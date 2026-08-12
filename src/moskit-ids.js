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

// Uma chave por opcao do CRM. Apelidos (o que a IA pode escrever em vez do nome oficial) ficam em
// APELIDOS, mais abaixo — misturar os dois aqui apagaria a invariante "nenhum ID repetido" que
// test-moskit-ids.js usa para pegar duas opcoes diferentes apontando pro mesmo ID por engano.
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
  'solucoes medicas': 577809,
};

const RESPONSAVEL_PROCESSO = {
  'berto': 228788,
  'bruno': 228789,
  'iury': 228790,
};

// APELIDOS: valor que a IA pode devolver -> chave canonica da tabela correspondente.
//
// Existem porque a busca de opcao passou a exigir correspondencia EXATA (decisao de 12/08/2026). O
// casamento por substring que existia antes preenchia mais campos, mas escolhia a opcao errada em
// silencio: "Indicacao" sozinho casava com "Indicacao de clientes", "direito" com "Direito
// Administrativo", "consulta" com "consulta gratis" (R$0 no CRM). Agora o que nao esta aqui nem na
// tabela canonica deixa o campo VAZIO e avisa, em vez de chutar.
//
// Chaves ja normalizadas (minusculo, sem acento, sem pontuacao) — ver normalizarChave.
const APELIDOS = {
  AREA_DIREITO: {
    // Aliases medicos: estavam presentes em apenas 2 das 6 copias antigas; nas outras "Direito
    // Medico" caia em null.
    'direito medico e da saude': 'solucoes medicas',
    'direito da saude': 'solucoes medicas',
    'direito medico': 'solucoes medicas',
    'solucoes medicas e da saude': 'solucoes medicas',
    // Como o escritorio chama a area de LGPD no dia a dia (e como o proprio prompt descreve o perfil
    // do Berto).
    'direito digital': 'lgpd',
    'protecao de dados': 'lgpd',
    // Formas curtas que o modelo usa quando responde sem o prefixo "Direito".
    'administrativo': 'direito administrativo',
    'educacional': 'direito educacional',
    'imobiliario': 'direito imobiliario',
    'previdenciario': 'direito previdenciario',
    'familia': 'direito de familia',
    'direito de familia e sucessoes': 'direito de familia',
    'consumidor': 'direito do consumidor',
    'trabalho': 'direito do trabalho',
    'trabalhista': 'direito do trabalho',
    'direito trabalhista': 'direito do trabalho',
    'empresarial': 'direito empresarial',
  },
  ORIGEM: {
    // O proprio prompt tem as duas grafias: a lista de valores permitidos diz "Indicacao de/ou amigos
    // e parentes" e o exemplo de captacao diz "Indicacao de amigos e parentes".
    'indicacao de amigos e parentes': 'indicacao de/ou amigos e parentes',
    'indicacao de amigos': 'indicacao de/ou amigos e parentes',
    'indicacao de parentes': 'indicacao de/ou amigos e parentes',
    'indicacao de cliente': 'indicacao de clientes',
    'indicacao de parceiro': 'indicacao de parceiros',
    'vsl': 'vsl - trafego pago',
    'trafego pago': 'vsl - trafego pago',
    'nao informado': 'nao identificado',
    'site do escritorio': 'site',
  },
  TIPO_CONSULTA: {
    'consulta gratuita': 'consulta gratis',
    'gratis': 'consulta gratis',
    'cortesia': 'consulta gratis',
    'paga': 'consulta paga',
  },
  CAPTACAO: {
    'berto caballero': 'berto',
    'berto igor caballero': 'berto',
    'dr berto': 'berto',
    'bruno rocha': 'bruno',
    'dr bruno': 'bruno',
    'iury carvalho': 'iury',
    'dr iury': 'iury',
  },
  RESPONSAVEL_PROCESSO: {
    'berto caballero': 'berto',
    'berto igor caballero': 'berto',
    'dr berto': 'berto',
    'bruno rocha': 'bruno',
    'dr bruno': 'bruno',
    'iury carvalho': 'iury',
    'dr iury': 'iury',
  },
};

// Minusculo, sem acento, sem pontuacao, espacos colapsados. Usado nas duas pontas da busca de opcao,
// entao "Dr. Berto", "DR BERTO" e "dr berto" chegam iguais.
function normalizarChave(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Indice de busca por campo: chave normalizada (canonica OU apelido) -> id da opcao. Montado uma vez
// no load para que buscarIdOpcao (index.js) seja O(1) e sem nenhuma heuristica.
function montarIndice(tabela, apelidos = {}) {
  const indice = {};
  for (const [chave, id] of Object.entries(tabela)) indice[normalizarChave(chave)] = id;
  for (const [apelido, canonica] of Object.entries(apelidos)) {
    const id = tabela[canonica];
    if (id === undefined) throw new Error(`APELIDOS: "${apelido}" aponta para chave inexistente "${canonica}"`);
    indice[normalizarChave(apelido)] = id;
  }
  return indice;
}

// A BUSCA vive junto das tabelas de proposito: os scripts manuais (test-moskit-real.js,
// test-simulacao.js, test-cenarios-classificacao.js) tinham cada um a sua copia de buscarIdOpcao, e uma
// copia com regra diferente resolve o mesmo texto para OUTRA opcao do CRM — o tipo de divergencia que
// ja gravou deal errado. Importando daqui, todo mundo classifica igual.
//
// Correspondencia exata depois de normalizar. `aproximado` e so para texto livre que precisa cair na
// opcao mais parecida de uma lista fixa (motivo de perda escrito com as palavras da conversa).
function buscarOpcao(indice, valor, { aproximado = false } = {}) {
  if (!valor) return null;
  const alvo = normalizarChave(valor);
  if (!alvo) return null;

  for (const [chave, id] of Object.entries(indice)) {
    if (normalizarChave(chave) === alvo) return id;
  }
  if (aproximado) {
    for (const [chave, id] of Object.entries(indice)) {
      const normalizada = normalizarChave(chave);
      if (alvo.includes(normalizada) || normalizada.includes(alvo)) return id;
    }
  }
  return null;
}

const INDICE_BUSCA = {
  ORIGEM: montarIndice(ORIGEM, APELIDOS.ORIGEM),
  TIPO_CONSULTA: montarIndice(TIPO_CONSULTA, APELIDOS.TIPO_CONSULTA),
  CAPTACAO: montarIndice(CAPTACAO, APELIDOS.CAPTACAO),
  AREA_DIREITO: montarIndice(AREA_DIREITO, APELIDOS.AREA_DIREITO),
  RESPONSAVEL_PROCESSO: montarIndice(RESPONSAVEL_PROCESSO, APELIDOS.RESPONSAVEL_PROCESSO),
};

// A AREA DO CASO DEFINE O RESPONSAVEL. Regra de negocio confirmada com o escritorio em 12/08/2026 —
// antes disto quem escolhia o advogado era o modelo, e nada no codigo impedia area de Familia sair com
// responsavel Berto.
//
// Chaveado pelo ID da opcao, nao pelo nome: assim apelido de area ("Direito Medico", "familia") ja
// chega resolvido e as duas tabelas nunca podem divergir sobre como uma area se chama.
//
// "Outros" fica FORA de proposito: e caixao de miscelanea e nao tem dono automatico — melhor campo
// vazio para a equipe decidir do que um responsavel sorteado por uma area indefinida.
//
// NAO confundir com captacao: captacao e quem TROUXE o lead (Instagram do Berto, indicacao) e
// continua independente da area. Lead que veio pelo Berto com caso educacional fica captacao=Berto,
// responsavel=Iury.
const ADVOGADO_POR_AREA_ID = {
  [AREA_DIREITO['direito administrativo']]: 'Berto',
  [AREA_DIREITO['lgpd']]: 'Berto',

  [AREA_DIREITO['direito imobiliario']]: 'Bruno',
  [AREA_DIREITO['direito de familia']]: 'Bruno',
  [AREA_DIREITO['direito empresarial']]: 'Bruno',

  [AREA_DIREITO['solucoes medicas']]: 'Iury',
  [AREA_DIREITO['direito educacional']]: 'Iury',
  [AREA_DIREITO['direito previdenciario']]: 'Iury',
  [AREA_DIREITO['direito do consumidor']]: 'Iury',
  [AREA_DIREITO['direito do trabalho']]: 'Iury',
};

// Tipos de atividade que representam consulta marcada (GET /activityTypes).
// Ligacao/Email/WhatsApp ficam de fora de proposito: nao viram compromisso de agenda.
const ATIVIDADE_TIPO = {
  reuniao: 87134,          // consulta presencial
  videoconferencia: 87361, // consulta online (a que ganha link do Meet)
};

// Derivado de ATIVIDADE_TIPO para os dois lados nunca divergirem: este Set filtra o que o bot LE do
// Moskit, e ATIVIDADE_TIPO decide o que ele ESCREVE. Manter as duas listas na mao seria repetir aqui
// dentro exatamente o erro que este arquivo existe para impedir.
const ATIVIDADE_TIPOS_CONSULTA = new Set(Object.values(ATIVIDADE_TIPO));

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
  APELIDOS,
  INDICE_BUSCA,
  ADVOGADO_POR_AREA_ID,
  normalizarChave,
  buscarOpcao,
  ATIVIDADE_TIPO,
  ATIVIDADE_TIPOS_CONSULTA,
  TIPO_CONSULTA_GRATIS_ID: TIPO_CONSULTA['consulta gratis'],
  TIPO_CONSULTA_PAGA_ID: TIPO_CONSULTA['consulta paga'],
  STATUS_DEAL,
  LOST_REASON,
  LOST_REASON_PADRAO_ID: LOST_REASON['nao informou o motivo'],
};
