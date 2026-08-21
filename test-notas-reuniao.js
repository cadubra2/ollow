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
  nomeAnexoNota,
  montarTextoNota,
  ehExtracaoAtual,
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

// E contra ESTA fonte que todo numero da extracao e conferido. Repare que ela cita "art. 47" e
// "Lei 9.394/96": desde que o briefing ganhou o campo de fundamentacao, citacao legal entrou no
// filtro, e os dois casos (o numero curto que nao identifica nada e a norma inteira) precisam de
// cobertura.
const FONTE = 'O advogado propos honorarios de R$ 3.500,00 divididos em 3x. '
  + 'O cliente informou o CPF 123.456.789-00 e o processo 0801234-56.2026.8.14.0301. '
  + 'A audiencia esta marcada para 20/09/2026. Foi citado o art. 47 da Lei 9.394/96.';

{
  const { extracao, avisos } = validarExtracao({
    perfil_qualificacao: 'Aluno de Medicina no ultimo periodo.',
    situacao_atual_urgencia: 'Audiencia em 20/09/2026.',
    fundamentacao_legal: 'Art. 47 da Lei 9.394/96.',
    superacao_obices: 'Processo 0801234-56.2026.8.14.0301 instruido com o historico.',
    honorarios: [{ etapa: 'Entrada / Início da Ação', valor: 'R$ 3.500,00', condicao: 'protocolo em 1o grau' }],
  }, FONTE);

  checar('valor que existe na fonte passa limpo', extracao.honorarios[0].valor === 'R$ 3.500,00', extracao.honorarios[0]);
  checar('processo que existe passa limpo', !extracao.superacao_obices.includes('⚠'), extracao.superacao_obices);
  checar('data que existe passa limpa', !extracao.situacao_atual_urgencia.includes('⚠'), extracao.situacao_atual_urgencia);
  checar('norma que existe passa limpa', !extracao.fundamentacao_legal.includes('⚠'), extracao.fundamentacao_legal);
  checar('nada ancorado => nenhum aviso', avisos.length === 0, avisos);
}

{
  // O risco que o campo "fundamentacao_legal" abriu: pedir "os dispositivos discutidos" e o convite
  // para o modelo completar "a LDB" com um numero de lei que ninguem disse. O numero sai perfeito.
  const { extracao, avisos } = validarExtracao({
    perfil_qualificacao: 'ok',
    fundamentacao_legal: 'Aplicacao da Lei 13.105/2015 e do art. 47.',
  }, FONTE);

  checar('norma INVENTADA e marcada', extracao.fundamentacao_legal.includes('Lei 13.105/2015 [⚠ não localizado'), extracao.fundamentacao_legal);
  checar('o numero original permanece legivel', extracao.fundamentacao_legal.includes('Lei 13.105/2015'), extracao.fundamentacao_legal);
  // "art. 47" tem dois digitos: nao identifica norma nenhuma e marcaria toda peca do escritorio.
  checar('artigo curto NAO vira ruido', !/art\. 47 \[⚠/.test(extracao.fundamentacao_legal), extracao.fundamentacao_legal);
  checar('aviso nomeia o campo', avisos.some((a) => a.startsWith('fundamentacao_legal:')), avisos);
}

{
  // O bloco a bloco: a fonte disse "Lei 9.394" sem o ano, e o modelo completou "/96". Comparar a
  // cadeia inteira ("939496") procuraria no texto um numero que ninguem escreveu junto e marcaria uma
  // citacao CERTA — falso alarme no campo de fundamentacao ensina o advogado a ignorar o simbolo.
  const { extracao } = validarExtracao({ perfil_qualificacao: 'ok', fundamentacao_legal: 'Lei 9.394/96' }, 'o advogado citou a Lei 9.394');
  checar('ano acrescentado a uma lei que existe na fonte nao vira alarme', !extracao.fundamentacao_legal.includes('⚠'), extracao.fundamentacao_legal);
}

{
  const { extracao, avisos } = validarExtracao({
    perfil_qualificacao: 'ok',
    honorarios: [
      { etapa: 'Entrada / Início da Ação', valor: 'R$ 3.500,00', condicao: 'protocolo' },
      { etapa: 'Êxito Final', valor: 'R$ 9.900,00', condicao: 'transito em julgado' },
    ],
  }, FONTE);

  checar('valor inventado no honorario e marcado', extracao.honorarios[1].valor.includes('⚠ não localizado'), extracao.honorarios[1].valor);
  checar('o numero original continua legivel', extracao.honorarios[1].valor.includes('R$ 9.900,00'), extracao.honorarios[1].valor);
  checar('a parcela ancorada nao e tocada', extracao.honorarios[0].valor === 'R$ 3.500,00', extracao.honorarios[0].valor);
  // Sem a etapa no rotulo, um briefing com cinco parcelas nao diria QUAL delas esta suspeita.
  checar('o aviso diz de qual etapa', avisos.some((a) => a.includes('honorarios (Êxito Final)')), avisos);
}

{
  // MEDIDO no e-mail real de 07/08/2026: o Gemini escreve "5000 reais", sem formatacao de moeda. Se o
  // modelo devolver "R$ 5.000,00" — o MESMO valor, formatado — comparar por cadeia de digitos
  // procuraria "500000" num texto que tem "5000". Dinheiro se compara como numero.
  const SEM_MOEDA = 'A causa foi precificada em 5000 reais para a primeira instancia e 1500 reais para recursos.';
  const { extracao } = validarExtracao({
    perfil_qualificacao: 'ok',
    honorarios: [{ etapa: 'Entrada / Início da Ação', valor: 'R$ 5.000,00', condicao: 'primeira instancia' }],
  }, SEM_MOEDA);
  checar('"5000 reais" na fonte casa com "R$ 5.000,00" na extracao', !extracao.honorarios[0].valor.includes('⚠'), extracao.honorarios[0].valor);
}

{
  const { extracao } = validarExtracao({
    perfil_qualificacao: 'ok',
    honorarios: [
      { condicao: 'quando o juiz decidir' },  // sem etapa e sem valor: nao e parcela nenhuma
      { etapa: 'Manutenção / Acompanhamento Mensal', valor: 'R$ 800,00/mês' },
      'texto solto',
      null,
    ],
  }, 'acompanhamento de 800 por mes');

  checar('item sem etapa e sem valor e descartado', extracao.honorarios.length === 1, extracao.honorarios);
  checar('lixo na lista de honorarios e descartado', extracao.honorarios[0].etapa === 'Manutenção / Acompanhamento Mensal', extracao.honorarios[0]);
  checar('parcela sem condicao sobrevive', extracao.honorarios[0].condicao === '', extracao.honorarios[0]);
}

{
  const { extracao, avisos, vazia } = validarExtracao({
    perfil_qualificacao: '',
    resumo_caso: 'campo do contrato antigo',   // chave que nao existe mais
    honorarios: 'nao e lista',
  }, FONTE);

  checar('chave fora do contrato e ignorada e registrada', avisos.some((a) => a.includes('resumo_caso')), avisos);
  checar('honorarios que nao e lista vira lista vazia', Array.isArray(extracao.honorarios) && extracao.honorarios.length === 0, extracao.honorarios);
  checar('sem campo de sustentacao => extracao vazia', vazia === true);
}

{
  checar('objeto sozinho ja sustenta a nota', validarExtracao({ objeto: 'Propositura de mandado de seguranca.' }, FONTE).vazia === false);
  // Estrategia e preco sem UMA linha de contexto factual e o retrato do modelo que preencheu o
  // formulario sem ter lido a reuniao — e uma nota assim vai para o prontuario do cliente.
  const so = validarExtracao({
    via_eleita_foro: 'Mandado de seguranca',
    honorarios: [{ etapa: 'Entrada / Início da Ação', valor: 'R$ 3.500,00' }],
  }, FONTE);
  checar('estrategia + honorarios SEM contexto ainda e extracao vazia', so.vazia === true, so.extracao);
  // Campo novo: papo social sozinho, sem nenhum campo do caso, tambem nao sustenta a nota — e o
  // retrato de uma reuniao que so teve conversa fora do objeto do atendimento.
  const soSocial = validarExtracao({
    contexto_pessoal_social: 'Cliente comentou sobre outro emprego e planos de carreira.',
  }, FONTE);
  checar('contexto_pessoal_social sozinho ainda e extracao vazia', soSocial.vazia === true, soSocial.extracao);
}

{
  // O campo novo (21/08/2026): papo social/pessoal tem lugar proprio, pra nao vazar pro perfil do
  // cliente nem ser confundido com honorario (ex.: salario de outro emprego, dito de passagem).
  const { extracao, avisos } = validarExtracao({
    objeto: 'ok',
    contexto_pessoal_social: 'Atua em outro emprego (advocacia empresarial), remuneracao de R$ 3.500,00 mensais, cogita mudar de carreira.',
  }, FONTE);
  checar('contexto_pessoal_social passa pelo mesmo filtro de ancoragem que os demais campos',
    !extracao.contexto_pessoal_social.includes('⚠'), extracao.contexto_pessoal_social);
  checar('nenhum aviso extra so por causa do campo novo', avisos.length === 0, avisos);
}

{
  // O index.js reusa a extracao ja gravada para nao pagar OpenAI duas vezes. Uma linha extraida sob o
  // contrato ANTIGO renderizaria um briefing sem uma unica secao: so cabecalho e rodape no negocio.
  checar('extracao do contrato atual e reconhecida', ehExtracaoAtual({ objeto: 'x' }) === true);
  checar('extracao do contrato antigo NAO passa', ehExtracaoAtual({ resumo_caso: 'x', proposta_valores: '' }) === false);
  checar('lixo nao passa', ehExtracaoAtual(null) === false && ehExtracaoAtual('x') === false);
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
  // O caso real do aluno de medicina (mandado de seguranca negado no TRF3 por deficiencia tecnica do
  // patrono anterior, agora com nova negativa expressa) — o mesmo caso que motivou a fusao pra 3
  // secoes em 20/08/2026 e a reversao pra 5 secoes em 21/08/2026, depois de testar contra um segundo
  // caso real (assessoria administrativa de Fies) que expos a falta do contexto do cliente e do papo
  // social/pessoal ter lugar proprio.
  const marcador = marcadorNota('m1', 'd1');
  const EXTRACAO = {
    perfil_qualificacao: 'Aluno de Medicina no ultimo periodo, aprovado em 1o lugar.',
    historico_processual_anterior: 'Mandado de seguranca extinto no TRF3 por deficiencia tecnica do patrono anterior.',
    situacao_atual_urgencia: 'Nova negativa expressa da IES; risco de perder a posse no cargo.',
    diretrizes_internas_equipe: 'Subir a transcricao no NotebookLM antes de redigir a peca.',
    objeto: 'Propositura de mandado de seguranca perante a Justica Federal.',
    via_eleita_foro: 'Mandado de seguranca, mesmo juizo por prevencao.',
    fundamentacao_legal: 'Principio da razoabilidade e teoria do fato consumado.',
    superacao_obices: '',
    contexto_pessoal_social: 'Pretende migrar de carreira apos concluir a formacao em Medicina.',
    honorarios: [
      { etapa: 'Entrada / Início da Ação', valor: 'R$ 5.000,00', condicao: 'protocolo em 1o e 2o graus' },
      { etapa: 'Êxito Final', valor: 'R$ 10.000,00', condicao: '' },
    ],
  };
  const meta = { dataBr: '14/08/2026', tituloEvento: 'Consulta — Lia (Berto)', metodo: 'evento_telefone', confianca: 'alta' };
  const texto = montarTextoNota({ extracao: EXTRACAO, meta, avisos: [], marcador });

  checar('titulo do briefing no topo', texto.startsWith('📄 BRIEFING DE ATENDIMENTO E ALINHAMENTO ESTRATÉGICO'), texto.slice(0, 70));
  checar('a data e o titulo do evento no cabecalho', texto.includes('— 14/08/2026 (Consulta — Lia (Berto))'), texto.slice(0, 120));
  checar('as cinco secoes na ordem', /1\. CONTEXTO[\s\S]*2\. DO OBJETO[\s\S]*3\. DA ESTRATÉGIA[\s\S]*4\. DA PROPOSTA[\s\S]*5\. CONTEXTO PESSOAL/.test(texto), texto);
  checar('rotulo com valor vira bullet', texto.includes('• Perfil/Qualificação: Aluno de Medicina'), texto);
  checar('rotulo VAZIO some do bullet', !texto.includes('Superação de Óbices'), texto);
  checar('secao 2 e texto corrido, sem bullet', texto.includes('📌 2. DO OBJETO\nPropositura'), texto);
  checar('honorario com condicao usa travessao', texto.includes('• Entrada / Início da Ação: R$ 5.000,00 — protocolo em 1o e 2o graus'), texto);
  checar('honorario sem condicao nao deixa travessao solto', texto.includes('• Êxito Final: R$ 10.000,00\n'), texto);
  checar('secao 5 (campo novo) e texto corrido', texto.includes('🗒️ 5. CONTEXTO PESSOAL/SOCIAL\nPretende migrar'), texto);
  checar('nota termina com o marcador', texto.trim().endsWith(marcador), texto.slice(-60));
  checar('disclaimer de IA presente', texto.includes('gerado por IA'));
  checar('metodo de vinculo impresso para auditoria', texto.includes('Vínculo: evento_telefone'), texto);
  // O `description` do Moskit e exibido cru: sintaxe nao renderizada viraria sujeira justamente no
  // documento que o advogado abre antes de redigir.
  checar('nota em texto puro, sem Markdown', !/\*\*|^#/m.test(texto), texto);

  // Funcao pura: mesma entrada, mesmo texto — e o que permite comparar contra o que esta no CRM.
  const denovo = montarTextoNota({ extracao: EXTRACAO, meta, avisos: [], marcador });
  checar('montarTextoNota e deterministica', texto === denovo);
}

{
  // Secao com TODOS os rotulos vazios some inteira. E o motivo de o prompt proibir "nao informado":
  // um titulo seguido de tres rotulos vazios ocupa espaco afirmando que se sabe alguma coisa.
  const texto = montarTextoNota({
    extracao: { objeto: 'So o objeto foi dito.', honorarios: [] },
    meta: {},
    avisos: [],
    marcador: marcadorNota('m4', 'd4'),
  });

  checar('secao 1 inteira vazia some', !texto.includes('CONTEXTO DO CLIENTE'), texto);
  checar('secao 3 inteira vazia some', !texto.includes('ESTRATÉGIA JURÍDICA'), texto);
  checar('honorarios vazio omite a secao 4', !texto.includes('PROPOSTA DE HONORÁRIOS'), texto);
  checar('secao 5 (campo novo) vazia tambem some', !texto.includes('CONTEXTO PESSOAL'), texto);
  checar('o que existe continua aparecendo', texto.includes('📌 2. DO OBJETO'), texto);
}

{
  const texto = montarTextoNota({
    extracao: { objeto: 'x' },
    meta: { truncou: true, semTranscricao: true, metodo: 'atividade_moskit', confianca: 'media' },
    avisos: ['honorarios (Êxito Final): valor "R$ 9.900,00" não aparece no texto da reunião'],
    marcador: marcadorNota('m2', null),
  });
  checar('truncagem avisada na nota', texto.includes('TRECHO INICIAL foi omitido'));
  checar('ausencia de transcricao avisada', texto.includes('Sem transcrição literal'));
  checar('aviso de ancoragem chega ao rodape', texto.includes('R$ 9.900,00'), texto);
}

// ------------------------------------------------------------
console.log('\n=== Nome do anexo (PDF na aba Arquivos) ===');

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

{
  const base = {
    extracao: { perfil_qualificacao: 'x' },
    avisos: [],
    marcador: marcadorNota('m3', 'd3'),
  };
  const com = montarTextoNota({ ...base, meta: { anexado: true } });
  const sem = montarTextoNota({ ...base, meta: { anexado: false } });

  checar('rodape anuncia o anexo quando ele existe', com.includes('anexada na aba Arquivos'), com);
  // O silencio e o ponto: prometer um arquivo que nao subiu manda o advogado procurar o que nao esta
  // la — pior que nao mencionar nada.
  checar('rodape NAO promete anexo quando ele falhou', !sem.includes('anexada na aba Arquivos'), sem);
  checar('sem anexo, o resto da nota fica igual', sem.includes('Resumo gerado por IA'));
}

// ------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`);
console.log(`Passou: ${passou} | Falhou: ${falhou}`);
console.log('='.repeat(50));
process.exit(falhou > 0 ? 1 : 0);
