// Correcao pontual (24/08/2026) dos 12 pares de deal duplicado medidos por
// estudar-deals-duplicados.js --sondar-crm --so-bot (ver CLAUDE.md). NAO apaga nada: no deal
// PERDEDOR de cada par, posta uma nota explicando o duplicado e move o status para LOST (reversivel
// — reabrir desfaz). No deal MANTIDO, posta uma nota linkando o duplicado corrigido. Os outros 2
// pares levantados (Marcos/Wallace e Marcelo Henrique) ficam de fora de proposito: o valor/status
// dos dois lados diverge de um jeito que pode nao ser duplicidade de verdade — decisao humana.
//
//   node corrigir-deals-duplicados-24-08-2026.js            (dry-run, so imprime)
//   node corrigir-deals-duplicados-24-08-2026.js --aplicar  (escreve no Moskit de verdade)
//
// Script pontual, ja aplicado — nao reexecutar (mesma convencao dos corrigir-*.js documentados no
// CLAUDE.md). NUNCA rodar em CI/npm test.
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `corrigir-duplicados-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const axios = require('axios');
const bot = require('./index.js'); // reusa criarNotaMoskit — mesma funcao que a producao usa
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
const APLICAR = process.argv.includes('--aplicar');

// { nome, manter (fica como esta), apagar (vira LOST + nota) } — decidido em conjunto com o usuario
// a partir do levantamento de notas/agenda/vinculo de cada par.
const PARES = [
  { nome: 'Priscilla Dutra', manter: 48226006, apagar: 48413914 },
  { nome: 'Eric', manter: 48273067, apagar: 48401150 },
  { nome: 'Jailma', manter: 48272964, apagar: 48403011 },
  { nome: 'Olimpio', manter: 48320992, apagar: 48402576 },
  { nome: 'Regislane', manter: 48346572, apagar: 48401733 },
  { nome: 'Solange', manter: 48706219, apagar: 48402543 },
  { nome: 'Carla', manter: 48430901, apagar: 48103630 },
  { nome: 'Willy', manter: 48272849, apagar: 48402609 },
  { nome: 'Rayra Pureza', manter: 48407608, apagar: 48401085 },
  { nome: 'Sol Pectrovit', manter: 48221821, apagar: 48402595 },
  { nome: 'Natanael Sousa', manter: 48346871, apagar: 48401681 },
  { nome: 'Weldo', manter: 48354611, apagar: 48401652 },
];

// Mesmo padrao de putDealComVerificacao (index.js): reenvia o corpo INTEIRO do GET (peculiaridade da
// API — omitir `activities` faz o Moskit recusar se alguma ja foi concluida) e so sobrepoe os campos
// que realmente mudam.
async function marcarComoLost(dealId, lostReasonId) {
  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (getRes.status < 200 || getRes.status >= 300) throw new Error(`GET /deals/${dealId} falhou (HTTP ${getRes.status})`);
  const dealAtual = { ...getRes.data, status: 'LOST', closeDate: new Date().toISOString(), lostReason: { id: lostReasonId } };
  const putRes = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, dealAtual, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT /deals/${dealId} falhou (HTTP ${putRes.status}): ${JSON.stringify(putRes.data).slice(0, 300)}`);
}

async function conferirStatus(dealId) {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  return r.data?.status;
}

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: vai escrever no Moskit de verdade\n' : '🔍 dry-run: nada sera escrito, so mostra o que faria\n');

  for (const par of PARES) {
    const notaPerdedor = [
      '🔁 Duplicado — corrigido em 24/08/2026.',
      `Este negócio é o mesmo caso do deal #${par.manter}. Foi criado por engano: uma falha temporária`,
      'na busca de contato no Moskit (rede instável/limite de requisições) fez o bot concluir que o',
      'cliente era novo e criar um segundo cadastro. O bug já foi corrigido no código.',
      `Marcado como perdido para não confundir o funil — o acompanhamento real continua no deal #${par.manter}.`,
      'Nada foi apagado; se este marcação estiver errada, é só reabrir o negócio.',
    ].join(' ');
    const notaMantido = [
      '🔁 Duplicidade identificada e corrigida em 24/08/2026:',
      `o deal #${par.apagar} era o mesmo caso, criado por engano (falha de rede na busca de contato).`,
      'Foi marcado como perdido/duplicado. Nada precisa ser feito aqui.',
    ].join(' ');

    console.log(`=== ${par.nome}: manter ${par.manter}, marcar ${par.apagar} como LOST ===`);
    if (!APLICAR) {
      console.log(`  [dry-run] nota em ${par.apagar}: "${notaPerdedor}"`);
      console.log(`  [dry-run] nota em ${par.manter}: "${notaMantido}"`);
      console.log(`  [dry-run] PUT ${par.apagar} -> status=LOST, lostReason="nao informou o motivo"\n`);
      continue;
    }

    try {
      await bot.criarNotaMoskit(par.apagar, notaPerdedor);
      await marcarComoLost(par.apagar, MOSKIT_IDS.LOST_REASON['nao informou o motivo']);
      await bot.criarNotaMoskit(par.manter, notaMantido);
      console.log(`  ✅ feito: ${par.apagar} → LOST + notas postadas nos dois lados\n`);
    } catch (e) {
      console.error(`  ❌ ERRO no par ${par.nome} (manter ${par.manter} / apagar ${par.apagar}): ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  if (APLICAR) {
    console.log('\n🔎 Conferindo status final de cada deal marcado...');
    for (const par of PARES) {
      await new Promise((r) => setTimeout(r, 300));
      const status = await conferirStatus(par.apagar);
      console.log(`  deal ${par.apagar} (${par.nome}): status=${status}${status === 'LOST' ? ' ✅' : ' ⚠️ NAO confirmado como LOST'}`);
    }
  }

  console.log('\nConcluído.');
})();
