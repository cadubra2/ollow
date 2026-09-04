// RELATORIO da auditoria do CRM. Le o snapshot que auditar-crm-coletar.js deixou no disco e deriva
// os CSVs. NAO FAZ REDE — nenhuma requisicao, nem uma. E o ponto do arquivo existir separado:
// rodar de novo custa segundos, entao mudar um limiar ou o corte de "deal parado" nao custa outra
// varredura de ~1.260 requisicoes.
//
//   node auditar-crm-relatar.js                          # usa o snapshot mais recente
//   node auditar-crm-relatar.js auditoria-crm/<ts>       # usa um snapshot especifico
//   node auditar-crm-relatar.js --parado-dias=90         # muda o corte de "parado"
//   node auditar-crm-relatar.js --db=conversations.db    # espelho local (opcional, mas muda muito)
//
// A garantia de "zero rede" e um interceptor que lanca em QUALQUER requisicao, de qualquer metodo —
// nao so nas de escrita, como no coletor. Aqui nem GET tem o que fazer.
//
// O QUE ELE NAO PODE FAZER, e por que isso importa: as notas do CRM existem no snapshot so para o
// CONJUNTO CANDIDATO da fase D (o resto da conta nunca teve briefing — so o pipeline do bot posta).
// Todo veredicto de resumo sai marcado com `nota_lida`, e deal sem nota lida NAO conta como "sem
// resumo". Concluir ausencia a partir de uma leitura que nunca aconteceu e o erro que faria o dono
// mandar reprocessar 3.000 deals sadios.
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const arg = (nome, padrao) => {
  const achado = process.argv.find((a) => a.startsWith(`${nome}=`));
  return achado ? achado.slice(nome.length + 1) : padrao;
};

const OPCOES = {
  // 60 dias: sugestao, nao veredicto. A justificativa vem do proprio repositorio — RECONCILIACAO_DIAS
  // = 30 e o que o BOT chama de "recente"; aos 60 dias o deal ja passou por todas as redes
  // automaticas ao menos uma vez sem nada acontecer. O histograma no console existe para o dono
  // escolher o corte vendo o formato da distribuicao, e nao no escuro.
  paradoDias: Number(arg('--parado-dias', 60)) || 60,
  db: arg('--db', process.env.CONVERSATIONS_DB || 'conversations.db'),
  // Limiares de "resumo fraco", calibrados contra a LINHA DE BASE de 02/09/2026
  // (avaliacoes/agregado-2026-09-02-depois-fase2.json): resumo_chars mediana 330 (min 59, max 572) e
  // literais_por_resumo 1,46. Curto = menos de 200 chars (bem abaixo da mediana, pega a cauda de
  // baixo); poluido = 3+ ocorrencias de "nao mencionado" (o dobro da media). Sao knobs de
  // calibragem, como os limiares de duplicidade — mexer aqui nao custa varredura nenhuma.
  resumoCurtoChars: Number(arg('--resumo-curto-chars', 200)) || 200,
  resumoLiteraisMax: Number(arg('--resumo-literais-max', 3)) || 3,
};

// ------------------------------------------------------------------------------------------------
// Protecoes: DB_PATH descartavel (o boot do index.js roda ALTER TABLE onde DB_PATH aponta) e o
// bloqueio total de rede, instalado ANTES do require do index.js.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `auditar-relatar-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
process.env.MOSKIT_BASE = 'http://127.0.0.1:9';
process.env.ZAPSIGN_BASE = 'http://127.0.0.1:9';
for (const k of ['MOSKIT_API_KEY', 'ZAPSIGN_API_KEY']) if (process.env[k]) process.env[k] = 'SENTINELA-RELATORIO';

const axios = require('axios');
axios.interceptors.request.use((config) => {
  throw new Error(
    `TRAVA DE REDE: ${String(config.method || 'get').toUpperCase()} ${config.url} bloqueado — auditar-crm-relatar.js trabalha 100% offline, sobre o snapshot`
  );
});
// ------------------------------------------------------------------------------------------------

const Database = require('better-sqlite3');
const bot = require('./index.js');
const MOSKIT_IDS = require('./src/moskit-ids');
const duplicidade = require('./src/duplicidade');
const { chaveConversa, mesmoTelefone, SUFIXO_COMPARACAO } = require('./src/telefone');
const { MARCADOR_BRIEFING } = require('./src/briefing');
const { escreverCsv } = require('./src/csv');

const RAIZ = process.env.AUDITORIA_DIR || 'auditoria-crm';

// Mesma definicao de avaliar-extracao.js:119 — o literal que o modelo escreve quando nao achou o
// dado. Reusar a regex e nao recriar: se ela ganhar um caso novo, os dois relatorios andam juntos.
const RE_LITERAL = /(Nao mencionado|Não mencionado|Nada mencionado|Nao informado|Não informado)/g;
const contarLiterais = (t) => (String(t || '').match(RE_LITERAL) || []).length;
// [...str].length e nao String.length: o resumo tem emoji de topico, e cada um vale DUAS unidades
// UTF-16 — contar unidades inflaria o tamanho em ~12 chars que nenhum leitor ve.
const tamanhoReal = (t) => [...String(t || '')].length;

// ================================================================================================
// Snapshot
// ================================================================================================
function acharSnapshot() {
  const posicional = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (posicional) return posicional;
  if (!fs.existsSync(RAIZ)) throw new Error(`${RAIZ}/ nao existe — rode auditar-crm-coletar.js primeiro`);
  const dirs = fs.readdirSync(RAIZ).filter((d) => fs.existsSync(path.join(RAIZ, d, 'manifesto.json'))).sort();
  if (!dirs.length) throw new Error(`nenhum snapshot com manifesto.json em ${RAIZ}/ — rode auditar-crm-coletar.js primeiro`);
  return path.join(RAIZ, dirs[dirs.length - 1]);
}

function lerJsonl(dir, arquivo) {
  const p = path.join(dir, arquivo);
  if (!fs.existsSync(p)) return [];
  const saida = [];
  for (const linha of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    try { saida.push(JSON.parse(linha)); } catch { /* linha truncada por crash */ }
  }
  return saida;
}

function lerJson(dir, arquivo, padrao) {
  const p = path.join(dir, arquivo);
  if (!fs.existsSync(p)) return padrao;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return padrao; }
}

const dedupePorId = (registros) => {
  const vistos = new Set();
  return registros.filter((r) => (vistos.has(r.id) ? false : (vistos.add(r.id), true)));
};

// ================================================================================================
// Espelho local (conversations.db) — opcional, mas e ele que responde as perguntas mais uteis:
// o que o bot ACHA que extraiu, versus o que o CRM mostra.
// ================================================================================================
function carregarEspelhoLocal(caminho) {
  const vazio = { existe: false, porDealId: new Map(), contatos: new Map(), atualizadoAte: null, conversas: 0, comDealId: 0 };
  if (!fs.existsSync(caminho)) return vazio;

  const db = new Database(caminho, { readonly: true });
  // deals_anteriores (cliente que volta) pode nao existir num banco antigo — o mesmo cuidado que o
  // index.js tem com coluna migrada por ALTER TABLE, e que estudar-deals-sem-origem.js:110 ja tinha.
  const temDealsAnteriores = !!db
    .prepare("SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'deals_anteriores'")
    .get();

  const linhas = db.prepare(`
    SELECT chat_id, phone, contact_name, deal_id, last_data, last_action, updated_at, messages,
           campos_travados, briefing_added, briefing_hash
           ${temDealsAnteriores ? ', deals_anteriores' : ''}
      FROM conversations
  `).all();

  const parse = (t, padrao) => { try { const v = JSON.parse(t); return v ?? padrao; } catch { return padrao; } };

  const porDealId = new Map();
  let atualizadoAte = null;
  let comDealId = 0;
  for (const l of linhas) {
    if (l.updated_at && (!atualizadoAte || l.updated_at > atualizadoAte)) atualizadoAte = l.updated_at;
    const msgs = parse(l.messages, []);
    const ultimaMsg = Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1]?.timestamp || null : null;
    const projecao = {
      chat_id: l.chat_id,
      phone: l.phone,
      contact_name: l.contact_name,
      dados: parse(l.last_data, null),
      last_action: l.last_action,
      updated_at: l.updated_at,
      ultima_mensagem: ultimaMsg,
      mensagens: Array.isArray(msgs) ? msgs.length : 0,
      campos_travados: parse(l.campos_travados, []),
      briefing_added: l.briefing_added,
      briefing_hash: l.briefing_hash,
    };
    if (l.deal_id) { porDealId.set(String(l.deal_id), projecao); comDealId += 1; }
    // Cliente que volta: abrirNovoAtendimento zera o deal_id da linha e arquiva o deal antigo em
    // deals_anteriores. Sem ler isso, todo deal de atendimento encerrado apareceria como "sem
    // correspondencia no banco", quando na verdade so saiu da conversa atual.
    for (const anterior of parse(l.deals_anteriores, [])) {
      if (anterior?.deal_id && !porDealId.has(String(anterior.deal_id))) {
        porDealId.set(String(anterior.deal_id), { ...projecao, dados: null, eh_deal_anterior: true });
      }
    }
  }

  // Espelho de contatos do Moskit: telefone -> moskit_id. E o que revela a assinatura do bug de
  // duplicidade — o espelho aponta para o contato 111, mas o CRM tem 111 E 222 no mesmo telefone.
  const contatos = new Map();
  for (const c of db.prepare('SELECT phone, moskit_id, name FROM moskit_contacts').all()) {
    contatos.set(String(c.phone), { moskit_id: c.moskit_id, name: c.name });
  }
  db.close();

  return { existe: true, porDealId, contatos, atualizadoAte, conversas: linhas.length, comDealId, temDealsAnteriores };
}

// ================================================================================================
// Diagnostico por deal
// ================================================================================================
const ORIGENS_DO_BOT = new Set(['BOT_WHATSAPP', 'BOT_TEST']);
const ID_ORIGEM_NAO_IDENTIFICADO = MOSKIT_IDS.ORIGEM['nao identificado'];

// Rotulo de campo obrigatorio do lado do CRM. As chaves sao os nomes que a PRODUCAO usa
// (CAMPOS_OBRIGATORIOS, index.js:1234); `cf` e onde aquele dado mora no Moskit. `assunto` nao tem CF:
// ele vive na segunda metade do NOME do deal ("{nome} - {assunto}", montarPayloadMoskit).
const CAMPO_OBRIGATORIO_NO_CRM = {
  assunto: { cf: null, rotulo: 'assunto (2a metade do nome do deal)' },
  origem: { cf: MOSKIT_IDS.CF.ORIGEM, rotulo: 'Origem' },
  tipo_consulta: { cf: MOSKIT_IDS.CF.TIPO_CONSULTA, rotulo: 'Tipo de Consulta' },
  area_direito: { cf: MOSKIT_IDS.CF.AREA_DIREITO, rotulo: 'Área do Direito' },
  advogado_responsavel: { cf: MOSKIT_IDS.CF.RESPONSAVEL, rotulo: 'Responsável pelo Processo' },
};

const opcoesDoCampo = (deal, cf) => (deal.entityCustomFields || []).find((c) => c.id === cf)?.options || [];

// Por que NAO existe um "id 435777 == vazio" global: 435777 e a opcao "Nao identificado" DA ORIGEM.
// Casar esse id cegamente contra qualquer campo personalizado marcaria como vazio qualquer outro
// campo que por acaso tivesse uma opcao com o mesmo numero. A checagem e por campo, sempre.
function motivoCampoVazio(deal, chave) {
  const { cf } = CAMPO_OBRIGATORIO_NO_CRM[chave];
  if (cf === null) {
    const { casoParte } = duplicidade.extrairNomeCaso(deal.name);
    if (!casoParte) return 'campo_ausente';
    if (bot.ehAssuntoNeutro(casoParte)) return 'explicitamente_nao_identificado';
    return null;
  }
  const opcoes = opcoesDoCampo(deal, cf);
  if (!opcoes.length) return 'campo_ausente';
  if (cf === MOSKIT_IDS.CF.ORIGEM && opcoes.includes(ID_ORIGEM_NAO_IDENTIFICADO)) return 'explicitamente_nao_identificado';
  return null;
}

// Tipos de nome generico. A ordem importa: o primeiro que casa e o rotulo, do mais especifico para o
// mais generico.
function tipoDeNomeGenerico(deal) {
  const nome = String(deal.name || '').trim();
  if (!nome) return 'nome_vazio';
  const { nomeParte, casoParte } = duplicidade.extrairNomeCaso(nome);
  if (casoParte === null) return 'sem_separador';
  const pessoa = String(nomeParte || '').replace(/^\*/, '').trim();
  // "*Cliente sem nome" e o literal que buscarOuCriarContato usa quando o WhatsApp nao expoe o nome
  // (index.js:1499); o `*` e a marca de "criado pelo bot". Nome que e so digito e o telefone entrando
  // no lugar da pessoa.
  if (!pessoa || /cliente sem nome/i.test(pessoa) || /^[\d\s()+-]+$/.test(pessoa)) return 'cliente_sem_nome';
  if (bot.ehAssuntoNeutro(casoParte)) return 'assunto_neutro';
  // O "assunto" e so o nome de uma area do direito ("Fulano - Direito de Familia"): diz a materia,
  // nao o caso. Para o advogado que abre o funil, e tao vago quanto "Consulta juridica".
  if (MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.INDICE_BUSCA.AREA_DIREITO, casoParte)) return 'assunto_e_nome_de_area';
  return null;
}

const emMs = (valor) => {
  if (!valor) return null;
  // 'YYYY-MM-DD HH:MM:SS' do SQLite nao tem marca de fuso; o projeto roda TZ=UTC (rodar-testes.js,
  // e a VPS), entao o T/Z explicito evita o parse local que deslocaria 3h no Brasil.
  const texto = typeof valor === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(valor)
    ? `${valor.replace(' ', 'T')}Z`
    : valor;
  const t = new Date(texto).getTime();
  return Number.isFinite(t) ? t : null;
};

// ================================================================================================
(function principal() {
  const t0 = Date.now();
  const DIR = acharSnapshot();
  const manifesto = lerJson(DIR, 'manifesto.json', null);
  if (!manifesto) throw new Error(`${DIR} nao tem manifesto.json`);

  console.log('='.repeat(80));
  console.log('📊 AUDITORIA DO CRM — RELATORIO (offline, zero requisicoes)');
  console.log('='.repeat(80));
  console.log(`\n📁 Snapshot: ${DIR}`);
  console.log(`   coletado em ${manifesto.inicio} → ${manifesto.fim || '(interrompido)'}`);
  for (const [f, d] of Object.entries(manifesto.fases || {})) {
    console.log(`   fase ${f} (${d.nome}): ${d.status}${d.truncou ? ' ⚠️ TRUNCADA' : ''}${d.unicos ? ` · ${d.unicos} registro(s)` : ''}`);
  }

  // A fase C (atividades) e o unico sinal de "houve movimento neste deal" que nao vem do banco local.
  // Sem ela, TODO deal aberto parece sem atividade e a coluna `parado` fica errada para cima — e
  // errada num relatorio que o dono le para decidir o que mexer. Entao a secao de parados nao sai:
  // e melhor faltar um numero do que publicar um numero falso.
  const faseCok = ['completa', 'truncada'].includes(manifesto.fases?.C?.status);
  const deals = dedupePorId(lerJsonl(DIR, 'deals.jsonl'));
  const contatos = dedupePorId(lerJsonl(DIR, 'contacts.jsonl'));
  const atividades = dedupePorId(lerJsonl(DIR, 'activities.jsonl'));
  const camposConta = lerJson(DIR, 'campos-personalizados.json', []);
  const metaConta = lerJson(DIR, 'metadados-conta.json', { pipelines: [], stages: [], usuarios: [] });

  // Notas: so do conjunto candidato da fase D.
  const notasPorDeal = new Map();
  const dirNotas = path.join(DIR, 'notas');
  if (fs.existsSync(dirNotas)) {
    for (const arq of fs.readdirSync(dirNotas)) {
      if (!arq.endsWith('.json')) continue;
      const conteudo = lerJson(dirNotas, arq, null);
      if (conteudo) notasPorDeal.set(String(conteudo.deal_id), conteudo);
    }
  }

  const local = carregarEspelhoLocal(OPCOES.db);
  console.log('');
  if (!local.existe) {
    console.log(`💾 Espelho local ausente (${OPCOES.db}) — as colunas que dependem do banco saem vazias`);
  } else {
    console.log(`💾 Espelho local: ${OPCOES.db} · ${local.conversas} conversa(s), ${local.comDealId} com deal_id, ${local.contatos.size} telefone(s) espelhado(s)`);
    console.log(`   ultima atualizacao registrada no banco: ${local.atualizadoAte || '(nenhuma)'}`);
    if (!local.temDealsAnteriores) {
      console.log('   ⚠️ este banco NAO tem a coluna `deals_anteriores` — e uma copia anterior a funcionalidade');
      console.log('      "cliente que volta". Deal de atendimento encerrado aparece como sem correspondencia.');
    }
    const idade = local.atualizadoAte ? Math.floor((Date.now() - emMs(local.atualizadoAte)) / 86400000) : null;
    if (idade !== null && idade > 7) {
      console.log(`   🚨 O BANCO ESTA ${idade} DIAS ATRASADO em relacao a hoje. Toda coluna vinda do lado`);
      console.log('      LOCAL (resumo gravado, assunto no last_data, causa de campo vazio) esta subestimada.');
      console.log('      Puxar o conversations.db atual da VPS antes de decidir qualquer correcao.');
    }
  }

  // ---- indices de rotulo, vindos da CONTA (nunca inventar nome) ----
  const stagePorId = new Map((metaConta.stages || []).map((s) => [s.id, s]));
  const pipelinePorId = new Map((metaConta.pipelines || []).map((p) => [p.id, p]));
  const usuarioPorId = new Map((metaConta.usuarios || []).map((u) => [u.id, u]));
  const rotuloStage = (id) => (stagePorId.get(id)?.name || (id ? `id:${id}` : ''));
  const rotuloPipeline = (idStage) => {
    const p = stagePorId.get(idStage)?.pipeline?.id;
    return p ? (pipelinePorId.get(p)?.name || `id:${p}`) : '';
  };
  const rotuloUsuario = (id) => (usuarioPorId.get(id)?.name || (id ? `id:${id}` : ''));

  // ---- sinais de atividade por deal ----
  const agora = Date.now();
  const atividadePorDeal = new Map(); // deal_id -> { ultima, futura }
  for (const a of atividades) {
    for (const d of a.deals || []) {
      const chave = String(d.id);
      const atual = atividadePorDeal.get(chave) || { ultima: null, futura: false, total: 0 };
      atual.total += 1;
      for (const data of [a.dateCreated, a.dueDate]) {
        const ms = emMs(data);
        if (ms === null) continue;
        if (ms <= agora && (atual.ultima === null || ms > atual.ultima)) atual.ultima = ms;
        if (ms > agora) atual.futura = true;
      }
      atividadePorDeal.set(chave, atual);
    }
  }

  // ---- duplicidade de deals (a MESMA regra de src/duplicidade.js, calibrada em 24/08) ----
  const normalizados = deals.map((d) => duplicidade.normalizarDeal(d));
  duplicidade.aplicarFrequenciaTokens(normalizados);
  const paresBrutos = duplicidade.montarParesCandidatos(normalizados);
  const contatoPorId = new Map(contatos.map((c) => [c.id, c]));
  const telefonesDoContato = (id) => {
    const c = contatoPorId.get(id);
    if (!c) return [];
    const brutos = [c.primaryPhone, ...(c.phones || []).map((p) => p.number)];
    return brutos.map((b) => chaveConversa(b)).filter(Boolean);
  };

  const pares = [];
  const dealsEmPar = new Map(); // deal_id -> categoria mais grave
  for (const [i, j] of paresBrutos) {
    const a = normalizados[i];
    const b = normalizados[j];
    const r = duplicidade.classificarParNomeCaso(a, b);
    if (!r) continue;

    // A ASSINATURA DO BUG que produziu os pares de 24/08: dois CONTATOS diferentes no CRM para o
    // mesmo telefone, cada um com o seu deal. Comparacao por mesmoTelefone (src/telefone.js:24), a
    // mesma regra de ultimos-8-digitos que a producao usa — nao string igual.
    const telA = telefonesDoContato(a.contactId);
    const telB = telefonesDoContato(b.contactId);
    const mesmoTel = telA.some((x) => telB.some((y) => mesmoTelefone(x, y)));
    const assinatura = mesmoTel && a.contactId && b.contactId && a.contactId !== b.contactId
      ? 'MESMO_TELEFONE_CONTATOS_DIFERENTES'
      : '';

    pares.push({ a, b, ...r, assinatura, telefone_a: telA[0] || '', telefone_b: telB[0] || '' });
    if (r.categoria === 'mesmo_nome_mesmo_caso') {
      dealsEmPar.set(String(a.id), r.categoria);
      dealsEmPar.set(String(b.id), r.categoria);
    }
  }

  // ---- diagnostico deal por deal ----
  const inventario = [];
  const faltaCampo = [];
  const nomesGenericos = [];
  const resumos = [];
  const parados = [];
  const diasDosAbertos = [];

  for (const deal of deals) {
    const chave = String(deal.id);
    const l = local.porDealId.get(chave) || null;
    const prefixo = {
      deal_id: deal.id,
      nome_deal: deal.name || '',
      origin: deal.origin || '',
      status: deal.status || '',
      criado_em: deal.dateCreated || '',
      pipeline: rotuloPipeline(deal.stage?.id),
      stage: rotuloStage(deal.stage?.id),
      responsavel: rotuloUsuario(deal.responsible?.id),
    };

    // --- campos obrigatorios ---
    const vazios = [];
    for (const chaveCampo of Object.keys(CAMPO_OBRIGATORIO_NO_CRM)) {
      const motivo = motivoCampoVazio(deal, chaveCampo);
      if (!motivo) continue;
      vazios.push(chaveCampo);
      faltaCampo.push({
        ...prefixo,
        campo: chaveCampo,
        campo_no_crm: CAMPO_OBRIGATORIO_NO_CRM[chaveCampo].rotulo,
        motivo_origem: motivo,
        // O que a PRODUCAO acha que falta, pela funcao dela — nao por uma lista espelhada aqui, que
        // divergiria em silencio no dia em que alguem acrescentasse um campo obrigatorio.
        pendente_para_o_bot: l?.dados ? bot.camposPendentes(l.dados).includes(chaveCampo) : '',
        valor_no_last_data: l?.dados?.[chaveCampo] ?? '',
        travado_por_edicao_manual: (l?.campos_travados || []).includes(CAMPO_OBRIGATORIO_NO_CRM[chaveCampo].cf),
        chat_id: l?.chat_id || '',
      });
    }

    // --- nome generico ---
    const tipoNome = tipoDeNomeGenerico(deal);
    if (tipoNome) {
      const assuntoLocal = l?.dados?.assunto || '';
      nomesGenericos.push({
        ...prefixo,
        tipo: tipoNome,
        // A COLUNA DECISIVA. "Fulano - Consulta juridica" cujo last_data.assunto diz "Abatimento do
        // FIES" e RENAME RECUPERAVEL — o dado existe, so nao chegou ao titulo. Sem esta coluna o
        // relatorio confundiria "dado que falta" com "dado que nao subiu".
        assunto_no_last_data: assuntoLocal,
        recuperavel_por_rename: !!assuntoLocal && !bot.ehAssuntoNeutro(assuntoLocal),
        chat_id: l?.chat_id || '',
      });
    }

    // --- resumo / briefing ---
    const notas = notasPorDeal.get(chave);
    const resumoLocal = l?.dados?.resumo_atendimento || '';
    const notaBriefing = notas
      ? (notas.notas || []).find((n) => String(n.text || n.note || n.content || '').includes(MARCADOR_BRIEFING))
      : null;
    const textoBriefing = notaBriefing ? String(notaBriefing.text || notaBriefing.note || notaBriefing.content || '') : '';
    let veredicto = '';
    if (!notas) veredicto = 'nao_avaliado_nota_nao_lida';
    else if (notas.truncado) veredicto = 'nao_avaliado_leitura_truncada';
    else if (!resumoLocal && !textoBriefing) veredicto = 'sem_resumo';
    else if (resumoLocal && !textoBriefing) veredicto = 'resumo_nunca_postado';
    else if (
      tamanhoReal(textoBriefing || resumoLocal) < OPCOES.resumoCurtoChars
      || contarLiterais(textoBriefing || resumoLocal) >= OPCOES.resumoLiteraisMax
    ) veredicto = 'resumo_fraco';
    else veredicto = 'ok';

    if (veredicto !== 'ok') {
      resumos.push({
        ...prefixo,
        veredicto,
        nota_lida: !!notas && !notas.truncado,
        notas_no_crm: notas ? (notas.notas || []).length : '',
        briefing_no_crm: !!textoBriefing,
        chars_resumo_local: resumoLocal ? tamanhoReal(resumoLocal) : '',
        chars_briefing_crm: textoBriefing ? tamanhoReal(textoBriefing) : '',
        literais_nao_mencionado: contarLiterais(textoBriefing || resumoLocal),
        briefing_added_local: l?.briefing_added ?? '',
        chat_id: l?.chat_id || '',
      });
    }

    // --- parado ---
    const ativ = atividadePorDeal.get(chave) || { ultima: null, futura: false, total: 0 };
    const ultimaNota = notas
      ? (notas.notas || []).map((n) => emMs(n.dateCreated || n.created_at)).filter((x) => x !== null).sort((x, y) => y - x)[0] || null
      : null;
    const sinais = [emMs(deal.dateCreated), ativ.ultima, ultimaNota, emMs(l?.ultima_mensagem)].filter((x) => x !== null);
    const ultimoSinal = sinais.length ? Math.max(...sinais) : null;
    const dias = ultimoSinal === null ? null : Math.floor((agora - ultimoSinal) / 86400000);

    if (deal.status === 'OPEN' && faseCok) {
      if (dias !== null) diasDosAbertos.push(dias);
      // Deal com atividade FUTURA nao e parado, e esperando: consulta marcada para semana que vem e
      // exatamente o oposto de negocio esquecido.
      if (!ativ.futura && dias !== null && dias >= OPCOES.paradoDias) {
        parados.push({
          ...prefixo,
          dias_desde_ultimo_sinal: dias,
          sinal_mais_recente: new Date(ultimoSinal).toISOString(),
          atividades_no_crm: ativ.total,
          tem_atividade_futura: ativ.futura,
          nota_lida: !!notas,
          ultima_mensagem_local: l?.ultima_mensagem || '',
          chat_id: l?.chat_id || '',
        });
      }
    }

    inventario.push({
      ...prefixo,
      criado_pelo_bot: ORIGENS_DO_BOT.has(deal.origin),
      campos_obrigatorios_faltando: vazios.length,
      campos_faltando_quais: vazios.join('|'),
      nome_generico: tipoNome || '',
      recuperavel_por_rename: tipoNome ? (!!l?.dados?.assunto && !bot.ehAssuntoNeutro(l.dados.assunto)) : '',
      veredicto_resumo: veredicto,
      em_par_de_duplicidade: dealsEmPar.has(chave),
      dias_desde_ultimo_sinal: dias === null ? '' : dias,
      // Vazio (nao `false`) quando a fase C nao rodou: "nao sabemos" e "nao esta parado" levam a
      // acoes opostas, e um `false` aqui afirmaria a segunda.
      parado: faseCok ? (deal.status === 'OPEN' && !ativ.futura && dias !== null && dias >= OPCOES.paradoDias) : '',
      tem_atividade_futura: faseCok ? ativ.futura : '',
      no_espelho_local: !!l,
      chat_id: l?.chat_id || '',
    });
  }

  // ---- contatos duplicados ----
  // Agrupa pelos ultimos 8 digitos (SUFIXO_COMPARACAO), a mesma janela de mesmoTelefone: e ela que
  // faz "5585999998888" e "85999998888" cairem no mesmo grupo.
  const porSufixo = new Map();
  for (const c of contatos) {
    for (const bruto of [c.primaryPhone, ...(c.phones || []).map((p) => p.number)]) {
      const chave = chaveConversa(bruto);
      if (!chave) continue;
      const sufixo = chave.slice(-SUFIXO_COMPARACAO);
      if (!porSufixo.has(sufixo)) porSufixo.set(sufixo, new Map());
      porSufixo.get(sufixo).set(c.id, c);
    }
  }
  const dealsPorContato = new Map();
  for (const d of deals) for (const c of d.contacts || []) {
    if (!dealsPorContato.has(c.id)) dealsPorContato.set(c.id, []);
    dealsPorContato.get(c.id).push(d.id);
  }
  const contatosDuplicados = [];
  for (const [sufixo, grupo] of porSufixo) {
    if (grupo.size < 2) continue;
    // O espelho local aponta para UM contato por telefone. Se o CRM tem dois, o que o espelho NAO
    // aponta e a duplicata que a producao nunca vai achar — e por isso ganha deal novo.
    const noEspelho = [...local.contatos.entries()]
      .filter(([tel]) => tel.slice(-SUFIXO_COMPARACAO) === sufixo)
      .map(([, v]) => v.moskit_id);
    for (const c of grupo.values()) {
      contatosDuplicados.push({
        sufixo_telefone: sufixo,
        contatos_no_grupo: grupo.size,
        contato_id: c.id,
        nome: c.name || '',
        criado_pelo_bot: String(c.name || '').startsWith('*'),
        criado_em: c.dateCreated || '',
        origin: c.origin || '',
        deals_deste_contato: (dealsPorContato.get(c.id) || []).join('|'),
        qtd_deals: (dealsPorContato.get(c.id) || []).length,
        mirror_local_aponta_para: noEspelho.join('|'),
        e_a_duplicata_invisivel_ao_bot: noEspelho.length > 0 && !noEspelho.includes(c.id),
      });
    }
  }
  contatosDuplicados.sort((a, b) => b.contatos_no_grupo - a.contatos_no_grupo || String(a.sufixo_telefone).localeCompare(String(b.sufixo_telefone)));

  // ---- pivo por origem ----
  const porOrigem = new Map();
  for (const inv of inventario) {
    const chave = inv.origin || '(sem origin)';
    const acc = porOrigem.get(chave) || {
      origin: chave, deals: 0, abertos: 0, ganhos: 0, perdidos: 0,
      sem_campo_obrigatorio: 0, nome_generico: 0, resumo_com_problema: 0,
      em_par_de_duplicidade: 0, parados: 0, no_espelho_local: 0,
    };
    acc.deals += 1;
    if (inv.status === 'OPEN') acc.abertos += 1;
    if (inv.status === 'WON') acc.ganhos += 1;
    if (inv.status === 'LOST') acc.perdidos += 1;
    if (inv.campos_obrigatorios_faltando > 0) acc.sem_campo_obrigatorio += 1;
    if (inv.nome_generico) acc.nome_generico += 1;
    if (!['ok', 'nao_avaliado_nota_nao_lida', 'nao_avaliado_leitura_truncada'].includes(inv.veredicto_resumo)) acc.resumo_com_problema += 1;
    if (inv.em_par_de_duplicidade) acc.em_par_de_duplicidade += 1;
    if (inv.parado) acc.parados += 1;
    if (inv.no_espelho_local) acc.no_espelho_local += 1;
    porOrigem.set(chave, acc);
  }
  const pivo = [...porOrigem.values()].sort((a, b) => b.deals - a.deals);

  // ---- taxa de preenchimento por campo personalizado DESCOBERTO na conta ----
  const preenchimentoCf = camposConta.filter((c) => c.module === 'DEAL').map((cf) => {
    const preenchidos = deals.filter((d) => opcoesDoCampo(d, cf.id).length > 0).length;
    return {
      id: cf.id,
      nome: cf.name,
      tipo: cf.type,
      ativo: cf.active,
      o_codigo_conhece: Object.values(MOSKIT_IDS.CF).includes(cf.id),
      deals_preenchidos: preenchidos,
      deals_total: deals.length,
      taxa: deals.length ? `${((preenchidos / deals.length) * 100).toFixed(1)}%` : '',
    };
  });

  // ================================================================================================
  // Saida
  // ================================================================================================
  // Ordem fixa das colunas de todo CSV que pode sair VAZIO — e todos podem: zero par de
  // duplicidade, zero campo faltando, a fase C nao rodada (06 vazio por decisao), o 04 filtrado ate
  // o fim. Sem cabecalho explicito, `montarCsv([])` produz um arquivo com nada dentro, e quem abrir
  // no Excel ve uma planilha sem coluna nenhuma em vez de "nenhum achado nesta categoria". Foi
  // exatamente o que aconteceu com o 06 na primeira rodada real.
  const PREFIXO = ['deal_id', 'nome_deal', 'origin', 'status', 'criado_em', 'pipeline', 'stage', 'responsavel'];
  const CABECALHOS = {
    duplicidade: [
      'categoria', 'assinatura',
      'deal_1', 'nome_1', 'origin_1', 'status_1', 'criado_1', 'contato_1', 'telefone_1', 'area_1',
      'deal_2', 'nome_2', 'origin_2', 'status_2', 'criado_2', 'contato_2', 'telefone_2', 'area_2',
      'nome_identico', 'nome_similaridade', 'caso_similaridade', 'area_igual', 'mesmo_contato_no_crm',
    ],
    campos: [...PREFIXO, 'campo', 'campo_no_crm', 'motivo_origem', 'pendente_para_o_bot',
      'valor_no_last_data', 'travado_por_edicao_manual', 'chat_id'],
    nome: [...PREFIXO, 'tipo', 'assunto_no_last_data', 'recuperavel_por_rename', 'chat_id'],
    resumo: [...PREFIXO, 'veredicto', 'nota_lida', 'notas_no_crm', 'briefing_no_crm',
      'chars_resumo_local', 'chars_briefing_crm', 'literais_nao_mencionado', 'briefing_added_local',
      'chat_id'],
    contatos: ['sufixo_telefone', 'contatos_no_grupo', 'contato_id', 'nome', 'criado_pelo_bot',
      'criado_em', 'origin', 'deals_deste_contato', 'qtd_deals', 'mirror_local_aponta_para',
      'e_a_duplicata_invisivel_ao_bot'],
    parados: [...PREFIXO, 'dias_desde_ultimo_sinal', 'sinal_mais_recente', 'atividades_no_crm',
      'tem_atividade_futura', 'nota_lida', 'ultima_mensagem_local', 'chat_id'],
  };

  const dirRel = path.join(DIR, 'relatorios');
  fs.mkdirSync(dirRel, { recursive: true });
  const csv = (arquivo, linhas, cabecalho) => {
    const r = escreverCsv(path.join(dirRel, arquivo), linhas, { cabecalho });
    console.log(`   ${arquivo.padEnd(30)} ${String(r.linhas).padStart(6)} linha(s)`);
  };

  const paresCsv = pares.map((p) => ({
    categoria: p.categoria,
    assinatura: p.assinatura,
    deal_1: p.a.id, nome_1: p.a.name, origin_1: p.a.origin || '', status_1: p.a.status || '', criado_1: p.a.dateCreated || '',
    contato_1: p.a.contactId || '', telefone_1: p.telefone_a, area_1: p.a.areaLabel || '',
    deal_2: p.b.id, nome_2: p.b.name, origin_2: p.b.origin || '', status_2: p.b.status || '', criado_2: p.b.dateCreated || '',
    contato_2: p.b.contactId || '', telefone_2: p.telefone_b, area_2: p.b.areaLabel || '',
    nome_identico: p.nomeIgual,
    nome_similaridade: p.nomeSimilaridade.toFixed(2),
    caso_similaridade: p.casoSimilaridade === null ? '' : p.casoSimilaridade.toFixed(2),
    area_igual: p.areaIgual === null ? '' : p.areaIgual,
    mesmo_contato_no_crm: p.mesmoContato === null ? '' : p.mesmoContato,
  })).sort((a, b) => (a.categoria === b.categoria ? 0 : a.categoria === 'mesmo_nome_mesmo_caso' ? -1 : 1));

  console.log('\n📄 CSVs gerados:');
  csv('00-inventario.csv', inventario);
  csv('01-duplicidade-deals.csv', paresCsv, CABECALHOS.duplicidade);
  csv('02-campos-obrigatorios.csv', faltaCampo, CABECALHOS.campos);
  csv('03-nome-generico.csv', nomesGenericos, CABECALHOS.nome);
  // Fora do CSV: linha que diz "nao avaliado" nao e achado, e ausencia de leitura. Deixar as ~3.000
  // do resto da conta na planilha afogaria os poucos deals com problema REAL de resumo. A contagem
  // sai no console, e o inventario (00) guarda o veredicto de todo deal para quem quiser filtrar.
  csv('04-resumo.csv', resumos.filter((r) => !r.veredicto.startsWith('nao_avaliado')), CABECALHOS.resumo);
  csv('05-contatos-duplicados.csv', contatosDuplicados, CABECALHOS.contatos);
  csv('06-deals-parados.csv', parados, CABECALHOS.parados);
  csv('07-por-origem.csv', pivo);
  csv('08-campos-personalizados.csv', preenchimentoCf);

  // ---- console ----
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`📊 ${deals.length} deal(s) · ${contatos.length} contato(s) · ${atividades.length} atividade(s) · notas lidas de ${notasPorDeal.size} deal(s)`);
  console.log(`${'─'.repeat(80)}\n`);

  console.log('POR ORIGEM (o pivo — onde a bagunca de fato mora):');
  console.log(`  ${'origem'.padEnd(20)} ${'deals'.padStart(6)} ${'abertos'.padStart(8)} ${'s/campo'.padStart(8)} ${'nome gen'.padStart(9)} ${'resumo'.padStart(7)} ${'duplic'.padStart(7)} ${'parados'.padStart(8)}`);
  for (const p of pivo) {
    console.log(`  ${String(p.origin).slice(0, 20).padEnd(20)} ${String(p.deals).padStart(6)} ${String(p.abertos).padStart(8)} ${String(p.sem_campo_obrigatorio).padStart(8)} ${String(p.nome_generico).padStart(9)} ${String(p.resumo_com_problema).padStart(7)} ${String(p.em_par_de_duplicidade).padStart(7)} ${String(p.parados).padStart(8)}`);
  }

  console.log('\nCAMPO OBRIGATORIO VAZIO, por campo:');
  const porCampo = faltaCampo.reduce((acc, f) => {
    const k = `${f.campo} · ${f.motivo_origem}`;
    return { ...acc, [k]: (acc[k] || 0) + 1 };
  }, {});
  for (const [k, n] of Object.entries(porCampo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

  console.log('\nNOME GENERICO, por tipo:');
  const porTipoNome = nomesGenericos.reduce((acc, n) => ({ ...acc, [n.tipo]: (acc[n.tipo] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(porTipoNome).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  const recuperaveis = nomesGenericos.filter((n) => n.recuperavel_por_rename).length;
  console.log(`  → ${recuperaveis} deles sao RENAME RECUPERAVEL: o assunto real ja esta no last_data, so nao subiu para o titulo.`);

  console.log('\nRESUMO / BRIEFING, por veredicto:');
  const porVeredicto = resumos.reduce((acc, r) => ({ ...acc, [r.veredicto]: (acc[r.veredicto] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(porVeredicto).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log(`  (deal sem nota lida nao conta como "sem resumo" — a fase D so coletou o conjunto candidato)`);

  console.log('\nDUPLICIDADE DE DEALS:');
  const porCategoriaPar = pares.reduce((acc, p) => ({ ...acc, [p.categoria]: (acc[p.categoria] || 0) + 1 }), {});
  for (const [k, n] of Object.entries(porCategoriaPar).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  const comAssinatura = pares.filter((p) => p.assinatura).length;
  console.log(`  → ${comAssinatura} par(es) com MESMO_TELEFONE_CONTATOS_DIFERENTES (a assinatura do bug: 100% dos pares de 24/08)`);
  console.log(`  limiares em uso: nome ${duplicidade.LIMIARES_PADRAO.nome}, caso ${duplicidade.LIMIARES_PADRAO.caso} (env DUPLICIDADE_*)`);

  console.log('\nCONTATOS DUPLICADOS:');
  const grupos = new Set(contatosDuplicados.map((c) => c.sufixo_telefone));
  const invisiveis = contatosDuplicados.filter((c) => c.e_a_duplicata_invisivel_ao_bot).length;
  console.log(`  ${grupos.size} telefone(s) com 2+ contatos no CRM, ${contatosDuplicados.length} contato(s) envolvido(s)`);
  console.log(`  → ${invisiveis} contato(s) que o espelho local NAO aponta: sao os que a producao nunca acha, e que ganham deal novo`);

  if (!faseCok) {
    console.log(`\nDEALS PARADOS — NAO CALCULADO: a fase C (atividades) esta "${manifesto.fases?.C?.status}".`);
    console.log('  Sem as atividades, todo deal aberto pareceria sem movimento e o numero sairia errado');
    console.log('  para cima. O CSV 06 sai vazio e a coluna `parado` do inventario fica em branco.');
    console.log(`  Completar com: node auditar-crm-coletar.js --retomar=${DIR} --so-fases=C`);
  } else {
  console.log(`\nDEALS PARADOS (só OPEN, excluindo quem tem atividade futura) — corte atual: ${OPCOES.paradoDias} dias`);
  const faixas = [[0, 30], [30, 60], [60, 90], [90, 180], [180, Infinity]];
  const contagens = faixas.map(([de, ate]) => diasDosAbertos.filter((d) => d >= de && d < ate).length);
  const maior = Math.max(1, ...contagens);
  console.log('  histograma de inercia dos deals ABERTOS (escolha o corte vendo o formato):');
  faixas.forEach(([de, ate], i) => {
    const rotulo = ate === Infinity ? `${de}+ dias` : `${de}-${ate} dias`;
    const barra = '█'.repeat(Math.round((contagens[i] / maior) * 50));
    console.log(`    ${rotulo.padEnd(14)} ${String(contagens[i]).padStart(5)}  ${barra}`);
  });
  console.log(`  com o corte de ${OPCOES.paradoDias} dias: ${parados.length} deal(s) parado(s)`);
  console.log('  mudar o corte nao custa varredura: node auditar-crm-relatar.js --parado-dias=90');
  }

  console.log('\nCAMPOS PERSONALIZADOS DA CONTA (taxa de preenchimento):');
  for (const c of preenchimentoCf) {
    const marca = c.o_codigo_conhece ? ' ' : '⚠';
    console.log(`  ${marca} ${String(c.taxa).padStart(6)}  ${c.id}  "${c.nome}"${c.o_codigo_conhece ? '' : '  ← o CODIGO NAO CONHECE este campo'}`);
  }
  const naoConhecidos = preenchimentoCf.filter((c) => !c.o_codigo_conhece);
  if (naoConhecidos.length) {
    console.log('\n  Campo marcado com ⚠ nao aparece em src/moskit-ids.js: o bot nao escreve nele.');
    console.log('  Isso NAO significa que esta vazio nem que vazio e o esperado — olhe a taxa acima.');
    for (const c of naoConhecidos) {
      // A leitura muda de sinal com a taxa, e foi por confundir as duas que a premissa inicial desta
      // auditoria saiu errada: "o codigo nao conhece" foi lido como "esta vazio, entao e ruido",
      // quando CF_y5lm56iyiY7rKDwW estava em 53,9% da conta (medido em 02/09/2026).
      const taxa = c.deals_total ? (c.deals_preenchidos / c.deals_total) : 0;
      if (taxa >= 0.2) {
        console.log(`    "${c.nome}" (${c.taxa}): a operacao USA este campo, o bot nao. Num deal criado`);
        console.log('      pelo bot, vazio aqui pode ser lacuna REAL, nao ruido.');
      } else {
        console.log(`    "${c.nome}" (${c.taxa}): pouco usado por qualquer origem — vazio e plausivelmente o esperado.`);
      }
    }
    console.log('  Se algum deles deve ser obrigatorio, e decisao do dono, e so depois entra em');
    console.log('  src/moskit-ids.js. Os ids de opcao nao vem da API (`GET /customFields/{id}` nao os');
    console.log('  lista), entao rotular exige ler as opcoes na tela do CRM.');
  }

  const erros = lerJsonl(DIR, 'erros.jsonl');
  if (erros.length) {
    console.log(`\n⚠️ ${erros.length} falha(s) registrada(s) durante a coleta (erros.jsonl) — o snapshot pode estar incompleto:`);
    for (const e of erros.slice(0, 8)) console.log(`   fase ${e.fase}: ${e.erro}`);
    if (erros.length > 8) console.log(`   ... e ${erros.length - 8} outra(s)`);
  }
  for (const [f, d] of Object.entries(manifesto.fases || {})) {
    if (d.truncou) console.log(`\n⚠️ A fase ${f} (${d.nome}) foi TRUNCADA — os numeros acima sao um piso, nao o total da conta.`);
    if (d.token_expirou) console.log(`\nℹ️ A fase ${f} reiniciou por pageToken expirado; o dedupe por id cobriu a sobreposicao.`);
  }
  // ?start= e OFFSET, nao cursor estavel: a conta muda durante a varredura. order=asc empurra o deal
  // novo para o fim (depois do cursor) em vez de deslocar a lista, mas a ressalva fica dita.
  console.log(`\nℹ️ A coleta paginou com order=asc e dedupe por id (${manifesto.fases?.A?.repetidos || 0} repetido(s) descartado(s)).`);
  console.log('   Deal criado DURANTE a varredura pode nao estar aqui: o snapshot e uma foto, nao um espelho ao vivo.');

  console.log(`\n📁 Relatorios em ${dirRel}`);
  console.log(`⏱️ ${((Date.now() - t0) / 1000).toFixed(1)}s · zero requisicoes de rede\n`);
})();
