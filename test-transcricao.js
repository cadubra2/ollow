// Teste da transcricao de audio do cliente (src/transcricao.js + wiring do index.js).
// Rodar com:
//   node test-transcricao.js
//
// Duas area limpas de rede:
//   - src/transcricao.js: `transcreverAudio` recebe um cliente openai FAKE (nunca toca a API).
//   - index.js: o download (baixarParaArquivo) e atravessado substituindo o adapter padrao do axios
//     por um que devolve um stream local — e `processarAudioCliente` recebe `transcreve` fake.
//
// WORKER_MODE=1 faz agendarProcessamento() ser no-op (sem timers) e o DB_PATH descartavel isola
// do banco de producao, como nos demais testes.

const fs = require('fs');
const { Readable } = require('stream');
const { dirTemporario } = require('./test-utils');
const path = require('path');
const Database = require('better-sqlite3');

const DIR = dirTemporario('transcricao');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.ADMIN_TOKEN = 'token-de-teste';
process.env.WEBHOOK_SECRET = '';
process.env.GOOGLE_CALENDAR_ID = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.OPENAI_AUDIO_MODEL = 'gpt-4o-mini-transcribe';
process.env.OPENAI_AUDIO_TIMEOUT_MS = '120000';

// ---------- dublê do download: adapter local, sem rede ----------
const axios = require('axios');
axios.defaults.adapter = async (config) => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  config,
  request: { res: {} },
  data: Readable.from(['bytes-fake-do-audio']),
});

// ---------- carrega o modulo apos as envs ----------
const { transcreverAudio } = require('./src/transcricao');
const { atualizarTranscricaoNaConversa, processarAudioCliente } = require('./index');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

function semear(chatId, ids, extras = {}) {
  const lista = (Array.isArray(ids) ? ids : [ids]).map((idZernio, i) => ({
    role: 'cliente',
    text: '📎 [cliente enviou um audio]',
    timestamp: `2026-08-01T12:00:0${i}Z`,
    id_zernio: idZernio,
  }));
  const campos = {
    chat_id: chatId, phone: chatId, contact_name: 'Alguem', processed: 0,
    messages: JSON.stringify(lista),
    ...extras,
  };
  const cols = Object.keys(campos);
  db.prepare(`INSERT OR REPLACE INTO conversations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => campos[c]));
}

function mensagens(chatId) {
  const row = db.prepare('SELECT messages FROM conversations WHERE chat_id = ?').get(chatId);
  return row ? JSON.parse(row.messages) : [];
}

const AUDIO_ATT = { type: 'audio', url: 'https://exemplo.invalido/nota.ogg', payload: { filename: 'nota-de-voz.ogg' } };

const CAMINHO_AUDIO = path.join(DIR, 'audio-fake.ogg');
fs.writeFileSync(CAMINHO_AUDIO, 'bytes-fake-do-audio');

(async () => {
  console.log('\n=== src/transcricao.js: transcreverAudio com cliente fake ===');

  {
    let chamada = null;
    const fake = { audio: { transcriptions: { create: async (corpo) => { chamada = corpo; return { text: '  Quero agendar uma consulta sobre inventário  ' }; } } } };
    const texto = await transcreverAudio(CAMINHO_AUDIO, { cliente: fake });
    igual('transcricao com sucesso vira texto trimado', texto, 'Quero agendar uma consulta sobre inventário');
    igual('envia o modelo configurado', chamada?.model, 'gpt-4o-mini-transcribe');
    igual('declara o idioma pt (pt-BR do escritorio)', chamada?.language, 'pt');
    igual('passa o arquivo como stream', checarTipo(chamada?.file), 'stream');
  }

  {
    const fake = { audio: { transcriptions: { create: async () => ({ text: '   ' }) } } };
    igual('resposta vazia (audio sem fala) vira null', await transcreverAudio(CAMINHO_AUDIO, { cliente: fake }), null);
  }

  {
    const fake = { audio: { transcriptions: { create: async () => { throw new Error('API fora'); } } } };
    checar('erro da API NAO lanca — vira null', (await transcreverAudio(CAMINHO_AUDIO, { cliente: fake })) === null);
  }

  igual('caminho nulo vira null', await transcreverAudio(null, { cliente: {} }), null);
  igual('arquivo inexistente vira null (sem uncaughtException)', await transcreverAudio(path.join(DIR, 'nao-existe.ogg'), { cliente: {} }), null);

  console.log('\n=== atualizarTranscricaoNaConversa (banco) ===');

  {
    const chat = '5599111122222';
    semear(chat, 'm1');
    const ok = atualizarTranscricaoNaConversa(chat, 'm1', 'Boletim do processo saiu');
    igual('substitui o placeholder pela transcricao', ok, true);
    const msg = mensagens(chat)[0];
    igual('texto final com marcador de audio', msg.text, '🎧 Transcrição do áudio: Boletim do processo saiu');
    igual('preserva role cliente', msg.role, 'cliente');
    igual('preserva timestamp original', msg.timestamp, '2026-08-01T12:00:00Z');
    igual('preserva id_zernio', msg.id_zernio, 'm1');
    checar('idempotente: segunda chamada nao transcreve de novo', atualizarTranscricaoNaConversa(chat, 'm1', 'de novo') === false);
    igual('texto nao mudou apos a duplicata', mensagens(chat)[0].text, '🎧 Transcrição do áudio: Boletim do processo saiu');
  }

  {
    const chat = '5599133334444';
    semear(chat, 'm2');
    igual('id_zernio inexistente vira no-op', atualizarTranscricaoNaConversa(chat, 'm-que-nao-existe', 'x'), false);
    igual('mensagem original intocada', mensagens(chat)[0].text, '📎 [cliente enviou um audio]');
  }

  {
    const chat = '5599144445555';
    semear(chat, 'm3');
    igual('sem idZernio vira no-op', atualizarTranscricaoNaConversa(chat, null, 'x'), false);
    igual('sem texto vira no-op', atualizarTranscricaoNaConversa(chat, 'm3', ''), false);
  }

  console.log('\n=== processarAudioCliente (download + transcreve + banco) ===');

  {
    const chat = '5599155556666';
    const id = 'm4';
    semear(chat, id);
    let chamouTranscreve = false;
    const transcreve = async () => { chamouTranscreve = true; return 'Preciso de um advogado para meu caso'; };
    await processarAudioCliente(chat, AUDIO_ATT, id, transcreve);
    igual('transcreve foi chamado', chamouTranscreve, true);
    igual('transcricao acabou no historico', mensagens(chat)[0].text, '🎧 Transcrição do áudio: Preciso de um advogado para meu caso');
  }

  {
    const chat = '5599166667777';
    const id = 'm5';
    semear(chat, id);
    let chamouTranscreve = false;
    await processarAudioCliente(chat, { type: 'audio', payload: {} }, id, async () => { chamouTranscreve = true; return 'x'; });
    // Sem URL o download nao acontece (nao tenta rede) e a transcricao nem chega a rodar.
    checar('audio sem URL nao chama transcreve', chamouTranscreve === false);
    igual('placeholder preservado', mensagens(chat)[0].text, '📎 [cliente enviou um audio]');
  }

  {
    const chat = '5599177778888';
    const id = 'm6';
    semear(chat, id);
    await processarAudioCliente(chat, AUDIO_ATT, id, async () => { throw new Error('transcricao falhou'); }).catch(() => {});
    igual('falha na transcricao NUNCA estrangula a conversa', mensagens(chat)[0].text, '📎 [cliente enviou um audio]');
  }

  {
    // Dois audios seguidos na mesma conversa: a fila por chat impede que o segundo sobrescreva o
    // texto do primeiro (leitura do array seria do mesmo snapshot sem a serializacao).
    const chat = '5599188889999';
    semear(chat, ['a1', 'a2']);
    const ordem = [];
    await Promise.all([
      processarAudioCliente(chat, AUDIO_ATT, 'a1', async () => { await new Promise((r) => setTimeout(r, 20)); ordem.push('a1'); return 'primeiro audio'; }),
      processarAudioCliente(chat, AUDIO_ATT, 'a2', async () => { ordem.push('a2'); return 'segundo audio'; }),
    ]);
    const msgs = mensagens(chat);
    checar('audios executaram em sequencia por chat', ordem.join(',') === 'a1,a2', ordem);
    igual('primeiro audio transcrito', msgs.find((m) => m.id_zernio === 'a1')?.text, '🎧 Transcrição do áudio: primeiro audio');
    igual('segundo audio transcrito', msgs.find((m) => m.id_zernio === 'a2')?.text, '🎧 Transcrição do áudio: segundo audio');
  }

  console.log(`\n${falhou === 0 ? '✅' : '❌'} ${passou} passaram, ${falhou} falharam\n`);
  // Limpa os audios fake gravados em comprovantes/<phone> do repo (numeros de teste, nao reais).
  const base = path.join(__dirname, 'comprovantes');
  for (const phone of ['5599155556666', '5599166667777', '5599177778888', '5599188889999']) {
    try { fs.rmSync(path.join(base, phone), { recursive: true, force: true }); } catch {}
  }
  process.exit(falhou === 0 ? 0 : 1);
})().catch((e) => { console.error('❌ ERRO no teste:', e); process.exit(1); });

function checarTipo(valor) {
  if (valor && typeof valor.pipe === 'function') return 'stream';
  if (valor instanceof Readable) return 'stream';
  return typeof valor;
}