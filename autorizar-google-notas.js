// Autorizacao unica do Gmail + Drive para a rotina de notas de reuniao (Gemini -> Moskit).
// Rodar uma vez: node autorizar-google-notas.js
//
// POR QUE NAO REAPROVEITAR O TOKEN DO BOT:
// google-oauth-token.json tem escopo APENAS de Calendar e e o que faz a agenda funcionar em
// producao. Somar escopos de Gmail/Drive aquele consentimento significaria refaze-lo, e um
// consentimento refeito pode invalidar o refresh token em uso — derrubando o agendamento de
// consultas para consertar uma funcionalidade nova. Um cliente OAuth proprio e um token proprio
// custam cinco minutos de configuracao e tornam esse risco zero.
//
// ANTES DE RODAR:
//   1. No Google Cloud (projeto persuasive-ego-503412-s7), habilitar Gmail API e Drive API.
//   2. Criar um cliente OAuth do tipo "Desktop app" e salvar o JSON como
//      google-oauth-client-notas.json na raiz do projeto.
//   3. CONFERIR o publishing status da tela de consentimento. Em "Testing" o refresh token expira
//      em 7 DIAS e a rotina para em silencio uma semana depois do deploy — que e a pior forma de
//      falhar, porque "nenhuma nota nova" e indistinguivel de "nenhuma reuniao nova".
//
// Roda na porta 8092. A 8091 e do autorizar-google.js (Calendar) — se as duas rodassem na mesma
// porta, autorizar uma derrubaria a outra pela metade.

const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const PORT = 8092;
const REDIRECT_URI = `http://localhost:${PORT}`;

const CLIENT_PATH = process.env.GOOGLE_OAUTH_CLIENT_NOTAS_JSON || './google-oauth-client-notas.json';
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN_NOTAS_JSON || './google-oauth-token-notas.json';

// gmail.modify cobre ler, rotular e marcar como lido — nao e preciso somar gmail.readonly.
// drive.readonly (e nao drive.file) porque o Doc das notas e criado pelo Gemini, nao por este app:
// drive.file so alcanca arquivos que o proprio app criou, e nao serviria para exportar as notas.
const ESCOPOS = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

if (!fs.existsSync(CLIENT_PATH)) {
  console.error(`\n❌ Falta ${CLIENT_PATH}.`);
  console.error('   Crie um cliente OAuth do tipo "Desktop app" no projeto persuasive-ego-503412-s7');
  console.error('   e salve o JSON baixado com esse nome. Veja o cabecalho deste arquivo.\n');
  process.exit(1);
}

const arquivo = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8'));
const credenciais = arquivo.installed || arquivo.web;
if (!credenciais?.client_id) {
  console.error(`\n❌ ${CLIENT_PATH} nao tem a chave "installed" (nem "web"). Baixe o JSON do cliente`);
  console.error('   OAuth do tipo Desktop app — nao a chave de API nem a conta de servico.\n');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(credenciais.client_id, credenciais.client_secret, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forca o refresh_token a vir mesmo se ja houve consentimento antes
  scope: ESCOPOS,
});

console.log('\nAbra esta URL no navegador e faca login com a conta do escritorio');
console.log('(escritoriocr2019@gmail.com — a caixa que RECEBE as notas do Gemini):\n');
console.log(authUrl);
console.log('\nAguardando voce autorizar...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.includes('code=')) {
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

    // Sem refresh_token o token morre em ~1h e a rotina para logo depois do primeiro ciclo. Melhor
    // falhar aqui, ruidosamente, do que descobrir isso em producao amanha.
    if (!tokens.refresh_token) {
      res.end('Autorizado, MAS sem refresh_token. Veja o terminal.');
      console.error('\n❌ O Google nao devolveu refresh_token.');
      console.error('   Revogue o acesso deste app em https://myaccount.google.com/permissions');
      console.error('   e rode de novo. Sem ele o acesso expira em cerca de uma hora.\n');
      server.close();
      process.exit(1);
    }

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.end('Autorizado com sucesso! Pode fechar esta aba e voltar pro terminal.');
    console.log(`✅ Token salvo em ${TOKEN_PATH}`);
    console.log(`   Escopos: ${tokens.scope || ESCOPOS.join(' ')}`);
    console.log('\n   Confira agora com: node sondar-notas.js\n');
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
  console.log(`(servidor local aguardando o redirecionamento em ${REDIRECT_URI})`);
});
