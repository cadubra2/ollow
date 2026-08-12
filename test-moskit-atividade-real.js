// Levanta o contrato real de /activities do Moskit — o repositorio nunca escreveu nesse recurso
// (so GET), e a documentacao publica e uma SPA que nao expoe o payload. Antes de confiar que o bot
// consegue marcar a consulta na AGENDA do CRM, e preciso saber a rota, os campos aceitos e,
// principalmente, EM QUE FORMATO o dueDate entra: se o fuso escorregar, a consulta cai 3h fora do
// lugar e ninguem percebe ate o cliente aparecer na hora errada.
//
//   node test-moskit-atividade-real.js <dealId>            # so LE: amostra real + payload que seria enviado
//   node test-moskit-atividade-real.js <dealId> --aplicar  # ESCREVE: cria a atividade, mede o PUT e apaga
//   node test-moskit-atividade-real.js <dealId> --aplicar --manter   # nao apaga no fim
//
// Use um deal de TESTE. O modo --aplicar cria uma atividade real na agenda do CRM.
// NUNCA rodar em CI nem no npm test.
//
// Este script e escada, nao tentativa unica: ele varre rota x variante de payload ate uma combinacao
// devolver id, e imprime status e corpo de TODA tentativa. A primeira versao falhava sem deixar
// rastro nenhum — o que e o pior desfecho possivel num script cuja unica funcao e diagnosticar.

require('dotenv').config();
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');
const { montarPayloadAtividade, horarioNaiveParaInstante } = require('./src/atividade-moskit');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const TZ_ESCRITORIO = process.env.TZ_ESCRITORIO || 'America/Fortaleza';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_TEST' };

const dealId = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');
const MANTER = process.argv.includes('--manter');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (metodo, url, corpo) => axios({ method: metodo, url, data: corpo, headers, validateStatus: () => true });
const noEscritorio = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: TZ_ESCRITORIO }) : '(vazio)');

// Horario de teste: amanha as 15h no fuso do escritorio, na mesma string "naive" que o pipeline
// produz (apurarDuplaConfirmacao devolve "2026-08-05T17:30:00", sem Z e sem offset).
function horarioNaiveDeTeste() {
  const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ_ESCRITORIO, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(amanha).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T15:00:00`;
}

// Variantes do payload, da mais completa a mais crua. Se o Moskit rejeitar um campo, a escada diz
// QUAL — um 422 sozinho nao diz nada.
//
// `createdBy` e o suspeito mais citado (costuma ser server-managed), mas e suspeito FRACO aqui:
// criarNegocioMoskit ja o envia com sucesso em POST /deals. A escada custa nada e tira a duvida.
function variantesDePayload(base) {
  const semCreatedBy = { ...base }; delete semCreatedBy.createdBy;
  const semExtras = { ...semCreatedBy }; delete semExtras.notes; delete semExtras.duration;
  return [
    { nome: 'completo (o que o bot monta hoje)', payload: base },
    { nome: 'sem createdBy', payload: semCreatedBy },
    { nome: 'sem createdBy, notes e duration', payload: semExtras },
    { nome: 'minimo (title, type, dueDate, deals)', payload: { title: base.title, type: base.type, dueDate: base.dueDate, deals: base.deals } },
  ];
}

function rotasDeCriacao(id) {
  return [
    { nome: 'POST /activities', url: `${MOSKIT_BASE}/activities` },
    // A rota aninhada existe (GET /deals/{id}/activities responde 200) e e o padrao que as notas ja
    // usam (POST /deals/{id}/notes). Se a rota plana nao aceitar, e a candidata obvia.
    { nome: `POST /deals/${id}/activities`, url: `${MOSKIT_BASE}/deals/${id}/activities` },
  ];
}

async function main() {
  if (!dealId || !/^\d+$/.test(dealId)) {
    console.error('Uso: node test-moskit-atividade-real.js <dealId> [--aplicar] [--manter]');
    process.exit(1);
  }
  if (!process.env.MOSKIT_API_KEY) {
    console.error('MOSKIT_API_KEY ausente no .env (rodou a partir da raiz do projeto?)');
    process.exit(1);
  }

  console.log(`\n${APLICAR ? '⚠️  MODO ESCRITA' : '🔍 SO LEITURA'} — deal ${dealId}`);
  console.log(`   base: ${MOSKIT_BASE} | fuso: ${TZ_ESCRITORIO}\n`);

  // ── 0. Que deal e esse? Escrever no deal errado e o unico erro irreversivel aqui. ─────────────
  const dealRes = await req('get', `${MOSKIT_BASE}/deals/${dealId}`);
  if (dealRes.status < 200 || dealRes.status >= 300) {
    console.error(`❌ Nao consegui ler o deal ${dealId} (HTTP ${dealRes.status}). Confira o id.`);
    process.exit(1);
  }
  console.log(`── Deal alvo ──\n  "${dealRes.data?.name}" (estagio ${dealRes.data?.stage?.id}, status ${dealRes.data?.status})`);
  if (APLICAR && !/teste/i.test(dealRes.data?.name || '')) {
    console.log('  ⚠️ O nome desse deal NAO parece de teste. Ctrl+C agora se for um cliente real.');
    await espera(5000);
  }

  // ── 1. Amostra: como o Moskit DEVOLVE uma atividade de consulta ───────────────────────────────
  // Paginando: `limit` sempre devolve 10 nesta API, e a pagina 1 costuma so ter atividades ja
  // concluidas — que nao tem os campos de uma atividade pendente (era o que confundia antes).
  console.log('\n── Amostra de atividade existente ──');
  const todas = [];
  for (let p = 1; p <= 8; p++) {
    const r = await req('get', `${MOSKIT_BASE}/activities?page=${p}&limit=100&sort=id&order=desc`);
    if (!Array.isArray(r.data) || !r.data.length) break;
    todas.push(...r.data);
  }
  const consultas = todas.filter((a) => MOSKIT_IDS.ATIVIDADE_TIPOS_CONSULTA.has(a?.type?.id));
  const amostra = consultas.find((a) => !a.doneDate) || consultas[0];
  console.log(`  ${todas.length} atividades varridas, ${consultas.length} de consulta`);
  if (amostra) {
    console.log(`  amostra ${amostra.id} (${amostra.doneDate ? 'concluida' : 'PENDENTE'}) — chaves: ${Object.keys(amostra).join(', ')}`);
    console.log(`  dueDate cru: ${JSON.stringify(amostra.dueDate)} → ${noEscritorio(amostra.dueDate)} (${TZ_ESCRITORIO})`);
    console.log(JSON.stringify(amostra, null, 2));
  } else {
    console.log('  ⚠️ nenhuma atividade de consulta encontrada — marque uma na mao no Moskit para comparar.');
  }

  // ── 2. O payload que o bot enviaria ───────────────────────────────────────────────────────────
  const horarioNaive = horarioNaiveDeTeste();
  const dueDate = horarioNaiveParaInstante(horarioNaive, TZ_ESCRITORIO);
  const payloadBase = montarPayloadAtividade({
    dealId: Number(dealId),
    titulo: 'Consulta — TESTE contrato de atividade (apagar)',
    assunto: 'Teste automatizado do contrato de POST /activities',
    dueDate,
    presencial: false,
    meetLink: 'https://meet.google.com/teste-teste-teste',
  });

  console.log('\n── Payload que o bot enviaria ──');
  console.log(`  naive do pipeline: ${horarioNaive}`);
  console.log(`  dueDate:           ${dueDate}`);
  console.log(`  volta como:        ${noEscritorio(dueDate)}  ← tem que ser igual ao naive acima`);
  console.log(JSON.stringify(payloadBase, null, 2));

  if (!APLICAR) {
    console.log('\nNada foi escrito. Rode com --aplicar para medir POST, PUT e DELETE de verdade.\n');
    return;
  }

  // ── 3. Escada rota x variante ─────────────────────────────────────────────────────────────────
  console.log('\n── POST: varrendo rota x variante ate uma devolver id ──');
  let atividadeId = null;
  let rotaVencedora = null;
  let varianteVencedora = null;

  for (const rota of rotasDeCriacao(dealId)) {
    for (const variante of variantesDePayload(payloadBase)) {
      const res = await req('post', rota.url, variante.payload);
      const id = res.data?.id;
      const resumo = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      console.log(`  ${id ? '✅' : '❌'} ${rota.nome} · ${variante.nome} → HTTP ${res.status}`);
      if (!id) console.log(`       ${resumo.slice(0, 400)}`);
      if (id) {
        atividadeId = id;
        rotaVencedora = rota.nome;
        varianteVencedora = variante.nome;
        break;
      }
    }
    if (atividadeId) break;
  }

  if (!atividadeId) {
    console.error('\n❌ NENHUMA combinacao de rota e payload foi aceita. Os corpos de erro acima dizem o motivo —');
    console.error('   compare com a amostra do passo 1 e ajuste src/atividade-moskit.js.\n');
    process.exit(1);
  }
  console.log(`\n  Aceito por: ${rotaVencedora} · ${varianteVencedora} → atividade ${atividadeId}`);

  // ── 4. Conferencia ────────────────────────────────────────────────────────────────────────────
  await espera(2000); // GET logo apos escrita pode vir de cache nesta API
  const confRes = await req('get', `${MOSKIT_BASE}/activities/${atividadeId}`);
  const criada = confRes.data || {};
  console.log(`\n── GET /activities/${atividadeId} (HTTP ${confRes.status}) ──`);
  console.log(JSON.stringify(criada, null, 2));

  const tipoOk = criada.type?.id === payloadBase.type?.id;
  const dealOk = (criada.deals || []).some((d) => Number(d?.id) === Number(dealId));
  const horaOk = noEscritorio(criada.dueDate) === horarioNaive.replace('T', ' ');
  console.log('\n── Conferencia ──');
  console.log(`  ${tipoOk ? '✅' : '❌'} tipo ${criada.type?.id} (esperado ${payloadBase.type?.id})`);
  console.log(`  ${dealOk ? '✅' : '❌'} vinculada ao deal ${dealId}`);
  console.log(`  ${horaOk ? '✅' : '❌'} horario ${noEscritorio(criada.dueDate)} (esperado ${horarioNaive.replace('T', ' ')} em ${TZ_ESCRITORIO})`);
  if (!horaOk) console.log('       ⚠️ FUSO ERRADO — corrigir horarioNaiveParaInstante em src/atividade-moskit.js antes de qualquer outra coisa.');

  // ── 5. Qual PUT move o dueDate? ───────────────────────────────────────────────────────────────
  console.log('\n── PUT: payload minimo x corpo do GET ──');
  const novoNaive = horarioNaive.replace('T15:00:00', 'T16:00:00');
  const novoDue = horarioNaiveParaInstante(novoNaive, TZ_ESCRITORIO);
  const moveu = async () => {
    await espera(2000);
    const r = await req('get', `${MOSKIT_BASE}/activities/${atividadeId}`);
    return { ok: r.data?.dueDate && new Date(r.data.dueDate).getTime() === new Date(novoDue).getTime(), data: r.data };
  };

  const putMin = await req('put', `${MOSKIT_BASE}/activities/${atividadeId}`, { dueDate: novoDue });
  const aposMin = await moveu();
  console.log(`  ${aposMin.ok ? '✅' : '❌'} payload minimo → HTTP ${putMin.status}, dueDate agora ${noEscritorio(aposMin.data?.dueDate)}`);
  console.log(`       title preservado: ${aposMin.data?.title === payloadBase.title ? 'sim' : `NAO ("${aposMin.data?.title}")`}`);

  let putVencedor = aposMin.ok ? 'payload minimo' : null;
  if (!aposMin.ok) {
    const putCorpo = await req('put', `${MOSKIT_BASE}/activities/${atividadeId}`, { ...criada, dueDate: novoDue });
    const aposCorpo = await moveu();
    console.log(`  ${aposCorpo.ok ? '✅' : '❌'} corpo do GET → HTTP ${putCorpo.status}, dueDate agora ${noEscritorio(aposCorpo.data?.dueDate)}`);
    if (aposCorpo.ok) putVencedor = 'corpo do GET';
  }

  // ── 6. Limpeza ────────────────────────────────────────────────────────────────────────────────
  let apagada = false;
  if (MANTER) {
    console.log(`\n── Limpeza ──\n  --manter: atividade ${atividadeId} deixada no CRM de proposito.`);
  } else {
    const del = await req('delete', `${MOSKIT_BASE}/activities/${atividadeId}`);
    await espera(1500);
    const sobrou = await req('get', `${MOSKIT_BASE}/activities/${atividadeId}`);
    apagada = del.status < 300 && sobrou.status >= 400;
    console.log(`\n── Limpeza ──`);
    console.log(`  ${apagada ? '✅' : '❌'} DELETE → HTTP ${del.status}; releitura → HTTP ${sobrou.status}`);
    if (!apagada) console.log(`  ⚠️ A atividade ${atividadeId} continua no CRM — apague na mao para nao sujar a agenda.`);
  }

  // ── 7. O que fazer com o resultado ────────────────────────────────────────────────────────────
  console.log('\n── Conclusao ──');
  console.log(`  rota:   ${rotaVencedora}`);
  console.log(`  payload: ${varianteVencedora}`);
  console.log(`  PUT:    ${putVencedor || 'NENHUM dos dois moveu o dueDate'}`);
  console.log(`  fuso:   ${horaOk ? 'correto' : 'ERRADO'}`);
  console.log('');
  if (rotaVencedora !== 'POST /activities') {
    console.log(`  → criarAtividadeMoskit (index.js) precisa passar a usar ${rotaVencedora}.`);
  }
  if (varianteVencedora !== 'completo (o que o bot monta hoje)') {
    console.log(`  → montarPayloadAtividade (src/atividade-moskit.js) precisa parar de enviar os campos que a variante "${varianteVencedora}" omite, e test-atividade-moskit.js acompanha.`);
  }
  if (putVencedor === 'corpo do GET') {
    console.log('  → atualizarAtividadeMoskit (index.js) precisa ler a atividade e reenviar o corpo do GET, como putDealComVerificacao ja faz para deal.');
  } else if (!putVencedor) {
    console.log('  → remarcacao no CRM nao funciona por nenhum dos dois caminhos: investigar antes de confiar em atualizarAtividadeMoskit.');
  }
  if (rotaVencedora === 'POST /activities' && varianteVencedora.startsWith('completo') && putVencedor === 'payload minimo' && horaOk) {
    console.log('  → nada a mudar: o codigo como esta ja bate com a API. Trocar o comentario "ainda NAO foi medido"');
    console.log('    de atualizarAtividadeMoskit pelo resultado desta medicao.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n❌', e.response?.status || '', e.message);
  if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
