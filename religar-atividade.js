// Religar manualmente uma Atividade do Moskit que ficou sem vinculo com o negocio.
//
//   node religar-atividade.js <dealId> <atividadeId>            # dry-run: mostra o que seria feito
//   node religar-atividade.js <dealId> <atividadeId> --aplicar  # ESCREVE no CRM e limpa o estado
//
// ESCREVE EM PRODUCAO com --aplicar. NUNCA rodar em CI nem no npm test.
//
// Por que existe: o Moskit as vezes cria a Atividade sem persistir o vinculo com o negocio (medido
// em 14/08/2026, deals 48474073/48464876). A rotina reconciliarVinculoAtividades tenta religar
// sozinha, mas desiste apos VINCULO_MAX_TENTATIVAS quando o Moskit esta rate-limitando (HTTP 429 /
// timeout) e marca vinculo_desistiu=1 na conversa. O aviso final do Telegram traz este comando.
// Religar aqui: GET da atividade + PUT com o vinculo corrigido (o PUT minimo volta 422, entao o
// corpo do GET vai inteiro) e limpa o estado terminal no banco, para a rotina voltar a vigiar.
//
// O id do negocio e da atividade vem no aviso do Telegram.

const axios = require('axios');
const path = require('path');
const Database = require('better-sqlite3');

const dealId = Number(process.argv[2]);
const atividadeId = Number(process.argv[3]);
const APLICAR = process.argv.includes('--aplicar');

if (!Number.isInteger(dealId) || !Number.isInteger(atividadeId)) {
  console.error('\nUso: node religar-atividade.js <dealId> <atividadeId> [--aplicar]\n');
  process.exit(1);
}

// WORKER_MODE=1 carrega o index.js SEM subir servidor, sem ngrok e sem os setInterval — o mesmo
// truque dos testes de rota. O require abre o conversations.db de producao (DB_PATH nao definido),
// que e o banco cujo estado terminal precisamos limpar.
process.env.WORKER_MODE = '1';
const bot = require('./index.js');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const headers = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
  'X-Ollow-Origin': 'BOT_WHATSAPP',
};

(async () => {
  const dryRun = !APLICAR;
  console.log(`\nReligando a atividade ${atividadeId} ao deal ${dealId}${dryRun ? ' [DRY-RUN — nada sera escrito]' : ' [APLICANDO]'}\n`);

  const atual = await axios.get(`${MOSKIT_BASE}/activities/${atividadeId}`, { headers, validateStatus: (s) => s < 500 });
  if (atual.status !== 200) {
    console.error(`❌ GET /activities/${atividadeId} devolveu HTTP ${atual.status}`);
    process.exit(1);
  }
  const jaVinculada = (atual.data.deals || []).some((d) => Number(d?.id) === Number(dealId));
  console.log(`Atividade: ${atual.data.title || '(sem titulo)'}`);
  console.log(`Deals na atividade: ${(atual.data.deals || []).map((d) => d.id).join(', ') || '(nenhum)'}`);
  console.log(`Vinculo com o deal ${dealId}: ${jaVinculada ? 'JA existe' : 'NAO existe'}`);

  if (!jaVinculada) {
    if (dryRun) {
      console.log('\nO PUT corrigiria `deals` para:', JSON.stringify([{ id: dealId }]));
      console.log('   reenviando o corpo do GET inteiro (payload minimo volta 422 na API real).');
    } else {
      const religou = await bot.garantirVinculoAtividadeDeal(atividadeId, dealId);
      if (!religou) {
        console.error('\n❌ Nao conseguiu religar a atividade ao deal (GET/PUT falhou).');
        process.exit(1);
      }
      console.log('\n✅ Atividade religada ao deal.');
      await bot.criarNotaMoskit(dealId, '🔁 Atividade da agenda religada manualmente ao negócio.').catch(() => {});
    }
  }

  // Limpa o estado terminal da reconciliacao (vinculo_desistiu/backoff/falhas) para a rotina voltar a
  // conferir a linha. Se nao havia estado, e um no-op silencioso.
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'conversations.db');
  const db = new Database(dbPath, { readonly: dryRun });
  const chats = db.prepare('SELECT chat_id FROM conversations WHERE deal_id = ? AND atividade_moskit_id = ?').all(dealId, atividadeId);
  if (chats.length) {
    if (dryRun) {
      console.log(`\n[DRY-RUN] limparia o estado da reconciliacao em ${chats.length} conversa(s).`);
    } else {
      db.prepare(`
        UPDATE conversations
           SET vinculo_falhas = 0, vinculo_desistiu = 0, vinculo_backoff_ate = NULL, vinculo_aviso_hash = NULL
         WHERE deal_id = ? AND atividade_moskit_id = ?
      `).run(dealId, atividadeId);
      console.log(`\n✅ Estado da reconciliacao limpo em ${chats.length} conversa(s).`);
    }
  } else {
    console.log('\nNenhuma conversa com esse deal+atividade no banco (estado da reconciliacao nao se aplica).');
  }
  db.close();

  if (dryRun) console.log('\nPara aplicar de verdade: node religar-atividade.js ' + dealId + ' ' + atividadeId + ' --aplicar\n');
  console.log('\nConcluido.');
})().catch((e) => {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
});