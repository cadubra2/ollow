// Correcao pontual (03/09/2026) — 2a leva de duplicidade da aba "Agendamento de Consulta", achada
// so depois de corrigir a comparacao de telefone (ultimos 8 digitos em vez do numero inteiro; ver o
// comentario de buscarOuCriarContato em index.js). Todos seguem o MESMO padrao: um lead antigo do
// Moskit Boost + um negocio que o bot criou sem reconhecer que o cliente ja existia, porque o
// telefone estava gravado sem DDI. 46 dos 87 negocios abertos da aba tinham par por esse criterio.
//
// QUAL LADO FICA: o do BOT, e nao o mais antigo — porque `conversations.deal_id` aponta pra ele, e
// fechar o negocio pro qual a automacao escreve deixaria o robo alimentando um deal perdido. O do
// Boost e fechado depois de ter seus campos copiados. EXCECAO: Hengrid, onde o lado do Boost esta em
// NEGOCIACAO (mais avancado no funil) — ali vale a regra do usuario e quem fecha e o do bot.
//
// NAO fecha o sobrevivente, mesmo os que aparecem como "cliente sumiu" no relatorio de limpeza: o
// silencio esta na thread do BOT, e a conversa pode ter seguido no registro do Boost (que nao tem
// espelho local pra eu enxergar). Fechar os dois lados por causa de um silencio que so vejo de um
// lado seria decidir com meia informacao — fica pra equipe, com o registro ja unificado.
//
//   node corrigir-duplicidade-boost-03-09-2026.js            (dry-run)
//   node corrigir-duplicidade-boost-03-09-2026.js --aplicar  (escreve no Moskit)
//
// Script pontual — depois de rodado com --aplicar, nao reexecutar.
require('dotenv').config();
const path = require('path');
process.env.WORKER_MODE = '1'; // sem isso, require('./index.js') sobe o servidor real e os setInterval
process.env.DB_PATH = path.join(require('os').tmpdir(), `dup-boost-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
const axios = require('axios');
const MOSKIT_IDS = require('./src/moskit-ids');
const { rejeitarAssuntoQueEhArea } = require('./index.js');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const apiHeaders = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_WHATSAPP' };
const APLICAR = process.argv.includes('--aplicar');
const MARCADOR = ' [bot limpeza]';
const ORIGEM_NAO_IDENTIFICADO = MOSKIT_IDS.ORIGEM['nao identificado'];

const PARES = [
  { rotulo: 'Gláucia', manter: 48407594, perder: 48402084 },
  { rotulo: 'José Carlos', manter: 48147390, perder: 48075325 },
  { rotulo: 'Vitor', manter: 48206716, perder: 48208363 },
  { rotulo: 'Matheus', manter: 48206720, perder: 48205626 },
  { rotulo: 'Gabrielle', manter: 48206727, perder: 48176666 },
  { rotulo: 'Virna', manter: 48212403, perder: 48128361 },
  { rotulo: 'Olímpio', manter: 48320992, perder: 48320629 },
  { rotulo: 'Aline', manter: 48428227, perder: 47840736 },
  // A Hengrid (49300572) saiu desta lista: o par dela (47397496, que estava em negociacao no
  // snapshot de 02/09) responde 404 hoje — alguem apagou o negocio no CRM nesse meio tempo. Sem par
  // vivo ela deixa de ser duplicidade e volta pro caminho normal: ela tem recusa explicita
  // ("sem interesse") no relatorio de limpeza, entao fecha como os outros, em
  // corrigir-limpeza-perdidos-03-09-2026.js.
];

const CF_NOME = {
  [MOSKIT_IDS.CF.ORIGEM]: 'Origem',
  [MOSKIT_IDS.CF.TIPO_CONSULTA]: 'Tipo de consulta',
  [MOSKIT_IDS.CF.AREA_DIREITO]: 'Área do Direito',
  [MOSKIT_IDS.CF.RESPONSAVEL]: 'Advogado responsável',
  [MOSKIT_IDS.CF.CAPTACAO]: 'Captação',
};

const get = async (id) => {
  const r = await axios.get(`${MOSKIT_BASE}/deals/${id}`, { headers: apiHeaders, validateStatus: (s) => s < 500 });
  if (r.status < 200 || r.status >= 300) throw new Error(`GET /deals/${id} → HTTP ${r.status}`);
  return r.data;
};
const vazio = (c) => !c || !c.options?.length || (c.id === MOSKIT_IDS.CF.ORIGEM && c.options[0] === ORIGEM_NAO_IDENTIFICADO);
// Titulo "generico" = sem caso nenhum, o placeholder do prompt, OU o proprio nome de uma area do
// direito. Este ultimo caso vem de `rejeitarAssuntoQueEhArea` (a funcao de PRODUCAO, exportada de
// index.js) — sem ele, o par da Virna manteria "Virna - Direito Imobiliario" e descartaria
// "Virna - Recebimento de valor de imovel leiloado", que e o caso de verdade. Mesma coisa na Aline
// ("Direito Médico" x "Indenização de seguro").
const generico = (nome) => {
  const i = String(nome || '').indexOf(' - ');
  if (i === -1) return true;
  const a = nome.slice(i + 3).trim();
  if (!a || /^consulta jur[ií]dica$/i.test(a)) return true;
  const teste = { assunto: a };
  rejeitarAssuntoQueEhArea(teste);
  return teste.assunto !== a; // a funcao trocou o valor => era nome de area
};
const comMarcador = (n) => (String(n || '').includes(MARCADOR) ? String(n) : `${n}${MARCADOR}`);

(async () => {
  console.log(APLICAR ? '🚨 MODO --aplicar: escreve no Moskit de verdade\n' : '🔍 dry-run: nada será escrito\n');
  let ok = 0;

  for (const par of PARES) {
    console.log(`=== ${par.rotulo}: manter ${par.manter}, fechar ${par.perder} ===`);
    let mantido; let perdedor;
    try { mantido = await get(par.manter); perdedor = await get(par.perder); } catch (e) { console.error(`  ❌ ${e.message}\n`); continue; }
    if (perdedor.status !== 'OPEN') { console.log(`  ⏭️  ${par.perder} já está ${perdedor.status} — pulando\n`); continue; }

    const campos = [...(mantido.entityCustomFields || [])];
    const complementos = [];
    for (const cp of perdedor.entityCustomFields || []) {
      if (vazio(cp)) continue;
      const i = campos.findIndex((f) => f.id === cp.id);
      if (!vazio(i === -1 ? null : campos[i])) continue;
      const novo = { id: cp.id, options: cp.options };
      if (i === -1) campos.push(novo); else campos[i] = novo;
      complementos.push(`${CF_NOME[cp.id] || cp.id} = ${cp.options.join(',')}`);
    }

    let nomeNovo = mantido.name;
    if (generico(mantido.name) && !generico(perdedor.name)) {
      const pessoa = mantido.name.includes(' - ') ? mantido.name.slice(0, mantido.name.indexOf(' - ')) : mantido.name;
      nomeNovo = `${pessoa} - ${perdedor.name.slice(perdedor.name.indexOf(' - ') + 3)}`;
    }

    console.log(`  mantido: "${mantido.name}"${nomeNovo !== mantido.name ? ` → "${nomeNovo}"` : ''}`);
    console.log(`  fechado: "${perdedor.name}" → "${comMarcador(perdedor.name)}"`);
    console.log(`  ${complementos.length ? `complementa: ${complementos.join(' · ')}` : '(nada a complementar)'}`);

    if (!APLICAR) { console.log(''); continue; }

    try {
      if (complementos.length || nomeNovo !== mantido.name) {
        const r1 = await axios.put(`${MOSKIT_BASE}/deals/${par.manter}`, { ...mantido, name: nomeNovo, entityCustomFields: campos }, { headers: apiHeaders, validateStatus: (s) => s < 500 });
        if (r1.status < 200 || r1.status >= 300) throw new Error(`PUT mantido → HTTP ${r1.status}`);
      }

      const notaMantido = [
        `🔁 Duplicidade resolvida em 03/09/2026: o negócio #${par.perder} ("${perdedor.name}") era o mesmo cliente —`,
        'mesmo telefone, gravado em formatos diferentes (com e sem DDI), o que fez o bot não reconhecer o cadastro que já existia.',
        complementos.length ? `As informações que faltavam aqui vieram de lá: ${complementos.join('; ')}.` : 'Os dois tinham os mesmos dados.',
        `O #${par.perder} foi fechado. O acompanhamento continua aqui.`,
      ].join(' ');
      await axios.post(`${MOSKIT_BASE}/deals/${par.manter}/notes`, { description: notaMantido, user: { id: MOSKIT_IDS.LAYLA_USER_ID } }, { headers: apiHeaders, validateStatus: (s) => s < 500 });

      const notaPerdedor = [
        '🧹 Duplicado — fechado pela limpeza de 03/09/2026.',
        `Mesmo cliente do #${par.manter} ("${nomeNovo}"), que segue como o registro ativo.`,
        'O telefone estava gravado em formatos diferentes (com e sem DDI) nos dois cadastros, e o bot não reconheceu que já existia — bug já corrigido no código.',
        complementos.length ? `As informações úteis daqui foram copiadas para o #${par.manter} antes do fechamento.` : '',
        'Nada foi apagado; reabrir desfaz se esta marcação estiver errada.',
      ].filter(Boolean).join(' ');
      await axios.post(`${MOSKIT_BASE}/deals/${par.perder}/notes`, { description: notaPerdedor, user: { id: MOSKIT_IDS.LAYLA_USER_ID } }, { headers: apiHeaders, validateStatus: (s) => s < 500 });

      const r2 = await axios.put(`${MOSKIT_BASE}/deals/${par.perder}`, {
        ...perdedor, name: comMarcador(perdedor.name), status: 'LOST',
        closeDate: new Date().toISOString(), lostReason: { id: MOSKIT_IDS.LOST_REASON['nao informou o motivo'] },
      }, { headers: apiHeaders, validateStatus: (s) => s < 500 });
      if (r2.status < 200 || r2.status >= 300) throw new Error(`PUT perdedor → HTTP ${r2.status}: ${JSON.stringify(r2.data).slice(0, 200)}`);

      await new Promise((r) => setTimeout(r, 4500));
      const cp = await get(par.perder); const cm = await get(par.manter);
      const bom = cp.status === 'LOST' && cp.name.includes(MARCADOR) && cm.name === nomeNovo;
      console.log(`  ${bom ? '✅' : '⚠️ '} ${par.perder} → ${cp.status} "${cp.name}" · ${par.manter} → "${cm.name}"\n`);
      if (bom) ok++;
    } catch (e) { console.error(`  ❌ ${e.message}\n`); }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (APLICAR) console.log(`\n${ok} de ${PARES.length} pares confirmados.`);
  console.log('Concluído.');
})();
