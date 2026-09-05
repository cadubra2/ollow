// Clone dos deals que tiveram REUNIAO GRAVADA NO MEET, reproduzidos pelo pipeline REAL
// (processarConversaDirect) dentro de um FUNIL DE TESTE do Moskit — nunca no funil de producao.
// Pedido do usuario em 04/09/2026: "crie um clone de todos os ultimos deals que tiveram reuniao
// gravada no meet pra ver se todas as funcoes principais do bot estao funcionando corretamente,
// faca no funil de teste para podermos apagar depois".
//
// POR QUE ESTES DEALS, e nao dez cenarios inventados (simular-10-leads-funil-teste.js ja faz isso):
// um deal que teve reuniao gravada e um atendimento que percorreu a cadeia INTEIRA — classificacao,
// extracao, gate do caso descrito, contato, negocio, campos, dupla confirmacao, agenda, briefing e a
// nota da reuniao. Sao as conversas reais mais completas que existem. A fonte da lista e a propria
// tabela `notas_reuniao` com estado CONCLUIDO: nota de reuniao so nasce quando o Gemini gravou e
// transcreveu a consulta.
//
// COMO O ISOLAMENTO E FEITO (cada linha aqui e uma forma de nao sujar producao):
//   - Funil: TODOS os estagios sao sobrescritos por env var (MOSKIT_STAGE_*), apontando para o
//     pipeline de teste. O bot nunca ve os estagios de producao.
//   - TELEFONE FICTICIO — a trava mais importante deste script, e a que nao existe no irmao de 10
//     leads porque la os telefones ja nasciam inventados. Reproduzir a conversa com o telefone REAL
//     faria `buscarOuCriarContato` achar o contato de producao e `buscarDealPorContato` achar o
//     NEGOCIO DE PRODUCAO — e a rodada terminaria dando PUT no deal do cliente de verdade, movendo
//     estagio e reescrevendo campo, que e exatamente o oposto do que "funil de teste" quer dizer.
//     Cada conversa e reproduzida sob um numero da faixa reservada 5586992000NNN.
//   - Banco: DB_PATH descartavel, como todo teste do projeto. Estado zerado de proposito: a graca e
//     ver a conversa inteira ser reprocessada do zero, nao herdar os checkpoints que ela ja tem.
//   - Telegram: token/chat removidos — `enviarTelegram` retorna em silencio quando faltam.
//   - Google Agenda: GOOGLE_CALENDAR_ID removido => getGoogleAuthClient() devolve null e nenhum
//     evento e criado. NAO e detalhe de conveniencia: com a credencial ligada, este script criaria
//     eventos de verdade na agenda do escritorio e mandaria convite por e-mail para os clientes
//     reais que aparecem nas conversas.
//   - ZapSign: chave removida, para nao criar documento nem disparar e-mail de assinatura real.
//   - Agenda do Moskit: LIGADA de proposito (AGENDA_MOSKIT_DRY_RUN nao e setado). E o unico caminho
//     de agendamento que sobra depois de desligar o Google, e e onde mora a conversao de fuso
//     (horarioNaiveParaInstante) — o defeito que nao quebra nada, so poe a consulta 3h fora do
//     lugar. As Atividades criadas sao registradas e apagadas pelo --limpar.
//   - Contatos: NAO tem como isolar (contato no Moskit nao pertence a funil). Nascem com o telefone
//     ficticio e sao apagados no fim — e o --limpar so apaga contato cujo telefone esta na faixa
//     reservada, para nunca encostar num contato de cliente real.
//
// A NOTA DA REUNIAO e o PDF DA TRANSCRICAO sao COPIADOS, nao reproduzidos: ela nasce de um e-mail do Gemini no Gmail, e o
// gatilho nao pode ser reencenado sem mexer nos rotulos da caixa real. O script le a nota que a
// rotina escreveu no deal de producao (a que carrega o marcador [ollow-notas:) e reposta no clone,
// para que o funil de teste mostre tambem a saida dessa funcao.
//
//   node clonar-deals-reuniao-funil-teste.js --snapshot=<db>            (dry-run: so lista)
//   node clonar-deals-reuniao-funil-teste.js --snapshot=<db> --aplicar  (roda de verdade)
//   node clonar-deals-reuniao-funil-teste.js --limpar                   (apaga o que criou)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------------------------
// Isolamento — TUDO isto precisa vir ANTES do require('./index.js'), que le env no carregamento.
// ---------------------------------------------------------------------------------------------
const PIPELINE_TESTE = Number(process.env.PIPELINE_TESTE) || 107282; // "ZZ Teste Bot (ignorar)"
const STAGES_TESTE = {
  MOSKIT_STAGE_ID: '516685',                     // Agendamento de Consulta
  MOSKIT_STAGE_CONSULTA_AGENDADA: '516686',
  MOSKIT_STAGE_AGUARDANDO_CONDICAO: '516687',
  MOSKIT_STAGE_ELABORACAO_PROPOSTA: '516688',
  MOSKIT_STAGE_NEGOCIACAO: '516689',
  MOSKIT_STAGE_ELABORACAO_CONTRATO: '516690',
  MOSKIT_STAGE_CONTRATO_ENVIADO: '516691',
};
const IDS_ESTAGIO_TESTE = new Set(Object.values(STAGES_TESTE));
Object.assign(process.env, STAGES_TESTE);
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `clone-reuniao-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.GOOGLE_CALENDAR_ID;      // <- e este que faz getGoogleAuthClient() devolver null
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
process.env.GOOGLE_OAUTH_CLIENT_JSON = path.join(os.tmpdir(), 'nao-existe-client.json');
process.env.GOOGLE_OAUTH_TOKEN_JSON = path.join(os.tmpdir(), 'nao-existe-token.json');
delete process.env.ZAPSIGN_API_KEY;
delete process.env.ZAPSIGN_TEMPLATE_TOKEN;
// Funil ligado de verdade: exercitar o avanco de estagio contra a API e metade da razao deste script.
process.env.FUNIL_DRY_RUN = 'false';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true'; // fechamento continua so sugerindo, como em producao

const axios = require('axios');
const Database = require('better-sqlite3');
const bot = require('./index.js');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json' };
const APLICAR = process.argv.includes('--aplicar');
const LIMPAR = process.argv.includes('--limpar');
const arg = (nome) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) || '').split('=').slice(1).join('=');
const SNAPSHOT = arg('snapshot') || process.env.SNAPSHOT_DB || '';
const LIMITE = Number(arg('limite')) || 0;
const SO_DEAL = arg('deal');
const SEM_COPIA = process.argv.includes('--sem-copia');
const REGISTRO = path.join(__dirname, '.clone-reuniao-criados.json');

// Faixa reservada de telefone. Duas exigencias ao mesmo tempo: nunca colidir com cliente real (o
// escritorio atende DDD 86/87/88 com numeros comuns) e ser reconhecivel de olho no CRM, porque e ela
// que autoriza o --limpar a apagar um contato.
const PREFIXO_TEL_TESTE = '5586992000';
const telTeste = (n) => `${PREFIXO_TEL_TESTE}${String(100 + n).slice(-3)}`;
const ehTelefoneDeTeste = (numero) => String(numero || '').replace(/\D/g, '').startsWith(PREFIXO_TEL_TESTE);

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Leitura do snapshot de producao (SOMENTE LEITURA, e a abertura readonly e a garantia disso).
// ---------------------------------------------------------------------------------------------
function lerFonte() {
  if (!SNAPSHOT || !fs.existsSync(SNAPSHOT)) {
    throw new Error(`--snapshot=<caminho> obrigatorio (copia do conversations.db de PRODUCAO). Recebi: "${SNAPSHOT}"`);
  }
  const origem = new Database(SNAPSHOT, { readonly: true });

  // A lista vem da propria tabela de notas de reuniao: CONCLUIDO significa que o Gemini gravou,
  // transcreveu e a nota chegou no negocio. E a definicao operacional de "teve reuniao gravada".
  const notas = origem
    .prepare("SELECT deal_id, assunto, doc_id, metodo, criado_em FROM notas_reuniao WHERE estado = 'CONCLUIDO' AND deal_id IS NOT NULL ORDER BY criado_em DESC")
    .all();

  const itens = [];
  for (const nota of notas) {
    if (SO_DEAL && String(nota.deal_id) !== String(SO_DEAL)) continue;
    let conv = origem
      .prepare('SELECT chat_id, contact_name, messages FROM conversations WHERE deal_id = ?')
      .get(nota.deal_id);
    let via = 'deal_id';
    if (!conv) {
      conv = origem
        .prepare('SELECT chat_id, contact_name, messages FROM conversations WHERE deals_anteriores LIKE ?')
        .get(`%${nota.deal_id}%`);
      via = 'deals_anteriores';
    }
    let mensagens = [];
    if (conv) { try { mensagens = JSON.parse(conv.messages || '[]'); } catch { mensagens = []; } }
    itens.push({
      dealReal: nota.deal_id,
      assuntoNota: nota.assunto,
      metodoNota: nota.metodo,
      chatReal: conv ? conv.chat_id : null,
      nomeContato: conv ? conv.contact_name : null,
      via: conv ? via : null,
      mensagens,
    });
  }

  // Espelho de contatos. Sem ele a simulacao nao vale: buscarOuCriarContato so conclui "este contato
  // nao existe" quando a varredura da API alcanca uma pagina que o espelho ja conhece, e um espelho
  // VAZIO nunca e alcancado — a funcao lanca, corretamente, porque a duvida e real.
  const contatos = origem.prepare('SELECT phone, moskit_id, name FROM moskit_contacts').all();
  origem.close();
  return { itens: LIMITE ? itens.slice(0, LIMITE) : itens, contatos };
}

// ---------------------------------------------------------------------------------------------
// Moskit — leitura e as poucas escritas que este script faz por fora do bot.
// ---------------------------------------------------------------------------------------------
const getDeal = async (id) =>
  (await axios.get(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 500 })).data;

// Pagina por ?start= porque `limit` e ignorado em silencio (sempre 10) — a mesma armadilha ja
// documentada para /deals, /contacts e /activities. Olhar so a primeira pagina responderia
// "nao achei" para uma nota que existe.
async function lerNotasDoDeal(dealId, maxPaginas = 20) {
  const todas = [];
  for (let p = 0; p < maxPaginas; p += 1) {
    const r = await axios.get(`${MOSKIT_BASE}/deals/${dealId}/notes`, {
      headers: apiHeaders, params: { start: p * 10 }, validateStatus: (s) => s < 500,
    });
    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
    todas.push(...r.data);
    if (r.data.length < 10) break;
    await pausa(200);
  }
  return todas;
}

async function postarNota(dealId, texto) {
  const r = await axios.post(
    `${MOSKIT_BASE}/deals/${dealId}/notes`,
    { description: texto, user: { id: MOSKIT_IDS.LAYLA_USER_ID } },
    { headers: apiHeaders, validateStatus: (s) => s < 500 }
  );
  return r.status;
}

// O PDF da transcricao. NAO da para "reenviar o arquivo": o Moskit nao aceita upload — o corpo do
// POST e so uma url, e ele BAIXA de la (ver "O PDF da transcricao na aba Arquivos" no CLAUDE.md).
// Isso torna a copia trivial, porque a url que o proprio CRM devolve em GET /attachments ja serve de
// origem: o Moskit rebaixa do storage dele mesmo. Sem este passo o clone fica com a nota e sem o
// arquivo — e "reuniao gravada" sem a transcricao anexada nao e o clone que foi pedido.
async function copiarAnexos(dealReal, dealDestino) {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${dealReal}/attachments`, {
    headers: apiHeaders, validateStatus: (s) => s < 500,
  });
  const lista = Array.isArray(r.data) ? r.data : [];
  if (!lista.length) return 'nenhum anexo no deal real';
  let ok = 0;
  for (const a of lista) {
    if (!a.url) continue;
    const p = await axios.post(`${MOSKIT_BASE}/deals/${dealDestino}/attachments`, { url: a.url }, {
      headers: apiHeaders, validateStatus: (s) => s < 500,
    });
    if (p.status >= 200 && p.status < 300) ok += 1;
    await pausa(400);
  }
  return `${ok}/${lista.length} copiado(s)`;
}

// Copia ESTATICA do deal de producao para dentro do funil de teste. Nao passa pelo bot e nao prova
// nada sobre ele — existe so para o funil mostrar os 12 deals pedidos, inclusive os que o replay nao
// recriou. Por isso o prefixo no nome e a nota explicando: uma copia que se pareca com saida do bot
// e pior que copia nenhuma, porque vira "verificacao" de algo que o bot nao fez.
async function criarCopiaEstatica(real, motivo) {
  const payload = {
    name: `[COPIA] ${real.name}`,
    status: 'OPEN',
    stage: { id: Number(STAGES_TESTE.MOSKIT_STAGE_ID) },
    createdBy: { id: MOSKIT_IDS.LAYLA_USER_ID },
    responsible: { id: MOSKIT_IDS.LAYLA_USER_ID },
    entityCustomFields: (real.entityCustomFields || [])
      .filter((f) => Array.isArray(f.options) && f.options.length)
      .map((f) => ({ id: f.id, options: f.options })),
    price: real.price || 0,
  };
  const r = await axios.post(`${MOSKIT_BASE}/deals`, payload, {
    headers: apiHeaders, validateStatus: (s) => s < 500,
  });
  if (!r.data?.id) return { id: null, erro: `${r.status} ${JSON.stringify(r.data).slice(0, 200)}` };
  await postarNota(
    r.data.id,
    `⚠️ COPIA ESTATICA do negocio ${real.id}, feita a mao pelo script de clone.\n`
    + `NAO foi produzida pelo bot nesta rodada — os campos foram copiados do CRM como estavam.\n`
    + `Motivo: ${motivo}`
  ).catch(() => {});
  return { id: r.data.id, erro: null };
}

// ---------------------------------------------------------------------------------------------
// Semeadura da conversa no banco descartavel, sob telefone ficticio.
// ---------------------------------------------------------------------------------------------
function semear(db, chatId, mensagens, nome) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
  db.prepare('INSERT INTO conversations (chat_id, phone, contact_name, messages, last_activity) VALUES (?,?,?,?,?)')
    .run(chatId, chatId, nome || '', JSON.stringify(mensagens), new Date().toISOString());
}

// ---------------------------------------------------------------------------------------------
// Limpeza.
// ---------------------------------------------------------------------------------------------
async function limpar() {
  if (!fs.existsSync(REGISTRO)) { console.log('Nada registrado para limpar.'); return; }
  const { deals = [], contatos = [], atividades = [] } = JSON.parse(fs.readFileSync(REGISTRO, 'utf-8'));
  console.log(`🧹 apagando ${atividades.length} atividade(s), ${deals.length} negocio(s) e ${contatos.length} contato(s) de teste...`);

  for (const id of atividades) {
    const r = await axios.delete(`${MOSKIT_BASE}/activities/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    console.log(`  atividade ${id} → ${r.status}`);
    await pausa(300);
  }
  for (const id of deals) {
    const r = await axios.delete(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    console.log(`  deal ${id} → ${r.status}`);
    await pausa(300);
  }
  // Contato so e apagado depois de CONFERIR na API que o telefone dele esta na faixa reservada. O
  // registro poderia estar errado (rodada interrompida, arquivo editado a mao) e apagar contato de
  // cliente real e irreversivel — a conferencia custa um GET e remove essa classe inteira de acidente.
  for (const id of contatos) {
    const c = await axios.get(`${MOSKIT_BASE}/contacts/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    const numeros = (c.data?.phones || []).map((p) => p.number || p.phone || '');
    if (c.status === 200 && !numeros.some(ehTelefoneDeTeste)) {
      console.log(`  contato ${id} → PULADO (telefone ${JSON.stringify(numeros)} nao e da faixa de teste)`);
      continue;
    }
    const r = await axios.delete(`${MOSKIT_BASE}/contacts/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    console.log(`  contato ${id} → ${r.status}`);
    await pausa(300);
  }
  fs.unlinkSync(REGISTRO);
  console.log('Limpeza concluida.');
}

// ---------------------------------------------------------------------------------------------
const CF = MOSKIT_IDS.CF;
const opt = (d, id) => (d?.entityCustomFields || []).find((f) => f.id === id)?.options?.[0] || null;
const rotulo = (mapa, id) => Object.entries(mapa).find(([, v]) => v === id)?.[0] || (id ? `id:${id}` : '—');

function imprimirApuracao(bruto) {
  try {
    const ap = JSON.parse(bruto);
    console.log(`      ${'dupla confirm.'.padEnd(14)} confirmado=${!!ap.confirmado} horario=${ap.horarioIso || '—'} motivo=${ap.motivo || '—'}`);
  } catch { /* apuracao ilegivel nao vale derrubar o relatorio */ }
}

function retrato(deal) {
  if (!deal || !deal.id) return null;
  return {
    id: deal.id,
    nome: deal.name,
    estagio: deal.stage?.id,
    status: deal.status,
    price: deal.price,
    area: rotulo(MOSKIT_IDS.AREA_DIREITO, opt(deal, CF.AREA_DIREITO)),
    advogado: rotulo(MOSKIT_IDS.RESPONSAVEL_PROCESSO, opt(deal, CF.RESPONSAVEL)),
    tipo: rotulo(MOSKIT_IDS.TIPO_CONSULTA, opt(deal, CF.TIPO_CONSULTA)),
    origem: rotulo(MOSKIT_IDS.ORIGEM, opt(deal, CF.ORIGEM)),
    captacao: rotulo(MOSKIT_IDS.CAPTACAO, opt(deal, CF.CAPTACAO)),
  };
}

(async () => {
  if (LIMPAR) { await limpar(); return; }

  const { itens, contatos } = lerFonte();

  console.log(`\n${'='.repeat(90)}`);
  console.log(`CLONE DOS DEALS COM REUNIAO GRAVADA — funil de teste ${PIPELINE_TESTE} (estagio inicial ${STAGES_TESTE.MOSKIT_STAGE_ID})`);
  console.log(APLICAR ? '🚨 --aplicar: chama OpenAI e Moskit DE VERDADE (no funil de teste)' : '🔍 dry-run: so lista o que seria feito');
  console.log(`${'='.repeat(90)}\n`);

  itens.forEach((it, i) => {
    const tel = telTeste(i + 1);
    console.log(`${String(i + 1).padStart(2)}. deal ${it.dealReal} — ${it.assuntoNota}`);
    console.log(`    nota vinculada por: ${it.metodoNota} · conversa: ${it.chatReal ? `${it.mensagens.length} msgs (via ${it.via})` : 'NENHUMA — nada a reproduzir'}`);
    if (it.chatReal) console.log(`    sera reproduzida sob o telefone ficticio ${tel} (real ${it.chatReal} nunca e usado)`);
  });

  const comConversa = itens.filter((i) => i.mensagens.length > 0);
  console.log(`\n${itens.length} deal(s) com reuniao gravada · ${comConversa.length} com conversa reproduzivel · ${itens.length - comConversa.length} sem conversa`);
  if (!APLICAR) { console.log('\nRode com --aplicar para executar.'); return; }

  const db = new Database(process.env.DB_PATH);
  const ins = db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?,?,?,?)');
  db.transaction((rs) => { for (const r of rs) ins.run(r.phone, r.moskit_id, r.name || '', '{}'); })(contatos);
  console.log(`\n📇 espelho de contatos carregado: ${contatos.length} contatos`);

  // Registro ACUMULA entre rodadas. Uma rodada com --deal=N zerando o registro deixaria os negocios
  // das rodadas anteriores orfaos no funil de teste (aconteceu com o script irmao em 04/09/2026).
  const criados = fs.existsSync(REGISTRO)
    ? JSON.parse(fs.readFileSync(REGISTRO, 'utf-8'))
    : { deals: [], contatos: [], atividades: [] };
  criados.atividades = criados.atividades || [];
  const resultados = [];

  for (let i = 0; i < itens.length; i += 1) {
    const it = itens[i];
    const chatId = telTeste(i + 1);
    console.log(`\n${'─'.repeat(90)}\n▶️  deal real ${it.dealReal} — ${it.assuntoNota}`);

    const real = await getDeal(it.dealReal);
    const linhaResultado = { it, chatId, real, clone: null, dealClone: null, erro: null, nota: null, anexos: null, linha: null, copiaEstatica: null, erroCopia: null };

    if (it.mensagens.length) {
      semear(db, chatId, it.mensagens, it.nomeContato);
      try {
        await bot.processarConversaDirect(chatId);
      } catch (e) {
        linhaResultado.erro = e.message;
        console.error(`    ❌ EXCECAO: ${e.message}`);
      }
      linhaResultado.linha = db.prepare('SELECT deal_id, last_action, atividade_moskit_id, evento_calendar_data, agendamento_apuracao, briefing_added, briefing_versao FROM conversations WHERE chat_id = ?').get(chatId);
    } else {
      console.log('    ⏭️ sem conversa no banco — nada a reproduzir (negocio criado fora do bot)');
    }

    const dealClone = linhaResultado.linha?.deal_id || null;
    linhaResultado.dealClone = dealClone;

    if (dealClone) {
      criados.deals.push(dealClone);
      if (linhaResultado.linha.atividade_moskit_id) criados.atividades.push(linhaResultado.linha.atividade_moskit_id);
      // GET logo apos PUT pode vir de cache por ~4s (peculiaridade ja medida da API).
      await pausa(4500);
      const clone = await getDeal(dealClone);
      linhaResultado.clone = clone;
      for (const c of clone?.contacts || []) if (!criados.contatos.includes(c.id)) criados.contatos.push(c.id);
    } else if (!SEM_COPIA) {
      const motivo = it.mensagens.length
        ? `o replay da conversa nao chegou a criar negocio (last_action=${linhaResultado.linha?.last_action || '?'})`
        : 'nao existe conversa deste negocio no banco do bot (foi criado fora dele)';
      const copia = await criarCopiaEstatica(real, motivo);
      linhaResultado.copiaEstatica = copia.id;
      linhaResultado.erroCopia = copia.erro;
      if (copia.id) { criados.deals.push(copia.id); console.log(`    📋 copia estatica criada: deal ${copia.id}`); }
      else console.log(`    ⚠️ copia estatica falhou: ${copia.erro}`);
    }

    // Copia da nota da reuniao: a saida da rotina de notas nao pode ser reencenada (o gatilho e um
    // e-mail no Gmail), entao ela e transportada tal como esta no deal real — e e ela que prova, no
    // funil de teste, que a gravacao do Meet virou registro no negocio.
    const destinoNota = dealClone || linhaResultado.copiaEstatica;
    if (destinoNota) {
      try {
        const notas = await lerNotasDoDeal(it.dealReal);
        const daReuniao = notas.filter((n) => String(n.description || '').includes('[ollow-notas:'));
        if (daReuniao.length) {
          const st = await postarNota(destinoNota, `[CLONE DE TESTE — copia da nota de reuniao do deal ${it.dealReal}]\n\n${daReuniao[0].description}`);
          linhaResultado.nota = `copiada (${st})`;
        } else {
          linhaResultado.nota = 'nao encontrada no deal real';
        }
      } catch (e) {
        linhaResultado.nota = `falhou: ${e.message}`;
      }
      try {
        linhaResultado.anexos = await copiarAnexos(it.dealReal, destinoNota);
      } catch (e) {
        linhaResultado.anexos = `falhou: ${e.message}`;
      }
    }

    resultados.push(linhaResultado);
    fs.writeFileSync(REGISTRO, JSON.stringify(criados, null, 2));
    await pausa(700);
  }

  // -------------------------------------------------------------------------------------------
  console.log(`\n\n${'='.repeat(90)}\nRESULTADO — producao (esquerda) x clone no funil de teste (direita)\n${'='.repeat(90)}`);

  for (const r of resultados) {
    const p = retrato(r.real);
    const c = retrato(r.clone);
    console.log(`\ndeal real ${r.it.dealReal} — ${r.it.assuntoNota}`);
    if (r.erro) console.log(`  ❌ EXCECAO: ${r.erro}`);
    if (!r.dealClone) {
      console.log(`  ⚠️ o bot NAO criou negocio no replay (last_action=${r.linha?.last_action || 'sem conversa reproduzivel'})`);
      if (r.linha?.agendamento_apuracao) imprimirApuracao(r.linha.agendamento_apuracao);
      if (r.copiaEstatica) console.log(`  copia estatica no funil de teste: deal ${r.copiaEstatica} (nao e saida do bot)`);
      else if (r.erroCopia) console.log(`  copia estatica falhou: ${r.erroCopia}`);
      console.log(`  nota reuniao  ${r.nota || '—'}`);
      console.log(`  anexos        ${r.anexos || '—'}`);
      continue;
    }
    const foraDoFunil = c && !IDS_ESTAGIO_TESTE.has(String(c.estagio));
    console.log(`  clone: deal ${r.dealClone} ${foraDoFunil ? '⚠️  FORA DO FUNIL DE TESTE' : '(funil de teste ✅)'}`);
    const linhas = [
      ['nome', p?.nome, c?.nome],
      ['estagio', p?.estagio, c?.estagio],
      ['area', p?.area, c?.area],
      ['advogado', p?.advogado, c?.advogado],
      ['tipo consulta', p?.tipo, c?.tipo],
      ['origem', p?.origem, c?.origem],
      ['captacao', p?.captacao, c?.captacao],
      ['price', p?.price, c?.price],
      ['status', p?.status, c?.status],
    ];
    for (const [rot, a, b] of linhas) {
      // Estagio SEMPRE difere (funis diferentes) — comparar seria ruido garantido em toda linha.
      const igual = rot === 'estagio' ? null : String(a) === String(b);
      const marca = igual === null ? ' ' : (igual ? '=' : '≠');
      console.log(`    ${marca} ${rot.padEnd(14)} ${String(a ?? '—').padEnd(42)} | ${String(b ?? '—')}`);
    }
    console.log(`      ${'agendamento'.padEnd(14)} ${'consulta no banco: ' + (r.linha?.evento_calendar_data || '—')}`);
    console.log(`      ${'atividade CRM'.padEnd(14)} ${r.linha?.atividade_moskit_id || '— (nenhuma criada)'}`);
    console.log(`      ${'briefing'.padEnd(14)} ${r.linha?.briefing_added ? `postado (v${r.linha.briefing_versao})` : '— (nao postado)'}`);
    console.log(`      ${'nota reuniao'.padEnd(14)} ${r.nota || '—'}`);
    console.log(`      ${'anexos'.padEnd(14)} ${r.anexos || '—'}`);
    if (r.linha?.agendamento_apuracao) imprimirApuracao(r.linha.agendamento_apuracao);
  }

  console.log(`\n\nCriados: ${criados.deals.length} negocio(s), ${criados.contatos.length} contato(s), ${criados.atividades.length} atividade(s) — registrados em ${path.basename(REGISTRO)}`);
  console.log(`Funil de teste: https://app.ollow.com.br  (pipeline ${PIPELINE_TESTE} "ZZ Teste Bot (ignorar)")`);
  console.log('Para apagar tudo: node clonar-deals-reuniao-funil-teste.js --limpar');
})().catch((e) => { console.error('\n❌ FALHOU:', e.message); process.exit(1); });
