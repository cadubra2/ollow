// Fila de processamento compartilhada entre o servidor (index.js, que enfileira) e o worker
// (worker.js, que consome). Antes cada um tinha sua propria copia de lerFila/salvarFila e do
// caminho do arquivo — duas implementacoes do mesmo contrato, livres pra divergir.
//
// Formato do item: { chatId, tentativas }. Versoes antigas gravavam string pura; `normalizar`
// aceita as duas formas pra que uma fila ja existente em disco continue valendo apos o deploy.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_DIR = path.join(os.tmpdir(), 'apiollow-bot');
// QUEUE_FILE configuravel so para TESTE: sem isso um teste de fila sobrescreve a fila real, que e
// compartilhada com o worker. TEMP_DIR fica fixo — index.js usa a mesma pasta para o worker.lock.
const QUEUE_FILE = process.env.QUEUE_FILE || path.join(TEMP_DIR, 'process_queue.json');

// Cada tentativa custa 2 chamadas a OpenAI com a conversa inteira. Falha permanente (deal apagado,
// messages corrompido) nao pode ficar reprocessando pra sempre.
const MAX_TENTATIVAS = 3;

try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

function normalizar(item) {
  if (typeof item === 'string') return { chatId: item, tentativas: 0 };
  if (item && typeof item.chatId === 'string') {
    return { chatId: item.chatId, tentativas: Number(item.tentativas) || 0 };
  }
  return null;
}

function lerFila() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const bruto = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return (Array.isArray(bruto) ? bruto : []).map(normalizar).filter(Boolean);
  } catch (e) {
    console.error(`  ⚠️ fila ilegivel (${e.message}) — tratando como vazia`);
    return [];
  }
}

function salvarFila(itens) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(itens));
    return true;
  } catch (e) {
    console.error(`  ❌ nao foi possivel gravar a fila: ${e.message}`);
    return false;
  }
}

// Idempotente: reenfileirar um chat que ja esta na fila nao zera o contador de tentativas dele.
function enfileirar(chatId) {
  const fila = lerFila();
  if (!fila.some((i) => i.chatId === chatId)) fila.push({ chatId, tentativas: 0 });
  salvarFila(fila);
}

// Chamado pelo worker quando processarConversaDirect lanca. Devolve o total de tentativas ja feitas
// e se o item foi desistido (removido da fila por exceder MAX_TENTATIVAS).
function registrarFalha(chatId) {
  const fila = lerFila();
  const item = fila.find((i) => i.chatId === chatId);
  const tentativas = (item ? item.tentativas : 0) + 1;
  const desistiu = tentativas >= MAX_TENTATIVAS;

  const restante = desistiu
    ? fila.filter((i) => i.chatId !== chatId)
    : fila.map((i) => (i.chatId === chatId ? { ...i, tentativas } : i));

  // Se o item nao estava na fila (worker o pegou de um snapshot antigo) e ainda ha tentativa
  // sobrando, recoloca — senao a falha viraria o mesmo descarte silencioso de antes.
  if (!desistiu && !restante.some((i) => i.chatId === chatId)) restante.push({ chatId, tentativas });

  salvarFila(restante);
  return { tentativas, desistiu };
}

function removerComSucesso(chatIds) {
  const alvo = new Set(chatIds);
  salvarFila(lerFila().filter((i) => !alvo.has(i.chatId)));
}

module.exports = {
  QUEUE_FILE,
  TEMP_DIR,
  MAX_TENTATIVAS,
  lerFila,
  salvarFila,
  enfileirar,
  registrarFalha,
  removerComSucesso,
};
