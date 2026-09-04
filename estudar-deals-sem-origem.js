// Estudo SO-LEITURA, deal por deal, de TODO negocio criado/tocado pelo bot (marca nativa
// origin==='BOT_WHATSAPP' no proprio Moskit) que HOJE esta sem o campo "Origem" preenchido no CRM.
//
//   node estudar-deals-sem-origem.js
//
// NUNCA rodar em CI nem no npm test — pagina TODO /deals da conta (nao so os do bot: o filtro por
// origin e feito EM MEMORIA, depois de ler cada pagina) e le o conversations.db de producao. NAO
// escreve em nada: nao existe flag --aplicar neste script de proposito.
//
// Por que varrer /deals inteiro em vez de so os deal_id que `conversations` conhece: MEDIDO em
// 21/08/2026 que a tabela local so cobre uma fração — cliente-retorno zera `deal_id` da linha ao abrir
// atendimento novo (o deal antigo continua existindo no CRM, so sai da conversa), e todo deal criado
// por outra via (Moskit Boost, importacao, a mao) nunca teve linha em `conversations`. `origin` e uma
// marca do PROPRIO Moskit (nao do nosso banco): toda escrita do bot manda o header
// `X-Ollow-Origin: BOT_WHATSAPP` (ver index.js, `apiHeaders`/`X-Ollow-Origin` nos call sites de
// criar/atualizar deal), e o Moskit grava isso no campo nativo `origin` do deal — e por isso e mais
// confiavel que qualquer heuristica local.
//
// MEDIDO em 21/08/2026: GET /deals ignora `limit`/`page` (quirk documentado), mas PAGINA DE VERDADE
// por `?start=` (nunca testado antes) — mesmo padrao de /activities. Cada pagina tambem já vem com
// `entityCustomFields` completo, entao nao precisa de um GET extra por deal.
const path = require('path');
require('dotenv').config();

// index.js e carregado so para reusar detectarOpcoesInvalidas/MOSKIT_IDS. WORKER_MODE=1 carrega o
// modulo sem servidor e sem os setInterval; DB_PATH descartavel garante que o require NAO abre nem
// altera o banco de producao — a leitura do banco real e feita mais abaixo, num handle readonly.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `estudo-origem-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');
const { escreverCsv } = require('./src/csv');
const bot = require('./index.js');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
const PAUSA_MS = Number(process.env.RECONCILIACAO_PAUSA_MS) || 300;
// Teto de seguranca: 3080 deals na conta em 21/08/2026, pagina de 10 => ~310 paginas. Se a conta
// crescer muito, um teto evita rodar por tempo indefinido sem avisar.
const MAX_PAGINAS = Number(process.env.MAX_PAGINAS_DEALS) || 500;

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

// "Nao identificado" (id 435777) e uma opcao REAL da lista do CRM, nao um valor vazio — mas pra fins
// deste estudo conta como sem origem: e o fallback que o prompt manda usar quando a IA nao consegue
// extrair o canal de entrada (index.js:3051), entao tao inutil pra analise de captacao quanto o campo
// vazio. Devolve null quando tem origem de verdade, ou o motivo quando nao tem.
const ID_NAO_IDENTIFICADO = MOSKIT_IDS.ORIGEM['nao identificado'];
function motivoSemOrigem(campos) {
  const campo = (campos || []).find((c) => c.id === MOSKIT_IDS.CF.ORIGEM);
  if (!campo || !campo.options?.length) return 'campo_ausente';
  if (campo.options.includes(ID_NAO_IDENTIFICADO)) return 'explicitamente_nao_identificado';
  return null; // tem origem de verdade
}

// Causa provavel de origem vazia num deal do bot, cruzando com o que sobrou no banco local (pode nao
// haver nada, se a linha em conversations foi zerada por cliente-retorno ou nunca existiu).
function classificarCausa(linhaLocal) {
  if (!linhaLocal) return 'sem_correspondencia_em_conversations (deal_id nao aparece em nenhuma linha nem em deals_anteriores)';

  const dados = parseJsonSeguro(linhaLocal.last_data, null);
  const travados = new Set(parseJsonSeguro(linhaLocal.campos_travados, null) || []);
  if (travados.has(MOSKIT_IDS.CF.ORIGEM)) return 'travado_por_edicao_manual';

  const origemLocal = dados?.origem || null;
  if (origemLocal) {
    // "Nao identificado" local == CRM nao e bug nenhum: e o fallback do prompt (index.js:3051)
    // funcionando exatamente como pedido — o modelo so nunca achou a origem real na conversa.
    if (String(origemLocal).toLowerCase() === 'nao identificado') {
      return 'modelo_usou_fallback_nao_identificado (nao e bug — nunca extraiu a origem real da conversa)';
    }
    const invalidas = bot.detectarOpcoesInvalidas({ origem: origemLocal });
    if (invalidas.length) return `opcao_invalida (valor extraido: "${origemLocal}")`;
    return `bot_acha_que_tem_valor_valido_mas_crm_diverge (valor local: "${origemLocal}" — investigar por que nao persistiu)`;
  }

  if (linhaLocal.last_action === 'inviavel') return 'ultima_classificacao_foi_inviavel (last_data foi zerado nessa rodada — index.js:3727)';
  if (linhaLocal.last_action === 'interno') return 'ultima_classificacao_foi_interno (last_data foi zerado nessa rodada — index.js:3665)';
  if (linhaLocal.opcao_invalida_hash) return 'opcao_invalida_ja_avisada_antes_mas_last_data_atual_nao_tem_origem';
  if (linhaLocal.eh_deal_anterior) return 'deal_de_atendimento_anterior (cliente voltou com caso novo; a linha atual nao aponta mais pra ele)';

  return 'nunca_extraido (last_data.origem esta nulo/ausente agora)';
}

(async () => {
  console.log('\n🔍 Estudo deal-por-deal: negocios do BOT (origin=BOT_WHATSAPP) sem "Origem" no Moskit');
  console.log('   somente leitura: nada e criado, movido ou apagado\n');

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  const porDealId = new Map();
  if (fs.existsSync(caminhoBanco)) {
    const db = new Database(caminhoBanco, { readonly: true });
    // deals_anteriores (feature "cliente que volta") pode nao existir num banco antigo/local — o
    // mesmo cuidado que o proprio index.js tem com colunas migradas por ALTER TABLE.
    const temDealsAnteriores = db.prepare("SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'deals_anteriores'").get();
    const linhas = db.prepare(`
      SELECT chat_id, deal_id, contact_name, last_data, last_action, custom_fields_bot,
             campos_travados, opcao_invalida_hash, updated_at
             ${temDealsAnteriores ? ', deals_anteriores' : ''}
      FROM conversations
    `).all();
    db.close();
    for (const l of linhas) {
      if (l.deal_id) porDealId.set(String(l.deal_id), l);
      // Cliente que volta: abrirNovoAtendimento zera deal_id da linha e arquiva o deal antigo em
      // deals_anteriores — sem isso, todo deal de atendimento encerrado por essa rotina apareceria
      // como "sem correspondencia", quando na verdade so saiu da conversa atual.
      for (const anterior of parseJsonSeguro(l.deals_anteriores, [])) {
        if (anterior?.deal_id && !porDealId.has(String(anterior.deal_id))) {
          porDealId.set(String(anterior.deal_id), { ...l, eh_deal_anterior: true, last_data: null });
        }
      }
    }
    console.log(`💾 Banco (${caminhoBanco}, readonly): ${linhas.length} conversa(s), ${porDealId.size} deal_id(s) conhecido(s) (atuais + anteriores)\n`);
  } else {
    console.log(`💾 Banco nao encontrado em ${caminhoBanco} — segue so com o que a API do Moskit disser\n`);
  }

  const doBot = [];
  let start = 0;
  let pagina = 0;
  let truncou = false;
  let totalVistos = 0;
  let totalSemOrigemGeral = 0; // conta TODA a conta, nao so origin=BOT_WHATSAPP — contexto pra saber
                                // se a reclamacao de "muitos sem origem" e sobre o bot ou sobre a base inteira.
  const origensVistas = {};
  console.log('Paginando /deals (pagina de 10, ?start=)...');
  while (pagina < MAX_PAGINAS) {
    if (pagina > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
    const { data, status } = await axios.get(`${MOSKIT_BASE}/deals`, {
      params: { start, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (status < 200 || status >= 300) { console.log(`  ⚠️ HTTP ${status} na pagina start=${start} — parando a varredura aqui`); break; }
    const lote = Array.isArray(data) ? data : [];
    for (const d of lote) {
      totalVistos++;
      origensVistas[d.origin || '(nulo)'] = (origensVistas[d.origin || '(nulo)'] || 0) + 1;
      if (motivoSemOrigem(d.entityCustomFields)) totalSemOrigemGeral++;
      if (d.origin === 'BOT_WHATSAPP') doBot.push(d);
    }
    pagina++;
    if (pagina % 25 === 0) console.log(`  ... ${pagina} paginas lidas, ${totalVistos} deals vistos, ${doBot.length} do bot até aqui`);
    if (lote.length < 10) break; // pagina incompleta = fim da lista (mesmo criterio de listarAtividadesMoskit)
    if (pagina === MAX_PAGINAS) truncou = true;
    start += lote.length;
  }
  if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS} paginas atingido — pode haver mais deals do bot alem dos vistos`);
  console.log(`✅ Varredura completa: ${pagina} pagina(s), ${totalVistos} deal(s) na conta inteira, ${doBot.length} deal(s) com origin=BOT_WHATSAPP\n`);
  console.log(`📊 Contexto (conta INTEIRA, nao so o bot): ${totalSemOrigemGeral} de ${totalVistos} deals estao sem "Origem" (${((totalSemOrigemGeral / totalVistos) * 100).toFixed(1)}%)`);
  console.log(`   Distribuicao de 'origin' na conta: ${JSON.stringify(origensVistas)}\n`);

  const semOrigem = [];
  let comOrigem = 0;
  for (const d of doBot) {
    const motivo = motivoSemOrigem(d.entityCustomFields);
    if (!motivo) { comOrigem++; continue; }
    const linhaLocal = porDealId.get(String(d.id));
    semOrigem.push({
      deal_id: d.id,
      nome: d.name,
      status: d.status,
      criado_em: d.dateCreated,
      chat_id: linhaLocal?.chat_id || null,
      so_vinculado: linhaLocal ? !linhaLocal.custom_fields_bot : null,
      origem_local: linhaLocal ? (parseJsonSeguro(linhaLocal.last_data, null)?.origem || null) : null,
      motivo, // 'campo_ausente' | 'explicitamente_nao_identificado'
      causa: classificarCausa(linhaLocal),
    });
  }

  console.log('='.repeat(70));
  console.log(`Deals do bot: ${doBot.length} | com origem real: ${comOrigem} | SEM origem: ${semOrigem.length}`);
  const porMotivo = { campo_ausente: 0, explicitamente_nao_identificado: 0 };
  for (const d of semOrigem) porMotivo[d.motivo] = (porMotivo[d.motivo] || 0) + 1;
  console.log(`  (campo ausente: ${porMotivo.campo_ausente} | explicitamente "Nao identificado": ${porMotivo.explicitamente_nao_identificado})\n`);

  if (semOrigem.length) {
    const porCausa = {};
    for (const d of semOrigem) {
      const chave = d.causa.split(' (')[0];
      (porCausa[chave] = porCausa[chave] || []).push(d);
    }
    console.log('Por causa provavel:');
    for (const [causa, lista] of Object.entries(porCausa).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${lista.length.toString().padStart(3)}  ${causa}`);
    }
    console.log('');

    console.log('Lista completa (deal_id | nome | status | criado_em | chat_id | motivo | causa):');
    for (const d of semOrigem) {
      console.log(`  ${d.deal_id}\t${(d.nome || '(sem nome)').slice(0, 40).padEnd(40)}\t${d.status}\t${(d.criado_em || '').slice(0, 10)}\t${d.chat_id || '(sem correspondencia)'}\t${d.motivo}\t${d.causa}`);
    }
    console.log('');
  }

  // Escape do CSV via src/csv.js desde 02/09/2026. A montagem anterior misturava JSON.stringify
  // (que escapa aspas como \", nao como "") com valores CRUS nao citados — `causa` contem virgula, e
  // toda virgula ali quebrava a coluna em duas sem erro nenhum na abertura da planilha.
  const csvPath = path.join(process.cwd(), `deals-bot-sem-origem-${Date.now()}.csv`);
  escreverCsv(csvPath, semOrigem.map((d) => ({
    deal_id: d.deal_id,
    nome: d.nome || '',
    status: d.status,
    criado_em: d.criado_em || '',
    chat_id: d.chat_id || '',
    so_vinculado: d.so_vinculado,
    origem_local: d.origem_local || '',
    motivo: d.motivo,
    causa: d.causa,
  })));
  console.log(`📄 CSV salvo em: ${csvPath}`);

  console.log('='.repeat(70));
  console.log('Nada foi alterado.\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
