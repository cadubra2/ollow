// Script de uso unico: corrige a data/hora de um evento ja criado no Google Calendar.
// Usado quando o bot agendou numa data errada e o fluxo automatico nao consegue remarcar sozinho
// (ex: a remarcacao exige confirmacao e o cliente nunca respondeu — ver handleAgendamentoCalendar).
//
// Preserva o link do Meet: o patch mexe so em start/end, nao em conferenceData. E nao usa
// sendUpdates, entao o cliente nao recebe e-mail.
//
// Uso: node corrigir-data-evento.js <chatId> <novaDataISO> [--aplicar]
//   ex: node corrigir-data-evento.js 5517991711168 2026-08-05T17:30:00 --aplicar
require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const Database = require('better-sqlite3');

const TZ = 'America/Fortaleza';
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

  const novoInicio = new Date(novaDataISO);
  if (isNaN(novoInicio.getTime())) {
    console.error(`data invalida: ${novaDataISO}`);
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
  console.log(`DEPOIS -> ${novoInicio.toLocaleString('pt-BR', { timeZone: TZ })}`);

  if (!aplicar) {
    console.log('(dry-run — rode com --aplicar pra gravar)');
    return;
  }

  const novoFim = new Date(novoInicio.getTime() + 60 * 60 * 1000);
  const patched = await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId: row.evento_calendar_id,
    requestBody: {
      start: { dateTime: novoInicio.toISOString(), timeZone: TZ },
      end: { dateTime: novoFim.toISOString(), timeZone: TZ },
    },
  });

  db.prepare('UPDATE conversations SET evento_calendar_data = ? WHERE chat_id = ?').run(novaDataISO, chatId);

  console.log(`\nPATCH ok -> ${patched.data.start?.dateTime}`);
  console.log(`Meet preservado: ${patched.data.hangoutLink || '(sem link)'}`);
  const ok = new Date(patched.data.start?.dateTime).getTime() === novoInicio.getTime();
  console.log(ok ? '✅ corrigido' : '❌ o Google aceitou mas gravou outra coisa');
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
