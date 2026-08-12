// Cria um documento REAL de teste no ZapSign a partir do template "Prestacao de Servico", usando
// ZAPSIGN_API_KEY/ZAPSIGN_TEMPLATE_TOKEN de PRODUCAO do .env. NAO chamar em CI/automaticamente —
// mesma categoria de test-moskit-put.js/test-moskit-real.js (CLAUDE.md, "Scripts manuais").
//
//   node test-zapsign-real.js <seu-email-de-teste>            # so mostra os campos que SERIAM enviados
//   node test-zapsign-real.js <seu-email-de-teste> --aplicar   # ENVIA de verdade — cria o documento e
//                                                                dispara o e-mail de assinatura pro
//                                                                endereco informado
//
// Use um e-mail que voce mesmo controla. O modo --aplicar cria um documento de VERDADE no ZapSign
// (aparece na lista de documentos da conta) e manda um convite de assinatura real.

require('dotenv').config();
const zapsign = require('./src/zapsign');

const emailTeste = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');

if (!emailTeste || !emailTeste.includes('@')) {
  console.error('Uso: node test-zapsign-real.js <seu-email-de-teste> [--aplicar]');
  process.exit(1);
}

const DADOS_TESTE = {
  nome: 'Cliente de Teste ZapSign',
  email_cliente: emailTeste,
  cpf: '00000000000',
  profissao: 'Profissão de Teste',
  estado_civil: 'Solteiro(a)',
  endereco: 'Rua de Teste, 123, Centro, Teresina - PI',
  area_direito: 'Direito de Familia',
  assunto: '[TESTE] Verificacao de integracao ZapSign',
  valor_honorarios_inicial: 1500,
  valor_honorarios_liminar: 9000,
};

const CHAT_ID_TESTE = '5586999990000';

async function main() {
  console.log('=== Campos que seriam enviados ao ZapSign ===');
  const { campos, faltantes } = zapsign.montarCamposContrato(DADOS_TESTE, CHAT_ID_TESTE, new Date().toISOString());
  if (faltantes.length) {
    console.error('❌ Dados de teste incompletos (nao deveria acontecer):', faltantes);
    process.exit(1);
  }
  console.log(JSON.stringify(campos, null, 2));

  if (!APLICAR) {
    console.log('\n(modo leitura — rode com --aplicar para criar o documento de verdade e mandar o e-mail)');
    return;
  }

  console.log(`\n⚠️  Criando documento REAL no ZapSign e enviando e-mail de assinatura para ${emailTeste}...`);
  const resultado = await zapsign.criarDocumentoZapSign(DADOS_TESTE, CHAT_ID_TESTE, new Date().toISOString());
  console.log('\n=== Resultado ===');
  console.log(JSON.stringify(resultado, null, 2));
  if (resultado.ok) {
    console.log(`\n✅ Documento criado. Verifique o e-mail ${emailTeste} (e a pasta de spam) para assinar.`);
  } else {
    console.log('\n❌ Falhou — veja "faltantes" acima.');
  }
}

main().catch((e) => {
  console.error('❌ Erro:', e.response?.data || e.message);
  process.exit(1);
});
