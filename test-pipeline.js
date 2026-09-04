// Testes das funcoes novas dos Lotes 1 e 2 que decidem o que vai pro CRM e pra agenda. Rodar com:
//   node test-pipeline.js
//
// Moskit, Google Calendar e Telegram sao SUBSTITUIDOS por dublês que so registram o que foi chamado.
// index.js faz `axios.get(...)` como lookup de propriedade na hora da chamada, entao trocar os
// metodos no objeto do modulo intercepta todos os call sites de uma vez. Nenhum byte sai da maquina.
//
// DB_PATH aponta para um banco descartavel; WORKER_MODE=1 impede o boot de subir servidor e timers.

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
// Os IDs de estagio das assercoes deste arquivo sao os canonicos de src/moskit-ids.js — fixar aqui
// impede que o .env de quem roda (dev ou VPS, que pode apontar para outro funil) mude o veredito.
require('./test-utils').fixarEstagiosDeTeste();
const path = require('path');
const Database = require('better-sqlite3');

const DIR = dirTemporario('pipeline');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.GOOGLE_CALENDAR_ID = 'agenda-de-teste@exemplo.com';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
// Fixado aqui em vez de herdar do .env real: FUNIL_DRY_RUN/FUNIL_FECHAMENTO_DRY_RUN sao lidos como
// const no require de index.js abaixo, e o .env de producao pode estar em qualquer valor (esta
// ligado de verdade la). Os testes de dry-run abaixo dependem de comecar em 'true'.
process.env.FUNIL_DRY_RUN = 'true';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true';
// Mesmo motivo, sinal trocado: AGENDA_MOSKIT_DRY_RUN default FALSE (a agenda funciona sem a
// variavel), e todas as assercoes de agenda deste arquivo cobrem o caminho LIGADO. Fixar em 'false'
// impede que um .env de producao com a flag ligada faca esses testes passarem por engano, sem
// escrever nada. O caminho desligado tem arquivo proprio: test-agenda-dry-run.js.
process.env.AGENDA_MOSKIT_DRY_RUN = 'false';
// Mesmo motivo: BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN nasce em 'true' (so loga). O caminho que
// realmente precisa de regressao e o bloqueio LIGADO — o caminho dry-run (loga mas cria mesmo assim)
// tem arquivo proprio: test-bloqueio-campos-obrigatorios-dry-run.js.
process.env.BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN = 'false';
// Mesmo motivo: fixar os limites da reconciliacao de vinculo (defaults identicos aos de producao)
// para o teste nao depender de um .env que esteja em outro valor.
process.env.VINCULO_MAX_TENTATIVAS = '3';
process.env.VINCULO_BACKOFF_CICLOS = '4';
// Anexo do Doc na aba "Arquivos": em producao nasce DESLIGADO (NOTAS_ANEXO_ATIVO default false), e e
// justamente o caminho ligado que precisa de regressao aqui. PUBLIC_BASE_URL tambem e obrigatoria —
// sem ela anexarDocNoDeal desiste antes de tocar a rede, e todos os testes abaixo passariam vazios.
process.env.NOTAS_ANEXO_ATIVO = 'true';
process.env.PUBLIC_BASE_URL = 'https://tunel-de-teste.example';
process.env.NOTAS_ANEXO_MAX_TENTATIVAS = '3';
// Cliente que volta: em producao nasce DESLIGADO e em dry-run (CLIENTE_RETORNO_ATIVO=false,
// CLIENTE_RETORNO_DRY_RUN=true). Aqui vale o inverso, pelo mesmo motivo de NOTAS_ANEXO_ATIVO: o
// caminho que escreve e o que pode errar, e as duas flags sao lidas como const no require abaixo.
process.env.CLIENTE_RETORNO_ATIVO = 'true';
process.env.CLIENTE_RETORNO_DRY_RUN = 'false';
process.env.RETORNO_FOLGA_HORAS = '2';
// src/telefone.js le TEAM_PHONES como `const` no require abaixo (mesmo motivo das flags acima) —
// numero dedicado so pro teste do ramo 'interno' de processarConversaDirect.
process.env.TEAM_PHONES = '5511900009999';
// Chatwoot: em producao nasce DESLIGADO e em dry-run, e as duas flags sao lidas como const no
// require de index.js abaixo. Aqui vale o inverso, pelo mesmo motivo de NOTAS_ANEXO_ATIVO — o caminho
// que ESCREVE e o que pode errar. O modo padrao (desligado + dry-run) tem arquivo proprio:
// test-chatwoot-flags.js. Pausa zerada para a suite nao esperar 300ms por contato.
process.env.CHATWOOT_ATIVO = 'true';
process.env.CHATWOOT_DRY_RUN = 'false';
process.env.CHATWOOT_BASE = 'https://chat.exemplo.com';
process.env.CHATWOOT_ACCOUNT_ID = '9';
process.env.CHATWOOT_API_TOKEN = 'token-falso-chatwoot';
process.env.CHATWOOT_PAUSA_MS = '0';
process.env.CHATWOOT_MAX_TENTATIVAS = '3';
// Monitor Evolution API -> Chatwoot: em producao nasce LIGADO (e so leitura), mas aqui e preciso
// FIXAR (nao herdar do .env real) pelo mesmo motivo de toda flag lida como const no require abaixo.
// Sem EVOLUTION_API_KEY o monitor vira no-op — a suite de rede/dedup precisa da chave pra exercitar
// o caminho de verdade.
process.env.EVOLUTION_MONITOR_ATIVO = 'true';
process.env.EVOLUTION_BASE = 'http://127.0.0.1:8080';
process.env.EVOLUTION_API_KEY = 'chave-falsa-evolution';
process.env.EVOLUTION_INSTANCE = 'escritorio';
process.env.EVOLUTION_MONITOR_INTERVAL_MS = '300000';

// ---------- dublê do axios ----------
const axios = require('axios');
const rede = { chamadas: [], get: null, post: null, put: null };
for (const metodo of ['get', 'post', 'put', 'patch', 'delete']) {
  axios[metodo] = async (url, a, b) => {
    const corpo = metodo === 'get' || metodo === 'delete' ? undefined : a;
    rede.chamadas.push({ metodo: metodo.toUpperCase(), url, corpo, cfg: corpo === undefined ? a : b });
    const h = rede[metodo];
    if (h) return h(url, corpo);
    return { status: 200, data: {} };
  };
}

// ---------- dublê da OpenAI ----------
// openaiChat fala HTTPS direto (sem SDK), entao o dublê e no https.request. Rodar a suite numa
// maquina com OPENAI_API_KEY valida gastava credito, e sem rede a chamada virava unhandledRejection.
//
// Fila explicita por cenario; sem resposta enfileirada, devolve `{}`.
const httpsModulo = require('https');
const { EventEmitter } = require('events');
const openai = { respostas: [], prompts: [], hosts: [] };
httpsModulo.request = (opcoes, cb) => {
  const corpo = [];
  const res = new EventEmitter();
  const req = {
    on: () => req,
    write: (c) => corpo.push(String(c)),
    destroy: () => {},
    end: () => {
      openai.hosts.push(opcoes && opcoes.hostname);
      openai.prompts.push(corpo.join(''));
      const resposta = openai.respostas.shift() || {};
      const texto = JSON.stringify(resposta);
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify({ choices: [{ message: { content: texto } }] }));
        res.emit('end');
      });
    },
  };
  return req;
};

// ---------- dublê do Google Calendar ----------
const { google } = require('googleapis');
const agenda = { insert: [], patch: [], get: [], delete: [], list: [], respostaInsert: null, respostaGet: null, respostaList: null, getDeveLancar: false };
google.calendar = () => ({
  events: {
    insert: async (a) => { agenda.insert.push(a); return { data: agenda.respostaInsert }; },
    // Usado por acharEventoDaReuniao (rotina de notas). Vazio por padrao = "nenhum evento casou",
    // que e o caminho em que a identificacao tem de se virar sem a agenda.
    list: async (a) => { agenda.list.push(a); return { data: { items: agenda.respostaList || [] } }; },
    patch: async (a) => { agenda.patch.push(a); return { data: {} }; },
    // respostaGet permite ao teste devolver o evento que o proprio bot acabou de criar — e assim que
    // se prova que sincronizarMetadadosEvento NAO fica repatchando um evento que nao mudou.
    // getDeveLancar simula o 404 que sincronizarAtividadesMoskit espera quando o Moskit AINDA nao
    // sincronizou uma atividade nativamente com o Google — sem isso o dublê nunca lanca, e o branch
    // "Moskit ainda nao sincronizou" (calendar.events.insert) ficaria impossivel de exercitar.
    get: async (a) => {
      agenda.get.push(a);
      if (agenda.getDeveLancar) { const e = new Error('Not Found'); e.code = 404; throw e; }
      return { data: agenda.respostaGet || { summary: 'antigo', description: 'antigo' } };
    },
    delete: async (a) => { agenda.delete.push(a); return {}; },
  },
});

const {
  moverParaEstagio, criarNotaMoskit, aplicarViradaCobranca, atualizarNegocioMoskit,
  handleAgendamentoCalendar, listarAtividadesMoskit, finalizarCiclo,
  aplicarGateCasoDescrito, deveEsperarCasoDescrito, deveEsperarCamposObrigatorios, aplicarPadroesDeterministicosDeOrigem, detectarRespostaPerguntaOrigem, registrarBriefing, mergeDados,
  mesclarParaCrm, derivarAdvogadoDaArea, detectarOpcoesInvalidas, registrarOpcoesInvalidas,
  rejeitarAssuntoQueEhArea,
  reconciliarClassificacao, reconciliarPendenciasAgendamento, reconciliarVinculoAtividades, montarPayloadMoskit,
  refrescarBriefingsPertoDaConsulta,
  descreverAncora, somarMinutosNaive, formatarHorarioEscritorio,
  stmtsNotas, registrarFalhaNota, conferirSilencioNotas, processarNotaReuniao,
  anexarDocNoDeal, anexoComNomeExiste, retomarAnexosPendentes, limparAnexosExpirados,
  enviarTelegram, baixarParaArquivo, montarHeadersAnexo, ehHostZernio, resolverUrlAnexo,
  garantirDealExiste, importarContatosMoskit, buscarOuCriarContato, buscarDealPorContato,
  sincronizarAtividadesMoskit, comSufixoDealId, comMarcadorDeal,
  processarConversaDirect, montarHistorico, equipeEnviouCondicoesDeValor,
  janelaAtendimento, consultaDoAtendimento, lerDealsAnteriores, abrirNovoAtendimento, avisarRetornoUmaVez,
  camposPendentes, ASSUNTO_NEUTRO,
  sincronizarContatosChatwoot, rodarSincronizacaoChatwoot, varrerContatosChatwoot,
  acharContatoChatwoot, dadosLocaisDoCliente, stmtsChatwoot, chatwootRequisicao, ehHostChatwoot,
  montarCandidatosChatwoot,
  evolutionConfigurado, evolutionRequisicao, ehHostEvolutionLocal, chatwootTokenValido,
  medirSaudeEvolution, monitorarEvolution, stmtEvolutionSaude,
  buscarMensagensEvolutionNaJanela, resolverTelefoneChatwoot, montarRelatorioRecuperacaoEvolution,
} = require('./index');
const { lerFila, salvarFila } = require('./src/fila');
const moskitIds = require('./src/moskit-ids');
const notasReuniao = require('./src/notas-reuniao');
const briefingModule = require('./src/briefing');
const { instanteParaNaiveLocal } = require('./src/evidencia');
const { BLOCO_CONDICOES_PAGA } = require('./src/bloco-condicoes');

const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

// Id devolvido pelo POST /activities simulado. Precisa existir: sem id o bot trata a criacao como
// falha (nao teria como remarcar nem como travar o evento duplicado) e posta uma nota de aviso, que
// desalinharia notas()[0] em todos os testes de agendamento.
const ID_ATIVIDADE = 990001;

function limpar() {
  rede.chamadas = []; rede.get = rede.put = null;
  rede.post = (url) => (url.includes('/activities') ? { status: 200, data: { id: ID_ATIVIDADE } } : { status: 200, data: {} });
  agenda.insert = []; agenda.patch = []; agenda.get = []; agenda.delete = []; agenda.list = [];
  agenda.respostaInsert = { id: 'ev1', htmlLink: 'https://exemplo/ev1' };
  agenda.respostaGet = null;
  agenda.respostaList = null;
  agenda.getDeveLancar = false;
  // Tabela de dedupe entre as duas agendas — sem limpar, o INSERT OR IGNORE do teste anterior faria
  // o proximo enxergar uma linha velha e passar por engano.
  db.prepare('DELETE FROM atividades_sincronizadas').run();
}
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
const notas = () => de('POST', '/notes');
const anexosCriados = () => de('POST', '/attachments');
const atividadesCriadas = () => de('POST', '/activities');
const atividadesRemarcadas = () => de('PUT', '/activities');
const sincronizada = (id) => db.prepare('SELECT * FROM atividades_sincronizadas WHERE activity_id = ?').get(id);
const telegrams = () => de('POST', 'api.telegram.org');
const linha = (chatId) => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);
// `de('POST', '/deals')` casaria tambem /deals/{id}/notes e /deals/{id}/attachments: para contar
// negocio CRIADO x negocio ATUALIZADO a URL tem que terminar ali.
const dealsCriados = () => rede.chamadas.filter((c) => c.metodo === 'POST' && c.url.endsWith('/deals'));
const dealsAtualizados = () => rede.chamadas.filter((c) => { if (c.metodo !== 'PUT') return false; const cauda = c.url.split('/deals/')[1]; return !!cauda && !cauda.includes('/'); });

function semear(chatId, extras = {}) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
  const campos = { chat_id: chatId, phone: chatId, contact_name: 'Fulano', messages: '[]', ...extras };
  const cols = Object.keys(campos);
  db.prepare(`INSERT INTO conversations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => campos[c]));
  return linha(chatId);
}

const esperarErro = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// area_direito faz parte dos dados base porque o responsavel deixou de ser escolha livre: montarPayloadMoskit
// deriva o advogado da area (MOSKIT_IDS.ADVOGADO_POR_AREA_ID). Familia → Bruno.
const DADOS = { nome: 'Fulano de Tal', assunto: 'Inventario', tipo_consulta: 'consulta paga', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno' };

const CF = moskitIds.CF;
const OPCAO = {
  paga: moskitIds.TIPO_CONSULTA['consulta paga'],
  gratis: moskitIds.TIPO_CONSULTA['consulta gratis'],
  familia: moskitIds.AREA_DIREITO['direito de familia'],
  admin: moskitIds.AREA_DIREITO['direito administrativo'],
  lgpd: moskitIds.AREA_DIREITO['lgpd'],
  bruno: moskitIds.RESPONSAVEL_PROCESSO['bruno'],
  berto: moskitIds.RESPONSAVEL_PROCESSO['berto'],
};

// entityCustomFields que atualizarNegocioMoskit vai tentar confirmar apos o PUT. Usado nos GETs
// simulados, pra que a reconferencia pos-PUT ja encontre o campo "persistido" de cara — sem isso, todo
// teste ficaria 6.5s tentando e por fim lancando, porque o dublê de rede nao tem estado real pra
// refletir o PUT que acabou de acontecer.
const cf = (id, opcao) => ({ id, options: [opcao] });
const CF_DADOS = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, OPCAO.familia), cf(CF.RESPONSAVEL, OPCAO.bruno)];

(async () => {
  // ============================================================
  console.log('\n=== moverParaEstagio: o PUT so vale se o estagio mudar mesmo ===');
  // corrigir-tipo-consulta.js afirma por escrito que o Moskit IGNORA em silencio um PUT montado com o
  // corpo do GET. Enquanto isso nao for medido contra a API (test-moskit-put.js), ao menos o
  // resultado deixa de ser engolido: a funcao rele o deal e lanca se nada mudou.
  {
    limpar();
    let seq = [{ id: 7, name: 'Deal', stage: { id: 179388 } }, { id: 7, stage: { id: 184382 } }];
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => moverParaEstagio(7, 184382));
    igual('estagio realmente mudou → resolve', erro, null);
    igual('   fez 2 GET (o de leitura e o de conferencia)', de('GET', '/deals/7').length, 2);
    igual('   fez 1 PUT', de('PUT', '/deals/7').length, 1);
    igual('   o PUT leva o estagio novo', de('PUT', '/deals/7')[0].corpo.stage.id, 184382);
    igual('   ...e preserva os outros campos do deal', de('PUT', '/deals/7')[0].corpo.name, 'Deal');
  }
  {
    limpar();
    let seq = [{ stage: { id: 179388 } }, { stage: { id: 179388 } }];
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => moverParaEstagio(7, 184382));
    checar('Moskit aceitou o PUT mas nao moveu → LANCA', !!erro && erro.includes('nao se confirmou'), erro);
  }
  {
    limpar();
    let seq = [{ stage: { id: 179388 } }, {}];
    rede.get = () => ({ status: 200, data: seq.shift() });
    checar('conferencia sem stage → LANCA', !!(await esperarErro(() => moverParaEstagio(7, 184382))));
  }
  {
    limpar();
    let seq = [{ stage: { id: 179388 } }, { stage: { id: '184382' } }];
    rede.get = () => ({ status: 200, data: seq.shift() });
    igual('id como string nao gera falso alarme (compara com Number)', await esperarErro(() => moverParaEstagio(7, 184382)), null);
  }

  // ============================================================
  console.log('\n=== atualizarNegocioMoskit: o PUT so conta se os custom fields realmente pegarem ===');
  // Regressao do deal 48423360: a IA decidiu "Direito Administrativo" e o bot criou a nota de
  // sucesso, mas o Moskit aceitou o PUT (2xx) sem aplicar o campo de fato — exigiu correcao manual
  // no CRM. atualizarNegocioMoskit agora reconfere os entityCustomFields que decidiu enviar, com o
  // mesmo retry de moverParaEstagio, antes de devolver sucesso.
  // Administrativo → Berto (a area define o responsavel).
  const DADOS_AREA = { ...DADOS, area_direito: 'Direito Administrativo' };
  const CF_AREA = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, OPCAO.admin), cf(CF.RESPONSAVEL, OPCAO.berto)];
  {
    limpar();
    let seq = [
      { id: 20, name: 'Cliente sem nome', stage: { id: 179388 }, entityCustomFields: [] },
      { id: 20, entityCustomFields: CF_AREA },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => atualizarNegocioMoskit(20, DADOS_AREA, 555, {}));
    igual('campo realmente pegou → resolve', erro, null);
    igual('   fez 2 GET (leitura de merge + 1 conferencia)', de('GET', '/deals/20').length, 2);
    igual('   fez 1 PUT', de('PUT', '/deals/20').length, 1);
  }
  {
    // MEDIDO em 19/08/2026 no deal 48441223: o PUT e full replace, e OMITIR `activities` significa
    // para o Moskit "desvincule estas atividades". Ele recusa quando alguma ja foi concluida e
    // derruba o PUT inteiro com 422 `field: oldActivities`.
    //
    // O caso real: a consulta de 13/08 foi marcada como concluida na mao em 17/08, e a partir dali
    // TODA atualizacao daquele negocio falhou — o chat 553799437737 queimou as 3 tentativas da fila
    // e foi descartado em silencio. E consulta concluida e o caminho NORMAL de sucesso, ou seja o
    // defeito atingia justamente os negocios bem atendidos.
    limpar();
    const ATIVIDADES = [{ id: 79974205 }];
    let seq = [
      { id: 24, name: 'Cliente sem nome', stage: { id: 179388 }, entityCustomFields: [], activities: ATIVIDADES },
      { id: 24, entityCustomFields: CF_AREA },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => atualizarNegocioMoskit(24, DADOS_AREA, 555, {}));
    igual('deal com atividade → resolve', erro, null);
    const corpo = de('PUT', '/deals/24')[0]?.corpo;
    checar('   o PUT REENVIA activities (senao o Moskit devolve 422)', JSON.stringify(corpo?.activities) === JSON.stringify(ATIVIDADES), corpo?.activities);
  }
  {
    // Deal sem atividade nenhuma: o campo nao deve ser inventado. Mandar `activities: []` seria
    // dizer "desvincule tudo" — a mesma frase que causa o 422, agora por excesso de zelo.
    limpar();
    let seq = [
      { id: 25, name: 'Cliente sem nome', stage: { id: 179388 }, entityCustomFields: [] },
      { id: 25, entityCustomFields: CF_AREA },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(25, DADOS_AREA, 555, {}));
    const corpo = de('PUT', '/deals/25')[0]?.corpo;
    igual('   GET sem activities → o PUT nao inventa o campo', corpo && 'activities' in corpo, false);
  }
  {
    // Exatamente o sintoma do deal 48423360: Moskit aceita o PUT (2xx) mas a area do direito nunca
    // aparece nas releituras — antes disto, a funcao devolvia sucesso do mesmo jeito.
    limpar();
    let seq = [
      { id: 21, entityCustomFields: [] },
      { id: 21, entityCustomFields: [] },
      { id: 21, entityCustomFields: [] },
      { id: 21, entityCustomFields: [] },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => atualizarNegocioMoskit(21, DADOS_AREA, 555, {}));
    checar('Moskit aceitou o PUT mas o campo nao pegou → LANCA', !!erro && erro.includes('nao se confirmaram'), erro);
  }
  {
    // Prova de que a comparacao nao e JSON.stringify ingenuo: ordem do array e tipo de options
    // diferentes (string vs number) nao podem gerar falso alarme.
    limpar();
    const invertidoEComoString = [
      { id: CF.AREA_DIREITO, options: [String(OPCAO.admin)] },
      cf(CF.TIPO_CONSULTA, OPCAO.paga),
      { id: CF.RESPONSAVEL, options: [String(OPCAO.berto)] },
    ].reverse();
    let seq = [
      { id: 22, entityCustomFields: [] },
      { id: 22, entityCustomFields: invertidoEComoString },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    igual('ordem/tipo diferentes no array nao geram falso alarme',
      await esperarErro(() => atualizarNegocioMoskit(22, DADOS_AREA, 555, {})), null);
  }
  {
    // dados sem nenhum campo mapeavel (origem/tipo_consulta/captacao/area/responsavel todos null) →
    // camposEsperados fica vazio, e a funcao nao tem nada pra reconferir.
    limpar();
    rede.get = () => ({ status: 200, data: { id: 23, entityCustomFields: [] } });
    const erro = await esperarErro(() => atualizarNegocioMoskit(23, { nome: 'Sem Campos' }, 555, {}));
    igual('nenhum custom field resolvido → resolve sem reconferir', erro, null);
    igual('   so o GET de leitura, zero GET de conferencia', de('GET', '/deals/23').length, 1);
  }

  // ============================================================
  console.log('\n=== criarNotaMoskit ===');
  for (const vazio of [null, undefined, 0, '']) {
    limpar();
    await criarNotaMoskit(vazio, 'texto');
    igual(`dealId ${JSON.stringify(vazio)} → nenhuma chamada HTTP`, rede.chamadas.length, 0);
  }
  {
    limpar();
    await criarNotaMoskit(42, 'oi');
    igual('dealId valido → 1 POST', notas().length, 1);
    igual('   na URL do deal', notas()[0].url.endsWith('/deals/42/notes'), true);
    igual('   com o texto', notas()[0].corpo.description, 'oi');
    igual('   atribuida a Layla', notas()[0].corpo.user.id, 90607);
    igual('   com o header de origem', notas()[0].cfg.headers['X-Ollow-Origin'], 'BOT_WHATSAPP');
  }
  {
    // Antes tinha validateStatus: s < 500, entao um 400 passava como sucesso e a nota simplesmente
    // nunca aparecia no deal — sem erro em lugar nenhum.
    limpar();
    rede.post = () => { throw new Error('Request failed with status code 400'); };
    checar('4xx PROPAGA (nao passa como sucesso)', !!(await esperarErro(() => criarNotaMoskit(42, 'oi'))));
  }

  // ============================================================
  console.log('\n=== aplicarViradaCobranca: cortesia → paga (checkpoint) ===');
  // Espelho local de contatos: buscarOuCriarContato resolve sem tocar na rede.
  db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run('5586911112222', 555, 'Fulano');
  const TEL = '5586911112222';

  {
    limpar();
    const row = semear(TEL, { deal_id: null });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    igual('sem deal ainda → no-op (o deal ja vai nascer paga)', rede.chamadas.length, 0);
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { id: 10, name: 'Fulano de Tal - Inventario', stage: { id: 179388 }, entityCustomFields: CF_DADOS } });
    const row = semear(TEL, { deal_id: 10 });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    const puts = de('PUT', '/deals/10');
    igual('1 PUT no deal', puts.length, 1);
    igual('   price sobe para 35000', puts[0].corpo.price, 35000);
    igual('   estagio atual preservado (PUT e full replace)', puts[0].corpo.stage.id, 179388);
    // Decisao de 02/09/2026: a virada bem-sucedida deixou de virar nota (confirmacao de rotina) —
    // so o PUT do valor/price e o alerta condicional de baixo (evento ja na agenda) permanecem.
    igual('nenhuma nota (sucesso de rotina, nao vira mais nota)', notas().length, 0);
    igual('sem evento na agenda → nenhum Telegram', telegrams().length, 0);
  }
  {
    // Consulta ja marcada como cortesia que vira paga: o evento NAO e cancelado — desmarcar reuniao
    // de cliente real por inferencia e pior que o erro. Avisa a equipe para cobrar.
    limpar();
    rede.get = () => ({ status: 200, data: { id: 11, stage: { id: 184382 }, entityCustomFields: CF_DADOS } });
    const row = semear(TEL, { deal_id: 11, evento_calendar_criado: 1, evento_calendar_id: 'ev9', evento_calendar_data: '2026-08-05T17:30:00' });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    igual('evento ja na agenda → 1 alerta no Telegram', telegrams().length, 1);
    checar('   o alerta traz o horario da reuniao', telegrams()[0].corpo.text.includes('05/08/2026'), telegrams()[0].corpo.text);
    igual('   o evento NAO e cancelado', agenda.delete.length, 0);
    igual('   o PUT acontece do mesmo jeito', de('PUT', '/deals/11').length, 1);
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { id: 12, stage: { id: 184382 }, entityCustomFields: CF_DADOS } });
    const row = semear(TEL, { deal_id: 12, evento_calendar_criado: 1, evento_calendar_id: 'ev9', evento_calendar_data: null });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    checar('evento sem data registrada → alerta sai mesmo assim', telegrams()[0]?.corpo.text.includes('horario nao registrado'));
  }
  {
    // Se falhar no meio, a marca do bloco tem que voltar a zero — senao a proxima rodada acharia que
    // a virada ja foi aplicada e o deal ficaria em R$0 para sempre.
    limpar();
    rede.get = () => ({ status: 200, data: { id: 13, stage: { id: 179388 } } });
    rede.put = () => { throw new Error('Moskit fora do ar'); };
    const row = semear(TEL, { deal_id: 13, bloco_condicoes_enviado: 1, bloco_condicoes_msg_idx: 4 });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    const r = linha(TEL);
    igual('PUT falhou → nao lanca para fora', true, true);
    igual('   bloco_condicoes_enviado volta a 0 (nova tentativa no proximo ciclo)', r.bloco_condicoes_enviado, 0);
    igual('   bloco_condicoes_msg_idx limpo', r.bloco_condicoes_msg_idx, null);
    igual('   nenhuma nota de sucesso foi criada', notas().length, 0);
  }

  // ============================================================
  console.log('\n=== handleAgendamentoCalendar: o portao da dupla confirmacao ===');
  const CHAT = '5586933334444';
  const ACEITE = { tipo: 'cliente_aceitou_horario', msg_idx: 2, trecho: 'pode ser sim', horario_iso: '2026-08-05T17:30:00' };
  const CONFIRMA = { tipo: 'equipe_confirmou_horario', msg_idx: 3, trecho: 'marquei sua consulta', horario_iso: '2026-08-05T17:30:00' };
  const CONFIRMADO = { confirmado: true, horarioIso: '2026-08-05T17:30:00', cliente: ACEITE, equipe: CONFIRMA, motivo: null };
  const SO_CLIENTE = { confirmado: false, horarioIso: null, cliente: ACEITE, equipe: null, motivo: 'falta_equipe' };
  const NADA = { confirmado: false, horarioIso: null, cliente: null, equipe: null, motivo: 'falta_ambos' };

  // Naive local (fuso do escritorio) a partir de agora + N horas — usado pelos testes de escalada por
  // proximidade em registrarAgendamentoPendente, que precisam de um horario de fato perto (ou longe)
  // do momento em que o teste roda (mesmo padrao Intl usado em test-moskit-atividade-real.js).
  function naiveDaquiA(horas) {
    const alvo = new Date(Date.now() + horas * 3600000);
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(alvo).map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }

  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, NADA);
    igual('ninguem falou de horario → nenhuma nota', notas().length, 0);
    igual('   e nenhum evento', agenda.insert.length, 0);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, SO_CLIENTE);
    // Pendencia de ROTINA (so falta a confirmacao de um lado, sem remarcacao/descarte/urgencia): ate
    // 02/09/2026 isso so virava nota, de proposito, pra nao virar ruido diario no Telegram. Com a
    // nota removida, o Telegram passou a ser o unico alerta tambem para este caso.
    igual('so o cliente aceitou → nenhuma nota (pendencia nao vira mais nota)', notas().length, 0);
    igual('   1 Telegram de pendencia', telegrams().length, 1);
    checar('   o Telegram diz que NAO foi lancada', telegrams()[0].corpo.text.includes('NÃO lançada'));
    checar('   e diz o que falta', telegrams()[0].corpo.text.includes('DA EQUIPE'));
    igual('   NENHUM evento criado', agenda.insert.length, 0);
    checar('   hash de pendencia gravado', !!linha(CHAT).agendamento_pendente_hash);

    // Sem o hash, o mesmo Telegram sairia a cada ciclo de 5 min enquanto a conversa nao mudasse.
    const anterior = telegrams().length;
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), SO_CLIENTE);
    igual('repetir identico → nenhum Telegram novo (dedup por hash)', telegrams().length, anterior);

    const outro = { ...SO_CLIENTE, cliente: { ...ACEITE, horario_iso: '2026-08-06T10:00:00' } };
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), outro);
    igual('horario diferente → Telegram novo', telegrams().length, anterior + 1);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: null });
    await handleAgendamentoCalendar(null, { ...DADOS }, CHAT, false, row, SO_CLIENTE);
    igual('sem dealId → nenhum alerta', notas().length + telegrams().length, 0);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: null });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-05T17:30:00' }, CHAT, false, row, CONFIRMADO);
    igual('evento marcado como criado mas sem id salvo → sai cedo, nao mexe em nada', agenda.patch.length + agenda.insert.length, 0);
    igual('   nenhuma nota', notas().length, 0);
  }
  {
    // A trava que faltava: sem ela, qualquer data extraida movia a reuniao de um cliente real —
    // inclusive um horario que a equipe apenas PROPOS e o cliente nunca respondeu.
    //
    // Esta conversa tambem NAO tem atividade_moskit_id — a auto-cura roda de qualquer forma (ela
    // nao depende de dupla confirmacao nesta rodada, so do evento no Google ja existir), mas a
    // criacao bem-sucedida da atividade deixou de virar nota (confirmacao de rotina) — so a
    // pendencia de "nao remarcada" continua saindo.
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-09T09:00:00' }, CHAT, false, row, SO_CLIENTE);
    igual('reuniao existente sem dupla confirmacao → NAO remarca', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
    checar('   a auto-cura ainda cria a atividade que faltava', atividadesCriadas().length === 1);
    igual('   nenhuma nota (pendencia de "nao remarcada" so avisa no Telegram)', notas().length, 0);
    checar('   1 Telegram com o texto certo de "nao remarcada"', telegrams().some((t) => t.corpo.text.includes('NÃO remarcada')));
    checar('   titulo/descricao ainda podem ser corrigidos (nao movem nada)', agenda.get.length >= 1);
  }

  // ============================================================
  // registrarAgendamentoPendente: escalada por proximidade + enriquecimento por conteudo.
  // MEDIDO em 14/08/2026 nos deals 48292471 (Lia) e 48287898 (Solange): a apuracao ja identificava a
  // pendencia certa (motivo falta_cliente), mas em pelo menos um caso (Lia) NENHUM campo do modelo
  // carregava informacao nova naquela rodada — so a PROXIMIDADE da reuniao ja marcada justificava
  // insistir no aviso, nao o conteudo.
  console.log('\n=== registrarAgendamentoPendente: proximidade e divergencia de conteudo ===');
  {
    // Cenario A: reuniao marcada para daqui a 2h (dentro da janela de urgencia), pendencia sem NENHUM
    // valor divergente no modelo (a perna relatada ja bate com o banco) — so a proximidade justifica
    // reenviar o Telegram mesmo com o MESMO hash de conteudo.
    limpar();
    const bancoPerto = naiveDaquiA(2);
    const apuracaoPerto = { confirmado: false, horarioIso: null, cliente: null, equipe: { ...CONFIRMA, horario_iso: bancoPerto }, motivo: 'falta_cliente' };
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: bancoPerto,
      atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, apuracaoPerto);
    igual('reuniao perto (2h) + pendencia → 1a rodada: nenhuma nota, 1 Telegram', notas().length, 0);
    igual('   Telegram disparado', telegrams().length, 1);

    // Rodada seguinte, EXATAMENTE a mesma apuracao (mesmo hash de conteudo) — sem a escalada por
    // proximidade isso seria deduplicado em silencio, igual ao comportamento de antes desta mudanca.
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), apuracaoPerto);
    igual('   2a rodada, mesmo conteudo → continua sem nota', notas().length, 0);
    igual('   MAS o Telegram repete (bypass por proximidade)', telegrams().length, 2);
  }
  {
    // Cenario B: mesma pendencia, mas a reuniao esta longe (10 dias, fora da janela de urgencia) — o
    // dedup por hash tem que continuar funcionando normalmente (sem a escalada), senão vira ruido
    // diario pra toda pendencia de rotina.
    limpar();
    const bancoLonge = naiveDaquiA(24 * 10);
    const apuracaoLonge = { confirmado: false, horarioIso: null, cliente: null, equipe: { ...CONFIRMA, horario_iso: bancoLonge }, motivo: 'falta_cliente' };
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: bancoLonge,
      atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, apuracaoLonge);
    igual('reuniao longe (10 dias) → 1a rodada: nenhuma nota, 1 Telegram', notas().length, 0);
    igual('   Telegram disparado', telegrams().length, 1);

    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), apuracaoLonge);
    igual('   2a rodada, mesmo conteudo, longe → dedup normal (nenhum Telegram novo)', notas().length, 0);
    igual('   e NENHUM Telegram novo (sem escalada por proximidade)', telegrams().length, 1);
  }
  {
    // Cenario C (padrao Solange): a perna validada da equipe tem um horario CERTO mas DIFERENTE do
    // que esta na agenda — divergencia de conteudo, independente de proximidade (reuniao longe, sem
    // janela de urgencia). Nota/Telegram tem que citar os dois horarios explicitamente.
    limpar();
    // Ambos relativos a "agora" (nao datas fixas) e bem alem da janela de urgencia (48h) — o sistema
    // roda com o relogio em 2026, entao uma data fixa tipo "2026-08-16" podia cair PERTO o bastante
    // de "agora" pra disparar a escalada por proximidade sem querer, contaminando este teste.
    const bancoAntigo = naiveDaquiA(24 * 15);
    const horarioComunicado = naiveDaquiA(24 * 20); // longe, so pra isolar do teste de proximidade
    const apuracaoDivergente = { confirmado: false, horarioIso: null, cliente: null, equipe: { ...CONFIRMA, horario_iso: horarioComunicado }, motivo: 'falta_cliente' };
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: bancoAntigo,
      atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, apuracaoDivergente);
    igual('divergencia de conteudo → nenhuma nota, 1 Telegram', notas().length, 0);
    checar('   o Telegram cita o que esta na agenda', telegrams()[0].corpo.text.includes('Agenda atual'));
    checar('   e sinaliza a divergencia', telegrams()[0].corpo.text.includes('diferente do que foi comunicado'));
    checar('   o Telegram cita os dois horarios', telegrams()[0]?.corpo?.text?.includes('Agenda atual') && telegrams()[0]?.corpo?.text?.includes('Horário relatado'));

    // Mesma divergencia de novo → dedup por conteudo continua valendo (nao esta na janela de urgencia).
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), apuracaoDivergente);
    igual('   repetir a MESMA divergencia → continua sem nota', notas().length, 0);
    igual('   nenhum Telegram novo', telegrams().length, 1);
  }

  // ============================================================
  // reconciliarPendenciasAgendamento: rede de seguranca pra conversa que PAROU DE VEZ (sem mensagem
  // nova, a escalada por proximidade dentro do ciclo normal nunca roda pra ela — ver deal 48466404,
  // Teresinha, medido em 14/08/2026). NAO chama a OpenAI: so relê agendamento_pendente_hash.
  console.log('\n=== reconciliarPendenciasAgendamento: conversa silenciosa ===');
  {
    limpar();
    const hashPerto = `${naiveDaquiA(24 * 3)}|falta_cliente|C`; // 3 dias, dentro da janela (7 dias)
    semear(CHAT, { deal_id: 20, agendamento_pendente_hash: hashPerto });
    const r1 = await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('conversa silenciosa, horario dentro da janela → 1 Telegram', telegrams().length, 1);
    igual('   1 pendencia avisada no relatorio', r1.avisados.length, 1);
    igual('   banco: agendamento_pendencia_avisada grava o hash avisado', linha(CHAT).agendamento_pendencia_avisada, hashPerto);
    checar('   Telegram avisa que a conversa esta silenciosa', telegrams()[0]?.corpo?.text?.includes('SILENCIOSA'));

    // Mesmo hash, rodada seguinte → dedup (nada mudou desde o ultimo aviso).
    const r2 = await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('   rodar de novo com o MESMO hash → nenhum Telegram novo', telegrams().length, 1);
    igual('   0 pendencias no relatorio (ja avisado)', r2.avisados.length, 0);

    // Hash mudou (uma rodada real aconteceu de novo e ainda nao fechou) → avisa de novo.
    const hashNovo = `${naiveDaquiA(24 * 2)}|falta_cliente|C`;
    db.prepare('UPDATE conversations SET agendamento_pendente_hash = ? WHERE chat_id = ?').run(hashNovo, CHAT);
    await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('   hash mudou → avisa de novo', telegrams().length, 2);
  }
  {
    // Horario fora da janela de 7 dias — nao e urgente ainda, nao avisa.
    limpar();
    const hashLonge = `${naiveDaquiA(24 * 30)}|falta_equipe|C`;
    semear(CHAT, { deal_id: 20, agendamento_pendente_hash: hashLonge });
    const r = await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('horario fora da janela (30 dias) → nenhum Telegram', telegrams().length, 0);
    igual('   0 pendencias no relatorio', r.avisados.length, 0);
  }
  {
    // falta_ambos grava "null" no lugar do horario (ver registrarAgendamentoPendente) — nada pra medir
    // proximidade, tem que pular sem lancar erro.
    limpar();
    semear(CHAT, { deal_id: 20, agendamento_pendente_hash: 'null|falta_ambos|C' });
    const r = await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('falta_ambos sem horario → nenhum Telegram, sem erro', telegrams().length, 0);
    igual('   0 erros no relatorio', r.erros.length, 0);
  }
  {
    // Comprovante ja verificado pro deal → urgente INCONDICIONALMENTE, mesmo com horario fora da
    // janela (ou sem horario nenhum) — compromisso real, nao hipotese (padrao Teresinha: pagou e
    // perguntou o endereco do escritorio).
    limpar();
    const hashLonge = `${naiveDaquiA(24 * 30)}|falta_cliente|C`;
    semear(CHAT, { deal_id: 20, agendamento_pendente_hash: hashLonge });
    db.prepare('INSERT INTO comprovantes (chat_id, phone, deal_id, match) VALUES (?, ?, ?, 1)').run(CHAT, CHAT, 20);
    const r = await reconciliarPendenciasAgendamento({ aplicar: true });
    igual('comprovante verificado + horario longe → avisa mesmo assim', telegrams().length, 1);
    checar('   Telegram menciona o comprovante', telegrams()[0]?.corpo?.text?.includes('Comprovante JÁ verificado'));
    igual('   1 pendencia avisada, marcada com comprovante', r.avisados[0]?.comprovante, true);
    db.prepare('DELETE FROM comprovantes WHERE deal_id = 20').run(); // nao vazar pros testes seguintes
  }

  {
    // O horario que vale e o das observacoes, nao o dados.data_hora_consulta — que pode ter sido
    // herdado de uma rodada anterior pelo mergeDados.
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-01-01T08:00:00' }, CHAT, true, row, CONFIRMADO);
    igual('dupla confirmacao → 1 evento criado', agenda.insert.length, 1);
    // Regressao do bug "reuniao marcada muito cedo": o dateTime enviado tem que ser a string NAIVE
    // combinada, tal e qual, com o fuso do escritorio explicito ao lado — nao um valor calculado via
    // new Date(...).toISOString() (que dependeria do fuso do SO onde o processo roda, e por isso so
    // "passava" antes porque a maquina que roda o teste tambem esta em horario de Brasilia).
    igual('   o inicio e o horario CONFIRMADO, nao o herdado', agenda.insert[0].requestBody.start.dateTime, '2026-08-05T17:30:00');
    igual('   com o fuso do escritorio explicito (nao depende do fuso do SO)', agenda.insert[0].requestBody.start.timeZone, 'America/Fortaleza');
    igual('   duracao de 1h (tambem naive, mesmo timeZone)', agenda.insert[0].requestBody.end.dateTime, '2026-08-05T18:30:00');
    igual('   end tambem leva o timeZone', agenda.insert[0].requestBody.end.timeZone, 'America/Fortaleza');
    checar('   pede link do Meet (consulta online)', !!agenda.insert[0].requestBody.conferenceData);

    const r = linha(CHAT);
    igual('   banco: evento_calendar_criado', r.evento_calendar_criado, 1);
    igual('   banco: evento_calendar_id', r.evento_calendar_id, 'ev1');
    igual('   banco: evento_calendar_data = horario confirmado', r.evento_calendar_data, '2026-08-05T17:30:00');
    igual('   banco: hash de pendencia limpo', r.agendamento_pendente_hash, null);

    // Decisao de 02/09/2026: a confirmacao de sucesso do agendamento deixou de virar nota
    // (confirmacao de rotina) — o Telegram (notificarTelegramMeet) e quem avisa a equipe agora.
    checar('   nenhuma nota de "reuniao agendada" (confirmacao de rotina, nao vira mais nota)',
      !notas().some((n) => (n.corpo.description || '').includes('Reunião agendada no Google Calendar')),
      notas().map((n) => n.corpo.description));
  }

  {
    // Titulo e descricao do evento carregam o vinculo com o negocio para a rotina de notas de reuniao
    // (sincronizarNotasReuniao). Sem eles, identificar o deal depende do "Telefone:", que so existe em
    // evento criado pelo bot — a sondagem de 16/08/2026 mediu 1/3 das reunioes com notas nascendo de
    // evento criado a mao.
    //
    // Deal com id REALISTA (8 digitos) de proposito: a extracao exige no minimo 5 digitos depois do
    // "#", entao com o `deal_id: 20` dos outros cenarios a ida-e-volta abaixo nao seria exercida —
    // passaria sem testar nada.
    const DEAL = 48292471;
    limpar();
    const row = semear(CHAT, { deal_id: DEAL });
    await handleAgendamentoCalendar(DEAL, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    const criado = agenda.insert[0].requestBody;

    checar(`titulo do evento termina em · #${DEAL}`, criado.summary.endsWith(` · #${DEAL}`), criado.summary);
    checar('descricao do evento leva [deal:...]', criado.description.includes(`[deal:${DEAL}]`), criado.description);
    checar('   e mantem o "Telefone:" (identificacao antiga continua valendo)', criado.description.includes(`Telefone: ${CHAT}`));

    // O numero e SUFIXO, nunca prefixo: a rota que adiciona link do Meet reconhece consulta na agenda
    // com /^Consulta\s*—/ sobre o summary. Com o numero na frente ela pararia de enxergar qualquer
    // consulta, e sem erro nenhum — o pior modo de falha possivel.
    checar('   e o /^Consulta —/ da rota do Meet continua casando', /^Consulta\s*—/.test(criado.summary), criado.summary);

    // Ida e volta: o que o bot ESCREVE no titulo tem que ser o que o bot LE depois. E o contrato
    // entre montarResumoEvento (index.js) e extrairSinais (src/notas-reuniao.js), e nada mais o cobre:
    // cada metade tem teste proprio e as duas poderiam divergir em silencio.
    const sinais = notasReuniao.extrairSinais({ evento: { summary: criado.summary, description: criado.description } });
    igual('   o modulo de notas le esse titulo de volta', sinais.dealIdNoTitulo, DEAL);
    igual('   e a cascata resolve o negocio certo', notasReuniao.decidirDeal(sinais, {}).dealId, DEAL);

    // Mesmo contrato pelo ASSUNTO do e-mail, que reproduz o titulo entre aspas — este e o caminho que
    // dispensa achar o evento na agenda.
    const doAssunto = notasReuniao.extrairSinais({ evento: null, assunto: `Notas: "${criado.summary}" de 05/08/2026` });
    igual('   e le tambem pelo assunto, sem evento nenhum', doAssunto.dealIdNoTitulo, DEAL);

    // O RISCO das duas mudancas: sincronizarMetadadosEvento COMPARA o titulo e a descricao que monta
    // com os que estao no Google para decidir se da patch. Se a criacao e a comparacao derivassem o
    // dealId de fontes diferentes — por exemplo lendo do banco, onde stmtFinalizarCiclo so grava
    // DEPOIS deste ponto — toda rodada veria "mudou" e repatcharia o evento para sempre. Devolvendo o
    // evento recem-criado no GET, nenhum patch pode sair.
    agenda.respostaGet = { summary: criado.summary, description: criado.description };
    agenda.patch = [];
    await handleAgendamentoCalendar(DEAL, { ...DADOS }, CHAT, true, linha(CHAT), CONFIRMADO);
    igual('   evento inalterado → NENHUM patch (sem repatch infinito)', agenda.patch.length, 0);
    igual('   e nenhum evento novo', agenda.insert.length, 1);
  }

  {
    // Decisao de 02/09/2026: a confirmacao de sucesso deixou de virar nota — sem comprovante ou
    // com ele, o agendamento bem-sucedido nao posta nada no deal.
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, CONFIRMADO);
    checar('sem comprovante → tambem nenhuma nota de "reuniao agendada" (so o Telegram avisa)',
      !notas().some((n) => (n.corpo.description || '').includes('Reunião agendada no Google Calendar')),
      notas().map((n) => n.corpo.description));
  }
  {
    // Regressao principal do bug "reuniao marcada muito cedo": o horario enviado NAO pode depender
    // do fuso do sistema operacional onde o processo roda. Simula a VPS (Ubuntu cloud sem fuso
    // configurado, default UTC) mudando process.env.TZ em runtime — o V8 le essa variavel a cada
    // parse de Date, nao so no boot, entao isso realmente exercita o codigo como se estivesse la.
    limpar();
    process.env.TZ = 'UTC';
    try {
      const row = semear(CHAT, { deal_id: 20 });
      await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
      igual('processo em UTC → dateTime continua a string naive combinada (nao desloca)',
        agenda.insert[0].requestBody.start.dateTime, '2026-08-05T17:30:00');
      igual('   e o timeZone do escritorio vai explicito (e o Google que resolve, nao o bot)',
        agenda.insert[0].requestBody.start.timeZone, 'America/Fortaleza');
    } finally {
      delete process.env.TZ; // nao contaminar os testes seguintes
    }
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    const novoHorario = '2026-08-06T10:00:00';
    const confirmadoOutraHora = { ...CONFIRMADO, horarioIso: novoHorario };
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, confirmadoOutraHora);
    igual('horario realmente mudou → 1 PATCH com o novo horario naive + timeZone', agenda.patch.filter((p) => p.requestBody?.start).length, 1);
    igual('   start leva o novo horario', agenda.patch[0].requestBody.start.dateTime, novoHorario);
    igual('   com o fuso do escritorio', agenda.patch[0].requestBody.start.timeZone, 'America/Fortaleza');
    igual('   banco: evento_calendar_data atualizado', linha(CHAT).evento_calendar_data, novoHorario);
  }
  {
    // Idempotencia: mesmo horario que ja esta salvo (evento_calendar_data) nao gera PATCH nenhum —
    // sem isso, todo ciclo de reprocessamento (a cada 5 min enquanto a confirmacao continuar valida)
    // remarcaria a mesma reuniao pro mesmo horario, so gerando ruido.
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO); // mesmo horario de evento_calendar_data
    igual('horario igual ao salvo → nenhum PATCH de start/end', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS, modalidade_consulta: 'presencial' }, CHAT, true, row, CONFIRMADO);
    igual('presencial → sem conferenceData (nao gera Meet)', agenda.insert[0].requestBody.conferenceData, undefined);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS, email_cliente: 'cliente@exemplo.com' }, CHAT, true, row, CONFIRMADO);
    igual('email do cliente → vira convidado', agenda.insert[0].requestBody.attendees[0].email, 'cliente@exemplo.com');
    igual('   e o convite e enviado', agenda.insert[0].sendUpdates, 'all');
  }

  // ============================================================
  // MEDIDO em 12/08/2026 contra a API real: em /activities o UNICO parametro que pagina e `?start=`.
  // `page`, `pageToken`, `limit`, `offset`, `skip`, `from` sao todos ignorados EM SILENCIO — a
  // chamada responde 200 com a primeira pagina de novo. Um loop errado aqui nao quebra: rele os
  // mesmos 10 registros e parece ter varrido tudo, que foi exatamente o bug (a varredura enxergava
  // 10 achando que enxergava 100). Estas assercoes existem para ninguem voltar a esse padrao.
  console.log('\n=== listarAtividadesMoskit: pagina por ?start=, nao por page/pageToken ===');
  {
    limpar();
    const pagina = (ids) => ids.map((id) => ({ id, type: { id: moskitIds.ATIVIDADE_TIPO.reuniao } }));
    const lotes = [
      pagina([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), // pagina cheia (10) → ha mais
      pagina([20, 19, 18]),                    // incompleta → fim da lista
    ];
    let i = 0;
    rede.get = () => ({ status: 200, data: lotes[i++] || [], headers: {} });

    const { atividades, truncou } = await listarAtividadesMoskit();
    const gets = de('GET', '/activities');
    igual('para na primeira pagina incompleta', gets.length, 2);
    igual('   juntando os dois lotes', atividades.length, 13);
    igual('   a primeira pede start=0', gets[0].cfg.params.start, 0);
    igual('   a segunda avanca o offset pelo que ja veio', gets[1].cfg.params.start, 10);
    checar('   e nunca manda page nem pageToken (ambos ignorados por esta API)',
      gets.every((g) => g.cfg.params.page === undefined && g.cfg.params.pageToken === undefined),
      gets.map((g) => g.cfg.params));
    igual('   nao marca truncado quando a lista acabou sozinha', truncou, false);
  }
  {
    // Teto silencioso se leria como "varri tudo e nao achei nada" — exatamente o engano anterior.
    limpar();
    const cheia = Array.from({ length: 10 }, (_, k) => ({ id: k, type: { id: moskitIds.ATIVIDADE_TIPO.reuniao } }));
    rede.get = () => ({ status: 200, data: cheia, headers: {} });
    const { atividades, truncou } = await listarAtividadesMoskit(3);
    igual('teto de paginas respeitado', de('GET', '/activities').length, 3);
    igual('   e devolve o que deu tempo de varrer', atividades.length, 30);
    checar('   sinalizando que a varredura foi truncada', truncou === true, truncou);
  }
  {
    limpar();
    rede.get = () => ({ status: 500, data: null, headers: {} });
    const r = await listarAtividadesMoskit();
    igual('erro na primeira pagina → devolve lista vazia, nao lanca', r.atividades.length, 0);
  }

  // ============================================================
  // Helpers puros: sufixo/marcador de deal aplicados a um titulo/descricao que JA EXISTE (o que a
  // equipe digitou na Atividade do Moskit), e nao gerados do zero como montarResumoEvento faz.
  console.log('\n=== comSufixoDealId / comMarcadorDeal (idempotentes) ===');
  {
    igual('acrescenta o sufixo quando falta', comSufixoDealId('Consulta on-line- Fulano e Ciclano', 70), 'Consulta on-line- Fulano e Ciclano · #70');
    igual('nao duplica se ja tiver o sufixo', comSufixoDealId('Consulta on-line- Fulano e Ciclano · #70', 70), 'Consulta on-line- Fulano e Ciclano · #70');
    igual('sem dealId, titulo fica intacto', comSufixoDealId('Consulta on-line- Fulano e Ciclano', null), 'Consulta on-line- Fulano e Ciclano');
    igual('titulo vazio vira o placeholder padrao', comSufixoDealId(null, 70), 'Consulta agendada · #70');
  }
  {
    igual('acrescenta o marcador quando falta', comMarcadorDeal('nota da equipe', 70), 'nota da equipe\n\n[deal:70]');
    igual('nao duplica se ja tiver algum [deal:]', comMarcadorDeal('nota da equipe\n\n[deal:70]', 70), 'nota da equipe\n\n[deal:70]');
    igual('sem dealId, descricao fica intacta', comMarcadorDeal('nota da equipe', null), 'nota da equipe');
    igual('descricao vazia vira so o marcador', comMarcadorDeal('', 70), '[deal:70]');
  }

  // ============================================================
  // O mesmo sufixo/marcador que o fluxo completo do bot ja grava (montarResumoEvento/
  // montarDescricaoEvento) precisa chegar tambem em reunioes cuja Atividade nasceu DIRETO no Moskit
  // (equipe digitando na mao, ou Moskit Boost) — sem isso a rotina de notas de reuniao dependia so
  // dos metodos mais fracos da cascata (telefone/atividade/e-mail) pra essas reunioes, nunca do
  // metodo 1 (titulo com #dealId, "alta confianca").
  console.log('\n=== sincronizarAtividadesMoskit: #dealId/[deal:...] tambem para atividade criada direto no Moskit ===');
  const FUTURO = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const semearComprovante = (dealId) => db.prepare('INSERT INTO comprovantes (chat_id, phone, deal_id, match) VALUES (?, ?, ?, 1)').run(`teste-atv-${dealId}`, `teste-atv-${dealId}`, dealId);
  const atv = (id, dealId, extra = {}) => ({
    id, type: { id: moskitIds.ATIVIDADE_TIPO.videoconferencia }, dueDate: FUTURO, duration: 60,
    deals: dealId ? [{ id: dealId }] : [], title: 'Consulta on-line- Fulano e Ciclano', notes: 'nota da equipe',
    ...extra,
  });
  {
    // Branch "evento nativo", Meet JA existe: unica janela em que da pra enriquecer, porque depois
    // stmtAtividadeMarcarSincronizada tira a atividade da varredura pra sempre.
    limpar();
    rede.get = () => ({ status: 200, data: [atv(500170, 70)], headers: {} });
    agenda.respostaGet = { summary: 'Consulta on-line- Fulano e Ciclano', description: 'nota antiga', hangoutLink: 'https://meet.google.com/abc' };
    await sincronizarAtividadesMoskit();
    igual('evento nativo com Meet: um patch de titulo/descricao', agenda.patch.length, 1);
    igual('   titulo ganha o sufixo #dealId', agenda.patch[0]?.requestBody?.summary, 'Consulta on-line- Fulano e Ciclano · #70');
    igual('   descricao ganha o marcador [deal:...]', agenda.patch[0]?.requestBody?.description, 'nota antiga\n\n[deal:70]');
    checar('   patch NAO mexe em conferenceData (Meet ja existia)', agenda.patch[0]?.requestBody?.conferenceData === undefined, agenda.patch[0]);
  }
  {
    // Mesmo branch, mas sem dealId vinculado — nao pode inventar numero nem gerar patch a toa.
    limpar();
    rede.get = () => ({ status: 200, data: [atv(500171, null)], headers: {} });
    agenda.respostaGet = { summary: 'Consulta on-line- Fulano e Ciclano', description: 'nota antiga', hangoutLink: 'https://meet.google.com/abc' };
    await sincronizarAtividadesMoskit();
    igual('evento nativo com Meet, SEM deal vinculado: nenhum patch', agenda.patch.length, 0);
  }
  {
    // Branch "evento nativo", Meet AINDA nao existe: o numero entra no MESMO patch que cria o Meet.
    limpar();
    semearComprovante(71);
    rede.get = () => ({ status: 200, data: [atv(500172, 71)], headers: {} });
    agenda.respostaGet = { summary: 'Consulta presencial- Maria e Joao', description: '', hangoutLink: null, conferenceData: null };
    await sincronizarAtividadesMoskit();
    db.prepare('DELETE FROM comprovantes WHERE deal_id = 71').run();
    igual('evento nativo sem Meet: um patch so (cria o Meet e ja enriquece)', agenda.patch.length, 1);
    igual('   titulo ganha o sufixo #dealId', agenda.patch[0]?.requestBody?.summary, 'Consulta presencial- Maria e Joao · #71');
    igual('   descricao ganha o marcador [deal:...]', agenda.patch[0]?.requestBody?.description, '[deal:71]');
    checar('   conferenceData continua criando o Meet', !!agenda.patch[0]?.requestBody?.conferenceData?.createRequest);
  }
  {
    // Branch "Moskit ainda nao sincronizou": o bot cria o evento do zero (calendar.events.insert).
    limpar();
    semearComprovante(72);
    agenda.getDeveLancar = true; // simula 404: nao existe evento nativo "oll<id>"
    rede.get = () => ({ status: 200, data: [atv(500173, 72)], headers: {} });
    await sincronizarAtividadesMoskit();
    db.prepare('DELETE FROM comprovantes WHERE deal_id = 72').run();
    igual('atividade nao sincronizada: um evento criado', agenda.insert.length, 1);
    igual('   titulo ganha o sufixo #dealId', agenda.insert[0]?.requestBody?.summary, 'Consulta on-line- Fulano e Ciclano · #72');
    checar('   descricao contem o marcador [deal:...]', (agenda.insert[0]?.requestBody?.description || '').includes('[deal:72]'), agenda.insert[0]?.requestBody?.description);
    checar('   e ainda tem o link pro negocio (nao foi substituido, so acrescido)', (agenda.insert[0]?.requestBody?.description || '').includes('/deal/72'));
  }
  {
    // Mesmo branch, mas sem dealId: autorizacaoParaAgendar nem chega a liberar (motivo "sem_deal"),
    // entao nenhum evento e criado — comportamento inalterado, so confirma que o dealId nulo nao
    // quebra nada antes de chegar em comSufixoDealId/comMarcadorDeal.
    limpar();
    agenda.getDeveLancar = true;
    rede.get = () => ({ status: 200, data: [atv(500174, null)], headers: {} });
    await sincronizarAtividadesMoskit();
    igual('sem deal vinculado: nenhum evento criado (aguardando_pagamento)', agenda.insert.length, 0);
  }

  // ============================================================
  // A consulta tem que existir nas DUAS agendas. Ate 12/08/2026 o bot so criava o evento no Google e
  // uma nota no negocio: quem trabalha dentro do Moskit nao via consulta nenhuma na agenda do CRM.
  console.log('\n=== handleAgendamentoCalendar: a consulta na agenda do Moskit ===');
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);

    igual('dupla confirmacao → 1 atividade criada no Moskit', atividadesCriadas().length, 1);
    const corpo = atividadesCriadas()[0]?.corpo || {};
    igual('   vinculada ao deal', corpo.deals?.[0]?.id, 20);
    igual('   tipo Videoconferencia (consulta online)', corpo.type?.id, moskitIds.ATIVIDADE_TIPO.videoconferencia);
    igual('   responsavel e o usuario do bot', corpo.responsible?.id, moskitIds.LAYLA_USER_ID);
    igual('   titulo igual ao do evento do Google', corpo.title, agenda.insert[0].requestBody.summary);
    // O ponto mais facil de errar em silencio: o horario combinado e hora LOCAL do escritorio, e o
    // Moskit guarda instante absoluto. 17:30 em Fortaleza (UTC-3) = 20:30Z.
    igual('   dueDate e o instante absoluto do horario confirmado', corpo.dueDate, '2026-08-05T20:30:00.000Z');
    igual('   duracao de 1h, igual a do evento', corpo.duration, 60);

    igual('   banco: atividade_moskit_id guardado', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);

    // A REGRESSAO QUE IMPORTA: sincronizarAtividadesMoskit cria um evento no Google para toda
    // atividade de consulta futura que nao esteja nessa tabela. Sem esta linha, o proprio bot criaria
    // um SEGUNDO evento para a mesma consulta no ciclo seguinte (a cada SYNC_INTERVAL_MS).
    const marca = sincronizada(ID_ATIVIDADE);
    checar('   atividade ja entra marcada como sincronizada (trava anti-evento-duplicado)', !!marca);
    igual('   apontando para o evento que o bot acabou de criar', marca?.evento_calendar_id, 'ev1');
    igual('   e para o deal', marca?.deal_id, 20);

    // Decisao de 02/09/2026: a confirmacao de sucesso deixou de virar nota — a trava
    // anti-evento-duplicado acima e o Telegram (notificarTelegramMeet) e que provam que funcionou.
    // (Outras notas de PENDENCIA, ex. contrato faltando dados, continuam existindo — nao e o caso
    // que este teste verifica.)
    checar('   nenhuma nota de "reuniao agendada" (confirmacao de rotina, nao vira mais nota)',
      !notas().some((n) => (n.corpo.description || '').includes('Reunião agendada no Google Calendar')),
      notas().map((n) => n.corpo.description));
  }
  {
    // MEDIDO em 14/08/2026 contra a API real (deals 48474073 e 48464876): o Moskit devolveu 2xx com id
    // no POST /activities, mas a atividade criada nunca ficou vinculada ao negocio (so ao contato) —
    // exatamente quando o negocio tinha acabado de ser escrito. Isso era 100% silencioso: o 2xx com id
    // passava como sucesso e ninguem no escritorio saberia que a atividade sumiu da tela do negocio.
    limpar();
    rede.get = (url) => ({
      status: 200,
      data: url.includes('/activities/') ? { id: ID_ATIVIDADE, deals: [], contacts: [{ id: 999 }] } : { stage: { id: 179388 } },
    });
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);

    igual('atividade criada mas o Moskit nao vinculou ao deal → confere com 1 GET', de('GET', `/activities/${ID_ATIVIDADE}`).length, 1);
    igual('   e religa com 1 PUT', atividadesRemarcadas().length, 1);
    igual('   o PUT manda deals com o deal certo', atividadesRemarcadas()[0]?.corpo?.deals?.[0]?.id, 20);
    checar('   e preserva o que ja estava na atividade (ex.: contacts do GET)', atividadesRemarcadas()[0]?.corpo?.contacts?.[0]?.id === 999);
    igual('   banco: atividade_moskit_id guardado mesmo assim (a cura funcionou)', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);
    checar('   NENHUMA nota de "sem vinculo" (a cura silenciosa resolveu antes de avisar)',
      !notas().some((n) => n.corpo.description.includes('NAO ficou vinculada')));
  }
  {
    // Mesmo cenario, mas agora a religacao TAMBEM falha (Moskit fora do ar no PUT) — isso nao pode
    // ficar silencioso: nota no deal + Telegram, igual ao padrao ja usado para falha de criacao.
    limpar();
    rede.get = (url) => ({
      status: 200,
      data: url.includes('/activities/') ? { id: ID_ATIVIDADE, deals: [] } : { stage: { id: 179388 } },
    });
    rede.put = (url) => (url.includes('/activities/') ? { status: 500, data: {} } : { status: 200, data: {} });
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);

    igual('religacao tambem falha → banco AINDA guarda o atividade_moskit_id (existe, so nao vinculada)', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);
    igual('   nenhuma nota (aviso de vinculo agora so no Telegram)', notas().length, 0);
    checar('   o Telegram avisa que a atividade NAO ficou vinculada ao negocio',
      telegrams().some((t) => JSON.stringify(t.corpo).includes('vínculo com o negócio')));
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS, modalidade_consulta: 'presencial' }, CHAT, true, row, CONFIRMADO);
    // Precisa concordar com o evento do Google, que nesse caso nasce sem Meet: consulta presencial
    // marcada como Videoconferencia manda a equipe procurar um link que nao existe.
    igual('presencial → tipo Reuniao', atividadesCriadas()[0]?.corpo.type?.id, moskitIds.ATIVIDADE_TIPO.reuniao);
    checar('   e a nota da atividade nao promete link de Meet', !atividadesCriadas()[0]?.corpo.notes.includes('Meet'));
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, SO_CLIENTE);
    igual('sem dupla confirmacao → NENHUMA atividade no Moskit', atividadesCriadas().length, 0);
  }
  {
    // Idempotencia: o ramo "evento ja existe" roda em todo ciclo enquanto a confirmacao valer.
    limpar();
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1',
      evento_calendar_data: '2026-08-05T17:30:00', atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('conversa que ja tem atividade → nao cria outra', atividadesCriadas().length, 0);
    igual('   e nao remarca (horario nao mudou)', atividadesRemarcadas().length, 0);
  }
  {
    limpar();
    const novoHorario = '2026-08-06T10:00:00';
    // Corpo que o GET da atividade devolve — o PUT tem que reenviar isto inteiro (ver assercao
    // abaixo). Os outros GETs (deal, em moverEstagioSeAvancar) seguem no dublê padrão.
    const ATIVIDADE_NO_CRM = {
      id: ID_ATIVIDADE, title: 'Consulta — Fulano de Tal (Bruno)', type: { id: moskitIds.ATIVIDADE_TIPO.videoconferencia },
      dueDate: '2026-08-05T20:30:00.000Z', duration: 60, deals: [{ id: 20 }], responsible: { id: moskitIds.LAYLA_USER_ID },
    };
    rede.get = (url) => ({ status: 200, data: url.includes('/activities/') ? ATIVIDADE_NO_CRM : { stage: { id: 179388 } } });
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1',
      evento_calendar_data: '2026-08-05T17:30:00', atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, { ...CONFIRMADO, horarioIso: novoHorario });
    igual('remarcacao → 1 PUT na atividade', atividadesRemarcadas().length, 1);
    checar('   na atividade certa', atividadesRemarcadas()[0].url.endsWith(`/activities/${ID_ATIVIDADE}`), atividadesRemarcadas()[0].url);
    // MEDIDO em 12/08/2026 contra a API real: `/activities` tem a mesma peculiaridade do PUT de deal
    // — `{dueDate}` sozinho volta 422. Sem reenviar o corpo do GET, NENHUMA remarcacao chega ao CRM.
    igual('   le a atividade antes de escrever', de('GET', `/activities/${ID_ATIVIDADE}`).length, 1);
    checar('   e o PUT reenvia o corpo do GET (payload minimo volta 422 na API real)',
      atividadesRemarcadas()[0].corpo.title === ATIVIDADE_NO_CRM.title
      && atividadesRemarcadas()[0].corpo.type?.id === ATIVIDADE_NO_CRM.type.id
      && atividadesRemarcadas()[0].corpo.duration === 60,
      atividadesRemarcadas()[0].corpo);
    // 10:00 em Fortaleza = 13:00Z. As duas agendas movem juntas; se so o Google mover, a agenda do
    // CRM continua mostrando o horario velho — que parece certo e esta errado.
    igual('   com o novo horario como instante absoluto', atividadesRemarcadas()[0].corpo.dueDate, '2026-08-06T13:00:00.000Z');
    // Decisao de 02/09/2026: a remarcacao bem-sucedida deixou de virar nota — o PUT na atividade
    // acima e o Telegram (notificarTelegramMeet) e que provam que as duas agendas moveram juntas.
    checar('   nenhuma nota de "reuniao remarcada" (confirmacao de rotina, nao vira mais nota)',
      !notas().some((n) => (n.corpo.description || '').includes('Reunião remarcada para')),
      notas().map((n) => n.corpo.description));
  }
  {
    // Conversa com evento no Google mas sem Atividade no Moskit — o caso real achado em 14/08/2026
    // (deals 48447661, 48287898): 21 de 27 consultas tinham esse gap porque este ramo (evento JA
    // existia) nunca tentava criar a Atividade que falta, so remarcava a que ja existisse. Auto-cura:
    // agora tenta criar (idempotente via registrarConsultaNaAgendaMoskit), e isso nao pode impedir a
    // remarcacao no Google.
    limpar();
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1',
      evento_calendar_data: '2026-08-05T17:30:00',
    });
    // Este cenario tambem remarca NO MESMO CICLO em que a auto-cura cria a atividade (evento ja
    // existia em 2026-08-05, a dupla confirmacao desta rodada fecha em 2026-08-06T10:00:00) — a RACE
    // medida ao investigar este mesmo fix: `row` e o snapshot lido ANTES do ciclo, entao sem
    // atualizar row.atividade_moskit_id logo apos a auto-cura criar, atualizarEventoSeRemarcado (que
    // usa o MESMO `row`) nunca via a atividade recem-nascida e a deixava presa no dia 05, mesmo com o
    // Google Agenda ja no dia 06.
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, { ...CONFIRMADO, horarioIso: '2026-08-06T10:00:00' });
    igual('   TENTA CRIAR a atividade que falta (auto-cura)', atividadesCriadas().length, 1);
    // A atividade acabou de nascer (deal + atividade quase no mesmo instante) — exatamente o cenario
    // medido em 14/08/2026 (deals 48474073/48464876) em que o Moskit as vezes nao persiste o vinculo
    // `deals` do POST. garantirVinculoAtividadeDeal confere e religa: 1o GET + 1o PUT (sem dueDate,
    // so com `deals`).
    const putsVinculo = atividadesRemarcadas().filter((p) => !p.corpo?.dueDate);
    const putsRemarcacao = atividadesRemarcadas().filter((p) => p.corpo?.dueDate);
    igual('   confere/religa o vinculo com o deal: 1 PUT so com `deals`', putsVinculo.length, 1);
    igual('     no deal certo', putsVinculo[0]?.corpo?.deals?.[0]?.id, 20);
    // E, por causa da remarcacao no mesmo ciclo, um 2o PUT move o dueDate da atividade que acabou de
    // nascer — sem o refresh de row.atividade_moskit_id apos a auto-cura, este PUT nao acontecia e a
    // atividade ficava presa no horario antigo (05/08) enquanto o Google Agenda ja ia pro dia 06.
    igual('   E remarca a atividade recem-criada pro novo horario: 1 PUT com dueDate', putsRemarcacao.length, 1);
    igual('     10:00 em Fortaleza = 13:00Z', putsRemarcacao[0]?.corpo?.dueDate, '2026-08-06T13:00:00.000Z');
    igual('   banco: atividade_moskit_id passa a existir', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);
    checar('   e entra na trava anti-duplicado', !!sincronizada(ID_ATIVIDADE));
    // Decisao de 02/09/2026: a auto-cura e a remarcacao bem-sucedidas deixaram de virar nota — os
    // PUTs de vinculo e remarcacao acima ja provam que a atividade nasceu e foi movida corretamente.
    checar('   nenhuma nota de "atividade criada agora" nem "reuniao remarcada"',
      !notas().some((n) => /foi criada agora|Reunião remarcada para/.test(n.corpo.description || '')),
      notas().map((n) => n.corpo.description));
    igual('   e o evento do Google e remarcado normalmente', agenda.patch.filter((p) => p.requestBody?.start).length, 1);
  }
  {
    // A auto-cura acima tem que ser idempotente: se a Atividade ja existe, nao tenta criar de novo
    // nem posta a nota de "foi criada agora".
    limpar();
    const row = semear(CHAT, {
      deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1',
      evento_calendar_data: '2026-08-05T17:30:00', atividade_moskit_id: ID_ATIVIDADE,
    });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('atividade ja existe → auto-cura nao cria outra', atividadesCriadas().length, 0);
    checar('   e nao posta a nota de "foi criada agora"',
      !notas().some((n) => n.corpo.description.includes('foi criada agora')));
  }
  {
    // Falha na agenda do CRM nao pode derrubar o resto do agendamento: o evento no Google ja existe e
    // o contrato/estagio dependem de o fluxo continuar.
    limpar();
    rede.post = (url) => {
      if (url.includes('/activities')) throw new Error('Moskit fora do ar');
      return { status: 200, data: {} };
    };
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('POST /activities falhou → o evento do Google foi criado assim mesmo', agenda.insert.length, 1);
    igual('   banco: atividade_moskit_id fica nulo (proximo ciclo nao tenta de novo, ver Telegram)', linha(CHAT).atividade_moskit_id, null);
    checar('   um Telegram avisa que a consulta NAO entrou na agenda do Moskit',
      telegrams().some((t) => t.corpo.text.includes('NAO entrou na agenda do Moskit')));
    checar('   e nenhuma atividade fica marcada como sincronizada', !sincronizada(ID_ATIVIDADE));
  }
  {
    // 2xx sem id e tao inutil quanto um erro: sem id nao da pra remarcar nem pra travar o duplicado.
    limpar();
    rede.post = (url) => ({ status: 200, data: url.includes('/activities') ? {} : {} });
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('POST /activities 200 sem id → tratado como falha', linha(CHAT).atividade_moskit_id, null);
    checar('   com aviso no negocio', telegrams().some((t) => t.corpo.text.includes('NAO entrou na agenda do Moskit')));
  }

  // "consulta_agendada" ficou orfa desde que foi mapeada em MOSKIT_STAGE_MAP: nada disparava o
  // avanco pra la (estagio_funil_sugerido, na IA, so cobre o que vem DEPOIS da consulta). Deal
  // 48346871 (Natanael) foi o caso real que expos isso — reprocessar aquele chat com este codigo
  // deve mover o deal sem eu tocar manualmente nele.
  {
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 179388 } } }); // ainda em "agendamento"
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    checar('evento criado agora + estagio anterior → avanca pra "consulta agendada"',
      telegrams().some((t) => t.corpo.text.includes('Avanço de estágio sugerido')), telegrams());
  }
  {
    // Ramo que faltava cobertura: evento JA existia (nao e criado de novo) e a dupla confirmacao
    // continua valida — atualizarEventoSeRemarcado roda E o avanco de estagio tambem tem que rodar.
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 179388 } } });
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-05T17:30:00' }, CHAT, true, row, CONFIRMADO);
    checar('evento que ja existia + dupla confirmacao valida → tambem avanca',
      telegrams().some((t) => t.corpo.text.includes('Avanço de estágio sugerido')), telegrams());
  }
  {
    // Guarda de prioridade: deal ja avancou alem de "consulta agendada" (ex: aguardando_condicao,
    // priority 5) — moverEstagioSeAvancar tem que ignorar antes de chegar no dry-run.
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 285584 } } }); // aguardando_condicao
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    checar('deal ja avancado → NENHUM Telegram de "consulta agendada"',
      !telegrams().some((t) => t.corpo.text.includes('Avanço de estágio sugerido')), telegrams());
  }
  {
    // Marcar como criado sem evento faria o bot achar que a consulta esta na agenda quando nao esta —
    // e nunca mais tentar. Aqui o insert responde vazio (falha REAL da API do Google, nao formato de
    // data invalido) — e desde a mudanca de 14/08/2026 (deal 48474073: as duas agendas ficaram vazias
    // com essa unica falha) a Atividade do Moskit tem que nascer mesmo assim, e o estagio avanca,
    // porque a consulta ESTA marcada em pelo menos uma agenda de verdade.
    limpar();
    agenda.respostaInsert = null;
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('Google falhou → banco NAO marca evento_calendar_criado', linha(CHAT).evento_calendar_criado, 0);
    igual('   sem evento_calendar_id', linha(CHAT).evento_calendar_id, null);
    igual('   MAS a Atividade do Moskit foi criada mesmo assim (desacoplado do Google)', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);
    checar('   e entra na trava anti-duplicado (sem apontar pra nenhum evento)', !!sincronizada(ID_ATIVIDADE));
    igual('   nenhuma nota (Google/Moskit combinado agora so no Telegram)', notas().length, 0);
    checar('   1 Telegram avisando que a consulta JA ENTROU no Moskit mas o Google falhou',
      telegrams().some((t) => t.corpo.text.includes('NÃO agendada') && t.corpo.text.includes("reading 'htmlLink'") && t.corpo.text.includes('JÁ ENTROU')), telegrams());
    checar('   e o estagio AVANCA (a atividade do Moskit conta como consulta marcada)',
      telegrams().some((t) => t.corpo.text.includes('Avanço de estágio sugerido')));
  }
  {
    // Os DOIS falham: Google (falha real de API) e a Atividade do Moskit tambem. Nem estagio nem
    // contrato podem disparar — a consulta nao esta marcada em agenda nenhuma de verdade — mas as
    // duas falhas tem que gerar nota (criarAtividadeMoskit posta a dela, registrarErroAgendamento
    // posta a do Google), sem crash.
    limpar();
    agenda.respostaInsert = null;
    rede.post = (url) => {
      if (url.includes('/activities')) throw new Error('Moskit fora do ar');
      return { status: 200, data: {} };
    };
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('os dois falharam → atividade_moskit_id continua nulo', linha(CHAT).atividade_moskit_id, null);
    igual('   evento_calendar_criado continua 0', linha(CHAT).evento_calendar_criado, 0);
    igual('   nenhuma nota (falhas agora so avisam no Telegram)', notas().length, 0);
    checar('   Telegram de falha da Atividade (criarAtividadeMoskit)',
      telegrams().some((t) => t.corpo.text.includes('NAO entrou na agenda do Moskit')));
    checar('   Telegram de falha do agendamento (Google) — NEM Google NEM Moskit',
      telegrams().some((t) => t.corpo.text.includes("reading 'htmlLink'") && t.corpo.text.includes('NEM no Google NEM no Moskit')));
    checar('   e SEM avanco de estagio (nada foi marcado em agenda nenhuma)',
      !telegrams().some((t) => t.corpo.text.includes('Avanço de estágio sugerido')));
  }
  {
    // Horario invalido com dupla confirmacao VALIDA nao pode ser silencioso. Antes era `return null`
    // mudo e o escritorio nao ficava sabendo: cliente e equipe combinaram, nao existe reuniao, e a
    // unica pista era uma linha de console repetida a cada ciclo de 5 min. Foi assim que o caso do
    // deal 48370184 (Arthur) passou batido. Agora lanca, e o catch de handleAgendamentoCalendar vira
    // nota no deal + Telegram.
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    const apuracaoRuim = { ...CONFIRMADO, horarioIso: 'amanha de tarde' };
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, apuracaoRuim);
    igual('horario invalido → nenhum evento, sem crash', agenda.insert.length, 0);
    igual('   banco intocado', linha(CHAT).evento_calendar_criado, 0);
    igual('   1 Telegram de FALHA (a equipe fica sabendo)', telegrams().length, 1);
    checar('   o Telegram cita o valor recusado', telegrams()[0].corpo.text.includes('amanha de tarde'));
    igual('   e nenhuma nota (Telegram e o unico canal agora)', notas().length, 0);
  }
  {
    // Eco da data-ancora: o valor que o modelo copiou da "ultima mensagem desta conversa" e o defeito
    // que colocou 3 reunioes reais em horario errado (deals 48370184, 48407621, 48177138). Com Z ou
    // com segundos, nao pode virar evento — e tem que avisar.
    for (const ruim of ['2026-08-10T18:54:58.000Z', '2026-08-10T18:54:58', '2026-08-07T09:00:00-03:00']) {
      limpar();
      const row = semear(CHAT, { deal_id: 20 });
      await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, { ...CONFIRMADO, horarioIso: ruim });
      igual(`eco "${ruim}" → nenhum evento`, agenda.insert.length, 0);
      igual('   com Telegram de falha', telegrams().length, 1);
    }
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, undefined);
    igual('apuracao ausente → trata como nao confirmado', agenda.insert.length, 0);
  }

  // ============================================================
  console.log('\n=== finalizarCiclo ===');
  {
    // Regressao: o ramo "nota" usava um UPDATE que nao gravava deal_id, entao a conversa ficava sem
    // vinculo com o negocio e a rodada seguinte criava outro.
    limpar();
    const row = semear(CHAT, { deal_id: null });
    await finalizarCiclo({
      dealId: 123, dados: {}, dadosMesclados: { nome: 'Fulano' }, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok',
    });
    const r = linha(CHAT);
    igual('acao "nota" grava deal_id', r.deal_id, 123);
    igual('   last_action', r.last_action, 'nota');
    igual('   processed = 1', r.processed, 1);
    igual('   last_data', r.last_data, JSON.stringify({ nome: 'Fulano' }));
    checar('   last_processed_at preenchido', !!r.last_processed_at);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({ dealId: 123, dados: {}, dadosMesclados: {}, chatId: CHAT, row, apuracao: NADA, acao: 'nota', resumo: 'ok' });
    igual('sem estagio sugerido → nao consulta o funil', de('GET', '/deals/123').length, 0);
  }
  {
    // FUNIL_DRY_RUN=true no .env: a IA sugere, o bot anota, ninguem move nada.
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 179388 } } });
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { estagio_funil_sugerido: 'negociacao' }, dadosMesclados: {}, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok',
    });
    igual('estagio sugerido em dry-run → NENHUM PUT', de('PUT', '/deals/123').length, 0);
    igual('   nenhuma nota (sugestao agora so no Telegram)', notas().length, 0);
    igual('   so um Telegram de sugestao', telegrams().length, 1);
    checar('   marcado como dry-run', telegrams()[0].corpo.text.includes('dry-run'));
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 179388 } } });
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { estagio_funil_sugerido: 'estagio_que_nao_existe' }, dadosMesclados: {}, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok',
    });
    igual('estagio desconhecido → no-op silencioso, sem crash', rede.chamadas.length, 0);
    igual('   e o ciclo persiste do mesmo jeito', linha(CHAT).processed, 1);
  }

  // ============================================================
  console.log('\n=== fecharNegocioSeAplicavel (via finalizarCiclo) ===');
  {
    // Sem observacao validada correspondente, o campo solto do modelo NAO basta — mesmo espirito de
    // pagamento_confirmado exigir comprovante em vez de confiar na alegacao pura.
    limpar();
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { status_negocio_sugerido: 'ganho' }, dadosMesclados: {}, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok', obsValidas: [],
    });
    igual('status sugerido sem evidencia validada → nenhuma chamada ao Moskit', rede.chamadas.length, 0);
  }
  {
    // FUNIL_FECHAMENTO_DRY_RUN=true (fixado no topo do arquivo): so anota, nao fecha de verdade.
    limpar();
    rede.get = () => ({ status: 200, data: { status: 'OPEN', stage: { id: 179386 } } });
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { status_negocio_sugerido: 'ganho' }, dadosMesclados: { nome: 'Fulano de Tal' }, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok',
      obsValidas: [{ tipo: 'equipe_declarou_ganho', msg_idx: 0, trecho: 'assinou o contrato' }],
    });
    igual('ganho em dry-run → NENHUM PUT', de('PUT', '/deals/123').length, 0);
    igual('   nenhuma nota (sugestao agora so no Telegram)', notas().length, 0);
    const tg = telegrams()[0]?.corpo?.text || '';
    checar('   marcado como dry-run', tg.includes('dry-run'));
    checar('   o Telegram avisa com o nome do cliente', tg.includes('Fulano de Tal'));
    checar('   ...com o telefone', tg.includes(CHAT));
    checar('   ...com o deal id', tg.includes('123'));
    checar('   ...e o resultado sugerido', tg.includes('ganho'));
    checar('   ...e pede revisao manual', tg.includes('Revisão manual'));
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { status: 'OPEN', stage: { id: 182159 } } });
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { status_negocio_sugerido: 'perdido', motivo_perda_sugerido: 'fechou com outro escritorio' },
      dadosMesclados: { nome: 'Fulano de Tal' }, chatId: CHAT, row, apuracao: NADA, acao: 'nota', resumo: 'ok',
      obsValidas: [{ tipo: 'cliente_declarou_perdido', msg_idx: 0, trecho: 'vou contratar outro advogado' }],
    });
    igual('perdido (evidencia do CLIENTE) em dry-run → NENHUM PUT', de('PUT', '/deals/123').length, 0);
    igual('   nenhuma nota (sugestao agora so no Telegram)', notas().length, 0);
    const tgPerdido = telegrams()[0]?.corpo?.text || '';
    checar('   o Telegram avisa o resultado "perdido"', tgPerdido.includes('perdido'));
    checar('   ...com o motivo', tgPerdido.includes('fechou com outro escritorio'));
  }
  {
    // Invariante mais importante: um deal ja fechado nunca e reaberto nem refechado, mesmo com
    // evidencia valida pro lado contrario.
    limpar();
    rede.get = () => ({ status: 200, data: { status: 'WON', stage: { id: 179386 } } });
    const row = semear(CHAT, { deal_id: 123 });
    await finalizarCiclo({
      dealId: 123, dados: { status_negocio_sugerido: 'perdido' }, dadosMesclados: {}, chatId: CHAT, row,
      apuracao: NADA, acao: 'nota', resumo: 'ok',
      obsValidas: [{ tipo: 'equipe_declarou_perdido', msg_idx: 0, trecho: 'nao vamos seguir com esse caso' }],
    });
    igual('deal ja WON → nenhuma nota, nenhum PUT (nunca reabre/refecha)', rede.chamadas.filter((c) => c.metodo !== 'GET').length, 0);
  }

  // ============================================================
  // Regressao do deal 48423360, parte 1: a area do direito era deduzida do SOCIO que o lead
  // mencionou. Conversa real: "Olá / Bom dia / Tudo bem? / Gostaria de agendar uma consulta com o
  // Dr. Berto" => a IA devolvia area="LGPD" e assunto="Direito Digital".
  console.log('\n=== gate do caso descrito: sem caso contado, nada de area/assunto adivinhados ===');
  const OBS_CASO = [{ tipo: 'cliente_descreveu_caso', msg_idx: 2, trecho: 'remocao por motivo de saude' }];
  {
    const dados = { nome: 'Martha Luiza', area_direito: 'LGPD', advogado_responsavel: 'Berto', captacao: 'Berto', origem: 'Instagram', assunto: 'Direito Digital' };
    const { casoDescrito } = aplicarGateCasoDescrito(dados, []);
    igual('sem evidencia de caso → casoDescrito false', casoDescrito, false);
    igual('   area_direito zerada (era o palpite "LGPD")', dados.area_direito, null);
    igual('   advogado_responsavel zerado', dados.advogado_responsavel, null);
    igual('   assunto que era nome de area zerado', dados.assunto, null);
    igual('   captacao preservada (vem da mensagem, nao de palpite sobre o caso)', dados.captacao, 'Berto');
    igual('   origem preservada', dados.origem, 'Instagram');
  }
  {
    const dados = { area_direito: 'LGPD', assunto: 'Consulta jurídica' };
    aplicarGateCasoDescrito(dados, []);
    igual('assunto neutro (o placeholder do prompt) sobrevive ao gate', dados.assunto, 'Consulta jurídica');
  }
  {
    const dados = { area_direito: 'Direito Administrativo', advogado_responsavel: 'Berto', assunto: 'Remoção por motivo de saúde' };
    const { casoDescrito } = aplicarGateCasoDescrito(dados, OBS_CASO);
    igual('com caso descrito → casoDescrito true', casoDescrito, true);
    igual('   area preservada', dados.area_direito, 'Direito Administrativo');
    igual('   assunto preservado', dados.assunto, 'Remoção por motivo de saúde');
  }
  {
    const dados = { area_direito: 'Direito Administrativo', assunto: 'Remoção' };
    aplicarGateCasoDescrito(dados, [{ tipo: 'equipe_descreveu_caso', msg_idx: 3, trecho: 'acao de remocao' }]);
    igual('caso descrito pela EQUIPE tambem autoriza a area', dados.area_direito, 'Direito Administrativo');
  }
  {
    // mergeDados nao sobrescreve com null: uma area boa de um ciclo anterior sobrevive a uma rodada
    // em que o modelo esqueceu de emitir a evidencia.
    const dados = { area_direito: 'LGPD' };
    aplicarGateCasoDescrito(dados, []);
    igual('area anterior sobrevive ao gate via mergeDados', mergeDados({ area_direito: 'Direito Administrativo' }, dados).area_direito, 'Direito Administrativo');
  }
  {
    const NADA_CONF = { confirmado: false, motivo: 'falta_ambos' };
    const CONF = { confirmado: true, horarioIso: '2026-08-12T14:00:00' };
    igual('criar sem caso descrito → espera (nada vai pro CRM)', deveEsperarCasoDescrito('criar', false, NADA_CONF, false), true);
    igual('criar com caso descrito → segue', deveEsperarCasoDescrito('criar', true, NADA_CONF, false), false);
    igual('sem caso mas com dupla confirmacao → segue (a agenda depende do dealId)', deveEsperarCasoDescrito('criar', false, CONF, false), false);
    igual('sem caso mas com bloco de condicoes → segue (consulta ja cobrada)', deveEsperarCasoDescrito('criar', false, NADA_CONF, true), false);
    igual('acao "nota" nao e afetada pelo gate', deveEsperarCasoDescrito('nota', false, NADA_CONF, false), false);
    igual('acao "atualizar_campos" nao e afetada', deveEsperarCasoDescrito('atualizar_campos', false, NADA_CONF, false), false);
  }

  console.log('\n=== gate dos campos obrigatorios: criar sem os 5 completos espera ===');
  {
    const NADA_CONF = { confirmado: false, motivo: 'falta_ambos' };
    const CONF = { confirmado: true, horarioIso: '2026-08-12T14:00:00' };
    const COMPLETOS = { assunto: 'Guarda', origem: 'Instagram', tipo_consulta: 'consulta paga', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno' };
    const FALTA_UM = { ...COMPLETOS, advogado_responsavel: null };

    igual('nenhum campo preenchido, sem gatilho forte → espera', deveEsperarCamposObrigatorios({}, NADA_CONF, false), true);
    igual('falta so 1 campo, sem gatilho forte → espera', deveEsperarCamposObrigatorios(FALTA_UM, NADA_CONF, false), true);
    igual('os 5 completos → segue', deveEsperarCamposObrigatorios(COMPLETOS, NADA_CONF, false), false);
    igual('incompleto mas com dupla confirmacao de horario → segue (agenda/Meet/ZapSign dependem do dealId)', deveEsperarCamposObrigatorios(FALTA_UM, CONF, false), false);
    igual('incompleto mas com bloco de condicoes enviado → segue (consulta ja cobrada)', deveEsperarCamposObrigatorios(FALTA_UM, NADA_CONF, true), false);
    igual('assunto placeholder neutro conta como pendente aqui tambem', deveEsperarCamposObrigatorios({ ...COMPLETOS, assunto: ASSUNTO_NEUTRO }, NADA_CONF, false), true);
  }

  // ============================================================
  // Teste de integracao via processarConversaDirect: prova que o WIRING (o ponto exato onde o gate
  // entra, ANTES de buscarOuCriarContato) funciona de ponta a ponta, nao so a funcao pura isolada
  // acima. A excecao de dupla confirmacao de horario ja esta coberta so no teste unitario (simular
  // apuracao.confirmado de verdade via pipeline exigiria reconstruir toda a cadeia de observacoes de
  // horario com mensagens realistas — redundante com o que a funcao pura ja prova isoladamente); a
  // excecao do bloco de condicoes E testada aqui porque e barata (so uma mensagem com o texto padrao).
  console.log('\n=== gate dos campos obrigatorios: bloqueio de ponta a ponta via processarConversaDirect ===');
  {
    const CHAT_INCOMPLETO = '5586999990098';
    const MSGS_INCOMPLETO = [
      { role: 'cliente', text: 'Boa tarde, gostaria de saber sobre um caso de inventario', timestamp: '2026-08-01T10:00:00Z' },
    ];
    const CLASSIFICACAO_OK = { classificacao: 'criar_negocio', justificativa: 'lead viavel' };
    // Falta "tipo_consulta" de proposito: e um dos campos que hoje NAO tem gate nenhum (junto de
    // origem — mas origem tem fallback automatico em mesclarParaCrm que forca "Nao identificado"
    // quando fica vazia, entao nunca chega vazia neste ponto; tipo_consulta nao tem esse fallback e
    // e um alvo real do gate).
    const extracaoIncompleta = () => ({
      acao: 'criar', justificativa: 'caso descrito, falta tipo_consulta', confianca: 9,
      dados: { nome: 'Marcos', assunto: 'Inventario', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno', tipo_consulta: null, origem: 'Instagram' },
      observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 0, trecho: 'caso de inventario' }],
    });

    // ---- sem gatilho forte: bloqueia, nenhum deal nem contato criados ----
    limpar();
    db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(CHAT_INCOMPLETO);
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(CHAT_INCOMPLETO);
    semear(CHAT_INCOMPLETO, { messages: JSON.stringify(MSGS_INCOMPLETO) });
    rede.get = (url) => (url.includes('/contacts') || url.includes('/deals') ? { status: 200, data: [] } : { status: 200, data: {} });
    openai.respostas = [CLASSIFICACAO_OK, extracaoIncompleta()];
    openai.prompts = [];
    await processarConversaDirect(CHAT_INCOMPLETO);

    igual('sem tipo_consulta, sem gatilho forte → last_action vira aguardar', linha(CHAT_INCOMPLETO).last_action, 'aguardar');
    igual('   nenhum negocio criado', dealsCriados().length, 0);
    igual('   nenhum contato criado (bloqueia ANTES de buscarOuCriarContato)', de('POST', '/contacts').length, 0);

    // ---- com bloco de condicoes ja enviado: excecao preservada, deal nasce mesmo incompleto ----
    limpar();
    db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(CHAT_INCOMPLETO);
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(CHAT_INCOMPLETO);
    semear(CHAT_INCOMPLETO, { messages: JSON.stringify(MSGS_INCOMPLETO.concat([{ role: 'equipe', text: BLOCO_CONDICOES_PAGA, timestamp: '2026-08-01T10:05:00Z' }])) });
    rede.get = (url) => (url.includes('/deals/') ? { status: 200, data: { id: 8001, status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: [] } } : { status: 200, data: [] });
    rede.post = (url) => {
      if (url.includes('/contacts')) return { status: 201, data: { id: 4343 } };
      if (url.includes('/deals')) return { status: 200, data: { id: 8001 } };
      if (url.includes('/activities')) return { status: 200, data: { id: ID_ATIVIDADE } };
      return { status: 200, data: {} };
    };
    openai.respostas = [CLASSIFICACAO_OK, extracaoIncompleta()];
    openai.prompts = [];
    await processarConversaDirect(CHAT_INCOMPLETO);

    igual('sem tipo_consulta, MAS com bloco de condicoes enviado → deal nasce mesmo incompleto (excecao preservada)', dealsCriados().length, 1);
  }

  // ============================================================
  // Regressao do deal 48423360, parte 2: a equipe corrigiu a area na mao e o bot reescrevia o valor
  // dele no ciclo seguinte — agora com retentativas ate grudar. Quem corrige na mao ganha.
  console.log('\n=== autoria dos campos: correcao manual nunca e sobrescrita ===');
  const CHAT_AUT = '5511999990000';
  const ID_AREA = CF.AREA_DIREITO;
  const LGPD = OPCAO.lgpd;
  const ADMIN = OPCAO.admin;
  // LGPD → Berto pela tabela do escritorio.
  const DADOS_LGPD = { ...DADOS, area_direito: 'LGPD' };
  // O que o bot manda quando pode escrever a area, e quando a area fica de fora (travada/preservada).
  const CF_LGPD = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, OPCAO.lgpd), cf(CF.RESPONSAVEL, OPCAO.berto)];
  const CF_LGPD_SEM_AREA = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.RESPONSAVEL, OPCAO.berto)];
  const registro = (chatId) => ({
    escritos: JSON.parse(linha(chatId).custom_fields_bot || '{}'),
    travados: JSON.parse(linha(chatId).campos_travados || '[]'),
  });
  const areaNoPut = (dealId) => {
    const corpo = de('PUT', `/deals/${dealId}`)[0]?.corpo;
    return (corpo?.entityCustomFields || []).find((c) => c.id === ID_AREA)?.options;
  };
  // Primeiro GET = leitura de merge (estado atual do CRM); os seguintes = reconferencia pos-PUT, que
  // precisa devolver os campos que o bot REALMENTE mandou, senao atualizarNegocioMoskit lanca com
  // razao. `preservada` e a area que continua sendo a do CRM (o bot nao a mandou).
  const getsDeAutoria = (remotoArea, confirmacao = [...CF_LGPD_SEM_AREA, cf(ID_AREA, remotoArea)]) => {
    let n = 0;
    return () => ({
      status: 200,
      data: n++ === 0
        ? { entityCustomFields: [cf(ID_AREA, remotoArea)] }
        : { entityCustomFields: confirmacao },
    });
  };
  {
    // Linha antiga (custom_fields_bot NULL): nao ha como saber se o valor no CRM e do bot ou de um
    // humano. Preserva o do CRM nesta rodada e passa a registrar autoria — e o que garante que a
    // correcao manual ja feita nao volte para LGPD no primeiro ciclo depois do deploy.
    limpar();
    semear(CHAT_AUT, { deal_id: 30 });
    rede.get = getsDeAutoria(ADMIN);
    const erro = await esperarErro(() => atualizarNegocioMoskit(30, DADOS_LGPD, 555, { chatId: CHAT_AUT }));
    igual('sem registro de autoria → nao lanca', erro, null);
    igual('   o PUT mantem o valor que estava no CRM', String(areaNoPut(30)), String([ADMIN]));
    igual('   baseline registrada com o valor do CRM', String(registro(CHAT_AUT).escritos[ID_AREA]), String([ADMIN]));
    igual('   nada travado ainda', registro(CHAT_AUT).travados.length, 0);
    igual('   nenhuma nota de trava', notas().length, 0);
  }
  {
    // Ciclo seguinte: o CRM continua com o que o bot registrou, ninguem mexeu — o bot pode aplicar a
    // decisao atual dele.
    limpar();
    let seq = [
      { id: 31, entityCustomFields: [cf(ID_AREA, ADMIN)] },
      { id: 31, entityCustomFields: CF_LGPD },
    ];
    semear(CHAT_AUT, { deal_id: 31, custom_fields_bot: JSON.stringify({ [ID_AREA]: [ADMIN] }) });
    rede.get = () => ({ status: 200, data: seq.shift() });
    const erro = await esperarErro(() => atualizarNegocioMoskit(31, DADOS_LGPD, 555, { chatId: CHAT_AUT }));
    igual('CRM igual ao ultimo valor do bot → bot escreve', erro, null);
    igual('   o PUT leva a decisao nova', String(areaNoPut(31)), String([LGPD]));
    igual('   autoria atualizada', String(registro(CHAT_AUT).escritos[ID_AREA]), String([LGPD]));
  }
  {
    // O caso do usuario: o bot escreveu LGPD, a equipe corrigiu para Direito Administrativo no CRM.
    limpar();
    semear(CHAT_AUT, { deal_id: 32, custom_fields_bot: JSON.stringify({ [ID_AREA]: [LGPD] }) });
    rede.get = getsDeAutoria(ADMIN);
    const erro = await esperarErro(() => atualizarNegocioMoskit(32, DADOS_LGPD, 555, { chatId: CHAT_AUT }));
    igual('divergencia = correcao manual → nao lanca', erro, null);
    igual('   o PUT NAO leva o LGPD do bot', String(areaNoPut(32)), String([ADMIN]));
    igual('   campo travado', String(registro(CHAT_AUT).travados), String([ID_AREA]));
    igual('   nenhuma nota (trava agora so avisa no Telegram)', notas().length, 0);
    igual('   um Telegram avisando a trava', telegrams().length, 1);
    checar('   ...com o nome do campo', telegrams()[0].corpo.text.includes('Área do Direito'), telegrams()[0].corpo.text);
  }
  {
    // Trava e permanente: no ciclo seguinte o bot nem tenta, e nao repete o aviso.
    limpar();
    semear(CHAT_AUT, { deal_id: 33, custom_fields_bot: JSON.stringify({ [ID_AREA]: [LGPD] }), campos_travados: JSON.stringify([ID_AREA]) });
    rede.get = getsDeAutoria(ADMIN);
    igual('campo travado → nao lanca', await esperarErro(() => atualizarNegocioMoskit(33, DADOS_LGPD, 555, { chatId: CHAT_AUT })), null);
    igual('campo travado continua fora do PUT', String(areaNoPut(33)), String([ADMIN]));
    igual('   Telegram de trava nao se repete', telegrams().length, 0);
  }
  {
    // Campo vazio no CRM: nao ha correcao humana para preservar, o bot preenche normalmente.
    limpar();
    let seq = [
      { id: 34, entityCustomFields: [] },
      { id: 34, entityCustomFields: CF_LGPD },
    ];
    semear(CHAT_AUT, { deal_id: 34, custom_fields_bot: JSON.stringify({}) });
    rede.get = () => ({ status: 200, data: seq.shift() });
    igual('campo vazio no CRM → bot preenche', await esperarErro(() => atualizarNegocioMoskit(34, DADOS_LGPD, 555, { chatId: CHAT_AUT })), null);
    igual('   valor do bot vai no PUT', String(areaNoPut(34)), String([LGPD]));
  }
  {
    // TIPO_CONSULTA fica fora do travamento de proposito: quem manda nele e o bloco de condicoes.
    limpar();
    const GRATIS = OPCAO.gratis;
    let seq = [
      { id: 35, entityCustomFields: [cf(CF.TIPO_CONSULTA, GRATIS)] },
      { id: 35, entityCustomFields: CF_DADOS },
    ];
    semear(CHAT_AUT, { deal_id: 35, custom_fields_bot: JSON.stringify({ [moskitIds.CF.TIPO_CONSULTA]: [GRATIS] }) });
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(35, DADOS, 555, { chatId: CHAT_AUT, condicoesValorEnviadas: true }));
    const tipoNoPut = (de('PUT', '/deals/35')[0]?.corpo?.entityCustomFields || []).find((c) => c.id === moskitIds.CF.TIPO_CONSULTA)?.options;
    igual('bloco enviado reclassifica cortesia → paga (tipo de consulta nao trava)', String(tipoNoPut), String([moskitIds.TIPO_CONSULTA['consulta paga']]));
  }
  {
    // Sem chatId (backfills e scripts): comportamento antigo, sem registro de autoria.
    limpar();
    let seq = [
      { id: 36, entityCustomFields: [cf(ID_AREA, ADMIN)] },
      { id: 36, entityCustomFields: CF_LGPD },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    igual('sem chatId → escreve como antes', await esperarErro(() => atualizarNegocioMoskit(36, DADOS_LGPD, 555, {})), null);
    igual('   valor do bot vai no PUT', String(areaNoPut(36)), String([LGPD]));
  }

  // ============================================================
  // O briefing do deal 48423360 dizia "caso relacionado à LGPD" e ficou congelado: briefing_added era
  // trava de uma vez so. Agora quem decide e o hash do TEXTO FINAL (cabeçalho em código + narrativa
  // da IA), e cada mudança real posta uma nota NOVA com título versionado — a trilha é o histórico.
  console.log('\n=== briefing: uma nota por mudanca real, com cabecalho deterministico ===');
  const CHAT_BRIEF = '5511988880000';
  const RESUMO_A = '📌 Caso: cliente quer tratar de assunto relacionado à LGPD.\n📌 Objetivo do cliente: entender a situação.\n📌 Urgencia/prazo: Nao mencionado.\n📌 Ja tentou: Nada mencionado.\n📌 Pendencias: Nao mencionado.\n📌 Documentos citados: Nao mencionado.';
  const RESUMO_B = '📌 Caso: servidora exonerada quer remoção por motivo de saúde.\n📌 Objetivo do cliente: voltar ao cargo.\n📌 Urgencia/prazo: Nao mencionado.\n📌 Ja tentou: Nada mencionado.\n📌 Pendencias: Nao mencionado.\n📌 Documentos citados: Nao mencionado.';
  const CTX_BRIEF = (dados, extra = {}) => ({ dados, contato: 'Fulano', telefone: CHAT_BRIEF, horarioConsulta: null, ...extra });
  const corpo = () => notas()[0]?.corpo?.description || '';
  {
    limpar();
    semear(CHAT_BRIEF, { deal_id: 40 });
    const postou = await registrarBriefing(40, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_A }));
    igual('primeiro briefing → posta', postou, true);
    checar('   com titulo versionado v1', /📋 Briefing · v1 · /.test(corpo()), corpo());
    checar('   com cabecalho deterministico', corpo().includes('Cliente: Fulano\nTelefone: 5511988880000'), corpo());
    checar('   com a narrativa da IA', corpo().includes('assunto relacionado à LGPD'), corpo());
    checar('   com o marcador no fim', corpo().includes(briefingModule.MARCADOR_BRIEFING), corpo());
    igual('   briefing_added marcado', linha(CHAT_BRIEF).briefing_added, 1);
    checar('   hash gravado', !!linha(CHAT_BRIEF).briefing_hash);
    igual('   versao 1', linha(CHAT_BRIEF).briefing_versao, 1);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_A }));
    igual('mesmo resumo → nao reposta', postou, false);
    igual('   nenhuma nota', notas().length, 0);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: `  ${RESUMO_A}\n\n ` }));
    igual('so mudou espaco/quebra de linha → nao reposta', postou, false);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_B }));
    igual('resumo mudou de verdade → reposta', postou, true);
    checar('   titulo v2', /📋 Briefing · v2 · /.test(corpo()), corpo());
    checar('   com o texto novo', corpo().includes('remoção por motivo de saúde'), corpo());
  }
  {
    // Mudanca so de CABEÇALHO (ex.: remarcacao) reposta mesmo com a narrativa igual — o hash e do
    // texto final, nao so da prosa da IA.
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, CTX_BRIEF(
      { nome: 'Fulano', resumo_atendimento: RESUMO_B },
      { horarioConsulta: '18/08/2026, 16:00' }
    ));
    igual('so o horario mudou → reposta', postou, true);
    checar('   com o horario novo no cabecalho', corpo().includes('Consulta: 18/08/2026, 16:00'), corpo());
    checar('   titulo v3', /📋 Briefing · v3 · /.test(corpo()), corpo());
  }
  {
    // Conversa anterior a esta mudanca (briefing_added=1, sem hash): adota o resumo atual como
    // referencia sem repostar, pra nao duplicar nota em todo deal ativo no primeiro ciclo apos deploy.
    limpar();
    semear(CHAT_BRIEF, { deal_id: 41, briefing_added: 1 });
    const postou = await registrarBriefing(41, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_A }));
    igual('linha antiga sem hash → nao reposta', postou, false);
    igual('   nenhuma nota escrita em deal existente', notas().length, 0);
    checar('   hash adotado como referencia', !!linha(CHAT_BRIEF).briefing_hash);
  }
  {
    limpar();
    const postou = await registrarBriefing(41, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_B }));
    igual('...e a proxima mudanca real ja reposta', postou, true);
    checar('   com titulo v1 (primeiro da linha migrada)', /📋 Briefing · v1 · /.test(corpo()), corpo());
  }
  {
    limpar();
    igual('sem conteudo → nao posta nada', await registrarBriefing(40, CHAT_BRIEF, {}), false);
    igual('sem dealId → nao posta nada', await registrarBriefing(null, CHAT_BRIEF, CTX_BRIEF({ nome: 'Fulano', resumo_atendimento: RESUMO_A })), false);
    igual('   nenhuma chamada de rede', rede.chamadas.length, 0);
  }
  // ============================================================
  // O CALL SITE com campo obrigatorio pendente. Este era o defeito: no ramo atualizar_campos o
  // briefing so era postado com `pendentes.length === 0`, e como aplicarGateCasoDescrito anula
  // area_direito e advogado_responsavel quando ninguem descreveu o caso (e os dois sao
  // obrigatorios), conversa sem caso descrito nunca recebia briefing nenhum. Medido em 02/09/2026:
  // 19 conversas barradas em 277, 14 delas com o resumo pronto e pago. Agora posta com a lacuna
  // dita — e o que este bloco vigia e que `pendentes` CHEGA ao texto da nota, nao so ao console.
  console.log('\n=== briefing com campo obrigatorio pendente: posta com a lacuna anotada ===');
  {
    limpar();
    semear(CHAT_BRIEF, { deal_id: 42 });
    const postou = await registrarBriefing(42, CHAT_BRIEF, CTX_BRIEF(
      { nome: 'Fulano', resumo_atendimento: RESUMO_B },
      { pendentes: ['area_direito', 'advogado_responsavel'] },
    ));
    igual('com pendentes → POSTA (antes nao postava nada)', postou, true);
    checar('   a nota diz o que falta, com rotulo legivel',
      corpo().includes('⚠️ Ainda não confirmado: área do direito, advogado responsável'), corpo());
    checar('   a narrativa continua na nota', corpo().includes('remoção por motivo de saúde'), corpo());
    checar('   nenhum nome de coluna vaza para a nota', !corpo().includes('area_direito'), corpo());
  }
  {
    // Preencher os campos e reprocessar tem de repostar: o texto mudou (a linha de lacuna saiu), e
    // sem hash novo o advogado ficaria lendo para sempre a nota que diz que falta area.
    const postou = await registrarBriefing(42, CHAT_BRIEF, CTX_BRIEF(
      { nome: 'Fulano', area_direito: 'Direito Administrativo', advogado_responsavel: 'Berto', resumo_atendimento: RESUMO_B },
      { pendentes: [] },
    ));
    igual('lacuna preenchida → reposta com nota nova', postou, true);
    // A ULTIMA nota, nao a primeira: este bloco nao chama limpar() de proposito (o hash da nota
    // anterior e justamente o que faz a reposta acontecer), entao notas()[0] ainda e a v1.
    const ultimo = notas()[notas().length - 1]?.corpo?.description || '';
    igual('   duas notas na trilha, nao uma reescrita', notas().length, 2);
    checar('   e a linha de lacuna desaparece da nota nova', !ultimo.includes('Ainda não confirmado'), ultimo);
    checar('   a nota v1 continua no historico dizendo o que faltava',
      (notas()[0]?.corpo?.description || '').includes('Ainda não confirmado'), notas()[0]?.corpo?.description);
    igual('   versao incrementada', linha(CHAT_BRIEF).briefing_versao, 2);
  }

  // ============================================================
  // O furo que sobrou depois do gate: mergeDados ressuscitava o palpite antigo gravado em last_data e o
  // reenviava para sempre. Regressao direta do 48423360.
  console.log('\n=== mesclarParaCrm: o palpite antigo nao volta do last_data ===');
  {
    const anteriores = { nome: 'Martha Luiza', area_direito: 'LGPD', advogado_responsavel: 'Berto', assunto: 'Direito Digital' };
    const mesclado = mesclarParaCrm(anteriores, { modalidade_consulta: 'online' }, []);
    igual('area antiga sem evidencia de caso → sai do objeto que vai pro CRM', mesclado.area_direito, null);
    igual('   advogado antigo tambem sai', mesclado.advogado_responsavel, null);
    igual('   assunto que era nome de area tambem sai', mesclado.assunto, null);
    igual('   o resto e preservado', mesclado.nome, 'Martha Luiza');
    igual('   payload nao leva area nenhuma', (montarPayloadMoskit(mesclado, 1, {}).entityCustomFields || []).find((c) => c.id === CF.AREA_DIREITO), undefined);
  }
  {
    const anteriores = { area_direito: 'Direito Administrativo', assunto: 'Remoção por motivo de saúde' };
    const mesclado = mesclarParaCrm(anteriores, {}, OBS_CASO);
    igual('com evidencia de caso a area anterior sobrevive', mesclado.area_direito, 'Direito Administrativo');
    igual('   e o responsavel e derivado dela', mesclado.advogado_responsavel, 'Berto');
  }
  {
    // O bug que sobrevivia mesmo depois do teste acima: aplicarGateCasoDescrito e chamado DE NOVO
    // dentro de mesclarParaCrm, sobre o objeto MESCLADO, usando so a evidencia DESTA rodada — uma
    // classificacao que uma rodada ANTERIOR ja tinha validado com evidencia real era apagada de novo
    // assim que uma rodada seguinte (ex: so reagendamento) nao reemitisse cliente_descreveu_caso,
    // revertendo ate o nome do deal em atualizarNegocioMoskit. `_casoDescritoValidado` persiste em
    // last_data pra distinguir "ja provado uma vez" de um palpite pre-gate (teste anterior, que nunca
    // carrega o marcador e continua sendo limpo).
    const rodada1 = mesclarParaCrm(null, { area_direito: 'Direito Administrativo' }, OBS_CASO);
    igual('rodada 1 (com evidencia): area entra', rodada1.area_direito, 'Direito Administrativo');
    igual('   e marca _casoDescritoValidado', rodada1._casoDescritoValidado, true);

    const rodada2 = mesclarParaCrm(rodada1, { modalidade_consulta: 'online' }, []);
    igual('rodada 2 (SEM evidencia nova, ex: so reagendamento): area validada antes sobrevive', rodada2.area_direito, 'Direito Administrativo');
    igual('   responsavel tambem sobrevive', rodada2.advogado_responsavel, 'Berto');
  }
  {
    const mesclado = mesclarParaCrm({ area_direito: 'Direito de Familia', advogado_responsavel: 'Iury' }, {}, OBS_CASO);
    igual('advogado incoerente com a area e corrigido no merge', mesclado.advogado_responsavel, 'Bruno');
  }
  {
    const dados = { area_direito: 'Outros', advogado_responsavel: 'Bruno' };
    derivarAdvogadoDaArea(dados);
    igual('area "Outros" → responsavel vazio', dados.advogado_responsavel, null);
  }

  // ============================================================
  // ACHADO em 03/09/2026 (investigando por que deals do bot com assunto real perdiam o dado sozinhos):
  // o modelo, seguindo a propria instrucao do prompt, devolve `assunto: "Consulta juridica"` (nao
  // omite o campo) em toda rodada sem caso novo — e mergeDados tratava isso como dado novo de verdade,
  // apagando um assunto real capturado numa rodada anterior. `_casoDescritoValidado` so protegia
  // area/advogado; assunto nunca teve protecao porque o gate deixa o placeholder passar sempre.
  console.log('\n=== mesclarParaCrm: placeholder do modelo nao apaga assunto real herdado ===');
  {
    const rodada1 = mesclarParaCrm(null, { nome: 'Jose Carlos', assunto: 'Pericia de readaptacao', area_direito: 'Direito Previdenciario' }, OBS_CASO);
    igual('rodada 1 (com evidencia): assunto real entra', rodada1.assunto, 'Pericia de readaptacao');

    const rodada2 = mesclarParaCrm(rodada1, { assunto: 'Consulta jurídica' }, []);
    igual('rodada 2 (so placeholder, sem caso novo): assunto real sobrevive', rodada2.assunto, 'Pericia de readaptacao');
  }
  {
    // Controle: se NUNCA existiu assunto real, o placeholder tem que continuar passando normalmente
    // (e o comportamento intencional para deal novo sem caso descrito ainda).
    const mesclado = mesclarParaCrm(null, { nome: 'Fulano', assunto: 'Consulta jurídica' }, []);
    igual('sem assunto anterior: placeholder passa normalmente', mesclado.assunto, 'Consulta jurídica');
  }
  {
    // Controle: assunto real NOVO (nao placeholder) continua atualizando por cima do antigo — a
    // protecao e so contra o placeholder especificamente, nao contra assunto mudar de verdade.
    const rodada1 = mesclarParaCrm(null, { assunto: 'Pericia de readaptacao' }, OBS_CASO);
    const rodada2 = mesclarParaCrm(rodada1, { assunto: 'Aposentadoria por invalidez' }, OBS_CASO);
    igual('assunto real novo substitui o real antigo normalmente', rodada2.assunto, 'Aposentadoria por invalidez');
  }

  // ============================================================
  // Regra deterministica de origem: "pagina/instagram do socio" e "site do escritorio" nao podem
  // depender do modelo lembrar disso a cada rodada. MEDIDO em 21/08/2026 (deal 48206716): a regex
  // antiga usava "pagina" sem acento e nunca batia contra "página" (a grafia mais comum), entao a
  // regra nunca acionava pra esse caso real.
  console.log('\n=== aplicarPadroesDeterministicosDeOrigem: sinais deterministicos de origem ===');
  {
    const msgs = [{ role: 'cliente', text: 'Olá, vi a página do Advogado Bruno Rocha e gostaria de uma análise do meu caso.' }];
    const dados = { origem: null, captacao: null };
    aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    igual('"página" COM acento tambem forca Instagram (antes so "pagina" sem acento acionava)', dados.origem, 'Instagram');
    igual('   e a captacao vai pro socio certo', dados.captacao, 'Bruno');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Cliquei no link da bio no Instagram do Dr. Berto Caballero, gostaria de tratar sobre meu caso.' }];
    const dados = { origem: 'Nao identificado', captacao: null };
    aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    igual('"instagram do Berto" forca Instagram mesmo com origem ja preenchida (sobrescreve o fallback)', dados.origem, 'Instagram');
    igual('   captacao = Berto', dados.captacao, 'Berto');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Olá, acessei o site do escritório e gostaria de uma consulta.' }];
    const dados = { origem: null };
    aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    igual('"site do escritorio" forca Site (sem socio associado)', dados.origem, 'Site');
    igual('   captacao nao e tocada por esta regra', dados.captacao, undefined);
  }
  {
    // Prioridade: se a conversa cita socio E site, o socio (sinal mais especifico) vence.
    const msgs = [{ role: 'cliente', text: 'Vi o site do escritório e depois achei a página do Bruno no Instagram.' }];
    const dados = { origem: null };
    aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    igual('socio tem prioridade sobre site quando os dois aparecem', dados.origem, 'Instagram');
    igual('   captacao = Bruno', dados.captacao, 'Bruno');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Bom dia, gostaria de agendar uma consulta.' }];
    const dados = { origem: 'Instagram', captacao: 'Iury' };
    aplicarPadroesDeterministicosDeOrigem(dados, msgs);
    igual('sem sinal nenhum: nao mexe no que a IA ja tinha extraido', dados.origem, 'Instagram');
    igual('   captacao tambem intocada', dados.captacao, 'Iury');
  }

  // ============================================================
  // Vocabulario ampliado em 02/09/2026: decisao do escritorio de tentar ao MAXIMO identificar a
  // origem antes de aceitar "Nao identificado" — expande aplicarPadroesDeterministicosDeOrigem alem
  // de socio/site, com os mesmos cuidados de falso positivo ja medidos em producao (Google Meet,
  // "danos materiais").
  console.log('\n=== aplicarPadroesDeterministicosDeOrigem: vocabulario ampliado ===');
  {
    const msgs = [{ role: 'cliente', text: 'Vi um caso parecido no JusBrasil e queria saber se voces atendem isso.' }];
    igual('JusBrasil', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'JusBrasil');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Assisti um video de voces no Youtube sobre esse assunto.' }];
    igual('Youtube', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Youtube');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Achei o perfil de voces no instagram e resolvi chamar.' }];
    igual('Instagram generico (sem socio) tambem conta', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Instagram');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Vi um artigo sobre isso e fiquei interessado em conversar.' }];
    igual('"vi um artigo" com verbo de consumo', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Artigo');
  }
  {
    // Armadilha: "artigo" SOZINHO em conversa juridica e most-likely artigo de LEI, nao artigo de
    // blog/imprensa. Sem o verbo "vi/li" na frente, nao pode acionar — senao toda mencao a "artigo
    // 927 do codigo civil" viraria origem="Artigo".
    const msgs = [{ role: 'cliente', text: 'O advogado me falou do artigo 927 do codigo civil.' }];
    igual('"artigo" sozinho (artigo de LEI) NAO aciona', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, null);
  }
  {
    const msgs = [{ role: 'cliente', text: 'Fui indicado por um amigo que ja foi cliente de voces.' }];
    igual('indicacao de amigo com contexto explicito', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Indicacao de/ou amigos e parentes');
  }
  {
    // Armadilha: "amigo"/"parente" SOZINHOS sao comuns em conversa juridica sem ser sobre origem
    // ("meu amigo teve um problema parecido"). So carrega o sinal com verbo/substantivo de indicacao.
    const msgs = [{ role: 'cliente', text: 'Meu amigo teve um problema parecido e falou que era complicado.' }];
    igual('"amigo" sozinho (sem indicacao) NAO aciona', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, null);
  }
  {
    const msgs = [{ role: 'cliente', text: 'Ja sou cliente de voces, tive outro caso com o escritorio ano passado.' }];
    igual('indicacao de clientes (ja foi cliente)', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Indicacao de clientes');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Vi um anuncio de voces passando no feed.' }];
    igual('VSL/trafego pago (anuncio)', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'VSL - Trafego pago');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Cliquei na landing page de voces sobre direito de familia.' }];
    igual('Landing Page', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Landing Page');
  }
  {
    const msgs = [{ role: 'cliente', text: 'Pesquisei no google e achei voces.' }];
    igual('"pesquisei no google" (com contexto de busca) conta como Site', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Site');
  }
  {
    // Armadilha MEDIDA em 21/08/2026 (deal 48219774): todo evento de consulta agendada injeta o
    // convite do Google Meet/Calendar no texto ("Informacoes de participacao do Google Meet",
    // "meet.google.com/..."). "google" isolado NUNCA pode acionar, ou toda consulta marcada viraria
    // origem="Site".
    const msgs = [{ role: 'equipe', text: 'Segue o convite: Informacoes de participacao do Google Meet meet.google.com/abc-defg-hij' }];
    igual('"google" isolado (convite do Meet) NAO aciona', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, null);
  }

  console.log('\n=== detectarRespostaPerguntaOrigem: equipe pergunta, cliente responde (gap real medido, deal 48317782) ===');
  {
    const msgs = [
      { role: 'equipe', text: 'Voce pode nos contar como conheceu o nosso escritorio? 1.Indicacao 2.Artigo 3.Instagram 4.Youtube', timestamp: '2026-08-01T10:00:00Z' },
      { role: 'cliente', text: 'verifiquei no instagram', timestamp: '2026-08-01T10:01:00Z' },
    ];
    const achado = detectarRespostaPerguntaOrigem(msgs);
    igual('regressao do deal 48317782: resposta "instagram" apos a pergunta e capturada', achado?.origem, 'Instagram');
    igual('aplicarPadroesDeterministicosDeOrigem usa esse sinal', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, 'Instagram');
  }
  {
    // Regressao MEDIDA no proprio deal 48317782 (produção, 02/09/2026): a resposta real do cliente so
    // vem depois de 4 anexos e de ele responder a OUTRA pergunta pendente da equipe (enviar o
    // contrato) — "Essa e a proposta de distrato da empresa" / "Um dos socios do escritorio foi meu
    // professor" / "Berto Igor" ×2 / SO ENTAO "E verifiquei no instagram que o escritorio atuava
    // nessa area". Sem pular anexo e sem janela de varias mensagens, a funcao parava na primeira
    // mensagem de texto do cliente (que nem menciona canal) e perdia o sinal real.
    const msgs = [
      { role: 'equipe', text: 'Voce pode nos contar como conheceu o nosso escritorio? 1.Indicacao 2.Artigo 3.Instagram 4.Youtube' },
      { role: 'cliente', text: '📎 [cliente enviou: contrato.pdf]' },
      { role: 'cliente', text: '📎 [cliente enviou uma imagem]' },
      { role: 'cliente', text: 'Essa e a proposta de distrato da empresa' },
      { role: 'cliente', text: 'Um dos socios do escritorio foi meu professor' },
      { role: 'cliente', text: 'Berto Igor' },
      { role: 'cliente', text: 'E verifiquei no instagram que o escritorio atuava nessa area' },
    ];
    igual('anexos e mensagens sem canal antes da resposta real nao fazem a funcao desistir', detectarRespostaPerguntaOrigem(msgs)?.origem, 'Instagram');
  }
  {
    // A janela tem limite (5 mensagens de TEXTO do cliente): resposta real MUITO depois da pergunta
    // (conversa que segue para outros assuntos) nao deve ser atribuida a ela por acaso.
    const msgs = [
      { role: 'equipe', text: 'Como voce conheceu o nosso escritorio?' },
      { role: 'cliente', text: 'Vou pensar' },
      { role: 'cliente', text: 'Certo' },
      { role: 'cliente', text: 'Obrigado' },
      { role: 'cliente', text: 'Ok' },
      { role: 'cliente', text: 'Combinado' },
      { role: 'cliente', text: 'Vi no instagram de voces' }, // 6a mensagem de texto — fora da janela de 5
    ];
    igual('resposta fora da janela de 5 mensagens de texto nao e atribuida a pergunta', detectarRespostaPerguntaOrigem(msgs), null);
  }
  {
    const msgs = [
      { role: 'equipe', text: 'Como voce chegou ate a gente?', timestamp: '2026-08-01T10:00:00Z' },
      { role: 'cliente', text: 'Vi o artigo que voces publicaram', timestamp: '2026-08-01T10:01:00Z' },
    ];
    igual('pergunta com outra frase ("como chegou ate a gente") tambem e reconhecida', detectarRespostaPerguntaOrigem(msgs)?.origem, 'Artigo');
  }
  {
    // Sem resposta do cliente logo em seguida (equipe fala de novo, ou conversa acaba): nao inventa.
    const msgs = [
      { role: 'equipe', text: 'Como voce conheceu o nosso escritorio?', timestamp: '2026-08-01T10:00:00Z' },
      { role: 'equipe', text: 'Pode ser por Instagram, indicacao, site...', timestamp: '2026-08-01T10:01:00Z' },
    ];
    igual('pergunta sem resposta do cliente → nao aciona', detectarRespostaPerguntaOrigem(msgs), null);
  }
  {
    // A pergunta em si nao tem sinal de canal nenhum — sem a funcao dedicada, o padrao generico de
    // "instagram" bateria na PROPRIA pergunta da equipe (que lista as opcoes), atribuindo a origem
    // errada mesmo sem o cliente ter respondido nada ainda.
    const msgs = [
      { role: 'equipe', text: 'Voce pode nos contar como conheceu o nosso escritorio? 1.Indicacao 2.Artigo 3.Instagram 4.Youtube', timestamp: '2026-08-01T10:00:00Z' },
    ];
    igual('so a pergunta, sem resposta ainda → nao aciona nada', aplicarPadroesDeterministicosDeOrigem({ origem: null }, msgs).origem, null);
  }

  // ============================================================
  // Bug real (sem regressao antes desta correcao): os ramos 'ignorar' (inclusive o downgrade
  // automatico por confianca baixa), 'nota'/'atualizar_campos' sem deal_id ainda gravado, e o fallback
  // de acao desconhecida persistiam em last_data a extracao CRUA desta rodada (JSON.stringify(dados)),
  // sem passar por mesclarParaCrm. Uma classificacao valida de uma rodada anterior (com
  // _casoDescritoValidado) era apagada em silencio sempre que a rodada seguinte nao reemitisse a mesma
  // evidencia — provavelmente a causa mais comum de deal que "estava classificado e ficou vazio".
  console.log('\n=== processarConversaDirect: classificacao anterior sobrevive a rodada sem merge ===');
  const CHAT_MERGE = '5511900002222';
  const MSGS_MERGE = [{ role: 'cliente', text: 'Alguma pergunta genérica sobre o andamento', timestamp: new Date().toISOString() }];
  const LAST_DATA_VALIDO_MERGE = JSON.stringify({
    nome: 'Fulano de Tal', area_direito: 'Direito de Familia', advogado_responsavel: 'Bruno',
    assunto: 'Inventario', origem: 'Instagram', _casoDescritoValidado: true,
  });
  const CLASSIFICACAO_GENERICA = { classificacao: 'criar_negocio', justificativa: 'cliente perguntando algo generico' };
  {
    // Ramo 'ignorar' via downgrade automatico de confianca baixa (acao 'criar' com confianca<6).
    limpar();
    semear(CHAT_MERGE, { deal_id: 60, last_data: LAST_DATA_VALIDO_MERGE, last_action: 'atualizar_campos', messages: JSON.stringify(MSGS_MERGE) });
    openai.respostas = [CLASSIFICACAO_GENERICA, { acao: 'criar', justificativa: 'baixa confianca', confianca: 3, dados: { nome: 'Fulano de Tal' }, observacoes: [] }];
    await processarConversaDirect(CHAT_MERGE);
    const depois = JSON.parse(linha(CHAT_MERGE).last_data || '{}');
    igual('   last_action gravado como "ignorar"', linha(CHAT_MERGE).last_action, 'ignorar');
    igual('ramo "ignorar" (via downgrade de confianca): area sobrevive', depois.area_direito, 'Direito de Familia');
    igual('   advogado tambem sobrevive', depois.advogado_responsavel, 'Bruno');
    igual('   nenhum PUT no negocio (ciclo so gravou local)', dealsAtualizados().length, 0);
  }
  {
    // Ramo 'nota' com deal_id AINDA null.
    limpar();
    semear(CHAT_MERGE, { deal_id: null, last_data: LAST_DATA_VALIDO_MERGE, last_action: 'aguardar', messages: JSON.stringify(MSGS_MERGE) });
    openai.respostas = [CLASSIFICACAO_GENERICA, { acao: 'nota', justificativa: 'modelo devolveu nota sem o negocio existir', confianca: 8, dados: { nome: 'Fulano de Tal' }, observacoes: [] }];
    await processarConversaDirect(CHAT_MERGE);
    const depois = JSON.parse(linha(CHAT_MERGE).last_data || '{}');
    igual('ramo "nota" sem deal_id: area sobrevive', depois.area_direito, 'Direito de Familia');
    igual('   advogado tambem sobrevive', depois.advogado_responsavel, 'Bruno');
  }
  {
    // Ramo 'atualizar_campos' com deal_id AINDA null.
    limpar();
    semear(CHAT_MERGE, { deal_id: null, last_data: LAST_DATA_VALIDO_MERGE, last_action: 'aguardar', messages: JSON.stringify(MSGS_MERGE) });
    openai.respostas = [CLASSIFICACAO_GENERICA, { acao: 'atualizar_campos', justificativa: 'modelo devolveu atualizar_campos sem o negocio existir', confianca: 8, dados: { nome: 'Fulano de Tal' }, observacoes: [] }];
    await processarConversaDirect(CHAT_MERGE);
    const depois = JSON.parse(linha(CHAT_MERGE).last_data || '{}');
    igual('ramo "atualizar_campos" sem deal_id: area sobrevive', depois.area_direito, 'Direito de Familia');
    igual('   advogado tambem sobrevive', depois.advogado_responsavel, 'Bruno');
  }
  {
    // Ramo 'inviavel': classificarConversa roda ANTES da extracao (index.js) — nesta rodada nao
    // existe `dados` novo nenhum, so a classificacao de uma rodada ANTERIOR que nao pode ser apagada
    // so porque esta mensagem especifica foi julgada nao-viavel (ex.: "obrigado!" depois da consulta).
    // MEDIDO em 21/08/2026: 12 de 29 deals reais atingidos por este bug ainda tinham sinal de origem
    // na conversa, perdido so por causa disso.
    limpar();
    semear(CHAT_MERGE, { deal_id: 60, last_data: LAST_DATA_VALIDO_MERGE, last_action: 'atualizar_campos', messages: JSON.stringify(MSGS_MERGE) });
    openai.respostas = [{ classificacao: 'inviavel', justificativa: 'cliente so agradecendo' }];
    await processarConversaDirect(CHAT_MERGE);
    const depois = JSON.parse(linha(CHAT_MERGE).last_data || '{}');
    igual('   last_action gravado como "inviavel"', linha(CHAT_MERGE).last_action, 'inviavel');
    igual('ramo "inviavel": area sobrevive', depois.area_direito, 'Direito de Familia');
    igual('   advogado tambem sobrevive', depois.advogado_responsavel, 'Bruno');
  }
  {
    // Ramo 'interno': e checagem de numero (TEAM_PHONES), roda ANTES de qualquer chamada a OpenAI —
    // nunca deveria ter chegado a apagar classificacao alguma. MEDIDO em 21/08/2026 (deal 48222273,
    // Alice Pimentel — o mesmo caso ja citado no comentario de src/telefone.js sobre numero interno
    // que virou lead antes de entrar em TEAM_PHONES).
    const CHAT_INTERNO = '5511900009999'; // bate em TEAM_PHONES, configurado no topo deste arquivo
    limpar();
    semear(CHAT_INTERNO, { deal_id: 60, last_data: LAST_DATA_VALIDO_MERGE, last_action: 'atualizar_campos', messages: JSON.stringify(MSGS_MERGE) });
    openai.respostas = [];
    openai.prompts = [];
    await processarConversaDirect(CHAT_INTERNO);
    const depois = JSON.parse(linha(CHAT_INTERNO).last_data || '{}');
    igual('   last_action gravado como "interno"', linha(CHAT_INTERNO).last_action, 'interno');
    igual('   nenhuma chamada de rede (nem a OpenAI)', openai.prompts.length, 0);
    igual('ramo "interno": area sobrevive', depois.area_direito, 'Direito de Familia');
    igual('   advogado tambem sobrevive', depois.advogado_responsavel, 'Bruno');
  }

  // ============================================================
  console.log('\n=== garantirDealExiste: erro transitorio nao pode criar deal duplicado ===');
  {
    limpar();
    rede.get = () => ({ status: 404, data: {} });
    let dealCriado = false;
    rede.post = (url) => { if (url.includes('/deals')) dealCriado = true; return { status: 201, data: { id: 999 } }; };
    const dealId = await garantirDealExiste(50, { nome: 'Fulano' }, 1, {});
    igual('404 CONFIRMADO → recria o deal', dealId, 999);
    checar('   POST /deals foi chamado', dealCriado);
  }
  {
    limpar();
    rede.get = () => { throw new Error('timeout of 30000ms exceeded'); };
    let dealCriado = false;
    rede.post = (url) => { if (url.includes('/deals')) dealCriado = true; return { status: 201, data: { id: 12345 } }; };
    const erro = await esperarErro(() => garantirDealExiste(50, { nome: 'Fulano' }, 1, {}));
    checar('timeout (erro transitorio, NAO 404) relanca em vez de recriar', !!erro && !dealCriado, { erro, dealCriado });
  }
  {
    limpar();
    rede.get = () => { const e = new Error('Request failed with status code 503'); e.response = { status: 503 }; throw e; };
    let dealCriado = false;
    rede.post = (url) => { if (url.includes('/deals')) dealCriado = true; return { status: 201, data: { id: 1 } }; };
    const erro = await esperarErro(() => garantirDealExiste(50, { nome: 'Fulano' }, 1, {}));
    checar('5xx do Moskit (nao 404) tambem relanca em vez de recriar', !!erro && !dealCriado, { erro, dealCriado });
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { id: 50 } });
    const dealId = await garantirDealExiste(50, { nome: 'Fulano' }, 1, {});
    igual('deal confirmado existente → devolve o mesmo id', dealId, 50);
    igual('   sem nenhum POST de criacao', de('POST', '/deals').length, 0);
  }

  // ============================================================
  // MEDIDO em 24/08/2026 (estudar-deals-duplicados.js --sondar-crm --so-bot): 14 contatos duplicados
  // de verdade na conta do escritorio — mesmo telefone, dois `contacts.id` diferentes no Moskit, a
  // maioria concentrada no dia em que o auto-deploy foi testado com varios `pm2 restart` em sequencia
  // (o cenario que faz o Moskit devolver 429 sob rajada de reprocessamento). Causa: um status fora de
  // 200-299 OU uma excecao de rede na busca terminavam em silencio e caiam direto no POST /contacts —
  // exatamente como se o contato genuinamente nao existisse. Mesmo raciocinio de garantirDealExiste
  // acima: rede instavel != contato/deal inexistente.
  console.log('\n=== buscarOuCriarContato: falha na busca nao pode criar contato duplicado ===');
  {
    limpar();
    const tel = '5586999990010';
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(tel.slice(-13));
    rede.get = (url) => (url.includes('/contacts') ? { status: 429, data: {} } : { status: 200, data: {} });
    let contatoCriado = false;
    rede.post = (url) => { if (url.includes('/contacts')) contatoCriado = true; return { status: 201, data: { id: 999 } }; };
    const erro = await esperarErro(() => buscarOuCriarContato(tel, 'Fulano'));
    checar('429 na busca de contato → LANCA em vez de criar', !!erro && !contatoCriado, { erro, contatoCriado });
  }
  {
    limpar();
    const tel = '5586999990011';
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(tel.slice(-13));
    rede.get = (url) => { if (url.includes('/contacts')) throw new Error('timeout of 30000ms exceeded'); return { status: 200, data: {} }; };
    let contatoCriado = false;
    rede.post = (url) => { if (url.includes('/contacts')) contatoCriado = true; return { status: 201, data: { id: 999 } }; };
    const erro = await esperarErro(() => buscarOuCriarContato(tel, 'Fulano'));
    checar('timeout na busca de contato → LANCA em vez de criar', !!erro && !contatoCriado, { erro, contatoCriado });
  }
  {
    // Contraprova: a busca chega ao FIM DE VERDADE da lista (pagina sem token de proxima pagina) sem
    // achar → so ENTAO cria. Sem isto, um bug que fizesse a funcao sempre lancar passaria nos dois
    // testes acima e travaria toda criacao de contato legitima (o caminho comum, cliente novo).
    limpar();
    const tel = '5586999990012';
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(tel.slice(-13));
    rede.get = (url) => (url.includes('/contacts') ? { status: 200, data: [] } : { status: 200, data: {} });
    let contatoCriado = false;
    rede.post = (url) => { if (url.includes('/contacts')) contatoCriado = true; return { status: 201, data: { id: 4242 } }; };
    const id = await buscarOuCriarContato(tel, 'Fulano');
    igual('busca chega ao fim sem achar → cria contato normalmente', id, 4242);
    checar('   POST /contacts foi chamado', contatoCriado);
  }

  // ============================================================
  // MEDIDO em 03/09/2026 limpando a aba "Agendamento de Consulta": o MESMO cliente salvo com e sem
  // DDI nao casava, e cada lead que ja existia no Moskit Boost em formato local virava contato novo
  // + deal duplicado. 46 dos 87 negocios abertos da aba tinham outro negocio no mesmo telefone pelos
  // ultimos 8 digitos, contra 20 pela comparacao inteira. `mesmoTelefone` (src/telefone.js) sempre
  // foi a comparacao certa — so nao era usada aqui.
  console.log('\n=== buscarOuCriarContato: mesmo telefone com e sem DDI e o MESMO cliente ===');
  {
    limpar();
    const comDdi = '558694751616';   // como chega do WhatsApp
    const semDdi = '8694751616';     // como o Moskit Boost gravou
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ? OR phone = ?').run(comDdi.slice(-13), semDdi.slice(-13));
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?, ?, ?, ?)')
      .run(semDdi.slice(-13), 7777, 'Jéssica', '{}');
    let contatoCriado = false;
    rede.post = (url) => { if (url.includes('/contacts')) contatoCriado = true; return { status: 201, data: { id: 9999 } }; };
    const id = await buscarOuCriarContato(comDdi, 'Jéssica');
    igual('espelho gravado SEM DDI é achado pelo número COM DDI', id, 7777);
    checar('   e nenhum contato duplicado foi criado', !contatoCriado);
  }
  {
    // MEDIDO em 04/09/2026 na base real: 22 pares de contatos compartilham os 8 dígitos finais sendo
    // pessoas DIFERENTES — "Pedro Amorim (55 99 84452303)" x "Lilian Naves (55 34 84452303)".
    // Casá-los poria o negócio de um cliente sob a ficha do outro. Achado pela simulação de 10 leads,
    // que ligou um deal ao contato errado exatamente assim.
    limpar();
    db.prepare("DELETE FROM moskit_contacts WHERE phone LIKE '%84452303'").run();
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?,?,?,?)')
      .run('559984452303', 6001, 'Pedro Amorim', '{}');
    let criado = false;
    rede.get = (url) => (url.includes('/contacts') ? { status: 200, data: [] } : { status: 200, data: {} });
    rede.post = (url) => { if (url.includes('/contacts')) criado = true; return { status: 201, data: { id: 6002 } }; };
    const id = await buscarOuCriarContato('553484452303', 'Lilian Naves');
    igual('DDD diferente com mesmo sufixo → NÃO é o mesmo cliente', id, 6002);
    checar('   criou contato próprio em vez de reusar o do outro cliente', criado);
  }
  {
    // Contraprova: mesmo DDD, só variando o nono dígito e o DDI → é a mesma pessoa e tem que casar.
    limpar();
    db.prepare("DELETE FROM moskit_contacts WHERE phone LIKE '%94751616'").run();
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?,?,?,?)')
      .run('8694751616', 6010, 'Jéssica', '{}');
    let criado = false;
    rede.post = (url) => { if (url.includes('/contacts')) criado = true; return { status: 201, data: { id: 6011 } }; };
    const id = await buscarOuCriarContato('558694751616', 'Jéssica');
    igual('mesmo DDD, com e sem DDI → é o mesmo cliente', id, 6010);
    checar('   e não criou duplicata', !criado);
  }
  {
    // Contraprova da ambiguidade: dois contatos DIFERENTES com o mesmo sufixo não podem eleger um
    // vencedor no palpite — cai para a busca na API, que é quem sabe desempatar.
    limpar();
    db.prepare("DELETE FROM moskit_contacts WHERE phone LIKE '%99887766'").run();
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?, ?, ?, ?)').run('5586999887766', 111, 'A', '{}');
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?, ?, ?, ?)').run('5511999887766', 222, 'B', '{}');
    rede.get = (url) => (url.includes('/contacts') ? { status: 200, data: [] } : { status: 200, data: {} });
    rede.post = () => ({ status: 201, data: { id: 3333 } });
    const id = await buscarOuCriarContato('5521999887766', 'C');
    igual('sufixo ambíguo (2 contatos) → não escolhe nenhum, segue para a API', id, 3333);
  }
  {
    // O outro lado do bug: a busca na API usava `.includes()`, que só casa quando o número salvo é
    // igual ou MAIS LONGO que o buscado. Aqui o contato existe no CRM gravado sem DDI.
    limpar();
    const comDdi = '558694751617';
    db.prepare('DELETE FROM moskit_contacts WHERE phone = ?').run(comDdi.slice(-13));
    rede.get = (url) => (url.includes('/contacts')
      ? { status: 200, data: [{ id: 5555, name: 'Cliente Antigo', phones: [{ number: '(86) 9475-1617' }] }] }
      : { status: 200, data: {} });
    let contatoCriado = false;
    rede.post = (url) => { if (url.includes('/contacts')) contatoCriado = true; return { status: 201, data: { id: 6666 } }; };
    const id = await buscarOuCriarContato(comDdi, 'Cliente Antigo');
    igual('contato do CRM gravado sem DDI é achado na busca da API', id, 5555);
    checar('   e nenhum contato duplicado foi criado', !contatoCriado);
  }

  // ============================================================
  // MEDIDO em 04/09/2026 pela simulacao de 10 leads (simular-10-leads-funil-teste.js): com 4.267
  // contatos na conta e 10 por pagina, chegar ao fim da lista exigiria 427 paginas contra um teto de
  // 20 — entao TODO lead novo estourava o teto e lancava, e nenhum cliente conseguia ser cadastrado.
  // O erro estava nos logs de producao sem ninguem ter ligado uma coisa na outra. A saida nao e
  // aumentar o teto (427 requisicoes por lead), e reconhecer quando "nao achei" ja basta: a listagem
  // vem do mais novo pro mais antigo, entao alcancar uma pagina que o espelho JA conhece prova que
  // as duas coberturas se encontraram.
  console.log('\n=== buscarOuCriarContato: teto de paginas nao pode impedir cliente novo ===');
  {
    limpar();
    const tel = '5586999990020';
    db.prepare('DELETE FROM moskit_contacts').run();
    // Espelho conhece um contato antigo; a API devolve uma pagina so com ele (e sempre mais token,
    // como acontece de verdade numa conta de milhares de contatos).
    db.prepare('INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?,?,?,?)')
      .run('5586988887777', 4242, 'Cliente Antigo', '{}');
    let paginas = 0;
    rede.get = (url) => {
      if (!url.includes('/contacts')) return { status: 200, data: {} };
      paginas++;
      return {
        status: 200,
        data: [{ id: 4242, name: 'Cliente Antigo', phones: [{ number: '5586988887777' }] }],
        headers: { 'x-moskit-listing-next-page-token': 'sempre-tem-mais' },
      };
    };
    let criado = false;
    rede.post = (url) => { if (url.includes('/contacts')) criado = true; return { status: 201, data: { id: 5150 } }; };
    const id = await buscarOuCriarContato(tel, 'Cliente Novo');
    igual('alcancou o espelho → conclui "nao existe" e CRIA o contato novo', id, 5150);
    checar('   POST /contacts foi chamado', criado);
    checar('   e parou na 1a pagina em vez de varrer o teto inteiro', paginas === 1, paginas);
  }
  {
    // O outro lado: espelho VAZIO e a lista nunca acaba → a duvida e real, e ai LANCA mesmo (a
    // protecao de 24/08 continua de pe onde ela faz sentido).
    limpar();
    db.prepare('DELETE FROM moskit_contacts').run();
    rede.get = (url) => (url.includes('/contacts')
      ? { status: 200, data: [{ id: 1, name: 'Outro', phones: [{ number: '5511777776666' }] }], headers: { 'x-moskit-listing-next-page-token': 'sempre-tem-mais' } }
      : { status: 200, data: {} });
    let criado = false;
    rede.post = (url) => { if (url.includes('/contacts')) criado = true; return { status: 201, data: { id: 9 } }; };
    const erro = await esperarErro(() => buscarOuCriarContato('5586999990021', 'Fulano'));
    checar('espelho vazio + lista infinita → LANCA em vez de criar as cegas', !!erro && !criado, { erro, criado });
    checar('   e a mensagem diz o que fazer (importar-moskit)', String(erro).includes('importar-moskit'), erro);
  }
  {
    // MEDIDO em 04/09/2026 contra a API real: com `pageToken` a listagem de /contacts devolve a MESMA
    // primeira página indefinidamente — o parâmetro é ignorado em silêncio. O nome que funciona é
    // `nextPageToken`, o mesmo que importarContatosMoskit sempre usou. Este teste trava a paginação
    // pelo NOME do parâmetro: se alguém voltar para `pageToken`, a busca gira em falso de novo.
    limpar();
    db.prepare('DELETE FROM moskit_contacts').run();
    let chamadasContatos = 0;
    rede.get = (url) => {
      if (!url.includes('/contacts')) return { status: 200, data: {} };
      chamadasContatos++;
      // 1ª página devolve token; a partir da 2ª, fim da lista. Se o código parar de mandar o token
      // (ou mandar com o nome errado), ele nunca sai da 1ª e estoura o teto em vez de criar.
      if (chamadasContatos === 1) {
        return { status: 200, data: [{ id: 1, name: 'A', phones: [{ number: '5586911111111' }] }], headers: { 'x-moskit-listing-next-page-token': 'tok2' } };
      }
      return { status: 200, data: [{ id: 2, name: 'B', phones: [{ number: '5586922222222' }] }], headers: {} };
    };
    rede.post = () => ({ status: 201, data: { id: 4321 } });
    const id = await buscarOuCriarContato('5586933333333', 'Cliente Novo');
    const paginas = de('GET', '/contacts').map((c) => c.cfg?.params || {});
    igual('paginação de /contacts avança de verdade → chega ao fim e cria', id, 4321);
    checar('   a 2ª página foi pedida com nextPageToken (não pageToken)', paginas[1]?.nextPageToken === 'tok2', paginas[1]);
    checar('   e nenhuma chamada usou o parâmetro que a API ignora', !paginas.some((p) => 'pageToken' in p), paginas);
  }
  {
    // A varredura alimenta o espelho pelo caminho — e o que faz a cobertura crescer sozinha, em vez
    // de depender de alguem lembrar de chamar /importar-moskit.
    limpar();
    db.prepare('DELETE FROM moskit_contacts').run();
    rede.get = (url) => (url.includes('/contacts')
      ? { status: 200, data: [{ id: 777, name: 'Passou Por Aqui', phones: [{ number: '5586955554444' }] }], headers: {} }
      : { status: 200, data: {} });
    rede.post = () => ({ status: 201, data: { id: 888 } });
    await buscarOuCriarContato('5586999990022', 'Fulano');
    const gravado = db.prepare('SELECT moskit_id FROM moskit_contacts WHERE phone = ?').get('5586955554444');
    igual('contato visto na varredura entra no espelho', gravado?.moskit_id, 777);
  }

  // ============================================================
  console.log('\n=== buscarDealPorContato: pagina de verdade (?start=) e nao conclui "nao existe" numa falha ===');
  {
    limpar();
    rede.get = (url) => (url.includes('/deals') ? { status: 429, data: [] } : { status: 200, data: {} });
    const erro = await esperarErro(() => buscarDealPorContato(555));
    checar('429 na busca de deal → LANCA em vez de concluir "nao existe"', !!erro, erro);
  }
  {
    limpar();
    rede.get = (url) => { if (url.includes('/deals')) throw new Error('timeout of 30000ms exceeded'); return { status: 200, data: {} }; };
    const erro = await esperarErro(() => buscarDealPorContato(555));
    checar('timeout na busca de deal → LANCA', !!erro, erro);
  }
  {
    // contacts[] vem na PROPRIA listagem de /deals (confirmado empiricamente em 24/08/2026) — acha
    // sem nenhum GET extra por deal, o N+1 que existia antes (page:1 + um GET /deals/{id} por item).
    limpar();
    rede.get = (url) => (url.includes('/deals')
      ? { status: 200, data: [{ id: 777, contacts: [{ id: 555 }] }, { id: 778, contacts: [{ id: 1 }] }] }
      : { status: 200, data: {} });
    const dealId = await buscarDealPorContato(555);
    igual('acha pelo contacts[] da propria listagem, sem GET extra', dealId, 777);
    igual('   nenhum GET /deals/777 individual', de('GET', '/deals/777').length, 0);
  }
  {
    // Contraprova: pagina incompleta (menos de 10) e o fim de verdade da lista — sem achar, devolve
    // null (o "nao existe" honesto), nunca lanca so porque nao viu a conta inteira.
    limpar();
    rede.get = (url) => (url.includes('/deals') ? { status: 200, data: [{ id: 1, contacts: [{ id: 2 }] }] } : { status: 200, data: {} });
    const dealId = await buscarDealPorContato(999);
    igual('pagina incompleta sem achar → null (fim de verdade da lista)', dealId, null);
  }

  // ============================================================
  console.log('\n=== importarContatosMoskit: mesmo limiar de telefone que o resto do sistema (MIN_DIGITOS=8) ===');
  {
    limpar();
    rede.get = () => ({
      status: 200,
      data: [
        { id: 1, name: 'Fixo sem DDD', phones: [{ number: '32345678' }] },   // 8 digitos
        { id: 2, name: 'Celular completo', phones: [{ number: '5511988887777' }] }, // 13 digitos
        { id: 3, name: 'Curto demais', phones: [{ number: '1234567' }] },   // 7 digitos
      ],
      headers: {},
    });
    const r = await importarContatosMoskit();
    igual('3 contatos, mas so 2 telefones validos entram no espelho', r.telefones_importados, 2);
    const espelho8 = db.prepare('SELECT moskit_id FROM moskit_contacts WHERE phone = ?').get('32345678');
    igual('telefone de 8 digitos (fixo sem DDD) ENTRA no espelho — antes o minimo era 10', espelho8?.moskit_id, 1);
    const espelhoCurto = db.prepare('SELECT moskit_id FROM moskit_contacts WHERE phone = ?').get('1234567');
    igual('telefone de 7 digitos continua de fora (MIN_DIGITOS)', espelhoCurto, undefined);
  }

  // ============================================================
  console.log('\n=== valor fora da lista do CRM: campo vazio + aviso uma unica vez ===');
  const CHAT_OPC = '5511977770000';
  {
    limpar();
    semear(CHAT_OPC, { deal_id: 50 });
    const invalidas = detectarOpcoesInvalidas({ area_direito: 'Direito Civil', origem: 'Indicação', captacao: 'Bruno' });
    igual('detecta os dois valores inexistentes', invalidas.length, 2);
    checar('   e nao acusa o valor valido', !invalidas.some((i) => i.campo === 'captacao'), invalidas);

    igual('primeira vez → avisa', await registrarOpcoesInvalidas(50, CHAT_OPC, invalidas), true);
    igual('   nenhuma nota (so Telegram agora)', notas().length, 0);
    igual('   um aviso no Telegram', telegrams().length, 1);
    checar('   o Telegram diz que o campo ficou em branco', (telegrams()[0].corpo.text || '').includes('Direito Civil'), telegrams()[0].corpo.text);

    limpar();
    igual('mesmo conjunto → nao repete', await registrarOpcoesInvalidas(50, CHAT_OPC, invalidas), false);
    igual('   nenhum Telegram novo', telegrams().length, 0);
  }

  // A SONDAGEM nao pode escrever aviso de preenchimento. MEDIDO em producao em 04/09/2026: o assunto
  // "Antecipacao de colacao de grau" (texto livre, correto, que foi para o NOME do negocio) fez o log
  // dizer "⚠️ opcao nao reconhecida — campo fica vazio" tres vezes, porque rejeitarAssuntoQueEhArea
  // pergunta "isto e nome de area?" pelo caminho que loga. O dono leu e pediu para cadastrar o assunto
  // numa lista que nao existe. Aviso que descreve o contrario do que aconteceu manda arrumar o que
  // esta certo — e por isso a sondagem tem funcao propria (ehOpcaoConhecida), silenciosa.
  {
    const logOriginal = console.log;
    const linhas = [];
    console.log = (...a) => { linhas.push(a.join(" ")); };
    let dadosAssuntoBom;
    let dadosAssuntoArea;
    try {
      dadosAssuntoBom = { assunto: "Antecipacao de colacao de grau" };
      rejeitarAssuntoQueEhArea(dadosAssuntoBom);
      dadosAssuntoArea = { assunto: "Direito Digital" };
      rejeitarAssuntoQueEhArea(dadosAssuntoArea);
      detectarOpcoesInvalidas({ area_direito: "Direito Civil" });
    } finally {
      console.log = logOriginal;
    }
    igual("assunto de texto livre SOBREVIVE", dadosAssuntoBom.assunto, "Antecipacao de colacao de grau");
    checar("   e a sondagem nao escreve aviso de opcao nao reconhecida",
      !linhas.some((l) => l.includes("opcao nao reconhecida")), linhas);
    // O controle: a regra que a sondagem serve continua funcionando.
    checar("assunto que E nome de area continua sendo trocado pelo neutro",
      /consulta jur/i.test(dadosAssuntoArea.assunto), dadosAssuntoArea.assunto);
    checar("   e o detector de opcao invalida tambem ficou silencioso (o caminho de escrita ja loga)",
      !linhas.some((l) => l.includes("opcao nao reconhecida")), linhas);
  }

  // ============================================================
  // O titulo do deal era congelado: "Cliente - Direito Digital" ficava para sempre porque a regra antiga
  // preservava qualquer nome diferente do nome cru do bot.
  console.log('\n=== titulo do deal: o bot corrige o que ele mesmo escreveu ===');
  const CHAT_NOME = '5511966660000';
  {
    limpar();
    semear(CHAT_NOME, { deal_id: 60, custom_fields_bot: JSON.stringify({ __name: 'Fulano de Tal - Direito Digital' }) });
    let seq = [
      { id: 60, name: 'Fulano de Tal - Direito Digital', entityCustomFields: [] },
      { id: 60, entityCustomFields: CF_DADOS },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(60, DADOS, 555, { chatId: CHAT_NOME }));
    igual('titulo escrito pelo bot → atualizado com o assunto novo', de('PUT', '/deals/60')[0]?.corpo?.name, 'Fulano de Tal - Inventario');
    igual('   autoria do nome atualizada', JSON.parse(linha(CHAT_NOME).custom_fields_bot).__name, 'Fulano de Tal - Inventario');
  }
  {
    limpar();
    semear(CHAT_NOME, { deal_id: 61, custom_fields_bot: JSON.stringify({ __name: 'Fulano de Tal - Direito Digital' }) });
    let seq = [
      { id: 61, name: 'URGENTE - Fulano (ver com o Dr. Bruno)', entityCustomFields: [] },
      { id: 61, entityCustomFields: CF_DADOS },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(61, DADOS, 555, { chatId: CHAT_NOME }));
    igual('titulo renomeado por humano → preservado', de('PUT', '/deals/61')[0]?.corpo?.name, 'URGENTE - Fulano (ver com o Dr. Bruno)');
  }

  // ============================================================
  // O BUG 1d, e a regressao que autoriza o conserto.
  //
  // camposPendentes considerava assunto = "Consulta juridica" como PREENCHIDO. Como esse e o
  // placeholder que o proprio prompt manda usar quando ninguem descreveu o caso, o assunto nunca
  // voltava a "pendentes" -> o prompt dizia "nenhum campo pendente" -> o modelo escolhia a acao
  // `nota` -> `nota` nao faz PUT -> o titulo ficava congelado no placeholder para sempre, mesmo
  // depois de o last_data ja ter o tema real (deals 48407608, 48287898 e 48206720 no corpus).
  //
  // O conserto faz essas conversas voltarem a fazer PUT, e e por isso que a segunda metade deste
  // bloco existe: se o PUT deixasse de respeitar renomeacao humana, o conserto viraria um bug pior
  // que o original — o bot reescrevendo o titulo que a equipe ajustou a mao. Se estes testes
  // cairem, a linha em camposPendentes volta atras.
  console.log('');
  console.log('=== assunto placeholder conta como PENDENTE (descongela o titulo) ===');
  {
    const base = { origem: 'Instagram', tipo_consulta: 'consulta gratis', area_direito: 'Direito de Familia', advogado_responsavel: 'Berto' };
    igual('assunto = "Consulta juridica" → PENDENTE', String(camposPendentes({ ...base, assunto: ASSUNTO_NEUTRO })), 'assunto');
    // Sem acento e minusculo: e a forma que o prompt manda o modelo devolver, e ehAssuntoNeutro
    // normaliza os dois lados. Se essa normalizacao quebrar, metade dos casos reais escapa.
    igual('   sem acento tambem → PENDENTE', String(camposPendentes({ ...base, assunto: 'consulta juridica' })), 'assunto');
    igual('   com espaco em volta → PENDENTE', String(camposPendentes({ ...base, assunto: '  Consulta Jurídica  ' })), 'assunto');
    igual('assunto especifico → NAO pendente', String(camposPendentes({ ...base, assunto: 'Abatimento do FIES' })), '');
    igual('assunto vazio → PENDENTE (comportamento antigo, intacto)', String(camposPendentes({ ...base, assunto: '' })), 'assunto');
    igual('string "null" → PENDENTE (comportamento antigo, intacto)', String(camposPendentes({ ...base, assunto: 'null' })), 'assunto');
    // O placeholder NAO pode contaminar os outros campos obrigatorios: "Consulta juridica" e valor
    // legitimo em nenhum deles, mas a regra e so do assunto e tem de continuar sendo.
    igual('a regra e SO do assunto', String(camposPendentes({ ...base, assunto: 'Guarda', tipo_consulta: ASSUNTO_NEUTRO })), '');
  }

  console.log('');
  console.log('=== e o PUT que isso libera continua respeitando renomeacao humana ===');
  const CHAT_1D = '5511955550000';
  {
    limpar();
    // Deal que nasceu com o placeholder no titulo, escrito pelo BOT (autoria registrada).
    semear(CHAT_1D, { deal_id: 70, custom_fields_bot: JSON.stringify({ __name: `Rayra Pureza - ${ASSUNTO_NEUTRO}` }) });
    let seq = [
      { id: 70, name: `Rayra Pureza - ${ASSUNTO_NEUTRO}`, entityCustomFields: [] },
      { id: 70, entityCustomFields: CF_DADOS },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(70, { ...DADOS, nome: 'Rayra Pureza' }, 555, { chatId: CHAT_1D }));
    igual('titulo com placeholder escrito pelo bot → recebe o assunto real', de('PUT', '/deals/70')[0]?.corpo?.name, 'Rayra Pureza - Inventario');
  }
  {
    limpar();
    // Mesmo cenario, mas a equipe renomeou o deal a mao depois. O PUT nao pode desfazer isso.
    semear(CHAT_1D, { deal_id: 71, custom_fields_bot: JSON.stringify({ __name: `Rayra Pureza - ${ASSUNTO_NEUTRO}` }) });
    let seq = [
      { id: 71, name: 'Rayra Pureza - FIES (falar com a Layla antes)', entityCustomFields: [] },
      { id: 71, entityCustomFields: CF_DADOS },
    ];
    rede.get = () => ({ status: 200, data: seq.shift() });
    await esperarErro(() => atualizarNegocioMoskit(71, { ...DADOS, nome: 'Rayra Pureza' }, 555, { chatId: CHAT_1D }));
    igual('renomeado a mao → PRESERVADO mesmo com o assunto novo em maos', de('PUT', '/deals/71')[0]?.corpo?.name, 'Rayra Pureza - FIES (falar com a Layla antes)');
  }

  // ============================================================
  // reconciliarVinculoAtividades: rede de seguranca do vinculo Atividade x negocio. MEDIDO 14-17/08/2026
  // em 6 negocios: o Moskit responde 429/timeout quando a varredura bate forte, e a rotina antiga
  // retentava a cada 30 min SEM religar nada, inundando o Telegram com o mesmo aviso (o dedup por
  // string do resumo nao segurava porque o subconjunto de falhas mudava a cada rodada). Regras novas:
  // cooldown por linha (que dobra a cada falha), erro transitorio SILENCIOSO, desistencia terminal apos
  // VINCULO_MAX_TENTATIVAS com UM aviso final (dedup por vinculo_aviso_hash), e estado terminal que so
  // o religar-atividade.js desfaz.
  console.log('\n=== reconciliarVinculoAtividades: backoff, desistencia e dedup ===');
  const CHAT_VINC = '5511966000001';
  const ATV_VINC = 880001;
  {
    limpar();
    semear(CHAT_VINC, { deal_id: 30, atividade_moskit_id: ATV_VINC });
    // Moskit rate-limitando: toda leitura da atividade volta 429.
    rede.get = () => ({ status: 429, data: {} });

    const r1 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('1a tentativa com 429 → erro transitorio', r1.erros_transitorios, 1);
    igual('   nenhum Telegram (429 nao e "conferir na mao")', telegrams().length, 0);
    igual('   falhas = 1', linha(CHAT_VINC).vinculo_falhas, 1);
    checar('   cooldown gravado', !!linha(CHAT_VINC).vinculo_backoff_ate);

    limpar();
    const r2 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('ciclo seguinte dentro do cooldown → linha pulada', r2.cooldown, 1);
    igual('   sem chamar a rede', de('GET', '/activities/').length, 0);
    igual('   nenhum Telegram novo', telegrams().length, 0);
  }
  {
    // Simula o cooldown vencer (o bot nao dorme 30 min no teste) ate estourar MAX_TENTATIVAS.
    // Moskit continua rate-limitando: o stub de 429 fica ligado o bloco inteiro — sem isso o dublê
    // devolveria 200 e a 2a tentativa "religaria com sucesso", zerando o estado.
    limpar();
    rede.get = () => ({ status: 429, data: {} });
    db.prepare('UPDATE conversations SET vinculo_backoff_ate = NULL WHERE chat_id = ?').run(CHAT_VINC);
    const r3 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('2a tentativa → falhas = 2', r3.erros_transitorios, 1);
    igual('   e cooldown dobrado gravado', linha(CHAT_VINC).vinculo_falhas, 2);

    db.prepare('UPDATE conversations SET vinculo_backoff_ate = NULL WHERE chat_id = ?').run(CHAT_VINC);
    const r4 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('3a tentativa → desistiu (estado terminal)', r4.desistidas.length, 1);
    igual('   vinculo_desistiu = 1', linha(CHAT_VINC).vinculo_desistiu, 1);
    checar('   cooldown limpo (nunca mais retenta sozinho)', linha(CHAT_VINC).vinculo_backoff_ate === null);
    igual('   UM aviso final no Telegram', telegrams().length, 1);
    checar('   o aviso traz o comando do script',
      telegrams()[0]?.corpo?.text?.includes(`religar-atividade.js 30 ${ATV_VINC}`), telegrams()[0]?.corpo?.text);
    igual('   e o hash de dedup fica gravado', linha(CHAT_VINC).vinculo_aviso_hash, `desistida|30|${ATV_VINC}`);

    limpar();
    const r5 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('ciclo seguinte → linha parada (terminal), sem rede', r5.paradas, 1);
    igual('   NENHUM Telegram novo (dedup por linha, nao por resumo)', telegrams().length, 0);
  }
  {
    // religar-atividade.js limpa o estado terminal e a rotina volta a conferir a linha.
    limpar();
    db.prepare('UPDATE conversations SET vinculo_desistiu = 0, vinculo_falhas = 0, vinculo_backoff_ate = NULL, vinculo_aviso_hash = NULL WHERE chat_id = ?').run(CHAT_VINC);
    rede.get = () => ({ status: 200, data: { id: ATV_VINC, deals: [{ id: 30 }] } });
    const r6 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('apos o script limpar → reconferida e ja ok', r6.ja_ok, 1);
    igual('   estado continua zerado', linha(CHAT_VINC).vinculo_falhas, 0);
    igual('   nenhum Telegram', telegrams().length, 0);
  }
  {
    // dry-run tem que ser leitura pura (mesmo contrato da reconciliacao de classificacao).
    limpar();
    semear(CHAT_VINC, { deal_id: 30, atividade_moskit_id: ATV_VINC });
    rede.get = () => ({ status: 429, data: {} });
    const r7 = await reconciliarVinculoAtividades({ aplicar: false });
    igual('dry-run com 429 → nao grava falhas', r7.erros_transitorios, 1);
    igual('   vinculo_falhas continua 0', linha(CHAT_VINC).vinculo_falhas, 0);
    igual('   vinculo_desistiu continua 0', linha(CHAT_VINC).vinculo_desistiu, 0);
    igual('   nenhum Telegram', telegrams().length, 0);
  }
  {
    // Caminho feliz: atividade sem vinculo que o PUT consegue religar — reseta o estado.
    limpar();
    semear(CHAT_VINC, { deal_id: 30, atividade_moskit_id: ATV_VINC });
    rede.get = (url) => url.includes('/activities/')
      ? { status: 200, data: { id: ATV_VINC, deals: [], contacts: [{ id: 999 }] } }
      : { status: 200, data: {} };
    const r8 = await reconciliarVinculoAtividades({ aplicar: true });
    igual('atividade sem vinculo → religada', r8.religadas.length, 1);
    igual('   estado zerado', linha(CHAT_VINC).vinculo_falhas, 0);
    // Decisao de 02/09/2026: a religacao bem-sucedida deixou de virar nota (confirmacao de rotina).
    igual('   nenhuma nota (so o PUT de religacao)', notas().length, 0);
  }

  // ============================================================
  // A rede de seguranca: se o CRM ficar diferente do que o bot apurou, alguem tem que voltar e conferir.
  // As regras vieram da varredura real de 12/08/2026 (64 deals): area do CRM manda, responsavel e
  // derivado dela, e tipo de consulta so sobe para paga — nunca rebaixa para R$0.
  console.log('\n=== reconciliarClassificacao ===');
  const CHAT_REC = '5511955550000';
  const EDUCACIONAL = moskitIds.AREA_DIREITO['direito educacional'];
  const IURY = moskitIds.RESPONSAVEL_PROCESSO['iury'];
  // last_data com area LGPD (palpite antigo) — o CRM e que vai mandar nos testes abaixo.
  const LAST_DATA = JSON.stringify({ nome: 'Martha Luiza', assunto: 'Remoção', tipo_consulta: 'consulta paga', area_direito: 'LGPD', advogado_responsavel: 'Berto' });
  const MSGS_SEM_BLOCO = JSON.stringify([{ role: 'cliente', text: 'Boa tarde, preciso de ajuda' }]);
  const MSGS_COM_BLOCO = JSON.stringify([{ role: 'cliente', text: 'Boa tarde' }, { role: 'equipe', text: BLOCO_CONDICOES_PAGA }]);
  const dealRec = (campos, extras = {}) => ({
    status: 200,
    data: { id: 70, status: 'OPEN', contacts: [{ id: 555 }], entityCustomFields: campos, ...extras },
  });
  // Deal tipico dos 4 casos que a varredura achou: area Educacional, mas responsavel Berto (a tabela
  // nova diz Iury).
  const CRM_RESP_ERRADO = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, EDUCACIONAL), cf(CF.RESPONSAVEL, OPCAO.berto)];
  const CRM_RESP_CERTO = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, EDUCACIONAL), cf(CF.RESPONSAVEL, IURY)];
  const putDe = (dealId, cfId) => (de('PUT', `/deals/${dealId}`)[0]?.corpo?.entityCustomFields || []).find((c) => c.id === cfId)?.options;
  const semearRec = (extras = {}) => {
    db.prepare('DELETE FROM conversations').run();
    return semear(CHAT_REC, { deal_id: 70, last_data: LAST_DATA, messages: MSGS_COM_BLOCO, bloco_condicoes_enviado: 1, ...extras });
  };
  {
    // Dry-run: aponta o responsavel incoerente e nao escreve nada.
    limpar();
    semearRec();
    rede.get = () => dealRec(CRM_RESP_ERRADO);
    const r = await reconciliarClassificacao({});
    igual('dry-run: 1 deal analisado', r.analisados, 1);
    igual('   1 divergencia a corrigir', r.a_corrigir.length, 1);
    igual('   e ela e o Responsavel', r.a_corrigir[0].campo, 'Responsável pelo processo');
    igual('   nada corrigido', r.corrigidos.length, 0);
    igual('   nenhum PUT', de('PUT', '/deals/70').length, 0);
    igual('   nenhuma nota', notas().length, 0);
  }
  {
    // Aplicar: corrige o responsavel a partir da AREA QUE ESTA NO CRM (Educacional → Iury), mesmo sem
    // registro de autoria — responsavel e campo derivado, nao opiniao, entao nao entra em "legado".
    limpar();
    let n = 0;
    rede.get = () => dealRec(n++ < 2 ? CRM_RESP_ERRADO : CRM_RESP_CERTO);
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('aplicar: 1 campo corrigido', r.corrigidos.length, 1);
    igual('   nada em "legado"', r.legado.length, 0);
    igual('   fez 1 PUT', de('PUT', '/deals/70').length, 1);
    igual('   o PUT leva o responsavel da tabela (Iury)', String(putDe(70, CF.RESPONSAVEL)), String([IURY]));
    igual('   ...e preserva a area do CRM (nao volta pro LGPD do last_data)', String(putDe(70, CF.AREA_DIREITO)), String([EDUCACIONAL]));
    // Decisao de 02/09/2026: a reconciliacao bem-sucedida deixou de virar nota — o PUT acima e a
    // fonte de verdade.
    igual('   nenhuma nota (so o PUT de reconciliacao)', notas().length, 0);
  }
  {
    // Area vazia no CRM: aí sim o bot preenche com o que apurou.
    limpar();
    semearRec();
    let n = 0;
    const VAZIO = [cf(CF.TIPO_CONSULTA, OPCAO.paga)];
    const DEPOIS = [cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.AREA_DIREITO, OPCAO.lgpd), cf(CF.RESPONSAVEL, OPCAO.berto)];
    rede.get = () => dealRec(n++ < 2 ? VAZIO : DEPOIS);
    const r = await reconciliarClassificacao({ aplicar: true });
    checar('area vazia no CRM → preenchida', r.corrigidos.some((c) => c.campo === 'Área do Direito'), r.corrigidos);
    igual('   o PUT leva a area do bot', String(putDe(70, CF.AREA_DIREITO)), String([OPCAO.lgpd]));
  }
  {
    // NUNCA REBAIXAR: CRM esta pago e o bloco nao aparece nas mensagens → nao mexe no tipo nem no preco.
    limpar();
    semearRec({ messages: MSGS_SEM_BLOCO });
    rede.get = () => dealRec(CRM_RESP_CERTO);
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('CRM pago sem bloco nas mensagens → entra em nao_rebaixados', r.nao_rebaixados.length, 1);
    igual('   nenhum PUT (nada mais divergia)', de('PUT', '/deals/70').length, 0);
    igual('   a coluna do bloco foi corrigida para 0', linha(CHAT_REC).bloco_condicoes_enviado, 0);
  }
  {
    // Dry-run e leitura PURA: reporta o recalculo do bloco mas nao grava a coluna. Sem isso, "conferir
    // sem escrever" deixa de ser verdade e o relatorio perde a confianca.
    limpar();
    semearRec({ messages: MSGS_SEM_BLOCO, bloco_condicoes_enviado: 1 });
    rede.get = () => dealRec(CRM_RESP_CERTO);
    const r = await reconciliarClassificacao({});
    igual('dry-run reporta o recalculo do bloco', r.bloco_recalculado.length, 1);
    igual('   mas NAO grava a coluna', linha(CHAT_REC).bloco_condicoes_enviado, 1);
  }
  {
    // SOBE PARA PAGA: CRM esta cortesia mas o bloco esta nas mensagens (coluna zerada, tipico de conversa
    // anterior ao checkpoint) → corrige o tipo e o preco.
    limpar();
    semearRec({ bloco_condicoes_enviado: 0 });
    let n = 0;
    const CRM_GRATIS = [cf(CF.TIPO_CONSULTA, OPCAO.gratis), cf(CF.AREA_DIREITO, EDUCACIONAL), cf(CF.RESPONSAVEL, IURY)];
    rede.get = () => dealRec(n++ < 2 ? CRM_GRATIS : CRM_RESP_CERTO);
    const r = await reconciliarClassificacao({ aplicar: true });
    checar('bloco recalculado das mensagens → tipo corrigido para paga', r.corrigidos.some((c) => c.campo === 'Tipo de Consulta'), r.corrigidos);
    igual('   o PUT leva "consulta paga"', String(putDe(70, CF.TIPO_CONSULTA)), String([OPCAO.paga]));
    igual('   ...e o preco sobe para 35000', de('PUT', '/deals/70')[0]?.corpo?.price, 35000);
    igual('   a coluna do bloco foi corrigida para 1', linha(CHAT_REC).bloco_condicoes_enviado, 1);
    igual('   nada em nao_rebaixados', r.nao_rebaixados.length, 0);
  }
  {
    // Area travada por correcao manual: nunca e tocada, nem em modo aplicar. Como a area do CRM passou a
    // ser a fonte, o unico jeito de a area divergir e ela estar VAZIA la — e mesmo assim, travada, o bot
    // nao preenche. O responsavel aqui fica coerente com o LGPD do last_data (Berto), pra que a unica
    // divergencia do caso seja a area.
    limpar();
    semearRec({ campos_travados: JSON.stringify([CF.AREA_DIREITO]) });
    rede.get = () => dealRec([cf(CF.TIPO_CONSULTA, OPCAO.paga), cf(CF.RESPONSAVEL, OPCAO.berto)]);
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('area travada entra em "travados"', r.travados.length, 1);
    igual('   nao conta como corrigida', r.corrigidos.length, 0);
    igual('   nenhum PUT', de('PUT', '/deals/70').length, 0);
  }
  {
    // Area com valor no CRM e sem registro de autoria: preservada (nao sobrescreve ajuste manual antigo).
    // O relatorio nao lista como divergencia porque a area do CRM passou a ser a fonte — e exatamente
    // isso que mantem a promessa de nao mexer nos deals que ja existiam.
    limpar();
    semearRec();
    rede.get = () => dealRec(CRM_RESP_CERTO);
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('CRM coerente → sem divergencia', r.sem_divergencia, 1);
    igual('   nenhum PUT', de('PUT', '/deals/70').length, 0);
    igual('   nenhuma nota', notas().length, 0);
  }
  {
    // Deal fechado: nao se reclassifica negocio ganho/perdido.
    limpar();
    semearRec();
    rede.get = () => dealRec(CRM_RESP_ERRADO, { status: 'WON' });
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('deal WON entra em "fechados"', r.fechados.length, 1);
    igual('   nenhum PUT', de('PUT', '/deals/70').length, 0);
  }
  {
    // Deal apagado no CRM: caso conhecido, nao erro de integracao.
    limpar();
    semearRec();
    rede.get = () => ({ status: 404, data: {} });
    const r = await reconciliarClassificacao({ aplicar: true });
    igual('404 entra em deals_apagados', r.deals_apagados.length, 1);
    igual('   e nao em erros', r.erros.length, 0);
    igual('   nenhum PUT', de('PUT', '/deals/70').length, 0);
  }

  // ============================================================
  // Cursor de reconciliacao (modo 'antigos'): o modo 'recentes' (o de sempre, por updated_at dentro de
  // RECONCILIACAO_DIAS) nunca revisita um deal parado ha mais de 30 dias ou fora do top-N mais recentes
  // — ficava esquecido para sempre, mesmo com classificacao errada/vazia. O modo 'antigos' ordena por
  // reconciliado_em (NULL primeiro) e cada linha processada grava a hora atual, o que faz a proxima
  // rodada avancar para a fatia seguinte em vez de reler sempre os mesmos registros.
  console.log('\n=== reconciliarClassificacao: cursor "antigos" alcanca o que o modo "recentes" nunca revisita ===');
  {
    const sqliteAtras = (deslocamento) => db.prepare('SELECT datetime(\'now\', ?)').pluck().get(deslocamento);
    const CHAT_CURSOR_A = '5511966660001';
    const CHAT_CURSOR_B = '5511966660002';
    const CHAT_CURSOR_C = '5511966660003';
    const LAST_DATA_SEM_CLASSIFICACAO = JSON.stringify({ nome: 'Teste' });
    const RECONCILIADO_B_INICIAL = '2020-06-01 00:00:00';
    const RECONCILIADO_C_INICIAL = '2026-01-01 00:00:00';

    limpar();
    db.prepare('DELETE FROM conversations').run();
    // A: nunca reconciliado (NULL), atualizado agora — deve ser o PRIMEIRO no modo "antigos".
    semear(CHAT_CURSOR_A, { deal_id: 81, last_data: LAST_DATA_SEM_CLASSIFICACAO, reconciliado_em: null });
    // B: reconciliado ha muito tempo E fora da janela de RECONCILIACAO_DIAS (30d) — o modo "recentes"
    // nunca o alcanca; deve ser o SEGUNDO no modo "antigos".
    semear(CHAT_CURSOR_B, { deal_id: 82, last_data: LAST_DATA_SEM_CLASSIFICACAO, updated_at: sqliteAtras('-60 days'), reconciliado_em: RECONCILIADO_B_INICIAL });
    // C: reconciliado mais recentemente que B (mas ainda no passado), atualizado agora — fica por ULTIMO.
    semear(CHAT_CURSOR_C, { deal_id: 83, last_data: LAST_DATA_SEM_CLASSIFICACAO, reconciliado_em: RECONCILIADO_C_INICIAL });

    const rRecentes = await reconciliarClassificacao({ modo: 'recentes' });
    igual('modo "recentes" (default, dry-run): so alcanca quem esta dentro da janela de dias', rRecentes.analisados, 2);

    const r1 = await reconciliarClassificacao({ aplicar: true, modo: 'antigos', limite: 1 });
    igual('modo "antigos" #1: processa exatamente 1 linha', r1.analisados, 1);
    checar('   e marca reconciliado_em na que nunca tinha sido vista (A)', linha(CHAT_CURSOR_A).reconciliado_em !== null, linha(CHAT_CURSOR_A).reconciliado_em);
    igual('   B ainda nao foi tocada', linha(CHAT_CURSOR_B).reconciliado_em, RECONCILIADO_B_INICIAL);
    igual('   C ainda nao foi tocada', linha(CHAT_CURSOR_C).reconciliado_em, RECONCILIADO_C_INICIAL);

    const r2 = await reconciliarClassificacao({ aplicar: true, modo: 'antigos', limite: 1 });
    igual('modo "antigos" #2: avanca para a proxima mais antiga (B, fora da janela de dias — nunca alcancada pelo modo "recentes")', r2.analisados, 1);
    checar('   B foi marcada nesta rodada', linha(CHAT_CURSOR_B).reconciliado_em !== RECONCILIADO_B_INICIAL, linha(CHAT_CURSOR_B).reconciliado_em);
    igual('   C continua intocada (ainda nao chegou a vez dela — sem repetir A/B antes de esgotar)', linha(CHAT_CURSOR_C).reconciliado_em, RECONCILIADO_C_INICIAL);
  }

  // ============================================================
  // Funcoes de horario que nunca tiveram teste direto. Todas rodam com TZ=UTC (ver rodar-testes.js),
  // que e o fuso da VPS — e onde os bugs de fuso aparecem.
  console.log('\n=== Data-ancora e aritmetica de horario naive ===');
  {
    // A ancora vai pro prompt em TEXTO do escritorio, nunca em ISO. Se ela parecer com o formato que o
    // modelo tem que devolver, ele copia — foi o que colocou 3 reunioes reais no horario errado.
    const ancora = descreverAncora('2026-08-10T18:54:58.000Z');
    checar(`ancora nao tem forma de ISO: "${ancora}"`, !/\d{4}-\d{2}-\d{2}T/.test(ancora));
    checar('   e esta na hora do escritorio (15:54, nao 18:54)', ancora.includes('15:54'), ancora);
    checar('   com o dia da semana pra resolver dia relativo', ancora.includes('segunda-feira'), ancora);
    igual('   ancora invalida nao inventa data', descreverAncora('xxx'), '(desconhecida — nao resolva dias relativos)');
    // Uma mensagem de 22h no escritorio cai no dia SEGUINTE em UTC: e o erro de dia que a tabela de
    // referencia do prompt herdava quando a ancora ia crua.
    checar('   01:00Z vira 06/08 22:00 no escritorio, nao 07/08',
      descreverAncora('2026-08-07T01:00:00.000Z').startsWith('06/08/2026'),
      descreverAncora('2026-08-07T01:00:00.000Z'));

    // somarMinutosNaive define o FIM do evento. A virada de dia nunca tinha sido exercitada.
    igual('somarMinutosNaive: 17:30 + 60min', somarMinutosNaive('2026-08-05T17:30:00', 60), '2026-08-05T18:30:00');
    igual('somarMinutosNaive: 23:30 + 60min vira o dia', somarMinutosNaive('2026-08-05T23:30:00', 60), '2026-08-06T00:30:00');
    igual('somarMinutosNaive: vira o mes', somarMinutosNaive('2026-08-31T23:30:00', 60), '2026-09-01T00:30:00');
    igual('somarMinutosNaive: vira o ano', somarMinutosNaive('2026-12-31T23:30:00', 60), '2027-01-01T00:30:00');


    // formatarHorarioEscritorio e o que aparece na nota do CRM e no Telegram: trata a string naive
    // como UTC de proposito ("nao girar de novo"), entao 17:30 tem que sair 17:30 em qualquer fuso.
    checar('formatarHorarioEscritorio nao gira a hora', formatarHorarioEscritorio('2026-08-05T17:30:00').includes('17:30'), formatarHorarioEscritorio('2026-08-05T17:30:00'));
    igual('   e devolve null sem horario', formatarHorarioEscritorio(null), null);
  }

  // ------------------------------------------------------------
  console.log('\n=== Estado das notas de reuniao (idempotencia) ===');
  {
    // A tabela notas_reuniao E a garantia de que um e-mail nunca vira duas notas no prontuario do
    // cliente. Os UPDATE usam parametros NOMEADOS, e better-sqlite3 e estrito com eles: uma chave a
    // mais ou a menos lanca em runtime — e esses caminhos so seriam exercidos em producao.
    const camposVazios = () => ({
      doc_id: null, evento_id: null, deal_id: null, metodo: null,
      diagnostico: null, extracao: null, marcador: null,
    });

    for (const dryRun of [false, true]) {
      const s = stmtsNotas(dryRun);
      const id = `msg-${dryRun}`;
      const rotulo = dryRun ? '[dry-run]' : '[real]';

      s.inserir.run(id, 'Notas: "Consulta — X (Y)" de 14/08/2026');
      igual(`${rotulo} nasce em RESERVADO`, s.get.get(id).estado, 'RESERVADO');

      s.avancar.run({
        ...camposVazios(), gmail_message_id: id, estado: 'DEAL_RESOLVIDO',
        doc_id: 'doc1', evento_id: 'ev1', deal_id: 123, metodo: 'evento_telefone',
        diagnostico: '{}', ultimo_erro: null,
      });
      s.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'SEM_TRANSCRICAO', ultimo_erro: null });

      // O COALESCE de cada campo e o que permite avancar um passo sem reenviar o que ja se sabe —
      // sem ele, este passo apagaria o deal_id descoberto no passo anterior.
      igual(`${rotulo} COALESCE preserva o deal_id`, s.get.get(id).deal_id, 123);
      igual(`${rotulo} COALESCE preserva o doc_id`, s.get.get(id).doc_id, 'doc1');

      s.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'POSTANDO', marcador: '[ollow-notas:abcd1234]', ultimo_erro: null });
      s.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'POSTADA', ultimo_erro: null });

      // POSTADA = a nota existe no CRM e so o rotulo do Gmail faltou. Tem que ser retomavel, senao
      // o e-mail volta pra fila e a nota e postada de novo.
      checar(`${rotulo} POSTADA aparece em pendentes (retomavel)`,
        s.pendentes.all().some((x) => x.gmail_message_id === id && x.estado === 'POSTADA'));

      s.falhar.run('erro de teste', id);
      igual(`${rotulo} falhar incrementa tentativas`, s.get.get(id).tentativas, 1);

      s.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'CONCLUIDO', ultimo_erro: null });
      checar(`${rotulo} CONCLUIDO sai de pendentes`, !s.pendentes.all().some((x) => x.gmail_message_id === id));
      igual(`${rotulo} porDoc encontra pelo Doc`, s.porDoc.get('doc1')?.gmail_message_id, id);

      // O mesmo Doc chegando por outra mensagem (encaminhamento, reenvio) nao pode virar 2a nota.
      s.inserir.run(`${id}-b`, 'reenvio do mesmo Doc');
      let barrou = false;
      try {
        s.avancar.run({ ...camposVazios(), gmail_message_id: `${id}-b`, estado: 'DEAL_RESOLVIDO', doc_id: 'doc1', ultimo_erro: null });
      } catch { barrou = true; }
      checar(`${rotulo} indice unico barra o MESMO Doc em outra mensagem`, barrou);

      // Reprocessar o mesmo e-mail nao pode ressuscitar um caso ja concluido.
      s.inserir.run(id, 'assunto diferente');
      igual(`${rotulo} reinsert nao sobrescreve o estado`, s.get.get(id).estado, 'CONCLUIDO');
    }

    // As duas tabelas sao independentes de proposito: se o dry-run gravasse na real, a primeira
    // execucao de verdade acharia tudo CONCLUIDO e nao postaria nada.
    checar('dry-run e real nao compartilham estado',
      stmtsNotas(true).get.get('msg-false') === undefined && stmtsNotas(false).get.get('msg-true') === undefined);
  }

  // ------------------------------------------------------------
  console.log('\n=== Notas de reuniao: desistencia, silencio e Doc duplicado ===');

  // gmail so precisa aceitar rotulo: as chamadas de verdade estao cobertas pelos dublês de rede.
  const gmailFalso = {
    users: {
      messages: { modify: async () => ({}), get: async () => ({}) },
      labels: { list: async () => ({ data: { labels: [] } }), create: async () => ({ data: { id: 'L1' } }) },
    },
  };

  {
    // Sem teto de tentativas, um e-mail que falha sempre (deal apagado, Doc corrompido) reprocessava
    // a cada 10 min PARA SEMPRE — pagando OpenAI quando a falha era depois da extracao, e em silencio,
    // porque a coluna `tentativas` era incrementada e nunca lida por ninguem.
    limpar();
    const s = stmtsNotas(false);
    const id = 'msg-desiste';
    db.prepare('DELETE FROM notas_reuniao').run();
    s.inserir.run(id, 'assunto');
    s.avancar.run({
      doc_id: null, evento_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
      gmail_message_id: id, estado: 'DEAL_RESOLVIDO', deal_id: 48292471, ultimo_erro: null,
    });

    const p1 = await registrarFalhaNota({ stmts: s, gmail: gmailFalso, id, erro: 'timeout', dryRun: false });
    const p2 = await registrarFalhaNota({ stmts: s, gmail: gmailFalso, id, erro: 'timeout', dryRun: false });
    checar('1a e 2a falha nao desistem', p1 === false && p2 === false, [p1, p2]);
    igual('   estado preservado para o proximo ciclo', s.get.get(id).estado, 'DEAL_RESOLVIDO');
    igual('   telegram ainda em silencio', telegrams().length, 0);

    const p3 = await registrarFalhaNota({ stmts: s, gmail: gmailFalso, id, erro: 'deal 48292471 nao existe', dryRun: false });
    checar('3a falha DESISTE', p3 === true);
    igual('   estado terminal', s.get.get(id).estado, 'ERRO_PERMANENTE');
    checar('   sai de pendentes (nao volta no proximo ciclo)', !s.pendentes.all().some((x) => x.gmail_message_id === id));
    checar('   e avisa no Telegram com o comando de religar',
      telegrams().some((t) => t.corpo.text.includes('desistida') && t.corpo.text.includes('reprocessar-nota-reuniao')),
      telegrams().map((t) => t.corpo.text));
  }

  {
    // `ambiguo` = a RETOMADA nao conseguiu descobrir se a nota ja existe no CRM. Nao e o mesmo que
    // "o POST falhou": um POST que falha deixa POSTANDO e o ciclo seguinte reconcilia sozinho. Se
    // isso escalasse na primeira falha, uma queda de rede viraria trabalho manual a toa.
    limpar();
    const s = stmtsNotas(false);
    const id = 'msg-ambiguo';
    db.prepare('DELETE FROM notas_reuniao').run();
    s.inserir.run(id, 'assunto');
    s.avancar.run({
      doc_id: null, evento_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
      gmail_message_id: id, estado: 'POSTANDO', deal_id: 48292471, ultimo_erro: null,
    });

    const r = await registrarFalhaNota({ stmts: s, gmail: gmailFalso, id, erro: 'Moskit fora do ar', dryRun: false, ambiguo: true });
    checar('ambiguo escala na PRIMEIRA vez, sem esperar 3', r === true);
    igual('   vai para revisao manual, nao para erro', s.get.get(id).estado, 'REVISAR_MANUAL');
    checar('   com aviso dizendo que pode haver nota no CRM',
      telegrams().some((t) => t.corpo.text.includes('ambíguo')), telegrams().map((t) => t.corpo.text));
  }

  {
    // "Ciclo vazio" e o estado NORMAL: o que ja foi processado sai da busca pelo rotulo. O que precisa
    // de aviso e silencio prolongado — que tem a mesma cara de token expirado e de formato de assunto
    // mudado, as duas falhas que ninguem percebe.
    limpar();
    const marcarUltimoEmail = (quando) => db.prepare('UPDATE notas_reuniao_saude SET ultimo_email_em = ?, ultimo_aviso_em = NULL WHERE id = 1').run(quando);

    await conferirSilencioNotas({ viuMensagem: true, dryRun: false });
    igual('viu mensagem → nenhum aviso', telegrams().length, 0);

    marcarUltimoEmail('2026-08-01 10:00:00'); // bem antes de "agora"
    await conferirSilencioNotas({ viuMensagem: false, dryRun: false });
    checar('silencio prolongado → avisa',
      telegrams().some((t) => t.corpo.text.includes('nenhum e-mail novo')), telegrams().map((t) => t.corpo.text));

    const apos = telegrams().length;
    await conferirSilencioNotas({ viuMensagem: false, dryRun: false });
    igual('   e nao repete o aviso no ciclo seguinte', telegrams().length, apos);

    limpar();
    marcarUltimoEmail(new Date().toISOString().slice(0, 19).replace('T', ' '));
    await conferirSilencioNotas({ viuMensagem: false, dryRun: false });
    igual('ciclo vazio recente NAO avisa (e o estado normal)', telegrams().length, 0);
  }

  {
    // Doc duplicado cuja primeira copia NAO concluiu. O guard antigo so cobria CONCLUIDO: o resto
    // batia no indice unico de doc_id, lancava, e o e-mail voltava a cada 10 min para sempre.
    limpar();
    const s = stmtsNotas(false);
    db.prepare('DELETE FROM notas_reuniao').run();
    const DOC = 'AbC123_def-456GHI789jkl';

    s.inserir.run('msg-orfa', 'primeira copia');
    s.avancar.run({
      evento_id: null, deal_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
      gmail_message_id: 'msg-orfa', estado: 'ORFAO', doc_id: DOC, ultimo_erro: 'nao_encontrado',
    });

    const mensagem = {
      id: 'msg-reenvio',
      internalDate: String(Date.parse('2026-08-14T21:40:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Notas: "Consulta — X (Berto)" de 14/08/2026' }],
        mimeType: 'text/plain',
        body: { data: Buffer.from(`Resumo\nhttps://docs.google.com/document/d/${DOC}/edit`).toString('base64url') },
      },
    };

    const erro = await esperarErro(() => processarNotaReuniao({
      gmail: gmailFalso,
      calendar: google.calendar(),
      drive: { files: { export: async () => ({ data: '' }) } },
      mensagem,
      stmts: s,
      dryRun: false,
    }));

    igual('reenvio do mesmo Doc nao lanca constraint', erro, null);
    igual('   vira terminal, e nao volta a cada ciclo', s.get.get('msg-reenvio').estado, 'ERRO_PERMANENTE');
    checar('   apontando para a copia que precisa ser resolvida',
      (s.get.get('msg-reenvio').ultimo_erro || '').includes('msg-orfa'), s.get.get('msg-reenvio').ultimo_erro);
    igual('   e a primeira copia continua intacta', s.get.get('msg-orfa').estado, 'ORFAO');
    igual('   nenhuma nota foi postada', notas().length, 0);
  }

  {
    // O DEFEITO MAIS GRAVE que este bloco cobre: o rotulo do Gmail e aplicado DEPOIS de o estado
    // virar terminal, e o `messages.list` do mesmo ciclo roda logo em seguida. Se o indice de busca
    // do Gmail atrasar — ou se a retomada falhar sem conseguir rotular — a mesma mensagem volta na
    // lista, nenhum dos `if` de retomada casa (o estado nao e mais POSTANDO) e ela seria reprocessada
    // do zero: nova chamada de OpenAI e uma SEGUNDA nota no prontuario do cliente.
    const mensagemQualquer = {
      id: 'msg-reprocesso',
      internalDate: String(Date.parse('2026-08-14T21:40:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Notas: "Consulta — X (Berto)" de 14/08/2026' }],
        mimeType: 'text/plain',
        body: { data: Buffer.from('Resumo da reuniao').toString('base64url') },
      },
    };
    const rodar = (extra = {}) => processarNotaReuniao({
      gmail: gmailFalso,
      calendar: google.calendar(),
      drive: { files: { export: async () => ({ data: '' }) } },
      mensagem: mensagemQualquer,
      stmts: stmtsNotas(false),
      dryRun: false,
      ...extra,
    });

    for (const estado of ['CONCLUIDO', 'REVISAR_MANUAL', 'ORFAO', 'ERRO_PERMANENTE']) {
      limpar();
      const s = stmtsNotas(false);
      db.prepare('DELETE FROM notas_reuniao').run();
      s.inserir.run('msg-reprocesso', 'assunto');
      s.avancar.run({
        doc_id: null, evento_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
        gmail_message_id: 'msg-reprocesso', estado, deal_id: 48292471, ultimo_erro: null,
      });

      const r = await rodar();
      checar(`${estado} reaparecendo na busca NAO e reprocessado`, r.jaResolvido === true, r);
      igual(`   ${estado}: nenhuma nota postada`, notas().length, 0);
      igual(`   ${estado}: estado preservado`, s.get.get('msg-reprocesso').estado, estado);
    }

    // O religamento manual atravessa a guarda de proposito — e o unico jeito de ressuscitar um orfao.
    limpar();
    const s = stmtsNotas(false);
    db.prepare('DELETE FROM notas_reuniao').run();
    s.inserir.run('msg-reprocesso', 'assunto');
    s.avancar.run({
      doc_id: null, evento_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
      gmail_message_id: 'msg-reprocesso', estado: 'ORFAO', deal_id: null, ultimo_erro: 'nao_encontrado',
    });
    const erroOrfao = await esperarErro(() => rodar({ dealIdForcado: 48292471 }));
    checar('religar um ORFAO atravessa a guarda', erroOrfao === null || !/segunda nota/.test(erroOrfao), erroOrfao);

    // ...menos quando ja foi postada: religar ai so criaria a segunda nota, e quem pediu precisa
    // saber disso em vez de descobrir no prontuario do cliente.
    limpar();
    db.prepare('DELETE FROM notas_reuniao').run();
    s.inserir.run('msg-reprocesso', 'assunto');
    s.avancar.run({
      doc_id: null, evento_id: null, metodo: null, diagnostico: null, extracao: null, marcador: null,
      gmail_message_id: 'msg-reprocesso', estado: 'CONCLUIDO', deal_id: 48292471, ultimo_erro: null,
    });
    const erroConcluida = await esperarErro(() => rodar({ dealIdForcado: 48292471 }));
    checar('religar uma CONCLUIDA e recusado com motivo', /segunda nota/.test(erroConcluida || ''), erroConcluida);
    igual('   e nada e postado', notas().length, 0);
  }

  {
    // `_` e caractere comum em e-mail e curinga de um caractere no LIKE. Sem ESCAPE,
    // "joao_silva@x.com" casaria com o last_data de "joaoXsilva@x.com" — o negocio de outra pessoa.
    limpar();
    semear('5586000000001', { deal_id: 70000001, last_data: JSON.stringify({ email_cliente: 'joaoXsilva@x.com' }) });
    semear('5586000000002', { deal_id: 70000002, last_data: JSON.stringify({ email_cliente: 'joao_silva@x.com' }) });

    const s = stmtsNotas(false);
    db.prepare('DELETE FROM notas_reuniao').run();
    const mensagem = {
      id: 'msg-email',
      internalDate: String(Date.parse('2026-08-14T21:40:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Notas: "Consulta online" de 14/08/2026' }],
        mimeType: 'text/plain',
        body: { data: Buffer.from('Resumo').toString('base64url') },
      },
    };
    agenda.respostaList = [{
      id: 'ev-email',
      status: 'confirmed',
      summary: 'Consulta online',
      description: '',
      organizer: { email: 'escritoriocr2019@gmail.com' },
      attendees: [{ email: 'joao_silva@x.com' }],
      start: { dateTime: '2026-08-14T18:00:00-03:00' },
    }];

    await processarNotaReuniao({
      gmail: gmailFalso,
      calendar: google.calendar(),
      drive: { files: { export: async () => ({ data: '' }) } },
      mensagem,
      stmts: s,
      dryRun: true,
    });
    igual('e-mail com "_" casa o deal certo, nao o vizinho', s.get.get('msg-email').deal_id, 70000002);

    db.prepare('DELETE FROM conversations WHERE deal_id IN (70000001, 70000002)').run();
  }

  // ============================================================
  // Refresh do briefing antes da consulta: reprocessa (uma vez por horario de consulta) as conversas
  // com consulta marcada nas proximas horas — o briefing de uma conversa que PAROU de receber
  // mensagem nao atualiza sozinho, e e essa a janela em que o advogado vai ler a nota.
  console.log('\n=== refresh de briefing perto da consulta ===');
  const CHAT_CONS = '5511966660000';
  const naive2h = instanteParaNaiveLocal(new Date(Date.now() + 2 * 3600000).toISOString());
  const naive10h = instanteParaNaiveLocal(new Date(Date.now() + 10 * 3600000).toISOString());
  const naivePassada = instanteParaNaiveLocal(new Date(Date.now() - 2 * 3600000).toISOString());
  const semearConsulta = (chatId, data) => semear(chatId, { deal_id: 60, evento_calendar_criado: 1, evento_calendar_data: data });
  // A rotina varre TODAS as conversas com consulta marcada — o bloco limpa o banco inteiro a cada
  // cenario pra nenhum residuo de teste anterior contar no resultado.
  const limparCons = () => { limpar(); db.prepare('DELETE FROM conversations').run(); };
  {
    limparCons();
    semearConsulta(CHAT_CONS, naive2h);
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: false });
    igual('   consulta em 2h → enfileirada', r.enfileirados.length, 1);
    igual('   com o chat certo', r.enfileirados[0]?.chat_id, CHAT_CONS);
    igual('   sem aplicar → nada marcado', linha(CHAT_CONS).briefing_refresh_para, null);
  }
  {
    limparCons();
    semearConsulta(CHAT_CONS, naive2h);
    db.prepare('UPDATE conversations SET briefing_refresh_para = ? WHERE chat_id = ?').run(naive2h, CHAT_CONS);
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: true });
    igual('   ja refrescada pro mesmo horario → nao enfileira', r.enfileirados.length, 0);
  }
  {
    limparCons();
    semearConsulta('5511966660000', naive10h);
    semearConsulta('5511966660001', naive2h);
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: false, maxPorCiclo: 1 });
    igual('   10h (fora da janela) descartada; teto 1 → so a de 2h', r.enfileirados.length, 1);
    igual('   a enfileirada', r.enfileirados[0]?.chat_id, '5511966660001');
  }
  {
    limparCons();
    semearConsulta(CHAT_CONS, naivePassada);
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: false });
    igual('   consulta ja passou → nao enfileira', r.enfileirados.length, 0);
  }
  {
    limparCons();
    semear(CHAT_CONS, { deal_id: 60, evento_calendar_criado: 0, evento_calendar_data: naive2h });
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: false });
    igual('   sem evento criado → nao enfileira', r.enfileirados.length, 0);
  }
  {
    limparCons();
    semearConsulta(CHAT_CONS, naive2h);
    const r = await refrescarBriefingsPertoDaConsulta({ aplicar: true });
    igual('   aplicar marca o horario', linha(CHAT_CONS).briefing_refresh_para, naive2h);
    // Remarcacao muda o horario -> volta a enfileirar (dedup e por horario, nao por conversa).
    const naive3h = instanteParaNaiveLocal(new Date(Date.now() + 3 * 3600000).toISOString());
    db.prepare('UPDATE conversations SET evento_calendar_data = ? WHERE chat_id = ?').run(naive3h, CHAT_CONS);
    const r2 = await refrescarBriefingsPertoDaConsulta({ aplicar: false });
    igual('   remarcacao muda o horario → volta a enfileirar', r2.enfileirados.length, 1);
    igual('   sem chamada de rede (so enfileira)', rede.chamadas.length, 0);
  }


  // ------------------------------------------------------------
  console.log('\n=== Telegram: aviso nao se perde por formatacao ===');
  {
    // MEDIDO em producao (19/08/2026): 400 do Telegram repetidas vezes. Causa: `parse_mode: Markdown`
    // com nome de arquivo interpolado fora de backticks — `comprovante_pix_18.pdf` tem `_`
    // desbalanceado e o Telegram recusa a mensagem INTEIRA. O aviso de comprovante recebido, que e o
    // unico jeito de o escritorio saber que o cliente pagou, sumia em silencio.
    limpar();
    let tentativas = [];
    rede.post = (url, corpo) => {
      if (!url.includes('api.telegram.org')) return { status: 200, data: {} };
      tentativas.push(corpo.parse_mode || '(sem parse_mode)');
      if (corpo.parse_mode === 'Markdown') {
        const e = new Error('Request failed with status code 400');
        e.response = { status: 400, data: { description: "can't parse entities" } };
        throw e;
      }
      return { status: 200, data: {} };
    };

    await enviarTelegram('📸 Arquivo: comprovante_pix_18.pdf');
    igual('Markdown recusado → reenvia', tentativas.length, 2);
    igual('   a 1a tentativa usou Markdown', tentativas[0], 'Markdown');
    igual('   a 2a foi texto puro', tentativas[1], '(sem parse_mode)');
    igual('   e o aviso CHEGOU', telegrams().length, 2);
  }
  {
    // 401/403 não é formatação: token errado ou bot bloqueado não melhora sem Markdown, e reenviar
    // seria só gastar uma segunda chamada para o mesmo erro.
    limpar();
    let n = 0;
    rede.post = (url) => {
      if (!url.includes('api.telegram.org')) return { status: 200, data: {} };
      n++;
      const e = new Error('Request failed with status code 401');
      e.response = { status: 401, data: {} };
      throw e;
    };
    await enviarTelegram('qualquer aviso');
    igual('401 nao vira reenvio (nao e formatacao)', n, 1);
  }

  console.log('\n=== Download de anexo: URL invalida nao chega ao axios ===');
  {
    // MEDIDO: 118 "Erro ao baixar anexo: 401" em producao, nenhum dizendo de que host — impossivel
    // saber se era chave errada do Zernio ou link assinado expirado da Meta. E "Invalid URL", que era
    // o axios recebendo algo que nem e endereco.
    limpar();
    const destino = path.join(DIR, 'nao-deve-existir.bin');
    for (const ruim of [undefined, null, '', 'nao-e-url', '/caminho/local', 'file:///etc/passwd', 'ftp://host/x']) {
      const r = await baixarParaArquivo(ruim, destino);
      checar(`   ${JSON.stringify(String(ruim).slice(0, 22))} recusada sem tocar a rede`, r === null, r);
    }
    igual('nenhuma requisicao foi feita', rede.chamadas.length, 0);
    igual('   e nenhum arquivo foi criado', fs.existsSync(destino), false);
  }

  console.log('\n=== Download de anexo: qual credencial vai junto ===');
  // MEDIDO em 19/08/2026 contra a API real, mesma rota e mesma chave, so trocando o esquema:
  //   Authorization: Bearer -> 200 | apikey -> 401
  // baixarParaArquivo era a UNICA chamada ao Zernio do arquivo que mandava `apikey`, e por isso a
  // unica que falhava: 113 erros 401 no log e nenhum comprovante verificado desde 24/07 — a foto do
  // PIX nunca chegava na IA de visao, o negocio nao avancava, o Telegram nao avisava que o cliente
  // pagou, e o audio do cliente parou de ser transcrito pelo mesmo caminho.
  {
    const headersDe = (url) => montarHeadersAnexo(new URL(url)).headers;
    const zernio = headersDe('https://zernio.com/api/v1/whatsapp/media/123');

    checar('URL do Zernio leva Authorization: Bearer', /^Bearer /.test(zernio.Authorization || ''), zernio);
    checar('   e NAO leva o header apikey (o esquema que a API recusa com 401)', !('apikey' in zernio), zernio);
    checar('subdominio do Zernio tambem leva a credencial', /^Bearer /.test(headersDe('https://cdn.zernio.com/x').Authorization || ''));

    // A URL vem do webhook: link assinado de CDN nao precisa de auth, e mandar a chave do escritorio
    // para um host de terceiro e vazamento de credencial. Era o que o codigo fazia com `apikey`.
    const meta = headersDe('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc');
    igual('CDN de terceiro NAO recebe credencial nenhuma', Object.keys(meta).length, 0);
    // Sufixo sem ponto: "malzernio.com" nao e o Zernio, e um endsWith ingenuo entregaria a chave.
    igual('host que so TERMINA em zernio.com nao recebe a chave', Object.keys(headersDe('https://malzernio.com/x')).length, 0);
    checar('ehHostZernio: exato e subdominio sim, sufixo colado nao',
      ehHostZernio('zernio.com') && ehHostZernio('api.zernio.com') && !ehHostZernio('malzernio.com') && !ehHostZernio(''),
      [ehHostZernio('zernio.com'), ehHostZernio('api.zernio.com'), ehHostZernio('malzernio.com')]);
  }

  console.log('\n=== Download de anexo: a URL da midia vem RELATIVA ===');
  // MEDIDO em 19/08/2026 contra a API real: 9 de 9 anexos das conversas recentes vieram como
  // "/api/v1/whatsapp/media/<id>?accountId=...". `new URL()` recusa isso, entao o download morria em
  // "URL invalida" ANTES da rede — e por isso sincronizarConversas, a rede de seguranca do webhook,
  // nunca baixou comprovante nem audio nenhum.
  {
    const resolvida = resolverUrlAnexo('/api/v1/whatsapp/media/1756300478897860?accountId=6a60a6');
    igual('caminho /api/ vira URL absoluta do Zernio', resolvida, 'https://zernio.com/api/v1/whatsapp/media/1756300478897860?accountId=6a60a6');
    checar('   e a resolvida leva a credencial (host do Zernio)', /^Bearer /.test(montarHeadersAnexo(new URL(resolvida)).headers.Authorization || ''));
    igual('URL absoluta passa intacta', resolverUrlAnexo('https://zernio.com/x'), 'https://zernio.com/x');

    // Resolver QUALQUER string contra a base transformaria lixo em requisicao. Estes continuam
    // recusados sem tocar a rede (o bloco anterior ja afirma isso ponta a ponta).
    igual('caminho local NAO e resolvido', resolverUrlAnexo('/caminho/local'), '/caminho/local');
    igual('texto solto NAO e resolvido', resolverUrlAnexo('nao-e-url'), 'nao-e-url');
    igual('vazio NAO e resolvido', resolverUrlAnexo(undefined), '');
  }

  console.log('\n=== Anexo do Doc do Gemini na aba "Arquivos" ===');

  // Um PDF de verdade: exportarPdfDoDoc CONFERE a assinatura %PDF- antes de aceitar os bytes, porque
  // o Drive responde 200 com corpo HTML em algumas falhas de permissao — e um HTML salvo como .pdf
  // entra no CRM parecendo anexo legitimo.
  const PDF_FALSO = Buffer.from('%PDF-1.4\n% doc do gemini\n%%EOF\n', 'latin1');
  const driveComPdf = (bytes = PDF_FALSO) => ({
    files: {
      export: async ({ mimeType }) => ({
        data: mimeType === 'application/pdf' ? bytes : 'transcricao em texto',
      }),
    },
  });

  const semearNotaConcluida = (s, id, extra = {}) => {
    db.prepare('DELETE FROM notas_reuniao').run();
    s.inserir.run(id, 'assunto');
    s.avancar.run({
      doc_id: 'doc-1', evento_id: null, metodo: 'evento_telefone', diagnostico: null, extracao: null,
      marcador: '[ollow-notas:abcd1234]', gmail_message_id: id, estado: 'CONCLUIDO', deal_id: 48292471,
      ultimo_erro: null, ...extra,
    });
  };

  {
    // Caminho feliz: exporta, serve, anexa.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-anexo');
    rede.post = () => ({ status: 200, data: { id: 7001 } }); // POST /attachments
    rede.get = (url) => (
      // GET .../attachments/7001 = conferencia; GET .../attachments = listagem para dedup
      /\/attachments\/7001$/.test(url)
        ? { status: 200, data: { id: 7001, filename: 'notas-reuniao-2026-08-14-abcd1234.pdf', size: PDF_FALSO.length, mimeType: 'application/pdf' } }
        : { status: 200, data: [] }
    );

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-anexo', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });

    checar('anexo criado', r.anexado === true && r.motivo === 'criado', r);
    igual('   1 POST /attachments', anexosCriados().length, 1);
    igual('   no deal certo', anexosCriados()[0].url.endsWith('/deals/48292471/attachments'), true);
    // O Moskit NAO aceita upload: o corpo e so uma url, e quem baixa o arquivo e o servidor dele.
    const url = anexosCriados()[0].corpo.url;
    checar('   corpo e {url}, nao multipart', typeof url === 'string' && Object.keys(anexosCriados()[0].corpo).join() === 'url', anexosCriados()[0].corpo);
    checar('   url aponta para a rota publica deste bot', url.startsWith('https://tunel-de-teste.example/arquivo-nota/'), url);
    checar('   com token de 256 bits', /\/arquivo-nota\/[a-f0-9]{64}\//.test(url), url);
    // O nome no fim da URL e o que vira `filename` no Moskit — e a chave de deduplicacao depois.
    checar('   e terminando no nome deterministico', url.endsWith('/notas-reuniao-2026-08-14-abcd1234.pdf'), url);
    igual('   com o header de origem', anexosCriados()[0].cfg.headers['X-Ollow-Origin'], 'BOT_WHATSAPP');
    igual('   estado final ANEXADO', s.get.get('msg-anexo').anexo_estado, 'ANEXADO');
    igual('   id do attachment guardado', s.get.get('msg-anexo').anexo_id, 7001);
    // Confirmada a copia, a URL publica morre na hora — nao espera o TTL. A transcricao de uma
    // consulta juridica nao fica servida um minuto a mais do que o necessario.
    igual('   token invalidado assim que o Moskit confirma', s.get.get('msg-anexo').anexo_token, null);
    igual('   PDF apagado do disco', s.get.get('msg-anexo').anexo_caminho, null);
    igual('   e nenhum Telegram (nada de errado aconteceu)', telegrams().length, 0);
  }

  {
    // O DETECTOR DO INTERSTICIO. O ngrok gratis devolve uma pagina HTML de aviso para clientes que
    // ele julga navegador, e nao controlamos o header de bypass — quem faz o GET e o Moskit. Nesse
    // caso o POST responde 2xx, o anexo aparece na aba com o nome certo, e so quem ABRIR o arquivo
    // descobre que e um HTML. Comparar tamanho e o que transforma isso em alerta.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-intersticio');
    rede.post = () => ({ status: 200, data: { id: 7009 } });
    rede.get = (url) => (
      /\/attachments\/7009$/.test(url)
        ? { status: 200, data: { id: 7009, filename: 'notas-reuniao-2026-08-14-abcd1234.pdf', size: 4211, mimeType: 'text/html' } }
        : { status: 200, data: [] }
    );

    await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-intersticio', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });

    igual('tamanho divergente → 1 Telegram', telegrams().length, 1);
    const aviso = telegrams()[0].corpo.text;
    checar('   o aviso cita os dois tamanhos', aviso.includes(String(PDF_FALSO.length)) && aviso.includes('4211'), aviso);
    checar('   e aponta o suspeito certo', aviso.includes('ngrok'), aviso);
    // NAO apaga o arquivo local: se o Moskit ainda estiver para buscar, apagar garantiria a falha.
    checar('   PDF local preservado para o Moskit ainda buscar', s.get.get('msg-intersticio').anexo_caminho !== null);
  }

  {
    // A trava contra a SEGUNDA copia da transcricao no prontuario do cliente. O POST nao aceita
    // marcador dentro do arquivo (o corpo e so uma url), entao a identidade e o nome — e e por ele
    // que a retomada pergunta ao CRM "isto ja esta ai?".
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-dup');
    rede.get = () => ({ status: 200, data: [{ id: 7002, filename: 'notas-reuniao-2026-08-14-abcd1234.pdf', size: 30, mimeType: 'application/pdf' }] });

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-dup', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });

    checar('anexo que ja existe nao e recriado', r.anexado === true && r.motivo === 'ja_existia', r);
    igual('   NENHUM POST /attachments', anexosCriados().length, 0);
    igual('   estado ANEXADO mesmo assim', s.get.get('msg-dup').anexo_estado, 'ANEXADO');
  }

  {
    // "Nao achei" e "nao terminei de procurar" levam a acoes opostas: confundir os dois e exatamente
    // como se anexa a transcricao duas vezes. Por isso o teto de paginas LANCA.
    limpar();
    rede.get = () => ({ status: 200, data: Array.from({ length: 10 }, (_, i) => ({ id: i, filename: `outro-${i}.pdf` })) });
    let lancou = false;
    try { await anexoComNomeExiste(48292471, 'nunca-vai-achar.pdf'); } catch { lancou = true; }
    checar('teto de paginas LANCA em vez de dizer "nao achei"', lancou);
  }

  {
    // Sem Doc nao ha o que anexar — e a nota NAO pode prometer um arquivo inexistente.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-sem-doc');
    rede.get = () => ({ status: 200, data: [] });

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: null, gmailMessageId: 'msg-sem-doc', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });
    igual('sem Doc → nao anexa', r.anexado, false);
    igual('   marcado como SEM_DOC', s.get.get('msg-sem-doc').anexo_estado, 'SEM_DOC');
    igual('   nenhum POST', anexosCriados().length, 0);
  }

  {
    // O Drive responde 200 com HTML em algumas falhas de permissao. Aceitar esses bytes poria um
    // HTML com extensao .pdf no prontuario — visualmente indistinguivel de um anexo legitimo.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-html');
    rede.get = () => ({ status: 200, data: [] });
    const driveHtml = { files: { export: async () => ({ data: Buffer.from('<html>Sem permissao</html>') }) } };

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-html', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveHtml, stmts: s, dryRun: false,
    });
    checar('export que devolve HTML nao vira anexo', r.anexado === false, r);
    igual('   nenhum POST', anexosCriados().length, 0);
  }

  {
    // CONTRATO CENTRAL: anexarDocNoDeal nunca lanca. Ela roda ANTES do bracket da nota (para o
    // rodape poder afirmar o anexo com honestidade); se lancasse, trocaria um bonus ausente por um
    // prontuario sem registro nenhum da consulta.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-falha');
    rede.get = () => ({ status: 200, data: [] });
    rede.post = () => { throw new Error('Moskit fora do ar'); };

    let lancou = false;
    let r = null;
    try {
      r = await anexarDocNoDeal({
        dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-falha', dataIso: '2026-08-14',
        marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
      });
    } catch { lancou = true; }

    checar('POST que falha NAO lanca', lancou === false, lancou);
    igual('   devolve anexado=false', r && r.anexado, false);
    // Fica em ANEXANDO de proposito: e o rastro que a rede de seguranca usa para retomar.
    igual('   estado fica ANEXANDO para a retomada', s.get.get('msg-falha').anexo_estado, 'ANEXANDO');
    // EXATAMENTE 1. Incrementar tambem no catch fazia UMA falha custar DUAS tentativas e cortar o
    // orcamento pela metade — o mesmo defeito ja corrigido na reconciliacao de vinculo (e78156f).
    igual('   UMA falha custa UMA tentativa (nao duas)', s.get.get('msg-falha').anexo_tentativas, 1);
  }

  {
    // O 429 na LISTAGEM de deduplicacao: acontece de verdade (o CLAUDE.md documenta 429/timeout de
    // 30s quando a varredura bate forte). O bracket abre ANTES dessa chamada justamente para que a
    // falha deixe rastro — senao a linha ficava com anexo_estado NULL, invisivel para a rede de
    // seguranca, e o PDF daquela reuniao sumia para sempre sem ninguem saber.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-429');
    rede.get = () => ({ status: 429, data: {} });

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-429', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });
    igual('429 na listagem → nao anexa', r.anexado, false);
    igual('   mas fica ANEXANDO (deixa rastro)', s.get.get('msg-429').anexo_estado, 'ANEXANDO');
    igual('   e a rede de seguranca ENXERGA a linha', s.anexosPendentes.all({ maxTentativas: 3, limite: 5 }).length, 1);
    igual('   com uma unica tentativa gasta', s.get.get('msg-429').anexo_tentativas, 1);
  }

  {
    // SEM_DOC e um estado que a rede de seguranca NUNCA retoma, entao ele so pode significar "esta
    // reuniao nao tem transcricao" — nunca "o Drive piscou". Um 5xx passageiro marcando SEM_DOC
    // perderia de vez o PDF de uma consulta que existia, e ainda gravaria no banco a afirmacao
    // contraria para quem fosse auditar depois.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-drive-5xx');
    rede.get = () => ({ status: 200, data: [] });
    const driveInstavel = { files: { export: async () => { const e = new Error('backend error'); e.response = { status: 500 }; throw e; } } };

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-drive-5xx', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveInstavel, stmts: s, dryRun: false,
    });
    igual('Drive 5xx → transitorio', r.motivo, 'export_transitorio');
    igual('   NAO marca SEM_DOC', s.get.get('msg-drive-5xx').anexo_estado, 'ANEXANDO');
    igual('   e sera retomado', s.anexosPendentes.all({ maxTentativas: 3, limite: 5 }).length, 1);

    // 404 e veredito, nao mau humor: o Doc nao existe, e insistir so gastaria as tentativas.
    limpar();
    semearNotaConcluida(s, 'msg-drive-404');
    rede.get = () => ({ status: 200, data: [] });
    const driveSemDoc = { files: { export: async () => { const e = new Error('File not found'); e.response = { status: 404 }; throw e; } } };
    await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-drive-404', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveSemDoc, stmts: s, dryRun: false,
    });
    igual('Drive 404 → definitivo, marca SEM_DOC', s.get.get('msg-drive-404').anexo_estado, 'SEM_DOC');
    igual('   e NAO fica pendente', s.anexosPendentes.all({ maxTentativas: 3, limite: 5 }).length, 0);
  }

  {
    // A retomada reusa o nome JA gravado. Recalcula-lo a partir de uma data que a linha nao guarda
    // seria a unica forma de gerar um nome diferente do que ja esta no CRM — ou seja, de duplicar.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-retoma');
    s.avancarAnexo.run({
      gmail_message_id: 'msg-retoma', anexo_estado: 'ANEXANDO', anexo_token: 'f'.repeat(64),
      anexo_caminho: null, anexo_nome: 'notas-reuniao-2026-08-14-abcd1234.pdf', anexo_id: null,
      anexo_expira_em: '2099-01-01 00:00:00',
    });
    // O CRM ja tem o anexo (o POST anterior chegou a passar, so nao voltou a resposta).
    rede.get = () => ({ status: 200, data: [{ id: 7003, filename: 'notas-reuniao-2026-08-14-abcd1234.pdf' }] });

    const resolvidos = await retomarAnexosPendentes({ stmts: s, drive: driveComPdf(), dryRun: false });
    igual('retomada resolve o pendente', resolvidos, 1);
    igual('   sem repostar (achou pelo nome)', anexosCriados().length, 0);
    igual('   estado vira ANEXADO', s.get.get('msg-retoma').anexo_estado, 'ANEXADO');
    // `avancarAnexo` usa COALESCE — passar null PRESERVA o valor antigo. Sem o encerramento
    // explicito, o token continuaria vivo servindo a transcricao ate o TTL vencer, mesmo com o
    // arquivo comprovadamente ja no CRM. Este teste falha se aquele encerrar sumir.
    igual('   token da tentativa anterior e invalidado', s.get.get('msg-retoma').anexo_token, null);
    igual('   e a validade tambem some', s.get.get('msg-retoma').anexo_expira_em, null);
  }

  {
    // Anexo faltando nao e incidente: a consulta esta registrada na nota. Desistir em silencio (sem
    // Telegram) e deliberado — aviso diario aqui viraria ruido e afogaria os alertas que importam.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-desiste-anexo');
    s.avancarAnexo.run({
      gmail_message_id: 'msg-desiste-anexo', anexo_estado: 'ANEXANDO', anexo_token: null,
      anexo_caminho: null, anexo_nome: 'notas-reuniao-2026-08-14-abcd1234.pdf', anexo_id: null,
      anexo_expira_em: null,
    });
    db.prepare('UPDATE notas_reuniao SET anexo_tentativas = 3 WHERE gmail_message_id = ?').run('msg-desiste-anexo');
    rede.get = () => ({ status: 200, data: [] });

    await retomarAnexosPendentes({ stmts: s, drive: driveComPdf(), dryRun: false });
    igual('estourou as tentativas → DESISTIU', s.get.get('msg-desiste-anexo').anexo_estado, 'DESISTIU');
    igual('   sem Telegram (anexo faltando nao e incidente)', telegrams().length, 0);
    igual('   e a NOTA continua concluida no CRM', s.get.get('msg-desiste-anexo').estado, 'CONCLUIDO');
  }

  {
    // A URL fica publica sem autenticacao e carrega a transcricao de uma consulta juridica. O que a
    // fecha e o TTL — e nada limpava `comprovantes/`, entao aqui o precedente e explicitamente outro.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-expira');
    const arq = path.join(DIR, 'expirado.pdf');
    fs.writeFileSync(arq, PDF_FALSO);
    s.avancarAnexo.run({
      gmail_message_id: 'msg-expira', anexo_estado: 'ANEXADO', anexo_token: 'e'.repeat(64),
      anexo_caminho: arq, anexo_nome: 'x.pdf', anexo_id: 7004, anexo_expira_em: '2000-01-01 00:00:00',
    });

    const apagados = limparAnexosExpirados(s);
    igual('TTL vencido → 1 anexo limpo', apagados, 1);
    igual('   PDF removido do disco', fs.existsSync(arq), false);
    igual('   token invalidado', s.get.get('msg-expira').anexo_token, null);
    // O que importa: o anexo continua no Moskit. Expirar a URL nao desfaz o que ja foi copiado.
    igual('   mas o anexo no CRM permanece', s.get.get('msg-expira').anexo_id, 7004);
  }

  {
    // Sem PUBLIC_BASE_URL o Moskit nao teria de onde baixar. Desistir cedo, sem tocar a rede, e o
    // que impede o CRM de receber um anexo apontando para uma URL que nao existe.
    limpar();
    const s = stmtsNotas(false);
    semearNotaConcluida(s, 'msg-sem-base');
    const salvo = process.env.PUBLIC_BASE_URL;
    delete require.cache[require.resolve('./index.js')]; // so para deixar claro que a const e do load
    process.env.PUBLIC_BASE_URL = salvo; // restaura: a const ja foi lida, o teste abaixo e de contrato

    rede.get = () => ({ status: 200, data: [] });
    rede.post = () => ({ status: 200, data: { id: 7005 } });
    const r = await anexarDocNoDeal({
      dealId: null, docId: 'doc-1', gmailMessageId: 'msg-sem-base', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: false,
    });
    igual('sem dealId → nao anexa', r.anexado, false);
    igual('   e nao toca a rede', anexosCriados().length, 0);
  }

  {
    // Dry-run tem que percorrer o ciclo inteiro sem escrever: nem POST, nem PDF em disco, nem token.
    limpar();
    const s = stmtsNotas(true); // tabela _dryrun
    db.prepare('DELETE FROM notas_reuniao_dryrun').run();
    s.inserir.run('msg-dry', 'assunto');
    s.avancar.run({
      doc_id: 'doc-1', evento_id: null, metodo: null, diagnostico: null, extracao: null,
      marcador: '[ollow-notas:abcd1234]', gmail_message_id: 'msg-dry', estado: 'CONCLUIDO',
      deal_id: 48292471, ultimo_erro: null,
    });
    rede.get = () => ({ status: 200, data: [] });

    const r = await anexarDocNoDeal({
      dealId: 48292471, docId: 'doc-1', gmailMessageId: 'msg-dry', dataIso: '2026-08-14',
      marcador: '[ollow-notas:abcd1234]', drive: driveComPdf(), stmts: s, dryRun: true,
    });
    igual('dry-run simula o anexo', r.motivo, 'dry_run');
    igual('   sem POST /attachments', anexosCriados().length, 0);
    igual('   sem token (nenhuma URL publica nasce)', s.get.get('msg-dry').anexo_token, null);
    // A tabela real nao pode ser tocada pelo dry-run: se fosse, a primeira execucao de verdade
    // acharia tudo pronto e nao faria nada.
    igual('   e a tabela real segue intacta', stmtsNotas(false).get.get('msg-dry'), undefined);
  }

  // ============================================================
  console.log('\n=== Negocio fechado nao reabre num PUT de campos ===');
  // O defeito que o cliente de retorno tornava inevitavel, mas que vale para TODO negocio:
  // montarPayloadMoskit sempre monta `status: 'OPEN'` e o PUT e full replace. Sem preservar o status do
  // GET, qualquer atualizacao de campo transformava um GANHO em aberto e apagava closeDate/lostReason —
  // e atingia justamente os negocios bem atendidos, que sao os que ficam fechados.
  {
    limpar();
    const CHAT_WON = '5511955550001';
    semear(CHAT_WON);
    rede.get = () => ({
      status: 200,
      data: {
        id: 30, name: 'Cliente - Inventario', status: 'WON', closeDate: '2026-08-01T10:00:00.000Z',
        stage: { id: 179386 }, activities: [], entityCustomFields: CF_DADOS,
      },
    });
    await atualizarNegocioMoskit(30, DADOS, 7, { chatId: CHAT_WON, condicoesValorEnviadas: true });
    const put = de('PUT', '/deals/30')[0]?.corpo;
    igual('negocio GANHO continua ganho depois do PUT', put?.status, 'WON');
    igual('   closeDate preservado', put?.closeDate, '2026-08-01T10:00:00.000Z');
  }
  {
    limpar();
    const CHAT_LOST = '5511955550002';
    semear(CHAT_LOST);
    rede.get = () => ({
      status: 200,
      data: {
        id: 31, name: 'Cliente - Inventario', status: 'LOST', closeDate: '2026-08-02T10:00:00.000Z',
        lostReason: { id: 126146 }, stage: { id: 179385 }, activities: [], entityCustomFields: CF_DADOS,
      },
    });
    await atualizarNegocioMoskit(31, DADOS, 7, { chatId: CHAT_LOST, condicoesValorEnviadas: true });
    const put = de('PUT', '/deals/31')[0]?.corpo;
    igual('negocio PERDIDO continua perdido', put?.status, 'LOST');
    igual('   motivo da perda preservado', put?.lostReason?.id, 126146);
  }
  {
    // O caminho comum nao muda: negocio aberto segue aberto, sem closeDate inventado.
    limpar();
    const CHAT_OPEN = '5511955550003';
    semear(CHAT_OPEN);
    rede.get = () => ({
      status: 200,
      data: { id: 32, name: 'Cliente - Inventario', status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: CF_DADOS },
    });
    await atualizarNegocioMoskit(32, DADOS, 7, { chatId: CHAT_OPEN, condicoesValorEnviadas: true });
    const put = de('PUT', '/deals/32')[0]?.corpo;
    igual('negocio aberto segue OPEN', put?.status, 'OPEN');
    igual('   e sem closeDate', put?.closeDate, undefined);
  }

  // ============================================================
  console.log('\n=== Janela do atendimento: indices ABSOLUTOS ===');
  // O corte esconde o atendimento anterior do modelo, mas nao pode renumerar mensagem: msg_idx e
  // validado contra o array `messages` inteiro (src/evidencia.js), e reindexar faria toda observacao
  // apontar para outra mensagem.
  {
    const msgs = [
      { role: 'cliente', text: 'caso velho do FIES', timestamp: '2026-08-01T10:00:00Z' },
      { role: 'equipe', text: BLOCO_CONDICOES_PAGA, timestamp: '2026-08-01T10:05:00Z' },
      { role: 'cliente', text: 'caso novo de despejo', timestamp: '2026-08-19T10:00:00Z' },
    ];
    const comJanela = montarHistorico(msgs, { inicio: 2 });
    checar('janela esconde o atendimento anterior', !comJanela.includes('FIES'), comJanela);
    checar('   e mantem o indice absoluto da mensagem', comJanela.includes('[2] Cliente: caso novo'), comJanela);
    checar('sem janela, a conversa inteira aparece', montarHistorico(msgs).includes('[0] Cliente: caso velho'));

    // A cobranca recomeca do zero: o bloco que a equipe mandou no atendimento anterior nao pode tornar
    // a consulta nova paga sem ninguem ter cobrado.
    igual('bloco de condicoes do atendimento anterior nao conta', equipeEnviouCondicoesDeValor(msgs, { inicio: 2 }), false);
    igual('   ...e sem janela continua contando', equipeEnviouCondicoesDeValor(msgs), true);
  }
  {
    // janelaAtendimento tolera coluna ausente/lixo: sem migracao, o corte e 0 (a conversa inteira), que
    // e exatamente o comportamento de antes desta funcionalidade existir.
    igual('linha sem coluna → corte 0', janelaAtendimento({}), 0);
    igual('linha com NULL → corte 0', janelaAtendimento({ atendimento_inicio_msg_idx: null }), 0);
    igual('valor valido e respeitado', janelaAtendimento({ atendimento_inicio_msg_idx: 4 }), 4);
  }

  // ============================================================
  console.log('\n=== Cliente que volta: o ciclo do corte e o ciclo seguinte ===');
  {
    const CHAT_RET = '5586999990001';
    const DEAL_ANTIGO = 9001;
    const DEAL_NOVO = 9002;
    // Timestamps relativos ao relogio, nao datas fixas: "a consulta ja aconteceu" e uma comparacao com
    // agora, e uma data cravada faria este teste passar hoje e falhar no ano que vem.
    const agora = Date.now();
    const atras = (h) => new Date(agora - h * 3600 * 1000).toISOString();
    const consultaIso = atras(48);
    const eventoNaive = instanteParaNaiveLocal(consultaIso);
    const TEXTO_CASO_NOVO = 'recebi uma notificacao de despejo do imovel que eu alugo, o prazo e de 15 dias';
    const TEXTO_TERCEIRO = 'fui demitido sem justa causa e nao recebi as verbas rescisorias';
    const MSGS_RET = [
      { role: 'cliente', text: 'oi, quero falar do abatimento do meu FIES', timestamp: atras(72) },
      { role: 'equipe', text: BLOCO_CONDICOES_PAGA, timestamp: atras(71) },
      // Dentro da folga (consulta + 1h de duracao + 2h): ainda e o MESMO atendimento.
      { role: 'cliente', text: 'obrigado pela consulta, doutor!', timestamp: atras(47) },
      { role: 'cliente', text: `Doutor, ${TEXTO_CASO_NOVO}`, timestamp: atras(24) },
    ];
    const LAST_DATA_ANTIGO = JSON.stringify({
      nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional',
      advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram',
      _casoDescritoValidado: true,
    });
    const semearRetorno = () => {
      db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(CHAT_RET);
      db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(CHAT_RET, 4242, 'Lia');
      salvarFila([]);
      return semear(CHAT_RET, {
        contact_name: 'Lia', deal_id: DEAL_ANTIGO, last_data: LAST_DATA_ANTIGO, last_action: 'nota',
        messages: JSON.stringify(MSGS_RET),
        evento_calendar_criado: 1, evento_calendar_id: 'ev-antigo', evento_calendar_data: eventoNaive,
        atividade_moskit_id: 777, bloco_condicoes_enviado: 1, bloco_condicoes_msg_idx: 1,
        contrato_zapsign_criado: 1, contrato_zapsign_doc_token: 'tok-antigo', contrato_zapsign_status: 'signed',
        campos_travados: JSON.stringify([CF.AREA_DIREITO]), custom_fields_bot: JSON.stringify({ [CF.AREA_DIREITO]: [228780] }),
        briefing_added: 1, briefing_hash: 'hash-antigo', briefing_versao: 3, briefing_refresh_para: eventoNaive,
        campos_nota_hash: 'hash-campos', agendamento_apuracao: '{}', agendamento_pendente_hash: 'hash-pend',
        vinculo_falhas: 2,
      });
    };

    const CLASSIFICACAO_OK = { classificacao: 'criar_negocio', justificativa: 'cliente antigo com caso novo' };
    const extracaoCasoNovo = (acao) => ({
      acao,
      justificativa: 'caso novo de despejo',
      confianca: 9,
      dados: {
        nome: 'Lia', assunto: 'Notificacao de despejo', area_direito: 'Direito Imobiliario',
        advogado_responsavel: 'Bruno', tipo_consulta: 'consulta paga', origem: 'Instagram',
      },
      observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 3, trecho: TEXTO_CASO_NOVO }],
    });

    // ---- ciclo 1: reconhece o retorno, abre o atendimento e NAO escreve caso nenhum no CRM ----
    limpar();
    semearRetorno();
    openai.respostas = [CLASSIFICACAO_OK, extracaoCasoNovo('atualizar_campos')];
    openai.prompts = [];
    await processarConversaDirect(CHAT_RET);

    const depoisDoCorte = linha(CHAT_RET);
    igual('corte gravado na primeira mensagem apos a consulta', depoisDoCorte.atendimento_inicio_msg_idx, 3);
    igual('   e o atendimento virou o 2o', depoisDoCorte.atendimento_num, 2);
    igual('   o negocio antigo sai da conversa (nao e reaproveitado)', depoisDoCorte.deal_id, null);
    checar('   ...mas fica registrado em deals_anteriores', lerDealsAnteriores(depoisDoCorte)[0]?.deal_id === DEAL_ANTIGO, depoisDoCorte.deals_anteriores);
    igual('   assunto do atendimento anterior guardado para a nota', lerDealsAnteriores(depoisDoCorte)[0]?.assunto, 'Abatimento do FIES');

    // O estado grudado: e isto que fazia a consulta nova nascer paga, o contrato nao ser gerado e a
    // agenda antiga passar por "consulta ja lancada".
    igual('   bloco de condicoes zerado', depoisDoCorte.bloco_condicoes_enviado, 0);
    igual('   msg do bloco zerada', depoisDoCorte.bloco_condicoes_msg_idx, null);
    igual('   agenda antiga desligada', depoisDoCorte.evento_calendar_criado, 0);
    igual('   evento antigo esquecido', depoisDoCorte.evento_calendar_id, null);
    igual('   horario antigo esquecido', depoisDoCorte.evento_calendar_data, null);
    igual('   atividade antiga esquecida', depoisDoCorte.atividade_moskit_id, null);
    igual('   contrato zerado', depoisDoCorte.contrato_zapsign_criado, 0);
    igual('   token do contrato esquecido', depoisDoCorte.contrato_zapsign_doc_token, null);
    igual('   campos travados liberados', depoisDoCorte.campos_travados, null);
    igual('   autoria de campos zerada', depoisDoCorte.custom_fields_bot, null);
    igual('   briefing recomeca', depoisDoCorte.briefing_added, 0);
    igual('   versao do briefing recomeca', depoisDoCorte.briefing_versao, 0);
    igual('   apuracao de agendamento esquecida', depoisDoCorte.agendamento_apuracao, null);
    igual('   pendencia de agendamento esquecida', depoisDoCorte.agendamento_pendente_hash, null);
    igual('   contador de falhas de vinculo zerado', depoisDoCorte.vinculo_falhas, 0);
    igual('   last_data limpo (o caso antigo nao classifica o novo)', depoisDoCorte.last_data, null);

    // Nada foi escrito no negocio antigo alem da nota — nenhum PUT e o que garante que o GANHO segue
    // ganho e que a classificacao do caso encerrado nao foi sobrescrita.
    igual('nenhum PUT no negocio antigo', dealsAtualizados().length, 0);
    igual('nenhum negocio criado neste ciclo', dealsCriados().length, 0);
    // Decisao de 02/09/2026: o corte bem-sucedido deixou de virar nota no negocio antigo — o
    // Telegram (abaixo) e deals_anteriores (ja conferido acima) e que registram o que aconteceu.
    igual('nenhuma nota no negocio antigo (so o Telegram avisa)', notas().length, 0);
    checar('Telegram avisa o escritorio', telegrams().some((t) => (t.corpo.text || '').includes('Cliente de retorno')), telegrams().map((t) => t.corpo.text));

    // Conversa muda nunca e reprocessada sozinha: sem reenfileirar, o atendimento novo ficaria aberto e
    // vazio ate o cliente escrever de novo.
    checar('conversa reenfileirada para o ciclo seguinte', lerFila().some((i) => i.chatId === CHAT_RET), lerFila());

    // ---- ciclo 2: com a janela limpa, o segundo negocio nasce do zero ----
    limpar();
    openai.respostas = [CLASSIFICACAO_OK, extracaoCasoNovo('criar')];
    openai.prompts = [];
    rede.get = (url) => (url.includes('/deals/') ? { status: 200, data: { id: DEAL_NOVO, status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: [] } } : { status: 200, data: [] });
    rede.post = (url) => {
      if (url.includes('/deals')) return { status: 200, data: { id: DEAL_NOVO } };
      if (url.includes('/activities')) return { status: 200, data: { id: ID_ATIVIDADE } };
      return { status: 200, data: {} };
    };
    await processarConversaDirect(CHAT_RET);

    const criados = dealsCriados();
    igual('o ciclo seguinte cria UM negocio novo', criados.length, 1);
    igual('   e a conversa passa a apontar para ele', linha(CHAT_RET).deal_id, DEAL_NOVO);
    igual('   o corte continua onde estava', linha(CHAT_RET).atendimento_inicio_msg_idx, 3);
    // A regra de cobranca e a mesma de sempre — e "sempre" agora comeca no atendimento novo.
    igual('consulta nova nasce cortesia (o bloco antigo ficou fora da janela)', criados[0]?.corpo?.price, 0);
    igual('   tipo de consulta = gratis', String((criados[0]?.corpo?.entityCustomFields || []).find((c) => c.id === CF.TIPO_CONSULTA)?.options), String([OPCAO.gratis]));
    // Responsavel pela AREA, como em qualquer lead (decisao do escritorio): Imobiliario → Bruno.
    igual('   responsavel derivado da area nova', String((criados[0]?.corpo?.entityCustomFields || []).find((c) => c.id === CF.RESPONSAVEL)?.options), String([OPCAO.bruno]));
    checar('   e o nome do negocio e do caso NOVO', (criados[0]?.corpo?.name || '').includes('despejo'), criados[0]?.corpo?.name);

    // O prompt e a prova de que o modelo nao viu mais o caso encerrado — a contaminacao que fazia o
    // caso novo herdar area e assunto do anterior.
    const promptExtracao = openai.prompts[1] || '';
    // 'FIES' sozinho nao serve: o proprio PROMPT tem uma regra fixa sobre financiamento estudantil. O que
        // nao pode aparecer e a MENSAGEM do atendimento anterior.
        checar('o modelo nao ve mais o caso do atendimento anterior', !promptExtracao.includes('abatimento do meu FIES'), promptExtracao.slice(0, 200));
    checar('   e ve o caso novo', promptExtracao.includes('despejo'));

    // Decisao de 02/09/2026: a nota "Cliente de retorno — Nº atendimento" no negocio novo deixou de
    // ser postada (confirmacao de rotina) — o vinculo com o negocio anterior continua rastreavel via
    // deals_anteriores (ja conferido acima), so nao aparece mais como texto no CRM.
    checar('nenhuma nota cita o negocio anterior (removida, so deals_anteriores guarda o vinculo)',
      !notas().some((n) => (n.corpo.description || '').includes(`Negócio anterior: ${DEAL_ANTIGO}`)), notas().map((n) => n.corpo.description));

    // ---- terceiro atendimento: nao ha teto ----
    // Cliente de escritorio volta mais de uma vez. Uma guarda de "so se ainda nao houve corte" faria o
    // 3o caso cair de novo dentro do negocio do 2o — exatamente o defeito que esta funcionalidade
    // existe para impedir, so uma volta mais tarde.
    limpar();
    const MSGS_3 = MSGS_RET.concat([
      // atras(21) e nao atras(20): a consulta do 2o atendimento fica em atras(23) e o fim com folga cai
      // em atras(20) — em cima do limite. `evento_calendar_data` tem precisao de MINUTO
      // (instanteParaNaiveLocal corta os segundos), entao um timestamp exatamente na borda decidiria por
      // fracao de segundo. A mensagem de agradecimento e do MESMO atendimento; o teste diz isso sem
      // depender de arredondamento.
      { role: 'cliente', text: 'obrigado pela consulta de hoje!', timestamp: atras(21) },
      { role: 'cliente', text: `Doutor, ${TEXTO_TERCEIRO}`, timestamp: atras(2) },
    ]);
    db.prepare('UPDATE conversations SET messages = ?, evento_calendar_data = ?, evento_calendar_criado = 1, last_data = ? WHERE chat_id = ?').run(
      JSON.stringify(MSGS_3),
      instanteParaNaiveLocal(atras(23)),
      JSON.stringify({ nome: 'Lia', assunto: 'Notificacao de despejo', area_direito: 'Direito Imobiliario', advogado_responsavel: 'Bruno', tipo_consulta: 'consulta paga', origem: 'Instagram', _casoDescritoValidado: true }),
      CHAT_RET,
    );
    openai.respostas = [CLASSIFICACAO_OK, {
      acao: 'atualizar_campos', justificativa: 'terceiro caso', confianca: 9,
      dados: { nome: 'Lia', assunto: 'Rescisao de contrato de trabalho', area_direito: 'Direito do Trabalho', advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram' },
      observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 5, trecho: TEXTO_TERCEIRO }],
    }];
    await processarConversaDirect(CHAT_RET);

    const terceiro = linha(CHAT_RET);
    igual('o 3o atendimento tambem e reconhecido', terceiro.atendimento_num, 3);
    igual('   com corte depois do corte anterior', terceiro.atendimento_inicio_msg_idx, 5);
    igual('   e o negocio do 2o atendimento sai da conversa', terceiro.deal_id, null);
    igual('   os dois anteriores ficam registrados', lerDealsAnteriores(terceiro).length, 2);
    igual('   o mais recente e o do 2o atendimento', lerDealsAnteriores(terceiro)[1]?.deal_id, DEAL_NOVO);
    igual('   e nada foi escrito no negocio do 2o', dealsAtualizados().length, 0);
  }

  // ============================================================
  console.log('\n=== Cliente que volta: quando o bot NAO decide ===');
  {
    const CHAT_AMB = '5586999990002';
    const agora = Date.now();
    const atras = (h) => new Date(agora - h * 3600 * 1000).toISOString();
    const TEXTO = 'ainda estou com aquele problema do abatimento do FIES, a faculdade nao respondeu';
    const MSGS = [
      { role: 'cliente', text: 'oi, quero falar do abatimento do meu FIES', timestamp: atras(72) },
      { role: 'cliente', text: `Doutor, ${TEXTO}`, timestamp: atras(24) },
    ];
    const semearAmbiguo = () => {
      db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(CHAT_AMB);
      db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(CHAT_AMB, 4243, 'Lia');
      return semear(CHAT_AMB, {
        contact_name: 'Lia', deal_id: 9010, last_action: 'nota',
        last_data: JSON.stringify({ nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional', advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram', _casoDescritoValidado: true }),
        messages: JSON.stringify(MSGS),
        evento_calendar_criado: 1, evento_calendar_data: instanteParaNaiveLocal(atras(48)),
      });
    };
    const extracaoMesmoCaso = {
      acao: 'nota',
      justificativa: 'cliente falando do mesmo caso',
      confianca: 9,
      dados: {
        nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional',
        advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram',
        resumo_atendimento: 'Cliente cobrando andamento do mesmo caso.',
      },
      observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 1, trecho: TEXTO }],
    };

    // Mesmo assunto e mesma area depois da consulta e indistinguivel de "cliente completando o caso de
    // sempre" — que e o que acontece na maioria das conversas apos uma consulta. Ambiguo NAO abre
    // negocio, NAO corta a conversa e NAO reclassifica nada; so avisa.
    limpar();
    semearAmbiguo();
    openai.respostas = [{ classificacao: 'criar_negocio', justificativa: 'cliente cobrando andamento' }, extracaoMesmoCaso];
    await processarConversaDirect(CHAT_AMB);

    const depois = linha(CHAT_AMB);
    igual('ambiguo nao corta a conversa', depois.atendimento_inicio_msg_idx, null);
    igual('   nao abre atendimento novo', depois.atendimento_num, 1);
    igual('   nao solta o negocio atual', depois.deal_id, 9010);
    igual('   nao escreve no CRM', dealsAtualizados().length + dealsCriados().length, 0);
    checar('   avisa que precisa de olho humano', telegrams().some((t) => (t.corpo.text || '').includes('é caso novo?')), telegrams().map((t) => t.corpo.text));
    checar('   e grava o hash do aviso', !!depois.retorno_aviso_hash, depois.retorno_aviso_hash);

    // Segundo ciclo identico: o mesmo veredito nao vira um segundo aviso. Aviso repetido a cada ciclo
    // afoga justamente o caso que importa.
    limpar();
    openai.respostas = [{ classificacao: 'criar_negocio', justificativa: 'cliente cobrando andamento' }, extracaoMesmoCaso];
    await processarConversaDirect(CHAT_AMB);
    igual('aviso identico nao e repetido', telegrams().length, 0);
  }
  {
    // Consulta AINDA NAO realizada: o cliente descrevendo o caso antes da consulta e o fluxo normal, e
    // nada disso pode disparar.
    const CHAT_FUT = '5586999990003';
    const agora = Date.now();
    const daqui = (h) => new Date(agora + h * 3600 * 1000).toISOString();
    const TEXTO = 'tenho um problema de despejo, recebi a notificacao ontem';
    limpar();
    db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(CHAT_FUT);
    db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(CHAT_FUT, 4244, 'Novo');
    semear(CHAT_FUT, {
      contact_name: 'Novo', deal_id: 9020, last_action: 'nota',
      last_data: JSON.stringify({ nome: 'Novo', assunto: 'Consulta jurídica', tipo_consulta: 'consulta paga', origem: 'Instagram' }),
      messages: JSON.stringify([{ role: 'cliente', text: `Doutor, ${TEXTO}`, timestamp: new Date(agora - 3600 * 1000).toISOString() }]),
      evento_calendar_criado: 1, evento_calendar_data: instanteParaNaiveLocal(daqui(24)),
    });
    rede.get = () => ({ status: 200, data: { id: 9020, status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: [] } });
    openai.respostas = [
      { classificacao: 'criar_negocio', justificativa: 'lead novo' },
      {
        acao: 'nota', justificativa: 'primeiro atendimento', confianca: 9,
        dados: { nome: 'Novo', assunto: 'Notificacao de despejo', area_direito: 'Direito Imobiliario', advogado_responsavel: 'Bruno', tipo_consulta: 'consulta paga', origem: 'Instagram', resumo_atendimento: 'Caso de despejo.' },
        observacoes: [{ tipo: 'cliente_descreveu_caso', msg_idx: 0, trecho: TEXTO }],
      },
    ];
    await processarConversaDirect(CHAT_FUT);
    igual('consulta futura: nada de atendimento novo', linha(CHAT_FUT).atendimento_inicio_msg_idx, null);
    igual('   negocio segue o mesmo', linha(CHAT_FUT).deal_id, 9020);
    igual('   e nenhum aviso de retorno', telegrams().filter((t) => (t.corpo.text || '').includes('retorno')).length, 0);
  }

  // ============================================================
  console.log('\n=== A reconciliacao tambem respeita a janela ===');
  // reconciliarClassificacao recalcula a cobranca a partir das MENSAGENS (a coluna nasceu depois de
  // muitas conversas existirem). Sem a janela, ela reintroduziria o bloco do atendimento anterior e
  // subiria o preco de um negocio que nunca viu bloco nenhum.
  {
    const CHAT_REC2 = '5586999990004';
    const MSGS = JSON.stringify([
      { role: 'equipe', text: BLOCO_CONDICOES_PAGA, timestamp: '2026-08-01T10:00:00Z' },
      { role: 'cliente', text: 'obrigado', timestamp: '2026-08-01T11:00:00Z' },
      { role: 'cliente', text: 'agora tenho um caso de despejo', timestamp: '2026-08-19T10:00:00Z' },
    ]);
    const LAST = JSON.stringify({ nome: 'Lia', assunto: 'Despejo', area_direito: 'Direito Imobiliario', advogado_responsavel: 'Bruno', tipo_consulta: 'consulta gratis' });
    const dealRec2 = () => ({
      status: 200,
      data: { id: 80, name: 'Lia - Despejo', status: 'OPEN', stage: { id: 179388 }, activities: [], entityCustomFields: [cf(CF.TIPO_CONSULTA, OPCAO.gratis), cf(CF.AREA_DIREITO, moskitIds.AREA_DIREITO['direito imobiliario']), cf(CF.RESPONSAVEL, OPCAO.bruno)] },
    });

    limpar();
    db.prepare('DELETE FROM conversations').run();
    semear(CHAT_REC2, { deal_id: 80, last_data: LAST, messages: MSGS, bloco_condicoes_enviado: 0, atendimento_inicio_msg_idx: 2 });
    rede.get = () => dealRec2();
    const comJanela = await reconciliarClassificacao({});
    igual('com a janela: a cobranca do atendimento novo nao e recalculada do bloco antigo', comJanela.bloco_recalculado.length, 0);

    // Controle: a MESMA conversa sem corte volta a enxergar o bloco — prova que a assercao acima mede a
    // janela, e nao um detector que simplesmente parou de funcionar.
    limpar();
    db.prepare('DELETE FROM conversations').run();
    semear(CHAT_REC2, { deal_id: 80, last_data: LAST, messages: MSGS, bloco_condicoes_enviado: 0 });
    rede.get = () => dealRec2();
    const semJanela = await reconciliarClassificacao({});
    igual('sem janela: o bloco e detectado (controle)', semJanela.bloco_recalculado.length, 1);
  }

  // ============================================================
  console.log('\n💬 Chatwoot: preencher o nome do contato a partir do Moskit');
  // ============================================================
  // O que esta em jogo: preencher o nome errado poe o nome de um cliente na ficha de CONVERSA de
  // outro, com o historico de mensagens do segundo a vista. Por isso metade das assercoes e sobre
  // NAO escrever.
  {
    const chatwootModulo = require('./src/chatwoot');
    const sChat = stmtsChatwoot();

    // A rotina varre `conversations` ordenada por updated_at: as seções anteriores deixaram dezenas
    // de linhas, e sem limpar os candidatos deste bloco seriam os do teste de agendamento.
    const zerar = () => {
      db.prepare('DELETE FROM conversations').run();
      db.prepare('DELETE FROM chatwoot_contacts').run();
      db.prepare('DELETE FROM moskit_contacts').run();
      limpar();
    };

    // Pre-semeia o espelho do Chatwoot para a cascata de BUSCA nao precisar de rede — o que este
    // bloco mede e a decisao de escrita, e a busca tem teste proprio abaixo.
    const semearChatwoot = (chave, chatwootId, nome = '') =>
      sChat.upsertVisto.run(chave, chatwootId, `+${chave}`, nome, '');
    const semearMoskit = (chave, moskitId, nome) =>
      db.prepare("INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)").run(chave, moskitId, nome);

    // Ficha devolvida pelo GET /contacts/{id} — e ela que traz custom_attributes e o nome ATUAL.
    const respondeFicha = (id, name, extras = {}) => (url) => {
      if (url.endsWith(`/contacts/${id}`)) {
        return { status: 200, data: { payload: { id, name, phone_number: '+558699999999', identifier: '', custom_attributes: {}, ...extras } } };
      }
      return { status: 200, data: {} };
    };

    const CHAVE = '558699999999';

    // ---------- o caminho felizmente comum ----------
    {
      zerar();
      semearChatwoot(CHAVE, 500, '558699999999');
      semearMoskit(CHAVE, 4711, '*Maria de Fatima');
      semear(CHAVE, { deal_id: 48407608, contact_name: '558699999999' });
      rede.get = respondeFicha(500, '558699999999');
      // 204 e o sucesso documentado do PUT do Chatwoot — nao 200.
      rede.put = () => ({ status: 204, data: '' });

      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('nome vazio/telefone => 1 escrita', r.escritos, 1);
      const put = de('PUT', '/contacts/500')[0];
      checar('PUT foi no contato certo', !!put, rede.chamadas.map((c) => c.metodo + ' ' + c.url));
      igual('nome do Moskit, sem o "*"', put.corpo.name, 'Maria de Fatima');
      igual('identifier com prefixo', put.corpo.identifier, 'moskit:4711');
      checar('link do negocio no custom attribute', /\/\?\/deal\/48407608$/.test(put.corpo.custom_attributes.moskit_negocio_url), put.corpo.custom_attributes);
      // phone_number NUNCA vai: reescrever o numero pode mexer no que amarra a ficha ao canal.
      checar('PUT nao manda phone_number', !('phone_number' in put.corpo), Object.keys(put.corpo));
      igual('estado gravado (nome_escrito)', sChat.get.get(CHAVE).nome_escrito, 'Maria de Fatima');
      checar('hash gravado', !!sChat.get.get(CHAVE).escrita_hash);

      // Idempotencia: nada mudou => zero PUT no segundo ciclo.
      limpar();
      rede.get = respondeFicha(500, 'Maria de Fatima');
      rede.put = () => ({ status: 204, data: '' });
      const r2 = await sincronizarContatosChatwoot({ aplicar: true });
      igual('2o ciclo nao escreve nada', de('PUT', '/contacts').length, 0);
      igual('e o motivo e "sem mudanca"', r2.pulados.sem_mudanca, 1);
    }

    // ---------- a garantia estrutural: nunca cria contato ----------
    {
      const todos = rede.chamadas.filter((c) => c.metodo === 'POST' && /\/contacts$/.test(c.url));
      igual('NENHUM POST /contacts em nenhum momento', todos.length, 0);
      const erro = await esperarErro(() => chatwootRequisicao('post', '/contacts'));
      checar('e o cliente HTTP se recusa a fazer isso', /nao e permitido/.test(erro || ''), erro);
      const erroDel = await esperarErro(() => chatwootRequisicao('delete', '/contacts/1'));
      checar('DELETE tambem nao existe no cliente', /metodo nao permitido/.test(erroDel || ''), erroDel);
    }

    // ---------- NUNCA escreve mensagem: decisao do dono, 04/09/2026, incidente real ----------
    {
      const naoManda = async (metodo, caminho) => {
        const erro = await esperarErro(() => chatwootRequisicao(metodo, caminho));
        checar(`${metodo.toUpperCase()} ${caminho} e recusado`, /NUNCA escreve mensagem/.test(erro || ''), erro);
      };
      await naoManda('post', '/conversations/114/messages');
      await naoManda('put', '/conversations/114/messages/5');
      await naoManda('delete', '/conversations/114/messages/5');
      await naoManda('post', '/conversations/9/messages?private=false'); // querystring nao escapa a guarda
      // GET continua liberado — e como o monitor e as investigacoes leem o que esta acontecendo.
      rede.get = () => ({ status: 200, data: { payload: [] } });
      const semErro = await esperarErro(() => chatwootRequisicao('get', '/conversations/114/messages'));
      checar('GET em mensagem continua permitido (so leitura)', semErro === null, semErro);
    }

    // ---------- numero interno nunca vira nome no Chatwoot ----------
    {
      zerar();
      const INTERNO = '5511900009999'; // TEAM_PHONES, fixado no topo do arquivo
      semearChatwoot(INTERNO, 501, '');
      semearMoskit(INTERNO, 4712, 'Alice Pimentel');
      semear(INTERNO, { contact_name: 'Alice' });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('interno e pulado', r.pulados.interno, 1);
      igual('e nada foi analisado', r.analisados, 0);
      // A guarda vem antes de casar, montar payload e tocar a rede.
      igual('nenhuma requisicao ao Chatwoot', rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com')).length, 0);
    }

    // ---------- precedencia: nome humano nunca e sobrescrito ----------
    {
      zerar();
      semearChatwoot(CHAVE, 502, 'Maria Aparecida');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, { contact_name: 'Maria' });
      rede.get = respondeFicha(502, 'Maria Aparecida');
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('nome humano => nao escreve', r.escritos, 0);
      igual('e o motivo diz por que', r.pulados.nome_humano, 1);
      igual('zero PUT', de('PUT', '/contacts').length, 0);
    }

    // ---------- autoria: renomeacao humana trava para sempre ----------
    {
      zerar();
      semearChatwoot(CHAVE, 503, 'Maria de Fatima');
      db.prepare("UPDATE chatwoot_contacts SET nome_escrito = 'Maria de Fatima' WHERE chave = ?").run(CHAVE);
      semearMoskit(CHAVE, 4711, 'Maria de Fatima Silva');
      semear(CHAVE, {});
      // A equipe corrigiu para o nome de casada depois do bot.
      rede.get = respondeFicha(503, 'Maria Aparecida Souza');
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('divergiu do que o bot escreveu => pula', r.pulados.humano_renomeou, 1);
      igual('e trava a linha', sChat.get.get(CHAVE).travado_humano, 1);

      // Travado nunca mais e reavaliado, nem com nome novo no Moskit.
      limpar();
      rede.get = respondeFicha(503, 'Maria Aparecida Souza');
      const r2 = await sincronizarContatosChatwoot({ aplicar: true });
      igual('travado => pula sem tocar a rede', r2.pulados.travado_humano, 1);
      igual('zero requisicao', rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com')).length, 0);
    }

    // ---------- sem nome utilizavel: nao gasta requisicao nenhuma ----------
    {
      zerar();
      semearChatwoot(CHAVE, 504, '');
      semearMoskit(CHAVE, 4711, '*Cliente sem nome');
      semear(CHAVE, { contact_name: '558699999999' });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('placeholder do bot nao e nome', r.pulados.sem_nome_utilizavel, 1);
      igual('nenhuma requisicao', rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com')).length, 0);
    }

    // ---------- duas fichas para o mesmo cliente: nao elege vencedor ----------
    {
      zerar();
      // Duas grafias do MESMO numero ja no espelho do Chatwoot, e a conversa chega numa TERCEIRA
      // (com o nono digito). Sem casar exato em nenhuma, a peneira por sufixo acha as duas — e a
      // regra e "candidato unico ou nada", nunca eleger uma por palpite.
      semearChatwoot('558699999999', 505, '');
      sChat.upsertVisto.run('8699999999', 506, '8699999999', '', '');
      semearMoskit('5586999999999', 4711, 'Maria de Fatima');
      semear('5586999999999', { contact_name: 'Maria' });
      const r = await sincronizarContatosChatwoot({ aplicar: true, detalhar: true });
      igual('entra na lista de acionaveis', r.ambiguos.length, 1);
      checar('com os dois ids', JSON.stringify(r.ambiguos[0].ids) === JSON.stringify([505, 506]), r.ambiguos);
      // O que importa: para a chave AMBIGUA nao se elege vencedor. As duas fichas duplicadas, cada
      // uma vista pela sua propria chave exata, sao candidatas legitimas e recebem nome — nao ha
      // ambiguidade do ponto de vista delas. A ambiguidade existe so para a terceira grafia (a da
      // conversa), e e ela que tem de sair sem escrita.
      const daChaveAmbigua = (r.detalhe || []).filter((d) => d.chave === '5586999999999');
      igual('a chave ambigua produz exatamente um desfecho', daChaveAmbigua.length, 1);
      igual('e esse desfecho e "ambiguo", nao uma escrita', daChaveAmbigua[0].resultado, 'ambiguo');
    }

    // ---------- colisao de identifier: degrada para o nome ----------
    {
      zerar();
      semearChatwoot(CHAVE, 507, '');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, { deal_id: 48407608 });
      rede.get = respondeFicha(507, '');
      let n = 0;
      rede.put = () => {
        n++;
        // 1a tentativa: o identifier moskit:4711 ja esta em outra ficha do mesmo cliente.
        if (n === 1) return { status: 422, data: { message: 'Identifier has already been taken' } };
        return { status: 204, data: '' };
      };
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('duas tentativas de PUT', de('PUT', '/contacts/507').length, 2);
      const segundo = de('PUT', '/contacts/507')[1];
      checar('a 2a vai SEM identifier', !('identifier' in segundo.corpo), Object.keys(segundo.corpo));
      igual('mas com o nome, que e o que o dono pediu', segundo.corpo.name, 'Maria de Fatima');
      igual('conta como escrito', r.escritos, 1);
      igual('e vira item acionavel', r.colisoes.length, 1);
    }

    // ---------- 403 encerra o ciclo (e global, nao por contato) ----------
    {
      zerar();
      for (const [chave, id] of [['558611111111', 601], ['558622222222', 602], ['558633333333', 603]]) {
        semearChatwoot(chave, id, '');
        semearMoskit(chave, 4700 + id, 'Cliente Real Um');
        semear(chave, {});
      }
      rede.get = (url) => {
        const m = url.match(/\/contacts\/(\d+)$/);
        return m ? { status: 200, data: { payload: { id: Number(m[1]), name: '', phone_number: '+558611111111', identifier: '', custom_attributes: {} } } } : { status: 200, data: {} };
      };
      rede.put = () => ({ status: 403, data: { error: 'forbidden' } });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('para no primeiro 403', de('PUT', '/contacts').length, 1);
      igual('e diz por que encerrou', r.encerrado_por, 'proibido');
      igual('nada escrito', r.escritos, 0);
    }

    // ---------- 404: a ficha sumiu do Chatwoot ----------
    {
      zerar();
      semearChatwoot(CHAVE, 508, '');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      rede.get = () => ({ status: 404, data: {} });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('contato sumiu', r.pulados.contato_sumiu, 1);
      checar('e a linha do espelho e apagada', !sChat.get.get(CHAVE), sChat.get.get(CHAVE));
    }

    // ---------- 429/erro transitorio: backoff, sem aviso ----------
    {
      zerar();
      semearChatwoot(CHAVE, 509, '');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      rede.get = respondeFicha(509, '');
      rede.put = () => ({ status: 429, data: {} });
      await sincronizarContatosChatwoot({ aplicar: true });
      const linhaCw = sChat.get.get(CHAVE);
      igual('conta a falha', linhaCw.falhas, 1);
      checar('e entra em cooldown', Number(linhaCw.backoff_ate) > Date.now(), linhaCw.backoff_ate);
      checar('sem desistir na primeira', !linhaCw.desistiu, linhaCw.desistiu);

      // Em cooldown, nao toca a rede.
      limpar();
      rede.get = respondeFicha(509, '');
      const r2 = await sincronizarContatosChatwoot({ aplicar: true });
      igual('em backoff => pula', r2.pulados.backoff, 1);
      igual('sem requisicao', rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com')).length, 0);
    }

    // ---------- dry-run: mede sem escrever ----------
    {
      zerar();
      semearChatwoot(CHAVE, 510, '');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      rede.get = respondeFicha(510, '');
      rede.put = () => ({ status: 204, data: '' });
      const r = await sincronizarContatosChatwoot({ aplicar: false });
      igual('nao escreve', r.escritos, 0);
      igual('mas diz o que escreveria', r.escreveria, 1);
      igual('zero PUT', de('PUT', '/contacts').length, 0);
      igual('com amostra auditavel', r.amostra[0].para, 'Maria de Fatima');
      igual('e a fonte do nome', r.amostra[0].fonte, 'espelho_moskit');
    }

    // ---------- cascata de busca: filter e depois search ----------
    {
      zerar();
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      // filter nao acha (formato divergente no Chatwoot) — e isso NAO prova que o contato nao existe.
      rede.post = (url) => (url.endsWith('/contacts/filter') ? { status: 200, data: { payload: [] } } : { status: 200, data: {} });
      rede.get = (url) => {
        if (url.includes('/contacts/search')) return { status: 200, data: { payload: [{ id: 520, name: '', phone_number: '8699999999' }] } };
        if (url.endsWith('/contacts/520')) return { status: 200, data: { payload: { id: 520, name: '', phone_number: '8699999999', identifier: '', custom_attributes: {} } } };
        return { status: 200, data: {} };
      };
      rede.put = () => ({ status: 204, data: '' });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('search acha o que o filter nao achou', r.escritos, 1);
      checar('e o filter foi tentado antes', de('POST', '/contacts/filter').length === 1, rede.chamadas.map((c) => c.url));
      // query_operator NULL, nao 'AND'. MEDIDO em 04/09/2026 contra a instancia real: o Chatwoot
      // valida esse campo contra a string TRADUZIDA do idioma da instancia, e a do escritorio esta em
      // portugues — 'AND' devolveu 422 "Operador de consulta deve ser E ou OU". O sintoma era mudo,
      // porque a cascata caia para /contacts/search e ACHAVA o contato: so queimava uma requisicao
      // recusada por candidato, em todo ciclo, para sempre.
      igual('e o filter manda query_operator null (nao "AND", que quebra em pt-BR)',
        de('POST', '/contacts/filter')[0].corpo.payload[0].query_operator, null);
      // Nunca busca por nome: o cliente nao tem nome no Chatwoot, e casar por nome poria a ficha de
      // um cliente na de outro.
      const busca = de('GET', '/contacts/search')[0];
      igual('a busca e pelo sufixo do telefone', busca.cfg.params.q, '99999999');
    }

    // ---------- nao encontrado: nao retenta a cada ciclo ----------
    {
      zerar();
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      rede.post = () => ({ status: 200, data: { payload: [] } });
      rede.get = () => ({ status: 200, data: { payload: [] } });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('marca como nao encontrado', r.nao_encontrados, 1);
      limpar();
      rede.post = () => ({ status: 200, data: { payload: [] } });
      rede.get = () => ({ status: 200, data: { payload: [] } });
      const r2 = await sincronizarContatosChatwoot({ aplicar: true });
      igual('e nao gasta 2 requisicoes por ciclo para sempre', r2.pulados.nao_encontrado_recente, 1);
      igual('sem tocar a rede', rede.chamadas.filter((c) => c.url.includes('chat.exemplo.com')).length, 0);
    }

    // ---------- varredura: paginacao ignorada em silencio e ERRO ALTO ----------
    {
      zerar();
      // Aconteceu 3x com o Moskit neste repo: o parametro de pagina e ignorado, a pagina 2 volta
      // identica a 1, e o loop "varre" 4 mil contatos relendo 15 — parecendo ter funcionado.
      rede.get = () => ({ status: 200, data: { meta: { count: 4000 }, payload: [{ id: 1, name: 'A', phone_number: '+558611111111' }] } });
      const erro = await esperarErro(() => varrerContatosChatwoot({ maxPaginas: 5 }));
      checar('varredura falha alto quando a pagina nao avanca', /paginacao do Chatwoot nao avanca/.test(erro || ''), erro);

      // Controle: paginacao de verdade varre e para na pagina vazia.
      limpar();
      let pag = 0;
      rede.get = () => {
        pag++;
        if (pag > 2) return { status: 200, data: { meta: { count: 3 }, payload: [] } };
        return { status: 200, data: { meta: { count: 3 }, payload: [{ id: pag * 10, name: 'X', phone_number: `+5586111111${pag}${pag}` }] } };
      };
      const rv = await varrerContatosChatwoot({ maxPaginas: 10 });
      igual('varredura normal conta os contatos', rv.contatos, 2);
      igual('e grava no espelho', rv.gravados, 2);
    }

    // ---------- o resumo do Telegram so leva o acionavel ----------
    {
      zerar();
      semearChatwoot(CHAVE, 511, '');
      semearMoskit(CHAVE, 4711, 'Maria de Fatima');
      semear(CHAVE, {});
      rede.get = respondeFicha(511, '');
      rede.put = () => ({ status: 204, data: '' });
      await rodarSincronizacaoChatwoot();
      // Sucesso de rotina e Familia B: nao vira aviso, viraria ruido diario.
      igual('sucesso nao manda Telegram', telegrams().length, 0);

      zerar();
      semearChatwoot('558644444444', 512, '');
      sChat.upsertVisto.run('8644444444', 513, '8644444444', '', '');
      semearMoskit('5586944444444', 4711, 'Maria de Fatima');
      semear('5586944444444', {});
      await rodarSincronizacaoChatwoot();
      igual('mas duas fichas para o mesmo cliente manda', telegrams().length, 1);
      checar('e o aviso diz que precisa de merge manual', /merge manual/.test(telegrams()[0].corpo.text), telegrams()[0].corpo.text);
    }

    // ---------- ficha do Chatwoot SEM conversa: o segundo conjunto de candidatos ----------
    {
      // MEDIDO em 04/09/2026 na instancia real: 4 fichas mostravam o telefone, tinham nome no Moskit
      // e NUNCA seriam preenchidas, porque a rotina varria apenas `conversations` e esses clientes
      // nunca escreveram para o bot. O conjunto que o escritorio quer consertar e definido pelo
      // CHATWOOT, nao pelo nosso log de conversas.
      zerar();
      const SEM_CONVERSA = '558677776666';
      semearChatwoot(SEM_CONVERSA, 700, '558677776666');
      semearMoskit(SEM_CONVERSA, 4799, 'Dayse Moreira');
      // De proposito: NENHUMA linha em conversations para este telefone.

      const chaves = montarCandidatosChatwoot(100).map((c) => c.chat_id);
      checar('ficha sem conversa entra na fila', chaves.includes(SEM_CONVERSA), chaves);

      rede.get = respondeFicha(700, '558677776666');
      rede.put = () => ({ status: 204, data: '' });
      const r = await sincronizarContatosChatwoot({ aplicar: true });
      igual('e o nome do Moskit e escrito', r.escritos, 1);
      igual('com o nome certo', de('PUT', '/contacts/700')[0].corpo.name, 'Dayse Moreira');
      // Sem conversa nao ha deal: o link do negocio nao pode entrar como string vazia nem quebrada.
      const attrs = de('PUT', '/contacts/700')[0].corpo.custom_attributes || {};
      checar('e sem link de negocio (nao existe deal)', !('moskit_negocio_url' in attrs), attrs);

      // Ficha que JA tem nome de pessoa nao entra na fila: seria um GET por ciclo para concluir
      // "nao mexer", e essa decisao nao depende de rede.
      zerar();
      semearChatwoot('558677775555', 701, 'Maria Aparecida');
      semearMoskit('558677775555', 4798, 'Maria Fatima');
      const chaves2 = montarCandidatosChatwoot(100).map((c) => c.chat_id);
      checar('ficha com nome humano NAO entra na fila', !chaves2.includes('558677775555'), chaves2);

      // A conversa tem precedencia sobre a ficha: e ela que traz deal_id e o nome extraido pela IA.
      zerar();
      semearChatwoot(CHAVE, 702, '558699999999');
      semearMoskit(CHAVE, 4797, 'Cliente Com Deal');
      semear(CHAVE, { deal_id: 48407608 });
      const candidatos = montarCandidatosChatwoot(100).filter((c) => c.chat_id === CHAVE);
      igual('a mesma chave nao entra duas vezes', candidatos.length, 1);
      igual('e a versao que vale e a da conversa (tem deal_id)', candidatos[0].deal_id, 48407608);
    }

    // ---------- a decisao de credencial ----------
    {
      checar('host exato', ehHostChatwoot('chat.exemplo.com') === true);
      checar('subdominio', ehHostChatwoot('a.chat.exemplo.com') === true);
      // endsWith('chat.exemplo.com') ingenuo entregaria o token para malchat.exemplo.com — este
      // repositorio ja vazou credencial exatamente assim (a chave do Zernio para CDN da Meta).
      checar('sufixo SEM ponto nao e o Chatwoot', ehHostChatwoot('malchat.exemplo.com') === false);
      checar('host de terceiro', ehHostChatwoot('evil.com') === false);
    }
  }

  // ============================================================
  console.log('\n🩺 Monitor Evolution API -> Chatwoot: nunca mais ficar mudo');
  // ============================================================
  // O incidente de 04/09/2026: um token do Chatwoot foi regenerado, a Evolution continuou com o
  // antigo, e 58 minutos de WhatsApp nunca viraram conversa no Chatwoot — sem alarme nenhum. O que
  // esta em jogo aqui e nao repetir isso: detectar e avisar, so leitura, com dedup que sobrevive a
  // restart do pm2 (por isso o estado e SQLite, nao variavel de processo).
  {
    const zerarEvolution = () => {
      db.prepare('DELETE FROM evolution_saude').run();
      db.prepare("INSERT INTO evolution_saude (id) VALUES (1)").run();
      limpar();
    };

    const respostaOk = (url) => {
      if (url.includes('/instance/fetchInstances')) return { status: 200, data: [{ name: 'escritorio', connectionStatus: 'open' }] };
      if (url.includes('/chatwoot/find/')) return { status: 200, data: { enabled: true, accountId: '9', token: 'token-evolution-valido', url: 'http://rails:3000', nameInbox: 'WhatsApp' } };
      if (url.includes('/api/v1/profile')) return { status: 200, data: { id: 1 } };
      return { status: 200, data: {} };
    };

    // ---------- ciclo saudavel: zero Telegram ----------
    {
      zerarEvolution();
      rede.get = respostaOk;
      const r = await monitorarEvolution();
      igual('ciclo saudavel: ok', r.veredito.ok, true);
      igual('ciclo saudavel: hash "ok"', r.hash, 'ok');
      igual('ciclo saudavel: zero Telegram (primeira execucao "ok" nao e evento)', telegrams().length, 0);
      igual('estado gravado no banco', stmtEvolutionSaude.get().ultimo_hash, 'ok');
      // Nao grava avisado_hash quando o ciclo e 'ok' e nunca houve nada a desfazer — nao ha aviso
      // "voltou" a evitar ainda. avisado_hash so passa a existir na PRIMEIRA vez que ha algo a
      // decidir (uma falha, que dispara e grava; ou uma recuperacao de falha anterior).
      igual('avisado_hash fica NULL em ciclo saudavel sem falha anterior (nada a desfazer ainda)', stmtEvolutionSaude.get().avisado_hash, null);
    }

    // ---------- token invalido: o causador do incidente real ----------
    {
      zerarEvolution();
      rede.get = (url) => (url.includes('/api/v1/profile') ? { status: 401, data: {} } : respostaOk(url));
      const r = await monitorarEvolution();
      igual('token invalido: motivo certo', r.veredito.motivo, 'token_invalido');
      igual('1 Telegram', telegrams().length, 1);
      checar('o texto e acionavel (fala em religar)', /religar/i.test(telegrams()[0].corpo.text), telegrams()[0].corpo.text);
      checar('o texto NUNCA contem o valor do token testado', !telegrams()[0].corpo.text.includes('token-evolution-valido'));
      igual('hash gravado', stmtEvolutionSaude.get().ultimo_hash, 'falha:token_invalido');
    }

    // ---------- mesmo motivo repetido: dedup, zero Telegram novo ----------
    {
      limpar();
      rede.get = (url) => (url.includes('/api/v1/profile') ? { status: 401, data: {} } : respostaOk(url));
      await monitorarEvolution();
      igual('mesma falha persistindo => zero Telegram novo', telegrams().length, 0);
    }

    // ---------- token volta a validar: aviso de recuperacao, sem sugerir recuperar mensagem ----------
    {
      limpar();
      rede.get = respostaOk;
      const r = await monitorarEvolution();
      igual('voltou: hash "ok"', r.hash, 'ok');
      igual('1 Telegram de recuperacao', telegrams().length, 1);
      checar('confirma que voltou', /voltou ao normal/i.test(telegrams()[0].corpo.text), telegrams()[0].corpo.text);
      checar('NUNCA sugere recuperar mensagem perdida (decisao fechada com o dono)', !/recuperar.*mensage/i.test(telegrams()[0].corpo.text), telegrams()[0].corpo.text);
    }

    // ---------- troca de motivo em falha continua: avisa de novo (nao so quando volta a "ok") ----------
    {
      zerarEvolution();
      rede.get = (url) => (url.includes('/api/v1/profile') ? { status: 401, data: {} } : respostaOk(url));
      await monitorarEvolution(); // fica em token_invalido, ja avisado
      limpar();
      rede.get = (url) => (url.includes('/instance/fetchInstances') ? { status: 200, data: [{ name: 'escritorio', connectionStatus: 'close' }] } : respostaOk(url));
      const r = await monitorarEvolution();
      igual('motivo mudou para sessao_fechada', r.veredito.motivo, 'sessao_fechada');
      igual('e avisa de novo, mesmo ainda quebrado', telegrams().length, 1);
    }

    // ---------- instancia sumiu / evolution inacessivel ----------
    {
      zerarEvolution();
      rede.get = () => ({ status: 200, data: [] }); // sem a instancia "escritorio" na lista
      const r1 = await monitorarEvolution();
      igual('instancia sumida', r1.veredito.motivo, 'instancia_nao_encontrada');

      zerarEvolution();
      rede.get = () => { throw new Error('ECONNREFUSED'); };
      const r2 = await monitorarEvolution();
      igual('evolution inacessivel', r2.veredito.motivo, 'evolution_inacessivel');
      igual('ainda assim manda 1 Telegram', telegrams().length, 1);
    }

    // ---------- guardas estruturais do cliente ----------
    {
      // Duas checagens independentes por design: precisa estar na familia loopback E bater
      // EXATAMENTE com o hostname configurado em EVOLUTION_BASE (aqui, '127.0.0.1'). 'localhost' e
      // loopback tambem, mas NAO bate com a base configurada — e por isso e recusado: um redirect
      // que trocasse a string do host (mesmo dentro da familia loopback) nao deveria passar batido.
      checar('bate com o host configurado (127.0.0.1)', ehHostEvolutionLocal('127.0.0.1') === true);
      checar('loopback mas host DIFERENTE do configurado e recusado', ehHostEvolutionLocal('localhost') === false);
      checar('host de terceiro e recusado', ehHostEvolutionLocal('evil.com') === false);
      // So GET, e um UNICO POST liberado (/chat/findMessages/{instancia}, leitura apesar do verbo —
      // mesma excecao de /contacts/filter no Chatwoot). Nenhum outro POST, nenhum PUT, nenhum DELETE.
      const erroPostArbitrario = await esperarErro(() => evolutionRequisicao('/instance/logout', { metodo: 'post' }));
      checar('POST fora do caminho liberado e recusado', /nao e permitido/.test(erroPostArbitrario || ''), erroPostArbitrario);
      const erroPut = await esperarErro(() => evolutionRequisicao('/instance/logout', { metodo: 'put' }));
      checar('PUT nunca e permitido (nem existe caminho liberado pra ele)', /metodo nao permitido/.test(erroPut || ''), erroPut);
    }

    // ---------- buscarMensagensEvolutionNaJanela: o relatorio pedido pelo dono em 04/09/2026 ----------
    {
      const t = (hhmm) => Date.parse(`2026-09-04T${hhmm}:00Z`);
      const registro = (id, jid, ts, fromMe, pushName) => ({ key: { id, remoteJid: jid, fromMe }, messageTimestamp: Math.floor(ts / 1000), pushName });

      rede.post = (url, corpo) => {
        if (!url.includes('/chat/findMessages/')) return { status: 200, data: {} };
        if (corpo.page > 1) return { status: 200, data: { messages: { records: [] } } }; // 1 pagina basta pro teste
        return {
          status: 200,
          data: {
            messages: {
              records: [
                registro('1', '558699999999@s.whatsapp.net', t('12:31'), false, 'Maria'),
                registro('2', '558699999999@s.whatsapp.net', t('12:45'), false, 'Maria'),
                registro('3', '999@lid', t('12:20'), false, '🌻'),
                registro('4', '120363410213066890@g.us', t('12:25'), false, 'Alguem do Grupo'), // grupo: fora
                registro('5', '558699999999@s.whatsapp.net', t('12:50'), true, 'Você'), // fromMe: fora ("recebida" e so do cliente)
                registro('6', '558611110000@s.whatsapp.net', t('11:00'), false, 'Fora da janela'), // antes de "desde": fora
              ],
            },
          },
        };
      };

      const contatos = await buscarMensagensEvolutionNaJanela(t('12:00'), t('13:00'));
      igual('so 2 contatos ficam (grupo, fromMe e fora-da-janela excluidos)', contatos.length, 2);
      const maria = contatos.find((c) => c.remoteJid.includes('558699999999'));
      igual('Maria com as 2 mensagens dela', maria.horarios.length, 2);
      igual('pushName capturado', maria.pushName, 'Maria');
      const semNome = contatos.find((c) => c.remoteJid === '999@lid');
      igual('contato so por @lid tambem entra (sem telefone, mas com nome)', semNome.pushName, '🌻');
    }

    // ---------- resolverTelefoneChatwoot: candidato unico ou nada — nunca palpite ----------
    {
      rede.get = (url) => {
        if (!url.includes('/contacts/search')) return { status: 200, data: {} };
        // O dublê do GET so passa a URL pro handler, sem os params (que vao em cfg, nao na string da
        // URL) — o proprio jeito que ele registra a chamada e como recuperamos o "q" que foi mandado.
        const ultima = rede.chamadas[rede.chamadas.length - 1];
        const q = ultima?.cfg?.params?.q;
        if (q === 'Maria Unica') return { status: 200, data: { payload: [{ id: 1, phone_number: '+558699999999' }] } };
        if (q === 'Nome Ambiguo') return { status: 200, data: { payload: [{ id: 1, phone_number: '+558611111111' }, { id: 2, phone_number: '+558622222222' }] } };
        return { status: 200, data: { payload: [] } };
      };
      igual('candidato unico => resolve', await resolverTelefoneChatwoot('Maria Unica'), '+558699999999');
      igual('dois candidatos => null, NAO chuta um', await resolverTelefoneChatwoot('Nome Ambiguo'), null);
      igual('nenhum candidato => null', await resolverTelefoneChatwoot('Ninguem Assim'), null);
      igual('nome vazio => null, nem tenta a rede', await resolverTelefoneChatwoot(''), null);
    }

    // ---------- o fluxo completo: recuperacao dispara o alerta E o relatorio, em mensagens separadas ----------
    {
      const t = (hhmm) => Date.parse(`2026-09-04T${hhmm}:00Z`);
      const registro = (id, jid, ts, fromMe, pushName) => ({ key: { id, remoteJid: jid, fromMe }, messageTimestamp: Math.floor(ts / 1000), pushName });

      db.prepare('DELETE FROM evolution_saude').run();
      db.prepare("INSERT INTO evolution_saude (id, ultimo_hash, avisado_hash, mudou_em) VALUES (1, 'falha:token_invalido', 'falha:token_invalido', ?)")
        .run(new Date(t('12:00')).toISOString().slice(0, 19).replace('T', ' '));
      limpar();

      rede.get = (url) => {
        if (url.includes('/instance/fetchInstances')) return { status: 200, data: [{ name: 'escritorio', connectionStatus: 'open' }] };
        if (url.includes('/chatwoot/find/')) return { status: 200, data: { enabled: true, accountId: '9', token: 'tok-valido' } };
        if (url.includes('/api/v1/profile')) return { status: 200, data: {} };
        if (url.includes('/contacts/search')) return { status: 200, data: { payload: [{ id: 1, phone_number: '+558699999999' }] } };
        return { status: 200, data: {} };
      };
      rede.post = (url, corpo) => {
        if (!url.includes('/chat/findMessages/')) return { status: 200, data: {} };
        if (corpo.page > 1) return { status: 200, data: { messages: { records: [] } } };
        return { status: 200, data: { messages: { records: [registro('1', '558699999999@s.whatsapp.net', t('12:31'), false, 'Maria')] } } };
      };

      await monitorarEvolution();
      igual('duas mensagens no Telegram: o "voltou" e o relatorio', telegrams().length, 2);
      checar('a primeira confirma a recuperacao', /voltou ao normal/i.test(telegrams()[0].corpo.text), telegrams()[0].corpo.text);
      checar('a segunda e o relatorio, com numero/nome/horario', /Maria/.test(telegrams()[1].corpo.text) && /558699999999/.test(telegrams()[1].corpo.text), telegrams()[1].corpo.text);

      // Controle: se NAO tem nada na janela, so manda o "voltou" — nao um relatorio vazio.
      db.prepare('DELETE FROM evolution_saude').run();
      db.prepare("INSERT INTO evolution_saude (id, ultimo_hash, avisado_hash, mudou_em) VALUES (1, 'falha:token_invalido', 'falha:token_invalido', ?)")
        .run(new Date(t('12:00')).toISOString().slice(0, 19).replace('T', ' '));
      limpar();
      rede.get = (url) => {
        if (url.includes('/instance/fetchInstances')) return { status: 200, data: [{ name: 'escritorio', connectionStatus: 'open' }] };
        if (url.includes('/chatwoot/find/')) return { status: 200, data: { enabled: true, accountId: '9', token: 'tok-valido' } };
        if (url.includes('/api/v1/profile')) return { status: 200, data: {} };
        return { status: 200, data: {} };
      };
      rede.post = (url, corpo) => (url.includes('/chat/findMessages/') ? { status: 200, data: { messages: { records: [] } } } : { status: 200, data: {} });
      await monitorarEvolution();
      igual('janela vazia => so o "voltou", sem relatorio vazio', telegrams().length, 1);
    }
  }

  db.close();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})().catch((e) => {
  // index.js registra um handler global de unhandledRejection que LOGA e nao muda o exit code —
  // correto para producao (promise rejeitada nao deve matar o bot), pessimo aqui: um throw dentro
  // desta IIFE imprimia o erro e o processo saia 0, ou seja FALHA PASSANDO COMO SUITE VERDE, sem
  // nem chegar a imprimir o resumo. Medido nesta sessao: uma excecao na secao do Chatwoot deu
  // "exit=0". Os outros test-*.js com IIFE async tem o mesmo buraco.
  console.error('o teste lancou fora de uma assercao:', e?.stack || e?.message || e);
  process.exit(1);
});
