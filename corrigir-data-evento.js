// Script de uso unico: corrige a data/hora de um evento ja criado no Google Calendar.
// Usado quando o bot agendou numa data errada e o fluxo automatico nao consegue remarcar sozinho
// (ex: a remarcacao exige confirmacao e o cliente nunca respondeu — ver handleAgendamentoCalendar).
//
// Preserva o link do Meet: o patch mexe so em start/end, nao em conferenceData. E nao usa
// sendUpdates, entao o cliente nao recebe e-mail.
//
// Uso: node corrigir-data-evento.js <chatId> <novaDataISO> [--aplicar]
//   ex: node corrigir-data-evento.js 5517991711168 2026-08-05T17:30:00 --aplicar
//
// ATENCAO: este script mexe SO no Google Agenda. A mesma consulta tambem existe como Atividade na
// agenda do Moskit (conversations.atividade_moskit_id) e ela NAO e movida aqui — depois de rodar,
// conferir o horario no CRM. Ver "As duas agendas" no CLAUDE.md.
require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const { normalizarHorarioNaive } = require('./src/evidencia');

const TZ = process.env.TZ_ESCRITORIO || 'America/Fortaleza';

// Mesma convencao do resto do pipeline (ver o comentario de TZ_ESCRITORIO em index.js): a string
// naive vai pro Google DO JEITO QUE ESTA, com o timeZone ao lado, e o Google resolve o instante.
// Este script fazia `new Date(naive).toISOString()`, que le a string no fuso do PROCESSO e manda um
// instante absoluto — o `timeZone` ao lado passa a ser ignorado pelo Google. Rodado na VPS (UTC),
// "2026-08-05T17:30:00" virava 14:30 em Fortaleza: o script de CONSERTAR data reintroduzia o proprio
// bug que ele existe pra consertar, e ainda gravava a naive original no banco, deixando o espelho
// local mentindo pra sempre (evento_calendar_data dizia 17:30 e o Google tinha 14:30).
function somarMinutosNaive(isoNaive, minutos) {
  const d = new Date(`${isoNaive}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutos);
  return d.toISOString().slice(0, 19);
}
const [, , chatId, novaDataISO] = process.argv;
const aplicar = process.argv.includes('--aplicar');

function getAuth() {
  const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_JSON || 'google-oauth-client.json', 'utf8'));
  const tok = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_TOKEN_JSON || 'google-oauth-token.json', 'utf8'));
  const c = cred.installed || cred.web;
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  o.setCredentials(tok);
  return o;
}

(async () => {
  if (!chatId || !novaDataISO) {
    console.error('uso: node corrigir-data-evento.js <chatId> <novaDataISO> [--aplicar]');
    process.exit(1);
  }

  // Formato estrito: hora do escritorio, sem Z e sem offset. Um valor com fuso embutido aqui e o
  // caminho mais curto pra remarcar a consulta 3h fora do lugar.
  const novoInicioNaive = normalizarHorarioNaive(novaDataISO);
  if (!novoInicioNaive) {
    console.error(`data invalida: "${novaDataISO}" — use AAAA-MM-DDTHH:MM (hora do escritorio, sem Z e sem offset)`);
    process.exit(1);
  }

  const db = new Database('conversations.db');
  const row = db.prepare('SELECT chat_id, contact_name, deal_id, evento_calendar_id FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row?.evento_calendar_id) {
    console.error(`chat ${chatId} nao tem evento_calendar_id salvo`);
    process.exit(1);
  }

  const calendar = google.calendar({ version: 'v3', auth: getAuth() });
  const atual = await calendar.events.get({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });

  console.log(`cliente: ${row.contact_name} | deal: ${row.deal_id} | evento: ${row.evento_calendar_id}`);
  console.log(`ANTES  -> ${atual.data.start?.dateTime} (Meet: ${atual.data.hangoutLink || '-'})`);
  console.log(`DEPOIS -> ${novoInicioNaive} (${TZ})`);

  if (!aplicar) {
    console.log('(dry-run — rode com --aplicar pra gravar)');
    return;
  }

  const patched = await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: row.evento_calendar_id,
    requestBody: {
      start: { dateTime: novoInicioNaive, timeZone: TZ },
      end: { dateTime: somarMinutosNaive(novoInicioNaive, 60), timeZone: TZ },
    },
  });

  // Grava a MESMA string que foi enviada no payload. atualizarEventoSeRemarcado compara
  // evento_calendar_data com o novo horario por igualdade de string, entao qualquer divergencia aqui
  // faz o bot achar que a agenda esta num horario em que ela nao esta.
  db.prepare('UPDATE conversations SET evento_calendar_data = ? WHERE chat_id = ?').run(novoInicioNaive, chatId);

  console.log(`\nPATCH ok -> ${patched.data.start?.dateTime}`);
  console.log(`Meet preservado: ${patched.data.hangoutLink || '(sem link)'}`);
  // Confere o que o Google REALMENTE gravou, comparando a hora local do escritorio com o que pedimos.
  const gravadoLocal = patched.data.start?.dateTime
    ? new Date(patched.data.start.dateTime).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T')
    : null;
  const ok = gravadoLocal === novoInicioNaive;
  console.log(ok ? '✅ corrigido' : `❌ o Google aceitou mas gravou outra coisa (${gravadoLocal})`);
  console.log('⚠️  a Atividade na agenda do Moskit NAO foi movida por este script — conferir no CRM.');
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
