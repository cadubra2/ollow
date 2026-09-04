// Deteccao de deal DUPLICADO por nome+caso — logica PURA: sem rede, sem banco, sem console.
//
// Extraido de estudar-deals-duplicados.js (fase 2) em 02/09/2026 para poder ser reusado pelo
// relatorio de auditoria (auditar-crm-relatar.js) sem duplicar a regra. Toda a calibragem que foi
// MEDIDA contra a conta real em 24/08/2026 esta preservada aqui — os comentarios que explicam POR QUE
// cada limiar existe vieram junto, porque sao eles que impedem a proxima pessoa de "simplificar" o
// filtro de IDF e voltar aos ~4400 pares falsos da primeira rodada.
//
// Nada aqui escreve, imprime ou faz IO. Quem chama decide o que logar e o que fazer com os pares.
const MOSKIT_IDS = require('./moskit-ids');

// Tokens que sozinhos nao distinguem pessoa nenhuma.
const STOPWORDS_NOME = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'dr', 'dra', 'sr', 'sra']);

// Defaults identicos aos que estudar-deals-duplicados.js usava antes da extracao — mesma leitura de
// env, mesmos numeros. Trocar aqui muda os dois consumidores de uma vez, que e o ponto do modulo.
const LIMIARES_PADRAO = {
  nome: Number(process.env.DUPLICIDADE_NOME_LIMIAR) || 0.75,
  caso: Number(process.env.DUPLICIDADE_CASO_LIMIAR) || 0.4,
  // Token presente em mais que isso no universo comparado e generico — nao serve de sinal sozinho.
  docFreqMax: Number(process.env.DUPLICIDADE_TOKEN_DOCFREQ_MAX) || 5,
  // Bucket maior que isso no indice invertido explodiria em pares (ex. "silva"/"maria").
  tokenBucketMax: Number(process.env.DUPLICIDADE_TOKEN_BUCKET_MAX) || 400,
};

const AREA_ID_PARA_LABEL = Object.fromEntries(
  Object.entries(MOSKIT_IDS.AREA_DIREITO).map(([label, id]) => [id, label])
);

// "{nome} - {assunto}" (montarPayloadMoskit, index.js:1590-1593) — so o PRIMEIRO " - " conta, porque
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

// Jaccard sobre tokens normalizados. Sinal de AUDITORIA, a producao nao usa nada parecido — serve
// para priorizar revisao manual, nunca para decidir sozinho (por isso nao entra em cliente-retorno.js).
function similaridadeTexto(a, b) {
  const tokA = new Set(MOSKIT_IDS.normalizarChave(a).split(' ').filter(Boolean));
  const tokB = new Set(MOSKIT_IDS.normalizarChave(b).split(' ').filter(Boolean));
  if (!tokA.size || !tokB.size) return 0;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  const uniao = new Set([...tokA, ...tokB]).size;
  return uniao ? inter / uniao : 0;
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

// Deal cru da API -> a projecao minima que a comparacao precisa. Uma funcao so, para o coletor, o
// estudo antigo e o relatorio novo lerem o MESMO formato.
function normalizarDeal(d) {
  const { nomeParte, casoParte } = extrairNomeCaso(d.name);
  return {
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
  };
}

function calcularFrequenciaTokens(deals) {
  const freq = new Map();
  for (const d of deals) {
    for (const t of new Set(d.tokensCompletos)) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return freq;
}

// MEDIDO na primeira rodada (24/08/2026): boa parte dos ~2793 deals do Moskit Boost/manuais NAO segue
// o padrao "{nome} - {assunto}" do bot — vem como "Remocao - Gleibson" (o nome da PESSOA cai na
// metade que a gente chamaria de "caso"). Splitar em nomeParte/casoParte e confiar em "area igual"
// como prova de mesmo caso produziu ~4400 pares, quase todos falsos.
//
// Correcao: mede a FREQUENCIA de cada token no nome COMPLETO de todos os deals do universo. Token que
// aparece em muitos deals ("fies", "consulta", "silva") e generico — nao distingue pessoa nem caso.
// So os tokens RAROS apontam pra identidade real. E IDF, sem biblioteca externa.
//
// "Generico" e relativo ao UNIVERSO comparado: "fies" e comum na conta inteira mas pode ser raro
// dentro so dos deals do bot — recalcular por universo, nunca reusar a frequencia da conta inteira.
// MUTA os deals (grava tokensEspecificos/freqTokens), como o codigo original fazia.
function aplicarFrequenciaTokens(deals, opcoes = {}) {
  const { docFreqMax = LIMIARES_PADRAO.docFreqMax } = opcoes;
  const freq = calcularFrequenciaTokens(deals);
  for (const d of deals) {
    // dedupe: token repetido dentro do MESMO nome ("...Pessoa De Aguiar... Lucas Pessoa") empurraria
    // o mesmo indice de deal duas vezes no bucket de montarParesCandidatos, formando um par consigo
    // mesmo (i,i) — nao e duplicidade, e artefato de tokenizacao.
    d.tokensEspecificos = [...new Set(d.tokensCompletos.filter((t) => (freq.get(t) || 0) <= docFreqMax))];
    d.freqTokens = freq;
  }
  return { deals, freq, docFreqMax };
}

// Indice invertido token ESPECIFICO -> deals, pra nao comparar 3000x3000. So vira candidato o par que
// compartilha >=2 tokens especificos, ou 1 token raro o bastante (docFreq<=2) — um unico token
// comum-mas-nao-generico sozinho (ex. um primeiro nome bem distribuido) nao basta.
function montarParesCandidatos(deals, opcoes = {}) {
  const { tokenBucketMax = LIMIARES_PADRAO.tokenBucketMax } = opcoes;
  const porToken = new Map();
  deals.forEach((d, i) => {
    for (const t of d.tokensEspecificos || []) {
      if (!porToken.has(t)) porToken.set(t, []);
      porToken.get(t).push(i);
    }
  });

  const tokensCompartilhados = new Map(); // "i_j" -> Set de tokens
  for (const [token, indices] of porToken) {
    if (indices.length < 2 || indices.length > tokenBucketMax) continue;
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

function classificarParNomeCaso(a, b, opcoes = {}) {
  const { nome: nomeLimiar = LIMIARES_PADRAO.nome, caso: casoLimiar = LIMIARES_PADRAO.caso } = opcoes;

  const nomeIgual = a.nomeParte && b.nomeParte
    && MOSKIT_IDS.normalizarChave(a.nomeParte) === MOSKIT_IDS.normalizarChave(b.nomeParte);
  // Similaridade so sobre os tokens ESPECIFICOS (sem os genericos) — mede quanto do que e DISTINTIVO
  // em cada nome aparece no outro, ignorando tipo-de-caso e sobrenome populacional.
  const nomeSimilaridade = similaridadeContainment(a.tokensEspecificos, b.tokensEspecificos);

  const casoSimilaridade = (a.casoParte && b.casoParte) ? similaridadeTexto(a.casoParte, b.casoParte) : null;
  const areaIgual = a.areaLabel && b.areaLabel ? a.areaLabel === b.areaLabel : null;
  const mesmoContato = a.contactId && b.contactId ? a.contactId === b.contactId : null;

  if (!nomeIgual && nomeSimilaridade < nomeLimiar && mesmoContato !== true) return null;

  // "Area igual" sozinho NUNCA e prova de mesmo caso (so 11 areas possiveis — duas pessoas diferentes
  // caem na mesma o tempo todo). So conta com o contato batendo no CRM ou o texto do caso parecido.
  const casoParece = mesmoContato === true || (casoSimilaridade !== null && casoSimilaridade >= casoLimiar);

  let categoria;
  if (casoParece) categoria = 'mesmo_nome_mesmo_caso';
  else if (casoSimilaridade !== null || areaIgual !== null) categoria = 'mesmo_nome_caso_diferente';
  else categoria = 'mesmo_nome_sem_info_de_caso';

  return { categoria, nomeIgual, nomeSimilaridade, casoSimilaridade, areaIgual, mesmoContato };
}

module.exports = {
  STOPWORDS_NOME,
  LIMIARES_PADRAO,
  AREA_ID_PARA_LABEL,
  extrairNomeCaso,
  tokensDoTexto,
  similaridadeTexto,
  similaridadeContainment,
  decodificarArea,
  normalizarDeal,
  calcularFrequenciaTokens,
  aplicarFrequenciaTokens,
  montarParesCandidatos,
  classificarParNomeCaso,
};
