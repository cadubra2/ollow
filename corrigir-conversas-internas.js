// Marca as conversas de numeros internos que ja estao no banco, para que nenhum caminho futuro
// (stmtGetPending no boot, /backfill-deals, polling) volte a processa-las como lead.
//
//   node corrigir-conversas-internas.js            # dry-run: so relata
//   node corrigir-conversas-internas.js --aplicar  # grava (faz backup antes)
//
// Nao apaga conversa nem mexe no Moskit. Deals ja criados para numeros internos sao apenas
// LISTADOS — remover negocio de um CRM de producao e decisao humana.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { ehInterno, TEAM_SUFIXOS } = require('./src/telefone');

const APLICAR = process.argv.includes('--aplicar');
const DB_PATH = path.join(__dirname, 'conversations.db');

function main() {
  if (!TEAM_SUFIXOS.size) {
    console.error('❌ TEAM_PHONES vazio no .env — nada a fazer. Configure a lista primeiro.');
    process.exit(1);
  }
  if (APLICAR) {
    const destino = path.join(__dirname, `conversations.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.copyFileSync(DB_PATH, destino);
    console.log(`💾 Backup: ${destino}\n`);
  }

  const db = new Database(DB_PATH, { readonly: !APLICAR });
  const internas = db.prepare('SELECT chat_id, contact_name, deal_id, last_action, processed FROM conversations').all()
    .filter((r) => ehInterno(r.chat_id) || ehInterno(r.phone));

  console.log(`${APLICAR ? '✅ APLICADO' : '🔍 DRY-RUN (nada gravado)'}\n`);
  console.log(`Numeros internos configurados: ${TEAM_SUFIXOS.size}`);
  console.log(`Conversas internas no banco:   ${internas.length}\n`);

  if (internas.length) console.table(internas);

  const comDeal = internas.filter((r) => r.deal_id);
  if (comDeal.length) {
    console.log('\n⚠️  DEALS criados para numeros internos — resolver no Moskit MANUALMENTE:');
    for (const r of comDeal) console.log(`     deal ${r.deal_id}  ·  ${r.contact_name}  ·  ${r.chat_id}`);
    console.log('     (o script nao apaga negocio: e escrita destrutiva num CRM de producao)');
  } else {
    console.log('\nNenhum deal de numero interno no banco.');
  }

  if (APLICAR) {
    const upd = db.prepare("UPDATE conversations SET processed = 1, last_action = 'interno' WHERE chat_id = ?");
    let n = 0;
    for (const r of internas) {
      if (r.processed === 1 && r.last_action === 'interno') continue;
      upd.run(r.chat_id);
      n++;
    }
    console.log(`\n${n} conversas marcadas como 'interno' (processed = 1).`);
  } else if (internas.length) {
    console.log('\nPara aplicar: node corrigir-conversas-internas.js --aplicar');
  }

  db.close();
}

main();
