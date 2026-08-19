// As DUAS configuracoes com que o cliente de retorno vai para producao. Rodar com:
//   node test-cliente-retorno-flags.js
//
// CLIENTE_RETORNO_ATIVO e CLIENTE_RETORNO_DRY_RUN sao lidos como `const` no require do index.js, entao
// nao ha como exercitar os dois modos no mesmo processo — mesmo motivo pelo qual test-agenda-dry-run.js
// existe separado de test-pipeline.js. Este arquivo se relanca como filho, um processo por modo.
//
// O que esta em jogo: producao vai comecar DESLIGADA e depois em DRY-RUN, e o contrato dos dois e o
// mesmo — "o ciclo continua exatamente como era antes desta funcionalidade". Um dry-run que ja mudasse
// o comportamento nao mediria o status quo; um "desligado" que mexesse em algo seria pior ainda.
// test-pipeline.js cobre o caminho LIGADO E APLICANDO.

const path = require('path');
const { spawnSync } = require('child_process');

const MODOS = {
  desligado: { CLIENTE_RETORNO_ATIVO: 'false', CLIENTE_RETORNO_DRY_RUN: 'false' },
  dryrun: { CLIENTE_RETORNO_ATIVO: 'true', CLIENTE_RETORNO_DRY_RUN: 'true' },
};

if (!process.env.RETORNO_MODO) {
  let falhou = false;
  for (const [modo, env] of Object.entries(MODOS)) {
    console.log(`\n${'#'.repeat(50)}\n# modo: ${modo}\n${'#'.repeat(50)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
      stdio: 'inherit',
      env: { ...process.env, ...env, RETORNO_MODO: modo },
    });
    if (r.status !== 0) falhou = true;
  }
  process.exit(falhou ? 1 : 0);
}

const MODO = process.env.RETORNO_MODO;

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

const DIR = dirTemporario(`retorno-${MODO}`);
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.AGENDA_MOSKIT_DRY_RUN = 'false';
process.env.FUNIL_DRY_RUN = 'true';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true';

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
const { instanteParaNaiveLocal } = require('./src/evidencia');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
const telegrams = () => de('POST', 'api.telegram.org');
const linha = () => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(CHAT);

// ---------- o cenario: o MESMO retorno que test-pipeline.js abre no modo ligado ----------
const CHAT = '5586999990001';
const DEAL_ANTIGO = 9001;
const agora = Date.now();
const atras = (h) => new Date(agora - h * 3600 * 1000).toISOString();
const TEXTO_CASO_NOVO = 'recebi uma notificacao de despejo do imovel que eu alugo, o prazo e de 15 dias';
const MSGS = [
  { role: 'cliente', text: 'oi, quero falar do abatimento do meu FIES', timestamp: atras(72) },
  { role: 'cliente', text: 'obrigado pela consulta, doutor!', timestamp: atras(47) },
  { role: 'cliente', text: `Doutor, ${TEXTO_CASO_NOVO}`, timestamp: atras(24) },
];

db.prepare(
  'INSERT INTO conversations (chat_id, phone, contact_name, messages, deal_id, last_data, last_action, evento_calendar_criado, evento_calendar_data, bloco_condicoes_enviado) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?)'
).run(
  CHAT, CHAT, 'Lia', JSON.stringify(MSGS), DEAL_ANTIGO,
  JSON.stringify({
    nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional',
    advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram',
    _casoDescritoValidado: true,
  }),
  'nota', 1, instanteParaNaiveLocal(atras(48)), 1
);
db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(CHAT, 4242, 'Lia');

const moskitIds = require('./src/moskit-ids');
const CF_CRM = [
  { id: moskitIds.CF.TIPO_CONSULTA, options: [moskitIds.TIPO_CONSULTA['consulta paga']] },
  { id: moskitIds.CF.AREA_DIREITO, options: [moskitIds.AREA_DIREITO['direito educacional']] },
  { id: moskitIds.CF.RESPONSAVEL, options: [moskitIds.RESPONSAVEL_PROCESSO['iury']] },
];
// Dublê com um pingo de estado: depois do PUT, o GET devolve os campos que o PUT levou. Sem isso a
// reconferencia pos-PUT de atualizarNegocioMoskit (que existe porque o Moskit propaga com atraso)
// nunca fecha, e o ciclo morre por 6,5s de retentativa em vez de exercitar o que este teste mede.
let ultimoPut = null;
const dealAtual = () => ({
  id: DEAL_ANTIGO, name: 'Lia - Abatimento do FIES', status: 'OPEN', stage: { id: 179388 }, activities: [],
  entityCustomFields: ultimoPut?.entityCustomFields || CF_CRM,
});
rede.get = () => ({ status: 200, data: dealAtual() });
rede.put = (url, corpo) => { if (url.includes(`/deals/${DEAL_ANTIGO}`)) ultimoPut = corpo; return { status: 200, data: {} }; };
rede.post = () => ({ status: 200, data: {} });

openai.respostas = [
  { classificacao: 'criar_negocio', justificativa: 'cliente antigo com caso novo' },
  {
    acao: 'atualizar_campos', justificativa: 'caso novo de despejo', confianca: 9,
    dados: {
      nome: 'Lia', assunto: 'Notificacao de despejo', area_direito: 'Direito Imobiliario',
      advogado_responsavel: 'Bruno', tipo_consulta: 'consulta paga', origem: 'Instagram',
    },
    observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 2, trecho: TEXTO_CASO_NOVO }],
  },
];

(async () => {
  console.log(`\n=== ${MODO}: o ciclo tem que continuar como era antes ===`);
  await processarConversaDirect(CHAT);

  const l = linha();
  igual('nao corta a conversa', l.atendimento_inicio_msg_idx, null);
  igual('   nao abre atendimento novo', l.atendimento_num, 1);
  igual('   o negocio antigo continua sendo o da conversa', l.deal_id, DEAL_ANTIGO);
  igual('   deals_anteriores segue vazio', l.deals_anteriores, null);

  // O ciclo normal seguiu: e isto que faz de "desligado" e "dry-run" uma medicao honesta do status quo,
  // e nao um terceiro comportamento que ninguem pediu.
  checar('o ciclo normal seguiu ate o CRM', de('PUT', `/deals/${DEAL_ANTIGO}`).length === 1, rede.chamadas.map((c) => `${c.metodo} ${c.url}`));

  if (MODO === 'desligado') {
    igual('desligado: nenhum aviso de retorno', telegrams().filter((t) => (t.corpo.text || '').includes('retorno')).length, 0);
    checar('desligado: nenhuma nota de retorno', !de('POST', '/notes').some((n) => (n.corpo.description || '').includes('retorno')), de('POST', '/notes').map((n) => n.corpo.description));
    igual('desligado: nem hash de aviso', l.retorno_aviso_hash, null);
  } else {
    checar('dry-run: avisa no Telegram', telegrams().some((t) => (t.corpo.text || '').includes('Cliente de retorno')), telegrams().map((t) => t.corpo.text));
    checar('dry-run: o aviso diz que nada foi alterado', telegrams().some((t) => (t.corpo.text || '').includes('[dry-run]')), telegrams().map((t) => t.corpo.text));
    checar('dry-run: nota marcada como dry-run no negocio', de('POST', '/notes').some((n) => (n.corpo.description || '').includes('[dry-run]')), de('POST', '/notes').map((n) => n.corpo.description));
    checar('dry-run: grava o hash para nao repetir o aviso', !!l.retorno_aviso_hash, l.retorno_aviso_hash);
  }

  db.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passou: ${passou} | Falhou: ${falhou}`);
  console.log('='.repeat(50));
  process.exit(falhou > 0 ? 1 : 0);
})();
