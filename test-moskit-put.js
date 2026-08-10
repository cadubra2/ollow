// Mede qual padrao de PUT o Moskit realmente aceita para mover um deal de estagio.
//
// Existem duas afirmacoes incompativeis no proprio repositorio:
//   index.js (moverParaEstagio)  -> devolve o corpo do GET num PUT
//   corrigir-tipo-consulta.js:38 -> "nao o corpo do GET devolvido de volta — esse o Moskit ignora
//                                    silenciosamente"
// Se a segunda estiver certa, NENHUM deal jamais foi movido por moverParaEstagio — inclusive os de
// pagamento confirmado, que a chamam sem passar pelo FUNIL_DRY_RUN.
//
//   node test-moskit-put.js <dealId>            # so LE o estagio atual, nao escreve nada
//   node test-moskit-put.js <dealId> --aplicar  # ESCREVE: move o deal e devolve ao estagio original
//
// Use um deal de TESTE. O modo --aplicar altera um negocio real no CRM.

require('dotenv').config();
const axios = require('axios');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_TEST' };

const dealId = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function lerEstagio(rotulo) {
  // Pausa antes de reler: o GET logo apos um PUT pode vir de cache neste endpoint.
  await espera(1500);
  const res = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers });
  const id = res.data?.stage?.id;
  console.log(`  ${rotulo}: estagio ${id}`);
  return { id, deal: res.data };
}

// Um PUT que move o estagio mas apaga name/entityCustomFields/contacts/price e PIOR que um PUT que
// nao faz nada — ninguem percebe a tempo. Compara os campos que nao deveriam ter mudado.
function camposPreservados(antes, depois) {
  const problemas = [];
  if (String(depois?.name || '') !== String(antes?.name || '')) {
    problemas.push(`name: "${antes?.name}" -> "${depois?.name}"`);
  }
  const precoAntes = antes?.price;
  const precoDepois = depois?.price;
  if ((precoAntes ?? null) !== (precoDepois ?? null) && Number(precoAntes) !== Number(precoDepois)) {
    problemas.push(`price: ${precoAntes} -> ${precoDepois}`);
  }
  const contatosAntes = (antes?.contacts || []).map((c) => c.id).sort().join(',');
  const contatosDepois = (depois?.contacts || []).map((c) => c.id).sort().join(',');
  if (contatosAntes !== contatosDepois) {
    problemas.push(`contacts: [${contatosAntes}] -> [${contatosDepois}]`);
  }
  const cfAntes = JSON.stringify((antes?.entityCustomFields || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id))));
  const cfDepois = JSON.stringify((depois?.entityCustomFields || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id))));
  if (cfAntes !== cfDepois) {
    problemas.push(`entityCustomFields: ${cfAntes} -> ${cfDepois}`);
  }
  return problemas;
}

async function main() {
  if (!dealId || !/^\d+$/.test(dealId)) {
    console.error('Uso: node test-moskit-put.js <dealId> [--aplicar]');
    process.exit(1);
  }
  if (!process.env.MOSKIT_API_KEY) {
    console.error('MOSKIT_API_KEY ausente no .env');
    process.exit(1);
  }

  console.log(`\n${APLICAR ? '⚠️  MODO ESCRITA' : '🔍 SO LEITURA'} — deal ${dealId}\n`);

  const inicial = await lerEstagio('estado inicial');
  if (!inicial.id) {
    console.error('Nao consegui ler o estagio do deal. Confira o id.');
    process.exit(1);
  }

  // Escolhe um estagio de destino diferente do atual, entre os configurados.
  const candidatos = [
    Number(process.env.MOSKIT_STAGE_ID) || 179388,
    Number(process.env.MOSKIT_STAGE_CONSULTA_AGENDADA) || 184382,
  ];
  const alvo = candidatos.find((c) => Number(c) !== Number(inicial.id));
  if (!alvo) {
    console.error('Nao achei um estagio de destino diferente do atual.');
    process.exit(1);
  }
  console.log(`\nDestino do teste: estagio ${alvo}\n`);

  if (!APLICAR) {
    console.log('Nada foi escrito. Rode com --aplicar para medir os dois padroes de PUT.');
    console.log('(o deal e devolvido ao estagio original ao final)');
    return;
  }

  // Padrao A — o que index.js faz hoje: devolve o corpo do GET com stage trocado.
  console.log('── Padrao A: PUT com o corpo do GET ──');
  const corpoDoGet = { ...inicial.deal, stage: { id: alvo } };
  const putA = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, corpoDoGet, { headers, validateStatus: () => true });
  console.log(`  PUT respondeu ${putA.status}`);
  const depoisA = await lerEstagio('apos padrao A');
  const funcionouA = Number(depoisA.id) === Number(alvo);
  console.log(`  ${funcionouA ? '✅ moveu' : '❌ NAO moveu (PUT aceito e ignorado)'}`);
  const problemasA = camposPreservados(inicial.deal, depoisA.deal);
  if (problemasA.length) console.log(`  ⚠️ campos alterados sem ser o estagio:\n    ${problemasA.join('\n    ')}`);
  else console.log('  ✅ name/price/contacts/entityCustomFields preservados');
  console.log('');

  // Volta ao inicial para medir o padrao B a partir do mesmo ponto.
  if (funcionouA) {
    await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, { ...inicial.deal, stage: { id: inicial.id } }, { headers, validateStatus: () => true });
    await lerEstagio('revertido');
  }

  // Padrao B — o que corrigir-tipo-consulta.js faz: payload minimo construido.
  console.log('── Padrao B: PUT com payload minimo construido ──');
  const putB = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, { stage: { id: alvo } }, { headers, validateStatus: () => true });
  console.log(`  PUT respondeu ${putB.status}`);
  const depoisB = await lerEstagio('apos padrao B');
  const funcionouB = Number(depoisB.id) === Number(alvo);
  console.log(`  ${funcionouB ? '✅ moveu' : '❌ NAO moveu'}`);
  const problemasB = camposPreservados(inicial.deal, depoisB.deal);
  if (problemasB.length) console.log(`  ⚠️ campos alterados sem ser o estagio:\n    ${problemasB.join('\n    ')}`);
  else console.log('  ✅ name/price/contacts/entityCustomFields preservados');
  console.log('');

  // Devolve ao estagio original, pelo padrao que provou funcionar.
  console.log('── Restaurando estagio original ──');
  const corpoRestauro = funcionouB ? { stage: { id: inicial.id } } : { ...inicial.deal, stage: { id: inicial.id } };
  await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, corpoRestauro, { headers, validateStatus: () => true });
  const final = await lerEstagio('estado final');
  if (Number(final.id) !== Number(inicial.id)) {
    console.error(`  ⚠️ NAO consegui restaurar: o deal ficou em ${final.id}, era ${inicial.id}. Ajuste na mao no Moskit.`);
  }

  console.log('\n── Conclusao ──');
  console.log(`  corpo do GET:       ${funcionouA ? 'FUNCIONA' : 'IGNORADO'}${problemasA.length ? ' (mas apaga campos!)' : ''}`);
  console.log(`  payload construido: ${funcionouB ? 'FUNCIONA' : 'IGNORADO'}${problemasB.length ? ' (mas apaga campos!)' : ''}`);
  if (!funcionouA && funcionouB && !problemasB.length) {
    console.log('\n  => moverParaEstagio precisa passar a usar payload construido (padrao B e seguro).');
    console.log('     E provavel que nenhum deal tenha sido movido automaticamente ate hoje.');
  } else if (funcionouA && !problemasA.length) {
    console.log('\n  => o padrao atual de index.js esta correto e preserva os outros campos; o');
    console.log('     comentario de corrigir-tipo-consulta.js esta desatualizado.');
  } else if ((funcionouA && problemasA.length) || (funcionouB && problemasB.length)) {
    console.log('\n  => NENHUM dos dois padroes e seguro como esta: o que move o estagio tambem');
    console.log('     apaga outros campos. moverParaEstagio precisa reconstruir um payload completo');
    console.log('     (nome/status/stage/responsible/contacts/entityCustomFields/price), nao um');
    console.log('     payload minimo nem o corpo bruto do GET.');
  }
  console.log('\n  Confira tambem na interface do Moskit — o GET pode vir de cache.\n');
}

main().catch((e) => {
  console.error('\n❌', e.response?.status || '', e.message);
  process.exit(1);
});
