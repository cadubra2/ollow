// As TRES configuracoes com que a reuniao de retorno vai para producao. Rodar com:
//   node test-reuniao-retorno-flags.js
//
// REUNIAO_RETORNO_ATIVO e REUNIAO_RETORNO_DRY_RUN sao lidas como `const` no require do index.js,
// entao nao ha como exercitar os tres modos no mesmo processo — mesmo motivo pelo qual
// test-cliente-retorno-flags.js/test-agenda-dry-run.js existem separados de test-pipeline.js. Este
// arquivo se relanca como filho, um processo por modo.
//
// O MESMO cenario passa pelos tres modos: uma consulta que aconteceu ha 20 dias, e cliente+equipe
// confirmam agora um horario novo (bem alem da tolerancia de 24h de remarcacao). O que muda e SO o
// desfecho:
//   desligado — trata como remarcacao comum (o comportamento de ANTES desta funcionalidade existir:
//               move o evento da consulta que ja aconteceu). E o "continua igual" que precisa ficar
//               provado, nao suposto.
//   dryrun    — detecta a reuniao nova, avisa, e NAO move nada (nem cria nada).
//   aplicando — abre a reuniao nova de verdade: evento e Atividade novos, a reuniao anterior
//               arquivada, o evento antigo nunca tocado.

const path = require('path');
const { spawnSync } = require('child_process');

const MODOS = {
  desligado: { REUNIAO_RETORNO_ATIVO: 'false', REUNIAO_RETORNO_DRY_RUN: 'false' },
  dryrun: { REUNIAO_RETORNO_ATIVO: 'true', REUNIAO_RETORNO_DRY_RUN: 'true' },
  aplicando: { REUNIAO_RETORNO_ATIVO: 'true', REUNIAO_RETORNO_DRY_RUN: 'false' },
};

if (!process.env.REUNIAO_MODO) {
  let falhou = false;
  for (const [modo, env] of Object.entries(MODOS)) {
    console.log(`\n${'#'.repeat(50)}\n# modo: ${modo}\n${'#'.repeat(50)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, path.basename(__filename))], {
      stdio: 'inherit',
      env: { ...process.env, ...env, REUNIAO_MODO: modo },
    });
    if (r.status !== 0) falhou = true;
  }
  process.exit(falhou ? 1 : 0);
}

const MODO = process.env.REUNIAO_MODO;

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const Database = require('better-sqlite3');

const DIR = dirTemporario(`reuniao-retorno-${MODO}`);
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.TELEGRAM_BOT_TOKEN = 'token-falso';
process.env.TELEGRAM_CHAT_ID = '1';
process.env.GOOGLE_CALENDAR_ID = 'agenda-de-teste@exemplo.com';
process.env.AGENDA_MOSKIT_DRY_RUN = 'false';
process.env.FUNIL_DRY_RUN = 'true';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true';
process.env.REUNIAO_TOLERANCIA_REMARCACAO_HORAS = '24';

// ---------- dublê do axios ----------
const axios = require('axios');
const rede = { chamadas: [], get: null, post: null, put: null };
for (const metodo of ['get', 'post', 'put', 'patch', 'delete']) {
  axios[metodo] = async (url, a, b) => {
    const corpo = metodo === 'get' || metodo === 'delete' ? undefined : a;
    rede.chamadas.push({ metodo: metodo.toUpperCase(), url, corpo, cfg: corpo === undefined ? a : b });
    const h = rede[metodo];
    if (h) return h(url, corpo);
    return { status: 200, data: {} };
  };
}

// ---------- dublê da OpenAI (https.request na mao) ----------
const httpsModulo = require('https');
const { EventEmitter } = require('events');
const openai = { respostas: [] };
httpsModulo.request = (opcoes, cb) => {
  const res = new EventEmitter();
  const req = {
    on: () => req,
    write: () => {},
    destroy: () => {},
    end: () => {
      const resposta = openai.respostas.shift() || {};
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify({ choices: [{ message: { content: JSON.stringify(resposta) } }] }));
        res.emit('end');
      });
    },
  };
  return req;
};

// ---------- dublê do Google Calendar ----------
const { google } = require('googleapis');
const agenda = { insert: [], patch: [] };
google.calendar = () => ({
  events: {
    insert: async (a) => { agenda.insert.push(a); return { data: { id: 'evNOVO', htmlLink: 'https://exemplo/evNOVO' } }; },
    patch: async (a) => { agenda.patch.push(a); return { data: {} }; },
    get: async () => ({ data: { summary: 'antigo', description: 'antigo' } }),
    list: async () => ({ data: { items: [] } }),
    delete: async () => ({}),
  },
});

const { processarConversaDirect } = require('./index');
const { instanteParaNaiveLocal } = require('./src/evidencia');
const moskitIds = require('./src/moskit-ids');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);
const de = (metodo, fragmento) => rede.chamadas.filter((c) => c.metodo === metodo && c.url.includes(fragmento));
const telegrams = () => de('POST', 'api.telegram.org');
const notas = () => de('POST', '/notes');
const atividadesCriadas = () => de('POST', '/activities');
const linha = () => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(CHAT);
const sincronizada = (id) => db.prepare('SELECT * FROM atividades_sincronizadas WHERE activity_id = ?').get(id);

// ---------- o cenario: consulta ha 20 dias, e agora confirmam uma reuniao de acompanhamento ----------
const CHAT = '5586999990002';
const DEAL_ANTIGO = 9201;
const ATIVIDADE_ANTIGA = 555222;
const ATIVIDADE_NOVA = 881333;
const agora = Date.now();
const atras = (h) => new Date(agora - h * 3600 * 1000).toISOString();

// Naive local (fuso do escritorio) para o dia (daqui a N dias) na hora fixada — mesma tecnica de
// naiveDaquiA em test-pipeline.js, so que fixando a HORA (nao "daqui a N horas") para cair sempre
// dentro da janela de atendimento (7h-20h), sem depender de que horas sao agora.
function naiveNoDia(diasDaqui, hora) {
  const alvo = new Date(agora + diasDaqui * 86400000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(alvo).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${String(hora).padStart(2, '0')}:00:00`;
}

const EVENTO_ANTIGO_NAIVE = instanteParaNaiveLocal(atras(24 * 20)); // consulta ha 20 dias
const HORARIO_NOVO = naiveNoDia(5, 10); // dentro de 5 dias, 10h — bem alem da tolerancia de 24h

const MSGS = [
  { role: 'cliente', text: 'Bom dia! Obrigado pela consulta, foi bem esclarecedor', timestamp: atras(24 * 20) },
  { role: 'cliente', text: 'Doutor, posso agendar uma reuniao de acompanhamento do meu caso?', timestamp: atras(3) },
  { role: 'equipe', text: 'Consegue nessa data as 10h?', timestamp: atras(2) },
  { role: 'cliente', text: 'Consigo sim', timestamp: atras(1.5) },
  { role: 'equipe', text: 'Perfeito, ja deixei marcado', timestamp: atras(1) },
];

db.prepare(
  'INSERT INTO conversations (chat_id, phone, contact_name, messages, deal_id, last_data, last_action, ' +
  'evento_calendar_criado, evento_calendar_id, evento_calendar_data, atividade_moskit_id, reuniao_num) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
).run(
  CHAT, CHAT, 'Lia', JSON.stringify(MSGS), DEAL_ANTIGO,
  JSON.stringify({
    nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional',
    advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram',
    _casoDescritoValidado: true,
  }),
  'nota', 1, 'evOLD', EVENTO_ANTIGO_NAIVE, ATIVIDADE_ANTIGA, 1
);
db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(CHAT, 4242, 'Lia');
db.prepare('INSERT INTO atividades_sincronizadas (activity_id, evento_calendar_id, deal_id) VALUES (?,?,?)')
  .run(ATIVIDADE_ANTIGA, 'evOLD', DEAL_ANTIGO);

// Dublê com estado: GET sempre devolve o deal ja vinculado a atividade nova (evita depender de PUT de
// religamento) e num estagio anterior a "consulta_agendada" (para moverEstagioSeAvancar ter o que
// avancar sem se importar com qual atividade e).
rede.get = () => ({ status: 200, data: { id: DEAL_ANTIGO, stage: { id: 179388 }, deals: [{ id: DEAL_ANTIGO }], activities: [] } });
rede.put = () => ({ status: 200, data: {} });
rede.post = (url) => (url.includes('/activities') ? { status: 200, data: { id: ATIVIDADE_NOVA } } : { status: 200, data: {} });

openai.respostas = [
  { classificacao: 'criar_negocio', justificativa: 'cliente antigo pedindo acompanhamento' },
  {
    acao: 'nota', justificativa: 'reuniao de acompanhamento confirmada', confianca: 9,
    dados: {
      nome: 'Lia', assunto: 'Abatimento do FIES', area_direito: 'Direito Educacional',
      advogado_responsavel: 'Iury', tipo_consulta: 'consulta paga', origem: 'Instagram',
      resumo_atendimento: 'Reuniao de acompanhamento agendada.',
    },
    observacoes: [
      { tipo: 'equipe_propos_horario', msg_idx: 2, trecho: 'Consegue nessa data as 10h', horario_iso: HORARIO_NOVO },
      { tipo: 'cliente_aceitou_horario', msg_idx: 3, trecho: 'Consigo sim', horario_iso: HORARIO_NOVO },
      { tipo: 'equipe_confirmou_horario', msg_idx: 4, trecho: 'ja deixei marcado', horario_iso: HORARIO_NOVO },
    ],
  },
];

(async () => {
  console.log(`\n=== ${MODO}: reuniao de acompanhamento confirmada 20 dias apos a consulta ===`);
  await processarConversaDirect(CHAT);

  const l = linha();

  if (MODO === 'desligado') {
    // O comportamento de ANTES desta funcionalidade existir: trata como remarcacao comum.
    igual('desligado: nenhum evento novo — 1 PATCH no antigo', agenda.insert.length, 0);
    igual('   1 PATCH movendo o evento que ja aconteceu', agenda.patch.filter((p) => p.requestBody?.start).length, 1);
    igual('   evento_calendar_data foi atualizado (comportamento antigo)', l.evento_calendar_data, HORARIO_NOVO);
    igual('   reuniao_num nao muda (feature nem existe aqui)', l.reuniao_num, 1);
    igual('   nenhuma reuniao arquivada', l.reunioes_anteriores, null);
  } else if (MODO === 'dryrun') {
    igual('dryrun: nenhum evento novo criado', agenda.insert.length, 0);
    igual('   e o evento antigo NAO e movido', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
    igual('   evento_calendar_data continua o antigo', l.evento_calendar_data, EVENTO_ANTIGO_NAIVE);
    igual('   reuniao_num nao muda', l.reuniao_num, 1);
    checar('   avisa no Telegram', telegrams().some((t) => (t.corpo.text || '').includes('Reunião de retorno')), telegrams().map((t) => t.corpo.text));
    checar('   o aviso diz que nada foi alterado', telegrams().some((t) => (t.corpo.text || '').includes('[dry-run]')), telegrams().map((t) => t.corpo.text));
    checar('   nota marcada como dry-run no negocio', notas().some((n) => (n.corpo.description || '').includes('[dry-run]')), notas().map((n) => n.corpo.description));
    checar('   grava o hash para nao repetir o aviso', !!l.reuniao_aviso_hash, l.reuniao_aviso_hash);
  } else {
    igual('aplicando: 1 evento NOVO criado', agenda.insert.length, 1);
    igual('   o evento antigo NUNCA e movido', agenda.patch.filter((p) => p.requestBody?.start).length, 0);
    const summary = agenda.insert[0]?.requestBody?.summary || '';
    checar('   titulo "Retorno 1 —"', summary.startsWith('Retorno 1 —'), summary);
    checar('   com o sufixo do deal', summary.endsWith(`· #${DEAL_ANTIGO}`), summary);
    igual('   1 Atividade nova criada no Moskit', atividadesCriadas().length, 1);
    igual('   reuniao_num incrementado', l.reuniao_num, 2);

    const anteriores = JSON.parse(l.reunioes_anteriores || '[]');
    igual('   1 reuniao arquivada', anteriores.length, 1);
    igual('   numero da reuniao arquivada', anteriores[0]?.numero, 1);
    igual('   evento arquivado e o antigo', anteriores[0]?.evento_id, 'evOLD');
    igual('   atividade arquivada e a antiga', anteriores[0]?.atividade_id, ATIVIDADE_ANTIGA);

    checar('   a trava anti-duplicado da Atividade ANTIGA continua', !!sincronizada(ATIVIDADE_ANTIGA));
    checar('   e a Atividade NOVA tambem entrou na trava', !!sincronizada(ATIVIDADE_NOVA));
  }

  db.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passou: ${passou} | Falhou: ${falhou}`);
  console.log('='.repeat(50));
  process.exit(falhou > 0 ? 1 : 0);
})();
