// Pedido do usuario (03/09/2026): dos deals do estagio "Agendamento de Consulta" com campo
// obrigatorio faltando, releia a conversa de cada um pra ver se o dado esta la e so nao foi
// extraido. Só faz sentido para quem TEM conversa local — dos 30 problematicos, 18 são Moskit
// Boost/sem espelho (nunca passaram pelo bot, não há o que reler); os outros 12 estão aqui.
//
// Replay com a MESMA cadeia de producao (classificarConversa -> extrairDadosAtendimento ->
// aplicarPadroesDeterministicosDeOrigem -> sanitizarClassificacao -> mesclarParaCrm), na MESMA ordem
// de processarConversaDirect — mesmo espirito de avaliar-extracao.js (camada 1), só que mirado nos
// 12 deals especificos em vez do corpus inteiro. NAO escreve nada no Moskit nem no banco: é só
// diagnóstico. Chama a OpenAI DE VERDADE — custa creditos (12 conversas, ~1-2 chamadas cada).
//
//   node reler-conversas-agendamento.js
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `reler-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
process.env.MOSKIT_BASE = 'http://127.0.0.1:9'; // trava: qualquer escrita acidental falha alto (mesma protecao de avaliar-extracao.js)
process.env.ZAPSIGN_BASE = 'http://127.0.0.1:9';

const Database = require('better-sqlite3');
const bot = require('./index.js');
const { validarObservacoes } = require('./src/evidencia');

const CONVERSATIONS_DB = process.env.CONVERSATIONS_DB || 'conversations.db';
const CAMPOS = ['assunto', 'area_direito', 'advogado_responsavel', 'tipo_consulta'];

// So o deal_id, nunca o telefone: `conversations` tem a coluna deal_id e a busca por ela e igualmente
// direta. Telefone de cliente e dado pessoal e nao entra no repositorio — e a mesma razao das regras
// de `deals-*.csv`/`auditoria-crm/` no .gitignore.
const ALVO = ['48407608', '48427024', '48505530', '48525718', '48531611', '48537015',
  '48681790', '48694983', '48701858', '48702040', '49229999', '49300572'];

(async () => {
  const db = new Database(CONVERSATIONS_DB, { readonly: true });
  console.log(`🔎 Relendo ${ALVO.length} conversas com a IA de verdade (custa créditos)...\n`);

  const resultados = [];
  for (const dealId of ALVO) {
    const row = db.prepare('SELECT * FROM conversations WHERE deal_id = ?').get(dealId);
    if (!row) { console.log(`=== deal ${dealId} === SEM LINHA NO BANCO\n`); continue; }
    const msgs = JSON.parse(row.messages || '[]');
    const inicio = bot.janelaAtendimento(row);
    const historico = bot.montarHistorico(msgs, { inicio });
    const dataAtual = msgs[msgs.length - 1]?.timestamp || new Date().toISOString();
    let dadosAnteriores = null;
    try { dadosAnteriores = row.last_data ? JSON.parse(row.last_data) : null; } catch { /* ignore */ }

    console.log(`=== deal ${dealId} (${row.contact_name || '?'}, ${msgs.length} msgs) ===`);
    const antes = {};
    for (const c of CAMPOS) antes[c] = dadosAnteriores?.[c] || null;

    const classificacao = await bot.classificarConversa(historico, `negocio ${dealId} ja existe no CRM`);
    if (classificacao?.classificacao === 'inviavel') {
      console.log(`  classificado como INVIAVEL nesta releitura (${classificacao.justificativa || ''}) — sem extracao\n`);
      resultados.push({ dealId, achou: [] });
      continue;
    }

    const result = await bot.extrairDadosAtendimento(historico, true, dadosAnteriores, 'Sim', dataAtual);
    const dados = result?.dados || {};
    const { validas: obsTodas } = validarObservacoes(result?.observacoes, msgs);
    const obsValidas = inicio > 0 ? obsTodas.filter((o) => o.msg_idx >= inicio) : obsTodas;

    bot.aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    bot.sanitizarClassificacao(dados, obsValidas);
    const acumulado = bot.mesclarParaCrm(dadosAnteriores, dados, obsValidas);

    const achou = [];
    for (const c of CAMPOS) {
      const valorAntes = antes[c];
      const valorDepois = acumulado[c];
      const tinhaAntes = !!valorAntes && !(c === 'assunto' && bot.ehAssuntoNeutro(valorAntes));
      const temAgora = !!valorDepois && !(c === 'assunto' && bot.ehAssuntoNeutro(valorDepois));
      if (!tinhaAntes && temAgora) {
        achou.push({ campo: c, valor: valorDepois });
        console.log(`  ✅ ${c}: RECUPERADO -> "${valorDepois}"`);
      }
    }
    if (!achou.length) console.log(`  ⚠️  nada novo — a releitura confirma que o caso ainda não foi descrito na conversa`);
    resultados.push({ dealId, achou });
    console.log('');
  }
  db.close();

  console.log('='.repeat(60));
  const comAchado = resultados.filter((r) => r.achou.length);
  console.log(`Recuperados: ${comAchado.length} de ${ALVO.length}`);
  for (const r of comAchado) console.log(`  deal ${r.dealId}: ${r.achou.map((a) => `${a.campo}="${a.valor}"`).join(', ')}`);
})();
