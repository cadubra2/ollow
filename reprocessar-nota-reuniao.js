// Religa manualmente uma nota de reuniao que ficou ORFA (o bot nao descobriu a qual negocio ela
// pertence) ou que precisa ser reprocessada apontando para outro deal.
//
//   node reprocessar-nota-reuniao.js <gmailMessageId> <dealId>            # dry-run: so mostra a nota
//   node reprocessar-nota-reuniao.js <gmailMessageId> <dealId> --aplicar  # ESCREVE a nota no CRM
//
// O id da mensagem vem no aviso de orfao do Telegram. Sem --aplicar nada e escrito: o script imprime
// exatamente o texto que iria para o negocio, para conferencia antes.
//
// ESCREVE EM PRODUCAO com --aplicar. NUNCA rodar em CI nem no npm test.
//
// Por que o trabalho nao se perde num orfao: o e-mail nao e marcado como processado e o Doc continua
// acessivel, entao religar e so refazer o caminho com o dealId correto. A cascata roda de novo assim
// mesmo e o que ELA teria decidido fica gravado no diagnostico — se um humano precisou corrigir, e
// porque alguma regra falhou, e sem esse registro nao da para saber qual.

const { google } = require('googleapis');

const messageId = process.argv[2];
const dealId = process.argv[3];
const APLICAR = process.argv.includes('--aplicar');

if (!messageId || !/^\d+$/.test(String(dealId || ''))) {
  console.error('\nUso: node reprocessar-nota-reuniao.js <gmailMessageId> <dealId> [--aplicar]\n');
  process.exit(1);
}

// WORKER_MODE=1 carrega o index.js SEM subir servidor, sem ngrok e sem os setInterval — o mesmo
// truque que os testes de rota usam. Sem isso, este script deixaria um bot inteiro rodando em cima
// do que ja esta em producao.
process.env.WORKER_MODE = '1';
const bot = require('./index.js');

(async () => {
  const auth = bot.getGoogleAuthClientNotas();
  if (!auth) {
    console.error('❌ Credencial de Gmail/Drive ausente. Rodar: node autorizar-google-notas.js');
    process.exit(1);
  }

  const gmail = google.gmail({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });
  const calendar = google.calendar({ version: 'v3', auth });

  const dryRun = !APLICAR;
  console.log(`\nReligando a mensagem ${messageId} ao deal ${dealId}${dryRun ? ' [DRY-RUN — nada sera escrito]' : ' [APLICANDO]'}\n`);

  let mensagem;
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    mensagem = res.data;
  } catch (e) {
    console.error(`❌ Nao consegui ler a mensagem ${messageId}: ${e.message}`);
    process.exit(1);
  }

  try {
    const r = await bot.processarNotaReuniao({
      gmail,
      calendar,
      drive,
      mensagem,
      stmts: bot.stmtsNotas(dryRun),
      dryRun,
      dealIdForcado: dealId,
    });
    console.log(`\n${dryRun ? '🔎 Dry-run concluido' : '✅ Concluido'}: estado ${r.estado}, deal ${r.dealId || '(nenhum)'}`);
    if (dryRun) console.log('   Para escrever de verdade, repita o comando com --aplicar.\n');
    process.exit(0);
  } catch (e) {
    console.error(`\n❌ Falhou: ${e.message}`);
    process.exit(1);
  }
})();
