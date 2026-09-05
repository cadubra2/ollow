// Os dois jeitos de o anexo da transcricao NAO ser tentado — e a garantia de que nenhum dos dois
// volta a ser silencioso. Rodar com:
//   node test-notas-anexo-flags.js
//
// POR QUE UM ARQUIVO PROPRIO: `NOTAS_ANEXO_ATIVO` e `PUBLIC_BASE_URL` sao lidas como `const` no
// require do index.js. test-pipeline.js fixa as duas como LIGADA/preenchida no topo (senao todos os
// testes de anexo passariam vazios), entao os dois cenarios abaixo nao cabem no mesmo processo —
// mesmo motivo de test-agenda-dry-run.js e test-chatwoot-flags.js. Este arquivo se relanca como filho.
//
// O QUE ESTA EM JOGO (medido em 04/09/2026): das 12 reunioes gravadas ate entao, 10 estavam com
// `anexo_estado = NULL` e `anexo_tentativas = 0`. As notas concluiram enquanto NOTAS_ANEXO_ATIVO
// ainda estava desligada — a flag foi ligada 11 minutos depois — e, como estado de nota concluida e
// terminal, elas nunca voltaram a ser processadas. `anexosPendentes` so retoma 'ANEXANDO', entao
// NULL nao era "ainda vou tentar": era um buraco que ninguem ia olhar de novo. Dez transcricoes de
// consulta juridica ficaram fora do CRM sem uma linha de log, e so apareceram porque alguem foi
// procurar. O estado explicito nao recupera nada — faz a proxima vez ser PERGUNTAVEL.

const path = require('path');
const { spawnSync } = require('child_process');

const MODOS = {
  // Funcionalidade desligada: e configuracao deliberada, nao defeito. Grava o motivo e fica quieta.
  desligado: { NOTAS_ANEXO_ATIVO: 'false', PUBLIC_BASE_URL: 'https://tunel-de-teste.example' },
  // Ligada e sem URL publica: o tunel caiu ou mudou de endereco. Isso e defeito, e avisa.
  sem_url: { NOTAS_ANEXO_ATIVO: 'true', PUBLIC_BASE_URL: '' },
};

if (!process.env.NOTAS_ANEXO_FLAGS_MODO) {
  let falhou = false;
  for (const [modo, env] of Object.entries(MODOS)) {
    console.log(`\n${'#'.repeat(50)}\n# modo: ${modo}\n${'#'.repeat(50)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
      stdio: 'inherit',
      env: { ...process.env, ...env, NOTAS_ANEXO_FLAGS_MODO: modo },
    });
    if (r.status !== 0) falhou = true;
  }
  process.exit(falhou ? 1 : 0);
}

const MODO = process.env.NOTAS_ANEXO_FLAGS_MODO;

const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

process.env.DB_PATH = path.join(dirTemporario(`notas-anexo-${MODO}`), 'teste.db');
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
// PUBLIC_BASE_URL ja veio do pai, e no modo `sem_url` ela e string VAZIA de proposito — nunca
// `delete`. O `require('dotenv').config()` do index.js nao sobrescreve chave que ja existe em
// process.env, mas preencheria de volta uma que fosse apagada, a partir do .env de quem roda: o
// teste passaria a depender da maquina. Mesma armadilha do CHATWOOT_BASE em test-evolution-flags.js.

// ---------- dublê do axios (mesmo padrao de test-pipeline.js) ----------
const axios = require('axios');
const rede = { chamadas: [] };
axios.get = async (url, cfg) => { rede.chamadas.push({ metodo: 'GET', url, cfg }); return { status: 200, data: [] }; };
axios.post = async (url, corpo, cfg) => { rede.chamadas.push({ metodo: 'POST', url, corpo, cfg }); return { status: 200, data: { ok: true, id: 1 } }; };
axios.put = async (url, corpo, cfg) => { rede.chamadas.push({ metodo: 'PUT', url, corpo, cfg }); return { status: 200, data: {} }; };

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
const moskit = () => rede.chamadas.filter((c) => !c.url.includes('api.telegram.org'));

// Um Doc que exporta um PDF valido: se o anexo NAO acontecer, e por causa da flag, nunca por falta
// de material. Sem isso o teste passaria pelo motivo errado.
const PDF_FALSO = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const driveComPdf = () => ({ files: { export: async () => ({ data: PDF_FALSO }) } });

function semearNotaConcluida(s, id) {
  db.prepare('DELETE FROM notas_reuniao').run();
  s.inserir.run(id, 'assunto');
  s.avancar.run({
    doc_id: 'doc-1', evento_id: null, metodo: 'evento_telefone', diagnostico: null, extracao: null,
    marcador: '[ollow-notas:abcd1234]', gmail_message_id: id, estado: 'CONCLUIDO', deal_id: 48292471,
    ultimo_erro: null,
  });
}

(async () => {
  console.log(`\n=== anexo da transcricao, modo "${MODO}" ===`);
  const s = bot.stmtsNotas(false);
  semearNotaConcluida(s, 'msg-flag');

  const r = await bot.anexarDocNoDeal({
    dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-flag', dataIso: '2026-08-14',
    marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
  });
  const linha = s.get.get('msg-flag');

  if (MODO === 'desligado') {
    igual('desligado: nao anexa', r.anexado, false);
    igual('desligado: motivo nomeado', r.motivo, 'desligado');
    // O CENTRO DESTE ARQUIVO: NULL era o buraco mudo. Hoje a linha diz por que ficou de fora.
    igual('desligado: grava DESLIGADO, nunca NULL', linha.anexo_estado, 'DESLIGADO');
    igual('desligado: zero requisicao (nem Drive, nem Moskit)', moskit().length, 0);
    // Configuracao deliberada nao vira alarme: com a funcionalidade desligada isso dispararia em
    // TODA nota, e um aviso que chega todo dia deixa de ser lido — a licao dos 6 negocios que
    // inundaram o Telegram em agosto.
    igual('desligado: zero Telegram (e configuracao, nao defeito)', telegrams().length, 0);
  }

  if (MODO === 'sem_url') {
    igual('sem URL publica: nao anexa', r.anexado, false);
    igual('sem URL publica: motivo nomeado', r.motivo, 'sem_url_base');
    igual('sem URL publica: grava SEM_URL, nunca NULL', linha.anexo_estado, 'SEM_URL');
    igual('sem URL publica: nenhum POST de anexo', moskit().filter((c) => c.metodo === 'POST').length, 0);
    // AQUI avisa: a funcionalidade esta ligada e mesmo assim a transcricao nao subiu. Tunel caido e
    // defeito, e cada reuniao que passar por aqui perde o arquivo.
    igual('sem URL publica: UM Telegram', telegrams().length, 1);
    checar('sem URL publica: o aviso diz o que fazer',
      /PUBLIC_BASE_URL/.test(JSON.stringify(telegrams()[0]?.corpo || {})),
      telegrams()[0]?.corpo);
  }

  // Vale para os dois modos: o estado novo NAO pode ser confundido com "pendente". `anexosPendentes`
  // so casa 'ANEXANDO' — se um destes estados entrasse na fila da rede de seguranca, a rotina ficaria
  // retentando para sempre algo que depende de configuracao, nao de tempo.
  const pendentes = s.anexosPendentes.all({ maxTentativas: 3, limite: 10 });
  igual('o estado novo nao entra na fila de retomada', pendentes.length, 0);
  // E nao gasta tentativa: o bracket nem chegou a abrir, entao o orcamento de 3 continua inteiro
  // para quando a configuracao voltar ao normal.
  igual('e nao gastou tentativa', linha.anexo_tentativas, 0);

  db.close();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passou: ${passou} | Falhou: ${falhou}`);
  console.log('='.repeat(50));
  process.exit(falhou > 0 ? 1 : 0);
})();
