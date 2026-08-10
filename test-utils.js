// Diretorio temporario dos testes.
//
// Antes cada teste usava mkdtempSync e apagava no fim — mas no Windows o better-sqlite3 mantem o
// arquivo .db travado enquanto o processo vive (index.js nunca fecha a conexao dele), entao o rmSync
// falhava em silencio e cada rodada deixava uma pasta nova em %TEMP%.
//
// Agora o nome e FIXO por teste e a limpeza acontece na ENTRADA, quando nenhum processo segura mais o
// arquivo. Uma sobra nunca vira duas.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(os.tmpdir(), 'apiollow-testes');

function dirTemporario(nome) {
  const dir = path.join(RAIZ, nome);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { dirTemporario, RAIZ };
