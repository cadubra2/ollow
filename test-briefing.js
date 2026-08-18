// Testes PUROS do modulo de briefing pre-consulta (src/briefing.js). Nao chamam OpenAI, Moskit nem
// Google. Rodar com:
//   node test-briefing.js
//
// O que se verifica: o CABECALHO e deterministico (montado em codigo a partir dos dados validados,
// nao da prosa da IA), linhas sem informacao sao omitidas, o telefone e normalizado, e o hash de
// dedup ignora espaco/quebra de linha mas reage a mudanca real — inclusive de campo do cabecalho
// (remarcacao de horario tem que repostar a nota mesmo com a narrativa igual).

const {
  MARCADOR_BRIEFING,
  montarTextoBriefing,
  montarCabecalho,
  hashTextoBriefing,
  limparTelefone,
} = require('./src/briefing');

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

const NARRATIVA = '📌 Caso: servidora exonerada quer remoção por motivo de saúde.\n📌 Objetivo do cliente: voltar ao cargo.';

console.log('\n=== montarTextoBriefing: cabeçalho determinístico ===');

{
  const texto = montarTextoBriefing({
    dados: {
      nome: 'Maria',
      area_direito: 'Direito Administrativo',
      advogado_responsavel: 'Berto',
      modalidade_consulta: 'online',
      valor_honorarios_inicial: 'R$ 350',
      resumo_atendimento: NARRATIVA,
    },
    contato: null,
    telefone: '+55 (86) 98765-4321',
    horarioConsulta: '17/08/2026, 15:30',
  });
  const linhas = texto.split('\n');
  checar('  cliente no topo', linhas[0] === 'Cliente: Maria', linhas[0]);
  checar('  telefone normalizado', linhas[1] === 'Telefone: 5586987654321', linhas[1]);
  checar('  area', linhas[2] === 'Área: Direito Administrativo', linhas[2]);
  checar('  advogado', linhas[3] === 'Advogado: Berto', linhas[3]);
  checar('  modalidade', linhas[4] === 'Modalidade: online', linhas[4]);
  checar('  horario da consulta', linhas[5] === 'Consulta: 17/08/2026, 15:30', linhas[5]);
  checar('  valor', linhas[6] === 'Valor: R$ 350', linhas[6]);
  checar('  narrativa em seguida', texto.includes(`\n\n${NARRATIVA}`), texto);
  checar('  narrativa intacta', texto.includes('remoção por motivo de saúde'), texto);
}

{
  // Contato do WhatsApp tem precedencia sobre dados.nome; linhas sem valor somem.
  const texto = montarTextoBriefing({
    dados: { nome: 'Maria', resumo_atendimento: NARRATIVA },
    contato: 'WhatsApp Name',
    telefone: '5586',
    horarioConsulta: null,
  });
  checar('  contato tem precedencia', texto.startsWith('Cliente: WhatsApp Name'), texto.split('\n')[0]);
  checar('  telefone curto (< 8 digitos) omitido', !texto.includes('Telefone:'), texto);
  checar('  area ausente omitida', !texto.includes('Área:'), texto);
  checar('  horario ausente omitido', !texto.includes('Consulta:'), texto);
  checar('  valor ausente omitido', !texto.includes('Valor:'), texto);
}

{
  // Sem nenhum campo de cabecalho, so a narrativa — vira uma nota so de prosa.
  const texto = montarTextoBriefing({ dados: { resumo_atendimento: NARRATIVA }, telefone: null });
  checar('  so narrativa', texto === NARRATIVA, texto);
  checar('  dados vazio → string vazia', montarTextoBriefing({ dados: null }) === '', montarTextoBriefing({ dados: null }));
}

console.log('\n=== montarCabecalho ===');

{
  const c = montarCabecalho({ dados: { nome: 'A' }, telefone: '558681876734' });
  checar('  cabeçalho com dois campos', c === 'Cliente: A\nTelefone: 558681876734', c);
  checar('  cabeçalho vazio sem dados', montarCabecalho({ dados: null, telefone: null }) === '', montarCabecalho({ dados: null, telefone: null }));
}

console.log('\n=== hashTextoBriefing: dedup ===');

{
  const a = hashTextoBriefing(NARRATIVA);
  const b = hashTextoBriefing(`  ${NARRATIVA}\n\n `);
  checar('  espaco/quebra de linha nao muda o hash', a === b, b);
  checar('  narrativa diferente muda o hash', a !== hashTextoBriefing('📌 Caso: outro caso.'), true);
  // Mudanca so de campo do CABECALHO tem que mudar o hash: remarcacao reposta a nota mesmo com a
  // narrativa igual.
  const comHorarioA = montarTextoBriefing({ dados: { resumo_atendimento: NARRATIVA }, horarioConsulta: '16/08/2026, 15:30' });
  const comHorarioB = montarTextoBriefing({ dados: { resumo_atendimento: NARRATIVA }, horarioConsulta: '17/08/2026, 10:00' });
  checar('  mudanca de horario muda o hash', hashTextoBriefing(comHorarioA) !== hashTextoBriefing(comHorarioB), true);
}

console.log('\n=== limparTelefone ===');

{
  checar('  so digitos', limparTelefone('+55 (86) 98765-4321'), '5586987654321');
  checar('  menos de 8 digitos → null', limparTelefone('5586') === null, limparTelefone('5586'));
  checar('  vazio → null', limparTelefone('') === null, limparTelefone(''));
}

console.log('\n=== MARCADOR_BRIEFING ===');

{
  checar('  marcador definido', typeof MARCADOR_BRIEFING === 'string' && MARCADOR_BRIEFING.length > 0, MARCADOR_BRIEFING);
}

console.log(`\n${falhou === 0 ? '✅' : '❌'} test-briefing: ${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou === 0 ? 0 : 1);