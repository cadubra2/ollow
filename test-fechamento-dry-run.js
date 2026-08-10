// Testa a NOVA implementacao de fechamento em dry-run contra o Moskit REAL e um Telegram REAL.
//
// O que e seguro: com FUNIL_FECHAMENTO_DRY_RUN=true (padrao em producao) NAO fecha nada — apenas
// cria uma nota real no deal e envia a notificacao do Telegram. Estagio e status permanecem intactos.
//
//   node test-fechamento-dry-run.js <dealId>
//
// Use um deal de TESTE com status OPEN (o bot nunca reabre/refecha negocio ja fechado). O script
// aborta se FUNIL_FECHAMENTO_DRY_RUN=false, para nunca fechar de verdade por acidente.

require('dotenv').config();
const path = require('path');
const os = require('os');
const axios = require('axios');

if (process.env.FUNIL_FECHAMENTO_DRY_RUN !== 'true') {
  console.error('⚠️  FUNIL_FECHAMENTO_DRY_RUN nao esta como "true" — este teste so roda em dry-run. Abortando.');
  process.exit(1);
}

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), 'apiollow-fechamento-dryrun-teste.db');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_TEST' };

const dealId = process.argv[2];
if (!dealId || !/^\d+$/.test(dealId)) {
  console.error('Uso: node test-fechamento-dry-run.js <dealId>  (use um deal de TESTE com status OPEN)');
  process.exit(1);
}
if (!process.env.MOSKIT_API_KEY) {
  console.error('MOSKIT_API_KEY ausente no .env');
  process.exit(1);
}

let passou = 0;
let falhou = 0;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function checar(nome, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✅ ${nome}`); }
  else { falhou += 1; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}

(async () => {
  const { fecharNegocioSeAplicavel } = require('./index');

  console.log(`\nDeal em teste: ${dealId}\n`);

  const antesRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 });
  const antes = antesRes.data;
  checar('deal existe', !!antes?.id, antesRes.status);
  checar('deal esta OPEN (se ja fechado o bot nunca reabre)', antes?.status === 'OPEN', antes?.status);
  const stageAntes = antes?.stage?.id;
  const nameAntes = antes?.name;
  console.log(`  -> status=${antes?.status} stage=${stageAntes} name="${nameAntes}"`);

  const obsValidas = [{ tipo: 'equipe_declarou_ganho', msg_idx: 0, trecho: 'assinou o contrato (teste manual)' }];
  await fecharNegocioSeAplicavel(
    dealId,
    'ganho',
    'teste manual da notificacao de ganho',
    obsValidas,
    'CLIENTE TESTE NOTIF',
    '5511999999999'
  );

  const depoisRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 });
  const depois = depoisRes.data;
  checar('status continua OPEN (nao fechou de verdade)', depois?.status === 'OPEN', depois?.status);
  checar('estagio inalterado', String(depois?.stage?.id) === String(stageAntes), depois?.stage?.id);
  checar('name inalterado', String(depois?.name) === String(nameAntes), depois?.name);

  try {
    await espera(2000);
    const notasRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}/notes`, { headers, validateStatus: (s) => s < 500 });
    const notas = notasRes.data || [];
    const nova = notas.filter((n) => (n.description || n.descricao || '').includes('CLIENTE TESTE NOTIF')).pop();
    checar('nota criada no deal com o nome do cliente', !!nova);
    if (nova) {
      const txt = nova.description || nova.descricao || '';
      checar('   ...marcada como dry-run', txt.includes('dry-run'));
      checar('   ...cita o telefone', txt.includes('5511999999999'));
      checar('   ...cita o resultado sugerido ganho', txt.includes('ganho'));
      checar('   ...cita o motivo', txt.includes('teste manual da notificacao de ganho'));
    }
  } catch (e) {
    console.log(`  ⚠️ nao consegui ler as notas do deal para conferir: ${e.message}`);
  }

  console.log('\nA validacao acima rodou contra o Moskit REAL.');
  console.log('Se TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID estao no .env, a mensagem "🤖 [dry-run] Fechamento sugerido" ja foi enviada agora ao Telegram do escritorio.');
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})().catch((e) => {
  console.error('\n❌', e.response?.status || '', e.message || e);
  process.exit(1);
});