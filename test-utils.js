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

// Fixa os 7 MOSKIT_STAGE_* do processo de teste nos IDs canonicos de src/moskit-ids.js.
//
// POR QUE ISTO EXISTE (medido em 04/09/2026, no deploy que apontou o bot para outro funil): as
// assercoes de estagio dos testes tem o ID escrito a mao (`stage: { id: 179388 }` como "ainda em
// agendamento", `285584` como "ja avancou"), e MOSKIT_STAGE_MAP aceita override por env var. Sem
// fixar nada, a suite lia o .env de QUEM RODA: verde na maquina de dev (que apontava para o funil
// principal) e VERMELHA na VPS no instante em que o .env de producao passou a apontar para outro
// funil — porque `285584` deixou de existir no mapa e a guarda de "deal ja avancado" nunca acionava.
// O teste falhava sem que uma linha de codigo de producao estivesse errada, e — pior — o `npm test`
// do deploy.js e o portao do deploy: isso ia travar todo deploy futuro do bot.
//
// `delete process.env.X` NAO serviria: o `require('dotenv').config()` do index.js preencheria a
// chave apagada a partir do .env. Tem de ser atribuicao explicita, e antes do require do index.js.
function fixarEstagiosDeTeste() {
  const { STAGE } = require('./src/moskit-ids');
  process.env.MOSKIT_STAGE_ID = String(STAGE.agendamento);
  process.env.MOSKIT_STAGE_CONSULTA_AGENDADA = String(STAGE.consulta_agendada);
  process.env.MOSKIT_STAGE_AGUARDANDO_CONDICAO = String(STAGE.aguardando_condicao);
  process.env.MOSKIT_STAGE_ELABORACAO_PROPOSTA = String(STAGE.elaboracao_proposta);
  process.env.MOSKIT_STAGE_NEGOCIACAO = String(STAGE.negociacao);
  process.env.MOSKIT_STAGE_ELABORACAO_CONTRATO = String(STAGE.elaboracao_contrato);
  process.env.MOSKIT_STAGE_CONTRATO_ENVIADO = String(STAGE.contrato_enviado);
}

module.exports = { dirTemporario, RAIZ, fixarEstagiosDeTeste };
