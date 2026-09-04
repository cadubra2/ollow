// Pedido do usuario (03/09/2026): "analise esses 87 que estao em agendamento, cruze os dados pra ver
// se esta duplicado com nomes diferentes mas casos iguais, ou se ja pode ser declarado como perdido
// por desinteresse — quero fazer uma limpa nessa aba".
//
// TRES eixos, todos offline (zero chamada de rede — usa o snapshot bruto da auditoria + o
// conversations.db):
//
//   1. DUPLICIDADE, em tres forcas de sinal, da mais forte pra mais fraca:
//      a) mesmo `contacts.id` no Moskit -> e literalmente a mesma ficha de cliente com 2 negocios
//      b) mesmo TELEFONE com contatos diferentes -> a assinatura exata do bug de buscarOuCriarContato
//         (documentado no CLAUDE.md, 24/08/2026)
//      c) CASO parecido com NOME diferente -> o que o usuario suspeita. Usa similaridadeTexto de
//         src/duplicidade.js com filtro de token generico (IDF): sem isso "Abatimento do FIES" casa
//         com "Abatimento do FIES" de OUTRA pessoa e vira um mar de falso positivo, porque FIES e
//         um tema recorrente de VERDADE neste escritorio.
//
//   2. ABANDONO / DESINTERESSE: idade do deal, dias desde a ultima mensagem, e QUEM falou por ultimo.
//      O sinal mais forte de abandono nao e "faz tempo" — e "a EQUIPE falou por ultimo e o cliente
//      nunca respondeu". Se o CLIENTE falou por ultimo e ninguem respondeu, o problema e do
//      escritorio, nao do lead: sao listas diferentes e acoes opostas.
//
//   3. DESINTERESSE DECLARADO: varredura deterministica por frase de recusa nas mensagens do CLIENTE
//      (preco fora da realidade, "vou pensar", "nao tenho interesse", "ja resolvi", "achei outro
//      advogado"). So o texto do cliente conta — a equipe dizendo "o valor e R$350" nao e recusa.
//
// Nada aqui fecha deal nenhum: e um relatorio pra decisao humana. Fechar como perdido continua sendo
// decisao do escritorio (e fecharNegocioSeAplicavel, no bot, exige evidencia validada por outro
// caminho).
//
//   node limpeza-agendamento-consulta.js [dir-da-auditoria]
require('dotenv').config();
const path = require('path');
const fs = require('fs');
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `limpeza-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const Database = require('better-sqlite3');
const duplicidade = require('./src/duplicidade');
const { escreverCsv } = require('./src/csv');
const { chaveConversa } = require('./src/telefone');

const STAGE_AGENDAMENTO = 179388;
const DIAS_ABANDONO = Number(process.env.LIMPEZA_DIAS_ABANDONO) || 21;

// Frases de RECUSA ditas pelo CLIENTE. Conservador de proposito: "caro" sozinho fica de fora (aparece
// em "vai ficar caro se eu nao resolver"), e so conta com negacao/valor explicito por perto.
const PADROES_DESINTERESSE = [
  { rotulo: 'preco', re: /\b(fora da minha realidade|nao tenho (esse|o) (valor|dinheiro)|muito (caro|alto) (pra|para) mim|nao posso pagar|sem condicoes de pagar|ta salgado)\b/i },
  { rotulo: 'vou_pensar', re: /\b(vou pensar|vou analisar|depois eu (te )?retorno|qualquer coisa eu (te )?chamo|vou ver com (meu|minha) )\b/i },
  { rotulo: 'sem_interesse', re: /\b(nao tenho interesse|nao quero mais|desisti|nao vou (mais )?(seguir|prosseguir|dar andamento)|deixa (pra la|quieto))\b/i },
  { rotulo: 'ja_resolvido', re: /\b(ja (resolvi|foi resolvido|consegui)|nao preciso mais|resolvi por (fora|conta propria))\b/i },
  { rotulo: 'outro_advogado', re: /\b(ja tenho (um )?advogad|outro (advogado|escritorio)|contratei (outro|um) )\b/i },
];

function normalizar(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function lerJsonl(caminho) {
  return fs.readFileSync(caminho, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function acharAuditoriaMaisRecente() {
  const base = 'auditoria-crm';
  const dirs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort();
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : null;
}

const dias = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

(async () => {
  const dir = process.argv[2] || acharAuditoriaMaisRecente();
  console.log(`📁 auditoria: ${dir}\n`);

  const todosDeals = lerJsonl(path.join(dir, 'deals.jsonl'));
  const contatos = new Map(lerJsonl(path.join(dir, 'contacts.jsonl')).map((c) => [c.id, c]));
  const alvo = todosDeals.filter((d) => d.stage?.id === STAGE_AGENDAMENTO && d.status === 'OPEN');
  console.log(`Deals ABERTOS no estágio "Agendamento de Consulta": ${alvo.length}\n`);

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  const db = fs.existsSync(caminhoBanco) ? new Database(caminhoBanco, { readonly: true }) : null;

  // telefone do contato -> pra cruzar mesmo quando o contactId difere
  function telefoneDoContato(contactId) {
    const c = contatos.get(contactId);
    const bruto = c?.phones?.[0]?.number || c?.phone || '';
    return chaveConversa(bruto) || '';
  }

  // ---- enriquecimento por deal ----
  const info = alvo.map((d) => {
    const contactId = d.contacts?.[0]?.id || null;
    const tel = contactId ? telefoneDoContato(contactId) : '';
    const { nomeParte, casoParte } = duplicidade.extrairNomeCaso(d.name);
    let conversa = null;
    if (db) {
      conversa = db.prepare('SELECT chat_id, contact_name, messages, last_data FROM conversations WHERE deal_id = ?').get(d.id) || null;
    }
    let msgs = [];
    try { msgs = conversa ? JSON.parse(conversa.messages || '[]') : []; } catch { /* ignore */ }
    const ultima = msgs[msgs.length - 1] || null;
    const ultimaCliente = [...msgs].reverse().find((m) => m.role === 'cliente') || null;

    const textoCliente = msgs.filter((m) => m.role === 'cliente').map((m) => normalizar(m.text)).join(' | ');
    const recusas = PADROES_DESINTERESSE.filter((p) => p.re.test(textoCliente)).map((p) => p.rotulo);

    return {
      id: d.id,
      nome: d.name,
      nomeParte,
      casoParte,
      origin: d.origin,
      criadoEm: d.dateCreated,
      idadeDias: dias(d.dateCreated),
      contactId,
      telefone: tel,
      temConversa: !!msgs.length,
      msgs: msgs.length,
      ultimaMsgEm: ultima?.timestamp || null,
      diasSemMsg: dias(ultima?.timestamp),
      ultimoFalante: ultima?.role || null,
      clienteJaRespondeu: !!ultimaCliente,
      recusas,
    };
  });

  // ================= 1. DUPLICIDADE =================
  const achados = [];

  // (a) mesmo contactId
  const porContato = new Map();
  for (const d of info) if (d.contactId) {
    if (!porContato.has(d.contactId)) porContato.set(d.contactId, []);
    porContato.get(d.contactId).push(d);
  }
  for (const [cid, lista] of porContato) {
    if (lista.length < 2) continue;
    achados.push({ forca: 'ALTA', tipo: 'mesmo_contato_no_crm', chave: `contato ${cid}`, deals: lista });
  }

  // (b) mesmo telefone, contatos diferentes
  const porTelefone = new Map();
  for (const d of info) if (d.telefone && d.telefone.length >= 8) {
    if (!porTelefone.has(d.telefone)) porTelefone.set(d.telefone, []);
    porTelefone.get(d.telefone).push(d);
  }
  for (const [tel, lista] of porTelefone) {
    if (lista.length < 2) continue;
    const contatosDistintos = new Set(lista.map((d) => d.contactId));
    if (contatosDistintos.size < 2) continue; // ja pego em (a)
    achados.push({ forca: 'ALTA', tipo: 'mesmo_telefone_contatos_diferentes', chave: `tel ...${tel.slice(-4)}`, deals: lista });
  }

  // (b2) MESMO TELEFONE/CONTATO contra a CONTA INTEIRA, nao so entre os 87. Foi o que revelou o
  // padrao mais forte da limpeza: 8 deals BOT_WHATSAPP deste estagio nao tem conversa local nenhuma,
  // 5 deles criados em 10/08/2026 — o dia do bug de buscarOuCriarContato (CLAUDE.md) — e quase todos
  // sao segunda copia de um negocio que ja existia. Comparar so dentro do estagio esconderia isso,
  // porque a outra ponta costuma estar em WON/LOST ou em outro estagio.
  const alvoIds = new Set(alvo.map((d) => d.id));
  const cruzados = [];
  for (const d of info) {
    if (!d.contactId && !d.telefone) continue;
    for (const outro of todosDeals) {
      if (outro.id === d.id) continue;
      const outroContato = outro.contacts?.[0]?.id || null;
      const outroTel = outroContato ? telefoneDoContato(outroContato) : '';
      const mesmoContato = !!(d.contactId && outroContato && d.contactId === outroContato);
      const mesmoTel = !!(d.telefone && outroTel && d.telefone === outroTel && d.telefone.length >= 8);
      if (!mesmoContato && !mesmoTel) continue;
      // Ja coberto pelos grupos (a)/(b) quando as duas pontas estao no estagio.
      if (alvoIds.has(outro.id)) continue;
      cruzados.push({
        deal: d,
        outro: { id: outro.id, nome: outro.name, status: outro.status, origin: outro.origin, criado: outro.dateCreated?.slice(0, 10) },
        sinal: [mesmoContato ? 'MESMO CONTATO' : '', mesmoTel ? 'MESMO TELEFONE' : ''].filter(Boolean).join(' + '),
      });
    }
  }

  // (c) CASO parecido, NOME diferente — o que o usuario pediu.
  // Frequencia de token calculada SO dentro dos 87 (universo comparado), como manda o comentario de
  // aplicarFrequenciaTokens: "generico" e relativo ao universo.
  const comCaso = info.filter((d) => d.casoParte && d.casoParte.trim());
  const freqCaso = new Map();
  for (const d of comCaso) {
    for (const t of new Set(duplicidade.tokensDoTexto(d.casoParte))) freqCaso.set(t, (freqCaso.get(t) || 0) + 1);
  }
  const jaPareado = new Set(achados.flatMap((a) => a.deals.map((d) => d.id)));
  for (let i = 0; i < comCaso.length; i++) {
    for (let j = i + 1; j < comCaso.length; j++) {
      const a = comCaso[i]; const b = comCaso[j];
      if (jaPareado.has(a.id) && jaPareado.has(b.id)) continue;
      const nomeIgual = duplicidade.similaridadeContainment(duplicidade.tokensDoTexto(a.nomeParte), duplicidade.tokensDoTexto(b.nomeParte)) >= 0.75;
      if (nomeIgual) continue; // nome parecido ja e o caso classico, coberto pela auditoria
      const sim = duplicidade.similaridadeTexto(a.casoParte, b.casoParte);
      if (sim < 0.5) continue;
      // Token generico (aparece em 3+ dos 87) nao sustenta o par sozinho.
      const tokensComuns = duplicidade.tokensDoTexto(a.casoParte).filter((t) => duplicidade.tokensDoTexto(b.casoParte).includes(t));
      const especificos = tokensComuns.filter((t) => (freqCaso.get(t) || 0) <= 2);
      if (!especificos.length) continue;
      achados.push({
        forca: 'REVISAR',
        tipo: 'caso_parecido_nome_diferente',
        chave: `sim ${sim.toFixed(2)} · tokens ${especificos.join(',')}`,
        deals: [a, b],
      });
    }
  }

  console.log('='.repeat(70));
  console.log('1. DUPLICIDADE\n');
  const porForca = { ALTA: achados.filter((a) => a.forca === 'ALTA'), REVISAR: achados.filter((a) => a.forca === 'REVISAR') };
  for (const forca of ['ALTA', 'REVISAR']) {
    console.log(`${forca}: ${porForca[forca].length} grupo(s)`);
    for (const a of porForca[forca]) {
      console.log(`  [${a.tipo}] ${a.chave}`);
      for (const d of a.deals) console.log(`     ${d.id} · "${d.nome}" · ${d.origin} · criado ha ${d.idadeDias}d`);
    }
    console.log('');
  }

  // Cruzamento com a conta inteira, agrupado por deal do estagio
  const cruzPorDeal = new Map();
  for (const c of cruzados) {
    if (!cruzPorDeal.has(c.deal.id)) cruzPorDeal.set(c.deal.id, []);
    cruzPorDeal.get(c.deal.id).push(c);
  }
  console.log(`CRUZAMENTO COM A CONTA INTEIRA (mesmo telefone/contato fora do estágio): ${cruzPorDeal.size} deal(s)\n`);
  for (const [dealId, lista] of [...cruzPorDeal].sort((a, b) => b[1].length - a[1].length)) {
    const d = info.find((x) => x.id === dealId);
    console.log(`  ${dealId} · "${d.nome}" · criado ${d.criadoEm?.slice(0, 10)}${d.temConversa ? '' : ' · ⚠️ SEM CONVERSA LOCAL'}`);
    for (const c of lista) console.log(`     ↔ ${c.outro.id} "${c.outro.nome}" [${c.outro.status}, ${c.outro.origin}, ${c.outro.criado}] ${c.sinal}`);
  }
  console.log('');

  // ================= 2 e 3. ABANDONO / DESINTERESSE =================
  const comConversa = info.filter((d) => d.temConversa);
  const semConversa = info.filter((d) => !d.temConversa);

  const equipeFalouPorUltimo = comConversa.filter((d) => d.ultimoFalante === 'equipe' && d.diasSemMsg >= DIAS_ABANDONO);
  const clienteFalouPorUltimo = comConversa.filter((d) => d.ultimoFalante === 'cliente' && d.diasSemMsg >= DIAS_ABANDONO);
  const clienteNuncaFalou = comConversa.filter((d) => !d.clienteJaRespondeu);
  const comRecusa = comConversa.filter((d) => d.recusas.length);

  console.log('='.repeat(70));
  console.log('2. ABANDONO (conversas locais disponíveis: ' + comConversa.length + ' de ' + info.length + ')\n');
  console.log(`Sem conversa local (Moskit Boost / sem espelho): ${semConversa.length} — dá pra julgar só pela idade do deal`);
  console.log(`\n🔴 EQUIPE falou por último e o cliente sumiu há ${DIAS_ABANDONO}+ dias: ${equipeFalouPorUltimo.length}`);
  for (const d of equipeFalouPorUltimo.sort((a, b) => b.diasSemMsg - a.diasSemMsg)) {
    console.log(`   ${d.id} · "${d.nome}" · ${d.diasSemMsg}d sem resposta${d.recusas.length ? ` · RECUSA: ${d.recusas.join(',')}` : ''}`);
  }
  console.log(`\n🟡 CLIENTE falou por último e ninguém respondeu há ${DIAS_ABANDONO}+ dias (falha DO ESCRITÓRIO, não do lead): ${clienteFalouPorUltimo.length}`);
  for (const d of clienteFalouPorUltimo.sort((a, b) => b.diasSemMsg - a.diasSemMsg)) {
    console.log(`   ${d.id} · "${d.nome}" · ${d.diasSemMsg}d esperando resposta`);
  }
  if (clienteNuncaFalou.length) {
    console.log(`\n⚪ Cliente NUNCA respondeu nenhuma mensagem: ${clienteNuncaFalou.length}`);
    for (const d of clienteNuncaFalou) console.log(`   ${d.id} · "${d.nome}" · ${d.msgs} msgs, todas da equipe`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('3. DESINTERESSE DECLARADO PELO CLIENTE (varredura de frase, só mensagens do cliente)\n');
  console.log(`${comRecusa.length} deal(s) com frase de recusa:`);
  for (const d of comRecusa.sort((a, b) => (b.diasSemMsg || 0) - (a.diasSemMsg || 0))) {
    console.log(`   ${d.id} · "${d.nome}" · ${d.recusas.join(', ')} · ${d.diasSemMsg}d sem msg`);
  }

  // Deals velhos SEM conversa local — só a idade fala
  const velhosSemConversa = semConversa.filter((d) => d.idadeDias >= 60).sort((a, b) => b.idadeDias - a.idadeDias);
  console.log('\n' + '='.repeat(70));
  console.log(`4. SEM CONVERSA LOCAL e parados há 60+ dias no primeiro estágio: ${velhosSemConversa.length}`);
  for (const d of velhosSemConversa) console.log(`   ${d.id} · "${d.nome}" · ${d.origin} · criado há ${d.idadeDias}d`);

  // ---- CSV ----
  const dupPorDeal = new Map();
  for (const a of achados) {
    for (const d of a.deals) {
      const outros = a.deals.filter((x) => x.id !== d.id).map((x) => `${x.id} (${x.nome})`).join(' + ');
      dupPorDeal.set(d.id, `${a.forca}:${a.tipo} -> ${outros}`);
    }
  }
  const linhas = info
    .map((d) => ({
      deal_id: d.id,
      nome: d.nome,
      origin: d.origin,
      link: `https://app.ollow.com.br/?/deal/${d.id}`,
      idade_dias: d.idadeDias,
      tem_conversa: d.temConversa,
      msgs: d.msgs,
      dias_sem_msg: d.diasSemMsg ?? '',
      ultimo_falante: d.ultimoFalante || '',
      cliente_ja_respondeu: d.temConversa ? d.clienteJaRespondeu : '',
      frases_de_recusa: d.recusas.join('|'),
      duplicidade: dupPorDeal.get(d.id) || '',
      mesmo_cliente_fora_do_estagio: (cruzPorDeal.get(d.id) || []).map((c) => `${c.outro.id} "${c.outro.nome}" [${c.outro.status}] ${c.sinal}`).join(' | '),
      sugestao: sugerir(d, dupPorDeal.get(d.id), cruzPorDeal.get(d.id)),
    }))
    .sort((a, b) => (b.dias_sem_msg || 0) - (a.dias_sem_msg || 0));

  function sugerir(d, dup, cruz) {
    if (dup && dup.startsWith('ALTA')) return 'REVISAR DUPLICIDADE (sinal forte, dentro do estágio)';
    // Deal do bot SEM conversa local e com o mesmo cliente em outro negócio = a assinatura do bug de
    // 10/08. Vem antes das regras de abandono: o problema aqui não é o lead, é o registro em si.
    if (!d.temConversa && d.origin === 'BOT_WHATSAPP' && cruz?.length) return 'PROVÁVEL DUPLICATA ÓRFÃ (bot, sem conversa, mesmo cliente em outro negócio)';
    if (d.recusas.length) return 'CANDIDATO A PERDIDO (recusa explícita do cliente)';
    if (d.temConversa && d.ultimoFalante === 'equipe' && d.diasSemMsg >= DIAS_ABANDONO) return 'CANDIDATO A PERDIDO (cliente sumiu)';
    if (d.temConversa && d.ultimoFalante === 'cliente' && d.diasSemMsg >= DIAS_ABANDONO) return 'RETOMAR CONTATO (cliente esperando resposta)';
    if (cruz?.length) return 'REVISAR (mesmo cliente tem outro negócio fora do estágio)';
    if (!d.temConversa && d.idadeDias >= 60) return 'REVISAR (velho, sem conversa pra julgar)';
    return '';
  }

  const saida = path.join(dir, 'limpeza-agendamento-consulta.csv');
  const r = escreverCsv(saida, linhas, {
    cabecalho: ['deal_id', 'nome', 'origin', 'link', 'idade_dias', 'tem_conversa', 'msgs', 'dias_sem_msg', 'ultimo_falante', 'cliente_ja_respondeu', 'frases_de_recusa', 'duplicidade', 'mesmo_cliente_fora_do_estagio', 'sugestao'],
  });

  console.log('\n' + '='.repeat(70));
  const porSugestao = {};
  for (const l of linhas) porSugestao[l.sugestao || '(nada a fazer)'] = (porSugestao[l.sugestao || '(nada a fazer)'] || 0) + 1;
  console.log('RESUMO DAS SUGESTÕES:');
  for (const [s, n] of Object.entries(porSugestao).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${s}`);
  console.log(`\n📄 ${r.caminho} (${r.linhas} linhas)`);
  if (db) db.close();
})();
