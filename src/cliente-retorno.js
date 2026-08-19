// DECISAO do segundo atendimento: o cliente que ja foi atendido e voltou com um caso NOVO.
//
// O bot trata um telefone como uma conversa e um negocio para sempre — `conversations` tem uma linha
// por chat_id e nada nela e encerrado quando o atendimento acaba. Cliente que volta meses depois cai
// na MESMA linha, com o deal_id antigo, o historico antigo do WhatsApp e todos os checkpoints
// herdados: o bloco de condicoes do primeiro atendimento ja marca a nova consulta como paga, a area
// do caso velho classifica o caso novo (mesclarParaCrm), e o PUT reabre o negocio fechado.
//
// A decisao vive aqui, sem rede e sem banco, pelo mesmo motivo de src/evidencia.js: e uma regra de
// negocio delicada que precisa de teste barato. O index.js so busca o que ela pede e executa.
//
// REGRA DE OURO, herdada do "candidato unico ou orfao" das notas de reuniao: sinal ambiguo NAO abre
// negocio. Abrir um segundo negocio para o MESMO caso duplica o cliente no funil e espalha a historia
// dele em dois lugares — e ninguem detecta lendo, porque os dois parecem legitimos.

const { DURACAO_CONSULTA_MIN, horarioNaiveParaInstante } = require('./atividade-moskit');
const MOSKIT_IDS = require('./moskit-ids');

// Assunto que o pipeline usa quando o cliente ainda NAO contou o caso (index.js, ASSUNTO_NEUTRO).
// Aqui ele vale como "nao sei do que se trata", nunca como "assunto diferente do anterior".
const ASSUNTO_NEUTRO = 'Consulta jurídica';

// Folga depois do FIM da consulta. Mensagem trocada durante a reuniao, ou logo depois dela ("doutor,
// esqueci de dizer que tenho tambem o contrato X"), e o MESMO atendimento — nao um caso novo.
const FOLGA_HORAS_PADRAO = 2;

// Converte o que o banco guarda em instante absoluto. `evento_calendar_data` e horario NAIVE do
// escritorio ("2026-08-05T17:30:00"): ler com `new Date()` cru interpreta no fuso do processo, que na
// VPS e UTC — a consulta das 17h30 viraria 14h30 e a fronteira do atendimento sairia 3h fora do lugar.
// Valor que ja venha com Z/offset e instante e passa direto.
function paraInstante(valor, timeZone) {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  const texto = valor.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(texto)) {
    const d = new Date(texto);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return horarioNaiveParaInstante(texto.slice(0, 19), timeZone);
}

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// A consulta ja aconteceu? Duas fontes, ambas LOCAIS (zero rede):
//   - eventoCalendarData: o horario que o proprio bot reservou (conversations.evento_calendar_data);
//   - notaReuniaoEm: a nota do Gemini concluida para o negocio, que so existe se a reuniao ocorreu.
// Quando as duas existem vale a MAIS RECENTE: e ela que define onde termina o atendimento anterior.
function consultaJaRealizada({ eventoCalendarData, notaReuniaoEm, agora, timeZone, folgaHoras } = {}) {
  const agoraMs = ms(agora) ?? Date.now();
  const folgaMs = (Number.isFinite(folgaHoras) ? folgaHoras : FOLGA_HORAS_PADRAO) * 60 * 60 * 1000;

  const candidatos = [
    { fonte: 'evento_calendar', inicio: paraInstante(eventoCalendarData, timeZone) },
    { fonte: 'nota_reuniao', inicio: paraInstante(notaReuniaoEm, timeZone) },
  ].filter((c) => ms(c.inicio) !== null);

  if (candidatos.length === 0) {
    return { realizada: false, motivo: 'sem_consulta_registrada', quando: null, fonte: null, fimComFolga: null };
  }

  const escolhido = candidatos.reduce((a, b) => (ms(b.inicio) > ms(a.inicio) ? b : a));
  const fimComFolga = new Date(ms(escolhido.inicio) + DURACAO_CONSULTA_MIN * 60 * 1000 + folgaMs).toISOString();
  const realizada = ms(fimComFolga) <= agoraMs;

  return {
    realizada,
    motivo: realizada ? 'consulta_realizada' : 'consulta_ainda_nao_aconteceu',
    quando: escolhido.inicio,
    fonte: escolhido.fonte,
    fimComFolga,
  };
}

// Area comparada por ID da opcao do CRM, nunca por texto: "Direito Digital" e "LGPD" sao a MESMA area
// (src/moskit-ids.js resolve o apelido), e compara-las como string diria "area diferente" e abriria um
// segundo negocio para o mesmo caso. Texto que nao resolve para opcao nenhuma cai na chave normalizada.
function chaveArea(valor) {
  if (!valor) return null;
  const id = MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.INDICE_BUSCA.AREA_DIREITO, valor);
  return id ? `id:${id}` : `txt:${MOSKIT_IDS.normalizarChave(valor)}`;
}

function assuntoEspecifico(valor) {
  const chave = MOSKIT_IDS.normalizarChave(valor);
  if (!chave) return null;
  if (chave === MOSKIT_IDS.normalizarChave(ASSUNTO_NEUTRO)) return null;
  return chave;
}

const TIPOS_CASO_DESCRITO = ['cliente_descreveu_caso', 'equipe_descreveu_caso'];

// A ultima observacao VALIDADA de caso descrito cuja mensagem e posterior ao fim da consulta.
// Posterior de verdade, pelo timestamp da propria mensagem citada — o mesmo criterio que
// corrigirDataRelativa usa para o dia relativo. Mensagem sem timestamp nao pode ser datada, entao nao
// serve de evidencia: e melhor perder um retorno do que abrir negocio por um indice solto.
function evidenciaDeCasoNovo(obsValidas, mensagens, depoisDe) {
  const limite = ms(depoisDe);
  if (limite === null) return null;
  let escolhida = null;
  for (const o of obsValidas || []) {
    if (!TIPOS_CASO_DESCRITO.includes(o?.tipo)) continue;
    const msg = (mensagens || [])[o.msg_idx];
    const t = ms(msg?.timestamp);
    if (t === null || t <= limite) continue;
    if (!escolhida || o.msg_idx > escolhida.msg_idx) escolhida = o;
  }
  return escolhida;
}

// Primeira mensagem do atendimento NOVO: a primeira posterior ao fim da consulta anterior (com folga).
// E o corte da janela — indice ABSOLUTO no array `messages`, porque observacoes.msg_idx e validado
// contra esse mesmo array e reindexar faria toda observacao apontar para a mensagem errada.
function primeiraMensagemApos(mensagens, depoisDe) {
  const limite = ms(depoisDe);
  if (limite === null) return null;
  for (let i = 0; i < (mensagens || []).length; i++) {
    const t = ms(mensagens[i]?.timestamp);
    if (t !== null && t > limite) return i;
  }
  return null;
}

// Veredito unico. `dadosAnteriores` e o last_data do atendimento que ja existe; `dados` e o que a IA
// extraiu nesta rodada.
//
//   novo_atendimento — consulta realizada + caso descrito DEPOIS dela + assunto/area diferentes
//   ambiguo          — consulta realizada + caso descrito depois, mas do mesmo assunto e mesma area
//   mesmo_negocio    — todo o resto (inclusive o caminho comum: nada mudou)
function decidirRetorno({ consulta, mensagens, obsValidas, dadosAnteriores, dados } = {}) {
  const base = { decisao: 'mesmo_negocio', motivo: null, evidencia: null, corteMsgIdx: null, consulta: consulta || null };

  if (!consulta?.realizada) {
    return { ...base, motivo: consulta?.motivo || 'sem_consulta_registrada' };
  }

  const evidencia = evidenciaDeCasoNovo(obsValidas, mensagens, consulta.fimComFolga);
  if (!evidencia) return { ...base, motivo: 'sem_caso_novo_apos_consulta' };

  const corteMsgIdx = primeiraMensagemApos(mensagens, consulta.fimComFolga);
  if (corteMsgIdx === null) return { ...base, motivo: 'sem_mensagem_apos_consulta' };

  const assuntoAnterior = assuntoEspecifico(dadosAnteriores?.assunto);
  const assuntoNovo = assuntoEspecifico(dados?.assunto);
  const areaAnterior = chaveArea(dadosAnteriores?.area_direito);
  const areaNova = chaveArea(dados?.area_direito);

  const assuntoMudou = !!assuntoNovo && assuntoNovo !== assuntoAnterior;
  const areaMudou = !!areaNova && !!areaAnterior && areaNova !== areaAnterior;

  const comum = {
    evidencia,
    corteMsgIdx,
    consulta,
    assuntoAnterior: dadosAnteriores?.assunto || null,
    assuntoNovo: dados?.assunto || null,
  };

  // Assunto novo vago ("Consulta juridica") ou identico ao anterior nao distingue "caso novo" de
  // "cliente completando o caso de sempre" — e o segundo e o caso comum depois de uma consulta.
  if (!assuntoMudou && !areaMudou) {
    return { ...comum, decisao: 'ambiguo', motivo: assuntoNovo ? 'mesmo_assunto_e_area' : 'assunto_novo_indefinido' };
  }

  return { ...comum, decisao: 'novo_atendimento', motivo: areaMudou ? 'area_diferente' : 'assunto_diferente' };
}

// Texto curto e NOMEADO — vai para a nota do negocio e para o Telegram, onde "ambiguo" sozinho nao
// diria a ninguem o que conferir.
const MOTIVOS = {
  sem_consulta_registrada: 'nenhuma consulta registrada para esta conversa',
  consulta_ainda_nao_aconteceu: 'a consulta ainda não aconteceu',
  sem_caso_novo_apos_consulta: 'nenhum caso novo descrito depois da consulta',
  sem_mensagem_apos_consulta: 'nenhuma mensagem posterior à consulta',
  mesmo_assunto_e_area: 'o caso descrito depois da consulta tem o mesmo assunto e a mesma área do anterior',
  assunto_novo_indefinido: 'o caso foi descrito depois da consulta, mas sem assunto específico',
  assunto_diferente: 'assunto diferente do atendimento anterior',
  area_diferente: 'área do direito diferente do atendimento anterior',
};

function descreverMotivo(motivo) {
  return MOTIVOS[motivo] || motivo || 'sem motivo registrado';
}

module.exports = {
  ASSUNTO_NEUTRO,
  FOLGA_HORAS_PADRAO,
  TIPOS_CASO_DESCRITO,
  MOTIVOS,
  paraInstante,
  consultaJaRealizada,
  evidenciaDeCasoNovo,
  primeiraMensagemApos,
  chaveArea,
  assuntoEspecifico,
  decidirRetorno,
  descreverMotivo,
};
