// Varredura SO-LEITURA das agendas reais, em busca de consulta em horario errado.
//
//   node varrer-agenda-horarios.js                          # ultimos 60 dias + proximos 120
//   node varrer-agenda-horarios.js 2026-07-01 2026-12-31    # janela explicita
//
// NUNCA rodar em CI nem no npm test — le a API do Google, a API do Moskit e o conversations.db de
// producao. Nao escreve em NENHUM dos tres: nao existe flag --aplicar neste script de proposito.
// Toda escrita foi deixada de fora em vez de ficar atras de um if.
//
// Diferenca em relacao a GET /auditoria-agenda: aquela rota parte do BANCO (so ve consulta que passou
// por uma conversa do bot). Esta parte da AGENDA, entao tambem enxerga o que foi marcado direto no
// CRM, pelo Moskit Boost ou na mao no Google — inclusive evento que o banco nao conhece.
//
// O detector central e a assinatura do "eco da data-ancora": consulta de escritorio e marcada em
// minuto de slot (:00, :30...), entao um evento que comeca as 15:54:58 nao foi combinado com ninguem —
// e um timestamp de mensagem que o modelo copiou como se fosse horario (deals 48370184, 48407621 e
// 48177138, medidos em 13/08/2026). Isso vale pra evento que nao esta no banco tambem, e e o unico
// jeito de achar esses casos varrendo a agenda de fora.
//
// CUIDADO com o segundo quebrado sozinho: fora do bot ele NAO e prova de nada. Medido em 13/08/2026
// nas atividades 79342287, 78907151 e 79136822, o proprio Moskit grava dueDate com segundos
// (19:00:25, 20:00:34) — quem marca escolhe o minuto na tela do CRM e a API estampa o segundo. Esses
// eventos estao certos.
//
// O que separa um caso do outro e a ORIGEM do evento, nao o relogio: o bot monta start/end a partir de
// string naive de minuto inteiro, entao evento criado por ele com segundo != 00 e necessariamente um
// valor que veio de timestamp. Evento vindo da sincronizacao do CRM herda os segundos do dueDate e
// pode te-los legitimamente. Origem Moskit se reconhece pelo id (prefixo oll/moskitatv, dado pela
// propria sincronizacao) ou pela tabela atividades_sincronizadas.
//
// Usar so o minuto ("multiplo de 5 e plausivel") nao bastava: classificava como OK um evento do bot as
// 10:10:47 — que e eco — porque 10 e multiplo de 5.
const path = require('path');
require('dotenv').config();

// index.js e carregado só para reusar listarAtividadesMoskit (a paginacao de /activities so funciona
// com ?start=, medido em producao — reimplementar aqui era o caminho curto pra reler a mesma pagina
// 10 vezes e achar que varreu tudo). WORKER_MODE=1 carrega o modulo sem servidor e sem os
// setInterval; DB_PATH descartavel garante que o require NAO abre nem altera o banco de producao —
// a leitura do banco real e feita mais abaixo, num handle proprio e readonly.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `varredura-agenda-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');
const { google } = require('googleapis');
const { instanteParaNaiveLocal, normalizarHorarioNaive } = require('./src/evidencia');
const bot = require('./index.js');

const TZ = process.env.TZ_ESCRITORIO || 'America/Fortaleza';
const HORA_MIN = Number(process.env.HORA_MIN_ATENDIMENTO) || 7;
const HORA_MAX = Number(process.env.HORA_MAX_ATENDIMENTO) || 20;

function diaLocalDeAgora(deslocamentoDias) {
  const d = new Date(Date.now() + deslocamentoDias * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

const [, , argInicio, argFim] = process.argv;
const inicio = /^\d{4}-\d{2}-\d{2}$/.test(argInicio || '') ? argInicio : diaLocalDeAgora(-60);
const fim = /^\d{4}-\d{2}-\d{2}$/.test(argFim || '') ? argFim : diaLocalDeAgora(120);

function getAuth() {
  const cliPath = process.env.GOOGLE_OAUTH_CLIENT_JSON || 'google-oauth-client.json';
  const tokPath = process.env.GOOGLE_OAUTH_TOKEN_JSON || 'google-oauth-token.json';
  if (!fs.existsSync(cliPath) || !fs.existsSync(tokPath)) return null;
  const cred = JSON.parse(fs.readFileSync(cliPath, 'utf8'));
  const tok = JSON.parse(fs.readFileSync(tokPath, 'utf8'));
  const c = cred.installed || cred.web || cred;
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  o.setCredentials(tok);
  return o;
}

// Segundos do horario de inicio, lidos da string crua do Google ("2026-08-10T15:54:58-03:00").
// instanteParaNaiveLocal corta no minuto, e e exatamente o segundo que denuncia o eco.
function segundosDoInicio(dateTime) {
  const m = /T\d{2}:\d{2}:(\d{2})/.exec(String(dateTime || ''));
  return m ? m[1] : null;
}

(async () => {
  console.log(`\n🔍 Varredura de horarios nas agendas — janela ${inicio} a ${fim} (${TZ})`);
  console.log('   somente leitura: nada e criado, movido ou apagado\n');

  const auth = getAuth();
  if (!auth || !process.env.GOOGLE_CALENDAR_ID) {
    console.error('❌ Google Agenda nao configurado (google-oauth-client.json / google-oauth-token.json / GOOGLE_CALENDAR_ID)');
    process.exit(1);
  }
  const calendar = google.calendar({ version: 'v3', auth });

  // ---------- 1. Google Agenda (paginado por pageToken) ----------
  const eventos = [];
  let pageToken;
  do {
    const { data } = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: new Date(`${inicio}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${fim}T23:59:59Z`).toISOString(),
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });
    eventos.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  console.log(`📅 Google Agenda: ${eventos.length} eventos na janela`);

  // ---------- 2. Agenda do Moskit ----------
  let atividades = [];
  try {
    const r = await bot.listarAtividadesMoskit();
    atividades = r.atividades || [];
    if (r.truncou) console.log('   ⚠️ teto de paginas do Moskit atingido — a varredura do CRM cobre so as atividades mais recentes');
  } catch (e) {
    console.log(`   ⚠️ nao foi possivel listar atividades do Moskit: ${e.message}`);
  }
  const atividadePorId = new Map(atividades.map((a) => [String(a.id), a]));
  console.log(`🗓️ Agenda do Moskit: ${atividades.length} atividades lidas`);

  // ---------- 3. Banco de producao (readonly) ----------
  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  let porEventoId = new Map();
  let sincronizadas = new Map();
  if (fs.existsSync(caminhoBanco)) {
    const db = new Database(caminhoBanco, { readonly: true });
    for (const r of db.prepare('SELECT chat_id, contact_name, deal_id, evento_calendar_id, evento_calendar_data, atividade_moskit_id FROM conversations WHERE evento_calendar_id IS NOT NULL AND evento_calendar_id <> \'\'').all()) {
      porEventoId.set(r.evento_calendar_id, r);
    }
    for (const r of db.prepare('SELECT activity_id, evento_calendar_id, deal_id FROM atividades_sincronizadas').all()) {
      sincronizadas.set(String(r.evento_calendar_id), r);
    }
    db.close();
    console.log(`💾 Banco (${caminhoBanco}, readonly): ${porEventoId.size} consultas com evento, ${sincronizadas.size} atividades sincronizadas`);
  } else {
    console.log(`💾 Banco nao encontrado em ${caminhoBanco} — varredura segue so com Google + Moskit`);
  }

  // ---------- 4. Cruzamento ----------
  const achados = [];
  for (const ev of eventos) {
    if (!ev.start?.dateTime) continue; // evento de dia inteiro nao e consulta com hora marcada
    const inicioLocal = instanteParaNaiveLocal(ev.start.dateTime);
    const segundos = segundosDoInicio(ev.start.dateTime);
    const hora = Number((inicioLocal || '').slice(11, 13));
    const minuto = Number((inicioLocal || '').slice(14, 16));
    const problemas = [];
    const observacoes = [];

    // Origem do evento: a sincronizacao do CRM nomeia o evento com o id da atividade, e a tabela de
    // dedupe registra o par. Qualquer outro evento de consulta foi criado pelo bot (ou na mao).
    const origemMoskit = /^(oll|moskitatv)\d+/.test(ev.id) || sincronizadas.has(ev.id);
    const segundoQuebrado = segundos && segundos !== '00';
    // Minuto de slot = multiplo de 5. Consulta e marcada as 9h, 9h30, 10h15 — nunca as 15h54.
    const minutoDeSlot = Number.isFinite(minuto) && minuto % 5 === 0;

    if (inicioLocal && !minutoDeSlot) {
      problemas.push(`comeca em ${inicioLocal.slice(11)}${segundoQuebrado ? `:${segundos}` : ''} — minuto que ninguem marca, assinatura de timestamp copiado como horario`);
    } else if (segundoQuebrado && !origemMoskit) {
      problemas.push(`comeca em ${inicioLocal.slice(11)}:${segundos} e NAO veio da agenda do Moskit — o bot so escreve minuto inteiro, entao esse segundo veio de um timestamp`);
    } else if (segundoQuebrado) {
      observacoes.push(`segundos :${segundos} no inicio — vindos do dueDate da atividade do Moskit, que estampa o segundo`);
    }
    if (inicioLocal && (hora < HORA_MIN || hora > HORA_MAX)) {
      problemas.push(`${inicioLocal.slice(11)} esta fora do horario de atendimento (${HORA_MIN}h-${HORA_MAX}h)`);
    }

    const linhaBanco = porEventoId.get(ev.id);
    if (linhaBanco) {
      const noBanco = linhaBanco.evento_calendar_data;
      if (noBanco && !normalizarHorarioNaive(noBanco)) {
        problemas.push(`espelho local em formato invalido ("${noBanco}")`);
      }
      if (noBanco && inicioLocal && noBanco.slice(0, 16) !== inicioLocal) {
        problemas.push(`banco (${noBanco.slice(0, 16)}) e Google (${inicioLocal}) divergem`);
      }
    }

    // Atividade correspondente: pelo id guardado na conversa, ou pela tabela de dedupe (caminho
    // Moskit -> Google, em que a consulta nasceu no CRM e nunca passou por conversa nenhuma).
    const idAtividade = linhaBanco?.atividade_moskit_id || sincronizadas.get(ev.id)?.activity_id;
    const atv = idAtividade ? atividadePorId.get(String(idAtividade)) : null;
    if (atv?.dueDate) {
      const noMoskit = instanteParaNaiveLocal(atv.dueDate);
      if (noMoskit && inicioLocal && noMoskit !== inicioLocal) {
        problemas.push(`Google (${inicioLocal}) e agenda do Moskit (${noMoskit}) divergem`);
      }
    }

    if (problemas.length || observacoes.length) {
      achados.push({
        evento: ev.id,
        titulo: ev.summary || '(sem titulo)',
        quando: inicioLocal,
        cru: ev.start.dateTime,
        status: ev.status,
        no_banco: linhaBanco ? `deal ${linhaBanco.deal_id} (${linhaBanco.contact_name})` : 'NAO esta no banco (marcada fora do bot)',
        problemas,
        observacoes,
      });
    }
  }

  // Atividade futura no CRM sem evento nenhum no Google: a consulta existe pra quem trabalha no
  // Moskit e nao existe pra quem olha a agenda. Nao e horario errado, mas e da mesma familia.
  const idsAtividadesComEvento = new Set([
    ...[...porEventoId.values()].map((r) => String(r.atividade_moskit_id || '')),
    ...[...sincronizadas.values()].map((r) => String(r.activity_id)),
  ]);
  const semEvento = atividades.filter((a) => {
    if (!a.dueDate || a.doneDate) return false;
    const dia = instanteParaNaiveLocal(a.dueDate)?.slice(0, 10);
    if (!dia || dia < diaLocalDeAgora(0) || dia > fim) return false;
    return !idsAtividadesComEvento.has(String(a.id));
  });

  // ---------- 5. Relatorio ----------
  const comProblema = achados.filter((a) => a.problemas.length);
  const soObservacao = achados.filter((a) => !a.problemas.length);
  console.log(`\n${'='.repeat(70)}`);
  if (!comProblema.length) {
    console.log('✅ Nenhum horario divergente na janela varrida.');
  } else {
    console.log(`⚠️ ${comProblema.length} evento(s) com horario suspeito — CONFERIR:\n`);
    for (const a of comProblema) {
      console.log(`  ${a.quando}  ${a.titulo}`);
      console.log(`     evento ${a.evento} (${a.status}) · cru: ${a.cru}`);
      console.log(`     ${a.no_banco}`);
      for (const p of a.problemas) console.log(`     - ${p}`);
      console.log('');
    }
  }
  if (soObservacao.length) {
    console.log(`ℹ️ ${soObservacao.length} evento(s) so com observacao (provavelmente OK, listados por transparencia):`);
    for (const a of soObservacao) {
      console.log(`   ${a.quando} "${a.titulo}" — ${a.observacoes.join('; ')}`);
    }
    console.log('');
  }
  if (semEvento.length) {
    console.log(`ℹ️ ${semEvento.length} atividade(s) FUTURA(S) na agenda do Moskit sem evento no Google:`);
    for (const a of semEvento) {
      console.log(`   ${instanteParaNaiveLocal(a.dueDate)}  "${a.title}" (atividade ${a.id})`);
    }
  }
  console.log(`${'='.repeat(70)}`);
  console.log(`Resumo: ${eventos.length} eventos e ${atividades.length} atividades conferidos · ${comProblema.length} suspeitos · ${soObservacao.length} so com observacao · ${semEvento.length} atividades sem evento`);
  console.log('Nada foi alterado. Corrigir horario de evento: node corrigir-data-evento.js <chatId> <AAAA-MM-DDTHH:MM> --aplicar\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
