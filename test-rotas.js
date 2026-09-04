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

// GET que devolve corpo e cabecalhos, nao so o status: a rota de anexo se prova pelo que ENTREGA
// (bytes do PDF, Content-Type), e um 200 sozinho nao distingue o PDF certo de uma pagina de erro.
function baixar(porta, caminho) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'GET' }, (res) => {
      const pedacos = [];
      res.on('data', (d) => pedacos.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(pedacos) }));
    });
    req.on('error', () => resolve({ status: 'ERRO', headers: {}, corpo: Buffer.alloc(0) }));
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
  checar('POST /chatwoot/sincronizar-contatos sem token', await pedir(PORTA, 'POST', '/chatwoot/sincronizar-contatos'), 401);
  // Com token e com CHATWOOT_ATIVO ausente (o padrao de producao) a rota responde 200 dizendo que
  // esta desligada, sem tocar a rede — e por isso este teste nao precisa de dublê do Chatwoot.
  checar('POST /chatwoot/sincronizar-contatos com token (desligada)',
    await pedir(PORTA, 'POST', '/chatwoot/sincronizar-contatos', AUTORIZADO), 200);

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

  console.log('\n=== GET /arquivo-nota/:token/:nome (publica, serve o PDF para o Moskit) ===');
  {
    // Esta rota e a UNICA sem autenticacao alem do health check, e por um motivo forte: o
    // POST /deals/{id}/attachments nao aceita upload — quem baixa o arquivo e o servidor do Moskit,
    // que nao tem como mandar ADMIN_TOKEN. O que segura a porta e o token de 256 bits + o TTL.
    const db = new Database(process.env.DB_PATH);
    const pdf = Buffer.from('%PDF-1.4\n% teste de anexo\n%%EOF\n', 'latin1');
    const arq = path.join(DIR, 'notas-reuniao-2026-08-14-abcd1234.pdf');
    fs.writeFileSync(arq, pdf);

    const tokenBom = 'a'.repeat(64);
    const tokenVelho = 'b'.repeat(64);
    const tokenSemArquivo = 'c'.repeat(64);
    const inserir = db.prepare(`
      INSERT INTO notas_reuniao (gmail_message_id, estado, deal_id, anexo_token, anexo_caminho, anexo_nome, anexo_expira_em)
      VALUES (?, 'CONCLUIDO', 48292471, ?, ?, ?, ?)
    `);
    const daquiUmaHora = new Date(Date.now() + 3600e3).toISOString().replace('T', ' ').slice(0, 19);
    inserir.run('m-bom', tokenBom, arq, 'notas-reuniao-2026-08-14-abcd1234.pdf', daquiUmaHora);
    inserir.run('m-velho', tokenVelho, arq, 'notas-reuniao-2026-08-14-abcd1234.pdf', new Date(Date.now() - 3600e3).toISOString().replace('T', ' ').slice(0, 19));
    inserir.run('m-sem-arq', tokenSemArquivo, path.join(DIR, 'nao-existe.pdf'), 'x.pdf', daquiUmaHora);
    db.close();

    const ok = await baixar(PORTA, `/arquivo-nota/${tokenBom}/notas-reuniao-2026-08-14-abcd1234.pdf`);
    checar('token valido devolve 200', ok.status, 200);
    checar('  Content-Type e PDF', ok.headers['content-type'], 'application/pdf');
    checar('  bytes entregues sao o PDF', ok.corpo.equals(pdf), true);
    checar('  nao vai para cache de intermediario', /no-store/.test(ok.headers['cache-control'] || ''), true);
    checar('  nao entra em indice de busca', /noindex/.test(ok.headers['x-robots-tag'] || ''), true);
    // O filename sai do BANCO, nunca de req.params: e o mesmo nome que a deduplicacao procura depois
    // em GET /deals/{id}/attachments.
    checar('  filename vem do banco', /filename="notas-reuniao-2026-08-14-abcd1234\.pdf"/.test(ok.headers['content-disposition'] || ''), true);

    // O :nome e decorativo — trocar so ele nao pode mudar o arquivo servido, senao viraria seletor.
    const outroNome = await baixar(PORTA, `/arquivo-nota/${tokenBom}/qualquer-outro-nome.pdf`);
    checar('nome diferente, mesmo token → mesmo arquivo', outroNome.corpo.equals(pdf), true);

    // Os tres desfechos negativos respondem IGUAL. Distinguir "expirado" de "inexistente" contaria a
    // quem sondasse que aquele token ja existiu — e quando.
    checar('token expirado → 404', (await baixar(PORTA, `/arquivo-nota/${tokenVelho}/x.pdf`)).status, 404);
    checar('token desconhecido → 404', (await baixar(PORTA, `/arquivo-nota/${'d'.repeat(64)}/x.pdf`)).status, 404);
    checar('token valido mas arquivo sumido → 404', (await baixar(PORTA, `/arquivo-nota/${tokenSemArquivo}/x.pdf`)).status, 404);
    checar('token fora do formato hex → 404', (await baixar(PORTA, '/arquivo-nota/curto/x.pdf')).status, 404);

    // Path traversal: o :nome NUNCA entra num path.join. Se um dia entrar, este teste cai.
    const traversal = await baixar(PORTA, `/arquivo-nota/${tokenBom}/${encodeURIComponent('../../../.env')}`);
    checar('traversal no :nome nao vaza outro arquivo', traversal.corpo.equals(pdf), true);
    const traversalToken = await baixar(PORTA, `/arquivo-nota/${encodeURIComponent('../../.env')}/x.pdf`);
    checar('traversal no :token → 404', traversalToken.status, 404);
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


  console.log('\n=== O bot SOBE mesmo se a migracao do anexo falhar ===');
  {
    // O defeito que este teste tranca: `stmtNotaPorAnexoToken` era um `db.prepare` no TOPO do
    // modulo. Os ALTER TABLE que criam `anexo_token` vivem em `try {} catch {}` como todo o boot —
    // e esse prepare transformava o catch numa armadilha. Migracao falhando por qualquer motivo que
    // nao "coluna ja existe" (disco cheio, banco travado, arquivo corrompido) fazia o `require`
    // lancar `no such column`, o processo morrer com exit 1 e o pm2 entrar em loop de restart.
    // O bot INTEIRO — WhatsApp, agenda, CRM — caía por causa de uma coluna de uma funcionalidade
    // que nasce desligada. Medido antes da correcao: exit code 1.
    //
    // A simulacao usa uma VIEW chamada `notas_reuniao`: o `CREATE TABLE IF NOT EXISTS` pula em
    // silencio (ja existe objeto com o nome) e o `ALTER TABLE` falha de verdade ("Cannot add a
    // column to a view"), reproduzindo exatamente "as colunas nao existem e nao da para cria-las".
    const dbQuebrado = path.join(DIR, 'migracao-impossivel.db');
    const d = new Database(dbQuebrado);
    d.exec('CREATE TABLE base (gmail_message_id TEXT PRIMARY KEY, estado TEXT)');
    d.exec('CREATE VIEW notas_reuniao AS SELECT * FROM base');
    d.close();

    let subiu = true;
    let r = null;
    try {
      r = emSubprocesso(
        { WORKER_MODE: '1', ADMIN_TOKEN: 't', WEBHOOK_SECRET: '', DB_PATH: dbQuebrado },
        `${CLIENTE_HTTP(3995)}
         const { app }=require('./index.js');
         const s=app.listen(3995,'127.0.0.1',async()=>{
           console.log(JSON.stringify({
             saude: await p('/','GET'),
             anexo: await p('/arquivo-nota/${'a'.repeat(64)}/x.pdf','GET'),
           }));
           s.close(); process.exit(0);
         });`
      );
    } catch { subiu = false; }

    checar('o processo SOBE com a migracao impossivel', subiu, true);
    checar('   e o resto do bot continua servindo', r && r.saude, 200);
    // O pior caso vira um 404 nesta rota — o mesmo que ela ja responde para token invalido.
    checar('   a rota de anexo degrada para 404, nao derruba nada', r && r.anexo, 404);
  }


  console.log('\n=== Migracao impossivel de chatwoot_contacts: o bot continua no ar ===');
  {
    // Mesmo defeito, mesma defesa, tabela nova: os prepares de chatwoot_contacts sao PREGUICOSOS
    // (stmtsChatwoot) porque um db.prepare no topo do modulo transformaria o try/catch da criacao
    // numa armadilha — o require morreria com "no such column", exit 1, e o pm2 entraria em loop de
    // restart, derrubando WhatsApp, agenda e CRM por causa de uma funcionalidade que nasce
    // DESLIGADA. A simulacao e a mesma de notas_reuniao: uma VIEW ocupando o nome faz o
    // CREATE TABLE IF NOT EXISTS pular em silencio e qualquer prepare falhar de verdade.
    const dbCw = path.join(DIR, 'migracao-impossivel-chatwoot.db');
    const d2 = new Database(dbCw);
    d2.exec('CREATE TABLE base_cw (id INTEGER PRIMARY KEY, x TEXT)');
    d2.exec('CREATE VIEW chatwoot_contacts AS SELECT * FROM base_cw');
    d2.close();

    let subiu = true;
    let r2 = null;
    try {
      r2 = emSubprocesso(
        {
          WORKER_MODE: '1', ADMIN_TOKEN: 't', WEBHOOK_SECRET: '', DB_PATH: dbCw,
          // Ligada e configurada de proposito: e o unico jeito de a requisicao chegar ao prepare que
          // nao pode ser feito. Host inexistente para nao haver a menor chance de sair pacote.
          CHATWOOT_ATIVO: 'true', CHATWOOT_DRY_RUN: 'true',
          CHATWOOT_BASE: 'https://chatwoot.invalid', CHATWOOT_ACCOUNT_ID: '1', CHATWOOT_API_TOKEN: 't',
        },
        `${CLIENTE_HTTP(3994)}
         const { app }=require('./index.js');
         const s=app.listen(3994,'127.0.0.1',async()=>{
           console.log(JSON.stringify({
             saude: await p('/','GET'),
             chatwoot: await p('/chatwoot/sincronizar-contatos?token=t','POST'),
           }));
           s.close(); process.exit(0);
         });`
      );
    } catch { subiu = false; }

    checar('o processo SOBE com a migracao impossivel', subiu, true);
    checar('   e o resto do bot continua servindo', r2 && r2.saude, 200);
    // O pior caso e a rota do Chatwoot falhar — nao o bot inteiro sair do ar.
    checar('   a rota do Chatwoot degrada para 500, nao derruba nada', r2 && r2.chatwoot, 500);
  }
  console.log(`\n${falhou === 0 ? '✅' : '❌'} ${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou === 0 ? 0 : 1);
})();
