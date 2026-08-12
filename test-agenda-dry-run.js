// AGENDA_MOSKIT_DRY_RUN ligado — o botao de emergencia da agenda do Moskit. Rodar com:
//   node test-agenda-dry-run.js
//
// Arquivo separado de test-pipeline.js por necessidade, nao por gosto: a flag e lida como `const` no
// require de index.js, entao os dois valores nao cabem no mesmo processo. test-pipeline.js fixa
// 'false' e cobre a agenda funcionando; aqui fixamos 'true' e cobrimos o desligamento.
//
// O que este teste protege: que desligar a agenda do CRM NAO derruba o resto do agendamento. O evento
// no Google, a nota no negocio, o avanco de estagio e o contrato continuam acontecendo — a flag e
// cirurgica. Se ela virar um "desliga o agendamento inteiro", o escritorio perde consulta de cliente
// real achando que so silenciou o CRM.
//
// Mesmo dublê de rede de test-pipeline.js: nenhum byte sai da maquina.

const path = require('path');
const Database = require('better-sqlite3');
const { dirTemporario } = require('./test-utils');

const DIR = dirTemporario('agenda-dry-run');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.GOOGLE_CALENDAR_ID = 'agenda-de-teste@exemplo.com';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.FUNIL_DRY_RUN = 'true';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true';
process.env.AGENDA_MOSKIT_DRY_RUN = 'true'; // <- o objeto deste arquivo

// ---------- dublê do axios ----------
const axios = require('axios');
const rede = { chamadas: [] };
for (const metodo of ['get', 'post', 'put', 'patch', 'delete']) {
  axios[metodo] = async (url, a, b) => {
    const corpo = metodo === 'get' || metodo === 'delete' ? undefined : a;
    rede.chamadas.push({ metodo: metodo.toUpperCase(), url, corpo, cfg: corpo === undefined ? a : b });
    return { status: 200, data: {} };
  };
}

// ---------- dublê do Google Calendar ----------
const { google } = require('googleapis');
const agenda = { insert: [], patch: [] };
google.calendar = () => ({
  events: {
    insert: async (a) => { agenda.insert.push(a); return { data: { id: 'ev1', htmlLink: 'https://exemplo/ev1' } }; },
    patch: async (a) => { agenda.patch.push(a); return { data: {} }; },
    get: async () => ({ data: { summary: 'antigo', description: 'antigo' } }),
    delete: async () => ({}),
  },
});

const { handleAgendamentoCalendar } = require('./index');

const db = new Database(process.env.DB_PATH);
let passou = 0;
let falhou = 0;
const checar = (nome, ok, det) => {
  if (ok) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${det !== undefined ? ` — obtido: ${JSON.stringify(det)}` : ''}`); }
};
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const de = (metodo, frag) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(frag));

const CHAT = '5586933334444';
const DADOS = { nome: 'Fulano de Tal', assunto: 'Inventario', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno' };
const ACEITE = { tipo: 'cliente_aceitou_horario', msg_idx: 2, trecho: 'pode ser sim', horario_iso: '2026-08-05T17:30:00' };
const CONFIRMA = { tipo: 'equipe_confirmou_horario', msg_idx: 3, trecho: 'marquei sua consulta', horario_iso: '2026-08-05T17:30:00' };
const CONFIRMADO = { confirmado: true, horarioIso: '2026-08-05T17:30:00', cliente: ACEITE, equipe: CONFIRMA, motivo: null };

function semear(chatId, extras = {}) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
  const campos = { chat_id: chatId, phone: chatId, contact_name: 'Fulano', messages: '[]', ...extras };
  const cols = Object.keys(campos);
  db.prepare(`INSERT INTO conversations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => campos[c]));
  return db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);
}

(async () => {
  console.log('\n=== AGENDA_MOSKIT_DRY_RUN=true: a agenda do CRM fica de fora, o resto continua ===');

  const row = semear(CHAT, { deal_id: 20 });
  await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);

  igual('nenhuma atividade criada no Moskit', de('POST', '/activities').length, 0);
  igual('   e nenhum PUT de remarcacao', de('PUT', '/activities').length, 0);

  const linha = db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(CHAT);
  igual('   atividade_moskit_id continua nulo', linha.atividade_moskit_id, null);
  igual('   nada entra em atividades_sincronizadas', db.prepare('SELECT COUNT(*) t FROM atividades_sincronizadas').get().t, 0);

  const notas = de('POST', '/notes');
  checar('uma nota [dry-run] avisa que a consulta nao foi pra agenda do CRM',
    notas.some((n) => n.corpo.description.includes('[dry-run]') && n.corpo.description.includes('agenda do Moskit')),
    notas.map((n) => n.corpo.description));
  checar('   e diz qual variavel desligar',
    notas.some((n) => n.corpo.description.includes('AGENDA_MOSKIT_DRY_RUN')));

  // O ponto mais importante: a flag e cirurgica. Se desligar a agenda do CRM tambem parasse o evento
  // no Google, o escritorio perderia a consulta achando que so silenciou o CRM.
  console.log('\n=== o resto do agendamento continua intacto ===');
  igual('o evento no Google Agenda foi criado normalmente', agenda.insert.length, 1);
  igual('   com o horario confirmado', agenda.insert[0].requestBody.start.dateTime, '2026-08-05T17:30:00');
  igual('   banco: evento_calendar_criado', linha.evento_calendar_criado, 1);
  igual('   banco: evento_calendar_id salvo', linha.evento_calendar_id, 'ev1');
  checar('a nota normal de agendamento continua saindo',
    notas.some((n) => n.corpo.description.includes('Reunião agendada no Google Calendar')));
  checar('   e ela NAO afirma que entrou na agenda do Moskit',
    !notas.some((n) => n.corpo.description.includes('Também marcada na agenda do Moskit')));

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
