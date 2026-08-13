// Monta a Atividade que representa a consulta na AGENDA do Moskit.
//
// Ate aqui a integracao era de mao unica: sincronizarAtividadesMoskit levava atividade do CRM para o
// Google Agenda, mas o agendamento nascido da conversa (dupla confirmacao cliente+equipe) so virava
// evento no Google e uma NOTA no negocio. Quem trabalha dentro do Moskit nao via o compromisso.
//
// A logica fica aqui, fora do index.js, para ser testavel sem rede e sem banco — e porque o unico
// ponto de verdade que importa nela e delicado: a conversao do horario.

const { ATIVIDADE_TIPO, LAYLA_USER_ID } = require('./moskit-ids');

// O pipeline trabalha com horario "naive": "2026-08-05T17:30:00", sem Z e sem offset, significando
// SEMPRE a hora local do escritorio (ver o comentario de TZ_ESCRITORIO em index.js). O Google Agenda
// aceita isso diretamente, junto de `timeZone` — o Moskit nao: `dueDate` e um instante absoluto.
//
// Por isso a conversao nao pode ser `new Date(naive)` (interpreta no fuso da VPS, que roda em UTC:
// a consulta das 17h30 iria para as 14h30 na agenda do escritorio) nem `${naive}Z`. E tambem nao
// deve fixar "-03:00" na mao: TZ_ESCRITORIO e configuravel, e o resto do codigo nunca chuta offset.
// O offset e perguntado ao proprio Intl, para o instante em questao.
function offsetDoFuso(instante, timeZone) {
  const parte = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instante)
    .find((p) => p.type === 'timeZoneName');
  // Formatos possiveis: "GMT-03:00", "GMT-3", "GMT" (fuso zero).
  const casado = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(parte?.value || '');
  if (!casado) return 0;
  const sinal = casado[1] === '-' ? -1 : 1;
  return sinal * (Number(casado[2]) * 60 + Number(casado[3] || 0));
}

// Converte o horario naive do escritorio no instante absoluto (ISO com Z) que o Moskit espera.
// Devolve null para entrada invalida, para o chamador poder desistir sem mandar lixo ao CRM.
function horarioNaiveParaInstante(horarioNaive, timeZone) {
  if (typeof horarioNaive !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(horarioNaive)) return null;

  // Primeiro palpite: le a string como se fosse UTC. O offset real do fuso naquele ponto do
  // calendario e entao descontado. Dois passos porque o offset pode depender da propria data
  // (horario de verao em fusos que ainda o praticam) — o primeiro palpite erra por no maximo
  // algumas horas, o que basta para cair no periodo certo.
  const palpite = new Date(`${horarioNaive}Z`);
  if (Number.isNaN(palpite.getTime())) return null;
  const offset1 = offsetDoFuso(palpite, timeZone);
  const corrigido = new Date(palpite.getTime() - offset1 * 60 * 1000);
  const offset2 = offsetDoFuso(corrigido, timeZone);
  const instante = offset2 === offset1 ? corrigido : new Date(palpite.getTime() - offset2 * 60 * 1000);
  return instante.toISOString();
}

// Duracao media de uma consulta — o mesmo 1h que criarEventoGoogleCalendar usa no evento do Google.
// Os dois precisam continuar iguais: sao o mesmo compromisso em duas agendas.
const DURACAO_CONSULTA_MIN = 60;

// `presencial` vem do mesmo sinal que decide se o evento do Google ganha link do Meet
// (dados.modalidade_consulta === 'presencial'), para o tipo da atividade nunca contradizer o evento.
function montarPayloadAtividade({ dealId, contatoId, titulo, assunto, dueDate, presencial, meetLink, duracaoMin }) {
  if (!dealId || !dueDate) return null;

  const notas = [
    assunto ? `Assunto: ${assunto}` : '',
    meetLink ? `Link do Meet: ${meetLink}` : '',
    `Negócio no Moskit: https://app.ollow.com.br/?/deal/${dealId}`,
    'Agendado automaticamente pelo bot do WhatsApp após confirmação do cliente e da equipe.',
  ].filter(Boolean).join('\n');

  return {
    title: titulo || 'Consulta agendada',
    type: { id: presencial ? ATIVIDADE_TIPO.reuniao : ATIVIDADE_TIPO.videoconferencia },
    dueDate,
    duration: duracaoMin || DURACAO_CONSULTA_MIN,
    notes: notas,
    deals: [{ id: dealId }],
    ...(contatoId ? { contacts: [{ id: contatoId }] } : {}),
    responsible: { id: LAYLA_USER_ID },
    createdBy: { id: LAYLA_USER_ID },
  };
}

module.exports = {
  DURACAO_CONSULTA_MIN,
  horarioNaiveParaInstante,
  montarPayloadAtividade,
};
