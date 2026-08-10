// Worker: processa conversas da fila (executado como processo filho)
process.env.WORKER_MODE = '1';

const { lerFila, registrarFalha, removerComSucesso, MAX_TENTATIVAS } = require('./src/fila');

async function work() {
  const fila = lerFila();
  if (fila.length === 0) {
    console.log('[worker] Fila vazia');
    return;
  }

  console.log(`[worker] ${fila.length} itens na fila`);
  const bot = require('./index.js');

  const sucessos = [];
  const desistidos = [];

  for (const { chatId, tentativas } of fila) {
    console.log(`\n[worker] Processando ${chatId}${tentativas ? ` (tentativa ${tentativas + 1}/${MAX_TENTATIVAS})` : ''}...`);
    try {
      await bot.processarConversaDirect(chatId);
      console.log(`[worker] ${chatId} concluido`);
      sucessos.push(chatId);
    } catch (e) {
      // Agora chega de verdade aqui: processarConversaDirect voltou a relancar. Antes ela engolia
      // tudo, este catch era inalcancavel e o chatId com falha saia da fila como se fosse sucesso.
      const r = registrarFalha(chatId);
      if (r.desistiu) {
        console.error(`[worker] ${chatId} FALHOU ${r.tentativas}x — desistindo e removendo da fila: ${e.message}`);
        desistidos.push({ chatId, erro: e.message });
      } else {
        console.error(`[worker] ${chatId} erro (tentativa ${r.tentativas}/${MAX_TENTATIVAS}, fica na fila): ${e.message}`);
      }
    }
  }

  removerComSucesso(sucessos);

  // Lead descartado nao pode sumir em silencio — foi exatamente esse o bug. Avisa quem pode agir.
  for (const d of desistidos) {
    try {
      await bot.enviarTelegram(
        `❌ *Conversa descartada após ${MAX_TENTATIVAS} falhas*\n\n` +
        `Telefone: \`${d.chatId}\`\n` +
        `Último erro: ${d.erro}\n\n` +
        `O bot parou de tentar processar esse lead. Verificar manualmente.`
      );
    } catch (e) {
      console.error(`[worker] falha ao avisar no Telegram sobre ${d.chatId}: ${e.message}`);
    }
  }

  const restantes = lerFila();
  if (restantes.length > 0) {
    console.log(`[worker] ${restantes.length} itens permanecem na fila para nova tentativa`);
  }
  console.log('[worker] Fim');
}

work().catch((e) => {
  console.error('[worker] Erro fatal:', e.message);
  process.exit(1);
});
