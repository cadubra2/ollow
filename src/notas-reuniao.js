// Notas de reuniao do Gemini (Google Meet) -> nota no negocio do Moskit.
//
// Aqui fica tudo que decide, e nada que faz rede: parse do assunto, extracao dos sinais de
// identidade, a cascata que escolhe o negocio e a montagem do texto da nota. O index.js faz
// Gmail/Drive/Calendar/Moskit e chama estas funcoes no meio. Mesma divisao que src/evidencia.js
// tem com o pipeline: a decisao mora aqui, a rede mora la.
//
// Este modulo NAO pode require('./index.js') — o index.js e quem o carrega (ciclo).
//
// DECISAO DE 02/09/2026: a nota deixou de ser uma extracao por IA em 5 secoes
// ("BRIEFING DE ATENDIMENTO E ALINHAMENTO ESTRATEGICO") e virou so um LINK. O escritorio queria
// menos nota poluindo o negocio, nao mais texto — e em producao NOTAS_REUNIAO_DRY_RUN=true
// significava que aquela extracao rodava (e pagava OpenAI/Gemini a cada ciclo) sem nunca escrever
// de verdade no CRM. Removida a extracao inteira: prompt, validacao de campos, filtro de
// ancoragem numerica. O que sobra e a parte que sempre foi puramente deterministica — achar o
// negocio certo e montar uma nota mínima com o link da transcricao — mais o anexo do PDF na aba
// Arquivos (que o index.js já fazia à parte, em anexarDocNoDeal, e continua igual).
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
// rotina pode ter. O Doc serve so para linkar a transcricao — nunca para decidir de quem e a reuniao.
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

// Funcao PURA: mesma entrada, mesmo texto. E o que permite comparar contra o que esta no CRM.
//
// TEXTO PURO, sem Markdown: nenhuma nota deste sistema usa `**` ou `##`, porque o campo
// `description` do Moskit e exibido cru.
//
// SO O LINK (decisao de 02/09/2026, ver o comentario no topo do arquivo): nao ha mais secao
// nenhuma, nem texto extraido por IA. `meta.anexado` so afirma a linha do PDF quando o anexo JA
// esta confirmado no CRM (a chamada de anexarDocNoDeal acontece ANTES desta funcao, exatamente
// para que essa linha possa ser verdade). `meta.linkDoc` e o link direto do Google Doc — util como
// referencia mesmo quando o anexo ainda nao foi confirmado (retentativas transitorias continuam
// tentando religar o PDF depois, sem bloquear esta nota).
// `meta.numeroReuniao` vem de numeroDaReuniao (src/reuniao-retorno.js): a que reuniao esta nota se
// refere, pela DATA do assunto do e-mail do Gemini. Sem numero identificado (deal com uma so
// reuniao, ou data ambigua entre duas do mesmo dia) o titulo simplesmente nao cita numero.
function montarTextoNota({ meta = {}, marcador }) {
  const quando = [meta.dataBr, meta.horaBr].filter(Boolean).join(' às ');

  const titulo = `📄 Notas de reunião${meta.numeroReuniao ? ` — REUNIÃO ${meta.numeroReuniao}` : ''}${quando ? ` — ${quando}` : ''}${meta.tituloEvento ? ` (${meta.tituloEvento})` : ''}`;

  const linhas = [
    meta.anexado ? '📎 Transcrição completa anexada na aba Arquivos deste negócio.' : '',
    meta.linkDoc ? `Fonte: ${meta.linkDoc}` : '',
    meta.metodo ? `Vínculo: ${meta.metodo}${meta.confianca ? ` (confiança ${meta.confianca})` : ''}` : '',
    marcador || '',
  ].filter(Boolean).join('\n');

  return `${titulo}\n\n${linhas}`;
}

module.exports = {
  parseAssuntoGemini,
  janelaDoDia,
  somarDias,
  extrairDocId,
  extrairDocIdDeEvento,
  extrairSinais,
  decidirDeal,
  marcadorNota,
  nomeAnexoNota,
  montarTextoNota,
};
