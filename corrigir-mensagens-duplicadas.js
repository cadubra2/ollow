// Limpeza unica das conversas ja contaminadas pela duplicacao de mensagens.
//
// A correcao em index.js/src/mensagens.js impede casos NOVOS. As conversas que ja estao no banco
// com texto repetido continuam sendo reenviadas inteiras a OpenAI a cada ciclo — este script
// remove as duplicatas e reordena por timestamp.
//
//   node corrigir-mensagens-duplicadas.js            # dry-run (padrao): so relata
//   node corrigir-mensagens-duplicadas.js --aplicar  # grava, apos fazer backup do .db
//
// Nao toca em Moskit, Google Calendar nem Telegram.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { normalizarMensagens, diagnosticar } = require('./src/mensagens');

const APLICAR = process.argv.includes('--aplicar');
const DB_PATH = path.join(__dirname, 'conversations.db');

function fazerBackup() {
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(__dirname, `conversations.backup-${carimbo}.db`);
  fs.copyFileSync(DB_PATH, destino);
  console.log(`💾 Backup: ${destino}\n`);
  return destino;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ ${DB_PATH} nao encontrado`);
    process.exit(1);
  }

  // O backup precisa acontecer ANTES de abrir pra escrita.
  if (APLICAR) fazerBackup();

  const db = new Database(DB_PATH, { readonly: !APLICAR });
  const linhas = db.prepare('SELECT chat_id, messages FROM conversations').all();

  const afetadas = [];
  let totalDuplicadas = 0;
  let totalReordenadas = 0;

  for (const linha of linhas) {
    let mensagens;
    try {
      mensagens = JSON.parse(linha.messages);
    } catch {
      console.log(`⚠️  ${linha.chat_id}: messages ilegivel — pulando`);
      continue;
    }
    if (!Array.isArray(mensagens) || mensagens.length === 0) continue;

    const antes = diagnosticar(mensagens);
    if (antes.duplicadas === 0 && antes.foraDeOrdem === 0) continue;

    const limpo = normalizarMensagens(mensagens);
    afetadas.push({
      chat_id: linha.chat_id,
      de: mensagens.length,
      para: limpo.length,
      removidas: antes.duplicadas,
      foraDeOrdem: antes.foraDeOrdem,
    });
    totalDuplicadas += antes.duplicadas;
    if (antes.foraDeOrdem > 0) totalReordenadas++;

    if (APLICAR) {
      db.prepare('UPDATE conversations SET messages = ? WHERE chat_id = ?')
        .run(JSON.stringify(limpo), linha.chat_id);
    }
  }

  console.log(`${APLICAR ? '✅ APLICADO' : '🔍 DRY-RUN (nada foi gravado)'}\n`);
  console.log(`Conversas analisadas: ${linhas.length}`);
  console.log(`Conversas afetadas:   ${afetadas.length}`);
  console.log(`Mensagens removidas:  ${totalDuplicadas}`);
  console.log(`Conversas reordenadas: ${totalReordenadas}\n`);

  afetadas.sort((a, b) => b.removidas - a.removidas);
  if (afetadas.length) {
    console.table(afetadas.slice(0, 20));
    if (afetadas.length > 20) console.log(`... e mais ${afetadas.length - 20} conversas\n`);
  }

  if (APLICAR) {
    // Reconfere lendo de novo: se sobrou duplicata, a normalizacao nao convergiu.
    const restante = db.prepare('SELECT chat_id, messages FROM conversations').all()
      .reduce((acc, l) => {
        try {
          const d = diagnosticar(JSON.parse(l.messages));
          return acc + d.duplicadas + d.foraDeOrdem;
        } catch { return acc; }
      }, 0);
    console.log(restante === 0
      ? '✅ Verificacao pos-limpeza: 0 duplicatas, 0 fora de ordem'
      : `❌ Verificacao pos-limpeza: ainda restam ${restante} ocorrencias — investigar`);
    process.exitCode = restante === 0 ? 0 : 1;
  } else if (afetadas.length) {
    console.log('Para aplicar: node corrigir-mensagens-duplicadas.js --aplicar');
  }

  db.close();
}

main();
