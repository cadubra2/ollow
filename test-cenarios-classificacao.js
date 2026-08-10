require('dotenv').config();

const OpenAI = require('openai');

// ------------------------------------------------------------
// Config (copiado do index.js atual)
// ------------------------------------------------------------
const LAYLA_USER_ID = 90607;
const PRODUTO_CONSULTA_PAGA_ID = 75739;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ------------------------------------------------------------
// Mapeamentos (copiados do index.js atual)
// ------------------------------------------------------------
const MAPEAMENTO_ORIGEM = {
  'indicacao de clientes': 200150,
  'jusbrasil': 200151,
  'instagram': 200152,
  'artigo': 200153,
  'indicacao de parceiros': 200165,
  'landing page': 242974,
  'youtube': 259742,
  'site': 264164,
  'indicacao de/ou amigos e parentes': 362034,
  'nao identificado': 435777,
  'vsl - trafego pago': 694860,
};

const MAPEAMENTO_TIPO_CONSULTA = {
  'consulta gratis': 217250,
  'consulta paga': 217251,
  'sem consulta': 228769,
};

const MAPEAMENTO_CAPTACAO = {
  'berto': 200154,
  'bruno': 200155,
  'iury': 200156,
};

const MAPEAMENTO_AREA_DIREITO = {
  'direito administrativo': 228779,
  'direito educacional': 228780,
  'direito imobiliario': 228781,
  'direito previdenciario': 228782,
  'direito de familia': 228783,
  'direito do consumidor': 228784,
  'direito do trabalho': 228785,
  'lgpd': 228786,
  'direito empresarial': 228787,
  'outros': 235234,
  'solucoes medicas': 577809, 'direito medico e da saude': 577809, 'direito da saude': 577809, 'direito medico': 577809,
};

const MAPEAMENTO_RESPONSAVEL_PROCESSO = {
  'berto': 228788,
  'bruno': 228789,
  'iury': 228790,
};

function removerAcentos(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function buscarIdOpcao(mapeamento, valor) {
  if (!valor) return null;
  const normalizado = removerAcentos(String(valor).toLowerCase().trim());
  if (mapeamento[normalizado] !== undefined) return mapeamento[normalizado];
  for (const [label, id] of Object.entries(mapeamento)) {
    const labelSemAcento = removerAcentos(label);
    if (normalizado === labelSemAcento ||
        normalizado.includes(labelSemAcento) ||
        labelSemAcento.includes(normalizado)) {
      return id;
    }
  }
  console.log(`  opcao nao encontrada para "${valor}"`);
  return null;
}

function removerEmoji(str) {
  return String(str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function montarHistorico(mensagens) {
  return mensagens.map((m) => {
    const label = m.role === 'equipe' ? 'Equipe do escritório' : m.role === 'sistema' ? 'Sistema' : 'Cliente';
    return `${label}: ${m.text}`;
  }).join('\n');
}

const CAMPOS_OBRIGATORIOS = ['origem', 'tipo_consulta', 'area_direito', 'advogado_responsavel'];

function camposPendentes(dados) {
  if (!dados) return CAMPOS_OBRIGATORIOS;
  return CAMPOS_OBRIGATORIOS.filter((k) => !dados[k] || dados[k] === 'null');
}

// ------------------------------------------------------------
// PROMPT_EXTRAIR (copiado literalmente do index.js:817-915)
// ------------------------------------------------------------
const PROMPT_EXTRAIR = `
Analise a conversa completa e extraia dados para criar/atualizar um negocio no CRM. Retorne APENAS um JSON valido.

Raciocine passo a passo antes de responder:
1. Esta conversa ja tem um deal no CRM? Se sim, quais campos estao pendentes?
2. Quais campos obrigatorios consigo identificar com confianca?
3. ATENCAO: advogado_responsavel eh DEFINIDO pela area_direito, NAO por qual socio o lead mencionou.
4. O lead fez pagamento ou enviou comprovante?
5. Qual acao e mais adequada?

CONTEXTO ATUAL:
- Data/hora da ultima mensagem desta conversa: {dataAtual}
- Deal ja existe no CRM: {temDeal}
- Dados ja extraidos anteriormente: {dadosAnteriores}
- Cliente ja existe no CRM: {infoCliente}

REGRAS DE DECISAO:
- "criar": lead DEMONSTROU interesse + agendou consulta. Crie o deal com TODOS os campos obrigatorios preenchidos e nota com resumo.
- "aguardar": lead NAO marcou/confirmou consulta. So explicando o caso. Nao criar nada.
- "nota": deal JA EXISTE + todos os campos ok. So adicione nota.
- "atualizar_campos": deal EXISTE + algum campo pendente. Atualize APENAS o que identificou AGORA.
- "ignorar": passou pela classificacao mas nao foi possivel extrair informacoes uteis. Ignorar permanentemente.

CAMPOS OBRIGATORIOS (nunca podem ser null em criar):
1. origem — SEMPRE preencher. Extraia da mensagem inicial. Se nao encontrar, use "Nao identificado".
2. tipo_consulta — SEMPRE "consulta paga" (padrao). So "sem consulta" se o lead disser EXPLICITAMENTE que nao quer contratar.
3. area_direito — Use seu conhecimento juridico para inferir pela conversa.
4. advogado_responsavel — Determinado UNICAMENTE pela area_direito. Se area_direito estiver clara, use os PERFIS para definir. Se area_direito estiver null ou incerta, mantenha null. NAO derive do nome do lead ou de qual socio ele mencionou.
5. captacao — Se mencionou rede social de Berto, Bruno ou Iury, ou foi indicado por um deles, preencha com o nome do socio (INDEPENDENTE de area_direito estar definida). CASO CONTRARIO, preencha com o MESMO valor de advogado_responsavel (que pode ser null se area_direito nao identificada).
6. pagamento_confirmado — boolean. True APENAS se DISSE que pagou OU enviou comprovante. Senao false.

CAMPOS OPCIONAIS (usados pra agendar a reuniao no Google Agenda — deixe null se nao tiver certeza):
7. data_hora_consulta — data/hora ISO 8601 (ex: "2026-07-31T10:00:00") que o cliente CONFIRMOU pra consulta, OU que a equipe do escritorio confirmou ter marcado com o cliente (mensagem "Equipe do escritório:"). Use "Data/hora da ultima mensagem desta conversa" (fornecida no CONTEXTO ATUAL) como referencia (data-ancora) pra resolver dias relativos tipo "sexta de manha", "amanha as 10h", "dia 9 de janeiro" — NUNCA invente uma data se nem o cliente nem a equipe confirmaram um dia/horario especifico. Se so disse "pode ser" sem dia/horario, ou se ainda esta negociando, deixe null.
   ATENCAO AO ANO: o resultado tem que ser uma data no FUTURO em relacao a data-ancora. Se o cliente mencionar so dia e mes (ex: "dia 9 de janeiro", "15 de marco") sem dizer o ano, calcule: se essa data (dia+mes) no ANO da data-ancora ja passou ou eh igual a data-ancora, use o ANO SEGUINTE. Exemplo: data-ancora 2026-07-24, cliente diz "dia 9 de janeiro" → 09/01 no ano 2026 ja passou → use 2027-01-09, NUNCA 2026-01-09.
8. email_cliente — email do cliente, APENAS se ele literalmente escreveu um email na conversa. Nunca invente ou derive de outro campo.
9. estagio_funil_sugerido — analise a conversa (incluindo mensagens "Equipe do escritório:") e identifique se houve avanco no funil de vendas alem da consulta paga/agendada. Use null se nao houver sinal claro. Valores possiveis:
   - "aguardando_condicao": a consulta ja aconteceu (equipe ou cliente mencionam que a reuniao/consulta ja ocorreu) e agora esta aguardando retorno/decisao do cliente.
   - "elaboracao_proposta": equipe menciona que vai preparar/enviar uma Proposta de Honorarios pro cliente.
   - "negociacao": cliente reage a proposta discutindo condicoes, valores ou prazos de pagamento dos honorarios.
   - "elaboracao_contrato": condicoes foram fechadas/aceitas e a equipe menciona que vai preparar o contrato.
   - "contrato_enviado": equipe confirma que o contrato foi enviado pro cliente.
   Seja conservador: so sugira um estagio se houver uma frase clara indicando esse avanco. Na duvida, deixe null.
10. confirmacao_agendamento_equipe — boolean. True APENAS se uma mensagem "Equipe do escritório:" confirma EXPLICITAMENTE que a consulta/reuniao foi agendada/marcada com o cliente (ex: "marquei sua consulta pra sexta 14h", "ficou confirmado dia 10 as 15h", "agendei pra vc"). Permite criar o evento na agenda mesmo sem comprovante de pagamento verificado — use com cautela, so quando a mensagem da equipe for uma confirmacao clara e inequivoca de agendamento. Se for so o cliente confirmando (sem a equipe ter dito isso), ou se a equipe so estiver negociando data sem confirmar, deixe false.
11. modalidade_consulta — "presencial" ou "online". Como a consulta sera realizada, se isso foi mencionado na conversa (ex: cliente ou equipe dizem "presencial", "no escritorio", "pessoalmente" → presencial; "por video", "online", "por chamada" → online). Se nao houver nenhuma indicacao clara, use "online" (padrao — gera link de Google Meet). So use "presencial" se estiver EXPLICITO que sera sem video-chamada.

INSTRUCOES PARA resumo_atendimento (briefing pre-consulta do advogado):
Escreva um resumo ESPECIFICO e ACIONAVEL, nao generico. Use os fatos concretos que aparecem na conversa: nomes de pessoas ou empresas envolvidas, datas, valores, numero de processo, tipo de documento, prazos. Evite frases vagas tipo "cliente quer analise do caso" — prefira algo como "cliente foi notificado pela ANPD em 15/03 sobre vazamento de dados de clientes e quer saber se pode ser responsabilizado".
Estruture em 4 linhas (uma por topico, com quebra de linha \n entre elas — NAO use "|"):
📌 Caso: [o que aconteceu, com os detalhes concretos disponiveis — partes envolvidas, datas, valores, documentos]
📌 Objetivo do cliente: [o que especificamente ele quer resolver, saber ou contratar]
📌 Urgencia/prazo: [prazo, audiencia, notificacao ou data mencionada — se nao houver, escreva "Nao mencionado"]
📌 Ja tentou: [acoes anteriores mencionadas pelo cliente — se nao houver, escreva "Nada mencionado"]
Se a conversa nao tiver detalhe suficiente pra algum topico, escreva "Nao mencionado" em vez de inventar ou generalizar.

EXEMPLOS REAIS DE CAPTACAO:
- "Instagram do Bruno" + area=Familia → origem: Instagram, captacao: Bruno, adv_resp: Bruno
- "link da bio no Instagram do Dr. Berto" + area=Educacional → origem: Instagram, captacao: Berto, adv_resp: Berto
- "vi a pagina do Bruno" + sem caso descrito → origem: Instagram, captacao: Bruno, adv_resp: null (sem area definida)
- "acessei o site do escritorio" + sem mencao a socio → origem: Site, captacao: [mesmo adv_resp, ou null se adv null]
- "minha prima falou, ela e amiga do escritorio" → origem: Indicacao de amigos e parentes, captacao: [mesmo adv_resp]

Formato de resposta (use dados reais extraidos, nao descricoes):
{
  "acao": "criar",
  "justificativa": "Lead agendou consulta sobre inventario",
  "confianca": 8,
  "dados": {
    "nome": "Carlos Eduardo",
    "assunto": "Inventario",
    "origem": "Site",
    "advogado_responsavel": "Bruno",
    "captacao": "Bruno",
    "tipo_consulta": "consulta paga",
    "area_direito": "Direito de Familia",
    "pagamento_confirmado": false,
    "data_hora_consulta": null,
    "email_cliente": null,
    "estagio_funil_sugerido": null,
    "confirmacao_agendamento_equipe": false,
    "modalidade_consulta": "online",
    "resumo_atendimento": "📌 Caso: pai do cliente faleceu ha 3 meses e deixou uma casa; os dois irmaos querem vender o imovel sem repassar a parte do cliente na heranca.\\n📌 Objetivo do cliente: entender seus direitos no inventario e formalizar a partilha antes que os irmaos vendam a casa.\\n📌 Urgencia/prazo: Nao mencionado.\\n📌 Ja tentou: Nada mencionado."
  }
}

Valores permitidos:
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto (Administrativo/Digital), Bruno (Imobiliario/Familia), Iury (Solucoes Medicas)

PERFIS DOS ADVOGADOS:
1. Berto Caballero — Direito Digital (LGPD, crimes digitais, propriedade intelectual) e Direito Administrativo (licitacoes, servidores publicos, concurseiros).
2. Bruno Rocha — Direito Imobiliario (compra/venda, locacao, usucapiao, reintegracao) e Direito de Familia (divorcio, guarda, alimentos, inventario).
3. Iury Carvalho — Solucoes Medicas (defesa de profissionais da saude, erro medico, planos de saude).

Conversa completa:
{historico}
`;

async function extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual) {
  const pendentes = dadosAnteriores ? camposPendentes(dadosAnteriores) : [];
  const prompt = PROMPT_EXTRAIR
    .replace('{historico}', historico)
    .replace('{temDeal}', temDeal ? 'sim' : 'nao')
    .replace('{dadosAnteriores}', dadosAnteriores ? JSON.stringify(dadosAnteriores) : `{ "pendentes": "${pendentes.join(', ')}" }`)
    .replace('{infoCliente}', infoCliente || 'Nao')
    .replace('{dataAtual}', dataAtual || new Date().toISOString());

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: 'Voce e um analista juridico especializado em extracao de dados de conversas de WhatsApp para leads de escritorio de advocacia. Extraia APENAS informacoes que voce tem CERTEZA. Nao invente. Se nao tiver certeza de um campo, deixe como null (a nao ser que a regra diga o contrario). Responda apenas JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  const conteudo = completion.choices[0]?.message?.content;
  if (!conteudo) throw new Error('OpenAI retornou resposta vazia.');
  return JSON.parse(conteudo);
}

// ------------------------------------------------------------
// montarPayloadMoskit (copiado literalmente do index.js:418-460,
// incluindo o override tratarComoGratis)
// ------------------------------------------------------------
function montarPayloadMoskit(dados, contactId) {
  const customFields = [];

  const confirmadoPelaEquipeSemComprovante = dados.confirmacao_agendamento_equipe === true || dados.confirmacao_agendamento_equipe === 'true';
  const pagamentoAlegadoPeloCliente = dados.pagamento_confirmado === true || dados.pagamento_confirmado === 'true';
  const tratarComoGratis = confirmadoPelaEquipeSemComprovante && !pagamentoAlegadoPeloCliente;
  const tipoConsultaFinal = tratarComoGratis ? 'consulta gratis' : dados.tipo_consulta;

  const idOrigem = buscarIdOpcao(MAPEAMENTO_ORIGEM, dados.origem);
  if (idOrigem) customFields.push({ id: 'CF_GwyMgWiEi7E0LMLA', options: [idOrigem] });

  const idTipoConsulta = buscarIdOpcao(MAPEAMENTO_TIPO_CONSULTA, tipoConsultaFinal);
  if (idTipoConsulta) customFields.push({ id: 'CF_Pj3qYeidir3ArqQe', options: [idTipoConsulta] });

  const idCaptacao = buscarIdOpcao(MAPEAMENTO_CAPTACAO, dados.captacao);
  if (idCaptacao) customFields.push({ id: 'CF_2wpDlkieioO8dmvL', options: [idCaptacao] });

  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  if (idArea) customFields.push({ id: 'CF_6rRmwei9i6aZpq4X', options: [idArea] });

  const idResponsavel = buscarIdOpcao(MAPEAMENTO_RESPONSAVEL_PROCESSO, dados.advogado_responsavel);
  if (idResponsavel) customFields.push({ id: 'CF_vG0mR0iwik846qbV', options: [idResponsavel] });

  const nomeLimpo = removerEmoji(dados.nome);
  const assuntoLimpo = removerEmoji(dados.assunto);
  const nomeDeal = assuntoLimpo ? `${nomeLimpo || 'Cliente sem nome'} - ${assuntoLimpo}` : (nomeLimpo || 'Cliente sem nome');
  const payload = {
    name: nomeDeal,
    status: 'OPEN',
    stage: { id: Number(process.env.MOSKIT_STAGE_ID) },
    createdBy: { id: LAYLA_USER_ID },
    responsible: { id: LAYLA_USER_ID },
    contacts: [{ id: contactId }],
    entityCustomFields: customFields,
    price: tratarComoGratis ? 0 : 35000,
    dealProducts: [{ product: { id: PRODUTO_CONSULTA_PAGA_ID }, quantity: 1, price: 0, initialPrice: 0, finalPrice: 0 }],
  };

  return { payload, tratarComoGratis, tipoConsultaFinal };
}

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
  console.log(`  pagamento_confirmado: ${result.dados?.pagamento_confirmado}`);
  console.log(`  confirmacao_agendamento_equipe: ${result.dados?.confirmacao_agendamento_equipe}`);
  console.log(`  tipo_consulta (extraído pela IA): ${result.dados?.tipo_consulta}`);

  if (result.acao === 'criar' && result.dados) {
    const { payload, tratarComoGratis, tipoConsultaFinal } = montarPayloadMoskit(result.dados, 12345);
    console.log(`\n--- Resultado final (após override do código) ---`);
    console.log(`  tratarComoGratis: ${tratarComoGratis}`);
    console.log(`  tipo_consulta FINAL enviado ao Moskit: ${tipoConsultaFinal}`);
    console.log(`  price FINAL enviado ao Moskit: ${payload.price}`);
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
