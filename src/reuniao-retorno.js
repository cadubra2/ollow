// DECISAO da 2a+ reuniao do MESMO caso: quando o horario novo que cliente e equipe confirmaram e
// uma reuniao NOVA (retorno/acompanhamento), e nao a remarcacao da reuniao que ja aconteceu.
//
// Sem esta decisao, handleAgendamentoCalendar (index.js) trata TODO horario novo confirmado, num
// deal que ja tem evento_calendar_criado=1, como remarcacao: da PATCH em start/end do evento que JA
// ACONTECEU, movendo-o para o futuro — o registro da reuniao 1 desaparece da agenda, e a Atividade do
// Moskit (se ja concluida) rejeita o PUT com 422 "Completed activity cannot be updated". A reuniao
// nova nunca entra na agenda do CRM (registrarConsultaNaAgendaMoskit sai na guarda de
// atividade_moskit_id ja existente).
//
// A decisao vive aqui, sem rede e sem banco, mesma divisao de src/evidencia.js e
// src/cliente-retorno.js: a IA propoe (o horario confirmado), o codigo deterministico decide o que
// esse horario SIGNIFICA. Nenhum campo novo de IA e nenhum tipo novo de observacao — os sinais
// (consulta ja realizada, dupla confirmacao) ja existem e ja sao validados contra a mensagem real.
//
// `consulta` e a saida de clienteRetorno.consultaJaRealizada (src/cliente-retorno.js) — reuso direto,
// ela ja escolhe a reuniao mais recente entre evento_calendar_data e a nota do Gemini CONCLUIDO, ja
// converte o naive do escritorio pra instante e ja devolve fimComFolga.

const { horarioNaiveParaInstante } = require('./atividade-moskit');

// Ate quantas horas DEPOIS do fim da reuniao anterior (com folga) uma nova confirmacao ainda conta
// como remarcacao (cliente furou o horario e reagendou logo depois) em vez de reuniao nova. Cliente
// que confirma um horario novo dias depois nao "faltou a reuniao de ha pouco" — voltou com outro
// assunto de acompanhamento.
const TOLERANCIA_HORAS_PADRAO = 24;

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Veredito unico sobre um horario que a dupla confirmacao ACABOU de fechar, num deal que ja tem
// evento na agenda.
//
//   retorno: false — remarcacao. Move o evento existente (caminho de hoje).
//   retorno: true  — reuniao nova. Abre um compromisso proprio, preserva o registro do anterior.
//
// `confirmadoEm` e o timestamp da MENSAGEM que fechou a perna mais recente da dupla confirmacao
// (max(apuracao.cliente, apuracao.equipe) por mensagens[msg_idx].timestamp) — NUNCA Date.now(). Um
// reprocessamento dias depois (fila, processar_pendentes.js, refresh de briefing) recalcularia a
// mesma conversa com um relogio diferente e inverteria o veredito. So cai para "agora" quando a
// mensagem nao tem timestamp.
function classificarReuniao({ consulta, horarioNovoIso, confirmadoEm, timeZone, toleranciaHoras } = {}) {
  const base = { retorno: false, motivo: null, consulta: consulta || null };

  if (!consulta?.realizada) {
    // Reuniao anterior ainda nao aconteceu (ou nao existe registro nenhum) — isto e uma remarcacao
    // comum, o caminho que handleAgendamentoCalendar ja sabia tratar antes desta funcionalidade.
    return { ...base, motivo: consulta?.motivo || 'sem_consulta_registrada' };
  }

  const horarioNovoInstante = horarioNaiveParaInstante(horarioNovoIso, timeZone);
  if (!horarioNovoInstante) {
    return { ...base, motivo: 'horario_novo_invalido' };
  }

  if (ms(horarioNovoInstante) <= ms(consulta.fimComFolga)) {
    // O horario confirmado ainda cai DENTRO da janela da reuniao anterior (idêntico ao que ja esta
    // marcado, ou anterior ao fim dela com folga) — nao e reuniao nova nenhuma, e o caminho comum de
    // reconfirmar o mesmo horario. atualizarEventoSeRemarcado ja tem seu proprio guard de "nao mudou
    // de verdade" para esse caso.
    return { ...base, motivo: 'horario_dentro_da_janela_anterior' };
  }

  const toleranciaMs = (Number.isFinite(toleranciaHoras) ? toleranciaHoras : TOLERANCIA_HORAS_PADRAO) * 60 * 60 * 1000;
  const limiteRemarcacao = ms(consulta.fimComFolga) + toleranciaMs;
  const confirmadoMs = ms(confirmadoEm) ?? Date.now();

  if (confirmadoMs <= limiteRemarcacao) {
    // Cliente furou o horario (ou a equipe so remarcou logo depois) e a dupla confirmacao fechou o
    // novo horario ainda dentro da tolerancia — trata como a MESMA reuniao que deslizou, nao como
    // uma segunda reuniao do caso.
    return { ...base, motivo: 'dentro_da_tolerancia_de_remarcacao' };
  }

  return { ...base, retorno: true, motivo: 'confirmado_apos_tolerancia' };
}

// A que reuniao um e-mail de notas do Gemini se refere, pela DATA (o assunto do e-mail so tem dia,
// nunca hora — ver parseAssuntoGemini em src/notas-reuniao.js). `reunioes` e a lista de todas as
// reunioes conhecidas do deal: a atual (row.reuniao_num + row.evento_calendar_data) mais as
// arquivadas em row.reunioes_anteriores, cada uma como { numero, horarioIso } — horarioIso NAIVE do
// escritorio, entao o dia bate direto com dataIso sem nenhuma conversao de fuso.
//
// Nao usa o contador atual (row.reuniao_num) direto: o e-mail da reuniao 1 pode chegar depois de a
// reuniao 2 ja estar aberta (Gmail atrasa, o Gemini demora a processar), e rotular pelo contador
// atual numeraria a nota da reuniao 1 como se fosse a mais recente.
//
// Dia com MAIS de uma reuniao (duas reunioes no mesmo dia) e ambiguo de proposito — devolve null, o
// mesmo "candidato unico ou nada" que decidirDeal usa pra escolher negocio.
function numeroDaReuniao(reunioes, dataIso) {
  if (!dataIso) return null;
  const candidatos = new Set();
  for (const r of reunioes || []) {
    if (!r?.horarioIso) continue;
    if (String(r.horarioIso).slice(0, 10) === dataIso) candidatos.add(r.numero);
  }
  return candidatos.size === 1 ? [...candidatos][0] : null;
}

// Vocabulario UNICO da agenda: a 1a reuniao do caso continua "Consulta" (nao quebra o contrato de
// montarResumoEvento/backfillMeetLinks/notas-reuniao que ja depende desse nome); da 2a em diante e
// "Retorno N" com N comecando em 1 na segunda reuniao (retorno 1 = a 2a reuniao do caso).
function rotuloCompromisso(numero) {
  const n = Number(numero) || 1;
  return n <= 1 ? 'Consulta' : `Retorno ${n - 1}`;
}

// Texto curto e NOMEADO — vai para a nota do negocio e para o Telegram.
const MOTIVOS = {
  sem_consulta_registrada: 'nenhuma consulta anterior registrada para esta conversa',
  consulta_ainda_nao_aconteceu: 'a consulta anterior ainda não aconteceu',
  horario_novo_invalido: 'o novo horário confirmado não converteu para um instante válido',
  horario_dentro_da_janela_anterior: 'o horário confirmado ainda cai dentro da janela da reunião anterior',
  dentro_da_tolerancia_de_remarcacao: 'confirmado dentro da tolerância de remarcação da reunião anterior',
  confirmado_apos_tolerancia: 'confirmado depois da tolerância de remarcação — é uma reunião nova',
};

function descreverMotivo(motivo) {
  return MOTIVOS[motivo] || motivo || 'sem motivo registrado';
}

module.exports = {
  TOLERANCIA_HORAS_PADRAO,
  MOTIVOS,
  classificarReuniao,
  numeroDaReuniao,
  rotuloCompromisso,
  descreverMotivo,
};
