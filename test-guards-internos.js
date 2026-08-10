// Os CINCO pontos que impedem um numero da equipe de virar lead, deal ou contato no CRM. Rodar com:
//   node test-guards-internos.js
//
// O bug relatado pelo dono: "a automacao esta criando deal com numeros de pessoas internas". A lista
// tinha 5 dos 12 numeros e a comparacao era igualdade EXATA de string. Um socio virou o deal 48222273;
// outros quatro so nao viraram porque o classificador os barrou por acaso.
//
// Aqui cada guard e exercitado no SEU nivel de entrada — webhook, polling, rota — porque o que
// precisa ser provado e o encanamento, nao o predicado. ehInterno() ja tem 55 assercoes proprias em
// test-telefone.js; se este arquivo chamasse ehInterno diretamente, testaria a mesma coisa de novo e
// nada sobre o wiring.

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const path = require('path');
const Database = require('better-sqlite3');

const DIR = dirTemporario('guards');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.ADMIN_TOKEN = 'token-de-teste';
process.env.WEBHOOK_SECRET = '';
process.env.GOOGLE_CALENDAR_ID = '';
process.env.TELEGRAM_BOT_TOKEN = '';

// Numeros de teste. O interno entra na lista; o externo nao.
const INTERNO = '5586988887777';
const EXTERNO = '5511977776666';
process.env.TEAM_PHONES = INTERNO; // antes do require de src/telefone.js

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

// ---------- OpenAI proibida ----------
// openaiChat fala HTTPS na mao (index.js:104). Se qualquer guard deixar a conversa chegar na
// classificacao, isto explode — e o teste denuncia. Cada rodada custaria 2 chamadas com a conversa
// inteira, entao o guard PRECISA vir antes.
const https = require('https');
let tentouOpenAI = 0;
https.request = () => { tentouOpenAI++; throw new Error('OpenAI nao pode ser chamada neste teste'); };

const http = require('http');
const { buscarOuCriarContato, processarConversaDirect, app } = require('./index');
const db = new Database(process.env.DB_PATH);

let passou = 0;
let falhou = 0;
function checar(nome, condicao, detalhe) {
  if (condicao) { passou++; console.log(`  ✅ ${nome}`); }
  else { falhou++; console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`); }
}
const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

function limpar() {
  rede.chamadas = []; rede.get = rede.post = rede.put = null;
  tentouOpenAI = 0;
  db.prepare('DELETE FROM conversations').run();
}
const linha = (chatId) => db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);
const pendentes = () => db.prepare('SELECT chat_id FROM conversations WHERE processed = 0 OR processed IS NULL').all().map((r) => r.chat_id);

function semear(chatId, extras = {}) {
  const campos = {
    chat_id: chatId, phone: chatId, contact_name: 'Alguem', processed: 0,
    messages: JSON.stringify([{ role: 'cliente', text: 'Boa tarde, preciso de um advogado', timestamp: '2026-07-30T12:00:00Z' }]),
    ...extras,
  };
  const cols = Object.keys(campos);
  db.prepare(`INSERT OR REPLACE INTO conversations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => campos[c]));
}

function pedir(porta, metodo, caminho, corpoObj) {
  return new Promise((resolve) => {
    const corpo = JSON.stringify(corpoObj || { ping: true });
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo), 'X-Admin-Token': 'token-de-teste' },
    }, (res) => {
      let txt = '';
      res.on('data', (d) => { txt += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: txt }));
    });
    req.on('error', () => resolve({ status: 'ERRO' }));
    req.write(corpo);
    req.end();
  });
}
const assentar = () => new Promise((r) => setTimeout(r, 250)); // o webhook responde 200 e processa depois

(async () => {
  const PORTA = 3995;
  const server = await new Promise((r) => { const s = app.listen(PORTA, '127.0.0.1', () => r(s)); });

  // ============================================================
  console.log('\n=== Guard 1: buscarOuCriarContato — ultima barreira antes do CRM ===');
  {
    limpar();
    let erro = null;
    try { await buscarOuCriarContato(INTERNO, 'Socio'); } catch (e) { erro = e.message; }
    checar('numero interno → LANCA em vez de criar contato', !!erro && erro.includes('numero interno'), erro);
    igual('   zero chamadas HTTP', rede.chamadas.length, 0);
  }
  {
    limpar();
    let erro = null;
    try { await buscarOuCriarContato('+55 (86) 98888-7777', 'Socio'); } catch (e) { erro = e.message; }
    checar('mesmo numero em outro formato tambem lanca', !!erro, erro);
  }
  {
    // Contraprova: sem ela, um bug que fizesse a funcao lancar sempre passaria nos dois casos acima.
    limpar();
    db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(EXTERNO, 777, 'Cliente');
    igual('numero externo resolve normalmente', await buscarOuCriarContato(EXTERNO, 'Cliente'), 777);
  }

  // ============================================================
  console.log('\n=== Guard 2: processarConversaDirect — antes da classificacao ===');
  {
    limpar();
    semear(INTERNO);
    let erro = null;
    try { await processarConversaDirect(INTERNO); } catch (e) { erro = e.message; }
    igual('conversa interna → retorna sem lancar', erro, null);
    igual('   a OpenAI NAO foi chamada (o guard vem antes)', tentouOpenAI, 0);
    igual('   zero chamadas ao Moskit', rede.chamadas.length, 0);
    igual('   marcada como interno', linha(INTERNO).last_action, 'interno');
    igual('   marcada como processada', linha(INTERNO).processed, 1);
    igual('   sem deal', linha(INTERNO).deal_id, null);
    // Era isto que reenfileirava 5 conversas internas a cada boot do bot.
    igual('   sai da lista de pendentes', pendentes().includes(INTERNO), false);
  }
  {
    limpar();
    semear(INTERNO, { phone: '86988887777' }); // mesmo numero, escrito sem DDI
    await processarConversaDirect(INTERNO);
    igual('formato divergente entre chat_id e phone tambem e barrado', linha(INTERNO).last_action, 'interno');
  }

  // ============================================================
  console.log('\n=== Guard 3: processarMensagemRecebida — entrada do webhook ===');
  const webhookRecebida = (de) => ({
    event: 'message.received',
    message: { direction: 'incoming', id: `z-${de}`, text: 'Boa tarde, preciso de ajuda', sender: { id: de, name: 'Alguem' } },
  });
  {
    limpar();
    const r = await pedir(PORTA, 'POST', '/webhook', webhookRecebida(INTERNO));
    await assentar();
    igual('webhook responde 200', r.status, 200);
    igual('   nenhuma conversa criada para o interno', linha(INTERNO), undefined);
  }
  {
    limpar();
    await pedir(PORTA, 'POST', '/webhook', webhookRecebida('+55 (86) 98888-7777'));
    await assentar();
    igual('interno em outro formato tambem nao cria conversa', db.prepare('SELECT COUNT(*) c FROM conversations').get().c, 0);
  }
  {
    limpar();
    await pedir(PORTA, 'POST', '/webhook', webhookRecebida(EXTERNO));
    await assentar();
    checar('CONTRAPROVA: numero externo cria a conversa', !!linha(EXTERNO));
    igual('   com 1 mensagem', JSON.parse(linha(EXTERNO)?.messages || '[]').length, 1);
  }
  {
    // Mensagem da equipe: e ela que carrega o role "equipe", a evidencia que autoriza agendamento.
    limpar();
    await pedir(PORTA, 'POST', '/webhook', {
      event: 'message.sent',
      message: { direction: 'outgoing', id: 'z-out', text: 'Podemos marcar quarta as 17:30?' },
      conversation: { participantId: INTERNO, participantName: 'Socio' },
    });
    await assentar();
    igual('mensagem enviada PARA um interno tambem nao cria conversa', linha(INTERNO), undefined);
  }

  // ============================================================
  console.log('\n=== Guard 4: sincronizarConversas — polling do Zernio ===');
  {
    limpar();
    rede.get = (url) => {
      if (url.includes('/messages')) {
        // Campos conforme o polling le em index.js:2436/2440 — `message` e `createdAt`, nao
        // `text`/`createdTime`. Este formato foi DERIVADO do codigo, nao capturado de um evento real
        // do Zernio; conferir contra um payload de producao continua sendo item de verificacao manual.
        return { status: 200, data: { messages: [{ id: 'm1', direction: 'incoming', message: 'oi', createdAt: '2026-07-30T12:00:00Z' }] } };
      }
      return {
        status: 200,
        data: {
          data: [
            { id: 'c1', participantId: INTERNO, participantName: 'Socio', updatedTime: '2026-07-30T12:00:00Z', accountId: 'a1' },
            { id: 'c2', participantId: EXTERNO, participantName: 'Cliente', updatedTime: '2026-07-30T12:00:00Z', accountId: 'a1' },
            { id: 'c3', participantId: 'grupo-xyz', participantName: 'Grupo', updatedTime: '2026-07-30T12:00:00Z', accountId: 'a1' },
          ],
        },
      };
    };
    const r = await pedir(PORTA, 'POST', '/sincronizar');
    igual('a rota responde 200', r.status, 200);

    const buscados = rede.chamadas.filter((c) => c.url.includes('/messages')).map((c) => c.url);
    igual('   busca mensagens de 1 conversa so', buscados.length, 1);
    checar('   e e a do EXTERNO (c2)', buscados[0].includes('/c2/'), buscados[0]);
    igual('   conversa do interno nao foi gravada', linha(INTERNO), undefined);
    checar('   conversa do externo foi gravada', !!linha(EXTERNO));
    igual('   id de grupo ignorado sem erro', JSON.parse(r.corpo).erros, 0);
  }

  // ============================================================
  console.log('\n=== Guard 5: backfillDeals — o caminho que nao tinha checagem nenhuma ===');
  {
    // Esta rota selecionava last_action='criar' AND deal_id IS NULL e criava negocio SEM checar a
    // lista. Era o caminho mais direto para um socio virar deal.
    limpar();
    db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name) VALUES (?,?,?)').run(EXTERNO, 777, 'Cliente');
    const dados = JSON.stringify({ nome: 'Alguem', assunto: 'Inventario', tipo_consulta: 'consulta paga' });
    semear(INTERNO, { last_action: 'criar', deal_id: null, last_data: dados, processed: 1 });
    semear(EXTERNO, { last_action: 'criar', deal_id: null, last_data: dados, processed: 1 });

    rede.post = (url) => ({ status: 200, data: { id: 5001 } });
    const r = await pedir(PORTA, 'POST', '/backfill-deals');
    const relatorio = JSON.parse(r.corpo);

    igual('a rota responde 200', r.status, 200);
    igual('   1 conversa ignorada', relatorio.ignorados, 1);
    igual('   1 deal criado', relatorio.deals_criados, 1);
    igual('   interno marcado como "interno"', linha(INTERNO).last_action, 'interno');
    igual('   interno continua sem deal', linha(INTERNO).deal_id, null);
    igual('   externo ganhou o deal', linha(EXTERNO).deal_id, 5001);

    const criados = rede.chamadas.filter((c) => c.metodo === 'POST' && c.url.endsWith('/deals'));
    igual('   exatamente 1 POST /deals', criados.length, 1);
    checar('   e nenhum contato do interno foi tocado',
      !rede.chamadas.some((c) => JSON.stringify(c.corpo || '').includes('88887777')));
  }

  server.close();
  db.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passou} passaram · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
