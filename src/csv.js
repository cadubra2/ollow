// Escrita de CSV: UMA implementacao, porque havia TRES copias do mesmo escape espalhadas pelos
// scripts de estudo — e uma delas estava errada.
//
// O bug que motivou o modulo (estudar-deals-sem-origem.js:210-215, antes desta extracao): a linha
// era montada com `JSON.stringify(nome)` para alguns campos e o valor CRU para outros, tudo junto num
// `.join(',')`. Dois defeitos numa linha:
//   1. JSON.stringify escapa aspas como \" — em CSV o escape e "" (aspas dobradas). Nome com aspas
//      saia deslocando todas as colunas seguintes.
//   2. Os campos crus (status, motivo, causa) nao eram citados. `causa` chega a conter virgula e
//      parentese; qualquer virgula ali quebrava a coluna em duas, em silencio.
// O resultado era uma planilha que ABRIA sem erro e mostrava dado na coluna errada, que e a pior
// forma de errar num relatorio: nao parece defeito.
//
// Regra unica aqui: TODO campo sai citado, sempre. Custa alguns bytes e elimina a classe inteira de
// bug — virgula, aspas, quebra de linha (o resumo de atendimento tem varias) e ponto-e-virgula
// deixam de ser casos especiais.

// BOM de UTF-8. O consumidor destes arquivos e o dono do escritorio abrindo no Excel, e o Excel
// do Windows le CSV sem BOM como ANSI: "José" vira "JosÃ©" em toda a planilha. Quem for parsear em
// codigo passa `bom: false`.
const BOM = '﻿';

function escaparCampo(valor) {
  if (valor === null || valor === undefined) return '""';
  // Boolean vira "true"/"false" e numero vira o proprio texto — o Excel interpreta os dois sem
  // ajuda, e um `Sim`/`Nao` traduzido aqui esconderia a diferenca entre `false` e "campo vazio".
  return `"${String(valor).replace(/"/g, '""')}"`;
}

// `linhas` e uma lista de objetos; o cabecalho sai das chaves do primeiro, ou de `cabecalho` quando
// dado (util para fixar a ordem das colunas, ou para emitir um CSV so com cabecalho quando a lista
// esta vazia — planilha vazia com coluna certa e melhor que arquivo ausente).
function montarCsv(linhas, cabecalho) {
  const colunas = cabecalho || (linhas.length ? Object.keys(linhas[0]) : []);
  const corpo = linhas.map((l) => colunas.map((c) => escaparCampo(l[c])).join(','));
  // \r\n: o CSV vai para o Excel no Windows, e ele e o unico consumidor que se incomoda com \n solto
  // dentro de campo citado em algumas versoes.
  return [colunas.map(escaparCampo).join(','), ...corpo].join('\r\n');
}

function escreverCsv(caminho, linhas, { cabecalho = null, bom = true } = {}) {
  const fs = require('fs');
  const texto = montarCsv(linhas, cabecalho);
  fs.writeFileSync(caminho, (bom ? BOM : '') + texto, 'utf8');
  return { caminho, linhas: linhas.length, colunas: (cabecalho || (linhas.length ? Object.keys(linhas[0]) : [])).length };
}

module.exports = { escaparCampo, montarCsv, escreverCsv, BOM };
