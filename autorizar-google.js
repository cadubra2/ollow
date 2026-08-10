// Script de autorizacao unica do Google Calendar (OAuth2, conta real do escritorio).
// Rodar uma vez: node autorizar-google.js
// Abre uma URL pra voce logar no navegador com a conta do escritorio (ex: escritoriocr2019@gmail.com)
// e salva o token em google-oauth-token.json.

const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const PORT = 8091;
const REDIRECT_URI = `http://localhost:${PORT}`;

const { client_id, client_secret } = JSON.parse(fs.readFileSync('./google-oauth-client.json', 'utf8')).installed;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\nAbra esta URL no seu navegador e faca login com a conta do escritorio:\n');
console.log(authUrl);
console.log('\nAguardando voce autorizar...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/?code=') && !req.url.includes('code=')) {
    res.end('Aguardando...');
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Codigo nao encontrado na URL. Feche e tente de novo.');
    return;
  }
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync('./google-oauth-token.json', JSON.stringify(tokens, null, 2));
    res.end('Autorizado com sucesso! Pode fechar esta aba e voltar pro terminal.');
    console.log('✅ Token salvo em google-oauth-token.json');
    server.close();
    process.exit(0);
  } catch (e) {
    res.end('Erro ao trocar o codigo pelo token: ' + e.message);
    console.error('❌ Erro:', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`(servidor local aguardando o redirecionamento em http://localhost:${PORT})`);
});
