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

// O contrato de extracao E a estrutura do briefing: cada chave aqui vira uma secao em montarTextoNota,
// na ordem em que o escritorio le. Nao existe "template" em outro lugar — trocar este objeto e trocar
// o formato da nota.
//
// Decisao do escritorio em 20/08/2026 (remover contexto do cliente, fundir estrategia num paragrafo
// unico) foi REVERTIDA em 21/08/2026: testar o formato de 3 campos contra um caso real de assessoria
// administrativa (Fies) mostrou que o contexto do cliente tem valor pra quem abre o negocio antes da
// consulta, e que "Via Eleita & Foro" ficava vazia (e a secao inteira sumia) sempre que o atendimento
// era so assessoria documental, sem acao judicial — ver PROMPT_SISTEMA_NOTAS.
//
// `contexto_pessoal_social` e NOVO: o mesmo caso real trouxe muito papo social sem relacao com o caso
// (outro emprego do cliente, aspiracoes de carreira, rede de amigos). Sem um campo proprio, isso
// vazava pra dentro de `perfil_qualificacao` (a regra de "seja exaustivo" nao distingue relevancia) —
// ou, pior, um valor em reais dito de passagem (ex.: salario de outro emprego) podia ser confundido
// com honorario. O campo separa sem descartar.
//
// `honorarios` e uma LISTA LIVRE de etapas, e nao cinco campos fixos (entrada / exito 1 / exito 2 /
// exito final / mensalidade). Campo fixo e um convite a preencher: perguntado sobre "Exito
// Intermediario (Etapa 2)" num atendimento em que so se falou de entrada, o modelo devolve um valor
// plausivel — e numero inventado no campo de honorarios e o pior erro que esta rotina pode cometer.
// As cinco etapas canonicas vivem no PROMPT, como vocabulario preferido, nao como formulario.
const CAMPOS = {
  // 1. Contexto do Cliente & Historico Fatico
  perfil_qualificacao: 'texto',
  historico_processual_anterior: 'texto',
  situacao_atual_urgencia: 'texto',
  diretrizes_internas_equipe: 'texto',
  // 2. Do Objeto
  objeto: 'texto',
  // 3. Da Estrategia Juridica (aceita via judicial OU administrativa)
  via_eleita_foro: 'texto',
  fundamentacao_legal: 'texto',
  superacao_obices: 'texto',
  // 4. Da Proposta de Honorarios
  honorarios: 'honorarios',
  // 5. Contexto Pessoal/Social — fora do caso, mas preservado
  contexto_pessoal_social: 'texto',
};

// Os campos que SUSTENTAM a nota. Sem nenhum deles a extracao falhou — nao e "reuniao objetiva".
// `contexto_pessoal_social` sozinho (ou honorarios sozinho) nao sustenta a nota: papo social sem
// nenhum campo de caso preenchido e sinal de que a extracao nao achou o atendimento em si.
const CAMPOS_SUSTENTACAO = [
  'perfil_qualificacao',
  'historico_processual_anterior',
  'situacao_atual_urgencia',
  'objeto',
];

// Uma extracao gravada em ciclo ANTERIOR segue o contrato de hoje? O index.js reusa a extracao da
// tabela quando a linha ja passou por EXTRAIDO, para nao pagar OpenAI duas vezes — e uma linha
// extraida sob o contrato antigo renderia um briefing sem uma unica secao: so cabecalho e rodape, no
// prontuario do cliente. O predicado mora aqui para que o index.js nao carregue nome de campo dentro
// dele, que e o mesmo motivo de CAMPOS existir.
function ehExtracaoAtual(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.keys(CAMPOS).some((chave) => chave in obj);
}

const PROMPT_SISTEMA_NOTAS = `Você extrai dados estruturados de notas e transcrições de reuniões de um escritório de advocacia brasileiro (Caballero, Rocha & Carvalho), para montar o BRIEFING DE ATENDIMENTO E ALINHAMENTO ESTRATÉGICO no CRM.

Responda SOMENTE com um objeto JSON PLANO (as 10 chaves abaixo direto na raiz do objeto — NUNCA
agrupadas dentro de um sub-objeto por seção/número; "1.", "2." etc. são só organização deste texto,
não fazem parte da chave nem viram um nível a mais no JSON). Exatamente estas chaves:

1. CONTEXTO DO CLIENTE & HISTÓRICO FÁTICO
- "perfil_qualificacao": texto. Quem é o cliente: profissão, formação, cargo, situação acadêmica ou funcional, aprovações, e o que mais o qualifica no caso — só o que for relevante para o atendimento (ver seção 5 para o que não for).
- "historico_processual_anterior": texto. Ações, recursos ou pedidos administrativos anteriores: onde tramitaram, o que foi decidido e por quê. Inclua a causa da derrota quando ela foi discutida.
- "situacao_atual_urgencia": texto. O que acontece agora, o que o cliente arrisca perder e em que prazo. Se a reunião é uma reunião DE RETORNO/ACOMPANHAMENTO de um caso já em andamento (não a consulta inicial), este campo carrega o ESTADO ATUAL do caso — o que já foi feito, o que mudou desde a última reunião, o que falta — em vez de ficar vazio só porque não há "caso novo" para descrever.
- "diretrizes_internas_equipe": texto. Instruções que a equipe deu a si mesma na reunião: quem faz o quê, que ferramenta usar, o que estudar antes de redigir, o que confirmar com o cliente.

2. DO OBJETO
- "objeto": texto corrido, em redação de contrato — como a cláusula de "objeto" de um contrato de honorários. Descreva com precisão qual providência o escritório vai tomar (ação judicial, recurso, ou assessoria administrativa/documental), perante quem (juízo ou órgão), e com que finalidade concreta para o cliente. Não resuma numa frase genérica: escreva o parágrafo inteiro, com todos os detalhes que a reunião deu (nome da instituição, cargo, situação específica etc.).

3. DA ESTRATÉGIA JURÍDICA
- "via_eleita_foro": texto. A medida escolhida e onde será conduzida. Pode ser uma via JUDICIAL (ação, juízo, tribunal, prevenção ou nova distribuição) OU uma via ADMINISTRATIVA/documental (ex.: procedimento perante um órgão, requerimento administrativo, gestão de documentação de um programa ou fundo) — nem todo atendimento é uma ação judicial, e a ausência de processo não significa ausência de estratégia.
- "fundamentacao_legal": texto. Os fundamentos discutidos: dispositivos, princípios e teses (quando houver via judicial), ou a norma/regulamento do órgão que rege o procedimento (quando for via administrativa). Vazio se nada foi citado.
- "superacao_obices": texto. Como derrubar o que atrapalha: o que provar, que documento juntar, que preliminar enfrentar, que erro anterior corrigir, que exigência do órgão cumprir.

4. DA PROPOSTA DE HONORÁRIOS
- "honorarios": lista de objetos {"etapa","valor","condicao"}, um por parcela combinada.
  "etapa": use, quando couber, os rótulos "Entrada / Início da Ação", "Êxito Intermediário (Etapa 1)", "Êxito Intermediário (Etapa 2)", "Êxito Final", "Manutenção / Acompanhamento Mensal".
  "valor": o valor como foi dito (R$ 3.500,00). "condicao": o que dispara essa parcela — descreva por extenso, sem abreviar ("protocolo em 1º e 2º graus", não "protocolo").
  Inclua SOMENTE as etapas efetivamente combinadas. Lista vazia se não se falou de dinheiro a ser pago AO ESCRITÓRIO — um valor mencionado em outro contexto (salário do cliente em outro emprego, preço de outro serviço) NÃO é honorário; ver seção 5.

5. CONTEXTO PESSOAL/SOCIAL (fora do caso)
- "contexto_pessoal_social": texto corrido. Tudo que for conversa social ou contexto de vida do cliente SEM relação direta com o objeto da contratação: outro emprego ou atividade profissional não relacionada, aspirações de carreira, rede de contatos/amigos, histórico social, valores em reais mencionados nesse contexto (ex.: salário de outro emprego). Isso existe para você NÃO colocar esse conteúdo dentro de "perfil_qualificacao" ou dos demais campos do caso, e para nunca confundir um valor desse contexto com honorário. Se a reunião NÃO teve nenhum papo desse tipo, devolva string vazia "" — NUNCA escreva frases como "não mencionou outros empregos" ou "sem contexto social a relatar" (mesmo erro proibido na regra 4, mas este campo é onde ele mais tende a acontecer, porque toda reunião jurídica é "só sobre o caso").

FORMATO EXATO DA RESPOSTA (objeto plano, as 10 chaves lado a lado, sem agrupar por seção):
{"perfil_qualificacao": "...", "historico_processual_anterior": "...", "situacao_atual_urgencia": "...", "diretrizes_internas_equipe": "...", "objeto": "...", "via_eleita_foro": "...", "fundamentacao_legal": "...", "superacao_obices": "...", "honorarios": [...], "contexto_pessoal_social": "..."}

NÍVEL DE DETALHE ESPERADO (estilo de referência — o CONTEÚDO vem sempre da reunião atual, nunca copie este exemplo):
- perfil_qualificacao: "Aluno de Medicina no último período, aprovado em 1º lugar em concursos públicos."
- historico_processual_anterior: "Processo anterior negado/extinto no TRF3 por deficiência técnica do patrono anterior — ausência de pedido expresso de formação de banca e falta de juntada de documentos/histórico."
- situacao_atual_urgencia: "Nova negativa expressa e ilegal da instituição de ensino; risco iminente de perda de posse em novos cargos públicos."
- diretrizes_internas_equipe: "Responsável deve subir a transcrição no NotebookLM para análise crítica e aprofundamento antes da redação da peça."
- objeto: "A atuação do escritório CABALLERO, ROCHA & CARVALHO consistirá nos serviços de consultoria e assessoria jurídica especializada para a propositura de Mandado de Segurança na Justiça Federal, com o objetivo de compelir a faculdade a constituir banca examinadora especial para fins de abreviação da colação de grau do CONTRATANTE, assegurando a posse em cargo público."
- via_eleita_foro (via judicial): "Mandado de Segurança perante a Justiça Federal, mesmo juízo por prevenção." / via_eleita_foro (via administrativa, outro tipo de caso): "Assessoria administrativa e documental perante o Fundo de Financiamento Estudantil (Fies) e o Ministério da Educação (MEC)."
- fundamentacao_legal: "Artigo 47, § 2º, da Lei de Diretrizes e Bases da Educação (Lei nº 9.394/96); princípio da razoabilidade e teoria do fato consumado."
- superacao_obices: "Comprovação do interesse de agir com a juntada da negativa administrativa formal; instrução probatória robusta (histórico acadêmico, edital e convocação do concurso)."
- contexto_pessoal_social: "Atua em outro emprego não relacionado ao caso (advocacia empresarial em outro escritório), com insatisfação relatada quanto à carga horária e remuneração; menciona interesse de mudar de carreira e vínculos sociais antigos."
Repare no que torna isto detalhado: nome da instituição por extenso, o dispositivo legal específico (não só "a LDB"), e as teses/técnicas pelo nome próprio (não "vamos juntar documentos e argumentar"). Um campo que não chegue a este nível de especificidade, quando a reunião tinha a informação, é extração malfeita — mas detalhe vale para o que É relevante ao caso; o que não é (campo 10) tem lugar próprio, não é para descartar nem misturar.

REGRAS INEGOCIÁVEIS:
1. Nunca invente. Valor, prazo, CPF, número de processo, número de lei ou data que não esteja no texto NÃO pode aparecer na resposta. Na dúvida, omita.
2. Só escreva número de lei, artigo ou súmula se o NÚMERO tiver sido dito na reunião. Se só o nome foi dito ("a LDB", "o CPC"), escreva o nome sem número.
3. Seja EXTREMAMENTE DETALHADO no que foi dito: preserve todo nome de órgão, instituição, programa, cargo, prazo, condição, tese jurídica e dispositivo citado — nos campos do CASO. "objeto", "via_eleita_foro", "fundamentacao_legal" e "superacao_obices" são frases/parágrafos completos e específicos, nunca um resumo genérico. Perder um nome, um número ou um raciocínio discutido derrota o propósito do briefing — quem lê precisa entender o caso sem ouvir a reunião de novo. A riqueza vem do texto da reunião, nunca do seu repertório.
4. Campo sem informação no texto: string vazia "" ou lista vazia []. Nunca escreva "não informado", "não mencionado" ou similar — campo vazio é omitido do briefing automaticamente.
5. NÃO classifique a área do direito nem sugira advogado responsável. Isso é decidido em outro lugar do sistema, e uma segunda opinião aqui contradiz a primeira.
6. Distinga o que o CLIENTE afirmou do que o ADVOGADO opinou. Use "o cliente relata que..." e "o advogado orientou que...".
7. Documentos a juntar entram em "superacao_obices"; ações combinadas para a equipe entram em "diretrizes_internas_equipe". Não há campo separado para eles.
8. Preserve valores monetários no formato original do texto (R$ 3.500,00), sem converter nem arredondar.
9. Escreva em português do Brasil, em tom objetivo de registro profissional. Sem saudação, sem conclusão, sem opinião sua.`;

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
  // A citacao legal so virou risco quando o briefing ganhou um campo de fundamentacao: pedir "os
  // dispositivos discutidos" e exatamente o convite para o modelo completar "a LDB" com
  // "(Lei n 9.394/96)" de memoria. O numero sai perfeito — e e por isso que ninguem desconfia.
  { nome: 'norma', re: /\b(?:lei|lc|s[úu]mula|art(?:igo)?)\.?\s*n?[º°]?\s*\d(?:[\d.\/-]*\d)?/gi },
];

const soDigitos = (s) => String(s).replace(/\D/g, '');

// Converte "3.500,00", "5000" ou "1.234,56" no numero que representam. Separador de milhar so e
// removido quando ha exatamente tres digitos depois dele — assim "0301" de um numero de processo nao
// vira parte de um valor.
function comoNumero(bruto) {
  const limpo = String(bruto).replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

// Todos os numeros que aparecem no texto-fonte, como VALORES e nao como cadeias de digitos.
//
// MEDIDO no e-mail real de 07/08/2026: o Gemini escreveu "precificada em 5000 reais para a primeira
// instancia e 1500 reais para recursos de apelacao". Se o modelo devolver isso como "R$ 5.000,00" —
// que e formatacao correta do MESMO valor — a comparacao por cadeia de digitos procuraria "500000"
// num texto que tem "5000" e marcaria um valor CERTO como nao localizado. Falso alarme no campo de
// honorarios e pior que nenhum aviso: ensina o advogado a ignorar o simbolo.
function valoresDoTexto(texto) {
  const valores = new Set();
  for (const casado of String(texto || '').matchAll(/\d[\d.]*(?:,\d+)?/g)) {
    const n = comoNumero(casado[0]);
    if (n !== null) valores.add(n);
  }
  return valores;
}

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
function conferirAncoragem(valor, fonte) {
  if (typeof valor !== 'string' || !valor) return { valor, achados: [] };
  const { digitosFonte, valoresFonte } = fonte;

  const achados = [];
  let saida = valor;

  for (const { nome, re } of PADROES_ANCORA) {
    for (const casado of valor.matchAll(re)) {
      const token = casado[0];

      // Dinheiro e comparado como NUMERO, nao como cadeia de digitos: "R$ 5.000,00" e "5000 reais"
      // sao o mesmo valor e precisam casar. Documento, processo e data continuam por digitos, onde a
      // identidade e a propria sequencia.
      if (nome === 'valor') {
        const n = comoNumero(token);
        if (n === null || valoresFonte.has(n)) continue;
      } else if (nome === 'norma') {
        // Norma se confere BLOCO a bloco, nunca pela cadeia inteira. "Lei n 9.394/96" tem os blocos
        // 9394 e 96: se a fonte disse "Lei 9.394" e o modelo completou o ano, procurar "939496" no
        // texto marcaria um numero CERTO. Mesmo raciocinio do dinheiro comparado como numero — falso
        // alarme no campo de fundamentacao ensina o advogado a ignorar o simbolo.
        //
        // O ponto e separador de milhar aqui ("9.394"), entao sai antes de partir os blocos; quem
        // separa de verdade e "/" e "-". Bloco curto ("art. 47", "§ 2") nao identifica norma nenhuma
        // e e ignorado — a mesma guarda de 3 digitos dos demais padroes.
        const blocos = token.replace(/\./g, '').match(/\d+/g) || [];
        if (!blocos.some((b) => b.length >= 3 && !digitosFonte.includes(b))) continue;
      } else {
        const digitos = soDigitos(token);
        // Menos de 3 digitos nao identifica nada (um "1/2" da vida) e geraria ruido constante.
        if (digitos.length < 3) continue;
        if (digitosFonte.includes(digitos)) continue;
      }

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
  const fonte = { digitosFonte: soDigitos(textoFonte), valoresFonte: valoresDoTexto(textoFonte) };

  const entrada = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : {};

  // Passa um texto pelo filtro de ancoragem e acumula o aviso ja nomeando o campo — e o rotulo que o
  // advogado le no rodape para saber ONDE esta o numero suspeito.
  const ancorar = (texto, rotulo) => {
    const { valor, achados } = conferirAncoragem(texto, fonte);
    for (const a of achados) avisos.push(`${rotulo}: ${a.tipo} "${a.token}" não aparece no texto da reunião`);
    return valor;
  };

  for (const [chave, tipo] of Object.entries(CAMPOS)) {
    const valor = entrada[chave];

    if (tipo === 'honorarios') {
      const itens = Array.isArray(valor) ? valor : [];
      extracao[chave] = itens
        .map((item) => {
          const campo = (k) => (item && typeof item[k] === 'string' ? item[k].trim() : '');
          return { etapa: campo('etapa'), valor: campo('valor'), condicao: campo('condicao') };
        })
        // Sem etapa E sem valor nao ha parcela nenhuma: uma condicao solta nao diz o que se paga.
        .filter((i) => i.etapa || i.valor)
        .map((i) => {
          const rotulo = `honorarios${i.etapa ? ` (${i.etapa})` : ''}`;
          return {
            etapa: ancorar(i.etapa, rotulo),
            valor: ancorar(i.valor, rotulo),
            condicao: ancorar(i.condicao, rotulo),
          };
        });
    } else {
      extracao[chave] = ancorar(typeof valor === 'string' ? valor.trim() : '', chave);
    }
  }

  // Chave que o modelo inventou fora do contrato: nao vai para a nota, mas o desvio e registrado —
  // e assim que se descobre que o prompt precisa de ajuste.
  const extras = Object.keys(entrada).filter((k) => !(k in CAMPOS));
  if (extras.length) avisos.push(`campos ignorados fora do contrato: ${extras.join(', ')}`);

  // Nenhum campo de sustentacao preenchido nao e "reuniao sem assunto": e falha de extracao.
  // Sinalizado para o chamador decidir (nao virar briefing so de cabecalho e rodape no negocio).
  const vazia = !CAMPOS_SUSTENTACAO.some((c) => extracao[c]);

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

// Nome do PDF anexado na aba "Arquivos" do negocio. Cumpre DOIS papeis, e o segundo e o que obriga
// o determinismo:
//
//   1. o que o advogado le no CRM — por isso a data por extenso, e nao um token hexadecimal;
//   2. a CHAVE DE DEDUPLICACAO. O POST /deals/{id}/attachments nao aceita marcador dentro do arquivo
//      (o corpo e so uma url), entao, depois de um crash entre "vou anexar" e "anexei", a unica
//      forma de perguntar ao CRM "isto ja esta ai?" e procurar por este nome na listagem. Se ele
//      variasse entre duas execucoes da mesma origem, a resposta seria sempre "nao achei" e o
//      prontuario do cliente ganharia uma segunda copia da transcricao.
//
// O sufixo vem do mesmo hash de marcadorNota — mesma origem, mesmo nome, sempre.
function nomeAnexoNota(marcador, dataIso) {
  const hash = String(marcador || '').match(/\[ollow-notas:([a-f0-9]+)\]/)?.[1] || 'semorigem';
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(dataIso || '')) ? dataIso : 'sem-data';
  return `notas-reuniao-${data}-${hash}.pdf`;
}

const secao = (titulo, conteudo) => (conteudo && conteudo.length ? `${titulo}\n${conteudo}` : '');

// Secao de rotulos (1 e 3). Bullet sem valor some, e se todos sumirem a secao inteira nao existe —
// e a mesma regra de `secao`, e o motivo de o prompt proibir "nao informado": um titulo seguido de
// tres rotulos vazios ocupa espaco afirmando que se sabe alguma coisa.
const secaoRotulada = (titulo, pares) =>
  secao(titulo, pares.filter(([, v]) => v).map(([r, v]) => `• ${r}: ${v}`).join('\n'));

// Secao 4: "• Entrada / Inicio da Acao: R$ 5.000,00 — protocolo em 1o e 2o graus". Etapa sem valor
// (combinado sem preco) e valor sem etapa (preco sem gatilho) continuam legiveis; o travessao so
// aparece quando ha condicao.
const secaoHonorarios = (titulo, itens) =>
  secao(titulo, (itens || []).map((i) => {
    const cabeca = [i.etapa, i.valor].filter(Boolean).join(': ');
    return cabeca ? `• ${[cabeca, i.condicao].filter(Boolean).join(' — ')}` : '';
  }).filter(Boolean).join('\n'));

// Funcao PURA: mesma entrada, mesmo texto. E o que permite comparar contra o que esta no CRM.
//
// TEXTO PURO, sem Markdown: nenhuma nota deste sistema usa `**` ou `##`, porque o campo
// `description` do Moskit e exibido cru — sintaxe nao renderizada viraria sujeira na tela do
// advogado, justamente no documento que ele abre minutos antes de redigir a peca.
//
// 5 secoes (revertido de 3 em 21/08/2026, ver CAMPOS): contexto do cliente de volta, estrategia
// juridica de volta a 3 sub-campos (aceita via administrativa tambem), e uma 5a secao nova pro que e
// social/pessoal e nao pertence ao caso.
// `meta.numeroReuniao` vem de numeroDaReuniao (src/reuniao-retorno.js): a que reuniao esta nota se
// refere, pela DATA do assunto do e-mail do Gemini. Sem numero identificado (deal com uma so
// reuniao, ou data ambigua entre duas do mesmo dia) o cabecalho fica exatamente como era antes desta
// funcionalidade existir — nenhuma mudanca de formato, so 5 secoes continuam o contrato.
function montarTextoNota({ extracao, meta = {}, avisos = [], marcador }) {
  const quando = [meta.dataBr, meta.horaBr].filter(Boolean).join(' às ');
  const e = extracao || {};

  const corpo = [
    `📄 BRIEFING DE ATENDIMENTO E ALINHAMENTO ESTRATÉGICO${meta.numeroReuniao ? ` — REUNIÃO ${meta.numeroReuniao}` : ''}${quando ? ` — ${quando}` : ''}${meta.tituloEvento ? ` (${meta.tituloEvento})` : ''}`,
    secaoRotulada('👤 1. CONTEXTO DO CLIENTE & HISTÓRICO FÁTICO', [
      ['Perfil/Qualificação', e.perfil_qualificacao],
      ['Histórico Processual Anterior', e.historico_processual_anterior],
      ['Situação Atual & Urgência', e.situacao_atual_urgencia],
      ['Diretrizes Internas da Equipe', e.diretrizes_internas_equipe],
    ]),
    secao('📌 2. DO OBJETO', e.objeto),
    secaoRotulada('⚖️ 3. DA ESTRATÉGIA JURÍDICA', [
      ['Via Eleita & Foro', e.via_eleita_foro],
      ['Fundamentação Legal Principal', e.fundamentacao_legal],
      ['Superação de Óbices', e.superacao_obices],
    ]),
    secaoHonorarios('💰 4. DA PROPOSTA DE HONORÁRIOS', e.honorarios),
    secao('🗒️ 5. CONTEXTO PESSOAL/SOCIAL', e.contexto_pessoal_social),
  ].filter((p) => p !== '').join('\n\n');

  const rodape = [
    '',
    '—',
    '⚠️ Resumo gerado por IA a partir das notas do Gemini. Confira antes de usar.',
    meta.truncou ? '⚠️ A transcrição era longa e o TRECHO INICIAL foi omitido na extração.' : '',
    meta.semTranscricao ? 'ℹ️ Sem transcrição literal (só o resumo do e-mail) — a transcrição não foi ativada nesta reunião.' : '',
    // Só afirma o anexo quando ele JÁ está no CRM. O anexo é tentado antes desta nota ser montada,
    // justamente para que esta linha possa ser verdade — uma nota que promete um arquivo inexistente
    // manda o advogado procurar o que não está lá.
    meta.anexado ? '📎 Transcrição completa anexada na aba Arquivos deste negócio.' : '',
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
  ehExtracaoAtual,
  marcadorNota,
  nomeAnexoNota,
  montarTextoNota,
  PROMPT_SISTEMA_NOTAS,
  CAMPOS,
  CAMPOS_SUSTENTACAO,
};
