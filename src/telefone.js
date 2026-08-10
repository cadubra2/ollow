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
  ehInterno,
  carregarInternos,
  TEAM_SUFIXOS,
  MIN_DIGITOS,
  MAX_DIGITOS,
  SUFIXO_COMPARACAO,
};
