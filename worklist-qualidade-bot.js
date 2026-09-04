// PLANO-CORRECAO-QUALIDADE-DEALS.md, Fases 2 e 3 — depois de reconferir os 43 campos obrigatorios
// faltando e os 45 nomes genericos dos deals do bot contra o `conversations.db` de producao (fresco,
// nao o snapshot de 12/08 usado pela auditoria original), a conclusao foi: **zero** sao recuperaveis
// sozinhos. Toda vez que a auditoria achava um "assunto no last_data", ou era o proprio nome da area
// (rejeitarAssuntoQueEhArea recusaria, entao renomear nao seria melhoria nenhuma) ou o campo tinha
// voltado para o placeholder "Consulta juridica" desde entao. Os 4 casos com deal_id sumido do banco
// (48401749, 48402952, 48403011, 48403502) ja foram tratados na Fase 1 (duplicidade) ou nao tem mais
// linha correspondente.
//
// Ou seja: nao ha PUT nenhum pra fazer aqui — o dado nunca foi capturado na conversa, ponto. O unico
// produto possivel e um WORKLIST pra equipe: qual deal, o que falta, e um pedaco da conversa do
// cliente pra quem for revisar nao precisar abrir o Moskit e o WhatsApp ao mesmo tempo.
//
// Roda 100% offline sobre `CONVERSATIONS_DB` (ou `conversations.db` local) + os CSVs da auditoria em
// `auditoria-crm/<timestamp>/relatorios/`. Nao escreve nada, nao chama rede — nao tem `--aplicar`
// porque nao ha nada pra aplicar.
//
//   node worklist-qualidade-bot.js <dir-da-auditoria>
//   node worklist-qualidade-bot.js  (usa a auditoria mais recente em auditoria-crm/)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `worklist-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const Database = require('better-sqlite3');
const { camposPendentes, ehAssuntoNeutro, rejeitarAssuntoQueEhArea } = require('./index.js');
const { escreverCsv } = require('./src/csv');

function parseCsv(caminho) {
  const texto = fs.readFileSync(caminho, 'utf-8').replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/).filter(Boolean);
  const cabecalho = linhas[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  return linhas.slice(1).map((linha) => {
    const valores = [];
    let atual = '';
    let dentroDeAspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (dentroDeAspas) {
        if (c === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else dentroDeAspas = false; }
        else atual += c;
      } else if (c === '"') dentroDeAspas = true;
      else if (c === ',') { valores.push(atual); atual = ''; }
      else atual += c;
    }
    valores.push(atual);
    const obj = {};
    cabecalho.forEach((h, i) => { obj[h] = valores[i]; });
    return obj;
  });
}

function acharAuditoriaMaisRecente() {
  const base = 'auditoria-crm';
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort();
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}

(async () => {
  const dirAuditoria = process.argv[2] || acharAuditoriaMaisRecente();
  if (!dirAuditoria || !fs.existsSync(dirAuditoria)) {
    console.error('❌ Diretorio de auditoria nao encontrado. Passe o caminho ou rode auditar-crm-coletar.js + auditar-crm-relatar.js antes.');
    process.exit(1);
  }
  const dirRel = path.join(dirAuditoria, 'relatorios');
  console.log(`📁 Usando auditoria: ${dirAuditoria}\n`);

  const camposCsv = parseCsv(path.join(dirRel, '02-campos-obrigatorios.csv'))
    .filter((r) => r.origin === 'BOT_WHATSAPP' && r.campo !== 'origem'); // origem tem script proprio (recuperar-origem-perdida.js) e nao bloqueia a criacao
  const nomeCsv = parseCsv(path.join(dirRel, '03-nome-generico.csv'))
    .filter((r) => r.origin === 'BOT_WHATSAPP');

  const porDeal = new Map(); // deal_id -> { nome_deal, camposFaltando: Set, nomeGenerico: bool }
  for (const r of camposCsv) {
    if (!porDeal.has(r.deal_id)) porDeal.set(r.deal_id, { nome_deal: r.nome_deal, camposFaltando: new Set(), nomeGenerico: false });
    porDeal.get(r.deal_id).camposFaltando.add(r.campo);
  }
  for (const r of nomeCsv) {
    if (!porDeal.has(r.deal_id)) porDeal.set(r.deal_id, { nome_deal: r.nome_deal, camposFaltando: new Set(), nomeGenerico: false });
    porDeal.get(r.deal_id).nomeGenerico = true;
  }

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  if (!fs.existsSync(caminhoBanco)) {
    console.error(`❌ Banco nao encontrado em ${caminhoBanco} (defina CONVERSATIONS_DB= para apontar pra uma copia de producao).`);
    process.exit(1);
  }
  const db = new Database(caminhoBanco, { readonly: true });

  const worklist = [];
  let recuperadosSozinhos = 0;
  for (const [dealId, info] of porDeal) {
    const conv = db.prepare('SELECT chat_id, contact_name, last_data, messages FROM conversations WHERE deal_id = ?').get(dealId);
    if (!conv) {
      worklist.push({ deal_id: dealId, nome_deal: info.nome_deal, chat_id: '', campos_faltando: [...info.camposFaltando].join('|'), nome_generico: info.nomeGenerico, motivo: 'deal_id nao encontrado no conversations.db (provavel duplicata ja tratada, ou fora do espelho local)', ultima_msg_cliente: '' });
      continue;
    }
    let dados = null;
    try { dados = JSON.parse(conv.last_data || 'null'); } catch { /* ignore */ }
    let mensagens = [];
    try { mensagens = JSON.parse(conv.messages || '[]'); } catch { /* ignore */ }

    // Reconfere CADA campo faltando contra o last_data fresco — pode ter sido preenchido depois da
    // auditoria (a auditoria pode estar defasada de dias).
    const aindaFaltando = new Set();
    const pendentesAgora = new Set(camposPendentes(dados || {}));
    for (const campo of info.camposFaltando) {
      if (pendentesAgora.has(campo)) aindaFaltando.add(campo);
    }

    // Nome generico: so continua no worklist se o last_data tambem nao tiver um assunto real e
    // utilizavel (nao neutro, nao apenas o nome da area) — a MESMA checagem de producao.
    let nomeAindaGenerico = info.nomeGenerico;
    if (nomeAindaGenerico && dados?.assunto && !ehAssuntoNeutro(dados.assunto)) {
      const teste = { assunto: dados.assunto };
      rejeitarAssuntoQueEhArea(teste);
      if (teste.assunto === dados.assunto) {
        // assunto real e utilizavel apareceu depois da auditoria — nao entra no worklist, e um caso
        // que SERIA recuperavel por rename se ninguem tiver corrigido na mao ainda (fora do escopo
        // deste script, que so lista o que precisa de humano).
        nomeAindaGenerico = false;
        recuperadosSozinhos++;
      }
    }

    if (!aindaFaltando.size && !nomeAindaGenerico) continue; // resolvido entre a auditoria e agora

    const ultimasClienteTexto = mensagens.filter((m) => m.role === 'cliente').slice(-3).map((m) => m.text).join(' | ');
    worklist.push({
      deal_id: dealId,
      nome_deal: info.nome_deal,
      chat_id: conv.chat_id,
      contato: conv.contact_name || '',
      campos_faltando: [...aindaFaltando].join('|'),
      nome_generico: nomeAindaGenerico,
      link: `https://app.ollow.com.br/?/deal/${dealId}`,
      ultima_msg_cliente: (ultimasClienteTexto || '').slice(0, 500),
    });
  }
  db.close();

  console.log(`Deals no worklist final: ${worklist.length} (de ${porDeal.size} candidatos da auditoria)`);
  if (recuperadosSozinhos) console.log(`  ${recuperadosSozinhos} ja tinham assunto real capturado depois da auditoria — conferir se ja foi corrigido no CRM antes de tratar como pendente.`);

  const saida = path.join(dirAuditoria, 'worklist-qualidade-bot.csv');
  const r = escreverCsv(saida, worklist, { cabecalho: ['deal_id', 'nome_deal', 'chat_id', 'contato', 'campos_faltando', 'nome_generico', 'link', 'ultima_msg_cliente'] });
  console.log(`\n📄 ${r.caminho} (${r.linhas} linha(s))`);
})();
