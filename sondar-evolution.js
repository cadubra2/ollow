// Mede, contra a Evolution API REAL, o que o monitor automatico (monitorarEvolution, em index.js)
// checa a cada ciclo. SO LEITURA. Rodar com:
//
//   node sondar-evolution.js
//
// Por que existe: o mesmo motivo de sondar-chatwoot.js — antes de confiar num setInterval rodando
// sozinho em produção, medir manualmente contra a instância real que o veredito bate com o que se
// espera. Mostra: as instâncias e o status da sessão do WhatsApp; a config da integração Chatwoot
// (com o token MASCARADO, nunca inteiro); se esse token autentica; e o texto EXATO que o Telegram
// receberia se isto fosse um ciclo automático — sem mandar nada.
//
// Nunca chama POST /chatwoot/set — isso é ação de escrita, fora do escopo "sondar" (mesmo espírito
// do script irmão nunca criar contato no Chatwoot).

const path = require('path');
require('dotenv').config();

// Protecoes antes do require do index.js: sem servidor, sem timers, banco descartavel, sem Telegram —
// esta sondagem nunca deve mandar aviso de verdade, so imprimir o que mandaria.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `sondar-evolution-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const bot = require('./index');
const evolutionSaude = require('./src/evolution');

function mascarar(token) {
  const t = String(token || '');
  if (t.length < 8) return t ? '(curto demais pra mascarar — confira manualmente)' : '(vazio)';
  return `${t.slice(0, 4)}${'•'.repeat(Math.max(0, t.length - 8))}${t.slice(-4)} (${t.length} chars)`;
}

async function main() {
  if (!bot.evolutionConfigurado()) {
    console.error('❌ Evolution nao configurada. Defina no .env:');
    console.error('   EVOLUTION_BASE=http://127.0.0.1:8080   EVOLUTION_API_KEY=...');
    console.error('   (na VPS: sudo docker exec chatwoot-evolution-1 printenv AUTHENTICATION_API_KEY)');
    process.exit(1);
  }
  const instanciaNome = process.env.EVOLUTION_INSTANCE || 'escritorio';
  console.log(`\n🔎 Sondando ${process.env.EVOLUTION_BASE} (instância "${instanciaNome}") — SO LEITURA\n`);

  // ---------------------------------------------------------
  console.log('1) GET /instance/fetchInstances — instâncias e status da sessão do WhatsApp');
  let instancias = [];
  try {
    const r = await bot.evolutionRequisicao('/instance/fetchInstances');
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    instancias = r.data || [];
  } catch (e) {
    console.log(`   ❌ ${e.message}`);
    console.log('\n⛔ Sem alcançar a Evolution, o resto não pode ser medido. Confira na VPS:');
    console.log('   docker ps | grep evolution   e   docker logs chatwoot-evolution-1 --tail 50');
    process.exit(1);
  }
  console.log(`   ${instancias.length} instância(s) encontrada(s):`);
  for (const i of instancias) console.log(`   - "${i.name}": connectionStatus="${i.connectionStatus}"${i.name === instanciaNome ? '  <-- a nossa' : ''}`);
  const instancia = instancias.find((i) => i.name === instanciaNome);
  if (!instancia) {
    console.log(`\n   ⛔ instância "${instanciaNome}" NÃO está na lista — foi renomeada ou apagada?`);
  } else if (instancia.connectionStatus !== 'open') {
    console.log(`\n   ⛔ sessão do WhatsApp NÃO está aberta (status "${instancia.connectionStatus}", esperado "open")`);
  } else {
    console.log('\n   ✅ sessão do WhatsApp aberta');
  }

  // ---------------------------------------------------------
  console.log('\n2) GET /chatwoot/find — a config da integração (token mascarado)');
  let chatwootFind = null;
  if (instancia) {
    try {
      const r = await bot.evolutionRequisicao(`/chatwoot/find/${instanciaNome}`);
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      chatwootFind = r.data || {};
      console.log(`   enabled: ${chatwootFind.enabled}`);
      console.log(`   accountId: ${chatwootFind.accountId}`);
      console.log(`   url: ${chatwootFind.url}`);
      console.log(`   nameInbox: ${chatwootFind.nameInbox}`);
      console.log(`   token: ${mascarar(chatwootFind.token)}`);
      if (chatwootFind.enabled === false) console.log('   ⛔ enabled=false — a integração está desligada');
    } catch (e) {
      console.log(`   ❌ ${e.message}`);
    }
  } else {
    console.log('   (pulado — instância não encontrada no passo 1)');
  }

  // ---------------------------------------------------------
  console.log('\n3) O token que a Evolution tem configurado ainda autentica no Chatwoot?');
  let tokenValido = null;
  if (chatwootFind?.token) {
    const inicio = Date.now();
    try {
      tokenValido = await bot.chatwootTokenValido(chatwootFind.token);
      console.log(`   GET ${process.env.CHATWOOT_BASE}/api/v1/profile -> ${tokenValido ? '200 (válido)' : '401 (INVÁLIDO)'} em ${Date.now() - inicio}ms`);
      if (!tokenValido) console.log('   ⛔ ESTE é o causador do incidente de 04/09/2026 quando acontece.');
    } catch (e) {
      console.log(`   ❌ ${e.message}`);
    }
  } else {
    console.log('   (pulado — sem token para testar)');
  }

  // ---------------------------------------------------------
  console.log('\n4) Veredito, com a MESMA função pura que o monitor automático usa');
  const veredito = evolutionSaude.avaliarSaudeEvolution({
    instanciaEncontrada: !!instancia,
    connectionStatus: instancia?.connectionStatus ?? null,
    chatwootEnabled: chatwootFind?.enabled ?? null,
    tokenValido,
  });
  console.log(`   ok: ${veredito.ok}${veredito.motivo ? `, motivo: ${veredito.motivo}` : ''}`);

  // O boot deste script usa DB_PATH descartavel (mesma protecao dos outros sondar-*.js) — isto NUNCA
  // e o banco de producao, e por isso comeca sempre vazio aqui.
  const linhaAtual = bot.stmtEvolutionSaude.get();
  console.log(`\n   estado no banco DESTA sondagem (descartável): ultimo_hash="${linhaAtual.ultimo_hash}", avisado_hash="${linhaAtual.avisado_hash}"`);

  // Le o estado REAL, so leitura (handle readonly, nunca escreve), se apontado explicitamente pra
  // producao — mesmo padrao de CONVERSATIONS_DB em backfill-chatwoot-nomes.js/varrer-agenda-horarios.js.
  if (process.env.CONVERSATIONS_DB) {
    try {
      const Database = require('better-sqlite3');
      const dbProducao = new Database(process.env.CONVERSATIONS_DB, { readonly: true, fileMustExist: true });
      const linhaReal = dbProducao.prepare('SELECT ultimo_hash, avisado_hash, mudou_em, atualizado_em FROM evolution_saude WHERE id = 1').get();
      dbProducao.close();
      console.log(`   estado no CONVERSATIONS_DB apontado (produção, so leitura): ${linhaReal ? JSON.stringify(linhaReal) : '(tabela ainda nao existe la — bot de producao precisa subir com este codigo primeiro)'}`);
    } catch (e) {
      console.log(`   ⚠️ não consegui ler CONVERSATIONS_DB: ${e.message}`);
    }
  } else {
    console.log('   (para ver o estado real de produção: CONVERSATIONS_DB=<caminho> node sondar-evolution.js)');
  }

  if (!veredito.ok) {
    console.log('\n5) O texto EXATO que o Telegram receberia (não foi mandado):\n');
    const texto = evolutionSaude.montarTextoAlertaEvolution({
      hash: `falha:${veredito.motivo}`,
      motivo: veredito.motivo,
      detalhe: veredito.detalhe,
      instancia: instanciaNome,
    });
    console.log('   ' + texto.split('\n').join('\n   '));
  } else {
    console.log('\n✅ Tudo certo — nenhum alerta seria mandado neste ciclo.');
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
