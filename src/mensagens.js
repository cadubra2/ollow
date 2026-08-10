// Identidade e ordenacao das mensagens de uma conversa.
//
// O array `conversations.messages` e alimentado por DUAS rotas que gravavam formatos diferentes:
//   - webhook (index.js)             -> { role, text, timestamp: agora }        SEM id_zernio
//   - polling (sincronizarConversas) -> { role, text, timestamp: m.createdAt, id_zernio }
//
// A deduplicacao do polling era feita so por `id_zernio`, entao toda mensagem que entrou pelo
// webhook era invisivel pra ela: quando o polling precisava buscar uma mensagem perdida, repuxava o
// historico inteiro da API e re-adicionava tudo. Medido em producao: 47 de 204 conversas com texto
// duplicado; uma delas com 21% do conteudo repetido, reenviado a OpenAI a cada ciclo.
//
// Alem disso os dois carimbos de tempo vinham de relogios diferentes e o polling anexava no fim do
// array, deixando 50 conversas fora de ordem cronologica — o que quebra os cabecalhos de dia de
// montarHistorico e, por tabela, a resolucao de datas do prompt e o msg_idx da validacao de
// evidencia.

// Placeholder de anexo: o texto e sempre o mesmo, entao 16 imagens enviadas em sequencia produzem
// 16 linhas identicas. Sao mensagens DISTINTAS — nunca podem ser fundidas por conteudo.
const RE_ANEXO = /^\s*📎/;

// Abaixo deste tamanho, texto repetido e comum e legitimo ("ok", "sim", "obrigado", "bom dia").
// Fundir por conteudo nesse caso apagaria mensagem de verdade.
const MIN_CHARS_DEDUP_CONTEUDO = 25;

// Duas linhas so podem ser consideradas o mesmo evento por semelhanca de conteudo quando o texto e
// longo e especifico o bastante pra que a coincidencia seja implausivel. Fora disso, so id_zernio
// igual prova que sao a mesma mensagem.
function deduplicavelPorConteudo(m) {
  const t = String(m?.text || '').trim();
  if (RE_ANEXO.test(t)) return false;
  return t.length >= MIN_CHARS_DEDUP_CONTEUDO;
}

// Chave forte: mesma mensagem do Zernio, sem ambiguidade.
function chaveZernio(m) {
  return m?.id_zernio ? `z:${m.id_zernio}` : null;
}

// Chave fraca (heuristica), so aplicavel a quem passa em deduplicavelPorConteudo. O minuto de
// precisao absorve a diferenca entre a hora de chegada no webhook e o createdAt do Zernio.
function chaveConteudo(m) {
  return `c:${m?.role}|${String(m?.text || '').trim()}|${String(m?.timestamp || '').slice(0, 16)}`;
}

// Chave usada por quem so precisa de um identificador estavel (ex.: detectar reentrega do webhook).
function chaveMensagem(m) {
  return chaveZernio(m) || chaveConteudo(m);
}

// A mensagem `nova` ja existe em `existentes`? Regra dupla: id igual sempre conta; conteudo igual
// so conta pra texto longo que nao seja anexo.
function jaExiste(nova, existentes) {
  const idNova = chaveZernio(nova);
  for (const m of existentes) {
    if (idNova && chaveZernio(m) === idNova) return true;
    if (deduplicavelPorConteudo(nova) && deduplicavelPorConteudo(m)
        && chaveConteudo(m) === chaveConteudo(nova)) return true;
  }
  return false;
}

function ordenarPorTempo(mensagens) {
  return [...(mensagens || [])].sort((a, b) => {
    const ta = new Date(a?.timestamp).getTime();
    const tb = new Date(b?.timestamp).getTime();
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;   // sem timestamp vai pro fim, nao embaralha o resto
    if (isNaN(tb)) return -1;
    return ta - tb;
  });
}

// Remove duplicatas preservando a PRIMEIRA ocorrencia e devolve em ordem cronologica.
// Duas passadas, com criterios de forca diferente:
//   1) id_zernio igual  -> mesma mensagem, sem duvida
//   2) conteudo igual   -> so pra texto longo nao-anexo; e o caso do par webhook/polling em que uma
//                          das linhas nao tem id. Quando funde, mantem o id que existir.
function normalizarMensagens(mensagens) {
  const ordenadas = ordenarPorTempo(mensagens).filter(Boolean);

  const porId = [];
  const idsVistos = new Set();
  for (const m of ordenadas) {
    const id = chaveZernio(m);
    if (id) {
      if (idsVistos.has(id)) continue;
      idsVistos.add(id);
    }
    porId.push(m);
  }

  const resultado = [];
  const porConteudo = new Map();
  for (const m of porId) {
    if (!deduplicavelPorConteudo(m)) {
      resultado.push(m);        // anexo e texto curto passam intocados
      continue;
    }
    const k = chaveConteudo(m);
    const anterior = porConteudo.get(k);
    if (!anterior) {
      porConteudo.set(k, m);
      resultado.push(m);
    } else if (!anterior.id_zernio && m.id_zernio) {
      // Mantem a linha ja posicionada, so herda o id — assim o polling a reconhece daqui pra frente.
      anterior.id_zernio = m.id_zernio;
    }
  }

  return ordenarPorTempo(resultado);
}

// Quantas linhas seriam removidas / quantas estao fora de ordem. Usado pelo script de limpeza e
// pelos testes para afirmar que o problema foi a zero.
function diagnosticar(mensagens) {
  const original = mensagens || [];
  const limpo = normalizarMensagens(original.map((m) => ({ ...m })));
  let foraDeOrdem = 0;
  for (let i = 1; i < original.length; i++) {
    const a = new Date(original[i - 1]?.timestamp).getTime();
    const b = new Date(original[i]?.timestamp).getTime();
    if (!isNaN(a) && !isNaN(b) && b < a) foraDeOrdem++;
  }
  return { total: original.length, duplicadas: original.length - limpo.length, foraDeOrdem };
}

module.exports = {
  RE_ANEXO,
  MIN_CHARS_DEDUP_CONTEUDO,
  deduplicavelPorConteudo,
  chaveMensagem,
  jaExiste,
  ordenarPorTempo,
  normalizarMensagens,
  diagnosticar,
};
