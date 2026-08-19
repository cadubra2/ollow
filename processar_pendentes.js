// Processamento direto de conversas pendentes (sem depender do bot web)
// ATENCAO — este script NAO conhece o segundo atendimento (src/cliente-retorno.js). Ele escreve no
// negocio que estiver em conversations.deal_id, e a decisao de "cliente voltou com caso novo" vive
// dentro de processarConversaDirect. Religando uma conversa de cliente que ja foi atendido, confira
// antes se o deal_id da linha e o do atendimento ATUAL.

require('dotenv').config();
const https = require('https');
const Database = require('better-sqlite3');
const db = new Database('conversations.db');
const axios = require('axios');

const MOSKIT_BASE = 'https://api.moskitcrm.com/v2';
const API_KEY = process.env.MOSKIT_API_KEY;
const IDS = require('./src/moskit-ids');
const LAYLA_USER_ID = IDS.LAYLA_USER_ID;
const PRODUTO_CONSULTA_PAGA_ID = IDS.PRODUTO_CONSULTA_PAGA_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const apiHeaders = { apikey: API_KEY, 'Content-Type': 'application/json' };

// Tabelas de ID e a busca vem de src/moskit-ids.js \u2014 este arquivo mantinha copias, e copia de tabela de
// ID grava dado errado no CRM em silencio (foi o bug do 'direito empresarial' virando 'outros'). Este
// script escreve deal de verdade, entao tem que classificar exatamente como o bot.
const buscarIdOpcao = (indice, valor) => IDS.buscarOpcao(indice, valor);

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
  const push = (cfId, id) => { if (id) customFields.push({ id: cfId, options: [id] }); };

  push(IDS.CF.ORIGEM, buscarIdOpcao(IDS.INDICE_BUSCA.ORIGEM, dados.origem));
  push(IDS.CF.TIPO_CONSULTA, buscarIdOpcao(IDS.INDICE_BUSCA.TIPO_CONSULTA, dados.tipo_consulta));
  push(IDS.CF.CAPTACAO, buscarIdOpcao(IDS.INDICE_BUSCA.CAPTACAO, dados.captacao));

  // Responsavel DERIVADO da area, como no bot — nunca o palpite do modelo.
  const idArea = buscarIdOpcao(IDS.INDICE_BUSCA.AREA_DIREITO, dados.area_direito);
  push(IDS.CF.AREA_DIREITO, idArea);
  const advogadoDaArea = idArea ? IDS.ADVOGADO_POR_AREA_ID[idArea] : null;
  push(IDS.CF.RESPONSAVEL, buscarIdOpcao(IDS.INDICE_BUSCA.RESPONSAVEL_PROCESSO, advogadoDaArea));
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
- resumo_atendimento: briefing em secoes para o advogado: "📌 Caso: <o que aconteceu> | 📌 Objetivo do cliente: <o que ele quer> | 📌 Urgencia/prazo: <se houver> | 📌 Ja tentou: <se houver> | 📌 Pendencias: <o que falta combinar/enviar> | 📌 Documentos citados: <se houver>". Campo que nao apareceu na conversa sai "Nao mencionado.", nunca vazio nem chute.

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

    // Nota de briefing — MESMO formato (titulo versionado + hash) que registrarBriefing usa em
    // index.js, para a nota religada manualmente nunca sair com cara diferente da rotina normal.
    // Antes o titulo era hardcoded ("📋 Briefing pré-reunião", sem versao/data) e briefing_hash nunca
    // era gravado — o proximo ciclo real caia no ramo de migracao de registrarBriefing (que ADOTA o
    // hash do resumo atual sem repostar), quebrando a trilha de versoes v1/v2/v3 logo na primeira
    // nota religada manualmente.
    const briefingLib = require('./src/briefing');
    let briefingHash = null;
    let briefingVersao = null;
    if (dados.resumo_atendimento) {
      const texto = briefingLib.montarTextoBriefing({
        dados,
        contato: contactName,
        telefone: phone || chatId,
        horarioConsulta: null,
      });
      if (texto) {
        // Deal recem-criado por este script: sempre v1, o mesmo que registrarBriefing produziria pra
        // um deal novo (atual?.briefing_versao ausente).
        const dataFormatada = new Intl.DateTimeFormat('pt-BR', {
          timeZone: process.env.TZ_ESCRITORIO || 'America/Fortaleza',
          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date());
        const titulo = `📋 Briefing · v1 · ${dataFormatada}`;
        await axios.post(MOSKIT_BASE + '/deals/' + dealId + '/notes', {
          description: titulo + '\n\n' + texto + '\n\n' + briefingLib.MARCADOR_BRIEFING,
          user: { id: LAYLA_USER_ID },
        }, { headers: apiHeaders, validateStatus: s => s < 500 });
        briefingHash = briefingLib.hashTextoBriefing(texto);
        briefingVersao = 1;
        console.log('   Nota adicionada:', titulo);
      } else {
        console.log('   Sem conteudo de briefing — nota nao adicionada');
      }
    }

    // Atualizar banco — grava briefing_hash/briefing_versao junto com briefing_added, para o proximo
    // ciclo real de registrarBriefing comparar contra o texto REALMENTE postado aqui, nao adotar um
    // hash as cegas.
    db.prepare("UPDATE conversations SET deal_id=?, last_action='criar', processed=1, briefing_added=1, briefing_hash=?, briefing_versao=?, last_data=?, last_processed_at=datetime('now') WHERE chat_id=?").run(dealId, briefingHash, briefingVersao, JSON.stringify(dados), chatId);
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
