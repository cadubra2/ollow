require('dotenv').config();

const axios = require('axios');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const API_KEY = process.env.MOSKIT_API_KEY;
const BASE = 'https://api.moskitcrm.com/v2';
const LAYLA = 90607;

// ==============================
// UTILS (copiado do index.js)
// ==============================

// Tabelas de ID e busca vem de src/moskit-ids.js. Aqui vivia a copia que gravou deal errado no CRM de
// verdade: 'direito empresarial' apontava para 235234, que e o ID de "Outros". Este script faz
// POST /deals real, entao classificar diferente do bot nao e detalhe de teste \u2014 e dado errado no CRM.
const IDS = require('./src/moskit-ids');
const MAP_ORIGEM = IDS.INDICE_BUSCA.ORIGEM;
const MAP_TIPO = IDS.INDICE_BUSCA.TIPO_CONSULTA;
const MAP_CAPTACAO = IDS.INDICE_BUSCA.CAPTACAO;
const MAP_AREA = IDS.INDICE_BUSCA.AREA_DIREITO;
const MAP_RESP = IDS.INDICE_BUSCA.RESPONSAVEL_PROCESSO;

const buscarId = (indice, valor) => IDS.buscarOpcao(indice, valor);

async function chamarOpenAI(historico, temDeal, dadosAnteriores) {
  const pendentes = dadosAnteriores
    ? ['origem', 'tipo_consulta', 'area_direito', 'advogado_responsavel'].filter(k => !dadosAnteriores[k] || dadosAnteriores[k] === 'null')
    : [];
  const prompt = `Analise a conversa completa abaixo e decida qual acao tomar. Retorne APENAS um JSON valido.

CONTEXTO ATUAL:
- Deal ja existe no CRM: ${temDeal ? 'sim' : 'nao'}
- Dados ja extraidos anteriormente: ${dadosAnteriores ? JSON.stringify(dadosAnteriores) : `{ "pendentes": "${pendentes.join(', ')}" }`}

REGRAS DE DECISAO:
- "aguardar": lead AINDA NAO marcou/confirmou consulta.
- "criar": lead JA DEMONSTROU interesse em contratar E marcou/agendou consulta.
- "nota": deal JA EXISTE + TODOS os campos obrigatorios preenchidos. So adicione nota.
- "atualizar_campos": deal JA EXISTE + algum campo obrigatorio pendente.

CAMPOS OBRIGATORIOS: origem, tipo_consulta (padrao "consulta paga"), area_direito, advogado_responsavel.
captacao PODE ser null. pagamento_confirmado boolean (true se pagou).

Formato:
{
  "acao": "aguardar | criar | nota | atualizar_campos",
  "justificativa": "...",
  "dados": {
    "nome": "...",
    "assunto": "...",
    "origem": "Nao identificado",
    "advogado_responsavel": "...",
    "captacao": null,
    "tipo_consulta": "consulta paga",
    "area_direito": "...",
    "amigos_do_escritorio": null,
    "pagamento_confirmado": false,
    "resumo_atendimento": "..."
  }
}

PERFIS DOS ADVOGADOS:
1. Berto — Direito Digital (LGPD, crimes digitais) e Direito Administrativo
2. Bruno — Direito Imobiliario e Direito de Familia (divorcio, guarda, alimentos, inventario)
3. Iury — Direito Medico e da Saude

Conversa:
${historico}`;

  const r = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: 'Voce analisa conversas de escritorio de advocacia. Responda apenas JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  return JSON.parse(r.choices[0].message.content);
}

function montarPayload(dados, contactId) {
  const cf = [];
  const o = buscarId(MAP_ORIGEM, dados.origem); if (o) cf.push({ id:'CF_GwyMgWiEi7E0LMLA', options:[o] });
  const t = buscarId(MAP_TIPO, dados.tipo_consulta); if (t) cf.push({ id:'CF_Pj3qYeidir3ArqQe', options:[t] });
  const c = buscarId(MAP_CAPTACAO, dados.captacao); if (c) cf.push({ id:'CF_2wpDlkieioO8dmvL', options:[c] });
  const a = buscarId(MAP_AREA, dados.area_direito); if (a) cf.push({ id:'CF_6rRmwei9i6aZpq4X', options:[a] });
  // Responsavel DERIVADO da area (regra do escritorio), igual ao bot — nao o que o modelo sugeriu.
  const r = buscarId(MAP_RESP, a ? IDS.ADVOGADO_POR_AREA_ID[a] : null); if (r) cf.push({ id:'CF_vG0mR0iwik846qbV', options:[r] });
  return {
    name: dados.assunto ? `${dados.nome} - ${dados.assunto}` : dados.nome,
    status: 'OPEN',
    stage: { id: Number(process.env.MOSKIT_STAGE_ID) || 179388 },
    createdBy: { id: LAYLA },
    responsible: { id: LAYLA },
    contacts: [{ id: contactId }],
    entityCustomFields: cf,
    price: 35000,
    dealProducts: [{ product: { id: 75739 }, quantity: 1, price: 0, initialPrice: 0, finalPrice: 0 }],
  };
}

async function buscarOuCriarContato(phone, name) {
  const { data } = await axios.get(`${BASE}/contacts`, { params: { page: 1, sort: 'id', order: 'desc' }, headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  const contatos = Array.isArray(data) ? data : [];
  const found = contatos.find(c => (c.phones || []).some(p => String(p.number).replace(/\D/g, '').includes(phone.replace(/\D/g, ''))));
  if (found) return found.id;
  const cr = await axios.post(`${BASE}/contacts`, { name: name || 'Teste', createdBy: { id: LAYLA }, responsible: { id: LAYLA }, phones: [{ number: phone }] }, { headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  return cr.data.id;
}

async function criarDeal(dados, contactId) {
  const r = await axios.post(`${BASE}/deals`, montarPayload(dados, contactId), { headers: { apikey: API_KEY, 'X-Ollow-Origin': 'BOT_TEST' }, validateStatus: s => s < 500 });
  return r.data;
}

async function adicionarNota(dealId, texto) {
  const r = await axios.post(`${BASE}/deals/${dealId}/notes`, { description: texto, user: { id: LAYLA } }, { headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  return r.data;
}

async function listarNotas(dealId) {
  const r = await axios.get(`${BASE}/deals/${dealId}/notes`, { headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  return Array.isArray(r.data) ? r.data : [];
}

async function moverParaEstagio(dealId, stageId) {
  const getRes = await axios.get(`${BASE}/deals/${dealId}`, { headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  const dealAtual = getRes.data;
  dealAtual.stage = { id: stageId };
  await axios.put(`${BASE}/deals/${dealId}`, dealAtual, { headers: { apikey: API_KEY }, validateStatus: s => s < 500 });
  console.log(`  ✅ Deal ${dealId} movido para stage ${stageId}`);
}

function contarBriefings(notas) {
  return notas.filter(n => n.description && n.description.includes('Briefing')).length;
}

// ==============================
// TESTE PRINCIPAL
// ==============================
async function main() {
  const TEST_PHONE = '5511999999199'; // telefone exclusivo para teste
  const PESSOA = { nome: 'Maria Teste', assunto: 'Divórcio' };

  console.log('============================================');
  console.log('  TESTE: BRIEFING ADICIONADO UMA UNICA VEZ');
  console.log('============================================\n');

  // 1. Criar contato + deal
  console.log('--- PASSO 1: Criar contato e deal ---');
  const contactId = await buscarOuCriarContato(TEST_PHONE, PESSOA.nome);
  console.log(`  Contato: ${contactId}`);

  const msgsFase1 = [
    { role: 'cliente', text: 'Bom dia, meu nome é Maria' },
    { role: 'cliente', text: 'Quero dar entrada no divórcio' },
    { role: 'cliente', text: 'Meu marido concorda, é amigável' },
    { role: 'cliente', text: 'Quero marcar a consulta, pode ser amanhã?' },
  ];
  const hist1 = msgsFase1.map(m => `${m.role}: ${m.text}`).join('\n');
  const r1 = await chamarOpenAI(hist1, false, null);
  console.log(`  IA: ${r1.acao} — ${r1.justificativa}`);

  if (r1.acao !== 'criar') { console.log('  ❌ IA nao decidiu criar'); return; }

  const deal = await criarDeal(r1.dados, contactId);
  console.log(`  Deal criado: ${deal.id}`);

  let briefingAdded = false; // nosso "briefing_added" local

  if (r1.dados.resumo_atendimento && !briefingAdded) {
    await adicionarNota(deal.id, `📋 Briefing pré-reunião\n\n${r1.dados.resumo_atendimento}`);
    briefingAdded = true;
    console.log('  ✅ Briefing adicionado (1a vez)');
  }

  let notas = await listarNotas(deal.id);
  let qtdBriefings = contarBriefings(notas);
  console.log(`  Notas no deal: ${notas.length} | Briefings: ${qtdBriefings}\n`);

  // 2. Simular segunda mensagem (pagamento)
  console.log('--- PASSO 2: Nova mensagem (pagamento) ---');
  const msgsFase2 = [
    ...msgsFase1,
    { role: 'cliente', text: 'Ja fiz o Pix de 97 reais' },
  ];
  const hist2 = msgsFase2.map(m => `${m.role}: ${m.text}`).join('\n');
  const r2 = await chamarOpenAI(hist2, true, r1.dados);
  console.log(`  IA: ${r2.acao} — ${r2.justificativa}`);
  console.log(`  pagamento_confirmado: ${r2.dados.pagamento_confirmado}`);

  // Verificar se BRIEFING nao foi adicionado de novo
  if (r2.dados.resumo_atendimento && !briefingAdded) {
    await adicionarNota(deal.id, `📋 Briefing atualizado\n\n${r2.dados.resumo_atendimento}`);
    briefingAdded = true;
    console.log('  ❌ Briefing foi adicionado DE NOVO (bug)');
  } else if (r2.dados.resumo_atendimento && briefingAdded) {
    console.log('  ✅ Briefing NAO foi adicionado (briefing_added = true)');
  } else {
    console.log('  ⏭️  Sem resumo para briefing');
  }

  if (r2.dados.pagamento_confirmado === true || r2.dados.pagamento_confirmado === 'true') {
    console.log('  💳 Pagamento confirmado, movendo deal...');
    await moverParaEstagio(deal.id, 184382);
    await adicionarNota(deal.id, `💳 Pagamento confirmado — deal movido para Consulta Agendada`);
    console.log('  ✅ Deal movido para Consulta Agendada');
  }

  // 3. Verificar resultado final
  notas = await listarNotas(deal.id);
  qtdBriefings = contarBriefings(notas);
  console.log(`\n--- RESULTADO FINAL ---`);
  console.log(`  Total de notas: ${notas.length}`);
  console.log(`  Notas de briefing: ${qtdBriefings}`);

  if (qtdBriefings === 1) {
    console.log(`\n  🟢 TESTE PASSOU: Briefing apareceu apenas 1 vez!`);
  } else {
    console.log(`\n  🔴 TESTE FALHOU: Briefing apareceu ${qtdBriefings} vezes`);
  }

  console.log(`\n  Link: https://app.moskitcrm.com/deals/${deal.id}`);
  console.log('============================================\n');
}

main().catch(err => {
  console.error('\n❌ Erro:', err.message);
  if (err.response) console.error('  Resposta:', JSON.stringify(err.response.data));
  process.exit(1);
});
