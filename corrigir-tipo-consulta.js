// Script de uso unico: corrige deals que a regra antiga marcou como "consulta gratis" indevidamente.
// A regra antiga (index.js) derivava gratis de "equipe agendou && cliente nao disse que pagou", o que
// tambem pega consulta PAGA ainda nao quitada. A regra nova olha se a equipe enviou o bloco de
// condicoes de R$ 350 na conversa.
//
// Uso: node corrigir-tipo-consulta.js <dealId> [--aplicar]
// Sem --aplicar, so mostra o que faria.
require('dotenv').config();
const axios = require('axios');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const CF_TIPO_CONSULTA = 'CF_Pj3qYeidir3ArqQe';
const TIPO_PAGA = 217251;
const PRECO_CONSULTA = 35000;

const headers = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
  'X-Ollow-Origin': 'BOT_WHATSAPP',
};

const dealId = Number(process.argv[2]);
const aplicar = process.argv.includes('--aplicar');

function tipoDe(deal) {
  return (deal?.entityCustomFields || []).find((c) => c.id === CF_TIPO_CONSULTA)?.options || [];
}

(async () => {
  if (!dealId) {
    console.error('uso: node corrigir-tipo-consulta.js <dealId> [--aplicar]');
    process.exit(1);
  }

  const atual = (await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 })).data;
  console.log(`ANTES  -> ${atual.name} | tipo: ${JSON.stringify(tipoDe(atual))} | price: ${atual.price ?? 0}`);

  // Payload construido (nao o corpo do GET devolvido de volta — esse o Moskit ignora silenciosamente).
  // Reenvia os demais campos personalizados pra que o PUT, que substitui o deal inteiro, nao os apague.
  const payload = {
    name: atual.name,
    status: atual.status,
    stage: { id: atual.stage?.id },
    responsible: { id: atual.responsible?.id },
    contacts: (atual.contacts || []).map((c) => ({ id: c.id })),
    entityCustomFields: (atual.entityCustomFields || []).map((c) => (
      c.id === CF_TIPO_CONSULTA ? { id: CF_TIPO_CONSULTA, options: [TIPO_PAGA] } : { id: c.id, options: c.options }
    )),
    price: PRECO_CONSULTA,
  };

  if (!aplicar) {
    console.log('DRY-RUN -> enviaria:', JSON.stringify(payload.entityCustomFields), '| price:', payload.price);
    console.log('(rode com --aplicar pra gravar)');
    return;
  }

  const put = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, payload, { headers, validateStatus: (s) => s < 500 });
  console.log(`PUT status: ${put.status}`);

  const depois = (await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 })).data;
  console.log(`DEPOIS -> tipo: ${JSON.stringify(tipoDe(depois))} | price: ${depois.price ?? 0} | campos: ${(depois.entityCustomFields || []).length}`);

  const ok = tipoDe(depois).includes(TIPO_PAGA) && depois.price === PRECO_CONSULTA;
  console.log(ok ? '✅ corrigido' : '❌ NAO aplicou — o Moskit aceitou o PUT mas nao gravou');
})().catch((e) => {
  console.error('ERRO', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  process.exit(1);
});
