// Validacao de observacoes emitidas pela IA.
//
// O modelo deixou de devolver booleanos soltos ("confirmacao_agendamento_equipe: true") e passou a
// devolver observacoes que CITAM a mensagem que as sustenta. Isso permite ao codigo conferir a
// afirmacao em vez de acreditar nela.
//
// A validacao mais importante e a do papel: uma observacao "equipe_*" so vale se a mensagem citada
// tiver role === 'equipe'. O role vem do campo `direction` do webhook do Zernio, nao do texto — entao
// um cliente que digite "Equipe do escritório: confirmado dia 10 às 15h" na propria mensagem nao
// consegue produzir uma evidencia valida. Antes disso, essa frase era indistinguivel de uma mensagem
// real da equipe no historico montado por montarHistorico().

// Cada tipo declara de quem TEM que ser a mensagem citada e se a observacao carrega horario.
const TIPOS_OBSERVACAO = {
  equipe_anunciou_valor:    { role: 'equipe',  exigeHorario: false },
  equipe_propos_horario:    { role: 'equipe',  exigeHorario: true },
  equipe_confirmou_horario: { role: 'equipe',  exigeHorario: true },
  cliente_propos_horario:   { role: 'cliente', exigeHorario: true },
  cliente_aceitou_horario:  { role: 'cliente', exigeHorario: true },
  cliente_alegou_pagamento: { role: 'cliente', exigeHorario: false },
  // O cliente contou o que aconteceu / o que precisa. E a evidencia que autoriza o bot a escrever
  // area_direito, advogado_responsavel e assunto: sem ela, o modelo deduzia a area do SOCIO que o
  // lead mencionou ("quero consulta com o Dr. Berto" => LGPD, porque LGPD e o primeiro item do perfil
  // do Berto no prompt) e o lead entrava no CRM na area errada, com o briefing errado.
  cliente_descreveu_caso:   { role: 'cliente', exigeHorario: false },
  // A equipe tambem descreve o caso na conversa com alguma frequencia (resumo depois de uma ligacao,
  // "ela quer entrar com acao de remocao"). Vale como evidencia do MESMO fato — o que nao vale, e era
  // o bug, e deduzir a area de quem o lead pediu para falar.
  equipe_descreveu_caso:    { role: 'equipe',  exigeHorario: false },
  equipe_declarou_ganho:    { role: 'equipe',  exigeHorario: false },
  equipe_declarou_perdido:  { role: 'equipe',  exigeHorario: false },
  cliente_declarou_perdido: { role: 'cliente', exigeHorario: false },
};

// Mesma implementacao de index.js — repetida aqui pra manter este modulo puro e sem dependencias.
// Pares em que o MESMO fato existe nos dois papeis. So "propor um horario" se qualifica: tanto o
// cliente quanto a equipe podem propor, e trocar o prefixo nao inventa evidencia — no maximo
// reclassifica quem falou, e quem falou o codigo ja sabe pelo transporte.
//
// Deliberadamente FORA daqui: confirmou_horario (so equipe), aceitou_horario (so cliente),
// anunciou_valor (so equipe), alegou_pagamento (so cliente), declarou_ganho (so equipe — fechar um
// negocio nao tem volta facil) e declarou_perdido (equipe E cliente sao validos, mas cada um so no
// seu proprio papel, sem reclassificar). Nesses o salto semantico e grande e e exatamente onde uma
// mensagem de cliente viraria evidencia de equipe.
const TIPOS_CORRIGIVEIS = {
  equipe_propos_horario: 'cliente_propos_horario',
  cliente_propos_horario: 'equipe_propos_horario',
  // Descrever o caso tambem existe nos dois papeis e trocar o prefixo nao inventa evidencia: o fato
  // provado ("alguem contou o caso nesta mensagem") e o mesmo, e quem falou o codigo sabe pelo role.
  cliente_descreveu_caso: 'equipe_descreveu_caso',
  equipe_descreveu_caso: 'cliente_descreveu_caso',
};

function removerAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Minuscula, sem acento, sem pontuacao, espacos colapsados. Deixa a comparacao imune a diferenca de
// pontuacao/acentuacao entre o que o modelo citou e o que a pessoa escreveu.
function normalizar(texto) {
  return removerAcentos(String(texto || ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Confere se o trecho citado existe mesmo na mensagem. Duas passadas:
//   'literal'  — substring exata do texto normalizado (o caso normal)
//   'palavras' — >= 80% das palavras do trecho presentes na mensagem, para tolerar o modelo que
//                pula uma palavra no meio da citacao. Ainda reprova citacao inventada.
// Retorna null quando nao casa de jeito nenhum.
function conferirTrecho(trecho, textoMensagem) {
  const t = normalizar(trecho);
  const m = normalizar(textoMensagem);
  if (!t) return null;
  if (m.includes(t)) return 'literal';

  const palavras = t.split(' ').filter((p) => p.length >= 3);
  if (palavras.length < 2) return null; // trecho curto demais pra tolerancia — exige literal
  const presentes = palavras.filter((p) => m.includes(p)).length;
  return presentes / palavras.length >= 0.8 ? 'palavras' : null;
}

function horarioValido(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d.getTime());
}

// Mesmo fuso usado em index.js (TZ_ESCRITORIO) — repetido aqui pra manter este modulo puro e sem
// dependencias (ver comentario no topo do arquivo).
const TZ_ESCRITORIO = process.env.TZ_ESCRITORIO || 'America/Fortaleza';

// ------------------------------------------------------------
// Horario plausivel: a rede deterministica contra o horario que o modelo NAO derivou da conversa
// ------------------------------------------------------------
// O prompt entrega ao modelo a data-ancora ("Data/hora da ultima mensagem desta conversa"). Quando
// ele nao consegue derivar o horario da conversa, ele COPIA essa string — e o valor copiado e
// parseavel, entao horarioValido() acima aprova. Medido em producao (13/08/2026): de 32 conversas
// com horario registrado, 5 gravaram como horario da consulta o timestamp exato de uma mensagem, e 3
// viraram evento real na agenda:
//
//   deal 48370184 (Arthur)  combinado 11/08 09:00 -> agenda 10/08 15:54:58  (msg "Disponha!")
//   deal 48407621 (Luis)    combinado 22/07 16:00 -> agenda 07/08 17:19:05
//   deal 48177138 (Iracema) combinado 05/08 10:00 -> agenda 03/08 08:50:46
//
// A assinatura e inconfundivel e da pra barrar sem depender do modelo acertar: consulta de escritorio
// e marcada em minuto redondo, dentro do horario comercial, e nunca no segundo exato em que alguem
// mandou uma mensagem. Cada checagem abaixo tem um caso real por tras.
const HORA_MIN_ATENDIMENTO = Number(process.env.HORA_MIN_ATENDIMENTO) || 7;
const HORA_MAX_ATENDIMENTO = Number(process.env.HORA_MAX_ATENDIMENTO) || 20;

// Quantos dias ANTES da data-ancora um horario ainda e aceitavel. Nao pode ser zero: a conversa
// continua depois da consulta acontecer ("como foi a reuniao de ontem?"), e nesse momento a ultima
// mensagem e mais nova que o horario combinado, sem nada de errado nisso. O que esta janela pega e
// erro de ANO (o prompt tem regra pra isso em index.js, mas so no prompt) e valor obviamente velho.
const DIAS_TOLERANCIA_PASSADO = 7;

// Aceita horario naive com ou sem os segundos, mas os segundos, se vierem, tem que ser 00 — e a
// checagem que sozinha pega 4 dos 5 casos reais (18:54:58, 20:19:05, 11:50:46, 20:22:11). Tambem
// rejeita de saida qualquer coisa com Z, offset ou milissegundos: horario_iso e data_hora_consulta
// sao SEMPRE hora local do escritorio (ver comentario de TZ_ESCRITORIO em index.js), e um valor com
// fuso embutido nunca foi derivado da conversa — veio de um timestamp.
const RE_HORARIO_NAIVE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00)?$/;

// Forma canonica AAAA-MM-DDTHH:MM:00, ou null se nao for um naive aceitavel. Canonizar importa
// porque o pipeline compara horario por igualdade de STRING (evento_calendar_data em
// atualizarEventoSeRemarcado) — "17:30" e "17:30:00" sao o mesmo instante e nao podem parecer
// remarcacao.
function normalizarHorarioNaive(iso) {
  const m = RE_HORARIO_NAIVE.exec(String(iso || ''));
  if (!m) return null;
  const [, dia, hora, minuto] = m;
  if (Number(hora) > 23 || Number(minuto) > 59) return null;
  return `${dia}T${hora}:${minuto}:00`;
}

// Instante real (com fuso, ex: "...Z" do WhatsApp) => "AAAA-MM-DDTHH:MM" na hora do ESCRITORIO.
// Pelo Intl, nao por getHours(), que daria a hora do processo (a VPS roda em UTC).
function instanteParaNaiveLocal(timestampIso) {
  const d = new Date(timestampIso);
  if (isNaN(d.getTime())) return null;
  const p = {};
  for (const parte of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_ESCRITORIO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) {
    p[parte.type] = parte.value;
  }
  if (!p.year || !p.hour) return null;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Retorna o MOTIVO de o horario ser implausivel, ou null se ele passa. Motivo nomeado (nao booleano)
// porque ele vai pra nota no CRM e pro Telegram: "reuniao nao agendada" sem dizer por que foi
// exatamente o problema que deixou esses 5 casos invisiveis.
//
// `timestampAncora` e o timestamp da ULTIMA mensagem da conversa — a unica data que o prompt entrega
// ao modelo e, portanto, a unica que ele consegue copiar. Comparar so com ela (e nao com o timestamp
// de toda mensagem) e deliberado: um cliente pode perfeitamente mandar "pode ser as 16h" as 16h em
// ponto de outro dia, e comparar com a conversa inteira rejeitaria essa consulta legitima. Nos 5
// casos medidos em producao o valor copiado era a ancora em 4, e no quinto (deal 48412103) era a
// ancora do ciclo em que o valor foi gravado — que e exatamente o que esta funcao recebe ao rodar.
// A comparacao e feita nas duas leituras possiveis (a hora UTC crua e a hora do escritorio) porque o
// modelo tanto copia a string inteira quanto so a parte do relogio: o caso da Lane Maria (48346572,
// "2026-08-05T20:22:11" = a hora UTC da mensagem escrita como se fosse local) so cai na segunda.
// Separada de motivoHorarioImplausivel porque precisa ser aplicada tambem ao valor CRU do modelo,
// antes de corrigirDataRelativa. Medido no replay do deal 47543238: o modelo devolveu
// "2026-08-05T17:11:00" (17:11 = a hora de envio da ultima mensagem, no fuso do escritorio) para tres
// observacoes. Duas foram pegas, mas a terceira citava "Pode ser amanha, na quarta" — a correcao de dia
// relativo mudou a DATA pra 2026-07-29, o valor deixou de bater com a ancora e o eco passou pela
// checagem, levando 17:11 pra dentro da apuracao como se fosse horario combinado. A correcao de dia
// existe pra consertar um DIA errado num horario real, nao pra reabilitar um timestamp copiado.
function ehEcoDaAncora(iso, timestampAncora) {
  if (!iso || !timestampAncora) return false;
  const minuto = String(iso).slice(0, 16);
  if (minuto === String(timestampAncora).slice(0, 16)) return true;                 // hora UTC crua
  if (minuto === instanteParaNaiveLocal(timestampAncora)) return true;              // hora do escritorio
  // Só o RELOGIO igual ao da ancora, em qualquer dia, ja e suspeito: consulta cair exatamente no
  // minuto em que a ultima mensagem foi enviada e coincidencia de 1 em 1440, e o eco produz isso
  // sempre. E o que resta depois de a data ter sido reescrita pela correcao de dia relativo.
  const relogioAncora = (instanteParaNaiveLocal(timestampAncora) || '').slice(11, 16);
  return !!relogioAncora && minuto.slice(11, 16) === relogioAncora;
}

function motivoHorarioImplausivel(iso, timestampAncora, diaAncora) {
  const canonico = normalizarHorarioNaive(iso);
  if (!canonico) return `formato invalido ("${iso}") — esperado AAAA-MM-DDTHH:MM:00 em hora do escritorio, sem Z nem offset`;

  // Limite superior INCLUSIVO na hora: com 20, uma consulta as 20:00 ou 20:30 ainda vale e as 21:00
  // nao. Rejeitar 20:00 em ponto seria arbitrario demais pra uma regra que existe pra pegar 03:00.
  const hora = Number(canonico.slice(11, 13));
  if (hora < HORA_MIN_ATENDIMENTO || hora > HORA_MAX_ATENDIMENTO) {
    return `${canonico.slice(11, 16)} esta fora do horario de atendimento (${HORA_MIN_ATENDIMENTO}h-${HORA_MAX_ATENDIMENTO}h)`;
  }

  if (ehEcoDaAncora(canonico, timestampAncora)) {
    return `bate com o horario de envio da ultima mensagem da conversa (${timestampAncora}) — o modelo copiou a data-ancora em vez de derivar o horario`;
  }

  if (diaAncora) {
    const limite = somarDias(diaAncora, -DIAS_TOLERANCIA_PASSADO);
    const dia = canonico.slice(0, 10);
    if (dia < limite) return `${dia} esta mais de ${DIAS_TOLERANCIA_PASSADO} dias antes da ultima mensagem da conversa (${diaAncora}) — provavel erro de ano ou valor velho`;
  }

  return null;
}

// "hoje"/"amanha"/"depois de amanha" no trecho citado dizem, de forma inequivoca, quantos dias a
// mais o horario_iso precisa ter em relacao ao dia em que a MENSAGEM foi enviada — nao ao dia da
// ultima mensagem da conversa (a data-ancora usada no prompt), que pode ser dias depois de quando a
// frase foi dita. So cobre esses tres casos (dia da semana solto, ex: "sexta", fica de fora — a
// ambiguidade de "essa sexta" vs "a que vem" e maior e nao da pra corrigir com uma regra simples).
function deslocamentoRelativo(trecho) {
  const t = normalizar(trecho);
  if (/\bdepois de amanha\b/.test(t)) return 2;
  if (/\bamanha\b/.test(t)) return 1;
  if (/\bhoje\b/.test(t)) return 0;
  return null;
}

// Dia (AAAA-MM-DD) de um timestamp real (com fuso, ex: "...Z" do WhatsApp) no fuso do escritorio.
function diaLocalDeTimestamp(timestampIso) {
  const d = new Date(timestampIso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ_ESCRITORIO });
}

// horario_iso do modelo e "naive" (sem Z/offset) e ja representa a hora do ESCRITORIO diretamente —
// o dia e so os 10 primeiros caracteres, sem passar por Date (que aplicaria o fuso do PROCESSO, nao
// o do escritorio, e podia empurrar o dia sem essa intencao).
function diaDoIsoNaive(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso || ''));
  return m ? m[1] : null;
}

function somarDias(diaIso, n) {
  const [ano, mes, dia] = diaIso.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Dia da semana (0=domingo) de um dia AAAA-MM-DD. Em UTC de proposito: o dia ja vem resolvido no fuso
// do escritorio, entao aqui e aritmetica de calendario pura, sem fuso nenhum envolvido.
function diaDaSemanaDoDiaIso(diaIso) {
  const [ano, mes, dia] = String(diaIso).split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return isNaN(d.getTime()) ? null : d.getUTCDay();
}

// Em portugues o nome de quase todo dia da semana e tambem um ordinal: "segunda via", "quarta parte",
// "quinta vez". Sem esta lista, "vou mandar a segunda via do documento" era lido como segunda-feira e
// a funcao MOVIA a consulta (visto no teste, nao em producao). Com "-feira" junto nao ha ambiguidade.
const SUBSTANTIVOS_ORDINAIS = 'via|vias|parcela|parcelas|vez|vezes|opcao|opiniao|instancia|quinzena|metade|chance|tentativa|etapa|fase|parte|coluna|linha|pagina|semana';

// "sexta", "quarta-feira", "terca feira" => 0..6. O trecho ja chega normalizado (sem acento, sem
// pontuacao), entao "terça-feira" vira "terca feira".
const DIAS_SEMANA_CITADOS = [
  ['domingo', 0],
  ['segunda', 1],
  ['terca', 2],
  ['quarta', 3],
  ['quinta', 4],
  ['sexta', 5],
  ['sabado', 6],
].map(([nome, dia]) => [
  new RegExp(`\\b${nome}(\\s?feira\\b|\\b(?!\\s+(${SUBSTANTIVOS_ORDINAIS})\\b))`),
  dia,
]);

function diaSemanaCitado(trecho) {
  const t = normalizar(trecho);
  for (const [re, dia] of DIAS_SEMANA_CITADOS) {
    if (re.test(t)) return dia;
  }
  return null;
}

// Bug real visto no deal 48346871: a equipe disse "amanha as 09h" numa mensagem de 06/08, e o
// modelo resolveu horario_iso pra "2026-08-06T09:00" (o MESMO dia) em vez de "2026-08-07T09:00".
// A dupla confirmacao bateu (cliente e equipe "combinaram" nesse valor errado, entao passou pelas
// checagens de mesmoInstante), e so nao gerou reuniao no dia errado por coincidencia (o Google
// Calendar estava com o token expirado). Sem essa correcao, o proximo caso igual teria criado o
// evento pro dia errado sem nenhum aviso.
//
// So corrige a PARTE DA DATA, preservando a hora/minuto que o modelo resolveu — o texto geralmente
// acerta a hora ("as 09h"), erra so o dia relativo.
function corrigirDataRelativa(trecho, horarioIso, timestampMensagem) {
  if (!horarioIso || !timestampMensagem) return horarioIso;

  const diaMsg = diaLocalDeTimestamp(timestampMensagem);
  const diaResolvido = diaDoIsoNaive(horarioIso);
  if (!diaMsg || !diaResolvido) return horarioIso;

  const deslocamento = deslocamentoRelativo(trecho);
  if (deslocamento !== null) {
    // hoje/amanha/depois de amanha tem precedencia: sao inequivocos, e uma frase como "amanha, sexta"
    // resolve pelo "amanha" sem precisar concordar com a conta do dia da semana.
    const diaEsperado = somarDias(diaMsg, deslocamento);
    return diaResolvido === diaEsperado ? horarioIso : diaEsperado + horarioIso.slice(10);
  }

  // Dia da semana pelo NOME ("na sexta", "quarta-feira"). Cobre o que ficava 100% na mao do modelo:
  // "hoje/amanha" era a unica rede deterministica, e dia da semana solto e o que a equipe mais usa.
  //
  // A correcao aqui e deliberadamente CONSERVADORA: so entra quando o dia que o modelo resolveu nao
  // cai no dia da semana citado. Se ele resolveu para uma sexta qualquer, respeitamos a SEMANA que ele
  // escolheu — "sexta da semana que vem" e "sexta" sao ambos sextas, e a conversa pode ter dito qual
  // com palavras que esta funcao nao le. Substituir a semana por conta propria trocaria um acerto do
  // modelo por um erro nosso; o que corrigimos e so o caso em que o dia nao e sexta de jeito nenhum.
  const alvo = diaSemanaCitado(trecho);
  if (alvo === null) return horarioIso;

  const diaSemanaResolvido = diaDaSemanaDoDiaIso(diaResolvido);
  const diaSemanaMsg = diaDaSemanaDoDiaIso(diaMsg);
  if (diaSemanaResolvido === null || diaSemanaMsg === null) return horarioIso;

  // Uma excecao a regra conservadora acima: o modelo resolveu para o PROPRIO dia da mensagem e o dia
  // citado e o mesmo dia da semana ("na quinta", dito numa quinta, resolvido para essa quinta). Aqui o
  // dia da semana "bate" mas e justamente o erro documentado — quem diz "na quinta" numa quinta fala
  // da proxima; se fosse hoje diria "hoje", e "hoje" ja foi tratado com precedencia la em cima.
  const mesmoDiaDaMensagem = diaResolvido === diaMsg && alvo === diaSemanaMsg;
  if (diaSemanaResolvido === alvo && !mesmoDiaDaMensagem) return horarioIso;

  // Primeira ocorrencia ESTRITAMENTE depois do dia da mensagem — mesma regra que o prompt manda o
  // modelo seguir na tabela CALENDARIO DE REFERENCIA (index.js). Mesmo dia da semana da mensagem =>
  // semana seguinte, porque quem diz "na sexta" numa sexta esta falando da proxima.
  const delta = ((alvo - diaSemanaMsg + 7) % 7) || 7;
  return somarDias(diaMsg, delta) + horarioIso.slice(10);
}

// Valida uma lista de observacoes contra o array de mensagens da conversa.
// mensagens: [{ role: 'cliente'|'equipe'|'sistema', text, timestamp }]
// Retorna { validas, rejeitadas } — rejeitadas trazem o motivo, pra ir pro log.
function validarObservacoes(observacoes, mensagens) {
  const validas = [];
  const rejeitadas = [];
  const lista = Array.isArray(observacoes) ? observacoes : [];
  const msgs = Array.isArray(mensagens) ? mensagens : [];

  // Data-ancora = dia da ultima mensagem da conversa, no fuso do escritorio. E o mesmo valor que o
  // prompt usa como referencia (index.js), entao "no passado" aqui quer dizer a mesma coisa que la.
  const ultimoTimestamp = [...msgs].reverse().find((m) => m?.timestamp)?.timestamp || null;
  const diaAncora = ultimoTimestamp ? diaLocalDeTimestamp(ultimoTimestamp) : null;

  for (const obs of lista) {
    if (!obs || typeof obs !== 'object') {
      rejeitadas.push({ obs, motivo: 'observacao nao e objeto' });
      continue;
    }

    const spec = TIPOS_OBSERVACAO[obs.tipo];
    if (!spec) {
      rejeitadas.push({ obs, motivo: `tipo desconhecido "${obs.tipo}"` });
      continue;
    }

    const idx = Number(obs.msg_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= msgs.length) {
      rejeitadas.push({ obs, motivo: `msg_idx ${obs.msg_idx} fora do intervalo 0..${msgs.length - 1}` });
      continue;
    }

    const mensagem = msgs[idx];
    let tipo = obs.tipo;

    if (mensagem?.role !== spec.role) {
      // O role vem do transporte (direction do webhook) e e confiavel; o prefixo do tipo e palpite
      // do modelo, e ele erra com alguma frequencia — marcava "equipe_propos_horario" citando uma
      // mensagem do cliente e a observacao inteira era descartada, custando a perna do cliente.
      // Onde o mesmo fato existe nos dois papeis, corrigimos o prefixo em vez de descartar.
      const corrigido = TIPOS_CORRIGIVEIS[obs.tipo];
      if (corrigido && TIPOS_OBSERVACAO[corrigido]?.role === mensagem?.role) {
        tipo = corrigido;
      } else {
        // Sem contrapartida no outro papel. Rejeitar e obrigatorio: e aqui que mora a defesa contra
        // um cliente virar evidencia de equipe.
        rejeitadas.push({ obs, motivo: `msg_idx ${idx} tem role "${mensagem?.role}", mas ${obs.tipo} exige "${spec.role}"` });
        continue;
      }
    }

    const modo = conferirTrecho(obs.trecho, mensagem.text);
    if (!modo) {
      rejeitadas.push({ obs, motivo: `trecho citado nao aparece na mensagem ${idx}` });
      continue;
    }

    // horario_iso ausente NAO invalida a observacao. Faltar horario e incompletude, nao invencao —
    // e o modelo costuma omitir justamente no "pode ser", em que o horario vem da mensagem anterior.
    // Fica null e quem apura resolve por heranca (ver src/agendamento.js). Descartar aqui perderia a
    // perna de confirmacao mais comum que existe.
    const specFinal = TIPOS_OBSERVACAO[tipo];
    const horarioBruto = specFinal.exigeHorario && horarioValido(obs.horario_iso) ? obs.horario_iso : null;
    // "amanha"/"hoje"/"depois de amanha" no trecho tem um dia certo e verificavel a partir do
    // timestamp real da mensagem — corrige quando o modelo resolveu pro dia errado (ver comentario
    // em corrigirDataRelativa).
    // O eco e checado no valor CRU, ANTES da correcao de dia relativo: a correcao reescreve a data e
    // faria um timestamp copiado deixar de parecer com a ancora (ver ehEcoDaAncora). Eco nao se
    // corrige, se descarta.
    const ecoNoValorCru = ehEcoDaAncora(normalizarHorarioNaive(horarioBruto) || horarioBruto, ultimoTimestamp);
    const horarioCorrigido = horarioBruto && !ecoNoValorCru
      ? corrigirDataRelativa(obs.trecho, horarioBruto, mensagem.timestamp)
      : horarioBruto;

    // Rede deterministica: horario que nao passa por motivoHorarioImplausivel nao pode servir de
    // perna de confirmacao. Cai pra null (a observacao continua valida — o FATO citado aconteceu, so
    // o horario e que nao serve), entao apurarDuplaConfirmacao registra falta_cliente/falta_equipe e o
    // escritorio recebe nota + Telegram em vez de uma reuniao no horario errado.
    const motivoImplausivel = horarioCorrigido
      ? motivoHorarioImplausivel(horarioCorrigido, ultimoTimestamp, diaAncora)
      : null;
    const horario = motivoImplausivel ? null : (horarioCorrigido && normalizarHorarioNaive(horarioCorrigido));

    validas.push({
      ...obs,
      tipo,                                   // pode ter sido corrigido pelo papel real de quem falou
      msg_idx: idx,
      horario_iso: horario,
      _modoEvidencia: modo,
      ...(tipo !== obs.tipo ? { _tipoOriginal: obs.tipo } : {}),
      ...(horario && horarioCorrigido !== horarioBruto ? { _dataCorrigida: horarioBruto } : {}),
      ...(motivoImplausivel ? { _horarioImplausivel: { valor: horarioCorrigido, motivo: motivoImplausivel } } : {}),
    });
  }

  // Segunda passada: propaga a correcao pras observacoes que citam o MESMO valor errado mas cujo
  // proprio trecho nao repete "amanha"/"hoje" (ex: "Perfeito, esta agendado!" — confirma sem
  // repetir o dia). Visto no deal 48346871: a proposta e o aceite citavam "amanha" e foram
  // corrigidos; a confirmacao da equipe, que so referenciava o horario ja combinado sem repetir a
  // palavra, ficou pro dia errado — cliente e equipe passaram a apontar pra dias diferentes e a
  // dupla confirmacao, que deveria bater, quebrou. Duas observacoes com o EXATO mesmo horario_iso
  // bruto (a mesma data+hora, ao minuto) quase certamente sao o mesmo compromisso.
  // As chaves entram canonizadas (HH:MM:00) porque horario_iso ja saiu canonizado acima — sem isso,
  // "09:00" de uma observacao nunca casaria com "09:00:00" da outra e a propagacao virava no-op.
  const correcaoPorValorOriginal = new Map();
  for (const v of validas) {
    if (v._dataCorrigida) correcaoPorValorOriginal.set(normalizarHorarioNaive(v._dataCorrigida) || v._dataCorrigida, v.horario_iso);
  }
  if (correcaoPorValorOriginal.size) {
    for (const v of validas) {
      if (v._dataCorrigida) continue; // ja corrigida pelo proprio trecho
      const corrigido = correcaoPorValorOriginal.get(v.horario_iso);
      if (!corrigido || corrigido === v.horario_iso) continue;

      // Propagacao NUNCA pode jogar o compromisso pra antes do dia da mensagem que o afirma. Medido no
      // replay do deal 47543238: o modelo deu o MESMO horario (errado) as tres observacoes; a proposta,
      // de 28/07, citava "amanha" e foi corrigida pra 29/07; a confirmacao da equipe, de 03/08 ("Perfeito,
      // esta marcado" — o aceite da REMARCACAO), herdou esse 29/07 por ter o mesmo valor bruto. A
      // apuracao entao fechava em 29/07: o horario ANTIGO, ja superado, e como o evento no Google ja
      // estava nele, a remarcacao pra 04/08 nunca acontecia — foi o que deixou o cliente esperando
      // sozinho na sala em 04/08. "Mesmo valor bruto = mesmo compromisso" nao vale quando o valor bruto
      // e lixo: nesse caso todas as observacoes tem o mesmo valor e o sinal nao quer dizer nada.
      const diaMensagem = diaLocalDeTimestamp(msgs[v.msg_idx]?.timestamp);
      const diaPropagado = diaDoIsoNaive(corrigido);
      if (diaMensagem && diaPropagado && diaPropagado < diaMensagem) {
        v._propagacaoRecusada = { valor: corrigido, motivo: `propagar ${diaPropagado} para uma mensagem de ${diaMensagem} colocaria a consulta antes de ser combinada` };
        v.horario_iso = null;
        continue;
      }

      v._dataCorrigida = v.horario_iso;
      v.horario_iso = corrigido;
    }
  }

  return { validas, rejeitadas };
}

// Ultima observacao valida de um tipo (a mais recente na conversa vence).
function ultimaObservacao(validas, tipo) {
  let escolhida = null;
  for (const o of validas) {
    if (o.tipo === tipo && (!escolhida || o.msg_idx > escolhida.msg_idx)) escolhida = o;
  }
  return escolhida;
}

module.exports = {
  TIPOS_OBSERVACAO,
  normalizar,
  conferirTrecho,
  corrigirDataRelativa,
  validarObservacoes,
  ultimaObservacao,
  normalizarHorarioNaive,
  instanteParaNaiveLocal,
  motivoHorarioImplausivel,
  diaLocalDeTimestamp,
};
