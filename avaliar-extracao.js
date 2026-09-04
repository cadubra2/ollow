// LINHA DE BASE da qualidade da extracao. Mede, nao conserta: nada aqui escreve no banco de
// producao, no Moskit, na agenda ou no Telegram.
//
//   node avaliar-extracao.js --so-gratis          # camada 0: custo ZERO, corpus inteiro
//   node avaliar-extracao.js                      # camada 0 + replay com IA (CUSTA CREDITO)
//   node avaliar-extracao.js --limite 20          # replay em 20 conversas SORTEADAS pela seed
//   node avaliar-extracao.js --so-com-desfecho    # fora as inviavel/interno sem deal
//   node avaliar-extracao.js --rubrica            # gera avaliacoes/rubrica-20.csv para o humano
//
// O QUE ELE MEDE, e a ordem importa: o TITULO do negocio (a queixa do dono) e o RESUMO. Ate
// 02/09/2026 media so o resumo — o assunto era extraido, usado e descartado sem aparecer em numero
// nenhum. Ver "O EIXO DO TITULO" mais abaixo.
//
// CHAMA A OPENAI DE VERDADE sem --so-gratis. NUNCA rodar em CI nem no npm test (por isso o nome nao
// comeca com "test-": rodar-testes.js usa lista explicita).
//
// POR QUE ELE EXISTE: a queixa do dono e de QUALIDADE ("nao pega informacao, resumo enxuto, nao me
// da o resultado"). Sem numero por defeito, "melhorou" vira opiniao. Este script produz o numero
// contra o qual cada conserto vai ser aprovado ou revertido.
//
// DUAS CAMADAS, e a separacao e o ponto:
//   Camada 0 (gratis)  - o que o corpus JA prova sozinho: silencio historico, truncamento, anexos
//                        que viraram placeholder, e o perfil dos resumos que a producao gravou.
//   Camada 1 (paga)    - o que so o replay revela: QUAL portao (B1/B2/B3/B4) engoliu cada conversa.
//
// TRES LIMITES DE FIDELIDADE, declarados porque medicao com limite escondido e pior que nenhuma:
//   1. `attachments` NUNCA e persistido (as mensagens tem so role/text/timestamp/id_zernio). O que
//      a ingestao descartou (defeitos A3/A4/A5) nao deixou rastro no corpus - aqui so da para contar
//      o placeholder que sobrou. Medir A3/A4/A5 exige instrumentar a ingestao ao vivo.
//   2. `dadosAnteriores` sai do `last_data` gravado, que e o estado DEPOIS da ultima rodada de
//      producao, nao antes dela. Isso torna a medicao de B4 CONSERVADORA (campo ja preenchido =
//      menos pendente). `--sem-estado` roda a mesma amostra como primeira passada, para ver os dois
//      lados.
//   3. O contexto "cliente JA FOI ATENDIDO" e a rotina de cliente-que-volta leem tabelas que vivem
//      no DB_PATH descartavel, entao nao disparam no replay. Elas so afetam conversa com deal_id +
//      consulta passada registrada, e o efeito seria MAIS silencio, nao menos.
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

// ------------------------------------------------------------------------------------------------
// As quatro protecoes do molde canonico (replay-dupla-confirmacao.js:25-28,41), na mesma ordem e
// ANTES do require('./index.js') - o boot do index.js roda ALTER TABLE no banco que DB_PATH aponta.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `avaliar-extracao-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
// A quinta, que o molde nao tem: as credenciais de ESCRITA apontadas para o nada. Chave invalida
// ainda bate na API real; a porta de descarte (127.0.0.1:9) falha na hora e alto. Se algum caminho
// de escrita for chamado por engano, ele quebra em vez de gravar no CRM de producao.
for (const k of ['MOSKIT_BASE', 'ZAPSIGN_BASE']) process.env[k] = 'http://127.0.0.1:9';
for (const k of ['MOSKIT_API_KEY', 'ZAPSIGN_API_KEY']) if (process.env[k]) process.env[k] = 'SENTINELA-AVALIACAO';
// ------------------------------------------------------------------------------------------------

const Database = require('better-sqlite3');
const bot = require('./index.js');
const { validarObservacoes } = require('./src/evidencia');
const { apurarDuplaConfirmacao } = require('./src/agendamento');
const { chaveConversa, ehInterno } = require('./src/telefone');
const MOSKIT_IDS = require('./src/moskit-ids');
// tokensDoTexto: normalizacao + descarte de stopword, reusada para medir ANCORAGEM do assunto. A
// lista de stopwords dele e orientada a NOME de pessoa ('de', 'da', 'dr'...), mas e justamente essa
// parte que atrapalharia a comparacao de assunto — o resto dos tokens e o que interessa.
const duplicidade = require('./src/duplicidade');
const { escreverCsv } = require('./src/csv');

const CAMINHO_BANCO = process.env.CONVERSATIONS_DB || 'conversations.db';
const DIR_SAIDA = 'avaliacoes';
const CAMPOS_EXTRAIDOS = [
  'nome', 'assunto', 'origem', 'advogado_responsavel', 'captacao', 'tipo_consulta', 'area_direito',
  'pagamento_confirmado', 'data_hora_consulta', 'email_cliente', 'estagio_funil_sugerido',
  'modalidade_consulta', 'status_negocio_sugerido', 'motivo_perda_sugerido', 'resumo_atendimento',
  'cpf', 'profissao', 'estado_civil', 'endereco', 'valor_honorarios_inicial',
  'valor_honorarios_liminar', 'valor_mensalidade',
];
// Preco por 1M de tokens em USD. TABELA QUE ENVELHECE - conferir na pagina de precos antes de citar
// o custo em qualquer decisao. Modelo fora da tabela sai com custo null, nunca com um chute.
const PRECOS = {
  'gpt-4o-mini': { entrada: 0.15, saida: 0.60 },
};

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(nome);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};
const tem = (nome) => process.argv.includes(nome);

const OPCOES = {
  soGratis: tem('--so-gratis'),
  rubrica: tem('--rubrica'),
  semEstado: tem('--sem-estado'),
  // Exclui do replay a conversa que nunca teve desfecho (inviavel/interno e sem deal). Existe porque
  // `--limite 30` sem ele gastava a amostra em silencio legitimo: das 277 conversas do corpus, 197
  // sao `inviavel` e 10 `interno`, entao uma fatia de 30 virava ~22 B1 e media quase nada do que
  // interessa. Sem a flag o comportamento e o de antes: corpus inteiro.
  soComDesfecho: tem('--so-com-desfecho'),
  limite: Number(arg('--limite', 0)) || 0,
  concorrencia: Number(arg('--concorrencia', 4)) || 4,
  seed: Number(arg('--seed', 42)),
};

// PRNG deterministico (mulberry32): a amostra da rubrica tem de ser a MESMA em toda rodada, senao
// duas pessoas avaliam conversas diferentes e a comparacao da Fase 3 nao fecha.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const embaralhar = (lista, seed) => {
  const r = prng(seed);
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const mediana = (nums) => {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : '-');
const linha = (c = '-') => console.log(c.repeat(96));
// A string 'null' entra na lista porque o modelo a devolve como texto, e camposPendentes (index.js)
// trata exatamente do mesmo jeito. Duas reguas diferentes para "vazio" dariam duas medidas.
const estaPreenchido = (v) => v !== null && v !== undefined && v !== '' && v !== 'null';

// "Teve desfecho" = o pipeline chegou a alguma conclusao sobre a conversa. Allowlist explicita em vez
// de negar inviavel/interno: acao nova que apareca no futuro fica de fora ate alguem decidir, o que
// e o lado seguro para uma amostra de medicao.
const ACOES_COM_DESFECHO = new Set(['criar', 'atualizar_campos', 'nota', 'aguardar']);
const temDesfecho = (r) => !!r.deal_id || ACOES_COM_DESFECHO.has(r.last_action);
// Os literais que o prompt MANDAVA escrever quando faltava dado, e que a Fase 2 proibiu. Contar nos
// dois lados (o gravado pela producao, na camada 0, e o produzido no replay, na camada 1) e o que
// permite dizer se a mudanca de prompt pegou.
const RE_LITERAL = /(Nao mencionado|Não mencionado|Nada mencionado|Nao informado|Não informado)/g;
const contarLiterais = (t) => (String(t || '').match(RE_LITERAL) || []).length;

// ================================================================================================
// O EIXO DO TITULO — o que este instrumento nao media
//
// A queixa do dono e sobre o NOME DO NEGOCIO ("nome do negocio so com consulta juridica e nao do que
// se trata o caso da pessoa"). Este script media o resumo em detalhe e **descartava o assunto**: o
// replay guardava `resumo_novo` e nem o valor nem o desfecho do titulo apareciam em lugar nenhum.
// Medir "o campo assunto estava preenchido" e outra pergunta — "Consulta juridica" esta preenchido e
// nao serve. As quatro classes abaixo separam as duas coisas.
// ================================================================================================
const assuntoEhNomeDeArea = (assunto) => !!assunto && !!MOSKIT_IDS.buscarOpcao(MOSKIT_IDS.INDICE_BUSCA.AREA_DIREITO, assunto);

function classificarTitulo(dados) {
  const assunto = dados?.assunto;
  // Sem assunto nao ha sufixo e o deal fica so com o nome do cliente (montarPayloadMoskit).
  if (!assunto) return 'titulo_so_nome';
  if (bot.ehAssuntoNeutro(assunto)) return 'titulo_generico';
  // Deve ser SEMPRE zero depois de rejeitarAssuntoQueEhArea: e a regressao de tolerancia zero da
  // Fase 1. Se aparecer, a protecao vazou.
  if (assuntoEhNomeDeArea(assunto)) return 'assunto_igual_a_area';
  return 'assunto_especifico';
}

// Fracao dos tokens de conteudo do assunto que aparecem LITERALMENTE no texto da conversa.
//
// ⚠️ DIAGNOSTICO, NAO PORTAO — e a medicao provou por que. O plano da Fase 1 propunha exigir ">=50%
// dos tokens de conteudo presentes no texto" como protecao substituta para liberar `indicou_tema`.
// MEDIDO em 02/09/2026, chat 558695411529: o cliente escreveu "os documentos necessario", "comprei
// uma casa da minha mae", "acordo de compra e vendas"; o modelo devolveu "Documentacao de
// Propriedade Imobiliaria" — caracterizacao juridica CORRETA e util, e ancoragem ZERO, porque
// nenhuma dessas palavras foi dita ("documentos" != "documentacao" como token, "casa" != "imovel",
// "propriedade" nunca apareceu). Na mesma rodada o PLACEHOLDER "Consulta juridica" pontuou 0,5,
// porque a palavra "consulta" aparece em qualquer conversa de escritorio. Um portao assim reprovaria
// a sintese boa e aprovaria o placeholder — exatamente ao contrario do que se quer.
//
// A confusao no plano era entre duas coisas diferentes: ancorar o TRECHO da observacao (citacao
// literal de uma mensagem, que `conferirTrecho` em src/evidencia.js JA exige e que e impossivel
// fabricar a partir do prompt) e ancorar as PALAVRAS do assunto, que e uma sintese por natureza. A
// protecao correta e a primeira; esta metrica serve para o outro caso, o de invencao do nada — no
// incidente 48423360 o modelo derivou "Direito Digital" do perfil de um socio escrito NO PROMPT, e
// ali a ancoragem zero aponta o problema de verdade. Ler junto com `titulo_classe`, nunca sozinha.
//
// null quando o assunto nao tem token de conteudo.
function ancoragemDoAssunto(assunto, msgs) {
  const alvo = duplicidade.tokensDoTexto(assunto);
  if (!alvo.length) return null;
  const universo = new Set(duplicidade.tokensDoTexto((msgs || []).map((m) => m?.text || '').join(' ')));
  return Number((alvo.filter((t) => universo.has(t)).length / alvo.length).toFixed(2));
}

// Linhas do resumo que o advogado de fato aproveita. O resumo vem em topicos "emoji Rotulo:
// conteudo", e um topico cujo conteudo e "Nao mencionado" e uma linha que ocupa espaco e nao informa
// — o defeito que o dono descreve como "resumo que nao me da o resultado". Contar CARACTERES nao
// distingue os dois; contar linhas uteis distingue.
function linhasUteisDoResumo(resumo) {
  let uteis = 0;
  for (const bruta of String(resumo || '').split('\n')) {
    const l = bruta.trim();
    if (!l) continue;
    const conteudo = (l.includes(':') ? l.slice(l.indexOf(':') + 1) : l).replace(RE_LITERAL, '').trim();
    if (conteudo.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) uteis += 1;
  }
  return uteis;
}

const contarPorTipo = (lista) => (Array.isArray(lista) ? lista : []).reduce((acc, o) => {
  const t = o?.tipo || '(sem tipo)';
  return { ...acc, [t]: (acc[t] || 0) + 1 };
}, {});

// ================================================================================================
// CAMADA 0 - gratis, deterministica, corpus inteiro
// ================================================================================================
// Duas geracoes de marcador convivem no corpus: o do webhook ("cliente enviou: arquivo.pdf",
// index.js:4901-4911) e o do polling ("cliente enviou image"). As duas contam - as duas significam
// a mesma coisa para o modelo: conteudo que ele nunca viu.
const RE_PLACEHOLDER = /\u{1F4CE}/u;
const RE_TIPO_PLACEHOLDER = /\[(cliente|equipe) enviou:?\s*(?:um |uma )?([^\]]*)\]/u;

function camada0(db) {
  const rows = db.prepare('SELECT chat_id, contact_name, phone, deal_id, messages, last_data, last_action FROM conversations').all();

  const porAcao = {};
  let msgsTotal = 0;
  let acima100 = 0;
  let placeholders = 0;
  let audios = 0;
  let perdidos = 0;
  let perdidosDoCliente = 0;
  const porTipoPlaceholder = {};
  const convsComPlaceholder = new Set();
  const tamanhos = [];

  for (const r of rows) {
    const chave = r.last_action || '(sem acao)';
    porAcao[chave] = (porAcao[chave] || 0) + 1;
    let msgs = [];
    try { msgs = JSON.parse(r.messages || '[]'); } catch { msgs = []; }
    msgsTotal += msgs.length;
    tamanhos.push(msgs.length);
    if (msgs.length > 100) acima100 += 1;
    for (const m of msgs) {
      const t = String(m.text || '');
      if (!RE_PLACEHOLDER.test(t)) continue;
      placeholders += 1;
      convsComPlaceholder.add(r.chat_id);
      const g = t.match(RE_TIPO_PLACEHOLDER);
      const tipo = g ? g[2].trim() : '';
      const rotulo = g ? `${g[1]} - ${/\.[a-z0-9]{2,4}$/i.test(tipo) ? 'arquivo nomeado' : tipo}` : 'outro';
      porTipoPlaceholder[rotulo] = (porTipoPlaceholder[rotulo] || 0) + 1;
      // AUDIO NAO ENTRA NO DEFEITO. Ele e baixado e transcrito no proprio caminho de audio
      // (index.js:6503-6507) e a transcricao ENTRA no historico — o placeholder e so o rastro do
      // primeiro momento. Somar audio ao resto infla A1/A2 com conteudo que nao se perdeu.
      if (/audio/i.test(tipo)) { audios += 1; continue; }
      perdidos += 1;
      if (g && g[1] === 'cliente') perdidosDoCliente += 1;
    }
  }

  // Perfil do resumo e preenchimento de campo a partir do que a producao DE FATO gravou.
  const comDados = rows.filter((r) => r.last_data && r.last_data !== '' && r.last_data !== '{}');
  const preenchimento = Object.fromEntries(CAMPOS_EXTRAIDOS.map((c) => [c, 0]));
  const tamResumo = [];
  let semResumo = 0;
  let literais = 0;
  for (const r of comDados) {
    let d = {};
    try { d = JSON.parse(r.last_data); } catch { continue; }
    for (const c of CAMPOS_EXTRAIDOS) if (estaPreenchido(d[c])) preenchimento[c] += 1;
    const res = d.resumo_atendimento;
    if (!res) { semResumo += 1; continue; }
    // [...str].length e nao String.length: o resumo tem seis emoji de topico e cada um vale DUAS
    // unidades UTF-16. Contar unidades inflava a mediana em ~4 chars que nenhum leitor ve.
    tamResumo.push([...String(res)].length);
    literais += contarLiterais(res);
  }

  return {
    conversas: rows.length,
    mensagens: msgsTotal,
    por_acao: porAcao,
    acima_de_100_mensagens: acima100,
    mensagens_mediana: mediana(tamanhos),
    placeholders_de_anexo: placeholders,
    placeholders_de_audio_transcrito: audios,
    conteudo_perdido: perdidos,
    conteudo_perdido_do_cliente: perdidosDoCliente,
    conversas_com_placeholder: convsComPlaceholder.size,
    placeholders_por_tipo: porTipoPlaceholder,
    com_last_data: comDados.length,
    sem_resumo: semResumo,
    resumo_chars: { min: Math.min(...tamResumo), mediana: mediana(tamResumo), max: Math.max(...tamResumo) },
    literais_nao_mencionado: literais,
    literais_por_resumo: tamResumo.length ? Number((literais / tamResumo.length).toFixed(2)) : null,
    preenchimento_por_campo: preenchimento,
    base_do_preenchimento: comDados.length,
  };
}

function imprimirCamada0(c) {
  linha('=');
  console.log('CAMADA 0 - o que o corpus prova sozinho (custo zero)');
  linha('=');
  console.log(`corpus: ${c.conversas} conversas / ${c.mensagens} mensagens (mediana ${c.mensagens_mediana} msgs por conversa)`);
  console.log('\nsilencio historico, por last_action gravado:');
  for (const [k, v] of Object.entries(c.por_acao).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(k).padEnd(18)} ${String(v).padStart(4)}  ${pct(v, c.conversas)}`);
  }
  console.log(`\nA6 truncamento - conversas com mais de 100 mensagens: ${c.acima_de_100_mensagens} (${pct(c.acima_de_100_mensagens, c.conversas)})`);
  console.log('   o polling le limit:100 sortOrder:asc sem paginar (index.js:5491) - nessas, o MEIO da conversa nao chega ao modelo');
  console.log(`\nA1/A2 mensagens que sao so placeholder: ${c.placeholders_de_anexo}, em ${c.conversas_com_placeholder} conversas`);
  console.log(`   audio (transcrito depois - NAO e perda): ${c.placeholders_de_audio_transcrito}`);
  console.log(`   conteudo de fato PERDIDO: ${c.conteudo_perdido} mensagens - ${c.conteudo_perdido_do_cliente} delas do CLIENTE`);
  console.log('   documento e imagem nao tem OCR nem parse em lugar nenhum (index.js:4901-4911): o modelo recebe a string, nunca o conteudo');
  for (const [k, v] of Object.entries(c.placeholders_por_tipo).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(k).padEnd(28)} ${String(v).padStart(4)}`);
  }
  console.log(`\nC1/C2 perfil dos ${c.com_last_data} resumos que a producao gravou (${c.sem_resumo} sem resumo nenhum):`);
  console.log(`   tamanho em chars: min ${c.resumo_chars.min} - mediana ${c.resumo_chars.mediana} - max ${c.resumo_chars.max}`);
  console.log(`   literais "nao/nada mencionado": ${c.literais_nao_mencionado} no total - ${c.literais_por_resumo} por resumo, de 6 linhas possiveis`);
  console.log(`\npreenchimento por campo (base: ${c.base_do_preenchimento} conversas com last_data):`);
  for (const [campo, n] of Object.entries(c.preenchimento_por_campo).sort((a, b) => a[1] - b[1])) {
    const barra = '#'.repeat(Math.round((n / c.base_do_preenchimento) * 30));
    console.log(`   ${campo.padEnd(26)} ${String(n).padStart(3)}/${c.base_do_preenchimento} ${pct(n, c.base_do_preenchimento).padStart(6)} ${barra}`);
  }
}

// ================================================================================================
// CAMADA 1 - replay com IA, atribuindo cada silencio ao portao que o causou
// ================================================================================================
// A cadeia abaixo espelha processarConversaDirect na ORDEM do arquivo. processarConversaDirect NAO e
// chamada de proposito: ela escreve no banco, no Moskit e na agenda.
async function replayConversa(row, db) {
  const t0 = Date.now();
  const registro = { chat_id: row.chat_id, contato: row.contact_name, deal_id: row.deal_id || null };
  let msgs = [];
  try { msgs = JSON.parse(row.messages || '[]'); } catch { msgs = []; }
  registro.mensagens = msgs.length;

  const phoneClean = chaveConversa(row.phone) || chaveConversa(row.chat_id);
  if (ehInterno(phoneClean) || ehInterno(row.chat_id)) {
    return { ...registro, portao: 'interno', resumo_produzido: false };
  }
  if (!msgs.length) return { ...registro, portao: 'vazia', resumo_produzido: false };

  const inicio = bot.janelaAtendimento(row);
  const historico = bot.montarHistorico(msgs, { inicio });
  const temDeal = !!row.deal_id;
  const dataAtual = msgs[msgs.length - 1]?.timestamp || new Date().toISOString();

  let dadosAnteriores = null;
  if (!OPCOES.semEstado && row.last_data && row.last_data !== '{}') {
    try { dadosAnteriores = JSON.parse(row.last_data); } catch { dadosAnteriores = null; }
  }
  // infoCliente sai da moskit_contacts do corpus REAL (index.js:3875 le a mesma tabela). Sem isso o
  // prompt receberia "Nao" para todo mundo e a classificacao mudaria por artefato da medicao.
  const contato = db.prepare('SELECT name FROM moskit_contacts WHERE phone = ?').get(phoneClean || '');
  const infoCliente = contato ? `Sim - ${contato.name}` : 'Nao';

  let consultaAnterior = { realizada: false };
  try { consultaAnterior = bot.consultaDoAtendimento(row); } catch { /* tabela vive no DB_PATH descartavel */ }
  const contextoCrm = [
    temDeal ? `negocio ${row.deal_id} ja existe no CRM` : 'nenhum negocio criado ainda',
    row.evento_calendar_criado ? 'consulta JA lancada na agenda' : 'consulta ainda NAO lancada na agenda',
    consultaAnterior.realizada ? 'este cliente JA FOI ATENDIDO' : '',
  ].filter(Boolean).join('; ');

  // O contador de tokens e de MODULO, e quatro conversas correm em paralelo — zerar aqui misturaria
  // os contadores das quatro e o custo por conversa sairia sem significado. O total vem de uma
  // leitura unica no fim (camada1); o delta por conversa so e confiavel com --concorrencia 1, e e
  // exatamente nessa condicao que ele e reportado. Numero que so vale as vezes tem de dizer quando.
  const usoAntes = bot.lerUsoIA();
  const usoDelta = () => {
    if (OPCOES.concorrencia !== 1) return null;
    const a = bot.lerUsoIA();
    return {
      chamadas: a.chamadas - usoAntes.chamadas,
      prompt_tokens: a.prompt_tokens - usoAntes.prompt_tokens,
      completion_tokens: a.completion_tokens - usoAntes.completion_tokens,
    };
  };

  const classificacao = await bot.classificarConversa(historico, contextoCrm);
  registro.classificacao = classificacao?.classificacao || null;
  if (classificacao?.classificacao === 'inviavel') {
    return {
      ...registro, portao: 'B1_inviavel', justificativa: classificacao.justificativa || '',
      resumo_produzido: false, uso: usoDelta(), ms: Date.now() - t0,
    };
  }

  const result = await bot.extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual);
  const dados = result?.dados || {};
  // O assunto CRU, antes de qualquer saneamento. E a unica forma de saber quantas vezes o modelo
  // devolve nome de area como assunto: rejeitarAssuntoQueEhArea troca o valor por "Consulta
  // juridica" mais adiante, e depois disso a evidencia do erro original desapareceu.
  registro.assunto_bruto = dados.assunto || null;
  const resumo = dados.resumo_atendimento || '';
  registro.resumo_produzido = !!resumo;
  registro.resumo_chars = [...resumo].length; // pontos de codigo, a MESMA regua da camada 0
  registro.resumo_novo = resumo;
  registro.literais = contarLiterais(resumo);
  // NOMES dos campos preenchidos, nunca os valores: guardar o conteudo aqui aumentaria a superficie
  // de dado pessoal do arquivo bruto sem medir nada a mais.
  //
  // DOIS objetos, porque confundi-los ja gerou leitura errada: `campos_da_rodada` e a extracao CRUA
  // desta passada (depois de sanitizarClassificacao, que anula area/advogado quando ninguem
  // descreveu o caso), e `campos_acumulados` e o estado MESCLADO, que e o que de fato vai ao CRM.
  // A camada 0 le `last_data`, que e acumulado — comparar a rodada crua com ela mede coisas
  // diferentes e faz o gate do caso descrito parecer regressao.
  registro.campos_da_rodada = CAMPOS_EXTRAIDOS.filter((c) => estaPreenchido(dados[c]));
  registro.confianca = result?.confianca ?? 0;
  registro.acao_do_modelo = result?.acao || null;

  const { validas: obsTodas } = validarObservacoes(result?.observacoes, msgs);
  const obsValidas = inicio > 0 ? obsTodas.filter((o) => o.msg_idx >= inicio) : obsTodas;
  // EMITIDAS x VALIDAS por tipo. A diferenca entre as duas e o que validarObservacoes/conferirTrecho
  // reprovaram — e e o numero que decide se um tipo de evidencia novo (a Fase 1a propoe
  // `cliente_indicou_tema`) esta sendo emitido pelo modelo mas barrado na conferencia, ou se o modelo
  // simplesmente nao o emite. Sao consertos opostos, e sem separar isso a escolha e chute.
  registro.obs_emitidas_por_tipo = contarPorTipo(result?.observacoes);
  registro.obs_validas_por_tipo = contarPorTipo(obsValidas);
  const apuracao = apurarDuplaConfirmacao(obsValidas);
  const blocoEnviado = bot.equipeEnviouCondicoesDeValor(msgs, { inicio });

  bot.aplicarPadroesDeterministicosDeOrigem(dados, msgs);
  const { casoDescrito } = bot.sanitizarClassificacao(dados, obsValidas);
  registro.caso_descrito = !!casoDescrito;
  // Funcao pura, sem rede: da para medir o acumulado em TODA conversa que chegou a extracao, nao so
  // no ramo atualizar_campos. E este e o eixo comparavel com o preenchimento da camada 0.
  const acumulado = bot.mesclarParaCrm(dadosAnteriores, dados, obsValidas);
  registro.campos_acumulados = CAMPOS_EXTRAIDOS.filter((c) => estaPreenchido(acumulado[c]));

  // Os VALORES de assunto/area/advogado, nao so os nomes dos campos preenchidos. A regra geral deste
  // arquivo e guardar nome de campo e nunca conteudo, para nao ampliar a superficie de dado pessoal —
  // mas `resumo_novo` ja e guardado inteiro, e sem o VALOR do assunto nao ha como responder "o titulo
  // serve?", que e a pergunta do dono. O arquivo bruto ja esta no .gitignore por conter caso de
  // cliente; o agregado versionavel continua recebendo so contagens.
  registro.assunto_novo = acumulado.assunto || null;
  registro.area_novo = acumulado.area_direito || null;
  registro.advogado_novo = acumulado.advogado_responsavel || null;
  registro.assunto_ancorado = ancoragemDoAssunto(acumulado.assunto, msgs);
  registro.linhas_uteis_do_resumo = linhasUteisDoResumo(resumo);
  registro.titulo_classe = classificarTitulo(acumulado);
  // O titulo pela FUNCAO DA PRODUCAO, nunca por uma copia da regra `${nome} - ${assunto}`: e ela que
  // aplica removerEmoji e o fallback "Cliente sem nome", e uma copia divergiria no dia em que ela
  // mudasse. Nao faz rede — monta payload e devolve.
  registro.titulo_do_deal = bot.montarPayloadMoskit(acumulado, 0).name;

  const acao = result?.acao;
  if (acao === 'criar' && registro.confianca < 6) {
    return { ...registro, portao: 'B2_confianca_baixa', uso: usoDelta(), ms: Date.now() - t0 };
  }
  if (bot.deveEsperarCasoDescrito(acao, casoDescrito, apuracao, blocoEnviado)) {
    return { ...registro, portao: 'B3_sem_caso_descrito', uso: usoDelta(), ms: Date.now() - t0 };
  }
  if (acao === 'ignorar' || acao === 'aguardar') {
    return { ...registro, portao: `modelo_${acao}`, uso: usoDelta(), ms: Date.now() - t0 };
  }

  if (acao === 'atualizar_campos') {
    const dadosMesclados = bot.mesclarParaCrm(dadosAnteriores, dados, obsValidas);
    const pendentes = bot.camposPendentes(dadosMesclados);
    registro.pendentes = pendentes;
    // ESTE era o defeito B4, e a assimetria era o achado: no ramo "criar" registrarBriefing e
    // chamado sem condicao (index.js:4209); aqui ele so acontecia com `pendentes.length === 0`. Um
    // campo lateral vazio e o resumo - pago, escrito, pronto - nunca virava nota nenhuma.
    //
    // O espelho SEGUE A FLAG, e isso e o que torna a medicao honesta: rodar com
    // BRIEFING_SEM_PENDENTES=false reproduz a linha de base antiga (o portao volta), e rodar com ela
    // ligada mostra o portao zerado. Um espelho que ignorasse a flag reportaria B4 para sempre e a
    // comparacao antes/depois nao mediria nada.
    if (pendentes.length > 0) {
      const engolido = process.env.BRIEFING_SEM_PENDENTES === 'false';
      return {
        ...registro,
        portao: engolido ? 'B4_briefing_engolido' : 'ok_atualizar_campos_com_lacuna',
        resumo_descartado: engolido && !!resumo,
        uso: usoDelta(), ms: Date.now() - t0,
      };
    }
    return { ...registro, portao: 'ok_atualizar_campos', uso: usoDelta(), ms: Date.now() - t0 };
  }

  return { ...registro, portao: `ok_${acao || 'desconhecida'}`, uso: usoDelta(), ms: Date.now() - t0 };
}

async function camada1(db, alvos) {
  const resultados = [];
  const fila = [...alvos];
  let feitos = 0;
  bot.zerarUsoIA(); // uma vez, aqui: o total da rodada e a diferenca entre este zero e a leitura final
  const trabalhador = async () => {
    for (;;) {
      const row = fila.shift();
      if (!row) return;
      // Retentativa com espera crescente SO para rate limit. O replay dispara ~600 chamadas em
      // poucos minutos e estoura o teto de tokens por minuto da conta — MEDIDO: 163 de 277 conversas
      // morreram assim na primeira rodada completa. Repetir a conversa inteira e seguro porque nada
      // aqui escreve; qualquer outro erro NAO e repetido, para nao mascarar defeito de verdade.
      let ultimo = null;
      for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
        try {
          resultados.push(await replayConversa(row, db));
          ultimo = null;
          break;
        } catch (e) {
          ultimo = e;
          if (!/rate limit|429|tokens per min|TPM/i.test(e.message) || tentativa === 4) break;
          await new Promise((r) => setTimeout(r, 4000 * tentativa));
        }
      }
      if (ultimo) resultados.push({ chat_id: row.chat_id, contato: row.contact_name, portao: 'erro', erro: ultimo.message });
      feitos += 1;
      if (feitos % 10 === 0 || feitos === alvos.length) process.stdout.write(`\r   replay: ${feitos}/${alvos.length}   `);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, OPCOES.concorrencia) }, trabalhador));
  process.stdout.write('\n');
  return resultados;
}

function imprimirCamada1(res) {
  linha('=');
  console.log('CAMADA 1 - qual portao engoliu cada conversa (replay real)');
  linha('=');
  const porPortao = {};
  for (const r of res) porPortao[r.portao] = (porPortao[r.portao] || 0) + 1;
  const total = res.length;
  for (const [k, v] of Object.entries(porPortao).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(26)} ${String(v).padStart(4)}  ${pct(v, total)}`);
  }
  // A conta tem de fechar: conversa sem portao atribuido significa cadeia replicada errado.
  const soma = Object.values(porPortao).reduce((a, b) => a + b, 0);
  console.log(`\n   soma dos portoes: ${soma} de ${total} processadas ${soma === total ? '(fecha)' : '(NAO FECHA - cadeia replicada errado)'}`);

  const engolidos = res.filter((r) => r.portao === 'B4_briefing_engolido' && r.resumo_descartado);
  const comLacuna = res.filter((r) => r.portao === 'ok_atualizar_campos_com_lacuna');
  console.log(`\nB4 - resumo produzido, pago e DESCARTADO: ${engolidos.length} conversa(s)`);
  if (comLacuna.length) {
    console.log(`     (BRIEFING_SEM_PENDENTES ligado: ${comLacuna.length} conversa(s) que ANTES eram descartadas agora`);
    console.log('      postam o briefing com a lacuna anotada no cabecalho)');
  }
  const culpados = {};
  for (const r of [...engolidos, ...comLacuna]) for (const c of (r.pendentes || [])) culpados[c] = (culpados[c] || 0) + 1;
  for (const [k, v] of Object.entries(culpados).sort((a, b) => b[1] - a[1])) {
    console.log(`   campo que ficou pendente: ${k.padEnd(24)} ${v}x`);
  }

  // Os MESMOS eixos da camada 0, sobre o resumo que o replay acabou de produzir. Sem isto nao ha
  // como dizer se uma mudanca de prompt melhorou: a camada 0 mede o que a producao gravou no passado,
  // e comparar passado com passado nao mede mudanca nenhuma.
  const comResumo = res.filter((r) => r.resumo_chars);
  const perfil = { resumos: comResumo.length };
  if (comResumo.length) {
    const tam = comResumo.map((r) => r.resumo_chars);
    const lit = comResumo.reduce((a, r) => a + (r.literais || 0), 0);
    perfil.resumo_chars = { min: Math.min(...tam), mediana: mediana(tam), max: Math.max(...tam) };
    perfil.literais_nao_mencionado = lit;
    perfil.literais_por_resumo = Number((lit / comResumo.length).toFixed(2));
    console.log(`\nresumos produzidos no replay: ${comResumo.length}`);
    console.log(`   tamanho em chars: min ${perfil.resumo_chars.min} - mediana ${perfil.resumo_chars.mediana} - max ${perfil.resumo_chars.max}`);
    console.log(`   literais "nao/nada mencionado": ${lit} no total - ${perfil.literais_por_resumo} por resumo`);
    const uteis = comResumo.map((r) => r.linhas_uteis_do_resumo || 0);
    perfil.linhas_uteis = { min: Math.min(...uteis), mediana: mediana(uteis), max: Math.max(...uteis) };
    console.log(`   linhas UTEIS (topico com conteudo, nao "nao mencionado"): min ${perfil.linhas_uteis.min} - mediana ${perfil.linhas_uteis.mediana} - max ${perfil.linhas_uteis.max}`);
  }

  // ---- O EIXO DO TITULO ----------------------------------------------------------------------
  // A queixa do dono, medida. Antes desta secao existir, nenhum numero deste script falava do nome
  // do negocio: o instrumento nao media o defeito que motivou a auditoria.
  const comTitulo = res.filter((r) => r.titulo_classe);
  const porClasse = {};
  for (const r of comTitulo) porClasse[r.titulo_classe] = (porClasse[r.titulo_classe] || 0) + 1;
  const especifico = porClasse.assunto_especifico || 0;
  const naoDizNada = (porClasse.titulo_generico || 0) + (porClasse.titulo_so_nome || 0);
  const igualArea = porClasse.assunto_igual_a_area || 0;
  // ANCORAGEM SO SOBRE ASSUNTO ESPECIFICO, e a restricao e o que torna o numero legivel. Medir se
  // "Consulta juridica" aparece literalmente na conversa nao significa nada — o placeholder nao vem
  // do texto, vem do prompt. Na primeira rodada com a metrica solta, 2 de 3 conversas eram
  // placeholder e a media caiu para 0,17, escondendo que o unico assunto real estava bem ancorado.
  // A meta da Fase 1 ("assunto_ancorado = 100%") fala do assunto que o bot AFIRMA, nao da ausencia.
  const ancoragens = comTitulo
    .filter((r) => r.titulo_classe === 'assunto_especifico')
    .map((r) => r.assunto_ancorado)
    .filter((a) => a !== null && a !== undefined);
  const ancoradosTotal = ancoragens.filter((a) => a >= 1).length;
  const ancoradosMetade = ancoragens.filter((a) => a >= 0.5).length;
  const brutoEraArea = comTitulo.filter((r) => assuntoEhNomeDeArea(r.assunto_bruto)).length;

  perfil.titulo = {
    base: comTitulo.length,
    por_classe: porClasse,
    assunto_especifico: especifico,
    titulo_nao_diz_nada: naoDizNada,
    assunto_igual_a_area: igualArea,
    assunto_bruto_era_area: brutoEraArea,
    ancoragem_media: ancoragens.length ? Number((ancoragens.reduce((a, b) => a + b, 0) / ancoragens.length).toFixed(2)) : null,
    ancorado_100pc: ancoradosTotal,
    ancorado_50pc: ancoradosMetade,
    base_da_ancoragem: ancoragens.length,
    base_da_ancoragem_e: "so os titulos assunto_especifico",
  };

  if (comTitulo.length) {
    console.log(`\nTITULO DO NEGOCIO (base: ${comTitulo.length} conversas que chegaram a extracao)`);
    for (const [k, v] of Object.entries(porClasse).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${k.padEnd(26)} ${String(v).padStart(4)}  ${pct(v, comTitulo.length)}`);
    }
    // As metas da Fase 1 do plano, impressas junto do numero: um relatorio que mostra o valor sem o
    // alvo obriga quem le a ir buscar o alvo em outro arquivo, e e assim que a meta e esquecida.
    console.log(`   → assunto_especifico ${especifico} (meta da Fase 1: >= 45 numa base de 74)`);
    console.log(`   → titulo que nao diz nada ${naoDizNada} (meta da Fase 1: <= 27 numa base de 74)`);
    console.log(`   → assunto_igual_a_area ${igualArea} ${igualArea === 0 ? '(ok, tolerancia zero)' : '🚨 REGRESSAO: a protecao vazou'}`);
    if (brutoEraArea) console.log(`      (o modelo devolveu nome de area como assunto ${brutoEraArea}x; rejeitarAssuntoQueEhArea pegou)`);
    if (ancoragens.length) {
      console.log(`   → ancoragem no texto, SO dos ${ancoragens.length} assunto(s) especifico(s): media ${perfil.titulo.ancoragem_media}`);
      console.log(`      ${ancoradosTotal} totalmente ancorado(s) · ${ancoradosMetade} acima de 50%`);
      // Sem meta numerica de proposito: ancoragem baixa aqui NAO e defeito. Assunto e sintese —
      // "Documentacao de Propriedade Imobiliaria" para quem disse "comprei uma casa" e uma boa
      // caracterizacao com ancoragem zero. Serve para achar invencao do NADA (o caso 48423360, tema
      // tirado do perfil de um socio escrito no prompt), lendo caso a caso no arquivo bruto.
      console.log('      (diagnostico, nao portao — assunto e sintese; ver o comentario de ancoragemDoAssunto)');
    }
  }

  // ---- OBSERVACOES: emitidas x validas -------------------------------------------------------
  const somar = (chave) => res.reduce((acc, r) => {
    for (const [t, n] of Object.entries(r[chave] || {})) acc[t] = (acc[t] || 0) + n;
    return acc;
  }, {});
  perfil.obs_emitidas_por_tipo = somar('obs_emitidas_por_tipo');
  perfil.obs_validas_por_tipo = somar('obs_validas_por_tipo');
  const tipos = new Set([...Object.keys(perfil.obs_emitidas_por_tipo), ...Object.keys(perfil.obs_validas_por_tipo)]);
  if (tipos.size) {
    console.log('\nOBSERVACOES por tipo — EMITIDAS pelo modelo x VALIDAS depois da conferencia de trecho literal');
    console.log(`   ${'tipo'.padEnd(28)} ${'emitidas'.padStart(9)} ${'validas'.padStart(8)} ${'reprovadas'.padStart(11)}`);
    for (const t of [...tipos].sort((a, b) => (perfil.obs_emitidas_por_tipo[b] || 0) - (perfil.obs_emitidas_por_tipo[a] || 0))) {
      const e = perfil.obs_emitidas_por_tipo[t] || 0;
      const v = perfil.obs_validas_por_tipo[t] || 0;
      console.log(`   ${t.padEnd(28)} ${String(e).padStart(9)} ${String(v).padStart(8)} ${String(e - v).padStart(11)}`);
    }
  }
  // Os dois eixos, lado a lado, com o rotulo dizendo qual e comparavel com a camada 0. A coluna
  // ACUMULADO e; a coluna RODADA nao — nela area_direito e advogado_responsavel aparecem baixos de
  // proposito, porque sanitizarClassificacao os anula quando ninguem descreveu o caso, e isso e a
  // regra funcionando, nao regressao.
  const comCampos = res.filter((r) => r.campos_acumulados || r.campos_da_rodada);
  const daRodada = Object.fromEntries(CAMPOS_EXTRAIDOS.map((c) => [c, 0]));
  const acumulados = Object.fromEntries(CAMPOS_EXTRAIDOS.map((c) => [c, 0]));
  for (const r of comCampos) {
    for (const c of (r.campos_da_rodada || [])) daRodada[c] += 1;
    for (const c of (r.campos_acumulados || [])) acumulados[c] += 1;
  }
  perfil.preenchimento_da_rodada = daRodada;
  perfil.preenchimento_acumulado = acumulados;
  perfil.base_do_preenchimento = comCampos.length;
  if (comCampos.length) {
    console.log(`\npreenchimento por campo (base: ${comCampos.length} conversas que chegaram a extracao)`);
    console.log('   ACUMULADO = estado mesclado, o que vai ao CRM — comparavel com a camada 0');
    console.log('   RODADA    = extracao crua desta passada — NAO comparavel (o gate do caso descrito anula area/advogado)');
    console.log(`   ${'campo'.padEnd(26)} ${'ACUMULADO'.padStart(12)} ${'RODADA'.padStart(12)}`);
    for (const [campo, n] of Object.entries(acumulados).sort((a, b) => b[1] - a[1])) {
      if (!n && !daRodada[campo]) continue;
      console.log(`   ${campo.padEnd(26)} ${pct(n, comCampos.length).padStart(12)} ${pct(daRodada[campo], comCampos.length).padStart(12)}`);
    }
  }

  // Leitura UNICA do contador de modulo: exata com qualquer concorrencia, ao contrario de somar
  // deltas por conversa.
  const bruto = bot.lerUsoIA();
  const uso = { chamadas: bruto.chamadas, entrada: bruto.prompt_tokens, saida: bruto.completion_tokens };
  const modelo = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const p = PRECOS[modelo];
  const custo = p ? (uso.entrada / 1e6) * p.entrada + (uso.saida / 1e6) * p.saida : null;
  console.log(`\ncusto MEDIDO (usage da propria API, nao estimativa) - modelo ${modelo}:`);
  console.log(`   ${uso.chamadas} chamadas - ${uso.entrada} tokens de entrada - ${uso.saida} de saida`);
  console.log(`   ${custo === null
    ? 'modelo fora da tabela de precos - custo nao calculado'
    : `US$ ${custo.toFixed(4)} no total - US$ ${(custo / Math.max(1, total)).toFixed(5)} por conversa`}`);
  const lat = res.filter((r) => r.ms).map((r) => r.ms);
  if (lat.length) console.log(`   latencia por conversa: mediana ${mediana(lat)} ms - max ${Math.max(...lat)} ms`);
  return {
    por_portao: porPortao, b4_descartados: engolidos.length, campos_que_seguraram: culpados,
    perfil_do_resumo: perfil, uso, custo_usd: custo, modelo,
  };
}

// ================================================================================================
// Rubrica humana - 20 conversas JULGAVEIS, estratificadas, reprodutiveis por seed
//
// Eram 40 linhas, e 18 delas tinham as DUAS colunas de resumo vazias — so 16 comparavam de fato.
// Uma rubrica com 45% de linhas em branco nao e uma amostra maior, e uma amostra menor com trabalho
// extra: o dono abre a planilha, encontra linha sem nada para julgar e perde a confianca no
// instrumento. A atencao dele e o recurso escasso aqui, nao o numero de linhas.
//
// Duas mudancas, alem do tamanho:
//   - So entra conversa com ALGO A JULGAR (resumo gravado ou resumo novo). "Nao ha resumo" e um
//     numero que a camada 0 ja da; nao precisa de julgamento humano.
//   - A coluna `titulo_do_deal_serve__sim_nao` passa a existir. A rubrica antiga perguntava sobre
//     campos e sobre o atendimento, e nao perguntava sobre o TITULO — o defeito que o dono relatou.
// ================================================================================================
function gerarRubrica(db, replay) {
  const porChat = new Map((replay || []).map((r) => [r.chat_id, r]));
  const resumoGravado = (r) => { try { return JSON.parse(r.last_data || '{}').resumo_atendimento || ''; } catch { return ''; } };
  const nMsgs = (r) => { try { return JSON.parse(r.messages || '[]').length; } catch { return 0; } };

  const rows = db.prepare('SELECT chat_id, contact_name, deal_id, messages, last_data FROM conversations').all()
    .filter((r) => nMsgs(r) >= 10)
    .filter((r) => resumoGravado(r) || porChat.get(r.chat_id)?.resumo_novo);

  // Estratos por DESFECHO DO TITULO, que e a pergunta nova: sem isso, uma amostra aleatoria de 20
  // cairia quase toda na classe majoritaria e o dono julgaria 20 vezes o mesmo caso. Quem nao passou
  // pelo replay (sem classe) entra no estrato "so o resumo gravado".
  const estratos = { titulo_so_nome: [], titulo_generico: [], assunto_especifico: [], sem_replay: [] };
  for (const r of rows) {
    const classe = porChat.get(r.chat_id)?.titulo_classe;
    (estratos[classe] || estratos.sem_replay).push(r);
  }

  const ALVO = 20;
  const chaves = Object.keys(estratos).filter((k) => estratos[k].length);
  const cota = chaves.length ? Math.ceil(ALVO / chaves.length) : 0;
  const amostra = [];
  for (const k of chaves) amostra.push(...embaralhar(estratos[k], OPCOES.seed).slice(0, cota));
  const finais = amostra.slice(0, ALVO);

  // Achatar quebra de linha para ' / ' e decisao de LEITURA (uma celula por linha no Excel, em vez de
  // uma celula de seis linhas de altura); o ESCAPE fica com src/csv.js, que e a unica implementacao.
  const achatar = (v) => String(v == null ? '' : v).replace(/\r?\n/g, ' / ');
  const destino = path.join(DIR_SAIDA, 'rubrica-20.csv');
  escreverCsv(destino, finais.map((r) => ({
    chat_id: r.chat_id,
    contato: r.contact_name,
    tem_deal: r.deal_id ? 'sim' : 'nao',
    n_msgs: nMsgs(r),
    titulo_do_deal: porChat.get(r.chat_id)?.titulo_do_deal || '',
    classe_do_titulo: porChat.get(r.chat_id)?.titulo_classe || '(nao passou pelo replay)',
    resumo_gravado: achatar(resumoGravado(r)),
    resumo_novo: achatar(porChat.get(r.chat_id)?.resumo_novo || ''),
    titulo_do_deal_serve__sim_nao: '',
    dava_para_atender__sim_maisoumenos_nao: '',
    o_que_faltou: '',
  })), {
    cabecalho: ['chat_id', 'contato', 'tem_deal', 'n_msgs', 'titulo_do_deal', 'classe_do_titulo',
      'resumo_gravado', 'resumo_novo', 'titulo_do_deal_serve__sim_nao',
      'dava_para_atender__sim_maisoumenos_nao', 'o_que_faltou'],
  });

  const distribuicao = chaves.map((k) => `${k}: ${Math.min(cota, estratos[k].length)}`).join(', ');
  console.log(`\nrubrica humana: ${destino} (${finais.length} conversas julgaveis; seed ${OPCOES.seed})`);
  console.log(`   estratos por desfecho do titulo — ${distribuicao}`);
  console.log(`   ${rows.length} conversa(s) tinham algo a julgar (resumo gravado ou resumo novo); o resto ficou fora.`);
  console.log('   as TRES colunas vazias no fim sao as perguntas. `titulo_do_deal_serve` e a nova, e e o');
  console.log('   criterio de aceitacao da Fase 1; `dava_para_atender` e o da troca de modelo.');
}

// ================================================================================================
(async () => {
  if (!fs.existsSync(CAMINHO_BANCO)) { console.error(`banco nao encontrado: ${CAMINHO_BANCO}`); process.exit(1); }
  fs.mkdirSync(DIR_SAIDA, { recursive: true });
  const db = new Database(CAMINHO_BANCO, { readonly: true });

  const c0 = camada0(db);
  imprimirCamada0(c0);

  let res = null;
  let agregado = null;
  if (!OPCOES.soGratis) {
    if (!process.env.OPENAI_API_KEY) { console.error('\nOPENAI_API_KEY ausente - rode com --so-gratis'); process.exit(1); }
    const corpus = db.prepare('SELECT * FROM conversations ORDER BY chat_id').all();
    const todas = OPCOES.soComDesfecho ? corpus.filter(temDesfecho) : corpus;
    if (OPCOES.soComDesfecho) console.log(`\n--so-com-desfecho: ${todas.length} de ${corpus.length} conversa(s) (fora as inviavel/interno sem deal)`);
    // AMOSTRA EMBARALHADA por seed, nao `slice(0, N)`. O corpus vem ordenado por chat_id, que e
    // telefone: `--limite 30` pegava as 30 primeiras por numero de telefone, e como 197 das 277
    // conversas sao `inviavel`, a fatia virava ~22 B1 e media quase nada do que interessa. Embaralhar
    // com a MESMA seed mantem a reprodutibilidade (duas rodadas comparam as mesmas conversas) e da
    // uma amostra representativa. Sem --limite, o corpus inteiro roda na ordem original.
    const alvos = OPCOES.limite ? embaralhar(todas, OPCOES.seed).slice(0, OPCOES.limite) : todas;
    console.log(`\nreplay com IA em ${alvos.length} conversa(s), concorrencia ${OPCOES.concorrencia}, modelo ${process.env.OPENAI_MODEL || 'gpt-4o-mini'}${OPCOES.semEstado ? ', SEM estado anterior' : ''}`);
    res = await camada1(db, alvos);
    agregado = imprimirCamada1(res);
  }

  if (OPCOES.rubrica) gerarRubrica(db, res);

  // A HORA entra no nome, e nao so a data. Duas rodadas no mesmo dia — que e exatamente o que
  // acontece quando se mede antes e depois de um conserto — tinham o MESMO nome, e a segunda
  // sobrescrevia a linha de base da primeira em silencio. Aconteceu em 02/09/2026.
  const agora = new Date();
  const hoje = `${agora.toISOString().slice(0, 10)}-${String(agora.getHours()).padStart(2, '0')}${String(agora.getMinutes()).padStart(2, '0')}`;
  const rotulo = arg('--rotulo', '');
  const sufixo = `${OPCOES.soGratis ? '-so-gratis' : ''}${OPCOES.semEstado ? '-sem-estado' : ''}${rotulo ? `-${String(rotulo).replace(/[^a-z0-9-]/gi, '')}` : ''}`;
  const cabecalho = {
    gerado_em: new Date().toISOString(),
    opcoes: OPCOES,
    modelo: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
  // DOIS arquivos, e a separacao e por PROTECAO DE DADO, nao por gosto. O bruto tem telefone
  // (chat_id), nome do contato e o resumo do caso — o mesmo conteudo que faz `deals-*.csv`,
  // `notas-*.csv` e o proprio conversations.db estarem no .gitignore deste repo. O agregado tem
  // apenas contagens, e e ele que precisa sobreviver no repositorio para a Fase 2 comparar.
  fs.writeFileSync(path.join(DIR_SAIDA, `linha-de-base-${hoje}${sufixo}.json`),
    JSON.stringify({ ...cabecalho, camada0: c0, camada1: agregado, por_conversa: res || undefined }, null, 2), 'utf8');
  const destino = path.join(DIR_SAIDA, `agregado-${hoje}${sufixo}.json`);
  fs.writeFileSync(destino, JSON.stringify({ ...cabecalho, camada0: c0, camada1: agregado }, null, 2), 'utf8');

  db.close();
  linha('=');
  console.log(`agregado (so numeros, versionavel) em ${destino}`);
  console.log(`bruto por conversa (telefone/nome/caso — NAO versionar) em ${path.join(DIR_SAIDA, `linha-de-base-${hoje}${sufixo}.json`)}`);
  console.log('nada foi escrito: nem no conversations.db, nem no Moskit, nem na agenda, nem no Telegram.');
  process.exit(0);
})().catch((e) => { console.error('ERRO', e.stack || e.message); process.exit(1); });
