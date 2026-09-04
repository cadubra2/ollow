// Definicao unica de "qual e a chave desta conversa".
//
// O chat_id vinha de tres lugares diferentes, cada um com seu formato:
//   webhook incoming -> msg.sender.id
//   webhook outgoing -> body.conversation.participantId
//   polling          -> conv.participantId
// e o telefone era normalizado com `.replace(/\D/g,'').slice(-13)` copiado em quatro pontos.
// Formatos divergentes geravam LINHAS SEPARADAS em `conversations` para o mesmo cliente — dois
// historicos parciais, cada um com sua propria extracao e seu proprio deal.

// Menos de 8 digitos nao identifica um telefone com seguranca (mesma guarda que
// buscarOuCriarContato ja usava para evitar match por substring).
const MIN_DIGITOS = 8;
const MAX_DIGITOS = 13;

function chaveConversa(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  if (digitos.length < MIN_DIGITOS) return null;
  return digitos.slice(-MAX_DIGITOS);
}

// Duas chaves apontam para o mesmo cliente? Compara pelos ultimos 8 digitos, que sobrevivem a
// diferencas de DDI/nono digito entre as fontes.
function mesmoTelefone(a, b) {
  const ca = chaveConversa(a);
  const cb = chaveConversa(b);
  if (!ca || !cb) return false;
  return ca.slice(-8) === cb.slice(-8);
}

// Tira o DDI 55 quando ele esta presente, para sobrar "DDD + numero". Numero brasileiro completo tem
// 10 (fixo/celular antigo) ou 11 (celular com o nono digito) digitos depois do DDI; com o 55 na
// frente vira 12 ou 13. Abaixo disso nao da pra afirmar que os dois primeiros digitos sao DDD.
function semDdi(digitos) {
  if (digitos.length >= 12 && digitos.startsWith('55')) return digitos.slice(2);
  return digitos;
}

// A comparacao usada para decidir se dois cadastros sao a MESMA PESSOA — mais rigorosa que
// mesmoTelefone, porque o custo do erro e diferente.
//
// MEDIDO em 04/09/2026 na base real (4.178 contatos com telefone): 126 sufixos de 8 digitos sao
// compartilhados por mais de um contato. 104 sao a mesma pessoa cadastrada duas vezes — o caso que
// queremos unificar — mas 22 sao pessoas DIFERENTES, e o exemplo que fecha a questao e
// "Pedro Amorim (55 99 84452303)" x "Lilian Naves (55 34 84452303)": DDDs diferentes, estados
// diferentes, mesmos 8 digitos finais. Casar esses dois poria o negocio de um cliente sob a ficha de
// outro — vazamento de dado entre clientes, e do tipo que ninguem descobre lendo, porque os dois
// registros parecem plausiveis.
//
// Achado pela simulacao de 10 leads no funil de teste (simular-10-leads-funil-teste.js), que ligou o
// deal do cenario 8 ao contato ERRADO justamente por essa colisao. `mesmoTelefone` continua como
// esta para o uso original (lista da equipe em ehInterno, ~12 numeros, onde colisao e improvavel e o
// custo e outro); o casamento de CONTATO passa a exigir tambem o DDD quando os dois lados o tem.
function mesmoClienteTelefone(a, b) {
  const ca = chaveConversa(a);
  const cb = chaveConversa(b);
  if (!ca || !cb) return false;
  if (ca.slice(-8) !== cb.slice(-8)) return false;

  const na = semDdi(ca);
  const nb = semDdi(cb);
  // So exige DDD igual quando os DOIS lados tem DDD para comparar (>= 10 digitos). Numero curto
  // (gravado sem DDD) continua casando pelo sufixo — nao da pra exigir o que nao foi informado.
  if (na.length >= 10 && nb.length >= 10) return na.slice(0, 2) === nb.slice(0, 2);
  return true;
}

// ------------------------------------------------------------
// Numeros internos (equipe/socios) — nunca viram lead
// ------------------------------------------------------------
// Antes esta lista era um Set de 5 strings fixas no index.js, comparado com `.has(telefone)` — ou
// seja, igualdade EXATA. Duas consequencias:
//   1) a lista real da equipe tem 12 numeros; 7 estavam de fora e eram tratados como lead. Um deles
//      (Alice Pimentel) chegou a virar o deal 48222403 no CRM.
//   2) igualdade exata nao tolera variacao de nono digito, DDI ou formatacao — o mesmo interno com
//      o numero escrito de outro jeito furava o bloqueio.
// Agora vem do .env e a comparacao e por sufixo de 8 digitos.
const SUFIXO_COMPARACAO = 8;

function carregarInternos(bruto) {
  return new Set(
    String(bruto || '')
      .split(/[,;\s]+/)
      .map((n) => chaveConversa(n))
      .filter(Boolean)
      .map((c) => c.slice(-SUFIXO_COMPARACAO))
  );
}

const TEAM_SUFIXOS = carregarInternos(process.env.TEAM_PHONES);

function ehInterno(bruto) {
  const c = chaveConversa(bruto);
  return !!c && TEAM_SUFIXOS.has(c.slice(-SUFIXO_COMPARACAO));
}

module.exports = {
  chaveConversa,
  mesmoTelefone,
  mesmoClienteTelefone,
  ehInterno,
  carregarInternos,
  TEAM_SUFIXOS,
  MIN_DIGITOS,
  MAX_DIGITOS,
  SUFIXO_COMPARACAO,
};
