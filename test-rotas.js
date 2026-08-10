// Teste das rotas HTTP em ISOLAMENTO. Rodar com:
//   node test-rotas.js
//
// Duas travas, e as duas ja falharam de verdade neste projeto:
//
// WORKER_MODE=1 faz o index.js carregar sem subir servidor, sem ngrok, sem os timers de
// sincronizacao e sem reprocessar conversas pendentes. Sem isso, testar rota significa ligar o bot
// de producao e disparar o pipeline em conversas reais — foi o que aconteceu na primeira tentativa.
//
// DB_PATH aponta o banco para um arquivo descartavel. Sem isso, o require('./index.js') abre
// conversations.db e roda os ALTER TABLE nas 208 conversas reais. Este teste nasceu fazendo isso.

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const path = require('path');

const DIR = dirTemporario('rotas');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';
process.env.ADMIN_TOKEN = 'token-de-teste';
process.env.WEBHOOK_SECRET = '';

const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

// Terceira trava: nenhuma rota pode alcancar Moskit, Zernio, Google ou Telegram. Qualquer chamada
// vira excecao — que e tambem o insumo do teste do adaptador rota() la embaixo.
const axios = require('axios');
let chamadasHttp = 0;
for (const metodo of ['get', 'post', 'put', 'patch', 'delete']) {
  axios[metodo] = async (url) => {
    chamadasHttp++;
    throw new Error(`rede bloqueada no teste (${metodo.toUpperCase()} ${url})`);
  };
}

let passou = 0;
let falhou = 0;

function checar(nome, obtido, esperado) {
  const ok = obtido === esperado;
  ok ? passou++ : falhou++;
  console.log(`  ${ok ? '✅' : '❌'} ${nome} → ${obtido}${ok ? '' : ` (esperado ${esperado})`}`);
}

function pedir(porta, method, caminho, headers = {}) {
  return new Promise((resolve) => {
    const corpo = JSON.stringify({ ping: true });
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo), ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('ERRO'));
    req.write(corpo);
    req.end();
  });
}

// Mesmo pedido mas com corpo arbitrario (para o webhook simular o formato do Zernio de verdade).
function pedirCorpo(porta, caminho, corpo) {
  return new Promise((resolve) => {
    const buf = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo));
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve('ERRO'));
    req.write(buf);
    req.end();
  });
}

const subir = (app, porta) => new Promise((r) => { const s = app.listen(porta, '127.0.0.1', () => r(s)); });

const AUTORIZADO = { 'X-Admin-Token': 'token-de-teste' };

(async () => {
  const { app } = require('./index.js');
  const PORTA = 3999;
  const server = await subir(app, PORTA);

  console.log('\n=== Rotas administrativas (ADMIN_TOKEN definido) ===');
  checar('GET / (health, aberta)', await pedir(PORTA, 'GET', '/'), 200);
  checar('POST /sincronizar sem token', await pedir(PORTA, 'POST', '/sincronizar'), 401);
  checar('GET /cliente-existente sem token', await pedir(PORTA, 'GET', '/cliente-existente/5586999999999'), 401);
  checar('POST /backfill-deals sem token', await pedir(PORTA, 'POST', '/backfill-deals'), 401);
  checar('POST /processar sem token', await pedir(PORTA, 'POST', '/processar/5586999999999'), 401);
  checar('POST /sincronizar-atividades sem token', await pedir(PORTA, 'POST', '/sincronizar-atividades'), 401);
  checar('GET /auditoria-consulta-gratis sem token', await pedir(PORTA, 'GET', '/auditoria-consulta-gratis'), 401);
  checar('POST /backfill-meet-links sem token', await pedir(PORTA, 'POST', '/backfill-meet-links'), 401);
  checar('POST /importar-moskit sem token', await pedir(PORTA, 'POST', '/importar-moskit'), 401);
  checar('GET /cliente-existente com token', await pedir(PORTA, 'GET', '/cliente-existente/5586999999999', AUTORIZADO), 200);
  checar('GET /cliente-existente com token errado', await pedir(PORTA, 'GET', '/cliente-existente/5586999999999', { 'X-Admin-Token': 'errado' }), 401);
  checar('token tambem aceito por querystring', await pedir(PORTA, 'GET', '/cliente-existente/5586999999999?token=token-de-teste'), 200);

  // CARACTERIZACAO: `req.get('X-Admin-Token') || req.query.token` pega o header PRIMEIRO. Um header
  // errado nao "cai" para a querystring — e facil supor o contrario ao depurar.
  checar('header errado + querystring certa → header manda (401)',
    await pedir(PORTA, 'GET', '/cliente-existente/5586999999999?token=token-de-teste', { 'X-Admin-Token': 'errado' }), 401);

  console.log('\n=== Adaptador rota(): erro async vira 500, nao requisicao pendurada ===');
  // O Express 4 NAO encaminha rejeicao de handler async pro error middleware. Sem o adaptador, a
  // requisicao ficava pendurada ate o timeout de 240s. /auditoria-consulta-gratis e a rota que
  // propaga a excecao (as outras tem try/catch interno e devolvem 200 com contador de erros).
  {
    const antes = Date.now();
    const status = await pedir(PORTA, 'GET', '/auditoria-consulta-gratis', AUTORIZADO);
    const decorrido = Date.now() - antes;
    checar('erro de rede na rota vira 500', status, 500);
    checar(`responde rapido (${decorrido}ms, nao 240s)`, decorrido < 2000, true);
    checar('a chamada de rede foi de fato tentada e bloqueada', chamadasHttp > 0, true);
  }

console.log('\n=== Webhook em periodo de tolerancia (sem WEBHOOK_SECRET) ===');
  checar('POST /webhook aberto, sem exigir assinatura', await pedir(PORTA, 'POST', '/webhook'), 200);
  // A URL do webhook e sempre /webhook (Zernio nao aceita caminho customizado) — nao existe mais
  // rota /webhook/:segredo, entao qualquer coisa alem de /webhook cai no 404 padrao do Express.
  checar('POST /webhook/qualquer nao e uma rota registrada', await pedir(PORTA, 'POST', '/webhook/qualquer'), 404);

  console.log('\n=== Webhook de audio do cliente (placeholder no banco, sem rede) ===');
  {
    const db = new Database(process.env.DB_PATH);
    const chat = '5586999999999';
    const corpo = JSON.stringify({
      event: 'message.received',
      message: {
        id: 'wamid-audio-123',
        direction: 'incoming',
        sender: { id: chat, name: 'Cliente' },
        attachments: [{ type: 'audio', payload: { filename: 'nota-de-voz.ogg' } }],
      },
    });
    const status = await pedirCorpo(PORTA, '/webhook', corpo);
    checar('webhook de audio responde 200', status, 200);
    const linha = db.prepare('SELECT messages FROM conversations WHERE chat_id = ?').get(chat);
    checar('conversa criada pelo audio', !!linha, true);
    const msgs = JSON.parse(linha.messages);
    const ultima = msgs[msgs.length - 1];
    checar('placeholder do audio no historico', ultima.text, '📎 [cliente enviou um audio]');
    checar('id_zernio preservado', ultima.id_zernio, 'wamid-audio-123');
    // Sem URL, o download do audio nao acontece (baixarAnexoAudio devolve null antes do axios) —
    // nenhuma rede tocada; o placeholder fica como esta. Aqui o audio e o caso de teste 2 do
    // test-transcricao.js, so que passando pela rota HTTP de verdade.
    await new Promise((r) => setTimeout(r, 100));
    const depois = JSON.parse(db.prepare('SELECT messages FROM conversations WHERE chat_id = ?').get(chat).messages);
    checar('sem URL, transcricao nao roda (placeholder intacto)', depois[depois.length - 1].text, '📎 [cliente enviou um audio]');
    db.close();
  }

  server.close();

  // As constantes de auth sao lidas no load do modulo, entao cada configuracao precisa do seu
  // processo. O sub-processo herda DB_PATH — banco descartavel tambem la.
  const emSubprocesso = (env, corpo) => {
    const saida = execFileSync(process.execPath, ['-e', corpo], {
      cwd: __dirname, encoding: 'utf8', env: { ...process.env, ...env },
    });
    return JSON.parse(saida.trim().split('\n').pop());
  };

  const CLIENTE_HTTP = (porta) => `
    const http=require('http');
    const p=(caminho,metodo,extraHeaders)=>new Promise(r=>{const c='{}';
      const headers=Object.assign({'Content-Type':'application/json','Content-Length':2}, extraHeaders||{});
      const q=http.request({host:'127.0.0.1',port:${porta},path:caminho,method:metodo,headers},
        res=>{res.resume();res.on('end',()=>r(res.statusCode));});
      q.on('error',()=>r('ERRO')); q.write(c); q.end();});`;

  console.log('\n=== Webhook autenticado (WEBHOOK_SECRET definido, assinatura HMAC) ===');
  {
    // Corpo enviado pelo CLIENTE_HTTP e sempre a string '{}' (Content-Length: 2 fixo) — a
    // assinatura precisa ser calculada sobre EXATAMENTE esse corpo cru, igual o Zernio faria.
    const SEGREDO = 'segredo123';
    const CORPO = '{}';
    const assinaturaCorreta = crypto.createHmac('sha256', SEGREDO).update(CORPO).digest('hex');
    const assinaturaErrada = crypto.createHmac('sha256', 'outro-segredo').update(CORPO).digest('hex');
    const r = emSubprocesso(
      { WORKER_MODE: '1', ADMIN_TOKEN: 't', WEBHOOK_SECRET: SEGREDO, DB_PATH: path.join(DIR, 'sub1.db') },
      `${CLIENTE_HTTP(3998)}
       const { app }=require('./index.js');
       const s=app.listen(3998,'127.0.0.1',async()=>{
         console.log(JSON.stringify({
           semAssinatura: await p('/webhook','POST'),
           assinaturaCorreta: await p('/webhook','POST',{'X-Zernio-Signature':'${assinaturaCorreta}'}),
           assinaturaErrada: await p('/webhook','POST',{'X-Zernio-Signature':'${assinaturaErrada}'}),
         }));
         s.close(); process.exit(0);
       });`
    );
    checar('POST /webhook sem assinatura → 401', r.semAssinatura, 401);
    checar('POST /webhook com assinatura HMAC correta → 200', r.assinaturaCorreta, 200);
    checar('POST /webhook com assinatura de outro segredo → 401', r.assinaturaErrada, 401);
  }

  console.log('\n=== Sem ADMIN_TOKEN as administrativas ficam DESLIGADAS (503, nao abertas) ===');
  // Perder /sincronizar por falta de config e preferivel a deixar /cliente-existente respondendo
  // para a internet inteira. Simula ADMIN_TOKEN nao configurado forcando string vazia — "delete"
  // nao bastaria, pois o dotenv.config() do index.js repovoa a partir do .env real (que agora TEM
  // ADMIN_TOKEN definido, ja que essa e a correcao de seguranca aplicada).
  {
    const ambiente = { WORKER_MODE: '1', ADMIN_TOKEN: '', WEBHOOK_SECRET: '', DB_PATH: path.join(DIR, 'sub2.db') };
    const r = emSubprocesso(
      ambiente,
      `${CLIENTE_HTTP(3996)}
       const { app }=require('./index.js');
       const s=app.listen(3996,'127.0.0.1',async()=>{
         console.log(JSON.stringify({
           saude: await p('/','GET'),
           sincronizar: await p('/sincronizar','POST'),
           cliente: await p('/cliente-existente/5586999999999','GET'),
           backfill: await p('/backfill-deals','POST'),
           webhook: await p('/webhook','POST'),
         }));
         s.close(); process.exit(0);
       });`
    );
    checar('GET / continua aberta', r.saude, 200);
    checar('POST /sincronizar desligada', r.sincronizar, 503);
    checar('GET /cliente-existente desligada', r.cliente, 503);
    checar('POST /backfill-deals desligada', r.backfill, 503);
    checar('POST /webhook continua respondendo (tolerancia)', r.webhook, 200);
  }


  console.log(`\n${falhou === 0 ? '✅' : '❌'} ${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou === 0 ? 0 : 1);
})();
