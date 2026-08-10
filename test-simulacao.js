require('dotenv').config();

const axios = require('axios');
const OpenAI = require('openai');
const Database = require('better-sqlite3');

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const LAYLA_USER_ID = 90607;
const PRODUTO_CONSULTA_PAGA_ID = 75739;
const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const apiHeaders = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
};

// ------------------------------------------------------------
// Mapeamentos
// ------------------------------------------------------------
const MAPEAMENTO_ORIGEM = {
  'indicação de clientes': 200150, 'jusbrasil': 200151, 'instagram': 200152,
  'artigo': 200153, 'indicação de parceiros': 200165, 'landing page': 242974,
  'youtube': 259742, 'site': 264164, 'indicação de/ou amigos e parentes': 362034,
  'não identificado': 435777, 'vsl - tráfego pago': 694860,
};
const MAPEAMENTO_TIPO_CONSULTA = {
  'consulta grátis': 217250, 'consulta paga': 217251, 'sem consulta': 228769,
};
const MAPEAMENTO_CAPTACAO = {
  'berto': 200154, 'bruno': 200155, 'iury': 200156, 'ana': 578820, 'layla': 578821,
};
const MAPEAMENTO_AREA_DIREITO = {
  'direito administrativo': 228779, 'direito educacional': 228780,
  'direito imobiliário': 228781, 'direito previdenciário': 228782,
  'direito de família': 228783, 'direito do consumidor': 228784,
  'direito do trabalho': 228785, 'lgpd': 228786, 'direito empresarial': 228787,
  'outros': 235234, 'soluções médicas': 577809,
};
const MAPEAMENTO_RESPONSAVEL_PROCESSO = {
  'berto': 228788, 'bruno': 228789, 'iury': 228790,
};

function removerAcentos(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function buscarIdOpcao(mapeamento, valor) {
  if (!valor) return null;
  const normalizado = removerAcentos(String(valor).toLowerCase().trim());
  if (mapeamento[normalizado] !== undefined) return mapeamento[normalizado];
  for (const [label, id] of Object.entries(mapeamento)) {
    const labelSemAcento = removerAcentos(label);
    if (normalizado === labelSemAcento ||
        normalizado.includes(labelSemAcento) ||
        labelSemAcento.includes(normalizado)) return id;
  }
  return null;
}

function montarHistorico(mensagens) {
  return mensagens.map((m) => `${m.role}: ${m.text}`).join('\n');
}

const PROMPT_EXTRAIR = `
Analise a conversa completa abaixo e decida qual acao tomar.
Retorne APENAS um JSON valido.

CONTEXTO ATUAL:
- Deal ja existe no CRM: {temDeal}
- Dados ja extraidos anteriormente: {dadosAnteriores}

REGRAS DE DECISAO:
- "aguardar": O lead AINDA NAO marcou/confirmou a consulta. Esta apenas explicando o caso, tirando duvidas, etc. Nao criar nada ainda.
- "criar": O lead JA DEMONSTROU interesse em contratar, marcou consulta, ou deixou claro que quer seguir com o caso. Crie o deal e adicione uma nota com o resumo.
- "nota": O deal JA EXISTE e o lead enviou informacoes adicionais. Adicione apenas uma nota com o resumo atualizado. NAO altere os campos do deal.

INSTRUCOES:
- Preencha com null qualquer campo que nao conseguir extrair.
- NUNCA invente dados. Use apenas informacoes presentes na conversa.
- Se for conversa sem contexto de negocio (ex.: "bom dia", "ola"), retorne "aguardar".
- Se nao conseguiu extrair o nome do cliente, retorne "aguardar".
- Para acao "criar": extraia TODOS os dados possiveis e forneca um resumo completo.
- Para acao "nota": extraia o resumo_atendimento atualizado, os demais campos podem vir null.

Formato de resposta:
{
  "acao": "aguardar | criar | nota",
  "justificativa": "explicacao curta do porque decidiu essa acao",
  "dados": {
    "nome": "... ou null",
    "assunto": "tema do processo (ex: Antecipacao da colacao de grau, Internato, Transferencia de FIES)",
    "origem": "... ou null",
    "advogado_responsavel": "... ou null",
    "captacao": "... ou null",
    "tipo_consulta": "... ou null",
    "area_direito": "... ou null",
    "amigos_do_escritorio": "... ou null",
    "resumo_atendimento": "briefing completo para o advogado antes da reuniao: o que aconteceu com o cliente, o que ele relatou, o que ja foi tentado, e os pontos principais que o advogado precisa saber"
  }
}

Valores permitidos para campos controlados (use null se nao encontrar):
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury, Ana, Layla
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto, Bruno, Iury
  REGRA: advogado_responsavel eh DEFINIDO pela area_direito. Use os PERFIS abaixo para decidir qual advogado melhor atende o caso do cliente.

PERFIS DOS ADVOGADOS:
1. Berto Caballero — Atende: Direito Digital (LGPD, crimes digitais, propriedade intelectual, contratos eletronicos) e Direito Administrativo (licitacoes, servidores publicos, concurseiros, processos admistrativos). Publico-alvo: Concurseiros, Servidores Publicos, Empresas.
2. Bruno Rocha — Atende: Direito Imobiliario (compra/venda, locacao, usucapiao, reintegracao de posse, regularizacao fundiaria) e Direito de Familia e Sucessoes (divorcio, guarda, alimentos, inventario, partilha, testamento, adocao). Publico-alvo: Proprietarios de imoveis, demandas familiares.
3. Iury Carvalho — Atende: Direito Medico e da Saude (defesa de profissionais da saude, erro medico, planos de saude, acesso a tratamentos e medicamentos). Publico-alvo: Medicos, Estudantes de Medicina, hospitais, clinicas.
- amigos_do_escritorio: texto livre com nome ou parentesco de alguem do escritorio, ou null se nao houver

Conversa completa:
{historico}
`;

async function extrairDadosAtendimento(historico, temDeal, dadosAnteriores) {
  const prompt = PROMPT_EXTRAIR
    .replace('{historico}', historico)
    .replace('{temDeal}', temDeal ? 'sim' : 'nao')
    .replace('{dadosAnteriores}', dadosAnteriores ? JSON.stringify(dadosAnteriores) : 'null');
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: 'Voce analisa conversas de escritorio de advocacia e decide a acao. Responda apenas JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  const conteudo = completion.choices[0]?.message?.content;
  if (!conteudo) throw new Error('OpenAI retornou resposta vazia.');
  return JSON.parse(conteudo);
}

function montarPayloadMoskit(dados, contactId) {
  const customFields = [];
  const idOrigem = buscarIdOpcao(MAPEAMENTO_ORIGEM, dados.origem);
  if (idOrigem) customFields.push({ id: 'CF_GwyMgWiEi7E0LMLA', options: [idOrigem] });
  const idTipoConsulta = buscarIdOpcao(MAPEAMENTO_TIPO_CONSULTA, dados.tipo_consulta);
  if (idTipoConsulta) customFields.push({ id: 'CF_Pj3qYeidir3ArqQe', options: [idTipoConsulta] });
  const idCaptacao = buscarIdOpcao(MAPEAMENTO_CAPTACAO, dados.captacao);
  if (idCaptacao) customFields.push({ id: 'CF_2wpDlkieioO8dmvL', options: [idCaptacao] });
  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  if (idArea) customFields.push({ id: 'CF_6rRmwei9i6aZpq4X', options: [idArea] });
  const idResponsavel = buscarIdOpcao(MAPEAMENTO_RESPONSAVEL_PROCESSO, dados.advogado_responsavel);
  if (idResponsavel) customFields.push({ id: 'CF_vG0mR0iwik846qbV', options: [idResponsavel] });

  const nomeDeal = dados.assunto ? `${dados.nome} - ${dados.assunto}` : (dados.nome || 'Cliente sem nome');
  return {
    name: nomeDeal,
    status: 'OPEN',
    stage: { id: Number(process.env.MOSKIT_STAGE_ID) },
    createdBy: { id: LAYLA_USER_ID },
    responsible: { id: LAYLA_USER_ID },
    contacts: [{ id: contactId }],
    entityCustomFields: customFields,
    price: 35000,
    dealProducts: [{ product: { id: PRODUTO_CONSULTA_PAGA_ID }, quantity: 1, price: 0, initialPrice: 0, finalPrice: 0 }],
  };
}

// ================================================================
//  CENÁRIOS DE TESTE
// ================================================================

async function testarCenario(nome, mensagens, temDeal, dadosAnteriores) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${nome}`);
  console.log(`${'='.repeat(60)}`);

  console.log(`\n--- Contexto ---`);
  console.log(`  Deal existe: ${temDeal ? 'sim' : 'nao'}`);
  if (dadosAnteriores) console.log(`  Dados anteriores: ${JSON.stringify(dadosAnteriores)}`);

  console.log(`\n--- Mensagens do lead ---`);
  mensagens.forEach((m, i) => console.log(`  [${i + 1}] ${m.text}`));

  const historico = montarHistorico(mensagens);
  const result = await extrairDadosAtendimento(historico, temDeal, dadosAnteriores);
  console.log(`\n--- Decisão da IA ---`);
  console.log(`  Ação: ${result.acao}`);
  console.log(`  Justificativa: ${result.justificativa}`);
  console.log(`  Dados extraídos: ${JSON.stringify(result.dados, null, 4)}`);

  if (result.acao === 'criar' && result.dados?.nome) {
    console.log(`\n--- Payload Moskit (simulado) ---`);
    const payload = montarPayloadMoskit(result.dados, 12345);
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\n--- Nota que seria adicionada ---`);
    console.log(`  📋 Briefing pré-reunião:\n  ${result.dados.resumo_atendimento}`);
  }

  if (result.acao === 'nota') {
    console.log(`\n--- Nota que seria adicionada ao deal ---`);
    console.log(`  📋 Briefing atualizado:\n  ${result.dados.resumo_atendimento || '(sem resumo)'}`);
  }

  if (result.acao === 'aguardar') {
    console.log(`\n  ⏳ Nenhuma ação no Moskit. IA aguardando mais contexto.`);
  }

  return result;
}

async function main() {
  // ==============================================================
  // CENÁRIO 1: Lead explicando o caso, AINDA não marcou consulta
  // ==============================================================
  const cenario1 = await testarCenario(
    'CENÁRIO 1: Lead explicando, sem consulta marcada ainda',
    [
      { role: 'cliente', text: 'Bom dia, tudo bem?' },
      { role: 'cliente', text: 'Meu nome é João Silva' },
      { role: 'cliente', text: 'Eu vi o escritório de vocês no Instagram' },
      { role: 'cliente', text: 'Preciso de ajuda com um problema' },
      { role: 'cliente', text: 'Me inscrevi num concurso público e a banca cancelou minha inscrição' },
      { role: 'cliente', text: 'Disseram que faltava um documento, mas eu entreguei tudo certinho' },
      { role: 'cliente', text: 'Já tentei recurso administrativo e negaram' },
    ],
    false,  // sem deal ainda
    null    // sem dados anteriores
  );

  // ==============================================================
  // CENÁRIO 2: Lead marcou a consulta → deve criar deal + nota
  // ==============================================================
  const cenario2 = await testarCenario(
    'CENÁRIO 2: Lead marcou/confirmou a consulta',
    [
      { role: 'cliente', text: 'Bom dia, tudo bem?' },
      { role: 'cliente', text: 'Meu nome é João Silva' },
      { role: 'cliente', text: 'Eu vi o escritório de vocês no Instagram' },
      { role: 'cliente', text: 'Me inscrevi num concurso público e a banca cancelou minha inscrição' },
      { role: 'cliente', text: 'Disseram que faltava um documento, mas eu entreguei tudo certinho' },
      { role: 'cliente', text: 'Quero contratar, pode marcar a consulta?' },
      { role: 'cliente', text: 'Pode ser quinta-feira às 14h?' },
    ],
    false,  // sem deal ainda
    null
  );

  // ==============================================================
  // CENÁRIO 3: Lead já tem deal, mandou info extra → só nota
  // ==============================================================
  const cenario3 = await testarCenario(
    'CENÁRIO 3: Lead já tem deal, mandou info adicional',
    [
      { role: 'cliente', text: 'Opa, só lembrando que meu irmão também precisa de ajuda' },
      { role: 'cliente', text: 'O caso dele é sobre plano de saúde negado' },
      { role: 'cliente', text: 'O nome dele é Pedro Silva' },
    ],
    true,  // já tem deal
    {     // dados já extraídos antes
      nome: 'João Silva',
      area_direito: 'Direito Administrativo',
      advogado_responsavel: 'Berto',
      tipo_consulta: 'consulta paga',
    }
  );

  // ==============================================================
  // CENÁRIO 4: Conversa genérica, sem contexto de negócio
  // ==============================================================
  const cenario4 = await testarCenario(
    'CENÁRIO 4: Conversa genérica (bom dia, obrigado)',
    [
      { role: 'cliente', text: 'Bom dia' },
      { role: 'cliente', text: 'Tudo bem?' },
      { role: 'cliente', text: 'Obrigado' },
      { role: 'cliente', text: 'Até mais' },
    ],
    false,
    null
  );

  // ==============================================================
  // RESUMO
  // ==============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESUMO DOS TESTES`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  C1 (explicando): ${cenario1.acao} — ${cenario1.justificativa}`);
  console.log(`  C2 (marcou):     ${cenario2.acao} — ${cenario2.justificativa}`);
  console.log(`  C3 (info extra): ${cenario3.acao} — ${cenario3.justificativa}`);
  console.log(`  C4 (generica):   ${cenario4.acao} — ${cenario4.justificativa}`);
  console.log(`${'='.repeat(60)}\n`);
}

main().catch((err) => {
  console.error('\n❌ Erro no teste:', err.message);
  console.error(err.stack);
});
