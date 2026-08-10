// Transcricao de audio do cliente (WhatsApp -> OpenAI).
//
// O pipeline do bot so enxerga texto: um audio de voz gravado como placeholder
// ("📎 [cliente enviou um audio]") nao informa nada a classificacao nem a extracao.
// Aqui o audio baixado vira texto via POST /v1/audio/transcriptions (SDK openai,
// modelo gpt-4o-mini-transcribe — ~US$0,003 por minuto de audio), e o texto entra
// no historico da conversa como a propria mensagem do cliente (ver
// atualizarTranscricaoNaConversa em index.js).
//
// Contrato: transcreverAudio NUNCA lanca. Falha (timeout, API fora, audio ilegivel
// ou sem fala) devolve null e quem chamou mantem o placeholder — a conversa segue
// processando sem o conteudo, nunca trava.
//
// O cliente openai e INJETAVEL por parametro (os testes passam um fake): por padrao
// e criado lazily com maxRetries 0 — sem retry automatico que pendure, mesma
// filosofia do openaiChat (index.js).

const fs = require('fs');
const OpenAI = require('openai');

const MODELO_AUDIO = process.env.OPENAI_AUDIO_MODEL || 'gpt-4o-mini-transcribe';
// Transcricao demora mais que os 25-30s do openaiChat: timeout proprio, configuravel.
const TIMEOUT_AUDIO_MS = Number(process.env.OPENAI_AUDIO_TIMEOUT_MS) || 120000;

let clientePadrao = null;
function getCliente() {
  if (clientePadrao) return clientePadrao;
  clientePadrao = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: TIMEOUT_AUDIO_MS,
  });
  return clientePadrao;
}

// Retorna o texto transcrito (trimado) ou null.
// O arquivo e VERIFICADO antes de abrir: fs.createReadStream falha emitindo um evento de
// erro ASINCRONO (nao lanca), que um try/catch nao pega e vira uncaughtException. Checar
// acesso antes e segurar o erro do stream mantem o contrato "nunca lanca" de verdade.
async function transcreverAudio(caminho, { cliente } = {}) {
  if (!caminho) return null;
  try {
    await fs.promises.access(caminho, fs.constants.R_OK);
  } catch {
    console.log(`  🎧 arquivo de audio inacessivel (${caminho}) — mantendo placeholder`);
    return null;
  }
  try {
    const leitura = fs.createReadStream(caminho);
    leitura.on('error', () => {}); // nunca deixa erro do stream virar uncaughtException
    const resposta = await (cliente || getCliente()).audio.transcriptions.create({
      file: leitura,
      model: MODELO_AUDIO,
      language: 'pt', // escritorio atende em pt-BR — o idioma explicito melhora acuracia/latencia
    });
    leitura.destroy();
    const texto = String(resposta?.text || '').trim();
    if (!texto) {
      console.log('  🎧 transcricao vazia (audio sem fala ou ilegivel) — mantendo placeholder');
      return null;
    }
    return texto;
  } catch (e) {
    console.error(`  🎧 erro ao transcrever audio (${e.message}) — mantendo placeholder`);
    return null;
  }
}

module.exports = { transcreverAudio, MODELO_AUDIO, TIMEOUT_AUDIO_MS };
