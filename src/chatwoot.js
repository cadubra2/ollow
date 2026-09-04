// Decisao pura da sincronizacao de contatos Moskit -> Chatwoot. Sem rede, sem banco, sem process.env
// lido aqui dentro (o chamador passa o que precisa, como src/atividade-moskit.js recebe o timeZone).
//
// POR QUE ISTO EXISTE: o escritorio atende pelo Chatwoot. Quando o numero do cliente nao esta salvo na
// agenda do WhatsApp, o Chatwoot mostra a ficha so pelo telefone — e pesquisar pelo NOME nao encontra
// o cliente. O nome ja existe do outro lado: o bot o extrai da conversa e grava no Moskit (e no
// espelho local `moskit_contacts`). Este modulo decide, para um contato do Chatwoot, se ha nome para
// escrever, qual, e se escrever e seguro.
//
// A decisao central e de DANO, nao de completude: preencher o nome errado poe o nome de um cliente na
// ficha de conversa de outro, com o historico de mensagens do segundo a vista — dentro da ferramenta
// de atendimento, e ninguem descobre lendo, porque as duas fichas parecem plausiveis. Por isso toda
// funcao aqui prefere devolver "nao sei" a chutar.

const crypto = require('crypto');
const { chaveConversa, mesmoClienteTelefone } = require('./telefone');
const { linkDeal } = require('./moskit-ids');

// ------------------------------------------------------------
// Nome utilizavel
// ------------------------------------------------------------
// Esta lista era DUAS no index.js (as regexes de sanitizacao do nome extraido pela IA e do fallback
// para o nome de perfil do WhatsApp) e as duas ja tinham divergido: so a segunda rejeitava "teste" e
// numero puro. Duas respostas diferentes para "esse nome e placeholder?" dependendo do caminho de
// codigo e exatamente o que src/moskit-ids.js existe para evitar — agora e uma, e o index.js le daqui.
//
// Comparacao sobre o nome normalizado (minuscula, sem acento, espaco colapsado): a regex antiga
// escrevia "nao informado" sem acento e por isso nunca casava "Nao informado" com til, que e a
// grafia natural em portugues.
const NOMES_GENERICOS = new Set([
  'cliente',
  'do cliente',
  'nome do cliente',
  'lead',
  'cliente sem nome',
  'sem nome',
  'n/a',
  'nao informado',
  'nao identificado',
  'null',
  'undefined',
  'teste',
]);

const MIN_CARACTERES_NOME = 3;

// Prefixo do `identifier` do Chatwoot. Um id nu ("4711") pode colidir com o identifier que outra
// integracao ja use na conta; com prefixo o namespace e explicito e a origem fica legivel na tela.
const PREFIXO_IDENTIFIER = 'moskit:';

// Custom attributes do Chatwoot. ATENCAO: chave que nao existe em Settings -> Custom Attributes e
// DESCARTADA em silencio, e o PUT responde sucesso igual — nao ha como detectar pelo status. Os dois
// tem de ser criados na instancia antes, com escopo Contact e exatamente estas chaves.
const CF_CONTATO = 'moskit_contato_id';
const CF_NEGOCIO = 'moskit_negocio_url';

// Classes de nome atual que o bot pode sobrescrever. 'humano' fica de fora: e a precedencia pedida
// pelo escritorio — nunca apagar o que uma pessoa digitou.
const CLASSES_SOBRESCREVIVEIS = new Set(['vazio', 'telefone', 'generico']);

// Para ESCREVER, exigimos DDD comparavel nos dois lados. `mesmoClienteTelefone` casa por sufixo de 8
// quando um dos lados e curto ("nao da pra exigir o que nao foi informado") — correto para LER, mas
// arriscado para escrever: 10 ou mais digitos e o que garante que o DDD entrou na comparacao.
const MIN_DIGITOS_PARA_ESCREVER = 10;

function removerAcentos(texto) {
  // Mesmo range de `removerAcentos` em index.js:837 — escrito escapado de proposito: marca
  // combinante literal no fonte e invisivel no diff e nao sobrevive a um copiar-colar descuidado.
  return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarNome(texto) {
  return removerAcentos(texto).trim().toLowerCase().replace(/\s+/g, ' ');
}

function digitosDe(bruto) {
  return String(bruto ?? '').replace(/\D/g, '');
}

function temLetra(texto) {
  return /\p{L}/u.test(String(texto ?? ''));
}

// Devolve o nome que pode ir para o Chatwoot, ou null.
//
// O `*` na frente e marca de contato criado pelo bot no Moskit (buscarOuCriarContato monta
// `'*' + nome`), e auditar-crm-relatar.js depende desse literal — ele fica no Moskit e nunca vai
// para a tela do atendente. Removido ANTES da lista de genericos, de proposito: assim
// "*Cliente sem nome" vira "Cliente sem nome", bate na lista e sai como null, nunca escrito.
function nomeUtilizavel(bruto) {
  const nome = String(bruto ?? '').trim().replace(/^\*+/, '').trim();
  if (!nome) return null;
  if (nome.length < MIN_CARACTERES_NOME) return null;
  // Sem letra nenhuma nao e nome de pessoa. Substitui o `/^\d+$/` antigo e cobre mais: "+55 (86)
  // 99999-9999" tem parenteses e sinais, escapava do teste de digito puro e viraria "nome".
  if (!temLetra(nome)) return null;
  if (NOMES_GENERICOS.has(normalizarNome(nome))) return null;
  return nome;
}

// O nome do contato no Chatwoot e, na verdade, o proprio numero? E o sintoma que o dono relata.
function nomeEhOTelefone(nome, telefone) {
  const texto = String(nome ?? '').trim();
  if (!texto) return false;
  const digitos = digitosDe(texto);
  if (digitos.length < 8) return false;
  // Sem letra: um punhado de digitos nunca e nome de pessoa. Cobre "5586999999999",
  // "+55 (86) 99999-9999" e "86 9 9999-9999" — os tres formatos que o Chatwoot mostra.
  if (!temLetra(texto)) return true;
  // Com letra, so conta como telefone se o que sobra depois de tirar o numero for generico
  // ("Cliente 558699999999"). "Maria 99999" e nome de pessoa que por acaso tem numero — nao mexer.
  if (!telefone || !mesmoClienteTelefone(digitos, telefone)) return false;
  const semNumero = texto.replace(/[\d\s()+\-.]/g, ' ').trim();
  return !semNumero || NOMES_GENERICOS.has(normalizarNome(semNumero));
}

function classificarNomeChatwoot(nomeAtual, telefone) {
  const texto = String(nomeAtual ?? '').trim();
  if (!texto) return { classe: 'vazio', motivo: 'contato sem nome' };
  if (nomeEhOTelefone(texto, telefone)) return { classe: 'telefone', motivo: 'nome e o proprio numero' };
  if (!nomeUtilizavel(texto)) return { classe: 'generico', motivo: `nome generico ou curto ("${texto}")` };
  return { classe: 'humano', motivo: 'nome preenchido por pessoa' };
}

// ------------------------------------------------------------
// De onde vem o nome
// ------------------------------------------------------------
// Ordem decidida por medicao no conversations.db de producao, nao por gosto: o espelho do Moskit tem
// 0 nomes vazios e 0 nomes que sao telefone em 3.828 linhas, enquanto 91 dos 277 `contact_name` do
// WhatsApp (33%) sao o proprio numero — o proprio sintoma que estamos consertando. Por isso o nome de
// perfil do WhatsApp entra por ULTIMO, e passa pelo mesmo filtro (numero nao vira nome).
function escolherNomeDoCliente({ nomeEspelho, nomeIa, nomeWhatsApp } = {}) {
  const cascata = [
    ['espelho_moskit', nomeEspelho],
    ['extracao_ia', nomeIa],
    ['perfil_whatsapp', nomeWhatsApp],
  ];
  for (const [fonte, bruto] of cascata) {
    const nome = nomeUtilizavel(bruto);
    if (nome) return { nome, fonte };
  }
  return null;
}

// ------------------------------------------------------------
// Casamento por telefone
// ------------------------------------------------------------
function normalizarE164(bruto, { ddi = '55' } = {}) {
  const d = digitosDe(bruto);
  if (d.length < 8) return null;
  if (d.length >= 12) return `+${d}`;             // ja tem DDI (o nosso ou outro) — respeita
  if (d.length === 10 || d.length === 11) return `+${ddi}${d}`;  // DDD + numero
  return null;                                     // 8-9 digitos: sem DDD, nao se inventa DDI
}

// Candidato unico ou nada — o mesmo "ambiguidade nao decide" de buscarOuCriarContato (index.js) e de
// decidirDeal (src/notas-reuniao.js). Dois contatos diferentes com telefone equivalente nao elegem
// vencedor por palpite: aqui o palpite errado poria o nome de um cliente na ficha de outro.
function casarContatoPorTelefone(chaveLocal, candidatos) {
  const chave = chaveConversa(chaveLocal);
  if (!chave) return null;
  const casados = (candidatos || []).filter((c) => c && c.id && mesmoClienteTelefone(c.phone_number, chave));
  const ids = new Set(casados.map((c) => c.id));
  if (ids.size === 0) return null;
  if (ids.size > 1) return { ambiguo: true, ids: [...ids].sort() };
  return casados[0];
}

function casamentoSeguroParaEscrita(a, b) {
  return digitosDe(a).length >= MIN_DIGITOS_PARA_ESCREVER && digitosDe(b).length >= MIN_DIGITOS_PARA_ESCREVER;
}

// ------------------------------------------------------------
// Payload
// ------------------------------------------------------------
// Duas decisoes que cortam dano de graca:
//
// 1) `phone_number` NUNCA vai no payload. Achamos o contato PELO telefone — nao ha o que corrigir
//    nele —, e reescrever um numero normalizado por cima do que o Chatwoot tem pode mexer no que
//    amarra a ficha ao canal do WhatsApp. Nao mandar elimina uma classe inteira de dano silencioso.
//
// 2) `custom_attributes` e MESCLADO, nunca substituido — daí o parametro `atributosAtuais`. Se o PUT
//    do Chatwoot substitui o objeto inteiro (comportamento comum, e NAO medido nesta instancia),
//    mandar so a nossa chave apagaria todo atributo personalizado que o escritorio ja tenha, em toda
//    a base, sem erro nenhum. `sondar-chatwoot.js` mede isso antes de qualquer lote.
//
// `additional_attributes` nao e tocado nunca (guarda dados de canal/origem do proprio Chatwoot).
function montarPayloadContato({ nome, moskitContatoId, dealId, identifierAtual, atributosAtuais } = {}) {
  const payload = {};
  if (nome) payload.name = nome;

  // `identifier` e UNICO por conta. So escrevemos se o campo esta vazio ou ja e nosso: outro valor la
  // e de outra integracao, e sobrescrever a quebra em silencio (o Chatwoot nao avisa nada).
  const atual = String(identifierAtual ?? '').trim();
  if (moskitContatoId && (!atual || atual.startsWith(PREFIXO_IDENTIFIER))) {
    payload.identifier = `${PREFIXO_IDENTIFIER}${moskitContatoId}`;
  }

  const atributos = { ...(atributosAtuais || {}) };
  if (moskitContatoId) atributos[CF_CONTATO] = String(moskitContatoId);
  const link = linkDeal(dealId);
  // Sem deal, o atributo simplesmente nao entra — nunca string vazia nem link quebrado. Hoje so 64
  // das 277 conversas tem deal_id.
  if (link) atributos[CF_NEGOCIO] = link;
  if (Object.keys(atributos).length) payload.custom_attributes = atributos;

  return payload;
}

// Usado no caminho de degradacao quando o `identifier` colide: o nome e o que o dono pediu, o atalho
// e bonus. Melhor um contato pesquisavel sem atalho que um contato invisivel.
function payloadSemIdentifier(payload) {
  const { identifier, ...resto } = payload || {};
  return resto;
}

// Hash estavel do payload: e a memoria de "eu ja escrevi isto". Chaves ordenadas em profundidade,
// senao a mesma escrita geraria hashes diferentes conforme a ordem em que o objeto foi montado e o
// bot faria um PUT por ciclo, para sempre, em 4 mil contatos.
function ordenarProfundo(valor) {
  if (Array.isArray(valor)) return valor.map(ordenarProfundo);
  if (valor && typeof valor === 'object') {
    return Object.keys(valor).sort().reduce((acc, k) => { acc[k] = ordenarProfundo(valor[k]); return acc; }, {});
  }
  return valor;
}

function hashEscrita(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(ordenarProfundo(payload || {}))).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------
// A decisao
// ------------------------------------------------------------
// `chatwoot`: { id, name, phone_number, identifier, custom_attributes } — como esta na ficha agora.
// `local`:    { chave, nome, fonte, moskitContatoId, dealId, nomeEscrito, travadoHumano, escritaHash }
function decidirAtualizacao({ chatwoot, local } = {}) {
  const cw = chatwoot || {};
  const lo = local || {};
  const pular = (motivo, extra = {}) => ({ acao: 'pular', motivo, ...extra });

  if (!cw.id) return pular('sem_contato_chatwoot');

  // Estado terminal: alguem renomeou depois do bot, uma vez. Nunca mais reescreve.
  if (lo.travadoHumano) return pular('travado_humano');

  if (!casamentoSeguroParaEscrita(cw.phone_number, lo.chave)) return pular('telefone_curto');

  const classe = classificarNomeChatwoot(cw.name, lo.chave);

  // AUTORIA, o mesmo desenho de custom_fields_bot/campos_travados no Moskit. Sem esta comparacao, o
  // ciclo seguinte nao distingue "nome humano" de "nome que eu mesmo pus": no 1o ciclo o campo estava
  // vazio e o bot escreveu; se a equipe corrigir depois para o nome de casada, o bot desfaria a
  // correcao. Nome atual == o que gravamos => o campo e nosso e pode ser atualizado.
  const nossoNome = !!lo.nomeEscrito && String(cw.name ?? '').trim() === String(lo.nomeEscrito).trim();

  if (!CLASSES_SOBRESCREVIVEIS.has(classe.classe) && !nossoNome) {
    // Divergiu do que escrevemos => foi pessoa. Trava permanente, e o chamador grava isso.
    if (lo.nomeEscrito) return pular('humano_renomeou', { travarHumano: true });
    return pular('nome_humano');
  }

  if (!lo.nome) return pular('sem_nome_utilizavel');

  const payload = montarPayloadContato({
    nome: lo.nome,
    moskitContatoId: lo.moskitContatoId,
    dealId: lo.dealId,
    identifierAtual: cw.identifier,
    atributosAtuais: cw.custom_attributes,
  });
  const hash = hashEscrita(payload);

  // Nada mudou no Moskit nem no Chatwoot: zero requisicao de escrita neste ciclo.
  if (lo.escritaHash && lo.escritaHash === hash) return pular('sem_mudanca', { hash });

  return {
    acao: 'escrever',
    motivo: nossoNome ? 'atualizando o nome que o bot escreveu' : classe.motivo,
    classeAnterior: classe.classe,
    payload,
    hash,
  };
}

// ------------------------------------------------------------
// Leitura da resposta do PUT
// ------------------------------------------------------------
// Existe como funcao nomeada por um motivo especifico: o PUT /contacts/{id} do Chatwoot documenta
// **204** como sucesso. Todo o resto deste repositorio confere `status < 200 || status >= 300`, o que
// aceita 204 — mas codigo novo que testar `=== 200` trata sucesso como FALHA, retenta para sempre e
// nunca grava o estado. Travar isso num teste e a unica forma de o 204 nao voltar a ser esquecido.
function interpretarRespostaPut(status, data) {
  const s = Number(status);
  if (s >= 200 && s < 300) return { ok: true, classe: 'sucesso', avisar: false };

  const texto = JSON.stringify(data ?? '').toLowerCase();
  // Colisao de identifier: duas fichas no Chatwoot para o mesmo cliente. Nao retenta e nao libera o
  // identifier da outra ficha (mutilar um cadastro para consertar outro) — degrada e avisa uma vez.
  if ((s === 400 || s === 409 || s === 422) && texto.includes('identifier')) {
    return { ok: false, classe: 'colisao_identifier', avisar: true };
  }
  // Global, nao por contato: token errado ou sem permissao. Insistir em 4 mil contatos sao 4 mil 403.
  if (s === 401 || s === 403) return { ok: false, classe: 'proibido', avisar: true };
  if (s === 404) return { ok: false, classe: 'ausente', avisar: false };
  // Rate limit nao e "conferir na mao" — e o Chatwoot pedindo calma. Silencioso, com backoff.
  if (s === 429) return { ok: false, classe: 'limite', avisar: false };
  if (s === 400 || s === 422) return { ok: false, classe: 'recusado', avisar: true };
  return { ok: false, classe: 'transitorio', avisar: false };
}

module.exports = {
  NOMES_GENERICOS,
  CLASSES_SOBRESCREVIVEIS,
  PREFIXO_IDENTIFIER,
  CF_CONTATO,
  CF_NEGOCIO,
  MIN_CARACTERES_NOME,
  MIN_DIGITOS_PARA_ESCREVER,
  normalizarNome,
  digitosDe,
  nomeUtilizavel,
  nomeEhOTelefone,
  classificarNomeChatwoot,
  escolherNomeDoCliente,
  normalizarE164,
  casarContatoPorTelefone,
  casamentoSeguroParaEscrita,
  montarPayloadContato,
  payloadSemIdentifier,
  hashEscrita,
  decidirAtualizacao,
  interpretarRespostaPut,
};
