// Inspecao MANUAL de cenarios de classificacao — chama a OpenAI de verdade e IMPRIME o que o bot
// decidiria. Nao tem asserção de pass/fail: serve pra olhar, nao pra CI (ver CLAUDE.md).
//
//   node test-cenarios-classificacao.js
//
// Este arquivo mantinha COPIAS de montarHistorico, do PROMPT_EXTRAIR, de montarPayloadMoskit, das
// tabelas de ID e de buscarIdOpcao — e elas ja tinham divergido do index.js (o prompt copiado ainda
// falava de "confirmacao_agendamento_equipe", campo que nao existe mais, e a copia de
// montarPayloadMoskit decidia paga x cortesia por uma regra que o bot abandonou). Um cenario que
// "passa" contra uma copia velha nao diz nada sobre o bot real, entao agora tudo vem do index.js.
//
// Carrega index.js, entao precisa de DB_PATH (banco descartavel) e WORKER_MODE=1 — sem isso o require
// abre o banco de PRODUCAO e sobe servidor/ngrok/timers.

require('dotenv').config();

const path = require('path');
const { dirTemporario } = require('./test-utils');

process.env.DB_PATH = path.join(dirTemporario('cenarios'), 'teste.db');
process.env.WORKER_MODE = '1';

const { montarHistorico, extrairDadosAtendimento, montarPayloadMoskit } = require('./index');
const IDS = require('./src/moskit-ids');

// ================================================================
//  CENÁRIOS DE TESTE (nenhum chama o Moskit — só simulação local)
// ================================================================

async function testarCenario(nome, esperado, mensagens) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${nome}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`  Esperado: ${esperado}`);

  console.log(`\n--- Conversa simulada ---`);
  mensagens.forEach((m) => console.log(`  [${m.role === 'equipe' ? 'Equipe' : 'Cliente'}] ${m.text}`));

  const historico = montarHistorico(mensagens);
  const result = await extrairDadosAtendimento(historico, false, null, 'Nao', '2026-07-28T10:00:00');

  console.log(`\n--- Decisão da IA ---`);
  console.log(`  Ação: ${result.acao}  |  Confiança: ${result.confianca}`);
  console.log(`  Justificativa: ${result.justificativa}`);
  console.log(`  area_direito: ${result.dados?.area_direito}  |  advogado sugerido: ${result.dados?.advogado_responsavel}`);
  console.log(`  assunto: ${result.dados?.assunto}`);
  console.log(`  pagamento_confirmado: ${result.dados?.pagamento_confirmado}`);
  console.log(`  tipo_consulta (extraído pela IA): ${result.dados?.tipo_consulta}`);
  console.log(`  observacoes: ${(result.observacoes || []).map((o) => o.tipo).join(', ') || '(nenhuma)'}`);

  if (result.acao === 'criar' && result.dados) {
    // O bloco de condicoes de valor e o unico fato que decide paga x cortesia (checkpoint), entao o
    // cenario informa isso pelo `opcoes` — igual ao que o pipeline faz.
    const equipeAnunciouValor = mensagens.some((m) => m.role === 'equipe' && /350|honor|investimento/i.test(m.text));
    const payload = montarPayloadMoskit(result.dados, 12345, { condicoesValorEnviadas: equipeAnunciouValor });
    const opcao = (cfId) => payload.entityCustomFields.find((c) => c.id === cfId)?.options?.[0];
    const nomeDaOpcao = (tabela, id) => Object.entries(tabela).find(([, v]) => v === id)?.[0] || '(vazio)';
    console.log(`\n--- O que iria pro Moskit (regras reais do index.js) ---`);
    console.log(`  titulo: ${payload.name}`);
    console.log(`  bloco de condicoes detectado: ${equipeAnunciouValor}`);
    console.log(`  tipo_consulta FINAL: ${nomeDaOpcao(IDS.TIPO_CONSULTA, opcao(IDS.CF.TIPO_CONSULTA))}`);
    console.log(`  price FINAL: ${payload.price}`);
    console.log(`  area FINAL: ${nomeDaOpcao(IDS.AREA_DIREITO, opcao(IDS.CF.AREA_DIREITO))}`);
    console.log(`  responsavel FINAL (derivado da area): ${nomeDaOpcao(IDS.RESPONSAVEL_PROCESSO, opcao(IDS.CF.RESPONSAVEL))}`);
  } else {
    console.log(`\n  ⏳ Ação "${result.acao}" — nenhum deal seria criado, logo nenhum price é calculado.`);
  }

  return result;
}

async function main() {
  await testarCenario(
    'CENÁRIO 1: CONSULTA GRÁTIS — equipe confirma agendamento, cliente nunca fala de pagamento',
    'tipo_consulta final = "consulta gratis", price = 0',
    [
      { role: 'cliente', text: 'Boa tarde, meu nome é Carla Mendes' },
      { role: 'cliente', text: 'Vi o escritório no Instagram do Dr. Bruno' },
      { role: 'cliente', text: 'Meu ex-marido parou de pagar a pensão do meu filho há 2 meses' },
      { role: 'cliente', text: 'Queria entender o que posso fazer' },
      { role: 'equipe', text: 'Oi Carla, entendi seu caso. Marquei sua consulta pra sexta-feira às 14h, pode ser?' },
      { role: 'cliente', text: 'Perfeito, obrigada!' },
    ]
  );

  await testarCenario(
    'CENÁRIO 2: CONSULTA PAGA — equipe confirma agendamento ANTES do pagamento ser verificado, mas cliente alega ter pago',
    'tipo_consulta final = "consulta paga", price = 35000 (cliente alegou pagamento, mesmo sem comprovante em foto)',
    [
      { role: 'cliente', text: 'Boa tarde, meu nome é Rafael Souza' },
      { role: 'cliente', text: 'Achei o site de vocês pesquisando no Google' },
      { role: 'cliente', text: 'Fui demitido e não recebi minhas verbas rescisórias corretas' },
      { role: 'cliente', text: 'Quero marcar a consulta' },
      { role: 'equipe', text: 'Show Rafael, ficou confirmado dia 10 às 15h' },
      { role: 'cliente', text: 'Já fiz o Pix de 350 aqui, depois te mando o comprovante' },
    ]
  );

  await testarCenario(
    'CENÁRIO 3: CONSULTA PAGA padrão — cliente marca sozinho, sem equipe confirmar e sem falar de pagamento',
    'tipo_consulta final = "consulta paga" (default do prompt), price = 35000',
    [
      { role: 'cliente', text: 'Bom dia, meu nome é Fernanda Lima' },
      { role: 'cliente', text: 'Vim pelo Google mesmo, pesquisando escritório de advocacia imobiliária' },
      { role: 'cliente', text: 'Comprei um apartamento e o vendedor não quer assinar a escritura' },
      { role: 'cliente', text: 'Quero contratar, pode marcar a consulta pra quinta de manhã?' },
    ]
  );

  await testarCenario(
    'CENÁRIO 4: CONSULTA PAGA — cliente paga sem a equipe confirmar nada',
    'tipo_consulta final = "consulta paga", price = 35000',
    [
      { role: 'cliente', text: 'Oi, meu nome é Juliana Prado' },
      { role: 'cliente', text: 'Vim por indicação de uma amiga do escritório' },
      { role: 'cliente', text: 'Meu plano de saúde negou uma cirurgia urgente' },
      { role: 'cliente', text: 'Já fiz o pagamento da consulta, segue o comprovante' },
    ]
  );

  await testarCenario(
    'CENÁRIO 5: SEM CONSULTA — cliente diz explicitamente que não quer contratar',
    'tipo_consulta final = "sem consulta"',
    [
      { role: 'cliente', text: 'Oi, meu nome é Marcos Alves' },
      { role: 'cliente', text: 'Vi vocês no JusBrasil' },
      { role: 'cliente', text: 'Tenho uma dúvida rápida sobre um contrato de aluguel' },
      { role: 'cliente', text: 'Na verdade só queria uma orientação geral, não pretendo contratar advogado agora, vou resolver por conta própria' },
    ]
  );

  await testarCenario(
    'CENÁRIO 6: AGUARDAR (sanity check) — conversa genérica, sem contexto de negócio',
    'ação = aguardar/ignorar, nenhum payload é montado',
    [
      { role: 'cliente', text: 'Bom dia' },
      { role: 'cliente', text: 'Tudo bem?' },
    ]
  );

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  FIM DOS TESTES`);
  console.log(`${'='.repeat(70)}\n`);
}

main().catch((err) => {
  console.error('\n❌ Erro no teste:', err.message);
  console.error(err.stack);
});
