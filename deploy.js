// Executado como processo filho DESACOPLADO (detached) pela rota POST /deploy-webhook em
// index.js, a cada push no branch de deploy. Faz git pull -> npm install -> npm test e SO
// reinicia o pm2 se as tres etapas passarem — se qualquer uma falhar, a versao antiga continua
// no ar e o erro fica em deploy.log (+ Telegram, se configurado). Nunca sobe codigo quebrado
// sem ninguem notar.
//
// Roda desacoplado do index.js de proposito: o `pm2 restart` que ele dispara no final mata e
// reinicia o PROPRIO processo que o gerou, entao este script nao pode depender do pai estar
// vivo pra terminar (log, notificar, liberar o lock).

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = require('./src/fila').TEMP_DIR;
const DEPLOY_LOCK_FILE = path.join(TEMP_DIR, 'deploy.lock');
const LOG_FILE = path.join(__dirname, 'deploy.log');
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'apiollow-bot';

function log(linha) {
  const texto = `[${new Date().toISOString()}] ${linha}`;
  console.log(texto);
  try { fs.appendFileSync(LOG_FILE, texto + '\n'); } catch {}
}

async function notificarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const axios = require('axios');
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: 'Markdown',
    }, { timeout: 10000 });
  } catch (e) {
    log(`  ⚠️ falha ao notificar Telegram: ${e.message}`);
  }
}

function rodar(cmd) {
  log(`$ ${cmd}`);
  const saida = execSync(cmd, { cwd: __dirname, encoding: 'utf8', stdio: 'pipe' });
  if (saida && saida.trim()) log(saida.trim());
  return saida;
}

function liberarLock() {
  try { fs.unlinkSync(DEPLOY_LOCK_FILE); } catch {}
}

// `git pull --ff-only` recusa mesclar quando ha "mudanca local" no arquivo que o pull tocaria —
// mas isso tambem dispara quando a UNICA diferenca e quebra de linha (CRLF vs LF), introduzida por
// alguem editando um arquivo direto na VPS fora do git (aconteceu em 11/08/2026: index.js/README.md/
// .env.example ficaram com CRLF e travaram todo deploy seguinte, exigindo intervencao manual via
// SSH). `.gitattributes` (eol=lf) evita que isso volte a acontecer por qualquer operacao do PROPRIO
// git, mas nao impede um editor externo de reescrever o arquivo em disco — por isso esta rede de
// seguranca aqui: se o pull falhar E a diferenca de TODOS os arquivos citados no erro for zero
// ignorando espaco/quebra de linha, descarta so esses arquivos e tenta mais uma vez. Qualquer
// arquivo com diferenca de CONTEUDO real cancela a auto-recuperacao inteira — nunca descarta
// trabalho de verdade.
function arquivosSoComDiferencaDeQuebraDeLinha(mensagemErro) {
  const bloco = /would be overwritten by merge:\n((?:\t.+\n?)+)/.exec(String(mensagemErro || ''));
  if (!bloco) return [];
  const arquivos = bloco[1].split('\n').map((l) => l.replace(/^\t/, '').trim()).filter(Boolean);
  if (!arquivos.length) return [];
  for (const arquivo of arquivos) {
    try {
      execSync(`git diff --ignore-space-at-eol --quiet -- "${arquivo}"`, { cwd: __dirname, stdio: 'pipe' });
      // exit 0 = nao ha diferenca real (so quebra de linha) — segue conferindo os demais
    } catch {
      return []; // pelo menos um arquivo tem diferenca de conteudo de verdade — nao arrisca nada
    }
  }
  return arquivos;
}

function pullComRecuperacaoDeQuebraDeLinha() {
  try {
    rodar('git pull --ff-only');
  } catch (e) {
    const detalhe = String(e.stdout || e.stderr || e.message || e);
    const arquivos = arquivosSoComDiferencaDeQuebraDeLinha(detalhe);
    if (!arquivos.length) throw e; // conflito de verdade — sobe pro catch normal, aborta o deploy
    log(`  🩹 pull travou so por quebra de linha (CRLF/LF) em: ${arquivos.join(', ')} — resetando (sem perda de conteudo) e tentando de novo`);
    for (const arquivo of arquivos) rodar(`git checkout -- "${arquivo}"`);
    rodar('git pull --ff-only'); // uma unica retentativa; se falhar de novo, e um problema diferente
  }
}

async function main() {
  log('🚀 Deploy iniciado');
  try {
    pullComRecuperacaoDeQuebraDeLinha();
    rodar('npm install');
    rodar('npm test');
  } catch (e) {
    const detalhe = e.stdout || e.stderr || e.message || String(e);
    log(`❌ Deploy ABORTADO — versao antiga continua no ar.\n${detalhe}`);
    await notificarTelegram(`❌ *Deploy falhou* — versao antiga continua no ar.\n\`\`\`\n${String(detalhe).slice(0, 500)}\n\`\`\``);
    liberarLock();
    process.exit(1);
  }

  log(`✅ Pull + install + testes OK — reiniciando pm2 (${PM2_APP_NAME})`);
  try {
    rodar(`pm2 restart ${PM2_APP_NAME}`);
  } catch (e) {
    const detalhe = e.stdout || e.stderr || e.message || String(e);
    log(`⚠️ pm2 restart falhou (pm2 esta instalado e o app registrado com esse nome?): ${detalhe}`);
    await notificarTelegram(`⚠️ Deploy aplicado mas \`pm2 restart ${PM2_APP_NAME}\` falhou — reinicie manualmente.`);
    liberarLock();
    process.exit(1);
  }

  await notificarTelegram('✅ *Deploy aplicado com sucesso* — bot reiniciado com a versao mais recente.');
  log('🏁 Deploy concluido');
  liberarLock();
}

main();
