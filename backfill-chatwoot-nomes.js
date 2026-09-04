// Preenche de uma vez o nome dos contatos que JA existem no Chatwoot, a partir do Moskit.
// A rotina periodica (rodarSincronizacaoChatwoot) pega os novos; este script pega o acumulado.
//
//   node backfill-chatwoot-nomes.js                        # SO LEITURA: mede e escreve o CSV
//   node backfill-chatwoot-nomes.js --refrescar-espelho    # atualiza moskit_contacts antes de medir
//   node backfill-chatwoot-nomes.js --aplicar              # ESCREVE nas fichas do Chatwoot
//   node backfill-chatwoot-nomes.js --aplicar --limite=1 --so=558699999999   # um contato, de verdade
//
// RODE O sondar-chatwoot.js PRIMEIRO. Ele mede tres coisas que aqui erram em silencio: se a paginacao
// funciona, se os dois custom attributes existem (chave sem definicao no Chatwoot e DESCARTADA e o
// PUT responde sucesso igual) e se o PUT mescla ou substitui custom_attributes.
//
// ---------------------------------------------------------------------------------------------
// ATENCAO AO BANCO: diferente dos outros scripts manuais deste repo, este NAO usa DB_PATH
// descartavel. O estado da sincronizacao (nome_escrito, escrita_hash, travado_humano) vive em
// `chatwoot_contacts`, e e a memoria de "eu ja escrevi isto" e "alguem mexeu depois de mim" que a
// rotina periodica le depois. Gravar num banco temporario faria o backfill: (a) rescanear o Chatwoot
// inteiro a cada execucao, (b) ignorar as travas de renomeacao humana que a producao ja registrou, e
// (c) fazer a rotina refazer todo PUT no ciclo seguinte. Por isso o padrao e `conversations.db` — na
// VPS, o banco de producao, que e onde ele DEVE gravar. Use --db= para apontar outro.
// ---------------------------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const arg = (nome, padrao = null) => {
  const a = process.argv.find((x) => x.startsWith(`${nome}=`));
  return a ? a.slice(nome.length + 1) : padrao;
};
const temFlag = (nome) => process.argv.includes(nome);

const APLICAR = temFlag('--aplicar');
const REFRESCAR = temFlag('--refrescar-espelho');
const SEM_VARREDURA = temFlag('--sem-varredura');
const LIMITE = Number(arg('--limite')) || 100000;
const SO = arg('--so');
const BANCO = arg('--db', process.env.CONVERSATIONS_DB || 'conversations.db');

// Protecoes antes do require do index.js: sem servidor e sem os setInterval (WORKER_MODE), e sem
// Telegram — o backfill nao avisa ninguem, ele imprime e escreve o CSV.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = BANCO;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
// A flag mestra CHATWOOT_DRY_RUN guarda a ROTINA periodica. Aqui quem manda e o --aplicar explicito,
// entao ela e destravada apenas quando a flag foi passada na linha de comando. Sem --aplicar, forcada
// para dry-run mesmo que o .env diga o contrario: um backfill que escreve por engano nao tem desfazer.
process.env.CHATWOOT_DRY_RUN = APLICAR ? 'false' : 'true';
// CHATWOOT_ATIVO guarda o agendamento da rotina no boot, nao a funcao — mas deixar explicito evita
// que rodar o script com a feature desligada pareca ter funcionado por engano.
if (!process.env.CHATWOOT_ATIVO) process.env.CHATWOOT_ATIVO = 'true';

if (!fs.existsSync(BANCO)) {
  console.error(`❌ Banco nao encontrado em "${BANCO}".`);
  console.error('   Use --db=<caminho> ou CONVERSATIONS_DB= para apontar o banco certo.');
  console.error('   Na VPS o caminho e o conversations.db de producao — e e nele que este script deve gravar.');
  process.exit(1);
}

const bot = require('./index');
const chatwootModulo = require('./src/chatwoot');
const { escreverCsv } = require('./src/csv');

const COLUNAS = [
  'chave', 'resultado', 'chatwoot_id', 'via', 'classe_anterior',
  'nome_atual', 'nome_novo', 'fonte', 'identifier', 'deal_id', 'ids',
];

async function main() {
  if (!bot.chatwootConfigurado()) {
    console.error('❌ Chatwoot nao configurado (CHATWOOT_BASE, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN no .env)');
    process.exit(1);
  }

  const idadeDias = (Date.now() - fs.statSync(BANCO).mtimeMs) / 86400000;
  console.log(`\n💬 Backfill de nomes no Chatwoot — ${APLICAR ? 'APLICANDO (escreve de verdade)' : 'SO LEITURA'}`);
  console.log(`   Chatwoot: ${process.env.CHATWOOT_BASE} (conta ${process.env.CHATWOOT_ACCOUNT_ID})`);
  console.log(`   Banco:    ${path.resolve(BANCO)} (modificado ha ${idadeDias.toFixed(1)} dia(s))`);
  if (idadeDias > 7) {
    console.log('   ⚠️ ESTE BANCO ESTA VELHO. Todo nome vem dele (espelho do Moskit + conversas):');
    console.log('      medir/escrever com um snapshot antigo subestima o resultado e pode escrever nome desatualizado.');
    console.log('      Na VPS, rode contra o conversations.db de producao.');
  }
  if (SO) console.log(`   Restrito ao telefone: ${SO}`);

  // ---------- espelho do Moskit ----------
  if (REFRESCAR) {
    // A MESMA funcao que a producao usa (importada, nunca copiada): a pergunta "qual o nome deste
    // contato no Moskit?" nao pode ter duas respostas dependendo do caminho de codigo.
    console.log('\n📥 Refrescando o espelho do Moskit (importarContatosMoskit)...');
    const imp = await bot.importarContatosMoskit();
    console.log(`   ${imp.telefones_importados} telefones de ${imp.total_contatos} contatos`);
  } else {
    console.log('\nℹ️ Espelho do Moskit NAO refrescado (--refrescar-espelho faz isso, ~400 requisicoes ao Moskit).');
  }

  // ---------- varredura do Chatwoot ----------
  if (!SEM_VARREDURA) {
    console.log('\n🔎 Varrendo /contacts do Chatwoot para montar o indice local...');
    console.log('   (uma varredura e MUITO mais barata que um filter por candidato: ~270 requisicoes contra ~3.800)');
    try {
      const v = await bot.varrerContatosChatwoot({
        aoProgresso: ({ pagina, vistos }) => {
          if (pagina % 20 === 0) console.log(`   pagina ${pagina}, ${vistos} contatos...`);
        },
      });
      console.log(`   ${v.contatos} contatos em ${v.paginas} paginas (${v.gravados} com telefone, ${v.sem_telefone} sem)`);
      if (v.total_relatado != null) console.log(`   o Chatwoot relata ${v.total_relatado} contatos na conta`);
      if (v.aviso) console.log(`   ⚠️ ${v.aviso}`);
    } catch (e) {
      // Paginacao que nao avanca e erro alto de proposito — seguir em frente escreveria 15 contatos e
      // pareceria ter varrido a base inteira.
      console.error(`\n❌ Varredura interrompida: ${e.message}`);
      console.error('   Rode `node sondar-chatwoot.js` para ver o que a paginacao desta instancia faz.');
      process.exit(1);
    }
  } else {
    console.log('\nℹ️ Varredura pulada (--sem-varredura): usando o indice local como esta.');
  }

  // ---------- a decisao, com a funcao de producao ----------
  console.log(`\n⚙️ Decidindo (${APLICAR ? 'e escrevendo' : 'sem escrever'})...`);
  // `soChave` restringe os candidatos DENTRO da funcao de producao. Antes o --so= filtrava apenas o
  // CSV no fim, e portanto `--aplicar --so=<um telefone>` escrevia em todos os candidatos — o
  // oposto do que a flag promete, e num script que escreve em dado de cliente.
  const r = await bot.sincronizarContatosChatwoot({ aplicar: APLICAR, limite: LIMITE, detalhar: true, soChave: SO });

  if (r.erro) {
    console.error(`❌ ${r.erro}`);
    process.exit(1);
  }

  // Com soChave a propria funcao ja processou so o telefone pedido; aqui e apenas cosmetica, para o
  // CSV nao carregar 200 linhas de "fora_do_filtro".
  let detalhe = (r.detalhe || []).filter((d) => d.resultado !== 'fora_do_filtro');

  // ---------- relatorio ----------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`analisados (chegaram a tocar a rede): ${r.analisados}`);
  console.log(APLICAR ? `ESCRITOS: ${r.escritos}` : `escreveria: ${r.escreveria}`);
  console.log(`nao encontrados no Chatwoot:          ${r.nao_encontrados}`);
  console.log(`ambiguos (duas fichas, merge manual): ${r.ambiguos.length}`);
  console.log(`colisoes de identifier:               ${r.colisoes.length}`);
  console.log(`erros:                                ${r.erros.length}`);
  console.log('\npulados, por motivo:');
  for (const [motivo, n] of Object.entries(r.pulados).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${motivo}`);
  }

  const porFonte = {};
  const porClasse = {};
  for (const d of detalhe) {
    if (d.resultado !== 'escrito' && d.resultado !== 'escreveria' && d.resultado !== 'escrito_sem_identifier') continue;
    porFonte[d.fonte || '?'] = (porFonte[d.fonte || '?'] || 0) + 1;
    porClasse[d.classe_anterior || '?'] = (porClasse[d.classe_anterior || '?'] || 0) + 1;
  }
  if (Object.keys(porFonte).length) {
    console.log('\nde onde veio o nome:');
    for (const [f, n] of Object.entries(porFonte).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${f}`);
    console.log('o que a ficha tinha antes:');
    for (const [c, n] of Object.entries(porClasse).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${c}`);
  }

  if (r.ambiguos.length) {
    console.log('\n👥 duas fichas no Chatwoot para o mesmo cliente (precisam de merge MANUAL):');
    for (const a of r.ambiguos.slice(0, 20)) console.log(`   ...${String(a.chave).slice(-8)} -> contatos ${a.ids.join(', ')}`);
    if (r.ambiguos.length > 20) console.log(`   ... e mais ${r.ambiguos.length - 20}`);
  }
  if (r.erros.length) {
    console.log('\n❌ erros:');
    for (const e of r.erros.slice(0, 20)) console.log(`   ...${String(e.chave).slice(-8)}: ${e.erro}`);
  }
  if (r.encerrado_por === 'proibido') {
    console.log('\n🚫 O ciclo foi ENCERRADO: o Chatwoot recusou o token (401/403). Nada mais foi tentado.');
  }

  // ---------- CSV ----------
  // Telefone + nome + link do negocio de milhares de pessoas: o diretorio esta no .gitignore, junto
  // com auditoria-crm/, e pelo mesmo motivo.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join('chatwoot-backfill', ts);
  fs.mkdirSync(dir, { recursive: true });
  const saida = escreverCsv(path.join(dir, 'contatos.csv'), detalhe.map((d) => {
    const linha = {};
    for (const c of COLUNAS) linha[c] = d[c] ?? '';
    return linha;
  }), { cabecalho: COLUNAS });
  console.log(`\n📄 ${saida.linhas} linha(s) em ${saida.caminho}`);

  if (!APLICAR) {
    console.log('\nNada foi escrito no Chatwoot. Confira o CSV — em especial a coluna `nome_novo` —');
    console.log('e depois: node backfill-chatwoot-nomes.js --aplicar --limite=1 --so=<um telefone>');
    console.log('seguido de uma olhada na ficha desse contato no Chatwoot (nome E custom attributes).');
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.stack || e.message}`);
  process.exit(1);
});
