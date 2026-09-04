// Briefing pre-consulta do advogado: o texto da nota que o bot posta no deal do Moskit.
//
// Duas partes com responsabilidades diferentes:
//   - CABECALHO: montado em CODIGO a partir dos dados ja validados (nome, area, advogado,
//     modalidade, horario, valor). Deterministico — nao depende do modelo escrever certo.
//   - NARRATIVA: o resumo_atendimento que a IA produz (secoes Caso/Objetivo/Urgencia/Ja tentou/
//     Pendencias/Documentos, ver o PROMPT_EXTRAIR em index.js). E a parte que precisa de
//     interpretacao, entao fica com o modelo.
//
// O marcador [ollow-briefing] no fim identifica a nota como briefing no historico do deal — e o que
// permite contar versoes, auditar e (se um dia precisar) achar a nota pra reescrever em lugar de
// repostar. Mesmo padrao do [ollow-notas:xxxxxxxx] da rotina de notas de reuniao.

const crypto = require('crypto');

const MARCADOR_BRIEFING = '[ollow-briefing]';

function limparTelefone(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  return digitos.length >= 8 ? digitos : null;
}

// Rotulo legivel de cada campo obrigatorio (CAMPOS_OBRIGATORIOS em index.js). O advogado le a nota,
// nao o schema: "advogado_responsavel" numa nota de CRM e vazamento de nome de coluna.
const ROTULO_CAMPO = {
  assunto: 'assunto',
  origem: 'origem do contato',
  tipo_consulta: 'tipo de consulta',
  area_direito: 'área do direito',
  advogado_responsavel: 'advogado responsável',
};

// O cabecalho omite linhas sem informacao de proposito: campo que o modelo ainda nao extraiu nao
// ganha clareza com "Nao informado" repetido. Linha so entra quando ha valor real — e o que falta
// aparece UMA vez, na linha de pendencia abaixo, em vez de seis vezes na narrativa.
//
// `pendentes` e a lista de campos obrigatorios ainda vazios (camposPendentes, index.js). Ela entra
// aqui, no cabecalho DETERMINISTICO, e nao na narrativa: o que falta e fato do sistema, apurado em
// codigo — pedir ao modelo que declare a propria lacuna seria pedir interpretacao de uma coisa que
// nao precisa dela. Antes desta linha existir, o briefing simplesmente NAO ERA POSTADO quando havia
// pendencia (ver o portao no ramo atualizar_campos): resumo pago, escrito e descartado em silencio.
//
// `rotuloConsulta` e o vocabulario da reuniao de retorno (ver src/reuniao-retorno.js,
// rotuloCompromisso): "Consulta" na 1a reuniao do caso, "Retorno N" da 2a em diante — e a linha que
// amarra os dois lados (a agenda diz "Retorno 1", o briefing tambem). Default "Consulta" preserva o
// comportamento de antes desta funcionalidade existir.
function montarCabecalho({ dados, contato, telefone, horarioConsulta, rotuloConsulta, pendentes }) {
  const d = dados || {};
  const linhas = [];
  const nome = contato || d.nome;
  if (nome) linhas.push(`Cliente: ${nome}`);
  const tel = limparTelefone(telefone);
  if (tel) linhas.push(`Telefone: ${tel}`);
  if (d.area_direito) linhas.push(`Área: ${d.area_direito}`);
  if (d.advogado_responsavel) linhas.push(`Advogado: ${d.advogado_responsavel}`);
  if (d.modalidade_consulta) linhas.push(`Modalidade: ${d.modalidade_consulta}`);
  if (horarioConsulta) linhas.push(`${rotuloConsulta || 'Consulta'}: ${horarioConsulta}`);
  const valor = d.valor_honorarios_inicial || d.valor_mensalidade;
  if (valor) linhas.push(`Valor: ${valor}`);
  const faltando = (Array.isArray(pendentes) ? pendentes : [])
    .map((c) => ROTULO_CAMPO[c] || c)
    .filter(Boolean);
  if (faltando.length) linhas.push(`⚠️ Ainda não confirmado: ${faltando.join(', ')}`);
  return linhas.join('\n');
}

function montarTextoBriefing({ dados, contato, telefone, horarioConsulta, rotuloConsulta, pendentes }) {
  const partes = [];
  const cabecalho = montarCabecalho({ dados, contato, telefone, horarioConsulta, rotuloConsulta, pendentes });
  if (cabecalho) partes.push(cabecalho);
  const narrativa = String((dados && dados.resumo_atendimento) || '').trim();
  if (narrativa) partes.push(narrativa);
  return partes.join('\n\n');
}

// Hash para dedup: sobre o TEXTO (cabecalho + narrativa), normalizando espaco e quebra de linha.
// Titulo, versao e data ficam de fora de proposito — senao toda postagem mudaria o hash mesmo com
// conteudo identico, e a nota seria repostada a cada ciclo.
function hashTextoBriefing(texto) {
  return crypto.createHash('sha1').update(String(texto).replace(/\s+/g, ' ').trim()).digest('hex');
}

module.exports = {
  MARCADOR_BRIEFING, ROTULO_CAMPO, montarTextoBriefing, montarCabecalho, hashTextoBriefing, limparTelefone,
};
