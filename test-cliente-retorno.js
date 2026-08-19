// Testes PUROS da decisao do segundo atendimento (cliente que ja foi atendido e voltou). Rodar com:
//   node test-cliente-retorno.js
//
// Nao chamam OpenAI, Moskit, Google nem banco. O que esta em jogo aqui e caro nos dois sentidos:
// deixar de reconhecer o retorno mantem o caso novo dentro do negocio antigo (e reabre um GANHO no
// primeiro PUT), e reconhecer um retorno que nao existe cria um SEGUNDO negocio para o mesmo caso,
// duplicando o cliente no funil. Por isso metade das assercoes abaixo e sobre NAO decidir.
//
// Os horarios seguem a convencao do pipeline: `evento_calendar_data` e NAIVE (hora do escritorio), e
// tudo o mais e instante absoluto. A suite roda com TZ=UTC (rodar-testes.js), entao qualquer confusao
// entre os dois aparece aqui como 3 horas de diferenca.

const {
  consultaJaRealizada,
  decidirRetorno,
  evidenciaDeCasoNovo,
  primeiraMensagemApos,
  chaveArea,
  assuntoEspecifico,
  descreverMotivo,
  paraInstante,
} = require('./src/cliente-retorno');

const TZ = 'America/Fortaleza';

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

// ------------------------------------------------------------
console.log('\n=== A consulta ja aconteceu? ===');

{
  const r = consultaJaRealizada({ agora: '2026-08-19T12:00:00Z', timeZone: TZ });
  igual('sem consulta registrada: nao e retorno', r.realizada, false);
  igual('sem consulta registrada: motivo nomeado', r.motivo, 'sem_consulta_registrada');
}

{
  // Naive do escritorio: 15:30 em Fortaleza (UTC-3) e 18:30Z. Rodando em UTC, ler a string com
  // `new Date()` cru daria 15:30Z — tres horas mais cedo, e a fronteira do atendimento sairia errada.
  const r = consultaJaRealizada({
    eventoCalendarData: '2026-08-18T15:30:00',
    agora: '2026-08-19T12:00:00Z',
    timeZone: TZ,
  });
  igual('consulta de ontem: realizada', r.realizada, true);
  igual('consulta de ontem: fonte', r.fonte, 'evento_calendar');
  igual('naive do escritorio virou o instante certo (UTC-3)', r.quando, '2026-08-18T18:30:00.000Z');
  // 18:30Z + 1h de consulta + 2h de folga.
  igual('fim com folga = inicio + duracao + folga', r.fimComFolga, '2026-08-18T21:30:00.000Z');
}

{
  const futura = consultaJaRealizada({
    eventoCalendarData: '2026-08-25T09:00:00',
    agora: '2026-08-19T12:00:00Z',
    timeZone: TZ,
  });
  igual('consulta futura nao e retorno', futura.realizada, false);
  igual('consulta futura: motivo nomeado', futura.motivo, 'consulta_ainda_nao_aconteceu');
}

{
  // A folga existe porque mensagem trocada DURANTE a consulta (ou logo depois) e o mesmo atendimento.
  const base = { eventoCalendarData: '2026-08-19T09:00:00', timeZone: TZ }; // 12:00Z
  igual('30 min depois do inicio: ainda no atendimento', consultaJaRealizada({ ...base, agora: '2026-08-19T12:30:00Z' }).realizada, false);
  igual('2h depois do inicio (dentro da folga): ainda no atendimento', consultaJaRealizada({ ...base, agora: '2026-08-19T14:00:00Z' }).realizada, false);
  igual('3h01 depois do inicio: atendimento encerrado', consultaJaRealizada({ ...base, agora: '2026-08-19T15:01:00Z' }).realizada, true);
  igual('folga configuravel: com 12h ainda esta no atendimento', consultaJaRealizada({ ...base, agora: '2026-08-19T15:01:00Z', folgaHoras: 12 }).realizada, false);
}

{
  // Nota do Gemini: prova que a reuniao ocorreu e cobre a consulta marcada direto no CRM, que nunca
  // passou por evento_calendar_data. Quando as duas fontes existem vale a MAIS RECENTE — e ela que diz
  // onde o atendimento anterior de fato terminou.
  const r = consultaJaRealizada({
    eventoCalendarData: '2026-08-10T15:30:00',
    notaReuniaoEm: '2026-08-17T23:59:59',
    agora: '2026-08-19T12:00:00Z',
    timeZone: TZ,
  });
  igual('duas fontes: vale a mais recente', r.fonte, 'nota_reuniao');
  igual('duas fontes: instante da mais recente', r.quando, '2026-08-18T02:59:59.000Z');

  const soEvento = consultaJaRealizada({
    eventoCalendarData: '2026-08-17T15:30:00',
    notaReuniaoEm: '2026-08-10T23:59:59',
    agora: '2026-08-19T12:00:00Z',
    timeZone: TZ,
  });
  igual('duas fontes, evento mais recente: vale o evento', soEvento.fonte, 'evento_calendar');
}

{
  igual('instante com Z passa direto', paraInstante('2026-08-18T18:30:00Z', TZ), '2026-08-18T18:30:00.000Z');
  igual('lixo nao vira data', paraInstante('amanha as 15h', TZ), null);
  igual('vazio nao vira data', paraInstante('', TZ), null);
}

// ------------------------------------------------------------
console.log('\n=== Evidencia de caso novo (so depois da consulta) ===');

// Consulta em 18/08 15:30 do escritorio => termina com folga em 21:30Z do dia 18.
const CONSULTA = consultaJaRealizada({
  eventoCalendarData: '2026-08-18T15:30:00',
  agora: '2026-08-19T14:00:00Z',
  timeZone: TZ,
});

const MENSAGENS = [
  { role: 'cliente', text: 'oi, quero falar do meu FIES', timestamp: '2026-08-17T13:00:00Z' },   // 0 — atendimento antigo
  { role: 'equipe', text: 'podemos as 15h30 amanha?', timestamp: '2026-08-17T13:10:00Z' },       // 1
  { role: 'cliente', text: 'obrigado pela consulta!', timestamp: '2026-08-18T19:00:00Z' },       // 2 — durante/apos, dentro da folga
  { role: 'cliente', text: 'doutor, recebi uma notificacao de despejo', timestamp: '2026-08-19T13:00:00Z' }, // 3 — caso novo
  { role: 'equipe', text: 'entendi, vamos ver isso', timestamp: '2026-08-19T13:30:00Z' },        // 4
];

const obs = (tipo, msg_idx) => ({ tipo, msg_idx, trecho: MENSAGENS[msg_idx].text });

{
  igual('primeira mensagem apos a consulta e o corte', primeiraMensagemApos(MENSAGENS, CONSULTA.fimComFolga), 3);
  checar('nada apos a consulta: sem corte', primeiraMensagemApos(MENSAGENS.slice(0, 3), CONSULTA.fimComFolga) === null);

  const dentroDaJanela = evidenciaDeCasoNovo([obs('cliente_descreveu_caso', 3)], MENSAGENS, CONSULTA.fimComFolga);
  igual('caso descrito depois da consulta conta', dentroDaJanela?.msg_idx, 3);

  const antes = evidenciaDeCasoNovo([obs('cliente_descreveu_caso', 0)], MENSAGENS, CONSULTA.fimComFolga);
  checar('caso descrito ANTES da consulta nao conta', antes === null, antes);

  const outroTipo = evidenciaDeCasoNovo([obs('cliente_aceitou_horario', 3)], MENSAGENS, CONSULTA.fimComFolga);
  checar('observacao de horario nao e evidencia de caso novo', outroTipo === null, outroTipo);

  // Mensagem sem timestamp nao pode ser datada — e sem data nao ha como afirmar "depois da consulta".
  // Melhor perder um retorno do que abrir negocio novo por um indice solto.
  const semData = evidenciaDeCasoNovo(
    [{ tipo: 'cliente_descreveu_caso', msg_idx: 0 }],
    [{ role: 'cliente', text: 'sem data' }],
    CONSULTA.fimComFolga
  );
  checar('mensagem sem timestamp nao serve de evidencia', semData === null, semData);
}

// ------------------------------------------------------------
console.log('\n=== O veredito ===');

const ANTIGO = { assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional', nome: 'Lia' };

{
  const r = decidirRetorno({
    consulta: consultaJaRealizada({ eventoCalendarData: '2026-08-25T09:00:00', agora: '2026-08-19T14:00:00Z', timeZone: TZ }),
    mensagens: MENSAGENS,
    obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: ANTIGO,
    dados: { assunto: 'Despejo', area_direito: 'Direito Imobiliario' },
  });
  igual('consulta ainda nao aconteceu: mesmo negocio', r.decisao, 'mesmo_negocio');
  igual('consulta ainda nao aconteceu: motivo do proprio consulta', r.motivo, 'consulta_ainda_nao_aconteceu');
}

{
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [],
    dadosAnteriores: ANTIGO, dados: { assunto: 'Despejo', area_direito: 'Direito Imobiliario' },
  });
  igual('sem observacao validada: mesmo negocio', r.decisao, 'mesmo_negocio');
  igual('sem observacao validada: motivo', r.motivo, 'sem_caso_novo_apos_consulta');
  checar('mesmo negocio nao propoe corte', r.corteMsgIdx === null, r.corteMsgIdx);
}

{
  // O caso que a funcionalidade existe para pegar: consulta feita, caso novo contado depois, tema
  // diferente. O corte NAO e a mensagem da evidencia — e a primeira mensagem apos a consulta, senao a
  // conversa do atendimento novo comecaria pela metade.
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: ANTIGO, dados: { assunto: 'Notificação de despejo', area_direito: 'Direito Imobiliario' },
  });
  igual('caso novo com assunto e area diferentes: atendimento novo', r.decisao, 'novo_atendimento');
  igual('motivo prioriza a area, que e o sinal mais forte', r.motivo, 'area_diferente');
  igual('corte na primeira mensagem apos a consulta', r.corteMsgIdx, 3);
  igual('evidencia registrada', r.evidencia?.msg_idx, 3);
  igual('assunto anterior preservado para a nota', r.assuntoAnterior, 'Abatimento do FIES');
}

{
  // MESMO assunto e mesma area: indistinguivel de "cliente completando o caso de sempre", que e o que
  // acontece na maioria das conversas depois de uma consulta. Ambiguo NAO abre negocio.
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: ANTIGO, dados: { assunto: 'abatimento do fies!', area_direito: 'Direito Educacional' },
  });
  igual('mesmo assunto (caixa/pontuacao diferentes) e ambiguo', r.decisao, 'ambiguo');
  igual('ambiguo: motivo nomeado', r.motivo, 'mesmo_assunto_e_area');
  checar('ambiguo ainda diz onde seria o corte, para o aviso', r.corteMsgIdx === 3, r.corteMsgIdx);
}

{
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: ANTIGO, dados: { assunto: 'Consulta jurídica', area_direito: 'Direito Educacional' },
  });
  igual('assunto neutro nao afirma caso novo', r.decisao, 'ambiguo');
  igual('assunto neutro: motivo proprio', r.motivo, 'assunto_novo_indefinido');
}

{
  // Apelido de area: "Direito Digital" e LGPD sao a MESMA opcao do CRM (src/moskit-ids.js). Comparar
  // como texto diria "area diferente" e abriria um segundo negocio para o mesmo caso.
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: { assunto: 'Vazamento de dados', area_direito: 'Direito Digital' },
    dados: { assunto: 'vazamento de dados', area_direito: 'LGPD' },
  });
  igual('apelido de area nao conta como area diferente', r.decisao, 'ambiguo');
  igual('chaveArea resolve o apelido', chaveArea('Direito Digital'), chaveArea('LGPD'));
  checar('area desconhecida cai no texto normalizado', chaveArea('Direito Espacial') === 'txt:direito espacial', chaveArea('Direito Espacial'));
}

{
  // Assunto igual mas area diferente ainda e caso novo: o cliente pode descrever o problema com as
  // mesmas palavras ("cobranca indevida") em duas frentes juridicas distintas.
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('equipe_descreveu_caso', 4)],
    dadosAnteriores: ANTIGO, dados: { assunto: 'Abatimento do FIES', area_direito: 'Direito do Consumidor' },
  });
  igual('area diferente com assunto igual: atendimento novo', r.decisao, 'novo_atendimento');
  igual('evidencia pode vir da equipe', r.evidencia?.tipo, 'equipe_descreveu_caso');
}

{
  // Primeiro atendimento sem area registrada: nao ha o que comparar do lado antigo, e area nova
  // sozinha nao afirma nada. Sobra o assunto — que aqui e diferente, entao abre.
  const r = decidirRetorno({
    consulta: CONSULTA, mensagens: MENSAGENS, obsValidas: [obs('cliente_descreveu_caso', 3)],
    dadosAnteriores: { assunto: 'Consulta jurídica', area_direito: null },
    dados: { assunto: 'Despejo', area_direito: 'Direito Imobiliario' },
  });
  igual('sem area anterior, o assunto decide', r.decisao, 'novo_atendimento');
  igual('sem area anterior: motivo pelo assunto', r.motivo, 'assunto_diferente');
}

{
  igual('assunto neutro nao e assunto especifico', assuntoEspecifico('Consulta jurídica'), null);
  igual('assunto vazio nao e assunto especifico', assuntoEspecifico(null), null);
  checar('motivo sem traducao volta cru', descreverMotivo('motivo_inventado') === 'motivo_inventado');
  checar('motivo conhecido vira frase', descreverMotivo('area_diferente').includes('área do direito'), descreverMotivo('area_diferente'));
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
