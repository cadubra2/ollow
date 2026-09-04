// Limpeza da aba "Agendamento de Consulta" (03/09/2026) — fecha como PERDIDO e marca no nome.
//
// Regra do usuario: "todo cliente que for pra perdido coloque no nome dele 'bot limpeza'".
// O marcador vai no FIM, como ` [bot limpeza]` — decisao do usuario, e tambem o que nao quebra as
// ferramentas: `extrairNomeCaso` (src/duplicidade.js) e a auditoria cortam o nome no PRIMEIRO " - "
// pra separar pessoa de caso; um prefixo faria "bot limpeza Fulano" virar o nome da pessoa.
// Idempotente: quem ja tem o marcador nao recebe outro.
//
// DOIS grupos:
//   A) 8 ja fechados hoje (mesclagem de duplicidade) — so recebem o marcador, status ja esta LOST.
//   B) 18 a fechar: 3 com recusa explicita do cliente + 15 que sumiram ha 21+ dias.
//
// FORA daqui de proposito: 10 dos 28 candidatos tem uma duplicata VIVA (par aberto no mesmo
// telefone, quase sempre um lead antigo do Moskit Boost). Fechar so um lado sem complementar o outro
// jogaria fora o dado do bot; esses precisam do mesmo tratamento de merge dos 7 pares anteriores, e
// vao numa rodada propria depois da decisao do usuario sobre qual lado manter.
//
//   node corrigir-limpeza-perdidos-03-09-2026.js            (dry-run)
//   node corrigir-limpeza-perdidos-03-09-2026.js --aplicar  (escreve no Moskit)
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar.
require('dotenv').config();
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_WHATSAPP' };
const APLICAR = process.argv.includes('--aplicar');
const MARCADOR = ' [bot limpeza]';
const R = MOSKIT_IDS.LOST_REASON;

// A) ja fechados hoje na mesclagem de duplicidade — so o marcador
const SO_MARCAR = [48403502, 48401433, 48971494, 48401430, 48402952, 48407405, 48431604, 48971188];

// B) fechar + marcar
const FECHAR = [
  { id: 48346572, motivo: R['achou nosso valor alto'], porque: 'cliente disse que o valor está fora da realidade dele' },
  { id: 48120486, motivo: R['nao informou o motivo'], porque: 'cliente disse que ia pensar e não voltou (23d)' },
  { id: 48681790, motivo: R['achou nosso valor alto'], porque: 'cliente disse que o valor da consulta está fora da realidade dele' },
  ...[48177138, 48317775, 48359253, 48110284, 48118464, 48178372, 48206722, 48210763, 48226023, 48272964, 48412728, 48430901, 48272849, 48436301, 48156600]
    .map((id) => ({ id, motivo: R['nao informou o motivo'], porque: 'equipe falou por último e o cliente não respondeu há 21+ dias' })),
];

const get = async (id) => {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (r.status < 200 || r.status >= 300) throw new Error(`GET /deals/${id} → HTTP ${r.status}`);
  return r.data;
};
const comMarcador = (nome) => (String(nome || '').includes(MARCADOR) ? String(nome) : `${nome}${MARCADOR}`);

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: escreve no Moskit de verdade\n' : '🔍 dry-run: nada será escrito\n');
  let marcados = 0; let fechados = 0; let pulados = 0;

  console.log(`--- A) já fechados na mesclagem de duplicidade: só o marcador (${SO_MARCAR.length}) ---`);
  for (const id of SO_MARCAR) {
    try {
      const d = await get(id);
      if (String(d.name).includes(MARCADOR)) { console.log(`  ⏭️  ${id} já marcado`); pulados++; continue; }
      const nomeNovo = comMarcador(d.name);
      console.log(`  ${id} · "${d.name}" → "${nomeNovo}"`);
      if (!APLICAR) continue;
      const r = await axios.put(`${MOSKIT_BASE}/deals/${id}`, { ...d, name: nomeNovo }, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      if (r.status < 200 || r.status >= 300) throw new Error(`PUT → HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
      marcados++;
    } catch (e) { console.error(`  ❌ ${id}: ${e.message}`); }
    await new Promise((x) => setTimeout(x, 350));
  }

  console.log(`\n--- B) fechar como PERDIDO + marcador (${FECHAR.length}) ---`);
  for (const item of FECHAR) {
    try {
      const d = await get(item.id);
      if (d.status !== 'OPEN') { console.log(`  ⏭️  ${item.id} já está ${d.status} — pulando`); pulados++; continue; }
      const nomeNovo = comMarcador(d.name);
      console.log(`  ${item.id} · "${d.name}" → PERDIDO (${item.porque})`);
      if (!APLICAR) continue;

      const nota = [
        '🧹 Fechado pela limpeza automática de 03/09/2026 (revisão da aba "Agendamento de Consulta").',
        `Motivo: ${item.porque}.`,
        'Nada foi apagado — reabrir o negócio desfaz esta marcação se ela estiver errada.',
      ].join(' ');
      await axios.post(`${MOSKIT_BASE}/deals/${item.id}/notes`, { description: nota, user: { id: MOSKIT_IDS.LAYLA_USER_ID } }, { headers: apiHeaders, validateStatus: (s) => s < 500 });

      const payload = { ...d, name: nomeNovo, status: 'LOST', closeDate: new Date().toISOString(), lostReason: { id: item.motivo } };
      const r = await axios.put(`${MOSKIT_BASE}/deals/${item.id}`, payload, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      if (r.status < 200 || r.status >= 300) throw new Error(`PUT → HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
      fechados++;
    } catch (e) { console.error(`  ❌ ${item.id}: ${e.message}`); }
    await new Promise((x) => setTimeout(x, 350));
  }

  if (APLICAR) {
    console.log('\n🔎 Conferindo (o Moskit cacheia o GET pós-PUT por ~4s)...');
    await new Promise((x) => setTimeout(x, 4500));
    let ok = 0; const problemas = [];
    for (const id of [...SO_MARCAR, ...FECHAR.map((f) => f.id)]) {
      const d = await get(id);
      const temMarca = String(d.name).includes(MARCADOR);
      const estaLost = d.status === 'LOST';
      if (temMarca && estaLost) ok++; else problemas.push(`${id} (marca=${temMarca}, status=${d.status})`);
      await new Promise((x) => setTimeout(x, 250));
    }
    console.log(`  ✅ ${ok} confirmados como PERDIDO com marcador`);
    if (problemas.length) console.log(`  ⚠️  conferir: ${problemas.join(' · ')}`);
    console.log(`\nmarcados: ${marcados} · fechados: ${fechados} · pulados: ${pulados}`);
  }
  console.log('\nConcluído.');
})();
