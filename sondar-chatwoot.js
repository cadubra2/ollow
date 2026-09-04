// Mede, contra a instancia REAL do Chatwoot, os contratos que a sincronizacao de nomes assume.
// SO LEITURA. Rodar com:
//
//   node sondar-chatwoot.js
//   node sondar-chatwoot.js --contato=123   # inclui a sondagem do PUT num contato de TESTE
//
// Por que existe: sem isto, o resto e fe. Cinco coisas nao foram medidas nesta instancia, e cada uma
// delas erra em silencio:
//
//  1) `page=N` pagina de verdade? Neste repositorio o Moskit ignorou parametro de paginacao em
//     silencio TRES vezes (/deals, /activities, /contacts): o loop rele a primeira pagina, escreve 15
//     contatos e PARECE ter varrido 4 mil.
//  2) Em que formato o `phone_number` esta gravado? E o que decide se `filter equal_to` casa alguma
//     coisa — `equal_to` e comparacao de STRING, nao de telefone.
//  3) Quantas fichas tem nome vazio / nome que e o proprio numero / nome humano? E o tamanho real do
//     problema do dono, medido pelo lado do Chatwoot.
//  4) O `identifier` ja e usado por outra integracao? Se sim, nao podemos escrever nele.
//  5) O PUT MESCLA ou SUBSTITUI `custom_attributes`? Se substitui, mandar so a nossa chave apagaria
//     todo atributo personalizado que o escritorio ja tenha, em toda a base, sem erro nenhum.
//     Esta e a unica sondagem que ESCREVE, exige --contato=<id> explicito, e o contato tem de ser um
//     de TESTE criado a mao — nunca de cliente.
//
// A saida vai para o terminal e nada e gravado em disco: nomes e telefones de milhares de pessoas nao
// precisam virar arquivo para responder estas cinco perguntas.

const path = require('path');
require('dotenv').config();

// Protecoes antes do require do index.js: sem servidor, sem timers, banco descartavel (o require roda
// os ALTER TABLE — apontar para conversations.db seria mexer em producao) e sem Telegram.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `sondar-chatwoot-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const bot = require('./index');
const chatwootModulo = require('./src/chatwoot');

const arg = (nome) => {
  const a = process.argv.find((x) => x.startsWith(`${nome}=`));
  return a ? a.slice(nome.length + 1) : null;
};
const CONTATO_TESTE = arg('--contato');
const MAX_PAGINAS = Number(arg('--paginas')) || 6;

async function main() {
  if (!bot.chatwootConfigurado()) {
    console.error('❌ Chatwoot nao configurado. Defina no .env:');
    console.error('   CHATWOOT_BASE=https://sua-instancia   CHATWOOT_ACCOUNT_ID=1   CHATWOOT_API_TOKEN=...');
    console.error('   (o token sai de Perfil -> Access Token dentro do Chatwoot)');
    process.exit(1);
  }
  console.log(`\n🔎 Sondando ${process.env.CHATWOOT_BASE} (conta ${process.env.CHATWOOT_ACCOUNT_ID}) — SO LEITURA\n`);

  // ---------------------------------------------------------
  console.log('1) GET /contacts — paginacao, tamanho de pagina e rate limit');
  const paginas = [];
  const idsPorPagina = [];
  let totalRelatado = null;
  let headersRate = null;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const res = await bot.chatwootRequisicao('get', '/contacts', { params: { page: pagina } });
    if (res.status < 200 || res.status >= 300) {
      console.log(`   pagina ${pagina}: HTTP ${res.status} — parando`);
      break;
    }
    if (!headersRate) {
      headersRate = Object.keys(res.headers || {}).filter((h) => /ratelimit|retry-after/i.test(h));
    }
    const lista = res.data?.payload || [];
    if (res.data?.meta?.count != null) totalRelatado = res.data.meta.count;
    paginas.push(lista);
    idsPorPagina.push(new Set(lista.map((c) => c.id)));
    console.log(`   pagina ${pagina}: ${lista.length} contatos`);
    if (!lista.length) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`   total relatado em meta.count: ${totalRelatado ?? '(ausente)'}`);
  console.log(`   headers de rate limit: ${headersRate?.length ? headersRate.join(', ') : 'NENHUM (nao ha como respeitar cota — so pausa fixa)'}`);

  if (idsPorPagina.length >= 2) {
    const iguais = [...idsPorPagina[0]].every((id) => idsPorPagina[1].has(id)) && idsPorPagina[0].size === idsPorPagina[1].size;
    if (iguais) {
      console.log('   ⛔ PAGINACAO IGNORADA: a pagina 2 e identica a 1. `page` nao funciona nesta instancia —');
      console.log('      uma varredura relerira os mesmos contatos e PARECERA ter varrido tudo.');
    } else {
      console.log('   ✅ paginacao avanca (pagina 2 traz ids novos)');
    }
  }
  const tamanho = paginas[0]?.length || 0;
  if (tamanho && totalRelatado) {
    console.log(`   custo estimado de uma varredura completa: ~${Math.ceil(totalRelatado / tamanho)} requisicoes`);
    console.log(`   => CHATWOOT_MAX_PAGINAS precisa ser >= ${Math.ceil(totalRelatado / tamanho)}`);
  }

  // ---------------------------------------------------------
  console.log('\n2) Formato do phone_number, e 3) o tamanho do problema do dono');
  const todos = paginas.flat();
  const formatos = {};
  const classes = {};
  let semTelefone = 0;
  let comIdentifier = 0;
  const identifiersAlheios = [];

  for (const c of todos) {
    const tel = c.phone_number || '';
    if (!tel) semTelefone++;
    else {
      const forma = tel.startsWith('+') ? `+ com ${tel.replace(/\D/g, '').length} digitos` : `sem + com ${tel.replace(/\D/g, '').length} digitos`;
      formatos[forma] = (formatos[forma] || 0) + 1;
    }
    const cl = chatwootModulo.classificarNomeChatwoot(c.name, tel).classe;
    classes[cl] = (classes[cl] || 0) + 1;
    if (c.identifier) {
      comIdentifier++;
      if (!String(c.identifier).startsWith(chatwootModulo.PREFIXO_IDENTIFIER) && identifiersAlheios.length < 5) {
        identifiersAlheios.push(c.identifier);
      }
    }
  }

  console.log(`   amostra: ${todos.length} contatos`);
  console.log(`   sem telefone nenhum: ${semTelefone}`);
  for (const [f, n] of Object.entries(formatos).sort((a, b) => b[1] - a[1])) console.log(`   formato "${f}": ${n}`);
  console.log('   --- classificacao do NOME atual (e o que decide se o bot escreve) ---');
  for (const cl of ['vazio', 'telefone', 'generico', 'humano']) {
    const n = classes[cl] || 0;
    const marca = cl === 'humano' ? '(NUNCA sobrescrito)' : '(o bot preencheria)';
    console.log(`   ${cl.padEnd(9)}: ${String(n).padStart(4)}  ${marca}`);
  }
  const preencheria = (classes.vazio || 0) + (classes.telefone || 0) + (classes.generico || 0);
  console.log(`   => nesta amostra, ${preencheria} de ${todos.length} fichas ganhariam nome (se houver nome no Moskit)`);

  // ---------------------------------------------------------
  console.log('\n4) O campo identifier ja e usado?');
  console.log(`   fichas com identifier preenchido: ${comIdentifier} de ${todos.length}`);
  if (identifiersAlheios.length) {
    console.log(`   ⚠️ identifiers de OUTRA origem (o bot nao vai sobrescrever): ${identifiersAlheios.join(', ')}`);
  } else {
    console.log('   ✅ nenhum identifier de terceiro na amostra');
  }

  // ---------------------------------------------------------
  console.log('\n5) POST /contacts/filter casa o formato real?');
  const comTel = todos.find((c) => c.phone_number);
  if (!comTel) {
    console.log('   (nenhum contato com telefone na amostra — nao da para medir)');
  } else {
    const chave = chatwootModulo.digitosDe(comTel.phone_number).slice(-13);
    const e164 = chatwootModulo.normalizarE164(chave);
    const res = await bot.chatwootRequisicao('post', '/contacts/filter', {
      corpo: { payload: [{ attribute_key: 'phone_number', filter_operator: 'equal_to', values: [e164], query_operator: null }] },
    });
    const achou = (res.data?.payload || []).some((c) => c.id === comTel.id);
    console.log(`   contato ${comTel.id} tem phone_number "${comTel.phone_number}"`);
    console.log(`   buscando por "${e164}" -> HTTP ${res.status}, ${(res.data?.payload || []).length} resultado(s), acertou: ${achou ? 'SIM' : 'NAO'}`);
    if (!achou) {
      console.log('   ℹ️ o filter nao casa este formato — a cascata cai para /contacts/search pelo sufixo,');
      console.log('      que e justamente por isso que ela tem tres passos e nao um.');
    }
  }

  // ---------------------------------------------------------
  console.log('\n6) O PUT mescla ou SUBSTITUI custom_attributes? (a pergunta mais perigosa)');
  if (!CONTATO_TESTE) {
    console.log('   PULADO. Esta e a unica sondagem que escreve, e por isso exige um id explicito:');
    console.log('     node sondar-chatwoot.js --contato=<id de um contato de TESTE>');
    console.log('   Crie um contato de teste a mao no Chatwoot, com pelo menos um custom attribute');
    console.log('   preenchido, e passe o id dele. NUNCA um contato de cliente.');
    console.log('   Se o PUT substituir o objeto, mandar so a nossa chave apagaria todo atributo');
    console.log('   personalizado do escritorio, em toda a base, sem erro nenhum.');
  } else {
    const antes = await bot.chatwootRequisicao('get', `/contacts/${CONTATO_TESTE}`);
    const fichaAntes = antes.data?.payload || antes.data || {};
    const atributosAntes = fichaAntes.custom_attributes || {};
    console.log(`   contato ${CONTATO_TESTE} ("${fichaAntes.name}") tem custom_attributes: ${JSON.stringify(atributosAntes)}`);
    if (!Object.keys(atributosAntes).length) {
      console.log('   ⚠️ sem nenhum atributo preenchido nao da para medir substituicao. Preencha um');
      console.log('      atributo personalizado neste contato pela tela e rode de novo.');
    } else {
      const sonda = { __sonda_ollow: String(Date.now()) };
      const put = await bot.chatwootRequisicao('put', `/contacts/${CONTATO_TESTE}`, { corpo: { custom_attributes: sonda } });
      const veredito = chatwootModulo.interpretarRespostaPut(put.status, put.data);
      console.log(`   PUT com APENAS a chave da sonda -> HTTP ${put.status} (${veredito.classe})`);
      const depois = await bot.chatwootRequisicao('get', `/contacts/${CONTATO_TESTE}`);
      const atributosDepois = (depois.data?.payload || depois.data || {}).custom_attributes || {};
      console.log(`   custom_attributes depois: ${JSON.stringify(atributosDepois)}`);
      const preservou = Object.keys(atributosAntes).every((k) => k in atributosDepois);
      const sondaPersistiu = '__sonda_ollow' in atributosDepois;
      console.log(`   => o PUT ${preservou ? 'MESCLA (atributos antigos preservados)' : 'SUBSTITUI (atributos antigos APAGADOS)'}`);
      console.log(`   => a chave da sonda ${sondaPersistiu ? 'PERSISTIU' : 'FOI DESCARTADA — chave sem definicao em Settings -> Custom Attributes e ignorada em silencio'}`);
      if (!preservou) {
        console.log('   ✅ o codigo ja mescla (montarPayloadContato recebe atributosAtuais) — mas agora esta medido.');
        console.log('   ⚠️ RESTAURE a mao os atributos deste contato de teste.');
      }
      if (!sondaPersistiu) {
        console.log('   ⚠️ E ESTA e a prova de que os dois atributos precisam ser criados ANTES:');
        console.log(`      "${chatwootModulo.CF_CONTATO}" e "${chatwootModulo.CF_NEGOCIO}", escopo Contact.`);
      }
    }
  }

  console.log('\n✅ Sondagem concluida. Nada foi gravado em disco.');
  if (!CONTATO_TESTE) console.log('   (e nada foi escrito no Chatwoot)');
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
