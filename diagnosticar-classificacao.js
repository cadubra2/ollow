// Diagnostico SO-LEITURA dos buckets de causa raiz para deals sem origem/advogado_responsavel.
//
//   node diagnosticar-classificacao.js                 # buckets locais (a-e) + bucket (f) fase 1
//   node diagnosticar-classificacao.js --sondar-crm     # inclui fase 2 do bucket (f) (GET por deal)
//
// NUNCA rodar em CI nem no npm test — le o conversations.db de producao e, com --sondar-crm, a API
// do Moskit. Nao escreve em NENHUM dos dois: nao existe flag --aplicar neste script de proposito.
//
// Por que existe: "muitos deals sem origem/advogado" tem pelo menos 6 causas raiz diferentes no
// pipeline (gate do caso descrito, bug de merge no ramo 'ignorar', janela fixa da reconciliacao
// periodica, opcao invalida nunca corrigida, campo travado por edicao manual, deal criado fora do
// bot). Corrigir sem medir o tamanho de cada bucket seria investir esforco no bucket errado. Este
// script so MEDE — a decisao de o que corrigir primeiro vem depois, com numero na mao.
const path = require('path');
require('dotenv').config();

// index.js e carregado so para reusar detectarOpcoesInvalidas/listarAtividadesMoskit (a mesma
// paginacao real por ?start= do varrer-agenda-horarios.js). WORKER_MODE=1 carrega o modulo sem
// servidor e sem os setInterval; DB_PATH descartavel garante que o require NAO abre nem altera o
// banco de producao — a leitura do banco real e feita mais abaixo, num handle proprio e readonly.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `diagnostico-classificacao-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');
const bot = require('./index.js');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
// Mesma pausa da reconciliacao periodica: uma passada por 64 deals ja levou 429 do Moskit.
const PAUSA_MS = Number(process.env.RECONCILIACAO_PAUSA_MS) || 300;
const sondarCrm = process.argv.includes('--sondar-crm');

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

(async () => {
  console.log('\n🔍 Diagnostico de classificacao — origem / advogado_responsavel vazios');
  console.log('   somente leitura: nada e criado, movido ou apagado\n');

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  if (!fs.existsSync(caminhoBanco)) {
    console.error(`❌ Banco nao encontrado em ${caminhoBanco} (defina CONVERSATIONS_DB= para apontar pra producao)`);
    process.exit(1);
  }
  const db = new Database(caminhoBanco, { readonly: true });

  const linhas = db.prepare(`
    SELECT chat_id, deal_id, last_data, last_action, custom_fields_bot, campos_travados,
           opcao_invalida_hash, updated_at, messages
    FROM conversations
    WHERE deal_id IS NOT NULL AND last_data IS NOT NULL
  `).all();
  db.close();
  console.log(`💾 Banco (${caminhoBanco}, readonly): ${linhas.length} conversas com deal_id + last_data\n`);

  // ---------- (d) travado por edicao manual ----------
  let travadosOrigem = 0, travadosArea = 0, travadosCaptacao = 0;
  for (const l of linhas) {
    const travados = new Set(parseJsonSeguro(l.campos_travados, null) || []);
    if (travados.has(MOSKIT_IDS.CF.ORIGEM)) travadosOrigem++;
    if (travados.has(MOSKIT_IDS.CF.AREA_DIREITO)) travadosArea++;
    if (travados.has(MOSKIT_IDS.CF.CAPTACAO)) travadosCaptacao++;
  }

  // ---------- (e) opcao invalida (valor que a IA extraiu e nao bate com a lista do CRM) ----------
  let opcaoInvalidaAgora = 0;
  let opcaoInvalidaAvisadaPendente = 0;
  const invalidasPorCampo = {};
  for (const l of linhas) {
    const dados = parseJsonSeguro(l.last_data, null);
    if (dados) {
      const invalidas = bot.detectarOpcoesInvalidas(dados);
      if (invalidas.length) {
        opcaoInvalidaAgora++;
        for (const inv of invalidas) invalidasPorCampo[inv.nome] = (invalidasPorCampo[inv.nome] || 0) + 1;
      }
    }
    if (l.opcao_invalida_hash) opcaoInvalidaAvisadaPendente++;
  }

  // ---------- (c) fora da janela/limite da reconciliacao periodica ----------
  // Mesma query de reconciliarClassificacao (index.js), sem o LIMIT, para medir o que ela nunca
  // alcanca hoje: rodarReconciliacaoPeriodica sempre chama com os defaults (30 dias, limite 100).
  const RECONCILIACAO_DIAS = Number(process.env.RECONCILIACAO_DIAS) || 30;
  const LIMITE_PADRAO = 100;
  const agora = Date.now();
  const dentroDaJanela = linhas.filter((l) => {
    if (!l.updated_at) return true;
    const t = new Date(`${l.updated_at.replace(' ', 'T')}Z`).getTime();
    return Number.isFinite(t) ? t >= agora - RECONCILIACAO_DIAS * 86400000 : true;
  });
  const foraDaJanela = linhas.length - dentroDaJanela.length;
  const foraDoLimite = Math.max(0, dentroDaJanela.length - LIMITE_PADRAO);

  // ---------- (a) nunca classificado por falta de evidencia (gate do caso descrito) ----------
  let semAreaOuAdvogado = 0, semAreaComMarcadorValidado = 0, semAreaSemMarcador = 0;
  for (const l of linhas) {
    const dados = parseJsonSeguro(l.last_data, null);
    if (!dados) continue;
    if (!dados.area_direito || !dados.advogado_responsavel) {
      semAreaOuAdvogado++;
      if (dados._casoDescritoValidado === true) semAreaComMarcadorValidado++;
      else semAreaSemMarcador++;
    }
  }

  // ---------- (b) suspeita do bug de merge nos ramos sem merge (ver index.js:3925/4021/4062/4140) ----------
  // Heuristica sem IA, so pra nao confundir com o bucket (a): mensagem da EQUIPE mencionando area do
  // direito no texto. Nao prova o bug — so separa "sem evidencia nunca existiu" de "parece que existiu
  // e sumiu". A confirmacao de verdade e reprocessar o chat_id e comparar com o historico completo.
  const REGEX_CASO_MENCIONADO = /(caso|processo|direito|administrativ|previdenci|trabalh|imobili[aá]ri|fam[ií]lia|empresarial|consumidor|lgpd|educacional|m[eé]dic)/i;
  let suspeitosBugMerge = 0;
  const chatIdsSuspeitos = [];
  for (const l of linhas) {
    if (!['ignorar', 'nota', 'atualizar_campos'].includes(l.last_action)) continue;
    const dados = parseJsonSeguro(l.last_data, null);
    if (!dados || dados.area_direito || dados.advogado_responsavel) continue;
    const mensagens = parseJsonSeguro(l.messages, []) || [];
    const textoEquipe = mensagens.filter((m) => m.role === 'equipe').map((m) => m.text || '').join(' ');
    if (REGEX_CASO_MENCIONADO.test(textoEquipe)) {
      suspeitosBugMerge++;
      chatIdsSuspeitos.push(l.chat_id);
    }
  }

  console.log('='.repeat(70));
  console.log('BUCKETS LOCAIS (custo zero — sem chamada de rede)\n');

  console.log('(d) Travado por edicao manual (campos_travados):');
  console.log(`    origem=${travadosOrigem}  area_direito=${travadosArea}  captacao=${travadosCaptacao}\n`);

  console.log('(e) Opcao invalida (valor extraido nao bate com a lista do CRM):');
  console.log(`    ${opcaoInvalidaAgora} conversa(s) com valor invalido hoje | ${opcaoInvalidaAvisadaPendente} com aviso ja disparado (opcao_invalida_hash) e ainda sem correcao confirmada`);
  for (const [nome, n] of Object.entries(invalidasPorCampo)) console.log(`      - ${nome}: ${n}`);
  console.log('');

  console.log(`(c) Fora da janela/limite da reconciliacao periodica (janela=${RECONCILIACAO_DIAS}d, limite=${LIMITE_PADRAO}):`);
  console.log(`    ${foraDaJanela} fora da janela de dias | ${foraDoLimite} dentro da janela mas fora do top-${LIMITE_PADRAO} mais recentes (nunca revisitados pelo ciclo automatico de hoje)\n`);

  console.log('(a) Sem area_direito e/ou advogado_responsavel:');
  console.log(`    ${semAreaOuAdvogado} no total | ${semAreaComMarcadorValidado} com _casoDescritoValidado=true (indicio de OUTRO bug — nao deveria ficar vazio com esse marcador) | ${semAreaSemMarcador} sem marcador (esperando evidencia — comportamento correto do gate)\n`);

  console.log("(b) Suspeitos do bug de merge (ramos 'ignorar'/'nota'/'atualizar_campos' sem deal_id ainda gravado):");
  console.log(`    ${suspeitosBugMerge} conversa(s) sem area/advogado, last_action de risco, com mencao a caso no texto da equipe (heuristica — confirmar reprocessando o chat_id)`);
  if (chatIdsSuspeitos.length) console.log(`      chat_ids: ${chatIdsSuspeitos.slice(0, 20).join(', ')}${chatIdsSuspeitos.length > 20 ? ` (+${chatIdsSuspeitos.length - 20})` : ''}`);
  console.log('');

  console.log('='.repeat(70));
  console.log('BUCKET (f): deal criado fora do bot (sem linha em conversations)\n');

  let atividades = [];
  try {
    const r = await bot.listarAtividadesMoskit();
    atividades = r.atividades || [];
    if (r.truncou) console.log('   ⚠️ teto de paginas do Moskit atingido — a fase 1 deste bucket cobre so as atividades mais recentes\n');
  } catch (e) {
    console.log(`   ⚠️ nao foi possivel listar atividades do Moskit: ${e.message}\n`);
  }

  const dealIdsConhecidos = new Set(linhas.map((l) => String(l.deal_id)));
  const dealIdsForaDoBot = new Set();
  for (const a of atividades) {
    const dealId = a.deals?.[0]?.id;
    if (dealId && !dealIdsConhecidos.has(String(dealId))) dealIdsForaDoBot.add(String(dealId));
  }
  console.log(`Fase 1 (sempre roda): ${atividades.length} atividades lidas via /activities (paginado de verdade por ?start=)`);
  console.log(`  -> ${dealIdsForaDoBot.size} deal-id distinto(s) com atividade agendada e SEM linha em conversations`);
  console.log('  (piso, nao total: deal sem nenhuma atividade continua invisivel a qualquer leitura hoje disponivel — a API /deals ignora limit e so devolve os 10 mais recentes)\n');

  if (!sondarCrm) {
    const segundosEstimados = Math.round((dealIdsForaDoBot.size * PAUSA_MS) / 1000);
    console.log('Fase 2 (GET /deals/{id} para cada um, checar origem/area vazias no CRM) NAO rodou.');
    console.log(`  Custo estimado: ${dealIdsForaDoBot.size} requisicoes, pausadas a ${PAUSA_MS}ms => ~${segundosEstimados}s.`);
    console.log('  Para rodar: node diagnosticar-classificacao.js --sondar-crm\n');
  } else if (dealIdsForaDoBot.size) {
    console.log(`Fase 2: sondando ${dealIdsForaDoBot.size} deal(s) no CRM (pausa de ${PAUSA_MS}ms entre leituras)...\n`);
    let vaziosOrigem = 0, vaziosArea = 0, lidos = 0, erros = 0;
    for (const dealId of dealIdsForaDoBot) {
      try {
        const { data } = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers: apiHeaders });
        lidos++;
        const campos = data?.entityCustomFields || [];
        const temOrigem = campos.some((c) => c.id === MOSKIT_IDS.CF.ORIGEM && c.options?.length);
        const temArea = campos.some((c) => c.id === MOSKIT_IDS.CF.AREA_DIREITO && c.options?.length);
        if (!temOrigem) vaziosOrigem++;
        if (!temArea) vaziosArea++;
      } catch (e) {
        erros++;
      }
      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
    console.log(`  ${lidos} deal(s) lido(s), ${erros} erro(s) de leitura`);
    console.log(`  -> ${vaziosOrigem} sem origem | ${vaziosArea} sem area_direito\n`);
  } else {
    console.log('Fase 2: nada a sondar (a fase 1 nao achou deal fora do bot).\n');
  }

  console.log('='.repeat(70));
  console.log('Nada foi alterado.\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
