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
  moverParaEstagio, criarNotaMoskit, aplicarViradaCobranca, handleAgendamentoCalendar, finalizarCiclo,
} = require('./index');

const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

function limpar() {
  rede.chamadas = []; rede.get = rede.post = rede.put = null;
  agenda.insert = []; agenda.patch = []; agenda.get = []; agenda.delete = [];
  agenda.respostaInsert = { id: 'ev1', htmlLink: 'https://exemplo/ev1' };
}
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
const notas = () => de('POST', '/notes');
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

const DADOS = { nome: 'Fulano de Tal', assunto: 'Inventario', tipo_consulta: 'consulta paga', advogado_responsavel: 'Bruno' };

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
    rede.get = () => ({ status: 200, data: { id: 10, name: 'Fulano de Tal - Inventario', stage: { id: 179388 } } });
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
    rede.get = () => ({ status: 200, data: { id: 11, stage: { id: 184382 } } });
    const row = semear(TEL, { deal_id: 11, evento_calendar_criado: 1, evento_calendar_id: 'ev9', evento_calendar_data: '2026-08-05T17:30:00' });
    await aplicarViradaCobranca(TEL, row, DADOS, { condicoesValorEnviadas: true }, TEL);
    igual('evento ja na agenda → 1 alerta no Telegram', telegrams().length, 1);
    checar('   o alerta traz o horario da reuniao', telegrams()[0].corpo.text.includes('05/08/2026'), telegrams()[0].corpo.text);
    igual('   o evento NAO e cancelado', agenda.delete.length, 0);
    igual('   o PUT acontece do mesmo jeito', de('PUT', '/deals/11').length, 1);
  }
  {
    limpar();
    rede.get = () => ({ status: 200, data: { id: 12, stage: { id: 184382 } } });
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
    limpar();
    const row = semear(CHAT, { deal_id: 20, evento_calendar_criado: 1, evento_calendar_id: 'ev1', evento_calendar_data: '2026-08-05T17:30:00' });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-08-09T09:00:00' }, CHAT, false, row, SO_CLIENTE);
    igual('reuniao existente sem dupla confirmacao → NAO remarca', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
    igual('   1 nota de "nao remarcada"', notas().length, 1);
    checar('   com o texto certo', notas()[0].corpo.description.includes('NÃO remarcada'));
    checar('   titulo/descricao ainda podem ser corrigidos (nao movem nada)', agenda.get.length >= 1);
  }
  {
    // O horario que vale e o das observacoes, nao o dados.data_hora_consulta — que pode ter sido
    // herdado de uma rodada anterior pelo mergeDados.
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS, data_hora_consulta: '2026-01-01T08:00:00' }, CHAT, true, row, CONFIRMADO);
    igual('dupla confirmacao → 1 evento criado', agenda.insert.length, 1);
    const inicio = agenda.insert[0].requestBody.start.dateTime;
    igual('   o inicio e o horario CONFIRMADO, nao o herdado', inicio, new Date('2026-08-05T17:30:00').toISOString());
    checar('   duracao de 1h', new Date(agenda.insert[0].requestBody.end.dateTime) - new Date(inicio) === 3600000);
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
    // e nunca mais tentar. Aqui o insert responde vazio e a montagem da nota de sucesso explode; o
    // que importa e que o catch da funcao NAO deixa o banco mentir — e, com o gap de visibilidade
    // fechado (deal 48346871), a equipe recebe uma nota de FALHA em vez de silencio total.
    limpar();
    agenda.respostaInsert = null;
    const row = semear(CHAT, { deal_id: 20 });
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, CONFIRMADO);
    igual('insert respondeu vazio → banco NAO marca como criado', linha(CHAT).evento_calendar_criado, 0);
    igual('   sem evento_calendar_id', linha(CHAT).evento_calendar_id, null);
    igual('   nenhuma nota de SUCESSO', notas().filter((n) => n.corpo.description.startsWith('📅')).length, 0);
    igual('   mas 1 nota de FALHA (a equipe fica sabendo)', notas().filter((n) => n.corpo.description.startsWith('❌')).length, 1);
    checar('   a nota de falha cita o motivo', notas()[0].corpo.description.includes("reading 'htmlLink'"));
    igual('   e SEM avanco de estagio (o return no catch impede)', notas().length, 1);
  }
  {
    // Caminho legitimo de `if (!evento) return`: data invalida faz criarEventoGoogleCalendar devolver
    // null sem lancar. Nada pode ser gravado.
    limpar();
    const row = semear(CHAT, { deal_id: 20 });
    const apuracaoRuim = { ...CONFIRMADO, horarioIso: 'amanha de tarde' };
    await handleAgendamentoCalendar(20, { ...DADOS }, CHAT, true, row, apuracaoRuim);
    igual('horario invalido → nenhum evento, sem crash', agenda.insert.length, 0);
    igual('   banco intocado', linha(CHAT).evento_calendar_criado, 0);
    igual('   nenhuma nota', notas().length, 0);
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

  db.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
