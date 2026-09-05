// Anexa o PDF da transcricao do Gemini nos CLONES do funil de teste (nunca nos negocios reais).
//
// Por que precisa rodar NA VPS e nao na maquina de dev: o Moskit nao aceita upload — o corpo do POST
// e so uma url e QUEM BAIXA e o servidor dele. A unica URL publica que serve esses PDFs e a rota
// /arquivo-nota/:token/:nome do bot em producao, atras do tunel (PUBLIC_BASE_URL). Ela le o token da
// tabela notas_reuniao do banco de PRODUCAO — entao o token tem de estar la, e so o processo que
// roda ao lado do servidor consegue por.
//
// COMO ISSO NAO SUJA A MAQUINA DE ESTADOS DAS NOTAS: a linha inserida aqui usa
//   - gmail_message_id sintetico ("clone-teste-<dealClone>"), que nunca colide com id do Gmail;
//   - doc_id NULL, porque o indice unico de doc_id e PARCIAL (WHERE doc_id IS NOT NULL) e reusar o
//     doc_id real derrubaria o INSERT — e, pior, se passasse, criaria uma segunda linha disputando a
//     mesma transcricao com a linha verdadeira;
//   - estado = 'CLONE_TESTE', que nenhuma query da rotina casa (todas filtram 'CONCLUIDO' ou a lista
//     de estados nao-terminais), entao a rotina periodica nunca pega essa linha para reprocessar.
// E a linha e APAGADA no fim, junto com o PDF do disco e o token invalidado. O anexo fica no CRM.
//
//   node anexar-transcricao-nos-clones.js            (dry-run)
//   node anexar-transcricao-nos-clones.js --aplicar
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Database = require('better-sqlite3');
const { google } = require('googleapis');

const APLICAR = process.argv.includes('--aplicar');
const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json' };
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ESTAGIOS_TESTE = new Set([516685, 516686, 516687, 516688, 516689, 516690, 516691]);

// real -> clone. Escrito a mao de proposito: e a lista que autoriza a escrita, e ela precisa ser
// conferivel de olho antes de rodar. Um id de producao aqui por engano seria escrita em deal de
// cliente — por isso cada destino ainda e CONFERIDO no CRM antes do POST (ver checagem de estagio).
const PARES = [
  [48292471, 49452542],
  [48464876, 49452543],
  [48474073, 49452545],
  [48505590, 49452546],
  [48353647, 49452549],
  [48715544, 49452550],
  [49448577, 49452552],
].filter(([, clone]) => {
  const so = (process.argv.find((a) => a.startsWith('--clone=')) || '').split('=')[1];
  return !so || String(clone) === so;
});

function authNotas() {
  const c = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_JSON_NOTAS || './google-oauth-client-notas.json', 'utf-8'));
  const t = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_TOKEN_JSON_NOTAS || './google-oauth-token-notas.json', 'utf-8'));
  const conf = c.installed || c.web;
  const o = new google.auth.OAuth2(conf.client_id, conf.client_secret, (conf.redirect_uris || [])[0]);
  o.setCredentials(t);
  return o;
}

// Nome que o cliente do Moskit vai derivar da URL. Sem acento e sem espaco: o `:nome` viaja num path
// de URL, e nome nao-ASCII vira percent-encoding que o baixador pode devolver como filename ilegivel.
function nomeArquivo(titulo) {
  const base = String(titulo || 'transcricao')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return `${base || 'transcricao'}.pdf`;
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL vazia — o Moskit nao teria de onde baixar');
  const db = new Database('conversations.db');
  const auth = authNotas();
  const drive = google.drive({ version: 'v3', auth });

  console.log(`base publica: ${PUBLIC_BASE_URL}`);
  console.log(APLICAR ? '🚨 --aplicar: anexa de verdade nos clones\n' : '🔍 dry-run\n');

  for (const [real, clone] of PARES) {
    const nota = db.prepare('SELECT doc_id, assunto FROM notas_reuniao WHERE deal_id = ? AND estado = ?').get(real, 'CONCLUIDO');
    if (!nota?.doc_id) { console.log(`${real} -> sem doc_id na tabela; pulando`); continue; }

    // Trava de destino: so escreve em deal que esta MESMO num estagio do funil de teste. A lista
    // acima e escrita a mao, e uma trava que depende so de a lista estar certa nao e trava nenhuma.
    const alvo = (await axios.get(`${MOSKIT_BASE}/deals/${clone}`, { headers: apiHeaders, validateStatus: (s) => s < 500 })).data;
    if (!ESTAGIOS_TESTE.has(Number(alvo?.stage?.id))) {
      console.log(`❌ deal ${clone} NAO esta no funil de teste (estagio ${alvo?.stage?.id}) — recusando escrever`);
      continue;
    }

    const meta = await drive.files.get({ fileId: nota.doc_id, fields: 'id,name' });
    const nome = nomeArquivo(meta.data.name);
    console.log(`${real} -> ${clone} | ${nome}`);
    if (!APLICAR) { console.log('   (dry-run, nada exportado)'); continue; }

    const exp = await drive.files.export({ fileId: nota.doc_id, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
    const pdf = Buffer.from(exp.data);
    // O Drive responde 200 com corpo HTML em algumas falhas de permissao; um HTML salvo como .pdf
    // entra no CRM parecendo anexo legitimo. A assinatura e a unica conferencia que pega isso.
    if (pdf.slice(0, 5).toString() !== '%PDF-') { console.log(`   ❌ export nao e PDF (${pdf.length} bytes) — pulando`); continue; }

    const pasta = path.join(__dirname, 'notas-reuniao', `clone-${clone}`);
    fs.mkdirSync(pasta, { recursive: true });
    const caminho = path.join(pasta, nome);
    fs.writeFileSync(caminho, pdf);

    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const chave = `clone-teste-${clone}`;
    db.prepare(`
      INSERT OR REPLACE INTO notas_reuniao
        (gmail_message_id, doc_id, deal_id, estado, assunto, anexo_token, anexo_caminho, anexo_nome, anexo_estado, anexo_expira_em)
      VALUES (?, NULL, ?, 'CLONE_TESTE', ?, ?, ?, ?, 'ANEXADO', ?)
    `).run(chave, clone, `clone de teste do deal ${real}`, token, caminho, nome, expira);

    const url = `${PUBLIC_BASE_URL}/arquivo-nota/${token}/${nome}`;
    let st = 0; let anexoId = null;
    try {
      const post = await axios.post(`${MOSKIT_BASE}/deals/${clone}/attachments`, { url }, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      st = post.status; anexoId = post.data?.id || null;
    } catch (e) { st = e.response?.status || 0; }
    console.log(`   POST attachments -> ${st} (anexo ${anexoId}) · ${(pdf.length / 1024).toFixed(0)}KB`);

    // ESPERA a copia terminar antes de matar o token — medido em 04/09/2026 e nao e detalhe: o
    // Moskit baixa o arquivo MAIS DE UMA VEZ. Primeiro um `Java-http-client` (a validacao que
    // devolve 422 quando a URL nao responde), depois o `Uploadcare` que faz a copia de verdade, as
    // vezes segundos depois. Uma espera fixa curta deixa o POST responder 200, o log registrar
    // "anexo servido", e mesmo assim o anexo NAO aparecer — foi o que aconteceu com o deal 49452550
    // na primeira rodada: so o primeiro fetch chegou a tempo, o token morreu, e a aba Arquivos ficou
    // vazia sem erro nenhum. O sinal de pronto e o anexo aparecer na listagem do CRM.
    let guardado = null;
    for (let tent = 0; tent < 20 && !guardado; tent += 1) {
      await pausa(3000);
      const lista = (await axios.get(`${MOSKIT_BASE}/deals/${clone}/attachments`, { headers: apiHeaders, validateStatus: (s) => s < 500 })).data || [];
      guardado = lista.find((a) => a.id === anexoId) || lista.find((a) => Number(a.size) === pdf.length) || null;
    }
    if (!guardado) console.log('   ⚠️ o CRM nao listou o anexo dentro de 60s — token sera encerrado assim mesmo');
    else console.log(`   no CRM: ${guardado.filename} | ${guardado.size} bytes | ${guardado.mimeType} ${Number(guardado.size) === pdf.length ? '✅ bate' : '⚠️ NAO bate com o PDF enviado'}`);

    // Encerramento: token invalidado, PDF fora do disco, linha sintetica removida. A transcricao
    // deixa de estar servida na URL publica assim que o CRM confirmou a copia.
    db.prepare('DELETE FROM notas_reuniao WHERE gmail_message_id = ?').run(chave);
    try { fs.unlinkSync(caminho); fs.rmdirSync(pasta); } catch {}
    await pausa(700);
  }

  const sobrou = db.prepare("SELECT COUNT(*) c FROM notas_reuniao WHERE estado = 'CLONE_TESTE'").get().c;
  console.log(`\nlinhas sinteticas restantes na tabela: ${sobrou} (esperado 0)`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
