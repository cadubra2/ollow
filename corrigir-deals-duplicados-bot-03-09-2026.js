// Correcao pontual (03/09/2026), Fase 1 do PLANO-CORRECAO-QUALIDADE-DEALS.md — duplicidade nos deals
// que o BOT criou. Levantamento: dos 9 pares que a auditoria de 02/09/2026 (auditoria-crm/2026-09-02T18-41-08-335Z)
// achou envolvendo pelo menos um deal BOT_WHATSAPP, 3 (Eric, Jailma, Regislane) JA FORAM corrigidos
// em 24/08/2026 (corrigir-deals-duplicados-24-08-2026.js) — a auditoria os re-flagra porque o par
// continua "mesmo nome/mesmo caso" independente do status, mas o lado perdedor ja esta LOST com nota
// explicando. CONFERIDO ao vivo contra o Moskit em 03/09/2026 antes de escrever este script (nao
// confiar so no snapshot de um dia atras): Eric/Jailma/Regislane ja LOST; nenhum outro par da lista
// de 24/08 aparece nos 9 daqui.
//
// Restam 6 pares novos, divididos em 2 grupos (mesmo criterio do plano):
//
// GRUPO A — alta confianca, --aplicar escreve: telefone igual, criados com poucos dias/semanas de
// diferenca, mesmo caso. So 1 par se qualifica:
//   Washington Lins (48474073, WON, 14/08) x Washington Wallace Souza Lins (48971188, OPEN, 26/08)
//   Confirmado nas notas dos dois deals (mandado de seguranca / colacao de grau / mesmo concurso),
//   mesmo telefone, contatos DIFERENTES no Moskit (47705276 x 47953046 — a assinatura exata do bug
//   de buscarOuCriarContato ja documentado no CLAUDE.md). Marca 48971188 como LOST + nota; posta nota
//   linkando no 48474073 (mantido, ja WON).
//
// GRUPO B — precisa de revisao humana, NUNCA escreve neste script (nem com --aplicar): telefone
// diferente OU anos de diferenca entre os dois — mais provavel ser cliente que voltou com caso novo
// (retorno legitimo) do que duplicata de bug. So imprime um relatorio com os dois deals lado a lado
// pra equipe decidir.
//
//   node corrigir-deals-duplicados-bot-03-09-2026.js            (dry-run, so imprime)
//   node corrigir-deals-duplicados-bot-03-09-2026.js --aplicar  (escreve SO o grupo A no Moskit)
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar (mesma convencao dos corrigir-*.js
// anteriores). NUNCA rodar em CI/npm test.
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `corrigir-duplicados-bot-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const axios = require('axios');
const bot = require('./index.js'); // reusa criarNotaMoskit — mesma funcao que a producao usa
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
const APLICAR = process.argv.includes('--aplicar');

const GRUPO_A = [
  { nome: 'Washington Lins', manter: 48474073, apagar: 48971188 },
];

const GRUPO_B = [
  { nome: 'Yago Pinto', deal_1: 16565154, deal_2: 48359253, motivo: 'mesmo contato no CRM, mas caso de 2022 (Concurso UFPI, WON) x 2026 (Direito Administrativo, OPEN) — parece retorno legitimo, nao duplicata' },
  { nome: 'Eliete', deal_1: 30187172, deal_2: 48210763, motivo: 'telefone DIFERENTE, ~2 anos de diferenca — pode nem ser a mesma pessoa/duplicata' },
  { nome: 'Hilton Charles', deal_1: 37007367, deal_2: 48407405, motivo: 'mesmo telefone, ~1.7 anos de diferenca, mesmo tipo de caso (colacao de grau) — mais suspeito, mas fora do padrao do bug' },
  { nome: 'Uriel', deal_1: 47659434, deal_2: 48401108, motivo: 'telefone DIFERENTE apesar do caso identico (Vicios Construtivos)' },
  { nome: 'Jéssica', deal_1: 48169449, deal_2: 48431604, motivo: 'telefone DIFERENTE, ~2 semanas de diferenca, texto quase identico' },
];

async function marcarComoLost(dealId, lostReasonId) {
  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (getRes.status < 200 || getRes.status >= 300) throw new Error(`GET /deals/${dealId} falhou (HTTP ${getRes.status})`);
  if (getRes.data?.status !== 'OPEN') throw new Error(`deal ${dealId} nao esta OPEN (esta ${getRes.data?.status}) — conferir na mao antes de aplicar`);
  const dealAtual = { ...getRes.data, status: 'LOST', closeDate: new Date().toISOString(), lostReason: { id: lostReasonId } };
  const putRes = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, dealAtual, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (putRes.status < 200 || putRes.status >= 300) throw new Error(`PUT /deals/${dealId} falhou (HTTP ${putRes.status}): ${JSON.stringify(putRes.data).slice(0, 300)}`);
}

async function conferirStatus(dealId) {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  return r.data?.status;
}

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: vai escrever no Moskit de verdade (so o GRUPO A)\n' : '🔍 dry-run: nada sera escrito, so mostra o que faria\n');

  console.log('=== GRUPO A — alta confianca ===');
  for (const par of GRUPO_A) {
    const notaPerdedor = [
      '🔁 Duplicado — corrigido em 03/09/2026.',
      `Este negócio é o mesmo caso do deal #${par.manter}. Foi criado por engano: uma falha temporária`,
      'na busca de contato no Moskit fez o bot concluir que o cliente era novo e criar um segundo',
      'cadastro (mesmo bug já corrigido em 24/08/2026, esta ocorrência é de 26/08).',
      `Marcado como perdido para não confundir o funil — o acompanhamento real continua no deal #${par.manter}.`,
      'Nada foi apagado; se esta marcação estiver errada, é só reabrir o negócio.',
    ].join(' ');
    const notaMantido = [
      '🔁 Duplicidade identificada e corrigida em 03/09/2026:',
      `o deal #${par.apagar} era o mesmo caso, criado por engano (falha de rede na busca de contato).`,
      'Foi marcado como perdido/duplicado. Nada precisa ser feito aqui.',
    ].join(' ');

    console.log(`--- ${par.nome}: manter ${par.manter}, marcar ${par.apagar} como LOST ---`);
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
    console.log('\n🔎 Conferindo status final...');
    for (const par of GRUPO_A) {
      await new Promise((r) => setTimeout(r, 300));
      const status = await conferirStatus(par.apagar);
      console.log(`  deal ${par.apagar} (${par.nome}): status=${status}${status === 'LOST' ? ' ✅' : ' ⚠️ NAO confirmado como LOST'}`);
    }
  }

  console.log('\n=== GRUPO B — precisa de revisao humana (nunca escrito por este script) ===');
  for (const par of GRUPO_B) {
    console.log(`--- ${par.nome} ---`);
    console.log(`  deal 1: https://app.ollow.com.br/?/deal/${par.deal_1}`);
    console.log(`  deal 2: https://app.ollow.com.br/?/deal/${par.deal_2}`);
    console.log(`  por que nao aplicar sozinho: ${par.motivo}\n`);
  }

  console.log('Concluído.');
})();
