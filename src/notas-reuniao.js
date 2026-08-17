// Notas de reuniao do Gemini (Google Meet) -> nota no negocio do Moskit.
//
// Aqui fica tudo que decide, e nada que faz rede: parse do assunto, extracao dos sinais de
// identidade, a cascata que escolhe o negocio, a validacao da saida da IA e a montagem do texto.
// O index.js faz Gmail/Drive/Calendar/OpenAI/Moskit e chama estas funcoes no meio. Mesma divisao
// que src/evidencia.js tem com o pipeline: a IA propoe, o codigo deterministico decide.
//
// Este modulo NAO pode require('./index.js') — o index.js e quem o carrega (ciclo).
//
// O QUE FOI MEDIDO na caixa escritoriocr2019@gmail.com e na agenda do escritorio em 16/08/2026,
// e que sustenta as decisoes abaixo:
//
//   - Remetente `gemini-notes@google.com`. Assunto em duas formas:
//       Notas: "Consulta — Lia 🇧🇷💛💚 (Berto)" de 14/08/2026        (reuniao com evento na agenda)
//       Notas: reunião de 5/08/2026 à(s) 4:37 PM GMT-03:00          (reuniao avulsa, sem titulo)
//   - `meetings-noreply@google.com` manda "Problema com as notas: ..." quando o Gemini FALHA.
//     Esse e-mail nao tem nota nenhuma e nao pode entrar na fila (o filtro esta no index.js, pelo
//     remetente; aqui parseAssuntoGemini tambem o recusa, porque nao comeca com "Notas:").
//   - O CORPO do e-mail ja traz o resumo inteiro e os proximos passos. O Doc so acrescenta a
//     transcricao literal, e so existe se alguem a ligou na reuniao. Por isso o corpo e obrigatorio
//     e o Doc e bonus.
//   - O evento da agenda traz o Doc em `attachments[].fileUrl` (campo estruturado, sem HTML) e o
//     telefone do cliente em `description` ("Telefone: 558681876734"), que e a chave de
//     conversations.chat_id.
//   - COBERTURA REAL: dos 6 eventos que geraram notas nos ultimos 30 dias, 4 tinham "Telefone:"
//     (foram criados pelo bot) e 2 nao (criados na mao: "Consulta online - Berto e Aurinete",
//     "Consulta online- Iury e Arthur"). Ou seja, ~1/3 depende do fallback — ele nao e caso raro,
//     e parte dele vai virar orfao mesmo. Por isso o orfao e um desfecho de primeira classe aqui,
//     com diagnostico e comando de religar, nao um erro envergonhado.

const crypto = require('crypto');
const { horarioNaiveParaInstante } = require('./atividade-moskit');

// ------------------------------------------------------------
// Assunto do e-mail
// ------------------------------------------------------------

// As duas formas medidas, mais o prefixo de encaminhamento (alguem da equipe repassando o e-mail
// para a caixa do escritorio — o assunto original sobrevive depois do "Enc:").
const RE_ASSUNTO = /^\s*(?:(?:re|fwd|enc|encaminhado)\s*:\s*)*notas\s*:\s*(?:"([^"]+)"|reuni[ãa]o)\s+de\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/iu;

// "14/08/2026" -> { tituloEvento, dataIso: "2026-08-14" }. Devolve null para qualquer assunto que
// nao seja de notas — inclusive o "Problema com as notas:", que e o aviso de FALHA do Gemini.
//
// A data sai do assunto como string e permanece string ate virar instante em janelaDoDia. Nenhum
// `new Date()` no meio: o assunto diz o dia no fuso do escritorio, e converter cedo demais e como
// os bugs de fuso deste projeto sempre comecaram.
function parseAssuntoGemini(assunto) {
  const casado = RE_ASSUNTO.exec(String(assunto || ''));
  if (!casado) return null;

  const [, titulo, dia, mes, ano] = casado;
  const dataIso = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  // Guarda contra assunto com data impossivel (o padStart aceitaria "99/99/2026").
  if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) return null;

  return { tituloEvento: titulo ? titulo.trim() : null, dataIso };
}

function somarDias(dataIso, dias) {
  const [a, m, d] = dataIso.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  t.setUTCDate(t.getUTCDate() + dias);
  return t.toISOString().slice(0, 10);
}

// Janela de busca no Google Agenda para o dia da reuniao, no fuso do escritorio.
// Reusa horarioNaiveParaInstante em vez de fixar offset — mesmo motivo documentado la.
function janelaDoDia(dataIso, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataIso || ''))) return null;
  const timeMin = horarioNaiveParaInstante(`${dataIso}T00:00:00`, timeZone);
  const timeMax = horarioNaiveParaInstante(`${somarDias(dataIso, 1)}T00:00:00`, timeZone);
  return timeMin && timeMax ? { timeMin, timeMax } : null;
}

// ------------------------------------------------------------
// Doc das notas
// ------------------------------------------------------------

const RE_DOC = /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/;

// O link no corpo HTML vem embrulhado no redirecionador do Google
// (https://www.google.com/url?q=<url-encodada>&source=...), entao o regex direto nao casa. Aqui o
// texto e "desembrulhado" antes: as ocorrencias de ?q= sao decodificadas e concatenadas ao espaco
// de busca. Tambem desfaz &amp;, que o HTML traz e quebraria o decode.
function extrairDocId(texto) {
  const bruto = String(texto || '').replace(/&amp;/g, '&');

  const direto = RE_DOC.exec(bruto);
  if (direto) return direto[1];

  for (const casado of bruto.matchAll(/[?&]q=([^&"'\s>]+)/g)) {
    let decodificado;
    try {
      decodificado = decodeURIComponent(casado[1]);
    } catch {
      continue; // percent-encoding quebrado: ignora esta ocorrencia, tenta as outras
    }
    const achado = RE_DOC.exec(decodificado);
    if (achado) return achado[1];
  }

  return null;
}

// O caminho preferido: campo estruturado do evento, sem parsear HTML nenhum.
function extrairDocIdDeEvento(evento) {
  for (const anexo of evento?.attachments || []) {
    const achado = extrairDocId(anexo?.fileUrl);
    if (achado) return achado;
  }
  return null;
}

// ------------------------------------------------------------
// Sinais de identidade
// ------------------------------------------------------------

const RE_DEAL_MARCADO = /\[deal:(\d{3,})\]/i;
const RE_TELEFONE = /Telefone:\s*(\d{8,})/i;
// "ID 45892" escrito a mao por alguem que encaminhou o e-mail. Minimo de 5 digitos para nao casar
// com numero solto de lista ("ID 3") nem com o ano.
const RE_ID_SOLTO = /\bID\s*[:#]?\s*(\d{5,})\b/i;

// O "· #48292471" que montarResumoEvento poe no fim do TITULO do evento. E o sinal mais valioso da
// cascata porque o assunto do e-mail do Gemini reproduz o titulo entre aspas — ou seja, ele chega
// sem que seja preciso achar o evento na agenda.
//
// Aplicado SO a titulo e assunto, nunca ao corpo do e-mail nem a transcricao. Num texto de fala
// corrida "#" seguido de numero e ruido provavel; num titulo que o proprio bot escreveu, e
// declaracao. O minimo de 5 digitos e a mesma guarda de RE_ID_SOLTO.
const RE_DEAL_TITULO = /#(\d{5,})\b/;

// Extrai, sem consultar nada, tudo que pode apontar para um negocio. O index.js usa isto para
// decidir QUE consultas fazer (e evitar a varredura cara de /activities quando ja ha sinal melhor).
// A TRANSCRICAO NAO ENTRA AQUI, e e por isso que ela nem aparece na assinatura. Nenhum sinal de
// identidade sai do texto do Doc: transcricao e fala corrida, onde "ID 45892" e "#99887766" podem ser
// um protocolo que o cliente leu em voz alta, um numero de processo, qualquer coisa. Vincular a nota
// de um caso ao negocio errado por causa de um numero dito de passagem e o defeito mais caro que esta
// rotina pode ter. O Doc serve para a IA extrair conteudo — nunca para decidir de quem e a reuniao.
function extrairSinais({ evento, assunto, corpo }) {
  const descricao = evento?.description || '';
  const marcado = RE_DEAL_MARCADO.exec(descricao);
  const telefone = RE_TELEFONE.exec(descricao);

  // SO no assunto. O corpo tambem esta fora, pelo mesmo motivo da transcricao: ele e o resumo que o
  // Gemini escreveu a partir da fala, entao "o ID 12345678 do processo administrativo" — um numero
  // que o cliente leu em voz alta — viraria vinculo de confianca ALTA com um negocio qualquer. O
  // assunto e o unico lugar onde escrever um ID e ato deliberado de quem encaminhou o e-mail.
  const idSolto = RE_ID_SOLTO.exec(String(assunto || ''));

  // O numero no titulo, vindo do evento OU do proprio assunto do e-mail (que reproduz o titulo entre
  // aspas). A segunda origem e o ponto da mudanca: ela funciona com o evento ausente.
  const tituloDoAssunto = parseAssuntoGemini(assunto)?.tituloEvento || null;
  const noTitulo = RE_DEAL_TITULO.exec(evento?.summary || '') || RE_DEAL_TITULO.exec(tituloDoAssunto || '');

  // Participantes, menos a propria caixa do escritorio (que e organizadora de tudo e nao identifica
  // ninguem).
  const organizador = String(evento?.organizer?.email || '').toLowerCase();
  const emails = (evento?.attendees || [])
    .map((a) => String(a?.email || '').toLowerCase())
    .filter((e) => e && e !== organizador && !e.endsWith('.calendar.google.com'));

  return {
    dealIdNoTitulo: noTitulo ? Number(noTitulo[1]) : null,
    dealIdMarcado: marcado ? Number(marcado[1]) : null,
    telefone: telefone ? telefone[1] : null,
    idSolto: idSolto ? Number(idSolto[1]) : null,
    tituloDoAssunto,
    emails: [...new Set(emails)],
    docId: extrairDocIdDeEvento(evento) || extrairDocId(corpo),
    tituloEvento: evento?.summary || null,
    eventoId: evento?.id || null,
    inicioIso: evento?.start?.dateTime || null,
  };
}

// ------------------------------------------------------------
// A cascata
// ------------------------------------------------------------

// Regra unica, e ela vale para TODO passo: candidato unico ou nada.
//
// Nunca "o primeiro", nunca "o mais proximo". Duas consultas as 15h com advogados diferentes fariam
// a nota do caso de um cliente cair no negocio de outro. Dentro do CRM isso e vazamento de sigilo,
// e ninguem detecta lendo — a nota parece perfeitamente plausivel no negocio errado.
//
// E quando um passo devolve DOIS candidatos, a cascata para ali em vez de tentar o passo seguinte:
// dois resultados nao querem dizer "sinal fraco, tente outro", querem dizer "este sinal aponta para
// dois negocios reais". Cair para um sinal mais fraco depois disso e trocar uma duvida conhecida
// por um palpite.
function decidirDeal(sinais, achados) {
  const passos = [
    // Primeiro o titulo: e o unico sinal deterministico que NAO depende de achar o evento na agenda.
    { metodo: 'titulo_deal_id', confianca: 'alta', ids: sinais.dealIdNoTitulo ? [sinais.dealIdNoTitulo] : [] },
    { metodo: 'evento_deal_id', confianca: 'alta', ids: sinais.dealIdMarcado ? [sinais.dealIdMarcado] : [] },
    { metodo: 'evento_telefone', confianca: 'alta', ids: achados.porTelefone || [] },
    { metodo: 'id_no_texto', confianca: 'alta', ids: sinais.idSolto ? [sinais.idSolto] : [] },
    { metodo: 'atividade_moskit', confianca: 'media', ids: achados.porAtividade || [] },
    { metodo: 'email_participante', confianca: 'media', ids: achados.porEmail || [] },
  ];

  const diagnostico = {
    tituloEvento: sinais.tituloEvento,
    eventoId: sinais.eventoId,
    inicioIso: sinais.inicioIso,
    telefone: sinais.telefone,
    emails: sinais.emails,
    passos: passos.map((p) => ({ metodo: p.metodo, encontrados: [...new Set(p.ids)] })),
    // Teto de paginacao de /activities: sem isto, "varri tudo e nao achei" e indistinguivel de
    // "parei no teto". E a mesma armadilha que ja enganou a sincronizacao de atividades.
    atividadesTruncadas: !!achados.truncouAtividades,
    semEvento: !sinais.eventoId,
  };

  // Os dois marcadores explicitos discordando e um caso a parte, conferido ANTES da cascata: nao ha
  // desempate honesto entre "#111" no titulo e "[deal:222]" na descricao. Significa evento copiado de
  // outro cliente com so um dos dois atualizado — e aceitar o primeiro da lista poria a nota do caso
  // de um cliente no negocio de outro, que e exatamente o que a regra do candidato unico existe para
  // impedir. Motivo proprio porque a correcao e diferente da de uma ambiguidade comum: aqui alguem
  // precisa arrumar o evento, nao a regra.
  if (sinais.dealIdNoTitulo && sinais.dealIdMarcado && sinais.dealIdNoTitulo !== sinais.dealIdMarcado) {
    return {
      dealId: null,
      metodo: 'marcadores_divergentes',
      confianca: null,
      candidatos: [sinais.dealIdNoTitulo, sinais.dealIdMarcado],
      diagnostico: { ...diagnostico, tituloDizia: sinais.dealIdNoTitulo, descricaoDizia: sinais.dealIdMarcado },
    };
  }

  for (const passo of passos) {
    const ids = [...new Set(passo.ids.filter((id) => Number.isFinite(Number(id)) && Number(id) > 0).map(Number))];
    if (ids.length === 1) {
      return { dealId: ids[0], metodo: passo.metodo, confianca: passo.confianca, candidatos: ids, diagnostico };
    }
    if (ids.length > 1) {
      return { dealId: null, metodo: 'ambiguidade', confianca: null, candidatos: ids, diagnostico: { ...diagnostico, ambiguoEm: passo.metodo } };
    }
  }

  return { dealId: null, metodo: 'nao_encontrado', confianca: null, candidatos: [], diagnostico };
}

// ------------------------------------------------------------
// Texto-fonte para a IA
// ------------------------------------------------------------

// O corpo do e-mail e obrigatorio; o Doc entra depois quando existe.
//
// Se estourar o teto, corta pelo COMECO e preserva a cauda: "proximos passos", "documentos
// solicitados" e "proposta de valores" ficam no FIM de uma reuniao. Truncar pela cabeca produz uma
// nota confiante e sem justamente o que se queria extrair. E a truncagem e sempre anunciada — no
// texto que vai para a IA e no rodape da nota.
function prepararTextoFonte({ corpo, textoDoc, maxChars = 120000 }) {
  const partes = [
    `=== RESUMO ENVIADO POR E-MAIL (Gemini) ===\n${String(corpo || '').trim()}`,
    textoDoc ? `=== TRANSCRIÇÃO DA REUNIÃO ===\n${String(textoDoc).trim()}` : '',
  ].filter((p) => p.trim());

  const texto = partes.join('\n\n');
  if (texto.length <= maxChars) return { texto, truncou: false };

  const cauda = texto.slice(texto.length - maxChars);
  return {
    texto: `[...trecho inicial omitido por tamanho...]\n\n${cauda}`,
    truncou: true,
  };
}

// ------------------------------------------------------------
// Extracao: prompt e validacao
// ------------------------------------------------------------

const CAMPOS = {
  resumo_caso: 'texto',
  teses_estrategia: 'texto',
  documentos_solicitados: 'lista',
  proposta_valores: 'texto',
  dados_criticos: 'texto',
  proximos_passos: 'lista',
};

const PROMPT_SISTEMA_NOTAS = `Você extrai dados estruturados de notas e transcrições de reuniões de um escritório de advocacia brasileiro (Caballero, Rocha & Carvalho), para registro no CRM.

Responda SOMENTE com um objeto JSON com exatamente estas chaves:
- "resumo_caso": texto. O caso do cliente em 3 a 6 frases: quem é, o que aconteceu, o que ele quer.
- "teses_estrategia": texto. As teses jurídicas e a estratégia discutidas pelo advogado. Vazio se não houve.
- "documentos_solicitados": lista de strings. Cada documento que o escritório pediu ao cliente, um por item.
- "proposta_valores": texto. Honorários, forma de pagamento e condições, EXATAMENTE como ditos.
- "dados_criticos": texto. Prazos, números de processo, órgãos, datas de audiência, nomes de partes.
- "proximos_passos": lista de strings. Cada ação combinada, começando por quem a executa.

REGRAS INEGOCIÁVEIS:
1. Nunca invente. Valor, prazo, CPF, número de processo ou data que não esteja no texto NÃO pode aparecer na resposta. Na dúvida, omita.
2. Campo sem informação no texto: string vazia "" ou lista vazia []. Nunca escreva "não informado", "não mencionado" ou similar.
3. NÃO classifique a área do direito nem sugira advogado responsável. Isso é decidido em outro lugar do sistema, e uma segunda opinião aqui contradiz a primeira.
4. Distinga o que o CLIENTE afirmou do que o ADVOGADO opinou. Use "o cliente relata que..." e "o advogado orientou que...".
5. Preserve valores monetários no formato original do texto (R$ 3.500,00), sem converter nem arredondar.
6. Escreva em português do Brasil, em tom objetivo de registro profissional. Sem saudação, sem conclusão, sem opinião sua.`;

function montarMensagensExtracao(textoFonte, meta = {}) {
  const cabecalho = [
    meta.tituloEvento ? `Título da reunião: ${meta.tituloEvento}` : '',
    meta.dataIso ? `Data: ${meta.dataIso}` : '',
    meta.truncou ? 'ATENÇÃO: o texto abaixo foi cortado no início por tamanho. Extraia apenas do que está presente.' : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: PROMPT_SISTEMA_NOTAS },
    { role: 'user', content: `${cabecalho}\n\n${textoFonte}` },
  ];
}

// Tokens que, se inventados, produzem o pior tipo de erro deste sistema: uma nota plausivel com um
// numero errado dentro do prontuario de um cliente. Ninguem pega isso lendo.
const PADROES_ANCORA = [
  { nome: 'valor', re: /R\$\s*[\d][\d.,]*/g },
  { nome: 'CNPJ', re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g },
  { nome: 'CPF', re: /\b\d{3}\.?\d{3}\.?\d{3}-\d{2}\b/g },
  { nome: 'processo', re: /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/g },
  { nome: 'data', re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g },
];

const soDigitos = (s) => String(s).replace(/\D/g, '');

// Confere cada numero da extracao contra o texto-fonte, comparando so os digitos — assim
// "R$ 3.500,00" casa com "R$3.500,00" e "3500,00" sem depender de pontuacao.
//
// O que se faz com um numero nao encontrado: MARCAR, nao apagar.
//
// Apagar seria pior nos dois sentidos. O falso positivo e real (o valor pode ter sido dito por
// extenso, "tres mil e quinhentos", e ai o digito nao esta mesmo no texto) e apagar destroi um dado
// que o advogado precisa. E o risco que se queria matar nao era a presenca do numero: era a
// CONFIANCA que ele transmite. Marcado inline, o numero continua util e para de se passar por
// verificado. Quem le decide.
function conferirAncoragem(valor, digitosFonte) {
  if (typeof valor !== 'string' || !valor) return { valor, achados: [] };

  const achados = [];
  let saida = valor;

  for (const { nome, re } of PADROES_ANCORA) {
    for (const casado of valor.matchAll(re)) {
      const token = casado[0];
      const digitos = soDigitos(token);
      // Menos de 3 digitos nao identifica nada (um "1/2" da vida) e geraria ruido constante.
      if (digitos.length < 3) continue;
      if (digitosFonte.includes(digitos)) continue;
      if (achados.some((a) => a.token === token)) continue;

      achados.push({ tipo: nome, token });
      saida = saida.split(token).join(`${token} [⚠ não localizado no texto]`);
    }
  }

  return { valor: saida, achados };
}

// A IA propoe, isto descarta. Devolve sempre um objeto utilizavel — quem chama nunca precisa de
// try/catch em volta.
function validarExtracao(bruto, textoFonte) {
  const avisos = [];
  const extracao = {};
  const digitosFonte = soDigitos(textoFonte);

  const entrada = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : {};

  for (const [chave, tipo] of Object.entries(CAMPOS)) {
    const valor = entrada[chave];

    if (tipo === 'lista') {
      const lista = Array.isArray(valor) ? valor : (typeof valor === 'string' && valor.trim() ? [valor] : []);
      extracao[chave] = lista
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
        .map((item) => {
          const { valor: limpo, achados } = conferirAncoragem(item, digitosFonte);
          for (const a of achados) avisos.push(`${chave}: ${a.tipo} "${a.token}" não aparece no texto da reunião`);
          return limpo;
        });
    } else {
      const texto = typeof valor === 'string' ? valor.trim() : '';
      const { valor: limpo, achados } = conferirAncoragem(texto, digitosFonte);
      for (const a of achados) avisos.push(`${chave}: ${a.tipo} "${a.token}" não aparece no texto da reunião`);
      extracao[chave] = limpo;
    }
  }

  // Chave que o modelo inventou fora do contrato: nao vai para a nota, mas o desvio e registrado —
  // e assim que se descobre que o prompt precisa de ajuste.
  const extras = Object.keys(entrada).filter((k) => !(k in CAMPOS));
  if (extras.length) avisos.push(`campos ignorados fora do contrato: ${extras.join(', ')}`);

  // Resumo vazio nao e "reuniao sem assunto": e falha de extracao. Sinalizado para o chamador
  // decidir (nao virar nota vazia no negocio do cliente).
  const vazia = !extracao.resumo_caso;

  return { extracao, avisos, vazia };
}

// ------------------------------------------------------------
// A nota
// ------------------------------------------------------------

// Impressao digital estavel da origem. Vai na ULTIMA linha da nota para que, se o processo morrer
// entre "vou postar" e "postei", a retomada consiga perguntar ao CRM se a nota ja existe em vez de
// repostar as cegas. Medido em 16/08/2026: GET /deals/{id}/notes devolve `description` integral
// (sem truncagem), entao a busca por este marcador funciona.
function marcadorNota(gmailMessageId, docId) {
  const semente = `${gmailMessageId || ''}|${docId || ''}`;
  return `[ollow-notas:${crypto.createHash('sha256').update(semente).digest('hex').slice(0, 8)}]`;
}

const secao = (titulo, conteudo) => (conteudo && conteudo.length ? `${titulo}\n${conteudo}` : '');
const lista = (itens) => (itens || []).map((i) => `• ${i}`).join('\n');

// Funcao PURA: mesma entrada, mesmo texto. E o que permite comparar contra o que esta no CRM.
function montarTextoNota({ extracao, meta = {}, avisos = [], marcador }) {
  const quando = [meta.dataBr, meta.horaBr].filter(Boolean).join(' às ');

  const corpo = [
    `🧠 Notas da reunião${quando ? ` — ${quando}` : ''}${meta.tituloEvento ? ` (${meta.tituloEvento})` : ''}`,
    '',
    secao('📌 RESUMO DO CASO', extracao.resumo_caso),
    secao('⚖️ TESES E ESTRATÉGIA', extracao.teses_estrategia),
    secao('📄 DOCUMENTOS SOLICITADOS', lista(extracao.documentos_solicitados)),
    secao('💰 PROPOSTA / VALORES', extracao.proposta_valores),
    secao('🔑 DADOS CRÍTICOS', extracao.dados_criticos),
    secao('➡️ PRÓXIMOS PASSOS', lista(extracao.proximos_passos)),
  ].filter((p) => p !== '').join('\n\n');

  const rodape = [
    '',
    '—',
    '⚠️ Resumo gerado por IA a partir das notas do Gemini. Confira antes de usar.',
    meta.truncou ? '⚠️ A transcrição era longa e o TRECHO INICIAL foi omitido na extração.' : '',
    meta.semTranscricao ? 'ℹ️ Sem transcrição literal (só o resumo do e-mail) — a transcrição não foi ativada nesta reunião.' : '',
    ...avisos.map((a) => `⚠️ ${a}`),
    meta.linkDoc ? `Fonte: ${meta.linkDoc}` : '',
    // Por qual porta esta nota entrou. Quando alguem achar uma nota no negocio errado, esta linha
    // diz qual regra corrigir — sem ela, so restaria adivinhar.
    meta.metodo ? `Vínculo: ${meta.metodo}${meta.confianca ? ` (confiança ${meta.confianca})` : ''}` : '',
    marcador || '',
  ].filter(Boolean).join('\n');

  return `${corpo}\n${rodape}`;
}

module.exports = {
  parseAssuntoGemini,
  janelaDoDia,
  somarDias,
  extrairDocId,
  extrairDocIdDeEvento,
  extrairSinais,
  decidirDeal,
  prepararTextoFonte,
  montarMensagensExtracao,
  validarExtracao,
  conferirAncoragem,
  marcadorNota,
  montarTextoNota,
  PROMPT_SISTEMA_NOTAS,
  CAMPOS,
};
