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

// O cabecalho omite linhas sem informacao de proposito: campo que o modelo ainda nao extraiu nao
// ganha clareza com "Nao informado" repetido — a narrativa abaixo e que tem o "Nao mencionado"
// mandado pelo prompt. Linha so entra quando ha valor real.
function montarCabecalho({ dados, contato, telefone, horarioConsulta }) {
  const d = dados || {};
  const linhas = [];
  const nome = contato || d.nome;
  if (nome) linhas.push(`Cliente: ${nome}`);
  const tel = limparTelefone(telefone);
  if (tel) linhas.push(`Telefone: ${tel}`);
  if (d.area_direito) linhas.push(`Área: ${d.area_direito}`);
  if (d.advogado_responsavel) linhas.push(`Advogado: ${d.advogado_responsavel}`);
  if (d.modalidade_consulta) linhas.push(`Modalidade: ${d.modalidade_consulta}`);
  if (horarioConsulta) linhas.push(`Consulta: ${horarioConsulta}`);
  const valor = d.valor_honorarios_inicial || d.valor_mensalidade;
  if (valor) linhas.push(`Valor: ${valor}`);
  return linhas.join('\n');
}

function montarTextoBriefing({ dados, contato, telefone, horarioConsulta }) {
  const partes = [];
  const cabecalho = montarCabecalho({ dados, contato, telefone, horarioConsulta });
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

module.exports = { MARCADOR_BRIEFING, montarTextoBriefing, montarCabecalho, hashTextoBriefing, limparTelefone };
