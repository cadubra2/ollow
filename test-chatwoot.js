// Testes PUROS da decisao de preencher o nome do contato no Chatwoot. Rodar com:
//   node test-chatwoot.js
//
// Nao chamam OpenAI, Moskit, Chatwoot nem banco. O custo do erro aqui e assimetrico e e por isso que
// boa parte das assercoes abaixo e sobre NAO escrever: deixar de preencher um nome mantem o status quo
// (o atendente continua pesquisando pelo numero), enquanto preencher o nome ERRADO poe o nome de um
// cliente na ficha de conversa de outro — com o historico de mensagens do segundo a vista, dentro da
// ferramenta de atendimento, e sem que ninguem descubra lendo.

const {
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
  CF_CONTATO,
  CF_NEGOCIO,
} = require('./src/chatwoot');

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
function igual(nome, obtido, esperado) {
  checar(nome, JSON.stringify(obtido) === JSON.stringify(esperado), obtido);
}

// ------------------------------------------------------------
console.log('\n1) interpretarRespostaPut — 204 e SUCESSO');
// A regressao mais provavel desta feature. O PUT /contacts/{id} do Chatwoot documenta 204; codigo que
// testar `=== 200` trata sucesso como falha, retenta para sempre e nunca grava o estado.
{
  igual('204 e sucesso', interpretarRespostaPut(204, '').classe, 'sucesso');
  checar('204 tem ok=true', interpretarRespostaPut(204, '').ok === true);
  igual('200 com corpo tambem e sucesso', interpretarRespostaPut(200, { id: 7 }).classe, 'sucesso');
  igual('201 tambem', interpretarRespostaPut(201, '').classe, 'sucesso');
  checar('sucesso nao avisa ninguem', interpretarRespostaPut(204, '').avisar === false);

  igual('422 citando identifier e colisao',
    interpretarRespostaPut(422, { message: 'Identifier has already been taken' }).classe, 'colisao_identifier');
  checar('colisao avisa', interpretarRespostaPut(422, { message: 'identifier taken' }).avisar === true);
  igual('422 sem identifier e recusa comum',
    interpretarRespostaPut(422, { message: 'Name is invalid' }).classe, 'recusado');

  igual('403 e proibido', interpretarRespostaPut(403, '').classe, 'proibido');
  igual('401 tambem e proibido', interpretarRespostaPut(401, '').classe, 'proibido');
  igual('404 e ausente', interpretarRespostaPut(404, '').classe, 'ausente');
  igual('429 e limite', interpretarRespostaPut(429, '').classe, 'limite');
  // 429 e o Chatwoot pedindo calma, nao "conferir na mao" — silencioso, com backoff.
  checar('429 NAO avisa', interpretarRespostaPut(429, '').avisar === false);
  igual('500 e transitorio', interpretarRespostaPut(500, '').classe, 'transitorio');
  checar('transitorio NAO avisa', interpretarRespostaPut(503, '').avisar === false);
}

// ------------------------------------------------------------
console.log('\n2) nomeUtilizavel — o "*" e os genericos');
{
  igual('tira o * do contato criado pelo bot', nomeUtilizavel('*Maria Fatima'), 'Maria Fatima');
  // O * sai ANTES da lista de genericos: e o que faz o placeholder do bot nunca chegar ao Chatwoot.
  igual('*Cliente sem nome NUNCA e escrito', nomeUtilizavel('*Cliente sem nome'), null);
  igual('Cliente sem nome tambem nao', nomeUtilizavel('Cliente sem nome'), null);
  igual('generico simples', nomeUtilizavel('Cliente'), null);
  igual('generico com caixa diferente', nomeUtilizavel('LEAD'), null);
  igual('generico com acento (a regex antiga nao pegava)', nomeUtilizavel('Não informado'), null);
  igual('teste', nomeUtilizavel('teste'), null);
  igual('vazio', nomeUtilizavel(''), null);
  igual('so espaco', nomeUtilizavel('   '), null);
  igual('null', nomeUtilizavel(null), null);
  igual('curto demais', nomeUtilizavel('Ab'), null);
  igual('digito puro nao e nome', nomeUtilizavel('5586999999999'), null);
  igual('numero mascarado tambem nao', nomeUtilizavel('+55 (86) 99999-9999'), null);
  // Controle: nome de pessoa de verdade tem de passar, com acento e tudo.
  igual('nome de pessoa passa', nomeUtilizavel('  Maria de Fátima  '), 'Maria de Fátima');
  igual('nome curto mas valido passa', nomeUtilizavel('Ana'), 'Ana');
}

// ------------------------------------------------------------
console.log('\n3) classificarNomeChatwoot — quem pode ser sobrescrito');
{
  const tel = '558699999999';
  igual('vazio', classificarNomeChatwoot('', tel).classe, 'vazio');
  igual('so espaco e vazio', classificarNomeChatwoot('   ', tel).classe, 'vazio');
  igual('nome e o proprio numero', classificarNomeChatwoot('558699999999', tel).classe, 'telefone');
  igual('numero mascarado', classificarNomeChatwoot('+55 (86) 99999-9999', tel).classe, 'telefone');
  igual('numero local sem DDI', classificarNomeChatwoot('86 9 9999-9999', tel).classe, 'telefone');
  igual('generico', classificarNomeChatwoot('Cliente', tel).classe, 'generico');
  igual('curto', classificarNomeChatwoot('Ab', tel).classe, 'generico');
  // "Cliente 558699999999": o que sobra depois de tirar o numero e generico -> ainda e telefone.
  igual('generico + numero', classificarNomeChatwoot('Cliente 558699999999', tel).classe, 'telefone');

  // CONTROLES — o que nunca pode ser sobrescrito:
  igual('nome de pessoa e humano', classificarNomeChatwoot('Maria de Fátima', tel).classe, 'humano');
  // Pessoa que por acaso tem numero no nome NAO e telefone.
  igual('nome com numero solto e humano', classificarNomeChatwoot('Maria 99', tel).classe, 'humano');
  igual('nome + outro numero e humano', classificarNomeChatwoot('Maria 558611112222', tel).classe, 'humano');

  checar('nomeEhOTelefone falso para nome de pessoa', nomeEhOTelefone('Maria de Fátima', tel) === false);
  checar('nomeEhOTelefone falso para poucos digitos', nomeEhOTelefone('1234', tel) === false);
}

// ------------------------------------------------------------
console.log('\n4) escolherNomeDoCliente — a cascata de fontes');
{
  igual('espelho do Moskit vence',
    escolherNomeDoCliente({ nomeEspelho: '*Rayra Pureza', nomeIa: 'Rayra', nomeWhatsApp: '558699999999' }),
    { nome: 'Rayra Pureza', fonte: 'espelho_moskit' });
  igual('sem espelho, cai na extracao da IA',
    escolherNomeDoCliente({ nomeEspelho: null, nomeIa: 'Rayra Pureza', nomeWhatsApp: '558699999999' }),
    { nome: 'Rayra Pureza', fonte: 'extracao_ia' });
  // Este e o caso medido: 33% dos contact_name de producao sao o proprio numero, e essa fonte e a
  // ultima justamente por isso.
  igual('sem espelho e sem IA, cai no perfil do WhatsApp',
    escolherNomeDoCliente({ nomeWhatsApp: 'Maria de Fátima' }),
    { nome: 'Maria de Fátima', fonte: 'perfil_whatsapp' });
  igual('fonte que e telefone e pulada (nao escreve numero sobre numero)',
    escolherNomeDoCliente({ nomeEspelho: '558699999999', nomeIa: 'Maria' }),
    { nome: 'Maria', fonte: 'extracao_ia' });
  igual('placeholder do espelho e pulado',
    escolherNomeDoCliente({ nomeEspelho: '*Cliente sem nome', nomeIa: 'Maria' }),
    { nome: 'Maria', fonte: 'extracao_ia' });
  igual('nenhuma fonte utilizavel', escolherNomeDoCliente({ nomeEspelho: 'Cliente', nomeWhatsApp: '5586999' }), null);
  igual('nada passado', escolherNomeDoCliente(), null);
}

// ------------------------------------------------------------
console.log('\n5) normalizarE164');
{
  igual('com DDI', normalizarE164('558699999999'), '+558699999999');
  igual('com mascara', normalizarE164('+55 (86) 99999-9999'), '+5586999999999');
  igual('sem DDI, 11 digitos', normalizarE164('86999999999'), '+5586999999999');
  igual('sem DDI, 10 digitos', normalizarE164('8632223333'), '+558632223333');
  // 8-9 digitos e numero sem DDD: inventar DDI produziria um numero de outra pessoa.
  igual('8 digitos nao ganha DDI inventado', normalizarE164('84452303'), null);
  igual('curto demais', normalizarE164('123'), null);
  igual('vazio', normalizarE164(''), null);
}

// ------------------------------------------------------------
console.log('\n6) casamento por telefone — ambiguidade nao decide');
{
  const candidatos = [
    { id: 10, phone_number: '+558699999999' },
    { id: 11, phone_number: '+558688888888' },
  ];
  igual('casa o certo', casarContatoPorTelefone('558699999999', candidatos), { id: 10, phone_number: '+558699999999' });
  igual('mesmo numero sem DDI casa', casarContatoPorTelefone('8699999999', candidatos), { id: 10, phone_number: '+558699999999' });
  igual('ninguem casa', casarContatoPorTelefone('558677777777', candidatos), null);
  igual('chave invalida', casarContatoPorTelefone('123', candidatos), null);

  // O caso do CLAUDE.md: 22 pares na base real compartilham os 8 digitos finais sendo pessoas
  // DIFERENTES. DDD diferente -> NAO casa, senao o nome de um cliente iria para a ficha do outro.
  igual('DDD diferente com mesmo sufixo NAO casa',
    casarContatoPorTelefone('559984452303', [{ id: 20, phone_number: '+553484452303' }]), null);

  // Duas fichas para o mesmo telefone: nao elege vencedor.
  const duplicados = [{ id: 30, phone_number: '+558699999999' }, { id: 31, phone_number: '8699999999' }];
  const amb = casarContatoPorTelefone('558699999999', duplicados);
  checar('duas fichas equivalentes => ambiguo', amb && amb.ambiguo === true, amb);
  igual('ambiguo lista os dois ids', amb.ids, [30, 31]);
  checar('ambiguo nao devolve id escolhido', amb.id === undefined);

  checar('escrita exige DDD nos dois lados', casamentoSeguroParaEscrita('558699999999', '8699999999') === true);
  checar('numero curto nao autoriza escrita', casamentoSeguroParaEscrita('84452303', '558684452303') === false);
}

// ------------------------------------------------------------
console.log('\n7) montarPayloadContato');
{
  const p = montarPayloadContato({ nome: 'Maria', moskitContatoId: 4711, dealId: 48407608 });
  igual('nome vai', p.name, 'Maria');
  igual('identifier com prefixo', p.identifier, 'moskit:4711');
  igual('id do contato no custom attribute', p.custom_attributes[CF_CONTATO], '4711');
  checar('link do negocio montado pela fonte unica', /\/\?\/deal\/48407608$/.test(p.custom_attributes[CF_NEGOCIO]), p.custom_attributes[CF_NEGOCIO]);

  // phone_number NUNCA vai: achamos o contato PELO telefone, e reescrever pode mexer no que amarra a
  // ficha ao canal do WhatsApp.
  checar('phone_number ausente do payload', !('phone_number' in p), Object.keys(p));
  checar('additional_attributes nunca e tocado', !('additional_attributes' in p), Object.keys(p));

  // Sem deal nao entra link nenhum — nunca string vazia nem link quebrado.
  const semDeal = montarPayloadContato({ nome: 'Maria', moskitContatoId: 4711, dealId: null });
  checar('sem deal, sem link', !(CF_NEGOCIO in semDeal.custom_attributes), semDeal.custom_attributes);

  // identifier de OUTRA integracao nao e sobrescrito: quebraria a integracao alheia em silencio.
  const alheio = montarPayloadContato({ nome: 'Maria', moskitContatoId: 4711, identifierAtual: 'crm-antigo-99' });
  checar('identifier de terceiro preservado', !('identifier' in alheio), alheio);
  igual('mas o nome ainda vai', alheio.name, 'Maria');
  const nosso = montarPayloadContato({ nome: 'Maria', moskitContatoId: 4711, identifierAtual: 'moskit:4711' });
  igual('identifier nosso pode ser reescrito', nosso.identifier, 'moskit:4711');

  // custom_attributes MESCLADO: se o PUT substituir o objeto, mandar so a nossa chave apagaria todo
  // atributo que o escritorio ja tenha, em toda a base, sem erro nenhum.
  const mesclado = montarPayloadContato({
    nome: 'Maria', moskitContatoId: 4711,
    atributosAtuais: { plano: 'ouro', cidade: 'Teresina' },
  });
  igual('atributo alheio preservado', mesclado.custom_attributes.plano, 'ouro');
  igual('segundo atributo alheio preservado', mesclado.custom_attributes.cidade, 'Teresina');
  igual('e o nosso somado', mesclado.custom_attributes[CF_CONTATO], '4711');

  igual('payloadSemIdentifier tira so o identifier', Object.keys(payloadSemIdentifier(p)).sort(), ['custom_attributes', 'name']);
}

// ------------------------------------------------------------
console.log('\n8) hashEscrita — estavel');
{
  const a = { name: 'Maria', custom_attributes: { x: '1', y: '2' } };
  const b = { custom_attributes: { y: '2', x: '1' }, name: 'Maria' };
  igual('ordem das chaves e irrelevante', hashEscrita(a), hashEscrita(b));
  checar('payload diferente => hash diferente', hashEscrita(a) !== hashEscrita({ name: 'Maria Jose' }));
  checar('hash e curto e estavel', /^[0-9a-f]{12}$/.test(hashEscrita(a)), hashEscrita(a));
}

// ------------------------------------------------------------
console.log('\n9) decidirAtualizacao');
{
  const chave = '558699999999';
  const cwVazio = { id: 10, name: '', phone_number: '+558699999999' };
  const local = { chave, nome: 'Maria de Fátima', moskitContatoId: 4711, dealId: 48407608 };

  const d = decidirAtualizacao({ chatwoot: cwVazio, local });
  igual('nome vazio => escreve', d.acao, 'escrever');
  igual('classe anterior registrada', d.classeAnterior, 'vazio');
  igual('payload carrega o nome', d.payload.name, 'Maria de Fátima');

  igual('nome que e o telefone => escreve',
    decidirAtualizacao({ chatwoot: { ...cwVazio, name: '558699999999' }, local }).acao, 'escrever');
  igual('nome generico => escreve',
    decidirAtualizacao({ chatwoot: { ...cwVazio, name: 'Cliente' }, local }).acao, 'escrever');

  // PRECEDENCIA: nunca apaga o que uma pessoa digitou.
  const humano = decidirAtualizacao({ chatwoot: { ...cwVazio, name: 'Maria Aparecida' }, local });
  igual('nome humano => pula', humano.acao, 'pular');
  igual('motivo do pulo', humano.motivo, 'nome_humano');
  checar('nome humano nao trava (ninguem sabe se foi o bot)', !humano.travarHumano);

  // AUTORIA: o nome atual e o que NOS escrevemos => o campo e nosso, pode atualizar.
  const nosso = decidirAtualizacao({
    chatwoot: { ...cwVazio, name: 'Maria Fatima' },
    local: { ...local, nomeEscrito: 'Maria Fatima', nome: 'Maria de Fátima' },
  });
  igual('nome que o bot escreveu pode ser atualizado', nosso.acao, 'escrever');

  // AUTORIA: divergiu do que escrevemos => foi pessoa. Trava permanente.
  const renomeado = decidirAtualizacao({
    chatwoot: { ...cwVazio, name: 'Maria Aparecida Souza' },
    local: { ...local, nomeEscrito: 'Maria Fatima' },
  });
  igual('humano renomeou => pula', renomeado.acao, 'pular');
  igual('e o motivo diz qual foi', renomeado.motivo, 'humano_renomeou');
  checar('e manda travar para sempre', renomeado.travarHumano === true);

  igual('travado => pula sem olhar mais nada',
    decidirAtualizacao({ chatwoot: cwVazio, local: { ...local, travadoHumano: 1 } }).motivo, 'travado_humano');

  // Idempotencia: nada mudou => zero requisicao de escrita.
  const hash = d.hash;
  igual('mesmo hash => pula', decidirAtualizacao({ chatwoot: cwVazio, local: { ...local, escritaHash: hash } }).motivo, 'sem_mudanca');
  checar('hash diferente => volta a escrever',
    decidirAtualizacao({ chatwoot: cwVazio, local: { ...local, escritaHash: 'aaaaaaaaaaaa' } }).acao === 'escrever');

  igual('sem nome utilizavel => pula',
    decidirAtualizacao({ chatwoot: cwVazio, local: { chave, nome: null } }).motivo, 'sem_nome_utilizavel');
  igual('sem contato no Chatwoot => pula',
    decidirAtualizacao({ chatwoot: { name: '' }, local }).motivo, 'sem_contato_chatwoot');
  igual('telefone curto => pula (DDD nao comparavel)',
    decidirAtualizacao({ chatwoot: { id: 10, name: '', phone_number: '84452303' }, local: { ...local, chave: '84452303' } }).motivo, 'telefone_curto');
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
