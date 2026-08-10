// Processamento direto de conversas pendentes (sem depender do bot web)
require('dotenv').config();
const https = require('https');
const Database = require('better-sqlite3');
const db = new Database('conversations.db');
const axios = require('axios');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const API_KEY = process.env.MOSKIT_API_KEY;
const LAYLA_USER_ID = 90607;
const PRODUTO_CONSULTA_PAGA_ID = 75739;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const apiHeaders = { apikey: API_KEY, 'Content-Type': 'application/json' };

// Mapeamentos (copiados do index.js)
const MAP_ORIGEM = { 'indicacao de clientes': 200150, 'jusbrasil': 200151, 'instagram': 200152, 'artigo': 200153, 'indicacao de parceiros': 200165, 'landing page': 242974, 'youtube': 259742, 'site': 264164, 'indicacao de/ou amigos e parentes': 362034, 'nao identificado': 435777, 'vsl - trafego pago': 694860 };
const MAP_TIPO_CONSULTA = { 'consulta gratis': 217250, 'consulta paga': 217251, 'sem consulta': 228769 };
const MAP_CAPTACAO = { 'berto': 200154, 'bruno': 200155, 'iury': 200156 };
const MAP_AREA = { 'direito administrativo': 228779, 'direito educacional': 228780, 'direito imobiliario': 228781, 'direito previdenciario': 228782, 'direito de familia': 228783, 'direito do consumidor': 228784, 'direito do trabalho': 228785, 'lgpd': 228786, 'direito empresarial': 228787, 'outros': 235234, 'solucoes medicas': 577809 };
const MAP_RESP = { 'berto': 228788, 'bruno': 228789, 'iury': 228790 };

function removerAcentos(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function buscarIdOpcao(map, valor) {
  if (!valor) return null;
  const chave = removerAcentos(valor.toLowerCase().trim());
  return map[chave] || null;
}

// OpenAI via fetch (mesma do index.js)
async function openaiChat(messages, responseFormat) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const fallback = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000));

  try {
    const promise = (async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages,
          temperature: 0,
          ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const parsed = await res.json();
      const content = parsed.choices?.[0]?.message?.content;
      if (!content) throw new Error('vazio');
      return content;
    })();
    return await Promise.race([promise, fallback]);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw e;
  } finally { clearTimeout(timeout); }
}

// Criar ou buscar contato
async function buscarOuCriarContato(phone, nome) {
  const phoneClean = phone.replace(/\D/g, '').slice(-13);
  try {
    const listRes = await axios.get(MOSKIT_BASE + '/contacts', {
      params: { limit: 200 },
      headers: apiHeaders,
      validateStatus: s => s < 500,
    });
    const contatos = listRes.data || [];
    if (Array.isArray(contatos)) {
      const found = contatos.find(c => (c.phones || []).some(p => String(p.number || '').replace(/\D/g, '').includes(phoneClean)));
      if (found) return found.id;
    }
  } catch {}
  const cr = await axios.post(MOSKIT_BASE + '/contacts', {
    name: nome ? '*' + nome + '*' : phone,
    createdBy: { id: LAYLA_USER_ID },
    responsible: { id: LAYLA_USER_ID },
    phones: [{ number: phone }],
  }, { headers: apiHeaders, validateStatus: s => s < 300 });
  return cr.data.id;
}

// Montar payload
function montarPayload(dados, contactId) {
  const customFields = [];
  const idOrigem = buscarIdOpcao(MAP_ORIGEM, dados.origem);
  if (idOrigem) customFields.push({ id: 'CF_GwyMgWiEi7E0LMLA', options: [idOrigem] });
  const idTipoConsulta = buscarIdOpcao(MAP_TIPO_CONSULTA, dados.tipo_consulta);
  if (idTipoConsulta) customFields.push({ id: 'CF_Pj3qYeidir3ArqQe', options: [idTipoConsulta] });
  const idCaptacao = buscarIdOpcao(MAP_CAPTACAO, dados.captacao);
  if (idCaptacao) customFields.push({ id: 'CF_2wpDlkieioO8dmvL', options: [idCaptacao] });
  const idArea = buscarIdOpcao(MAP_AREA, dados.area_direito);
  if (idArea) customFields.push({ id: 'CF_6rRmwei9i6aZpq4X', options: [idArea] });
  const idResponsavel = buscarIdOpcao(MAP_RESP, dados.advogado_responsavel);
  if (idResponsavel) customFields.push({ id: 'CF_vG0mR0iwik846qbV', options: [idResponsavel] });
  return {
    name: dados.assunto ? (dados.nome || 'Cliente') + ' - ' + dados.assunto : (dados.nome || 'Cliente'),
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

async function processarConversa(chatId, contactName) {
  console.log('\n=== Processando', chatId, contactName, '===');

  const row = db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row) { console.log('Nao encontrado'); return; }
  if (row.deal_id) {
    // Verificar se o deal existe no Moskit
    try {
      const chk = await axios.get(MOSKIT_BASE + '/deals/' + row.deal_id, { headers: apiHeaders, validateStatus: s => s < 500 });
      if (chk.status === 200) { console.log('Deal ja existe:', row.deal_id); return; }
    } catch {}
    console.log('Deal', row.deal_id, 'nao existe mais, recriando');
  }

  const mensagens = JSON.parse(row.messages);
  if (mensagens.length === 0) { console.log('Sem mensagens'); return; }

  const historico = mensagens.map(m => 'Cliente: ' + m.text).join('\n');
  const temDeal = false;
  const dadosAnteriores = row.last_data ? JSON.parse(row.last_data) : null;

  // Classificar
  console.log('1. Classificando...');
  const PROMPT_CLASSIFICAR = `Analise a conversa e retorne JSON. Se lead demonstrou interesse real em contratar servicos juridicos, retorne {"classificacao":"criar_negocio","justificativa":"..."}. Senao, retorne {"classificacao":"inviavel","justificativa":"..."}. Ignore mensagens de equipe/socios.

EXEMPLOS:
- "Ola, vi a pagina do advogado e gostaria de consulta" + caso descrito → criar_negocio
- Spam, numero errado, confirmacao de horario, conversa interna → inviavel

Conversa:
${historico}`;

  let classificacao;
  try {
    const r = await openaiChat([
      { role: 'system', content: 'Voce e um assistente juridico especializado em qualificacao de leads. Responda apenas JSON.' },
      { role: 'user', content: PROMPT_CLASSIFICAR },
    ], 'json');
    classificacao = JSON.parse(r);
  } catch (e) {
    console.log('  Erro classificacao:', e.message);
    return;
  }
  console.log('  Resultado:', JSON.stringify(classificacao));

  if (classificacao.classificacao !== 'criar_negocio') {
    console.log('  Inviavel');
    return;
  }

  // Extrair dados
  console.log('2. Extraindo dados...');
  const PROMPT_EXTRAIR = `Analise a conversa e extraia dados para criar um negocio no CRM. Retorne APENAS JSON.

Campos:
- nome: nome do cliente
- assunto: resumo do problema
- origem: Site, Instagram, JusBrasil, Indicacao de clientes, etc
- advogado_responsavel: Berto (Administrativo/Digital), Bruno (Imobiliario/Familia), Iury (Solucoes Medicas)
- captacao: Berto, Bruno, Iury (se indicado por eles), senao null
- tipo_consulta: "consulta paga"
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- pagamento_confirmado: boolean
- resumo_atendimento: "O que aconteceu: ... | O que o cliente quer: ... | O que ja foi tentado: ..."

Dados anteriores: ${JSON.stringify(dadosAnteriores || {})}

Conversa:
${historico}`;

  let result;
  try {
    const r = await openaiChat([
      { role: 'system', content: 'Voce e um analista juridico. Responda apenas JSON.' },
      { role: 'user', content: PROMPT_EXTRAIR },
    ], 'json');
    result = JSON.parse(r);
  } catch (e) {
    console.log('  Erro extracao:', e.message);
    return;
  }
  console.log('  Extraido:', JSON.stringify(result));

  const dados = result.dados || {};
  const acao = result.acao || 'criar';

  // Post-processing: forcar origem Instagram se mencionou pagina de socio
  const textoCompleto = historico.toLowerCase();
  const padroes = [
    { re: /pagina\s+do\s+(bruno|dr\.?\s*bruno|advogado\s+bruno)/i, s: 'Bruno' },
    { re: /pagina\s+do\s+(berto|dr\.?\s*berto|caballero)/i, s: 'Berto' },
    { re: /pagina\s+do\s+(iury|dr\.?\s*iury)/i, s: 'Iury' },
    { re: /instagram\s+do\s+(bruno|dr\.?\s*bruno)/i, s: 'Bruno' },
    { re: /instagram\s+do\s+(berto|dr\.?\s*berto|caballero)/i, s: 'Berto' },
    { re: /instagram\s+do\s+(iury|dr\.?\s*iury)/i, s: 'Iury' },
  ];
  for (const p of padroes) {
    if (p.re.test(textoCompleto)) {
      dados.origem = 'Instagram';
      dados.captacao = p.s;
      console.log('  Pagina de', p.s, 'detectada -> origem Instagram, captacao', p.s);
      break;
    }
  }

  // Fallback nome
  if (!dados.nome && contactName) {
    const nome = contactName.trim();
    if (!/^(cliente|do cliente|lead|nao identificado|null|teste)$/i.test(nome) && nome.length >= 3 && !/^\d+$/.test(nome)) {
      dados.nome = nome;
      console.log('  Usando nome do WA:', nome);
    }
  }

  // Criar deal
  const phone = row.phone || chatId;
  console.log('3. Buscando/criando contato...');
  const contactId = await buscarOuCriarContato(phone, dados.nome);
  console.log('   Contact ID:', contactId);

  console.log('4. Criando deal...');
  const payload = montarPayload(dados, contactId);
  try {
    const dealRes = await axios.post(MOSKIT_BASE + '/deals', payload, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: s => s < 300,
    });
    const dealId = dealRes.data.id;
    console.log('   Deal criado:', dealId);

    // Nota de briefing
    if (dados.resumo_atendimento) {
      await axios.post(MOSKIT_BASE + '/deals/' + dealId + '/notes', {
        description: '📋 Briefing pré-reunião\n\n' + dados.resumo_atendimento,
        user: { id: LAYLA_USER_ID },
      }, { headers: apiHeaders, validateStatus: s => s < 500 });
      console.log('   Nota adicionada');
    }

    // Atualizar banco
    db.prepare("UPDATE conversations SET deal_id=?, last_action='criar', processed=1, briefing_added=1, last_data=?, last_processed_at=datetime('now') WHERE chat_id=?").run(dealId, JSON.stringify(dados), chatId);
    console.log('   ✅ Concluido!');
  } catch (e) {
    console.error('   ERRO ao criar deal:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).substring(0,200) : e.message);
  }
}

// Main
async function main() {
  const chats = process.argv.slice(2);
  if (chats.length > 0) {
    for (const c of chats) {
      const row = db.prepare('SELECT contact_name FROM conversations WHERE chat_id = ?').get(c);
      await processarConversa(c, row?.contact_name || c);
    }
  } else {
    // Processar todas com last_action='criar' e sem deal_id
    const rows = db.prepare("SELECT chat_id, contact_name FROM conversations WHERE last_action='criar' AND deal_id IS NULL").all();
    console.log('Pendentes:', rows.length);
    for (const r of rows) {
      await processarConversa(r.chat_id, r.contact_name);
    }
  }
  console.log('\n=== FIM ===');
}

main().catch(e => console.error('FATAL:', e));
