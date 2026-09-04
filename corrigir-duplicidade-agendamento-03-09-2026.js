// Correcao pontual (03/09/2026) — mesclagem dos pares duplicados achados na limpeza do estagio
// "Agendamento de Consulta" (limpeza-agendamento-consulta.js). Todos confirmados como MESMO TELEFONE
// com `contacts.id` DIFERENTE: a assinatura exata do bug de buscarOuCriarContato (CLAUDE.md,
// 24/08/2026). 4 dos 7 pares nasceram em 10/08/2026, o dia dos `pm2 restart` em sequencia.
//
// Regra pedida pelo usuario: "adicionar as informacoes de um ao outro pra se complementarem e
// excluir o que esta menos avancado no funil".
//   - MANTIDO  = o mais avancado no funil (prioridade de MOSKIT_STAGE_MAP; WON ganha de OPEN; em
//                empate, o que TEM conversa local, porque e nele que o bot continua escrevendo).
//   - COMPLEMENTO = campo VAZIO no mantido recebe o valor do perdedor. NUNCA sobrescreve valor que
//                ja existe: complementar e preencher lacuna, nao trocar dado. O nome do negocio so
//                e trocado quando o mantido esta com titulo generico e o perdedor tem o caso real.
//   - "EXCLUIR" = marcado como LOST + nota explicando e linkando o mantido. NAO e DELETE de verdade:
//                deletar no Moskit e irreversivel e apagaria a trilha (notas, atividades, historico
//                de quem falou com quem). O efeito pratico e o mesmo — o negocio sai da aba
//                "Agendamento" —, e reabrir desfaz se algum par estiver errado. Mesmo padrao ja
//                aplicado em 24/08/2026 e 03/09/2026 (corrigir-deals-duplicados-*.js).
//
// FORA deste script de proposito: o par Martha Luiza (48423360 x 49298706), porque os DOIS estao
// GANHOS com R$1.500 cada — fechar um como perdido mexe em receita reportada, e isso precisa de um
// "pode" explicito do escritorio, nao de uma inferencia minha.
//
//   node corrigir-duplicidade-agendamento-03-09-2026.js            (dry-run)
//   node corrigir-duplicidade-agendamento-03-09-2026.js --aplicar  (escreve no Moskit)
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar.
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `dup-agenda-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_WHATSAPP' };
const APLICAR = process.argv.includes('--aplicar');
const ORIGEM_NAO_IDENTIFICADO = MOSKIT_IDS.ORIGEM['nao identificado'];

// manter = mais avancado no funil · perder = o que sai da aba
const PARES = [
  { rotulo: 'Marcos Vinicius', manter: 48287893, perder: 48403502, porque: 'mesmo estágio, mas 48287893 é mais antigo e tem a conversa do WhatsApp; 48403502 nasceu órfão em 10/08 (dia do bug)' },
  { rotulo: 'Rafaela/Rafaella', manter: 48359210, perder: 48401433, porque: 'mesmo estágio, mas 48359210 tem a conversa; 48401433 nasceu órfão em 10/08' },
  { rotulo: 'Hedina', manter: 48701057, perder: 48971494, porque: '48701057 está em "consulta agendada" (mais avançado) — recebe área/advogado/origem e o nome do caso real do 48971494' },
  { rotulo: 'Jonas Vieira', manter: 47904832, perder: 48401430, porque: '47904832 está GANHO em "consulta agendada"; 48401430 nasceu órfão em 10/08' },
  { rotulo: 'Otaviano', manter: 48109800, perder: 48402952, porque: '48109800 está GANHO em "negociação"' },
  { rotulo: 'Hilton Charles', manter: 37007367, perder: 48407405, porque: '37007367 está GANHO em "contrato enviado" com o MESMO caso (colação de grau); 48407405 nasceu órfão em 10/08' },
  { rotulo: 'Jéssica', manter: 48169449, perder: 48431604, porque: 'nome e caso idênticos, mesmo estágio; 48169449 é mais antigo e tem a conversa' },
];

const CF_NOME = {
  [MOSKIT_IDS.CF.ORIGEM]: 'Origem',
  [MOSKIT_IDS.CF.TIPO_CONSULTA]: 'Tipo de consulta',
  [MOSKIT_IDS.CF.AREA_DIREITO]: 'Área do Direito',
  [MOSKIT_IDS.CF.RESPONSAVEL]: 'Advogado responsável',
  [MOSKIT_IDS.CF.CAPTACAO]: 'Captação',
};

const get = async (id) => {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (r.status < 200 || r.status >= 300) throw new Error(`GET /deals/${id} → HTTP ${r.status}`);
  return r.data;
};

// Valor "vazio" para efeito de complemento: campo ausente, sem opcao, ou a opcao "Nao identificado"
// da Origem (que e o fallback honesto, nao um dado — mesma leitura de recuperar-origem-perdida.js).
function vazio(campo) {
  if (!campo || !campo.options?.length) return true;
  if (campo.id === MOSKIT_IDS.CF.ORIGEM && campo.options[0] === ORIGEM_NAO_IDENTIFICADO) return true;
  return false;
}

function tituloGenerico(nome) {
  const idx = String(nome || '').indexOf(' - ');
  if (idx === -1) return true; // sem caso nenhum no titulo
  const assunto = nome.slice(idx + 3);
  return !assunto.trim() || /^consulta jur[ií]dica$/i.test(assunto.trim());
}

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: vai escrever no Moskit de verdade\n' : '🔍 dry-run: nada será escrito\n');

  for (const par of PARES) {
    console.log(`=== ${par.rotulo}: manter ${par.manter}, fechar ${par.perder} ===`);
    console.log(`    motivo: ${par.porque}`);
    let mantido; let perdedor;
    try { mantido = await get(par.manter); perdedor = await get(par.perder); } catch (e) { console.error(`  ❌ ${e.message}\n`); continue; }

    if (perdedor.status !== 'OPEN') {
      console.log(`  ⏭️  ${par.perder} já está ${perdedor.status} — alguém já resolveu, pulando\n`);
      continue;
    }

    // ---- complemento: campo vazio no mantido recebe o valor do perdedor ----
    const camposMantido = [...(mantido.entityCustomFields || [])];
    const complementos = [];
    for (const campoPerdedor of perdedor.entityCustomFields || []) {
      if (vazio(campoPerdedor)) continue;
      const idx = camposMantido.findIndex((f) => f.id === campoPerdedor.id);
      const atual = idx === -1 ? null : camposMantido[idx];
      if (!vazio(atual)) continue; // ja tem valor proprio — complementar nunca sobrescreve
      const novo = { id: campoPerdedor.id, options: campoPerdedor.options };
      if (idx === -1) camposMantido.push(novo); else camposMantido[idx] = novo;
      complementos.push(`${CF_NOME[campoPerdedor.id] || campoPerdedor.id} = ${campoPerdedor.options.join(',')}`);
    }

    // ---- nome: so troca se o mantido esta generico e o perdedor tem caso real ----
    let nomeNovo = mantido.name;
    if (tituloGenerico(mantido.name) && !tituloGenerico(perdedor.name)) {
      const nomePessoa = mantido.name.includes(' - ') ? mantido.name.slice(0, mantido.name.indexOf(' - ')) : mantido.name;
      const casoReal = perdedor.name.slice(perdedor.name.indexOf(' - ') + 3);
      nomeNovo = `${nomePessoa} - ${casoReal}`;
    }

    if (complementos.length) console.log(`  complementa ${par.manter}: ${complementos.join(' · ')}`);
    if (nomeNovo !== mantido.name) console.log(`  renomeia ${par.manter}: "${mantido.name}" → "${nomeNovo}"`);
    if (!complementos.length && nomeNovo === mantido.name) console.log(`  (nada a complementar — os dois têm os mesmos campos)`);
    console.log(`  fecha ${par.perder} como PERDIDO + nota nos dois lados`);

    if (!APLICAR) { console.log(''); continue; }

    try {
      // 1. complementa o mantido (so se houve mudanca)
      if (complementos.length || nomeNovo !== mantido.name) {
        const payloadMantido = { ...mantido, name: nomeNovo, entityCustomFields: camposMantido };
        const r1 = await axios.put(`${MOSKIT_BASE}/deals/${par.manter}`, payloadMantido, { headers: apiHeaders, validateStatus: (s) => s < 500 });
        if (r1.status < 200 || r1.status >= 300) throw new Error(`PUT mantido → HTTP ${r1.status}: ${JSON.stringify(r1.data).slice(0, 200)}`);
      }

      // 2. nota no mantido
      const notaMantido = [
        `🔁 Duplicidade resolvida em 03/09/2026: o negócio #${par.perder} ("${perdedor.name}") era o mesmo cliente`,
        '(mesmo telefone, cadastro de contato duplicado por uma falha temporária na busca do CRM).',
        complementos.length ? `As informações que faltavam aqui foram trazidas de lá: ${complementos.join('; ')}.` : 'Os dois tinham os mesmos dados — nada precisou ser copiado.',
        nomeNovo !== mantido.name ? `O título foi completado com o caso real.` : '',
        `O #${par.perder} foi marcado como perdido/duplicado. O acompanhamento continua aqui.`,
      ].filter(Boolean).join(' ');
      await axios.post(`${MOSKIT_BASE}/deals/${par.manter}/notes`, { description: notaMantido, user: { id: MOSKIT_IDS.LAYLA_USER_ID } }, { headers: apiHeaders, validateStatus: (s) => s < 500 });

      // 3. nota + LOST no perdedor
      const notaPerdedor = [
        `🔁 Duplicado — resolvido em 03/09/2026.`,
        `Este negócio é o mesmo cliente do #${par.manter} ("${mantido.name}"), que está mais avançado no funil.`,
        'Foi criado por engano: uma falha temporária na busca de contato no Moskit fez o bot concluir que o cliente era novo',
        'e abrir um segundo cadastro (bug já corrigido no código).',
        complementos.length ? `As informações úteis daqui foram copiadas para o #${par.manter} antes do fechamento.` : '',
        `Marcado como perdido para sair do funil — nada foi apagado, e reabrir desfaz se esta marcação estiver errada.`,
      ].filter(Boolean).join(' ');
      await axios.post(`${MOSKIT_BASE}/deals/${par.perder}/notes`, { description: notaPerdedor, user: { id: MOSKIT_IDS.LAYLA_USER_ID } }, { headers: apiHeaders, validateStatus: (s) => s < 500 });

      const payloadPerdedor = { ...perdedor, status: 'LOST', closeDate: new Date().toISOString(), lostReason: { id: MOSKIT_IDS.LOST_REASON['nao informou o motivo'] } };
      const r2 = await axios.put(`${MOSKIT_BASE}/deals/${par.perder}`, payloadPerdedor, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      if (r2.status < 200 || r2.status >= 300) throw new Error(`PUT perdedor → HTTP ${r2.status}: ${JSON.stringify(r2.data).slice(0, 200)}`);

      // 4. confere (o Moskit cacheia o GET pos-PUT por ~4s — ver CLAUDE.md)
      await new Promise((r) => setTimeout(r, 4500));
      const confP = await get(par.perder);
      const confM = await get(par.manter);
      const okP = confP.status === 'LOST';
      const okM = confM.name === nomeNovo;
      console.log(`  ${okP ? '✅' : '⚠️ '} ${par.perder} → ${confP.status}   ${okM ? '✅' : '⚠️ '} ${par.manter} → "${confM.name}"\n`);
    } catch (e) {
      console.error(`  ❌ ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log('Concluído.');
})();
