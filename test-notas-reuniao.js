// Testes PUROS da rotina de notas de reuniao (Gemini -> Moskit). Nao chamam OpenAI, Gmail, Drive,
// Calendar nem Moskit. Rodar com:
//   node test-notas-reuniao.js
//
// Os dados aqui NAO sao inventados: os assuntos, titulos de evento e o formato do anexo foram
// copiados de e-mails e eventos REAIS da caixa escritoriocr2019@gmail.com, medidos em 16/08/2026.
// Um teste com assunto plausivel-porem-fake nao provaria nada sobre o formato do Google.

const {
  parseAssuntoGemini,
  janelaDoDia,
  somarDias,
  extrairDocId,
  extrairDocIdDeEvento,
  extrairSinais,
  decidirDeal,
  prepararTextoFonte,
  validarExtracao,
  marcadorNota,
  montarTextoNota,
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
console.log('\n=== Texto-fonte e truncagem ===');

{
  const { texto, truncou } = prepararTextoFonte({ corpo: 'resumo do e-mail', textoDoc: 'transcricao literal' });
  checar('corpo e Doc entram rotulados', texto.includes('RESUMO ENVIADO POR E-MAIL') && texto.includes('TRANSCRIÇÃO'), texto);
  checar('sem estouro nao trunca', truncou === false);
}

{
  const r = prepararTextoFonte({ corpo: 'so o e-mail', textoDoc: '' });
  checar('sem Doc a nota ainda sai', r.texto.includes('so o e-mail') && !r.texto.includes('TRANSCRIÇÃO'));
}

{
  // A cauda e o que importa: "proximos passos" e "valores" ficam no FIM de uma reuniao. Cortar pela
  // cabeca preserva justamente o que se quer extrair.
  // Marcador UNICO na cabeca: enchimento repetido nao serviria, porque o mesmo trecho reapareceria
  // na cauda preservada e o teste passaria (ou falharia) por acidente.
  const cabeca = `SO-NO-INICIO ${'enchimento '.repeat(500)}`;
  const cauda = 'PROXIMOS PASSOS: enviar contrato';
  const { texto, truncou } = prepararTextoFonte({ corpo: cabeca + cauda, maxChars: 200 });
  checar('truncagem sinalizada', truncou === true);
  checar('a CAUDA sobrevive', texto.includes('PROXIMOS PASSOS'), texto.slice(-80));
  checar('a cabeca foi descartada', !texto.includes('SO-NO-INICIO'));
  checar('o corte e anunciado no texto', texto.includes('omitido por tamanho'));
}

// ------------------------------------------------------------
console.log('\n=== Validacao da saida da IA (filtro de ancoragem) ===');

const FONTE = 'O advogado propos honorarios de R$ 3.500,00 divididos em 3x. '
  + 'O cliente informou o CPF 123.456.789-00 e o processo 0801234-56.2026.8.14.0301. '
  + 'A audiencia esta marcada para 20/09/2026.';

{
  const { extracao, avisos } = validarExtracao({
    resumo_caso: 'Cliente busca orientacao.',
    proposta_valores: 'Honorarios de R$ 3.500,00 em 3x.',
    dados_criticos: 'Processo 0801234-56.2026.8.14.0301, audiencia em 20/09/2026.',
    documentos_solicitados: ['RG', 'Comprovante de residencia'],
    proximos_passos: ['Cliente enviara os documentos'],
    teses_estrategia: '',
  }, FONTE);

  checar('valor que EXISTE na fonte passa limpo',
    extracao.proposta_valores === 'Honorarios de R$ 3.500,00 em 3x.', extracao.proposta_valores);
  checar('processo que existe passa limpo', !extracao.dados_criticos.includes('⚠'), extracao.dados_criticos);
  checar('nenhum aviso quando tudo esta ancorado', avisos.length === 0, avisos);
  checar('listas preservadas', extracao.documentos_solicitados.length === 2);
}

{
  // O erro que ninguem pega lendo: um honorario plausivel que a reuniao nunca mencionou.
  const { extracao, avisos } = validarExtracao({
    resumo_caso: 'Cliente busca orientacao.',
    proposta_valores: 'Honorarios de R$ 9.900,00 a vista.',
  }, FONTE);

  checar('valor INVENTADO e marcado', extracao.proposta_valores.includes('⚠ não localizado'), extracao.proposta_valores);
  checar('o numero original permanece legivel', extracao.proposta_valores.includes('R$ 9.900,00'), extracao.proposta_valores);
  checar('vira aviso para o rodape', avisos.some((a) => a.includes('9.900')), avisos);
}

{
  const { extracao, avisos } = validarExtracao({
    resumo_caso: 'ok',
    proximos_passos: ['Protocolar ate 05/12/2026', 'Enviar RG'],
  }, FONTE);
  checar('data inventada dentro de LISTA tambem e marcada',
    extracao.proximos_passos[0].includes('⚠'), extracao.proximos_passos);
  checar('item sem numero passa intacto', extracao.proximos_passos[1] === 'Enviar RG');
  checar('aviso menciona o campo da lista', avisos.some((a) => a.startsWith('proximos_passos:')), avisos);
}

{
  // Pontuacao diferente nao pode gerar falso alarme: a fonte diz "R$ 3.500,00", a extracao "R$3.500,00".
  const { avisos } = validarExtracao({ resumo_caso: 'ok', proposta_valores: 'R$3.500,00' }, FONTE);
  checar('pontuacao diferente nao gera falso alarme', avisos.length === 0, avisos);
}

{
  // TEXTO REAL do e-mail do Gemini de 07/08/2026 (deal do Eric Ishibashi). Repare que o Gemini
  // escreve valor SEM formatacao de moeda — "5000 reais", nao "R$ 5.000,00".
  const REAL = 'A atuação jurídica foi precificada em 5000 reais para a primeira instância '
    + 'e 1500 reais para recursos de apelação. Esta estrutura cobre petições iniciais, '
    + 'acompanhamentos e eventuais agravos de instrumento.';

  const { extracao, avisos } = validarExtracao({
    resumo_caso: 'Transferência no programa Mais Médicos.',
    // O prompt manda preservar o formato original, mas o modelo pode normalizar para moeda. Os dois
    // sao o MESMO valor e nenhum pode virar alarme.
    proposta_valores: 'R$ 5.000,00 para a primeira instância e R$ 1.500,00 para apelação.',
  }, REAL);

  checar('valor real escrito como "5000 reais" casa com "R$ 5.000,00"',
    !extracao.proposta_valores.includes('⚠'), extracao.proposta_valores);
  checar('   e nao gera aviso nenhum', avisos.length === 0, avisos);
}

{
  // A contraprova: no MESMO texto real, um valor que nao foi dito continua sendo marcado. Sem isto a
  // correcao acima teria simplesmente desligado o filtro de dinheiro.
  const REAL = 'A atuação jurídica foi precificada em 5000 reais para a primeira instância.';
  const { extracao, avisos } = validarExtracao({
    resumo_caso: 'ok',
    proposta_valores: 'Honorários de R$ 7.200,00 mais R$ 5.000,00 de entrada.',
  }, REAL);

  checar('valor inventado continua marcado', extracao.proposta_valores.includes('R$ 7.200,00 [⚠'), extracao.proposta_valores);
  checar('   e o valor real ao lado NAO e marcado',
    /R\$ 5\.000,00(?! \[⚠)/.test(extracao.proposta_valores), extracao.proposta_valores);
  checar('   um unico aviso', avisos.length === 1, avisos);
}

{
  // Centavos de verdade tambem precisam casar nos dois sentidos.
  const { avisos: a1 } = validarExtracao({ resumo_caso: 'ok', proposta_valores: 'R$ 1.234,56' }, 'combinado 1234,56 no total');
  checar('valor com centavos casa entre formatos', a1.length === 0, a1);

  const { avisos: a2 } = validarExtracao({ resumo_caso: 'ok', proposta_valores: 'R$ 1.234,56' }, 'combinado 1234,65 no total');
  checar('   mas digito trocado ainda e pego', a2.length === 1, a2);
}

{
  const { extracao, avisos, vazia } = validarExtracao({
    resumo_caso: '',
    documentos_solicitados: 'RG',            // string onde devia ser lista
    proximos_passos: [null, '', 'Enviar'],   // lixo no meio
    invencao_do_modelo: 'nao deveria existir',
  }, FONTE);

  checar('resumo vazio e sinalizado como falha', vazia === true);
  checar('string vira lista de um item', extracao.documentos_solicitados.length === 1, extracao.documentos_solicitados);
  checar('lixo na lista e descartado', extracao.proximos_passos.length === 1, extracao.proximos_passos);
  checar('chave fora do contrato nao entra na nota', !('invencao_do_modelo' in extracao));
  checar('mas o desvio e registrado', avisos.some((a) => a.includes('fora do contrato')), avisos);
}

{
  checar('resposta nao-objeto nao quebra', validarExtracao(null, FONTE).vazia === true);
  checar('array no lugar do objeto nao quebra', validarExtracao([1, 2], FONTE).vazia === true);
}

// ------------------------------------------------------------
console.log('\n=== Marcador e texto da nota ===');

{
  const a = marcadorNota('19f22dabbca943ac', 'doc123');
  const b = marcadorNota('19f22dabbca943ac', 'doc123');
  const c = marcadorNota('OUTRA_MENSAGEM', 'doc123');

  checar('marcador e estavel entre execucoes', a === b, [a, b]);
  checar('marcador muda com a origem', a !== c);
  checar('formato do marcador', /^\[ollow-notas:[0-9a-f]{8}\]$/.test(a), a);
}

{
  const marcador = marcadorNota('m1', 'd1');
  const texto = montarTextoNota({
    extracao: {
      resumo_caso: 'Servidora federal desligada do programa de produtividade.',
      teses_estrategia: 'Aguardar o recurso administrativo.',
      documentos_solicitados: ['Contracheque', 'Portaria de desligamento'],
      proposta_valores: '',
      dados_criticos: 'Recurso administrativo em curso.',
      proximos_passos: ['Cliente protocola o recurso'],
    },
    meta: { dataBr: '14/08/2026', tituloEvento: 'Consulta — Lia (Berto)', metodo: 'evento_telefone', confianca: 'alta' },
    avisos: [],
    marcador,
  });

  checar('nota termina com o marcador', texto.trim().endsWith(marcador), texto.slice(-60));
  checar('secao com conteudo aparece', texto.includes('📌 RESUMO DO CASO'));
  checar('secao VAZIA e omitida', !texto.includes('💰 PROPOSTA'), texto);
  checar('itens de lista viram bullets', texto.includes('• Contracheque'));
  checar('disclaimer de IA presente', texto.includes('gerado por IA'));
  checar('metodo de vinculo impresso para auditoria', texto.includes('Vínculo: evento_telefone'), texto);

  // Funcao pura: mesma entrada, mesmo texto — e o que permite comparar contra o que esta no CRM.
  const denovo = montarTextoNota({
    extracao: {
      resumo_caso: 'Servidora federal desligada do programa de produtividade.',
      teses_estrategia: 'Aguardar o recurso administrativo.',
      documentos_solicitados: ['Contracheque', 'Portaria de desligamento'],
      proposta_valores: '',
      dados_criticos: 'Recurso administrativo em curso.',
      proximos_passos: ['Cliente protocola o recurso'],
    },
    meta: { dataBr: '14/08/2026', tituloEvento: 'Consulta — Lia (Berto)', metodo: 'evento_telefone', confianca: 'alta' },
    avisos: [],
    marcador,
  });
  checar('montarTextoNota e deterministica', texto === denovo);
}

{
  const texto = montarTextoNota({
    extracao: { resumo_caso: 'x', teses_estrategia: '', documentos_solicitados: [], proposta_valores: '', dados_criticos: '', proximos_passos: [] },
    meta: { truncou: true, semTranscricao: true, metodo: 'atividade_moskit', confianca: 'media' },
    avisos: ['proposta_valores: valor "R$ 9.900,00" não aparece no texto da reunião'],
    marcador: marcadorNota('m2', null),
  });
  checar('truncagem avisada na nota', texto.includes('TRECHO INICIAL foi omitido'));
  checar('ausencia de transcricao avisada', texto.includes('Sem transcrição literal'));
  checar('aviso de ancoragem chega ao rodape', texto.includes('R$ 9.900,00'), texto);
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
