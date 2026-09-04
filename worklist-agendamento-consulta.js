// Pedido do usuario (03/09/2026): "temos 82 pessoas em agendamento de consulta, vamos analisar
// todos e ver se estao com os campos preenchidos corretamente e a qualidade do deal delas".
//
// Cruza o snapshot da auditoria (auditoria-crm/<ts>/relatorios/) com o conversations.db mais fresco
// disponivel para todo deal ABERTO no estagio "Agendamento de Consulta e Analise de Viabilidade"
// (STAGE.agendamento = 179388) — de QUALQUER origem, nao so do bot (esse estagio recebe leads do
// Moskit Boost tambem). Zero chamada de rede: 100% offline sobre os CSVs ja coletados.
//
//   node worklist-agendamento-consulta.js <dir-da-auditoria>
//   node worklist-agendamento-consulta.js  (usa a auditoria mais recente em auditoria-crm/)
//
// Nota: o snapshot pode estar 1-2 dias defasado (a auditoria nao roda ao vivo) — se o numero aqui nao
// bater exato com o que aparece no Moskit agora, é porque alguns deals avançaram/fecharam nesse meio
// tempo. Rodar `auditar-crm-coletar.js` + `auditar-crm-relatar.js` de novo para um snapshot fresco
// custa ~310 requisicoes (a conta inteira) — nao faço isso sem pedir, por ser uma varredura cara.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `worklist-agendamento-${process.pid}.db`);
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
    console.error('❌ Diretorio de auditoria nao encontrado.');
    process.exit(1);
  }
  const dirRel = path.join(dirAuditoria, 'relatorios');
  console.log(`📁 Usando auditoria: ${dirAuditoria}\n`);

  const inventario = parseCsv(path.join(dirRel, '00-inventario.csv'));
  const alvo = inventario.filter((r) => r.stage.includes('Agendamento de Consulta') && r.status === 'OPEN');
  console.log(`Deals no estágio "Agendamento de Consulta e Análise de Viabilidade", status OPEN: ${alvo.length}`);
  const porOrigem = {};
  for (const r of alvo) porOrigem[r.origin] = (porOrigem[r.origin] || 0) + 1;
  console.log('  por origem:', JSON.stringify(porOrigem));

  const alvoIds = new Set(alvo.map((r) => r.deal_id));
  const camposCsv = parseCsv(path.join(dirRel, '02-campos-obrigatorios.csv')).filter((r) => alvoIds.has(r.deal_id) && r.campo !== 'origem');
  const nomeCsv = parseCsv(path.join(dirRel, '03-nome-generico.csv')).filter((r) => alvoIds.has(r.deal_id));
  const paresCsv = parseCsv(path.join(dirRel, '01-duplicidade-deals.csv'))
    .filter((r) => r.categoria === 'mesmo_nome_mesmo_caso' && (alvoIds.has(r.deal_1) || alvoIds.has(r.deal_2)));

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  const dbDisponivel = fs.existsSync(caminhoBanco);
  const db = dbDisponivel ? new Database(caminhoBanco, { readonly: true }) : null;
  if (!dbDisponivel) console.log(`⚠️  ${caminhoBanco} não encontrado — reconferência de campos via last_data ficará pulada (usando só a auditoria).\n`);

  const camposPorDeal = new Map();
  for (const r of camposCsv) {
    if (!camposPorDeal.has(r.deal_id)) camposPorDeal.set(r.deal_id, new Set());
    camposPorDeal.get(r.deal_id).add(r.campo);
  }
  const nomeGenericoPorDeal = new Map(nomeCsv.map((r) => [r.deal_id, r.tipo]));

  // Duplicidade: separa par LIVE (as duas pontas ainda abertas/relevantes) de par JA RESOLVIDO
  // (uma ponta ja fechada — muito provavelmente ja corrigido num script pontual anterior, ou so um
  // desfecho normal de funil onde o outro lado perdeu por outro motivo).
  const dupInfoPorDeal = new Map();
  for (const p of paresCsv) {
    const outro = alvoIds.has(p.deal_1) ? { id: p.deal_2, nome: p.nome_2, status: p.status_2 } : { id: p.deal_1, nome: p.nome_1, status: p.status_1 };
    const alvoDealId = alvoIds.has(p.deal_1) ? p.deal_1 : p.deal_2;
    const jaResolvido = outro.status !== 'OPEN';
    const lista = dupInfoPorDeal.get(alvoDealId) || [];
    lista.push({ outroId: outro.id, outroNome: outro.nome, outroStatus: outro.status, jaResolvido });
    dupInfoPorDeal.set(alvoDealId, lista);
  }

  const linhas = [];
  let semCampoQualquer = 0, nomeGenericoQualquer = 0, dupLive = 0, dupResolvida = 0;
  for (const r of alvo) {
    const camposFaltandoAuditoria = camposPorDeal.get(r.deal_id) || new Set();
    let camposFaltando = [...camposFaltandoAuditoria];
    let nomeGenerico = nomeGenericoPorDeal.get(r.deal_id) || '';

    // Reconfere contra o last_data mais fresco disponivel, quando existe conversa local — evita
    // reportar como problema algo que ja foi corrigido desde a auditoria (como aconteceu com os 4
    // deals do bug de mergeDados, ja restaurados).
    if (db) {
      const conv = db.prepare('SELECT last_data FROM conversations WHERE deal_id = ?').get(r.deal_id);
      if (conv) {
        let dados = null;
        try { dados = JSON.parse(conv.last_data || 'null'); } catch { /* ignore */ }
        if (dados) {
          const pendentesAgora = new Set(camposPendentes(dados));
          camposFaltando = camposFaltando.filter((c) => pendentesAgora.has(c));
          if (nomeGenerico && dados.assunto && !ehAssuntoNeutro(dados.assunto)) {
            const teste = { assunto: dados.assunto };
            rejeitarAssuntoQueEhArea(teste);
            if (teste.assunto === dados.assunto) nomeGenerico = ''; // assunto real e utilizavel apareceu depois
          }
        }
      }
    }

    const dup = dupInfoPorDeal.get(r.deal_id) || [];
    const dupLiveList = dup.filter((d) => !d.jaResolvido);
    const dupResolvidaList = dup.filter((d) => d.jaResolvido);
    if (camposFaltando.length) semCampoQualquer++;
    if (nomeGenerico) nomeGenericoQualquer++;
    if (dupLiveList.length) dupLive++;
    if (dupResolvidaList.length) dupResolvida++;

    linhas.push({
      deal_id: r.deal_id,
      nome_deal: r.nome_deal,
      origin: r.origin,
      link: `https://app.ollow.com.br/?/deal/${r.deal_id}`,
      campos_faltando: camposFaltando.join('|'),
      nome_generico: nomeGenerico,
      duplicidade_live: dupLiveList.map((d) => `${d.outroId} (${d.outroNome}, ${d.outroStatus})`).join(' | '),
      duplicidade_ja_resolvida: dupResolvidaList.map((d) => `${d.outroId} (${d.outroStatus})`).join(' | '),
      sem_espelho_local: r.no_espelho_local === 'false',
    });
  }
  if (db) db.close();

  console.log(`\nResumo da qualidade (${alvo.length} deals no estágio, status OPEN):`);
  console.log(`  sem campo obrigatório: ${semCampoQualquer}`);
  console.log(`  nome genérico: ${nomeGenericoQualquer}`);
  console.log(`  em par de duplicidade AINDA ABERTO (precisa de revisão): ${dupLive}`);
  console.log(`  em par de duplicidade JÁ RESOLVIDO (o outro lado já foi fechado — informativo): ${dupResolvida}`);
  const semNenhumProblema = linhas.filter((l) => !l.campos_faltando && !l.nome_generico && !l.duplicidade_live).length;
  console.log(`  sem nenhum problema encontrado: ${semNenhumProblema} / ${alvo.length}`);

  const saida = path.join(dirAuditoria, 'worklist-agendamento-consulta.csv');
  const r = escreverCsv(saida, linhas, {
    cabecalho: ['deal_id', 'nome_deal', 'origin', 'link', 'campos_faltando', 'nome_generico', 'duplicidade_live', 'duplicidade_ja_resolvida', 'sem_espelho_local'],
  });
  console.log(`\n📄 ${r.caminho} (${r.linhas} linha(s))`);
})();
