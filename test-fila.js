// Testes de src/fila.js. Escreve APENAS num arquivo descartavel — QUEUE_FILE e apontado para o
// diretorio temporario antes do require, senao o teste sobrescreveria a fila real, que e
// compartilhada com o worker. Rodar com:
//   node test-fila.js
//
// O que esta fila protege: cada tentativa custa 2 chamadas a OpenAI com a conversa inteira. Antes do
// Lote 1 o pipeline engolia toda excecao, entao o catch do worker era inalcancavel e a conversa saia
// da fila em silencio — falha permanente e falha transitoria tinham o mesmo destino: o descarte.

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = dirTemporario('fila');
const ARQUIVO = path.join(DIR, 'fila.json');
process.env.QUEUE_FILE = ARQUIVO; // antes do require

const { lerFila, salvarFila, enfileirar, registrarFalha, removerComSucesso, MAX_TENTATIVAS, QUEUE_FILE } = require('./src/fila');

let passou = 0;
let falhou = 0;

function checar(nome, condicao, detalhe) {
  if (condicao) {
    passou++;
    console.log(`  ✅ ${nome}`);
  } else {
    falhou++;
    console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`);
  }
}

const igual = (nome, obtido, esperado) => checar(nome, JSON.stringify(obtido) === JSON.stringify(esperado), obtido);

function limpar() {
  try { fs.unlinkSync(ARQUIVO); } catch {}
}
// Grava conteudo cru, sem passar pela API — para testar o que a fila faz ao LER lixo.
const gravarCru = (texto) => fs.writeFileSync(ARQUIVO, texto);

// ============================================================
console.log('\n=== Isolamento ===');
checar('QUEUE_FILE respeita a variavel de ambiente', QUEUE_FILE === ARQUIVO, QUEUE_FILE);
checar('nao aponta para a fila real', !QUEUE_FILE.endsWith('process_queue.json'));

// ============================================================
console.log('\n=== lerFila / enfileirar ===');

limpar();
igual('fila inexistente le como vazia', lerFila(), []);

enfileirar('A');
igual('enfileirar cria o item com 0 tentativas', lerFila(), [{ chatId: 'A', tentativas: 0 }]);

enfileirar('A');
igual('enfileirar o mesmo chat duas vezes e idempotente', lerFila(), [{ chatId: 'A', tentativas: 0 }]);

enfileirar('B');
igual('segundo chat entra no fim', lerFila().map((i) => i.chatId), ['A', 'B']);

// Se reenfileirar zerasse o contador, um chat que falha e e reenfileirado a cada webhook nunca
// chegaria a MAX_TENTATIVAS — reprocessaria para sempre, 2 chamadas de OpenAI por vez.
limpar();
salvarFila([{ chatId: 'A', tentativas: 2 }]);
enfileirar('A');
igual('reenfileirar NAO zera o contador de tentativas', lerFila(), [{ chatId: 'A', tentativas: 2 }]);

// ============================================================
console.log('\n=== Fila em disco corrompida ou legada ===');

limpar();
gravarCru('["A","B"]');
igual('formato legado (string pura) continua valendo', lerFila(), [{ chatId: 'A', tentativas: 0 }, { chatId: 'B', tentativas: 0 }]);

gravarCru('{{{ isso nao e json');
igual('JSON invalido le como vazia, sem lancar', lerFila(), []);

gravarCru('{"a":1}');
igual('JSON valido mas nao-array le como vazia', lerFila(), []);

gravarCru('[]');
igual('array vazio', lerFila(), []);

gravarCru('[null, 42, {"semChatId":1}, "C", {"chatId":123}]');
igual('itens invalidos sao descartados, os validos sobrevivem', lerFila(), [{ chatId: 'C', tentativas: 0 }]);

gravarCru('[{"chatId":"A","tentativas":"2"}]');
igual('tentativas como string vira numero', lerFila(), [{ chatId: 'A', tentativas: 2 }]);

gravarCru('[{"chatId":"A","tentativas":"abc"}]');
igual('tentativas ilegivel vira 0', lerFila(), [{ chatId: 'A', tentativas: 0 }]);

// ============================================================
console.log('\n=== registrarFalha (o ciclo de desistencia) ===');

igual('MAX_TENTATIVAS', MAX_TENTATIVAS, 3);

limpar();
salvarFila([{ chatId: 'A', tentativas: 0 }]);
igual('1a falha → {1, nao desistiu}', registrarFalha('A'), { tentativas: 1, desistiu: false });
igual('   fila fica com tentativas=1', lerFila(), [{ chatId: 'A', tentativas: 1 }]);

igual('2a falha → {2, nao desistiu}', registrarFalha('A'), { tentativas: 2, desistiu: false });
igual('   fila fica com tentativas=2', lerFila(), [{ chatId: 'A', tentativas: 2 }]);

igual('3a falha → {3, DESISTIU}', registrarFalha('A'), { tentativas: 3, desistiu: true });
igual('   item sai da fila ao desistir', lerFila(), []);

// O worker pode ter pego o chat de um snapshot antigo e o item ja nao estar na fila. Descartar aqui
// seria o mesmo sumico silencioso de antes do Lote 1.
limpar();
igual('item AUSENTE da fila → {1, nao desistiu}', registrarFalha('Z'), { tentativas: 1, desistiu: false });
igual('   item ausente e RECOLOCADO, nao descartado', lerFila(), [{ chatId: 'Z', tentativas: 1 }]);

limpar();
salvarFila([{ chatId: 'A', tentativas: 0 }]);
registrarFalha('Z');
igual('falha de um chat nao mexe nos outros', lerFila(), [{ chatId: 'A', tentativas: 0 }, { chatId: 'Z', tentativas: 1 }]);

limpar();
salvarFila([{ chatId: 'A', tentativas: 0 }, { chatId: 'B', tentativas: 2 }]);
igual('desistencia de B → {3, true}', registrarFalha('B'), { tentativas: 3, desistiu: true });
igual('   so B sai; A fica intacto', lerFila(), [{ chatId: 'A', tentativas: 0 }]);

limpar();
const ciclo = [registrarFalha('Z'), registrarFalha('Z'), registrarFalha('Z')];
igual('ciclo completo a partir da fila vazia', ciclo, [
  { tentativas: 1, desistiu: false },
  { tentativas: 2, desistiu: false },
  { tentativas: 3, desistiu: true },
]);
igual('   fila vazia ao fim do ciclo', lerFila(), []);

// ============================================================
console.log('\n=== removerComSucesso ===');

limpar();
salvarFila([{ chatId: 'A', tentativas: 0 }, { chatId: 'B', tentativas: 1 }]);
removerComSucesso(['A']);
igual('remove so o informado', lerFila(), [{ chatId: 'B', tentativas: 1 }]);

removerComSucesso(['X']);
igual('id inexistente nao tem efeito', lerFila(), [{ chatId: 'B', tentativas: 1 }]);

removerComSucesso([]);
igual('lista vazia nao tem efeito', lerFila(), [{ chatId: 'B', tentativas: 1 }]);

salvarFila([{ chatId: 'A', tentativas: 0 }, { chatId: 'B', tentativas: 1 }]);
removerComSucesso(['A', 'B']);
igual('remove todos', lerFila(), []);

// ============================================================
console.log('\n=== Fila indisponivel nao derruba o processo ===');
// Sub-processo com QUEUE_FILE num caminho impossivel: salvarFila tem que devolver false, nao lancar.
// Se lancasse, uma pasta temporaria sem permissao derrubaria o servidor inteiro no enfileirar.
{
  const saida = execFileSync(
    process.execPath,
    ['-e', "const f=require('./src/fila');const ok=f.salvarFila([{chatId:'A',tentativas:0}]);console.log('RESULTADO:'+ok)"],
    {
      cwd: __dirname,
      env: { ...process.env, QUEUE_FILE: path.join(DIR, 'nao', 'existe', 'x.json') },
      encoding: 'utf8',
    }
  );
  checar('salvarFila em caminho impossivel devolve false sem lancar', saida.includes('RESULTADO:false'), saida.trim());
}

// ============================================================
// NAO testado de proposito: concorrencia. enfileirar/registrarFalha sao read-modify-write nao
// atomicos e servidor e worker escrevem o mesmo arquivo — uma escrita pode sobrescrever a outra.
// Um teste disso seria intermitente por natureza. Fica registrado como limitacao conhecida.


console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
