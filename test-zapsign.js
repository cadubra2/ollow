// Testes de src/zapsign.js — cobre so as funcoes PURAS (montagem de campos, gate de completude,
// extenso, formatacao). Nenhuma chamada de rede: criarDocumentoZapSign (I/O real) fica de fora,
// mesma regra de test-moskit-real.js/test-moskit-put.js (scripts manuais, nunca em CI). Rodar com:
//   node test-zapsign.js

const zapsign = require('./src/zapsign');

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

const igual = (nome, obtido, esperado) => checar(nome, JSON.stringify(obtido) === JSON.stringify(esperado), obtido);

const DADOS_COMPLETOS = {
  nome: 'Carlos Eduardo',
  email_cliente: 'carlos@exemplo.com',
  cpf: '12345678900',
  profissao: 'Comerciante',
  estado_civil: 'Casado',
  endereco: 'Rua Jornalista Dondon, 2347, Teresina - PI',
  area_direito: 'Direito de Familia',
  assunto: 'Inventario',
  valor_honorarios_inicial: 1500,
};

// ============================================================
console.log('\n=== camposContratoFaltantes / contratoCompleto ===');

igual('dados nulos: todos os obrigatorios faltam', zapsign.camposContratoFaltantes(null), zapsign.CAMPOS_CONTRATO_OBRIGATORIOS);
checar('dados nulos: contrato incompleto', !zapsign.contratoCompleto(null));

igual('dados completos: nenhum faltante', zapsign.camposContratoFaltantes(DADOS_COMPLETOS), []);
checar('dados completos: contratoCompleto = true', zapsign.contratoCompleto(DADOS_COMPLETOS));

igual('falta so o cpf', zapsign.camposContratoFaltantes({ ...DADOS_COMPLETOS, cpf: null }), ['cpf']);
igual('falta so o email', zapsign.camposContratoFaltantes({ ...DADOS_COMPLETOS, email_cliente: null }), ['email_cliente']);
igual('string "null" conta como faltante (mesma regra de camposPendentes)', zapsign.camposContratoFaltantes({ ...DADOS_COMPLETOS, endereco: 'null' }), ['endereco']);

// valor_honorarios_liminar e valor_mensalidade NAO sao obrigatorios — nem todo caso tem liminar/mensalidade.
checar('liminar/mensalidade ausentes nao bloqueiam o contrato', zapsign.contratoCompleto(DADOS_COMPLETOS));

// ============================================================
console.log('\n=== montarObjetoContrato ===');

checar(
  'compoe area + assunto',
  zapsign.montarObjetoContrato(DADOS_COMPLETOS).includes('Direito de Família') &&
    zapsign.montarObjetoContrato(DADOS_COMPLETOS).includes('Inventario')
);
checar(
  'area desconhecida cai no generico, sem lancar',
  zapsign.montarObjetoContrato({ area_direito: 'Area Que Nao Existe', assunto: 'X' }).includes('prestação de serviços advocatícios')
);
checar('sem area nem assunto nao lanca', typeof zapsign.montarObjetoContrato({}) === 'string');

// ============================================================
console.log('\n=== valorPorExtenso ===');

igual('1500 -> mil e quinhentos reais', zapsign.valorPorExtenso(1500), 'mil e quinhentos reais');
igual('350.50 -> inclui centavos', zapsign.valorPorExtenso(350.5), 'trezentos e cinquenta reais e cinquenta centavos');
igual('valor invalido -> string vazia', zapsign.valorPorExtenso('abc'), '');
igual('zero -> string vazia (nao "zero reais")', zapsign.valorPorExtenso(0), '');
igual('negativo -> string vazia', zapsign.valorPorExtenso(-100), '');

// ============================================================
console.log('\n=== formatarMoeda / formatarData ===');

igual('formata em R$ com duas casas', zapsign.formatarMoeda(1500), 'R$ 1.500,00');
igual('valor invalido -> string vazia', zapsign.formatarMoeda('abc'), '');

checar('formatarData sem argumento nao lanca (usa hoje)', typeof zapsign.formatarData() === 'string' && zapsign.formatarData().length > 0);
igual('formatarData com ISO valido', zapsign.formatarData('2026-08-11T10:00:00-03:00'), '11/08/2026');
igual('formatarData com valor invalido -> string vazia', zapsign.formatarData('nao-e-data'), '');

// ============================================================
console.log('\n=== formatarTelefone ===');

checar('formata numero de 13 digitos com DDI+DDD', zapsign.formatarTelefone('5586999998888') === '+55 (86) 99999-8888');
checar('numero curto devolve so os digitos, sem lancar', typeof zapsign.formatarTelefone('123') === 'string');

// ============================================================
console.log('\n=== montarCamposContrato ===');

{
  const { campos, faltantes } = zapsign.montarCamposContrato(null, '5586999998888', '2026-08-11T10:00:00-03:00');
  checar('dados nulos: campos = null', campos === null);
  igual('dados nulos: faltantes = todos os obrigatorios', faltantes, zapsign.CAMPOS_CONTRATO_OBRIGATORIOS);
}

{
  const { campos, faltantes } = zapsign.montarCamposContrato(DADOS_COMPLETOS, '5586999998888', '2026-08-11T10:00:00-03:00');
  igual('dados completos: sem faltantes', faltantes, []);
  checar('campos nao e null', campos !== null);
  igual('{{NOME COMPLETO}}', campos['{{NOME COMPLETO}}'], 'Carlos Eduardo');
  igual('{{CPF}}', campos['{{CPF}}'], '12345678900');
  igual('{{EMAIL}}', campos['{{EMAIL}}'], 'carlos@exemplo.com');
  igual('{{TELEFONE}}', campos['{{TELEFONE}}'], '+55 (86) 99999-8888');
  igual('{{VALOR HONORARIOS INICIAL}}', campos['{{VALOR HONORARIOS INICIAL}}'], 'R$ 1.500,00');
  igual('{{valor por extenso}} = honorarios iniciais em palavras', campos['{{valor por extenso}}'], 'mil e quinhentos reais');
  igual('{{DATA ASSINATURA}}', campos['{{DATA ASSINATURA}}'], '11/08/2026');
  // Sem liminar informado, os campos derivados dele ficam vazios em vez de "R$ 0,00"/extenso de zero.
  igual('sem liminar: {{VALOR HONORARIOS LIMINAR}} vazio', campos['{{VALOR HONORARIOS LIMINAR}}'], '');
  igual('sem liminar: {{VALOR HONORARIOS LIMINAR DIVIDIDO POR 3}} vazio', campos['{{VALOR HONORARIOS LIMINAR DIVIDIDO POR 3}}'], '');
  igual('sem liminar: {{número por extenso}} vazio', campos['{{número por extenso}}'], '');
}

{
  // {{número por extenso}} = VALOR HONORARIOS LIMINAR DIVIDIDO POR 3 em palavras — confirmado com
  // o usuario em 11/08/2026 (NAO e o divisor "3" por extenso).
  const dadosComLiminar = { ...DADOS_COMPLETOS, valor_honorarios_liminar: 9000 };
  const { campos } = zapsign.montarCamposContrato(dadosComLiminar, '5586999998888', '2026-08-11T10:00:00-03:00');
  igual('{{VALOR HONORARIOS LIMINAR}}', campos['{{VALOR HONORARIOS LIMINAR}}'], 'R$ 9.000,00');
  igual('{{VALOR HONORARIOS LIMINAR DIVIDIDO POR 3}} = 9000/3', campos['{{VALOR HONORARIOS LIMINAR DIVIDIDO POR 3}}'], 'R$ 3.000,00');
  igual('{{número por extenso}} = 3000 por extenso (liminar/3, nao o divisor)', campos['{{número por extenso}}'], 'três mil reais');
}

// ============================================================
console.log('\n=== interpretarStatusWebhook ===');

igual(
  'doc_signed -> assinado=true',
  zapsign.interpretarStatusWebhook({ event_type: 'doc_signed', token: 'abc', status: 'signed' }),
  { docToken: 'abc', eventType: 'doc_signed', status: 'signed', assinado: true, recusado: false, emailFalhou: false }
);
igual(
  'doc_refused -> recusado=true',
  zapsign.interpretarStatusWebhook({ event_type: 'doc_refused', token: 'abc', status: 'refused' }),
  { docToken: 'abc', eventType: 'doc_refused', status: 'refused', assinado: false, recusado: true, emailFalhou: false }
);
igual(
  'email_bounce -> emailFalhou=true',
  zapsign.interpretarStatusWebhook({ event_type: 'email_bounce', token: 'abc' }),
  { docToken: 'abc', eventType: 'email_bounce', status: null, assinado: false, recusado: false, emailFalhou: true }
);
igual(
  'doc_created -> nenhuma flag',
  zapsign.interpretarStatusWebhook({ event_type: 'doc_created', token: 'abc', status: 'pending' }),
  { docToken: 'abc', eventType: 'doc_created', status: 'pending', assinado: false, recusado: false, emailFalhou: false }
);
igual('payload sem token', zapsign.interpretarStatusWebhook({}).docToken, null);

console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
