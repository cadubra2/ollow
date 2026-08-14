// Replay de conversas REAIS contra a OpenAI, para descobrir por que a perna do cliente se perdeu.
//
//   node replay-dupla-confirmacao.js                 # os 2 casos investigados (Priscilla e Rafael)
//   node replay-dupla-confirmacao.js 48226006 47543238 ...   # deals especificos
//
// CHAMA A OPENAI DE VERDADE — custa creditos. NUNCA rodar em CI nem no npm test.
//
// A pergunta: nos deals 48226006 (Priscilla) e 47543238 (Rafael) a equipe confirmou o horario e o
// CLIENTE propos, mas apurarDuplaConfirmacao registrou `falta_cliente` e a reuniao nao foi remarcada —
// o do Rafael ficou parado em 29/07 depois de remarcado pra 04/08, e ele esperou sozinho na sala. Como
// `cliente_propos_horario` JA conta como perna do cliente (src/agendamento.js), a perna foi PERDIDA, e
// so ha duas explicacoes, com correcoes opostas:
//
//   A) o modelo nao emitiu a observacao do cliente  -> corrigir REGRA DE PROMPT
//   B) emitiu e validarObservacoes descartou        -> corrigir a VALIDACAO
//
// Este script responde qual das duas, mostrando o que o modelo devolveu, o que foi descartado e por
// que. So leitura: le o banco de producao num handle readonly e nao escreve em lugar nenhum.
const path = require('path');
require('dotenv').config();

// DB_PATH descartavel ANTES do require: sem isso o boot do index.js abre o conversations.db de
// producao e roda ALTER TABLE nele (a regra esta no CLAUDE.md). O banco real e lido mais abaixo, num
// handle proprio e readonly.
process.env.WORKER_MODE = '1';
process.env.DB_PATH = path.join(require('os').tmpdir(), `replay-dupla-${process.pid}.db`);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const Database = require('better-sqlite3');
const { validarObservacoes } = require('./src/evidencia');
const { apurarDuplaConfirmacao, descreverPendencia } = require('./src/agendamento');
const bot = require('./index.js');

const DEALS_PADRAO = ['48226006', '47543238'];
const deals = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const alvos = deals.length ? deals : DEALS_PADRAO;
const CAMINHO_BANCO = process.env.CONVERSATIONS_DB || 'conversations.db';

(async () => {
  const db = new Database(CAMINHO_BANCO, { readonly: true });

  for (const dealId of alvos) {
    const row = db.prepare('SELECT chat_id, contact_name, deal_id, messages, evento_calendar_data, agendamento_pendente_hash FROM conversations WHERE deal_id = ?').get(dealId);
    if (!row) {
      console.log(`\n### deal ${dealId}: nao encontrado em ${CAMINHO_BANCO}`);
      continue;
    }

    const mensagens = JSON.parse(row.messages || '[]');
    const historico = bot.montarHistorico(mensagens);
    const dataAtual = mensagens[mensagens.length - 1]?.timestamp || null;

    console.log(`\n${'='.repeat(78)}`);
    console.log(`deal ${dealId} — ${row.contact_name} (${mensagens.length} mensagens)`);
    console.log(`  evento_calendar_data no banco : ${row.evento_calendar_data}`);
    console.log(`  pendencia registrada na epoca : ${row.agendamento_pendente_hash}`);
    console.log(`  data-ancora (ultima mensagem) : ${dataAtual}`);
    console.log(`  ancora como vai pro prompt    : ${bot.descreverAncora(dataAtual)}`);
    console.log(`${'='.repeat(78)}`);

    const result = await bot.extrairDadosAtendimento(historico, true, null, null, dataAtual);
    const observacoes = Array.isArray(result.observacoes) ? result.observacoes : [];

    console.log(`\n  data_hora_consulta que o modelo devolveu: ${JSON.stringify(result.dados?.data_hora_consulta)}`);

    const deHorario = observacoes.filter((o) => /_horario$/.test(o?.tipo || ''));
    console.log(`\n  OBSERVACOES DE HORARIO EMITIDAS pelo modelo: ${deHorario.length}`);
    for (const o of deHorario) {
      const m = mensagens[o.msg_idx];
      console.log(`    ${o.tipo} @msg ${o.msg_idx} [role real: ${m?.role || '?'}] horario_iso=${o.horario_iso}`);
      console.log(`       trecho citado: "${String(o.trecho).replace(/\s+/g, ' ').slice(0, 90)}"`);
    }
    const emitiuPernaCliente = deHorario.some((o) => o.tipo === 'cliente_propos_horario' || o.tipo === 'cliente_aceitou_horario');

    const { validas, rejeitadas } = validarObservacoes(observacoes, mensagens);
    const rejeitadasHorario = rejeitadas.filter((r) => /_horario$/.test(r.obs?.tipo || ''));
    console.log(`\n  DESCARTADAS na validacao (so as de horario): ${rejeitadasHorario.length}`);
    for (const r of rejeitadasHorario) {
      console.log(`    ${r.obs?.tipo} @msg ${r.obs?.msg_idx} — ${r.motivo}`);
    }
    for (const v of validas.filter((o) => o._horarioImplausivel)) {
      console.log(`    ${v.tipo} @msg ${v.msg_idx} — horario recusado: ${v._horarioImplausivel.motivo}`);
    }

    const apuracao = apurarDuplaConfirmacao(validas);
    console.log(`\n  APURACAO: ${apuracao.confirmado ? `CONFIRMADO para ${apuracao.horarioIso}` : `NAO — ${descreverPendencia(apuracao)}`}`);
    console.log(`    perna do cliente: ${apuracao.cliente ? `${apuracao.cliente.tipo} @msg ${apuracao.cliente.msg_idx} (${apuracao.cliente.horario_iso})` : 'AUSENTE'}`);
    console.log(`    perna da equipe : ${apuracao.equipe ? `${apuracao.equipe.tipo} @msg ${apuracao.equipe.msg_idx} (${apuracao.equipe.horario_iso})` : 'AUSENTE'}`);

    // O veredito. Recusado por horario implausivel NAO e a mesma coisa que perdido na validacao: no
    // primeiro caso o modelo produziu lixo e o sistema barrou como devia (e avisa a equipe); no segundo
    // havia evidencia boa e o codigo a jogou fora, que e bug nosso.
    const pernaClienteValida = !!apuracao.cliente;
    const recusadoPorHorario = validas.some((o) => o._horarioImplausivel);
    const descartadoNaValidacao = rejeitadasHorario.length > 0;
    console.log('\n  >>> VEREDITO:');
    if (apuracao.confirmado) {
      console.log('      A dupla confirmacao FECHA com o codigo atual. O caso era do prompt antigo');
      console.log('      (ancora em ISO) e/ou da falta da rede deterministica de dia da semana.');
    } else if (recusadoPorHorario) {
      console.log('      O modelo devolveu horario que NAO veio da conversa (ver o motivo acima) e a rede');
      console.log('      deterministica barrou. Comportamento CORRETO: nada vai pra agenda, e o deal recebe');
      console.log('      nota + Telegram dizendo o motivo. Nao ha o que corrigir no codigo por este caso.');
    } else if (descartadoNaValidacao) {
      console.log('      HIPOTESE B: havia evidencia e validarObservacoes a descartou (papel, indice ou');
      console.log('      trecho). A correcao e na VALIDACAO — ver o motivo do descarte acima.');
    } else if (!emitiuPernaCliente) {
      console.log('      HIPOTESE A: o modelo NAO emitiu observacao de cliente_propos/aceitou_horario.');
      console.log('      A correcao e de REGRA DE PROMPT, nao de validacao.');
    } else if (emitiuPernaCliente && !pernaClienteValida) {
      console.log('      O modelo emitiu a perna do cliente e ela nao chegou na apuracao — investigar.');
    } else {
      console.log(`      Perna do cliente existe e e valida, mas a apuracao nao fecha: ${apuracao.motivo}.`);
      console.log('      Olhar horarios_divergentes/renegociado acima — nao e perna perdida.');
    }
  }

  db.close();
  console.log(`\n${'='.repeat(78)}`);
  console.log('Replay concluido. Nada foi escrito (nem no banco, nem no CRM, nem na agenda).\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERRO', e.message);
  process.exit(1);
});
