// Correcao pontual (03/09/2026) do bug documentado no CLAUDE.md ("O placeholder do modelo apagava um
// assunto real herdado — achado em 03/09/2026, mergeDados"): 4 deals do bot tinham assunto real
// capturado (visto na auditoria de 02/09/2026, lido direto do conversations.db local intacto daquela
// epoca) e voltaram ao placeholder "Consulta jurídica" depois, sem ninguem ter corrigido nada na mao —
// uma rodada sem caso novo fez o modelo devolver o placeholder, que mergeDados tratava como dado novo
// de verdade. O bug ja foi corrigido no codigo (mergeDados); este script so restaura o que os 4 deals
// JA tinham antes de serem apagados.
//
//   node corrigir-assunto-perdido-bot-03-09-2026.js            (dry-run, so imprime)
//   node corrigir-assunto-perdido-bot-03-09-2026.js --aplicar  (escreve no Moskit de verdade)
//
// PRIMEIRA VERSAO deste script usava atualizarNegocioMoskit (a funcao de producao) — mas essa funcao
// decide se preserva ou troca o titulo consultando `custom_fields_bot` no conversations.db LOCAL
// (nomeEscritoPeloBot), e um script pontual roda com um DB_PATH descartavel e vazio (mesma convencao
// de recuperar-origem-perdida.js) — sem essa tabela, ela SEMPRE concluia "renomeado fora do bot" e
// preservava o titulo corrompido, mesmo com --aplicar (MEDIDO: o PUT retornou 2xx e o titulo no Moskit
// continuou intacto). Por isso este script faz GET + PUT direto, no mesmo estilo de
// recuperar-origem-perdida.js: preserva TUDO que veio do GET e so troca o campo `name`, sem depender
// de nenhum estado local. Antes de escrever, confere de novo que o titulo remoto AINDA e o placeholder
// exato — se a equipe corrigiu na mao nesse meio-tempo, pula sem barulho.
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar.
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1'; // sem isso, require('./index.js') sobe o servidor real e os setInterval
                                // de reconciliacao/sincronizacao — MEDIDO nesta mesma investigacao
                                // (04/09/2026): a 1a versao deste arquivo esqueceu este guard e o
                                // require tentou de verdade abrir a porta 3000 (deu EADDRINUSE por
                                // coincidencia, mas os setInterval do bloco !WORKER_MODE teriam
                                // rodado do mesmo jeito).
process.env.DB_PATH = path.join(require('os').tmpdir(), `corrigir-assunto-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
const axios = require('axios');
const { rejeitarAssuntoQueEhArea } = require('./index.js');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_WHATSAPP' };
const APLICAR = process.argv.includes('--aplicar');
const PLACEHOLDER = 'Consulta juridica'; // sem acento — e o texto exato que o titulo corrompido mostra hoje nos 4 deals

// Valor real lido direto do conversations.db LOCAL (intacto, nunca tocado pelo bug — a corrupcao so
// afeta o banco de PRODUCAO, que passou por rodadas novas depois de 02/09). Conferido byte a byte
// contra o SQLite (nao contra o CSV da auditoria, que tem um bug de encoding proprio e mostra "???"
// no lugar de acento).
const DEALS = [
  { dealId: 48226006, assuntoReal: 'Rematrícula estudante de medicina' },
  { dealId: 48317782, assuntoReal: 'Compra de imóvel na planta' },
  { dealId: 48353647, assuntoReal: 'Pericia de readaptacao' },
  { dealId: 48407421, assuntoReal: 'Transferência de internato médico' },
];

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: vai escrever no Moskit de verdade\n' : '🔍 dry-run: nada sera escrito, so mostra o que faria\n');

  for (const d of DEALS) {
    console.log(`=== deal ${d.dealId} ===`);
    const getRes = await axios.get(`${MOSKIT_BASE}/deals/${d.dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    if (getRes.status < 200 || getRes.status >= 300) { console.error(`  ❌ GET falhou (HTTP ${getRes.status})\n`); continue; }
    const atual = getRes.data;

    const nomeAtual = String(atual.name || '');
    const idx = nomeAtual.indexOf(' - ');
    const nomeParte = idx === -1 ? nomeAtual : nomeAtual.slice(0, idx);
    const assuntoNoTitulo = idx === -1 ? '' : nomeAtual.slice(idx + 3);

    if (assuntoNoTitulo !== PLACEHOLDER) {
      console.log(`  ⏭️  título atual já não é mais o placeholder ("${nomeAtual}") — alguém já corrigiu, pulando\n`);
      continue;
    }

    const teste = { assunto: d.assuntoReal };
    rejeitarAssuntoQueEhArea(teste); // defesa: nao deveria disparar para nenhum destes 4, mas nunca pular esta checagem
    if (teste.assunto !== d.assuntoReal) {
      console.log(`  ⚠️  assunto "${d.assuntoReal}" foi rejeitado por ser nome de área — não aplicando\n`);
      continue;
    }

    const nomeNovo = `${nomeParte} - ${d.assuntoReal}`;
    console.log(`  título atual: "${nomeAtual}"`);
    console.log(`  título novo:  "${nomeNovo}"`);

    if (!APLICAR) { console.log(''); continue; }

    // PUT e full replace: reenvia TUDO que veio do GET (mesmo padrao de recuperar-origem-perdida.js e
    // putDealComVerificacao), so o `name` muda.
    const payload = { ...atual, name: nomeNovo };
    const putRes = await axios.put(`${MOSKIT_BASE}/deals/${d.dealId}`, payload, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    if (putRes.status < 200 || putRes.status >= 300) {
      console.error(`  ❌ PUT falhou (HTTP ${putRes.status}): ${JSON.stringify(putRes.data).slice(0, 300)}\n`);
      continue;
    }

    // Confirma lendo de novo (mesmo cuidado de putDealComVerificacao: o Moskit pode aceitar o PUT e so
    // aplicar o valor de fato ate uns 4s depois — MEDIDO nesta mesma rodada: 800ms nao bastou e os 4
    // deals imprimiram "NAO confirmado" apesar do PUT ja ter pegado de verdade).
    await new Promise((r) => setTimeout(r, 4500));
    const confRes = await axios.get(`${MOSKIT_BASE}/deals/${d.dealId}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
    const confirmado = confRes.data?.name === nomeNovo;
    console.log(`  ${confirmado ? '✅' : '⚠️ '} deal ${d.dealId}: ${confirmado ? 'título confirmado' : `NAO confirmado — titulo lido: "${confRes.data?.name}"`}\n`);
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log('Concluído.');
})();
