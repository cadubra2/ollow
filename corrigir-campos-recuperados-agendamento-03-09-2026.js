// Correcao pontual (03/09/2026) — os 2 campos que a releitura com IA de verdade
// (reler-conversas-agendamento.js) recuperou de fato, dos 12 deals do estagio "Agendamento de
// Consulta" que tinham conversa local pra reler:
//   deal 48525718 (Helenilde Dourado): tipo_consulta = "consulta paga"
//   deal 48702040 (Waldek): area_direito = "Direito Educacional", advogado_responsavel = "Iury"
// Os outros 10 nao tinham nada recuperavel (caso genuinamente nunca descrito), e os 2 casos
// classificados como INVIAVEL na releitura (48505530, 48681790) ficam de fora por decisao do
// usuario — nao sao "campo faltando", sao candidato a fechar como perdido, decisao da equipe.
//
//   node corrigir-campos-recuperados-agendamento-03-09-2026.js            (dry-run, so imprime)
//   node corrigir-campos-recuperados-agendamento-03-09-2026.js --aplicar  (escreve no Moskit de verdade)
//
// GET + PUT direto (mesmo estilo de recuperar-origem-perdida.js/corrigir-assunto-perdido-bot):
// reenvia TUDO que veio do GET, so troca os customFields dos campos recuperados. Confere de novo no
// CRM que o campo AINDA esta vazio antes de escrever — se a equipe ja preencheu na mao, pula.
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar.
require('dotenv').config();
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_WHATSAPP' };
const APLICAR = process.argv.includes('--aplicar');

const CORRECOES = [
  { dealId: 48525718, campos: { [MOSKIT_IDS.CF.TIPO_CONSULTA]: MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.TIPO_CONSULTA, 'consulta paga') } },
  {
    dealId: 48702040,
    campos: {
      [MOSKIT_IDS.CF.AREA_DIREITO]: MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.AREA_DIREITO, 'Direito Educacional'),
      [MOSKIT_IDS.CF.RESPONSAVEL]: MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.RESPONSAVEL_PROCESSO, 'Iury'),
    },
  },
];

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: vai escrever no Moskit de verdade\n' : '🔍 dry-run: nada sera escrito, so mostra o que faria\n');

  for (const c of CORRECOES) {
    console.log(`=== deal ${c.dealId} ===`);
    const getRes = await axios.get(`${MOSKIT_BASE}/deals/${c.dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    if (getRes.status < 200 || getRes.status >= 300) { console.error(`  ❌ GET falhou (HTTP ${getRes.status})\n`); continue; }
    const atual = getRes.data;
    const existentes = atual.entityCustomFields || [];

    let algumJaPreenchido = false;
    const novos = [...existentes];
    for (const [cfId, novoValor] of Object.entries(c.campos)) {
      if (!novoValor) { console.log(`  ⚠️  valor não mapeado para o campo ${cfId} — pulando este campo`); continue; }
      const idx = novos.findIndex((f) => f.id === cfId);
      const jaTemValor = idx !== -1 && novos[idx].options?.length;
      if (jaTemValor) {
        console.log(`  ⏭️  campo ${cfId} já preenchido no CRM (${JSON.stringify(novos[idx].options)}) — alguém já resolveu, pulando`);
        algumJaPreenchido = true;
        continue;
      }
      if (idx === -1) novos.push({ id: cfId, options: [novoValor] });
      else novos[idx] = { id: cfId, options: [novoValor] };
      console.log(`  ${cfId} -> ${novoValor}`);
    }

    if (algumJaPreenchido && novos.every((f, i) => JSON.stringify(f) === JSON.stringify(existentes[i]))) {
      console.log('  nada a fazer neste deal\n');
      continue;
    }

    if (!APLICAR) { console.log(''); continue; }

    const payload = { ...atual, entityCustomFields: novos };
    const putRes = await axios.put(`${MOSKIT_BASE}/deals/${c.dealId}`, payload, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    if (putRes.status < 200 || putRes.status >= 300) {
      console.error(`  ❌ PUT falhou (HTTP ${putRes.status}): ${JSON.stringify(putRes.data).slice(0, 300)}\n`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 4500)); // mesmo cache de propagacao documentado no CLAUDE.md
    const confRes = await axios.get(`${MOSKIT_BASE}/deals/${c.dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    const confCampos = confRes.data?.entityCustomFields || [];
    const confirmado = Object.entries(c.campos).every(([cfId, valor]) => !valor || confCampos.some((f) => f.id === cfId && f.options?.includes(valor)));
    console.log(`  ${confirmado ? '✅ confirmado' : '⚠️  NAO confirmado'}\n`);
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log('Concluído.');
})();
