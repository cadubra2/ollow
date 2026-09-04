// Simulacao de 10 leads pelo pipeline REAL (processarConversaDirect), escrevendo num FUNIL DE TESTE
// do Moskit — nunca no funil de producao. Pedido do usuario em 03/09/2026: "crie 10 bots pra testar
// um monte de coisas e procurar erros, so que faca esse teste em um funil de teste".
//
// POR QUE ISSO EXISTE, e por que nao basta `npm test`: a suite roda com a rede DUBLADA. Quase todo
// bug serio ja documentado no CLAUDE.md foi achado contra a API REAL — o 422 de `activities`, o 422
// de `createdBy`, a paginacao que so funciona com `?start=`, o cache de 4s no GET pos-PUT. Este
// script fecha essa lacuna: cadeia de producao de verdade, OpenAI de verdade, Moskit de verdade,
// mas com o destino trocado.
//
// COMO O ISOLAMENTO E FEITO (cada linha aqui e uma forma de nao sujar producao):
//   - Funil: TODOS os estagios sao sobrescritos por env var (MOSKIT_STAGE_*), apontando para o
//     pipeline de teste. O bot nunca ve os estagios de producao.
//   - Banco: DB_PATH descartavel, como todo teste do projeto.
//   - Telegram: token/chat removidos — `enviarTelegram` retorna em silencio quando faltam (nao
//     lanca), entao a equipe nao recebe nada.
//   - Google Agenda: credenciais removidas. `getGoogleAuthClient()` devolve null e
//     handleAgendamentoCalendar segue sem evento — o caminho ja previsto para "ambiente sem
//     credencial", que NAO conta como falha de agendamento.
//   - ZapSign: chave removida, para nao criar documento nem disparar e-mail de assinatura real.
//   - Contatos: NAO tem como isolar (contato no Moskit nao pertence a funil). Os 10 nascem com o
//     prefixo do TAG abaixo no nome e sao apagados no fim, junto com os negocios.
//
//   node simular-10-leads-funil-teste.js            (dry-run: so lista os cenarios, nao chama nada)
//   node simular-10-leads-funil-teste.js --aplicar  (roda de verdade: OpenAI + Moskit de teste)
//   node simular-10-leads-funil-teste.js --limpar   (apaga os negocios/contatos que ele criou)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------------------------
// Isolamento — TUDO isto precisa vir ANTES do require('./index.js'), que le env no carregamento.
// ---------------------------------------------------------------------------------------------
const PIPELINE_TESTE = Number(process.env.PIPELINE_TESTE) || 107282;
const STAGES_TESTE = {
  MOSKIT_STAGE_ID: '516685',                     // Agendamento de Consulta
  MOSKIT_STAGE_CONSULTA_AGENDADA: '516686',
  MOSKIT_STAGE_AGUARDANDO_CONDICAO: '516687',
  MOSKIT_STAGE_ELABORACAO_PROPOSTA: '516688',
  MOSKIT_STAGE_NEGOCIACAO: '516689',
  MOSKIT_STAGE_ELABORACAO_CONTRATO: '516690',
  MOSKIT_STAGE_CONTRATO_ENVIADO: '516691',
};
Object.assign(process.env, STAGES_TESTE);
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(os.tmpdir(), `simulacao-10-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_ID;
delete process.env.ZAPSIGN_API_KEY;
delete process.env.ZAPSIGN_TEMPLATE_TOKEN;
// Funil ligado de verdade: o objetivo aqui e justamente exercitar o avanco de estagio contra a API.
process.env.FUNIL_DRY_RUN = 'false';
process.env.FUNIL_FECHAMENTO_DRY_RUN = 'true'; // fechamento continua so sugerindo, como em producao

const axios = require('axios');
const Database = require('better-sqlite3');
const bot = require('./index.js');
const MOSKIT_IDS = require('./src/moskit-ids');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json' };
const APLICAR = process.argv.includes('--aplicar');
const LIMPAR = process.argv.includes('--limpar');
const TAG = 'ZZTESTE';
const REGISTRO = path.join(__dirname, '.simulacao-10-criados.json');

const db = new Database(process.env.DB_PATH);

// ---------------------------------------------------------------------------------------------
// Espelho de contatos: copiado de uma copia do banco de PRODUCAO (so a tabela moskit_contacts,
// nunca as conversas — nao ha razao pra carregar conversa de cliente real pra dentro de um teste).
//
// Sem isso a simulacao nao vale: buscarOuCriarContato so conclui "este contato nao existe" quando a
// varredura da API alcanca uma pagina que o espelho ja conhece, e um espelho VAZIO nunca e
// alcancado — a funcao lanca, corretamente, porque a duvida e real. Em producao o espelho tem ~3.8k
// contatos e o encontro acontece nas primeiras paginas. Rodar sem espelho testaria um cenario que
// nao existe na producao (instalacao nova, sem importacao nenhuma).
const ESPELHO_ORIGEM = process.env.ESPELHO_CONTATOS_DB;
if (ESPELHO_ORIGEM && fs.existsSync(ESPELHO_ORIGEM)) {
  const origem = new Database(ESPELHO_ORIGEM, { readonly: true });
  const linhas = origem.prepare('SELECT phone, moskit_id, name FROM moskit_contacts').all();
  origem.close();
  const ins = db.prepare('INSERT OR REPLACE INTO moskit_contacts (phone, moskit_id, name, raw_data) VALUES (?,?,?,?)');
  const tx = db.transaction((rs) => { for (const r of rs) ins.run(r.phone, r.moskit_id, r.name || '', '{}'); });
  tx(linhas);
  console.log(`📇 espelho de contatos carregado: ${linhas.length} contatos (de ${path.basename(ESPELHO_ORIGEM)})`);
} else {
  console.log('⚠️  sem ESPELHO_CONTATOS_DB — a busca de contato vai lançar por não alcançar o espelho (esperado)');
}

const agora = Date.now();
const ts = (minutosAtras) => new Date(agora - minutosAtras * 60000).toISOString();

// Telefones ficticios com DDD 86 e sufixo reservado 9000xxxx — nao colidem com cliente real, e o
// numero interno da equipe e barrado por ehInterno de qualquer jeito.
const tel = (n) => `55869${String(90000000 + n)}`;

// ---------------------------------------------------------------------------------------------
// Os 10 cenarios. Cada um mira uma regra especifica do pipeline — a coluna `espero` e o que o
// codigo DEVERIA fazer, e e contra ela que o relatorio final compara.
// ---------------------------------------------------------------------------------------------
const CENARIOS = [
  {
    id: 1, nome: 'Lead completo', mira: 'caminho feliz: caso descrito → deal com todos os campos',
    espero: 'cria deal; assunto real (nao placeholder); area/advogado preenchidos',
    msgs: [
      ['cliente', 'Oi, vi vocês no Instagram e queria uma consulta', 40],
      ['equipe', 'Olá! Claro. Pode me contar um pouco do seu caso?', 38],
      ['cliente', 'Sou servidora pública e tive meu pedido de remoção por motivo de saúde negado pela administração. Queria entrar na justiça.', 35],
      ['equipe', 'Entendi. Vou verificar a agenda do Dr. Berto e te retorno.', 30],
    ],
  },
  {
    id: 2, nome: 'Sem caso descrito', mira: 'gate do caso descrito (deveEsperarCasoDescrito)',
    espero: 'NAO cria deal — ninguem descreveu o caso',
    msgs: [
      ['cliente', 'Bom dia, gostaria de marcar uma consulta com o Dr. Berto', 40],
      ['equipe', 'Bom dia! Qual seria o melhor horário para você?', 35],
      ['cliente', 'De manhã é melhor', 30],
    ],
  },
  {
    id: 3, nome: 'Dupla confirmacao sem caso', mira: 'excecao do gate: horario fechado cria deal mesmo sem caso',
    espero: 'CRIA deal (excecao), com area/advogado VAZIOS e assunto placeholder',
    msgs: [
      ['cliente', 'Queria agendar uma consulta', 60],
      ['equipe', 'Posso te encaixar quinta-feira às 15h, pode ser?', 55],
      ['cliente', 'Pode sim, quinta às 15h está ótimo', 50],
      ['equipe', 'Perfeito, sua consulta está agendada para quinta-feira às 15h.', 45],
    ],
  },
  {
    id: 4, nome: 'Assunto = nome de area', mira: 'rejeitarAssuntoQueEhArea',
    espero: 'assunto NAO pode ser "Direito do Consumidor" no titulo — vira placeholder',
    msgs: [
      ['cliente', 'Preciso de ajuda com uma questão de direito do consumidor', 40],
      ['equipe', 'Certo, pode detalhar o que aconteceu?', 35],
      ['cliente', 'É sobre direito do consumidor mesmo, prefiro explicar na consulta', 30],
    ],
  },
  {
    id: 5, nome: 'Origem deterministica', mira: 'aplicarPadroesDeterministicosDeOrigem (JusBrasil)',
    espero: 'origem preenchida sem depender do modelo lembrar',
    msgs: [
      ['cliente', 'Achei o escritório no JusBrasil', 40],
      ['equipe', 'Que bom! Como podemos ajudar?', 38],
      ['cliente', 'Comprei um apartamento na planta e a construtora atrasou a entrega em 2 anos. Quero rescindir e ser indenizado.', 35],
    ],
  },
  {
    id: 6, nome: 'Numero interno', mira: 'ehInterno — socio/equipe nunca vira lead',
    espero: 'NAO cria contato nem deal, em nenhuma hipotese',
    interno: true,
    msgs: [
      ['cliente', 'testando o bot aqui, meu caso é sobre rescisão de contrato', 30],
    ],
  },
  {
    id: 7, nome: 'Bloco de condicoes', mira: 'checkpoint do bloco de condicoes → consulta PAGA',
    espero: 'tipo_consulta = consulta paga e price 35000',
    msgs: [
      ['cliente', 'Boa tarde, preciso de um advogado', 60],
      ['equipe', 'Boa tarde! Me conta o que houve.', 58],
      ['cliente', 'Fui demitido sem justa causa e não recebi as verbas rescisórias', 55],
      ['equipe', 'A consulta com nosso advogado tem o valor de R$ 350,00 (trezentos e cinquenta reais), podendo ser paga via PIX, cartão ou transferência. A consulta tem duração aproximada de 1 hora.', 50],
      ['cliente', 'Certo, vou fazer o pix', 45],
    ],
  },
  {
    id: 8, nome: 'Cliente existente sem DDI', mira: 'A CORRECAO DE 03/09: telefone com/sem DDI e o mesmo cliente',
    espero: 'REUSA o contato ja existente — nao cria um segundo',
    preCriarContatoSemDdi: true,
    msgs: [
      ['cliente', 'Oi, sou cliente de vocês. Tenho um caso novo: minha vizinha construiu um muro invadindo meu terreno.', 40],
      ['equipe', 'Olá! Vamos verificar isso para você.', 35],
    ],
  },
  {
    id: 9, nome: 'Assunto sobrevive a rodada muda', mira: 'A CORRECAO DE 03/09: placeholder nao apaga assunto real',
    espero: 'depois da 2a rodada (so agendamento), o assunto real CONTINUA no titulo',
    duasRodadas: true,
    msgs: [
      ['cliente', 'Meu FIES foi calculado errado, quero revisar o abatimento por tempo de serviço no SUS', 60],
      ['equipe', 'Entendido, vou verificar com o Dr. Iury.', 55],
    ],
    msgsRodada2: [
      ['equipe', 'Consegui um horário na terça às 9h.', 20],
      ['cliente', 'Perfeito, obrigado', 15],
    ],
  },
  {
    id: 10, nome: 'Horario implausivel (eco da ancora)', mira: 'motivoHorarioImplausivel — eco da data-ancora',
    espero: 'NAO agenda com horario copiado do timestamp; registra pendencia',
    msgs: [
      ['cliente', 'Preciso de ajuda com um inventário, meu pai faleceu e temos um imóvel para partilhar', 40],
      ['equipe', 'Sinto muito. Podemos marcar uma consulta para tratar disso.', 35],
      ['cliente', 'Pode ser amanhã de tarde?', 30],
      ['equipe', 'Amanhã à tarde temos horário sim.', 25],
    ],
  },
];

function semear(chatId, msgs, nome) {
  db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
  const mensagens = msgs.map(([role, text, min], i) => ({ id: `${chatId}-${i}`, role, text, timestamp: ts(min) }));
  db.prepare('INSERT INTO conversations (chat_id, phone, contact_name, messages, last_activity) VALUES (?,?,?,?,?)')
    .run(chatId, chatId, nome, JSON.stringify(mensagens), new Date().toISOString());
}

function anexar(chatId, msgs) {
  const row = db.prepare('SELECT messages FROM conversations WHERE chat_id = ?').get(chatId);
  const atuais = JSON.parse(row.messages || '[]');
  const novas = msgs.map(([role, text, min], i) => ({ id: `${chatId}-r2-${i}`, role, text, timestamp: ts(min) }));
  db.prepare('UPDATE conversations SET messages = ? WHERE chat_id = ?').run(JSON.stringify([...atuais, ...novas]), chatId);
}

const getDeal = async (id) => (await axios.get(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 500 })).data;

async function limpar() {
  if (!fs.existsSync(REGISTRO)) { console.log('Nada registrado para limpar.'); return; }
  const { deals = [], contatos = [] } = JSON.parse(fs.readFileSync(REGISTRO, 'utf-8'));
  console.log(`🧹 apagando ${deals.length} negócio(s) e ${contatos.length} contato(s) de teste...`);
  for (const id of deals) {
    const r = await axios.delete(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    console.log(`  deal ${id} → ${r.status}`);
    await new Promise((x) => setTimeout(x, 300));
  }
  for (const id of contatos) {
    const r = await axios.delete(`${MOSKIT_BASE}/contacts/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 600 });
    console.log(`  contato ${id} → ${r.status}`);
    await new Promise((x) => setTimeout(x, 300));
  }
  fs.unlinkSync(REGISTRO);
  console.log('Limpeza concluída.');
}

(async () => {
  if (LIMPAR) { await limpar(); return; }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`SIMULACAO DE 10 LEADS — funil de teste ${PIPELINE_TESTE} (estágio inicial ${STAGES_TESTE.MOSKIT_STAGE_ID})`);
  console.log(APLICAR ? '🚨 --aplicar: chama OpenAI e Moskit DE VERDADE (no funil de teste)' : '🔍 dry-run: só lista os cenários');
  console.log(`${'='.repeat(78)}\n`);

  for (const c of CENARIOS) {
    console.log(`${String(c.id).padStart(2)}. ${c.nome.padEnd(32)} → ${c.mira}`);
    console.log(`    espero: ${c.espero}`);
  }
  if (!APLICAR) { console.log('\nRode com --aplicar para executar.'); return; }

  // Registro ACUMULA entre rodadas em vez de sobrescrever. Aprendido na marra em 04/09/2026: uma
  // rodada com --cenario=7 zerou o registro dos 6 negocios da rodada anterior, e o --limpar so achou
  // 1 — os outros 5 ficaram orfaos no funil de teste ate uma varredura manual. Sobra de teste que o
  // proprio teste nao limpa e pior que teste nenhum: o cenario 8 chegou a casar com um contato
  // "ZZTESTE Cliente Antigo" de uma rodada anterior e eu quase reportei isso como bug de producao.
  const criados = fs.existsSync(REGISTRO)
    ? JSON.parse(fs.readFileSync(REGISTRO, 'utf-8'))
    : { deals: [], contatos: [] };
  const resultados = [];

  // --cenario=N roda um so — util pra investigar uma falha especifica sem pagar a OpenAI dos outros 9.
  const filtro = (process.argv.find((a) => a.startsWith('--cenario=')) || '').split('=')[1];
  const aRodar = filtro ? CENARIOS.filter((c) => String(c.id) === filtro) : CENARIOS;

  for (const c of aRodar) {
    const chatId = c.interno ? (process.env.TEAM_PHONES || '').split(',')[0]?.trim() || tel(c.id) : tel(c.id);
    const nome = `${TAG} Cenario ${c.id}`;
    console.log(`\n${'─'.repeat(78)}\n▶️  CENARIO ${c.id}: ${c.nome}  (chat ${chatId})`);

    // Cenario 8 precisa do contato JA existente, gravado sem DDI — a situacao exata do bug.
    if (c.preCriarContatoSemDdi) {
      const semDdi = chatId.replace(/^55/, '');
      const r = await axios.post(`${MOSKIT_BASE}/contacts`, {
        name: `${TAG} Cliente Antigo`, createdBy: { id: MOSKIT_IDS.LAYLA_USER_ID },
        responsible: { id: MOSKIT_IDS.LAYLA_USER_ID }, phones: [{ number: semDdi }],
      }, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      if (r.data?.id) { criados.contatos.push(r.data.id); c.contatoPreExistente = r.data.id; }
      console.log(`    contato pré-existente criado SEM DDI (${semDdi}) → id ${r.data?.id}`);
      await new Promise((x) => setTimeout(x, 500));
    }

    semear(chatId, c.msgs, nome);
    let erro = null;
    try {
      await bot.processarConversaDirect(chatId);
      if (c.duasRodadas) {
        anexar(chatId, c.msgsRodada2);
        console.log('    (2ª rodada: só agendamento, sem caso novo)');
        await bot.processarConversaDirect(chatId);
      }
    } catch (e) { erro = e.message; console.error(`    ❌ EXCECAO: ${e.message}`); }

    const linha = db.prepare('SELECT deal_id, last_action, last_data FROM conversations WHERE chat_id = ?').get(chatId);
    const dealId = linha?.deal_id || null;
    if (dealId) criados.deals.push(dealId);

    let deal = null;
    if (dealId) { await new Promise((x) => setTimeout(x, 4500)); deal = await getDeal(dealId); }
    resultados.push({ c, chatId, dealId, deal, linha, erro });
    fs.writeFileSync(REGISTRO, JSON.stringify(criados, null, 2));
    await new Promise((x) => setTimeout(x, 700));
  }

  // -------------------------------------------------------------------------------------------
  console.log(`\n\n${'='.repeat(78)}\nRESULTADO\n${'='.repeat(78)}`);
  const CF = MOSKIT_IDS.CF;
  const opt = (d, id) => (d?.entityCustomFields || []).find((f) => f.id === id)?.options?.[0] || null;
  const rotulo = (mapa, id) => Object.entries(mapa).find(([, v]) => v === id)?.[0] || (id ? `id:${id}` : '—');

  for (const r of resultados) {
    const { c, deal, dealId, linha } = r;
    console.log(`\n${String(c.id).padStart(2)}. ${c.nome}`);
    console.log(`    espero : ${c.espero}`);
    if (r.erro) { console.log(`    ❌ EXCECAO: ${r.erro}`); continue; }
    if (!dealId) { console.log(`    obtive : nenhum deal criado (last_action=${linha?.last_action})`); continue; }
    const noFunilCerto = String(deal?.stage?.id) in Object.fromEntries(Object.values(STAGES_TESTE).map((v) => [v, 1]));
    console.log(`    obtive : deal ${dealId} "${deal?.name}"`);
    console.log(`             estágio ${deal?.stage?.id} ${noFunilCerto ? '(funil de teste ✅)' : '⚠️  FORA DO FUNIL DE TESTE'} · price R$${(deal?.price || 0) / 100}`);
    console.log(`             área=${rotulo(MOSKIT_IDS.AREA_DIREITO, opt(deal, CF.AREA_DIREITO))} · advogado=${rotulo(MOSKIT_IDS.RESPONSAVEL_PROCESSO, opt(deal, CF.RESPONSAVEL))}`);
    console.log(`             tipo=${rotulo(MOSKIT_IDS.TIPO_CONSULTA, opt(deal, CF.TIPO_CONSULTA))} · origem=${rotulo(MOSKIT_IDS.ORIGEM, opt(deal, CF.ORIGEM))}`);
    console.log(`             contatos=${JSON.stringify((deal?.contacts || []).map((x) => x.id))}${c.contatoPreExistente ? ` (pré-existente era ${c.contatoPreExistente})` : ''}`);
  }

  console.log(`\n\nCriados: ${criados.deals.length} negócio(s), ${criados.contatos.length} contato(s) — registrados em ${REGISTRO}`);
  console.log('Para apagar tudo: node simular-10-leads-funil-teste.js --limpar');
})();
