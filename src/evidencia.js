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
  const deslocamento = deslocamentoRelativo(trecho);
  if (deslocamento === null) return horarioIso;

  const diaMsg = diaLocalDeTimestamp(timestampMensagem);
  const diaResolvido = diaDoIsoNaive(horarioIso);
  if (!diaMsg || !diaResolvido) return horarioIso;

  const diaEsperado = somarDias(diaMsg, deslocamento);
  if (diaResolvido === diaEsperado) return horarioIso; // ja estava certo

  return diaEsperado + horarioIso.slice(10);
}

// Valida uma lista de observacoes contra o array de mensagens da conversa.
// mensagens: [{ role: 'cliente'|'equipe'|'sistema', text, timestamp }]
// Retorna { validas, rejeitadas } — rejeitadas trazem o motivo, pra ir pro log.
function validarObservacoes(observacoes, mensagens) {
  const validas = [];
  const rejeitadas = [];
  const lista = Array.isArray(observacoes) ? observacoes : [];
  const msgs = Array.isArray(mensagens) ? mensagens : [];

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
    const horario = horarioBruto ? corrigirDataRelativa(obs.trecho, horarioBruto, mensagem.timestamp) : null;

    validas.push({
      ...obs,
      tipo,                                   // pode ter sido corrigido pelo papel real de quem falou
      msg_idx: idx,
      horario_iso: horario,
      _modoEvidencia: modo,
      ...(tipo !== obs.tipo ? { _tipoOriginal: obs.tipo } : {}),
      ...(horario && horario !== horarioBruto ? { _dataCorrigida: horarioBruto } : {}),
    });
  }

  // Segunda passada: propaga a correcao pras observacoes que citam o MESMO valor errado mas cujo
  // proprio trecho nao repete "amanha"/"hoje" (ex: "Perfeito, esta agendado!" — confirma sem
  // repetir o dia). Visto no deal 48346871: a proposta e o aceite citavam "amanha" e foram
  // corrigidos; a confirmacao da equipe, que so referenciava o horario ja combinado sem repetir a
  // palavra, ficou pro dia errado — cliente e equipe passaram a apontar pra dias diferentes e a
  // dupla confirmacao, que deveria bater, quebrou. Duas observacoes com o EXATO mesmo horario_iso
  // bruto (a mesma data+hora, ao minuto) quase certamente sao o mesmo compromisso.
  const correcaoPorValorOriginal = new Map();
  for (const v of validas) {
    if (v._dataCorrigida) correcaoPorValorOriginal.set(v._dataCorrigida, v.horario_iso);
  }
  if (correcaoPorValorOriginal.size) {
    for (const v of validas) {
      if (v._dataCorrigida) continue; // ja corrigida pelo proprio trecho
      const corrigido = correcaoPorValorOriginal.get(v.horario_iso);
      if (corrigido && corrigido !== v.horario_iso) {
        v._dataCorrigida = v.horario_iso;
        v.horario_iso = corrigido;
      }
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
};
