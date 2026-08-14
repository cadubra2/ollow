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

// ---------- dublê do Google Calendar ----------
const { google } = require('googleapis');
const agenda = { insert: [], patch: [], get: [], delete: [], respostaInsert: null };
google.calendar = () => ({
  events: {
    insert: async (a) => { agenda.insert.push(a); return { data: agenda.respostaInsert }; },
    patch: async (a) => { agenda.patch.push(a); return { data: {} }; },
    get: async (a) => { agenda.get.push(a); return { data: { summary: 'antigo', description: 'antigo' } }; },
    delete: async (a) => { agenda.delete.push(a); return {}; },
  },
});

const {
  moverParaEstagio, criarNotaMoskit, aplicarViradaCobranca, atualizarNegocioMoskit,
  handleAgendamentoCalendar, listarAtividadesMoskit, finalizarCiclo,
  aplicarGateCasoDescrito, deveEsperarCasoDescrito, registrarBriefing, mergeDados,
  mesclarParaCrm, derivarAdvogadoDaArea, detectarOpcoesInvalidas, registrarOpcoesInvalidas,
  reconciliarClassificacao, montarPayloadMoskit,
  descreverAncora, somarMinutosNaive, formatarHorarioEscritorio,
} = require('./index');
const moskitIds = require('./src/moskit-ids');
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
  agenda.insert = []; agenda.patch = []; agenda.get = []; agenda.delete = [];
  agenda.respostaInsert = { id: 'ev1', htmlLink: 'https://exemplo/ev1' };
  // Tabela de dedupe entre as duas agendas — sem limpar, o INSERT OR IGNORE do teste anterior faria
  // o proximo enxergar uma linha velha e passar por engano.
  db.prepare('DELETE FROM atividades_sincronizadas').run();
}
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
const notas = () => de('POST', '/notes');
const atividadesCriadas = () => de('POST', '/activities');
const atividadesRemarcadas = () => de('PUT', '/activities');
const sincronizada = (id) => db.prepare('SELECT * FROM atividades_sincronizadas WHERE activity_id = ?').get(id);
const telegrams = () => de('POST', 'api.telegram.org');
const linha = (chatId) => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);

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
    igual('1 nota explicando a virada', notas().length, 1);
    checar('   a nota cita a reclassificacao', notas()[0].corpo.description.includes('PAGA'));
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
    igual('so o cliente aceitou → 1 nota de pendencia', notas().length, 1);
    checar('   a nota diz que NAO foi lancada', notas()[0].corpo.description.includes('NÃO lançada'));
    checar('   e diz o que falta', notas()[0].corpo.description.includes('DA EQUIPE'));
    igual('   NENHUM evento criado', agenda.insert.length, 0);
    checar('   hash de pendencia gravado', !!linha(CHAT).agendamento_pendente_hash);

    // Sem o hash, a mesma nota sairia a cada ciclo de 5 min enquanto a conversa nao mudasse.
    const anterior = notas().length;
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), SO_CLIENTE);
    igual('repetir identico → nenhuma nota nova (dedup por hash)', notas().length, anterior);

    const outro = { ...SO_CLIENTE, cliente: { ...ACEITE, horario_iso: '2026-08-06T10:00:00' } };
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, linha(CHAT), outro);
    igual('horario diferente → nota nova', notas().length, anterior + 1);
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: null });
    await handleAgendamentoCalendar(null, { ...DADOS }, CHAT, false, row, SO_CLIENTE);
    igual('sem dealId → nenhuma nota', notas().length, 0);
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
    // nao depende de dupla confirmacao nesta rodada, so do evento no Google ja existir), entao
    // aparece 1 nota a mais alem da de "nao remarcada".
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-09T09:00:00' }, CHAT, false, row, SO_CLIENTE);
    igual('reuniao existente sem dupla confirmacao → NAO remarca', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
    checar('   a auto-cura ainda cria a atividade que faltava', atividadesCriadas().length === 1);
    igual('   2 notas: atividade criada agora + "nao remarcada"', notas().length, 2);
    checar('   uma delas com o texto certo de "nao remarcada"', notas().some((n) => n.corpo.description.includes('NÃO remarcada')));
    checar('   titulo/descricao ainda podem ser corrigidos (nao movem nada)', agenda.get.length >= 1);
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

    checar('   nota cita a evidencia das duas pernas',
      notas()[0].corpo.description.includes('pode ser sim') && notas()[0].corpo.description.includes('marquei sua consulta'));
    checar('   com comprovante verificado, a nota nao alerta', notas()[0].corpo.description.includes('comprovante verificado'));
  }
  {
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, false, row, CONFIRMADO);
    checar('sem comprovante → a nota avisa em destaque', notas()[0].corpo.description.includes('SEM comprovante verificado'));
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

    checar('   a nota do negocio avisa que entrou na agenda do Moskit',
      notas()[0]?.corpo.description.includes('agenda do Moskit'));
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
    checar('   e a nota avisa que a agenda do Moskit acompanhou',
      notas()[0]?.corpo.description.includes('Agenda do Moskit'));
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
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, { ...CONFIRMADO, horarioIso: '2026-08-06T10:00:00' });
    igual('conversa legada sem atividade → nenhum PUT em /activities (nao ha o que remarcar)', atividadesRemarcadas().length, 0);
    igual('   mas TENTA CRIAR a atividade que falta (auto-cura)', atividadesCriadas().length, 1);
    igual('   banco: atividade_moskit_id passa a existir', linha(CHAT).atividade_moskit_id, ID_ATIVIDADE);
    checar('   e entra na trava anti-duplicado', !!sincronizada(ID_ATIVIDADE));
    checar('   com uma nota avisando que a atividade foi criada agora',
      notas().some((n) => n.corpo.description.includes('foi criada agora')));
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
    igual('   banco: atividade_moskit_id fica nulo (proximo ciclo nao tenta de novo, ver nota)', linha(CHAT).atividade_moskit_id, null);
    checar('   uma nota avisa que a consulta NAO entrou na agenda do Moskit',
      notas().some((n) => n.corpo.description.includes('NAO entrou na agenda do Moskit')));
    checar('   e nenhuma atividade fica marcada como sincronizada', !sincronizada(ID_ATIVIDADE));
  }
  {
    // 2xx sem id e tao inutil quanto um erro: sem id nao da pra remarcar nem pra travar o duplicado.
    limpar();
    rede.post = (url) => ({ status: 200, data: url.includes('/activities') ? {} : {} });
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('POST /activities 200 sem id → tratado como falha', linha(CHAT).atividade_moskit_id, null);
    checar('   com aviso no negocio', notas().some((n) => n.corpo.description.includes('NAO entrou na agenda do Moskit')));
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
      notas().some((n) => n.corpo.description.includes('consulta agendada')), notas());
  }
  {
    // Ramo que faltava cobertura: evento JA existia (nao e criado de novo) e a dupla confirmacao
    // continua valida — atualizarEventoSeRemarcado roda E o avanco de estagio tambem tem que rodar.
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 179388 } } });
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-05T17:30:00' }, CHAT, true, row, CONFIRMADO);
    checar('evento que ja existia + dupla confirmacao valida → tambem avanca',
      notas().some((n) => n.corpo.description.includes('consulta agendada')), notas());
  }
  {
    // Guarda de prioridade: deal ja avancou alem de "consulta agendada" (ex: aguardando_condicao,
    // priority 5) — moverEstagioSeAvancar tem que ignorar antes de chegar no dry-run.
    limpar();
    rede.get = () => ({ status: 200, data: { stage: { id: 285584 } } }); // aguardando_condicao
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    checar('deal ja avancado → NENHUMA nota de "consulta agendada"',
      !notas().some((n) => n.corpo.description.includes('consulta agendada')), notas());
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
    igual('   nenhuma nota de SUCESSO do Google (📅)', notas().filter((n) => n.corpo.description.startsWith('📅')).length, 0);
    checar('   1 nota combinada: Moskit marcado + Google/Meet NAO criado',
      notas().some((n) => n.corpo.description.startsWith('🗓️') && n.corpo.description.includes('NÃO foi criado')), notas());
    checar('   1 nota de FALHA do agendamento (a mesma que dispara Telegram)',
      notas().some((n) => n.corpo.description.startsWith('❌') && n.corpo.description.includes("reading 'htmlLink'")));
    checar('   e o estagio AVANCA (a atividade do Moskit conta como consulta marcada)',
      notas().some((n) => n.corpo.description.includes('consulta agendada')));
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
    checar('   nota de falha da Atividade (criarAtividadeMoskit)',
      notas().some((n) => n.corpo.description.includes('NAO entrou na agenda do Moskit')));
    checar('   nota de falha do agendamento (Google)',
      notas().some((n) => n.corpo.description.startsWith('❌') && n.corpo.description.includes("reading 'htmlLink'")));
    checar('   sem nenhuma nota de sucesso (nem 📅 nem 🗓️ combinada)',
      !notas().some((n) => n.corpo.description.startsWith('📅') || (n.corpo.description.startsWith('🗓️') && n.corpo.description.includes('NÃO foi criado'))));
    checar('   e SEM avanco de estagio (nada foi marcado em agenda nenhuma)',
      !notas().some((n) => n.corpo.description.includes('consulta agendada')));
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
    igual('   1 nota de FALHA (a equipe fica sabendo)', notas().filter((n) => n.corpo.description.startsWith('❌')).length, 1);
    checar('   a nota cita o valor recusado', notas()[0].corpo.description.includes('amanha de tarde'));
    igual('   e nenhuma nota de sucesso', notas().filter((n) => n.corpo.description.startsWith('📅')).length, 0);
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
      igual('   com nota de falha', notas().filter((n) => n.corpo.description.startsWith('❌')).length, 1);
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
    igual('   so uma nota de sugestao', notas().length, 1);
    checar('   marcada como dry-run', notas()[0].corpo.description.includes('dry-run'));
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
    igual('   so uma nota de sugestao', notas().length, 1);
    checar('   marcada como dry-run', notas()[0].corpo.description.includes('dry-run'));
    checar('   a nota cita o nome do cliente', notas()[0].corpo.description.includes('Fulano de Tal'));
    const tg = telegrams()[0]?.corpo?.text || '';
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
    igual('   so uma nota de sugestao', notas().length, 1);
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
    igual('   uma nota avisando a trava', notas().length, 1);
    checar('   ...com o nome do campo', (notas()[0].corpo.description || '').includes('Área do Direito'), notas()[0].corpo.description);
  }
  {
    // Trava e permanente: no ciclo seguinte o bot nem tenta, e nao repete a nota.
    limpar();
    semear(CHAT_AUT, { deal_id: 33, custom_fields_bot: JSON.stringify({ [ID_AREA]: [LGPD] }), campos_travados: JSON.stringify([ID_AREA]) });
    rede.get = getsDeAutoria(ADMIN);
    igual('campo travado → nao lanca', await esperarErro(() => atualizarNegocioMoskit(33, DADOS_LGPD, 555, { chatId: CHAT_AUT })), null);
    igual('campo travado continua fora do PUT', String(areaNoPut(33)), String([ADMIN]));
    igual('   nota de trava nao se repete', notas().length, 0);
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
  // trava de uma vez so. Agora quem decide e o hash do resumo.
  console.log('\n=== briefing: reposta quando o resumo muda de verdade ===');
  const CHAT_BRIEF = '5511988880000';
  const RESUMO_A = '📌 Caso: cliente quer tratar de assunto relacionado à LGPD.';
  const RESUMO_B = '📌 Caso: servidora exonerada quer remoção por motivo de saúde.';
  {
    limpar();
    semear(CHAT_BRIEF, { deal_id: 40 });
    const postou = await registrarBriefing(40, CHAT_BRIEF, RESUMO_A, '📋 Briefing pré-reunião');
    igual('primeiro briefing → posta', postou, true);
    checar('   com o titulo inicial', (notas()[0].corpo.description || '').includes('Briefing pré-reunião'), notas()[0]?.corpo?.description);
    igual('   briefing_added marcado', linha(CHAT_BRIEF).briefing_added, 1);
    checar('   hash gravado', !!linha(CHAT_BRIEF).briefing_hash);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, RESUMO_A, '📋 Briefing pré-reunião');
    igual('mesmo resumo → nao reposta', postou, false);
    igual('   nenhuma nota', notas().length, 0);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, `  ${RESUMO_A}\n\n `, '📋 Briefing pré-reunião');
    igual('so mudou espaco/quebra de linha → nao reposta', postou, false);
  }
  {
    limpar();
    const postou = await registrarBriefing(40, CHAT_BRIEF, RESUMO_B, '📋 Briefing pré-reunião');
    igual('resumo mudou de verdade → reposta', postou, true);
    checar('   agora como "Briefing atualizado"', (notas()[0].corpo.description || '').includes('Briefing atualizado'), notas()[0]?.corpo?.description);
    checar('   com o texto novo', (notas()[0].corpo.description || '').includes('remoção por motivo de saúde'));
  }
  {
    // Conversa anterior a esta mudanca (briefing_added=1, sem hash): adota o resumo atual como
    // referencia sem repostar, pra nao duplicar nota em todo deal ativo no primeiro ciclo apos deploy.
    limpar();
    semear(CHAT_BRIEF, { deal_id: 41, briefing_added: 1 });
    const postou = await registrarBriefing(41, CHAT_BRIEF, RESUMO_A, '📋 Briefing pré-reunião');
    igual('linha antiga sem hash → nao reposta', postou, false);
    igual('   nenhuma nota escrita em deal existente', notas().length, 0);
    checar('   hash adotado como referencia', !!linha(CHAT_BRIEF).briefing_hash);
  }
  {
    limpar();
    const postou = await registrarBriefing(41, CHAT_BRIEF, RESUMO_B, '📋 Briefing pré-reunião');
    igual('...e a proxima mudanca real ja reposta', postou, true);
    checar('   como atualizado', (notas()[0].corpo.description || '').includes('Briefing atualizado'));
  }
  {
    limpar();
    igual('sem resumo → nao posta nada', await registrarBriefing(40, CHAT_BRIEF, null, '📋 Briefing pré-reunião'), false);
    igual('sem dealId → nao posta nada', await registrarBriefing(null, CHAT_BRIEF, RESUMO_A, '📋 Briefing pré-reunião'), false);
    igual('   nenhuma chamada de rede', rede.chamadas.length, 0);
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
    const mesclado = mesclarParaCrm({ area_direito: 'Direito de Familia', advogado_responsavel: 'Iury' }, {}, OBS_CASO);
    igual('advogado incoerente com a area e corrigido no merge', mesclado.advogado_responsavel, 'Bruno');
  }
  {
    const dados = { area_direito: 'Outros', advogado_responsavel: 'Bruno' };
    derivarAdvogadoDaArea(dados);
    igual('area "Outros" → responsavel vazio', dados.advogado_responsavel, null);
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
    igual('   uma nota no deal', notas().length, 1);
    igual('   um aviso no Telegram', telegrams().length, 1);
    checar('   a nota diz que o campo ficou em branco', (notas()[0].corpo.description || '').includes('Direito Civil'), notas()[0].corpo.description);

    limpar();
    igual('mesmo conjunto → nao repete', await registrarOpcoesInvalidas(50, CHAT_OPC, invalidas), false);
    igual('   nenhuma nota nova', notas().length, 0);
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
    checar('   anota a reconciliacao no deal', notas().some((x) => (x.corpo.description || '').includes('reconciliada')), notas().map((x) => x.corpo.description));
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

  db.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
