// Dos deals do bot sem origem (ou "Nao identificado"), quais tem o SINAL de origem detectavel
// deterministicamente no texto — versus os que o modelo ja examinou e genuinamente nao achou nada.
//
//   node recuperar-origem-perdida.js               (so leitura — como sempre foi)
//   node recuperar-origem-perdida.js --aplicar      (ESCREVE a origem detectada nos deals reais do Moskit)
//
// Por que existe: o estudo anterior (estudar-deals-sem-origem.js) achou 12 deals com
// last_action='inviavel' cujo last_data foi zerado pra `{}` por um bug de merge (ver CLAUDE.md,
// "Moskit CRM" / index.js:3663-3665,3725-3727 na numeracao da epoca) — mas esse bug so apaga
// `last_data`, nunca `messages`. A conversa inteira continua salva; so a CONCLUSAO sobre ela foi
// perdida. Este script relê o texto bruto e sinaliza mencao a canal de entrada conhecido, pra
// separar "a informacao ainda existe, so nao foi re-extraida" de "o cliente nunca disse de onde veio".
//
// Decisao do escritorio, 02/09/2026: "Nao identificado" pode continuar sendo aceito na criacao do
// deal (nao vira gate de bloqueio — ver deveEsperarCamposObrigatorios em index.js), mas a automacao
// deve tentar ao MAXIMO identificar a origem antes disso. Este script e a 3a frente dessa decisao —
// as outras duas sao o vocabulario ampliado de aplicarPadroesDeterministicosDeOrigem (roda em toda
// extracao nova, dai em diante) e detectarRespostaPerguntaOrigem (equipe pergunta, cliente responde).
// Este arquivo cobre o HISTORICO: deals que ja nasceram antes dessas duas melhorias existirem.
//
// MESMA REGRA que roda em producao (aplicarPadroesDeterministicosDeOrigem/
// detectarRespostaPerguntaOrigem, importadas de index.js), nao uma copia local: a mesma pergunta
// ("essa conversa tem sinal de origem?") nao pode ter duas respostas diferentes dependendo de qual
// caminho de codigo a examina — foi exatamente esse tipo de divergencia silenciosa que motivou
// src/moskit-ids.js virar fonte unica para os IDs.
//
// Modo leitura: zero chamada de rede, so grep de texto sobre mensagens ja salvas localmente.
// Modo --aplicar: GET + PUT reais no Moskit — ver protecoes abaixo antes de rodar.
const path = require('path');
require('dotenv').config();

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `recuperar-origem-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');
const { aplicarPadroesDeterministicosDeOrigem } = require('./index');
const moskitIds = require('./src/moskit-ids');

const APLICAR = process.argv.includes('--aplicar');
const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const CF_ORIGEM = moskitIds.CF.ORIGEM;
const headers = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
  'X-Ollow-Origin': 'BOT_WHATSAPP',
};

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

// Sinal deterministico sobre a conversa inteira, usando a MESMA funcao que roda em toda extracao
// nova — nunca retorna algo ambiguo (a funcao so devolve um valor canonico ou null), entao todo
// resultado aqui e diretamente aplicavel, sem "Video (Youtube/Instagram/TikTok — conferir qual)"
// exigindo escolha humana como o script tinha antes desta reescrita.
function sinalDeterministico(mensagens) {
  const dados = { origem: null };
  aplicarPadroesDeterministicosDeOrigem(dados, mensagens || []);
  return dados.origem;
}

(async () => {
  console.log(`\n🔍 Recuperacao de sinal de origem em conversas com last_data perdido ou "Nao identificado"`);
  console.log(`   modo: ${APLICAR ? 'APLICANDO — vai escrever no Moskit real' : 'so leitura, zero chamada de rede'}\n`);

  const caminhoBanco = process.env.CONVERSATIONS_DB || 'conversations.db';
  if (!fs.existsSync(caminhoBanco)) {
    console.error(`❌ Banco nao encontrado em ${caminhoBanco} (defina CONVERSATIONS_DB= para apontar pra producao)`);
    process.exit(1);
  }
  const db = new Database(caminhoBanco, { readonly: true });
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, contact_name, last_data, last_action, messages
    FROM conversations
    WHERE deal_id IS NOT NULL
  `).all();
  db.close();

  // Grupo B: last_data foi zerado pelo bug do ramo 'inviavel'/'interno' (o candidato real a
  // recuperacao — a conversa esta intacta, so a conclusao sumiu).
  const grupoB = linhas.filter((l) => ['inviavel', 'interno'].includes(l.last_action));

  // Grupo A: o modelo JA concluiu "Nao identificado" com a conversa inteira disponivel (nao foi
  // afetado pelo bug do grupo B). Mede o GAP REAL de reconhecimento do modelo, separado do bug.
  const grupoA = linhas.filter((l) => {
    const dados = parseJsonSeguro(l.last_data, null);
    return dados && String(dados.origem || '').trim().toLowerCase() === 'nao identificado';
  });

  console.log(`💾 Banco (${caminhoBanco}, readonly): ${linhas.length} deal(s) do bot no total`);
  console.log(`   Grupo B (last_data perdido por 'inviavel'/'interno'): ${grupoB.length} deal(s)`);
  console.log(`   Grupo A (ja concluido 'Nao identificado', sem o bug): ${grupoA.length} deal(s)\n`);

  // Sinal computado UMA VEZ por deal (nao duas — sinalDeterministico loga cada padrao que aciona, e
  // chama-la duas vezes por deal duplicaria esse log sem motivo).
  function analisar(lista) {
    return lista.map((l) => {
      const mensagens = parseJsonSeguro(l.messages, []) || [];
      return { linha: l, mensagens, origemDetectada: sinalDeterministico(mensagens) };
    });
  }

  function relatarGrupo(nome, analisados) {
    console.log('='.repeat(70));
    console.log(`${nome}\n`);
    for (const { linha: l, mensagens, origemDetectada } of analisados) {
      const textoCliente = mensagens.filter((m) => m.role === 'cliente').map((m) => m.text).join(' | ');
      console.log(`Deal ${l.deal_id} — ${l.contact_name || '(sem nome)'} (chat ${l.chat_id}, last_action=${l.last_action})`);
      console.log(origemDetectada ? `  ✅ SINAL ENCONTRADO: ${origemDetectada}` : '  ⚠️ nenhum sinal deterministico — provavelmente "Nao identificado" mesmo');
      console.log(`  Mensagens do cliente (${mensagens.filter((m) => m.role === 'cliente').length}): ${textoCliente.slice(0, 400)}${textoCliente.length > 400 ? '...' : ''}`);
      console.log('');
    }
  }

  const analisadosB = analisar(grupoB);
  const analisadosA = analisar(grupoA);
  relatarGrupo('GRUPO B — last_data perdido (bug inviavel/interno), conversa intacta', analisadosB);
  relatarGrupo('GRUPO A — modelo ja concluiu "Nao identificado" (sem o bug)', analisadosA);

  const recuperaveisB = analisadosB.filter((c) => c.origemDetectada);
  const gapReaisA = analisadosA.filter((c) => c.origemDetectada);
  console.log('='.repeat(70));
  console.log(`Grupo B (afetado pelo bug): ${recuperaveisB.length} de ${grupoB.length} tem sinal deterministico recuperavel no texto.`);
  console.log(`Grupo A (modelo examinou e concluiu sozinho): ${gapReaisA.length} de ${grupoA.length} tem sinal que o modelo deixou passar — este e o GAP REAL de reconhecimento, separado do bug.`);
  if (gapReaisA.length) console.log(`  deals: ${gapReaisA.map((c) => c.linha.deal_id).join(', ')}`);

  const todosCandidatos = [...recuperaveisB, ...gapReaisA];
  if (!todosCandidatos.length) {
    console.log('\nNenhum deal com sinal deterministico recuperavel. Nada a fazer.\n');
    process.exit(0);
  }

  if (!APLICAR) {
    console.log(`\n${todosCandidatos.length} deal(s) seriam corrigidos com --aplicar:`);
    for (const c of todosCandidatos) console.log(`  deal ${c.linha.deal_id}: origem → "${c.origemDetectada}"`);
    console.log('\nNada foi alterado. Rode com --aplicar para escrever no Moskit.\n');
    process.exit(0);
  }

  // ---------------- modo --aplicar: escreve nos deals reais do Moskit ----------------
  // Protecao contra sobrescrever correcao manual: confere o campo ORIGEM direto no Moskit, JUSTO
  // ANTES do PUT (nao o snapshot local, que pode estar desatualizado) — so aplica se ainda estiver
  // vazio ou "Nao identificado". Se a equipe ja corrigiu na mao entre a auditoria e esta rodada, o
  // deal sai da lista sem barulho (nao e erro, e o caminho feliz de "alguem ja resolveu").
  //
  // PUT preserva TUDO que veio do GET (mesmo padrao de corrigir-tipo-consulta.js): so o campo ORIGEM
  // do array entityCustomFields e substituido, nunca reconstruido do zero.
  if (!process.env.MOSKIT_API_KEY) {
    console.error('\n❌ MOSKIT_API_KEY nao definida — necessaria para --aplicar.');
    process.exit(1);
  }
  const axios = require('axios');
  console.log(`\n⚠️  APLICANDO em ${todosCandidatos.length} deal(s) reais do Moskit — Ctrl+C nos proximos 5s para cancelar...`);
  await new Promise((r) => setTimeout(r, 5000));

  let corrigidos = 0;
  let jaResolvidos = 0;
  let falhas = 0;
  for (const c of todosCandidatos) {
    const dealId = c.linha.deal_id;
    try {
      const atual = (await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, { headers, validateStatus: (s) => s < 500 })).data;
      const origemAtual = (atual.entityCustomFields || []).find((f) => f.id === CF_ORIGEM);
      const idOrigemAtual = origemAtual?.options?.[0];
      const idNaoIdentificado = moskitIds.ORIGEM['nao identificado'];
      const aindaVazio = !idOrigemAtual || idOrigemAtual === idNaoIdentificado;
      if (!aindaVazio) {
        console.log(`  ⏭️  deal ${dealId}: origem ja preenchida no CRM (id ${idOrigemAtual}) — alguem ja resolveu, pulando`);
        jaResolvidos++;
        continue;
      }

      const idNovo = moskitIds.buscarOpcao(moskitIds.ORIGEM, c.origemDetectada);
      if (!idNovo) {
        console.log(`  ⚠️  deal ${dealId}: "${c.origemDetectada}" nao mapeia para nenhum id conhecido — pulando`);
        falhas++;
        continue;
      }

      const jaTemCampo = (atual.entityCustomFields || []).some((f) => f.id === CF_ORIGEM);
      const camposNovos = jaTemCampo
        ? (atual.entityCustomFields || []).map((f) => (f.id === CF_ORIGEM ? { id: CF_ORIGEM, options: [idNovo] } : { id: f.id, options: f.options }))
        : [...(atual.entityCustomFields || []).map((f) => ({ id: f.id, options: f.options })), { id: CF_ORIGEM, options: [idNovo] }];

      const payload = {
        name: atual.name,
        status: atual.status,
        stage: { id: atual.stage?.id },
        responsible: atual.responsible?.id ? { id: atual.responsible.id } : undefined,
        // MEDIDO em 02/09/2026 no deal 48412103: PUT sem createdBy volta 422
        // {"messageError":"Id cannot be null","field":"createdBy.id"} — o Moskit exige o campo mesmo
        // num PUT de "so um campo". Preserva o criador ORIGINAL do deal (do proprio GET), nunca forca
        // um valor fixo — quem criou o deal nao muda so porque a origem foi corrigida.
        createdBy: atual.createdBy?.id ? { id: atual.createdBy.id } : undefined,
        // MEDIDO no mesmo dia no deal 48317782 (LOST): PUT com status=LOST mas sem closeDate/
        // lostReason volta 422 ("closeDate cannot be null" / "lostReason.id cannot be null") — mesmo
        // padrao de atualizarNegocioMoskit (index.js) documentado no CLAUDE.md. So entram no payload
        // quando o deal ja os tem (deal aberto nao manda nenhum dos dois).
        closeDate: atual.closeDate || undefined,
        lostReason: atual.lostReason?.id ? { id: atual.lostReason.id } : undefined,
        contacts: (atual.contacts || []).map((ct) => ({ id: ct.id })),
        activities: atual.activities, // PUT e full replace — omitir derruba 422 em atividade concluida
        entityCustomFields: camposNovos,
      };

      const put = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, payload, { headers, validateStatus: (s) => s < 500 });
      if (put.status < 200 || put.status >= 300) {
        console.log(`  ❌ deal ${dealId}: PUT falhou (${put.status})`);
        falhas++;
        continue;
      }
      console.log(`  ✅ deal ${dealId}: origem → "${c.origemDetectada}" (id ${idNovo})`);
      corrigidos++;
    } catch (e) {
      console.log(`  ❌ deal ${dealId}: erro — ${e.response?.status || ''} ${e.message}`);
      falhas++;
    }
    // Piso de espaçamento entre deals — rate limit do Moskit e 6 req/s, 240/min (ver CLAUDE.md).
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`✅ corrigidos: ${corrigidos} | ⏭️ ja resolvidos por fora: ${jaResolvidos} | ❌ falhas: ${falhas}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
