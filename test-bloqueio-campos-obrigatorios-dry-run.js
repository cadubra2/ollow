// BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN ligado (o padrao de producao no dia em que o gate nasce).
// Rodar com:
//   node test-bloqueio-campos-obrigatorios-dry-run.js
//
// Arquivo separado de test-pipeline.js por necessidade, nao por gosto: a flag e lida como `const` no
// require de index.js, entao os dois valores nao cabem no mesmo processo (mesmo motivo de
// test-agenda-dry-run.js). test-pipeline.js fixa 'false' e cobre o bloqueio de verdade; aqui fixamos
// o padrao (sem setar a variavel) e cobrimos o dry-run: detecta e LOGA, mas cria o deal mesmo assim —
// e assim que a mudanca vai para producao no primeiro deploy, para medir contra o corpus real antes
// de confiar (ver CLAUDE.md, "Classificacao do deal").

const path = require('path');
const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

const DIR = dirTemporario('bloqueio-campos-dryrun');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.AGENDA_MOSKIT_DRY_RUN = 'false';
process.env.FUNIL_DRY_RUN = 'true';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true';
// BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN de proposito NAO setada aqui: o objeto deste arquivo e o
// DEFAULT (nasce em 'true', so loga).

// ---------- dublê do axios ----------
const axios = require('axios');
const rede = { chamadas: [], get: null, post: null, put: null };
for (const metodo of ['get', 'post', 'put', 'patch', 'delete']) {
  axios[metodo] = async (url, a, b) => {
    const corpo = metodo === 'get' || metodo === 'delete' ? undefined : a;
    rede.chamadas.push({ metodo: metodo.toUpperCase(), url, corpo, cfg: corpo === undefined ? a : b });
    const h = rede[metodo];
    if (h) return h(url, corpo);
    return { status: 200, data: {} };
  };
}

// ---------- dublê da OpenAI (https.request na mao) ----------
const httpsModulo = require('https');
const { EventEmitter } = require('events');
const openai = { respostas: [] };
httpsModulo.request = (opcoes, cb) => {
  const res = new EventEmitter();
  const req = {
    on: () => req,
    write: () => {},
    destroy: () => {},
    end: () => {
      const resposta = openai.respostas.shift() || {};
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify(resposta) } }] }));
        res.emit('end');
      });
    },
  };
  return req;
};

// ---------- dublê do Google Calendar ----------
const { google } = require('googleapis');
google.calendar = () => ({
  events: {
    insert: async () => ({ data: { id: 'ev1', htmlLink: 'https://exemplo/ev1' } }),
    list: async () => ({ data: { items: [] } }),
    patch: async () => ({ data: {} }),
    get: async () => ({ data: {} }),
    delete: async () => ({}),
  },
});

const { processarConversaDirect } = require('./index');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
// `de('POST', '/deals')` casaria tambem /deals/{id}/notes (o briefing): para contar negocio CRIADO a
// URL tem que terminar ali (mesmo helper de test-pipeline.js).
const dealsCriados = () => rede.chamadas.filter((c) => c.metodo === 'POST' && c.url.endsWith('/deals'));
const linha = (chatId) => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);

const CHAT = '5586999990097';
const MSGS = [
  { role: 'cliente', text: 'Boa tarde, gostaria de saber sobre um caso de inventario', timestamp: '2026-08-01T10:00:00Z' },
];
db.prepare('INSERT INTO conversations (chat_id, phone, contact_name, messages) VALUES (?,?,?,?)')
  .run(CHAT, CHAT, 'Marcos', JSON.stringify(MSGS));

// Falta "tipo_consulta" de proposito, mesmo cenario de test-pipeline.js — so o modo da flag muda.
openai.respostas = [
  { classificacao: 'criar_negocio', justificativa: 'lead viavel' },
  {
    acao: 'criar', justificativa: 'caso descrito, falta tipo_consulta', confianca: 9,
    dados: { nome: 'Marcos', assunto: 'Inventario', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno', tipo_consulta: null, origem: 'Instagram' },
    observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 0, trecho: 'caso de inventario' }],
  },
];
rede.get = (url) => (url.includes('/deals/') ? { status: 200, data: { id: 8501, status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: [] } } : { status: 200, data: [] });
rede.post = (url) => {
  if (url.includes('/contacts')) return { status: 201, data: { id: 5151 } };
  if (url.includes('/deals')) return { status: 200, data: { id: 8501 } };
  if (url.includes('/activities')) return { status: 200, data: { id: 990002 } };
  return { status: 200, data: {} };
};

(async () => {
  console.log('\n=== BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN=true (padrao): detecta e loga, mas cria mesmo assim ===');
  await processarConversaDirect(CHAT);

  igual('acao continua "criar" (dry-run nao desvia para aguardar)', linha(CHAT).last_action, 'criar');
  igual('   o deal E criado, mesmo com tipo_consulta pendente', dealsCriados().length, 1);
  checar('   o contato tambem e criado normalmente', de('POST', '/contacts').length === 1);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
