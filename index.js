require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { validarObservacoes, ultimaObservacao } = require('./src/evidencia');
const { detectarBlocoCondicoes, contarAnexosIlegiveisEquipe } = require('./src/bloco-condicoes');
const { apurarDuplaConfirmacao, descreverPendencia } = require('./src/agendamento');
const { enfileirar, TEMP_DIR } = require('./src/fila');
const { jaExiste, normalizarMensagens } = require('./src/mensagens');
const { chaveConversa, ehInterno, TEAM_SUFIXOS } = require('./src/telefone');
const { transcreverAudio } = require('./src/transcricao');
const MOSKIT_IDS = require('./src/moskit-ids');

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Ver src/moskit-ids.js — todo identificador do Moskit vive la, numa fonte so.
const { LAYLA_USER_ID, PRODUTO_CONSULTA_PAGA_ID, STATUS_DEAL, LOST_REASON, LOST_REASON_PADRAO_ID } = require('./src/moskit-ids');
const TEMPO_INATIVIDADE_MS = Number(process.env.TEMPO_INATIVIDADE_MS) || 5 * 60 * 1000;
const MOSKIT_STAGE_CONSULTA_AGENDADA = Number(process.env.MOSKIT_STAGE_CONSULTA_AGENDADA) || 184382;
const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const TZ_ESCRITORIO = process.env.TZ_ESCRITORIO || 'America/Fortaleza';
// Valor da consulta (aceita igual ou maior — pagamento por cartao pode ter acrescimo)
const COMPROVANTE_VALOR_ESPERADO_CENTAVOS = Number(process.env.COMPROVANTE_VALOR_ESPERADO_CENTAVOS) || 35000;

// Funil de vendas completo (pipeline "Funil de Vendas", id 40631), em ordem de avanco.
// priority vem direto do GET /stages do Moskit — usado pra nunca deixar o funil andar pra tras.
const FUNIL_DRY_RUN = process.env.FUNIL_DRY_RUN !== 'false'; // default true (so anota, nao move de verdade)
// Fechar um negocio (ganho/perdido) e mais consequente e mais novo que avancar de estagio — flag
// separada de FUNIL_DRY_RUN de proposito, pra poder ligar o avanco de estagio primeiro, observar,
// e so depois (com confianca independente) ligar o fechamento automatico.
const FUNIL_FECHAMENTO_DRY_RUN = process.env.FUNIL_FECHAMENTO_DRY_RUN !== 'false'; // default true
// Cria evento/Meet sem comprovante quando o deal esta marcado como "consulta gratis" no Moskit.
// Default DESLIGADO de proposito: sobe o codigo, roda GET /auditoria-consulta-gratis pra ver o que
// seria liberado, e so entao liga no .env.
const LIBERAR_CONSULTA_GRATIS = process.env.LIBERAR_CONSULTA_GRATIS === 'true';
const MOSKIT_STAGE_MAP = {
  agendamento: { id: Number(process.env.MOSKIT_STAGE_ID) || 179388, priority: 3 },
  consulta_agendada: { id: MOSKIT_STAGE_CONSULTA_AGENDADA, priority: 4 },
  aguardando_condicao: { id: Number(process.env.MOSKIT_STAGE_AGUARDANDO_CONDICAO) || 285584, priority: 5 },
  elaboracao_proposta: { id: Number(process.env.MOSKIT_STAGE_ELABORACAO_PROPOSTA) || 267035, priority: 9 },
  negociacao: { id: Number(process.env.MOSKIT_STAGE_NEGOCIACAO) || 182159, priority: 12 },
  elaboracao_contrato: { id: Number(process.env.MOSKIT_STAGE_ELABORACAO_CONTRATO) || 179385, priority: 13 },
  contrato_enviado: { id: Number(process.env.MOSKIT_STAGE_CONTRATO_ENVIADO) || 179386, priority: 17 },
};

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;

// Telefones de socios e equipe — nunca processar como lead. A lista vive no .env (TEAM_PHONES) e a
// comparacao e por sufixo de 8 digitos: ver ehInterno() em src/telefone.js.
// Antes eram 5 numeros fixos aqui, comparados por igualdade exata, enquanto a equipe tem 12.

// Teto de paginas na busca de contato: protege contra base grande + resposta sem token de proxima
// pagina, que viraria loop. 20 x 100 cobre a base atual com folga.
const MAX_PAGINAS_BUSCA_CONTATO = Number(process.env.MAX_PAGINAS_BUSCA_CONTATO) || 20;
// Timeout de toda chamada HTTP feita por axios (Moskit, Zernio, download de anexo). Aplicado como
// default global mais abaixo, junto com o httpsAgent — cobre os 25 call sites de uma vez.
const TIMEOUT_HTTP_MS = Number(process.env.TIMEOUT_HTTP_MS) || 30000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ------------------------------------------------------------
// Google Calendar (OAuth2 com conta real do escritorio — necessario
// pra criar link do Google Meet e convidar participantes por email;
// a service account nao tem essas permissoes sem Domain-Wide Delegation)
// ------------------------------------------------------------
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
let googleOAuthClient = null;
function getGoogleAuthClient() {
  if (googleOAuthClient) return googleOAuthClient;
  const caminhoClient = process.env.GOOGLE_OAUTH_CLIENT_JSON || './google-oauth-client.json';
  const caminhoToken = process.env.GOOGLE_OAUTH_TOKEN_JSON || './google-oauth-token.json';
  if (!GOOGLE_CALENDAR_ID || !fs.existsSync(caminhoClient) || !fs.existsSync(caminhoToken)) return null;
  const { client_id, client_secret, redirect_uris } = JSON.parse(fs.readFileSync(caminhoClient, 'utf8')).installed;
  const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  client.setCredentials(JSON.parse(fs.readFileSync(caminhoToken, 'utf8')));
  googleOAuthClient = client;
  return googleOAuthClient;
}

// HTTP agent compartilhado para evitar exaustao de conexoes
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
// Timeout global de toda chamada axios. Fica aqui, num lugar so — o valor estava hard-coded e agora
// vem de TIMEOUT_HTTP_MS, configuravel por .env.
axios.defaults.timeout = TIMEOUT_HTTP_MS;

// Chamada direta a API OpenAI via HTTPS (sem SDK, sem fetch, sem hangs)
async function openaiChat(messages, responseFormat) {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    messages,
    temperature: 0,
    ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
  });

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; req.destroy(); reject(new Error('timeout')); }
    }, 30000);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) reject(new Error('OpenAI retornou resposta vazia'));
          else resolve(content);
        } catch (e) {
          reject(new Error('Falha ao parsear resposta OpenAI: ' + e.message));
        }
      });
    });

    req.on('timeout', () => { if (!done) { done = true; req.destroy(); reject(new Error('OpenAI socket timeout')); } });
    req.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    req.write(body);
    req.end();
  });
}

const apiHeaders = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
};

// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
// DB_PATH existe para TESTE. Sem ele, qualquer teste que faca require('./index.js') abre o banco de
// producao e roda os ALTER TABLE nas conversas reais — foi assim que o test-rotas.js nasceu tocando
// as 208 conversas. As tabelas nascem com CREATE TABLE IF NOT EXISTS, entao apontar para um arquivo
// inexistente produz um banco valido e completo, descartavel.
const db = new Database(process.env.DB_PATH || 'conversations.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    chat_id TEXT PRIMARY KEY,
    phone TEXT,
    contact_name TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    deal_id INTEGER,
    last_activity TEXT,
    last_data TEXT,
    last_action TEXT,
    processed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

try { db.exec("ALTER TABLE conversations ADD COLUMN last_data TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN last_action TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN processed INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_added INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN last_processed_at TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_criado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_id TEXT"); } catch {}
// Horario que o bot reservou de fato — sem isso nao ha memoria de qual slot foi agendado
// (atualizarEventoSeRemarcado sempre relia do Google) e nao da pra auditar remarcacao.
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_data TEXT"); } catch {}
// Checkpoint da cobranca: 1 depois que a equipe enviou o bloco de condicoes de valor nesta conversa.
// Transicao de mao unica (cortesia -> paga); e a virada 0->1 que dispara a correcao do deal.
try { db.exec("ALTER TABLE conversations ADD COLUMN bloco_condicoes_enviado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN bloco_condicoes_msg_idx INTEGER"); } catch {}
// Hash da ultima pendencia de agendamento ja anotada no deal — evita repetir a nota a cada ciclo.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_pendente_hash TEXT"); } catch {}
// Hash do ultimo ERRO de agendamento ja anotado no deal (token expirado, erro de rede, etc — nao
// confundir com agendamento_pendente_hash, que e sobre confirmacao INCOMPLETA). Sem isso a falha na
// criacao/remarcacao do evento so aparecia no console do processo: a dupla confirmacao acontecia de
// verdade e ninguem no escritorio ficava sabendo que a reuniao nao foi pra agenda. Visto no deal
// 48346871 (token OAuth expirado): confirmacao completa, zero nota no CRM.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_erro_hash TEXT"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS moskit_contacts (
    phone TEXT PRIMARY KEY,
    moskit_id INTEGER,
    name TEXT,
    raw_data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_moskit_phone ON moskit_contacts(phone)"); } catch {}

const stmtMoskitUpsert = db.prepare(`
  INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET
    moskit_id = excluded.moskit_id,
    name = excluded.name,
    raw_data = excluded.raw_data,
    updated_at = datetime('now')
`);
const stmtMoskitGet = db.prepare('SELECT * FROM moskit_contacts WHERE phone = ?');
const stmtMoskitCount = db.prepare('SELECT COUNT(*) as t FROM moskit_contacts');

const stmtUpsert = db.prepare(`
  INSERT INTO conversations (chat_id, phone, contact_name, messages, last_activity)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    messages = excluded.messages,
    last_activity = excluded.last_activity,
    phone = excluded.phone,
    contact_name = excluded.contact_name,
    updated_at = datetime('now')
`);

const stmtGet = db.prepare('SELECT * FROM conversations WHERE chat_id = ?');
const stmtUpdateDeal = db.prepare(
  "UPDATE conversations SET deal_id = ?, last_data = ?, last_action = ?, processed = 1, updated_at = datetime('now') WHERE chat_id = ?"
);
const stmtUpdateProcessed = db.prepare(
  "UPDATE conversations SET last_data = ?, last_action = ?, processed = 1, updated_at = datetime('now') WHERE chat_id = ?"
);
// Usado por finalizarCiclo: grava deal_id, dados, acao, processed e last_processed_at de uma vez.
// Os ramos faziam isso em DOIS comandos (stmtUpdateDeal + um db.prepare inline so pro
// last_processed_at), repetidos em cada um dos tres ramos.
const stmtFinalizarCiclo = db.prepare(
  "UPDATE conversations SET deal_id = ?, last_data = ?, last_action = ?, processed = 1, last_processed_at = datetime('now'), updated_at = datetime('now') WHERE chat_id = ?"
);
const stmtGetPending = db.prepare("SELECT * FROM conversations WHERE processed = 0 OR processed IS NULL");

db.exec(`
  CREATE TABLE IF NOT EXISTS comprovantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    phone TEXT,
    caminho_arquivo TEXT,
    valor_pago_centavos INTEGER,
    confianca INTEGER,
    parece_comprovante INTEGER,
    observacao TEXT,
    match INTEGER,
    notificado_telegram INTEGER DEFAULT 0,
    deal_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_comprovantes_chat ON comprovantes(chat_id)"); } catch {}

const stmtComprovanteInsert = db.prepare(`
  INSERT INTO comprovantes (chat_id, phone, caminho_arquivo, valor_pago_centavos, confianca, parece_comprovante, observacao, match, notificado_telegram)
  VALUES (@chat_id, @phone, @caminho_arquivo, @valor_pago_centavos, @confianca, @parece_comprovante, @observacao, @match, @notificado_telegram)
`);
const stmtComprovanteUltimo = db.prepare(
  'SELECT * FROM comprovantes WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
);
const stmtComprovanteSetDeal = db.prepare('UPDATE comprovantes SET deal_id = ? WHERE id = ?');
const stmtComprovantePorDeal = db.prepare(
  'SELECT * FROM comprovantes WHERE deal_id = ? AND match = 1 ORDER BY id DESC LIMIT 1'
);
const stmtComprovantePorSufixoTelefone = db.prepare(
  "SELECT * FROM comprovantes WHERE match = 1 AND (chat_id LIKE '%' || ? || '%' OR phone LIKE '%' || ? || '%') ORDER BY id DESC LIMIT 1"
);

db.exec(`
  CREATE TABLE IF NOT EXISTS atividades_sincronizadas (
    activity_id INTEGER PRIMARY KEY,
    evento_calendar_id TEXT,
    deal_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
const stmtAtividadeJaSincronizada = db.prepare('SELECT 1 FROM atividades_sincronizadas WHERE activity_id = ?');
const stmtAtividadeMarcarSincronizada = db.prepare(
  'INSERT OR IGNORE INTO atividades_sincronizadas (activity_id, evento_calendar_id, deal_id) VALUES (?, ?, ?)'
);

// ------------------------------------------------------------
// Mapeamentos de campos personalizados (Moskit)
// ------------------------------------------------------------
function removerAcentos(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function removerEmoji(str) {
  return String(str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\ufe0f]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Tabelas de ID vem de src/moskit-ids.js — fonte unica, importada tambem pelos scripts.
const MAPEAMENTO_ORIGEM = MOSKIT_IDS.ORIGEM;
const MAPEAMENTO_TIPO_CONSULTA = MOSKIT_IDS.TIPO_CONSULTA;
const MAPEAMENTO_CAPTACAO = MOSKIT_IDS.CAPTACAO;
const MAPEAMENTO_AREA_DIREITO = MOSKIT_IDS.AREA_DIREITO;
const MAPEAMENTO_RESPONSAVEL_PROCESSO = MOSKIT_IDS.RESPONSAVEL_PROCESSO;

// Campo "Tipo de Consulta" do deal (MULTIPLE_OPTION). Unica fonte de verdade pra leads que nunca
// passaram pelo WhatsApp (Moskit Boost, atividade criada na mao) — ver autorizacaoParaAgendar.
const CF_TIPO_CONSULTA = MOSKIT_IDS.CF.TIPO_CONSULTA;
const TIPO_CONSULTA_GRATIS_ID = MOSKIT_IDS.TIPO_CONSULTA_GRATIS_ID;
const TIPO_CONSULTA_PAGA_ID = MOSKIT_IDS.TIPO_CONSULTA_PAGA_ID;

function buscarIdOpcao(mapeamento, valor) {
  if (!valor) return null;
  const normalizado = removerAcentos(String(valor).toLowerCase().trim());
  if (mapeamento[normalizado] !== undefined) return mapeamento[normalizado];
  for (const [label, id] of Object.entries(mapeamento)) {
    const labelSemAcento = removerAcentos(label);
    if (normalizado === labelSemAcento ||
        normalizado.includes(labelSemAcento) ||
        labelSemAcento.includes(normalizado)) {
      return id;
    }
  }
  console.log(`  opcao nao encontrada para "${valor}"`);
  return null;
}

// Bloco padrao de condicoes que a equipe manda quando a consulta e PAGA. Se a equipe NUNCA enviou
// esse bloco, a consulta e cortesia — essa e a regra do escritorio, porque o atendente nunca declara
// gratuidade explicitamente.
//
// A deteccao vive em src/bloco-condicoes.js: e impressao digital do template (1 marcador de valor OU
// 3 de estrutura), avaliada por mensagem e sobre a concatenacao do que a equipe escreveu. O detector
// antigo era um punhado de regex soltas e uma delas ("informacoes sobre o atendimento") procurava
// uma frase que nao existe mais no bloco em uso, entao bloco parcial passava como cortesia.
function equipeEnviouCondicoesDeValor(mensagens) {
  return detectarBlocoCondicoes(mensagens).enviado;
}

// Campo MULTIPLE_OPTION: pode ter mais de uma opcao marcada. Regra conservadora — so e gratis se a
// opcao gratis estiver presente E a paga NAO estiver. Campo vazio, "sem consulta" ou combinacao
// ambigua => false, mantendo a exigencia de comprovante.
function dealEhConsultaGratis(deal) {
  const campo = (deal?.entityCustomFields || []).find((c) => c?.id === CF_TIPO_CONSULTA);
  const opcoes = (campo?.options || []).map(Number);
  if (!opcoes.length || opcoes.includes(TIPO_CONSULTA_PAGA_ID)) return false;
  return opcoes.includes(TIPO_CONSULTA_GRATIS_ID);
}

// O PUT do Moskit e "full replace": qualquer campo ausente do payload some do deal. Preserva o que
// a equipe preencheu na mao e que o bot nao soube resolver nesta rodada.
function mesclarCustomFields(existentes, novos) {
  const mapa = new Map();
  for (const c of (Array.isArray(existentes) ? existentes : [])) {
    if (c?.id && Array.isArray(c.options) && c.options.length) mapa.set(c.id, { id: c.id, options: c.options });
  }
  for (const c of (Array.isArray(novos) ? novos : [])) mapa.set(c.id, c);
  return [...mapa.values()];
}

// Compara por id do custom field + conjunto de options (nao por posicao no array nem
// JSON.stringify direto — o Moskit nao garante a mesma ordem de array em duas leituras, e
// id/options podem vir como string numa leitura e number noutra).
function customFieldsPersistiram(esperados, atuais) {
  const mapaAtual = new Map((Array.isArray(atuais) ? atuais : []).map((c) => [c.id, c]));
  return (Array.isArray(esperados) ? esperados : []).every((esperado) => {
    const atual = mapaAtual.get(esperado.id);
    if (!atual) return false;
    const optsEsperados = (esperado.options || []).map(String).sort();
    const optsAtuais = (atual.options || []).map(String).sort();
    return optsEsperados.length === optsAtuais.length && optsEsperados.every((o, i) => o === optsAtuais[i]);
  });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function extrairTelefone(from) {
  return from.replace(/@[a-z0-9.-]+$/, '');
}

const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado'];

// Data (YYYY-MM-DD) e dia da semana no fuso do escritorio — o Date do Node guarda UTC, e uma
// mensagem enviada as 21h em Fortaleza cai no dia seguinte em UTC.
function diaLocal(d) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ_ESCRITORIO });
}
function diaSemanaLocal(d) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ_ESCRITORIO, weekday: 'short' }).format(d);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes);
  return DIAS_SEMANA[idx >= 0 ? idx : d.getDay()];
}

// Lista os proximos 14 dias com o nome do dia da semana, pra que o modelo so precise CONSULTAR a
// tabela em vez de calcular "que dia cai a proxima quarta" — a conta que ele erra (ver a regra
// ATENCAO AO DIA DA SEMANA no PROMPT_EXTRAIR).
function montarReferenciaDeDatas(isoAncora) {
  const base = new Date(isoAncora);
  if (isNaN(base.getTime())) return '  (data-ancora invalida — nao resolva dias relativos)';
  const linhas = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    linhas.push(`  ${diaLocal(d)} = ${diaSemanaLocal(d)}${i === 0 ? '   <- DATA-ANCORA (dia da ultima mensagem)' : ''}`);
  }
  return linhas.join('\n');
}

// O modelo precisa distinguir o que foi combinado ontem do que foi combinado hoje — sem isso um
// acordo antigo e ja superado parece tao atual quanto a ultima mensagem. Cabecalho por dia em vez
// de timestamp por mensagem pra nao inflar o prompt em conversa de 100+ mensagens.
// Cada linha comeca com o indice da mensagem no array `messages`. E esse numero que o modelo cita em
// `observacoes.msg_idx`, e e por ele que o codigo confere o role de quem falou (ver src/evidencia.js).
// Efeito colateral util: um cliente que digite "Equipe do escritório: ..." dentro da propria mensagem
// aparece embaixo do indice DELE, sem indice proprio — nao ganha mais o mesmo peso visual.
function montarHistorico(mensagens) {
  const linhas = [];
  let diaAnterior = null;
  for (let i = 0; i < mensagens.length; i++) {
    const m = mensagens[i];
    const label = m.role === 'equipe' ? 'Equipe do escritório' : m.role === 'sistema' ? 'Sistema' : 'Cliente';
    const d = m.timestamp ? new Date(m.timestamp) : null;
    if (d && !isNaN(d.getTime())) {
      const dia = diaLocal(d);
      if (dia !== diaAnterior) {
        linhas.push(`--- ${dia} (${diaSemanaLocal(d)}) ---`);
        diaAnterior = dia;
      }
    }
    linhas.push(`[${i}] ${label}: ${m.text}`);
  }
  return linhas.join('\n');
}

// assunto entra aqui pra que um deal criado sem tema no nome seja cobrado nos ciclos seguintes
// (camposPendentes -> acao "atualizar_campos" -> PUT -> deal renomeado). Sem isso a IA escolhe
// "nota", que nao faz PUT, e o nome fica congelado sem o tema pra sempre.
const CAMPOS_OBRIGATORIOS = ['assunto', 'origem', 'tipo_consulta', 'area_direito', 'advogado_responsavel'];

function camposPendentes(dados) {
  if (!dados) return CAMPOS_OBRIGATORIOS;
  return CAMPOS_OBRIGATORIOS.filter((k) => !dados[k] || dados[k] === 'null');
}

function mergeDados(anteriores, novos) {
  const merged = { ...(anteriores || {}) };
  for (const key of Object.keys(novos || {})) {
    if (novos[key] !== null && novos[key] !== undefined && novos[key] !== 'null') {
      merged[key] = novos[key];
    }
  }
  return merged;
}

// ------------------------------------------------------------
// Moskit API
// ------------------------------------------------------------
async function buscarOuCriarContato(phone, name) {
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const phoneClean = phoneDigits.slice(-13);

  // Ultima barreira antes de escrever no CRM. As camadas acima ja barram numero interno, mas se um
  // caminho novo chegar ate aqui, e melhor explodir do que criar contato de socio no Moskit.
  if (ehInterno(phoneDigits)) {
    throw new Error(`buscarOuCriarContato chamada para numero interno (${phoneClean}) — abortado`);
  }

  // 1) Espelho local primeiro. A tabela moskit_contacts ja e um dump do CRM (preenchida por
  //    /importar-moskit) e ate agora so alimentava o banner "Cliente NOVO/EXISTENTE". A busca na API
  //    abaixo le APENAS a primeira pagina de /contacts ordenada por id desc: contato antigo nunca
  //    aparecia ali, o codigo caia no POST e criava DUPLICATA — em toda rodada criar/nota/atualizar.
  if (phoneClean.length >= 8) {
    const espelho = stmtMoskitGet.get(phoneClean);
    if (espelho?.moskit_id) return espelho.moskit_id;
  }

  // 2) Fallback na API, agora paginando de verdade (mesmo mecanismo de importarContatosMoskit).
  //    Menos de 8 digitos nao identifica um telefone com seguranca — evita ".includes()" casando com
  //    qualquer numero que contenha a mesma sequencia.
  if (phoneDigits.length >= 8) {
    try {
      let pageToken = null;
      for (let pagina = 0; pagina < MAX_PAGINAS_BUSCA_CONTATO; pagina++) {
        const listRes = await axios.get(`${MOSKIT_BASE}/contacts`, {
          params: { limit: 100, sort: 'id', order: 'desc', ...(pageToken ? { pageToken } : { page: 1 }) },
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
          timeout: TIMEOUT_HTTP_MS,
        });
        if (listRes.status < 200 || listRes.status >= 300) break;

        const contatos = Array.isArray(listRes.data) ? listRes.data : [];
        const found = contatos.find((c) => (c.phones || [])
          .some((p) => String(p.number).replace(/\D/g, '').includes(phoneDigits)));
        if (found) {
          // Alimenta o espelho pra que a proxima rodada nem precise da rede.
          stmtMoskitUpsert.run(phoneClean, found.id, found.name || '', JSON.stringify(found));
          return found.id;
        }

        pageToken = listRes.headers?.['x-moskit-listing-next-page-token']
          || listRes.headers?.['x-ollow-listing-next-page-token'];
        if (!pageToken || contatos.length === 0) break;
      }
    } catch (e) {
      console.error(`  ⚠️ busca de contato falhou (${e.message}) — seguindo para criacao`);
    }
  }

  const createRes = await axios.post(
    `${MOSKIT_BASE}/contacts`,
    {
      name: `*${name || 'Cliente sem nome'}`,
      createdBy: { id: LAYLA_USER_ID },
      responsible: { id: LAYLA_USER_ID },
      phones: [{ number: phone }],
    },
    { headers: apiHeaders, validateStatus: (s) => s < 500, timeout: TIMEOUT_HTTP_MS }
  );

  // validateStatus aceita 4xx: sem conferir o status, um 400/409 devolvia `undefined` como contactId
  // e seguia para o payload do deal com `contacts: [{ id: undefined }]`.
  if (createRes.status < 200 || createRes.status >= 300 || !createRes.data?.id) {
    throw new Error(`POST /contacts falhou (${createRes.status}): ${JSON.stringify(createRes.data)?.slice(0, 200)}`);
  }

  // Espelho atualizado na criacao — sem isso o proximo ciclo nao acha o contato recem-criado (ele
  // esta na primeira pagina hoje, mas sai dela assim que outros contatos forem criados) e duplica.
  if (phoneClean.length >= 8) {
    stmtMoskitUpsert.run(phoneClean, createRes.data.id, name || '', JSON.stringify(createRes.data));
  }

  return createRes.data.id;
}

async function buscarDealPorContato(contactId) {
  try {
    const listRes = await axios.get(`${MOSKIT_BASE}/deals`, {
      params: { page: 1, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const deals = listRes.data || [];
    if (Array.isArray(deals)) {
      for (const deal of deals) {
        const detailRes = await axios.get(`${MOSKIT_BASE}/deals/${deal.id}`, {
          headers: apiHeaders,
              validateStatus: (s) => s < 500,
        });
        const contacts = detailRes.data?.contacts || [];
        const match = contacts.some((c) => String(c.id) === String(contactId));
        if (match) return deal.id;
      }
    }
  } catch {}
  return null;
}

function montarPayloadMoskit(dados, contactId, opcoes = {}) {
  const customFields = [];

  // CHECKPOINT: o bloco de condicoes de valor e o unico fato que decide paga x cortesia.
  //   nunca enviado  => cortesia (price 0)
  //   enviado, quando for => paga (price 35000), inclusive retroativamente num deal ja criado
  // Nao ha mais a pre-condicao de "so concluir cortesia depois que a equipe confirmar o horario":
  // como o deal se corrige sozinho quando o bloco chega depois, concluir cortesia cedo nao custa nada.
  // condicoesValorEnviadas === undefined (mensagens indisponiveis) => cai em paga, padrao seguro.
  const tratarComoGratis = opcoes.condicoesValorEnviadas === false;
  const tipoConsultaFinal = tratarComoGratis ? 'consulta gratis' : dados.tipo_consulta;

  const idOrigem = buscarIdOpcao(MAPEAMENTO_ORIGEM, dados.origem);
  if (idOrigem) customFields.push({ id: MOSKIT_IDS.CF.ORIGEM, options: [idOrigem] });

  const idTipoConsulta = buscarIdOpcao(MAPEAMENTO_TIPO_CONSULTA, tipoConsultaFinal);
  if (idTipoConsulta) customFields.push({ id: CF_TIPO_CONSULTA, options: [idTipoConsulta] });

  const idCaptacao = buscarIdOpcao(MAPEAMENTO_CAPTACAO, dados.captacao);
  if (idCaptacao) customFields.push({ id: MOSKIT_IDS.CF.CAPTACAO, options: [idCaptacao] });

  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  if (idArea) customFields.push({ id: MOSKIT_IDS.CF.AREA_DIREITO, options: [idArea] });

  const idResponsavel = buscarIdOpcao(MAPEAMENTO_RESPONSAVEL_PROCESSO, dados.advogado_responsavel);
  if (idResponsavel) customFields.push({ id: MOSKIT_IDS.CF.RESPONSAVEL, options: [idResponsavel] });

  const nomeLimpo = removerEmoji(dados.nome);
  const assuntoLimpo = removerEmoji(dados.assunto);
  const nomeDeal = assuntoLimpo ? `${nomeLimpo || 'Cliente sem nome'} - ${assuntoLimpo}` : (nomeLimpo || 'Cliente sem nome');
  if (!assuntoLimpo) console.log(`  ⚠️ assunto vazio — deal vai ficar so com o nome do cliente ("${nomeLimpo || 'Cliente sem nome'}")`);
  const payload = {
    name: nomeDeal,
    status: 'OPEN',
    stage: { id: Number(process.env.MOSKIT_STAGE_ID) },
    createdBy: { id: LAYLA_USER_ID },
    responsible: { id: LAYLA_USER_ID },
    contacts: [{ id: contactId }],
    entityCustomFields: customFields,
    // Mesma constante que a verificacao do comprovante usa. Com o literal 35000 aqui, mudar o valor
    // no .env fazia o preco do negocio e a conferencia do pagamento discordarem em silencio.
    price: tratarComoGratis ? 0 : COMPROVANTE_VALOR_ESPERADO_CENTAVOS,
    dealProducts: [{ product: { id: PRODUTO_CONSULTA_PAGA_ID }, quantity: 1, price: 0, initialPrice: 0, finalPrice: 0 }],
  };

  return payload;
}

async function criarNegocioMoskit(dados, contactId, opcoes = {}) {
  const payload = montarPayloadMoskit(dados, contactId, opcoes);
  const response = await axios.post(`${MOSKIT_BASE}/deals`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return response.data;
}

async function atualizarNegocioMoskit(dealId, dados, contactId, opcoes = {}) {
  const payload = montarPayloadMoskit(dados, contactId, opcoes);
  // Tudo que o bot decidiu sobre este lead NESTA rodada, antes do merge com o que ja existia
  // remotamente (que so acontece no GET abaixo) — e exatamente o que confirmamos apos o PUT.
  const camposEsperados = payload.entityCustomFields;

  // O PUT substitui o deal inteiro. Le o estado atual antes pra (1) nao apagar campo personalizado
  // que a equipe preencheu na mao e o bot nao resolveu nesta rodada, e (2) preservar marcacao manual
  // de "consulta gratis" — mas so ENQUANTO o bloco de condicoes nao tiver sido enviado.
  // Depois do bloco quem manda e o checkpoint: foi a propria equipe que anunciou o valor, entao a
  // consulta e paga e o deal tem que subir pra R$350 mesmo que alguem tenha marcado gratis na mao.
  const blocoEnviado = opcoes.condicoesValorEnviadas === true;
  try {
    const atualRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 200 && atualRes.status < 300) {
      // Nome: so escreve se o deal ainda estiver com o nome cru que o proprio bot gera (sem tema).
      // Se alguem da equipe renomeou na mao, ou se o nome atual ja tem tema e esta rodada veio sem
      // assunto, preserva o que esta la — nunca tira um tema que ja estava certo.
      const nomeRemoto = String(atualRes.data?.name || '').trim();
      const nomeCruDoBot = removerEmoji(dados.nome) || 'Cliente sem nome';
      if (nomeRemoto && nomeRemoto !== nomeCruDoBot) {
        if (nomeRemoto !== payload.name) console.log(`  ⏭️ nome do deal ${dealId} preservado ("${nomeRemoto}")`);
        payload.name = atualRes.data.name;
      }

      // Estagio: montarPayloadMoskit sempre monta o estagio INICIAL, e o PUT e full replace — sem
      // preservar aqui, toda atualizacao arrasta o deal de volta pro comeco do funil, desfazendo o
      // que moverParaEstagio/a equipe tinham avancado.
      const stageAtual = atualRes.data?.stage?.id;
      if (stageAtual) payload.stage = { id: stageAtual };

      if (dealEhConsultaGratis(atualRes.data)) {
        const novoTipo = payload.entityCustomFields.find((c) => c.id === CF_TIPO_CONSULTA);
        if (novoTipo && !novoTipo.options.includes(TIPO_CONSULTA_GRATIS_ID)) {
          if (blocoEnviado) {
            console.log(`  💳 Deal ${dealId} estava marcado "consulta gratis", mas a equipe enviou o bloco de condicoes — reclassificando para PAGA`);
          } else {
            console.log(`  🆓 Deal ${dealId} ja marcado como "consulta gratis" no Moskit — preservando (nao rebaixa pra paga)`);
            novoTipo.options = [TIPO_CONSULTA_GRATIS_ID];
            payload.price = 0;
          }
        }
      }
      payload.entityCustomFields = mesclarCustomFields(atualRes.data?.entityCustomFields, payload.entityCustomFields);
    }
  } catch (e) {
    console.error(`  ❌ Erro ao ler deal ${dealId} antes de atualizar (seguindo sem mesclar): ${e.message}`);
  }

  const response = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });

  // O Moskit pode aceitar o PUT (2xx) e so aplicar o valor de fato alguns segundos depois (mesmo
  // cache/lag de propagacao documentado em putDealComVerificacao, abaixo). Sem esta confirmacao o
  // bot cria a nota de "Campos preenchidos" achando que deu certo mesmo quando o campo nao pegou —
  // foi exatamente isso que exigiu correcao manual no deal 48423360 (LGPD ficou preso no CRM depois
  // do bot ja ter decidido corretamente "Direito Administrativo"). Se nao ha custom field resolvido
  // nesta rodada, pula a confirmacao: zero GETs extras, zero latencia no caso comum.
  if (camposEsperados.length > 0) {
    const { confirmado, deal } = await confirmarAposRetentativas(
      dealId,
      (d) => customFieldsPersistiram(camposEsperados, d?.entityCustomFields)
    );
    if (!confirmado) {
      throw new Error(
        `Moskit aceitou o PUT no deal ${dealId} (2xx) mas os campos personalizados nao se confirmaram ` +
        `apos retentativas (esperado: ${JSON.stringify(camposEsperados)}, lido: ${JSON.stringify(deal?.entityCustomFields)})`
      );
    }
  }
  return response.data;
}

// Confirma que o deal ainda existe no Moskit antes de atualiza-lo — se foi apagado por fora do bot
// (ex: alguem da equipe removeu manualmente), recria com os dados mais recentes em vez de falhar
// pra sempre com 404 a cada nova tentativa (ver agendarProcessamento).
async function garantirDealExiste(dealId, dados, contactId, opcoes = {}) {
  if (!dealId) return null;
  try {
    const checkRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (checkRes.status !== 404) return dealId;
    console.log(`  ⚠️ Deal ${dealId} nao existe mais no Moskit — criando novo`);
  } catch {
    console.log(`  ⚠️ Erro ao verificar deal ${dealId} — criando novo`);
  }
  const deal = await criarNegocioMoskit(dados, contactId, opcoes);
  return deal.id;
}

// Roda na rodada em que o bloco de condicoes aparece pela primeira vez numa conversa que JA tem deal.
// O deal nasceu como cortesia (price 0) e agora precisa virar paga (R$350).
//
// Precisa ser chamada fora do switch de `acao` porque a virada nao depende do que a IA decidiu nesta
// rodada: os ramos "aguardar"/"ignorar"/"inviavel" retornam antes de qualquer escrita, e o ramo
// "nota" nunca chama atualizarNegocioMoskit (so garantirDealExiste, que faz PUT apenas se o deal
// sumiu). Sem isso, o bloco chegando num desses ciclos nao viraria nada no CRM.
async function aplicarViradaCobranca(chatId, row, dados, opcoesPayload, phone) {
  const dealId = row.deal_id;
  if (!dealId) return; // deal ainda nao existe — vai nascer ja como paga
  try {
    const contactId = await buscarOuCriarContato(phone, dados?.nome || row.contact_name);
    await atualizarNegocioMoskit(dealId, dados || {}, contactId, opcoesPayload);
    console.log(`  💳 Deal ${dealId} reclassificado para PAGA (price 35000) pelo checkpoint do bloco de condicoes`);
    await criarNotaMoskit(dealId, '💳 A equipe enviou as condições de valor nesta conversa — consulta reclassificada de cortesia para PAGA (R$350,00). Valor do negócio atualizado. Aguardando comprovante.');

    // Se a consulta ja foi pro Google Agenda como cortesia, o evento NAO e cancelado — cancelar
    // reuniao de cliente real por inferencia e pior que o erro. Avisa pra alguem cobrar.
    if (row.evento_calendar_criado) {
      const quando = row.evento_calendar_data
        ? new Date(row.evento_calendar_data).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO })
        : 'horario nao registrado';
      await enviarTelegram(
        `⚠️ *Consulta agendada como cortesia virou PAGA*\n\n` +
        `Cliente: ${dados?.nome || row.contact_name || chatId}\n` +
        `Telefone: ${chatId}\n` +
        `Horário: ${quando}\n\n` +
        `A equipe enviou as condições de valor DEPOIS de a consulta já estar na agenda. ` +
        `O evento foi mantido e o deal atualizado para R$350 — confirmar o pagamento com o cliente.`
      );
    }
  } catch (e) {
    console.error(`  ❌ Erro ao aplicar virada de cobranca no deal ${dealId}: ${e.message}`);
    // Nao regrava bloco_condicoes_enviado=0: a proxima rodada nao repetiria a virada. Reverte pra
    // que a correcao seja tentada de novo no proximo ciclo.
    db.prepare('UPDATE conversations SET bloco_condicoes_enviado = 0, bloco_condicoes_msg_idx = NULL WHERE chat_id = ?').run(chatId);
  }
}

async function criarNotaMoskit(dealId, texto) {
  if (!dealId) {
    console.error('  ⚠️ criarNotaMoskit chamada sem dealId — nota descartada');
    return;
  }
  // Sem validateStatus: 4xx aqui nao e esperado e precisa virar excecao. Com `s < 500` um
  // POST rejeitado passava como sucesso e a nota simplesmente nunca aparecia no deal.
  await axios.post(
    `${MOSKIT_BASE}/deals/${dealId}/notes`,
    { description: texto, user: { id: LAYLA_USER_ID } },
    { headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' } }
  );
}

// CONFIRMADO empiricamente em 04/08/2026 via test-moskit-put.js contra um deal de teste: o PUT com
// o corpo do GET de volta (padrao abaixo) FUNCIONA e preserva name/price/contacts/entityCustomFields
// — a duvida de corrigir-tipo-consulta.js estava desatualizada. Um PUT so com {stage:{id}} (payload
// minimo) e REJEITADO pelo Moskit com 422, nao apenas ignorado.
//
// `verificar(dealLido)` decide se a mudanca "pegou". O GET logo apos um PUT pode devolver dado velho
// por alguns segundos (confirmado no mesmo teste: uma espera de 1.5s ainda nao foi suficiente numa
// das rodadas) — por isso reconfere algumas vezes antes de declarar falha, em vez de arriscar um
// falso negativo numa automacao sem checkpoint humano. Retorna o deal lido na confirmacao.
// Mecanismo de retry compartilhado: GET repetido (1.5s/2s/3s) ate `verificar(deal)` bater, ou
// devolve o ultimo lido sem confirmar. Nao lanca — quem decide se isso e erro (e a mensagem) e o
// chamador, porque o que se verifica (stage/status escalar vs. array de entityCustomFields) e
// diferente em cada caso.
async function confirmarAposRetentativas(dealId, verificar, origem = 'BOT_WHATSAPP') {
  const esperasMs = [1500, 2000, 3000];
  let ultimoLido = null;
  for (const ms of esperasMs) {
    await new Promise((r) => setTimeout(r, ms));
    const conferir = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
    });
    ultimoLido = conferir.data;
    if (verificar(ultimoLido)) return { confirmado: true, deal: ultimoLido };
  }
  return { confirmado: false, deal: ultimoLido };
}

async function putDealComVerificacao(dealId, mudancas, verificar, origem = 'BOT_WHATSAPP') {
  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
  });
  const dealAtual = { ...getRes.data, ...mudancas };
  // O Moskit rejeita PUT cujo corpo traga status null ("Enum cannot be null"). Quando o GET vem sem
  // status, assume OPEN (o PUT aqui so acontece em operacoes de avancar/fechar — nunca reabre um
  // WON/LOST, e o status real de um deal em movimento no funil e OPEN).
  if (dealAtual.status === null || dealAtual.status === undefined || dealAtual.status === '') {
    dealAtual.status = STATUS_DEAL.OPEN;
  }
  await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, dealAtual, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
  });

  const { confirmado, deal } = await confirmarAposRetentativas(dealId, verificar, origem);
  if (!confirmado) {
    throw new Error(`Moskit aceitou o PUT no deal ${dealId} mas a mudanca nao se confirmou (mudancas: ${JSON.stringify(mudancas)}, lido: stage=${deal?.stage?.id} status=${deal?.status})`);
  }
  return deal;
}

async function moverParaEstagio(dealId, stageId) {
  await putDealComVerificacao(
    dealId,
    { stage: { id: stageId } },
    (deal) => Number(deal?.stage?.id) === Number(stageId)
  );
}

// So move o deal se for AVANCO no funil (nunca deixa voltar).
// Se FUNIL_DRY_RUN estiver ativo (padrao), so registra uma nota com a sugestao, sem mover de verdade.
async function moverEstagioSeAvancar(dealId, estagioKey) {
  const alvo = MOSKIT_STAGE_MAP[estagioKey];
  if (!alvo) return;

  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  const stageAtualId = getRes.data?.stage?.id;
  const atual = Object.values(MOSKIT_STAGE_MAP).find((s) => s.id === stageAtualId);

  if (atual && atual.priority >= alvo.priority) {
    console.log(`  ⏭️ estagio sugerido (${estagioKey}) nao avanca em relacao ao atual — ignorando`);
    return;
  }

  const nomeEstagio = estagioKey.replace(/_/g, ' ');
  if (FUNIL_DRY_RUN) {
    console.log(`  🤖 [dry-run] moveria deal ${dealId} para "${nomeEstagio}" — nao movido de verdade`);
    await criarNotaMoskit(dealId, `🤖 [dry-run] IA sugere mover para "${nomeEstagio}" (revisao manual necessaria — FUNIL_DRY_RUN ativo)`);
    return;
  }

  await moverParaEstagio(dealId, alvo.id);
  console.log(`  ➡️ Deal ${dealId} movido automaticamente para "${nomeEstagio}"`);
  await criarNotaMoskit(dealId, `➡️ Deal movido automaticamente para "${nomeEstagio}" com base na conversa`);
}

// Fecha o negocio como Ganho/Perdido — eixo DIFERENTE de moverEstagioSeAvancar: `status`, nao
// `stage` (confirmado em 04/08/2026 contra a API real: deal.status so aceita OPEN/WON/LOST, nao e
// mais um estagio na esteira). Nunca reabre nem refecha um deal que ja saiu de OPEN.
//
// So age se houver OBSERVACAO VALIDADA correspondente (nao um campo solto que o modelo preencheu) —
// mesmo espirito de pagamento_confirmado exigir comprovante em vez de confiar na alegacao pura,
// porque fechar ou perder um negocio errado nao tem volta facil no CRM.
async function fecharNegocioSeAplicavel(dealId, statusKey, motivoTexto, obsValidas, nomeCliente, telefone) {
  const evidencia = statusKey === 'ganho'
    ? ultimaObservacao(obsValidas, 'equipe_declarou_ganho')
    : (ultimaObservacao(obsValidas, 'equipe_declarou_perdido') || ultimaObservacao(obsValidas, 'cliente_declarou_perdido'));

  if (!evidencia) {
    console.log(`  ⏭️ status_negocio_sugerido "${statusKey}" sem observacao validada correspondente — ignorando`);
    return;
  }

  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  if (getRes.data?.status !== STATUS_DEAL.OPEN) {
    console.log(`  ⏭️ deal ${dealId} ja esta com status "${getRes.data?.status}" — nunca reabre/refecha`);
    return;
  }

  if (FUNIL_FECHAMENTO_DRY_RUN) {
    const quem = nomeCliente ? `"${nomeCliente}"${telefone ? ` (${telefone})` : ''}` : `deal ${dealId}`;
    console.log(`  🤖 [dry-run] fecharia ${quem} como "${statusKey}"${motivoTexto ? ` (motivo: ${motivoTexto})` : ''} — nao fechado de verdade`);
    await criarNotaMoskit(dealId, `🤖 [dry-run] IA sugere fechar negocio ${quem} como "${statusKey}"${motivoTexto ? ` — motivo: ${motivoTexto}` : ''} (revisao manual necessaria — FUNIL_FECHAMENTO_DRY_RUN ativo)`);
    await enviarTelegram([
      `🤖 *[dry-run] Fechamento sugerido*`,
      `Cliente: ${nomeCliente || 'nao informado'}${telefone ? ` (\`${telefone}\`)` : ''}`,
      `Deal: \`${dealId}\``,
      `Resultado sugerido: ${statusKey}`,
      motivoTexto ? `Motivo: ${motivoTexto}` : '',
      '',
      'Revisão manual é necessária — fechar no Moskit se confirmar.',
    ].filter(Boolean).join('\n'));
    return;
  }

  const closeDate = new Date().toISOString();

  if (statusKey === 'ganho') {
    // Best-effort: avanca pro estagio final mapeado antes de fechar, mas nao bloqueia o fechamento
    // se isso falhar — o status fechado e o sinal mais importante aqui, nao a posicao no funil.
    const estagioFinal = MOSKIT_STAGE_MAP.contrato_enviado;
    const atual = Object.values(MOSKIT_STAGE_MAP).find((s) => s.id === getRes.data?.stage?.id);
    if (estagioFinal && (!atual || atual.priority < estagioFinal.priority)) {
      try {
        await moverParaEstagio(dealId, estagioFinal.id);
      } catch (e) {
        console.error(`  ⚠️ nao consegui avancar deal ${dealId} pro estagio final antes de fechar como ganho: ${e.message}`);
      }
    }

    await putDealComVerificacao(
      dealId,
      { status: STATUS_DEAL.WON, closeDate },
      (deal) => deal?.status === STATUS_DEAL.WON
    );
    console.log(`  🏆 Deal ${dealId} fechado automaticamente como GANHO`);
    await criarNotaMoskit(dealId, '🏆 Negocio fechado automaticamente como GANHO, com base na conversa');
    await enviarTelegram(`🏆 *Negocio ganho!*\nDeal \`${dealId}\` fechado automaticamente com base na conversa.`);
    return;
  }

  // "perdido": nunca toca em stage — um lead pode ser perdido de qualquer estagio do funil.
  const idMotivo = buscarIdOpcao(LOST_REASON, motivoTexto) || LOST_REASON_PADRAO_ID;
  await putDealComVerificacao(
    dealId,
    { status: STATUS_DEAL.LOST, closeDate, lostReason: { id: idMotivo } },
    (deal) => deal?.status === STATUS_DEAL.LOST
  );
  console.log(`  💔 Deal ${dealId} fechado automaticamente como PERDIDO (motivo: ${motivoTexto || 'nao informado'})`);
  await criarNotaMoskit(dealId, `💔 Negocio fechado automaticamente como PERDIDO — motivo: ${motivoTexto || 'nao informado'}`);
  await enviarTelegram(`💔 *Negocio perdido*\nDeal \`${dealId}\` fechado automaticamente.\nMotivo: ${motivoTexto || 'nao informado'}`);
}

async function handlePagamentoConfirmado(dealId, dados, chatId) {
  if (!(dados.pagamento_confirmado === true || dados.pagamento_confirmado === 'true')) {
    return { verificadoPorComprovante: false };
  }

  const comprovante = chatId ? stmtComprovanteUltimo.get(chatId) : null;

  if (!comprovante) {
    // Cliente disse que pagou mas nunca enviou imagem verificavel — mantem comportamento antigo
    // (nao regredir casos legitimos de "ja paguei" sem foto), so deixando claro na nota.
    console.log(`  💳 Pagamento confirmado (sem comprovante verificado), movendo deal ${dealId} para Consulta Agendada...`);
    await moverParaEstagio(dealId, MOSKIT_STAGE_CONSULTA_AGENDADA);
    console.log(`  ✅ Deal ${dealId} movido para Consulta Agendada`);
    await criarNotaMoskit(dealId, `💳 Pagamento confirmado (sem comprovante verificado) — deal movido para Consulta Agendada`);
    return { verificadoPorComprovante: false };
  }

  stmtComprovanteSetDeal.run(dealId, comprovante.id);
  const valorFormatado = comprovante.valor_pago_centavos !== null ? `R$${(comprovante.valor_pago_centavos / 100).toFixed(2)}` : 'ilegível';

  if (comprovante.match) {
    console.log(`  💳 Comprovante confere (${valorFormatado}), movendo deal ${dealId} para Consulta Agendada...`);
    await moverParaEstagio(dealId, MOSKIT_STAGE_CONSULTA_AGENDADA);
    console.log(`  ✅ Deal ${dealId} movido para Consulta Agendada`);
    await criarNotaMoskit(dealId, `💳 Pagamento confirmado (comprovante verificado: ${valorFormatado}) — deal movido para Consulta Agendada`);
    return { verificadoPorComprovante: true };
  }

  console.log(`  ⚠️ Comprovante NAO confere (${valorFormatado}) — deal ${dealId} NAO movido, revisao manual necessaria`);
  await criarNotaMoskit(dealId, `⚠️ Comprovante recebido mas NÃO confere (valor lido: ${valorFormatado}) — revisão manual necessária, deal não movido`);
  return { verificadoPorComprovante: false };
}

// Decide se um deal ja pode virar evento/Meet no calendario. Duas portas:
//   1) comprovante verificado pela IA de visao (match = 1) — consulta paga
//   2) campo "Tipo de Consulta" do deal = "consulta gratis" no Moskit — cobre leads do Moskit
//      Boost / atividades marcadas na mao, que nunca passam pela verificacao via WhatsApp
// Campo em branco continua bloqueado (comportamento seguro de antes). Erro de leitura tambem:
// numa indisponibilidade do Moskit, "erro => tratar como gratis" viraria uma leva de agendamentos
// nao autorizados, entao sempre falha FECHADA.
// Usado por sincronizarAtividadesMoskit/backfillMeetLinks, que so tem o dealId (nao o chatId).
// Retorna { permitido, motivo, comprovante } — motivo: 'comprovante' | 'consulta_gratis' |
// 'aguardando' | 'sem_deal' | 'erro'.
async function autorizacaoParaAgendar(dealId) {
  if (!dealId) return { permitido: false, motivo: 'sem_deal', comprovante: null };

  // Caminho rapido: esse deal ja teve um comprovante vinculado por handlePagamentoConfirmado
  const porDeal = stmtComprovantePorDeal.get(dealId);
  if (porDeal) return { permitido: true, motivo: 'comprovante', comprovante: porDeal };

  try {
    const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (dealRes.status < 200 || dealRes.status >= 300) {
      console.error(`  ❌ GET /deals/${dealId} retornou ${dealRes.status} — tratando como NAO liberado`);
      return { permitido: false, motivo: 'erro', comprovante: null };
    }

    // Mesmo GET de sempre — aproveita a resposta pra ler o "Tipo de Consulta" antes de gastar
    // outra chamada buscando o contato/telefone.
    if (LIBERAR_CONSULTA_GRATIS && dealEhConsultaGratis(dealRes.data)) {
      return { permitido: true, motivo: 'consulta_gratis', comprovante: null };
    }

    // Fallback: acha o telefone do contato do deal e cruza com comprovantes por numero
    const contactId = dealRes.data?.contacts?.[0]?.id;
    if (!contactId) return { permitido: false, motivo: 'aguardando', comprovante: null };

    const contactRes = await axios.get(`${MOSKIT_BASE}/contacts/${contactId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const numero = contactRes.data?.phones?.[0]?.number;
    const digitos = String(numero || '').replace(/\D/g, '');
    if (digitos.length < 8) return { permitido: false, motivo: 'aguardando', comprovante: null }; // evita match vazio/curto (mesmo bug corrigido em buscarOuCriarContato)

    const sufixo = digitos.slice(-8);
    const comprovante = stmtComprovantePorSufixoTelefone.get(sufixo, sufixo) || null;
    return {
      permitido: !!comprovante,
      motivo: comprovante ? 'comprovante' : 'aguardando',
      comprovante,
    };
  } catch (e) {
    console.error(`  ❌ Erro ao avaliar liberacao do deal ${dealId}: ${e.message}`);
    return { permitido: false, motivo: 'erro', comprovante: null };
  }
}

// Titulo e descricao do evento ficam aqui pra que a criacao e a correcao posterior
// (sincronizarMetadadosEvento) usem exatamente a mesma regra.
function montarResumoEvento(dados) {
  const presencial = dados.modalidade_consulta === 'presencial';
  return `Consulta${presencial ? ' (Presencial)' : ''} — ${dados.nome || 'Cliente'} (${dados.advogado_responsavel || 'a definir'})`;
}

function montarDescricaoEvento(dados, chatId) {
  return [
    `Assunto: ${dados.assunto || 'nao informado'}`,
    `Telefone: ${chatId}`,
    dados.email_cliente ? `Email do cliente: ${dados.email_cliente}` : '',
    dados.resumo_atendimento || '',
  ].filter(Boolean).join('\n');
}

// Corrige titulo/descricao de um evento ja criado quando os dados melhoraram depois — tipico do
// evento que nasceu com "(a definir)" porque o ciclo que o criou nao tinha o advogado ainda.
// Nao mexe em data/hora, entao nao exige confirmacao (diferente de remarcar).
async function sincronizarMetadadosEvento(dados, chatId, row) {
  const auth = getGoogleAuthClient();
  if (!auth) return;

  const novoResumo = montarResumoEvento(dados);
  const novaDescricao = montarDescricaoEvento(dados, chatId);
  if (novoResumo.includes('(a definir)')) return; // ainda nao sabemos o advogado — nao piora o que esta la

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const atual = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });
    if (atual.data.summary === novoResumo && atual.data.description === novaDescricao) return;

    await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.evento_calendar_id,
      requestBody: { summary: novoResumo, description: novaDescricao },
    });
    console.log(`  ✏️ Evento do chat ${chatId} atualizado: "${novoResumo}"`);
  } catch (e) {
    console.error(`  ❌ Erro ao atualizar titulo/descricao do evento: ${e.message}`);
  }
}

async function criarEventoGoogleCalendar(dados, chatId) {
  const auth = getGoogleAuthClient();
  if (!auth) {
    console.log('  ⏭️ Google Calendar nao configurado (faltam google-oauth-client.json/google-oauth-token.json/GOOGLE_CALENDAR_ID) — pulando');
    return null;
  }

  const inicio = new Date(dados.data_hora_consulta);
  if (isNaN(inicio.getTime())) {
    console.log(`  ⚠️ data_hora_consulta invalida: "${dados.data_hora_consulta}" — pulando criacao do evento`);
    return null;
  }
  const fim = new Date(inicio.getTime() + 60 * 60 * 1000); // duracao media de 1h
  const presencial = dados.modalidade_consulta === 'presencial';

  const calendar = google.calendar({ version: 'v3', auth });
  const event = {
    summary: montarResumoEvento(dados),
    description: montarDescricaoEvento(dados, chatId),
    start: { dateTime: inicio.toISOString() },
    end: { dateTime: fim.toISOString() },
    ...(presencial ? {} : {
      conferenceData: {
        createRequest: {
          requestId: `meet-${chatId}-${inicio.getTime()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
    ...(dados.email_cliente ? { attendees: [{ email: dados.email_cliente }] } : {}),
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
    conferenceDataVersion: 1,
    sendUpdates: dados.email_cliente ? 'all' : undefined,
  });

  console.log(`  📅 Evento criado no Google Calendar: ${res.data.htmlLink}`);
  return res.data;
}

// DUPLA CONFIRMACAO: o evento so nasce quando o cliente aceitou E a equipe confirmou o MESMO horario.
// `apuracao` vem de apurarDuplaConfirmacao() sobre observacoes ja validadas contra as mensagens reais
// (src/evidencia.js), entao cada perna esta amarrada a uma mensagem com o role correto — o modelo nao
// consegue mais simplesmente afirmar que houve confirmacao.
//
// O horario agendado e o das observacoes, nao o `dados.data_hora_consulta`: e o horario que as duas
// partes concordaram nesta rodada, e nao herda valor antigo via mergeDados.
async function handleAgendamentoCalendar(dealId, dados, chatId, pagamentoVerificado, row, apuracao) {
  const podeAgendar = !!apuracao?.confirmado;
  const dadosEvento = podeAgendar
    ? { ...dados, data_hora_consulta: apuracao.horarioIso }
    : dados;

  if (row?.evento_calendar_criado) {
    if (!row?.evento_calendar_id) {
      console.log(`  ⚠️ Chat ${chatId} ja tem evento_calendar_criado=1 mas sem evento_calendar_id salvo (conversa anterior a essa correcao) — nao da pra atualizar automaticamente, revisar manualmente se precisar remarcar`);
      return;
    }
    // Corrigir titulo/descricao nao move nada, entao roda sempre — inclusive quando a remarcacao
    // esta travada por falta de confirmacao.
    if (dados.data_hora_consulta) await sincronizarMetadadosEvento(dados, chatId, row);

    // Remarcar uma reuniao ja marcada exige o MESMO criterio de criar. Sem essa trava, qualquer
    // data extraida movia a reuniao de um cliente real — inclusive um horario que a equipe apenas
    // PROPOS e o cliente nunca respondeu.
    if (!podeAgendar) {
      // So anota se houver horario em jogo. Sem isso, toda conversa ja agendada geraria uma nota de
      // "nao remarcada" a cada ciclo, mesmo quando ninguem falou de horario nenhum.
      if (apuracao?.cliente || apuracao?.equipe) {
        console.log(`  ⏭️ deal ${dealId}: reuniao NAO remarcada — ${descreverPendencia(apuracao)}`);
        await registrarAgendamentoPendente(dealId, chatId, apuracao, true);
      }
      return;
    }
    await atualizarEventoSeRemarcado(dealId, dadosEvento, chatId, row);
    // Evento ja existia e a dupla confirmacao continua valida — o deal tem consulta marcada de
    // verdade. "consulta_agendada" fica orfa desde que foi mapeada (MOSKIT_STAGE_MAP): a IA nunca
    // sugere esse estagio (estagio_funil_sugerido so cobre o que vem DEPOIS da consulta), entao sem
    // esta chamada nenhum deal chegava la. So avanca (nunca volta, ver moverEstagioSeAvancar).
    await moverEstagioSeAvancar(dealId, 'consulta_agendada');
    return;
  }

  if (!podeAgendar) {
    // So vale anotar quando existe algum horario em jogo — conversa que nem chegou a falar de data
    // nao e "pendencia", e so uma conversa em andamento.
    if (apuracao?.cliente || apuracao?.equipe || dados.data_hora_consulta) {
      console.log(`  ⏭️ deal ${dealId}: evento NAO criado — ${descreverPendencia(apuracao || { motivo: 'falta_ambos' })}`);
      await registrarAgendamentoPendente(dealId, chatId, apuracao, false);
    }
    return;
  }

  try {
    const evento = await criarEventoGoogleCalendar(dadosEvento, chatId);
    if (!evento) return;
    db.prepare('UPDATE conversations SET evento_calendar_criado = 1, evento_calendar_id = ?, evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(evento.id, apuracao.horarioIso, chatId);
    const dataFormatada = new Date(apuracao.horarioIso).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });
    const meetLink = extrairMeetLink(evento);
    const notaComprovante = pagamentoVerificado ? ' (comprovante verificado)' : ' ⚠️ SEM comprovante verificado';
    const evidencia = `\nCliente aceitou: "${apuracao.cliente.trecho}" · Equipe confirmou: "${apuracao.equipe.trecho}"`;
    await criarNotaMoskit(dealId, `📅 Reunião agendada no Google Calendar: ${dataFormatada}${notaComprovante}${evidencia}${meetLink ? `\nLink do Meet: ${meetLink}` : ''}`);
    await notificarTelegramMeet({
      nome: dados.nome,
      telefone: chatId,
      advogado: dados.advogado_responsavel,
      dataHoraTexto: dataFormatada,
      meetLink,
      dealId,
    });
  } catch (e) {
    console.error(`  ❌ Erro ao criar evento no Google Calendar: ${e.message}`);
    // Ate aqui, so o console sabia disso. A dupla confirmacao JA aconteceu (cliente + equipe) —
    // sem essa nota, a falha (token expirado, rede, quota da API) fica invisivel pro escritorio.
    await registrarErroAgendamento(dealId, chatId, e.message, false);
    return; // sem isso, o avanco de estagio abaixo rodaria mesmo com o evento falhando
  }
  // Evento criado com sucesso agora — mesmo raciocinio do outro ramo (evento que ja existia):
  // avanca pra "consulta_agendada" se ainda nao passou desse ponto.
  await moverEstagioSeAvancar(dealId, 'consulta_agendada');
}

// Nota no deal quando ha horario em jogo mas o agendamento esta travado. O hash evita repetir a mesma
// nota a cada ciclo de 5 min enquanto a situacao nao muda.
async function registrarAgendamentoPendente(dealId, chatId, apuracao, remarcacao) {
  if (!dealId) return;
  const motivo = apuracao?.motivo || 'falta_ambos';
  const horario = apuracao?.equipe?.horario_iso || apuracao?.cliente?.horario_iso || null;
  const hash = `${horario}|${motivo}|${remarcacao ? 'R' : 'C'}`;

  const atual = db.prepare('SELECT agendamento_pendente_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.agendamento_pendente_hash === hash) return;

  const quando = horario
    ? new Date(horario).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO })
    : 'horário ainda não definido';
  const acao = remarcacao ? 'Reunião NÃO remarcada' : 'Consulta NÃO lançada na agenda';
  try {
    await criarNotaMoskit(dealId, `⏳ ${acao}: ${quando} — ${descreverPendencia({ motivo })}. O evento é criado quando as duas confirmações aparecerem na conversa.`);
    db.prepare('UPDATE conversations SET agendamento_pendente_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar pendencia de agendamento no deal ${dealId}: ${e.message}`);
  }
}

// Nota no deal quando a dupla confirmacao ACONTECEU mas a criacao/remarcacao do evento FALHOU de
// verdade (token do Google expirado, erro de rede, quota da API, etc). Ate esta funcao existir,
// esse caminho so gerava um console.error — a equipe nao tinha nenhum jeito de saber, pelo CRM, que
// uma consulta ja confirmada pelas duas partes nao foi pra agenda. O hash evita repetir a mesma nota
// de erro a cada ciclo de 5 min enquanto a causa nao for corrigida (ex: token continuar expirado).
async function registrarErroAgendamento(dealId, chatId, mensagemErro, remarcacao) {
  if (!dealId) return;
  const hash = `${mensagemErro}|${remarcacao ? 'R' : 'C'}`;

  const atual = db.prepare('SELECT agendamento_erro_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.agendamento_erro_hash === hash) return;

  const acao = remarcacao ? 'reunião NÃO remarcada' : 'evento NÃO criado';
  try {
    await criarNotaMoskit(
      dealId,
      `❌ Falha ao agendar: ${acao} — cliente e equipe já confirmaram o horário, mas a integração com o Google Calendar falhou (${mensagemErro}). Verificar manualmente e, se for token expirado, renovar com autorizar-google.js.`
    );
    db.prepare('UPDATE conversations SET agendamento_erro_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar FALHA de agendamento no deal ${dealId}: ${e.message}`);
  }
}

// Se o cliente pediu pra remarcar (nova data_hora_consulta diferente da ja salva no evento),
// atualiza o evento existente (so start/end, preserva o link do Meet) em vez de ignorar a mudanca.
async function atualizarEventoSeRemarcado(dealId, dados, chatId, row) {
  const auth = getGoogleAuthClient();
  if (!auth) return;

  const novoInicio = new Date(dados.data_hora_consulta);
  if (isNaN(novoInicio.getTime())) return;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const eventoAtual = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });
    const inicioAtual = new Date(eventoAtual.data.start?.dateTime || eventoAtual.data.start?.date);

    if (Math.abs(novoInicio.getTime() - inicioAtual.getTime()) < 60 * 1000) return; // nao mudou de verdade, evita ruido a cada ciclo

    const novoFim = new Date(novoInicio.getTime() + 60 * 60 * 1000);
    const patched = await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.evento_calendar_id,
      requestBody: {
        start: { dateTime: novoInicio.toISOString() },
        end: { dateTime: novoFim.toISOString() },
      },
    });

    db.prepare('UPDATE conversations SET evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(dados.data_hora_consulta, chatId);

    const dataFormatada = novoInicio.toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });
    const meetLink = extrairMeetLink(patched.data);
    console.log(`  🔁 Reunião remarcada para ${dataFormatada} (chat ${chatId})`);

    await criarNotaMoskit(dealId, `🔁 Reunião remarcada para ${dataFormatada}${meetLink ? `\nLink do Meet (o mesmo de antes): ${meetLink}` : ''}`);
    await notificarTelegramMeet({
      nome: dados.nome,
      telefone: chatId,
      advogado: dados.advogado_responsavel,
      dataHoraTexto: dataFormatada,
      meetLink,
      dealId,
      remarcado: true,
    });
  } catch (e) {
    console.error(`  ❌ Erro ao tentar remarcar evento do chat ${chatId}: ${e.message}`);
    // Mesma logica do erro em criarEventoGoogleCalendar: a remarcacao so chega aqui quando a dupla
    // confirmacao ja aconteceu (podeAgendar=true) — sem nota, a equipe nao sabe que o novo horario
    // nao foi pra agenda e o cliente pode aparecer no horario velho.
    await registrarErroAgendamento(dealId, chatId, e.message, true);
  }
}

// ------------------------------------------------------------
// OpenAI
// ------------------------------------------------------------
const PROMPT_CLASSIFICAR = `
Analise a conversa de WhatsApp e classifique o lead.

CONTEXTO DO CRM: {contextoCrm}

Raciocine passo a passo:
1. O lead demonstrou interesse em contratar servicos juridicos?
2. Ha evidencias de que ele quer agendar ou ja agendou consulta?
3. A conversa parece genuina ou e automatica/spam/numero errado/interna?
4. O lead ja e cliente existente apenas atualizando algo?

Apos raciocinar, retorne APENAS um JSON:
{"classificacao": "criar_negocio", "justificativa": "motivo"}
OU
{"classificacao": "inviavel", "justificativa": "motivo"}

"criar_negocio": lead demonstrou interesse real em contratar. Fez perguntas sobre servicos/honorarios, agendou consulta, explicou o caso juridico. Exemplos abaixo.

"inviavel":
- Spam ou mensagem automatica (ex: "Seu horario foi confirmado")
- Numero errado ("quem e?", "enganou")
- Cliente existente apenas avisando que esta a caminho ou que chegou ("Chego ja na clinica", "Cheguei")
  ATENCAO: isso NAO vale quando o CONTEXTO DO CRM diz que ja existe negocio ou consulta em andamento
  E o cliente esta ACEITANDO ou ALTERANDO um horario ("pode ser", "confirmado", "prefiro sexta").
  Nesse caso classifique "criar_negocio": e exatamente essa mensagem que fecha o agendamento, e
  descarta-la deixa a consulta travada sem a confirmacao do cliente.
- Membro da equipe falando de trabalho interno ("Passa pra Layla", "cria tarefa no astrea")
- Lead dizendo "ja resolvi", "obrigado" sem contexto
- Conversa muito curta/sem contexto (1 msg generica)

EXEMPLOS REAIS:

--- criar_negocio ---
Cliente: "Ola, acessei o site do escritorio e gostaria de uma consulta."
Cliente: "Meu nome e Carlos Eduardo. E sobre meu tio que morreu e deixou uma casa mas ele nao fez testamento e os irmao ta querendo vender sem eu receber nada. Vi o Instagram do Bruno, ele parece entender bem dessas coisas de familia."
Resposta: {"classificacao": "criar_negocio", "justificativa": "lead explicou o caso juridico, mencionou origem (Site + Instagram do Bruno) e pediu consulta"}

--- criar_negocio ---
Cliente: "Cliquei no link da bio no Instagram do Dr. Berto Caballero, gostaria de tratar sobre meu caso. Trabalho no programa mais medicos e tenho 32 meses de atuacao. Estou com um processo sobre abatimento da divida do FIES."
Resposta: {"classificacao": "criar_negocio", "justificativa": "lead veio pelo Instagram do Berto, explicou o caso juridico especifico e demonstrou interesse em contratar"}

--- inviavel (membro da equipe) ---
Cliente: "Passa pra Layla. Rayane, temos que cobrar um valor da Teresinha (despejo). Me lembra amanha."
Cliente: "Pode marcar. Pede logo os contratos e documentos que ele pode enviar."
Resposta: {"classificacao": "inviavel", "justificativa": "conversa interna da equipe do escritorio, nao e um lead"}

--- inviavel (socio/equipe — contato interno) ---
Cliente: "Ola Dr. Berto Igor Caballero (8694231397), so comunicando que o processo da Ana Clara ja esta pronto."
Cliente: "Pode deixar que eu mesmo aviso ela."
Resposta: {"classificacao": "inviavel", "justificativa": "remetente e socio do escritorio falando sobre trabalho interno"}

--- inviavel (cliente existente) ---
Cliente: "Chego ja na clinica"
Cliente: "Estou a caminho"
Cliente: "Ok"
Cliente: "Cheguei"
Resposta: {"classificacao": "inviavel", "justificativa": "cliente existente apenas confirmando horario de consulta, nao e lead novo"}

--- inviavel (sem interesse) ---
Cliente: "Obrigado."
Resposta: {"classificacao": "inviavel", "justificativa": "mensagem generica de agradecimento, sem contexto ou interesse"}

Conversa:
{historico}
`;

const PROMPT_EXTRAIR = `
Analise a conversa completa e extraia dados para criar/atualizar um negocio no CRM. Retorne APENAS um JSON valido.

Raciocine passo a passo antes de responder:
1. Esta conversa ja tem um deal no CRM? Se sim, quais campos estao pendentes?
2. Quais campos obrigatorios consigo identificar com confianca?
3. ATENCAO: advogado_responsavel eh DEFINIDO pela area_direito, NAO por qual socio o lead mencionou.
4. O lead fez pagamento ou enviou comprovante?
5. Qual acao e mais adequada?

CONTEXTO ATUAL:
- Data/hora da ultima mensagem desta conversa: {dataAtual}
- CALENDARIO DE REFERENCIA (consulte esta tabela, NUNCA calcule datas de cabeca):
{calendarioReferencia}
- Deal ja existe no CRM: {temDeal}
- Dados ja extraidos anteriormente: {dadosAnteriores}
- Cliente ja existe no CRM: {infoCliente}

REGRAS DE DECISAO:
- "criar": lead DEMONSTROU interesse + agendou consulta. Crie o deal com TODOS os campos obrigatorios preenchidos e nota com resumo.
- "aguardar": lead NAO marcou/confirmou consulta. So explicando o caso. Nao criar nada.
- "nota": deal JA EXISTE + todos os campos ok. So adicione nota.
- "atualizar_campos": deal EXISTE + algum campo pendente. Devolva o que identificou AGORA e TAMBEM os campos listados como "AINDA PENDENTES" no contexto, se a conversa inteira permitir preenche-los. Nao repita campos que ja estao preenchidos e corretos.
- "ignorar": passou pela classificacao mas nao foi possivel extrair informacoes uteis. Ignorar permanentemente.

CAMPOS OBRIGATORIOS (nunca podem ser null em criar):
1. assunto — tema curto do caso, 2 a 5 palavras (ex: "Inventario", "Usucapiao de imovel", "Abatimento do FIES", "Rescisao de contrato"). E o que aparece no titulo do negocio no CRM, entao seja especifico e direto, sem frase completa. NUNCA deixe null: se o caso ainda estiver vago, use a propria area_direito como assunto.
2. origem — SEMPRE preencher. Extraia da mensagem inicial. Se nao encontrar, use "Nao identificado".
3. tipo_consulta — "consulta paga" por padrao. Use "consulta gratis" APENAS se a equipe disser explicitamente que a consulta e cortesia/gratuita/sem custo/isenta. Use "sem consulta" so se o lead disser EXPLICITAMENTE que nao quer contratar.
4. area_direito — Use seu conhecimento juridico para inferir pela conversa.
5. advogado_responsavel — Determinado UNICAMENTE pela area_direito. Se area_direito estiver clara, use os PERFIS para definir. Se area_direito estiver null ou incerta, mantenha null. NAO derive do nome do lead ou de qual socio ele mencionou.
6. captacao — Se mencionou rede social de Berto, Bruno ou Iury, ou foi indicado por um deles, preencha com o nome do socio (INDEPENDENTE de area_direito estar definida). CASO CONTRARIO, preencha com o MESMO valor de advogado_responsavel (que pode ser null se area_direito nao identificada).
7. pagamento_confirmado — boolean. True APENAS se DISSE que pagou OU enviou comprovante. Senao false.

CAMPOS OPCIONAIS (usados pra agendar a reuniao no Google Agenda — deixe null se nao tiver certeza):
8. data_hora_consulta — data/hora ISO 8601 (ex: "2026-07-31T10:00:00") que o cliente CONFIRMOU pra consulta, OU que a equipe do escritorio confirmou ter marcado com o cliente (mensagem "Equipe do escritório:"). Use "Data/hora da ultima mensagem desta conversa" (fornecida no CONTEXTO ATUAL) como referencia (data-ancora) pra resolver dias relativos tipo "sexta de manha", "amanha as 10h", "dia 9 de janeiro" — NUNCA invente uma data se nem o cliente nem a equipe confirmaram um dia/horario especifico. Se so disse "pode ser" sem dia/horario, ou se ainda esta negociando, deixe null.
   SEMPRE RECALCULE: derive a data da CONVERSA + tabela CALENDARIO DE REFERENCIA a cada rodada. NUNCA copie o data_hora_consulta que aparece em "Dados ja extraidos anteriormente" — esse valor pode ter sido calculado errado antes. Se o que voce derivar agora divergir do valor anterior, use o que voce derivou agora.
   ATENCAO AO DIA DA SEMANA: se a conversa citar um dia pelo NOME ("quarta-feira", "na sexta") sem dizer o numero do dia, procure esse dia na tabela CALENDARIO DE REFERENCIA e use a PRIMEIRA ocorrencia DEPOIS da data-ancora. NUNCA calcule de cabeca. Se o dia citado for o mesmo dia da semana da data-ancora, use a ocorrencia da semana seguinte, a nao ser que a mensagem diga "hoje". Exemplo: data-ancora 2026-07-30 (quinta-feira), mensagem diz "quarta-feira" -> a tabela mostra 2026-08-05 = quarta-feira -> use 2026-08-05, NUNCA 2026-08-03.
   ATENCAO A PROPOSTA SEM RESPOSTA: se a ultima mensagem sobre horario for uma PROPOSTA da equipe que o cliente ainda nao aceitou (ex: "Podemos marcar na quarta as 17:30?" e nenhuma resposta depois), NAO troque a data — mantenha o horario ANTERIOR ja confirmado, ou null se nunca houve um.
   ATENCAO AO ANO: o resultado tem que ser uma data no FUTURO em relacao a data-ancora. Se o cliente mencionar so dia e mes (ex: "dia 9 de janeiro", "15 de marco") sem dizer o ano, calcule: se essa data (dia+mes) no ANO da data-ancora ja passou ou eh igual a data-ancora, use o ANO SEGUINTE. Exemplo: data-ancora 2026-07-24, cliente diz "dia 9 de janeiro" → 09/01 no ano 2026 ja passou → use 2027-01-09, NUNCA 2026-01-09.
9. email_cliente — email do cliente, APENAS se ele literalmente escreveu um email na conversa. Nunca invente ou derive de outro campo.
10. estagio_funil_sugerido — analise a conversa (incluindo mensagens "Equipe do escritório:") e identifique se houve avanco no funil de vendas alem da consulta paga/agendada. Use null se nao houver sinal claro. Valores possiveis:
   - "aguardando_condicao": a consulta ja aconteceu (equipe ou cliente mencionam que a reuniao/consulta ja ocorreu) e agora esta aguardando retorno/decisao do cliente.
   - "elaboracao_proposta": equipe menciona que vai preparar/enviar uma Proposta de Honorarios pro cliente.
   - "negociacao": cliente reage a proposta discutindo condicoes, valores ou prazos de pagamento dos honorarios.
   - "elaboracao_contrato": condicoes foram fechadas/aceitas e a equipe menciona que vai preparar o contrato.
   - "contrato_enviado": equipe confirma que o contrato foi enviado pro cliente.
   Seja conservador: so sugira um estagio se houver uma frase clara indicando esse avanco. Na duvida, deixe null.
11. modalidade_consulta — "presencial" ou "online". Como a consulta sera realizada, se isso foi mencionado na conversa (ex: cliente ou equipe dizem "presencial", "no escritorio", "pessoalmente" → presencial; "por video", "online", "por chamada" → online). Se nao houver nenhuma indicacao clara, use "online" (padrao — gera link de Google Meet). So use "presencial" se estiver EXPLICITO que sera sem video-chamada.
12. status_negocio_sugerido — null, "ganho" ou "perdido". Eixo DIFERENTE de estagio_funil_sugerido: nao e posicao no funil, e o FECHAMENTO do negocio (o CRM nao deixa reabrir depois). Use APENAS com frase explicita e inequivoca:
   - "ganho": a EQUIPE confirma que o cliente ASSINOU o contrato e o caso esta fechado/o cliente virou cliente ativo do escritorio. "contrato enviado" ou "vamos fechar" NAO bastam — isso e so contrato_enviado.
   - "perdido": a EQUIPE ou o CLIENTE confirmam explicitamente que o negocio NAO vai adiante (cliente desistiu do processo, contratou outro escritorio, recusou a proposta definitivamente, nao quis pagar a consulta).
   Seja MAIS conservador aqui do que em qualquer outro campo: fechar ou perder um negocio errado nao tem volta facil no CRM. Na menor duvida, deixe null.
13. motivo_perda_sugerido — SO preencha se status_negocio_sugerido = "perdido". Frase curta com o motivo, nas palavras da conversa (ex: "fechou com outro escritorio", "achou o valor alto", "desistiu do processo"). Null se status_negocio_sugerido nao for "perdido", ou se nao houver motivo claro.

OBSERVACOES (obrigatorio — array "observacoes" no nivel raiz do JSON):
Cada linha da conversa comeca com um indice entre colchetes, tipo "[12] Cliente: ...". Relate os fatos abaixo CITANDO o indice da mensagem que prova cada um. O sistema confere a citacao: se o indice nao existir, se o papel de quem falou nao bater com o tipo, ou se o trecho nao aparecer mesmo na mensagem, a observacao e DESCARTADA. Nao invente citacao — observacao descartada e pior que observacao ausente.

Formato de cada item: {"tipo": "...", "msg_idx": 12, "trecho": "pedaco literal da mensagem", "horario_iso": "2026-08-05T17:30:00"}
O campo "trecho" tem que ser copiado LITERALMENTE da mensagem citada (pode ser um pedaco curto dela).
O campo "horario_iso" e OBRIGATORIO em todo tipo que termina em "_horario" — sempre preencha, nunca deixe de fora e nunca escreva texto tipo "quarta que vem". Se a mensagem nao repete o dia/hora (ex: cliente so respondeu "pode ser"), use o horario da proposta a que ela responde.

REGRA DE PAPEL (a que mais causa observacao descartada): o prefixo do tipo tem que bater com o rotulo da linha citada. Linha "[7] Cliente: ..." so aceita tipo comecando com "cliente_". Linha "[7] Equipe do escritório: ..." so aceita tipo comecando com "equipe_". Antes de escrever cada observacao, olhe o rotulo daquele indice e escolha o prefixo por ele — nao pelo conteudo da frase. Um cliente dizendo "consigo sexta as 14h" e "cliente_propos_horario", nunca "equipe_propos_horario".

Tipos permitidos:
- "equipe_anunciou_valor" (mensagem da EQUIPE) — a equipe informou que a consulta tem custo, em qualquer formato: o bloco padrao de condicoes, "a consulta e 350", "o investimento e de trezentos e cinquenta", valor negociado diferente, parcelamento. Sem horario_iso.
- "equipe_propos_horario" (mensagem da EQUIPE) — a equipe SUGERIU um dia/hora, sem fechar ("podemos quarta as 17:30?").
- "equipe_confirmou_horario" (mensagem da EQUIPE) — a equipe afirmou que a consulta ESTA marcada ("marquei sua consulta pra sexta 14h", "ficou confirmado dia 10 as 15h"). Uma PERGUNTA nunca e confirmacao.
- "cliente_propos_horario" (mensagem do CLIENTE) — o cliente sugeriu um dia/hora ("consigo sexta as 14h").
- "cliente_aceitou_horario" (mensagem do CLIENTE) — o cliente ACEITOU explicitamente um dia/hora ja falado ("pode ser", "confirmado", "ok", "fechado", "estarei la"). "vou ver", "te aviso", "acho que sim" NAO sao aceite.
- "cliente_alegou_pagamento" (mensagem do CLIENTE) — o cliente disse que pagou ou enviou comprovante.
- "equipe_declarou_ganho" (mensagem da EQUIPE) — a equipe confirma que o contrato foi ASSINADO e o cliente virou cliente do escritorio ("assinou o contrato", "fechamos com o cliente", "cliente confirmado, vamos iniciar o processo"). Sem horario_iso.
- "equipe_declarou_perdido" (mensagem da EQUIPE) — a equipe confirma que o negocio NAO vai adiante ("cliente desistiu", "nao vamos seguir com esse caso", "ele fechou com outro escritorio"). Sem horario_iso.
- "cliente_declarou_perdido" (mensagem do CLIENTE) — o cliente diz explicitamente que nao vai contratar/seguir ("vou contratar outro advogado", "desisti do processo", "nao quero mais fechar"). Sem horario_iso.

Regras de horario nas observacoes:
- Resolva o horario_iso com a mesma tabela CALENDARIO DE REFERENCIA usada em data_hora_consulta, e com as mesmas regras de dia da semana e de ano.
- Se o cliente aceitou uma proposta sem repetir o dia/hora ("pode ser"), use o horario da proposta a que ele respondeu.
- Relate TODAS as ocorrencias, inclusive as antigas e as que se contradizem. O sistema usa a mais recente de cada tipo e sabe detectar sozinho que uma proposta nova reabriu a negociacao — nao tente filtrar nem resumir isso voce.
- REGRA CRITICA: percorra a conversa DE TRAS PRA FRENTE e garanta que a ULTIMA mensagem que menciona dia/hora esteja na lista, seja ela do cliente ou da equipe. Vale mesmo que ela desmarque, adie ou troque um horario que ja estava confirmado antes ("surgiu um imprevisto, consegue na sexta as 16h?"). Omitir essa mensagem faz o sistema agendar num horario que ja foi abandonado — e o pior erro possivel aqui.
- So agendamos na agenda quando o CLIENTE aceitou E a EQUIPE confirmou o MESMO horario. Se so um dos dois falou, relate so o que existe; nao complete o que falta.

INSTRUCOES PARA resumo_atendimento (briefing pre-consulta do advogado):
Escreva um resumo ESPECIFICO e ACIONAVEL, nao generico. Use os fatos concretos que aparecem na conversa: nomes de pessoas ou empresas envolvidas, datas, valores, numero de processo, tipo de documento, prazos. Evite frases vagas tipo "cliente quer analise do caso" — prefira algo como "cliente foi notificado pela ANPD em 15/03 sobre vazamento de dados de clientes e quer saber se pode ser responsabilizado".
Estruture em 4 linhas (uma por topico, com quebra de linha \n entre elas — NAO use "|"):
📌 Caso: [o que aconteceu, com os detalhes concretos disponiveis — partes envolvidas, datas, valores, documentos]
📌 Objetivo do cliente: [o que especificamente ele quer resolver, saber ou contratar]
📌 Urgencia/prazo: [prazo, audiencia, notificacao ou data mencionada — se nao houver, escreva "Nao mencionado"]
📌 Ja tentou: [acoes anteriores mencionadas pelo cliente — se nao houver, escreva "Nada mencionado"]
Se a conversa nao tiver detalhe suficiente pra algum topico, escreva "Nao mencionado" em vez de inventar ou generalizar.

EXEMPLOS REAIS DE CAPTACAO:
- "Instagram do Bruno" + area=Familia → origem: Instagram, captacao: Bruno, adv_resp: Bruno
- "link da bio no Instagram do Dr. Berto" + area=Educacional → origem: Instagram, captacao: Berto, adv_resp: Berto
- "vi a pagina do Bruno" + sem caso descrito → origem: Instagram, captacao: Bruno, adv_resp: null (sem area definida)
- "acessei o site do escritorio" + sem mencao a socio → origem: Site, captacao: [mesmo adv_resp, ou null se adv null]
- "minha prima falou, ela e amiga do escritorio" → origem: Indicacao de amigos e parentes, captacao: [mesmo adv_resp]

Formato de resposta (use dados reais extraidos, nao descricoes):
{
  "acao": "criar",
  "justificativa": "Lead agendou consulta sobre inventario",
  "confianca": 8,
  "observacoes": [
    {"tipo": "equipe_anunciou_valor", "msg_idx": 4, "trecho": "O valor da consulta é de R$350,00"},
    {"tipo": "equipe_propos_horario", "msg_idx": 7, "trecho": "podemos marcar na quarta às 17:30", "horario_iso": "2026-08-05T17:30:00"},
    {"tipo": "cliente_aceitou_horario", "msg_idx": 8, "trecho": "pode ser", "horario_iso": "2026-08-05T17:30:00"},
    {"tipo": "equipe_confirmou_horario", "msg_idx": 9, "trecho": "marquei sua consulta", "horario_iso": "2026-08-05T17:30:00"}
  ],
  "dados": {
    "nome": "Carlos Eduardo",
    "assunto": "Inventario",
    "origem": "Site",
    "advogado_responsavel": "Bruno",
    "captacao": "Bruno",
    "tipo_consulta": "consulta paga",
    "area_direito": "Direito de Familia",
    "pagamento_confirmado": false,
    "data_hora_consulta": "2026-08-05T17:30:00",
    "email_cliente": null,
    "estagio_funil_sugerido": null,
    "modalidade_consulta": "online",
    "status_negocio_sugerido": null,
    "motivo_perda_sugerido": null,
    "resumo_atendimento": "📌 Caso: pai do cliente faleceu ha 3 meses e deixou uma casa; os dois irmaos querem vender o imovel sem repassar a parte do cliente na heranca.\n📌 Objetivo do cliente: entender seus direitos no inventario e formalizar a partilha antes que os irmaos vendam a casa.\n📌 Urgencia/prazo: Nao mencionado.\n📌 Ja tentou: Nada mencionado."
  }
}

Valores permitidos:
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto (Administrativo/Digital), Bruno (Imobiliario/Familia), Iury (Solucoes Medicas)

PERFIS DOS ADVOGADOS:
1. Berto Caballero — Direito Digital (LGPD, crimes digitais, propriedade intelectual) e Direito Administrativo (licitacoes, servidores publicos, concurseiros).
2. Bruno Rocha — Direito Imobiliario (compra/venda, locacao, usucapiao, reintegracao) e Direito de Familia (divorcio, guarda, alimentos, inventario).
3. Iury Carvalho — Solucoes Medicas (defesa de profissionais da saude, erro medico, planos de saude).

Conversa completa:
{historico}
`;

async function classificarConversa(historico, contextoCrm) {
  const prompt = PROMPT_CLASSIFICAR
    .replace('{contextoCrm}', contextoCrm || 'nenhum negocio nem consulta registrados para este contato')
    .replace('{historico}', historico);
  const conteudo = await openaiChat([
    { role: 'system', content: 'Voce e um assistente juridico especializado em qualificacao de leads para escritorio de advocacia. Analise conversas de WhatsApp e decida objetivamente se o lead tem potencial de contratar ou nao. Seja rigoroso: apenas leads com intencao real devem ser classificados como criar_negocio. Responda apenas JSON.' },
    { role: 'user', content: prompt },
  ], 'json');

  if (!conteudo) throw new Error('OpenAI retornou resposta vazia na classificacao.');
  const parsed = JSON.parse(conteudo);
  return parsed;
}

async function extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual) {
  // A lista de pendentes precisa ir SEMPRE, inclusive (principalmente) quando ja existem dados
  // anteriores — senao o modelo nunca fica sabendo que um campo obrigatorio continua vazio e a
  // regra "atualize APENAS o que identificou agora" faz ele ignorar o campo pra sempre.
  const pendentes = camposPendentes(dadosAnteriores);
  const contextoAnteriores = dadosAnteriores
    ? `${JSON.stringify(dadosAnteriores)}\n- Campos obrigatorios AINDA PENDENTES (preencha estes se a conversa permitir, mesmo que nao tenham sido mencionados agora): ${pendentes.length ? pendentes.join(', ') : 'nenhum'}`
    : `{ "pendentes": "${pendentes.join(', ')}" }`;
  const prompt = PROMPT_EXTRAIR
    .replace('{historico}', historico)
    .replace('{temDeal}', temDeal ? 'sim' : 'nao')
    .replace('{calendarioReferencia}', montarReferenciaDeDatas(dataAtual || new Date().toISOString()))
    .replace('{dadosAnteriores}', contextoAnteriores)
    .replace('{infoCliente}', infoCliente || 'Nao')
    .replace('{dataAtual}', dataAtual || new Date().toISOString());
  const conteudo = await openaiChat([
    { role: 'system', content: 'Voce e um analista juridico especializado em extracao de dados de conversas de WhatsApp para leads de escritorio de advocacia. Extraia APENAS informacoes que voce tem CERTEZA. Nao invente. Se nao tiver certeza de um campo, deixe como null (a nao ser que a regra diga o contrario). Responda apenas JSON.' },
    { role: 'user', content: prompt },
  ], 'json');

  if (!conteudo) throw new Error('OpenAI retornou resposta vazia.');
  const parsed = JSON.parse(conteudo);
  return parsed;
}

// ------------------------------------------------------------
// Timers e fila de processamento (via processo filho)
// ------------------------------------------------------------
const timers = {};
const CHILD_LOCK_FILE = path.join(TEMP_DIR, 'worker.lock');
const DEPLOY_LOCK_FILE = path.join(TEMP_DIR, 'deploy.lock');

// atrasoMs existe pra que sincronizarConversas nao precise mexer em `timers` na mao — era assim que
// ela vazava timer, atribuindo direto sem o clearTimeout de baixo.
function agendarProcessamento(chatId, atrasoMs = TEMPO_INATIVIDADE_MS) {
  if (process.env.WORKER_MODE) return; // worker nao se auto-agenda
  if (timers[chatId]) clearTimeout(timers[chatId]);
  timers[chatId] = setTimeout(() => processarConversa(chatId), atrasoMs);
}

function pidEstaAtivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // processo existe mas sem permissao de sinal — ainda ativo
  }
}

// Retorna true se ja existe um worker rodando de verdade.
// Se a trava for orfa (pid gravado nao existe mais), remove e libera pra um novo worker.
function workerJaRodando() {
  if (!fs.existsSync(CHILD_LOCK_FILE)) return false;
  const pid = Number(fs.readFileSync(CHILD_LOCK_FILE, 'utf8').trim());
  if (pidEstaAtivo(pid)) return true;
  console.log(`  ⚠️ worker.lock orfao (pid ${pid} nao existe mais) — liberando fila`);
  try { fs.unlinkSync(CHILD_LOCK_FILE); } catch {}
  return false;
}

// Mesma logica de workerJaRodando(), pro processo de auto-deploy (deploy.js) — evita disparar
// dois deploys em paralelo quando o GitHub reentrega o mesmo push (retry de webhook).
function deployJaRodando() {
  if (!fs.existsSync(DEPLOY_LOCK_FILE)) return false;
  const pid = Number(fs.readFileSync(DEPLOY_LOCK_FILE, 'utf8').trim());
  if (pidEstaAtivo(pid)) return true;
  console.log(`  ⚠️ deploy.lock orfao (pid ${pid} nao existe mais) — liberando`);
  try { fs.unlinkSync(DEPLOY_LOCK_FILE); } catch {}
  return false;
}

function processarConversa(chatId) {
  // Worker: processar diretamente
  if (process.env.WORKER_MODE) {
    processarConversaDirect(chatId).catch(e => console.error(`❌ Worker ${chatId}:`, e.message));
    return;
  }

  // Servidor: salvar na fila e disparar worker
  delete timers[chatId];

  enfileirar(chatId);

  if (workerJaRodando()) return;

  const child = require('child_process').spawn(process.execPath, [
    path.join(__dirname, 'worker.js'),
  ], {
    stdio: 'inherit',
    detached: false,
  });

  try { fs.writeFileSync(CHILD_LOCK_FILE, String(child.pid)); } catch (e) {
    console.error(`  ⚠️ nao consegui gravar worker.lock: ${e.message}`);
  }

  child.on('exit', () => {
    try { fs.unlinkSync(CHILD_LOCK_FILE); } catch {}
  });
}

// Fim de ciclo comum aos tres ramos que escrevem (criar / nota / atualizar_campos).
//
// Estas quatro operacoes estavam COPIADAS nos tres ramos, e foi essa triplicacao que produziu os
// dois piores bugs desta semana: o ramo "nota" nao chamava atualizarNegocioMoskit (a virada de
// cobranca nao chegava ao CRM) e o ramo "criar" tinha uma verificacao de deal incompleta. Com um
// lugar so, corrigir passa a valer para os tres de uma vez.
async function finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, resumo, obsValidas }) {
  const resultadoPagamento = await handlePagamentoConfirmado(dealId, dados, chatId);
  await handleAgendamentoCalendar(
    dealId, dadosMesclados, chatId, resultadoPagamento.verificadoPorComprovante, row, apuracao
  );

  if (dados.estagio_funil_sugerido) {
    await moverEstagioSeAvancar(dealId, dados.estagio_funil_sugerido);
  }

  // Fechamento (ganho/perdido) so DEPOIS do avanco de estagio: um mesmo ciclo com "contrato
  // assinado" + "ganho" deve deixar o deal ja no estagio final antes de fechar, nao fechado no meio
  // do funil.
  if (dados.status_negocio_sugerido) {
    const nomeFechamento = dadosMesclados?.nome || dados?.nome || row?.contact_name || 'nao informado';
    await fecharNegocioSeAplicavel(dealId, dados.status_negocio_sugerido, dados.motivo_perda_sugerido, obsValidas, nomeFechamento, chatId);
  }

  // Sempre persiste o deal_id — o ramo "nota" usava um UPDATE que nao gravava esse campo.
  stmtFinalizarCiclo.run(dealId, JSON.stringify(dadosMesclados), acao, chatId);
  console.log(`  ✅ ${resumo}`);
}

// ------------------------------------------------------------
// Pipeline principal
// ------------------------------------------------------------
async function processarConversaDirect(chatId) {
  delete timers[chatId];

  try {
    const row = stmtGet.get(chatId);
    if (!row) {
      console.log(`  ⏭️ processarConversa: ${chatId} nao encontrado no banco`);
      return;
    }

    const mensagens = JSON.parse(row.messages);
    if (mensagens.length === 0) {
      console.log(`  ⏭️ processarConversa: ${chatId} sem mensagens`);
      return;
    }

    console.log(`\n🔰 Processando ${chatId} (${mensagens.length} msgs acumuladas)`);

    const temDeal = !!row.deal_id;
    const dadosAnteriores = row.last_data ? JSON.parse(row.last_data) : null;
    const phone = row.phone || extrairTelefone(chatId);
    const phoneClean = chaveConversa(phone) || chaveConversa(chatId);

    // Safety: ignorar socios/equipe. Marca a conversa como resolvida para que ela pare de aparecer
    // em stmtGetPending a cada boot — as 5 conversas internas eram reenfileiradas indefinidamente.
    if (ehInterno(phoneClean) || ehInterno(chatId)) {
      console.log(`  ⏭️ numero interno (equipe/socio) — ignorando permanentemente`);
      stmtUpdateProcessed.run(JSON.stringify({}), 'interno', chatId);
      return;
    }

    // Buscar info do cliente no Moskit
    const contatoMoskit = stmtMoskitGet.get(phoneClean);
    const infoCliente = contatoMoskit ? `Sim — ${contatoMoskit.name}` : 'Nao';

    const historico = montarHistorico(mensagens);

    // CHECKPOINT da cobranca. Calculado uma vez e passado pra todos os payloads desta rodada
    // (ver montarPayloadMoskit). `viradaCobranca` marca a rodada em que o bloco apareceu pela
    // primeira vez — e nela que um deal ja criado como cortesia precisa ser corrigido pra R$350.
    const bloco = detectarBlocoCondicoes(mensagens);
    const blocoJaRegistrado = row.bloco_condicoes_enviado === 1;
    const viradaCobranca = bloco.enviado && !blocoJaRegistrado;
    const opcoesPayload = { condicoesValorEnviadas: bloco.enviado };

    if (viradaCobranca) {
      db.prepare('UPDATE conversations SET bloco_condicoes_enviado = 1, bloco_condicoes_msg_idx = ? WHERE chat_id = ?').run(bloco.msgIdx, chatId);
      console.log(`  💳 Checkpoint: bloco de condicoes detectado na msg ${bloco.msgIdx} (${bloco.motivo}, valor=${bloco.marcadores.valor} estrutura=${bloco.marcadores.estrutura}) — consulta e PAGA`);
      // Antes da classificacao de proposito: mesmo que esta rodada acabe como "inviavel" ou
      // "aguardar", o deal ja existente precisa ser corrigido de cortesia pra paga.
      await aplicarViradaCobranca(chatId, row, dadosAnteriores, opcoesPayload, phone);
    } else if (!bloco.enviado) {
      const anexos = contarAnexosIlegiveisEquipe(mensagens);
      console.log(`  🆓 Checkpoint: bloco de condicoes nunca enviado — tratando como cortesia${anexos ? ` (⚠️ ${anexos} anexo(s) da equipe ilegivel(is))` : ''}`);
    }

    // Etapa 1: Classificar
    console.log('  Classificando lead...');
    // Sem este contexto, a regra "cliente existente so confirmando horario => inviavel" descartava a
    // propria mensagem que fecha a dupla confirmacao, e a conversa parava antes da extracao.
    const contextoCrm = [
      temDeal ? `negocio ${row.deal_id} ja existe no CRM` : 'nenhum negocio criado ainda',
      row.evento_calendar_criado ? 'consulta JA lancada na agenda' : 'consulta ainda NAO lancada na agenda',
    ].join('; ');
    const classificacao = await classificarConversa(historico, contextoCrm);
    console.log('  Classificacao:', JSON.stringify(classificacao));

    if (classificacao.classificacao === 'inviavel') {
      console.log(`  ⏭️ Inviavel (${classificacao.justificativa}) — ignorando`);
      stmtUpdateProcessed.run(JSON.stringify({}), 'inviavel', chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      return;
    }

    // Etapa 2: Extrair (apenas para criar_negocio)
    console.log('  Chamando OpenAI para extracao...');
    const dataAtual = mensagens[mensagens.length - 1]?.timestamp || new Date().toISOString();
    const result = await extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual);
    console.log('  OpenAI respondeu:', JSON.stringify(result));

    let acao = result.acao;
    const justificativa = result.justificativa || '';
    const dados = result.dados || {};

    // Valida as observacoes contra as mensagens reais ANTES de deixar qualquer uma influenciar a
    // agenda. Observacao que cita indice inexistente, papel errado ou trecho inventado e descartada.
    const { validas: obsValidas, rejeitadas: obsRejeitadas } = validarObservacoes(result.observacoes, mensagens);
    for (const r of obsRejeitadas) {
      console.log(`  🚫 observacao descartada (${r.motivo}): ${JSON.stringify(r.obs)}`);
    }
    for (const o of obsValidas) {
      if (o._dataCorrigida) {
        console.log(`  🗓️ horario_iso corrigido (dia relativo "hoje/amanha/depois de amanha" batido contra o timestamp da msg ${o.msg_idx}): "${o._dataCorrigida}" → "${o.horario_iso}"`);
      }
    }
    const apuracao = apurarDuplaConfirmacao(obsValidas);
    console.log(`  🔐 Dupla confirmacao: ${apuracao.confirmado
      ? `OK para ${apuracao.horarioIso} (cliente msg ${apuracao.cliente.msg_idx}, equipe msg ${apuracao.equipe.msg_idx})`
      : `NAO — ${descreverPendencia(apuracao)}`}`);
    // Sanitizar nome: rejeitar placeholders genericos que a IA inventa
    if (dados.nome) {
      const nome = dados.nome.trim();
      const genericos = /^(cliente|do cliente|nome do cliente|lead|cliente sem nome|sem nome|n\/a|nao informado|nao identificado|null|undefined)$/i;
      if (genericos.test(nome) || nome.length < 3) {
        console.log(`  ⚠️ nome generico/invalido rejeitado: "${dados.nome}"`);
        dados.nome = null;
      }
    }
    // Fallback: usar nome do contato do WhatsApp se a IA nao extraiu
    if (!dados.nome && row.contact_name) {
      const nomeWhatsApp = row.contact_name.trim();
      const genericos = /^(cliente|do cliente|nome do cliente|lead|cliente sem nome|sem nome|n\/a|nao informado|nao identificado|null|undefined|teste)$/i;
      if (!genericos.test(nomeWhatsApp) && nomeWhatsApp.length >= 3 && !/^\d+$/.test(nomeWhatsApp)) {
        console.log(`  ℹ️ usando nome do WhatsApp: "${nomeWhatsApp}"`);
        dados.nome = nomeWhatsApp;
      }
    }
    // Se o lead mencionou pagina/Instagram de socio, forcar origem Instagram + captacao
    const textoCompleto = mensagens.map(m => m.text).join(' ').toLowerCase();
    const PADROES_SOCIO = [
      { regex: /pagina\s+do\s+(bruno|dr\.?\s*bruno|advogado\s+bruno)/i, socio: 'Bruno' },
      { regex: /pagina\s+do\s+(berto|dr\.?\s*berto|caballero)/i, socio: 'Berto' },
      { regex: /pagina\s+do\s+(iury|dr\.?\s*iury)/i, socio: 'Iury' },
      { regex: /instagram\s+do\s+(bruno|dr\.?\s*bruno)/i, socio: 'Bruno' },
      { regex: /instagram\s+do\s+(berto|dr\.?\s*berto|caballero)/i, socio: 'Berto' },
      { regex: /instagram\s+do\s+(iury|dr\.?\s*iury)/i, socio: 'Iury' },
    ];
    for (const padrao of PADROES_SOCIO) {
      if (padrao.regex.test(textoCompleto)) {
        if (dados.origem !== 'Instagram') console.log(`  ℹ️ pagina/Instagram de ${padrao.socio} detectada — origem forçada para Instagram`);
        dados.origem = 'Instagram';
        dados.captacao = padrao.socio;
        break;
      }
    }
    const jsonDados = JSON.stringify(dados);
    const confianca = result.confianca ?? 0;

    console.log(`  → Ação decidida: "${acao}" (${justificativa}) | confianca: ${confianca}`);

    if (acao === 'criar' && confianca < 6) {
      console.log(`  ⏭️ confianca baixa (${confianca}/10), tratando como ignorar`);
      acao = 'ignorar';
    }

    if (acao === 'ignorar') {
      stmtUpdateProcessed.run(jsonDados, acao, chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      console.log(`  ⏭️ ignorado ${chatId} (${justificativa})`);
      return;
    }

    if (acao === 'aguardar') {
      const dadosMesclados = mergeDados(dadosAnteriores || {}, dados);
      stmtUpdateProcessed.run(JSON.stringify(dadosMesclados), acao, chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      console.log(`  ⏳ Aguardando mais mensagens de ${chatId}`);
      return;
    }

    if (!dados.nome) {
      console.log(`  ⚠️ nome nao extraido, continuando com 'Cliente sem nome'`);
    }

    if (acao === 'criar') {
      console.log('  Buscando/criando contato no Moskit...');
      const contactId = await buscarOuCriarContato(phone, dados.nome);
      console.log(`  Contato ID: ${contactId}`);

      // Mescla com o que ja tinha sido extraido antes — sem isso um campo que veio null nesta
      // rodada (tipicamente o assunto) descarta o valor bom de um ciclo anterior. Os branches
      // aguardar/nota/atualizar_campos ja faziam isso; o criar era o unico que usava dados cru.
      const dadosMesclados = mergeDados(dadosAnteriores || {}, dados);

      // Tres bugs viviam aqui, todos por causa de um if/else que decidia o caminho antes de saber
      // o resultado da verificacao:
      //   1) deal vivo => nenhum dos dois ramos de escrita rodava, e o ciclo "criar" nao mandava
      //      campo nenhum pro CRM;
      //   2) deal 404 => dealId virava null mas o else ja tinha sido descartado, entao nenhum deal
      //      novo nascia e o null descia pra criarNotaMoskit/stmtUpdateDeal, APAGANDO o deal_id;
      //   3) a verificacao de 404 era copia inline e incompleta de garantirDealExiste, que ja
      //      recria o deal e e usada pelos outros dois ramos.
      let dealId = row.deal_id
        ? await garantirDealExiste(row.deal_id, dadosMesclados, contactId, opcoesPayload)
        : await buscarDealPorContato(contactId);

      if (dealId) {
        console.log(`  Deal ${dealId} ja existe — atualizando...`);
        await atualizarNegocioMoskit(dealId, dadosMesclados, contactId, opcoesPayload);
        console.log(`  ✅ Deal ${dealId} atualizado`);
      } else {
        console.log('  Criando novo deal...');
        const deal = await criarNegocioMoskit(dadosMesclados, contactId, opcoesPayload);
        dealId = deal.id;
        console.log(`  ✅ Novo Deal ${dealId} criado`);
      }

      // Se o deal foi recriado com outro id, o banco precisa saber agora — o briefing e o
      // evento_calendar_* abaixo dependem disso, e nao no fim do ciclo.
      if (dealId !== row.deal_id) {
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0 WHERE chat_id = ?').run(dealId, chatId);
        row.deal_id = dealId;
        row.briefing_added = 0;
      }

      if (dados.resumo_atendimento && !row.briefing_added) {
        console.log('  Adicionando nota com resumo do caso...');
        await criarNotaMoskit(dealId, `📋 Briefing pré-reunião\n\n${dados.resumo_atendimento}`);
        db.prepare('UPDATE conversations SET briefing_added = 1 WHERE chat_id = ?').run(chatId);
        console.log(`  ✅ Nota adicionada ao deal ${dealId}`);
      }

      await finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, obsValidas,
        resumo: `Processamento de ${chatId} concluido` });
      return;
    }

    if (acao === 'nota') {
      if (!row.deal_id) {
        console.log(`  ⏭️ acao "nota" mas sem deal_id — ignorando`);
        stmtUpdateProcessed.run(jsonDados, acao, chatId);
        db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
        return;
      }

      const contactId = await buscarOuCriarContato(phone, dados.nome || dadosAnteriores?.nome);
      let dealId = row.deal_id;
      const dealVerificado = await garantirDealExiste(dealId, mergeDados(dadosAnteriores || {}, dados), contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0 WHERE chat_id = ?').run(dealId, chatId);
        row.briefing_added = 0;
        console.log(`  ✅ Deal recriado como ${dealId} (o anterior nao existia mais no Moskit)`);
      }

      if (dados.resumo_atendimento && !row.briefing_added) {
        console.log(`  Adicionando nota atualizada ao deal ${dealId}...`);
        await criarNotaMoskit(dealId, `📋 Briefing atualizado\n\n${dados.resumo_atendimento}`);
        db.prepare('UPDATE conversations SET briefing_added = 1 WHERE chat_id = ?').run(chatId);
        console.log(`  ✅ Nota adicionada ao deal ${dealId}`);
      } else if (!dados.resumo_atendimento) {
        console.log(`  ⏭️ acao "nota" sem resumo — ignorando`);
      } else {
        console.log(`  ⏭️ Briefing ja adicionado para este deal — ignorando`);
      }

      await finalizarCiclo({
        dealId, dados, dadosMesclados: mergeDados(dadosAnteriores || {}, dados),
        chatId, row, apuracao, acao, obsValidas, resumo: `Nota adicionada para ${chatId}`,
      });
      return;
    }

    if (acao === 'atualizar_campos') {
      if (!row.deal_id) {
        console.log(`  ⏭️ acao "atualizar_campos" mas sem deal_id — ignorando`);
        stmtUpdateProcessed.run(jsonDados, acao, chatId);
        db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
        return;
      }

      let dealId = row.deal_id;
      // Nao redeclarar `dadosAnteriores` aqui: havia uma segunda declaracao com o mesmo nome
      // sombreando a do escopo da funcao. A externa e `null` quando nao ha dados salvos, a interna
      // era `{}` — e as linhas abaixo usavam a sombra enquanto os ramos "criar" e "nota" usavam a
      // externa. Tres ramos que parecem identicos operando sobre objetos diferentes.
      const dadosMesclados = mergeDados(dadosAnteriores || {}, dados);
      const pendentes = camposPendentes(dadosMesclados);

      console.log('  Dados anteriores:', JSON.stringify(dadosAnteriores));
      console.log('  Dados novos:', JSON.stringify(dados));
      console.log('  Dados mesclados:', JSON.stringify(dadosMesclados));
      console.log(`  Campos ainda pendentes: ${pendentes.length > 0 ? pendentes.join(', ') : 'nenhum'}`);

      const contactId = await buscarOuCriarContato(phone, dadosMesclados.nome || dadosAnteriores?.nome);

      const dealVerificado = await garantirDealExiste(dealId, dadosMesclados, contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        db.prepare('UPDATE conversations SET briefing_added = 0 WHERE chat_id = ?').run(chatId);
        row.briefing_added = 0;
        console.log(`  ✅ Deal recriado como ${dealId} (o anterior nao existia mais no Moskit)`);
      } else {
        console.log(`  Atualizando deal ${dealId} com novos campos...`);
        await atualizarNegocioMoskit(dealId, dadosMesclados, contactId, opcoesPayload);
        console.log(`  ✅ Deal ${dealId} atualizado no Moskit`);
      }

      const camposAlterados = Object.keys(dados).filter(
        (k) => dados[k] !== null && dados[k] !== undefined && dados[k] !== 'null'
      );
      if (camposAlterados.length > 0) {
        const descricao = camposAlterados.map((k) => `${k}: ${dados[k]}`).join(', ');
        await criarNotaMoskit(dealId, `🔄 Campos preenchidos: ${descricao}`);
        console.log(`  ✅ Nota de atualizacao adicionada`);
      }

      if (pendentes.length === 0) {
        console.log('  🎯 Todos os campos obrigatorios preenchidos!');
        if (dadosMesclados.resumo_atendimento && !row.briefing_added) {
          await criarNotaMoskit(dealId, `📋 Briefing completo\n\n${dadosMesclados.resumo_atendimento}`);
          db.prepare('UPDATE conversations SET briefing_added = 1 WHERE chat_id = ?').run(chatId);
        }
      }

      await finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, obsValidas,
        resumo: `Deal ${dealId} atualizado com campos pendentes` });
      return;
    }

    console.log(`  ⏭️ acao desconhecida "${acao}" — ignorando`);
    stmtUpdateProcessed.run(jsonDados, acao, chatId);
    db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);

  } catch (erro) {
    console.error(`\n❌ Erro ao processar ${chatId}:`);
    if (erro.response) {
      console.error('  Status:', erro.response.status);
      console.error('  Dados:', JSON.stringify(erro.response.data, null, 2));
    } else {
      console.error('  Message:', erro.message);
    }
    console.error('  Stack:', erro.stack);
    // RELANCA. Antes engolia o erro aqui e chamava agendarProcessamento(), que e no-op sob
    // WORKER_MODE — e esta funcao so roda no worker. Resultado: o catch do worker.js nunca era
    // atingido, o chatId entrava em `sucessos` e saia da fila como se tivesse dado certo. Uma
    // falha de rede descartava o lead em silencio. Quem decide o que fazer com a falha e a fila.
    throw erro;
  }
}

// ------------------------------------------------------------
// Servidor Webhook (Zernio)
// ------------------------------------------------------------
const app = express();
// Guarda o corpo cru (bytes) pra poder validar a assinatura HMAC do webhook — depois de
// express.json() fazer o parse, o buffer original nao existe mais.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Timeout global: responde 503 se a requisicao demorar mais de 240s (sync pode ser lenta)
app.use((req, res, next) => {
  res.setTimeout(240000, () => {
    console.error(`⏰ TIMEOUT na requisicao ${req.method} ${req.path} apos 240s`);
    if (!res.headersSent) res.status(503).json({ error: 'timeout' });
  });
  next();
});

// ------------------------------------------------------------
// Autenticacao
// ------------------------------------------------------------
// O servico e publicado na internet pelo ngrok e ate aqui NENHUMA das 10 rotas exigia credencial:
// dava pra forcar processamento, criar evento no Google Agenda do escritorio, mover deal, e
// consultar nome+id de qualquer cliente do CRM a partir do telefone.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// Compara em tempo constante (evita vazar o segredo por diferenca de timing char a char).
// timingSafeEqual exige buffers do mesmo tamanho, entao valores de tamanho diferente ja falham direto.
function comparacaoSegura(enviado, esperado) {
  const bufEnviado = Buffer.from(String(enviado || ''));
  const bufEsperado = Buffer.from(String(esperado || ''));
  if (bufEnviado.length !== bufEsperado.length) return false;
  return crypto.timingSafeEqual(bufEnviado, bufEsperado);
}

// A URL do webhook no Zernio e FIXA (nao da pra apontar pra um caminho com segredo, tipo
// /webhook/<segredo>) — mas o Zernio suporta assinar cada entrega com HMAC-SHA256 do corpo cru,
// usando um secret configurado no dashboard deles (Settings > Webhooks) ou via API. O segredo aqui
// e o MESMO valor cadastrado la, e a assinatura vem no header X-Zernio-Signature (hex minusculo).
function assinaturaValida(req) {
  const recebida = req.get('X-Zernio-Signature') || req.get('X-Late-Signature');
  if (!recebida || !req.rawBody) return false;
  const esperada = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  return comparacaoSegura(recebida, esperada);
}

// Segredo do webhook de auto-deploy (repositorio no GitHub > Settings > Webhooks). Usado pela
// rota /deploy-webhook pra manter esta maquina sempre com a versao mais recente do codigo a
// cada `git push` — ver deploy.js. Sem DEPLOY_WEBHOOK_SECRET, a rota fica desabilitada (503).
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || null;
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH || 'main';

// O GitHub assina cada entrega com HMAC-SHA256 do corpo cru, no header X-Hub-Signature-256
// (formato "sha256=<hex>") — mesma ideia de assinaturaValida() acima, so que com o prefixo
// "sha256=" que o GitHub usa e o Zernio nao.
function assinaturaGithubValida(req) {
  const recebida = req.get('X-Hub-Signature-256');
  if (!recebida || !recebida.startsWith('sha256=') || !req.rawBody) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', DEPLOY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  return comparacaoSegura(recebida, esperada);
}

// Sem ADMIN_TOKEN a rota fica DESLIGADA (503), nao aberta. Perder /sincronizar por falta de config
// e preferivel a deixar /cliente-existente respondendo pra qualquer um.
function exigeAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN nao configurado — rota administrativa desabilitada' });
  }
  const enviado = req.get('X-Admin-Token') || req.query.token;
  if (!comparacaoSegura(enviado, ADMIN_TOKEN)) return res.status(401).json({ error: 'nao autorizado' });
  next();
}

// Adaptador de rota async: o Express 4 NAO encaminha rejeicao de handler async pro error middleware,
// entao um erro deixava a requisicao pendurada ate o timeout de 240s.
const rota = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`❌ ${req.method} ${req.path}: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  });
};

// Health check — unica rota aberta de proposito; nao revela nada.
app.get('/', (req, res) => {
  res.send('Bot WhatsApp rodando via Zernio!');
});

// Rota para forçar processamento manual (debug)
app.post('/processar/:chatId', exigeAdmin, (req, res) => {
  const chatId = req.params.chatId;
  console.log(`\n🔧 Forçando processamento de ${chatId} via rota /processar`);
  res.json({ ok: true, chatId });
  try {
    processarConversa(chatId);
  } catch (e) {
    console.error(`❌ POST /processar/${chatId}: ${e.message}`);
  }
});

// Rota para sincronizar conversas via API Zernio
app.post('/sincronizar', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Sincronizando conversas via API Zernio...');
  const resultado = await sincronizarConversas();
  res.json({ ok: true, ...resultado });
}));

// Rota para sincronizar Atividades do Moskit (Reunião/Videoconferência) com o Google Calendar,
// independente de o deal ter sido criado pelo bot ou pelo Moskit Boost / manualmente
app.post('/sincronizar-atividades', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Sincronizando atividades do Moskit com o Google Calendar...');
  const resultado = await sincronizarAtividadesMoskit();
  res.json({ ok: true, ...resultado });
}));

// Auditoria SO-LEITURA: mostra quais atividades seriam liberadas sem comprovante por estarem
// marcadas como "consulta gratis" no Moskit. Nao toca em Calendar, Moskit nem Telegram — serve
// pra conferir o alcance antes de ligar LIBERAR_CONSULTA_GRATIS.
app.get('/auditoria-consulta-gratis', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria de consultas gratis (so leitura)...');
  const linhas = [];
  try {
    const ativRes = await axios.get(`${MOSKIT_BASE}/activities`, {
      params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const agora = Date.now();

    for (const atv of (ativRes.data || [])) {
      if (!ATIVIDADE_TIPOS_CONSULTA.has(atv.type?.id)) continue;
      if (atv.doneDate) continue;
      if (!atv.dueDate || new Date(atv.dueDate).getTime() <= agora) continue;

      const dealId = atv.deals?.[0]?.id || null;
      const linha = {
        activity_id: atv.id,
        title: atv.title,
        dueDate: atv.dueDate,
        dealId,
        ja_sincronizada: !!stmtAtividadeJaSincronizada.get(atv.id),
        opcoes_tipo_consulta: null,
        tem_comprovante: false,
        decisao: 'bloqueada',
      };

      if (dealId) {
        linha.tem_comprovante = !!stmtComprovantePorDeal.get(dealId);
        const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
        });
        if (dealRes.status >= 200 && dealRes.status < 300) {
          const campo = (dealRes.data?.entityCustomFields || []).find((c) => c?.id === CF_TIPO_CONSULTA);
          linha.opcoes_tipo_consulta = campo?.options || [];
          if (linha.tem_comprovante) linha.decisao = 'liberada por comprovante';
          else if (dealEhConsultaGratis(dealRes.data)) linha.decisao = 'liberaria por consulta gratis';
        } else {
          linha.decisao = `erro ao ler deal (HTTP ${dealRes.status})`;
        }
      } else {
        linha.decisao = 'bloqueada (atividade sem deal)';
      }

      linhas.push(linha);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }

  const liberariaPorGratis = linhas.filter((l) => l.decisao === 'liberaria por consulta gratis').length;
  console.log(`  🔍 ${linhas.length} atividades futuras analisadas — ${liberariaPorGratis} seriam liberadas por consulta gratis`);
  res.json({ ok: true, flag_ativa: LIBERAR_CONSULTA_GRATIS, total: linhas.length, liberaria_por_consulta_gratis: liberariaPorGratis, atividades: linhas });
}));

// Auditoria SO-LEITURA: lista estagios do funil (pipeline "Funil de Vendas", id 40631) com priority
// maior que a do ultimo estagio mapeado hoje em MOSKIT_STAGE_MAP (contrato_enviado), e amostra os
// valores reais de deal.status ja em uso no Moskit. Nao escreve nada — serve pra descobrir os
// nomes/IDs dos estagios finais do funil (ex.: Contrato Assinado, Ganho, Perdido) antes de mapea-los.
app.get('/auditoria-funil-completo', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria do funil completo (so leitura)...');
  const maxPriorityMapeada = Math.max(...Object.values(MOSKIT_STAGE_MAP).map((s) => s.priority));

  let stages = [];
  let stagesFonte = null;
  for (const tentativa of [
    { fonte: '/stages', req: () => axios.get(`${MOSKIT_BASE}/stages`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
    { fonte: '/pipelines/40631', req: () => axios.get(`${MOSKIT_BASE}/pipelines/40631`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
    { fonte: '/pipelines', req: () => axios.get(`${MOSKIT_BASE}/pipelines`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
  ]) {
    try {
      const respTentativa = await tentativa.req();
      if (respTentativa.status >= 200 && respTentativa.status < 300 && respTentativa.data) {
        const candidato = Array.isArray(respTentativa.data)
          ? respTentativa.data
          : (respTentativa.data.stages || [respTentativa.data]);
        if (candidato.length) {
          stages = candidato;
          stagesFonte = tentativa.fonte;
          break;
        }
      }
    } catch (e) {
      console.log(`  ⚠️ ${tentativa.fonte} falhou: ${e.message}`);
    }
  }

  const estagiosAlemDoMapeado = stages
    .filter((s) => Number.isFinite(s?.priority) && s.priority > maxPriorityMapeada)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => ({ id: s.id, name: s.name, priority: s.priority }));

  // ATENCAO: /deals ignora `limit` e sempre devolve so os 10 mais recentes (quirk conhecido da API
  // do Moskit) — esta amostra e so uma indicacao rapida, nao uma varredura de todos os deals.
  const dealsRes = await axios.get(`${MOSKIT_BASE}/deals`, {
    params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  const deals = dealsRes.data || [];
  const statusVistos = {};
  let exemploNaoAberto = null;
  for (const d of deals) {
    const st = d?.status || '(vazio)';
    statusVistos[st] = (statusVistos[st] || 0) + 1;
    if (st !== 'OPEN' && !exemploNaoAberto) exemploNaoAberto = d;
  }

  console.log(`  🔍 ${estagiosAlemDoMapeado.length} estagio(s) alem do mapeado, ${deals.length} deal(s) na amostra (limit ignorado pela API)`);
  res.json({
    ok: true,
    fonte_estagios: stagesFonte,
    max_priority_mapeada_hoje: maxPriorityMapeada,
    estagios_alem_do_mapeado: estagiosAlemDoMapeado,
    amostra_deals: deals.length,
    amostra_aviso: 'API do Moskit ignora limit em /deals — amostra e so os ~10 deals mais recentes',
    status_vistos_na_amostra: statusVistos,
    exemplo_deal_status_diferente_de_open: exemploNaoAberto,
  });
}));

// Rota de uso unico (manual) pra adicionar link do Google Meet a eventos futuros
// que ja existiam no calendario antes dessa funcionalidade existir
app.post('/backfill-meet-links', exigeAdmin, rota(async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  console.log(`\n🔧 ${dryRun ? '[dry-run] Simulando' : 'Adicionando'} Meet a eventos futuros existentes...`);
  const resultado = await backfillMeetLinks(dryRun);
  res.json({ ok: true, ...resultado });
}));

// Rota para importar todos os contatos do Moskit
app.post('/importar-moskit', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Importando contatos do Moskit...');
  const resultado = await importarContatosMoskit();
  const count = stmtMoskitCount.get();
  res.json({ ok: true, ...resultado, total_no_banco: count.t });
}));

// Rota para consultar se um telefone existe no Moskit.
// Sem auth isto era um oraculo de enumeracao: telefone -> nome + id do cliente no CRM.
app.get('/cliente-existente/:telefone', exigeAdmin, (req, res) => {
  const contato = stmtMoskitGet.get(chaveConversa(req.params.telefone));
  if (contato) {
    res.json({ existe: true, moskit_id: contato.moskit_id, nome: contato.name });
  } else {
    res.json({ existe: false });
  }
});

// Rota para backfill: criar deals pendentes de conversas com last_action='criar' sem deal_id
app.post('/backfill-deals', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Backfill: processando conversas criar sem deal_id...');
  const resultado = await backfillDeals();
  res.json({ ok: true, ...resultado });
}));

// Webhook — Zernio envia eventos aqui
function tratarWebhook(req, res) {
  res.sendStatus(200);

  // Se req.body veio vazio ou deu problema no parse, ignorar
  if (!req.body || Object.keys(req.body).length === 0) {
    console.log('  ⏭️ webhook recebido sem body (provavel timeout/parse error)');
    return;
  }

  const body = req.body;
  const msg = body?.message;
  if (!msg) return;

  // Mensagem recebida do cliente
  if (body.event === 'message.received' && msg.direction === 'incoming') {
    const from = chaveConversa(msg.sender?.id);
    const contactName = msg.sender?.name || from;
    if (!from) {
      // Nao e telefone reconhecivel (id alfanumerico, grupo, remetente vazio). Loga em vez de
      // sumir em silencio — se aparecer no log, o formato do Zernio mudou.
      console.log(`  ⏭️ webhook: sender.id "${msg.sender?.id}" nao vira chave de conversa — ignorado`);
      return;
    }

    let corpo;
    let audioAtt = null;
    if (msg.text) {
      corpo = String(msg.text).trim();
      if (!corpo) return;
    } else if (msg.attachments && msg.attachments.length > 0) {
      const att = msg.attachments[0];
      const nomeArquivo = att.payload?.filename || att.payload?.name;
      if (att.type === 'image') {
        corpo = nomeArquivo ? `📎 [cliente enviou: ${nomeArquivo}]` : '📎 [cliente enviou uma imagem]';
      } else if (att.type === 'document' || att.type === 'file') {
        corpo = `📎 [cliente enviou: ${nomeArquivo || 'documento'}]`;
      } else if (att.type === 'audio') {
        corpo = '📎 [cliente enviou um audio]';
        audioAtt = att; // transcricao assincrona apos o placeholder estar no banco (abaixo)
      } else if (att.type === 'video') {
        corpo = '📎 [cliente enviou um video]';
      } else if (att.type === 'sticker') {
        corpo = '📎 [cliente enviou uma figurinha]';
      } else {
        corpo = `📎 [cliente enviou ${att.type}]`;
      }
      // O audio NAO passa por baixarComprovante: alem de salvar com nome/erro de "comprovante",
      // notificaria "NOVO COMPROVANTE" no Telegram a toa. Ele e baixado e transcrito no proprio
      // caminho de audio, la embaixo.
      if (att.type !== 'audio') {
        // .catch obrigatorio: sem ele a rejeicao caia no handler global de unhandledRejection e o
        // comprovante sumia sem ninguem saber.
        baixarComprovante(from, att)
          .then(async (caminho) => {
            await notificarTelegram(from, att, caminho);
            if (att.type === 'image' && caminho) await processarComprovante(from, from, caminho);
          })
          .catch((e) => console.error(`  ❌ Erro ao tratar anexo de ${from}: ${e.message}`));
      }
    } else {
      return;
    }

    processarMensagemRecebida(from, from, contactName, corpo, 'cliente', msg.id);
    // Transcricao depois do placeholder estar no banco: se o processo morrer no meio, a conversa
    // segue processando sem o conteudo do audio em vez de perder a mensagem inteira.
    if (audioAtt && msg.id) {
      processarAudioCliente(from, audioAtt, msg.id)
        .catch((e) => console.error(`  ❌ Erro ao transcrever audio de ${from}: ${e.message}`));
    }
    return;
  }

  // Mensagem enviada pela equipe (usado pra detectar avanco no funil — proposta, contrato, etc.)
  if (body.event === 'message.sent' && msg.direction === 'outgoing') {
    const chatId = chaveConversa(body.conversation?.participantId);
    const contactName = body.conversation?.participantName || chatId;
    if (!chatId) {
      console.log(`  ⏭️ webhook: participantId "${body.conversation?.participantId}" nao vira chave de conversa — ignorado`);
      return;
    }

    // Nome do arquivo tambem do lado da equipe: o polling ja capturava e o webhook descartava, entao
    // "tabela-honorarios.pdf" virava "[equipe enviou document]" e sumia da deteccao de cobranca.
    const anexo = msg.attachments?.[0];
    const nomeAnexo = anexo?.payload?.filename || anexo?.payload?.name || anexo?.filename;
    const corpo = msg.text
      ? String(msg.text).trim()
      : (anexo ? `📎 [equipe enviou${nomeAnexo ? `: ${nomeAnexo}` : ` ${anexo.type}`}]` : null);
    if (!corpo) return;

    processarMensagemRecebida(chatId, chatId, contactName, corpo, 'equipe', msg.id);
  }
}

// A URL do webhook e sempre /webhook (o Zernio nao permite apontar pra um caminho customizado).
// Em periodo de tolerancia — sem WEBHOOK_SECRET configurado — aceita sem checar assinatura, so pra
// dar tempo de subir o codigo sem blackout; passa a EXIGIR assinatura valida assim que o secret for
// cadastrado aqui E no dashboard do Zernio (Settings > Webhooks).
app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET && !assinaturaValida(req)) return res.sendStatus(401);
  tratarWebhook(req, res);
});

// Auto-deploy: o GitHub chama esta rota a cada push (repositorio > Settings > Webhooks) pra
// manter esta maquina sempre com a versao mais recente do codigo. So dispara pro branch
// DEPLOY_BRANCH (padrao main); a execucao de verdade (git pull + npm install + npm test, e SO
// reinicia o pm2 se tudo passar) fica isolada em deploy.js, roda como processo filho desacoplado
// pra sobreviver ao proprio restart que ela vai provocar neste processo.
app.post('/deploy-webhook', (req, res) => {
  if (!DEPLOY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'DEPLOY_WEBHOOK_SECRET nao configurado — auto-deploy desabilitado' });
  }
  if (!assinaturaGithubValida(req)) return res.sendStatus(401);

  const evento = req.get('X-GitHub-Event');
  if (evento !== 'push') return res.status(202).json({ ok: true, ignorado: `evento ${evento || 'desconhecido'}` });

  const branchRef = req.body?.ref; // ex.: "refs/heads/main"
  if (branchRef !== `refs/heads/${DEPLOY_BRANCH}`) {
    return res.status(202).json({ ok: true, ignorado: `branch ${branchRef || 'desconhecido'}` });
  }

  if (deployJaRodando()) {
    console.log('  ⏭️ deploy ja em andamento — entrega duplicada do GitHub ignorada');
    return res.status(202).json({ ok: true, ignorado: 'deploy ja em andamento' });
  }

  console.log(`\n🚀 Push em ${DEPLOY_BRANCH} recebido — disparando deploy.js`);
  const child = require('child_process').spawn(process.execPath, [
    path.join(__dirname, 'deploy.js'),
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  try { fs.writeFileSync(DEPLOY_LOCK_FILE, String(child.pid)); } catch (e) {
    console.error(`  ⚠️ nao consegui gravar deploy.lock: ${e.message}`);
  }

  res.status(202).json({ ok: true, deploy: 'iniciado' });
});

function processarMensagemRecebida(chatId, phone, contactName, corpo, role, idZernio) {
  try {
    const phoneClean = chaveConversa(phone || chatId);
    const existente = stmtMoskitGet.get(phoneClean);
    const statusCliente = existente ? `🔵 Cliente EXISTENTE (${existente.name})` : '🟢 Cliente NOVO';

    const origem = role === 'equipe' ? '📤 MSG enviada pela equipe pra' : '📩 MSG recebida de';
    console.log(`\n${origem}: ${chatId} | ${statusCliente} | corpo:`, (corpo || '').substring(0, 200));

    // Ignorar conversas de socios/equipe (numero da conversa em si eh interno, nao um cliente).
    // Barra na ENTRADA: sem isso a mensagem era gravada e so descartada no fim do pipeline, e a
    // conversa interna crescia no banco a toa (a do Bruno acumulou 318 mensagens).
    if (ehInterno(phoneClean) || ehInterno(chatId)) {
      console.log(`  ⏭️ numero interno (equipe/socio) — nao registrado como lead`);
      return;
    }

    const row = stmtGet.get(chatId);
    const mensagens = row ? JSON.parse(row.messages) : [];
    const nova = {
      role: role || 'cliente',
      text: corpo,
      timestamp: new Date().toISOString(),
      // id do Zernio gravado desde a entrada: e o que permite ao polling reconhecer esta mensagem
      // depois. Sem ele, o polling nao a via e re-adicionava o historico inteiro.
      id_zernio: idZernio || null,
    };

    // O webhook pode reentregar o mesmo evento (retry do Zernio). `jaExiste` so barra quando o id
    // bate, ou quando o texto e longo o bastante pra coincidencia ser implausivel — rajada de
    // imagens (mesmo placeholder, varios envios) continua passando.
    if (jaExiste(nova, mensagens)) {
      console.log(`  ⏭️ mensagem ja registrada — ignorando reentrega do webhook`);
      return;
    }
    mensagens.push(nova);

    stmtUpsert.run(chatId, phone, contactName, JSON.stringify(mensagens), new Date().toISOString());
    console.log(`  -> salva no banco (${mensagens.length} msgs acumuladas), timer resetado`);

    agendarProcessamento(chatId);
  } catch (erro) {
    console.error('❌ Erro no processamento da mensagem:', erro.message);
    console.error(erro.stack);
  }
}

// ------------------------------------------------------------
// Sincronizar conversas via API Zernio
// ------------------------------------------------------------
// Tipos de atividade do Moskit que representam consulta/reuniao marcada (GET /activityTypes):
// 87134 = Reuniao, 87361 = Videoconferencia. Ligacao/Email/Whatsapp nao viram evento de calendario.
const ATIVIDADE_TIPOS_CONSULTA = MOSKIT_IDS.ATIVIDADE_TIPOS_CONSULTA;

// Marca, na nota do Moskit, que a reuniao foi liberada sem comprovante — sem isso nao ha como
// auditar depois quais consultas foram agendadas sem pagamento.
function seloConsultaGratis(motivo) {
  return motivo === 'consulta_gratis'
    ? '\n🆓 Consulta gratuita (marcada no Moskit) — evento criado sem comprovante de pagamento.'
    : '';
}

// Evita dois ciclos sobrepostos: o setInterval dispara a cada 3 min e a rota manual pode disparar
// por cima. Com o gate liberado cada atividade faz varias chamadas de rede, e duas execucoes
// simultaneas criariam evento, Meet e aviso no Telegram duplicados pro mesmo cliente.
let sincronizacaoAtividadesEmAndamento = false;

// Sincroniza Atividades do Moskit (marcadas manualmente ou por qualquer integracao, incluindo
// o Moskit Boost) com o Google Calendar — cobre consultas que nunca passaram pela conversa
// que o bot analisa (ex: deals vindos do Boost, ou atividade criada direto no Moskit).
async function sincronizarAtividadesMoskit() {
  const relatorio = { atividades_verificadas: 0, eventos_criados: 0, ja_sincronizadas: 0, aguardando_pagamento: 0, liberadas_consulta_gratis: 0, ignoradas: 0, erros: 0 };

  if (!getGoogleAuthClient()) {
    console.log('  ⏭️ Google Calendar nao configurado — pulando sincronizacao de atividades');
    return relatorio;
  }

  if (sincronizacaoAtividadesEmAndamento) {
    console.log('  ⏭️ Sincronizacao de atividades ja em andamento — pulando este ciclo');
    return relatorio;
  }
  sincronizacaoAtividadesEmAndamento = true;

  try {
    const res = await axios.get(`${MOSKIT_BASE}/activities`, {
      params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const atividades = res.data || [];
    relatorio.atividades_verificadas = atividades.length;
    console.log(`  📅 ${atividades.length} atividades recentes encontradas no Moskit`);

    const agora = Date.now();

    for (const atv of atividades) {
      try {
        if (!ATIVIDADE_TIPOS_CONSULTA.has(atv.type?.id)) continue;
        if (atv.doneDate) continue; // ja realizada/concluida
        if (!atv.dueDate || new Date(atv.dueDate).getTime() <= agora) continue; // so agenda futura

        if (stmtAtividadeJaSincronizada.get(atv.id)) {
          relatorio.ja_sincronizadas++;
          continue;
        }

        const dealId = atv.deals?.[0]?.id || null;
        const calendar = google.calendar({ version: 'v3', auth: getGoogleAuthClient() });

        // O proprio Moskit ja sincroniza algumas atividades nativamente com esse calendario,
        // usando o ID "oll<activity_id>". Se ja existir, nao criar um evento duplicado —
        // so garantir que ele tenha o link do Meet (quando o pagamento ja estiver verificado).
        const ollEventId = `oll${atv.id}`;
        let eventoNativo = null;
        try {
          const getRes = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: ollEventId });
          eventoNativo = getRes.data;
        } catch {
          // 404 esperado: Moskit nao sincronizou essa nativamente, seguimos e criamos nosso proprio evento
        }

        if (eventoNativo) {
          if (eventoNativo.hangoutLink || eventoNativo.conferenceData?.entryPoints?.length) {
            stmtAtividadeMarcarSincronizada.run(atv.id, ollEventId, dealId);
            relatorio.ja_sincronizadas++;
            continue;
          }

          const authNativa = await autorizacaoParaAgendar(dealId);
          if (!authNativa.permitido) {
            relatorio.aguardando_pagamento++;
            console.log(`  ⏳ Atividade "${atv.title}" (nativa do Moskit) aguardando comprovante verificado — Meet ainda nao sera criado`);
            continue;
          }
          if (authNativa.motivo === 'consulta_gratis') {
            relatorio.liberadas_consulta_gratis++;
            console.log(`  🆓 Atividade "${atv.title}" (nativa do Moskit) liberada SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
          }

          const patched = await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ollEventId,
            conferenceDataVersion: 1,
            requestBody: {
              conferenceData: { createRequest: { requestId: `meet-native-${atv.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
            },
          });
          stmtAtividadeMarcarSincronizada.run(atv.id, ollEventId, dealId);
          relatorio.ja_sincronizadas++;

          const meetLinkNativo = extrairMeetLink(patched.data);
          const dataFormatadaNativo = new Date(atv.dueDate).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });
          console.log(`  ✅ Link do Meet adicionado ao evento nativo "${atv.title}" (${ollEventId}): ${meetLinkNativo}`);

          if (dealId) {
            await criarNotaMoskit(dealId, `🔗 Link do Meet adicionado à reunião "${atv.title}": ${meetLinkNativo}${seloConsultaGratis(authNativa.motivo)}`);
          }
          await notificarTelegramMeet({ nome: atv.title, telefone: null, advogado: null, dataHoraTexto: dataFormatadaNativo, meetLink: meetLinkNativo, dealId });
          continue;
        }

        // Moskit ainda nao sincronizou essa atividade — so criamos o evento (e o Meet) quando
        // o pagamento ja estiver verificado, senao ficaria uma reuniao/link marcada sem confirmacao real.
        const auth = await autorizacaoParaAgendar(dealId);
        if (!auth.permitido) {
          relatorio.aguardando_pagamento++;
          console.log(`  ⏳ Atividade "${atv.title}" aguardando comprovante verificado — evento ainda nao sera criado`);
          continue;
        }
        if (auth.motivo === 'consulta_gratis') {
          relatorio.liberadas_consulta_gratis++;
          console.log(`  🆓 Atividade "${atv.title}" liberada SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
        }

        const inicio = new Date(atv.dueDate);
        const fim = new Date(inicio.getTime() + (atv.duration || 60) * 60 * 1000);

        // Id deterministico: se o insert der certo mas a resposta se perder (timeout, processo
        // morto antes de marcar no banco), o ciclo seguinte recebe 409 em vez de criar um evento
        // duplicado. So [a-v0-9] e aceito pelo Google.
        const eventIdAtv = `moskitatv${atv.id}`;
        let evento;
        try {
          evento = await calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            requestBody: {
              id: eventIdAtv,
              summary: atv.title || 'Consulta agendada',
              description: [
                atv.notes || '',
                dealId ? `Negócio no Moskit: https://app.ollow.com.br/?/deal/${dealId}` : '',
              ].filter(Boolean).join('\n\n'),
              start: { dateTime: inicio.toISOString() },
              end: { dateTime: fim.toISOString() },
              conferenceData: {
                createRequest: {
                  requestId: `meet-atv-${atv.id}`,
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            },
            conferenceDataVersion: 1,
          });
        } catch (e) {
          const status = e.code || e.response?.status;
          if (status !== 409) throw e;
          console.log(`  ⏭️ Evento ${eventIdAtv} ja existia no calendario — marcando como sincronizado`);
          stmtAtividadeMarcarSincronizada.run(atv.id, eventIdAtv, dealId);
          relatorio.ja_sincronizadas++;
          continue;
        }

        stmtAtividadeMarcarSincronizada.run(atv.id, evento.data.id, dealId);
        relatorio.eventos_criados++;
        console.log(`  ✅ Evento criado pra atividade "${atv.title}" (${inicio.toLocaleString('pt-BR')})`);

        const meetLink = extrairMeetLink(evento.data);
        const dataFormatada = inicio.toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });

        if (dealId) {
          await criarNotaMoskit(dealId, `📅 Reunião "${atv.title}" sincronizada com o Google Calendar (${dataFormatada})${meetLink ? `\nLink do Meet: ${meetLink}` : ''}${seloConsultaGratis(auth.motivo)}`);
        }
        await notificarTelegramMeet({
          nome: atv.title,
          telefone: null,
          advogado: null,
          dataHoraTexto: dataFormatada,
          meetLink,
          dealId,
        });
      } catch (e) {
        console.error(`  ❌ Erro ao sincronizar atividade ${atv.id}: ${e.message}`);
        relatorio.erros++;
      }
    }

    console.log(`\n📅 Sincronizacao de atividades concluida: ${relatorio.eventos_criados} eventos criados, ${relatorio.ja_sincronizadas} ja sincronizadas, ${relatorio.aguardando_pagamento} aguardando pagamento, ${relatorio.liberadas_consulta_gratis} liberadas por consulta gratis, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro na sincronizacao de atividades: ${e.message}`);
    relatorio.erros++;
  } finally {
    sincronizacaoAtividadesEmAndamento = false;
  }

  return relatorio;
}

// Adiciona link do Google Meet a eventos futuros ja existentes no calendario que ainda
// nao tem link (criados antes dessa funcionalidade existir, ou nativamente pelo Moskit).
// Roda uma vez (via rota manual), nao faz parte do ciclo periodico.
async function backfillMeetLinks(dryRun) {
  const relatorio = { eventos_verificados: 0, links_adicionados: 0, ja_tinham_link: 0, aguardando_pagamento: 0, liberadas_consulta_gratis: 0, erros: 0, candidatos: [] };
  const auth = getGoogleAuthClient();
  if (!auth) {
    console.log('  ⏭️ Google Calendar (OAuth2) nao configurado — pulando backfill de Meet links');
    return relatorio;
  }

  const calendar = google.calendar({ version: 'v3', auth });
  let pageToken;
  try {
    do {
      const res = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        timeMin: new Date().toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      const eventos = res.data.items || [];
      relatorio.eventos_verificados += eventos.length;

      for (const ev of eventos) {
        try {
          if (ev.status === 'cancelled') continue;
          // So mexe em evento que e uma consulta de verdade: tem link de negocio do Moskit
          // na descricao (evento criado pelo bot na Fase 5, ou nativamente pelo Moskit/"oll")
          // ou segue o padrao de titulo usado pelo bot na Fase 4 ("Consulta — nome (advogado)").
          // Sem esse filtro, o backfill mexe em QUALQUER evento futuro do calendario
          // (aniversarios, reunioes internas recorrentes etc.) — ja aconteceu uma vez.
          const eDeConsulta = /\/deal\/\d+/.test(ev.description || '') || /^Consulta\s*—/.test(ev.summary || '');
          if (!eDeConsulta) continue;

          if (ev.hangoutLink || ev.conferenceData?.entryPoints?.length) {
            relatorio.ja_tinham_link++;
            continue;
          }

          // Eventos com link de negocio na descricao (Fase 5 / nativos do Moskit) so ganham Meet
          // se ja houver comprovante verificado — os "Consulta — " (Fase 4) ja nasceram gated.
          const dealMatch = (ev.description || '').match(/\/deal\/(\d+)/);
          const dealId = dealMatch ? Number(dealMatch[1]) : null;

          let motivoLiberacao = null;
          if (dealId) {
            const authBackfill = await autorizacaoParaAgendar(dealId);
            if (!authBackfill.permitido) {
              relatorio.aguardando_pagamento++;
              console.log(`  ⏳ Evento "${ev.summary}" aguardando comprovante verificado — Meet ainda nao sera adicionado`);
              continue;
            }
            motivoLiberacao = authBackfill.motivo;
            if (motivoLiberacao === 'consulta_gratis') {
              relatorio.liberadas_consulta_gratis++;
              console.log(`  🆓 Evento "${ev.summary}" liberado SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
            }
          }

          if (dryRun) {
            relatorio.candidatos.push({ id: ev.id, summary: ev.summary, start: ev.start?.dateTime || ev.start?.date, motivo: motivoLiberacao });
            continue;
          }

          const patched = await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ev.id,
            conferenceDataVersion: 1,
            requestBody: {
              conferenceData: {
                createRequest: { requestId: `meet-backfill-${ev.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
              },
            },
          });
          const meetLink = extrairMeetLink(patched.data);
          relatorio.links_adicionados++;
          console.log(`  ✅ Link do Meet adicionado ao evento "${ev.summary}": ${meetLink}`);

          const dataHoraTexto = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });

          if (dealId) {
            await criarNotaMoskit(dealId, `🔗 Link do Meet adicionado à reunião já agendada: ${meetLink}${seloConsultaGratis(motivoLiberacao)}`).catch((e) => {
              console.error(`  ❌ Erro ao anotar link no deal ${dealId}: ${e.message}`);
            });
          }
          await notificarTelegramMeet({ nome: ev.summary, telefone: null, advogado: null, dataHoraTexto, meetLink, dealId });
        } catch (e) {
          relatorio.erros++;
          console.error(`  ❌ Erro ao adicionar Meet no evento ${ev.id}: ${e.message}`);
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);

    console.log(`\n🔗 Backfill de Meet concluido: ${relatorio.links_adicionados} links adicionados, ${relatorio.ja_tinham_link} ja tinham, ${relatorio.aguardando_pagamento} aguardando pagamento, ${relatorio.liberadas_consulta_gratis} liberadas por consulta gratis, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro no backfill de Meet links: ${e.message}`);
    relatorio.erros++;
  }

  return relatorio;
}

async function sincronizarConversas() {
  const relatorio = { conversas_encontradas: 0, atualizadas: 0, novas_mensagens: 0, erros: 0 };

  try {
    console.log('\n🔁 Iniciando sincronizacao com API Zernio...');

    const { data: convResp } = await axios.get('https://zernio.com/api/v1/inbox/conversations', {
      params: { platform: 'whatsapp', limit: 100, sortOrder: 'desc' },
      headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },
      validateStatus: (s) => s < 500,
    });

    const conversations = convResp?.data || [];
    relatorio.conversas_encontradas = conversations.length;
    console.log(`  📞 ${conversations.length} conversas WhatsApp encontradas na API`);

    for (const conv of conversations) {
      const phone = chaveConversa(conv.participantId);
      const contactName = conv.participantName || phone;
      if (!phone) continue;

      // O polling tambem precisa da trava: era por aqui que a conversa interna era gravada e
      // enfileirada, mesmo com o webhook barrando na outra ponta.
      if (ehInterno(phone)) continue;

      const row = stmtGet.get(phone);
      const lastActivity = row?.last_activity ? new Date(row.last_activity).getTime() : 0;

      if (row && new Date(conv.updatedTime).getTime() <= lastActivity) {
        continue;
      }

      try {
        const { data: msgsResp } = await axios.get(
          `https://zernio.com/api/v1/inbox/conversations/${conv.id}/messages`,
          {
            params: { accountId: conv.accountId, limit: 100, sortOrder: 'asc' },
            headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },
            validateStatus: (s) => s < 500,
          }
        );

        const msgsApi = msgsResp?.messages || [];
        if (!msgsApi.length) continue;

        const mensagensExistentes = row ? JSON.parse(row.messages) : [];
        // Dedup por id_zernio OU por conteudo (so texto longo nao-anexo). Antes era so por id, e
        // mensagem gravada pelo webhook — que nao tinha id — era invisivel aqui, fazendo o historico
        // inteiro ser re-adicionado.
        let novas = 0;
        const audiosPendentes = [];

        for (const m of msgsApi) {
          if (m.direction !== 'incoming' && m.direction !== 'outgoing') continue;

          const role = m.direction === 'outgoing' ? 'equipe' : 'cliente';
          let texto;
          let audioAtt = null;
          if (m.attachments && m.attachments.length > 0) {
            const att = m.attachments[0];
            const quem = role === 'equipe' ? 'equipe enviou' : 'cliente enviou';
            texto = att.filename ? `📎 [${quem}: ${att.filename}]` : `📎 [${quem} ${att.type}]`;
            // Rede de seguranca para os audios que o webhook perdeu (bot fora do ar, reentrega
            // falha). Transcreve depois de salvar, fire-and-forget — nao segura o ciclo de polling.
            if (role === 'cliente' && att.type === 'audio') audioAtt = att;
          } else {
            texto = m.message || '';
          }
          if (!texto) continue;

          const nova = { role, text: texto, timestamp: m.createdAt, id_zernio: m.id };
          if (jaExiste(nova, mensagensExistentes)) continue;
          mensagensExistentes.push(nova);
          novas++;
          if (audioAtt && m.id) audiosPendentes.push({ att: audioAtt, id: m.id });
        }

        if (novas > 0) {
          // Ordena por timestamp: o polling insere mensagens ANTIGAS no fim do array (relogio do
          // Zernio x hora de chegada no webhook), e montarHistorico renderiza na ordem do array —
          // sem isso o historico mostra os dias voltando no tempo.
          const mensagensFinais = normalizarMensagens(mensagensExistentes);
          stmtUpsert.run(phone, phone, contactName, JSON.stringify(mensagensFinais), conv.updatedTime);
          relatorio.atualizadas++;
          relatorio.novas_mensagens += novas;
          console.log(`  ✅ ${phone} (${contactName}): +${novas} mensagens`);

          for (const { att, id } of audiosPendentes) {
            processarAudioCliente(phone, att, id)
              .catch((e) => console.error(`  ❌ Erro ao transcrever audio de ${phone} (polling): ${e.message}`));
          }

          if (mensagensExistentes.length > 0) {
            const inativo = Date.now() - new Date(conv.updatedTime).getTime();
            // Sempre pelo helper: a atribuicao direta em `timers` que existia aqui nao fazia
            // clearTimeout, entao a cada ciclo de polling o timer anterior ficava vivo e a mesma
            // conversa era processada mais de uma vez.
            const restante = Math.max(0, TEMPO_INATIVIDADE_MS - inativo);
            agendarProcessamento(phone, restante);
          }
        }
      } catch (e) {
        console.error(`  ❌ Erro ao sincronizar ${phone}: ${e.message}`);
        relatorio.erros++;
      }
    }

    console.log(`\n🔁 Sincronizacao concluida: ${relatorio.conversas_encontradas} conversas, ${relatorio.atualizadas} atualizadas, ${relatorio.novas_mensagens} novas mensagens, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro na sincronizacao: ${e.message}`);
    relatorio.erros++;
  }

  return relatorio;
}

// ------------------------------------------------------------
// Importar contatos do Moskit
// ------------------------------------------------------------
async function importarContatosMoskit() {
  let nextToken = '';
  let total = 0;
  let importados = 0;

  console.log('\n📥 Importando contatos do Moskit...');

  while (true) {
    const params = { limit: 100 };
    if (nextToken) params.nextPageToken = nextToken;
    try {
      const res = await axios.get(`${MOSKIT_BASE}/contacts`, {
        params,
        headers: apiHeaders,
        validateStatus: (s) => s < 500,
      });
      const contatos = res.data || [];
      if (!contatos.length) break;

      for (const c of contatos) {
        const phones = c.phones || [];
        for (const p of phones) {
          let num = String(p.number || '').replace(/\D/g, '');
          if (num.length >= 10) {
            if (num.length > 13) num = num.slice(-13);
            stmtMoskitUpsert.run(num, c.id, c.name || '', JSON.stringify(c));
            importados++;
          }
        }
      }
      total += contatos.length;

      const headers = res.headers;
      nextToken = headers['x-moskit-listing-next-page-token'] || headers['x-ollow-listing-next-page-token'] || '';
      if (!nextToken) break;
    } catch (e) {
      console.error(`  ❌ Erro na importacao: ${e.message}`);
      break;
    }
  }

  console.log(`  ✅ ${importados} telefones importados de ${total} contatos do Moskit`);
  return { total_contatos: total, telefones_importados: importados };
}

// ------------------------------------------------------------
// Backfill: criar deals pendentes
// ------------------------------------------------------------
async function backfillDeals() {
  const relatorio = { processados: 0, deals_criados: 0, deals_existentes: 0, erros: 0 };

  console.log('\n🔙 Backfill: buscando conversas criar sem deal_id...');

  const rows = db.prepare("SELECT chat_id, contact_name, phone, last_data FROM conversations WHERE last_action = 'criar' AND deal_id IS NULL").all();

  relatorio.processados = rows.length;
  console.log(`  ${rows.length} conversas encontradas`);

  for (const row of rows) {
    const chatId = row.chat_id;
    const phone = chaveConversa(row.phone || chatId);
    const dados = row.last_data ? JSON.parse(row.last_data) : {};

    // Esta rota criava negocio SEM nenhuma checagem de numero interno — era o caminho mais direto
    // para um socio virar deal, bastando a conversa dele ter ficado com last_action='criar'.
    if (ehInterno(phone) || ehInterno(chatId)) {
      console.log(`  ⏭️ ${chatId} e numero interno — nao cria deal`);
      stmtUpdateProcessed.run(JSON.stringify({}), 'interno', chatId);
      relatorio.ignorados = (relatorio.ignorados || 0) + 1;
      continue;
    }

    try {
      // Buscar contato no Moskit
      let contactId = null;
      const contatoLocal = stmtMoskitGet.get(phone);
      if (contatoLocal) {
        contactId = contatoLocal.moskit_id;
        console.log(`  📞 Contato local encontrado: ${contatoLocal.name} (${contactId})`);
      } else {
        // Buscar na API do Moskit
        const listRes = await axios.get(`${MOSKIT_BASE}/contacts`, {
          params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
          headers: apiHeaders, validateStatus: (s) => s < 500,
        });
        const contatos = Array.isArray(listRes.data) ? listRes.data : [];
        // Menos de 8 digitos nao e suficiente pra identificar um telefone com seguranca
        // (evita falso-positivo tipo ".includes()" casando com qualquer numero que contenha o mesmo trecho)
        const sufixo = phone.slice(-8);
        if (sufixo.length >= 8) {
          for (const c of contatos) {
            const phones = (c.phones || []).map(p => String(p.number || '').replace(/\D/g, ''));
            if (phones.some(p => p.includes(sufixo))) {
              contactId = c.id;
              console.log(`  📞 Contato via API: ${c.name} (${contactId})`);
              break;
            }
          }
        }
      }

      if (!contactId) {
        console.log(`  ❌ Contato nao encontrado para ${phone} — pulando`);
        relatorio.erros++;
        continue;
      }

      // Verificar se ja existe deal para este contato
      let dealId = null;
      const dealsRes = await axios.get(`${MOSKIT_BASE}/deals`, {
        params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
        headers: apiHeaders, validateStatus: (s) => s < 500,
      });
      const deals = Array.isArray(dealsRes.data) ? dealsRes.data : [];
      for (const d of deals) {
        try {
          const { data: det } = await axios.get(`${MOSKIT_BASE}/deals/${d.id}`, {
            headers: apiHeaders, validateStatus: (s) => s < 500,
          });
          const conts = (det?.contacts || []).map(x => String(x.id));
          if (conts.includes(String(contactId))) {
            dealId = d.id;
            break;
          }
        } catch {}
      }

      if (dealId) {
        console.log(`  ✅ Deal ja existe: ${dealId} — salvando no banco`);
        db.prepare("UPDATE conversations SET deal_id = ?, updated_at = datetime('now') WHERE chat_id = ?").run(dealId, chatId);
        relatorio.deals_existentes++;
      } else {
        console.log(`  🔶 Criando novo deal para ${phone}...`);
        try {
          const deal = await criarNegocioMoskit(dados, contactId);
          console.log(`  ✅ Deal criado: ${deal.id}`);
          db.prepare("UPDATE conversations SET deal_id = ?, updated_at = datetime('now') WHERE chat_id = ?").run(deal.id, chatId);

          if (dados.resumo_atendimento) {
            await criarNotaMoskit(deal.id, `📋 Briefing\n\n${dados.resumo_atendimento}`);
          }

          relatorio.deals_criados++;
        } catch (e) {
          console.error(`  ❌ Erro ao criar deal: ${e.message}`);
          relatorio.erros++;
        }
      }
    } catch (e) {
      console.error(`  ❌ Erro ao processar ${chatId}: ${e.message}`);
      relatorio.erros++;
    }
  }

  console.log(`\n🔙 Backfill concluido: ${relatorio.processados} processados, ${relatorio.deals_criados} criados, ${relatorio.deals_existentes} existentes, ${relatorio.erros} erros`);
  return relatorio;
}

// Transporte comum do download de anexos da Zernio (comprovante e audio): streama para o disco e
// devolve o caminho do arquivo, ou null se nao conseguiu baixar.
async function baixarParaArquivo(url, caminho) {
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      headers: ZERNIO_API_KEY ? { apikey: ZERNIO_API_KEY } : {},
    });
    const writer = fs.createWriteStream(caminho);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return caminho;
  } catch (e) {
    console.error(`  ❌ Erro ao baixar anexo: ${e.message}`);
    return null;
  }
}

async function baixarComprovante(phone, att) {
  const url = att.url || att.downloadUrl || att.payload?.url;
  if (!url) {
    console.log('  ⏭️ Sem URL para download do anexo');
    return null;
  }
  const nome = att.payload?.filename || att.payload?.name || (att.type === 'image' ? 'imagem.jpeg' : 'documento.pdf');
  const pasta = path.join(__dirname, 'comprovantes', phone);
  fs.mkdirSync(pasta, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = path.join(pasta, `${timestamp}_${nome}`);
  const baixado = await baixarParaArquivo(url, caminho);
  if (baixado) console.log(`  💾 Comprovante salvo: ${caminho}`);
  return baixado;
}

// ------------------------------------------------------------
// Transcricao de audio (cliente) — ver src/transcricao.js
// ------------------------------------------------------------
// Extensoes que a API de transcricao aceita. Voice notes do WhatsApp sao .ogg (Android) ou
// .m4a (iPhone). O SDK infere o MIME pelo nome do arquivo, entao o default importa.
const EXTENSOES_AUDIO_VALIDAS = new Set(['.ogg', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.wav', '.webm', '.flac']);

function baixarAnexoAudio(phone, att) {
  const url = att.url || att.downloadUrl || att.payload?.url;
  if (!url) {
    console.log('  🎧 Sem URL para download do audio');
    return null;
  }
  const nomeBruto = att.payload?.filename || att.payload?.name || '';
  const ext = path.extname(nomeBruto).toLowerCase();
  const nome = nomeBruto && EXTENSOES_AUDIO_VALIDAS.has(ext)
    ? nomeBruto
    : (nomeBruto ? `${nomeBruto}.ogg` : 'audio.ogg');
  const pasta = path.join(__dirname, 'comprovantes', phone);
  fs.mkdirSync(pasta, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = path.join(pasta, `${timestamp}_${nome}`);
  return baixarParaArquivo(url, caminho).then((baixado) => {
    if (baixado) console.log(`  🎧 Audio salvo: ${caminho}`);
    return baixado;
  });
}

// Fila de transcricoes por chat: dois audios seguidos na mesma conversa nao podem ler o mesmo
// snapshot do array de mensagens (o segundo sobrescreveria a transcricao do primeiro). As tarefas
// encadeiam por chat e a entrada e removida so pela ultima.
const transcricoesEmAndamento = new Map();

// Baixa, transcreve e registra o texto do audio no historico. Falha em qualquer etapa mantem o
// placeholder — a conversa segue processando sem o conteudo. `transcreve` e injetavel (teste).
async function processarAudioCliente(chatId, att, idZernio, transcreve = transcreverAudio) {
  const anterior = transcricoesEmAndamento.get(chatId) || Promise.resolve();
  const proxima = anterior
    .catch(() => {}) // falha de um audio nao bloqueia o proximo da mesma conversa
    .then(async () => {
      const caminho = await baixarAnexoAudio(chatId, att);
      if (!caminho) return;
      const texto = await transcreve(caminho);
      if (!texto) return;
      await atualizarTranscricaoNaConversa(chatId, idZernio, texto);
    });
  transcricoesEmAndamento.set(chatId, proxima);
  return proxima.finally(() => {
    if (transcricoesEmAndamento.get(chatId) === proxima) transcricoesEmAndamento.delete(chatId);
  });
}

// Substitui o placeholder do audio pela transcricao dentro do historico, preservando role e
// timestamp da mensagem original. Idempotente: reentrega do webhook nao transcreve de novo.
function atualizarTranscricaoNaConversa(chatId, idZernio, texto) {
  if (!idZernio || !texto) return false;
  const row = stmtGet.get(chatId);
  if (!row) return false;
  const mensagens = JSON.parse(row.messages || '[]');
  const alvo = mensagens.find((m) => m.id_zernio === idZernio);
  if (!alvo) {
    console.log(`  🎧 mensagem ${idZernio} nao encontrada na conversa ${chatId} — transcricao descartada`);
    return false;
  }
  if (String(alvo.text || '').startsWith('🎧')) {
    console.log(`  🎧 mensagem ${idZernio} ja transcrita — ignorando`);
    return false;
  }
  alvo.text = `🎧 Transcrição do áudio: ${texto}`;
  db.prepare("UPDATE conversations SET messages = ?, updated_at = datetime('now') WHERE chat_id = ?").run(
    JSON.stringify(mensagens), chatId
  );
  console.log(`  🎧 Audio de ${chatId} transcrito (${texto.length} chars)`);
  // Reagenda do zero: o timer comeca a contar da transcricao, entao o pipeline (5 min depois)
  // enxerga o conteudo em vez de rodar com apenas o placeholder.
  agendarProcessamento(chatId);
  return true;
}

async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: 'Markdown',
    });
    console.log(`  ✅ Notificacao enviada ao Telegram`);
  } catch (e) {
    console.error(`  ❌ Erro ao notificar Telegram: ${e.message}`);
  }
}

async function notificarTelegramMeet({ nome, telefone, advogado, dataHoraTexto, meetLink, dealId, remarcado }) {
  const texto = [
    remarcado ? `🔁 *Consulta remarcada!*` : (meetLink ? `📅 *Nova consulta com Meet pronto!*` : `📅 *Nova consulta agendada (presencial)!*`),
    `Cliente: ${nome || 'nao informado'}${telefone ? ` (${telefone})` : ''}`,
    `Advogado: ${advogado || 'a definir'}`,
    remarcado ? `Novo horário: ${dataHoraTexto}` : `Quando: ${dataHoraTexto}`,
    meetLink ? (remarcado ? `Link do Meet (o mesmo de antes): ${meetLink}` : `Link do Meet: ${meetLink}`) : '',
    dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
    '',
    meetLink
      ? (remarcado
        ? 'Avise o cliente e o advogado responsável do novo horário no WhatsApp (o link do Meet continua o mesmo).'
        : 'Copie o link e envie pro cliente e pro advogado responsável no WhatsApp.')
      : 'Avise o cliente e o advogado responsável do horário combinado (sem link de videochamada).',
  ].filter(Boolean).join('\n');
  await enviarTelegram(texto);
}

function extrairMeetLink(eventoData) {
  if (!eventoData) return null;
  if (eventoData.hangoutLink) return eventoData.hangoutLink;
  const entryPoints = eventoData.conferenceData?.entryPoints || [];
  return entryPoints.find((e) => e.entryPointType === 'video')?.uri || null;
}

async function notificarTelegram(phone, att, caminho) {
  const tipo = att.type === 'image' ? 'imagem' : att.type === 'document' || att.type === 'file' ? 'documento' : att.type;
  const nome = att.payload?.filename || att.payload?.name || '';
  let texto = `📸 *NOVO COMPROVANTE*\nCliente: \`${phone}\`\nTipo: ${tipo}`;
  if (nome) texto += `\nArquivo: ${nome}`;
  if (caminho) texto += `\nSalvo em: \`${caminho}\``;
  await enviarTelegram(texto);
}

const PROMPT_COMPROVANTE = `
Analise esta imagem de um comprovante de pagamento (PIX, transferencia ou cartao) enviado por um cliente de escritorio de advocacia.

Extraia o valor pago e avalie se a imagem realmente parece um comprovante de pagamento valido.

REGRAS:
- Se a imagem estiver ilegivel, cortada, ou voce nao tiver certeza do valor, marque parece_comprovante como false e valor_pago_centavos como null. NUNCA chute um valor que voce nao consegue ler com clareza.
- valor_pago_centavos deve ser o valor total pago, em centavos (ex: R$350,00 vira 35000).
- confianca de 0 a 10 sobre sua propria leitura do valor.

Retorne APENAS um JSON no formato:
{"parece_comprovante": true, "valor_pago_centavos": 35000, "confianca": 9, "observacao": "Comprovante de PIX no valor de R$350,00"}
`;

async function verificarComprovante(caminho) {
  const resultadoPadrao = { parece_comprovante: false, valor_pago_centavos: null, confianca: 0, observacao: 'Nao verificado' };
  if (!caminho) return resultadoPadrao;

  try {
    const buffer = fs.readFileSync(caminho);
    const ext = path.extname(caminho).toLowerCase().replace('.', '') || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const conteudo = await openaiChat([
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT_COMPROVANTE },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ], 'json');

    if (!conteudo) return resultadoPadrao;
    const parsed = JSON.parse(conteudo);
    return {
      parece_comprovante: !!parsed.parece_comprovante,
      valor_pago_centavos: typeof parsed.valor_pago_centavos === 'number' ? parsed.valor_pago_centavos : null,
      confianca: Number(parsed.confianca) || 0,
      observacao: parsed.observacao || '',
    };
  } catch (e) {
    console.error(`  ❌ Erro ao verificar comprovante: ${e.message}`);
    return { ...resultadoPadrao, observacao: 'Erro ao processar imagem: ' + e.message };
  }
}

async function processarComprovante(chatId, phone, caminho) {
  const resultado = await verificarComprovante(caminho);
  const match = resultado.parece_comprovante
    && resultado.valor_pago_centavos !== null
    && resultado.confianca >= 7
    && resultado.valor_pago_centavos >= COMPROVANTE_VALOR_ESPERADO_CENTAVOS;

  stmtComprovanteInsert.run({
    chat_id: chatId,
    phone,
    caminho_arquivo: caminho,
    valor_pago_centavos: resultado.valor_pago_centavos,
    confianca: resultado.confianca,
    parece_comprovante: resultado.parece_comprovante ? 1 : 0,
    observacao: resultado.observacao,
    match: match ? 1 : 0,
    notificado_telegram: 1,
  });

  const valorFormatado = resultado.valor_pago_centavos !== null ? `R$${(resultado.valor_pago_centavos / 100).toFixed(2)}` : 'ilegível';
  const valorEsperadoFormatado = `R$${(COMPROVANTE_VALOR_ESPERADO_CENTAVOS / 100).toFixed(2)}`;

  if (match) {
    await enviarTelegram(`✅ *Comprovante confere*\nCliente: \`${phone}\`\nValor lido: ${valorFormatado} (esperado ${valorEsperadoFormatado})`);
  } else {
    await enviarTelegram(`⚠️ *Comprovante NÃO confere — revisar manualmente*\nCliente: \`${phone}\`\nValor lido: ${valorFormatado} (esperado ${valorEsperadoFormatado})\nObs: ${resultado.observacao}`);
  }

  // Registra o resultado no historico da conversa pra IA de classificacao/extracao enxergar
  try {
    const row = stmtGet.get(chatId);
    if (row) {
      const mensagens = JSON.parse(row.messages || '[]');
      mensagens.push({
        role: 'sistema',
        text: match
          ? `✅ Comprovante verificado: ${valorFormatado} confirmado`
          : `⚠️ Comprovante recebido mas NÃO confere (valor lido: ${valorFormatado}, esperado ${valorEsperadoFormatado})`,
        timestamp: new Date().toISOString(),
      });
      db.prepare('UPDATE conversations SET messages = ? WHERE chat_id = ?').run(JSON.stringify(mensagens), chatId);
    }
  } catch (e) {
    console.error(`  ❌ Erro ao registrar verificacao no historico: ${e.message}`);
  }

  return { ...resultado, match };
}

// ------------------------------------------------------------
// Tratamento de erros globais
// ------------------------------------------------------------
process.on('uncaughtException', (erro) => {
  console.error('\n❌ Erro nao tratado (uncaughtException):', erro.message);
  console.error(erro.stack);
});

process.on('unhandledRejection', (erro) => {
  console.error('\n❌ Promise rejeitada sem catch (unhandledRejection):', erro?.message || erro);
  if (erro?.stack) console.error(erro.stack);
});

// ------------------------------------------------------------
// Start (apenas se nao for worker)
// ------------------------------------------------------------
if (!process.env.WORKER_MODE) {
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  if (!ADMIN_TOKEN) {
    console.warn('\n⚠️  ADMIN_TOKEN nao definido — as rotas administrativas estao DESABILITADAS (503).');
    console.warn('    Defina ADMIN_TOKEN no .env para poder usar /sincronizar, /processar, backfills etc.\n');
  }
  if (!WEBHOOK_SECRET) {
    console.warn('\n⚠️  WEBHOOK_SECRET nao definido — POST /webhook esta ACEITANDO QUALQUER ORIGEM.');
    console.warn('    Quem tiver a URL do ngrok consegue injetar mensagem com role="equipe", que e a');
    console.warn('    evidencia que autoriza agendamento na dupla confirmacao.');
    console.warn('    Defina WEBHOOK_SECRET no .env com o MESMO valor cadastrado no Zernio (Settings');
    console.warn('    > Webhooks > secret) — a assinatura HMAC no header X-Zernio-Signature passa a');
    console.warn('    ser exigida em toda entrega.\n');
  } else {
    console.log(`   Webhook autenticado: POST /webhook exige assinatura HMAC valida (X-Zernio-Signature)`);
  }
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);

  if (DEPLOY_WEBHOOK_SECRET) {
    console.log(`   Auto-deploy: POST /deploy-webhook ativo (branch "${DEPLOY_BRANCH}", assinatura X-Hub-Signature-256 exigida)`);
  } else {
    console.log(`   Auto-deploy: POST /deploy-webhook DESABILITADO (defina DEPLOY_WEBHOOK_SECRET no .env pra ativar)`);
  }

  const pendentes = stmtGetPending.all();
  for (const row of pendentes) {
    const inativo = Date.now() - new Date(row.last_activity).getTime();
    agendarProcessamento(row.chat_id, Math.max(0, TEMPO_INATIVIDADE_MS - inativo));
  }
  console.log(`${pendentes.length} conversas pendentes carregadas`);

  // Sincronizacao periodica: o webhook so recebe mensagens incoming; mensagens
  // enviadas pela equipe (outgoing) so aparecem via API, entao precisamos
  // puxar periodicamente pra detectar avancos no funil (proposta, contrato etc.)
  const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 3 * 60 * 1000;
  setInterval(() => {
    sincronizarConversas().catch((e) => console.error(`  ❌ Erro na sincronizacao periodica: ${e.message}`));
  }, SYNC_INTERVAL_MS);

  // Sincronizacao periodica de Atividades do Moskit (Reuniao/Videoconferencia) -> Google Calendar,
  // cobre consultas marcadas fora do fluxo do bot (Moskit Boost, agendamento manual)
  setInterval(() => {
    sincronizarAtividadesMoskit().catch((e) => console.error(`  ❌ Erro na sincronizacao de atividades: ${e.message}`));
  }, SYNC_INTERVAL_MS);

  // Expor via ngrok para receber webhooks do Zernio
  const { spawn } = require('child_process');
  const ngrokPath = process.platform === 'win32'
    ? require('path').join(__dirname, 'ngrok', 'ngrok.exe')
    : require('path').join(__dirname, 'ngrok', 'ngrok');
  // Porta propria para a API local do ngrok: a 4040 (padrao) pode estar ocupada por
  // outro agente (ex: bot de comprovantes na 3010) e ai leriamos o tunnel errado
  // A API local do ngrok fica na 4040; se ela ja estiver ocupada por outro agente, o proximo sobe
  // na 4041, e assim por diante. Nao da pra fixar por flag (--web-addr nao existe no CLI, so em
  // arquivo de config), entao varremos a faixa e pegamos o tunnel que aponta pra NOSSA porta.
  const ngrokProcess = spawn(ngrokPath, process.env.NGROK_URL
    ? ['http', String(PORT), '--url=' + process.env.NGROK_URL]
    : ['http', String(PORT)], { stdio: 'ignore', windowsHide: true });
  const NGROK_API_PORTS = [4040, 4041, 4042, 4043, 4044, 4045];
  const tentarNgrok = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      for (const apiPort of NGROK_API_PORTS) {
        try {
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
          const data = await res.json();
          // Ignora tuneis de outros projetos (ex: bot de comprovantes na 3010)
          const tunnel = data.tunnels?.find(t => String(t.config?.addr || '').endsWith(`:${PORT}`));
          const url = tunnel?.public_url;
          if (url) {
            console.log(`\n🌐 Tunnel publico (ngrok): ${url}  [api local :${apiPort}]`);
            console.log(`   Configure o webhook no Zernio para: ${url}/webhook`);
            require('fs').writeFileSync('tunnel_url.txt', url);
            return;
          }
        } catch {}
      }
    }
    console.error('\n⚠️ Nao foi possivel obter URL do ngrok');
  };
  tentarNgrok();
});
} // fim if !WORKER_MODE

// Exportar para worker process
// extrairDadosAtendimento/montarHistorico ficam exportados pra que os scripts de teste usem a MESMA
// logica do bot em vez de manter copias (que ja divergiram — ver test-cenarios-classificacao.js).
module.exports = {
  processarConversa,
  processarConversaDirect,
  equipeEnviouCondicoesDeValor,
  dealEhConsultaGratis,
  extrairDadosAtendimento,
  classificarConversa,
  montarHistorico,
  mergeDados,
  montarPayloadMoskit,
  enviarTelegram, // worker.js avisa quando desiste de uma conversa
  // Exportadas para teste (test-pipeline.js / test-guards-internos.js). Sao as funcoes novas dos
  // Lotes 1 e 2 que nao tinham nenhuma cobertura. registrarAgendamentoPendente fica de fora de
  // proposito: e totalmente observavel atraves de handleAgendamentoCalendar.
  buscarOuCriarContato,
  aplicarViradaCobranca,
  atualizarNegocioMoskit,
  handleAgendamentoCalendar,
  finalizarCiclo,
  moverParaEstagio,
  moverEstagioSeAvancar,
  criarNotaMoskit,
  fecharNegocioSeAplicavel,
  // Exportados para teste da transcricao de audio (test-transcricao.js): atualizarTranscricaoNaConversa
  // e uma operacao de banco pura, e processarAudioCliente aceita `transcreve` injetado.
  atualizarTranscricaoNaConversa,
  processarAudioCliente,
  // Exportado para teste de rota: com WORKER_MODE=1 o modulo carrega SEM subir servidor, sem ngrok,
  // sem os timers de sincronizacao e sem reprocessar as conversas pendentes. O teste chama
  // app.listen() por conta propria e exercita so o HTTP.
  app,
};
