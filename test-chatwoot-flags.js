// Os DOIS modos com que a sincronizacao do Chatwoot vai para producao. Rodar com:
//   node test-chatwoot-flags.js
//
// CHATWOOT_ATIVO e CHATWOOT_DRY_RUN sao lidos como `const` no require do index.js, entao nao ha como
// exercitar os dois modos no mesmo processo — mesmo motivo pelo qual test-agenda-dry-run.js existe
// separado de test-pipeline.js. Este arquivo se relanca como filho, um processo por modo.
//
// O que esta em jogo: producao comeca DESLIGADA e depois em DRY-RUN, e o contrato dos dois e o mesmo —
// nao escrever NADA na instancia do Chatwoot. O caminho ligado-e-aplicando e coberto em
// test-pipeline.js. Aqui a assercao central e negativa: zero PUT.

const path = require('path');
const { spawnSync } = require('child_process');

const MODOS = {
  desligado: { CHATWOOT_ATIVO: 'false', CHATWOOT_DRY_RUN: 'false' },
  dryrun: { CHATWOOT_ATIVO: 'true', CHATWOOT_DRY_RUN: 'true' },
};

if (!process.env.CHATWOOT_MODO) {
  let falhou = false;
  for (const [modo, env] of Object.entries(MODOS)) {
    console.log(`\n${'#'.repeat(50)}\n# modo: ${modo}\n${'#'.repeat(50)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
      stdio: 'inherit',
      env: { ...process.env, ...env, CHATWOOT_MODO: modo },
    });
    if (r.status !== 0) falhou = true;
  }
  process.exit(falhou ? 1 : 0);
}

const MODO = process.env.CHATWOOT_MODO;

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

const DIR = dirTemporario(`chatwoot-${MODO}`);
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.CHATWOOT_BASE = 'https://chat.exemplo.com';
process.env.CHATWOOT_ACCOUNT_ID = '9';
process.env.CHATWOOT_API_TOKEN = 'token-falso-chatwoot';
process.env.CHATWOOT_PAUSA_MS = '0';

// ---------- dublê do axios (mesmo padrao de test-pipeline.js) ----------
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

const bot = require('./index');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const puts = () => rede.chamadas.filter((c) => c.metodo === 'PUT' && c.url.includes('/contacts'));
const aoChatwoot = () => rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com'));

const CHAVE = '558699999999';

(async () => {
  console.log(`\n=== Chatwoot, modo "${MODO}" ===`);

  // Um candidato que, no modo ligado-e-aplicando, geraria escrita: ficha sem nome no Chatwoot e nome
  // bom no espelho do Moskit. Se algum dos dois modos escrever, escreve aqui.
  bot.stmtsChatwoot().upsertVisto.run(CHAVE, 500, `+${CHAVE}`, '', '');
  db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)')
    .run(CHAVE, 4711, 'Maria de Fatima');
  db.prepare('INSERT INTO conversations (chat_id, phone, contact_name, messages, deal_id) VALUES (?,?,?,?,?)')
    .run(CHAVE, CHAVE, '558699999999', '[]', 48407608);

  rede.get = (url) => (url.endsWith('/contacts/500')
    ? { status: 200, data: { payload: { id: 500, name: '', phone_number: `+${CHAVE}`, identifier: '', custom_attributes: {} } } }
    : { status: 200, data: {} });
  rede.put = () => ({ status: 204, data: '' });

  if (MODO === 'desligado') {
    // A rotina periodica nem chega a rodar: rodarSincronizacaoChatwoot sai na primeira linha.
    const r = await bot.rodarSincronizacaoChatwoot();
    igual('desligado: a rotina periodica nao faz nada', r, null);
    igual('desligado: zero requisicao ao Chatwoot', aoChatwoot().length, 0);
    igual('desligado: zero PUT', puts().length, 0);
    // E a tabela existe de qualquer jeito (a migracao nao depende da flag) — e o que garante que
    // ligar a flag depois nao precisa de deploy de schema.
    checar('desligado: a tabela do espelho existe mesmo assim', !!bot.stmtsChatwoot().contar.get());
  }

  if (MODO === 'dryrun') {
    const r = await bot.rodarSincronizacaoChatwoot();
    checar('dry-run: o ciclo roda de verdade', !!r && r.analisados === 1, r);
    igual('dry-run: e diz o que escreveria', r.escreveria, 1);
    igual('dry-run: mas nao escreve', r.escritos, 0);
    // A assercao central deste arquivo.
    igual('dry-run: ZERO PUT na instancia do Chatwoot', puts().length, 0);
    checar('dry-run: leu a ficha (e por isso mede de verdade)', aoChatwoot().some((c) => c.metodo === 'GET'), aoChatwoot().map((c) => c.metodo));
    igual('dry-run: a amostra mostra o nome que iria', r.amostra[0].para, 'Maria de Fatima');
    // Nada de estado de escrita gravado: no proximo ciclo o dry-run tem de medir a mesma coisa.
    const l = bot.stmtsChatwoot().get.get(CHAVE);
    checar('dry-run: nao grava nome_escrito', !l.nome_escrito, l.nome_escrito);
    checar('dry-run: nao grava hash de escrita', !l.escrita_hash, l.escrita_hash);
    // A rota tambem respeita a flag mestra: ?aplicar=1 nao vence CHATWOOT_DRY_RUN.
    const viaRota = await bot.sincronizarContatosChatwoot({ aplicar: true });
    igual('dry-run: aplicar=true nao vence a flag mestra', viaRota.aplicar, false);
    igual('dry-run: e continua sem PUT', puts().length, 0);
  }

  db.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passou: ${passou} | Falhou: ${falhou}`);
  console.log('='.repeat(50));
  process.exit(falhou > 0 ? 1 : 0);
})();
