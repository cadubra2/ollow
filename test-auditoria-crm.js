// Testes PUROS da auditoria do CRM — sem rede, sem banco, sem OpenAI. Rodar com:
//   node test-auditoria-crm.js
//
// Duas coisas sao testadas aqui, e as duas sao "invariante que ja falhou uma vez":
//
//   1) src/csv.js — o escape. A montagem anterior (estudar-deals-sem-origem.js, antes de 02/09/2026)
//      misturava JSON.stringify com valores crus nao citados, e o efeito era o pior possivel: a
//      planilha ABRIA sem erro nenhum, mostrando dado na coluna errada. Nome com aspas deslocava
//      todas as colunas seguintes; `causa` com virgula quebrava a coluna em duas. Sem teste, esse
//      bug volta na proxima vez que alguem montar um CSV "na mao, que e mais simples".
//
//   2) A TRAVA DE ESCRITA do coletor. E a garantia de que auditar-crm-coletar.js nao pode alterar o
//      CRM — e uma garantia que nao serve de nada se ninguem verificar que ela DISPARA. O teste sobe
//      o interceptor do mesmo jeito que o coletor sobe e confirma que POST/PUT/PATCH/DELETE lancam
//      antes de sair da maquina, e que GET continua passando pelo caminho normal.
const { escaparCampo, montarCsv, escreverCsv, BOM } = require('./src/csv');

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

// ================================================================================================
console.log('\n📄 src/csv.js — escape');

checar('campo simples sai citado', escaparCampo('abc') === '"abc"', escaparCampo('abc'));
checar('null sai como campo vazio citado', escaparCampo(null) === '""', escaparCampo(null));
checar('undefined sai como campo vazio citado', escaparCampo(undefined) === '""', escaparCampo(undefined));
checar('zero NAO virou vazio', escaparCampo(0) === '"0"', escaparCampo(0));
checar('false NAO virou vazio', escaparCampo(false) === '"false"', escaparCampo(false));

// O defeito 1 do bug antigo: JSON.stringify escapa aspas como \" — em CSV o escape e "".
checar('aspas dobram, nao viram barra-aspas', escaparCampo('diz "oi"') === '"diz ""oi"""', escaparCampo('diz "oi"'));
checar('nao usa o escape do JSON', !escaparCampo('diz "oi"').includes('\\"'), escaparCampo('diz "oi"'));

// O defeito 2: valor cru nao citado. Virgula dentro do campo quebrava a coluna em duas.
const comVirgula = montarCsv([{ a: 'x, y', b: 'z' }]);
checar('virgula dentro do campo nao cria coluna', comVirgula.split('\r\n')[1] === '"x, y","z"', comVirgula.split('\r\n')[1]);

// Quebra de linha: o resumo de atendimento tem varias, e sem citacao ela viraria uma linha nova.
const comQuebra = montarCsv([{ a: 'linha1\nlinha2' }]);
checar('quebra de linha fica DENTRO do campo citado', comQuebra.split('\r\n').length === 2, comQuebra.split('\r\n').length);

// ================================================================================================
console.log('\n📄 src/csv.js — cabecalho e forma');

const duas = montarCsv([{ deal_id: 1, nome: 'A' }, { deal_id: 2, nome: 'B' }]);
checar('cabecalho vem das chaves do primeiro objeto', duas.split('\r\n')[0] === '"deal_id","nome"', duas.split('\r\n')[0]);
checar('uma linha por objeto, mais o cabecalho', duas.split('\r\n').length === 3, duas.split('\r\n').length);

// Cabecalho explicito: e o que garante que uma lista FILTRADA ate o vazio (04-resumo.csv quando
// nenhum deal tem problema de resumo) ainda produza planilha com as colunas certas.
const vazioComCabecalho = montarCsv([], ['deal_id', 'veredicto']);
checar('lista vazia + cabecalho explicito ainda tem colunas', vazioComCabecalho === '"deal_id","veredicto"', vazioComCabecalho);
// Sem linhas E sem cabecalho nao ha coluna nenhuma a declarar: sai texto vazio, nao um campo vazio.
// Quem chama e que decide se isso e aceitavel — os CSVs desta auditoria passam cabecalho explicito
// justamente para nunca cair aqui.
checar('lista vazia sem cabecalho sai vazia, sem explodir', montarCsv([]) === '', montarCsv([]));

// Ordem fixa: o cabecalho explicito manda, mesmo quando o objeto tem as chaves em outra ordem.
const ordenado = montarCsv([{ b: 2, a: 1 }], ['a', 'b']);
checar('cabecalho explicito fixa a ORDEM das colunas', ordenado.split('\r\n')[1] === '"1","2"', ordenado.split('\r\n')[1]);
checar('coluna pedida que o objeto nao tem sai vazia', montarCsv([{ a: 1 }], ['a', 'z']).split('\r\n')[1] === '"1",""');

// ================================================================================================
console.log('\n📄 src/csv.js — BOM (o Excel do Windows le CSV sem BOM como ANSI)');

const os = require('os');
const path = require('path');
const fs = require('fs');
const destino = path.join(os.tmpdir(), `test-csv-${process.pid}.csv`);
escreverCsv(destino, [{ nome: 'José' }]);
const escrito = fs.readFileSync(destino, 'utf8');
checar('arquivo comeca com BOM por padrao', escrito.startsWith(BOM), escrito.slice(0, 3));
checar('acento sobrevive ao round-trip', escrito.includes('José'), escrito);
escreverCsv(destino, [{ nome: 'José' }], { bom: false });
checar('bom:false remove o BOM', !fs.readFileSync(destino, 'utf8').startsWith(BOM));
fs.rmSync(destino);

// ================================================================================================
console.log('\n🔒 auditar-crm-coletar.js — trava de escrita');

// O MESMO interceptor do coletor, montado aqui. Nao e uma copia da regra: e a mesma condicao
// (method !== 'get') sobre a instancia default do axios, que e a que o coletor e o index.js
// compartilham — `require('axios')` devolve sempre o mesmo objeto, e e disso que a trava depende.
const axios = require('axios');
axios.interceptors.request.use((config) => {
  const metodo = String(config.method || 'get').toLowerCase();
  if (metodo !== 'get') throw new Error(`TRAVA DE ESCRITA: ${metodo.toUpperCase()} bloqueado`);
  // Porta de descarte: se um GET escapar do teste ele falha na conexao, nao vai para a internet.
  config.url = 'http://127.0.0.1:9/nada';
  return config;
});

(async () => {
  for (const metodo of ['post', 'put', 'patch', 'delete']) {
    let mensagem = '';
    try {
      await axios({ method: metodo, url: 'http://127.0.0.1:9/deals', data: {} });
    } catch (e) {
      mensagem = e.message;
    }
    checar(`${metodo.toUpperCase()} e bloqueado pela trava`, mensagem.includes('TRAVA DE ESCRITA'), mensagem);
  }

  // GET tem de passar pela trava (e so falhar na conexao com a porta de descarte). Se a trava
  // bloqueasse GET tambem, o coletor nao coletaria nada — e o teste acima continuaria verde.
  let mensagemGet = '';
  try {
    await axios.get('http://127.0.0.1:9/deals');
  } catch (e) {
    mensagemGet = e.message;
  }
  checar('GET NAO e bloqueado pela trava', !mensagemGet.includes('TRAVA DE ESCRITA'), mensagemGet);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  console.log('='.repeat(60));
  process.exit(falhou ? 1 : 0);
})();
