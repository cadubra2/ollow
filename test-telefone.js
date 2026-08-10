// Testes PUROS de src/telefone.js — sem rede, sem banco, sem OpenAI. Rodar com:
//   node test-telefone.js
//
// Este e o modulo que corrige o bug relatado pelo dono: "a automacao esta criando deal com numeros
// de pessoas internas". A lista antiga tinha 5 dos 12 numeros e comparava por igualdade EXATA de
// string, entao o mesmo interno escrito com/sem nono digito ou DDI furava o bloqueio.
//
// TEAM_SUFIXOS e congelado no momento do require, por isso o arquivo tem duas secoes:
//   1) sintetica — TEAM_PHONES inventado, definido ANTES do require. Deterministica.
//   2) lista real — via carregarInternos(), com os casos DERIVADOS da propria lista. Nunca imprime
//      telefone de ninguem: so contagens e booleanos.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Precisa vir antes do require de src/telefone.js.
const INTERNO_A = '5586988887777'; // sufixo 88887777
const INTERNO_B = '5586977776666'; // sufixo 77776666
process.env.TEAM_PHONES = `${INTERNO_A},${INTERNO_B}`;

const {
  chaveConversa,
  mesmoTelefone,
  ehInterno,
  carregarInternos,
  TEAM_SUFIXOS,
  MIN_DIGITOS,
  MAX_DIGITOS,
  SUFIXO_COMPARACAO,
} = require('./src/telefone');

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

const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

// ============================================================
console.log('\n=== chaveConversa ===');

igual('13 digitos passam inteiros', chaveConversa('5586988887777'), '5586988887777');
igual('parenteses, espaco, hifen e + sao removidos', chaveConversa('+55 (86) 98888-7777'), '5586988887777');
igual('hifen e ponto como separadores', chaveConversa('55-86-98888.7777'), '5586988887777');
igual('11 digitos (sem DDI)', chaveConversa('86988887777'), '86988887777');
igual('10 digitos (sem nono)', chaveConversa('8688887777'), '8688887777');
igual(`exatamente MIN_DIGITOS (${MIN_DIGITOS}) e aceito`, chaveConversa('88887777'), '88887777');
igual('7 digitos e recusado', chaveConversa('8887777'), null);
igual(`17 digitos cortam nos ultimos ${MAX_DIGITOS}`, chaveConversa('00551186988887777'), '1186988887777');
igual('null', chaveConversa(null), null);
igual('undefined', chaveConversa(undefined), null);
igual('string vazia', chaveConversa(''), null);
igual('so espacos', chaveConversa('   '), null);
igual('id de grupo do Zernio (alfanumerico) nao vira telefone', chaveConversa('grupo-abc'), null);
igual('Number em vez de String (o polling passa nao-string)', chaveConversa(86988887777), '86988887777');
igual('zero (falsy) nao explode', chaveConversa(0), null);

// ============================================================
console.log('\n=== mesmoTelefone ===');

checar('com e sem DDI', mesmoTelefone('5586988887777', '86988887777'));
checar('com e sem nono digito', mesmoTelefone('5586988887777', '558688887777'));
checar('formatado vs cru', mesmoTelefone('+55 (86) 98888-7777', '5586988887777'));
checar('so o sufixo de 8 ja casa', mesmoTelefone('88887777', '5586988887777'));
checar('numeros diferentes nao casam', mesmoTelefone('5586988887777', '5586977776666') === false);
checar('null de um lado', mesmoTelefone(null, '5586988887777') === false);
checar('curto demais dos dois lados', mesmoTelefone('123', '123') === false);
// CARACTERIZACAO, nao defeito corrigido: a comparacao ignora o DDD. Um cliente de outro DDD cujo
// numero termine nos mesmos 8 digitos de um socio e bloqueado em silencio. Com 12 internos a chance
// e pequena, mas o modo de falha e mudo — fica registrado aqui.
checar('CARACTERIZACAO: DDDs diferentes com o mesmo sufixo de 8 casam', mesmoTelefone('86988887777', '1188887777'));

// ============================================================
console.log('\n=== carregarInternos (parser) ===');

igual('duas entradas separadas por virgula', carregarInternos(`${INTERNO_A},${INTERNO_B}`).size, 2);
igual('ponto-e-virgula', carregarInternos(`${INTERNO_A}; ${INTERNO_B}`).size, 2);
igual('quebra de linha', carregarInternos(`${INTERNO_A}\n${INTERNO_B}`).size, 2);
igual('separadores vazios sao descartados', carregarInternos(`${INTERNO_A},,  ,${INTERNO_B},`).size, 2);
igual('formatacao tolerada', carregarInternos('+55 (86) 98888-7777').size, 1);
igual('string vazia', carregarInternos('').size, 0);
igual('undefined', carregarInternos(undefined).size, 0);
igual('null', carregarInternos(null).size, 0);
igual('entrada curta demais some em silencio', carregarInternos(`123, ${INTERNO_A}`).size, 1);
igual('dois numeros com o mesmo sufixo colapsam em 1', carregarInternos(`${INTERNO_A},558688887777`).size, 1);
checar(
  `todo elemento tem ${SUFIXO_COMPARACAO} caracteres`,
  [...carregarInternos(`${INTERNO_A},${INTERNO_B}`)].every((s) => s.length === SUFIXO_COMPARACAO)
);
checar('guarda o sufixo, nao o numero inteiro', carregarInternos(INTERNO_A).has('88887777'));

// ============================================================
console.log('\n=== ehInterno (lista sintetica) ===');

checar('numero listado, forma canonica', ehInterno(INTERNO_A));
checar('sem DDI', ehInterno('86988887777'));
checar('sem nono digito', ehInterno('558688887777'));
checar('com parenteses e hifen', ehInterno('+55 (86) 98888-7777'));
checar('com zero na frente', ehInterno('088887777'));
checar('so os 8 digitos finais', ehInterno('88887777'));
checar('segundo numero da lista', ehInterno(INTERNO_B));
checar('numero NAO listado', ehInterno('5586911112222') === false);
checar('curto demais nao casa por acidente', ehInterno('8887777') === false);
checar('null', ehInterno(null) === false);
checar('undefined', ehInterno(undefined) === false);
checar('string vazia', ehInterno('') === false);
checar('id de grupo', ehInterno('grupo-abc') === false);

// ============================================================
console.log('\n=== ehInterno sem TEAM_PHONES (falha em ABERTO) ===');
// Sem a variavel, TEAM_SUFIXOS nasce vazio e os 5 guards do index.js somem de uma vez — sem log,
// sem erro. E o mesmo bug que o dono relatou, reintroduzido por um .env incompleto. O teste fixa o
// comportamento atual para que uma mudanca futura seja deliberada.
{
  const ambiente = { ...process.env };
  delete ambiente.TEAM_PHONES;
  const saida = execFileSync(
    process.execPath,
    ['-e', "const t=require('./src/telefone');console.log(JSON.stringify({n:t.TEAM_SUFIXOS.size,i:t.ehInterno('5586988887777')}))"],
    { cwd: __dirname, env: ambiente, encoding: 'utf8' }
  );
  const r = JSON.parse(saida.trim().split('\n').pop());
  igual('sem TEAM_PHONES, TEAM_SUFIXOS fica vazio', r.n, 0);
  igual('sem TEAM_PHONES, ehInterno devolve false para TODO numero', r.i, false);
}

// ============================================================
console.log('\n=== Lista REAL do .env ===');
// Le o .env direto: dotenv nao sobrescreveria a TEAM_PHONES sintetica que este processo ja definiu.
{
  const bruto = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  const linha = bruto.split(/\r?\n/).find((l) => l.trim().startsWith('TEAM_PHONES='));
  const valor = linha ? linha.slice(linha.indexOf('=') + 1).trim() : '';
  const numeros = valor.split(/[,;\s]+/).filter(Boolean);
  const sufixos = carregarInternos(valor);

  console.log(`  (${numeros.length} numeros no .env → ${sufixos.size} sufixos distintos)`);
  checar('TEAM_PHONES existe no .env', numeros.length > 0);
  checar('os 12 numeros da equipe estao configurados', numeros.length === 12, numeros.length);
  checar(
    'nenhum numero perdido por duplicata ou truncamento',
    sufixos.size === numeros.length,
    { numeros: numeros.length, sufixos: sufixos.size }
  );

  // Cada numero real precisa ser reconhecido nas 5 formas que a variacao brasileira produz. E
  // exatamente o que a igualdade exata antiga nao cobria.
  const dentro = (n) => sufixos.has(String(n).replace(/\D/g, '').slice(-13).slice(-SUFIXO_COMPARACAO));

  // A lista esta gravada com 12 digitos (55 + DDD + 8), ou seja, SEM o nono digito. A variacao que
  // interessa e a inversa: alguem escrever o mesmo numero COM o nono. Se a lista tivesse 13 digitos,
  // a variacao seria remove-lo. Cobre os dois sentidos.
  const semNono = (n) => (n.length === 13 && n[4] === '9' ? n.slice(0, 4) + n.slice(5) : null);
  const comNono = (n) => (n.length === 12 ? `${n.slice(0, 4)}9${n.slice(4)}` : null);

  const falhas = [];
  for (const n of numeros) {
    const variacoes = {
      'como esta no .env': n,
      'com + na frente': `+${n}`,
      'formatado com parenteses e hifen': `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, -4)}-${n.slice(-4)}`,
      'sem DDI': n.slice(2),
      'so os 8 finais': n.slice(-8),
      'nono digito alternado': semNono(n) || comNono(n),
    };
    for (const [rotulo, v] of Object.entries(variacoes)) {
      if (v && !dentro(v)) falhas.push(rotulo); // so o ROTULO — nunca o telefone
    }
  }
  checar('todo numero real e reconhecido em DDI/nono digito/formatacao', falhas.length === 0, falhas);

  // Contraprova: um numero que nao esta na lista NAO pode casar. Sem isso, um bug que fizesse
  // ehInterno devolver sempre true passaria em todos os testes acima.
  checar('numero de fora nao e confundido com interno', dentro('5511999990000') === false);
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
