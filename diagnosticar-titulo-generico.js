// Por que o negocio nasce chamado "Fulano - Consulta juridica" mesmo quando o cliente CONTOU o caso?
//
// A simulacao de 04/09/2026 (simular-10-leads-funil-teste.js) mostrou 4 de 6 negocios com titulo
// generico, e dois padroes diferentes escondidos atras do mesmo sintoma:
//   (a) area/advogado tambem VAZIOS -> o gate do caso descrito nao passou, ou seja o modelo nao
//       emitiu (ou a validacao rejeitou) a observacao `cliente_descreveu_caso`;
//   (b) area/advogado PREENCHIDOS e assunto placeholder -> o gate PASSOU e mesmo assim o assunto
//       veio neutro. Sao causas opostas e consertos opostos, e "o titulo esta generico" nao
//       distingue as duas.
//
// Este script chama a extracao REAL (extrairDadosAtendimento) e imprime o que normalmente ninguem ve:
// o assunto CRU antes do saneamento, as observacoes EMITIDAS, as REJEITADAS com o motivo, e o
// veredito do gate. Zero escrita: nao toca no Moskit nem no banco de producao.
//
//   node diagnosticar-titulo-generico.js            (roda os casos embutidos)
//   node diagnosticar-titulo-generico.js --deal=N   (releia uma conversa real do conversations.db)
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `diag-titulo-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
// Trava: qualquer escrita acidental falha alto em vez de chegar no CRM (mesma protecao de
// avaliar-extracao.js).
process.env.MOSKIT_BASE = 'http://127.0.0.1:9';
process.env.ZAPSIGN_BASE = 'http://127.0.0.1:9';

const bot = require('./index.js');
const { validarObservacoes } = require('./src/evidencia');

const agora = Date.now();
const ts = (min) => new Date(agora - min * 60000).toISOString();

// Casos que a simulacao produziu, com o desfecho observado la.
const CASOS = [
  {
    nome: 'Cenario 1 — remocao por motivo de saude',
    observado: 'titulo generico E area vazia (gate nao passou)',
    msgs: [
      ['cliente', 'Oi, vi vocês no Instagram e queria uma consulta', 40],
      ['equipe', 'Olá! Claro. Pode me contar um pouco do seu caso?', 38],
      ['cliente', 'Sou servidora pública e tive meu pedido de remoção por motivo de saúde negado pela administração. Queria entrar na justiça.', 35],
      ['equipe', 'Entendi. Vou verificar a agenda do Dr. Berto e te retorno.', 30],
    ],
  },
  {
    nome: 'Cenario 7 — demissao sem justa causa',
    observado: 'titulo generico E area vazia (gate nao passou)',
    msgs: [
      ['cliente', 'Boa tarde, preciso de um advogado', 60],
      ['equipe', 'Boa tarde! Me conta o que houve.', 58],
      ['cliente', 'Fui demitido sem justa causa e não recebi as verbas rescisórias', 55],
      ['equipe', 'A consulta com nosso advogado tem o valor de R$ 350,00 (trezentos e cinquenta reais), podendo ser paga via PIX, cartão ou transferência. A consulta tem duração aproximada de 1 hora.', 50],
      ['cliente', 'Certo, vou fazer o pix', 45],
    ],
  },
  {
    nome: 'Cenario 9 — FIES calculado errado',
    observado: 'titulo generico MAS area preenchida (gate PASSOU)',
    msgs: [
      ['cliente', 'Meu FIES foi calculado errado, quero revisar o abatimento por tempo de serviço no SUS', 60],
      ['equipe', 'Entendido, vou verificar com o Dr. Iury.', 55],
    ],
  },
  {
    nome: 'Cenario 5 — atraso de obra (CONTROLE: este deu certo)',
    observado: 'assunto real "Rescisao de contrato"',
    msgs: [
      ['cliente', 'Achei o escritório no JusBrasil', 40],
      ['equipe', 'Que bom! Como podemos ajudar?', 38],
      ['cliente', 'Comprei um apartamento na planta e a construtora atrasou a entrega em 2 anos. Quero rescindir e ser indenizado.', 35],
    ],
  },
  // ---------------------------------------------------------------------------------------------
  // CONTROLES NEGATIVOS. Reforcar "seja especifico" tem um risco oposto e pior: o modelo INVENTAR
  // um assunto quando ninguem contou o caso — que e exatamente o defeito do deal 48423360, em que
  // "consulta com o Dr. Berto" virou area LGPD e assunto "Direito Digital" deduzidos do perfil do
  // socio. Aqui o certo e o placeholder e area null; se algum destes voltar com assunto real, a
  // mudanca de prompt trocou um bug por um pior e tem que ser revertida.
  {
    nome: 'NEGATIVO A — so quer marcar, sem contar o caso',
    observado: 'DEVE continuar "Consulta juridica" com area null',
    negativo: true,
    msgs: [
      ['cliente', 'Bom dia, gostaria de marcar uma consulta com o Dr. Berto', 40],
      ['equipe', 'Bom dia! Qual seria o melhor horário para você?', 35],
      ['cliente', 'De manhã é melhor', 30],
    ],
  },
  {
    nome: 'NEGATIVO B — o contraexemplo do proprio prompt (deal 48423360)',
    observado: 'DEVE continuar "Consulta juridica" com area null',
    negativo: true,
    msgs: [
      ['cliente', 'Olá!', 40],
      ['cliente', 'Bom dia!', 39],
      ['cliente', 'Tudo bem?', 38],
      ['cliente', 'Gostaria de agendar uma consulta com o Dr. Berto, por videoconferencia.', 35],
    ],
  },
  {
    nome: 'NEGATIVO C — horario fechado, caso nunca descrito',
    observado: 'DEVE continuar "Consulta juridica" com area null',
    negativo: true,
    msgs: [
      ['cliente', 'Queria agendar uma consulta', 60],
      ['equipe', 'Posso te encaixar quinta-feira às 15h, pode ser?', 55],
      ['cliente', 'Pode sim, quinta às 15h está ótimo', 50],
      ['equipe', 'Perfeito, sua consulta está agendada para quinta-feira às 15h.', 45],
    ],
  },
];

async function diagnosticar(nome, observado, msgsBrutas, negativo = false) {
  const msgs = msgsBrutas.map(([role, text, min], i) => ({ id: `d-${i}`, role, text, timestamp: ts(min) }));
  const historico = bot.montarHistorico(msgs, {});
  const dataAtual = msgs[msgs.length - 1].timestamp;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${nome}`);
  console.log(`observado na simulação: ${observado}`);
  console.log('─'.repeat(78));

  const r = await bot.extrairDadosAtendimento(historico, false, null, 'Nao', dataAtual);
  const dados = r?.dados || {};

  console.log(`assunto CRU do modelo      : ${JSON.stringify(dados.assunto)}`);
  console.log(`area CRUA do modelo        : ${JSON.stringify(dados.area_direito)}`);
  console.log(`acao / confianca           : ${r?.acao} / ${r?.confianca}`);

  const emitidas = Array.isArray(r?.observacoes) ? r.observacoes : [];
  const { validas, rejeitadas } = validarObservacoes(emitidas, msgs);
  console.log(`observações EMITIDAS (${emitidas.length})     : ${emitidas.map((o) => o.tipo).join(', ') || '(nenhuma)'}`);
  console.log(`observações VÁLIDAS  (${validas.length})     : ${validas.map((o) => o.tipo).join(', ') || '(nenhuma)'}`);
  if (rejeitadas.length) {
    console.log('observações REJEITADAS:');
    for (const rj of rejeitadas) console.log(`   ${rj.obs?.tipo || '?'} → ${rj.motivo}`);
  }

  // O veredito do gate, com a MESMA funcao da producao.
  const copia = { ...dados };
  const { casoDescrito } = bot.sanitizarClassificacao(copia, validas);
  console.log(`gate do caso descrito      : ${casoDescrito ? 'PASSOU' : 'NÃO passou'}`);
  console.log(`assunto DEPOIS do saneamento: ${JSON.stringify(copia.assunto)}`);
  console.log(`área DEPOIS do saneamento   : ${JSON.stringify(copia.area_direito)}`);

  // O diagnostico em uma linha.
  const neutroCru = !dados.assunto || bot.ehAssuntoNeutro(dados.assunto);
  if (negativo) {
    const ok = neutroCru && !copia.area_direito;
    console.log(ok
      ? '\n✅ CONTROLE NEGATIVO OK: placeholder mantido e área vazia — nada foi inventado.'
      : `\n🚨 REGRESSÃO: sem caso descrito, mas veio assunto ${JSON.stringify(dados.assunto)} / área ${JSON.stringify(copia.area_direito)}. É o defeito do deal 48423360 — reverter a mudança de prompt.`);
    return;
  }
  if (neutroCru) {
    console.log('\n🔎 CAUSA: o MODELO já devolveu o assunto neutro/vazio — o saneamento não teve culpa.');
  } else if (!casoDescrito) {
    console.log('\n🔎 CAUSA: o modelo devolveu assunto REAL, mas o gate anulou por falta de evidência válida.');
  } else if (bot.ehAssuntoNeutro(copia.assunto)) {
    console.log('\n🔎 CAUSA: assunto real virou neutro no saneamento com o gate PASSANDO (rejeitarAssuntoQueEhArea).');
  } else {
    console.log('\n✅ sem problema: assunto real sobreviveu.');
  }
}

(async () => {
  const arg = (process.argv.find((a) => a.startsWith('--deal=')) || '').split('=')[1];
  if (arg) {
    const Database = require('better-sqlite3');
    const caminho = process.env.CONVERSATIONS_DB || 'conversations.db';
    const dbc = new Database(caminho, { readonly: true });
    const row = dbc.prepare('SELECT contact_name, messages FROM conversations WHERE deal_id = ?').get(arg);
    dbc.close();
    if (!row) { console.error(`deal ${arg} não encontrado em ${caminho}`); process.exit(1); }
    const msgs = JSON.parse(row.messages || '[]');
    await diagnosticar(`deal ${arg} (${row.contact_name})`, 'conversa real de produção', msgs.map((m) => [m.role, m.text, 0]));
    return;
  }
  for (const c of CASOS) await diagnosticar(c.nome, c.observado, c.msgs, !!c.negativo);
})();
