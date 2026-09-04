// Os DOIS jeitos com que o monitor Evolution API -> Chatwoot precisa se provar em produção. Rodar
// com:
//   node test-evolution-flags.js
//
// EVOLUTION_MONITOR_ATIVO e lida como `const` no require do index.js, entao nao ha como exercitar o
// modo desligado no mesmo processo do resto da suite — mesmo motivo de test-chatwoot-flags.js. Este
// arquivo se relanca como filho.
//
// Duas coisas em jogo, e as duas viraram garantia central deste desenho:
//   1) desligado (EVOLUTION_MONITOR_ATIVO=false) nao manda nenhuma requisicao — o monitor e so
//      leitura, mas "so leitura" nao e desculpa pra rodar quando a flag diz pra nao rodar.
//   2) SOBREVIVE A RESTART DO PM2. Se a falha ainda esta ativa quando o processo reinicia, o estado
//      tem que vir do SQLite, nao de uma variavel de processo — senao a memoria de "ja avisei isso"
//      se perde e cada restart manda o mesmo aviso de novo. Isto so pode ser provado com DOIS
//      processos de verdade compartilhando o MESMO banco (um require novo de index.js e o que
//      acontece de fato quando o pm2 reinicia), entao esta prova nao cabe no dublê de um processo so
//      de test-pipeline.js.

const path = require('path');
const { spawnSync } = require('child_process');

const MODOS = {
  desligado: { EVOLUTION_MONITOR_ATIVO: 'false' },
  sem_chatwoot: { EVOLUTION_FLAGS_SEM_CHATWOOT: '1' },
};

if (!process.env.EVOLUTION_FLAGS_MODO) {
  let falhou = false;

  for (const [modo, env] of Object.entries(MODOS)) {
    console.log(`\n${'#'.repeat(50)}\n# modo: ${modo}\n${'#'.repeat(50)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
      stdio: 'inherit',
      env: { ...process.env, ...env, EVOLUTION_FLAGS_MODO: modo },
    });
    if (r.status !== 0) falhou = true;
  }

  // ---------- prova de persistencia: dois processos, o MESMO banco ----------
  console.log(`\n${'#'.repeat(50)}\n# persistencia atraves de "restart" (dois processos, mesmo banco)\n${'#'.repeat(50)}`);
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-restart-'));
  const dbPath = path.join(dir, 'teste.db');
  const envComum = { ...process.env, DB_PATH: dbPath, EVOLUTION_FLAGS_MODO: 'persistencia' };

  console.log('\n-- fase 1: falha acontece, Telegram e mandado, estado gravado --');
  const f1 = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
    stdio: 'inherit', env: { ...envComum, EVOLUTION_FLAGS_FASE: '1' },
  });
  if (f1.status !== 0) falhou = true;

  console.log('\n-- fase 2: processo NOVO (simula restart do pm2), MESMA falha continua --');
  const f2 = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
    stdio: 'inherit', env: { ...envComum, EVOLUTION_FLAGS_FASE: '2' },
  });
  if (f2.status !== 0) falhou = true;

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(falhou ? 1 : 0);
}

const MODO = process.env.EVOLUTION_FLAGS_MODO;
const FASE = process.env.EVOLUTION_FLAGS_FASE;

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

if (!process.env.DB_PATH) {
  const DIR = dirTemporario(`evolution-${MODO}`);
  process.env.DB_PATH = path.join(DIR, 'teste.db');
}
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.EVOLUTION_BASE = 'http://127.0.0.1:8080';
process.env.EVOLUTION_API_KEY = 'chave-falsa-evolution';
process.env.EVOLUTION_INSTANCE = 'escritorio';
// CHATWOOT_BASE tem de ser EXPLICITO aqui, nos dois sentidos. O modo normal precisa de um valor
// fixado (senao o dotenv do index.js pega o .env de quem roda e o veredito passa a depender da
// maquina); o modo `sem_chatwoot` precisa de string VAZIA, nao `delete` — dotenv nao sobrescreve
// chave que ja existe em process.env, mas preencheria uma que fosse apagada.
process.env.CHATWOOT_BASE = process.env.EVOLUTION_FLAGS_SEM_CHATWOOT ? '' : 'http://127.0.0.1:3001';

// ---------- dublê do axios (mesmo padrao de test-pipeline.js) ----------
// Os DOIS metodos, nao so GET: enviarTelegram usa axios.post, e sem dublê nele a fase 1 deste teste
// mandou uma requisicao de VERDADE para api.telegram.org (com token falso, 404, mas rede real —
// exatamente o que um teste nunca pode fazer). Medido nesta sessao.
const axios = require('axios');
const rede = { chamadas: [], get: null, post: null };
axios.get = async (url, cfg) => {
  rede.chamadas.push({ metodo: 'GET', url, cfg });
  const h = rede.get;
  if (h) return h(url, cfg);
  return { status: 200, data: {} };
};
axios.post = async (url, corpo, cfg) => {
  rede.chamadas.push({ metodo: 'POST', url, corpo, cfg });
  const h = rede.post;
  if (h) return h(url, corpo, cfg);
  return { status: 200, data: { ok: true } }; // formato que o cliente do Telegram espera em sucesso
};

const bot = require('./index');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const telegrams = () => rede.chamadas.filter((c) => c.url.includes('api.telegram.org'));

const respostaFalha = (url) => {
  if (url.includes('/instance/fetchInstances')) return { status: 200, data: [{ name: 'escritorio', connectionStatus: 'open' }] };
  if (url.includes('/chatwoot/find/')) return { status: 200, data: { enabled: true, accountId: '9', token: 'algum-token', url: 'http://rails:3000' } };
  if (url.includes('/api/v1/profile')) return { status: 401, data: {} }; // token invalido, o motivo de sempre
  return { status: 200, data: {} };
};

(async () => {
  console.log(`\n=== Evolution, modo "${MODO}"${FASE ? `, fase ${FASE}` : ''} ===`);

  if (MODO === 'desligado') {
    rede.get = respostaFalha; // mesmo com falha de verdade pronta pra detectar
    const r = await bot.monitorarEvolution();
    igual('desligado: o monitor nem roda', r, null);
    igual('desligado: zero requisicao', rede.chamadas.length, 0);
    igual('desligado: zero Telegram', telegrams().length, 0);
    checar('desligado: a tabela existe mesmo assim (migracao nao depende da flag)', !!bot.stmtEvolutionSaude.get());
  }

  if (MODO === 'sem_chatwoot') {
    // O .env da VPS pode ter a secao da Evolution e NAO ter a do Chatwoot — foi exatamente o estado
    // encontrado em 04/09/2026 ao preparar o deploy. Nesse caso o 5o sinal (o token que a Evolution
    // usa pra postar no Chatwoot) e NAO-MENSURAVEL, e "nao consegui medir" nunca pode virar "o token
    // e invalido": seria um alarme falso a cada 5 min, no monitor que existe justamente pra que um
    // aviso signifique incidente de verdade.
    rede.get = respostaFalha; // o /api/v1/profile do dublê responde 401 — nem deve ser chamado
    const r = await bot.monitorarEvolution();
    igual('sem CHATWOOT_BASE: veredito e OK, nao "token_invalido"', r.veredito.motivo, null);
    igual('sem CHATWOOT_BASE: zero Telegram (nada de alarme falso)', telegrams().length, 0);
    checar('sem CHATWOOT_BASE: nem tenta testar o token (nao ha onde)',
      !rede.chamadas.some((c) => c.url.includes('/api/v1/profile')),
      rede.chamadas.map((c) => c.url));
    // E a funcao de baixo nivel LANCA, em vez de devolver false — quem chamar por outro caminho
    // (sondar-evolution.js) recebe um erro claro, nunca um "invalido" inventado.
    let erro = null;
    try { await bot.chatwootTokenValido('qualquer-token'); } catch (e) { erro = e.message; }
    checar('chatwootTokenValido lanca sem CHATWOOT_BASE', /CHATWOOT_BASE nao configurado/.test(erro || ''), erro);
  }

  if (MODO === 'persistencia' && FASE === '1') {
    rede.get = respostaFalha;
    const r = await bot.monitorarEvolution();
    igual('fase 1: detecta a falha', r.veredito.motivo, 'token_invalido');
    igual('fase 1: manda o Telegram', telegrams().length, 1);
    const linha = bot.stmtEvolutionSaude.get();
    igual('fase 1: grava o estado no banco (nao em memoria)', linha.avisado_hash, 'falha:token_invalido');
  }

  if (MODO === 'persistencia' && FASE === '2') {
    // Processo NOVO, banco reaberto do zero — e exatamente o que acontece quando o pm2 reinicia com
    // uma falha ainda ativa. Se o estado fosse uma variavel de processo, teria voltado a null aqui.
    const antes = bot.stmtEvolutionSaude.get();
    igual('fase 2: o avisado_hash da fase 1 SOBREVIVEU ao "restart"', antes.avisado_hash, 'falha:token_invalido');

    rede.get = respostaFalha; // a MESMA falha continua
    const r = await bot.monitorarEvolution();
    igual('fase 2: ainda detecta a mesma falha', r.veredito.motivo, 'token_invalido');
    igual('fase 2: NAO reenvia o mesmo aviso (e isto que a persistencia garante)', telegrams().length, 0);
  }

  db.close();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passou: ${passou} | Falhou: ${falhou}`);
  console.log('='.repeat(50));
  process.exit(falhou > 0 ? 1 : 0);
})();
