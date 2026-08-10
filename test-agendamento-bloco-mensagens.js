// Testes PUROS das funcoes auxiliares de src/agendamento.js, src/bloco-condicoes.js e
// src/mensagens.js que so eram exercitadas INDIRETAMENTE por test-evidencia.js/test-dupla-
// confirmacao.js (via apurarDuplaConfirmacao/detectarBlocoCondicoes/normalizarMensagens).
// Sem rede, sem banco, sem OpenAI. Rodar com:
//   node test-agendamento-bloco-mensagens.js

const {
  mesmoInstante,
  horarioTemHoraDefinida,
  descreverPendencia,
  TOLERANCIA_MS,
} = require('./src/agendamento');

const {
  normalizarSuave,
  contarMarcadores,
  MIN_MARCADORES_ESTRUTURA,
} = require('./src/bloco-condicoes');

const {
  ordenarPorTempo,
  chaveMensagem,
  deduplicavelPorConteudo,
  MIN_CHARS_DEDUP_CONTEUDO,
} = require('./src/mensagens');

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

const igual = (nome, obtido, esperado) => {
  const passa = JSON.stringify(obtido) === JSON.stringify(esperado);
  checar(nome, passa, passa ? undefined : { obtido, esperado });
};

// ============================================================
console.log('\n=== mesmoInstante ===');

igual('mesmo ISO exato', mesmoInstante('2026-08-10T14:00:00', '2026-08-10T14:00:00'), true);
igual(`dentro da tolerancia (${TOLERANCIA_MS}ms)`, mesmoInstante('2026-08-10T14:00:00', '2026-08-10T14:00:30'), true);
igual('fora da tolerancia (2 min de diferenca)', mesmoInstante('2026-08-10T14:00:00', '2026-08-10T14:02:00'), false);
igual('dias diferentes', mesmoInstante('2026-08-10T14:00:00', '2026-08-11T14:00:00'), false);
igual('isoA null', mesmoInstante(null, '2026-08-10T14:00:00'), false);
igual('isoB null', mesmoInstante('2026-08-10T14:00:00', null), false);
igual('ambos null', mesmoInstante(null, null), false);
igual('isoA invalido', mesmoInstante('nao-e-data', '2026-08-10T14:00:00'), false);

// ============================================================
console.log('\n=== horarioTemHoraDefinida ===');

igual('horario com hora definida (14h)', horarioTemHoraDefinida('2026-08-10T14:00:00'), true);
igual('meia-noite exata e recusada (so o DIA foi resolvido)', horarioTemHoraDefinida('2026-08-10T00:00:00'), false);
igual('00:01 ja conta como horario definido', horarioTemHoraDefinida('2026-08-10T00:01:00'), true);
igual('null', horarioTemHoraDefinida(null), false);
igual('string vazia', horarioTemHoraDefinida(''), false);
igual('data invalida', horarioTemHoraDefinida('nao-e-data'), false);

// ============================================================
console.log('\n=== descreverPendencia ===');

igual('falta_ambos', descreverPendencia({ motivo: 'falta_ambos' }), 'nem o cliente nem a equipe confirmaram o horário');
igual('falta_cliente', descreverPendencia({ motivo: 'falta_cliente' }), 'falta a confirmação DO CLIENTE (a equipe já confirmou)');
igual('falta_equipe', descreverPendencia({ motivo: 'falta_equipe' }), 'falta a confirmação DA EQUIPE (o cliente já aceitou)');
igual('horarios_divergentes', descreverPendencia({ motivo: 'horarios_divergentes' }), 'cliente e equipe confirmaram horários diferentes');
igual('renegociado', descreverPendencia({ motivo: 'renegociado' }), 'um novo horário foi proposto depois das confirmações — a negociação reabriu');
igual('motivo desconhecido cai no default', descreverPendencia({ motivo: 'algo-novo' }), 'confirmações incompletas');

// ============================================================
console.log('\n=== normalizarSuave (src/bloco-condicoes.js) ===');

igual('acento e removido, ponto e virgula preservados', normalizarSuave('É R$350,00 à vista'), 'e r$350,00 a vista');
igual('maiuscula vira minuscula', normalizarSuave('PROPOSTA DE HONORÁRIOS'), 'proposta de honorarios');
igual('espacos multiplos colapsam em 1', normalizarSuave('a    b\n\nc'), 'a b c');
igual('trim nas pontas', normalizarSuave('   texto   '), 'texto');
igual('null vira string vazia', normalizarSuave(null), '');
igual('undefined vira string vazia', normalizarSuave(undefined), '');

// ============================================================
console.log('\n=== contarMarcadores (src/bloco-condicoes.js) ===');

{
  const bloco = `O valor da consulta é de R$350,00 (pix, transferência ou cartão de crédito com acréscimos);
Nesse valor está incluso o retorno, se necessário;
o valor da consulta é abatido integralmente no valor dos honorários advocatícios;
duração média de 01 hora;
Podemos verificar a disponibilidade de dias e horários.`;
  const m = contarMarcadores(bloco);
  checar('bloco completo bate pelo menos 1 marcador de valor', m.valor >= 1, m);
  checar(`bloco completo bate >= ${MIN_MARCADORES_ESTRUTURA} marcadores de estrutura`, m.estrutura >= MIN_MARCADORES_ESTRUTURA, m);
}
{
  const m = contarMarcadores('Bom dia! Tudo bem?');
  igual('mensagem sem relacao com o bloco: 0 marcadores de valor', m.valor, 0);
  igual('mensagem sem relacao com o bloco: 0 marcadores de estrutura', m.estrutura, 0);
}
{
  const m = contarMarcadores('trezentos e cinquenta reais é o valor');
  checar('marcador de valor por extenso tambem conta', m.valor >= 1, m);
}
igual('texto vazio nao quebra', JSON.stringify(contarMarcadores('')), JSON.stringify({ valor: 0, estrutura: 0 }));

// ============================================================
console.log('\n=== ordenarPorTempo (src/mensagens.js) ===');

{
  const msgs = [
    { text: 'terceira', timestamp: '2026-08-10T14:00:00' },
    { text: 'primeira', timestamp: '2026-08-10T10:00:00' },
    { text: 'segunda', timestamp: '2026-08-10T12:00:00' },
  ];
  const ordenado = ordenarPorTempo(msgs).map((m) => m.text);
  igual('ordena cronologicamente', ordenado, ['primeira', 'segunda', 'terceira']);
}
{
  // Campo AUSENTE (nao null): new Date(null) vira epoch 1970, um instante valido — so a AUSENCIA
  // do campo produz Invalid Date (isNaN) e cai no ramo "vai pro fim" do comparador.
  const msgs = [
    { text: 'com timestamp', timestamp: '2026-08-10T10:00:00' },
    { text: 'sem timestamp' }, // campo timestamp AUSENTE, nao null
  ];
  const ordenado = ordenarPorTempo(msgs).map((m) => m.text);
  igual('mensagem sem campo timestamp vai pro fim, nao embaralha o resto', ordenado, ['com timestamp', 'sem timestamp']);
}
{
  // Contraprova documentada: timestamp EXPLICITAMENTE null nao cai no ramo "sem timestamp" — vira
  // epoch (1970) e o item vai pro INICIO, nao pro fim. Comportamento real do modulo, nao um bug
  // deste teste; registrado aqui pra nao ser "corrigido" sem querer no futuro.
  const msgs = [
    { text: 'com timestamp', timestamp: '2026-08-10T10:00:00' },
    { text: 'timestamp null', timestamp: null },
  ];
  const ordenado = ordenarPorTempo(msgs).map((m) => m.text);
  igual('CARACTERIZACAO: timestamp null vira epoch (1970) e vai pro INICIO, nao pro fim', ordenado, ['timestamp null', 'com timestamp']);
}
igual('array vazio', ordenarPorTempo([]), []);
igual('undefined nao quebra', ordenarPorTempo(undefined), []);
{
  const original = [{ text: 'a', timestamp: '2026-08-10T10:00:00' }];
  ordenarPorTempo(original);
  igual('nao muta o array original (retorna copia)', Array.isArray(original) && original.length === 1, true);
}

// ============================================================
console.log('\n=== chaveMensagem (src/mensagens.js) ===');

igual('com id_zernio, usa a chave forte', chaveMensagem({ id_zernio: 'abc123', role: 'cliente', text: 'oi', timestamp: '2026-08-10T10:00:00' }), 'z:abc123');
igual('sem id_zernio, cai na chave de conteudo', chaveMensagem({ role: 'cliente', text: 'oi', timestamp: '2026-08-10T10:00:00' }), 'c:cliente|oi|2026-08-10T10:00');
{
  const a = chaveMensagem({ role: 'cliente', text: 'mesma msg', timestamp: '2026-08-10T10:00:30' });
  const b = chaveMensagem({ role: 'cliente', text: 'mesma msg', timestamp: '2026-08-10T10:00:59' });
  igual('chave de conteudo tem precisao de minuto (absorve diferenca de segundos)', a, b);
}
igual('mensagem vazia nao quebra', chaveMensagem({}), 'c:undefined||');

// ============================================================
console.log('\n=== deduplicavelPorConteudo (src/mensagens.js) ===');

igual(`texto com exatamente ${MIN_CHARS_DEDUP_CONTEUDO} caracteres e dedupável`, deduplicavelPorConteudo({ text: 'x'.repeat(MIN_CHARS_DEDUP_CONTEUDO) }), true);
igual('texto curto ("ok") nunca e fundido por conteudo', deduplicavelPorConteudo({ text: 'ok' }), false);
igual('anexo (com emoji de clipe) nunca e fundido, mesmo sendo longo', deduplicavelPorConteudo({ text: '📎 ' + 'x'.repeat(40) }), false);
igual('mensagem sem text nao quebra', deduplicavelPorConteudo({}), false);
igual('mensagem undefined nao quebra', deduplicavelPorConteudo(undefined), false);

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
