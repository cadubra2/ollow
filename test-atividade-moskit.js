// Invariantes de src/atividade-moskit.js — a consulta na AGENDA do Moskit. Puro, sem rede. Rodar com:
//   node test-atividade-moskit.js
//
// O que este teste protege, em ordem de dano:
//
// 1. A CONVERSAO DO HORARIO. O pipeline trabalha com horario "naive" que significa hora local do
//    escritorio; o Moskit quer instante absoluto. Errar isso nao quebra nada em tempo de execucao —
//    grava a consulta 3h fora do lugar na agenda e so aparece quando o cliente entra na sala vazia.
//    Era exatamente o erro que o comentario de TZ_ESCRITORIO em index.js ja descreve para o Google.
// 2. O TIPO DA ATIVIDADE, que precisa concordar com a decisao de criar (ou nao) link do Meet no
//    evento do Google: consulta presencial nao pode virar Videoconferencia na agenda do CRM.

require('dotenv').config();

const { montarPayloadAtividade, horarioNaiveParaInstante, DURACAO_CONSULTA_MIN } = require('./src/atividade-moskit');
const { ATIVIDADE_TIPO, ATIVIDADE_TIPOS_CONSULTA, LAYLA_USER_ID } = require('./src/moskit-ids');

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
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

const TZ = 'America/Fortaleza';
// Le um instante de volta na hora local do escritorio, no mesmo formato da string naive de entrada.
const naHoraDoEscritorio = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');

// ============================================================
console.log('\n=== horarioNaiveParaInstante: ida e volta no fuso do escritorio ===');
for (const naive of ['2026-08-05T17:30:00', '2026-01-01T08:00:00', '2026-12-25T23:59:00', '2026-06-30T00:30:00']) {
  const instante = horarioNaiveParaInstante(naive, TZ);
  igual(`${naive} volta identico ao ser lido em ${TZ}`, naHoraDoEscritorio(instante), naive);
}

// A conversao NAO pode ser "acrescenta Z": esse era o jeito errado obvio, e o resultado passa
// despercebido porque continua sendo uma data valida.
checar('nao trata o horario naive como UTC',
  horarioNaiveParaInstante('2026-08-05T17:30:00', TZ) !== '2026-08-05T17:30:00.000Z',
  horarioNaiveParaInstante('2026-08-05T17:30:00', TZ));

igual('17:30 em Fortaleza (UTC-3) vira 20:30Z', horarioNaiveParaInstante('2026-08-05T17:30:00', TZ), '2026-08-05T20:30:00.000Z');

// Fortaleza nao pratica horario de verao, entao um fuso que pratica e o unico jeito de provar que o
// offset e perguntado para a DATA em questao, e nao fixado uma vez so.
console.log('\n=== horarioNaiveParaInstante: fuso com horario de verao ===');
igual('meio-dia de julho em Nova York (EDT, UTC-4)', horarioNaiveParaInstante('2026-07-01T12:00:00', 'America/New_York'), '2026-07-01T16:00:00.000Z');
igual('meio-dia de janeiro em Nova York (EST, UTC-5)', horarioNaiveParaInstante('2026-01-15T12:00:00', 'America/New_York'), '2026-01-15T17:00:00.000Z');
igual('fuso zero nao ganha offset', horarioNaiveParaInstante('2026-03-10T09:00:00', 'UTC'), '2026-03-10T09:00:00.000Z');

console.log('\n=== horarioNaiveParaInstante: entrada invalida devolve null (nao manda lixo ao CRM) ===');
for (const ruim of [null, undefined, '', 'amanha as 15h', '2026-13-45T99:99:00', '05/08/2026 17:30', 20260805, '2026-08-05T17:30:00Z']) {
  checar(`recusa ${JSON.stringify(ruim)}`, horarioNaiveParaInstante(ruim, TZ) === null, horarioNaiveParaInstante(ruim, TZ));
}
checar('aceita naive sem segundos', horarioNaiveParaInstante('2026-08-05T17:30', TZ) === '2026-08-05T20:30:00.000Z');

// ============================================================
console.log('\n=== montarPayloadAtividade: tipo concorda com a modalidade ===');
const base = { dealId: 48290481, titulo: 'Consulta — Fulano (Iury)', assunto: 'Revisao de beneficio', dueDate: '2026-08-05T20:30:00.000Z' };

const online = montarPayloadAtividade({ ...base, presencial: false, meetLink: 'https://meet.google.com/abc-defg-hij' });
const presencial = montarPayloadAtividade({ ...base, presencial: true });

igual('consulta online vira Videoconferencia', online.type.id, ATIVIDADE_TIPO.videoconferencia);
igual('consulta presencial vira Reuniao', presencial.type.id, ATIVIDADE_TIPO.reuniao);
checar('ambos os tipos sao tipos de consulta (o que a sincronizacao periodica reconhece)',
  ATIVIDADE_TIPOS_CONSULTA.has(online.type.id) && ATIVIDADE_TIPOS_CONSULTA.has(presencial.type.id));

console.log('\n=== montarPayloadAtividade: o que o Moskit espera ===');
// Formato levantado em 12/08/2026 contra a API real (test-moskit-atividade-real.js): atividade
// pendente devolve title/type{id}/dueDate/duration/contacts[{id}]/deals[{id}]/responsible{id}.
igual('title vem do titulo do evento', online.title, base.titulo);
igual('dueDate e o instante recebido', online.dueDate, base.dueDate);
igual('duration em minutos, igual a duracao do evento do Google', online.duration, DURACAO_CONSULTA_MIN);
igual('duracao padrao e 60', DURACAO_CONSULTA_MIN, 60);
checar('deals e array de {id}', Array.isArray(online.deals) && online.deals[0].id === base.dealId, online.deals);
igual('responsible e o usuario do bot', online.responsible.id, LAYLA_USER_ID);
igual('createdBy e o usuario do bot', online.createdBy.id, LAYLA_USER_ID);
igual('duracao customizada e respeitada', montarPayloadAtividade({ ...base, duracaoMin: 90 }).duration, 90);

console.log('\n=== montarPayloadAtividade: contato ===');
checar('vincula o contato quando conhecido', montarPayloadAtividade({ ...base, contatoId: 47575967 }).contacts[0].id === 47575967);
// Mandar `contacts: [{id: null}]` seria pior que omitir: cria vinculo para um contato inexistente.
checar('omite contacts quando o contato nao foi resolvido', !('contacts' in online), Object.keys(online));

console.log('\n=== montarPayloadAtividade: notas ===');
checar('nota traz o link do Meet', online.notes.includes('https://meet.google.com/abc-defg-hij'));
checar('nota traz o assunto', online.notes.includes('Revisao de beneficio'));
checar('nota linka de volta para o negocio', online.notes.includes(`/deal/${base.dealId}`));
checar('presencial nao inventa link de Meet', !presencial.notes.includes('Meet'), presencial.notes);
checar('nota diz que foi o bot (a equipe precisa saber de onde veio)', online.notes.includes('bot'));

console.log('\n=== montarPayloadAtividade: recusa o que nao da para agendar ===');
// Atividade sem deal fica orfa na agenda e some do negocio; sem dueDate nao e compromisso nenhum.
checar('sem dealId devolve null', montarPayloadAtividade({ ...base, dealId: null }) === null);
checar('sem dueDate devolve null', montarPayloadAtividade({ ...base, dueDate: null }) === null);
checar('titulo ausente cai num padrao em vez de "undefined"',
  montarPayloadAtividade({ ...base, titulo: null }).title === 'Consulta agendada');

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
