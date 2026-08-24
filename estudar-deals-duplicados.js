// Estudo SO-LEITURA de deal DUPLICADO: mais de um negocio no Moskit para o MESMO
// atendimento/cliente por engano.
//
//   node estudar-deals-duplicados.js [--db=<caminho>] [--sondar-crm] [--so-bot]
//
// --so-bot (com --sondar-crm): restringe a comparacao de nome+caso aos deals com origin=BOT_WHATSAPP
// — "desde o dia que o bot foi criado e comecou a fazer a automacao", em vez da conta inteira (que
// tem milhares de leads do Moskit Boost desde 2021, irrelevantes pra medir duplicidade causada pelo
// bot). Recalcula o que e "termo generico" dentro desse universo menor.
//
// NUNCA rodar em CI nem no npm test — le o conversations.db de producao (ou uma copia dele). NAO
// escreve em nada, nem no banco nem no CRM: nao existe flag --aplicar neste script de proposito.
//
// FASE 1 (este script, hoje): 100% local, custo de rede ZERO. Toda cadeia de 2+ deals ja criada pelo
// caminho "cliente que volta" fica registrada em `conversations.deals_anteriores`
// (abrirNovoAtendimento, index.js:3564-3626) — este script reaplica a MESMA regra que a producao usa
// para decidir "caso novo" (src/cliente-retorno.js, decidirRetorno) para separar retroativamente
// retorno legitimo de duplicidade disfarcada, e acrescenta um sinal que a producao nao usa
// (similaridade textual entre os dois assuntos) para achar o caso mais arriscado: quando so o
// ASSUNTO mudou (texto livre da IA, comparado so por normalizacao de string — sem nocao semantica —
// em MOSKIT_IDS.normalizarChave/assuntoEspecifico) mas os dois textos sao parecidos o bastante para
// suspeitar que e o MESMO caso, so descrito com outras palavras na segunda vez.
//
// FASE 2 (--sondar-crm): pagina /deals INTEIRO no Moskit real (?start=, mesmo padrao medido em
// estudar-deals-sem-origem.js — page/limit sao ignorados em silencio, start pagina de verdade) e
// procura, na conta INTEIRA (nao so nos deals do bot — duplicidade pode vir de qualquer origem:
// Moskit Boost, importacao, cadastro manual), pares de deals com NOME parecido/igual e depois
// confere se o CASO (a parte do nome depois do " - ", formato `${nome} - ${assunto}` de
// montarPayloadMoskit, index.js:1433-1436) tambem e parecido — o par que importa e "mesma pessoa E
// mesmo caso", nao so nome parecido (homonimo e comum em base de milhares de leads). NUNCA escreve
// nada; so GET /deals paginado. Cobre, de bonus, a lacuna real de buscarDealPorContato
// (index.js:1376-1397, usa params:{page:1} sem `limit` — a API ignora esse parametro e sempre volta
// so os ~10 deals mais recentes da conta inteira, entao um contato com deal antigo fora dessa janela
// nao e achado e pode ganhar um segundo deal).
const path = require('path');
require('dotenv').config();

// index.js e carregado so para reusar src/moskit-ids.js/src/cliente-retorno.js com a MESMA instancia
// que a producao usa (nunca reimplementar a regra). WORKER_MODE=1 carrega o modulo sem servidor e sem
// os setInterval; DB_PATH descartavel garante que o require NAO abre nem altera o banco de producao —
// a leitura do banco real (ou de uma copia dele) e feita mais abaixo, num handle readonly separado.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `estudo-duplicados-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');
const clienteRetorno = require('./src/cliente-retorno');
require('./index.js'); // so para confirmar que o boot nao lanca com este DB_PATH descartavel

const LIMIAR_SIMILARIDADE = Number(process.env.DUPLICIDADE_LIMIAR_SIMILARIDADE) || 0.5;

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY };
const PAUSA_MS = Number(process.env.RECONCILIACAO_PAUSA_MS) || 300;
const MAX_PAGINAS = Number(process.env.MAX_PAGINAS_DEALS) || 500;
const NOME_LIMIAR = Number(process.env.DUPLICIDADE_NOME_LIMIAR) || 0.75;
const CASO_LIMIAR = Number(process.env.DUPLICIDADE_CASO_LIMIAR) || 0.4;
// Tokens sozinhos nao distinguem pessoa nenhuma ("de", "da"...) e um token presente em mais que isso
// na conta inteira e comum demais pra servir de sinal (evita bucket gigante tipo "silva"/"maria").
const STOPWORDS_NOME = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'dr', 'dra', 'sr', 'sra']);
const TOKEN_BUCKET_MAX = Number(process.env.DUPLICIDADE_TOKEN_BUCKET_MAX) || 400;

const AREA_ID_PARA_LABEL = Object.fromEntries(
  Object.entries(MOSKIT_IDS.AREA_DIREITO).map(([label, id]) => [id, label])
);

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

// Jaccard sobre tokens normalizados (MOSKIT_IDS.normalizarChave: minusculo/sem-acento/sem-pontuacao).
// Sinal NOVO desta auditoria, a producao nao usa nada parecido — serve so para priorizar revisao
// manual, nunca para decidir sozinho (por isso nao entra em cliente-retorno.js).
function similaridadeTexto(a, b) {
  const tokA = new Set(MOSKIT_IDS.normalizarChave(a).split(' ').filter(Boolean));
  const tokB = new Set(MOSKIT_IDS.normalizarChave(b).split(' ').filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  const uniao = new Set([...tokA, ...tokB]).size;
  return uniao ? inter / uniao : 0;
}

// Mesma comparacao de src/cliente-retorno.js:decidirRetorno (linhas 144-166), reaplicada fora do
// runtime — aqui nao temos mensagens/obsValidas do atendimento antigo, so o par
// {assunto, area_direito} de cada elo, que e exatamente o que deals_anteriores guarda.
function classificarPar({ assuntoAnterior, areaAnterior, assuntoNovo, areaNova }) {
  const chaveAreaAnterior = clienteRetorno.chaveArea(areaAnterior);
  const chaveAreaNova = clienteRetorno.chaveArea(areaNova);
  const areaMudou = !!chaveAreaNova && !!chaveAreaAnterior && chaveAreaNova !== chaveAreaAnterior;

  const chaveAssuntoAnterior = clienteRetorno.assuntoEspecifico(assuntoAnterior);
  const chaveAssuntoNovo = clienteRetorno.assuntoEspecifico(assuntoNovo);
  const assuntoMudou = !!chaveAssuntoNovo && chaveAssuntoNovo !== chaveAssuntoAnterior;

  const similaridade = similaridadeTexto(assuntoAnterior || '', assuntoNovo || '');

  let categoria;
  if (!assuntoMudou && !areaMudou) {
    // Nao deveria nem estar em deals_anteriores: decidirRetorno so abre atendimento novo quando
    // assuntoMudou||areaMudou. Se nenhum dos dois mudou AGORA, ou a regra mudou depois que essa
    // linha foi gravada, ou algo abriu o atendimento fora do caminho normal — vale investigar.
    categoria = 'nao_deveria_ter_dividido';
  } else if (areaMudou) {
    categoria = 'retorno_legitimo_area_diferente';
  } else if (similaridade >= LIMIAR_SIMILARIDADE) {
    // Só o assunto mudou, e os dois textos sao parecidos: candidato principal a "mesmo caso descrito
    // com outras palavras" — o cenario do bullet "assunto raso mudou" do CLAUDE.md.
    categoria = 'suspeita_assunto_raso_mudou';
  } else {
    categoria = 'retorno_legitimo_assunto_diferente';
  }

  return { categoria, areaMudou, assuntoMudou, similaridade };
}

function montarCadeia(linha) {
  const anteriores = parseJsonSeguro(linha.deals_anteriores, []);
  if (!Array.isArray(anteriores) || !anteriores.length) return null;

  const dadosAtuais = parseJsonSeguro(linha.last_data, {});
  const eloAtual = {
    deal_id: linha.deal_id || null,
    assunto: dadosAtuais?.assunto || null,
    area: dadosAtuais?.area_direito || null,
    consulta_em: null,
    encerrado_em: null,
    atual: true,
  };

  return [...anteriores.map((a) => ({ ...a, atual: false })), eloAtual];
}

function fase1(caminhoBanco) {
  console.log('\n🔍 FASE 1 — so-leitura, local: cadeias de deals do mesmo telefone (cliente que volta)');
  console.log('   objetivo: separar retorno legitimo de possivel duplicidade disfarcada');
  console.log('   somente leitura: nada e criado, movido ou apagado\n');

  if (!fs.existsSync(caminhoBanco)) {
    console.log(`❌ Banco nao encontrado em ${caminhoBanco}. Passe --db=<caminho> ou defina CONVERSATIONS_DB.`);
    process.exitCode = 1;
    return false;
  }

  const db = new Database(caminhoBanco, { readonly: true });
  const temDealsAnteriores = db.prepare("SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'deals_anteriores'").get();
  if (!temDealsAnteriores) {
    console.log('❌ Este banco nao tem a coluna deals_anteriores (versao antiga, ou funcionalidade nunca migrada aqui).');
    db.close();
    process.exitCode = 1;
    return false;
  }

  const linhas = db.prepare(`
    SELECT chat_id, deal_id, contact_name, last_data, deals_anteriores, updated_at
    FROM conversations
    WHERE deals_anteriores IS NOT NULL AND deals_anteriores != '[]' AND deals_anteriores != ''
  `).all();
  db.close();

  console.log(`💾 Banco (${caminhoBanco}, readonly): ${linhas.length} conversa(s) com 2+ deals encadeados\n`);

  const contagem = {};
  const detalhados = { suspeita_assunto_raso_mudou: [], nao_deveria_ter_dividido: [] };
  let totalPares = 0;

  for (const linha of linhas) {
    const cadeia = montarCadeia(linha);
    if (!cadeia || cadeia.length < 2) continue;

    for (let i = 1; i < cadeia.length; i++) {
      const anterior = cadeia[i - 1];
      const novo = cadeia[i];
      const resultado = classificarPar({
        assuntoAnterior: anterior.assunto,
        areaAnterior: anterior.area,
        assuntoNovo: novo.assunto,
        areaNova: novo.area,
      });

      totalPares++;
      contagem[resultado.categoria] = (contagem[resultado.categoria] || 0) + 1;

      if (detalhados[resultado.categoria]) {
        detalhados[resultado.categoria].push({
          chat_id: linha.chat_id,
          deal_anterior: anterior.deal_id,
          deal_novo: novo.deal_id,
          assunto_anterior: anterior.assunto || '(vazio)',
          assunto_novo: novo.assunto || '(vazio)',
          area_anterior: anterior.area || '(vazio)',
          area_novo: novo.area || '(vazio)',
          similaridade: resultado.similaridade.toFixed(2),
          consulta_anterior_em: anterior.consulta_em || null,
          encerrado_em: anterior.encerrado_em || null,
        });
      }
    }
  }

  console.log(`📊 Classificacao de ${totalPares} par(es) consecutivo(s) de deals (limiar de similaridade: ${LIMIAR_SIMILARIDADE}):\n`);
  const ordem = [
    'suspeita_assunto_raso_mudou',
    'nao_deveria_ter_dividido',
    'retorno_legitimo_area_diferente',
    'retorno_legitimo_assunto_diferente',
  ];
  for (const cat of ordem) {
    const marca = (cat === 'suspeita_assunto_raso_mudou' || cat === 'nao_deveria_ter_dividido') ? '⚠️ ' : '   ';
    console.log(`  ${marca}${cat}: ${contagem[cat] || 0}`);
  }
  console.log('');

  for (const cat of ['suspeita_assunto_raso_mudou', 'nao_deveria_ter_dividido']) {
    const lista = detalhados[cat];
    if (!lista.length) continue;
    console.log(`\n--- ${cat} (${lista.length}) ---`);
    for (const item of lista) {
      console.log(`  chat_id=${item.chat_id}  deal ${item.deal_anterior} → ${item.deal_novo}  (similaridade ${item.similaridade})`);
      console.log(`    assunto anterior: "${item.assunto_anterior}"`);
      console.log(`    assunto novo:     "${item.assunto_novo}"`);
      if (item.area_anterior !== item.area_novo) {
        console.log(`    area anterior: ${item.area_anterior}  |  area nova: ${item.area_novo}`);
      }
      if (item.consulta_anterior_em) console.log(`    consulta anterior em: ${item.consulta_anterior_em}`);
      console.log('');
    }
  }

  // CSV com TODOS os pares analisados, nao so os suspeitos — mesmo padrao de estudar-deals-sem-origem.js.
  const todos = [];
  for (const linha of linhas) {
    const cadeia = montarCadeia(linha);
    if (!cadeia || cadeia.length < 2) continue;
    for (let i = 1; i < cadeia.length; i++) {
      const anterior = cadeia[i - 1];
      const novo = cadeia[i];
      const resultado = classificarPar({
        assuntoAnterior: anterior.assunto,
        areaAnterior: anterior.area,
        assuntoNovo: novo.assunto,
        areaNova: novo.area,
      });
      todos.push({
        chat_id: linha.chat_id,
        deal_anterior: anterior.deal_id || '',
        deal_novo: novo.deal_id || '',
        categoria: resultado.categoria,
        similaridade: resultado.similaridade.toFixed(2),
        assunto_anterior: anterior.assunto || '',
        assunto_novo: novo.assunto || '',
        area_anterior: anterior.area || '',
        area_novo: novo.area || '',
      });
    }
  }
  if (todos.length) {
    const cabecalho = Object.keys(todos[0]);
    const escapar = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [cabecalho.join(','), ...todos.map((l) => cabecalho.map((c) => escapar(l[c])).join(','))].join('\n');
    const nomeArquivo = `deals-duplicados-fase1-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    fs.writeFileSync(nomeArquivo, csv, 'utf8');
    console.log(`📄 CSV com todos os ${todos.length} par(es) gravado em ${nomeArquivo}`);
  }

  console.log('\nFase 1: nada foi alterado.');
  return true;
}

// ---------------------------------------------------------------------------------------------
// FASE 2 — rede real contra o Moskit (--sondar-crm)
// ---------------------------------------------------------------------------------------------

// "{nome} - {assunto}" (montarPayloadMoskit, index.js:1433-1436) — so o PRIMEIRO " - " conta, porque
// o assunto em si pode conter um traco ("Guarda - regulamentacao de visitas").
function extrairNomeCaso(nomeDeal) {
  const nome = String(nomeDeal || '');
  const idx = nome.indexOf(' - ');
  if (idx === -1) return { nomeParte: nome, casoParte: null };
  return { nomeParte: nome.slice(0, idx), casoParte: nome.slice(idx + 3) };
}

function tokensDoTexto(texto) {
  return MOSKIT_IDS.normalizarChave(texto)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS_NOME.has(t));
}

// MEDIDO na primeira rodada (24/08/2026): boa parte dos ~2793 deals do Moskit Boost/manuais NAO
// segue o padrao "{nome} - {assunto}" do bot — vem como "Remoção - Gleibson" (o nome da PESSOA cai
// na metade que a gente chamaria de "caso"). Splitar em nomeParte/casoParte e confiar em "area igual"
// como prova de mesmo caso produziu ~4400 pares, quase todos falsos (duas pessoas diferentes com
// "Remoção" em Direito Administrativo, ou "Fies" em Direito Educacional — sao apenas os TIPOS DE
// CASO mais comuns do escritorio, nao um sinal de identidade).
//
// Correcao: em vez de confiar no split, mede a FREQUENCIA de cada token no nome COMPLETO de todos os
// deals da conta. Token que aparece em muitos deals ("remoção", "fies", "consulta", "contrato",
// sobrenome populacional como "silva"/"oliveira") e generico — nao distingue pessoa nem caso, entao
// nao conta como sinal sozinho. So os tokens RAROS (poucos deals na conta inteira os usam) sao
// especificos o bastante pra apontar pra uma pessoa/caso real. E o mesmo raciocinio de IDF, aplicado
// sem nenhuma biblioteca externa.
function calcularFrequenciaTokens(deals) {
  const freq = new Map();
  for (const d of deals) {
    for (const t of new Set(d.tokensCompletos)) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return freq;
}

// Containment (intersecao / menor conjunto), mais tolerante que Jaccard pra nome: "Ana Paula Silva"
// vs "Ana Paula" tem containment 1.0 (o nome curto e um subconjunto legitimo do longo), Jaccard puniria.
function similaridadeContainment(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

function decodificarArea(entityCustomFields) {
  const campo = (entityCustomFields || []).find((c) => c.id === MOSKIT_IDS.CF.AREA_DIREITO);
  const idOpcao = campo?.options?.[0];
  return idOpcao ? (AREA_ID_PARA_LABEL[idOpcao] || `id:${idOpcao}`) : null;
}

async function paginarTodosDeals() {
  const deals = [];
  let start = 0;
  let pagina = 0;
  let truncou = false;
  let contactsNaListagem = null;
  console.log('Paginando /deals inteiro (pagina de 10, ?start=) — conta inteira, nao so o bot...');
  while (pagina < MAX_PAGINAS) {
    if (pagina > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
    const { data, status } = await axios.get(`${MOSKIT_BASE}/deals`, {
      params: { start, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (status < 200 || status >= 300) {
      console.log(`  ⚠️ HTTP ${status} na pagina start=${start} — parando a varredura aqui`);
      break;
    }
    const lote = Array.isArray(data) ? data : [];
    if (contactsNaListagem === null && lote.length) {
      contactsNaListagem = Array.isArray(lote[0].contacts) && lote[0].contacts.length > 0;
      console.log(`  ℹ️ contacts[] vem na listagem? ${contactsNaListagem ? 'sim' : 'nao'} (${contactsNaListagem ? 'sinal de mesmo-contato disponivel sem GET extra' : 'sem sinal de mesmo-contato nesta varredura'})`);
    }
    for (const d of lote) {
      const { nomeParte, casoParte } = extrairNomeCaso(d.name);
      deals.push({
        id: d.id,
        name: d.name || '',
        origin: d.origin || null,
        status: d.status || null,
        dateCreated: d.dateCreated || null,
        contactId: Array.isArray(d.contacts) && d.contacts.length ? d.contacts[0].id : null,
        nomeParte,
        casoParte,
        tokensCompletos: tokensDoTexto(d.name), // nome INTEIRO — nao confia em qual lado do "-" tem a pessoa
        areaLabel: decodificarArea(d.entityCustomFields),
      });
    }
    pagina++;
    if (pagina % 25 === 0) console.log(`  ... ${pagina} paginas lidas, ${deals.length} deals vistos`);
    if (lote.length < 10) break; // pagina incompleta = fim da lista
    if (pagina === MAX_PAGINAS) truncou = true;
    start += lote.length;
  }
  if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS} paginas atingido — pode haver mais deals alem dos vistos`);

  // A conta muda enquanto a varredura roda (~90s+ de paginacao): um deal criado/movido entre duas
  // paginas pode aparecer duas vezes (?start= e OFFSET, nao cursor estavel). Sem isto, o mesmo deal
  // comparado com ele mesmo entraria como "par candidato" — nao e duplicidade, e artefato de leitura.
  const vistos = new Set();
  const dealsUnicos = deals.filter((d) => (vistos.has(d.id) ? false : (vistos.add(d.id), true)));
  if (dealsUnicos.length !== deals.length) {
    console.log(`  ℹ️ ${deals.length - dealsUnicos.length} deal(s) repetido(s) entre paginas (conta mudou durante a varredura) — descartados`);
  }

  console.log(`✅ Varredura completa: ${pagina} pagina(s), ${dealsUnicos.length} deal(s) na conta inteira\n`);
  return dealsUnicos;
}

// "Generico" e relativo ao UNIVERSO comparado: "fies" e comum na conta inteira (milhares de leads de
// Moskit Boost), mas dentro de SO os deals do bot pode nao ser — recalcula por universo, nunca reusa
// a frequencia da conta inteira quando o universo mudou (--so-bot).
function aplicarFrequenciaTokens(deals) {
  const freq = calcularFrequenciaTokens(deals);
  const LIMIAR_GENERICO = Number(process.env.DUPLICIDADE_TOKEN_DOCFREQ_MAX) || 5;
  for (const d of deals) {
    // dedupe: token repetido dentro do MESMO nome ("...Pessoa De Aguiar... Lucas Pessoa") empurraria
    // o mesmo indice de deal duas vezes no bucket de montarParesCandidatos, formando um par consigo
    // mesmo (i,i) — nao e duplicidade nenhuma, e artefato de tokenizacao.
    d.tokensEspecificos = [...new Set(d.tokensCompletos.filter((t) => (freq.get(t) || 0) <= LIMIAR_GENERICO))];
    d.freqTokens = freq;
  }
  console.log(`ℹ️ ${deals.length} deal(s) no universo comparado; token generico = aparece em mais de ${LIMIAR_GENERICO} deal(s) DESSE universo\n`);
  return deals;
}

// Indice invertido token ESPECIFICO -> deals, pra nao comparar 3000×3000. So vira candidato o par
// que compartilha >=2 tokens especificos, ou 1 token raro o bastante (docFreq<=2 — aparece em no
// maximo 2 deals da conta inteira) — um unico token comum-mas-nao-genérico sozinho (ex. um primeiro
// nome bem distribuido) nao basta.
function montarParesCandidatos(deals) {
  const porToken = new Map();
  deals.forEach((d, i) => {
    for (const t of d.tokensEspecificos) {
      if (!porToken.has(t)) porToken.set(t, []);
      porToken.get(t).push(i);
    }
  });

  const tokensCompartilhados = new Map(); // "i_j" -> Set de tokens
  for (const [token, indices] of porToken) {
    if (indices.length < 2 || indices.length > TOKEN_BUCKET_MAX) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a], j = indices[b];
        if (i === j) continue; // defesa extra: nunca formar par de um deal consigo mesmo
        const chave = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (!tokensCompartilhados.has(chave)) tokensCompartilhados.set(chave, new Set());
        tokensCompartilhados.get(chave).add(token);
      }
    }
  }

  const freq = deals[0]?.freqTokens || new Map();
  const candidatos = [];
  for (const [chave, tokens] of tokensCompartilhados) {
    const raroBastante = tokens.size >= 2 || [...tokens].some((t) => (freq.get(t) || 0) <= 2);
    if (!raroBastante) continue;
    candidatos.push(chave.split('_').map(Number));
  }
  return candidatos;
}

function classificarParNomeCaso(a, b) {
  const nomeIgual = a.nomeParte && b.nomeParte
    && MOSKIT_IDS.normalizarChave(a.nomeParte) === MOSKIT_IDS.normalizarChave(b.nomeParte);
  // Similaridade calculada so sobre os tokens ESPECIFICOS (sem os genericos) — mede quanto do que e
  // DISTINTIVO em cada nome aparece no outro, ignorando tipo-de-caso e sobrenome populacional.
  const nomeSimilaridade = similaridadeContainment(a.tokensEspecificos, b.tokensEspecificos);

  const casoSimilaridade = (a.casoParte && b.casoParte) ? similaridadeTexto(a.casoParte, b.casoParte) : null;
  const areaIgual = a.areaLabel && b.areaLabel ? a.areaLabel === b.areaLabel : null;
  const mesmoContato = a.contactId && b.contactId ? a.contactId === b.contactId : null;

  if (!nomeIgual && nomeSimilaridade < NOME_LIMIAR && mesmoContato !== true) return null;

  // "Area igual" sozinho NUNCA e prova de mesmo caso (so 11 areas possiveis na conta inteira — duas
  // pessoas diferentes caem na mesma o tempo todo). So conta com o contato batendo no CRM ou o texto
  // do "caso" de fato parecido.
  const casoParece = mesmoContato === true || (casoSimilaridade !== null && casoSimilaridade >= CASO_LIMIAR);

  let categoria;
  if (casoParece) categoria = 'mesmo_nome_mesmo_caso';
  else if (casoSimilaridade !== null || areaIgual !== null) categoria = 'mesmo_nome_caso_diferente';
  else categoria = 'mesmo_nome_sem_info_de_caso';

  return {
    categoria, nomeIgual, nomeSimilaridade, casoSimilaridade, areaIgual, mesmoContato,
  };
}

function relatorioFase2(deals, pares) {
  const grupos = { mesmo_nome_mesmo_caso: [], mesmo_nome_caso_diferente: [], mesmo_nome_sem_info_de_caso: [] };

  for (const [i, j] of pares) {
    const a = deals[i], b = deals[j];
    const r = classificarParNomeCaso(a, b);
    if (!r) continue;
    grupos[r.categoria].push({ a, b, ...r });
  }

  console.log(`\n📊 FASE 2 — pares candidatos por nome parecido/igual (limiar nome ${NOME_LIMIAR}, limiar caso ${CASO_LIMIAR}):\n`);
  console.log(`  ⚠️ mesmo_nome_mesmo_caso: ${grupos.mesmo_nome_mesmo_caso.length}  (candidato principal a duplicidade real)`);
  console.log(`     mesmo_nome_caso_diferente: ${grupos.mesmo_nome_caso_diferente.length}  (pode ser retorno legitimo — pessoa homonima ou caso novo)`);
  console.log(`     mesmo_nome_sem_info_de_caso: ${grupos.mesmo_nome_sem_info_de_caso.length}  (nome bate, mas nao ha assunto/area/contato pra confirmar)`);

  for (const cat of ['mesmo_nome_mesmo_caso', 'mesmo_nome_caso_diferente']) {
    const lista = grupos[cat];
    if (!lista.length) continue;
    console.log(`\n--- ${cat} (${lista.length}) ---`);
    for (const { a, b, nomeIgual, nomeSimilaridade, casoSimilaridade, areaIgual, mesmoContato } of lista) {
      console.log(`  deal ${a.id} (${a.status}, ${a.origin || '(sem origin)'}, ${a.dateCreated}) ↔ deal ${b.id} (${b.status}, ${b.origin || '(sem origin)'}, ${b.dateCreated})`);
      console.log(`    nome 1: "${a.name}"`);
      console.log(`    nome 2: "${b.name}"`);
      console.log(`    nome ${nomeIgual ? 'IDENTICO' : `similaridade ${nomeSimilaridade.toFixed(2)}`}${mesmoContato ? '  |  MESMO CONTATO NO CRM' : ''}`);
      if (areaIgual !== null) console.log(`    area: "${a.areaLabel}" vs "${b.areaLabel}" (${areaIgual ? 'igual' : 'diferente'})`);
      if (casoSimilaridade !== null) console.log(`    caso: "${a.casoParte}" vs "${b.casoParte}" (similaridade ${casoSimilaridade.toFixed(2)})`);
      console.log('');
    }
  }

  const todos = [];
  for (const cat of Object.keys(grupos)) {
    for (const { a, b, nomeIgual, nomeSimilaridade, casoSimilaridade, areaIgual, mesmoContato } of grupos[cat]) {
      todos.push({
        categoria: cat,
        deal_1: a.id, nome_1: a.name, origin_1: a.origin || '', status_1: a.status || '', criado_1: a.dateCreated || '',
        deal_2: b.id, nome_2: b.name, origin_2: b.origin || '', status_2: b.status || '', criado_2: b.dateCreated || '',
        nome_identico: nomeIgual, nome_similaridade: nomeSimilaridade.toFixed(2),
        caso_similaridade: casoSimilaridade === null ? '' : casoSimilaridade.toFixed(2),
        area_igual: areaIgual === null ? '' : areaIgual,
        mesmo_contato: mesmoContato === null ? '' : mesmoContato,
      });
    }
  }
  if (todos.length) {
    const cabecalho = Object.keys(todos[0]);
    const escapar = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [cabecalho.join(','), ...todos.map((l) => cabecalho.map((c) => escapar(l[c])).join(','))].join('\n');
    const nomeArquivo = `deals-duplicados-fase2-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    fs.writeFileSync(nomeArquivo, csv, 'utf8');
    console.log(`📄 CSV com todos os ${todos.length} par(es) candidato(s) gravado em ${nomeArquivo}`);
  } else {
    console.log('\n(nenhum par candidato encontrado com os limiares atuais)');
  }

  console.log('\nFase 2: nada foi alterado no Moskit — so leitura (GET /deals).');
}

// --so-bot: restringe a comparacao aos deals com origin===BOT_WHATSAPP, do primeiro ao ultimo — "desde
// o dia que o bot foi criado e comecou a fazer a automacao" e o intervalo natural desse subconjunto
// (o campo nativo `origin` e gravado pelo PROPRIO Moskit a partir do header X-Ollow-Origin que toda
// escrita do bot manda; nao existe candidato ANTES do primeiro deal do bot). Restringir o universo
// aqui, em vez de so filtrar o RELATORIO depois de comparar a conta inteira, muda o que conta como
// "generico" em aplicarFrequenciaTokens: "fies"/"remoção" podem ser raros na conta inteira (que tem
// milhares de leads de Moskit Boost sobre assuntos variados) mas comuns SO entre os casos do bot —
// comparar dentro do universo certo evita tanto falso positivo (herdado do Boost) quanto falso
// negativo (limiar calibrado pra um universo 30x maior).
async function fase2({ soBot } = {}) {
  if (!process.env.MOSKIT_API_KEY) {
    console.log('❌ MOSKIT_API_KEY nao configurada (.env) — Fase 2 precisa da API real do Moskit.');
    process.exitCode = 1;
    return;
  }
  const todos = await paginarTodosDeals();
  if (!todos.length) {
    console.log('Nenhum deal lido — nada para comparar.');
    return;
  }

  let deals = todos;
  if (soBot) {
    deals = todos.filter((d) => d.origin === 'BOT_WHATSAPP');
    if (!deals.length) {
      console.log('❌ Nenhum deal com origin=BOT_WHATSAPP encontrado — nada para comparar em --so-bot.');
      return;
    }
    const datas = deals.map((d) => d.dateCreated).filter(Boolean).sort();
    console.log(`🤖 --so-bot: restringindo a ${deals.length} deal(s) do bot (de ${todos.length} na conta inteira).`);
    console.log(`   primeiro deal do bot: ${datas[0]}  |  ultimo: ${datas[datas.length - 1]}`);
    console.log('   (origin=BOT_WHATSAPP e gravado pelo Moskit a partir do header X-Ollow-Origin de toda escrita do bot)\n');
  }

  aplicarFrequenciaTokens(deals);
  console.log(`Montando pares candidatos por token de nome (${deals.length} deals)...`);
  const pares = montarParesCandidatos(deals);
  console.log(`${pares.length} par(es) candidato(s) por nome — classificando por caso/area/contato...\n`);
  relatorioFase2(deals, pares);
}

async function main() {
  const argDb = process.argv.find((a) => a.startsWith('--db='));
  const caminhoBanco = argDb ? argDb.slice('--db='.length) : (process.env.CONVERSATIONS_DB || 'conversations.db');
  const rodarFase2 = process.argv.includes('--sondar-crm');
  const soBot = process.argv.includes('--so-bot');

  fase1(caminhoBanco);

  if (rodarFase2) {
    await fase2({ soBot });
  } else {
    console.log('\n(Fase 2 nao rodou — passe --sondar-crm pra varrer o Moskit real por nome+caso parecidos; some --so-bot pra restringir aos deals do bot.)');
  }
}

main();
