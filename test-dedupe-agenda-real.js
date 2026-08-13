// Prova, contra o Moskit e o Google Agenda REAIS, que a consulta nao entra duas vezes na agenda.
//
// A pergunta que este script responde: quando o bot cria a Atividade no Moskit
// (registrarConsultaNaAgendaMoskit), a sincronizacao periodica (sincronizarAtividadesMoskit, que
// roda a cada SYNC_INTERVAL_MS) cria um SEGUNDO evento no Google para a mesma consulta?
//
//   node test-dedupe-agenda-real.js             # so mostra o que faria — nao escreve nada
//   node test-dedupe-agenda-real.js --aplicar   # ESCREVE: cria atividade e evento reais, e apaga no fim
//
// NUNCA rodar em CI nem no npm test.
//
// A prova precisa das DUAS rodadas — so a segunda nao prova nada, porque um "nao criou evento"
// tambem acontece se a sync estiver quebrada:
//   A) atividade FORA de atividades_sincronizadas  -> a sync DEVE criar 1 evento (a trava e necessaria)
//   B) atividade DENTRO da tabela (o que o bot faz) -> a sync DEVE pular       (a trava funciona)
//
// Por que rodar isto contra producao e seguro:
//   - WORKER_MODE=1  -> index.js carrega SEM subir servidor e SEM os setInterval; o ciclo que
//                       processa conversas reais e escreve no CRM nunca liga
//   - DB_PATH        -> banco descartavel; conversations.db de producao nao e aberto
//   - TELEGRAM_*     -> apagados, para a equipe nao receber notificacao de teste
//   - blindagem      -> TODAS as atividades futuras de clientes reais entram pre-marcadas como
//                       sincronizadas, entao nenhuma delas pode virar evento por causa deste teste
//   - limpeza        -> o finally apaga o evento do Google e a atividade do Moskit, e confere que
//                       sumiram (inclusive se o teste falhar no meio)

const path = require('path');
require('dotenv').config();

const APLICAR = process.argv.includes('--aplicar');

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `dedupe-agenda-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const axios = require('axios');
const Database = require('better-sqlite3');
const { google } = require('googleapis');
const { montarPayloadAtividade, horarioNaiveParaInstante } = require('./src/atividade-moskit');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const TZ = process.env.TZ_ESCRITORIO || 'America/Fortaleza';
const CAL = process.env.GOOGLE_CALENDAR_ID;
const ADMIN = process.env.ADMIN_TOKEN;
const DEAL = Number(process.env.DEAL_TESTE) || 48290481; // "TESTE BOT - ignorar (validacao automacao funil)"
const PORTA = Number(process.env.PORTA_TESTE) || 3999;

const h = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_TEST' };
const req = (m, u, d) => axios({ method: m, url: u, data: d, headers: h, validateStatus: () => true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let passou = 0;
let falhou = 0;
const checar = (nome, ok, det) => {
  if (ok) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${det !== undefined ? ` — ${JSON.stringify(det)}` : ''}`); }
};

function calendario() {
  const cred = require('./google-oauth-client.json');
  const tok = require('./google-oauth-token.json');
  const c = cred.installed || cred.web;
  const oAuth2 = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  oAuth2.setCredentials(tok);
  return google.calendar({ version: 'v3', auth: oAuth2 });
}

// Daqui a 2 dias as 14h no fuso do escritorio, na mesma string naive que o pipeline produz.
function horarioNaiveDeTeste() {
  const d = new Date(Date.now() + 48 * 3600 * 1000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T14:00:00`;
}

// Pagina por `?start=` — o unico parametro que esta API respeita em /activities (medido em
// 12/08/2026: page, pageToken, limit, offset, skip e from sao todos ignorados EM SILENCIO, devolvendo
// a primeira pagina de novo). Aqui isso nao e detalhe de precisao: a blindagem abaixo depende desta
// lista para impedir que atividade de cliente real vire evento por causa do teste, e um loop que rele
// a mesma pagina protegeria so os 10 mais recentes achando que protegeu todos.
async function atividadesFuturasDeConsulta() {
  const todas = [];
  for (let p = 0; p < 40; p++) {
    const r = await req('get', `${MOSKIT_BASE}/activities?start=${todas.length}&limit=100&sort=id&order=desc`);
    if (r.status < 200 || r.status >= 300) break;
    const lote = Array.isArray(r.data) ? r.data : [];
    todas.push(...lote);
    if (lote.length < 10) break; // pagina incompleta = fim da lista
  }
  const agora = Date.now();
  return todas.filter((a) => MOSKIT_IDS.ATIVIDADE_TIPOS_CONSULTA.has(a?.type?.id)
    && !a.doneDate && a.dueDate && new Date(a.dueDate).getTime() > agora);
}

async function main() {
  for (const [nome, valor] of [['MOSKIT_API_KEY', process.env.MOSKIT_API_KEY], ['ADMIN_TOKEN', ADMIN], ['GOOGLE_CALENDAR_ID', CAL]]) {
    if (!valor) { console.error(`${nome} ausente no .env`); process.exit(1); }
  }

  console.log(`\n${APLICAR ? '⚠️  MODO ESCRITA' : '🔍 SO LEITURA'} — deal de teste ${DEAL}, calendario ${CAL}\n`);

  const emRisco = await atividadesFuturasDeConsulta();
  const naive = horarioNaiveDeTeste();
  console.log(`  ${emRisco.length} atividades futuras de consulta no CRM — todas entram na blindagem`);
  console.log(`  horario da atividade de teste: ${naive} (${TZ})`);

  if (!APLICAR) {
    console.log('\nNada foi escrito. Rode com --aplicar para executar as duas rodadas de verdade.');
    console.log('O modo escrita cria UMA atividade e UM evento de teste, e apaga os dois no final.\n');
    return;
  }

  const { app } = require('./index.js'); // WORKER_MODE=1: sem servidor de producao, sem setInterval
  const servidor = app.listen(PORTA);
  const db = new Database(process.env.DB_PATH);
  const cal = calendario();
  const sincronizar = () => axios.post(`http://localhost:${PORTA}/sincronizar-atividades`, {}, {
    headers: { 'X-Admin-Token': ADMIN }, validateStatus: () => true, timeout: 180000,
  });

  let atividadeId = null;
  let eventoId = null;

  try {
    const marcar = db.prepare('INSERT OR IGNORE INTO atividades_sincronizadas (activity_id, evento_calendar_id, deal_id) VALUES (?, ?, ?)');
    for (const a of emRisco) marcar.run(a.id, 'blindagem-teste', a.deals?.[0]?.id || null);
    console.log(`\n🛡️  ${emRisco.length} atividades de clientes reais pre-marcadas — nenhuma vira evento por este teste`);

    // Sem comprovante o gate de pagamento (autorizacaoParaAgendar) barra a atividade ANTES de chegar
    // na trava, e a rodada A nao provaria nada. Vai no banco descartavel, nao no de producao.
    db.prepare("INSERT INTO comprovantes (chat_id, phone, match, deal_id, observacao) VALUES ('teste','teste',1,?,'seed do teste de dedupe')").run(DEAL);

    const payload = montarPayloadAtividade({
      dealId: DEAL,
      titulo: 'Consulta — TESTE dedupe agenda (apagar)',
      assunto: 'Teste de nao-duplicacao entre as duas agendas',
      dueDate: horarioNaiveParaInstante(naive, TZ),
      presencial: false,
      meetLink: null,
    });
    const post = await req('post', `${MOSKIT_BASE}/activities`, payload);
    atividadeId = post.data?.id;
    if (!atividadeId) {
      console.error(`\n❌ Nao consegui criar a atividade de teste (HTTP ${post.status}): ${JSON.stringify(post.data)}`);
      process.exit(1);
    }
    console.log(`   atividade de teste ${atividadeId} criada no deal ${DEAL}`);

    // A LISTAGEM demora a enxergar o que acabou de ser criado (o mesmo cache de ate ~4s que o
    // CLAUDE.md documenta para GET logo apos escrita). Sem esperar, a RODADA A varre e nao acha a
    // atividade: o teste "passa" na rodada errada e as duas conclusoes saem invertidas.
    let visivel = false;
    for (let tentativa = 0; tentativa < 8 && !visivel; tentativa++) {
      await espera(2000);
      const r = await req('get', `${MOSKIT_BASE}/activities?start=0&limit=100&sort=id&order=desc`);
      visivel = (Array.isArray(r.data) ? r.data : []).some((a) => a.id === atividadeId);
    }
    if (!visivel) {
      console.error(`\n❌ A atividade ${atividadeId} nao apareceu na listagem — sem isso as rodadas nao provam nada.`);
      process.exit(1);
    }
    console.log('   e ja aparece na listagem que a sincronizacao varre\n');

    // ── RODADA A: sem a trava. Se a sync NAO criar evento aqui, a rodada B nao prova nada. ──
    console.log('── RODADA A: atividade FORA de atividades_sincronizadas ──');
    // Insistir ate a varredura enxergar a atividade. A listagem do Moskit demora a incluir o que
    // acabou de ser criado, e — medido na pratica — uma leitura positiva NAO garante que a proxima
    // tambem veja: o teste ficava intermitente, com as duas rodadas trocando de resultado. Repetir e
    // seguro porque a sync so cria evento para atividade que ainda nao esta em
    // atividades_sincronizadas, entao a tentativa que der certo e a unica que escreve.
    let a = null;
    for (let tentativa = 1; tentativa <= 6; tentativa++) {
      a = await sincronizar();
      console.log(`  tentativa ${tentativa}: ${JSON.stringify(a.data)}`);
      if (a.data?.eventos_criados >= 1) break;
      await espera(3000);
    }
    checar('sem a trava, a sync cria 1 evento no Google (prova que a trava e necessaria)', a.data?.eventos_criados === 1, a.data);
    eventoId = `moskitatv${atividadeId}`;
    const evA = await cal.events.get({ calendarId: CAL, eventId: eventoId }).then((r) => r.data).catch(() => null);
    checar(`   o evento ${eventoId} existe mesmo no calendario`, !!evA && evA.status !== 'cancelled', evA?.summary);
    checar('   e a linha de dedupe ficou gravada apontando pro evento',
      db.prepare('SELECT * FROM atividades_sincronizadas WHERE activity_id = ?').get(atividadeId)?.evento_calendar_id === eventoId);

    // ── RODADA B: com a trava — exatamente o estado que registrarConsultaNaAgendaMoskit deixa ──
    console.log('\n── RODADA B: atividade DENTRO de atividades_sincronizadas ──');
    const b = await sincronizar();
    console.log(`  relatorio: ${JSON.stringify(b.data)}`);
    checar('a sync NAO cria um segundo evento', b.data?.eventos_criados === 0, b.data);
    checar('   e conta a atividade como ja_sincronizada', (b.data?.ja_sincronizadas || 0) >= 1, b.data);

    const lista = await cal.events.list({ calendarId: CAL, q: 'TESTE dedupe agenda', singleEvents: true, timeMin: new Date().toISOString() });
    const vivos = (lista.data.items || []).filter((e) => e.status !== 'cancelled');
    checar('o Google Agenda tem UM evento para essa consulta, nao dois', vivos.length === 1, vivos.map((e) => e.id));
  } finally {
    console.log('\n── Limpeza ──');
    if (eventoId) {
      const ok = await cal.events.delete({ calendarId: CAL, eventId: eventoId })
        .then(() => true)
        .catch((e) => e.code === 404 || e.response?.status === 404);
      checar(`evento ${eventoId} removido do Google Agenda`, !!ok);
    }
    if (atividadeId) {
      const d = await req('delete', `${MOSKIT_BASE}/activities/${atividadeId}`);
      // A releitura logo apos o DELETE ainda devolve 200 por alguns segundos (mesmo cache de escrita
      // que confirmarAposRetentativas trata para deal). Reconferir com espera crescente, senao o
      // teste acusa sujeira que nao existe.
      let ultimo = null;
      for (const ms of [1500, 2000, 3000, 4000]) {
        await espera(ms);
        ultimo = await req('get', `${MOSKIT_BASE}/activities/${atividadeId}`);
        if (ultimo.status >= 400) break;
      }
      checar(`atividade ${atividadeId} removida do Moskit`, d.status < 300 && ultimo.status >= 400, { del: d.status, get: ultimo.status });
    }
    servidor.close();
    console.log(`\n${'='.repeat(50)}\n${passou} passaram · ${falhou} falharam\n`);
    process.exit(falhou ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('\n❌', e.response?.status || '', e.message);
  process.exit(1);
});
