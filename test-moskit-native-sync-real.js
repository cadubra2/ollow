// Prova, contra o Moskit e o Google Agenda REAIS, se a sincronizacao NATIVA do Moskit (a que gera
// o evento com id "oll<activity_id>", ver sincronizarAtividadesMoskit em index.js) dispara sozinha
// quando a Activity nasce por POST /activities — o MESMO caminho que o bot ja usa
// (criarAtividadeMoskit/registrarConsultaNaAgendaMoskit) pra marcar a consulta na agenda do CRM.
//
// A pergunta que este script responde: se o bot passasse a criar a consulta A PARTIR do Moskit (em
// vez de criar o evento no Google primeiro, como faz hoje), o proprio Moskit empurraria o evento pro
// Google sozinho, sem o bot precisar do seu OAuth2? E se empurrar, ja vem com link de Meet e convite
// do cliente, ou nasce pelado (like os eventos oll<id> que sincronizarAtividadesMoskit ja trata)?
//
//   node test-moskit-native-sync-real.js             # so mostra o que faria — nao escreve nada
//   node test-moskit-native-sync-real.js --aplicar   # ESCREVE: cria atividade real, espera ate ~6min
//                                                       observando o Google Agenda, roda a sync do
//                                                       bot uma vez, e apaga tudo no fim
//
// NUNCA rodar em CI nem no npm test — mesma classe dos demais test-*-real.js (escreve em producao).
//
// Por que rodar isto contra producao e seguro (mesmo padrao de test-dedupe-agenda-real.js):
//   - WORKER_MODE=1  -> index.js carrega SEM subir servidor e SEM os setInterval; o ciclo que
//                       processa conversas reais e escreve no CRM nunca liga
//   - DB_PATH        -> banco descartavel; conversations.db de producao nao e aberto
//   - TELEGRAM_*     -> apagados, para a equipe nao receber notificacao de teste
//   - blindagem      -> TODAS as atividades futuras de clientes reais entram pre-marcadas como
//                       sincronizadas, entao nenhuma delas pode virar evento por causa deste teste
//   - limpeza        -> o finally apaga qualquer evento do Google criado (oll<id> e/ou
//                       moskitatv<id>, o que existir) e a Activity do Moskit, e confere que sumiram

const path = require('path');
require('dotenv').config();

const APLICAR = process.argv.includes('--aplicar');

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `native-sync-${process.pid}.db`);
// String vazia, NAO delete: index.js chama require('dotenv').config() de novo ao carregar, e o
// dotenv so preserva uma env var que ja EXISTE em process.env (mesmo vazia) — uma chave deletada
// e reposta a partir do .env, e a notificacao de teste vaza pro Telegram real do escritorio (visto
// na pratica: rodada de 14/08/2026 mandou "Consulta — TESTE sync nativo..." pro chat de producao).
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_CHAT_ID = '';

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

// Polling do evento nativo: 18 tentativas x 20s = ate 6 minutos so observando o Google, sem
// nenhuma ajuda do bot (sincronizarAtividadesMoskit so roda DEPOIS dessa janela, de proposito).
const TENTATIVAS_POLLING = 18;
const INTERVALO_POLLING_MS = 20000;

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

// Daqui a 2 dias as 15h no fuso do escritorio, na mesma string naive que o pipeline produz.
function horarioNaiveDeTeste() {
  const d = new Date(Date.now() + 48 * 3600 * 1000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T15:00:00`;
}

// Pagina por `?start=` — o unico parametro que /activities respeita (ver CLAUDE.md/index.js). A
// blindagem abaixo depende desta lista pra impedir que atividade de cliente real vire evento por
// causa do teste — um loop que rele a mesma pagina protegeria so os 10 mais recentes.
async function atividadesFuturasDeConsulta() {
  const todas = [];
  for (let p = 0; p < 40; p++) {
    const r = await req('get', `${MOSKIT_BASE}/activities?start=${todas.length}&limit=100&sort=id&order=desc`);
    if (r.status < 200 || r.status >= 300) break;
    const lote = Array.isArray(r.data) ? r.data : [];
    todas.push(...lote);
    if (lote.length < 10) break;
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
  console.log(`  janela de observacao do sync nativo: ${TENTATIVAS_POLLING}x${INTERVALO_POLLING_MS / 1000}s (~${Math.round(TENTATIVAS_POLLING * INTERVALO_POLLING_MS / 60000)} min)`);

  if (!APLICAR) {
    console.log('\nNada foi escrito. Rode com --aplicar para executar o teste de verdade.');
    console.log('O modo escrita cria UMA atividade real e apaga tudo no final.\n');
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
  const eventIdNativo = () => `oll${atividadeId}`;
  const eventIdFallback = () => `moskitatv${atividadeId}`;

  try {
    const marcar = db.prepare('INSERT OR IGNORE INTO atividades_sincronizadas (activity_id, evento_calendar_id, deal_id) VALUES (?, ?, ?)');
    for (const a of emRisco) marcar.run(a.id, 'blindagem-teste', a.deals?.[0]?.id || null);
    console.log(`\n🛡️  ${emRisco.length} atividades de clientes reais pre-marcadas — nenhuma vira evento por este teste`);

    // Seed pro caso a etapa final (sincronizarAtividadesMoskit) precisar do gate de pagamento —
    // autorizacaoParaAgendar exige comprovante verificado ou "consulta gratis". Vai no banco
    // descartavel, nao no de producao.
    db.prepare("INSERT INTO comprovantes (chat_id, phone, match, deal_id, observacao) VALUES ('teste','teste',1,?,'seed do teste de sync nativo')").run(DEAL);

    const payload = montarPayloadAtividade({
      dealId: DEAL,
      titulo: 'Consulta — TESTE sync nativo Moskit->Google (apagar)',
      assunto: 'Teste: POST /activities dispara sync nativo?',
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
    console.log(`   atividade de teste ${atividadeId} criada no deal ${DEAL} — id nativo esperado: ${eventIdNativo()}`);

    // ── JANELA DE OBSERVACAO: so o Google Calendar, sem nenhuma ajuda do bot ──
    console.log(`\n── Observando o Google Agenda por ate ~${Math.round(TENTATIVAS_POLLING * INTERVALO_POLLING_MS / 60000)} min (sem chamar sincronizarAtividadesMoskit) ──`);
    let eventoNativo = null;
    let tentativaEncontrou = null;
    for (let tentativa = 1; tentativa <= TENTATIVAS_POLLING; tentativa++) {
      const achou = await cal.events.get({ calendarId: CAL, eventId: eventIdNativo() }).then((r) => r.data).catch(() => null);
      if (achou) { eventoNativo = achou; tentativaEncontrou = tentativa; break; }
      console.log(`  tentativa ${tentativa}/${TENTATIVAS_POLLING}: ainda nao apareceu ${eventIdNativo()}`);
      if (tentativa < TENTATIVAS_POLLING) await espera(INTERVALO_POLLING_MS);
    }

    if (eventoNativo) {
      console.log(`\n✅ EVENTO NATIVO APARECEU sozinho (tentativa ${tentativaEncontrou}, ~${Math.round(tentativaEncontrou * INTERVALO_POLLING_MS / 1000)}s depois da criacao)`);
      console.log(`   summary: ${eventoNativo.summary}`);
      const temMeet = !!(eventoNativo.hangoutLink || eventoNativo.conferenceData?.entryPoints?.length);
      const temConvidados = !!(eventoNativo.attendees && eventoNativo.attendees.length);
      checar('   RESPOSTA #1: POST /activities dispara o sync nativo pro Google', true);
      checar('   RESPOSTA #2: evento nativo ja nasce com Meet', temMeet, { hangoutLink: eventoNativo.hangoutLink, entryPoints: eventoNativo.conferenceData?.entryPoints });
      checar('   RESPOSTA #2b: evento nativo ja nasce com convidado(s)', temConvidados, eventoNativo.attendees);
    } else {
      console.log(`\n❌ Evento nativo ${eventIdNativo()} NAO apareceu em ~${Math.round(TENTATIVAS_POLLING * INTERVALO_POLLING_MS / 60000)} min de observacao`);
      checar('   RESPOSTA #1: POST /activities dispara o sync nativo pro Google (dentro da janela testada)', false);
    }

    // ── Confirmatorio: como o PROPRIO bot reagiria a essa atividade agora ──
    console.log('\n── Rodando sincronizarAtividadesMoskit (confirmatorio) ──');
    const sync = await sincronizar();
    console.log(`  relatorio: ${JSON.stringify(sync.data)}`);
    if (eventoNativo) {
      checar('   o bot reconhece o evento nativo como ja sincronizado (nao cria outro)', (sync.data?.ja_sincronizadas || 0) >= 1, sync.data);
    } else {
      checar('   sem evento nativo, o bot cria o fallback via moskitatv<id>', sync.data?.eventos_criados === 1, sync.data);
    }
  } finally {
    console.log('\n── Limpeza ──');
    if (atividadeId) {
      for (const eventId of [eventIdNativo(), eventIdFallback()]) {
        const existe = await cal.events.get({ calendarId: CAL, eventId }).then((r) => r.data).catch(() => null);
        if (existe && existe.status !== 'cancelled') {
          const ok = await cal.events.delete({ calendarId: CAL, eventId })
            .then(() => true)
            .catch((e) => e.code === 404 || e.response?.status === 404);
          checar(`evento ${eventId} removido do Google Agenda`, !!ok);
        }
      }
      const d = await req('delete', `${MOSKIT_BASE}/activities/${atividadeId}`);
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
