// COLETOR do diagnostico do CRM. E a UNICA coisa desta auditoria que toca a API do Moskit — e nao
// escreve absolutamente nada, em lugar nenhum.
//
//   node auditar-crm-coletar.js                       # fases A (deals), B (contatos), C (atividades)
//   node auditar-crm-coletar.js --confirmar            # inclui a fase D (notas), a mais cara
//   node auditar-crm-coletar.js --retomar=<dir>        # continua um snapshot interrompido
//   node auditar-crm-coletar.js --so-fases=A,C         # roda so as fases pedidas
//   node auditar-crm-coletar.js --notas-max=400 --notas-paginas=2
//
// NAO EXISTE FLAG --aplicar NESTE ARQUIVO, DE PROPOSITO. Nao escreve no CRM (o interceptor de metodo
// abaixo LANCA em qualquer requisicao que nao seja GET) nem no conversations.db de producao (aberto
// readonly; o require do index.js recebe um DB_PATH descartavel em tmpdir, porque o boot dele roda
// ALTER TABLE no banco que DB_PATH aponta).
//
// POR QUE ELE E SEPARADO DO RELATORIO: a varredura completa custa ~1.260 requisicoes e ~20 minutos.
// O corte de "deal parado" ainda nao foi fixado pelo dono e os limiares de similaridade de nome/caso
// sao calibraveis. Num script unico, cada ajuste de limiar custaria outra varredura inteira;
// separado, custa os poucos segundos de rodar auditar-crm-relatar.js sobre o snapshot que ja esta no
// disco. Uma varredura, todos os relatorios.
//
// O snapshot guarda o objeto CRU da API, uma linha por registro (JSONL, append-only: crash nao
// corrompe e a retomada e um cursor no manifesto). Nao e projecao de proposito — pergunta nova se
// responde offline, relendo o arquivo, em vez de com uma varredura nova.
//
// NUNCA rodar em CI nem no npm test — fala com a conta de producao.
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const arg = (nome, padrao) => {
  const achado = process.argv.find((a) => a.startsWith(`${nome}=`));
  return achado ? achado.slice(nome.length + 1) : padrao;
};
const tem = (nome) => process.argv.includes(nome);

const OPCOES = {
  retomar: arg('--retomar', ''),
  confirmar: tem('--confirmar'),
  soFases: String(arg('--so-fases', 'A,B,C,D')).toUpperCase().split(',').map((f) => f.trim()).filter(Boolean),
  notasMax: Number(arg('--notas-max', 400)) || 400,
  notasPaginas: Number(arg('--notas-paginas', 2)) || 2,
  maxPaginasDeals: Number(arg('--max-paginas-deals', 500)) || 500,
  maxPaginasContatos: Number(arg('--max-paginas-contatos', 600)) || 600,
};

// ------------------------------------------------------------------------------------------------
// As protecoes do molde canonico (avaliar-extracao.js:38-47), ANTES do require('./index.js').
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `auditar-crm-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
// Credenciais de ESCRITA apontadas para o nada. MOSKIT_BASE/MOSKIT_API_KEY ficam REAIS de proposito
// — ler a conta e o trabalho deste script. O que impede escrita aqui e o interceptor de metodo, nao
// uma base falsa.
process.env.ZAPSIGN_BASE = 'http://127.0.0.1:9';
if (process.env.ZAPSIGN_API_KEY) process.env.ZAPSIGN_API_KEY = 'SENTINELA-AUDITORIA';
// Teto de paginas por deal na busca de notas. index.js le NOTAS_MAX_PAGINAS_BUSCA no momento do
// require, entao precisa estar definido ANTES dele: a fase D reusa acharEmColecaoDoDeal e esse teto
// e o que segura o custo da fase mais cara.
process.env.NOTAS_MAX_PAGINAS_BUSCA = String(OPCOES.notasPaginas);
// ------------------------------------------------------------------------------------------------

const axios = require('axios');
const Database = require('better-sqlite3');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
// Piso de ritmo: nunca mais rapido que a pausa que a producao ja usa (RECONCILIACAO_PAUSA_MS=300).
const PISO_MS = Number(process.env.AUDITORIA_PISO_MS) || 300;
const MAX_TENTATIVAS_429 = 5;

// ================================================================================================
// TRAVA DE ESCRITA + RITMO
//
// Os dois moram no mesmo interceptor do axios, e ele e instalado ANTES do require('./index.js') de
// proposito: `require('axios')` devolve sempre a MESMA instancia default, entao a trava e o ritmo
// valem tambem para as chamadas que saem de dentro do index.js (acharEmColecaoDoDeal,
// listarAtividadesMoskit), que este script reusa. Uma protecao que so cobrisse o axios daqui seria
// uma protecao com buraco exatamente onde o codigo reusado passa.
//
// Ler os headers de rate limit e feito NESTE script, nao retrofitado no index.js: as pausas de
// producao convivem com maquinas de backoff proprias (vinculo_backoff_ate, notas, reconciliacao) e
// mexer nelas e risco de outra natureza. Aqui o registro serve de EVIDENCIA — o manifesto guarda o
// minimo observado de cada janela, e e isso que vai dizer depois se vale a pena a producao ler os
// headers tambem.
// ================================================================================================
const RITMO = {
  requisicoes: 0,
  http_429: 0,
  min_remaining_second: null,
  min_remaining_minute: null,
  limite_segundo: null,
  limite_minuto: null,
  esperas_janela_segundo: 0,
  esperas_janela_minuto: 0,
  // Ultimo valor visto, usado para decidir a proxima espera (e zerado depois de esperar).
  ultimo_remaining_second: null,
  ultimo_remaining_minute: null,
  ultimo_reset_segundo: null,
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let ultimaRequisicaoEm = 0;

function numeroDeHeader(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function registrarHeaders(headers) {
  if (!headers) return;
  const rs = numeroDeHeader(headers['x-ratelimit-remaining-second']);
  const rm = numeroDeHeader(headers['x-ratelimit-remaining-minute']);
  const ls = numeroDeHeader(headers['x-ratelimit-limit-second']);
  const lm = numeroDeHeader(headers['x-ratelimit-limit-minute']);
  const reset = numeroDeHeader(headers['ratelimit-reset']);

  if (rs !== null) {
    RITMO.ultimo_remaining_second = rs;
    if (RITMO.min_remaining_second === null || rs < RITMO.min_remaining_second) RITMO.min_remaining_second = rs;
  }
  if (rm !== null) {
    RITMO.ultimo_remaining_minute = rm;
    if (RITMO.min_remaining_minute === null || rm < RITMO.min_remaining_minute) RITMO.min_remaining_minute = rm;
  }
  if (ls !== null) RITMO.limite_segundo = ls;
  if (lm !== null) RITMO.limite_minuto = lm;
  if (reset !== null) RITMO.ultimo_reset_segundo = reset;
}

async function aguardarVez() {
  const desdeUltima = Date.now() - ultimaRequisicaoEm;
  if (desdeUltima < PISO_MS) await dormir(PISO_MS - desdeUltima);

  // Janela do SEGUNDO no fim: dorme ate ela virar. `ratelimit-reset` vem em segundos.
  if (RITMO.ultimo_remaining_second !== null && RITMO.ultimo_remaining_second <= 1) {
    RITMO.esperas_janela_segundo += 1;
    await dormir((RITMO.ultimo_reset_segundo || 1) * 1000 + 100);
    RITMO.ultimo_remaining_second = null;
  }

  // Janela do MINUTO no fim. A API nao expoe quando essa janela reinicia (`ratelimit-reset` acompanha
  // a do segundo), entao dormir ate o proximo minuto do relogio e uma APROXIMACAO — declarada aqui
  // porque medicao com limite escondido e pior que nenhuma. Na pratica quase nunca dispara: o piso de
  // 300ms sustenta ~200 req/min, abaixo do teto de 240.
  if (RITMO.ultimo_remaining_minute !== null && RITMO.ultimo_remaining_minute <= 10) {
    RITMO.esperas_janela_minuto += 1;
    const restoDoMinuto = (60 - new Date().getSeconds()) * 1000 + 200;
    console.log(`   ⏸️ cota do minuto quase no fim (${RITMO.ultimo_remaining_minute} restantes) — pausando ~${Math.round(restoDoMinuto / 1000)}s`);
    await dormir(restoDoMinuto);
    RITMO.ultimo_remaining_minute = null;
  }

  ultimaRequisicaoEm = Date.now();
}

axios.interceptors.request.use(async (config) => {
  const metodo = String(config.method || 'get').toLowerCase();
  if (metodo !== 'get') {
    // A garantia REAL de zero escrita: nao depende de alguem reler o codigo procurando `.post(`.
    throw new Error(
      `TRAVA DE ESCRITA: ${metodo.toUpperCase()} ${config.baseURL || ''}${config.url} bloqueado — auditar-crm-coletar.js e somente leitura`
    );
  }
  await aguardarVez();
  RITMO.requisicoes += 1;
  return config;
});

// 429 -> backoff 1/2/4/8/16s retentando a MESMA pagina. Nunca avancar o cursor num 429: avancar
// pularia 10 registros em silencio, e um relatorio que perde 10 deals sem avisar e pior que um
// relatorio que nao roda.
async function retentar429(config) {
  RITMO.http_429 += 1;
  const tentativa = (config.__tentativas429 || 0) + 1;
  if (tentativa > MAX_TENTATIVAS_429) {
    throw new Error(`HTTP 429 persistente depois de ${MAX_TENTATIVAS_429} tentativas em ${config.url}`);
  }
  config.__tentativas429 = tentativa;
  const espera = 1000 * 2 ** (tentativa - 1);
  console.log(`   ⏳ HTTP 429 — tentativa ${tentativa}/${MAX_TENTATIVAS_429}, aguardando ${espera / 1000}s e repetindo A MESMA pagina`);
  await dormir(espera);
  return axios(config);
}

axios.interceptors.response.use(
  (res) => {
    registrarHeaders(res.headers);
    // O codigo reusado do index.js usa `validateStatus: (s) => s < 500`, entao um 429 chega aqui pelo
    // caminho de SUCESSO, nao pelo de erro. Tratar so no handler de erro deixaria o 429 passar como
    // resposta valida com corpo vazio.
    if (res.status === 429) return retentar429(res.config);
    return res;
  },
  (erro) => {
    if (erro.response) {
      registrarHeaders(erro.response.headers);
      if (erro.response.status === 429) return retentar429(erro.config);
    }
    throw erro;
  }
);

// Depois dos interceptores, nunca antes.
const bot = require('./index.js');
const MOSKIT_IDS = require('./src/moskit-ids');
const duplicidade = require('./src/duplicidade');

// ================================================================================================
// SNAPSHOT
// ================================================================================================
const RAIZ = process.env.AUDITORIA_DIR || 'auditoria-crm';
const VERSAO_SNAPSHOT = 1;

function prepararDiretorio() {
  if (OPCOES.retomar) {
    if (!fs.existsSync(path.join(OPCOES.retomar, 'manifesto.json'))) {
      throw new Error(`--retomar=${OPCOES.retomar} nao tem manifesto.json — nao e um snapshot desta auditoria`);
    }
    return OPCOES.retomar;
  }
  const dir = path.join(RAIZ, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.join(dir, 'notas'), { recursive: true });
  return dir;
}

function anexar(dir, arquivo, objetos) {
  if (!objetos.length) return;
  fs.appendFileSync(path.join(dir, arquivo), `${objetos.map((o) => JSON.stringify(o)).join('\n')}\n`, 'utf8');
}

function lerJsonl(dir, arquivo) {
  const p = path.join(dir, arquivo);
  if (!fs.existsSync(p)) return [];
  const linhas = [];
  for (const linha of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    try { linhas.push(JSON.parse(linha)); } catch { /* linha truncada por crash: ignora, o cursor do manifesto e a fonte */ }
  }
  return linhas;
}

function registrarErro(dir, entrada) {
  anexar(dir, 'erros.jsonl', [{ quando: new Date().toISOString(), ...entrada }]);
  console.log(`   ❌ ${entrada.fase || '?'}: ${entrada.erro}`);
}

function manifestoNovo() {
  return {
    versao: VERSAO_SNAPSHOT,
    script: 'auditar-crm-coletar.js',
    argv: process.argv.slice(2),
    inicio: new Date().toISOString(),
    fim: null,
    moskit_base: MOSKIT_BASE,
    // Quirks MEDIDOS nesta rodada, nao herdados de comentario. Quem le o snapshot depois precisa
    // saber o que era verdade no dia da coleta.
    quirks: {
      ordem_paginacao_deals: 'asc',
      tamanho_pagina_deals_observado: null,
      tamanho_pagina_contatos_observado: null,
      contatos_respeitam_limit_100: null,
      headers_rate_limit_presentes: null,
    },
    rate_limit: null,
    fases: {
      A: { nome: 'deals', status: 'pendente', cursor: 0, unicos: 0, repetidos: 0, paginas: 0, truncou: false },
      B: { nome: 'contatos', status: 'pendente', proximo_page_token: '', unicos: 0, paginas: 0, truncou: false, token_expirou: false },
      C: { nome: 'atividades', status: 'pendente', unicos: 0, truncou: false },
      D: { nome: 'notas', status: 'pendente', candidatos: 0, coletados: 0, truncados: 0 },
    },
  };
}

let DIR = '';
let MANIFESTO = null;
const salvarManifesto = () => fs.writeFileSync(path.join(DIR, 'manifesto.json'), JSON.stringify(MANIFESTO, null, 2), 'utf8');

async function get(rota, params) {
  const res = await axios.get(`${MOSKIT_BASE}${rota}`, { params, headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (res.status < 200 || res.status >= 300) {
    const erro = new Error(`GET ${rota} devolveu HTTP ${res.status}`);
    erro.status = res.status;
    throw erro;
  }
  return res;
}

const dedupePorId = (registros) => {
  const vistos = new Set();
  return registros.filter((r) => (vistos.has(r.id) ? false : (vistos.add(r.id), true)));
};

// ================================================================================================
// FASE 0 — metadados da conta
//
// Puxados da CONTA, nunca hardcodados. O motivo e concreto: `CF_y5lm56iyiY7rKDwW` ("Tipo de acao de
// massa", modulo DEAL) existe e esta ATIVO no CRM, e nao aparece em nenhuma linha do codigo deste
// projeto — src/moskit-ids.js conhece 5 campos, a conta tem 7. Se o coletor hardcodasse a lista,
// reportaria "vazio em quase todo deal" como defeito, quando o esperado e exatamente isso: o bot
// nunca escreve nesse campo. Se ele DEVE ser obrigatorio e decisao do dono, e so depois entra em
// moskit-ids.js.
//
// /pipelines e /stages entram pelo mesmo motivo: o deal traz so `stage: {id}` (sem pipeline), e
// MOSKIT_IDS.STAGE conhece 7 dos 9 stages da conta — nao conhece nenhum dos dois do funil "Consulta
// Juridica" (93725). Com /stages o relatorio rotula stage e funil sem inventar nome.
// ================================================================================================
async function faseMetadados() {
  console.log('\n📋 Fase 0 — metadados da conta (campos personalizados, funis, stages, usuarios)');
  const campos = (await get('/customFields')).data;
  fs.writeFileSync(path.join(DIR, 'campos-personalizados.json'), JSON.stringify(campos, null, 2), 'utf8');

  const pipelines = (await get('/pipelines')).data;
  const stages = (await get('/stages')).data;
  let usuarios = [];
  try {
    usuarios = (await get('/users')).data;
  } catch (e) {
    registrarErro(DIR, { fase: '0', rota: '/users', erro: e.message });
  }
  fs.writeFileSync(
    path.join(DIR, 'metadados-conta.json'),
    JSON.stringify({ pipelines, stages, usuarios }, null, 2),
    'utf8'
  );

  const conhecidos = new Set(Object.values(MOSKIT_IDS.CF));
  const desconhecidos = campos.filter((c) => !conhecidos.has(c.id));
  const stagesConhecidos = new Set(Object.values(MOSKIT_IDS.STAGE));
  const stagesDesconhecidos = stages.filter((s) => !stagesConhecidos.has(s.id));

  MANIFESTO.metadados = {
    campos_personalizados: campos.length,
    campos_que_o_codigo_nao_conhece: desconhecidos.map((c) => ({ id: c.id, nome: c.name, modulo: c.module, ativo: c.active })),
    pipelines: pipelines.map((p) => ({ id: p.id, nome: p.name })),
    stages: stages.length,
    stages_que_o_codigo_nao_conhece: stagesDesconhecidos.map((s) => ({ id: s.id, nome: s.name, pipeline: s.pipeline?.id })),
    usuarios: usuarios.map((u) => ({ id: u.id, nome: u.name, ativo: u.active })),
  };
  MANIFESTO.quirks.headers_rate_limit_presentes = RITMO.limite_segundo !== null;

  console.log(`   ${campos.length} campo(s) personalizado(s), ${pipelines.length} funil(is), ${stages.length} stage(s), ${usuarios.length} usuario(s)`);
  if (desconhecidos.length) {
    console.log(`   ⚠️ ${desconhecidos.length} campo(s) personalizado(s) que o CODIGO nao conhece (nao entram em moskit-ids.js sem decisao do dono):`);
    for (const c of desconhecidos) console.log(`      ${c.id}  ${c.module}  "${c.name}"${c.active ? '' : ' (inativo)'}`);
  }
  if (stagesDesconhecidos.length) {
    console.log(`   ℹ️ ${stagesDesconhecidos.length} stage(s) fora de MOSKIT_IDS.STAGE — o relatorio usa o nome vindo da conta`);
  }
  salvarManifesto();
}

// ================================================================================================
// FASE A — deals
//
// Uma CORRECAO de paginacao em relacao aos estudos que ja existem: estudar-deals-sem-origem.js:142 e
// estudar-deals-duplicados.js:348 paginam com `sort:'id', order:'desc'`. Numa varredura de 5+ minutos
// isso PERDE deal em silencio — `?start=` e offset, nao cursor: cada deal novo criado durante a
// varredura empurra a lista uma posicao e a pagina seguinte pula um registro. Com `order:'asc'` o
// deal novo cai no FIM, depois do cursor. O dedupe por id fica como rede, nao como conserto.
// ================================================================================================
async function faseDeals() {
  const fase = MANIFESTO.fases.A;
  console.log(`\n📦 Fase A — deals (${fase.cursor ? `retomando de start=${fase.cursor}` : 'do inicio'}, pagina de 10, order=asc)`);

  const idsVistos = new Set(lerJsonl(DIR, 'deals.jsonl').map((d) => d.id));
  fase.status = 'rodando';

  let paginas = 0;
  while (paginas < OPCOES.maxPaginasDeals) {
    let lote;
    try {
      lote = (await get('/deals', { start: fase.cursor, sort: 'id', order: 'asc' })).data;
    } catch (e) {
      fase.status = 'interrompida';
      registrarErro(DIR, { fase: 'A', cursor: fase.cursor, erro: e.message });
      salvarManifesto();
      throw e;
    }
    lote = Array.isArray(lote) ? lote : [];
    if (MANIFESTO.quirks.tamanho_pagina_deals_observado === null && lote.length) {
      MANIFESTO.quirks.tamanho_pagina_deals_observado = lote.length;
    }

    const novos = lote.filter((d) => !idsVistos.has(d.id));
    for (const d of novos) idsVistos.add(d.id);
    fase.repetidos += lote.length - novos.length;
    anexar(DIR, 'deals.jsonl', novos);

    fase.cursor += lote.length;
    fase.unicos = idsVistos.size;
    paginas += 1;
    fase.paginas += 1;

    if (paginas % 25 === 0) {
      salvarManifesto();
      console.log(`   ... ${fase.paginas} pagina(s), ${fase.unicos} deal(s) unico(s)`);
    }
    if (lote.length < 10) break; // pagina incompleta = fim da lista
    if (paginas === OPCOES.maxPaginasDeals) fase.truncou = true;
  }

  fase.status = fase.truncou ? 'truncada' : 'completa';
  if (fase.truncou) console.log(`   ⚠️ teto de ${OPCOES.maxPaginasDeals} paginas atingido — pode haver deal alem do que foi lido`);
  if (fase.repetidos) console.log(`   ℹ️ ${fase.repetidos} registro(s) repetido(s) entre paginas (a conta mudou durante a varredura) — descartados`);
  console.log(`   ✅ ${fase.unicos} deal(s) em ${fase.paginas} pagina(s)`);
  salvarManifesto();
}

// ================================================================================================
// FASE B — contatos
//
// O unico endpoint com paginacao DIFERENTE: cursor no header `x-moskit-listing-next-page-token`, e
// nao `?start=`. A incognita do plano ("sera que /contacts e o unico que respeita limit=100?") foi
// MEDIDA em 02/09/2026: nao respeita — `limit=100` devolve 10, como todo o resto. O parametro fica
// no codigo so para o dia em que a API mudar; `tamanho_pagina_contatos_observado` no manifesto e o
// que diz a verdade da rodada.
// ================================================================================================
async function faseContatos() {
  const fase = MANIFESTO.fases.B;
  console.log(`\n👥 Fase B — contatos (${fase.proximo_page_token ? 'retomando do pageToken salvo' : 'do inicio'}, cursor por header)`);

  const idsVistos = new Set(lerJsonl(DIR, 'contacts.jsonl').map((c) => c.id));
  fase.status = 'rodando';

  let token = fase.proximo_page_token || '';
  let paginas = 0;
  let tentouReiniciar = false;

  while (paginas < OPCOES.maxPaginasContatos) {
    const params = { limit: 100 };
    if (token) params.nextPageToken = token;

    let res;
    try {
      res = await get('/contacts', params);
    } catch (e) {
      // Token de pagina expira. Reiniciar a fase e honesto e barato (os ids ja escritos deduplicam);
      // continuar de um cursor invalido produziria um relatorio silenciosamente incompleto.
      if (token && !tentouReiniciar && e.status >= 400 && e.status < 500) {
        tentouReiniciar = true;
        fase.token_expirou = true;
        token = '';
        console.log(`   ⚠️ pageToken invalido/expirado (HTTP ${e.status}) — reiniciando a fase B do inicio; o dedupe por id cobre o que ja foi lido`);
        continue;
      }
      fase.status = 'interrompida';
      registrarErro(DIR, { fase: 'B', page_token: token, erro: e.message });
      salvarManifesto();
      throw e;
    }

    const lote = Array.isArray(res.data) ? res.data : [];
    if (MANIFESTO.quirks.tamanho_pagina_contatos_observado === null && lote.length) {
      MANIFESTO.quirks.tamanho_pagina_contatos_observado = lote.length;
      MANIFESTO.quirks.contatos_respeitam_limit_100 = lote.length > 10;
    }
    if (!lote.length) break;

    const novos = lote.filter((c) => !idsVistos.has(c.id));
    for (const c of novos) idsVistos.add(c.id);
    anexar(DIR, 'contacts.jsonl', novos);

    token = res.headers['x-moskit-listing-next-page-token'] || res.headers['x-ollow-listing-next-page-token'] || '';
    fase.proximo_page_token = token;
    fase.unicos = idsVistos.size;
    paginas += 1;
    fase.paginas += 1;

    if (paginas % 50 === 0) {
      salvarManifesto();
      console.log(`   ... ${fase.paginas} pagina(s), ${fase.unicos} contato(s)`);
    }
    if (!token) break; // sem proximo token = fim da lista
    if (paginas === OPCOES.maxPaginasContatos) fase.truncou = true;
  }

  fase.status = fase.truncou ? 'truncada' : 'completa';
  if (fase.truncou) console.log(`   ⚠️ teto de ${OPCOES.maxPaginasContatos} paginas atingido — pode haver contato alem do que foi lido`);
  console.log(`   ✅ ${fase.unicos} contato(s) em ${fase.paginas} pagina(s)`);
  salvarManifesto();
}

// ================================================================================================
// FASE C — atividades
//
// Reusa listarAtividadesMoskit (index.js) em vez de repaginar: e ela que sabe que /activities pagina
// por `?start=` e que o header `x-moskit-listing-total` e mentiroso (dizia 1165 numa base cuja
// varredura completa devolveu 190 unicos). O ritmo e a trava valem para ela tambem, porque o
// interceptor esta na instancia default do axios, que e a que o index.js usa.
// ================================================================================================
async function faseAtividades() {
  const fase = MANIFESTO.fases.C;
  console.log('\n📅 Fase C — atividades (via listarAtividadesMoskit, do index.js)');
  fase.status = 'rodando';

  // Idempotente por reescrita: a rotina do index.js nao aceita cursor de retomada, entao a fase toda
  // roda de novo e o arquivo e reescrito. Sao ~20-120 requisicoes, barato o suficiente para nao
  // valer um cursor proprio.
  const arquivo = path.join(DIR, 'activities.jsonl');
  if (fs.existsSync(arquivo)) fs.rmSync(arquivo);

  let resultado;
  try {
    resultado = await bot.listarAtividadesMoskit(Number(process.env.MAX_PAGINAS_ATIVIDADES) || 120);
  } catch (e) {
    fase.status = 'interrompida';
    registrarErro(DIR, { fase: 'C', erro: e.message });
    salvarManifesto();
    throw e;
  }

  const unicas = dedupePorId(resultado.atividades || []);
  anexar(DIR, 'activities.jsonl', unicas);
  fase.unicos = unicas.length;
  fase.truncou = !!resultado.truncou;
  fase.status = fase.truncou ? 'truncada' : 'completa';
  if (fase.truncou) console.log('   ⚠️ a varredura de atividades bateu no teto de paginas — pode haver atividade nao lida');
  console.log(`   ✅ ${fase.unicos} atividade(s)`);
  salvarManifesto();
}

// ================================================================================================
// FASE D — notas (a mais cara)
//
// Tres cortes, e sao eles que tornam a fase viavel:
//
// 1. MOSKIT BOOST NUNCA TEVE BRIEFING. So o pipeline do bot posta nota de briefing, e o Boost e a
//    maior parte da conta (~2.793 dos ~3.094). Pedir /notes deles seria gastar 90% do orcamento para
//    confirmar uma ausencia ja conhecida.
// 2. O RESUMO JA ESTA DE GRACA no SQLite local (`last_data.resumo_atendimento`). A rede aqui responde
//    UMA pergunta que o banco nao responde: o briefing chegou ao CRM? Dai os tres veredictos do
//    relatorio (sem_resumo / resumo_nunca_postado / resumo_fraco).
// 3. CONJUNTO CANDIDATO EXPLICITO, com orcamento: deals do bot + deals em par de duplicidade + OPEN
//    sem atividade, nessa ordem de prioridade, ate fechar --notas-max.
//
// Exige --confirmar: imprime contagem e tempo estimado e sai sem gastar nada se o dono nao confirmou.
// ================================================================================================
const ORIGENS_DO_BOT = new Set(['BOT_WHATSAPP', 'BOT_TEST']);

function conjuntoCandidato() {
  const deals = dedupePorId(lerJsonl(DIR, 'deals.jsonl'));
  const atividades = lerJsonl(DIR, 'activities.jsonl');

  const prioridade = new Map(); // deal_id -> motivo (o primeiro motivo ganha, na ordem abaixo)
  const marcar = (id, motivo) => { if (id && !prioridade.has(id)) prioridade.set(id, motivo); };

  // 1. Deals do bot: os unicos que podem ter briefing.
  for (const d of deals) if (ORIGENS_DO_BOT.has(d.origin)) marcar(d.id, 'origem_do_bot');

  // 2. Deals em par de duplicidade candidato. Roda a MESMA regra de src/duplicidade.js que o estudo
  //    de 24/08 calibrou — offline, custo zero. Sem isso o relatorio de duplicidade nao teria como
  //    dizer qual dos dois lados do par tem o briefing (o sinal que decide qual deal sobrevive).
  const normalizados = deals.map((d) => duplicidade.normalizarDeal(d));
  duplicidade.aplicarFrequenciaTokens(normalizados);
  for (const [i, j] of duplicidade.montarParesCandidatos(normalizados)) {
    const r = duplicidade.classificarParNomeCaso(normalizados[i], normalizados[j]);
    if (r && r.categoria === 'mesmo_nome_mesmo_caso') {
      marcar(normalizados[i].id, 'par_de_duplicidade');
      marcar(normalizados[j].id, 'par_de_duplicidade');
    }
  }

  // 3. OPEN sem atividade nenhuma: o candidato a "parado". Deal com atividade FUTURA nao entra —
  //    consulta marcada nao e deal parado, e deal esperando.
  const agora = Date.now();
  const comAtividade = new Set();
  const comAtividadeFutura = new Set();
  for (const a of atividades) {
    for (const d of a.deals || []) {
      comAtividade.add(d.id);
      if (a.dueDate && new Date(a.dueDate).getTime() > agora) comAtividadeFutura.add(d.id);
    }
  }
  for (const d of deals) {
    if (d.status !== 'OPEN') continue;
    if (comAtividade.has(d.id) || comAtividadeFutura.has(d.id)) continue;
    marcar(d.id, 'aberto_sem_atividade');
  }

  const ordem = { origem_do_bot: 0, par_de_duplicidade: 1, aberto_sem_atividade: 2 };
  return [...prioridade.entries()]
    .map(([deal_id, motivo]) => ({ deal_id, motivo }))
    .sort((a, b) => ordem[a.motivo] - ordem[b.motivo] || a.deal_id - b.deal_id);
}

async function faseNotas() {
  const fase = MANIFESTO.fases.D;
  console.log('\n📝 Fase D — notas dos deals do conjunto candidato');

  // A fase D DEPENDE da C: "aberto sem atividade" e um dos tres motivos de candidatura, e sem
  // activities.jsonl TODO deal aberto parece sem atividade — o conjunto candidato inunda e o
  // orcamento e gasto nos deals errados. Falhar alto aqui e melhor que gastar 400 requisicoes num
  // recorte que nao significa nada.
  if (MANIFESTO.fases.C.status !== 'completa' && MANIFESTO.fases.C.status !== 'truncada') {
    fase.status = 'bloqueada_sem_fase_c';
    console.log(`   ⛔ a fase C (atividades) esta "${MANIFESTO.fases.C.status}" — sem ela, todo deal aberto`);
    console.log('      parece sem atividade e o conjunto candidato perde sentido. Rode a fase C primeiro:');
    console.log(`      node auditar-crm-coletar.js --retomar=${DIR} --so-fases=C`);
    salvarManifesto();
    return;
  }

  const candidatos = conjuntoCandidato();
  const porMotivo = candidatos.reduce((acc, c) => ({ ...acc, [c.motivo]: (acc[c.motivo] || 0) + 1 }), {});
  const dentroDoOrcamento = candidatos.slice(0, OPCOES.notasMax);
  const jaColetados = dentroDoOrcamento.filter((c) => fs.existsSync(path.join(DIR, 'notas', `${c.deal_id}.json`)));
  const aColetar = dentroDoOrcamento.filter((c) => !fs.existsSync(path.join(DIR, 'notas', `${c.deal_id}.json`)));

  console.log(`   conjunto candidato: ${candidatos.length} deal(s)`);
  for (const [motivo, n] of Object.entries(porMotivo)) console.log(`      ${String(n).padStart(4)}  ${motivo}`);
  console.log(`   orcamento --notas-max=${OPCOES.notasMax} → ${dentroDoOrcamento.length} deal(s); ${jaColetados.length} ja no snapshot, ${aColetar.length} a coletar`);
  const reqEstimadas = aColetar.length * OPCOES.notasPaginas;
  console.log(`   custo estimado: ate ${reqEstimadas} requisicao(oes) (${OPCOES.notasPaginas} pagina(s) por deal), ~${Math.ceil((reqEstimadas * PISO_MS) / 60000)} min`);
  fase.candidatos = candidatos.length;

  if (!OPCOES.confirmar) {
    fase.status = 'nao_confirmada';
    console.log('   ⏭️ fase D NAO executada: rode de novo com --confirmar para gastar essas requisicoes.');
    console.log(`      node auditar-crm-coletar.js --retomar=${DIR} --so-fases=D --confirmar`);
    salvarManifesto();
    return;
  }

  fase.status = 'rodando';
  let feitos = 0;
  for (const { deal_id, motivo } of aColetar) {
    const notas = [];
    const destino = path.join(DIR, 'notas', `${deal_id}.json`);
    try {
      // Predicado coletor: empurra e devolve sempre false, entao acharEmColecaoDoDeal pagina ate o
      // fim da lista (ou ate o teto) em vez de parar na primeira nota.
      await bot.acharEmColecaoDoDeal({
        rota: `/deals/${deal_id}/notes`,
        achar: (n) => { notas.push(n); return false; },
        descricao: `notas do deal ${deal_id}`,
      });
      fs.writeFileSync(destino, JSON.stringify({ deal_id, motivo, truncado: false, notas }, null, 2), 'utf8');
    } catch (e) {
      // acharEmColecaoDoDeal LANCA ao bater no teto de paginas, de proposito: "nao existe" e "nao
      // terminei de procurar" levam a acoes opostas. O arquivo guarda truncado:true para o relatorio
      // nao concluir "sem briefing" a partir de uma leitura incompleta.
      fs.writeFileSync(destino, JSON.stringify({ deal_id, motivo, truncado: true, erro: e.message, notas }, null, 2), 'utf8');
      fase.truncados += 1;
      registrarErro(DIR, { fase: 'D', deal_id, erro: e.message });
    }
    feitos += 1;
    fase.coletados = jaColetados.length + feitos;
    if (feitos % 25 === 0) {
      salvarManifesto();
      console.log(`   ... ${feitos}/${aColetar.length} deal(s)`);
    }
  }

  fase.coletados = jaColetados.length + feitos;
  fase.status = 'completa';
  console.log(`   ✅ notas de ${fase.coletados} deal(s)${fase.truncados ? `, ${fase.truncados} com leitura truncada` : ''}`);
  salvarManifesto();
}

// ================================================================================================
(async () => {
  const t0 = Date.now();
  console.log('='.repeat(80));
  console.log('🔍 AUDITORIA DO CRM — COLETA (somente leitura)');
  console.log('   nada e criado, alterado ou apagado: nao ha flag --aplicar neste script,');
  console.log('   e um interceptor do axios lanca em qualquer requisicao que nao seja GET.');
  console.log('='.repeat(80));

  if (!process.env.MOSKIT_API_KEY) {
    console.error('❌ MOSKIT_API_KEY ausente no .env — sem chave nao ha o que coletar.');
    process.exit(1);
  }

  DIR = prepararDiretorio();
  MANIFESTO = OPCOES.retomar
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifesto.json'), 'utf8'))
    : manifestoNovo();
  if (OPCOES.retomar) {
    MANIFESTO.retomadas = (MANIFESTO.retomadas || []).concat({ quando: new Date().toISOString(), argv: process.argv.slice(2) });
    fs.mkdirSync(path.join(DIR, 'notas'), { recursive: true });
  }
  console.log(`\n📁 Snapshot: ${DIR}`);
  console.log(`   fases pedidas: ${OPCOES.soFases.join(', ')}`);
  salvarManifesto();

  const rodar = (f) => OPCOES.soFases.includes(f) && MANIFESTO.fases[f].status !== 'completa';

  try {
    if (!MANIFESTO.metadados) await faseMetadados();
    if (rodar('A')) await faseDeals(); else console.log('\n📦 Fase A — pulada');
    if (rodar('B')) await faseContatos(); else console.log('\n👥 Fase B — pulada');
    if (rodar('C')) await faseAtividades(); else console.log('\n📅 Fase C — pulada');
    if (rodar('D')) await faseNotas(); else console.log('\n📝 Fase D — pulada');
  } catch (e) {
    MANIFESTO.rate_limit = { ...RITMO };
    MANIFESTO.fim = new Date().toISOString();
    salvarManifesto();
    console.error(`\n❌ Coleta interrompida: ${e.message}`);
    console.error(`   O snapshot parcial esta em ${DIR} e as falhas em erros.jsonl.`);
    console.error(`   Retomar com: node auditar-crm-coletar.js --retomar=${DIR}`);
    process.exit(1);
  }

  MANIFESTO.rate_limit = { ...RITMO };
  MANIFESTO.fim = new Date().toISOString();
  salvarManifesto();

  const minutos = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ Coleta concluida em ${minutos} min · ${RITMO.requisicoes} requisicao(oes) · ${RITMO.http_429} HTTP 429`);
  console.log(`   rate limit observado: minimo ${RITMO.min_remaining_second ?? '?'}/${RITMO.limite_segundo ?? '?'} por segundo, ${RITMO.min_remaining_minute ?? '?'}/${RITMO.limite_minuto ?? '?'} por minuto`);
  console.log(`   esperas por cota: ${RITMO.esperas_janela_segundo} no segundo, ${RITMO.esperas_janela_minuto} no minuto`);
  const erros = lerJsonl(DIR, 'erros.jsonl');
  console.log(`   ${erros.length} falha(s) registrada(s) em erros.jsonl`);
  const bloqueadas = erros.filter((e) => String(e.erro || '').includes('TRAVA DE ESCRITA'));
  if (bloqueadas.length) console.log(`   🚨 ${bloqueadas.length} requisicao(oes) de ESCRITA bloqueada(s) — isso e bug do coletor, investigar antes de confiar no snapshot`);
  console.log(`\n📄 Proximo passo (custo zero, quantas vezes quiser):`);
  console.log(`   node auditar-crm-relatar.js ${DIR}`);
  console.log(`${'='.repeat(80)}\n`);
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
