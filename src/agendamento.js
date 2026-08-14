// Apuracao da DUPLA CONFIRMACAO do horario da consulta.
//
// O bug que originou isto: o portao antigo era `pagamentoVerificado || confirmadoPelaEquipe`, ou seja
// uma perna so. A equipe dizer "marquei pra sexta 14h" bastava pra criar o evento, mesmo que o
// cliente nunca tivesse respondido.
//
// Agora precisa das duas pernas — o cliente aceitou E a equipe confirmou — apontando para o MESMO
// horario. E as duas tem que vir de observacoes ja validadas (src/evidencia.js), entao cada perna
// esta amarrada a uma mensagem real, com o role correto.

const { ultimaObservacao } = require('./evidencia');

const TOLERANCIA_MS = 60 * 1000; // mesma tolerancia que atualizarEventoSeRemarcado usa

// Tipos que servem como perna do CLIENTE. Aceitar ou propor tem o mesmo peso: quem propos "consigo
// sexta as 14h" concordou com sexta as 14h tanto quanto quem respondeu "pode ser" a uma proposta.
// O que fecha o agendamento e a equipe confirmar ESSE mesmo horario depois.
const TIPOS_PERNA_CLIENTE = ['cliente_aceitou_horario', 'cliente_propos_horario'];

// "pode ser" nao repete o dia/hora — o horario vem da proposta imediatamente anterior, entao um
// ACEITE sem horario_iso herda o ultimo horario mencionado.
//
// Heranca vale SO pra aceite. Proposta e confirmacao sempre nomeiam o proprio horario; se vierem sem
// ele, herdar o anterior seria inventar concordancia. Foi exatamente isso que mascarou o caso de
// renegociacao: "Consegue na sexta as 16h no lugar?" sem horario_iso herdava a quarta ja confirmada e
// a mudanca de horario passava despercebida.
const TIPOS_QUE_HERDAM_HORARIO = ['cliente_aceitou_horario'];

function resolverHorarios(validas) {
  const ordenadas = [...validas].sort((a, b) => a.msg_idx - b.msg_idx);
  let ultimoHorario = null;
  return ordenadas.map((o) => {
    if (o.horario_iso) {
      ultimoHorario = o.horario_iso;
      return o;
    }
    if (TIPOS_QUE_HERDAM_HORARIO.includes(o.tipo) && ultimoHorario) {
      return { ...o, horario_iso: ultimoHorario, _horarioHerdado: true };
    }
    return o;
  });
}

// Rede determinista contra o erro de classificacao mais caro que o modelo comete: marcar
// "vou ver e te aviso" como cliente_aceitou_horario. Combinado com a heranca de horario, isso
// viraria uma confirmacao completa e a reuniao iria pra agenda sem o cliente ter aceitado nada.
// Nao dependemos do modelo acertar: se o trecho e evasivo e nao tem nada afirmativo junto, nao vale.
const RE_EVASIVO = /\b(vou ver|vou verificar|vou checar|te aviso|te falo|te retorno|aviso depois|depois (eu )?(confirmo|falo|vejo)|acho que|talvez|provavelmente|preciso ver|vou pensar|se der)\b/g;

// So afirmativos FORTES cancelam a hesitacao. "sim" e "confirmo" ficaram de fora de proposito:
// sao exatamente as palavras que a propria hesitacao carrega ("acho que sim", "depois eu confirmo"),
// e mante-las na lista fazia esses casos passarem como aceite valido.
const RE_AFIRMATIVO = /\b(pode ser|podemos sim|confirmado|confirmada|fechado|combinado|perfeito|otimo|beleza|isso mesmo|estarei|ta bom|tudo bem|ok)\b/;

function aceiteEvasivo(trecho) {
  const t = String(trecho || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  RE_EVASIVO.lastIndex = 0;
  if (!RE_EVASIVO.test(t)) return false;
  // Testa o afirmativo no texto SEM os trechos evasivos, pra que "depois eu confirmo" nao se
  // auto-absolva com o "confirmo" que faz parte da propria hesitacao.
  RE_EVASIVO.lastIndex = 0;
  return !RE_AFIRMATIVO.test(t.replace(RE_EVASIVO, ' '));
}

// Perna do cliente = a mais recente entre aceite e proposta.
function pernaDoCliente(validas) {
  let escolhida = null;
  for (const o of validas) {
    if (!TIPOS_PERNA_CLIENTE.includes(o.tipo)) continue;
    if (!horarioTemHoraDefinida(o.horario_iso)) continue;
    // Vale pros dois tipos: o modelo tanto marca "vou ver e te aviso" como aceite quanto como
    // proposta do cliente — e nenhuma das duas leituras compromete o cliente com um horario.
    if (aceiteEvasivo(o.trecho)) continue;
    if (!escolhida || o.msg_idx > escolhida.msg_idx) escolhida = o;
  }
  return escolhida;
}

// "a partir do dia 10 nos podemos" vira "2026-08-10T00:00:00": o modelo resolveu o DIA e nao a HORA.
// Meia-noite nunca e horario real de consulta, entao esse valor nao serve como perna de confirmacao —
// senao a reuniao ia parar na agenda a 00:00. Visto em conversa real no replay.
//
// Le a hora da PROPRIA STRING, sem passar por Date: getHours() devolve a hora do fuso do PROCESSO, e
// a VPS roda em UTC. Enquanto o valor e naive isso dava no mesmo, mas com um ISO que traga "Z" o
// resultado mudava conforme o servidor — "2026-08-10T00:00:00Z" e meia-noite numa VPS em UTC (recusa)
// e 21:00 do dia anterior em America/Fortaleza (aceita). Mesmo motivo de diaDoIsoNaive em
// src/evidencia.js: horario naive nunca deve passar por Date.
function horarioTemHoraDefinida(iso) {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(String(iso || ''));
  if (!m) return false;
  return !(m[1] === '00' && m[2] === '00');
}

function mesmoInstante(isoA, isoB) {
  if (!isoA || !isoB) return false; // explicito: new Date(null) daria 1970 e compararia como valido
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return false;
  return Math.abs(a.getTime() - b.getTime()) < TOLERANCIA_MS;
}

// Proposta posterior as duas confirmacoes, para um horario diferente => a negociacao reabriu e as
// vagas de confirmacao ficam vazias de novo. E isto que impede o bug do mergeDados: uma confirmacao
// nao sobrevive a uma mudanca de horario.
//
// Proposta posterior SEM horario resolvido tambem reabre: vimos alguem mexer no horario e nao
// conseguimos dizer pra quando. Nao dar pra afirmar que continua valendo e motivo pra nao agendar —
// o custo de esperar e uma nota no CRM, o de errar e reuniao no horario errado.
function propostaMaisRecenteDivergente(validas, idxLimite, horarioIso) {
  return validas.some((o) =>
    (o.tipo === 'equipe_propos_horario' || o.tipo === 'cliente_propos_horario')
    && o.msg_idx > idxLimite
    && !mesmoInstante(o.horario_iso, horarioIso));
}

// Retorna:
//   { confirmado, horarioIso, cliente, equipe, motivo }
// motivo (quando nao confirmado): 'falta_cliente' | 'falta_equipe' | 'falta_ambos'
//                               | 'horarios_divergentes' | 'renegociado'
function apurarDuplaConfirmacao(validas) {
  const lista = resolverHorarios(Array.isArray(validas) ? validas : []);
  const cliente = pernaDoCliente(lista);
  const equipe = ultimaObservacao(lista.filter((o) => horarioTemHoraDefinida(o.horario_iso)), 'equipe_confirmou_horario');

  if (!cliente && !equipe) return { confirmado: false, horarioIso: null, cliente, equipe, motivo: 'falta_ambos' };
  if (!cliente) return { confirmado: false, horarioIso: null, cliente, equipe, motivo: 'falta_cliente' };
  if (!equipe) return { confirmado: false, horarioIso: null, cliente, equipe, motivo: 'falta_equipe' };

  if (!mesmoInstante(cliente.horario_iso, equipe.horario_iso)) {
    return { confirmado: false, horarioIso: null, cliente, equipe, motivo: 'horarios_divergentes' };
  }

  const idxLimite = Math.max(cliente.msg_idx, equipe.msg_idx);
  if (propostaMaisRecenteDivergente(lista, idxLimite, equipe.horario_iso)) {
    return { confirmado: false, horarioIso: null, cliente, equipe, motivo: 'renegociado' };
  }

  return { confirmado: true, horarioIso: equipe.horario_iso, cliente, equipe, motivo: null };
}

// Texto curto pra log e pra nota no CRM.
function descreverPendencia(apuracao) {
  switch (apuracao.motivo) {
    case 'falta_ambos': return 'nem o cliente nem a equipe confirmaram o horário';
    case 'falta_cliente': return 'falta a confirmação DO CLIENTE (a equipe já confirmou)';
    case 'falta_equipe': return 'falta a confirmação DA EQUIPE (o cliente já aceitou)';
    case 'horarios_divergentes': return 'cliente e equipe confirmaram horários diferentes';
    case 'renegociado': return 'um novo horário foi proposto depois das confirmações — a negociação reabriu';
    default: return 'confirmações incompletas';
  }
}

module.exports = { mesmoInstante, horarioTemHoraDefinida, apurarDuplaConfirmacao, descreverPendencia, TOLERANCIA_MS };
