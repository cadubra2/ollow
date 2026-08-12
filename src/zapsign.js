// Integracao com a API do ZapSign — geracao automatica do contrato de "Prestacao de Servico"
// preenchido com os dados que o bot ja tem, quando o agendamento da consulta e confirmado
// (chamada a partir de handleContratoZapSign em index.js).
//
// Endpoint e formato do payload confirmados na documentacao oficial (docs.zapsign.com.br) em
// 11/08/2026: POST /api/v1/models/create-doc/, autenticacao "Authorization: Bearer <token>",
// campos dinamicos do template enviados como array `data: [{ de: "{{CAMPO}}", para: "valor" }]`
// — as chaves duplas do nome do campo ENTRAM no "de", exatamente como aparecem no modelo.
//
// Webhook de status (doc_signed etc): a ZapSign NAO assina o corpo com HMAC como Zernio/GitHub —
// a autenticacao e por um header HTTP customizado que a gente mesmo escolhe ao cadastrar o
// webhook (painel ou POST /api/v1/user/company/webhook/ com {url, type, headers}). Ver
// zapsignWebhookValido em index.js.

const extenso = require('extenso');
const { chaveConversa } = require('./telefone');

const ZAPSIGN_BASE = process.env.ZAPSIGN_BASE || 'https://api.zapsign.com.br';
const ZAPSIGN_API_KEY = process.env.ZAPSIGN_API_KEY;
const ZAPSIGN_TEMPLATE_TOKEN = process.env.ZAPSIGN_TEMPLATE_TOKEN;

// Dados exigidos antes de criar o documento. email_cliente entra aqui porque sem e-mail o ZapSign
// nao tem como mandar o convite de assinatura automaticamente — decisao do escritorio (11/08/2026):
// bloquear a criacao do contrato em vez de mandar sem e-mail. valor_honorarios_liminar e
// valor_mensalidade ficam DE FORA da lista: nem todo caso tem liminar ou mensalidade.
const CAMPOS_CONTRATO_OBRIGATORIOS = [
  'nome', 'email_cliente', 'cpf', 'profissao', 'estado_civil', 'endereco',
  'area_direito', 'assunto', 'valor_honorarios_inicial',
];

// Frase fixa por area do direito pra compor {{OBJETO DO CONTRATO}}. Mesmas chaves (normalizadas)
// de MOSKIT_IDS.AREA_DIREITO em src/moskit-ids.js — nao duplicar outra lista de nomes de area em
// paralelo; se uma area for renomeada la, repetir aqui.
const OBJETO_CONTRATO_POR_AREA = {
  'direito administrativo': 'prestação de serviços advocatícios na área de Direito Administrativo',
  'direito educacional': 'prestação de serviços advocatícios na área de Direito Educacional',
  'direito imobiliario': 'prestação de serviços advocatícios na área de Direito Imobiliário',
  'direito previdenciario': 'prestação de serviços advocatícios na área de Direito Previdenciário',
  'direito de familia': 'prestação de serviços advocatícios na área de Direito de Família',
  'direito do consumidor': 'prestação de serviços advocatícios na área de Direito do Consumidor',
  'direito do trabalho': 'prestação de serviços advocatícios na área de Direito do Trabalho',
  'lgpd': 'prestação de serviços advocatícios na área de Direito Digital/LGPD',
  'direito empresarial': 'prestação de serviços advocatícios na área de Direito Empresarial',
  'outros': 'prestação de serviços advocatícios',
  'solucoes medicas': 'prestação de serviços advocatícios na área de Direito Médico e da Saúde',
};

function normalizar(valor) {
  return String(valor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function vazio(v) {
  return v === null || v === undefined || v === '' || v === 'null';
}

// Espelha camposPendentes (index.js) — mesma logica, lista diferente (a do contrato, nao a do deal).
function camposContratoFaltantes(dados) {
  if (!dados) return [...CAMPOS_CONTRATO_OBRIGATORIOS];
  return CAMPOS_CONTRATO_OBRIGATORIOS.filter((k) => vazio(dados[k]));
}

function contratoCompleto(dados) {
  return camposContratoFaltantes(dados).length === 0;
}

function montarObjetoContrato(dados) {
  const chave = normalizar(dados?.area_direito);
  const base = OBJETO_CONTRATO_POR_AREA[chave] || 'prestação de serviços advocatícios';
  return dados?.assunto ? `${base}, especificamente: ${dados.assunto}` : base;
}

// Wrapper isolado sobre a lib de extenso PT-BR (pacote "extenso") — se a lib mudar, so este
// arquivo muda. valor em reais (ex: 1500 ou 1500.50), nao em centavos.
function valorPorExtenso(valorEmReais) {
  const numero = Number(valorEmReais);
  if (!Number.isFinite(numero) || numero <= 0) return '';
  return extenso(numero, { mode: 'currency', currency: { type: 'BRL' } });
}

function formatarMoeda(valorEmReais) {
  const numero = Number(valorEmReais);
  if (!Number.isFinite(numero)) return '';
  // toLocaleString insere U+00A0 (espaco nao-quebravel) entre "R$" e o valor — normaliza pra
  // espaco comum, pra nao deixar caractere invisivel estranho dentro de um documento real.
  return numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
}

function formatarData(dataIso) {
  const d = dataIso ? new Date(dataIso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: process.env.TZ_ESCRITORIO || 'America/Fortaleza' });
}

// Mascara de exibicao pro campo {{TELEFONE}} — best-effort, nao e usado pra nada alem de aparecer
// no texto do contrato. chatId chega no formato de src/telefone.js (ate 13 digitos, DDI+DDD+numero).
function formatarTelefone(chatId) {
  const digitos = chaveConversa(chatId) || String(chatId || '').replace(/\D/g, '');
  if (digitos.length < 10) return digitos;
  const semPais = digitos.length > 11 ? digitos.slice(-11) : digitos;
  const pais = digitos.length > 11 ? digitos.slice(0, digitos.length - 11) : '55';
  const ddd = semPais.slice(0, 2);
  const numero = semPais.slice(2);
  const meio = numero.length >= 5 ? numero.slice(0, numero.length - 4) : numero;
  const fim = numero.slice(-4);
  return `+${pais} (${ddd}) ${meio}-${fim}`;
}

// Monta o payload de "data" pro endpoint /models/create-doc/ com as 14 chaves exatas do template
// "Prestacao de Servico". Retorna { campos: null, faltantes: [...] } se algum campo obrigatorio
// ainda estiver vazio — NUNCA manda documento pela metade.
//
// {{valor por extenso}} = VALOR HONORARIOS INICIAL em palavras; {{número por extenso}} = VALOR
// HONORARIOS LIMINAR DIVIDIDO POR 3 em palavras — confirmado com o usuario em 11/08/2026 (nao e o
// divisor "tres" por extenso, e o valor liminar/3 por extenso).
function montarCamposContrato(dados, chatId, dataAssinaturaIso) {
  const faltantes = camposContratoFaltantes(dados);
  if (faltantes.length) return { campos: null, faltantes };

  const liminar = Number(dados.valor_honorarios_liminar) || 0;
  const liminarDividido = liminar / 3;

  const campos = {
    '{{NOME COMPLETO}}': dados.nome,
    '{{PROFISSAO}}': dados.profissao,
    '{{ESTADO CIVIL}}': dados.estado_civil,
    '{{CPF}}': dados.cpf,
    '{{ENDERECO}}': dados.endereco,
    '{{EMAIL}}': dados.email_cliente,
    '{{TELEFONE}}': formatarTelefone(chatId),
    '{{OBJETO DO CONTRATO}}': montarObjetoContrato(dados),
    '{{VALOR HONORARIOS INICIAL}}': formatarMoeda(dados.valor_honorarios_inicial),
    '{{valor por extenso}}': valorPorExtenso(dados.valor_honorarios_inicial),
    '{{VALOR HONORARIOS LIMINAR}}': liminar ? formatarMoeda(liminar) : '',
    '{{VALOR HONORARIOS LIMINAR DIVIDIDO POR 3}}': liminar ? formatarMoeda(liminarDividido) : '',
    '{{VALOR MENSALIDADE}}': dados.valor_mensalidade ? formatarMoeda(dados.valor_mensalidade) : '',
    '{{número por extenso}}': liminar ? valorPorExtenso(liminarDividido) : '',
    '{{DATA ASSINATURA}}': formatarData(dataAssinaturaIso),
  };
  return { campos, faltantes: [] };
}

// Chamada de I/O real — cria o documento no ZapSign a partir do template configurado
// (ZAPSIGN_TEMPLATE_TOKEN) e dispara o convite de assinatura por e-mail (comportamento padrao da
// API quando signer_email e informado). Sem validateStatus customizado: erro de verdade precisa
// subir, quem chama (handleContratoZapSign em index.js) decide o que fazer com ele.
async function criarDocumentoZapSign(dados, chatId, dataAssinaturaIso) {
  const axios = require('axios'); // lazy require: reusa axios.defaults (timeout/httpsAgent) já configurados em index.js
  if (!ZAPSIGN_API_KEY) throw new Error('ZAPSIGN_API_KEY nao configurado');
  if (!ZAPSIGN_TEMPLATE_TOKEN) throw new Error('ZAPSIGN_TEMPLATE_TOKEN nao configurado');

  const { campos, faltantes } = montarCamposContrato(dados, chatId, dataAssinaturaIso);
  if (!campos) return { ok: false, faltantes };

  const payload = {
    template_id: ZAPSIGN_TEMPLATE_TOKEN,
    signer_name: dados.nome,
    signer_email: dados.email_cliente,
    data: Object.entries(campos).map(([de, para]) => ({ de, para: String(para ?? '') })),
  };

  const { data } = await axios.post(
    `${ZAPSIGN_BASE}/api/v1/models/create-doc/`,
    payload,
    { headers: { Authorization: `Bearer ${ZAPSIGN_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  return {
    ok: true,
    docToken: data?.token || null,
    status: data?.status || null,
    signUrl: data?.signers?.[0]?.sign_url || null,
  };
}

// Mapeia o payload do webhook do ZapSign pro vocabulario interno, isolando index.js do formato
// exato da API (confirmado na doc oficial em 11/08/2026: event_type, token, status, signers[]).
function interpretarStatusWebhook(payload) {
  const eventType = payload?.event_type || null;
  const status = payload?.status || null;
  return {
    docToken: payload?.token || null,
    eventType,
    status,
    assinado: eventType === 'doc_signed' || status === 'signed',
    recusado: eventType === 'doc_refused' || status === 'refused',
    emailFalhou: eventType === 'email_bounce',
  };
}

module.exports = {
  CAMPOS_CONTRATO_OBRIGATORIOS,
  OBJETO_CONTRATO_POR_AREA,
  camposContratoFaltantes,
  contratoCompleto,
  montarObjetoContrato,
  valorPorExtenso,
  formatarMoeda,
  formatarData,
  formatarTelefone,
  montarCamposContrato,
  criarDocumentoZapSign,
  interpretarStatusWebhook,
};
