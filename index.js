require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { validarObservacoes, ultimaObservacao, motivoHorarioImplausivel, normalizarHorarioNaive, instanteParaNaiveLocal } = require('./src/evidencia');
const { detectarBlocoCondicoes, contarAnexosIlegiveisEquipe } = require('./src/bloco-condicoes');
const { apurarDuplaConfirmacao, descreverPendencia } = require('./src/agendamento');
const { enfileirar, TEMP_DIR } = require('./src/fila');
const { jaExiste, normalizarMensagens } = require('./src/mensagens');
const { chaveConversa, ehInterno, TEAM_SUFIXOS } = require('./src/telefone');
const { transcreverAudio } = require('./src/transcricao');
const { montarPayloadAtividade, horarioNaiveParaInstante } = require('./src/atividade-moskit');
const MOSKIT_IDS = require('./src/moskit-ids');
const zapsign = require('./src/zapsign');

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

// dados.data_hora_consulta / apuracao.horarioIso sao strings NAIVE (sem Z/offset) que representam
// direto a hora do ESCRITORIO (TZ_ESCRITORIO) - ver src/evidencia.js:102-104. Pro Google Calendar,
// mandamos { dateTime: naive, timeZone: TZ_ESCRITORIO } e deixamos o GOOGLE resolver o instante -
// zero matematica de fuso do lado do bot, e funciona igual independente do fuso do SO onde o
// processo roda. Era essa dependencia — new Date(naive).toISOString() SEM timeZone no payload —
// que fazia uma reuniao marcada pras 17h30 (hora do escritorio) virar 17h30 UTC quando o processo
// roda numa VPS sem fuso configurado (Ubuntu cloud vem em UTC por padrao): 3h mais cedo do que foi
// combinado. Pra exibicao (notas/Telegram) e pra somar duracao, tratamos a string como se fosse UTC
// so como TRUQUE DE CALCULO (Brasil nao tem horario de verao desde 2019, entao "+1h de relogio" ==
// "+1h real" para TZ_ESCRITORIO) — nunca usar esse valor como o instante real enviado a uma API
// externa sem o timeZone explicito ao lado.
// horarioNaiveValido (`!isNaN(Date.parse(iso + 'Z'))`) foi removido: aceitava qualquer coisa que o
// Date parseasse, inclusive "2026-08-05T17:30:00.000" com milissegundos, que passava aqui e era
// recusada pela regex de horarioNaiveParaInstante — evento no Google sem a atividade no Moskit. Quem
// valida horario agora e normalizarHorarioNaive/motivoHorarioImplausivel (src/evidencia.js), que
// exigem formato exato e devolvem MOTIVO nomeado em vez de um booleano.
function somarMinutosNaive(isoNaive, minutos) {
  const d = new Date(`${isoNaive}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutos);
  return d.toISOString().slice(0, 19);
}
function formatarHorarioEscritorio(isoNaive) {
  if (!isoNaive) return null;
  const d = new Date(`${isoNaive}Z`);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', { timeZone: 'UTC' }); // 'UTC' aqui = nao girar de novo
}

// Valor da consulta (aceita igual ou maior — pagamento por cartao pode ter acrescimo)
const COMPROVANTE_VALOR_ESPERADO_CENTAVOS = Number(process.env.COMPROVANTE_VALOR_ESPERADO_CENTAVOS) || 35000;

// Funil de vendas completo (pipeline "Funil de Vendas", id 40631), em ordem de avanco.
// priority vem direto do GET /stages do Moskit — usado pra nunca deixar o funil andar pra tras.
const FUNIL_DRY_RUN = process.env.FUNIL_DRY_RUN !== 'false'; // default true (so anota, nao move de verdade)
// Fechar um negocio (ganho/perdido) e mais consequente e mais novo que avancar de estagio — flag
// separada de FUNIL_DRY_RUN de proposito, pra poder ligar o avanco de estagio primeiro, observar,
// e so depois (com confianca independente) ligar o fechamento automatico.
const FUNIL_FECHAMENTO_DRY_RUN = process.env.FUNIL_FECHAMENTO_DRY_RUN !== 'false'; // default true
// Desliga a escrita na AGENDA do Moskit (a Atividade que representa a consulta) sem precisar de
// redeploy: basta mudar o .env na VPS e reiniciar. E botao de emergencia, nao encenacao.
//
// ATENCAO — a comparacao aqui e INVERTIDA em relacao as duas flags acima (`=== 'true'` em vez de
// `!== 'false'`), de proposito: esta flag default FALSE, ou seja, a agenda funciona por padrao. As
// outras seguram PALPITE DE IA sobre estagio de funil, e por isso nascem desligadas; aqui a regra e
// deterministica — houve dupla confirmacao de cliente e equipe, entao a consulta existe e tem que
// aparecer na agenda. Nao "conserte" esta linha para `!== 'false'`: isso desligaria a funcionalidade
// em producao em silencio (ha teste cobrindo os dois caminhos).
const AGENDA_MOSKIT_DRY_RUN = process.env.AGENDA_MOSKIT_DRY_RUN === 'true'; // default FALSE
// Janela de urgencia para reenviar Telegram de pendencia de agendamento MESMO com o hash de dedup
// repetido — ver registrarAgendamentoPendente. Medido em 14/08/2026 (deals 48292471/48287898): a
// dupla confirmacao corretamente identificou a pendencia (motivo falta_cliente), mas nenhum campo do
// modelo carregava o horario novo naquela rodada, entao nao havia CONTEUDO novo pra furar o dedup — a
// reuniao ja marcada ficou horas presa no horario velho, perto da hora do cliente aparecer, sem
// nenhum aviso novo. Perto o bastante da reuniao, o aviso tem que repetir mesmo sem conteudo novo:
// a PROXIMIDADE e o sinal de urgencia, nao depende do modelo acertar nada.
const AGENDAMENTO_URGENCIA_HORAS = Number(process.env.AGENDAMENTO_URGENCIA_HORAS) || 48;
// Janela (maior, em DIAS) usada so por reconciliarPendenciasAgendamento — a rede de seguranca pra
// conversa que PAROU de vez (nenhuma mensagem nova de nenhum lado, entao nunca mais e reprocessada e
// a escalada por proximidade acima nunca roda pra ela). Maior que AGENDAMENTO_URGENCIA_HORAS de
// proposito: aquela e a escalada de uma conversa ATIVA (reage rodada a rodada, tanto faz avisar so na
// vespera); esta e a unica chance de avisar sobre uma conversa muda, entao precisa de mais
// antecedencia. Medido em 14/08/2026, deal 48466404 (Teresinha): pagou, perguntou o endereco do
// escritorio, e a consulta ficaria descoberta ate a antecedencia de 48h se essa varredura usasse a
// mesma janela da escalada ativa.
const AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS = Number(process.env.AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS) || 7;
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
// Teto da varredura de atividades. Cada pagina traz 10 (ver listarAtividadesMoskit), entao 20
// paginas = 200 atividades por ciclo — a varredura completa da base em 12/08/2026 devolveu 190
// registros unicos, ou seja, hoje o teto cobre tudo com folga e `truncou` nunca dispara.
//
// E teto, nao janela: a varredura para sozinha na primeira pagina incompleta. Serve so para uma base
// que cresca muito, e mesmo ai o essencial esta coberto — a lista vem por id desc (ordem de criacao)
// e cada atividade so precisa ser vista UMA vez, porque depois disso fica em
// atividades_sincronizadas e nunca mais entra na conta.
//
// O teto efetivo de 10 que existia antes nao era uma escolha: era `?page=` sendo ignorado em
// silencio pela API.
const MAX_PAGINAS_ATIVIDADES = Number(process.env.MAX_PAGINAS_ATIVIDADES) || 20;
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
// Atividade criada no Moskit para a consulta desta conversa — e o compromisso na AGENDA do CRM,
// irmao do evento em evento_calendar_id. Guarda o id para (a) nao criar duas e (b) mover o horario
// junto quando a consulta e remarcada. Antes disto o agendamento so existia no Google Agenda e como
// texto de nota: quem trabalha dentro do Moskit nao via a consulta em lugar nenhum.
try { db.exec("ALTER TABLE conversations ADD COLUMN atividade_moskit_id INTEGER"); } catch {}
// Contrato de Prestacao de Servico gerado no ZapSign — mesmo espirito das colunas de agendamento
// acima. contrato_zapsign_criado e o guard de idempotencia (so gera uma vez por deal);
// _doc_token identifica o documento pro webhook de status; _pendente_hash/_erro_hash dedupam
// nota de dado faltante vs. falha real de API, mesma distincao de agendamento_pendente_hash vs
// agendamento_erro_hash.
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_criado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_doc_token TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_status TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_pendente_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_erro_hash TEXT"); } catch {}
// Ultimo valor que o BOT escreveu em cada campo personalizado do deal, no formato
// {"<CF_id>": [options]}. E a memoria que permite distinguir "o CRM tem o valor que eu mesmo
// escrevi" de "alguem da equipe corrigiu na mao": divergencia => humano mexeu.
try { db.exec("ALTER TABLE conversations ADD COLUMN custom_fields_bot TEXT"); } catch {}
// Ids de campo personalizado travados por edicao humana (JSON array). Trava permanente: uma vez que a
// equipe corrigiu um campo, o bot nunca mais o reescreve, mesmo que a IA mude de opiniao depois.
try { db.exec("ALTER TABLE conversations ADD COLUMN campos_travados TEXT"); } catch {}
// Hashes de nota: briefing (para repostar quando o resumo do caso mudar de verdade) e nota de campos
// preenchidos (para nao repetir a MESMA nota a cada ciclo — o deal 48423360 acumulou 6 identicas).
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN campos_nota_hash TEXT"); } catch {}
// Ultima apuracao de dupla confirmacao desta conversa (JSON): as observacoes de horario validadas,
// as duas pernas escolhidas e o motivo, quando nao fechou. Existe porque essa decisao so vivia num
// console.log: quando o cliente do deal 47543238 esperou sozinho na sala e o do 48226006 ficou com a
// reuniao no dia velho, nao havia como saber, depois do fato, se a perna do cliente nao foi emitida
// pelo modelo ou se foi descartada na validacao — as duas hipoteses levam a correcoes opostas.
// Guarda o ESTADO ATUAL (uma linha por conversa), nao historico: e o espelho da ultima rodada.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_apuracao TEXT"); } catch {}
// Hash do ultimo conjunto de valores que a IA devolveu e que nao existem na lista do CRM. Sem isso o
// campo apenas nao era enviado e ninguem no escritorio ficava sabendo — e um valor recorrente ("Direito
// Civil") continuava caindo no vazio indefinidamente em vez de virar apelido em src/moskit-ids.js.
try { db.exec("ALTER TABLE conversations ADD COLUMN opcao_invalida_hash TEXT"); } catch {}
// Hash da ultima divergencia (bruta, nao aplicada) entre o `data_hora_consulta` que o modelo devolveu
// nesta rodada e o `dadosEvento.data_hora_consulta` que a apuracao efetivamente manteve — sinal de que
// a apuracao fechou com um valor diferente do que o proprio modelo entendeu. Coluna PROPOSITALMENTE
// separada de agendamento_pendente_hash/agendamento_erro_hash: sao avisos com ciclo de vida diferente
// (aquelas zeram quando o evento e criado/remarcado; esta e so um log de auditoria, nao depende disso).
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_divergencia_hash TEXT"); } catch {}
// Ultimo agendamento_pendente_hash que ja gerou aviso da reconciliacao periodica
// (reconciliarPendenciasAgendamento) — dedup PROPRIO, separado de agendamento_pendente_hash. Existe
// porque uma conversa SILENCIOSA (sem mensagem nova de nenhum lado) nunca e reprocessada de novo —
// medido em 14/08/2026 no deal 48466404 (Teresinha): ela pagou e perguntou o endereco do escritorio,
// claramente achando que a consulta esta marcada, mas a dupla confirmacao nunca fechou (dia ambiguo,
// "quarta ou quinta") e a conversa parou de receber mensagem. A escalada por proximidade dentro de
// registrarAgendamentoPendente so roda quando a conversa E REPROCESSADA — uma conversa muda nunca
// aciona isso. Levantamento em produção achou 17 negocios parados assim, alguns ha mais de uma semana.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_pendencia_avisada TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_contrato_zapsign_doc_token ON conversations(contrato_zapsign_doc_token)"); } catch {}

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

// Assunto que o prompt manda usar quando ninguem descreveu o caso ainda. Nao e um palpite de area \u2014
// e o placeholder honesto, e por isso passa pelo gate do caso descrito (ver processarConversaDirect).
// Com acento porque vai pro TITULO do negocio no CRM, que e texto lido por gente. A comparacao em
// ehAssuntoNeutro normaliza acentos, entao o "Consulta juridica" sem acento que o prompt manda o modelo
// devolver casa com este valor.
const ASSUNTO_NEUTRO = 'Consulta jurídica';
function ehAssuntoNeutro(assunto) {
  const normalizar = (s) => removerAcentos(String(s || '').toLowerCase().trim());
  return normalizar(assunto) === normalizar(ASSUNTO_NEUTRO);
}

function removerEmoji(str) {
  return String(str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\ufe0f]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Tabelas de ID vem de src/moskit-ids.js — fonte unica, importada tambem pelos scripts. Aqui usamos o
// INDICE_BUSCA (canonicas + apelidos, tudo normalizado), nao as tabelas cruas: a busca de opcao exige
// correspondencia exata, entao "Dr. Berto" ou "familia" so chegam ao ID certo pelo indice.
const MAPEAMENTO_ORIGEM = MOSKIT_IDS.INDICE_BUSCA.ORIGEM;
const MAPEAMENTO_TIPO_CONSULTA = MOSKIT_IDS.INDICE_BUSCA.TIPO_CONSULTA;
const MAPEAMENTO_CAPTACAO = MOSKIT_IDS.INDICE_BUSCA.CAPTACAO;
const MAPEAMENTO_AREA_DIREITO = MOSKIT_IDS.INDICE_BUSCA.AREA_DIREITO;
const MAPEAMENTO_RESPONSAVEL_PROCESSO = MOSKIT_IDS.INDICE_BUSCA.RESPONSAVEL_PROCESSO;

// Campos de opcao que o bot classifica, com o nome que a equipe ve no CRM. Usado para detectar valor
// que a IA inventou (detectarOpcoesInvalidas) e para nomear campo em nota/log.
const CAMPOS_CLASSIFICACAO = [
  { campo: 'origem', nome: 'Origem', mapa: MAPEAMENTO_ORIGEM },
  { campo: 'tipo_consulta', nome: 'Tipo de Consulta', mapa: MAPEAMENTO_TIPO_CONSULTA },
  { campo: 'captacao', nome: 'Captação', mapa: MAPEAMENTO_CAPTACAO },
  { campo: 'area_direito', nome: 'Área do Direito', mapa: MAPEAMENTO_AREA_DIREITO },
  { campo: 'advogado_responsavel', nome: 'Responsável pelo processo', mapa: MAPEAMENTO_RESPONSAVEL_PROCESSO },
];

// Campo "Tipo de Consulta" do deal (MULTIPLE_OPTION). Unica fonte de verdade pra leads que nunca
// passaram pelo WhatsApp (Moskit Boost, atividade criada na mao) — ver autorizacaoParaAgendar.
const CF_TIPO_CONSULTA = MOSKIT_IDS.CF.TIPO_CONSULTA;
const TIPO_CONSULTA_GRATIS_ID = MOSKIT_IDS.TIPO_CONSULTA_GRATIS_ID;
const TIPO_CONSULTA_PAGA_ID = MOSKIT_IDS.TIPO_CONSULTA_PAGA_ID;

// Correspondencia EXATA (depois de normalizar) contra o indice de busca do campo, que ja inclui as
// chaves canonicas e os apelidos declarados em src/moskit-ids.js.
//
// O casamento por substring que existia aqui preenchia mais campos ao custo de escolher a opcao errada
// em silencio: "Indicacao" sozinho virava "Indicacao de clientes", "direito" virava "Direito
// Administrativo" e "consulta" virava "consulta gratis" — esse ultimo com consequencia financeira
// (R$0 no CRM). Decisao de 12/08/2026: valor que nao esta na tabela deixa o campo VAZIO e vira aviso
// (ver detectarOpcoesInvalidas/registrarOpcoesInvalidas), nunca um chute.
//
// `aproximado` existe para UM caso legitimo: o motivo de perda, que a IA escreve com as palavras da
// conversa e precisa cair na opcao mais parecida da lista fixa do CRM.
function buscarIdOpcao(mapeamento, valor, opcoes = {}) {
  const id = MOSKIT_IDS.buscarOpcao(mapeamento, valor, opcoes);
  if (id === null && valor) {
    console.log(`  ⚠️ opcao nao reconhecida para "${valor}" — campo fica vazio (cadastrar apelido em src/moskit-ids.js se for recorrente)`);
  }
  return id;
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
// Autoria dos campos personalizados: humano ganha do bot
// ------------------------------------------------------------
// O bot reescreve os mesmos campos a cada ciclo, a partir de last_data. Com a verificacao pos-PUT
// (ver atualizarNegocioMoskit) ele ainda insiste com retentativas ate o valor dele grudar — ou seja,
// uma correcao feita na mao pela equipe era desfeita no ciclo seguinte. Regra do escritorio
// (12/08/2026): quem corrige na mao ganha, para sempre.
//
// Dois campos ficam FORA da lista de proposito, porque neles nao existe "opiniao" a preservar — existe
// regra:
//   - TIPO_CONSULTA: quem manda e o checkpoint do bloco de condicoes, que ja sobrepoe marcacao manual
//     de cortesia quando a equipe anuncia o valor.
//   - RESPONSAVEL: e DERIVADO da area (MOSKIT_IDS.ADVOGADO_POR_AREA_ID) e montarPayloadMoskit o
//     reescreve em toda escrita. Trava-lo criaria um CRM incoerente consigo mesmo — area de Familia com
//     responsavel Iury — que e exatamente o erro que a tabela existe para eliminar. Quem quiser outro
//     responsavel muda a AREA, ou a tabela.
const CF_TRAVAVEIS = new Set([
  MOSKIT_IDS.CF.ORIGEM,
  MOSKIT_IDS.CF.CAPTACAO,
  MOSKIT_IDS.CF.AREA_DIREITO,
]);

const CF_NOMES = {
  [MOSKIT_IDS.CF.ORIGEM]: 'Origem',
  [MOSKIT_IDS.CF.CAPTACAO]: 'Captação',
  [MOSKIT_IDS.CF.AREA_DIREITO]: 'Área do Direito',
  [MOSKIT_IDS.CF.RESPONSAVEL]: 'Responsável pelo processo',
  [MOSKIT_IDS.CF.TIPO_CONSULTA]: 'Tipo de Consulta',
};

function nomeCampo(id) {
  return CF_NOMES[id] || id;
}

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

function opcoesIguais(a, b) {
  const na = (Array.isArray(a) ? a : []).map(String).sort();
  const nb = (Array.isArray(b) ? b : []).map(String).sort();
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

function lerRegistroCampos(chatId) {
  if (!chatId) return null;
  const row = db.prepare('SELECT custom_fields_bot, campos_travados FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row) return null;
  return {
    escritos: parseJsonSeguro(row.custom_fields_bot, null) || {},
    temRegistro: !!row.custom_fields_bot,
    travados: new Set(parseJsonSeguro(row.campos_travados, null) || []),
  };
}

function gravarRegistroCampos(chatId, escritos, travados) {
  if (!chatId) return;
  db.prepare('UPDATE conversations SET custom_fields_bot = ?, campos_travados = ? WHERE chat_id = ?')
    .run(JSON.stringify(escritos), JSON.stringify([...travados]), chatId);
}

// Decide campo por campo se o bot pode escrever, comparando o que esta no CRM com o ultimo valor que
// o PROPRIO bot escreveu (custom_fields_bot):
//   - campo vazio no CRM              => escreve (nao ha nada de ninguem para preservar)
//   - remoto == ultimo valor do bot   => escreve (o valor de la e dele mesmo)
//   - remoto != ultimo valor do bot   => TRAVA para sempre (alguem corrigiu na mao) e nao escreve
//   - sem registro (linha antiga)     => nao escreve nesta rodada e adota o remoto como referencia;
//                                        do proximo ciclo em diante a comparacao acima ja vale
// Sem chatId (backfills, scripts) nao ha onde guardar autoria: segue o comportamento antigo.
function filtrarCamposPorAutoria(chatId, dealRemoto, camposDoBot, opcoes = {}) {
  const registro = lerRegistroCampos(chatId);
  if (!registro) return { campos: camposDoBot, travasNovas: [], baseline: [], registro: null };

  const remotos = new Map(
    (dealRemoto?.entityCustomFields || [])
      .filter((c) => c?.id)
      .map((c) => [c.id, (c.options || []).map(Number)])
  );

  const campos = [];
  const travasNovas = [];
  const baseline = [];

  for (const campo of camposDoBot) {
    if (!CF_TRAVAVEIS.has(campo.id)) { campos.push(campo); continue; }

    if (registro.travados.has(campo.id)) {
      console.log(`  🔒 ${nomeCampo(campo.id)}: travado por correcao manual — bot nao escreve`);
      continue;
    }

    const remoto = remotos.get(campo.id);
    if (!remoto || !remoto.length) { campos.push(campo); continue; }

    const registrado = registro.escritos[campo.id];
    if (registrado === undefined) {
      // `forcarAutoria` e o escape hatch da reconciliacao manual (?incluir-legado=1): assume que o valor
      // de la e do bot e escreve a decisao atual. Fora dele, o CRM ganha.
      if (opcoes.forcarAutoria) {
        console.log(`  🔁 ${nomeCampo(campo.id)}: sem registro de autoria, mas forcarAutoria ligado — sobrescrevendo o valor do CRM (${remoto.join(',')})`);
        campos.push(campo);
        continue;
      }
      baseline.push({ id: campo.id, options: remoto });
      console.log(`  🧷 ${nomeCampo(campo.id)}: sem registro de autoria — preservando o valor que esta no CRM (${remoto.join(',')}) nesta rodada`);
      continue;
    }

    if (!opcoesIguais(registrado, remoto)) {
      travasNovas.push(campo.id);
      console.log(`  🔒 ${nomeCampo(campo.id)}: valor no CRM (${remoto.join(',')}) diferente do que o bot escreveu (${[].concat(registrado).join(',')}) — alguem corrigiu na mao, travando para sempre`);
      continue;
    }

    campos.push(campo);
  }

  return { campos, travasNovas, baseline, registro };
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

// A data-ancora em texto do escritorio, NUNCA em ISO. Medido em producao (13/08/2026): entregar a
// ancora como "2026-08-10T18:54:58.000Z" fazia o modelo COPIAR essa string quando nao conseguia
// derivar o horario da conversa — e o valor copiado e uma data valida, entao passava por qualquer
// checagem de parse. Deu 5 casos em 32 conversas com horario, 3 deles com reuniao real na agenda
// (deals 48370184, 48407621, 48177138 — ver o comentario em src/evidencia.js).
//
// Duas defesas em uma: o formato aqui nao se parece com o que o modelo tem que devolver (se ele
// copiar, o valor nem chega a lugar nenhum — motivoHorarioImplausivel rejeita de saida por formato),
// e a hora fica na do escritorio, igual a todo o resto do pipeline, em vez de UTC.
function descreverAncora(isoAncora) {
  const d = new Date(isoAncora);
  if (isNaN(d.getTime())) return '(desconhecida — nao resolva dias relativos)';
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_ESCRITORIO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  const [ano, mes, dia] = diaLocal(d).split('-');
  return `${dia}/${mes}/${ano} (${diaSemanaLocal(d)}), ${hora} — hora do escritorio`;
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

// GATE DO CASO DESCRITO. Area do direito, advogado responsavel e assunto so entram no CRM se alguem
// tiver CONTADO o caso nesta conversa — observacao validada contra a mensagem real (cliente ou equipe,
// ver src/evidencia.js). Sem isso o modelo deduzia a area do SOCIO que o lead mencionou: "gostaria de
// agendar uma consulta com o Dr. Berto" virava area=LGPD e assunto="Direito Digital", porque LGPD e o
// primeiro item do perfil do Berto no prompt. Foi assim que uma cliente de Direito Administrativo
// (remocao por motivo de saude) entrou no CRM como LGPD, com briefing errado, e precisou de correcao
// manual no deal 48423360.
//
// Zera para null, nunca para um valor de fachada: mergeDados so sobrescreve com valor nao-nulo, entao
// uma area boa de um ciclo anterior sobrevive a uma rodada em que a evidencia nao aparecer.
// Muta `dados` (mesmo contrato das outras sanitizacoes do pipeline) e devolve o veredito.
function aplicarGateCasoDescrito(dados, obsValidas) {
  const casoDescrito = !!(ultimaObservacao(obsValidas, 'cliente_descreveu_caso')
    || ultimaObservacao(obsValidas, 'equipe_descreveu_caso'));
  if (casoDescrito || !dados) return { casoDescrito };

  if (dados.area_direito || dados.advogado_responsavel) {
    console.log(`  🚫 area/advogado descartados — ninguem descreveu o caso nesta conversa (area="${dados.area_direito}", advogado="${dados.advogado_responsavel}")`);
  }
  dados.area_direito = null;
  dados.advogado_responsavel = null;
  // "Consulta juridica" e o placeholder que o proprio prompt manda usar enquanto o caso esta vago —
  // esse passa. Qualquer outro assunto sem caso descrito e palpite (tipicamente o nome da area) e nao
  // pode virar titulo de negocio no CRM.
  if (dados.assunto && !ehAssuntoNeutro(dados.assunto)) {
    console.log(`  🚫 assunto descartado (sem caso descrito): "${dados.assunto}"`);
    dados.assunto = null;
  }
  return { casoDescrito };
}

// Lead que ainda nao contou o caso nao vira contato nem deal no CRM (decisao do escritorio,
// 12/08/2026): melhor nenhum registro do que um registro com area/assunto adivinhados, que a equipe
// so descobre errado depois.
//
// Duas excecoes, porque a partir dai o custo de nao ter deal deixa de ser cadastral: com dupla
// confirmacao de horario o evento na agenda, o Meet e o contrato do ZapSign dependem de existir dealId
// (finalizarCiclo so roda nos ramos que escrevem), e com o bloco de condicoes enviado a consulta ja
// foi cobrada. Nesses casos o deal nasce mesmo assim — com area/advogado vazios para a equipe
// preencher, nunca com palpite.
function deveEsperarCasoDescrito(acao, casoDescrito, apuracao, blocoEnviado) {
  return acao === 'criar' && !casoDescrito && !apuracao?.confirmado && !blocoEnviado;
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

// O ADVOGADO E CONSEQUENCIA DA AREA, nunca uma escolha independente (MOSKIT_IDS.AREA_PARA_ADVOGADO).
// Antes disto o responsavel era o que o modelo dissesse: area de Familia podia sair com responsavel
// Berto e nada no codigo reclamava. Aqui a area manda, e a sugestao do modelo e so um palpite que pode
// ser descartado.
//
// Area sem dono ("Outros") ou nome de area que nao esta na tabela => responsavel VAZIO, para a equipe
// decidir. `captacao` nao e tocada: e quem trouxe o lead, nao quem cuida do caso.
function derivarAdvogadoDaArea(dados) {
  if (!dados) return;

  if (!dados.area_direito) {
    if (dados.advogado_responsavel) {
      console.log(`  🚫 advogado "${dados.advogado_responsavel}" descartado — sem area do direito definida, o responsavel nao pode ser derivado`);
      dados.advogado_responsavel = null;
    }
    return;
  }

  // Pelo ID da opcao, nao pelo nome: apelido de area ("Direito Medico", "familia") chega resolvido e a
  // tabela do responsavel nunca discorda da tabela de areas sobre como uma area se chama.
  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  const dono = idArea ? (MOSKIT_IDS.ADVOGADO_POR_AREA_ID[idArea] || null) : null;
  if (!dono) {
    if (dados.advogado_responsavel) {
      console.log(`  🚫 advogado "${dados.advogado_responsavel}" descartado — a area "${dados.area_direito}" nao tem responsavel definido na tabela do escritorio`);
      dados.advogado_responsavel = null;
    }
    return;
  }

  if (dados.advogado_responsavel && removerAcentos(String(dados.advogado_responsavel).toLowerCase().trim()) !== dono.toLowerCase()) {
    console.log(`  ⚠️ advogado sugerido "${dados.advogado_responsavel}" ignorado — "${dados.area_direito}" e do ${dono}`);
  }
  dados.advogado_responsavel = dono;
}

// Assunto que e so o nome de uma area do direito nao e assunto: e o palpite de area vazando pro TITULO
// do negocio (foi assim que o deal do caso 48423360 nasceu "… - Direito Digital"). Vale mesmo quando o
// caso FOI descrito: nesse caso o modelo tinha material para resumir o tema e devolveu a area.
function rejeitarAssuntoQueEhArea(dados) {
  if (!dados?.assunto) return;
  // Pelo indice de busca: pega tanto "LGPD" quanto os apelidos ("Direito Digital", "familia").
  if (!buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.assunto)) return;
  console.log(`  🚫 assunto "${dados.assunto}" e nome de area, nao tema do caso — trocado por "${ASSUNTO_NEUTRO}"`);
  dados.assunto = ASSUNTO_NEUTRO;
}

// Tudo que o bot AFIRMA sobre o caso passa por aqui: evidencia do caso descrito, advogado derivado da
// area e assunto que nao pode ser nome de area. Idempotente de proposito — roda na extracao da rodada e
// DE NOVO no objeto mesclado que vai pro CRM (ver mesclarParaCrm).
function sanitizarClassificacao(dados, obsValidas) {
  const { casoDescrito } = aplicarGateCasoDescrito(dados, obsValidas);
  rejeitarAssuntoQueEhArea(dados);
  derivarAdvogadoDaArea(dados);
  return { casoDescrito };
}

// O gate limpava so a extracao da rodada, mas o que vai pro CRM (e o que volta pro last_data) e o
// objeto MESCLADO com os ciclos anteriores — e mergeDados ressuscitava o palpite antigo de area/assunto
// gravado antes destas travas existirem, reenviando-o para sempre. Mesclar e sanitizar tem que ser uma
// coisa so.
//
// Omitir um campo do payload nunca APAGA nada no CRM: mesclarCustomFields devolve o valor remoto para o
// corpo do PUT. Omitir significa "nao disputo este campo nesta rodada".
function mesclarParaCrm(dadosAnteriores, dados, obsValidas) {
  const mesclados = mergeDados(dadosAnteriores || {}, dados);
  sanitizarClassificacao(mesclados, obsValidas);
  return mesclados;
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

function montarPayloadMoskit(dadosBrutos, contactId, opcoes = {}) {
  // Ultimo ponto de estrangulamento antes de qualquer escrita no CRM (criar, atualizar, virada de
  // cobranca, backfill, reconciliacao): a area DEFINE o responsavel. Sem isto, um caminho que nao passe
  // pelo pipeline — backfill lendo last_data antigo, por exemplo — ainda conseguiria gravar area de
  // Familia com responsavel Berto. Copia para nao mutar o objeto de quem chamou.
  const dados = { ...(dadosBrutos || {}) };
  derivarAdvogadoDaArea(dados);

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
  // Registra a autoria dos campos (e do nome) ja no nascimento do deal: e o que permite ao proximo ciclo
  // saber que o que esta no CRM foi escrito pelo bot, e nao corrigido por alguem da equipe.
  registrarAutoriaCampos(opcoes.chatId, payload.entityCustomFields, [], [], payload.name);
  return response.data;
}

// Chave reservada no mesmo registro de autoria para o NOME do deal (os outros ids sao sempre "CF_...",
// entao nao ha colisao possivel).
const CHAVE_AUTORIA_NOME = '__name';

function nomeEscritoPeloBot(chatId) {
  const registro = lerRegistroCampos(chatId);
  const nome = registro?.escritos?.[CHAVE_AUTORIA_NOME];
  return typeof nome === 'string' && nome.trim() ? nome.trim() : null;
}

// Guarda em custom_fields_bot o que o bot acabou de escrever. Preserva o que ja estava registrado para
// os campos que nao entraram nesta rodada (ex: campo travado, ou campo que a IA nao resolveu).
function registrarAutoriaCampos(chatId, camposEscritos, travasNovas = [], baseline = [], nomeEscrito = null) {
  if (!chatId) return;
  const registro = lerRegistroCampos(chatId);
  if (!registro) return;

  const escritos = { ...registro.escritos };
  for (const c of [...(camposEscritos || []), ...(baseline || [])]) {
    if (c?.id) escritos[c.id] = (c.options || []).map(Number);
  }
  if (nomeEscrito) escritos[CHAVE_AUTORIA_NOME] = String(nomeEscrito).trim();
  const travados = new Set([...registro.travados, ...travasNovas]);
  gravarRegistroCampos(chatId, escritos, travados);
}

async function atualizarNegocioMoskit(dealId, dados, contactId, opcoes = {}) {
  const payload = montarPayloadMoskit(dados, contactId, opcoes);
  // Tudo que o bot decidiu sobre este lead NESTA rodada, antes do merge com o que ja existia
  // remotamente (que so acontece no GET abaixo) — e exatamente o que confirmamos apos o PUT.
  // Reatribuido abaixo se algum campo sair do payload por autoria humana: confirmar um campo que o bot
  // deliberadamente NAO mandou faria a atualizacao falhar para sempre.
  let camposEsperados = payload.entityCustomFields;
  let travasNovas = [];
  let baselineCampos = [];

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
      // Nome do deal, pela mesma regra de autoria dos campos personalizados:
      //   - nome cru do bot (sem tema) ou nome que o BOT escreveu por ultimo => pode atualizar
      //   - qualquer outro nome => alguem da equipe renomeou, preserva para sempre
      // A trava antiga era "preserva tudo que nao seja o nome cru", e por isso um titulo que nasceu com
      // assunto errado ("Cliente - Direito Digital") ficava congelado mesmo depois de o bot descobrir o
      // tema real — outro caminho pelo qual a classificacao errada sobrevivia no CRM.
      const nomeRemoto = String(atualRes.data?.name || '').trim();
      const nomeCruDoBot = removerEmoji(dados.nome) || 'Cliente sem nome';
      const nomeDoBot = nomeEscritoPeloBot(opcoes.chatId);
      const escritoPeloBot = nomeRemoto === nomeCruDoBot || (!!nomeDoBot && nomeRemoto === nomeDoBot);
      if (nomeRemoto && !escritoPeloBot) {
        if (nomeRemoto !== payload.name) console.log(`  ⏭️ nome do deal ${dealId} preservado ("${nomeRemoto}") — renomeado fora do bot`);
        payload.name = atualRes.data.name;
      } else if (nomeRemoto && nomeRemoto !== payload.name) {
        console.log(`  ✏️ titulo do deal ${dealId} atualizado: "${nomeRemoto}" → "${payload.name}"`);
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
      // Autoria: campo corrigido na mao pela equipe sai do payload. mesclarCustomFields (abaixo)
      // devolve o valor remoto pro corpo do PUT, entao a correcao humana continua la — o bot
      // simplesmente para de disputar aquele campo.
      const autoria = filtrarCamposPorAutoria(opcoes.chatId, atualRes.data, payload.entityCustomFields, {
        forcarAutoria: opcoes.forcarAutoria === true,
      });
      payload.entityCustomFields = autoria.campos;
      camposEsperados = autoria.campos;
      travasNovas = autoria.travasNovas;
      baselineCampos = autoria.baseline;

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

  // So depois do PUT confirmado: registrar autoria de um valor que nao entrou faria o bot achar,
  // no ciclo seguinte, que a divergencia foi correcao humana.
  registrarAutoriaCampos(opcoes.chatId, camposEsperados, travasNovas, baselineCampos, payload.name);
  for (const id of travasNovas) {
    await criarNotaMoskit(
      dealId,
      `🔒 "${nomeCampo(id)}" foi corrigido manualmente no CRM — o bot não vai mais sobrescrever este campo nesta negociação.`
    );
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
    // `dados` aqui e o last_data cru de ciclos anteriores, e esta rodada nem chegou na extracao — nao
    // existe evidencia do caso para sustentar area/advogado/assunto. Sanitizar sem observacao nenhuma
    // deixa esses campos de fora do payload, e a virada faz so o que tem que fazer: corrigir o tipo de
    // consulta e o valor. Campo omitido nao apaga nada no CRM (mesclarCustomFields devolve o remoto).
    const dadosVirada = { ...(dados || {}) };
    sanitizarClassificacao(dadosVirada, []);
    await atualizarNegocioMoskit(dealId, dadosVirada, contactId, opcoesPayload);
    console.log(`  💳 Deal ${dealId} reclassificado para PAGA (price 35000) pelo checkpoint do bloco de condicoes`);
    await criarNotaMoskit(dealId, '💳 A equipe enviou as condições de valor nesta conversa — consulta reclassificada de cortesia para PAGA (R$350,00). Valor do negócio atualizado. Aguardando comprovante.');

    // Se a consulta ja foi pro Google Agenda como cortesia, o evento NAO e cancelado — cancelar
    // reuniao de cliente real por inferencia e pior que o erro. Avisa pra alguem cobrar.
    if (row.evento_calendar_criado) {
      const quando = formatarHorarioEscritorio(row.evento_calendar_data) || 'horario nao registrado';
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

// Valores que a IA devolveu para campos de opcao e que NAO existem na lista do CRM (nem como apelido).
// Esses campos ficam vazios no deal — o que e o comportamento seguro —, mas silenciosamente. Aqui eles
// viram lista para uma nota unica no deal e um aviso no Telegram.
function detectarOpcoesInvalidas(dados) {
  if (!dados) return [];
  return CAMPOS_CLASSIFICACAO
    .filter(({ campo, mapa }) => {
      const valor = dados[campo];
      return valor && valor !== 'null' && buscarIdOpcao(mapa, valor) === null;
    })
    .map(({ campo, nome }) => ({ campo, nome, valor: dados[campo] }));
}

// Nota + Telegram uma unica vez por conjunto de valores invalidos (hash), mesmo padrao de
// registrarPendenciaContrato. E assim que um apelido novo chega ao conhecimento de quem mantem
// src/moskit-ids.js, em vez de o valor errado se repetir calado a cada ciclo.
async function registrarOpcoesInvalidas(dealId, chatId, invalidas) {
  if (!dealId || !invalidas?.length) return false;
  const hash = invalidas.map((i) => `${i.campo}=${i.valor}`).sort().join('|');

  const atual = chatId ? db.prepare('SELECT opcao_invalida_hash FROM conversations WHERE chat_id = ?').get(chatId) : null;
  if (atual?.opcao_invalida_hash === hash) return false;

  const lista = invalidas.map((i) => `• ${i.nome}: "${i.valor}"`).join('\n');
  try {
    await criarNotaMoskit(
      dealId,
      `⚠️ A IA sugeriu valor que não existe na lista do CRM — campo(s) deixado(s) em branco de propósito:\n${lista}\n\nPreencher manualmente se fizer sentido.`
    );
    await enviarTelegram(`⚠️ *Valor fora da lista do CRM*\nDeal \`${dealId}\`\n${lista}`);
    if (chatId) db.prepare('UPDATE conversations SET opcao_invalida_hash = ? WHERE chat_id = ?').run(hash, chatId);
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao avisar opcao invalida no deal ${dealId}: ${e.message}`);
    return false;
  }
}

// Briefing pre-consulta do advogado. Antes isto era uma trava de uma vez so (briefing_added): o
// PRIMEIRO resumo que a IA produzisse ficava no deal para sempre. No deal 48423360 esse primeiro
// resumo dizia "caso relacionado à LGPD" — deduzido do advogado que a cliente mencionou, sem uma linha
// sobre o caso — e continuou sendo o texto que o advogado leria antes da consulta mesmo depois de o
// bot descobrir que era remocao por motivo de saude (Direito Administrativo).
//
// Agora quem decide e o HASH do resumo: mudou de verdade => posta a versao nova. Texto igual nao gera
// nota nenhuma, e o mesmo criterio dos outros hashes de nota (agendamento_pendente_hash etc).
async function registrarBriefing(dealId, chatId, resumo, tituloInicial) {
  if (!dealId || !resumo) return false;

  const hash = crypto.createHash('sha1').update(String(resumo).replace(/\s+/g, ' ').trim()).digest('hex');
  const atual = chatId
    ? db.prepare('SELECT briefing_hash, briefing_added FROM conversations WHERE chat_id = ?').get(chatId)
    : null;

  if (atual?.briefing_hash === hash) {
    console.log(`  ⏭️ briefing inalterado — nao repostado`);
    return false;
  }

  // Conversa anterior a esta mudanca: ja tem briefing no deal, mas nao tem hash. Adota o resumo atual
  // como referencia SEM repostar — senao todo deal ativo receberia uma nota duplicada no primeiro
  // ciclo depois do deploy. Da proxima mudanca real em diante o hash ja funciona normalmente.
  if (atual && !atual.briefing_hash && atual.briefing_added) {
    db.prepare('UPDATE conversations SET briefing_hash = ? WHERE chat_id = ?').run(hash, chatId);
    console.log(`  🧷 briefing anterior a esta versao — hash registrado sem repostar nota`);
    return false;
  }

  const titulo = atual?.briefing_added ? '📋 Briefing atualizado' : tituloInicial;
  await criarNotaMoskit(dealId, `${titulo}\n\n${resumo}`);
  if (chatId) {
    db.prepare('UPDATE conversations SET briefing_added = 1, briefing_hash = ? WHERE chat_id = ?').run(hash, chatId);
  }
  console.log(`  ✅ ${titulo} registrado no deal ${dealId}`);
  return true;
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

// A consulta na AGENDA do Moskit. Contrato levantado em 12/08/2026 com test-moskit-atividade-real.js
// contra a API real (o repositorio so lia /activities ate entao): `dueDate` e instante absoluto
// ("2026-08-07T12:00:00.000+00:00"), `duration` em minutos, `deals`/`contacts` como arrays de {id}.
//
// NUNCA LANCA — de proposito. Quando esta funcao roda, o evento no Google Agenda ja existe e a dupla
// confirmacao ja aconteceu; deixar uma excecao subir aqui derrubaria o avanco de estagio e a geracao
// do contrato no ZapSign por causa da agenda do CRM. A falha vira nota no deal, que e onde o
// escritorio ve.
async function criarAtividadeMoskit(dealId, payload) {
  if (!dealId || !payload) return null;
  try {
    const res = await axios.post(`${MOSKIT_BASE}/activities`, payload, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    // Resposta 2xx sem id e tao inutil quanto um erro: sem o id nao da pra remarcar nem pra impedir
    // que a sincronizacao periodica crie um evento duplicado no Google Agenda.
    const atividadeId = res.data?.id;
    if (res.status >= 300 || !atividadeId) {
      const texto = `⚠️ A consulta NAO entrou na agenda do Moskit (falha ao criar a atividade, HTTP ${res.status}). O evento no Google Agenda foi criado normalmente — marque a atividade na mao para ela aparecer na agenda do CRM.`;
      console.error(`  ❌ Atividade nao criada no Moskit (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
      await criarNotaMoskit(dealId, texto).catch(() => {});
      // Achado em 14/08/2026: 21 de 27 consultas com evento no Google NUNCA tiveram a Atividade
      // criada, e a unica trilha que sobrou foi o console (o log da VPS nao guarda historico longo o
      // bastante, e a nota acima tambem pode falhar em silencio via o .catch). Telegram nao depende de
      // nenhum dos dois — mesmo padrao ja aplicado em registrarErroAgendamento/registrarErroContrato.
      await enviarTelegram(`❌ *Atividade NAO criada no Moskit*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
      return null;
    }
    return atividadeId;
  } catch (e) {
    const texto = `⚠️ A consulta NAO entrou na agenda do Moskit (${e.message}). O evento no Google Agenda foi criado normalmente — marque a atividade na mao para ela aparecer na agenda do CRM.`;
    console.error(`  ❌ Erro ao criar atividade no Moskit: ${e.message}`);
    await criarNotaMoskit(dealId, texto).catch(() => {});
    await enviarTelegram(`❌ *Atividade NAO criada no Moskit*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
    return null;
  }
}

// Move o horario da atividade quando a consulta e remarcada. Mesmo contrato de nao-lancar: o evento
// no Google ja foi movido quando chegamos aqui, e o pior desfecho e a agenda do CRM ficar no horario
// velho — o que precisa virar nota, nao excecao.
async function atualizarAtividadeMoskit(atividadeId, dueDate, dealId) {
  if (!atividadeId) return false;
  // dueDate nulo aqui significa que horarioNaiveParaInstante recusou o horario DEPOIS de o evento no
  // Google ja ter sido movido: as duas agendas ficam divergentes, e a do CRM mostrando o horario
  // antigo e pior que nao mostrar nada, porque parece certo. Era um `return false` mudo, o unico ramo
  // de falha do agendamento sem nota nenhuma no deal.
  if (!dueDate) {
    console.error(`  ❌ Atividade ${atividadeId}: horario invalido pra remarcar — agenda do CRM continua no horario antigo`);
    if (dealId) {
      await criarNotaMoskit(dealId, `⚠️ A reunião foi remarcada no Google Agenda, mas a atividade ${atividadeId} na agenda do Moskit NÃO foi movida (horário inválido na conversão de fuso). A agenda do CRM está mostrando o horário ANTIGO — corrigir na mão.`).catch(() => {});
    }
    return false;
  }
  try {
    // MEDIDO em 12/08/2026 com test-moskit-atividade-real.js contra a API real: `/activities` tem a
    // MESMA peculiaridade do PUT de deal — um payload minimo `{dueDate}` e rejeitado com 422, e so o
    // corpo do GET de volta (com o dueDate trocado) move o horario. Por isso o GET abaixo nao e
    // firula: sem ele nenhuma remarcacao jamais chegaria na agenda do CRM.
    const atualRes = await axios.get(`${MOSKIT_BASE}/activities/${atividadeId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser lida para remarcar (HTTP ${atualRes.status})`);
      if (dealId) await criarNotaMoskit(dealId, '⚠️ A atividade na agenda do Moskit NAO foi remarcada (nao consegui ler a atividade) e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.').catch(() => {});
      return false;
    }

    const res = await axios.put(`${MOSKIT_BASE}/activities/${atividadeId}`, { ...atualRes.data, dueDate }, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (res.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao remarcada no Moskit (HTTP ${res.status})`);
      if (dealId) await criarNotaMoskit(dealId, '⚠️ A atividade na agenda do Moskit NAO foi remarcada e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.').catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao remarcar atividade ${atividadeId} no Moskit: ${e.message}`);
    if (dealId) await criarNotaMoskit(dealId, `⚠️ A atividade na agenda do Moskit NAO foi remarcada (${e.message}) e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.`).catch(() => {});
    return false;
  }
}

// MEDIDO em 14/08/2026 contra a API real, nos deals 48474073 e 48464876: o Moskit aceita o
// `POST /activities` com `deals: [{id: dealId}]` (HTTP 2xx, id devolvido) mas, quando o negocio foi
// criado/escrito quase ao MESMO tempo que a atividade (segundos a poucas horas de diferenca), o
// vinculo com o negocio nao gruda — a atividade fica so vinculada ao contato. Os dois casos que
// funcionaram nasceram contra um negocio que ja estava parado ha dias (rodada tardia de auto-cura).
// Nada nisso e visivel em criarAtividadeMoskit: a resposta do POST e 2xx com id, entao passa como
// sucesso. Esta funcao confere e corrige, reaproveitando o padrao GET-then-PUT de
// atualizarAtividadeMoskit (PUT minimo e rejeitado com 422). Devolve true se ficou (ou ja estava) ok.
async function garantirVinculoAtividadeDeal(atividadeId, dealId) {
  if (!atividadeId || !dealId) return false;
  try {
    const atualRes = await axios.get(`${MOSKIT_BASE}/activities/${atividadeId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser lida para conferir vinculo com o deal (HTTP ${atualRes.status})`);
      return false;
    }
    const jaVinculada = (atualRes.data?.deals || []).some((d) => Number(d?.id) === Number(dealId));
    if (jaVinculada) return true;

    const res = await axios.put(`${MOSKIT_BASE}/activities/${atividadeId}`, { ...atualRes.data, deals: [{ id: dealId }] }, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (res.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser religada ao deal ${dealId} (HTTP ${res.status})`);
      return false;
    }
    console.log(`  🔗 Atividade ${atividadeId} religada ao deal ${dealId} (o Moskit tinha criado sem o vinculo)`);
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao conferir/religar vinculo da atividade ${atividadeId} com o deal ${dealId}: ${e.message}`);
    return false;
  }
}

// Varre as atividades do Moskit paginando por OFFSET (`?start=`).
//
// MEDIDO em 12/08/2026 contra a API real, testando um parametro de cada vez. Em `/activities`:
//   - `?page=`      IGNORADO — page=1 ate page=5 devolvem os MESMOS 10 registros
//   - `?pageToken=` IGNORADO — devolve a mesma pagina e repete o mesmo token (diferente de
//                   `/contacts`, onde esse mecanismo funciona e buscarOuCriarContato depende dele)
//   - `?limit=`     IGNORADO — sempre 10, qualquer que seja o valor
//   - `?offset=` / `?skip=` / `?from=` / `?maxId=` / `?beforeId=` — todos ignorados
//   - **`?start=`   FUNCIONA** — offset real: start=10 devolve os 10 seguintes, sem sobreposicao
//   - `?sort=`/`?order=` funcionam (order=asc devolve as mais antigas)
//
// Nenhum desses parametros ignorados devolve erro: a chamada responde 200 com a primeira pagina de
// novo. Um loop mal escrito aqui nao quebra — ele rele os mesmos 10 registros e parece ter varrido
// tudo. Foi assim que a sincronizacao e a auditoria passaram a enxergar so as 10 atividades mais
// recentes achando que varriam 100.
//
// Devolve tambem `truncou`, para o chamador poder AVISAR quando o teto cortou a varredura — teto
// silencioso aqui se leria como "varri tudo e nao achei nada", que e exatamente o engano acima.
async function listarAtividadesMoskit(maxPaginas = MAX_PAGINAS_ATIVIDADES) {
  const atividades = [];
  let truncou = false;

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const res = await axios.get(`${MOSKIT_BASE}/activities`, {
      params: { start: atividades.length, limit: 100, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (res.status < 200 || res.status >= 300) break;

    const lote = Array.isArray(res.data) ? res.data : [];
    atividades.push(...lote);

    // Pagina incompleta = fim da lista. Nao da pra confiar no header `x-moskit-listing-total`: ele
    // dizia 1165 numa base cuja varredura completa devolveu 190 registros unicos.
    if (lote.length < 10) break;
    if (pagina === maxPaginas - 1) truncou = true; // ainda vinha pagina cheia quando o teto chegou
  }

  return { atividades, truncou };
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
  // `aproximado`: o motivo vem com as palavras da conversa ("achou o valor muito alto"), nao com o nome
  // exato da opcao do CRM — aqui a aproximacao e o comportamento certo, e o pior caso e cair no motivo
  // padrao "nao informou o motivo".
  const idMotivo = buscarIdOpcao(LOST_REASON, motivoTexto, { aproximado: true }) || LOST_REASON_PADRAO_ID;
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

// Cria, na AGENDA do Moskit, a atividade que corresponde ao evento recem-criado no Google Agenda.
//
// O PONTO CRITICO AQUI E O `stmtAtividadeMarcarSincronizada` NO FIM. sincronizarAtividadesMoskit roda
// a cada SYNC_INTERVAL_MS e cria um evento no Google para toda atividade de consulta futura que nao
// esteja nessa tabela — ou seja, sem essa linha o proprio bot criaria um SEGUNDO evento para a mesma
// consulta minutos depois. Marcar a atividade como ja sincronizada, apontando para o evento que
// acabamos de criar, e o que fecha o circuito entre as duas agendas.
//
// Nao lanca: quem chama esta no meio do caminho feliz do agendamento (nota, Telegram, estagio,
// contrato) e nada disso pode cair porque a agenda do CRM falhou. Devolve true se entrou na agenda.
async function registrarConsultaNaAgendaMoskit({ dealId, dados, chatId, horarioIso, meetLink, eventoId, row }) {
  if (!dealId) return false;
  if (row?.atividade_moskit_id) return false; // ja tem atividade — nao duplicar na agenda do CRM

  if (AGENDA_MOSKIT_DRY_RUN) {
    // Uma nota so: esta funcao roda no ramo de CRIACAO do evento, guardado por
    // evento_calendar_criado — uma vez por conversa, nao a cada ciclo.
    const quando = formatarHorarioEscritorio(horarioIso);
    console.log(`  ⏭️ [dry-run] atividade do Moskit NAO criada para o deal ${dealId} (AGENDA_MOSKIT_DRY_RUN ativo)`);
    await criarNotaMoskit(dealId, `🤖 [dry-run] A consulta de ${quando} NAO foi lançada na agenda do Moskit (AGENDA_MOSKIT_DRY_RUN ativo) — marque a atividade na mão. O evento no Google Agenda foi criado normalmente.`).catch(() => {});
    return false;
  }

  const dueDate = horarioNaiveParaInstante(horarioIso, TZ_ESCRITORIO);
  if (!dueDate) {
    console.error(`  ⚠️ horario "${horarioIso}" nao converteu para instante — atividade do Moskit nao criada`);
    return false;
  }

  // O contato ja foi resolvido antes neste ciclo (buscarOuCriarContato) e ficou no espelho local;
  // vincular a atividade a ele e o que a faz aparecer tambem na ficha do cliente, nao so no negocio.
  const phoneClean = String(chatId || '').replace(/\D/g, '').slice(-13);
  const contatoId = phoneClean.length >= 8 ? stmtMoskitGet.get(phoneClean)?.moskit_id || null : null;

  const payload = montarPayloadAtividade({
    dealId,
    contatoId,
    titulo: montarResumoEvento(dados), // mesmo titulo do evento do Google: e o mesmo compromisso
    assunto: dados.assunto,
    dueDate,
    presencial: dados.modalidade_consulta === 'presencial',
    meetLink,
  });

  const atividadeId = await criarAtividadeMoskit(dealId, payload);
  if (!atividadeId) return false;

  // Confere se o POST realmente vinculou a atividade ao negocio — ver o comentario de
  // garantirVinculoAtividadeDeal, o 2xx do POST acima nao garante isso.
  const vinculada = await garantirVinculoAtividadeDeal(atividadeId, dealId);
  if (!vinculada) {
    const texto = `⚠️ A atividade ${atividadeId} foi criada na agenda do Moskit mas NAO ficou vinculada ao negócio (o Moskit as vezes perde esse vínculo quando o negócio acabou de ser escrito) — vincule na mão para ela aparecer na tela do negócio.`;
    await criarNotaMoskit(dealId, texto).catch(() => {});
    await enviarTelegram(`❌ *Atividade criada sem vínculo com o negócio*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
  }

  db.prepare('UPDATE conversations SET atividade_moskit_id = ? WHERE chat_id = ?').run(atividadeId, chatId);
  stmtAtividadeMarcarSincronizada.run(atividadeId, eventoId, dealId); // <- trava anti-evento-duplicado
  console.log(`  🗓️ Consulta marcada na agenda do Moskit (atividade ${atividadeId}, deal ${dealId})`);
  return true;
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

  // Chegar aqui com horario invalido significa que a dupla confirmacao JA aconteceu (cliente e equipe
  // concordaram) e ainda assim nao vai existir reuniao. Isso tem que LANCAR, nao devolver null: o
  // catch de quem chama vira nota no deal + Telegram. Antes era `return null` silencioso, e foi
  // exatamente esse silencio que deixou o caso do Arthur (deal 48370184) invisivel — a partir do
  // guard de formato, o sintoma deixou de ser "reuniao no horario errado" e passou a ser "reuniao que
  // ninguem marcou e ninguem soube", repetindo a cada ciclo de 5 min so no console.
  const inicioNaive = normalizarHorarioNaive(dados.data_hora_consulta);
  if (!inicioNaive) {
    const erro = new Error(`horario da consulta invalido ("${dados.data_hora_consulta}") — esperado AAAA-MM-DDTHH:MM:00 em hora do escritorio`);
    // Marca o erro pra handleAgendamentoCalendar distinguir "dado ruim" (sem data confiavel, aborta
    // tudo) de falha real da API do Google (rede/OAuth/quota — nesse caso a Atividade do Moskit ainda
    // pode e deve nascer, ver comentario la).
    erro.horarioInvalido = true;
    throw erro;
  }
  const fimNaive = somarMinutosNaive(inicioNaive, 60); // duracao media de 1h
  const presencial = dados.modalidade_consulta === 'presencial';

  const calendar = google.calendar({ version: 'v3', auth });
  const event = {
    summary: montarResumoEvento(dados),
    description: montarDescricaoEvento(dados, chatId),
    start: { dateTime: inicioNaive, timeZone: TZ_ESCRITORIO },
    end: { dateTime: fimNaive, timeZone: TZ_ESCRITORIO },
    ...(presencial ? {} : {
      conferenceData: {
        createRequest: {
          requestId: `meet-${chatId}-${Date.parse(`${inicioNaive}Z`)}`, // so precisa ser deterministico e unico
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

  // Camada de defesa teorica (nao confirmada em incidente real, achada revisando o codigo em
  // 14/08/2026): quando podeAgendar e true, o override acima DESCARTA o `data_hora_consulta` bruto
  // que o modelo devolveu nesta rodada em favor de `apuracao.horarioIso` — se a apuracao fechar com
  // um par ANTIGO mas autoconsistente (ja igual ao que esta no banco), `atualizarEventoSeRemarcado`
  // faz um `return` silencioso (`row.evento_calendar_data === novoInicioNaive`) sem instrumentacao
  // nenhuma. So registra (nota + hash proprio, sem Telegram — e defesa, nao incidente confirmado)
  // quando ja existe reuniao marcada e os dois valores discordam.
  if (row?.evento_calendar_criado && podeAgendar) {
    const brutoNaive = normalizarHorarioNaive(dados?.data_hora_consulta);
    const efetivoNaive = normalizarHorarioNaive(dadosEvento?.data_hora_consulta);
    if (brutoNaive && efetivoNaive && brutoNaive !== efetivoNaive) {
      const hash = `${brutoNaive}|${efetivoNaive}`;
      const atual = db.prepare('SELECT agendamento_divergencia_hash FROM conversations WHERE chat_id = ?').get(chatId);
      if (atual?.agendamento_divergencia_hash !== hash) {
        console.log(`  ⚠️ deal ${dealId}: apuracao fechou em ${efetivoNaive} mas o modelo devolveu ${brutoNaive} nesta rodada — divergencia registrada`);
        await criarNotaMoskit(dealId, `⚠️ A dupla confirmação fechou em ${formatarHorarioEscritorio(efetivoNaive)}, mas a IA havia entendido ${formatarHorarioEscritorio(brutoNaive)} nesta rodada — vale conferir a conversa manualmente.`).catch(() => {});
        db.prepare('UPDATE conversations SET agendamento_divergencia_hash = ? WHERE chat_id = ?').run(hash, chatId);
      }
    }
  }

  if (row?.evento_calendar_criado) {
    if (!row?.evento_calendar_id) {
      console.log(`  ⚠️ Chat ${chatId} ja tem evento_calendar_criado=1 mas sem evento_calendar_id salvo (conversa anterior a essa correcao) — nao da pra atualizar automaticamente, revisar manualmente se precisar remarcar`);
      return;
    }
    // Corrigir titulo/descricao nao move nada, entao roda sempre — inclusive quando a remarcacao
    // esta travada por falta de confirmacao.
    if (dados.data_hora_consulta) await sincronizarMetadadosEvento(dados, chatId, row);

    // Auto-cura: achado em 14/08/2026 que 21 de 27 consultas com evento no Google NUNCA tiveram a
    // Atividade criada no Moskit (falha silenciosa de POST /activities, sem log nem nota nem
    // Telegram — ja corrigido em criarAtividadeMoskit). Esse ramo (evento JA existia) nunca tentava
    // criar a Atividade que falta — so `atualizarAtividadeMoskit` quando ela ja existe.
    //
    // Roda ANTES do `if (!podeAgendar) return` de proposito: o evento no Google ja existe
    // (`row.evento_calendar_criado`), entao a reuniao ja foi confirmada de verdade numa rodada
    // anterior — a auto-cura nao depende de a IA reconfirmar a dupla confirmacao HOJE. Foi assim que
    // a primeira versao deste fix (dentro do `if (podeAgendar)`) deixou o deal 48287898 sem cura: o
    // eco-da-data-ancora corretamente rejeitou o horario extraido nessa rodada, `podeAgendar` deu
    // false, e o `return` logo abaixo nunca deixava a auto-cura rodar.
    // `registrarConsultaNaAgendaMoskit` ja e idempotente (`if (row?.atividade_moskit_id) return
    // false`), entao chamar aqui e seguro tanto quando a Atividade ja existe quanto quando falta. Sem
    // meetLink aqui de proposito — buscar o link do Meet exigiria reler o evento do Google; a
    // Atividade nascer sem o link nas notas e aceitavel, o essencial e ela existir (ver "Limitacao
    // aceita" no plano).
    const naAgendaMoskit = await registrarConsultaNaAgendaMoskit({
      dealId, dados: dadosEvento, chatId, horarioIso: row.evento_calendar_data, meetLink: null, eventoId: row.evento_calendar_id, row,
    });
    if (naAgendaMoskit) {
      await criarNotaMoskit(dealId, '🗓️ Consulta marcada na agenda do Moskit (a atividade estava faltando e foi criada agora).');
      // `row` e o snapshot lido ANTES deste ciclo — registrarConsultaNaAgendaMoskit acabou de gravar
      // atividade_moskit_id no banco, mas o objeto em memoria continua com o valor antigo (nulo).
      // Sem atualiza-lo aqui, atualizarEventoSeRemarcado (logo abaixo) nao acha a atividade que acabou
      // de nascer e nao move o dueDate dela quando a remarcacao acontece NO MESMO ciclo da auto-cura —
      // a atividade fica presa na data antiga (row.evento_calendar_data) pra sempre, sem nenhum sinal.
      row = { ...row, atividade_moskit_id: db.prepare('SELECT atividade_moskit_id FROM conversations WHERE chat_id = ?').get(chatId)?.atividade_moskit_id };
    }

    // Remarcar uma reuniao ja marcada exige o MESMO criterio de criar. Sem essa trava, qualquer
    // data extraida movia a reuniao de um cliente real — inclusive um horario que a equipe apenas
    // PROPOS e o cliente nunca respondeu.
    if (!podeAgendar) {
      // So anota se houver horario em jogo. Sem isso, toda conversa ja agendada geraria uma nota de
      // "nao remarcada" a cada ciclo, mesmo quando ninguem falou de horario nenhum.
      if (apuracao?.cliente || apuracao?.equipe) {
        console.log(`  ⏭️ deal ${dealId}: reuniao NAO remarcada — ${descreverPendencia(apuracao)}`);
        await registrarAgendamentoPendente(dealId, chatId, apuracao, true, row);
      }
      return;
    }
    await atualizarEventoSeRemarcado(dealId, dadosEvento, chatId, row);

    // Evento ja existia e a dupla confirmacao continua valida — o deal tem consulta marcada de
    // verdade. "consulta_agendada" fica orfa desde que foi mapeada (MOSKIT_STAGE_MAP): a IA nunca
    // sugere esse estagio (estagio_funil_sugerido so cobre o que vem DEPOIS da consulta), entao sem
    // esta chamada nenhum deal chegava la. So avanca (nunca volta, ver moverEstagioSeAvancar).
    await moverEstagioSeAvancar(dealId, 'consulta_agendada');
    // Este ramo roda em TODO ciclo enquanto a confirmacao continuar valida (nao so na primeira
    // vez) — handleContratoZapSign tem seu proprio guard de idempotencia (contrato_zapsign_criado).
    await handleContratoZapSign(dealId, dados, chatId, row);
    return;
  }

  if (!podeAgendar) {
    // So vale anotar quando existe algum horario em jogo — conversa que nem chegou a falar de data
    // nao e "pendencia", e so uma conversa em andamento.
    if (apuracao?.cliente || apuracao?.equipe || dados.data_hora_consulta) {
      console.log(`  ⏭️ deal ${dealId}: evento NAO criado — ${descreverPendencia(apuracao || { motivo: 'falta_ambos' })}`);
      await registrarAgendamentoPendente(dealId, chatId, apuracao, false, row);
    }
    return;
  }

  // Google e Moskit sao tentados de forma DESACOPLADA a partir daqui: uma falha real da API do
  // Google (rede, token expirado, quota) nao pode impedir a Atividade de nascer na agenda do Moskit
  // — foi exatamente essa dependencia (Moskit so era tentado DEPOIS do Google ter sucesso, dentro do
  // mesmo try) que deixou as DUAS agendas vazias no deal 48474073 quando so o Google falhou.
  //
  // "Data invalida" (eco da data-ancora, formato estranho — `erro.horarioInvalido`) e um caso
  // DIFERENTE e continua abortando tudo: sem uma data confiavel nao existe reuniao pra marcar em
  // lugar nenhum, nem Google nem Moskit.
  let evento = null;
  let erroGoogle = null;
  try {
    evento = await criarEventoGoogleCalendar(dadosEvento, chatId);
  } catch (e) {
    if (e.horarioInvalido) {
      console.error(`  ❌ Erro ao criar evento no Google Calendar: ${e.message}`);
      await registrarErroAgendamento(dealId, chatId, e.message, false);
      return; // dado ruim: sem isso, o avanco de estagio abaixo rodaria com uma data que nao presta
    }
    erroGoogle = e; // falha real de API/rede/OAuth — a Atividade do Moskit ainda pode e deve nascer
    console.error(`  ❌ Erro ao criar evento no Google Calendar: ${e.message}`);
  }

  if (evento) {
    db.prepare('UPDATE conversations SET evento_calendar_criado = 1, evento_calendar_id = ?, evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(evento.id, apuracao.horarioIso, chatId);
  }
  const dataFormatada = formatarHorarioEscritorio(apuracao.horarioIso);
  const meetLink = evento ? extrairMeetLink(evento) : null;
  const notaComprovante = pagamentoVerificado ? ' (comprovante verificado)' : ' ⚠️ SEM comprovante verificado';
  const evidencia = `\nCliente aceitou: "${apuracao.cliente.trecho}" · Equipe confirmou: "${apuracao.equipe.trecho}"`;

  // Tenta a Atividade do Moskit INDEPENDENTE do Google ter dado certo — o que garante que o deal
  // tenha a consulta marcada em pelo menos uma agenda mesmo com o Google fora do ar. Com eventoId
  // nulo, `registrarConsultaNaAgendaMoskit` ainda grava `atividades_sincronizadas` (trava
  // anti-duplicado), so sem apontar pra um evento que nao existe.
  const naAgendaMoskit = await registrarConsultaNaAgendaMoskit({
    dealId, dados: dadosEvento, chatId, horarioIso: apuracao.horarioIso, meetLink, eventoId: evento?.id || null, row,
  });

  if (evento) {
    await criarNotaMoskit(dealId, `📅 Reunião agendada no Google Calendar: ${dataFormatada}${notaComprovante}${evidencia}${meetLink ? `\nLink do Meet: ${meetLink}` : ''}${naAgendaMoskit ? '\n🗓️ Também marcada na agenda do Moskit.' : ''}`);
    await notificarTelegramMeet({
      nome: dados.nome,
      telefone: chatId,
      advogado: dados.advogado_responsavel,
      dataHoraTexto: dataFormatada,
      meetLink,
      dealId,
    });
  } else if (erroGoogle) {
    // A dupla confirmacao e a data sao boas — so a chamada ao Google falhou de verdade. Uma nota
    // otimista aqui seria mentira se a Atividade TAMBEM tiver falhado (criarAtividadeMoskit ja posta
    // a propria nota de falha nesse caso); por isso o texto se ajusta conforme `naAgendaMoskit`.
    await criarNotaMoskit(dealId, naAgendaMoskit
      ? `🗓️ Consulta marcada na agenda do Moskit: ${dataFormatada}${evidencia}\n⚠️ Mas o evento no Google Calendar/Meet NÃO foi criado (${erroGoogle.message}). Será tentado de novo automaticamente no próximo reprocessamento.`
      : `⚠️ A consulta foi confirmada (${dataFormatada})${evidencia}, mas NEM o Google Calendar NEM a agenda do Moskit foram atualizados (Google: ${erroGoogle.message}). Verificar manualmente.`);
    await registrarErroAgendamento(dealId, chatId, erroGoogle.message, false);
  }
  // evento nulo sem erroGoogle = Google nao configurado (getGoogleAuthClient() devolveu null, tipico
  // de ambiente sem as credenciais) — nao e falha de producao, so segue: a Atividade do Moskit ja foi
  // tentada acima.

  // Avanca de estagio e dispara o contrato sempre que a consulta esta marcada em QUALQUER UMA das
  // duas agendas — e essa marcacao real, nao so a intencao do Google ter dado certo, que importa
  // pro funil (e e exatamente isso que o usuario pediu: a Atividade aparecer no deal).
  if (evento || naAgendaMoskit) {
    await moverEstagioSeAvancar(dealId, 'consulta_agendada');
    await handleContratoZapSign(dealId, dados, chatId, row);
  }
}

// Gera automaticamente o contrato de Prestacao de Servico no ZapSign, preenchido com os dados que
// o bot ja tem, assim que o agendamento da consulta e confirmado (dupla confirmacao cliente+equipe
// — mesmo criterio de handleAgendamentoCalendar, que e quem chama esta funcao). So dispara UMA vez
// por deal: o guard abaixo e necessario porque o ramo "evento ja existia" chama esta funcao em todo
// ciclo de reprocessamento enquanto a confirmacao continuar valida, nao so na primeira vez.
async function handleContratoZapSign(dealId, dados, chatId, row) {
  if (!dealId || row?.contrato_zapsign_criado) return;

  const faltantes = zapsign.camposContratoFaltantes(dados);
  if (faltantes.length) {
    await registrarPendenciaContrato(dealId, chatId, faltantes);
    return;
  }

  try {
    const resultado = await zapsign.criarDocumentoZapSign(dados, chatId, new Date().toISOString());
    if (!resultado.ok) {
      // Corrida rara: os dados passaram no gate acima mas mudaram/zeraram entre o check e a
      // chamada (nao deveria acontecer no fluxo normal, mas nao custa nao mandar documento vazio).
      await registrarPendenciaContrato(dealId, chatId, resultado.faltantes || []);
      return;
    }
    db.prepare(
      'UPDATE conversations SET contrato_zapsign_criado = 1, contrato_zapsign_doc_token = ?, contrato_zapsign_status = ?, contrato_zapsign_pendente_hash = NULL WHERE chat_id = ?'
    ).run(resultado.docToken, resultado.status || 'pending', chatId);
    await criarNotaMoskit(dealId, `📄 Contrato de Prestação de Serviço enviado para assinatura via ZapSign (convite por e-mail para ${dados.email_cliente}).`);
    await moverEstagioSeAvancar(dealId, 'contrato_enviado');
  } catch (e) {
    console.error(`  ❌ Erro ao criar contrato no ZapSign (deal ${dealId}): ${e.message}`);
    // Erro real de API (token/template invalido, rede, etc) — nao confundir com dado faltante.
    // Nao relanca: mesmo raciocinio de criarEventoGoogleCalendar, a causa mais provavel aqui e
    // configuracao errada, nao falha transitoria, entao nao faz sentido entrar na fila de retry.
    await registrarErroContrato(dealId, chatId, e.message);
  }
}

// Nota no deal quando falta algum dado pro contrato (CPF, profissao, endereco, e-mail, valor de
// honorarios...) — mesmo padrao de registrarAgendamentoPendente: hash evita repetir a nota a cada
// ciclo de 5 min enquanto a mesma lista de campos continuar faltando. Como o bot nunca manda
// mensagem pro cliente (so le o que a Zernio ja trouxe), esta nota e o unico jeito de a equipe
// saber que precisa pedir esses dados pelo WhatsApp real dela.
async function registrarPendenciaContrato(dealId, chatId, faltantes) {
  if (!dealId || !faltantes?.length) return;
  const hash = faltantes.slice().sort().join(',');

  const atual = db.prepare('SELECT contrato_zapsign_pendente_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.contrato_zapsign_pendente_hash === hash) return;

  try {
    await criarNotaMoskit(dealId, `⏳ Contrato de Prestação de Serviço NÃO gerado — faltam: ${faltantes.join(', ')}. Peça esses dados ao cliente pelo WhatsApp.`);
    db.prepare('UPDATE conversations SET contrato_zapsign_pendente_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar pendencia de contrato no deal ${dealId}: ${e.message}`);
  }
}

// Nota no deal quando os dados estavam completos mas a CHAMADA a API do ZapSign falhou de verdade
// (token/template invalido, rede, etc) — eixo diferente de registrarPendenciaContrato (dado
// faltante). Mesmo padrao de registrarErroAgendamento — inclusive o aviso no Telegram: uma falha de
// API tende a afetar TODOS os contratos seguintes, nao so este deal, e sem Telegram ninguem percebe
// ate abrir o deal na mao.
async function registrarErroContrato(dealId, chatId, mensagemErro) {
  if (!dealId) return;
  const hash = String(mensagemErro || '').slice(0, 200);

  const atual = db.prepare('SELECT contrato_zapsign_erro_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.contrato_zapsign_erro_hash === hash) return;

  const texto = `❌ Falha ao gerar contrato no ZapSign: ${mensagemErro}. Verificar manualmente (ZAPSIGN_API_KEY/ZAPSIGN_TEMPLATE_TOKEN configurados corretamente?).`;
  try {
    await criarNotaMoskit(dealId, texto);
    await enviarTelegram(`❌ *Falha ao gerar contrato*\nDeal: \`${dealId}\`\nTelefone: \`${chatId}\`\n${texto}`);
    db.prepare('UPDATE conversations SET contrato_zapsign_erro_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar FALHA de contrato no deal ${dealId}: ${e.message}`);
  }
}

// Nota no deal quando ha horario em jogo mas o agendamento esta travado. O hash evita repetir a mesma
// nota a cada ciclo de 5 min enquanto a situacao nao muda.
//
// MEDIDO em 14/08/2026 (deals 48292471/48287898): a apuracao ja identificava a pendencia certa
// (motivo falta_cliente) e o Telegram ja e incondicional quando remarcacao=true — mas em pelo menos
// um caso (Lia) NENHUM campo que o modelo devolveu naquela rodada carregava o horario novo, entao o
// hash de dedup (que so olha pra motivo/horario relatado) nunca mudou enquanto a reuniao ficava mais
// perto, e o aviso nao insistiu. `row` (novo parametro) traz o que ESTA na agenda pra dois reforcos:
// (1) uma divergencia de CONTEUDO explicita quando a perna validada discorda do banco (pega o caso da
// Solange, cuja equipe confirmou "18/08" com trecho limpo mas o banco seguia em "16/08"); (2) uma
// escalada por PROXIMIDADE que reenvia o Telegram mesmo com hash igual, quando a reuniao ja marcada
// esta perto (`AGENDAMENTO_URGENCIA_HORAS`) — essa e a garantia que nao depende do modelo acertar
// nada, porque nem sempre ele acerta.
async function registrarAgendamentoPendente(dealId, chatId, apuracao, remarcacao, row) {
  if (!dealId) return;
  const motivo = apuracao?.motivo || 'falta_ambos';
  const horarioRelatado = apuracao?.equipe?.horario_iso || apuracao?.cliente?.horario_iso || null;
  const descartados = apuracao?.horariosDescartados || [];
  const bancoNaive = row?.evento_calendar_data || null;

  // Divergencia de CONTEUDO: a perna validada (quando existe) discorda do horario ja marcado. So faz
  // sentido comparar quando ja existe reuniao (bancoNaive truthy) — sem isso e so uma proposta nova,
  // nao uma divergencia.
  const divergeDoConteudo = !!(bancoNaive && horarioRelatado && bancoNaive !== horarioRelatado);
  const hash = `${horarioRelatado}|${motivo}|${remarcacao ? 'R' : 'C'}|${descartados.length}|${divergeDoConteudo ? bancoNaive : ''}`;

  // Urgencia por PROXIMIDADE — funciona mesmo sem nenhum sinal de conteudo (ver comentario da funcao).
  let urgente = false;
  if (remarcacao && bancoNaive) {
    const instante = horarioNaiveParaInstante(bancoNaive, TZ_ESCRITORIO);
    if (instante) {
      const horasAteReuniao = (new Date(instante).getTime() - Date.now()) / 3_600_000;
      urgente = Math.abs(horasAteReuniao) <= AGENDAMENTO_URGENCIA_HORAS;
    }
  }

  const atual = db.prepare('SELECT agendamento_pendente_hash FROM conversations WHERE chat_id = ?').get(chatId);
  const hashMudou = atual?.agendamento_pendente_hash !== hash;
  if (!hashMudou && !urgente) return; // nada novo, e a reuniao (se existir) nao esta perto o bastante

  const quando = formatarHorarioEscritorio(horarioRelatado) || 'horário ainda não definido';
  const acao = remarcacao ? 'Reunião NÃO remarcada' : 'Consulta NÃO lançada na agenda';
  // Horario que o modelo devolveu e a rede deterministica recusou (eco da data-ancora, formato com
  // fuso, madrugada). Vale na nota porque muda o diagnostico: nao e "o cliente ainda nao respondeu",
  // e "o horario extraido nao servia" — sem isso a equipe procura a confirmacao que ja existe.
  const detalheDescartado = descartados.length
    ? `\nHorário extraído e recusado pela validação: ${descartados.map((d) => `"${d.valor}" (${d.motivo})`).join('; ')}`
    : '';
  // O que ESTA na agenda agora — faltava na nota antiga, que so falava do que a IA extraiu nesta
  // rodada (que pode nao ter extraido nada de novo, como no caso da Lia).
  const detalheBanco = bancoNaive
    ? `\nAgenda atual mostra: ${formatarHorarioEscritorio(bancoNaive)}${divergeDoConteudo ? ' (diferente do que foi comunicado na conversa)' : ''}`
    : '';

  try {
    if (hashMudou) {
      await criarNotaMoskit(dealId, `⏳ ${acao}: ${quando} — ${descreverPendencia({ motivo })}.${detalheDescartado}${detalheBanco}\nO evento é criado/movido quando as duas confirmações aparecerem na conversa.`);
    }

    // Telegram so no que e acionavel e surpreendente. Uma REMARCACAO travada e o caso grave: ja existe
    // reuniao na agenda e ela agora esta no horario errado — foi o que fez o cliente do deal 47543238
    // esperar sozinho ("Estou aguardando aqui para o horario agendado") com o evento parado no dia
    // velho. Horario recusado pela validacao tambem avisa, porque indica extracao quebrada. O que NAO
    // avisa por hash novo e a pendencia de rotina (falta a confirmacao de um dos lados num agendamento
    // novo): isso e o fluxo normal do atendimento e viraria ruido diario no Telegram. Mas se a
    // pendencia e de remarcacao E a reuniao esta perto (`urgente`), reenvia mesmo com hash igual — a
    // proximidade sozinha ja justifica.
    if (hashMudou ? (remarcacao || descartados.length) : urgente) {
      await enviarTelegram([
        remarcacao ? `⚠️ *Reunião NÃO remarcada — agenda com horário velho*` : `⚠️ *Horário da consulta recusado pela validação*`,
        `Chat: \`${chatId}\``,
        dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
        `Horário relatado na conversa: ${quando}`,
        bancoNaive ? `Agenda atual: ${formatarHorarioEscritorio(bancoNaive)}` : '',
        `Situação: ${descreverPendencia({ motivo })}`,
        descartados.length ? `Recusado: ${descartados.map((d) => `"${d.valor}" — ${d.motivo}`).join('; ')}` : '',
        urgente && !hashMudou ? '⏰ Reenviando: a reunião está próxima e a pendência continua sem resolver.' : '',
        '',
        remarcacao
          ? 'A reunião que já está na agenda pode estar no horário ANTIGO. Conferir a conversa e remarcar na mão.'
          : 'Conferir na conversa qual horário foi combinado e marcar na mão se já estiver fechado.',
      ].filter(Boolean).join('\n'));
    }
    if (hashMudou) db.prepare('UPDATE conversations SET agendamento_pendente_hash = ? WHERE chat_id = ?').run(hash, chatId);
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
    // Nota no deal nao e suficiente: ninguem abre o deal a tempo. As duas partes ja combinaram um
    // horario e nao existe reuniao — isso tem que chegar em quem pode marcar na mao, hoje.
    await enviarTelegram([
      `❌ *Consulta confirmada mas NÃO agendada*`,
      `Chat: \`${chatId}\``,
      dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
      `Motivo: ${mensagemErro}`,
      '',
      `Cliente e equipe já confirmaram o horário, mas ${acao}. Marcar na mão e verificar a integração.`,
    ].filter(Boolean).join('\n'));
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

  // Ja veio saneado de processarConversaDirect (normalizarHorarioNaive/motivoHorarioImplausivel), mas
  // handleAgendamentoCalendar tambem e chamado direto pelos testes e pelo reprocessamento manual —
  // aqui e a ultima linha antes de um PATCH em reuniao de cliente real. Nao pode ser `return` mudo:
  // quem chega aqui tem evento na agenda E dupla confirmacao valida, entao o horario velho continuar
  // no lugar e um erro que precisa aparecer.
  const novoInicioNaive = normalizarHorarioNaive(dados.data_hora_consulta);
  if (!novoInicioNaive) {
    if (dados.data_hora_consulta) {
      console.log(`  ⚠️ remarcacao ignorada: horario invalido ("${dados.data_hora_consulta}")`);
      await registrarErroAgendamento(dealId, chatId, `horario da consulta invalido ("${dados.data_hora_consulta}") — a reuniao na agenda continua no horario anterior`, true);
    }
    return;
  }

  // evento_calendar_data grava sempre a mesma string naive usada no payload (criacao: acima em
  // handleAgendamentoCalendar; atualizacao: mais abaixo) — comparar por igualdade de STRING e mais
  // simples e robusto que reconverter timestamps, e dispensa reler o evento do Google so pra essa
  // checagem (era o `calendar.events.get` + `inicioAtual` que existiam so pra isso).
  if (row?.evento_calendar_data === novoInicioNaive) return; // nao mudou de verdade, evita ruido a cada ciclo

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const novoFimNaive = somarMinutosNaive(novoInicioNaive, 60);
    const patched = await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.evento_calendar_id,
      requestBody: {
        start: { dateTime: novoInicioNaive, timeZone: TZ_ESCRITORIO },
        end: { dateTime: novoFimNaive, timeZone: TZ_ESCRITORIO },
      },
    });

    db.prepare('UPDATE conversations SET evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(novoInicioNaive, chatId);

    const dataFormatada = formatarHorarioEscritorio(novoInicioNaive);
    const meetLink = extrairMeetLink(patched.data);
    console.log(`  🔁 Reunião remarcada para ${dataFormatada} (chat ${chatId})`);

    // As duas agendas movem juntas. Sem isto, a agenda do CRM continuaria mostrando o horario velho
    // — pior que nao ter compromisso nenhum la, porque parece certo e esta errado. O guard de
    // "nao mudou de verdade" la em cima ja impede um PUT redundante a cada ciclo.
    const naAgendaMoskit = row?.atividade_moskit_id
      ? await atualizarAtividadeMoskit(row.atividade_moskit_id, horarioNaiveParaInstante(novoInicioNaive, TZ_ESCRITORIO), dealId)
      : false;

    await criarNotaMoskit(dealId, `🔁 Reunião remarcada para ${dataFormatada}${meetLink ? `\nLink do Meet (o mesmo de antes): ${meetLink}` : ''}${naAgendaMoskit ? '\n🗓️ Agenda do Moskit atualizada também.' : ''}`);
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
3. O cliente contou algum fato do caso dele? Se NAO (so saudacao, so pedido de consulta, so o nome de um advogado), area_direito e advogado_responsavel ficam null e o assunto e "Consulta juridica".
4. ATENCAO: advogado_responsavel eh DEFINIDO pela area_direito, NAO por qual socio o lead mencionou.
5. O lead fez pagamento ou enviou comprovante?
6. Qual acao e mais adequada?

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
1. assunto — tema curto do caso, 2 a 5 palavras (ex: "Inventario", "Usucapiao de imovel", "Abatimento do FIES", "Rescisao de contrato"). E o que aparece no titulo do negocio no CRM, entao seja especifico e direto, sem frase completa. NUNCA deixe null: se o cliente ainda NAO contou o caso, use exatamente "Consulta juridica" — NUNCA use o nome de uma area do direito como assunto (isso transforma um palpite de area no titulo do negocio).
2. origem — SEMPRE preencher. Extraia da mensagem inicial. Se nao encontrar, use "Nao identificado".
3. tipo_consulta — "consulta paga" por padrao. Use "consulta gratis" APENAS se a equipe disser explicitamente que a consulta e cortesia/gratuita/sem custo/isenta. Use "sem consulta" so se o lead disser EXPLICITAMENTE que nao quer contratar.
4. area_direito — Use seu conhecimento juridico para inferir a area A PARTIR DO QUE O CLIENTE CONTOU SOBRE O CASO, e de nada mais. Se ele so cumprimentou, so pediu consulta, so disse por qual canal chegou ou so citou o nome de um advogado ("quero falar com o Dr. Berto"), voce NAO sabe a area: devolva null. E PROIBIDO derivar a area de captacao, de origem, do advogado que o lead mencionou ou dos PERFIS DOS ADVOGADOS abaixo — o caminho e sempre area -> advogado, nunca advogado -> area. Deixar null e o resultado correto e esperado nessa situacao; a area entra numa rodada seguinte, quando o cliente descrever o caso.
   CASO RECORRENTE NESTE ESCRITORIO — FIES: caso envolvendo financiamento estudantil (FIES) — negativa administrativa, transferencia de curso, renegociacao, aditamento, recurso — e SEMPRE "Direito Educacional", mesmo que o cliente nao diga isso com essas palavras (deals 48474073, 48466404, 48464876, 48320992 nasceram com area_direito null porque o modelo nao fez essa ligacao sozinho, apesar do caso estar descrito).
5. advogado_responsavel — Determinado UNICAMENTE pela area_direito, pela TABELA AREA -> ADVOGADO abaixo. Se area_direito estiver null ou incerta, mantenha null. NAO derive do nome do lead ou de qual socio ele mencionou. (O sistema reaplica essa tabela em cima do que voce responder: se divergir, o valor da tabela vence.)
6. captacao — Se mencionou rede social de Berto, Bruno ou Iury, ou foi indicado por um deles, preencha com o nome do socio (INDEPENDENTE de area_direito estar definida). CASO CONTRARIO, preencha com o MESMO valor de advogado_responsavel (que pode ser null se area_direito nao identificada).
7. pagamento_confirmado — boolean. True APENAS se DISSE que pagou OU enviou comprovante. Senao false.

CAMPOS OPCIONAIS (usados pra agendar a reuniao no Google Agenda — deixe null se nao tiver certeza):
8. data_hora_consulta — data/hora ISO 8601 (ex: "2026-07-31T10:00:00") que o cliente CONFIRMOU pra consulta, OU que a equipe do escritorio confirmou ter marcado com o cliente (mensagem "Equipe do escritório:"). Use "Data/hora da ultima mensagem desta conversa" (fornecida no CONTEXTO ATUAL) como referencia (data-ancora) pra resolver dias relativos tipo "sexta de manha", "amanha as 10h", "dia 9 de janeiro" — NUNCA invente uma data se nem o cliente nem a equipe confirmaram um dia/horario especifico. Se so disse "pode ser" sem dia/horario, ou se ainda esta negociando, deixe null.
   SEMPRE RECALCULE: derive a data da CONVERSA + tabela CALENDARIO DE REFERENCIA a cada rodada. NUNCA copie o data_hora_consulta que aparece em "Dados ja extraidos anteriormente" — esse valor pode ter sido calculado errado antes. Se o que voce derivar agora divergir do valor anterior, use o que voce derivou agora.
   ATENCAO AO DIA DA SEMANA: se a conversa citar um dia pelo NOME ("quarta-feira", "na sexta") sem dizer o numero do dia, procure esse dia na tabela CALENDARIO DE REFERENCIA e use a PRIMEIRA ocorrencia DEPOIS da data-ancora. NUNCA calcule de cabeca. Se o dia citado for o mesmo dia da semana da data-ancora, use a ocorrencia da semana seguinte, a nao ser que a mensagem diga "hoje". Exemplo: data-ancora 2026-07-30 (quinta-feira), mensagem diz "quarta-feira" -> a tabela mostra 2026-08-05 = quarta-feira -> use 2026-08-05, NUNCA 2026-08-03.
   ATENCAO A PROPOSTA SEM RESPOSTA: se a ultima mensagem sobre horario for uma PROPOSTA da equipe que o cliente ainda nao aceitou (ex: "Podemos marcar na quarta as 17:30?" e nenhuma resposta depois), NAO troque a data — mantenha o horario ANTERIOR ja confirmado, ou null se nunca houve um.
   ATENCAO AO ANO: o resultado tem que ser uma data no FUTURO em relacao a data-ancora. Se o cliente mencionar so dia e mes (ex: "dia 9 de janeiro", "15 de marco") sem dizer o ano, calcule: se essa data (dia+mes) no ANO da data-ancora ja passou ou eh igual a data-ancora, use o ANO SEGUINTE. Exemplo: data-ancora 2026-07-24, cliente diz "dia 9 de janeiro" → 09/01 no ano 2026 ja passou → use 2027-01-09, NUNCA 2026-01-09.
   FORMATO OBRIGATORIO: exatamente "AAAA-MM-DDTHH:MM:00" — hora do ESCRITORIO, sem "Z" e sem offset, e os segundos SEMPRE "00". Consulta e marcada em minuto redondo e dentro do horario comercial. Se o horario que voce ia devolver tem segundos diferentes de 00, ou cai de madrugada, ele nao veio da conversa: devolva null.
   NUNCA use a data-ancora como resposta. Ela e a hora em que a ULTIMA MENSAGEM foi enviada, nao a hora da consulta. Se a conversa nao diz um dia/horario que as duas partes trataram, o valor correto e null — null e uma resposta certa, a hora da mensagem e sempre errada.
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

CAMPOS DO CONTRATO (usados so pra preencher automaticamente o contrato de Prestacao de Servico no ZapSign quando a consulta e agendada — SAO DADOS SENSIVEIS. Extraia APENAS se a pessoa (cliente ou equipe) escreveu literalmente na conversa. NUNCA infira, calcule ou derive CPF/endereco/profissao/estado civil a partir de outro campo, do nome ou de qualquer suposicao — e melhor deixar null do que errar um desses. Deixe null se nao tiver 100% de certeza):
14. cpf — APENAS se o cliente escreveu literalmente o numero do CPF na conversa.
15. profissao — APENAS se o cliente mencionou explicitamente sua profissao.
16. estado_civil — APENAS se mencionado explicitamente ("sou casado", "sou solteira", "divorciado", etc).
17. endereco — APENAS se o cliente escreveu um endereco (rua/numero/bairro/cidade) na conversa.
18. valor_honorarios_inicial — valor em reais (numero, sem "R$") dos honorarios ADVOCATICIOS do CASO negociados pela EQUIPE (proposta de honorarios) — DIFERENTE do valor da consulta (R$350). So preencha se a equipe mencionou um valor especifico de honorarios nesta conversa.
19. valor_honorarios_liminar — idem, valor em reais dos honorarios de LIMINAR, se mencionado pela equipe. Null se nao houver liminar no caso.
20. valor_mensalidade — idem, valor em reais de MENSALIDADE do contrato, se mencionado pela equipe. Null se o contrato nao tiver mensalidade.

OBSERVACOES (obrigatorio — array "observacoes" no nivel raiz do JSON):
Cada linha da conversa comeca com um indice entre colchetes, tipo "[12] Cliente: ...". Relate os fatos abaixo CITANDO o indice da mensagem que prova cada um. O sistema confere a citacao: se o indice nao existir, se o papel de quem falou nao bater com o tipo, ou se o trecho nao aparecer mesmo na mensagem, a observacao e DESCARTADA. Nao invente citacao — observacao descartada e pior que observacao ausente.

Formato de cada item: {"tipo": "...", "msg_idx": 12, "trecho": "pedaco literal da mensagem", "horario_iso": "2026-08-05T17:30:00"}
O campo "trecho" tem que ser copiado LITERALMENTE da mensagem citada (pode ser um pedaco curto dela).
O campo "horario_iso" e OBRIGATORIO em todo tipo que termina em "_horario" — sempre preencha, nunca deixe de fora e nunca escreva texto tipo "quarta que vem". Se a mensagem nao repete o dia/hora (ex: cliente so respondeu "pode ser"), use o horario da proposta a que ela responde.

REGRA DE PAPEL (a que mais causa observacao descartada): o prefixo do tipo tem que bater com o rotulo da linha citada. Linha "[7] Cliente: ..." so aceita tipo comecando com "cliente_". Linha "[7] Equipe do escritório: ..." so aceita tipo comecando com "equipe_". Antes de escrever cada observacao, olhe o rotulo daquele indice e escolha o prefixo por ele — nao pelo conteudo da frase. Um cliente dizendo "consigo sexta as 14h" e "cliente_propos_horario", nunca "equipe_propos_horario".

Tipos permitidos:
- "cliente_descreveu_caso" (mensagem do CLIENTE) — o cliente contou O QUE ACONTECEU ou o que precisa resolver, com algum fato concreto do caso ("meu tio morreu e deixou uma casa sem testamento", "fui exonerada do cargo por motivo de saude", "recebi uma notificacao da ANPD"). Sem horario_iso. NAO valem como descricao do caso: saudacao ("ola", "bom dia"), pedido de consulta sem conteudo ("gostaria de agendar uma consulta"), preferencia de advogado ("quero falar com o Dr. Berto"), canal de origem ("vi seu Instagram") nem pergunta sobre preco. Esta observacao e o que autoriza o sistema a gravar area_direito/advogado_responsavel/assunto: se ninguem descreveu o caso, NAO emita esta observacao e devolva area_direito e advogado_responsavel null.
- "equipe_descreveu_caso" (mensagem da EQUIPE) — a EQUIPE descreveu o caso do cliente na conversa (resumo depois de uma ligacao, "ela quer entrar com acao de remocao por motivo de saude"). Sem horario_iso. Vale como a mesma evidencia do tipo acima. NAO vale a equipe apenas encaminhar o lead para um advogado ("vou passar pro Dr. Berto") — isso nao diz qual e o caso.
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
- Resolva o horario_iso com a mesma tabela CALENDARIO DE REFERENCIA usada em data_hora_consulta, e com as mesmas regras de dia da semana, de ano, de FORMATO OBRIGATORIO ("AAAA-MM-DDTHH:MM:00", segundos sempre 00) e a proibicao de usar a data-ancora como resposta.
- Se o cliente aceitou uma proposta sem repetir o dia/hora ("pode ser"), use o horario da proposta a que ele respondeu.
- Relate TODAS as ocorrencias, inclusive as antigas e as que se contradizem. O sistema usa a mais recente de cada tipo e sabe detectar sozinho que uma proposta nova reabriu a negociacao — nao tente filtrar nem resumir isso voce.
- REGRA CRITICA: percorra a conversa DE TRAS PRA FRENTE e garanta que a ULTIMA mensagem que menciona dia/hora esteja na lista, seja ela do cliente ou da equipe. Vale mesmo que ela desmarque, adie ou troque um horario que ja estava confirmado antes ("surgiu um imprevisto, consegue na sexta as 16h?"). Omitir essa mensagem faz o sistema agendar num horario que ja foi abandonado — e o pior erro possivel aqui. Se a EQUIPE propuser mais de um horario em sequencia (mesmo com uma mensagem de sistema/edicao entre elas), cada proposta e uma observacao "equipe_propos_horario" propria — nao descarte a anterior nem assuma que a mensagem seguinte repete o mesmo horario. A resposta do cliente vale para a proposta MAIS RECENTE que a precede, mesmo que a resposta nao repita o horario.
- So agendamos na agenda quando o CLIENTE aceitou E a EQUIPE confirmou o MESMO horario. Se so um dos dois falou, relate so o que existe; nao complete o que falta.

INSTRUCOES PARA resumo_atendimento (briefing pre-consulta do advogado):
Escreva um resumo ESPECIFICO e ACIONAVEL, nao generico. Use os fatos concretos que aparecem na conversa: nomes de pessoas ou empresas envolvidas, datas, valores, numero de processo, tipo de documento, prazos. Evite frases vagas tipo "cliente quer analise do caso" — prefira algo como "cliente foi notificado pela ANPD em 15/03 sobre vazamento de dados de clientes e quer saber se pode ser responsabilizado".
Estruture em 4 linhas (uma por topico, com quebra de linha \n entre elas — NAO use "|"):
📌 Caso: [o que aconteceu, com os detalhes concretos disponiveis — partes envolvidas, datas, valores, documentos]
📌 Objetivo do cliente: [o que especificamente ele quer resolver, saber ou contratar]
📌 Urgencia/prazo: [prazo, audiencia, notificacao ou data mencionada — se nao houver, escreva "Nao mencionado"]
📌 Ja tentou: [acoes anteriores mencionadas pelo cliente — se nao houver, escreva "Nada mencionado"]
Se a conversa nao tiver detalhe suficiente pra algum topico, escreva "Nao mencionado" em vez de inventar ou generalizar.

EXEMPLOS REAIS DE CAPTACAO (captacao = quem TROUXE o lead; adv_resp = quem CUIDA da area — podem ser pessoas diferentes):
- "Instagram do Bruno" + area=Familia → origem: Instagram, captacao: Bruno, adv_resp: Bruno
- "link da bio no Instagram do Dr. Berto" + area=Educacional → origem: Instagram, captacao: Berto, adv_resp: Iury (Educacional e do Iury, mesmo o lead tendo vindo pelo Berto)
- "vi a pagina do Bruno" + sem caso descrito → origem: Instagram, captacao: Bruno, adv_resp: null (sem area definida)
- "acessei o site do escritorio" + sem mencao a socio → origem: Site, captacao: [mesmo adv_resp, ou null se adv null]
- "minha prima falou, ela e amiga do escritorio" → origem: Indicacao de amigos e parentes, captacao: [mesmo adv_resp]

CONTRAEXEMPLO (lead que ainda nao contou o caso — caso real que entrou errado no CRM):
Cliente: "Olá!" / "Bom dia!" / "Tudo bem?" / "Gostaria de agendar uma consulta com o Dr. Berto, por videoconferencia."
Resposta correta: area_direito: null, advogado_responsavel: null, assunto: "Consulta juridica", captacao: "Berto", origem: [o canal, se ele disse], modalidade_consulta: "online", observacoes SEM "cliente_descreveu_caso".
ERRADO (foi o que aconteceu e nao pode repetir): area_direito: "LGPD", assunto: "Direito Digital" — deduzidos do perfil do Dr. Berto, sem uma linha sobre o caso. O cliente era servidora publica com caso de remocao por motivo de saude (Direito Administrativo).

Formato de resposta (use dados reais extraidos, nao descricoes):
{
  "acao": "criar",
  "justificativa": "Lead agendou consulta sobre inventario",
  "confianca": 8,
  "observacoes": [
    {"tipo": "cliente_descreveu_caso", "msg_idx": 2, "trecho": "meu pai faleceu e deixou uma casa"},
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
    "resumo_atendimento": "📌 Caso: pai do cliente faleceu ha 3 meses e deixou uma casa; os dois irmaos querem vender o imovel sem repassar a parte do cliente na heranca.\n📌 Objetivo do cliente: entender seus direitos no inventario e formalizar a partilha antes que os irmaos vendam a casa.\n📌 Urgencia/prazo: Nao mencionado.\n📌 Ja tentou: Nada mencionado.",
    "cpf": null,
    "profissao": null,
    "estado_civil": null,
    "endereco": null,
    "valor_honorarios_inicial": null,
    "valor_honorarios_liminar": null,
    "valor_mensalidade": null
  }
}

Valores permitidos:
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto, Bruno ou Iury — sempre pela TABELA AREA -> ADVOGADO abaixo

TABELA AREA -> ADVOGADO (regra do escritorio; e de mao unica, area define advogado e nunca o contrario):
- Direito Administrativo, LGPD                                                              -> Berto
- Direito Imobiliario, Direito de Familia, Direito Empresarial                              -> Bruno
- Solucoes Medicas, Direito Educacional, Direito Previdenciario, Direito do Consumidor,
  Direito do Trabalho                                                                       -> Iury
- Outros                                                                                    -> null (sem responsavel automatico)

PERFIS DOS ADVOGADOS (tabela de mao unica: serve para ir de AREA -> ADVOGADO. NUNCA use no sentido
inverso: o lead mencionar um advogado nao diz nada sobre a area do caso dele):
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
    .replace('{dataAtual}', descreverAncora(dataAtual || new Date().toISOString()));
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
  // Antes de qualquer outra consequencia: se algum campo de classificacao ficou vazio porque a IA
  // inventou um valor que nao existe no CRM, isso precisa aparecer para a equipe.
  await registrarOpcoesInvalidas(dealId, chatId, detectarOpcoesInvalidas(dadosMesclados || dados));

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
    // chatId viaja no mesmo objeto porque criarNegocioMoskit/atualizarNegocioMoskit precisam saber
    // ONDE registrar a autoria dos campos personalizados (custom_fields_bot/campos_travados), e todos
    // os ramos — inclusive aplicarViradaCobranca e garantirDealExiste — ja repassam `opcoesPayload`.
    const opcoesPayload = { condicoesValorEnviadas: bloco.enviado, chatId };

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
      if (o._horarioImplausivel) {
        console.log(`  🚫 horario_iso descartado na msg ${o.msg_idx} — ${o._horarioImplausivel.motivo}`);
      }
    }

    // A mesma rede deterministica das observacoes, agora no campo solto do modelo.
    // data_hora_consulta NAO passa por validarObservacoes, e e por ele que o eco da data-ancora
    // chegou na agenda do deal 48407621 (valor gravado: "2026-08-07T20:19:05.000Z", que e a hora de
    // envio da ultima mensagem). Continua valendo pra remarcacao: atualizarEventoSeRemarcado le este
    // campo, nao apuracao.horarioIso.
    if (dados.data_hora_consulta) {
      const motivo = motivoHorarioImplausivel(dados.data_hora_consulta, dataAtual, diaLocal(new Date(dataAtual)));
      if (motivo) {
        console.log(`  🚫 data_hora_consulta descartada ("${dados.data_hora_consulta}") — ${motivo}`);
        dados.data_hora_consulta = null;
      } else {
        dados.data_hora_consulta = normalizarHorarioNaive(dados.data_hora_consulta);
      }
    }

    const apuracao = apurarDuplaConfirmacao(obsValidas);
    // Viaja junto com a apuracao pra chegar em registrarAgendamentoPendente: e a diferenca entre
    // "ninguem confirmou ainda" e "alguem confirmou mas o horario extraido nao servia".
    apuracao.horariosDescartados = obsValidas
      .filter((o) => o._horarioImplausivel)
      .map((o) => ({ msg_idx: o.msg_idx, ...o._horarioImplausivel }));
    console.log(`  🔐 Dupla confirmacao: ${apuracao.confirmado
      ? `OK para ${apuracao.horarioIso} (cliente msg ${apuracao.cliente.msg_idx}, equipe msg ${apuracao.equipe.msg_idx})`
      : `NAO — ${descreverPendencia(apuracao)}`}`);

    // Espelha a decisao no banco pra ela ser auditavel depois do fato (ver a coluna
    // agendamento_apuracao no topo). So o que importa pra reconstruir o "por que": as observacoes de
    // horario com o indice da mensagem que as sustenta, e as pernas que a apuracao escolheu.
    try {
      db.prepare('UPDATE conversations SET agendamento_apuracao = ? WHERE chat_id = ?').run(JSON.stringify({
        em: new Date().toISOString(),
        ancora: dataAtual,
        confirmado: apuracao.confirmado,
        motivo: apuracao.motivo,
        horarioIso: apuracao.horarioIso,
        cliente: apuracao.cliente ? { tipo: apuracao.cliente.tipo, msg_idx: apuracao.cliente.msg_idx, horario_iso: apuracao.cliente.horario_iso, trecho: apuracao.cliente.trecho } : null,
        equipe: apuracao.equipe ? { tipo: apuracao.equipe.tipo, msg_idx: apuracao.equipe.msg_idx, horario_iso: apuracao.equipe.horario_iso, trecho: apuracao.equipe.trecho } : null,
        horariosDescartados: apuracao.horariosDescartados,
        data_hora_consulta: dados.data_hora_consulta || null,
        observacoesHorario: obsValidas
          .filter((o) => /_horario$/.test(o.tipo))
          .map((o) => ({ tipo: o.tipo, msg_idx: o.msg_idx, horario_iso: o.horario_iso, trecho: o.trecho, ...(o._dataCorrigida ? { _dataCorrigida: o._dataCorrigida } : {}), ...(o._horarioImplausivel ? { _horarioImplausivel: o._horarioImplausivel } : {}) })),
        observacoesRejeitadas: obsRejeitadas.map((r) => ({ motivo: r.motivo, tipo: r.obs?.tipo, msg_idx: r.obs?.msg_idx, horario_iso: r.obs?.horario_iso })),
      }), chatId);
    } catch (e) {
      console.error(`  ❌ Erro ao gravar apuracao de agendamento: ${e.message}`);
    }
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
    const { casoDescrito } = sanitizarClassificacao(dados, obsValidas);

    const jsonDados = JSON.stringify(dados);
    const confianca = result.confianca ?? 0;

    console.log(`  → Ação decidida: "${acao}" (${justificativa}) | confianca: ${confianca}`);

    if (acao === 'criar' && confianca < 6) {
      console.log(`  ⏭️ confianca baixa (${confianca}/10), tratando como ignorar`);
      acao = 'ignorar';
    }

    if (deveEsperarCasoDescrito(acao, casoDescrito, apuracao, bloco.enviado)) {
      console.log(`  ⏳ "criar" sem caso descrito (e sem horario confirmado nem bloco de condicoes) — tratando como aguardar, nada e criado no CRM`);
      acao = 'aguardar';
    }

    if (acao === 'ignorar') {
      stmtUpdateProcessed.run(jsonDados, acao, chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      console.log(`  ⏭️ ignorado ${chatId} (${justificativa})`);
      return;
    }

    if (acao === 'aguardar') {
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);
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
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);

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
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(dealId, chatId);
        row.deal_id = dealId;
        row.briefing_added = 0;
      }

      await registrarBriefing(dealId, chatId, dados.resumo_atendimento, '📋 Briefing pré-reunião');

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
      const dealVerificado = await garantirDealExiste(dealId, mesclarParaCrm(dadosAnteriores, dados, obsValidas), contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(dealId, chatId);
        row.briefing_added = 0;
        console.log(`  ✅ Deal recriado como ${dealId} (o anterior nao existia mais no Moskit)`);
      }

      if (!dados.resumo_atendimento) {
        console.log(`  ⏭️ acao "nota" sem resumo — ignorando`);
      } else {
        await registrarBriefing(dealId, chatId, dados.resumo_atendimento, '📋 Briefing pré-reunião');
      }

      await finalizarCiclo({
        dealId, dados, dadosMesclados: mesclarParaCrm(dadosAnteriores, dados, obsValidas),
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
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);
      const pendentes = camposPendentes(dadosMesclados);

      console.log('  Dados anteriores:', JSON.stringify(dadosAnteriores));
      console.log('  Dados novos:', JSON.stringify(dados));
      console.log('  Dados mesclados:', JSON.stringify(dadosMesclados));
      console.log(`  Campos ainda pendentes: ${pendentes.length > 0 ? pendentes.join(', ') : 'nenhum'}`);

      const contactId = await buscarOuCriarContato(phone, dadosMesclados.nome || dadosAnteriores?.nome);

      const dealVerificado = await garantirDealExiste(dealId, dadosMesclados, contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        db.prepare('UPDATE conversations SET briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(chatId);
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
        // Hash: a IA devolve os mesmos campos a cada ciclo enquanto a conversa nao muda, e essa nota
        // era postada de novo toda vez — o deal 48423360 acumulou SEIS notas identicas, ruido que
        // ainda por cima escondia o problema real (o campo que nao estava pegando no CRM).
        const hashNota = crypto.createHash('sha1').update(descricao).digest('hex');
        const notaAtual = db.prepare('SELECT campos_nota_hash FROM conversations WHERE chat_id = ?').get(chatId);
        if (notaAtual?.campos_nota_hash === hashNota) {
          console.log(`  ⏭️ nota de campos identica a ultima — nao repostada`);
        } else {
          await criarNotaMoskit(dealId, `🔄 Campos preenchidos: ${descricao}`);
          db.prepare('UPDATE conversations SET campos_nota_hash = ? WHERE chat_id = ?').run(hashNota, chatId);
          console.log(`  ✅ Nota de atualizacao adicionada`);
        }
      }

      if (pendentes.length === 0) {
        console.log('  🎯 Todos os campos obrigatorios preenchidos!');
        await registrarBriefing(dealId, chatId, dadosMesclados.resumo_atendimento, '📋 Briefing completo');
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

// Segredo do webhook do ZapSign (documento assinado/recusado/e-mail nao entregue). DIFERENTE de
// assinaturaValida/assinaturaGithubValida: a ZapSign nao assina o corpo com HMAC — a autenticacao
// e um header HTTP customizado que a gente mesmo escolhe ao cadastrar o webhook (painel:
// Configuracoes > Integracoes > API ZapSign > Webhooks > Headers, ou via
// POST /api/v1/user/company/webhook/ com {url, type, headers}). O NOME do header e fixo aqui
// (X-Zapsign-Webhook-Secret) — cadastre esse mesmo nome e o valor de ZAPSIGN_WEBHOOK_SECRET do lado
// de la. Sem ZAPSIGN_WEBHOOK_SECRET configurado, periodo de tolerancia (mesmo padrao de /webhook)
// — pior caso de aceitar sem checar aqui e uma nota indevida no CRM, nao um risco de seguranca
// como /deploy-webhook (execucao de codigo) ou /webhook (injecao de mensagem "equipe").
const ZAPSIGN_WEBHOOK_SECRET = process.env.ZAPSIGN_WEBHOOK_SECRET || null;

function zapsignWebhookValido(req) {
  if (!ZAPSIGN_WEBHOOK_SECRET) return true;
  const recebido = req.get('X-Zapsign-Webhook-Secret');
  return comparacaoSegura(recebido, ZAPSIGN_WEBHOOK_SECRET);
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

// Auditoria da classificacao: compara o que esta no CRM com o que o bot apurou na conversa.
// DRY-RUN por padrao (nao escreve nada) — `?aplicar=1` corrige o que o proprio bot escreveu e
// `?incluir-legado=1` alcanca tambem os deals sem registro de autoria (anteriores a esta versao), que no
// modo normal sao preservados. Campo corrigido na mao pela equipe nunca e tocado, em nenhum modo.
app.get('/auditoria-classificacao', exigeAdmin, rota(async (req, res) => {
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true';
  const incluirLegado = req.query['incluir-legado'] === '1' || req.query['incluir-legado'] === 'true';
  const limite = Math.min(Number(req.query.limite) || 100, 500);
  console.log(`\n🔍 Auditoria de classificacao (${aplicar ? 'APLICANDO correcoes' : 'so leitura'}${incluirLegado ? ', incluindo legado' : ''})...`);
  const relatorio = await reconciliarClassificacao({ aplicar, incluirLegado, limite });
  res.json({ ok: true, ...relatorio });
}));

// Auditoria SO-LEITURA: mostra quais atividades seriam liberadas sem comprovante por estarem
// marcadas como "consulta gratis" no Moskit. Nao toca em Calendar, Moskit nem Telegram — serve
// pra conferir o alcance antes de ligar LIBERAR_CONSULTA_GRATIS.
app.get('/auditoria-consulta-gratis', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria de consultas gratis (so leitura)...');
  const linhas = [];
  try {
    const { atividades, truncou } = await listarAtividadesMoskit();
    if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS_ATIVIDADES} paginas atingido — auditoria cobre so as ${atividades.length} atividades mais recentes`);
    const agora = Date.now();

    for (const atv of atividades) {
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

// Auditoria SO-LEITURA das TRES fontes de horario de uma consulta: o espelho local
// (conversations.evento_calendar_data), o evento no Google Agenda e a Atividade na agenda do Moskit.
//
// Existe porque nada no sistema cruzava essas fontes, e foi cruzando as tres na mao que os 5 casos de
// horario errado apareceram (13/08/2026). Divergencia entre elas e invisivel no dia a dia: cada tela
// mostra um horario e todas parecem certas. Os casos reais que esta rota pega:
//   deal 48226006 (Priscilla) — banco/Google em 07/08 14:00, decisao do bot em 10/08 14:00
//   deal 47543238 (Rafael)    — evento parado em 29/07 depois de remarcado pra 04/08
//   deal 48370184 (Arthur)    — valor gravado = hora de envio da ultima mensagem
//
// ?todas=1 inclui consulta passada (o padrao e so futura). ?desde=AAAA-MM-DD limita a janela.
app.get('/auditoria-agenda', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria de agenda: banco x Google x Moskit (so leitura)...');
  const incluirPassadas = req.query.todas === '1';
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
  const hojeLocal = diaLocal(new Date());

  const auth = getGoogleAuthClient();
  const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;
  const linhas = [];

  const rows = db.prepare(`
    SELECT chat_id, contact_name, deal_id, evento_calendar_id, evento_calendar_data,
           atividade_moskit_id, agendamento_apuracao
      FROM conversations
     WHERE evento_calendar_id IS NOT NULL AND evento_calendar_id <> ''
  `).all();

  for (const row of rows) {
    const noBanco = row.evento_calendar_data || null;
    let apuracao = null;
    try { apuracao = row.agendamento_apuracao ? JSON.parse(row.agendamento_apuracao) : null; } catch {}

    // Horario do Google, trazido pra hora do escritorio. Evento cancelado conta como divergencia:
    // "cancelled" com o banco achando que a consulta existe e o pior estado possivel.
    let noGoogle = null;
    let statusGoogle = null;
    if (calendar) {
      try {
        const { data } = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });
        statusGoogle = data.status;
        noGoogle = data.start?.dateTime ? instanteParaNaiveLocal(data.start.dateTime) : null;
      } catch (e) {
        statusGoogle = `erro: ${e.code || e.message}`;
      }
    }

    // Horario da Atividade no Moskit. dueDate e instante absoluto (ver "As duas agendas" no
    // CLAUDE.md), entao volta pro naive local pela MESMA conversao usada na comparacao acima.
    let noMoskit = null;
    let statusMoskit = null;
    let semVinculoComDeal = false;
    if (row.atividade_moskit_id) {
      try {
        const r = await axios.get(`${MOSKIT_BASE}/activities/${row.atividade_moskit_id}`, {
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
        });
        if (r.status >= 200 && r.status < 300) {
          noMoskit = r.data?.dueDate ? instanteParaNaiveLocal(r.data.dueDate) : null;
          // MEDIDO em 14/08/2026 (deals 48474073, 48464876): o POST as vezes cria a atividade sem
          // vincular ao negocio (so ao contato) — ver garantirVinculoAtividadeDeal.
          semVinculoComDeal = !(r.data?.deals || []).some((d) => Number(d?.id) === Number(row.deal_id));
        } else {
          statusMoskit = `HTTP ${r.status}`;
        }
      } catch (e) {
        statusMoskit = `erro: ${e.message}`;
      }
    }

    const referencia = (noBanco || '').slice(0, 16) || noGoogle || noMoskit;
    const diaReferencia = (referencia || '').slice(0, 10);
    if (!incluirPassadas && diaReferencia && diaReferencia < hojeLocal) continue;
    if (desde && diaReferencia && diaReferencia < desde) continue;

    // `problemas` e so o que significa "a consulta pode estar no horario errado AGORA" — e a lista que
    // alguem vai ler pra corrigir na mao. Tudo que e contexto vai pra `observacoes`: um item que
    // dispara em toda linha nao e problema, e ruido, e afoga justamente os 3 casos que importam.
    const problemas = [];
    const observacoes = [];
    const bancoMinuto = noBanco ? noBanco.slice(0, 16) : null;
    const futura = diaReferencia && diaReferencia >= hojeLocal;

    if (noBanco && !normalizarHorarioNaive(noBanco)) {
      problemas.push(`espelho local em formato invalido ("${noBanco}") — nao e hora naive do escritorio, provavel timestamp copiado`);
    }
    if (bancoMinuto && noGoogle && bancoMinuto !== noGoogle) {
      problemas.push(`banco (${bancoMinuto}) e Google (${noGoogle}) divergem`);
    }
    if (noGoogle && noMoskit && noGoogle !== noMoskit) {
      problemas.push(`Google (${noGoogle}) e agenda do Moskit (${noMoskit}) divergem`);
    }
    if (apuracao?.horarioIso && bancoMinuto && apuracao.horarioIso.slice(0, 16) !== bancoMinuto) {
      problemas.push(`ultima decisao do bot (${apuracao.horarioIso}) nao chegou na agenda (banco em ${bancoMinuto}) — remarcacao travada?`);
    }
    // apurarDuplaConfirmacao sempre grava horarioIso:null quando confirmado e false (falta_cliente/
    // falta_equipe/falta_ambos) — exatamente o caso que este audit precisa enxergar (MEDIDO em
    // 14/08/2026, deals 48292471/48287898: a perna validada da equipe as vezes tem o horario CERTO,
    // mesmo com confirmado:false por a perna do cliente ter sido descartada). Ver perna isolada, nao
    // so horarioIso, pra nao ficar cego nesse caso.
    const pernaValidada = apuracao?.equipe?.horario_iso || apuracao?.cliente?.horario_iso || null;
    if (!apuracao?.horarioIso && pernaValidada && bancoMinuto && pernaValidada.slice(0, 16) !== bancoMinuto) {
      problemas.push(`equipe/cliente comunicou ${pernaValidada} na conversa mas a agenda mostra ${bancoMinuto} — confirmacao nao fechou (${apuracao?.motivo || 'motivo desconhecido'})`);
    }
    if (row.atividade_moskit_id && !noMoskit) {
      problemas.push(`atividade ${row.atividade_moskit_id} nao pode ser lida na agenda do Moskit${statusMoskit ? ` (${statusMoskit})` : ''}`);
    }
    if (row.atividade_moskit_id && noMoskit && semVinculoComDeal) {
      problemas.push(`atividade ${row.atividade_moskit_id} existe mas nao esta vinculada ao negocio (so ao contato) — some da tela do negocio no Moskit`);
    }
    if (apuracao?.horariosDescartados?.length) {
      problemas.push(`horario recusado pela validacao: ${apuracao.horariosDescartados.map((d) => `"${d.valor}" (${d.motivo})`).join('; ')}`);
    }

    if (statusGoogle && statusGoogle !== 'confirmed') {
      // Cancelado nao e defeito por si: a equipe cancela consulta o tempo todo. Vira problema so se o
      // bot ainda acha que ela vai acontecer.
      (futura ? problemas : observacoes).push(`evento no Google com status "${statusGoogle}"`);
    }
    if (!row.atividade_moskit_id) {
      // atividade_moskit_id nasceu em 12/08/2026; consulta anterior a isso nunca teve Atividade no CRM
      // e nao ha o que corrigir numa consulta que ja passou.
      (futura ? problemas : observacoes).push('consulta sem Atividade na agenda do Moskit (so existe no Google)');
    }
    if (!apuracao) {
      observacoes.push('sem apuracao gravada (conversa nao reprocessada depois da coluna agendamento_apuracao existir)');
    }

    linhas.push({
      chat_id: row.chat_id,
      cliente: row.contact_name,
      deal_id: row.deal_id,
      evento_calendar_id: row.evento_calendar_id,
      horario_no_banco: noBanco,
      horario_no_google: noGoogle,
      horario_na_agenda_moskit: noMoskit,
      status_google: statusGoogle,
      decisao_do_bot: apuracao?.horarioIso || null,
      motivo_pendencia: apuracao?.confirmado === false ? apuracao?.motivo : null,
      problemas,
      observacoes,
    });
  }

  const comProblema = linhas.filter((l) => l.problemas.length);
  console.log(`  🔍 ${linhas.length} consultas conferidas — ${comProblema.length} com divergencia`);
  for (const l of comProblema) {
    console.log(`  ⚠️ deal ${l.deal_id} (${l.cliente}): ${l.problemas.join(' | ')}`);
  }
  res.json({
    ok: true,
    google_configurado: !!calendar,
    escopo: incluirPassadas ? 'todas as consultas' : `consultas de ${hojeLocal} em diante`,
    total: linhas.length,
    com_divergencia: comProblema.length,
    consultas: linhas,
  });
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

// Status de assinatura do contrato (doc_signed/doc_refused/email_bounce) — configurar no painel do
// ZapSign apontando pra https://<seu-dominio>/zapsign-webhook, com o header customizado descrito em
// zapsignWebhookValido. Responde 200 antes de processar, mesmo padrao de /webhook — a ZapSign nao
// precisa esperar o Moskit responder pra considerar a entrega bem-sucedida.
app.post('/zapsign-webhook', (req, res) => {
  res.sendStatus(200);
  if (!zapsignWebhookValido(req)) {
    console.log('  ⚠️ /zapsign-webhook: header de autenticacao invalido ou ausente — evento ignorado');
    return;
  }
  processarWebhookZapSign(req.body).catch((e) => {
    console.error(`  ❌ Erro ao processar webhook do ZapSign: ${e.message}`);
  });
});

// So gera nota pros eventos que interessam ao escritorio (assinado/recusado/e-mail nao entregue) —
// doc_created/doc_deleted so atualizam o status em silencio, pra nao poluir o deal com nota
// redundante do que o proprio bot ja anotou ao criar o documento.
async function processarWebhookZapSign(payload) {
  const info = zapsign.interpretarStatusWebhook(payload);
  if (!info.docToken) return;

  const row = db.prepare('SELECT deal_id FROM conversations WHERE contrato_zapsign_doc_token = ?').get(info.docToken);
  if (!row?.deal_id) {
    console.log(`  ⚠️ webhook ZapSign: doc_token ${info.docToken} nao corresponde a nenhum deal conhecido`);
    return;
  }

  db.prepare('UPDATE conversations SET contrato_zapsign_status = ? WHERE contrato_zapsign_doc_token = ?')
    .run(info.status || info.eventType || null, info.docToken);

  // Fechamento do negocio (WON/LOST) continua exclusivo de equipe_declarou_ganho/perdido na
  // conversa (ver fecharNegocioSeAplicavel) — assinatura do contrato NAO fecha o deal
  // automaticamente, e uma decisao de produto que nao foi pedida e fica de fora de proposito.
  if (info.assinado) {
    await criarNotaMoskit(row.deal_id, '✅ Contrato de Prestação de Serviço assinado pelo cliente via ZapSign.');
  } else if (info.recusado) {
    await criarNotaMoskit(row.deal_id, '❌ Cliente recusou assinar o contrato de Prestação de Serviço (ZapSign).');
  } else if (info.emailFalhou) {
    await criarNotaMoskit(row.deal_id, '⚠️ Falha ao entregar o e-mail de assinatura do contrato (ZapSign) — verificar o endereço ou reenviar manualmente.');
  }
}

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
    const { atividades, truncou } = await listarAtividadesMoskit();
    relatorio.atividades_verificadas = atividades.length;
    relatorio.varredura_truncada = truncou;
    console.log(`  📅 ${atividades.length} atividades recentes encontradas no Moskit`);
    // Teto silencioso aqui se leria como "varri tudo e nao tinha nada" — que foi exatamente o engano
    // enquanto `?page=` era ignorado e a varredura via 10 de 1165.
    if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS_ATIVIDADES} paginas atingido — atividades mais antigas que essas nao foram verificadas neste ciclo`);

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
        // Com timeZone explicito: sem ele este log sai na hora do SISTEMA (a VPS roda em UTC, 3h
        // adiantado) enquanto a nota do mesmo deal, tres linhas abaixo, sai na hora do escritorio —
        // o mesmo compromisso aparecia em dois horarios diferentes dependendo de onde se olhava.
        console.log(`  ✅ Evento criado pra atividade "${atv.title}" (${inicio.toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO })})`);

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
// Reconciliacao da classificacao (o CRM tem que refletir a decisao ATUAL do bot)
// ------------------------------------------------------------
// Por que existe: todas as travas de classificacao agem NO MOMENTO do ciclo. Se um PUT falhar fora de um
// ciclo, se a conversa parar de receber mensagens, ou se alguem mexer no CRM depois, nada nunca
// reconferia — foi assim que "LGPD" ficou preso no deal 48423360 enquanto o bot dizia "Direito
// Administrativo" a cada rodada. Aqui o bot volta e confere.
//
// Regras (as mesmas do caminho normal de escrita, por reuso de atualizarNegocioMoskit):
//   - campo vazio no CRM e o bot sabe o valor        => preenche
//   - divergente e o valor de la foi escrito pelo bot => corrige
//   - divergente e travado por correcao manual        => NAO toca, entra no resumo do Telegram
//   - sem registro de autoria (deal anterior a isto)  => NAO toca (incluirLegado forca)
//   - deal WON/LOST                                   => NAO toca, so reporta
const RECONCILIACAO_INTERVAL_MS = Number(process.env.RECONCILIACAO_INTERVAL_MS) || 30 * 60 * 1000;
const RECONCILIACAO_ATIVA = process.env.RECONCILIACAO_ATIVA !== 'false'; // default ligada
const RECONCILIACAO_DIAS = Number(process.env.RECONCILIACAO_DIAS) || 30;
// Pausa entre as leituras da varredura: uma passada por 64 deals ja levou 429 do Moskit.
const RECONCILIACAO_PAUSA_MS = Number(process.env.RECONCILIACAO_PAUSA_MS) || 300;
// Ultimo resumo enviado ao Telegram. Sem isso, uma pendencia que depende de acao humana (campo travado)
// seria reenviada a cada rodada. Memoria de processo de proposito: um restart avisa de novo, o que e
// barato e melhor do que perder o aviso.
let ultimoResumoReconciliacao = null;
// Mesma ideia, para a reconciliacao de vinculo de Atividade x negocio (ver reconciliarVinculoAtividades).
let ultimoResumoReconciliacaoAtividades = null;
// Mesma ideia, para a reconciliacao de pendencias de agendamento em conversa silenciosa (ver
// reconciliarPendenciasAgendamento) — so evita repetir o LOG de resumo; cada pendencia urgente ja
// manda seu proprio Telegram individual, deduplicado por linha via agendamento_pendencia_avisada.
let ultimoResumoReconciliacaoPendencias = null;

// Nome canonico da area a partir do ID da opcao — o caminho inverso de buscarIdOpcao, usado pela
// reconciliacao para adotar a area que esta no CRM como fonte da verdade.
function nomeAreaPorId(idOpcao) {
  if (!idOpcao) return null;
  const alvo = Number(idOpcao);
  return Object.keys(MOSKIT_IDS.AREA_DIREITO).find((k) => MOSKIT_IDS.AREA_DIREITO[k] === alvo) || null;
}

// Os campos de classificacao que o bot afirma hoje, montados pelas MESMAS regras do payload real.
function camposClassificacaoDe(dados, condicoesValorEnviadas) {
  const payload = montarPayloadMoskit(dados, 0, { condicoesValorEnviadas });
  return payload.entityCustomFields || [];
}

async function reconciliarClassificacao({ aplicar = false, incluirLegado = false, limite = 100 } = {}) {
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, last_data, bloco_condicoes_enviado, messages
    FROM conversations
    WHERE deal_id IS NOT NULL AND last_data IS NOT NULL
      AND (updated_at IS NULL OR updated_at >= datetime('now', ?))
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`-${RECONCILIACAO_DIAS} days`, limite);

  const relatorio = {
    aplicar, incluir_legado: incluirLegado, janela_dias: RECONCILIACAO_DIAS,
    analisados: 0, sem_divergencia: 0,
    corrigidos: [], a_corrigir: [], travados: [], legado: [], fechados: [],
    nao_rebaixados: [], deals_apagados: [], bloco_recalculado: [], erros: [],
  };

  let primeira = true;
  for (const linha of linhas) {
    const dados = parseJsonSeguro(linha.last_data, null);
    if (!dados) continue;

    // BLOCO DE CONDICOES RECALCULADO DAS MENSAGENS, nao lido da coluna. `bloco_condicoes_enviado` foi
    // adicionada depois de muitas conversas existirem, e nelas o valor e 0 — que significa "nunca
    // enviou o bloco", ou seja CORTESIA. Confiar na coluna aqui rebaixaria consulta paga para R$0 em
    // massa (13 deals na varredura de 12/08/2026). As mensagens estao no banco: e delas que sai a
    // verdade. Se o recalculo discordar da coluna, a coluna e corrigida de passagem.
    const mensagens = parseJsonSeguro(linha.messages, null) || [];
    const blocoRecalculado = mensagens.length ? detectarBlocoCondicoes(mensagens).enviado : linha.bloco_condicoes_enviado === 1;
    if (blocoRecalculado !== (linha.bloco_condicoes_enviado === 1)) {
      relatorio.bloco_recalculado.push({ chat_id: linha.chat_id, coluna: linha.bloco_condicoes_enviado, mensagens: blocoRecalculado ? 1 : 0 });
      console.log(`  💳 ${linha.chat_id}: bloco de condicoes recalculado das mensagens (coluna dizia ${linha.bloco_condicoes_enviado}, agora ${blocoRecalculado ? 1 : 0})`);
      // Persistir so quando for pra valer: dry-run tem que ser leitura pura, senao "conferir sem
      // escrever" deixa de ser verdade e ninguem confia no relatorio. O valor recalculado vale para esta
      // rodada de qualquer forma (esta em `blocoRecalculado`).
      if (aplicar) {
        db.prepare('UPDATE conversations SET bloco_condicoes_enviado = ? WHERE chat_id = ?').run(blocoRecalculado ? 1 : 0, linha.chat_id);
      }
    }

    relatorio.analisados++;

    try {
      // Espaco entre as leituras: a varredura de 64 deals ja tomou 429 do Moskit.
      if (!primeira) await new Promise((r) => setTimeout(r, RECONCILIACAO_PAUSA_MS));
      primeira = false;

      const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${linha.deal_id}`, {
        headers: apiHeaders,
        validateStatus: (s) => s < 500,
      });
      if (dealRes.status === 404) {
        // Caso conhecido e acionavel (alguem apagou o deal no CRM e o banco ainda aponta pra ele), nao
        // um erro de integracao — separar evita esconder falha de verdade num monte de 404.
        relatorio.deals_apagados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id });
        continue;
      }
      if (dealRes.status < 200 || dealRes.status >= 300) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: `HTTP ${dealRes.status}` });
        continue;
      }
      const deal = dealRes.data;

      if (deal?.status && deal.status !== STATUS_DEAL.OPEN) {
        relatorio.fechados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, status: deal.status });
        continue;
      }

      const remotos = new Map((deal?.entityCustomFields || []).filter((c) => c?.id).map((c) => [c.id, (c.options || []).map(Number)]));
      const registro = lerRegistroCampos(linha.chat_id) || { escritos: {}, travados: new Set() };

      // NUNCA REBAIXAR: se o deal ja esta como consulta paga no CRM, o payload nao pode ser montado como
      // cortesia (montarPayloadMoskit tira o price junto com o campo). Corrigir PARA paga e seguro
      // — tem evidencia do bloco na conversa; rebaixar para R$0 nao e, porque a cobranca pode ter sido
      // combinada por telefone ou vindo num anexo que o detector nao le. Decisao do escritorio, 12/08/2026.
      const tipoRemotoEhPaga = (remotos.get(CF_TIPO_CONSULTA) || []).includes(TIPO_CONSULTA_PAGA_ID);
      const condicoesParaPayload = blocoRecalculado || tipoRemotoEhPaga;
      if (tipoRemotoEhPaga && !blocoRecalculado) {
        relatorio.nao_rebaixados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, motivo: 'CRM esta "consulta paga" e o bloco nao aparece nas mensagens — nao rebaixado' });
      }

      // A AREA QUE MANDA AQUI E A DO CRM, quando existe: ela foi curada pela equipe, enquanto a do
      // last_data pode ser palpite anterior as travas. Trocando a area no objeto (em vez de remendar o
      // campo do responsavel depois), tudo que deriva dela — inclusive o responsavel — sai coerente, e o
      // relatorio promete exatamente o que a escrita vai fazer. Area vazia no CRM continua sendo
      // preenchida com a do bot.
      const nomeAreaDoCrm = nomeAreaPorId((remotos.get(MOSKIT_IDS.CF.AREA_DIREITO) || [])[0]);
      const dadosParaEscrita = nomeAreaDoCrm ? { ...dados, area_direito: nomeAreaDoCrm } : dados;

      const esperados = camposClassificacaoDe(dadosParaEscrita, condicoesParaPayload);
      if (!esperados.length) continue;

      const divergentes = esperados.filter((e) => !opcoesIguais(remotos.get(e.id), e.options));
      if (!divergentes.length) { relatorio.sem_divergencia++; continue; }

      const detalhe = (campo) => ({
        chat_id: linha.chat_id,
        deal_id: linha.deal_id,
        campo: nomeCampo(campo.id),
        no_crm: (remotos.get(campo.id) || []).join(',') || '(vazio)',
        do_bot: (campo.options || []).join(','),
      });

      let corrigiveis = 0;
      for (const campo of divergentes) {
        const remoto = remotos.get(campo.id);
        const registrado = registro.escritos[campo.id];
        const temValorRemoto = !!(remoto && remoto.length);

        // Campo fora de CF_TRAVAVEIS (tipo de consulta e responsavel) e regido por regra, nao por
        // opiniao: nao existe autoria a respeitar nele, e o caminho de escrita tambem nao o filtra.
        // Sem esta linha os 4 responsaveis incoerentes cairiam em "legado" e nunca seriam corrigidos.
        if (!CF_TRAVAVEIS.has(campo.id)) {
          corrigiveis++;
          relatorio[aplicar ? 'corrigidos' : 'a_corrigir'].push(detalhe(campo));
          continue;
        }

        if (registro.travados.has(campo.id)) { relatorio.travados.push(detalhe(campo)); continue; }
        if (temValorRemoto && registrado === undefined && !incluirLegado) { relatorio.legado.push(detalhe(campo)); continue; }
        // Valor remoto que o bot nao escreveu: o caminho de escrita vai TRAVAR este campo (correcao
        // manual) em vez de corrigir. Nao prometemos no relatorio o que nao vai acontecer.
        if (temValorRemoto && registrado !== undefined && !opcoesIguais(registrado, remoto) && !incluirLegado) {
          relatorio.travados.push(detalhe(campo));
          continue;
        }
        corrigiveis++;
        relatorio[aplicar ? 'corrigidos' : 'a_corrigir'].push(detalhe(campo));
      }

      if (!corrigiveis || !aplicar) continue;

      const contactId = deal?.contacts?.[0]?.id;
      if (!contactId) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: 'deal sem contato — nao da pra montar o payload' });
        continue;
      }

      // Reusa o caminho normal de escrita: merge com o remoto, autoria/trava e confirmacao pos-PUT — uma
      // correcao que nao gruda no CRM vira erro visivel, nao sucesso silencioso.
      await atualizarNegocioMoskit(linha.deal_id, dadosParaEscrita, contactId, {
        chatId: linha.chat_id,
        condicoesValorEnviadas: condicoesParaPayload,
        forcarAutoria: incluirLegado,
      });
      await criarNotaMoskit(
        linha.deal_id,
        '🔁 Classificação reconciliada automaticamente (o CRM estava diferente do que o bot apurou na conversa): ' +
        divergentes.map((c) => nomeCampo(c.id)).join(', ') + '.'
      );
      console.log(`  🔁 Deal ${linha.deal_id} reconciliado (${divergentes.length} campo(s))`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: e.message });
      console.error(`  ❌ Reconciliacao do deal ${linha.deal_id}: ${e.message}`);
    }
  }

  return relatorio;
}

// Rotina periodica: corrige sozinha o que o proprio bot escreveu e avisa no Telegram o que ela NAO pode
// tocar (campo corrigido na mao, deal fechado, deal legado sem autoria) — essas dependem de decisao
// humana, entao viram aviso, nunca escrita.
async function rodarReconciliacaoPeriodica() {
  const r = await reconciliarClassificacao({ aplicar: true });

  const pendencias = [...r.travados, ...r.legado];
  if (!r.corrigidos.length && !pendencias.length) return r;

  console.log(`  🔁 Reconciliacao: ${r.analisados} deals conferidos, ${r.corrigidos.length} corrigidos, ${pendencias.length} pendencia(s) humana(s)`);

  const linhasResumo = [
    r.corrigidos.length ? `✅ ${r.corrigidos.length} campo(s) corrigido(s) automaticamente` : '',
    ...pendencias.slice(0, 10).map((p) => `• Deal \`${p.deal_id}\` — ${p.campo}: CRM "${p.no_crm}" x bot "${p.do_bot}"`),
    pendencias.length > 10 ? `… e mais ${pendencias.length - 10}` : '',
  ].filter(Boolean);

  const resumo = `🔁 *Reconciliação de classificação*\n${linhasResumo.join('\n')}`;
  if (resumo === ultimoResumoReconciliacao) return r; // nada novo desde a ultima rodada
  ultimoResumoReconciliacao = resumo;
  if (pendencias.length) {
    await enviarTelegram(`${resumo}\n\nEsses o bot não toca (correção manual, deal fechado ou negócio anterior ao registro de autoria).`);
  }
  return r;
}

// Rede de seguranca para o quirk medido em 14/08/2026 (ver garantirVinculoAtividadeDeal): mesmo com a
// conferencia logo apos criar, uma atividade pode ficar sem o vinculo com o negocio (ex.: a conferencia
// falhou por rede no mesmo ciclo). Varre toda conversa com atividade_moskit_id gravado e religa a que
// estiver solta — mesmo espirito de reconciliarClassificacao, rodando na mesma cadencia.
async function reconciliarVinculoAtividades({ aplicar = false } = {}) {
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, atividade_moskit_id FROM conversations WHERE atividade_moskit_id IS NOT NULL
  `).all();

  const relatorio = { aplicar, analisados: 0, corrigidos: [], erros: [] };

  let primeira = true;
  for (const linha of linhas) {
    relatorio.analisados++;
    try {
      if (!primeira) await new Promise((r) => setTimeout(r, RECONCILIACAO_PAUSA_MS));
      primeira = false;

      const res = await axios.get(`${MOSKIT_BASE}/activities/${linha.atividade_moskit_id}`, {
        headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
        validateStatus: (s) => s < 500,
      });
      if (res.status >= 300) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id, erro: `HTTP ${res.status}` });
        continue;
      }
      const vinculada = (res.data?.deals || []).some((d) => Number(d?.id) === Number(linha.deal_id));
      if (vinculada) continue;

      if (!aplicar) {
        relatorio.corrigidos.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id });
        continue;
      }
      const religou = await garantirVinculoAtividadeDeal(linha.atividade_moskit_id, linha.deal_id);
      if (!religou) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id, erro: 'PUT de religacao falhou' });
        continue;
      }
      relatorio.corrigidos.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id });
      await criarNotaMoskit(linha.deal_id, '🔁 Atividade da agenda religada automaticamente ao negócio (o Moskit tinha criado sem esse vínculo).').catch(() => {});
      console.log(`  🔁 Deal ${linha.deal_id}: atividade ${linha.atividade_moskit_id} religada ao negocio`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id, erro: e.message });
      console.error(`  ❌ Reconciliacao de vinculo da atividade ${linha.atividade_moskit_id} (deal ${linha.deal_id}): ${e.message}`);
    }
  }

  return relatorio;
}

async function rodarReconciliacaoVinculoAtividades() {
  const r = await reconciliarVinculoAtividades({ aplicar: true });
  if (!r.corrigidos.length && !r.erros.length) return r;

  console.log(`  🔁 Reconciliacao de vinculo de atividade: ${r.analisados} conferida(s), ${r.corrigidos.length} religada(s), ${r.erros.length} erro(s)`);

  const linhasResumo = [
    r.corrigidos.length ? `✅ ${r.corrigidos.length} atividade(s) religada(s) ao negócio automaticamente` : '',
    ...r.erros.slice(0, 10).map((e) => `• Deal \`${e.deal_id}\` — atividade \`${e.atividade_moskit_id}\`: ${e.erro}`),
    r.erros.length > 10 ? `… e mais ${r.erros.length - 10}` : '',
  ].filter(Boolean);

  const resumo = `🔁 *Reconciliação de vínculo de atividade*\n${linhasResumo.join('\n')}`;
  if (resumo === ultimoResumoReconciliacaoAtividades) return r; // nada novo desde a ultima rodada
  ultimoResumoReconciliacaoAtividades = resumo;
  if (r.erros.length) {
    await enviarTelegram(`${resumo}\n\nErro precisa de conferência manual (a atividade continua sem aparecer na tela do negócio).`);
  }
  return r;
}

// Rede de seguranca pra pendencia de agendamento numa conversa que PAROU DE VEZ. A escalada por
// proximidade dentro de registrarAgendamentoPendente (ver AGENDAMENTO_URGENCIA_HORAS) so roda quando a
// conversa E REPROCESSADA — e nada neste codebase reprocessa uma conversa so porque o tempo passou
// (so mensagem nova, via webhook ou sincronizarConversas achando algo novo no Zernio). Uma pendencia
// sem nenhuma mensagem nova de nenhum lado fica congelada pra sempre. Medido em 14/08/2026, deal
// 48466404 (Teresinha): pagou e perguntou o endereco do escritorio — claramente acha que a consulta
// esta marcada — mas ninguem mais escreveu na conversa desde entao e a pendencia nunca escalou.
//
// NAO chama a OpenAI nem reprocessa a conversa — so lê o que ja esta gravado. `agendamento_pendente_hash`
// tem o formato `${horarioRelatado}|${motivo}|...` desde a criacao da funcao (ver registrarAgendamentoPendente),
// entao da pra reconstruir o horario em jogo mesmo quando `agendamento_apuracao` esta NULL (coluna
// recente — conversas que nao rodam mais um ciclo completo desde 13/08 nunca a preenchem).
async function reconciliarPendenciasAgendamento({ aplicar = false } = {}) {
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, agendamento_pendente_hash, agendamento_pendencia_avisada
      FROM conversations
     WHERE agendamento_pendente_hash IS NOT NULL
  `).all();

  const relatorio = { aplicar, analisados: 0, avisados: [], erros: [] };
  const janelaHoras = AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS * 24;

  for (const linha of linhas) {
    relatorio.analisados++;
    if (linha.agendamento_pendente_hash === linha.agendamento_pendencia_avisada) continue; // ja avisado, nada mudou

    try {
      const [horarioRelatado, motivo] = String(linha.agendamento_pendente_hash).split('|');

      // Sinal independente de proximidade: comprovante ja verificado pra esse deal e compromisso real,
      // nao hipotese — avisa incondicionalmente, mesmo que o horario esteja fora da janela ou ausente.
      const comprovante = linha.deal_id
        ? db.prepare('SELECT 1 FROM comprovantes WHERE deal_id = ? AND match = 1 LIMIT 1').get(linha.deal_id)
        : null;

      let urgente = !!comprovante;
      if (!urgente && horarioRelatado && horarioRelatado !== 'null') {
        const instante = horarioNaiveParaInstante(horarioRelatado, TZ_ESCRITORIO);
        if (instante) {
          const horasAteReuniao = (new Date(instante).getTime() - Date.now()) / 3_600_000;
          // Janela grande pra frente (a antecedencia que essa varredura existe pra dar) e um pouco
          // pra tras (a reuniao pode ja ter passado sem ninguem notar — vale avisar tambem).
          urgente = horasAteReuniao <= janelaHoras && horasAteReuniao >= -AGENDAMENTO_URGENCIA_HORAS;
        }
      }
      if (!urgente) continue;

      relatorio.avisados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, horarioRelatado, motivo, comprovante: !!comprovante });
      if (!aplicar) continue;

      await enviarTelegram([
        '⏰ *Pendência de agendamento parada — conversa SILENCIOSA*',
        `Chat: \`${linha.chat_id}\``,
        linha.deal_id ? `Negócio: https://app.ollow.com.br/?/deal/${linha.deal_id}` : '',
        horarioRelatado && horarioRelatado !== 'null' ? `Horário em jogo: ${formatarHorarioEscritorio(horarioRelatado)}` : 'Horário em jogo: nenhum ainda extraído',
        `Situação: ${descreverPendencia({ motivo })}`,
        comprovante ? '💳 Comprovante JÁ verificado para este negócio — compromisso real, não hipótese.' : '',
        '',
        'O bot NÃO reprocessa uma conversa sozinho quando ela para de receber mensagem — conferir manualmente e mandar mensagem pra retomar se precisar.',
      ].filter(Boolean).join('\n'));
      db.prepare('UPDATE conversations SET agendamento_pendencia_avisada = ? WHERE chat_id = ?').run(linha.agendamento_pendente_hash, linha.chat_id);
      console.log(`  ⏰ Deal ${linha.deal_id}: pendencia de agendamento parada e urgente — Telegram enviado`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: e.message });
      console.error(`  ❌ Reconciliacao de pendencia de agendamento (deal ${linha.deal_id}): ${e.message}`);
    }
  }

  return relatorio;
}

async function rodarReconciliacaoPendenciasAgendamento() {
  const r = await reconciliarPendenciasAgendamento({ aplicar: true });
  if (!r.avisados.length && !r.erros.length) return r;

  console.log(`  ⏰ Reconciliacao de pendencia de agendamento: ${r.analisados} conferida(s), ${r.avisados.length} avisada(s), ${r.erros.length} erro(s)`);

  const linhasResumo = [
    r.avisados.length ? `⏰ ${r.avisados.length} pendência(s) urgente(s) em conversa(s) silenciosa(s)` : '',
    ...r.erros.slice(0, 10).map((e) => `• Deal \`${e.deal_id}\`: ${e.erro}`),
    r.erros.length > 10 ? `… e mais ${r.erros.length - 10}` : '',
  ].filter(Boolean);

  const resumo = `⏰ *Reconciliação de pendências de agendamento*\n${linhasResumo.join('\n')}`;
  if (resumo === ultimoResumoReconciliacaoPendencias) return r; // nada novo desde a ultima rodada
  ultimoResumoReconciliacaoPendencias = resumo;
  // Cada pendencia urgente ja manda o proprio Telegram individual (acima) — este resumo e so log,
  // nao precisa duplicar no Telegram (a diferenca do padrao das outras 2 reconciliacoes, que so
  // resumem no fim: aqui cada caso ja e um alerta acionavel por si so, avisar de novo seria eco).
  return r;
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
          // Passa pelas MESMAS travas do pipeline: `dados` aqui e last_data cru, que pode carregar um
          // palpite de area gravado antes delas existirem, e nao ha observacao nenhuma pra sustentar.
          // `chatId` vai junto para que a autoria dos campos fique registrada desde o nascimento.
          sanitizarClassificacao(dados, []);
          const deal = await criarNegocioMoskit(dados, contactId, { chatId });
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

  // Reconciliacao da classificacao: rede de seguranca para o CRM nao ficar diferente do que o bot apurou
  // (PUT que nao pegou, conversa que parou de receber mensagem, alteracao feita fora do bot). Intervalo
  // proprio, bem maior que o da sincronizacao: e uma varredura de deals, 1 GET por deal.
  if (RECONCILIACAO_ATIVA) {
    console.log(`   Reconciliacao de classificacao: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min (janela de ${RECONCILIACAO_DIAS} dias)`);
    setInterval(() => {
      rodarReconciliacaoPeriodica().catch((e) => console.error(`  ❌ Erro na reconciliacao periodica: ${e.message}`));
    }, RECONCILIACAO_INTERVAL_MS);

    // Mesma cadencia e mesma flag: religa sozinha a Atividade que o Moskit criou sem vincular ao
    // negocio (ver garantirVinculoAtividadeDeal/reconciliarVinculoAtividades).
    console.log(`   Reconciliacao de vinculo de atividade: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min`);
    setInterval(() => {
      rodarReconciliacaoVinculoAtividades().catch((e) => console.error(`  ❌ Erro na reconciliacao de vinculo de atividade: ${e.message}`));
    }, RECONCILIACAO_INTERVAL_MS);

    // Mesma cadencia e mesma flag: avisa sobre pendencia de agendamento numa conversa que PAROU DE VEZ
    // (ver reconciliarPendenciasAgendamento) — a escalada por proximidade so roda dentro de um ciclo
    // de reprocessamento, e uma conversa muda nunca e reprocessada de novo.
    console.log(`   Reconciliacao de pendencia de agendamento: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min (janela de ${AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS} dias)`);
    setInterval(() => {
      rodarReconciliacaoPendenciasAgendamento().catch((e) => console.error(`  ❌ Erro na reconciliacao de pendencia de agendamento: ${e.message}`));
    }, RECONCILIACAO_INTERVAL_MS);
  } else {
    console.log('   Reconciliacao de classificacao: DESLIGADA (RECONCILIACAO_ATIVA=false)');
  }

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
  // Gate do caso descrito e autoria de campos: funcoes puras (ou so-banco) exercitadas direto em
  // test-pipeline.js, porque processarConversaDirect depende da OpenAI e nao roda nos testes.
  aplicarGateCasoDescrito,
  deveEsperarCasoDescrito,
  sanitizarClassificacao,
  mesclarParaCrm,
  derivarAdvogadoDaArea,
  detectarOpcoesInvalidas,
  registrarOpcoesInvalidas,
  registrarBriefing,
  filtrarCamposPorAutoria,
  reconciliarClassificacao,
  reconciliarVinculoAtividades,
  reconciliarPendenciasAgendamento,
  buscarIdOpcao,
  handleAgendamentoCalendar,
  // Exportadas para teste: a data-ancora em texto do escritorio (nao em ISO) e o que impede o modelo
  // de copiar a hora da ultima mensagem como horario da consulta, e a formatacao naive-como-UTC de
  // somarMinutosNaive nunca teve teste direto — a virada de dia (23:30 + 60min) passava no escuro.
  descreverAncora,
  somarMinutosNaive,
  formatarHorarioEscritorio,
  // Exportada para teste: a paginacao por pageToken (e NAO por ?page=) e o tipo de detalhe que passa
  // despercebido — o codigo antigo "paginava" e lia sempre os mesmos 10 registros sem erro nenhum.
  listarAtividadesMoskit,
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
