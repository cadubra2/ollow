require('dotenv').config();

const axios = require('axios');
const OpenAI = require('openai');

const LAYLA_USER_ID = 90607;
const PRODUTO_CONSULTA_PAGA_ID = 75739;
const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const apiHeaders = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
};

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
  console.log(`  opcao nao encontrada para "${valor}"`);
  return null;
}

function montarHistorico(mensagens) {
  return mensagens.map((m) => `${m.role}: ${m.text}`).join('\n');
}

const CAMPOS_OBRIGATORIOS = ['origem', 'tipo_consulta', 'area_direito', 'advogado_responsavel'];

function camposPendentes(dados) {
  if (!dados) return CAMPOS_OBRIGATORIOS;
  return CAMPOS_OBRIGATORIOS.filter((k) => !dados[k] || dados[k] === 'null');
}

function mergeDados(anteriores, novos) {
  const merged = { ...(anteriores || {}) };
  for (const key of Object.keys(novos || {})) {
    if (novos[key] !== null && novos[key] !== undefined && novos[key] !== 'null') {
      merged[key] = novos[key];
    }
  }
  return merged;
}

const PROMPT_EXTRAIR = `
Analise a conversa completa abaixo e decida qual acao tomar.
Retorne APENAS um JSON valido.

CONTEXTO ATUAL:
- Deal ja existe no CRM: {temDeal}
- Dados ja extraidos anteriormente: {dadosAnteriores}

REGRAS DE DECISAO:
- "aguardar": lead AINDA NAO marcou/confirmou consulta. So esta explicando o caso ou conversa generica. Nao criar nada.
- "criar": lead JA DEMONSTROU interesse em contratar E marcou/agendou consulta. Crie o deal com TODOS os campos obrigatorios preenchidos e nota com resumo.
- "nota": deal JA EXISTE + TODOS os campos obrigatorios ja estao preenchidos no CRM. So adicione nota com briefing atualizado. NAO altere campos do deal.
- "atualizar_campos": deal JA EXISTE + algum campo obrigatorio esta null/pendente. Preencha APENAS os campos que voce conseguiu identificar AGORA. Os demais mantenha null. Apos isso, se todos os campos obrigatorios estiverem preenchidos, adicione nota de conclusao.

CAMPOS OBRIGATORIOS (nunca podem ser null, exceto captacao e pagamento_confirmado):
1. origem — SEMPRE preencher. Extraia da mensagem inicial. Se nao encontrar, use "Nao identificado".
2. tipo_consulta — SEMPRE "consulta paga" (padrao). So use "sem consulta" se o lead disser EXPLICITAMENTE que nao quer contratar.
3. area_direito — Use seu conhecimento juridico para inferir pela conversa.
4. advogado_responsavel — Determinado pela area_direito + PERFIS DOS ADVOGADOS abaixo.
5. captacao — PODE ser null. Só preencha se o lead mencionar QUEM trouxe ele (ex: "Instagram do Berto", "fui indicado pelo Bruno"). Se mencionar "escritorio" generico, mantenha null.
6. pagamento_confirmado — boolean (true/false). Marque como true APENAS se o lead DISSE que pagou OU enviou um arquivo (imagem/PDF/comprovante) E o contexto indica pagamento (ex: "ja fiz o Pix", "paguei", comprovante). Se nao houver indicacao de pagamento, mantenha false.

EXEMPLOS DE INTERPRETACAO DE MENSAGENS AUTOMATICAS:
- "acessei o site do escritorio" → origem: Site
- "vi no Instagram do escritorio" → origem: Instagram
- "vi no Instagram do Berto" → origem: Instagram, captacao: Berto
- "vi no Instagram do Bruno" → origem: Instagram, captacao: Bruno
- "seu link na bio" → origem: Instagram
- "fui indicado pelo Bruno" → origem: Indicacao de clientes, captacao: Bruno
- "meu amigo me indicou" → origem: Indicacao de amigos e parentes
- "achei no YouTube" → origem: Youtube
- "pesquisei no Google/JusBrasil" → origem: JusBrasil
- "vi um artigo" → origem: Artigo
- sem menção explicita → origem: Nao identificado

REGRA IMPORTANTE: Se o lead comecar falando de onde veio (ex: "acessei o site", "vi no Instagram"), ISSO DEFINE a origem. Nao deixe null.

Formato de resposta:
{
  "acao": "aguardar | criar | nota | atualizar_campos",
  "justificativa": "explicacao curta do porque decidiu essa acao",
  "dados": {
    "nome": "... ou null",
    "assunto": "tema do processo (ex: Antecipacao da colacao de grau, Internato, Transferencia de FIES)",
    "origem": "... (nunca null em criar)",
    "advogado_responsavel": "... (nunca null em criar)",
    "captacao": "... ou null",
    "tipo_consulta": "... (nunca null em criar)",
    "area_direito": "... (nunca null em criar)",
    "amigos_do_escritorio": "... ou null",
    "pagamento_confirmado": "true se o lead pagou ou false se nao. So true se ele disse que pagou OU enviou comprovante.",
    "resumo_atendimento": "briefing completo para o advogado antes da reuniao: o que aconteceu com o cliente, o que ele relatou, o que ja foi tentado, e os pontos principais que o advogado precisa saber"
  }
}

Valores permitidos:
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury, Ana, Layla
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto, Bruno, Iury
  REGRA: advogado_responsavel eh DEFINIDO pela area_direito. Use os PERFIS ABAIXO.
- pagamento_confirmado: true, false

PERFIS DOS ADVOGADOS:
1. Berto Caballero — Atende: Direito Digital (LGPD, crimes digitais, propriedade intelectual, contratos eletronicos) e Direito Administrativo (licitacoes, servidores publicos, concurseiros, processos admistrativos). Publico-alvo: Concurseiros, Servidores Publicos, Empresas.
2. Bruno Rocha — Atende: Direito Imobiliario (compra/venda, locacao, usucapiao, reintegracao de posse, regularizacao fundiaria) e Direito de Familia e Sucessoes (divorcio, guarda, alimentos, inventario, partilha, testamento, adocao). Publico-alvo: Proprietarios de imoveis, demandas familiares.
3. Iury Carvalho — Atende: Direito Medico e da Saude (defesa de profissionais da saude, erro medico, planos de saude, acesso a tratamentos e medicamentos). Publico-alvo: Medicos, Estudantes de Medicina, hospitais, clinicas.
- amigos_do_escritorio: texto livre com nome ou parentesco de alguem do escritorio, ou null se nao houver

Conversa completa:
{historico}
`;

async function extrairDados(historico, temDeal, dadosAnteriores) {
  const pendentes = dadosAnteriores ? camposPendentes(dadosAnteriores) : [];
  const prompt = PROMPT_EXTRAIR
    .replace('{historico}', historico)
    .replace('{temDeal}', temDeal ? 'sim' : 'nao')
    .replace('{dadosAnteriores}', dadosAnteriores ? JSON.stringify(dadosAnteriores) : `{ "pendentes": "${pendentes.join(', ')}" }`);
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

async function buscarOuCriarContato(phone, name) {
  try {
    const listRes = await axios.get(`${MOSKIT_BASE}/contacts`, {
      params: { page: 1, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const contatos = listRes.data || [];
    if (Array.isArray(contatos)) {
      const found = contatos.find((c) => {
        const phones = c.phones || [];
        return phones.some((p) => String(p.number).replace(/\D/g, '').includes(phone.replace(/\D/g, '')));
      });
      if (found) return found.id;
    }
  } catch {}
  const createRes = await axios.post(
    `${MOSKIT_BASE}/contacts`,
    { name: name || 'Cliente sem nome', createdBy: { id: LAYLA_USER_ID }, responsible: { id: LAYLA_USER_ID }, phones: [{ number: phone }] },
    { headers: apiHeaders, validateStatus: (s) => s < 500 }
  );
  return createRes.data.id;
}

async function criarDeal(dados, contactId) {
  const payload = montarPayloadMoskit(dados, contactId);
  const response = await axios.post(`${MOSKIT_BASE}/deals`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return response.data;
}

async function atualizarDeal(dealId, dados, contactId) {
  const payload = montarPayloadMoskit(dados, contactId);
  const response = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return response.data;
}

async function buscarDealPorContato(contactId) {
  try {
    const listRes = await axios.get(`${MOSKIT_BASE}/deals`, {
      params: { page: 1, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const deals = listRes.data || [];
    if (Array.isArray(deals)) {
      for (const deal of deals) {
        const detailRes = await axios.get(`${MOSKIT_BASE}/deals/${deal.id}`, {
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
        });
        const contacts = detailRes.data?.contacts || [];
        const match = contacts.some((c) => String(c.id) === String(contactId));
        if (match) return deal.id;
      }
    }
  } catch {}
  return null;
}

async function criarNota(dealId, texto) {
  const res = await axios.post(
    `${MOSKIT_BASE}/deals/${dealId}/notes`,
    { description: texto, user: { id: LAYLA_USER_ID } },
    { headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' }, validateStatus: (s) => s < 500 }
  );
  if (res.status >= 300) {
    console.error(`  ❌ Erro nota: ${res.status}`, JSON.stringify(res.data));
  } else {
    console.log(`  ✅ Nota criada (id ${res.data.id})`);
  }
}

async function moverParaEstagio(dealId, stageId) {
  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s < 500,
  });
  const dealAtual = getRes.data;
  dealAtual.stage = { id: stageId };
  await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, dealAtual, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s < 500,
  });
  console.log(`  ✅ Deal ${dealId} movido para stage ${stageId}`);
}

// ============================================================
// FLUXO COMPLETO: 1º cria deal com campos pendentes,
//                  2º atualiza quando chega info
// ============================================================

const PHONE_MAP = { ana: '101', maria: '102', pedro: '103' };

function phoneDoNome(nome) {
  const primeiroNome = nome.split(' ')[0].split('-')[0].trim().toLowerCase();
  const sufixo = PHONE_MAP[primeiroNome] || '199';
  return `5511999999${sufixo}`;
}

async function simularFluxoPessoa(nome, mensagensFase1, mensagensFase2) {
  const phone = phoneDoNome(nome);
  const chatId = phone;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  FLUXO: ${nome}`);
  console.log(`${'='.repeat(60)}`);

  // ---- FASE 1: Lead manda mensagens sem origem/captacao ----
  console.log(`\n--- FASE 1: Primeiras mensagens (sem origem/captacao) ---`);
  mensagensFase1.forEach((m, i) => console.log(`  [${i + 1}] ${m.text}`));

  const historico1 = montarHistorico(mensagensFase1);
  let result1 = await extrairDados(historico1, false, null);
  console.log(`\n  → IA: ${result1.acao} | just: ${result1.justificativa}`);
  console.log(`  → Dados: ${JSON.stringify(result1.dados)}`);

  if (result1.acao !== 'criar' || !result1.dados?.nome) {
    console.log(`  ❌ Fase 1 falhou: IA nao criou o deal`);
    return null;
  }

  // Criar contato + deal (reusa se ja existir)
  const contactId = await buscarOuCriarContato(phone, result1.dados.nome);
  console.log(`  → Contato: ${contactId}`);

  const pendentesFase1 = camposPendentes(result1.dados);
  console.log(`  → Campos pendentes: ${pendentesFase1.length > 0 ? pendentesFase1.join(', ') : 'nenhum'}`);

  let dealId = await buscarDealPorContato(contactId);
  if (dealId) {
    await atualizarDeal(dealId, result1.dados, contactId);
    console.log(`  ✅ Deal existente reutilizado: ${dealId}`);
  } else {
    const deal = await criarDeal(result1.dados, contactId);
    dealId = deal.id;
    console.log(`  ✅ Novo deal criado: ${dealId}`);
  }

  if (result1.dados.resumo_atendimento) {
    await criarNota(dealId, `📋 Briefing pré-reunião\n\n${result1.dados.resumo_atendimento}`);
  }

  if (result1.dados.pagamento_confirmado === true || result1.dados.pagamento_confirmado === 'true') {
    await moverParaEstagio(dealId, 184382);
    await criarNota(dealId, `💳 Pagamento confirmado — deal movido para Consulta Agendada`);
  }

  let dadosAtuais = result1.dados;

  // ---- FASE 2: Lead revela origem/captacao ----
  if (mensagensFase2 && mensagensFase2.length > 0) {
    console.log(`\n--- FASE 2: Novas mensagens com origem/captacao ---`);
    mensagensFase2.forEach((m, i) => console.log(`  [${i + 1}] ${m.text}`));

    const historico2 = montarHistorico([...mensagensFase1, ...mensagensFase2]);
    let result2 = await extrairDados(historico2, true, dadosAtuais);
    console.log(`\n  → IA: ${result2.acao} | just: ${result2.justificativa}`);
    console.log(`  → Dados novos: ${JSON.stringify(result2.dados)}`);

    if (result2.acao === 'atualizar_campos' || result2.acao === 'criar') {
      const dadosMesclados = mergeDados(dadosAtuais, result2.dados);
      const pendentesFase2 = camposPendentes(dadosMesclados);

      console.log(`  → Dados mesclados: ${JSON.stringify(dadosMesclados)}`);
      console.log(`  → Ainda pendentes: ${pendentesFase2.length > 0 ? pendentesFase2.join(', ') : 'nenhum'}`);

      await atualizarDeal(dealId, dadosMesclados, contactId);
      console.log(`  ✅ Deal ${dealId} atualizado`);

      // Única nota combinada: campos alterados + briefing
      const camposAlterados = Object.keys(result2.dados).filter(
        (k) => result2.dados[k] !== null && result2.dados[k] !== undefined && result2.dados[k] !== 'null'
      );
      let notaTexto = '';
      if (camposAlterados.length > 0) {
        const descricao = camposAlterados.map((k) => `${k}: ${result2.dados[k]}`).join(', ');
        notaTexto += `🔄 Campos preenchidos: ${descricao}\n\n`;
      }
      if (result2.dados.resumo_atendimento) {
        const titulo = pendentesFase2.length === 0 ? '📋 Briefing completo' : '📋 Briefing atualizado';
        notaTexto += `${titulo}\n${result2.dados.resumo_atendimento}`;
      }
      if (notaTexto) {
        await criarNota(dealId, notaTexto);
      }

      // Pagamento confirmado → mover para Consulta Agendada
      if (result2.dados.pagamento_confirmado === true || result2.dados.pagamento_confirmado === 'true') {
        await moverParaEstagio(dealId, 184382);
        await criarNota(dealId, `💳 Pagamento confirmado — deal movido para Consulta Agendada`);
      }

      dadosAtuais = dadosMesclados;
    } else if (result2.acao === 'nota') {
      if (result2.dados.resumo_atendimento) {
        await criarNota(dealId, `📋 Briefing atualizado\n\n${result2.dados.resumo_atendimento}`);
      }
    }
  }

  return { nome: result1.dados.nome, assunto: result1.dados.assunto, dealId, contactId, dadosAtuais };
}

async function main() {
  console.log('========================================');
  console.log('  TESTE — LEAD CHEGOU + PAGAMENTO (2 FASES)');
  console.log('========================================');

  // Ana — fase 1: chega e agenda, fase 2: paga e envia comprovante
  const r = await simularFluxoPessoa(
    'Ana - Pensão alimentícia',
    [
      { role: 'cliente', text: 'Bom dia, meu nome é Ana' },
      { role: 'cliente', text: 'Preciso de ajuda com uma pensão alimentícia' },
      { role: 'cliente', text: 'Meu ex-marido não está pagando' },
      { role: 'cliente', text: 'Quero contratar, pode marcar uma consulta?' },
      { role: 'cliente', text: 'Posso ir na segunda de manhã' },
    ],
    [
      { role: 'cliente', text: 'Ja fiz o Pix da consulta' },
      { role: 'cliente', text: '📎 [cliente enviou uma imagem]' },
    ]
  );

  // === RESUMO ===
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESUMO`);
  console.log(`${'='.repeat(60)}`);

  if (r) {
    const pends = camposPendentes(r.dadosAtuais);
    console.log(`\n  ✅ ${r.nome}${r.assunto ? ` - ${r.assunto}` : ''}`);
    console.log(`     Deal: ${r.dealId}`);
    console.log(`     Contato: ${r.contactId}`);
    console.log(`     Link: https://app.moskitcrm.com/deals/${r.dealId}`);
    console.log(`     Dados: ${JSON.stringify(r.dadosAtuais)}`);
    console.log(`     Pendentes: ${pends.length > 0 ? pends.join(', ') : 'nenhum ✅'}`);
  }
  console.log(`\n${'='.repeat(60)}`);
}

main().catch((err) => {
  console.error('\n❌ Erro:', err.message);
  if (err.response) {
    console.error('  Status:', err.response.status);
    console.error('  Resposta:', JSON.stringify(err.response.data, null, 2));
  }
  console.error(err.stack);
});
