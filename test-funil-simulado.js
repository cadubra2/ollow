// Simula uma conversa que evolui o deal por TODAS as etapas do funil, de verdade no Moskit.
//
// O que e SIMULADO: a extracao da IA (qual estagio_funil_sugerido ela devolveria para aquela
// conversa). O que e REAL: moverEstagioSeAvancar → moverParaEstagio → PUT real no Moskit (muda o
// estagio de verdade, sem dry-run), nota real criada a cada avanco, e a notificacao de fechamento
// em dry-run ao final (nao fecha nada).
//
//   node test-funil-simulado.js <dealId>
//
// Use um deal de TESTE. Cada avanco so acontece se for PRIORIDADE MAIOR no MOSKIT_STAGE_MAP; nunca
// regride. Se um PUT nao se confirmar, putDealComVerificacao LANA ERRO — o script para na etapa.

require('dotenv').config();
const path = require('path');
const os = require('os');
const axios = require('axios');

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), 'apiollow-funil-simulado-teste.db');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json' };

const dealId = process.argv[2];
if (!dealId || !/^\d+$/.test(dealId)) {
  console.error('Uso: node test-funil-simulado.js <dealId>  (deal de TESTE)');
  process.exit(1);
}
if (!process.env.MOSKIT_API_KEY) {
  console.error('MOSKIT_API_KEY ausente no .env');
  process.exit(1);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`    ✅ ${nome}`); }
  else { falhou += 1; console.log(`    ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}

// Etapas do funil na ordem real do MOSKIT_STAGE_MAP (priority 3 → 17).
const ETAPAS = [
  { key: 'consulta_agendada', rotulo: 'Consulta agendada', esperado: Number(process.env.MOSKIT_STAGE_CONSULTA_AGENDADA) || 184382, linhas: [
    '👤 Cliente: "Quero marcar uma consulta. Segunda às 14h pode?"',
    '🏢 Equipe:  "Pode sim, segunda 14h confirmado."',
    '👤 Cliente: "Então confirmo, segunda 14h."',
  ] },
  { key: 'aguardando_condicao', rotulo: 'Aguardando condição', esperado: Number(process.env.MOSKIT_STAGE_AGUARDANDO_CONDICAO) || 285584, linhas: [
    '🏢 Equipe:  "As condições são: pagamento à vista com 5% de desconto ou 3x sem juros."',
  ] },
  { key: 'elaboracao_proposta', rotulo: 'Elaboração de proposta', esperado: Number(process.env.MOSKIT_STAGE_ELABORACAO_PROPOSTA) || 267035, linhas: [
    '🏢 Equipe:  "Vou elaborar a proposta e te envio em seguida."',
  ] },
  { key: 'negociacao', rotulo: 'Negociação', esperado: Number(process.env.MOSKIT_STAGE_NEGOCIACAO) || 182159, linhas: [
    '👤 Cliente: "Dá para negociar 10% de desconto?"',
    '🏢 Equipe:  "Consigo chegar a 5%, combinado?"',
  ] },
  { key: 'elaboracao_contrato', rotulo: 'Elaboração de contrato', esperado: Number(process.env.MOSKIT_STAGE_ELABORACAO_CONTRATO) || 179385, linhas: [
    '🏢 Equipe:  "Fechado com 5%. Vou elaborar o contrato."',
  ] },
  { key: 'contrato_enviado', rotulo: 'Contrato enviado', esperado: Number(process.env.MOSKIT_STAGE_CONTRATO_ENVIADO) || 179386, linhas: [
    '🏢 Equipe:  "Contrato enviado por e-mail, confere e me avisa."',
  ] },
];

(async () => {
  const { moverEstagioSeAvancar, fecharNegocioSeAplicavel } = require('./index');

  const inicialRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 });
  checar('deal existe e esta OPEN', inicialRes.data?.status === 'OPEN', inicialRes.status);
  console.log(`  -> deal ${dealId} · "${inicialRes.data?.name}" · status=${inicialRes.data?.status} stage=${inicialRes.data?.stage?.id}\n`);

  for (const etapa of ETAPAS) {
    console.log(`──── ${etapa.rotulo} ────`);
    for (const linha of etapa.linhas) console.log(linha);
    console.log(`  → o que a IA extrairia: estagio_funil_sugerido = "${etapa.key}"`);

    await moverEstagioSeAvancar(dealId, etapa.key);

    await espera(2000);
    const res = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 });
    const stageId = res.data?.stage?.id;
    checar(`deal esta no estagio ${etapa.esperado} (${etapa.rotulo})`, Number(stageId) === etapa.esperado, stageId);
    console.log('');
  }

  console.log(`──── Ganho (fechamento em dry-run) ────`);
  console.log('🏢 Equipe:  "Cliente assinou o contrato, fechamos!"');
  console.log('  → o que a IA extrairia: status_negocio_sugerido = "ganho" (com observacao validada)');
  const obsValidas = [{ tipo: 'equipe_declarou_ganho', msg_idx: 0, trecho: 'assinou o contrato' }];
  await fecharNegocioSeAplicavel(dealId, 'ganho', 'cliente assinou o contrato (simulacao de funil)', obsValidas, 'TESTE FUNIL SIMULADO', '5511999999999');

  await espera(2000);
  const finalRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 });
  checar('status continua OPEN (nao fechou de verdade)', finalRes.data?.status === 'OPEN', finalRes.data?.status);
  checar('estagio permanece em contrato_enviado', Number(finalRes.data?.stage?.id) === ETAPAS[ETAPAS.length - 1].esperado, finalRes.data?.stage?.id);

  console.log(`\n${'='.repeat(56)}`);
  console.log('Conversa simulada terminada. Etapa final no Moskit:');
  console.log(`  "${finalRes.data?.name}" · stage=${finalRes.data?.stage?.id} · status=${finalRes.data?.status}`);
  console.log(`\n${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})().catch((e) => {
  console.error('\n❌', e.response?.status || '', e.message || e);
  process.exit(1);
});