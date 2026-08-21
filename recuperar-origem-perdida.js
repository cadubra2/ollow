// Estudo SO-LEITURA: dos deals do bot sem origem, quais tem o SINAL de origem ainda presente na
// conversa (so o campo que guardava a conclusao foi perdido), versus os que o modelo ja examinou e
// genuinamente nao achou nada.
//
//   node recuperar-origem-perdida.js
//
// NUNCA rodar em CI nem no npm test — le o conversations.db de producao. NAO escreve em nada, NAO
// chama a OpenAI: e so grep de texto (regex) sobre mensagens que ja estao salvas.
//
// Por que existe: o estudo anterior (estudar-deals-sem-origem.js) achou 12 deals com
// last_action='inviavel' cujo last_data foi zerado pra `{}} por um bug de merge (ver CLAUDE.md,
// "Moskit CRM" / index.js:3663-3665,3725-3727) — mas esse bug so apaga `last_data`, nunca
// `messages`. A conversa inteira continua salva; so a CONCLUSAO sobre ela foi perdida. Este script
// releva o texto bruto e sinaliza mencao a canal de entrada conhecido, pra separar "a informacao
// ainda existe, so nao foi re-extraida" de "o cliente nunca disse de onde veio".
const path = require('path');
require('dotenv').config();

process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `recuperar-origem-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const fs = require('fs');
const Database = require('better-sqlite3');

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

// Vocabulario inspirado nas opcoes de src/moskit-ids.js (ORIGEM), mas escrito como gatilho de
// linguagem NATURAL — o apelido cadastrado la e a forma CANONICA que a IA devolve, nao
// necessariamente a frase que o cliente escreve na conversa. Heuristica, nao veredito: sinaliza pra conferencia
// humana, nao decide nada.
const SINAIS = [
  // Mesma regra que index.js:3838-3855 (PADROES_SOCIO) ja usa em producao pra forcar
  // origem=Instagram + captacao=socio — "pagina/instagram do Bruno/Berto/Iury/Caballero". Se a
  // conversa tem essa frase mas o deal ficou sem origem, e prova de que essa rodada NUNCA passou por
  // aquele trecho de codigo (ex.: a mensagem caiu numa rodada classificada 'inviavel', que retorna
  // antes de chegar la).
  { origem: 'Instagram (pagina de socio — regra ja existente em index.js)', regex: /p[aá]gina\s+d[eo]\s+(advogad[oa]\s+)?(bruno|berto|iury|caballero|dr\.?\s*(bruno|berto|iury))|instagram\s+d[eo]\s+(bruno|berto|iury|dr\.?\s*(bruno|berto|iury))/i },
  { origem: 'Instagram', regex: /\binstagram\b|\binsta\b|link (da|na) bio/i },
  { origem: 'JusBrasil', regex: /\bjusbrasil\b/i },
  { origem: 'Youtube', regex: /\byou\s?tube\b/i },
  { origem: 'Video (Youtube/Instagram/TikTok — conferir qual)', regex: /\bv[ií]deo\b|\breels?\b/i },
  // "google" sozinho e ARMADILHA: toda consulta agendada insere o convite do Google Meet/Calendar
  // no texto da conversa ("Informacoes de participacao do Google Meet", "meet.google.com/...") —
  // MEDIDO em 21/08/2026 no deal 48219774 (Aurinete), falso positivo puro. So conta "google" quando
  // vem colado a pesquisa/busca, nunca isolado.
  { origem: 'Site', regex: /\bsite\b|\bpesquisei\b|pesquisa (no|na)\s*google|achei\s*(no|pelo)\s*google/i },
  // \b depois de "materia"/"noticia" e o que impede casar "danos MATERIAis"/"notificação" — MEDIDO
  // em 21/08/2026 no deal 48222273 (Alice, conversa INTERNA da equipe sobre "danos materiais e
  // morais"), falso positivo puro que nem era conversa de cliente.
  { origem: 'Artigo', regex: /\bartigo\b|\bmat[eé]ria\b|\bnot[ií]cia\b/i },
  { origem: 'Indicacao de/ou amigos e parentes', regex: /\bindica[cç][aã]o\b|\bindicou\b|\bindicad[oa]\b|\bamigo\b|\bparente\b/i },
  { origem: 'Indicacao de clientes', regex: /j[aá]\s+(sou|fui|foi)\s+cliente|outro caso (com|no) (escrit[oó]rio|voces)/i },
  { origem: 'VSL - Trafego pago', regex: /an[uú]ncio|propaganda|trafego pago|facebook ads|impulsionad/i },
  { origem: 'Landing Page', regex: /landing page/i },
];

function sinaisEncontrados(texto) {
  const achados = [];
  for (const s of SINAIS) if (s.regex.test(texto)) achados.push(s.origem);
  return achados;
}

(async () => {
  console.log('\n🔍 Recuperacao de sinal de origem em conversas com last_data perdido ou "Nao identificado"');
  console.log('   somente leitura, zero chamada de IA: nada e criado, movido ou apagado\n');

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
  // afetado pelo bug do grupo B). Mede o GAP REAL de reconhecimento do modelo, separado do bug —
  // e o numero que decide se vale investir em prompt/regra determinista nova.
  const grupoA = linhas.filter((l) => {
    const dados = parseJsonSeguro(l.last_data, null);
    return dados && String(dados.origem || '').trim().toLowerCase() === 'nao identificado';
  });

  console.log(`💾 Banco (${caminhoBanco}, readonly): ${linhas.length} deal(s) do bot no total`);
  console.log(`   Grupo B (last_data perdido por 'inviavel'/'interno'): ${grupoB.length} deal(s)`);
  console.log(`   Grupo A (ja concluido 'Nao identificado', sem o bug): ${grupoA.length} deal(s)\n`);

  function relatarGrupo(nome, lista) {
    console.log('='.repeat(70));
    console.log(`${nome}\n`);
    for (const l of lista) {
      const mensagens = parseJsonSeguro(l.messages, []) || [];
      const textoCliente = mensagens.filter((m) => m.role === 'cliente').map((m) => m.text).join(' | ');
      const textoTodos = mensagens.map((m) => `[${m.role}] ${m.text}`).join(' | ');
      const achados = sinaisEncontrados(textoTodos);
      console.log(`Deal ${l.deal_id} — ${l.contact_name || '(sem nome)'} (chat ${l.chat_id}, last_action=${l.last_action})`);
      if (achados.length) {
        console.log(`  ✅ SINAL ENCONTRADO: ${achados.join(', ')}`);
      } else {
        console.log('  ⚠️ nenhum sinal de canal de entrada no texto — provavelmente "Nao identificado" mesmo');
      }
      console.log(`  Mensagens do cliente (${mensagens.filter((m) => m.role === 'cliente').length}): ${textoCliente.slice(0, 400)}${textoCliente.length > 400 ? '...' : ''}`);
      console.log('');
    }
  }

  relatarGrupo('GRUPO B — last_data perdido (bug inviavel/interno), conversa intacta', grupoB);
  relatarGrupo('GRUPO A — modelo ja concluiu "Nao identificado" (sem o bug)', grupoA);

  const temSinal = (l) => {
    const mensagens = parseJsonSeguro(l.messages, []) || [];
    const textoTodos = mensagens.map((m) => `[${m.role}] ${m.text}`).join(' | ');
    return sinaisEncontrados(textoTodos).length > 0;
  };
  const recuperaveisB = grupoB.filter(temSinal);
  const gapReaisA = grupoA.filter(temSinal);
  console.log('='.repeat(70));
  console.log(`Grupo B (afetado pelo bug): ${recuperaveisB.length} de ${grupoB.length} tem sinal de origem recuperavel no texto.`);
  console.log(`Grupo A (modelo examinou e concluiu sozinho): ${gapReaisA.length} de ${grupoA.length} tem sinal que o modelo deixou passar — este e o GAP REAL de reconhecimento, separado do bug.`);
  if (gapReaisA.length) console.log(`  deals: ${gapReaisA.map((l) => l.deal_id).join(', ')}`);
  console.log('Nada foi alterado.\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
