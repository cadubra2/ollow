// Levanta os contratos que a rotina de notas de reuniao (Gemini -> Moskit) assume mas o repositorio
// nunca exerceu. SO LEITURA — nao escreve em lugar nenhum. NUNCA rodar em CI nem no npm test: le
// producao (Moskit real + Google Agenda real).
//
//   node sondar-notas.js [dealId]
//
// O que mede, e por que cada um importa:
//
// 1. GET /deals/{id}/notes existe e devolve o TEXTO da nota?
//    E a maior incognita do desenho. O bracket do POST guarda um marcador `[ollow-notas:xxxxxxxx]`
//    no fim da nota justamente para que, se o processo morrer entre "gravei POSTANDO" e "gravei
//    POSTADA", a retomada consiga perguntar ao CRM se a nota ja existe em vez de repostar as cegas.
//    Sem esse GET, esse estado ambiguo nao tem como ser resolvido e todo caso vira REVISAR_MANUAL.
//
// 2. Como esse endpoint pagina?
//    /activities ignora `limit`, `page` e `pageToken` EM SILENCIO e responde 200 com a primeira
//    pagina de novo; /contacts pagina por header. O mecanismo difere por endpoint neste CRM, entao
//    nao da para assumir nada. Se a busca do marcador so olhar a primeira pagina de um deal com
//    muitas notas, ela responde "nao achei" para uma nota que existe — e ai o codigo posta a segunda.
//
// 3. events.list devolve `attachments` pela credencial DO BOT?
//    O Doc das notas do Gemini vem em attachments[].fileUrl do evento. Isso foi visto numa leitura
//    avulsa da agenda; aqui a pergunta e outra: o token OAuth do bot (escopo `calendar`) enxerga
//    esse campo? Se nao enxergar, a ancora do desenho muda e o Doc precisa sair do HTML do e-mail.
//
// 4. A credencial nova de Gmail/Drive ja existe?
//    So reporta o que falta; nao tenta autorizar nada.

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const TZ_ESCRITORIO = process.env.TZ_ESCRITORIO || 'America/Fortaleza';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json' };

// Deal da Lia (48292471) so como padrao conveniente: e um deal real citado no CLAUDE.md que
// certamente tem notas escritas pelo bot. Qualquer dealId serve.
const dealId = process.argv[2] || '48292471';

const req = (url, params) => axios.get(url, { headers, params, validateStatus: () => true });
const preview = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

function titulo(n, texto) {
  console.log(`\n${'='.repeat(72)}\n${n}. ${texto}\n${'='.repeat(72)}`);
}

// ------------------------------------------------------------
// 1 e 2 — GET /deals/{id}/notes
// ------------------------------------------------------------
async function sondarNotasDoDeal() {
  titulo(1, `GET /deals/${dealId}/notes — existe? devolve o texto?`);

  const res = await req(`${MOSKIT_BASE}/deals/${dealId}/notes`);
  console.log(`   HTTP ${res.status}`);

  if (res.status < 200 || res.status >= 300) {
    console.log(`   ❌ Corpo: ${preview(JSON.stringify(res.data), 300)}`);
    console.log('\n   VEREDITO: o endpoint NAO serve. A reconciliacao do estado POSTANDO fica');
    console.log('   impossivel — todo caso ambiguo tera de virar REVISAR_MANUAL + Telegram.');
    return null;
  }

  const lista = Array.isArray(res.data) ? res.data : res.data?.items || res.data?.content;
  if (!Array.isArray(lista)) {
    console.log(`   ⚠️ 2xx mas o corpo nao e uma lista. Formato: ${preview(JSON.stringify(res.data), 300)}`);
    return null;
  }

  console.log(`   ✅ Devolveu ${lista.length} nota(s).`);
  if (!lista.length) {
    console.log('   ⚠️ Deal sem nota nenhuma — passe outro dealId para medir o formato do item.');
    return { lista, campoTexto: null };
  }

  const primeira = lista[0];
  console.log(`   Campos do item: ${Object.keys(primeira).join(', ')}`);

  // Qual campo carrega o texto? criarNotaMoskit ENVIA `description`, mas a leitura pode devolver
  // com outro nome — ja aconteceu neste CRM (test-fechamento-dry-run.js le `description || descricao`).
  const campoTexto = ['description', 'descricao', 'text', 'body', 'content']
    .find((c) => typeof primeira[c] === 'string' && primeira[c].length);
  console.log(`   Campo com o texto: ${campoTexto || '(NENHUM — problema)'}`);
  if (campoTexto) console.log(`   Amostra: "${preview(primeira[campoTexto])}"`);

  // O marcador fica na ULTIMA linha da nota. Se a API truncar o texto na listagem, a busca do
  // marcador falha em silencio justamente nas notas longas — que sao todas as deste projeto.
  if (campoTexto) {
    const maior = lista.reduce((a, b) => ((b[campoTexto] || '').length > (a[campoTexto] || '').length ? b : a));
    const texto = maior[campoTexto] || '';
    console.log(`   Maior nota devolvida: ${texto.length} chars, termina em "...${preview(texto.slice(-60), 60)}"`);
    console.log(`   ${texto.endsWith('...') ? '⚠️ TERMINA EM "..." — suspeita de truncagem' : '✅ Nao aparenta truncagem'}`);
  }

  titulo(2, 'Paginacao de /notes — `start` funciona? `limit` e respeitado?');

  const p0 = await req(`${MOSKIT_BASE}/deals/${dealId}/notes`, { start: 0 });
  const p1 = await req(`${MOSKIT_BASE}/deals/${dealId}/notes`, { start: 1 });
  const pL = await req(`${MOSKIT_BASE}/deals/${dealId}/notes`, { limit: 100 });

  const ids = (r) => (Array.isArray(r.data) ? r.data.map((n) => n.id).join(',') : '(nao-lista)');
  const n = (r) => (Array.isArray(r.data) ? r.data.length : -1);

  console.log(`   sem params : ${lista.length} itens`);
  console.log(`   ?start=0   : ${n(p0)} itens`);
  console.log(`   ?start=1   : ${n(p1)} itens`);
  console.log(`   ?limit=100 : ${n(pL)} itens`);
  console.log(`   start=0 e start=1 devolveram a MESMA coisa? ${ids(p0) === ids(p1) ? '⚠️ SIM (start ignorado)' : '✅ nao (start pagina)'}`);
  console.log(`   Header x-moskit-listing-total: ${res.headers['x-moskit-listing-total'] ?? '(ausente)'}`);
  console.log(`   Header next-page-token: ${res.headers['x-moskit-listing-next-page-token'] ?? '(ausente)'}`);

  if (lista.length === 10 || n(pL) === 10) {
    console.log('   ⚠️ Exatamente 10 itens: mesmo teto de /activities. Assumir que ha mais paginas.');
  }

  return { lista, campoTexto };
}

// ------------------------------------------------------------
// 3 — events.list traz `attachments` pela credencial do bot?
// ------------------------------------------------------------
async function sondarAnexosDoEvento() {
  titulo(3, 'Google Agenda — events.list devolve attachments[] (o Doc do Gemini)?');

  const clientPath = process.env.GOOGLE_OAUTH_CLIENT_JSON || './google-oauth-client.json';
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_JSON || './google-oauth-token.json';
  if (!fs.existsSync(clientPath) || !fs.existsSync(tokenPath)) {
    console.log(`   ⏭️ Credencial do Calendar ausente (${clientPath} / ${tokenPath}) — pulando.`);
    return;
  }

  const { client_id, client_secret, redirect_uris } = JSON.parse(fs.readFileSync(clientPath, 'utf8')).installed;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));

  const calendar = google.calendar({ version: 'v3', auth });
  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: desde,
    timeMax: new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
    q: 'Consulta',
  });

  const eventos = (res.data.items || []).filter((e) => e.status !== 'cancelled');
  const comAnexo = eventos.filter((e) => (e.attachments || []).length);
  const comTelefone = eventos.filter((e) => /Telefone:\s*\d+/.test(e.description || ''));

  console.log(`   Eventos "Consulta" nos ultimos 30 dias: ${eventos.length}`);
  console.log(`   ...com attachments[]: ${comAnexo.length}`);
  console.log(`   ...com "Telefone:" na descricao: ${comTelefone.length}`);

  if (!comAnexo.length) {
    console.log('   ⚠️ Nenhum anexo veio. Ou nenhuma reuniao gerou notas na janela, ou o campo nao');
    console.log('      chega por esta credencial. Nesse caso o docId tem de sair do HTML do e-mail.');
  } else {
    const e = comAnexo[comAnexo.length - 1];
    console.log(`   ✅ Exemplo: "${e.summary}" (${e.start?.dateTime || e.start?.date})`);
    for (const a of e.attachments) console.log(`      - ${a.title}: ${a.fileUrl}`);
    const casaTelefone = /Telefone:\s*(\d+)/.exec(e.description || '');
    console.log(`      Telefone na descricao: ${casaTelefone ? casaTelefone[1] : '(ausente)'}`);
  }

  // Cobertura da cascata. O denominador que importa NAO e "todo evento de consulta": e so o
  // subconjunto que gerou notas do Gemini (tem anexo), porque so esses viram e-mail e, portanto,
  // trabalho para esta rotina. Medir sobre o total subestima ou superestima sem querer.
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const anexoComTelefone = comAnexo.filter((e) => /Telefone:\s*\d+/.test(e.description || ''));
  console.log(`   Cobertura do passo (b) "Telefone:" sobre TODOS os eventos: ${pct(comTelefone.length, eventos.length)}`);
  console.log(`   Cobertura sobre os que GERARAM NOTAS (o que importa): ${anexoComTelefone.length}/${comAnexo.length} = ${pct(anexoComTelefone.length, comAnexo.length)}`);
  for (const e of comAnexo) {
    const tem = /Telefone:\s*(\d+)/.exec(e.description || '');
    console.log(`      ${tem ? '✅' : '❌'} "${e.summary}" ${tem ? `(${tem[1]})` : '— sem Telefone, cairia no fallback'}`);
  }
}

// ------------------------------------------------------------
// 4 — credencial nova de Gmail/Drive
// ------------------------------------------------------------
function sondarCredencialNotas() {
  titulo(4, 'Credencial OAuth de Gmail/Drive (separada da agenda)');

  const c = process.env.GOOGLE_OAUTH_CLIENT_NOTAS_JSON || './google-oauth-client-notas.json';
  const t = process.env.GOOGLE_OAUTH_TOKEN_NOTAS_JSON || './google-oauth-token-notas.json';

  console.log(`   Cliente (${c}): ${fs.existsSync(c) ? '✅ existe' : '❌ falta'}`);
  console.log(`   Token   (${t}): ${fs.existsSync(t) ? '✅ existe' : '❌ falta'}`);

  if (!fs.existsSync(t)) {
    console.log('\n   Para gerar: criar um cliente OAuth tipo Desktop no projeto GCP');
    console.log('   persuasive-ego-503412-s7, habilitar Gmail API e Drive API, salvar o JSON como');
    console.log(`   ${c} e rodar:  node autorizar-google-notas.js`);
    console.log('\n   ATENCAO: conferir o publishing status da tela de consentimento. Em "Testing"');
    console.log('   o refresh token expira em 7 dias e a rotina para em silencio.');
  }
}

(async () => {
  console.log(`Sondagem da rotina de notas de reuniao — deal ${dealId}, fuso ${TZ_ESCRITORIO}`);
  console.log('SO LEITURA: nada e escrito no Moskit, no Google nem no banco.');

  if (!process.env.MOSKIT_API_KEY) {
    console.error('\n❌ MOSKIT_API_KEY ausente no .env — sem ela nada aqui funciona.');
    process.exit(1);
  }

  try {
    await sondarNotasDoDeal();
  } catch (e) {
    console.error(`\n❌ Falha ao sondar /notes: ${e.message}`);
  }

  try {
    await sondarAnexosDoEvento();
  } catch (e) {
    console.error(`\n❌ Falha ao sondar a agenda: ${e.message}`);
    if (String(e.message).includes('invalid_grant')) {
      console.error('   invalid_grant = o token do bot expirou/foi revogado. Rodar autorizar-google.js.');
    }
  }

  sondarCredencialNotas();
  console.log('');
})();
