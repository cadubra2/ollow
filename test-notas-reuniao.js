// Testes PUROS da rotina de notas de reuniao (Gemini -> Moskit). Nao chamam OpenAI, Gmail, Drive,
// Calendar nem Moskit. Rodar com:
//   node test-notas-reuniao.js
//
// Os dados aqui NAO sao inventados: os assuntos, titulos de evento e o formato do anexo foram
// copiados de e-mails e eventos REAIS da caixa escritoriocr2019@gmail.com, medidos em 16/08/2026.
// Um teste com assunto plausivel-porem-fake nao provaria nada sobre o formato do Google.
//
// DECISAO DE 02/09/2026: a nota deixou de ser uma extracao por IA em 5 secoes e virou so um link —
// ver o comentario no topo de src/notas-reuniao.js. Os testes da extracao/ancoragem
// (validarExtracao/conferirAncoragem) e da traducao pro Gemini (src/gemini.js) saíram daqui porque
// as duas coisas deixaram de existir.

const {
  parseAssuntoGemini,
  janelaDoDia,
  somarDias,
  extrairDocId,
  extrairDocIdDeEvento,
  extrairSinais,
  decidirDeal,
  marcadorNota,
  nomeAnexoNota,
  montarTextoNota,
  casarAtividadePorTitulo,
  tokensDistintivos,
} = require('./src/notas-reuniao');

let passou = 0;
let falhou = 0;

function checar(nome, condicao, detalhe) {
  if (condicao) {
    passou++;
    console.log(`  ✅ ${nome}`);
  } else {
    falhou++;
    console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`);
  }
}

// ------------------------------------------------------------
console.log('\n=== Assunto do e-mail do Gemini ===');

{
  // Forma 1 (a comum): reuniao com evento na agenda. Repare no emoji dentro do titulo — o nome do
  // contato vem do WhatsApp e emoji e regra, nao excecao.
  const r = parseAssuntoGemini('Notas: "Consulta — Lia 🇧🇷💛💚 (Berto)" de 14/08/2026');
  checar('assunto com titulo: extrai titulo', r?.tituloEvento === 'Consulta — Lia 🇧🇷💛💚 (Berto)', r);
  checar('assunto com titulo: extrai data ISO', r?.dataIso === '2026-08-14', r);
}

{
  // Forma 2 (real, existe na caixa): reuniao avulsa, sem titulo, e com dia de UM digito.
  const r = parseAssuntoGemini('Notas: reunião de 5/08/2026 à(s) 4:37 PM GMT-03:00');
  checar('assunto sem titulo: titulo null', r?.tituloEvento === null, r);
  checar('assunto sem titulo: dia de 1 digito vira 05', r?.dataIso === '2026-08-05', r);
}

{
  // A armadilha: o Gemini manda um e-mail parecido quando FALHA em gerar as notas. Ele nao tem nota
  // nenhuma dentro. Se entrasse na fila, viraria uma nota vazia no negocio do cliente.
  checar('"Problema com as notas" e recusado',
    parseAssuntoGemini('Problema com as notas: "Consulta online- Iury e Arthur" de 11/08/2026') === null);
  checar('"Problema com as notas" sem titulo tambem e recusado',
    parseAssuntoGemini('Problema com as notas: 12/08/2026 à(s) 12:10 PM GMT-03:00') === null);
}

{
  checar('assunto encaminhado ainda casa',
    parseAssuntoGemini('Enc: Notas: "Consulta — Sol Pectrovit (Iury)" de 4/08/2026')?.dataIso === '2026-08-04');
  checar('assunto de outro remetente nao casa', parseAssuntoGemini('Reunião amanhã') === null);
  checar('assunto vazio nao quebra', parseAssuntoGemini('') === null);
  checar('assunto undefined nao quebra', parseAssuntoGemini(undefined) === null);
  checar('data impossivel e recusada', parseAssuntoGemini('Notas: "X" de 99/99/2026') === null);
}

// ------------------------------------------------------------
console.log('\n=== Janela do dia (fuso) ===');

{
  // A suite roda em UTC (fuso da VPS), mas o dia da reuniao e o dia do ESCRITORIO. Se a janela fosse
  // montada com new Date(), o dia 14 em Fortaleza comecaria 3h cedo demais e as consultas das 21h+
  // cairiam fora da busca.
  const j = janelaDoDia('2026-08-14', 'America/Fortaleza');
  checar('inicio do dia em Fortaleza = 03:00Z', j?.timeMin === '2026-08-14T03:00:00.000Z', j);
  checar('fim do dia em Fortaleza = 03:00Z do dia seguinte', j?.timeMax === '2026-08-15T03:00:00.000Z', j);

  const jTokyo = janelaDoDia('2026-08-14', 'Asia/Tokyo');
  checar('fuso a leste de UTC tambem funciona', jTokyo?.timeMin === '2026-08-13T15:00:00.000Z', jTokyo);

  checar('data invalida devolve null', janelaDoDia('14/08/2026', 'America/Fortaleza') === null);
  checar('virada de mes no somarDias', somarDias('2026-08-31', 1) === '2026-09-01');
  checar('virada de ano no somarDias', somarDias('2026-12-31', 1) === '2027-01-01');
}

// ------------------------------------------------------------
console.log('\n=== Doc das notas ===');

{
  // Formato REAL do anexo, copiado do evento da Lia.
  const evento = {
    attachments: [{
      fileUrl: 'https://docs.google.com/document/d/1jJ34MKqvrdxE7HTEpGC26W93I3m-zOrDONnqSe2TuXs/edit?usp=meet_tnfm_calendar',
      title: 'Anotações do Gemini',
    }],
  };
  checar('docId sai do anexo do evento',
    extrairDocIdDeEvento(evento) === '1jJ34MKqvrdxE7HTEpGC26W93I3m-zOrDONnqSe2TuXs');
  checar('evento sem anexo devolve null', extrairDocIdDeEvento({}) === null);
  checar('evento null nao quebra', extrairDocIdDeEvento(null) === null);
}

{
  // No corpo HTML o link vem embrulhado no redirecionador do Google, com &amp; no meio. O regex
  // direto NAO casa aqui — e este e o caminho de fallback quando o evento nao e encontrado.
  const html = '<a href="https://www.google.com/url?q=https://docs.google.com/document/d/'
    + 'AbC123_def-456GHI789jkl/edit&amp;source=gmail&amp;ust=123">Abrir notas da reunião</a>';
  checar('docId sai do redirect do Google no HTML',
    extrairDocId(html) === 'AbC123_def-456GHI789jkl', extrairDocId(html));

  const direto = 'veja em https://docs.google.com/document/d/ZZZ111_yyy-222WWW333vvv/edit';
  checar('docId sai de link direto', extrairDocId(direto) === 'ZZZ111_yyy-222WWW333vvv');
  checar('texto sem link devolve null', extrairDocId('Abrir notas da reunião') === null);
  checar('percent-encoding quebrado nao lanca', extrairDocId('?q=%E0%A4%A') === null);
}

// ------------------------------------------------------------
console.log('\n=== Sinais de identidade ===');

{
  // Descricao REAL do evento da Lia (criado pelo bot).
  const evento = {
    id: '33g7tehniljh2hptbpmfaggcfs',
    summary: 'Consulta — Lia 🇧🇷💛💚 (Berto)',
    description: 'Assunto: Consulta juridica\nTelefone: 558681876734\n📌 Caso: Cliente é servidora federal...',
    organizer: { email: 'escritoriocr2019@gmail.com' },
    attendees: [{ email: 'escritoriocr2019@gmail.com' }, { email: 'lia@exemplo.com' }],
    start: { dateTime: '2026-08-14T18:00:00-03:00' },
    attachments: [{ fileUrl: 'https://docs.google.com/document/d/1jJ34MKqvrdxE7HTEpGC26W93I3m-zOrDONnqSe2TuXs/edit' }],
  };
  const s = extrairSinais({ evento, assunto: 'Notas: "Consulta — Lia 🇧🇷💛💚 (Berto)" de 14/08/2026', corpo: '' });

  checar('extrai telefone da descricao', s.telefone === '558681876734', s.telefone);
  checar('organizador nao entra como participante', !s.emails.includes('escritoriocr2019@gmail.com'), s.emails);
  checar('participante real entra', s.emails.includes('lia@exemplo.com'), s.emails);
  checar('docId vem do anexo', s.docId === '1jJ34MKqvrdxE7HTEpGC26W93I3m-zOrDONnqSe2TuXs');
  checar('sem [deal:] ainda hoje', s.dealIdMarcado === null);
}

{
  const evento = { description: 'Telefone: 558681876734\n[deal:48292471]' };
  checar('extrai [deal:] quando presente',
    extrairSinais({ evento }).dealIdMarcado === 48292471);
}

{
  // O evento criado na mao ("Consulta online - Berto e Aurinete") nao tem NADA disso — e o caso que
  // a sondagem mediu em 1/3 das reunioes com notas.
  const s = extrairSinais({ evento: { summary: 'Consulta online - Berto e Aurinete', description: '' }, assunto: '', corpo: '' });
  checar('evento manual: sem telefone', s.telefone === null);
  checar('evento manual: sem deal marcado', s.dealIdMarcado === null);
}

{
  const s = extrairSinais({ evento: null, assunto: 'Notas da reunião ID 45892', corpo: '' });
  checar('ID solto no assunto e capturado', s.idSolto === 45892, s.idSolto);
  checar('numero curto nao vira ID', extrairSinais({ assunto: 'ID 42' }).idSolto === null);
}

// ------------------------------------------------------------
console.log('\n=== Numero do negocio no titulo (· #NNNNN) ===');

{
  // O PONTO DA MUDANCA: o assunto do Gemini reproduz o titulo entre aspas, entao o numero chega sem
  // que seja preciso achar o evento na agenda. Aqui evento e null de proposito.
  const s = extrairSinais({
    evento: null,
    assunto: 'Notas: "Consulta — Lia 🇧🇷💛💚 (Berto) · #48292471" de 14/08/2026',
    corpo: '',
  });
  checar('numero sai do assunto SEM evento nenhum', s.dealIdNoTitulo === 48292471, s.dealIdNoTitulo);

  const r = decidirDeal(s, {});
  checar('   e resolve o deal sozinho', r.dealId === 48292471 && r.metodo === 'titulo_deal_id', r);
  checar('   com confianca alta', r.confianca === 'alta');
}

{
  const s = extrairSinais({
    evento: { summary: 'Consulta — Lia (Berto) · #48292471', description: '' },
    assunto: '',
  });
  checar('numero tambem sai do summary do evento', s.dealIdNoTitulo === 48292471, s.dealIdNoTitulo);
}

{
  // Assunto do acervo atual, sem numero: tem de continuar caindo nos passos seguintes. E a prova de
  // que a mudanca e aditiva e nao quebra os e-mails que ja estao na caixa.
  const s = extrairSinais({
    evento: { summary: 'Consulta — Lia (Berto)', description: 'Telefone: 558681876734' },
    assunto: 'Notas: "Consulta — Lia (Berto)" de 14/08/2026',
  });
  checar('titulo antigo (sem numero) nao inventa sinal', s.dealIdNoTitulo === null);
  const r = decidirDeal(s, { porTelefone: [48292471] });
  checar('   e o acervo antigo segue resolvendo pelo telefone', r.metodo === 'evento_telefone', r);
}

{
  checar('# com menos de 5 digitos e ignorado',
    extrairSinais({ evento: { summary: 'Consulta — X · #123' } }).dealIdNoTitulo === null);
}

{
  // "#" seguido de numero e ruido comum em fala transcrita e em texto de protocolo. O sinal do titulo
  // so pode sair de titulo e assunto.
  const s = extrairSinais({
    evento: { summary: 'Consulta — X', description: '' },
    assunto: 'Notas: "Consulta — X" de 14/08/2026',
    corpo: 'o cliente citou o protocolo #99887766 e o ID 12345678 do processo administrativo',
  });
  checar('# no corpo NAO vira sinal de titulo', s.dealIdNoTitulo === null, s.dealIdNoTitulo);
  // O corpo e o resumo que o Gemini escreveu a partir da FALA: um numero que o cliente leu em voz
  // alta nao pode virar vinculo de confianca alta com um negocio.
  checar('   "ID 12345678" no corpo tambem nao vira sinal', s.idSolto === null, s.idSolto);
  checar('   e a cascata nao resolve nada por eles', decidirDeal(s, {}).dealId === null, decidirDeal(s, {}));

  // A transcricao NAO chega a extrairSinais: nao existe parametro para ela. E a garantia estrutural
  // de que um numero dito de passagem numa reuniao nunca vira vinculo com um negocio.
  checar('extrairSinais nao aceita transcricao', !/textoDoc/.test(extrairSinais.toString()));
}

{
  // Evento copiado de outro cliente com so um dos marcadores atualizado. Nao ha desempate honesto:
  // aceitar qualquer um dos dois poria a nota do caso de um cliente no negocio de outro.
  const s = extrairSinais({
    evento: { summary: 'Consulta — X · #48111111', description: '[deal:48222222]\nTelefone: 558681876734' },
    assunto: '',
  });
  const r = decidirDeal(s, { porTelefone: [48333333] });
  checar('marcadores divergentes = orfao', r.dealId === null, r);
  checar('   com motivo proprio', r.metodo === 'marcadores_divergentes', r.metodo);
  checar('   os dois numeros ficam no aviso', r.candidatos.includes(48111111) && r.candidatos.includes(48222222), r.candidatos);
  checar('   o diagnostico diz quem disse o que',
    r.diagnostico.tituloDizia === 48111111 && r.diagnostico.descricaoDizia === 48222222, r.diagnostico);
  checar('   e NAO cai para o telefone', r.dealId !== 48333333);
}

{
  // Os dois marcadores concordando e o caso normal de todo evento criado pelo bot daqui pra frente.
  const s = extrairSinais({
    evento: { summary: 'Consulta — X · #48292471', description: '[deal:48292471]' },
    assunto: '',
  });
  const r = decidirDeal(s, {});
  checar('marcadores concordantes resolvem normalmente', r.dealId === 48292471, r);
  checar('   pelo titulo, que nao depende do evento', r.metodo === 'titulo_deal_id', r.metodo);
}

// ------------------------------------------------------------
console.log('\n=== A cascata e a regra de ambiguidade ===');

{
  const sinais = extrairSinais({ evento: { description: 'Telefone: 558681876734' } });
  const r = decidirDeal(sinais, { porTelefone: [48292471] });
  checar('telefone unico resolve', r.dealId === 48292471 && r.metodo === 'evento_telefone', r);
  checar('confianca alta no telefone', r.confianca === 'alta');
}

{
  const sinais = extrairSinais({ evento: { description: 'Telefone: 5586\n[deal:111]' } });
  const r = decidirDeal(sinais, { porTelefone: [999] });
  checar('[deal:] tem precedencia sobre telefone', r.dealId === 111 && r.metodo === 'evento_deal_id', r);
}

{
  // O CORACAO DA SEGURANCA. Dois negocios para o mesmo telefone (cliente com dois casos): a nota
  // NAO pode ir para nenhum dos dois no chute — no CRM isso e a nota de um caso aparecendo no outro.
  const sinais = extrairSinais({ evento: { description: 'Telefone: 558681876734' } });
  const r = decidirDeal(sinais, { porTelefone: [48292471, 48287898], porEmail: [48111111] });
  checar('dois candidatos = orfao, nao chute', r.dealId === null, r);
  checar('motivo registrado como ambiguidade', r.metodo === 'ambiguidade', r.metodo);
  checar('os dois candidatos ficam no diagnostico', r.candidatos.length === 2, r.candidatos);
  checar('NAO cai para o passo seguinte apos ambiguidade', r.diagnostico.ambiguoEm === 'evento_telefone', r.diagnostico);
}

{
  const r = decidirDeal(extrairSinais({ evento: null }), {});
  checar('sem sinal nenhum vira nao_encontrado', r.dealId === null && r.metodo === 'nao_encontrado', r);
  checar('ausencia de evento fica no diagnostico', r.diagnostico.semEvento === true);
}

{
  // Teto de paginacao de /activities: "nao achei" tem de ser distinguivel de "parei no teto".
  const r = decidirDeal(extrairSinais({ evento: null }), { truncouAtividades: true });
  checar('truncagem de atividades fica no diagnostico', r.diagnostico.atividadesTruncadas === true);
}

{
  const sinais = extrairSinais({ evento: { description: '' }, assunto: '' });
  const r = decidirDeal(sinais, { porAtividade: [], porEmail: [48222222] });
  checar('email do participante resolve em ultimo caso', r.dealId === 48222222 && r.metodo === 'email_participante', r);
  checar('confianca media no email', r.confianca === 'media');
}

{
  const r = decidirDeal(extrairSinais({}), { porTelefone: [0, null, 'abc'] });
  checar('ids invalidos sao descartados', r.dealId === null, r);
}

// ------------------------------------------------------------
console.log('\n=== Casamento por titulo contra as Atividades do Moskit ===');
// Reuniao marcada A MAO nao tem telefone, nem e-mail de participante, nem #dealId: os 6 passos
// voltavam vazios. O sinal que sobra e o par de nomes do titulo, que a MESMA pessoa digitou na
// Atividade do CRM. MEDIDO em 04/09/2026 nas duas primeiras orfas reais.
{
  const at = (id, dealId, subject) => ({ id, subject, deals: [{ id: dealId }] });

  checar('palavra de todo titulo nao e sinal (consulta/online caem fora)', tokensDistintivos('Consulta On-line-').length === 0, tokensDistintivos('Consulta On-line-').length);
  checar('nomes proprios sobrevivem',
    JSON.stringify(tokensDistintivos('Consulta On-line- Iury e Gleydson')) === JSON.stringify(['iury', 'gleydson']),
    tokensDistintivos('Consulta On-line- Iury e Gleydson'));
  checar('acento e caixa nao mudam o token', tokensDistintivos('Reunião — JOÃO').includes('joao'),
    tokensDistintivos('Reunião — JOÃO'));

  const atividades = [
    at(1, 48715620, 'Retorno - Iury e Gleydson'),
    at(2, 48457749, 'Consulta- Berto e Gustavo'),
    at(3, 99999999, 'Consulta online'),
  ];
  checar('caso real: o par advogado+cliente acha o negocio certo', JSON.stringify(casarAtividadePorTitulo('Consulta On-line- Iury e Gleydson', atividades)) === JSON.stringify([48715620]), JSON.stringify(casarAtividadePorTitulo('Consulta On-line- Iury e Gleydson', atividades)));
  checar('   e o outro par acha o outro', JSON.stringify(casarAtividadePorTitulo('Consulta on-line- Berto e Gustavo', atividades)) === JSON.stringify([48457749]), JSON.stringify(casarAtividadePorTitulo('Consulta on-line- Berto e Gustavo', atividades)));

  // A guarda que impede isto de virar maquina de falso positivo. MEDIDO: 'Gustavo' sozinho bate
  // em 15 negocios da conta — um primeiro nome nao e identidade.
  checar('UM nome sozinho nao casa nada (minimo de 2 tokens distintivos)', casarAtividadePorTitulo('Consulta - Gustavo', atividades).length === 0, casarAtividadePorTitulo('Consulta - Gustavo', atividades).length);
  checar('titulo sem nome nenhum tambem nao', casarAtividadePorTitulo('Consulta online', atividades).length === 0, casarAtividadePorTitulo('Consulta online', atividades).length);
  checar('titulo vazio/nulo nao quebra', casarAtividadePorTitulo(null, atividades).length === 0, casarAtividadePorTitulo(null, atividades).length);

  // Exige TODOS os tokens: metade do par nao serve.
  checar('token a mais no titulo que a atividade nao tem => nao casa', casarAtividadePorTitulo('Consulta - Iury e Gleydson e Marcos', atividades).length === 0, casarAtividadePorTitulo('Consulta - Iury e Gleydson e Marcos', atividades).length);

  // Duas atividades do MESMO negocio contam como um candidato (nao viram ambiguidade falsa).
  const duasDoMesmo = [at(1, 48715620, 'Retorno - Iury e Gleydson'), at(2, 48715620, 'Iury e Gleydson - consulta online')];
  checar('duas atividades do mesmo negocio => um candidato', JSON.stringify(casarAtividadePorTitulo('Iury e Gleydson', duasDoMesmo)) === JSON.stringify([48715620]), JSON.stringify(casarAtividadePorTitulo('Iury e Gleydson', duasDoMesmo)));

  // E dois negocios diferentes casando viram DOIS candidatos — quem decide e a cascata, que para.
  const doisNegocios = [at(1, 111111, 'Iury e Gleydson'), at(2, 222222, 'Retorno Iury e Gleydson')];
  checar('negocios diferentes => dois candidatos (a cascata vai recusar)', casarAtividadePorTitulo('Iury e Gleydson', doisNegocios).length === 2, casarAtividadePorTitulo('Iury e Gleydson', doisNegocios).length);
}

console.log('\n=== O passo novo na cascata: ULTIMO, e candidato unico ou nada ===');
{
  const sinaisVazios = { emails: [], tituloEvento: 'Consulta On-line- Iury e Gleydson', eventoId: 'ev1' };
  const r = decidirDeal(sinaisVazios, { porTituloAtividade: [48715620] });
  checar('acha pelo titulo quando nada mais achou', r.dealId === 48715620, r.dealId);
  checar('   com metodo proprio no rodape da nota', r.metodo === 'atividade_titulo', r.metodo);
  checar('   e confianca media (e semelhanca de texto, nao marcador)', r.confianca === 'media', r.confianca);

  const ambiguo = decidirDeal(sinaisVazios, { porTituloAtividade: [111, 222] });
  checar('dois candidatos => orfao, nunca o primeiro', ambiguo.dealId === null, ambiguo.dealId);
  checar('   e o diagnostico diz em que passo a ambiguidade apareceu', ambiguo.diagnostico.ambiguoEm === 'atividade_titulo', ambiguo.diagnostico.ambiguoEm);

  // O ponto de ser o ULTIMO: um sinal deterministico sempre vence a semelhanca de texto.
  const comMarcador = decidirDeal({ ...sinaisVazios, dealIdNoTitulo: 48292471 }, { porTituloAtividade: [48715620] });
  checar('marcador no titulo vence o casamento por texto', comMarcador.dealId === 48292471, comMarcador.dealId);
  checar('   pelo passo de sempre', comMarcador.metodo === 'titulo_deal_id', comMarcador.metodo);

  // E o passo aparece no diagnostico mesmo quando nao acha nada (senao ninguem descobre que rodou).
  const nada = decidirDeal(sinaisVazios, {});
  checar('o passo consta no diagnostico mesmo vazio',
    nada.diagnostico.passos.some((p) => p.metodo === 'atividade_titulo'),
    nada.diagnostico.passos.map((p) => p.metodo));
}

console.log('\n=== Marcador e nome do anexo ===');

{
  const a = marcadorNota('19f22dabbca943ac', 'doc123');
  const b = marcadorNota('19f22dabbca943ac', 'doc123');
  const c = marcadorNota('OUTRA_MENSAGEM', 'doc123');

  checar('marcador e estavel entre execucoes', a === b, [a, b]);
  checar('marcador muda com a origem', a !== c);
  checar('formato do marcador', /^\[ollow-notas:[0-9a-f]{8}\]$/.test(a), a);
}

{
  // O determinismo NAO e detalhe estetico: o POST /deals/{id}/attachments so aceita uma url, sem
  // lugar para marcador dentro do arquivo. Depois de um crash entre "vou anexar" e "anexei", a unica
  // pergunta possivel ao CRM e "existe anexo com este nome?". Nome instavel = resposta sempre "nao"
  // = segunda copia da transcricao no prontuario do cliente.
  const marcador = marcadorNota('msg-abc', 'doc-xyz');
  const a = nomeAnexoNota(marcador, '2026-08-14');
  const b = nomeAnexoNota(marcadorNota('msg-abc', 'doc-xyz'), '2026-08-14');
  checar('nome do anexo e estavel entre execucoes', a === b, a);
  checar('termina em .pdf', a.endsWith('.pdf'), a);
  checar('carrega a data da reuniao', a.includes('2026-08-14'), a);

  const hash = marcador.match(/\[ollow-notas:([a-f0-9]+)\]/)[1];
  checar('sufixo e o MESMO hash do marcador da nota', a.includes(hash), a);

  // Origem diferente tem que produzir nome diferente, senao a nota de um cliente encontraria o anexo
  // de outro na deduplicacao e o PDF certo nunca subiria.
  const outro = nomeAnexoNota(marcadorNota('msg-zzz', 'doc-xyz'), '2026-08-14');
  checar('origem diferente => nome diferente', a !== outro, { a, outro });

  // Mesma origem, dias diferentes: duas consultas do mesmo cliente sao dois arquivos.
  const outroDia = nomeAnexoNota(marcador, '2026-08-15');
  checar('data diferente => nome diferente', a !== outroDia, { a, outroDia });

  // Entradas degeneradas nao podem gerar caminho estranho — o nome vai para dentro de um
  // Content-Disposition e para a comparacao com o filename devolvido pelo Moskit.
  const semNada = nomeAnexoNota(null, null);
  checar('sem marcador/data ainda produz nome valido', /^notas-reuniao-[\w-]+\.pdf$/.test(semNada), semNada);
  checar('nome nunca contem separador de caminho', !/[\\/]/.test(nomeAnexoNota('lixo', '../../etc')), nomeAnexoNota('lixo', '../../etc'));
}

// ------------------------------------------------------------
console.log('\n=== Texto da nota (so link, sem extracao por IA) ===');

{
  // Decisao de 02/09/2026: nao ha mais secao nenhuma nem texto extraido por IA — so o link da
  // transcricao (quando existe) e o metodo de vinculo, para auditoria.
  const marcador = marcadorNota('m1', 'd1');
  const meta = {
    dataBr: '14/08/2026', tituloEvento: 'Consulta — Lia (Berto)',
    anexado: true, linkDoc: 'https://docs.google.com/document/d/d1',
    metodo: 'evento_telefone', confianca: 'alta', numeroReuniao: 2,
  };
  const texto = montarTextoNota({ meta, marcador });

  checar('titulo simples, sem "BRIEFING DE ATENDIMENTO"', texto.startsWith('📄 Notas de reunião'), texto.slice(0, 40));
  checar('titulo cita a reuniao, a data e o evento', texto.includes('REUNIÃO 2') && texto.includes('14/08/2026') && texto.includes('(Consulta — Lia (Berto))'), texto.slice(0, 100));
  checar('rodape afirma o anexo quando anexado=true', texto.includes('anexada na aba Arquivos'), texto);
  checar('rodape cita o link da transcricao', texto.includes('Fonte: https://docs.google.com/document/d/d1'), texto);
  checar('metodo de vinculo impresso para auditoria', texto.includes('Vínculo: evento_telefone (confiança alta)'), texto);
  checar('nota termina com o marcador', texto.trim().endsWith(marcador), texto.slice(-60));
  // O `description` do Moskit e exibido cru: sintaxe nao renderizada viraria sujeira justamente no
  // documento que o advogado abre antes de redigir.
  checar('nota em texto puro, sem Markdown', !/\*\*|^#/m.test(texto), texto);
  // Nenhum resto da extracao antiga: nem secao, nem disclaimer de IA, nem aviso de ancoragem.
  checar('nada de secoes numeradas antigas', !/1\.\s*CONTEXTO|DA ESTRATÉGIA|PROPOSTA DE HONOR/.test(texto), texto);
  checar('nada de disclaimer de IA (nao ha mais extracao)', !texto.includes('gerado por IA'), texto);

  // Funcao pura: mesma entrada, mesmo texto — e o que permite comparar contra o que esta no CRM.
  const denovo = montarTextoNota({ meta, marcador });
  checar('montarTextoNota e deterministica', texto === denovo);
}

{
  // Sem numero de reuniao identificado (deal com uma so reuniao) o titulo simplesmente nao cita
  // numero — nenhuma mudanca de formato so por isso.
  const texto = montarTextoNota({
    meta: { dataBr: '14/08/2026', anexado: false, linkDoc: 'https://docs.google.com/document/d/d2', metodo: 'atividade_moskit', confianca: 'media' },
    marcador: marcadorNota('m2', 'd2'),
  });
  checar('sem numeroReuniao, titulo nao cita "REUNIÃO"', !texto.includes('REUNIÃO'), texto.slice(0, 60));
  checar('sem tituloEvento, titulo nao abre parenteses vazio', !texto.includes('()'), texto.slice(0, 60));
  // O silencio e o ponto: prometer um arquivo que nao subiu manda o advogado procurar o que nao esta
  // la — pior que nao mencionar nada.
  checar('rodape NAO promete anexo quando ele ainda nao foi confirmado', !texto.includes('anexada na aba Arquivos'), texto);
  checar('mas o link da transcricao continua presente (util mesmo sem anexo confirmado)', texto.includes('Fonte:'), texto);
}

{
  // Sem link nenhum (nao deveria acontecer em producao — o index.js so chama montarTextoNota depois
  // de confirmar que ha docId — mas a funcao pura nao pode quebrar mesmo assim).
  const texto = montarTextoNota({ meta: {}, marcador: marcadorNota('m3', null) });
  checar('sem linkDoc, a linha "Fonte:" simplesmente nao aparece', !texto.includes('Fonte:'), texto);
  checar('ainda assim termina com o marcador', texto.trim().endsWith(marcadorNota('m3', null)), texto);
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
