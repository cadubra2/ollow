// Testes PUROS da decisao "esta reuniao e remarcacao ou uma reuniao nova (retorno)?". Rodar com:
//   node test-reuniao-retorno.js
//
// Nao chamam OpenAI, Moskit, Google nem banco. O que esta em jogo: classificar uma remarcacao comum
// como retorno abriria um segundo compromisso sem necessidade; classificar um retorno de verdade como
// remarcacao apagaria o registro da reuniao anterior (PATCH no evento que ja aconteceu) e a reuniao
// nova nunca entraria na agenda do Moskit.
//
// A suite roda com TZ=UTC (rodar-testes.js) — os horarios usados aqui seguem a mesma convencao do
// pipeline: `consulta.fimComFolga`/`confirmadoEm` sao instante absoluto, e `horarioNovoIso` e NAIVE do
// escritorio, exatamente como apuracao.horarioIso chega de src/agendamento.js.

const { consultaJaRealizada } = require('./src/cliente-retorno');
const {
  classificarReuniao,
  numeroDaReuniao,
  rotuloCompromisso,
  descreverMotivo,
  TOLERANCIA_HORAS_PADRAO,
} = require('./src/reuniao-retorno');

const TZ = 'America/Fortaleza';

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

// ------------------------------------------------------------
console.log('\n=== Consulta anterior ainda nao aconteceu / nao existe ===');

{
  const r = classificarReuniao({ consulta: { realizada: false, motivo: 'consulta_ainda_nao_aconteceu' }, horarioNovoIso: '2026-08-20T15:00:00', timeZone: TZ });
  igual('reuniao ainda nao aconteceu: nao e retorno', r.retorno, false);
  igual('motivo herdado da propria consulta', r.motivo, 'consulta_ainda_nao_aconteceu');
}

{
  const r = classificarReuniao({ consulta: null, horarioNovoIso: '2026-08-20T15:00:00', timeZone: TZ });
  igual('sem consulta nenhuma: nao e retorno', r.retorno, false);
  igual('motivo default', r.motivo, 'sem_consulta_registrada');
}

// ------------------------------------------------------------
console.log('\n=== A tolerancia de 24h (no-show) ===');

// Consulta em 18/08 15:30 do escritorio (UTC-3) => inicio 18:30Z, fim com folga (1h consulta + 2h
// folga padrao de cliente-retorno) em 21:30Z do dia 18.
const CONSULTA = consultaJaRealizada({ eventoCalendarData: '2026-08-18T15:30:00', agora: '2026-08-25T12:00:00Z', timeZone: TZ });
igual('sanity: a consulta de referencia esta realizada', CONSULTA.realizada, true);
igual('sanity: fim com folga e 18/08 21:30Z', CONSULTA.fimComFolga, '2026-08-18T21:30:00.000Z');

{
  // Cliente furou o horario e a equipe remarca pra amanha mesmo (19/08), confirmado ainda no mesmo
  // dia — bem dentro das 24h de tolerancia.
  const r = classificarReuniao({
    consulta: CONSULTA, horarioNovoIso: '2026-08-19T10:00:00', timeZone: TZ,
    confirmadoEm: '2026-08-18T22:00:00Z',
  });
  igual('confirmado horas depois: continua sendo a mesma reuniao (remarcacao)', r.retorno, false);
  igual('motivo: dentro da tolerancia', r.motivo, 'dentro_da_tolerancia_de_remarcacao');
}

{
  // Confirmado exatamente no limite das 24h (21:30Z do dia 19) ainda conta como remarcacao — o corte
  // e "apos", nao "a partir de".
  const r = classificarReuniao({
    consulta: CONSULTA, horarioNovoIso: '2026-08-20T10:00:00', timeZone: TZ,
    confirmadoEm: '2026-08-19T21:30:00.000Z',
  });
  igual('confirmado exatamente no limite: ainda remarcacao', r.retorno, false);
}

{
  // Confirmado um minuto depois do limite: vira retorno.
  const r = classificarReuniao({
    consulta: CONSULTA, horarioNovoIso: '2026-08-20T10:00:00', timeZone: TZ,
    confirmadoEm: '2026-08-19T21:31:00.000Z',
  });
  igual('confirmado 1min depois do limite: reuniao nova', r.retorno, true);
  igual('motivo: apos a tolerancia', r.motivo, 'confirmado_apos_tolerancia');
}

{
  // Uma semana depois: claramente uma reuniao de acompanhamento, nao um no-show.
  const r = classificarReuniao({
    consulta: CONSULTA, horarioNovoIso: '2026-08-27T14:00:00', timeZone: TZ,
    confirmadoEm: '2026-08-26T13:00:00Z',
  });
  igual('confirmado dias depois: reuniao nova', r.retorno, true);
}

{
  // Janela configuravel: com tolerancia de 72h, a mesma confirmacao de ~26h ainda conta como
  // remarcacao.
  const r = classificarReuniao({
    consulta: CONSULTA, horarioNovoIso: '2026-08-20T10:00:00', timeZone: TZ,
    confirmadoEm: '2026-08-19T23:00:00.000Z',
    toleranciaHoras: 72,
  });
  igual('tolerancia configuravel: 72h ainda e remarcacao', r.retorno, false);
  igual('tolerancia padrao exportada', TOLERANCIA_HORAS_PADRAO, 24);
}

// ------------------------------------------------------------
console.log('\n=== confirmadoEm vem do timestamp da MENSAGEM, nao do relogio ===');

{
  // O MESMO cenario, reprocessado bem mais tarde (fila, refresh de briefing) — o veredito nao pode
  // mudar so porque o relogio avancou. confirmadoEm fixo garante isso.
  const opts = { consulta: CONSULTA, horarioNovoIso: '2026-08-19T10:00:00', timeZone: TZ, confirmadoEm: '2026-08-18T22:00:00Z' };
  const primeira = classificarReuniao(opts);
  const reprocessada = classificarReuniao(opts); // mesmos argumentos, "reprocessado" mais tarde
  igual('mesmo confirmadoEm: mesmo veredito na primeira vez', primeira.retorno, false);
  igual('mesmo confirmadoEm: mesmo veredito reprocessado depois', reprocessada.retorno, primeira.retorno);
}

{
  // Mensagem sem timestamp: cai para "agora" (fallback documentado), nunca lanca.
  const r = classificarReuniao({ consulta: CONSULTA, horarioNovoIso: '2026-08-27T10:00:00', timeZone: TZ, confirmadoEm: undefined });
  checar('sem confirmadoEm nao lanca e classifica', r.retorno === true || r.retorno === false, r);
}

// ------------------------------------------------------------
console.log('\n=== Horario novo dentro da janela da reuniao anterior ===');

{
  // Reconfirmar o MESMO horario que ja esta marcado (sem mudanca real) nao e reuniao nova em hipotese
  // nenhuma — cai antes mesmo de considerar a tolerancia.
  const r = classificarReuniao({ consulta: CONSULTA, horarioNovoIso: '2026-08-18T15:30:00', timeZone: TZ, confirmadoEm: '2026-08-30T12:00:00Z' });
  igual('mesmo horario de sempre: nunca e retorno', r.retorno, false);
  igual('motivo: dentro da janela anterior', r.motivo, 'horario_dentro_da_janela_anterior');
}

{
  const r = classificarReuniao({ consulta: CONSULTA, horarioNovoIso: 'lixo', timeZone: TZ });
  igual('horario novo invalido: nao e retorno', r.retorno, false);
  igual('motivo: horario invalido', r.motivo, 'horario_novo_invalido');
}

// ------------------------------------------------------------
console.log('\n=== numeroDaReuniao: a que reuniao um e-mail do Gemini se refere ===');

{
  const REUNIOES = [
    { numero: 1, horarioIso: '2026-08-10T15:30:00' },
    { numero: 2, horarioIso: '2026-08-18T15:30:00' },
  ];
  igual('data bate com a reuniao 1', numeroDaReuniao(REUNIOES, '2026-08-10'), 1);
  igual('data bate com a reuniao 2', numeroDaReuniao(REUNIOES, '2026-08-18'), 2);
  igual('data sem reuniao nenhuma: sem numero', numeroDaReuniao(REUNIOES, '2026-09-01'), null);
  igual('sem data: sem numero', numeroDaReuniao(REUNIOES, null), null);
}

{
  // E-mail da reuniao 1 chega DEPOIS de a reuniao 2 ja estar aberta — nao pode se apoiar no contador
  // atual (que ja seria 2), tem que achar a data certa na lista.
  const REUNIOES = [
    { numero: 1, horarioIso: '2026-08-10T15:30:00' },
    { numero: 2, horarioIso: '2026-08-18T15:30:00' },
  ];
  igual('e-mail atrasado da reuniao 1 nao herda o numero da mais recente', numeroDaReuniao(REUNIOES, '2026-08-10'), 1);
}

{
  // Duas reunioes no mesmo dia: ambiguo de proposito, mesmo "candidato unico ou nada" das notas.
  const REUNIOES = [
    { numero: 1, horarioIso: '2026-08-10T09:00:00' },
    { numero: 2, horarioIso: '2026-08-10T15:30:00' },
  ];
  igual('duas reunioes no mesmo dia: ambiguo, sem numero', numeroDaReuniao(REUNIOES, '2026-08-10'), null);
}

// ------------------------------------------------------------
console.log('\n=== rotuloCompromisso: o vocabulario da agenda ===');

{
  igual('1a reuniao continua "Consulta"', rotuloCompromisso(1), 'Consulta');
  igual('sem numero (undefined) tambem e "Consulta"', rotuloCompromisso(undefined), 'Consulta');
  igual('2a reuniao e "Retorno 1"', rotuloCompromisso(2), 'Retorno 1');
  igual('3a reuniao e "Retorno 2"', rotuloCompromisso(3), 'Retorno 2');
}

{
  checar('motivo sem traducao volta cru', descreverMotivo('motivo_inventado') === 'motivo_inventado');
  checar('motivo conhecido vira frase', descreverMotivo('confirmado_apos_tolerancia').includes('reunião nova'), descreverMotivo('confirmado_apos_tolerancia'));
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
