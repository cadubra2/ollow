// FONTE UNICA dos identificadores do Moskit.
//
// Estas tabelas estavam copiadas em SEIS arquivos (index.js, processar_pendentes.js,
// testar-briefing-unico.js, test-simulacao.js, test-moskit-real.js, test-cenarios-classificacao.js)
// e ja tinham divergido: `testar-briefing-unico.js` mapeava 'direito empresarial' para 235234, que
// e o ID de "outros" — e esse script escreve deals de verdade no CRM. Todo teste de Direito
// Empresarial entrou classificado errado.
//
// Nada de ID de Moskit deve ser escrito fora deste arquivo. Se o CRM mudar uma opcao, e aqui.

// Usuario dono de todo contato, deal e nota criados pelo bot. E uma decisao de negocio, nao um
// detalhe tecnico: tudo que o bot cria aparece no CRM atribuido a esta pessoa.
const LAYLA_USER_ID = 90607;

const PRODUTO_CONSULTA_PAGA_ID = 75739;

// Campos personalizados do deal.
const CF = {
  TIPO_CONSULTA: 'CF_Pj3qYeidir3ArqQe',
  ORIGEM: 'CF_GwyMgWiEi7E0LMLA',
  CAPTACAO: 'CF_2wpDlkieioO8dmvL',
  AREA_DIREITO: 'CF_6rRmwei9i6aZpq4X',
  RESPONSAVEL: 'CF_vG0mR0iwik846qbV',
};

const ORIGEM = {
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

const TIPO_CONSULTA = {
  'consulta gratis': 217250,
  'consulta paga': 217251,
  'sem consulta': 228769,
};

const CAPTACAO = {
  'berto': 200154,
  'bruno': 200155,
  'iury': 200156,
};

const AREA_DIREITO = {
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
  // Aliases da mesma opcao — estavam presentes em apenas 2 das 6 copias; nas outras, "Direito
  // Medico" caia em null.
  'solucoes medicas': 577809,
  'direito medico e da saude': 577809,
  'direito da saude': 577809,
  'direito medico': 577809,
};

const RESPONSAVEL_PROCESSO = {
  'berto': 228788,
  'bruno': 228789,
  'iury': 228790,
};

// Tipos de atividade que viram evento no Google Agenda. Ligacao/Email/WhatsApp nao viram.
const ATIVIDADE_TIPOS_CONSULTA = new Set([87134, 87361]); // 87134 = Reuniao, 87361 = Videoconferencia

// Valores de deal.status confirmados em 04/08/2026 testando contra a API real (deal de teste): o
// Moskit rejeita qualquer outra grafia com 422 "Enum must be valid format (OPEN, WON, LOST)".
const STATUS_DEAL = {
  OPEN: 'OPEN',
  WON: 'WON',
  LOST: 'LOST',
};

// GET /lostReasons do Moskit em 04/08/2026 — lista fixa cadastrada no CRM, nao inventada aqui.
// O item com `pipelines: [{id: 40631}]` e especifico do Funil de Vendas.
const LOST_REASON = {
  'fechou com concorrente': 126145,
  'achou nosso valor alto': 126146,
  'fora do perfil de compra': 126147,
  'inviabilidade da acao': 126506,
  'resolveu o problema administrativamente': 126755,
  'nao informou o motivo': 126756,
  'nao quis pagar consulta': 126857,
  'desistiu de entrar com a acao': 127372,
  'escritorio nao possui interesse em prosseguir': 182706,
  'nao quis marcar consulta gratis': 244375,
};

module.exports = {
  LAYLA_USER_ID,
  PRODUTO_CONSULTA_PAGA_ID,
  CF,
  ORIGEM,
  TIPO_CONSULTA,
  CAPTACAO,
  AREA_DIREITO,
  RESPONSAVEL_PROCESSO,
  ATIVIDADE_TIPOS_CONSULTA,
  TIPO_CONSULTA_GRATIS_ID: TIPO_CONSULTA['consulta gratis'],
  TIPO_CONSULTA_PAGA_ID: TIPO_CONSULTA['consulta paga'],
  STATUS_DEAL,
  LOST_REASON,
  LOST_REASON_PADRAO_ID: LOST_REASON['nao informou o motivo'],
};
