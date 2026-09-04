// Decisao pura do monitor de saude Evolution API -> Chatwoot. Sem rede, sem banco, sem process.env
// lido aqui dentro (o chamador passa o que precisa, como src/chatwoot.js e src/atividade-moskit.js).
//
// POR QUE ISTO EXISTE: em 04/09/2026, um Access Token pessoal do Chatwoot apareceu exposto numa
// conversa e foi regenerado por seguranca. A Evolution API (o servico que conecta o WhatsApp real ao
// Chatwoot, na mesma VPS do bot) continuou configurada com o token ANTIGO, agora invalido. Por 58
// minutos toda mensagem de WhatsApp deixou de virar conversa no Chatwoot — a equipe via a mensagem no
// WhatsApp normal, mas ela nunca chegava a quem atende pelo Chatwoot. Nenhum alarme disparou; so foi
// descoberto porque o dono notou na mao. Este modulo decide, a partir do que foi medido num ciclo, se
// esta tudo bem e, se nao, qual e o motivo e o texto do aviso — para nunca mais ficar mudo.
//
// GARANTIA DE SEGURANCA que atravessa todo o desenho: o token testado NUNCA aparece no texto do
// alerta nem em qualquer valor que este modulo devolva. E o mesmo tipo de credencial que ja vazou
// uma vez — repetir isso aqui seria o oposto do que a funcionalidade existe para evitar.

// Ordem de prioridade quando mais de uma coisa esta errada ao mesmo tempo — o motivo mais "de baixo
// nivel" vence, porque um problema de conexao com a Evolution torna os outros sinais nao-confiaveis
// (nao da pra saber se a sessao esta aberta se nem a API responde).
const ORDEM_MOTIVOS = [
  'evolution_inacessivel',
  'instancia_nao_encontrada',
  'sessao_fechada',
  'integracao_desabilitada',
  'token_invalido',
];

// Avalia um ciclo de medicao e devolve o veredito. Cada campo de entrada e OPCIONAL/null quando a
// etapa correspondente nao pode ser medida (ex.: erroRede true implica os outros ficarem null, porque
// o early-exit no chamador nem tentou medi-los).
//
//   erroRede            -> string do erro, ou null se a Evolution respondeu
//   instanciaEncontrada -> bool, existe uma instancia com este nome em /instance/fetchInstances
//   connectionStatus    -> string ('open', 'close', 'connecting', ...) ou null
//   chatwootEnabled     -> bool ou null (campo `enabled` de /chatwoot/find/{instance})
//   tokenValido         -> bool ou null (resultado de testar o token contra {CHATWOOT_BASE}/api/v1/profile)
function avaliarSaudeEvolution({
  erroRede = null,
  instanciaEncontrada = null,
  connectionStatus = null,
  chatwootEnabled = null,
  tokenValido = null,
} = {}) {
  if (erroRede) return { ok: false, motivo: 'evolution_inacessivel', detalhe: erroRede };
  if (instanciaEncontrada === false) return { ok: false, motivo: 'instancia_nao_encontrada', detalhe: null };
  if (connectionStatus != null && connectionStatus !== 'open') {
    return { ok: false, motivo: 'sessao_fechada', detalhe: connectionStatus };
  }
  if (chatwootEnabled === false) return { ok: false, motivo: 'integracao_desabilitada', detalhe: null };
  if (tokenValido === false) return { ok: false, motivo: 'token_invalido', detalhe: null };
  return { ok: true, motivo: null, detalhe: null };
}

// O hash que vira a chave de dedup (coluna evolution_saude.ultimo_hash / avisado_hash). 'ok' ou
// 'falha:<motivo>' — string estavel, comparavel byte a byte entre ciclos.
function hashSaude(veredito) {
  return veredito.ok ? 'ok' : `falha:${veredito.motivo}`;
}

function formatarDuracao(desdeMs, agoraMs) {
  const min = Math.max(0, Math.round((agoraMs - desdeMs) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h}h${resto}min` : `${h}h`;
}

// Texto do alerta, um por motivo — sempre acionavel (diz o comando ou o caminho de conferencia), e
// NUNCA contem o valor de um token. Cada bloco termina apontando para o script de sondagem manual.
function montarTextoAlertaEvolution({ hash, motivo, detalhe, instancia, mudouEm, agora = Date.now() } = {}) {
  const nomeInstancia = instancia || 'escritorio';
  const rodape = `\nConferir: \`node sondar-evolution.js\``;

  if (hash === 'ok') {
    const duracao = mudouEm ? formatarDuracao(mudouEm, agora) : null;
    return [
      `🟢 *Evolution API: voltou ao normal* (instância "${nomeInstancia}")`,
      'Token válido e sessão do WhatsApp abertos de novo.',
      duracao ? `Ficou fora do ar por ~${duracao}.` : null,
    ].filter(Boolean).join('\n') + rodape;
  }

  const linhas = { header: null, corpo: [] };

  if (motivo === 'token_invalido') {
    linhas.header = `🔴 *Evolution API: token do Chatwoot inválido* (instância "${nomeInstancia}")`;
    linhas.corpo = [
      '`GET /api/v1/profile` recusou (401) o token que a Evolution tem configurado para postar mensagem no Chatwoot.',
      '**Toda mensagem de WhatsApp deixa de virar conversa no Chatwoot enquanto isto não for religado** — foi exatamente isto que aconteceu em 04/09/2026 (58 min sem aviso nenhum).',
      '',
      'Religar: `GET http://127.0.0.1:8080/chatwoot/find/' + nomeInstancia + '` (header `apikey`) para pegar a config atual, trocar só o campo `token` por um Access Token válido do Chatwoot (Perfil → Access Token) e reenviar o MESMO objeto por `POST http://127.0.0.1:8080/chatwoot/set/' + nomeInstancia + '`.',
    ];
  } else if (motivo === 'sessao_fechada') {
    linhas.header = `🔴 *Evolution API: sessão do WhatsApp caiu* (instância "${nomeInstancia}")`;
    linhas.corpo = [
      `\`connectionStatus\` = "${detalhe || '?'}", esperado "open".`,
      'Nenhuma mensagem nova chega ao Chatwoot enquanto a sessão não for reconectada.',
      '',
      `Reconectar: escanear o QR Code da instância (\`GET http://127.0.0.1:8080/instance/connect/${nomeInstancia}\`) no WhatsApp do escritório.`,
    ];
  } else if (motivo === 'integracao_desabilitada') {
    linhas.header = `🔴 *Evolution API: integração com o Chatwoot está DESLIGADA* (instância "${nomeInstancia}")`;
    linhas.corpo = [
      '`GET /chatwoot/find/' + nomeInstancia + '` devolveu `enabled: false`.',
      'Religar: mesmo caminho do token inválido, mudando `enabled` para `true` no `POST /chatwoot/set/' + nomeInstancia + '`.',
    ];
  } else if (motivo === 'instancia_nao_encontrada') {
    linhas.header = `🔴 *Evolution API: instância "${nomeInstancia}" não aparece mais*`;
    linhas.corpo = [
      '`GET /instance/fetchInstances` não trouxe esta instância — pode ter sido renomeada ou apagada.',
      'Conferir na VPS: painel da Evolution ou `docker exec chatwoot-evolution-1 ...`.',
    ];
  } else {
    linhas.header = `🔴 *Evolution API inacessível*`;
    linhas.corpo = [
      detalhe ? `Erro: ${detalhe}` : 'Sem detalhe do erro.',
      'Sem isto o bot não consegue nem medir se o WhatsApp está recebendo mensagem — pode ser o container `chatwoot-evolution-1` fora do ar.',
      'Conferir na VPS: `docker ps | grep evolution` e `docker logs chatwoot-evolution-1 --tail 50`.',
    ];
  }

  return [linhas.header, ...linhas.corpo].join('\n') + rodape;
}

// Instante absoluto (ms desde epoch, o formato de messageTimestamp*1000 da Evolution) -> "HH:MM" no
// fuso do escritorio. Recebe o fuso por parametro (nunca le TZ_ESCRITORIO daqui — modulo puro, sem
// process.env, mesma convencao do resto do arquivo).
function formatarHorarioBr(ms, timeZone) {
  return new Date(ms).toLocaleString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' });
}

// Teto de contatos mostrados no relatorio — o resto vira "...e mais N", mesmo padrao do resumo do
// Chatwoot (index.js, rodarSincronizacaoChatwoot) pra nao virar parede de texto no Telegram.
const RELATORIO_MAX_CONTATOS = 25;

// O relatorio de "mensagens recebidas enquanto a integracao estava quebrada" — mandado so quando o
// monitor detecta RECUPERACAO (falha -> ok), nunca em outro momento. So METADADO: numero (quando
// confirmado), nome, horario. NUNCA o conteudo da mensagem — e comunicacao de cliente indo para um
// canal diferente (Telegram), e o pedido foi literalmente "numero, contato, horario", nao o texto.
//
//   contatos: [{ remoteJid, pushName, telefone: string|null, horarios: number[] (ms epoch) }]
//   desde/ate: ms epoch (a janela da falha)
//   timeZone: string (TZ_ESCRITORIO, passado pelo chamador)
function montarRelatorioMensagensPerdidas({ contatos, desde, ate, timeZone, agora = Date.now() } = {}) {
  const lista = (contatos || []).filter((c) => c.horarios && c.horarios.length);
  if (!lista.length) return null; // nada chegou na janela — nao manda relatorio nenhum

  const totalMensagens = lista.reduce((s, c) => s + c.horarios.length, 0);
  const ordenados = [...lista].sort((a, b) => Math.min(...a.horarios) - Math.min(...b.horarios));

  const janela = desde != null && ate != null
    ? `${formatarHorarioBr(desde, timeZone)}–${formatarHorarioBr(ate, timeZone)}`
    : null;

  const linhas = [
    `📋 *Mensagens recebidas durante a falha*${janela ? ` (${janela}, hora do escritório)` : ''}`,
    `${lista.length} cliente(s), ${totalMensagens} mensagem(ns) — confira no WhatsApp normal, pode não ter chegado ao Chatwoot:`,
    '',
  ];

  for (const c of ordenados.slice(0, RELATORIO_MAX_CONTATOS)) {
    const horarios = [...c.horarios].sort((a, b) => a - b).map((h) => formatarHorarioBr(h, timeZone));
    const identificacao = c.telefone ? `${c.telefone} — ${c.pushName || '(sem nome)'}` : `${c.pushName || '(sem nome)'} — telefone não confirmado`;
    const marca = c.telefone ? '📱' : '❓';
    linhas.push(`${marca} ${identificacao}: ${horarios.join(', ')}`);
  }
  if (ordenados.length > RELATORIO_MAX_CONTATOS) {
    linhas.push(`\n...e mais ${ordenados.length - RELATORIO_MAX_CONTATOS} cliente(s).`);
  }

  return linhas.join('\n');
}

// O nome deste texto NUNCA deve receber um token como argumento — mas caso algum dia alguem tente
// (bug de chamada), esta funcao existe para o teste de regressao ter algo objetivo para verificar:
// nenhuma das saidas de montarTextoAlertaEvolution contem uma sequencia longa alfanumerica que
// pareca token (heuristica: >=20 chars sem espaco, fora de blocos ja esperados como `codigo`).
function pareceConterSegredo(texto) {
  // Ignora trechos entre crases (comandos/paths do proprio alerta, que sao esperados e nao segredo).
  const semCodigo = String(texto || '').replace(/`[^`]*`/g, '');
  return /[A-Za-z0-9_-]{24,}/.test(semCodigo);
}

module.exports = {
  ORDEM_MOTIVOS,
  avaliarSaudeEvolution,
  hashSaude,
  montarTextoAlertaEvolution,
  formatarDuracao,
  formatarHorarioBr,
  montarRelatorioMensagensPerdidas,
  RELATORIO_MAX_CONTATOS,
  pareceConterSegredo,
};
