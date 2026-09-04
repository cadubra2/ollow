// Testes PUROS da decisao do monitor de saude Evolution API -> Chatwoot. Rodar com:
//   node test-evolution.js
//
// Nao chamam rede nem banco. O que esta em jogo: nunca mais ficar mudo quando a integracao WhatsApp
// -> Chatwoot quebrar (o incidente de 04/09/2026, 58 min sem aviso). Metade das assercoes e sobre o
// texto do alerta nunca vazar credencial — e a mesma classe de erro que causou o incidente original.

const {
  avaliarSaudeEvolution,
  hashSaude,
  montarTextoAlertaEvolution,
  formatarDuracao,
  formatarHorarioBr,
  montarRelatorioMensagensPerdidas,
  RELATORIO_MAX_CONTATOS,
  pareceConterSegredo,
  ORDEM_MOTIVOS,
} = require('./src/evolution');

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
function igual(nome, obtido, esperado) {
  checar(nome, obtido === esperado, obtido);
}

// ------------------------------------------------------------
console.log('\n1) avaliarSaudeEvolution — o ciclo saudavel');
{
  const v = avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'open', chatwootEnabled: true, tokenValido: true });
  igual('tudo certo => ok', v.ok, true);
  igual('sem motivo', v.motivo, null);
}

// ------------------------------------------------------------
console.log('\n2) cada motivo isolado');
{
  igual('evolution inacessivel', avaliarSaudeEvolution({ erroRede: 'timeout' }).motivo, 'evolution_inacessivel');
  igual('instancia sumiu', avaliarSaudeEvolution({ instanciaEncontrada: false }).motivo, 'instancia_nao_encontrada');
  igual('sessao fechada', avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'close' }).motivo, 'sessao_fechada');
  igual('sessao conectando (nao e open) tambem conta', avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'connecting' }).motivo, 'sessao_fechada');
  igual('integracao desabilitada', avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'open', chatwootEnabled: false }).motivo, 'integracao_desabilitada');
  igual('token invalido — o causador do incidente de 04/09', avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'open', chatwootEnabled: true, tokenValido: false }).motivo, 'token_invalido');
}

// ------------------------------------------------------------
console.log('\n3) prioridade entre motivos simultaneos (early-exit)');
{
  // Se a Evolution esta inacessivel, os outros sinais nem foram medidos — nao da pra confiar neles.
  igual('erroRede vence mesmo com outros campos preenchidos',
    avaliarSaudeEvolution({ erroRede: 'ECONNREFUSED', instanciaEncontrada: true, connectionStatus: 'open', tokenValido: false }).motivo,
    'evolution_inacessivel');
  igual('instancia sumida vence sobre sessao/token',
    avaliarSaudeEvolution({ instanciaEncontrada: false, connectionStatus: 'open', tokenValido: false }).motivo,
    'instancia_nao_encontrada');
  igual('sessao fechada vence sobre integracao/token',
    avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'close', chatwootEnabled: false, tokenValido: false }).motivo,
    'sessao_fechada');
  igual('integracao desabilitada vence sobre token',
    avaliarSaudeEvolution({ instanciaEncontrada: true, connectionStatus: 'open', chatwootEnabled: false, tokenValido: false }).motivo,
    'integracao_desabilitada');
  // A ordem declarada bate com a ordem realmente aplicada (documenta a intencao, nao so o comportamento).
  igual('ORDEM_MOTIVOS comeca no mais "de baixo nivel"', ORDEM_MOTIVOS[0], 'evolution_inacessivel');
  igual('e termina no mais especifico', ORDEM_MOTIVOS[ORDEM_MOTIVOS.length - 1], 'token_invalido');
}

// ------------------------------------------------------------
console.log('\n4) hashSaude — a chave de dedup');
{
  igual('ok vira "ok"', hashSaude({ ok: true }), 'ok');
  igual('falha vira "falha:<motivo>"', hashSaude({ ok: false, motivo: 'token_invalido' }), 'falha:token_invalido');
  checar('motivos diferentes => hash diferente',
    hashSaude({ ok: false, motivo: 'token_invalido' }) !== hashSaude({ ok: false, motivo: 'sessao_fechada' }));
}

// ------------------------------------------------------------
console.log('\n5) montarTextoAlertaEvolution — sempre acionavel, nunca com segredo');
{
  const TOKEN_FALSO = 'ExemploDeTokenFalso123451234567890'; // formato de token real, NUNCA deve passar por aqui

  for (const motivo of ['token_invalido', 'sessao_fechada', 'integracao_desabilitada', 'instancia_nao_encontrada', 'evolution_inacessivel']) {
    const texto = montarTextoAlertaEvolution({ hash: `falha:${motivo}`, motivo, detalhe: motivo === 'sessao_fechada' ? 'close' : (motivo === 'evolution_inacessivel' ? 'ECONNREFUSED' : null), instancia: 'escritorio' });
    checar(`"${motivo}": tem cabecalho`, texto.length > 20, texto);
    checar(`"${motivo}": aponta pro sondar-evolution.js`, texto.includes('sondar-evolution.js'), texto);
    checar(`"${motivo}": nunca contem o token de teste`, !texto.includes(TOKEN_FALSO));
    checar(`"${motivo}": nao "parece" ter segredo vazado`, !pareceConterSegredo(texto), texto);
  }

  const okTexto = montarTextoAlertaEvolution({ hash: 'ok', instancia: 'escritorio', mudouEm: Date.now() - 58 * 60 * 1000 });
  checar('recuperacao: confirma que voltou', /voltou ao normal/i.test(okTexto), okTexto);
  checar('recuperacao: mostra a duracao aproximada', /58 min|59 min|57 min|1h/.test(okTexto), okTexto);
  checar('recuperacao: NUNCA sugere recuperar mensagens perdidas (decisao fechada)', !/recuperar.*mensage/i.test(okTexto), okTexto);

  // Sem mudouEm (primeira execucao nunca deveria chamar isto, mas a funcao tem que degradar bem)
  const okSemDuracao = montarTextoAlertaEvolution({ hash: 'ok', instancia: 'escritorio' });
  checar('recuperacao sem duracao conhecida nao quebra', /voltou ao normal/i.test(okSemDuracao), okSemDuracao);
}

// ------------------------------------------------------------
console.log('\n6) formatarDuracao');
{
  const agora = Date.now();
  igual('minutos', formatarDuracao(agora - 5 * 60000, agora), '5 min');
  igual('horas exatas', formatarDuracao(agora - 120 * 60000, agora), '2h');
  igual('horas e minutos', formatarDuracao(agora - 125 * 60000, agora), '2h5min');
  igual('zero nao vira negativo', formatarDuracao(agora + 5000, agora), '0 min');
}

// ------------------------------------------------------------
console.log('\n7) pareceConterSegredo — a heuristica do teste 5');
{
  checar('texto normal nao acusa nada', !pareceConterSegredo('Bom dia, tudo bem? Vamos seguir com o contrato.'));
  checar('token de 24+ chars fora de crase acusa', pareceConterSegredo('o token e ExemploDeTokenFalso12345 agora'));
  checar('a MESMA sequencia dentro de crase (comando/path) nao acusa', !pareceConterSegredo('rode `node sondar-evolution.js --com-um-parametro-bem-comprido-assim`'));
}

// ------------------------------------------------------------
console.log('\n8) formatarHorarioBr');
{
  // 2026-09-04T12:00:00Z em America/Fortaleza (UTC-3, sem horario de verao desde 2019) = 09:00.
  igual('UTC -> hora do escritorio', formatarHorarioBr(Date.parse('2026-09-04T12:00:00Z'), 'America/Fortaleza'), '09:00');
}

// ------------------------------------------------------------
console.log('\n9) montarRelatorioMensagensPerdidas — o relatorio pedido pelo dono em 04/09/2026');
{
  const TZ = 'America/Fortaleza';
  const t = (hhmm) => Date.parse(`2026-09-04T${hhmm}:00Z`); // ja em UTC, -3h vira hora do escritorio

  igual('sem contato nenhum na janela => null (nao manda relatorio vazio)',
    montarRelatorioMensagensPerdidas({ contatos: [], desde: t('12:00'), ate: t('13:00'), timeZone: TZ }), null);
  igual('contato sem horario nenhum tambem conta como vazio',
    montarRelatorioMensagensPerdidas({ contatos: [{ remoteJid: 'x', pushName: 'Fulano', horarios: [] }], desde: t('12:00'), ate: t('13:00'), timeZone: TZ }), null);

  const contatos = [
    { remoteJid: '558699999999@s.whatsapp.net', pushName: 'Maria', telefone: '+558699999999', horarios: [t('12:31'), t('12:45')] },
    { remoteJid: '999@lid', pushName: '🌻', telefone: null, horarios: [t('12:20')] },
  ];
  const texto = montarRelatorioMensagensPerdidas({ contatos, desde: t('12:00'), ate: t('13:00'), timeZone: TZ });
  checar('cabecalho com a janela em hora do escritorio', texto.includes('09:00') && texto.includes('10:00'), texto);
  checar('conta clientes e mensagens', texto.includes('2 cliente(s), 3 mensagem(ns)'), texto);
  checar('telefone confirmado aparece com o marcador de telefone', /📱 \+558699999999 — Maria/.test(texto), texto);
  checar('horarios do mesmo contato, em ordem, separados por virgula', /09:31, 09:45/.test(texto), texto);
  checar('sem telefone confirmado usa o outro marcador e avisa', /❓ 🌻 — telefone não confirmado/.test(texto), texto);
  checar('ORDENADO pelo horario mais cedo — o do 09:20 vem antes do 09:31', texto.indexOf('🌻') < texto.indexOf('Maria'), texto);
  checar('NUNCA contem o conteudo de uma mensagem — so numero/nome/horario (pedido literal do dono)',
    !/conteudo|mensagem:|"/.test(texto.toLowerCase().replace(/mensagem\(ns\)/g, '')), texto);

  // teto de contatos — o resto vira "e mais N"
  const muitos = Array.from({ length: RELATORIO_MAX_CONTATOS + 5 }, (_, i) => ({
    remoteJid: `c${i}`, pushName: `Cliente ${i}`, telefone: null, horarios: [t('12:00') + i * 1000],
  }));
  const textoMuitos = montarRelatorioMensagensPerdidas({ contatos: muitos, desde: t('12:00'), ate: t('13:00'), timeZone: TZ });
  igual('teto de contatos respeitado', (textoMuitos.match(/❓/g) || []).length, RELATORIO_MAX_CONTATOS);
  checar('e diz quantos ficaram de fora', textoMuitos.includes('e mais 5 cliente(s)'), textoMuitos);
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
