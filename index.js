require('dotenv').config();

const express = require('express');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { validarObservacoes, ultimaObservacao, motivoHorarioImplausivel, normalizarHorarioNaive, instanteParaNaiveLocal } = require('./src/evidencia');
const { detectarBlocoCondicoes, contarAnexosIlegiveisEquipe } = require('./src/bloco-condicoes');
const { apurarDuplaConfirmacao, descreverPendencia } = require('./src/agendamento');
const { enfileirar, TEMP_DIR } = require('./src/fila');
const { jaExiste, normalizarMensagens } = require('./src/mensagens');
const { chaveConversa, ehInterno, TEAM_SUFIXOS, mesmoTelefone, SUFIXO_COMPARACAO } = require('./src/telefone');
const { transcreverAudio } = require('./src/transcricao');
const { montarPayloadAtividade, horarioNaiveParaInstante } = require('./src/atividade-moskit');
const MOSKIT_IDS = require('./src/moskit-ids');
const zapsign = require('./src/zapsign');
const notasReuniao = require('./src/notas-reuniao');
const clienteRetorno = require('./src/cliente-retorno');
const reuniaoRetorno = require('./src/reuniao-retorno');
const briefing = require('./src/briefing');

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// Ver src/moskit-ids.js — todo identificador do Moskit vive la, numa fonte so.
const { LAYLA_USER_ID, PRODUTO_CONSULTA_PAGA_ID, STATUS_DEAL, LOST_REASON, LOST_REASON_PADRAO_ID } = require('./src/moskit-ids');
const TEMPO_INATIVIDADE_MS = Number(process.env.TEMPO_INATIVIDADE_MS) || 5 * 60 * 1000;
const MOSKIT_STAGE_CONSULTA_AGENDADA = Number(process.env.MOSKIT_STAGE_CONSULTA_AGENDADA) || MOSKIT_IDS.STAGE.consulta_agendada;
const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const TZ_ESCRITORIO = process.env.TZ_ESCRITORIO || 'America/Fortaleza';

// dados.data_hora_consulta / apuracao.horarioIso sao strings NAIVE (sem Z/offset) que representam
// direto a hora do ESCRITORIO (TZ_ESCRITORIO) - ver src/evidencia.js:102-104. Pro Google Calendar,
// mandamos { dateTime: naive, timeZone: TZ_ESCRITORIO } e deixamos o GOOGLE resolver o instante -
// zero matematica de fuso do lado do bot, e funciona igual independente do fuso do SO onde o
// processo roda. Era essa dependencia — new Date(naive).toISOString() SEM timeZone no payload —
// que fazia uma reuniao marcada pras 17h30 (hora do escritorio) virar 17h30 UTC quando o processo
// roda numa VPS sem fuso configurado (Ubuntu cloud vem em UTC por padrao): 3h mais cedo do que foi
// combinado. Pra exibicao (notas/Telegram) e pra somar duracao, tratamos a string como se fosse UTC
// so como TRUQUE DE CALCULO (Brasil nao tem horario de verao desde 2019, entao "+1h de relogio" ==
// "+1h real" para TZ_ESCRITORIO) — nunca usar esse valor como o instante real enviado a uma API
// externa sem o timeZone explicito ao lado.
// horarioNaiveValido (`!isNaN(Date.parse(iso + 'Z'))`) foi removido: aceitava qualquer coisa que o
// Date parseasse, inclusive "2026-08-05T17:30:00.000" com milissegundos, que passava aqui e era
// recusada pela regex de horarioNaiveParaInstante — evento no Google sem a atividade no Moskit. Quem
// valida horario agora e normalizarHorarioNaive/motivoHorarioImplausivel (src/evidencia.js), que
// exigem formato exato e devolvem MOTIVO nomeado em vez de um booleano.
function somarMinutosNaive(isoNaive, minutos) {
  const d = new Date(`${isoNaive}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutos);
  return d.toISOString().slice(0, 19);
}
function formatarHorarioEscritorio(isoNaive) {
  if (!isoNaive) return null;
  const d = new Date(`${isoNaive}Z`);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', { timeZone: 'UTC' }); // 'UTC' aqui = nao girar de novo
}

// Valor da consulta (aceita igual ou maior — pagamento por cartao pode ter acrescimo)
const COMPROVANTE_VALOR_ESPERADO_CENTAVOS = Number(process.env.COMPROVANTE_VALOR_ESPERADO_CENTAVOS) || 35000;

// Funil de vendas completo (pipeline "Funil de Vendas", id 40631), em ordem de avanco.
// priority vem direto do GET /stages do Moskit — usado pra nunca deixar o funil andar pra tras.
const FUNIL_DRY_RUN = process.env.FUNIL_DRY_RUN !== 'false'; // default true (so anota, nao move de verdade)
// Fechar um negocio (ganho/perdido) e mais consequente e mais novo que avancar de estagio — flag
// separada de FUNIL_DRY_RUN de proposito, pra poder ligar o avanco de estagio primeiro, observar,
// e so depois (com confianca independente) ligar o fechamento automatico.
const FUNIL_FECHAMENTO_DRY_RUN = process.env.FUNIL_FECHAMENTO_DRY_RUN !== 'false'; // default true
// Desliga a escrita na AGENDA do Moskit (a Atividade que representa a consulta) sem precisar de
// redeploy: basta mudar o .env na VPS e reiniciar. E botao de emergencia, nao encenacao.
//
// ATENCAO — a comparacao aqui e INVERTIDA em relacao as duas flags acima (`=== 'true'` em vez de
// `!== 'false'`), de proposito: esta flag default FALSE, ou seja, a agenda funciona por padrao. As
// outras seguram PALPITE DE IA sobre estagio de funil, e por isso nascem desligadas; aqui a regra e
// deterministica — houve dupla confirmacao de cliente e equipe, entao a consulta existe e tem que
// aparecer na agenda. Nao "conserte" esta linha para `!== 'false'`: isso desligaria a funcionalidade
// em producao em silencio (ha teste cobrindo os dois caminhos).
const AGENDA_MOSKIT_DRY_RUN = process.env.AGENDA_MOSKIT_DRY_RUN === 'true'; // default FALSE
// Janela de urgencia para reenviar Telegram de pendencia de agendamento MESMO com o hash de dedup
// repetido — ver registrarAgendamentoPendente. Medido em 14/08/2026 (deals 48292471/48287898): a
// dupla confirmacao corretamente identificou a pendencia (motivo falta_cliente), mas nenhum campo do
// modelo carregava o horario novo naquela rodada, entao nao havia CONTEUDO novo pra furar o dedup — a
// reuniao ja marcada ficou horas presa no horario velho, perto da hora do cliente aparecer, sem
// nenhum aviso novo. Perto o bastante da reuniao, o aviso tem que repetir mesmo sem conteudo novo:
// a PROXIMIDADE e o sinal de urgencia, nao depende do modelo acertar nada.
const AGENDAMENTO_URGENCIA_HORAS = Number(process.env.AGENDAMENTO_URGENCIA_HORAS) || 48;
// Janela (maior, em DIAS) usada so por reconciliarPendenciasAgendamento — a rede de seguranca pra
// conversa que PAROU de vez (nenhuma mensagem nova de nenhum lado, entao nunca mais e reprocessada e
// a escalada por proximidade acima nunca roda pra ela). Maior que AGENDAMENTO_URGENCIA_HORAS de
// proposito: aquela e a escalada de uma conversa ATIVA (reage rodada a rodada, tanto faz avisar so na
// vespera); esta e a unica chance de avisar sobre uma conversa muda, entao precisa de mais
// antecedencia. Medido em 14/08/2026, deal 48466404 (Teresinha): pagou, perguntou o endereco do
// escritorio, e a consulta ficaria descoberta ate a antecedencia de 48h se essa varredura usasse a
// mesma janela da escalada ativa.
const AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS = Number(process.env.AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS) || 7;
// Briefing pre-consulta: reprocessar a conversa algumas horas antes da consulta agendada para que a
// nota reflita o que houve de ultimo (comprovante, dado novo, remarcacao). Conversa que recebe
// mensagem nova ja e reprocessada sozinha; a consulta que NAO recebe mais nada e o caso que esta
// rotina cobre (mesmo espirito de reconciliarPendenciasAgendamento). Custa ~2 chamadas OpenAI por
// reprocessamento, por isso nasce ligado mas conservador: janela curta + teto por ciclo.
const BRIEFING_REFRESH_ATIVO = process.env.BRIEFING_REFRESH_ATIVO !== 'false'; // default true
const BRIEFING_REFRESH_ANTECEDENCIA_HORAS = Number(process.env.BRIEFING_REFRESH_ANTECEDENCIA_HORAS) || 4;
const BRIEFING_REFRESH_MAX_POR_CICLO = Number(process.env.BRIEFING_REFRESH_MAX_POR_CICLO) || 5;
// Postar o briefing MESMO com campo obrigatorio pendente, com a lacuna anotada no cabecalho. Nasce
// LIGADO, ao contrario da regra "recurso novo nasce desligado", porque nao e recurso: e conserto de
// um portao que descartava resumo pago em silencio (ver o bloco no ramo atualizar_campos). A flag
// existe como interruptor de emergencia — `BRIEFING_SEM_PENDENTES=false` volta ao comportamento
// antigo sem redeploy.
const BRIEFING_SEM_PENDENTES = process.env.BRIEFING_SEM_PENDENTES !== 'false'; // default true
// Cria evento/Meet sem comprovante quando o deal esta marcado como "consulta gratis" no Moskit.
// Default DESLIGADO de proposito: sobe o codigo, roda GET /auditoria-consulta-gratis pra ver o que
// seria liberado, e so entao liga no .env.
const LIBERAR_CONSULTA_GRATIS = process.env.LIBERAR_CONSULTA_GRATIS === 'true';
// Bloquear a criacao do deal quando falta campo obrigatorio e um comportamento novo com impacto de
// negocio direto (lead pode ficar sem deal nenhum criado). Nasce em DRY-RUN: so loga o que faria,
// sem alterar `acao` de verdade — permite validar contra o corpus real antes de confiar. Setar
// BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN=false liga o bloqueio de verdade.
const BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN = process.env.BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN !== 'false'; // default true
// Os IDs de estagio vem de MOSKIT_IDS.STAGE (src/moskit-ids.js) — a fonte unica para todo ID do
// Moskit. Aqui so vive o que E de fato logica de negocio do funil: o override por env var e a
// `priority` que decide a ordem (moverEstagioSeAvancar nunca deixa o funil andar pra tras).
const MOSKIT_STAGE_MAP = {
  agendamento: { id: Number(process.env.MOSKIT_STAGE_ID) || MOSKIT_IDS.STAGE.agendamento, priority: 3 },
  consulta_agendada: { id: MOSKIT_STAGE_CONSULTA_AGENDADA, priority: 4 },
  aguardando_condicao: { id: Number(process.env.MOSKIT_STAGE_AGUARDANDO_CONDICAO) || MOSKIT_IDS.STAGE.aguardando_condicao, priority: 5 },
  elaboracao_proposta: { id: Number(process.env.MOSKIT_STAGE_ELABORACAO_PROPOSTA) || MOSKIT_IDS.STAGE.elaboracao_proposta, priority: 9 },
  negociacao: { id: Number(process.env.MOSKIT_STAGE_NEGOCIACAO) || MOSKIT_IDS.STAGE.negociacao, priority: 12 },
  elaboracao_contrato: { id: Number(process.env.MOSKIT_STAGE_ELABORACAO_CONTRATO) || MOSKIT_IDS.STAGE.elaboracao_contrato, priority: 13 },
  contrato_enviado: { id: Number(process.env.MOSKIT_STAGE_CONTRATO_ENVIADO) || MOSKIT_IDS.STAGE.contrato_enviado, priority: 17 },
};

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;

// Telefones de socios e equipe — nunca processar como lead. A lista vive no .env (TEAM_PHONES) e a
// comparacao e por sufixo de 8 digitos: ver ehInterno() em src/telefone.js.
// Antes eram 5 numeros fixos aqui, comparados por igualdade exata, enquanto a equipe tem 12.

// Teto de paginas na busca de contato: protege contra base grande + resposta sem token de proxima
// pagina, que viraria loop. 20 x 100 cobre a base atual com folga.
const MAX_PAGINAS_BUSCA_CONTATO = Number(process.env.MAX_PAGINAS_BUSCA_CONTATO) || 20;
// Teto da busca de deal por contato (buscarDealPorContato) — pagina de 10 (?start=, /deals ignora
// `limit`), entao 20 paginas = 200 deals mais recentes da conta. Paginar a conta inteira (3000+, ~90s)
// e impraticavel dentro de um ciclo de processamento; os deals mais recentes sao onde o cenario real
// do bug (deal criado ha poucos dias, buscado de novo num reprocessamento) vive.
const MAX_PAGINAS_BUSCA_DEAL = Number(process.env.MAX_PAGINAS_BUSCA_DEAL) || 20;
// Teto da varredura de atividades. Cada pagina traz 10 (ver listarAtividadesMoskit), entao 20
// paginas = 200 atividades por ciclo — a varredura completa da base em 12/08/2026 devolveu 190
// registros unicos, ou seja, hoje o teto cobre tudo com folga e `truncou` nunca dispara.
//
// E teto, nao janela: a varredura para sozinha na primeira pagina incompleta. Serve so para uma base
// que cresca muito, e mesmo ai o essencial esta coberto — a lista vem por id desc (ordem de criacao)
// e cada atividade so precisa ser vista UMA vez, porque depois disso fica em
// atividades_sincronizadas e nunca mais entra na conta.
//
// O teto efetivo de 10 que existia antes nao era uma escolha: era `?page=` sendo ignorado em
// silencio pela API.
const MAX_PAGINAS_ATIVIDADES = Number(process.env.MAX_PAGINAS_ATIVIDADES) || 20;
// Timeout de toda chamada HTTP feita por axios (Moskit, Zernio, download de anexo). Aplicado como
// default global mais abaixo, junto com o httpsAgent — cobre os 25 call sites de uma vez.
const TIMEOUT_HTTP_MS = Number(process.env.TIMEOUT_HTTP_MS) || 30000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ------------------------------------------------------------
// Google Calendar (OAuth2 com conta real do escritorio — necessario
// pra criar link do Google Meet e convidar participantes por email;
// a service account nao tem essas permissoes sem Domain-Wide Delegation)
// ------------------------------------------------------------
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
let googleOAuthClient = null;
function getGoogleAuthClient() {
  if (googleOAuthClient) return googleOAuthClient;
  const caminhoClient = process.env.GOOGLE_OAUTH_CLIENT_JSON || './google-oauth-client.json';
  const caminhoToken = process.env.GOOGLE_OAUTH_TOKEN_JSON || './google-oauth-token.json';
  if (!GOOGLE_CALENDAR_ID || !fs.existsSync(caminhoClient) || !fs.existsSync(caminhoToken)) return null;
  const { client_id, client_secret, redirect_uris } = JSON.parse(fs.readFileSync(caminhoClient, 'utf8')).installed;
  const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  client.setCredentials(JSON.parse(fs.readFileSync(caminhoToken, 'utf8')));
  googleOAuthClient = client;
  return googleOAuthClient;
}

// ------------------------------------------------------------
// Notas de reuniao do Gemini (Google Meet) -> nota no negocio do Moskit
// ------------------------------------------------------------
// Credencial SEPARADA da de cima, de proposito. O token do bot tem escopo apenas de Calendar e e o
// que faz o agendamento funcionar em producao; somar Gmail/Drive aquele consentimento exigiria
// refaze-lo, e um consentimento refeito pode invalidar o refresh token em uso — ou seja, derrubar o
// agendamento de consultas para ligar uma funcionalidade nova. Gerar com: node autorizar-google-notas.js
const NOTAS_REUNIAO_ATIVO = process.env.NOTAS_REUNIAO_ATIVO === 'true';
// Padrao DRY-RUN, no espirito de FUNIL_DRY_RUN: recurso novo nasce sem escrever no CRM. (O inverso
// de AGENDA_MOSKIT_DRY_RUN, que guarda uma regra deterministica ja madura e nasce ligada.)
const NOTAS_REUNIAO_DRY_RUN = process.env.NOTAS_REUNIAO_DRY_RUN !== 'false';
const NOTAS_REMETENTE = process.env.NOTAS_REMETENTE || 'gemini-notes@google.com';
const NOTAS_JANELA_DIAS = Number(process.env.NOTAS_JANELA_DIAS) || 30;
const NOTAS_MAX_POR_CICLO = Number(process.env.NOTAS_MAX_POR_CICLO) || 20;
const NOTAS_SYNC_INTERVAL_MS = Number(process.env.NOTAS_SYNC_INTERVAL_MS) || 10 * 60 * 1000;
// Teto de paginacao ao procurar o marcador nas notas de um deal. Medido em 16/08/2026: /deals/{id}/notes
// devolve 10 por pagina (`limit` e ignorado, como em /activities) e pagina por `?start=`. O deal da
// Lia ja tinha 40 notas — parar na primeira pagina responderia "nao achei" para uma nota existente,
// que e justamente o caso em que o codigo postaria a segunda.
const NOTAS_MAX_PAGINAS_BUSCA = Number(process.env.NOTAS_MAX_PAGINAS_BUSCA) || 20;
// Mesmo numero e mesmo motivo do MAX_TENTATIVAS de src/fila.js: cada tentativa custa uma chamada a
// OpenAI com o texto inteiro da reuniao, e falha permanente (deal apagado, Doc corrompido) nao pode
// reprocessar para sempre. Sem esse teto, o e-mail voltava a cada ciclo, pagava IA de novo e nunca
// avisava ninguem.
const NOTAS_MAX_TENTATIVAS = Number(process.env.NOTAS_MAX_TENTATIVAS) || 3;
// Dias sem NENHUM e-mail novo de notas antes de desconfiar. Nao e "ciclo vazio": a maioria dos ciclos
// e vazia mesmo, porque o que ja foi processado sai da busca pelo rotulo. E silencio PROLONGADO —
// que tem a mesma cara de "nao houve reuniao", "o token morreu" e "o Google mudou o formato do
// assunto". Sem esse aviso, a falha mais provavel da rotina e tambem a unica invisivel.
const NOTAS_SILENCIO_DIAS = Number(process.env.NOTAS_SILENCIO_DIAS) || 10;

// ---- Cliente que volta: segundo atendimento ---------------------------------------------------
// Cliente que ja teve consulta e volta com um caso NOVO continua na mesma conversa e no mesmo
// negocio, herdando bloco de condicoes, contrato, agenda e classificacao do caso anterior (ver
// src/cliente-retorno.js). Quando esta rotina reconhece o retorno, ela ABRE um atendimento novo: o
// negocio antigo fica intacto e o proximo ciclo cria o segundo negocio do zero.
//
// Nasce DESLIGADO e, quando ligado, nasce em dry-run — mesmo padrao de NOTAS_REUNIAO_*, porque o
// efeito aqui e criar negocio no CRM. As duas flags sao independentes de proposito: ATIVO=true com
// DRY_RUN=true e o modo de medicao (decide, loga, avisa no Telegram, nao grava nada).
const CLIENTE_RETORNO_ATIVO = process.env.CLIENTE_RETORNO_ATIVO === 'true';
const CLIENTE_RETORNO_DRY_RUN = process.env.CLIENTE_RETORNO_DRY_RUN !== 'false';
// Folga depois do FIM da consulta antes de aceitar que uma descricao de caso e um caso NOVO. Mensagem
// durante a reuniao ou logo depois ("esqueci de dizer que tenho o contrato X") e o mesmo atendimento.
const RETORNO_FOLGA_HORAS = Number(process.env.RETORNO_FOLGA_HORAS) || clienteRetorno.FOLGA_HORAS_PADRAO;
// O ciclo que detecta o retorno nao cria o negocio (a IA acabou de ler o historico do caso ANTIGO):
// ele abre o atendimento e reagenda. Sem esse reagendamento a conversa fica muda e nunca volta — o
// mesmo defeito que exigiu reconciliarPendenciasAgendamento.
const RETORNO_REPROCESSO_MS = Number(process.env.RETORNO_REPROCESSO_MS) || 30 * 1000;

// ---- Reuniao de retorno: 2a+ reuniao do MESMO caso ---------------------------------------------
// Consulta ja aconteceu e cliente+equipe confirmam outro horario para o MESMO negocio (ver
// src/reuniao-retorno.js). Sem esta rotina, handleAgendamentoCalendar trata isso como remarcacao da
// consulta que ja aconteceu: da PATCH no evento passado (apagando o registro da reuniao anterior) e
// a reuniao nova nunca entra na agenda do Moskit (registrarConsultaNaAgendaMoskit sai na guarda de
// atividade_moskit_id ja existente).
//
// Nasce DESLIGADA e, quando ligada, nasce em dry-run — mesmo padrao de CLIENTE_RETORNO_*. Aqui
// "como hoje" e desviado de proposito no dry-run: "como hoje" seria mover o evento da consulta que
// ja aconteceu, e medir nao justifica destruir esse registro (ver handleAgendamentoCalendar).
const REUNIAO_RETORNO_ATIVO = process.env.REUNIAO_RETORNO_ATIVO === 'true';
const REUNIAO_RETORNO_DRY_RUN = process.env.REUNIAO_RETORNO_DRY_RUN !== 'false';
// Ate quantas horas DEPOIS do fim da reuniao anterior uma confirmacao nova ainda conta como
// remarcacao (no-show + reagendamento rapido) em vez de reuniao nova de acompanhamento.
const REUNIAO_TOLERANCIA_REMARCACAO_HORAS = Number(process.env.REUNIAO_TOLERANCIA_REMARCACAO_HORAS) || reuniaoRetorno.TOLERANCIA_HORAS_PADRAO;

// ---- Anexo do Doc do Gemini na aba "Arquivos" do negocio -------------------------------------
// O POST /deals/{id}/attachments NAO aceita upload: o corpo e {"url": "..."} e quem baixa o arquivo
// e o servidor do Moskit (medido na doc oficial em 18/08/2026). Por isso o bot precisa servir o PDF
// numa URL que o Moskit alcance — e por isso esta funcionalidade depende de PUBLIC_BASE_URL.
const NOTAS_ANEXO_ATIVO = process.env.NOTAS_ANEXO_ATIVO === 'true';
// A URL publica e LIDA do ambiente, nunca derivada de tunnel_url.txt. O arquivo do tunel muda
// sozinho a cada restart do ngrok sem dominio fixo: um anexo apontando para a URL de ontem entra no
// CRM como link quebrado, e ninguem descobre ate abrir. URL de anexo tem que ser uma decisao, nao
// um efeito colateral de qual tunel subiu primeiro.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
// O PDF fica servido por uma rota SEM autenticacao — e a unica forma de o Moskit baixar. O conteudo
// e a transcricao de uma consulta juridica, entao o token de 256 bits nao basta sozinho: a janela
// tambem e curta. Assim que o Moskit confirma que copiou (size/mimeType batendo), o token expira na
// hora; este TTL e so o teto para o caso de a confirmacao nunca vir.
const NOTAS_ANEXO_TTL_HORAS = Number(process.env.NOTAS_ANEXO_TTL_HORAS) || 24;
// Mesmo teto e mesmo motivo de NOTAS_MAX_TENTATIVAS: falha permanente (deal apagado, Doc sem
// permissao) nao pode reprocessar para sempre em silencio.
const NOTAS_ANEXO_MAX_TENTATIVAS = Number(process.env.NOTAS_ANEXO_MAX_TENTATIVAS) || 3;
// Pausa entre anexos de uma mesma varredura, no mesmo espirito de VINCULO_PAUSA_MS. MEDIDO em
// 19/08/2026 contra a API real: o limite e 6 req/s (240/min) e o 429 aparece com FACILIDADE — bastaram
// tres requisicoes quase simultaneas numa sondagem de leitura. Cada anexo custa 1 GET de dedup + 1
// POST + ate 3 GETs de conferencia, entao uma varredura sem pausa e exatamente o tipo de rajada que
// derruba a rotina inteira em 429.
const NOTAS_ANEXO_PAUSA_MS = Number(process.env.NOTAS_ANEXO_PAUSA_MS) || 400;

let googleOAuthClientNotas = null;
function getGoogleAuthClientNotas() {
  if (googleOAuthClientNotas) return googleOAuthClientNotas;
  const caminhoClient = process.env.GOOGLE_OAUTH_CLIENT_NOTAS_JSON || './google-oauth-client-notas.json';
  const caminhoToken = process.env.GOOGLE_OAUTH_TOKEN_NOTAS_JSON || './google-oauth-token-notas.json';
  if (!fs.existsSync(caminhoClient) || !fs.existsSync(caminhoToken)) return null;
  const arquivo = JSON.parse(fs.readFileSync(caminhoClient, 'utf8'));
  const { client_id, client_secret, redirect_uris } = arquivo.installed || arquivo.web || {};
  if (!client_id) return null;
  const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  client.setCredentials(JSON.parse(fs.readFileSync(caminhoToken, 'utf8')));
  googleOAuthClientNotas = client;
  return googleOAuthClientNotas;
}

// HTTP agent compartilhado para evitar exaustao de conexoes
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
// Timeout global de toda chamada axios. Fica aqui, num lugar so — o valor estava hard-coded e agora
// vem de TIMEOUT_HTTP_MS, configuravel por .env.
axios.defaults.timeout = TIMEOUT_HTTP_MS;

// Consumo da IA, acumulado. Toda resposta da OpenAI carrega `usage` e este arquivo o DESCARTAVA —
// entao nao havia como dizer quanto custa uma conversa, nem comparar dois modelos sobre o mesmo
// corpus (e a comparacao e o criterio de decisao da troca de modelo). Aditivo de proposito: o
// `resolve(content)` continua identico e nenhum call site muda. Quem quer custo POR conversa chama
// zerarUsoIA() antes dela — e o que avaliar-extracao.js faz.
const usoIA = { chamadas: 0, prompt_tokens: 0, completion_tokens: 0 };
function lerUsoIA() { return { ...usoIA }; }
function zerarUsoIA() { usoIA.chamadas = 0; usoIA.prompt_tokens = 0; usoIA.completion_tokens = 0; }
// A chamada conta mesmo sem `usage` (resposta vazia tambem foi paga); os tokens somam o que vier.
function registrarUsoIA(usage) {
  usoIA.chamadas += 1;
  usoIA.prompt_tokens += Number(usage?.prompt_tokens) || 0;
  usoIA.completion_tokens += Number(usage?.completion_tokens) || 0;
}

// Chamada direta a API OpenAI via HTTPS (sem SDK, sem fetch, sem hangs)
async function openaiChat(messages, responseFormat) {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    messages,
    temperature: 0,
    ...(responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
  });

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; req.destroy(); reject(new Error('timeout')); }
    }, 30000);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25000,
    }, (res) => {
      // Acumula os Buffers brutos e so decodifica UTF-8 uma vez no fim: decodificar chunk a chunk
      // (`data += chunk` forca toString() por pedaco) corrompe um caractere multi-byte (c, ~a, etc.)
      // que caia bem na fronteira entre dois pedacos de rede. MEDIDO contra a API real em 21/08/2026:
      // "Ministerio da Educacao" saiu com o "ca" corrompido numa resposta real do gpt-4o-mini.
      const chunks = [];
      // Buffer.isBuffer: o dublê de OpenAI usado nos testes emite 'data' com string pronta em vez de
      // Buffer (mais simples de escrever) — sem essa checagem, Buffer.concat lançaria contra o dublê.
      res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')); });
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const data = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(data);
          registrarUsoIA(parsed.usage);
          const content = parsed.choices?.[0]?.message?.content;
          // A mensagem tem de CARREGAR o motivo. "resposta vazia" era o que saia para TODA falha da
          // API — 429 de rate limit, contexto estourado, chave revogada — porque `parsed.choices`
          // nao existe em nenhuma delas e o payload de erro era descartado aqui. MEDIDO em
          // 02/09/2026: 163 de 277 conversas de um replay falharam com essa frase, e nao havia como
          // descobrir que eram rate limit sem instrumentar a funcao a mao.
          if (!content) {
            const motivo = parsed.error?.message || parsed.error?.code || `sem choices (HTTP ${res.statusCode})`;
            reject(new Error(`OpenAI nao devolveu conteudo: ${motivo}`));
          } else resolve(content);
        } catch (e) {
          reject(new Error('Falha ao parsear resposta OpenAI: ' + e.message));
        }
      });
    });

    req.on('timeout', () => { if (!done) { done = true; req.destroy(); reject(new Error('OpenAI socket timeout')); } });
    req.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    req.write(body);
    req.end();
  });
}

const apiHeaders = {
  apikey: process.env.MOSKIT_API_KEY,
  'Content-Type': 'application/json',
};

// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
// DB_PATH existe para TESTE. Sem ele, qualquer teste que faca require('./index.js') abre o banco de
// producao e roda os ALTER TABLE nas conversas reais — foi assim que o test-rotas.js nasceu tocando
// as 208 conversas. As tabelas nascem com CREATE TABLE IF NOT EXISTS, entao apontar para um arquivo
// inexistente produz um banco valido e completo, descartavel.
const db = new Database(process.env.DB_PATH || 'conversations.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    chat_id TEXT PRIMARY KEY,
    phone TEXT,
    contact_name TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    deal_id INTEGER,
    last_activity TEXT,
    last_data TEXT,
    last_action TEXT,
    processed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

try { db.exec("ALTER TABLE conversations ADD COLUMN last_data TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN last_action TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN processed INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_added INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN last_processed_at TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_criado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_id TEXT"); } catch {}
// Horario que o bot reservou de fato — sem isso nao ha memoria de qual slot foi agendado
// (atualizarEventoSeRemarcado sempre relia do Google) e nao da pra auditar remarcacao.
try { db.exec("ALTER TABLE conversations ADD COLUMN evento_calendar_data TEXT"); } catch {}
// Checkpoint da cobranca: 1 depois que a equipe enviou o bloco de condicoes de valor nesta conversa.
// Transicao de mao unica (cortesia -> paga); e a virada 0->1 que dispara a correcao do deal.
try { db.exec("ALTER TABLE conversations ADD COLUMN bloco_condicoes_enviado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN bloco_condicoes_msg_idx INTEGER"); } catch {}
// Hash da ultima pendencia de agendamento ja anotada no deal — evita repetir a nota a cada ciclo.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_pendente_hash TEXT"); } catch {}
// Hash do ultimo ERRO de agendamento ja anotado no deal (token expirado, erro de rede, etc — nao
// confundir com agendamento_pendente_hash, que e sobre confirmacao INCOMPLETA). Sem isso a falha na
// criacao/remarcacao do evento so aparecia no console do processo: a dupla confirmacao acontecia de
// verdade e ninguem no escritorio ficava sabendo que a reuniao nao foi pra agenda. Visto no deal
// 48346871 (token OAuth expirado): confirmacao completa, zero nota no CRM.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_erro_hash TEXT"); } catch {}
// Atividade criada no Moskit para a consulta desta conversa — e o compromisso na AGENDA do CRM,
// irmao do evento em evento_calendar_id. Guarda o id para (a) nao criar duas e (b) mover o horario
// junto quando a consulta e remarcada. Antes disto o agendamento so existia no Google Agenda e como
// texto de nota: quem trabalha dentro do Moskit nao via a consulta em lugar nenhum.
try { db.exec("ALTER TABLE conversations ADD COLUMN atividade_moskit_id INTEGER"); } catch {}
// Contrato de Prestacao de Servico gerado no ZapSign — mesmo espirito das colunas de agendamento
// acima. contrato_zapsign_criado e o guard de idempotencia (so gera uma vez por deal);
// _doc_token identifica o documento pro webhook de status; _pendente_hash/_erro_hash dedupam
// nota de dado faltante vs. falha real de API, mesma distincao de agendamento_pendente_hash vs
// agendamento_erro_hash.
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_criado INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_doc_token TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_status TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_pendente_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN contrato_zapsign_erro_hash TEXT"); } catch {}
// Ultimo valor que o BOT escreveu em cada campo personalizado do deal, no formato
// {"<CF_id>": [options]}. E a memoria que permite distinguir "o CRM tem o valor que eu mesmo
// escrevi" de "alguem da equipe corrigiu na mao": divergencia => humano mexeu.
try { db.exec("ALTER TABLE conversations ADD COLUMN custom_fields_bot TEXT"); } catch {}
// Ids de campo personalizado travados por edicao humana (JSON array). Trava permanente: uma vez que a
// equipe corrigiu um campo, o bot nunca mais o reescreve, mesmo que a IA mude de opiniao depois.
try { db.exec("ALTER TABLE conversations ADD COLUMN campos_travados TEXT"); } catch {}
// Hashes de nota: briefing (para repostar quando o resumo do caso mudar de verdade) e nota de campos
// preenchidos (para nao repetir a MESMA nota a cada ciclo — o deal 48423360 acumulou 6 identicas).
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_hash TEXT"); } catch {}
// Versao do ultimo briefing postado (titulo "📋 Briefing · v{n} · ..."). O historico de verdade e a
// trilha de notas no deal; esta coluna so da o numero do proximo titulo (se uma nota for apagada na
// mao o numero continua, e so cosmetica).
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_versao INTEGER DEFAULT 0"); } catch {}
// Horario de consulta (evento_calendar_data) para o qual o briefing ja foi "refrescado" pela rotina
// refrescarBriefingsPertoDaConsulta. Dedup por horario: consulta nova (ou remarcada) volta a ser
// processada; a mesma consulta nao gera reprocessamento repetido a cada ciclo.
try { db.exec("ALTER TABLE conversations ADD COLUMN briefing_refresh_para TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN campos_nota_hash TEXT"); } catch {}
// Ultima apuracao de dupla confirmacao desta conversa (JSON): as observacoes de horario validadas,
// as duas pernas escolhidas e o motivo, quando nao fechou. Existe porque essa decisao so vivia num
// console.log: quando o cliente do deal 47543238 esperou sozinho na sala e o do 48226006 ficou com a
// reuniao no dia velho, nao havia como saber, depois do fato, se a perna do cliente nao foi emitida
// pelo modelo ou se foi descartada na validacao — as duas hipoteses levam a correcoes opostas.
// Guarda o ESTADO ATUAL (uma linha por conversa), nao historico: e o espelho da ultima rodada.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_apuracao TEXT"); } catch {}
// Hash do ultimo conjunto de valores que a IA devolveu e que nao existem na lista do CRM. Sem isso o
// campo apenas nao era enviado e ninguem no escritorio ficava sabendo — e um valor recorrente ("Direito
// Civil") continuava caindo no vazio indefinidamente em vez de virar apelido em src/moskit-ids.js.
try { db.exec("ALTER TABLE conversations ADD COLUMN opcao_invalida_hash TEXT"); } catch {}
// Hash da ultima divergencia (bruta, nao aplicada) entre o `data_hora_consulta` que o modelo devolveu
// nesta rodada e o `dadosEvento.data_hora_consulta` que a apuracao efetivamente manteve — sinal de que
// a apuracao fechou com um valor diferente do que o proprio modelo entendeu. Coluna PROPOSITALMENTE
// separada de agendamento_pendente_hash/agendamento_erro_hash: sao avisos com ciclo de vida diferente
// (aquelas zeram quando o evento e criado/remarcado; esta e so um log de auditoria, nao depende disso).
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_divergencia_hash TEXT"); } catch {}
// Ultimo agendamento_pendente_hash que ja gerou aviso da reconciliacao periodica
// (reconciliarPendenciasAgendamento) — dedup PROPRIO, separado de agendamento_pendente_hash. Existe
// porque uma conversa SILENCIOSA (sem mensagem nova de nenhum lado) nunca e reprocessada de novo —
// medido em 14/08/2026 no deal 48466404 (Teresinha): ela pagou e perguntou o endereco do escritorio,
// claramente achando que a consulta esta marcada, mas a dupla confirmacao nunca fechou (dia ambiguo,
// "quarta ou quinta") e a conversa parou de receber mensagem. A escalada por proximidade dentro de
// registrarAgendamentoPendente so roda quando a conversa E REPROCESSADA — uma conversa muda nunca
// aciona isso. Levantamento em produção achou 17 negocios parados assim, alguns ha mais de uma semana.
try { db.exec("ALTER TABLE conversations ADD COLUMN agendamento_pendencia_avisada TEXT"); } catch {}
// Estado da reconciliacao de vinculo de atividade (ver reconciliarVinculoAtividades). Medido
// 14-17/08/2026 em 6 negocios (48287898, 48292471, 48441223, 48447661, 48464876, 48474073): a
// atividade criada pelo bot ficou sem vinculo com o negocio e a rede de seguranca retentava a cada
// 30 min contra o rate-limit do Moskit (HTTP 429 / timeout de 30s) SEMPRE, inundando o Telegram com
// o mesmo "erro precisa de conferencia manual". vinculo_falhas conta tentativas consecutivas;
// vinculo_backoff_ate segura a linha durante um cooldown (sem chamar rede); vinculo_desistiu e o
// estado terminal (so o script religar-atividade.js desfaz); vinculo_aviso_hash deduplica o aviso
// final do Telegram.
try { db.exec("ALTER TABLE conversations ADD COLUMN vinculo_falhas INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN vinculo_desistiu INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN vinculo_backoff_ate INTEGER"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN vinculo_aviso_hash TEXT"); } catch {}
// Segundo atendimento do MESMO telefone (ver src/cliente-retorno.js). A conversa e uma linha por
// chat_id para sempre: sem uma fronteira, o atendimento novo herda o bloco de condicoes, o contrato, a
// agenda e a classificacao do anterior.
//   atendimento_inicio_msg_idx — indice ABSOLUTO da primeira mensagem do atendimento atual. Absoluto
//     porque observacoes.msg_idx e validado contra o array `messages` inteiro (src/evidencia.js):
//     reindexar a janela faria toda observacao apontar para a mensagem errada.
//   deals_anteriores — JSON com os negocios ja encerrados desta conversa, para a nota do negocio novo
//     poder citar o anterior sem nenhuma chamada ao CRM.
//   retorno_aviso_hash — dedup do aviso do caminho ambiguo, por LINHA (mesmo padrao de
//     vinculo_aviso_hash): sem ele o mesmo "confira se e caso novo" volta a cada ciclo.
try { db.exec("ALTER TABLE conversations ADD COLUMN atendimento_inicio_msg_idx INTEGER"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN atendimento_num INTEGER DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN deals_anteriores TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN retorno_aviso_hash TEXT"); } catch {}
// 2a+ reuniao do MESMO caso (ver src/reuniao-retorno.js) — diferente do bloco acima, que e sobre um
// caso NOVO. Aqui o negocio e o MESMO; so o compromisso (evento/Atividade/briefing) e novo.
//   reuniao_num — numero da reuniao ATUAL desta conversa (1 = a consulta original).
//   reunioes_anteriores — JSON [{numero, horarioIso, evento_id, atividade_id, encerrada_em}] das
//     reunioes ja arquivadas, para numeroDaReuniao (nota do Gemini) e para a nota do negocio poder
//     citar a reuniao anterior sem chamada ao CRM.
//   reuniao_aviso_hash — dedup por LINHA, mesmo padrao de retorno_aviso_hash/vinculo_aviso_hash.
try { db.exec("ALTER TABLE conversations ADD COLUMN reuniao_num INTEGER DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN reunioes_anteriores TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN reuniao_aviso_hash TEXT"); } catch {}
// Quando esta linha foi vista pela ultima vez pela reconciliacao de classificacao (ver
// reconciliarClassificacao, modo 'antigos'). reconciliarClassificacao no modo 'recentes' (o de sempre,
// por updated_at) nunca alcanca deal fora da janela de RECONCILIACAO_DIAS ou fora do top-N mais
// recentes — um deal parado ha mais de 30 dias nunca era revisitado. O modo 'antigos' ordena por esta
// coluna (NULL primeiro) em vez de updated_at, e cada linha processada e marcada com a hora atual —
// e o que garante rotacao: a proxima rodada em modo 'antigos' avanca para a fatia seguinte nunca vista,
// em vez de reler sempre os mesmos registros.
try { db.exec("ALTER TABLE conversations ADD COLUMN reconciliado_em TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_contrato_zapsign_doc_token ON conversations(contrato_zapsign_doc_token)"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS moskit_contacts (
    phone TEXT PRIMARY KEY,
    moskit_id INTEGER,
    name TEXT,
    raw_data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_moskit_phone ON moskit_contacts(phone)"); } catch {}

const stmtMoskitUpsert = db.prepare(`
  INSERT INTO moskit_contacts (phone, moskit_id, name, raw_data)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET
    moskit_id = excluded.moskit_id,
    name = excluded.name,
    raw_data = excluded.raw_data,
    updated_at = datetime('now')
`);
const stmtMoskitGet = db.prepare('SELECT * FROM moskit_contacts WHERE phone = ?');
// Busca pelo SUFIXO do telefone (ultimos SUFIXO_COMPARACAO digitos). A chave da tabela e o telefone
// com `slice(-13)`, entao o mesmo cliente salvo com e sem DDI ocupa duas chaves diferentes e o GET
// exato erra — ver o comentario de buscarOuCriarContato. Varredura de tabela, mas so roda quando o
// GET exato falha e a tabela e pequena (~4k contatos).
const stmtMoskitPorSufixo = db.prepare("SELECT * FROM moskit_contacts WHERE phone LIKE '%' || ?");
const stmtMoskitCount = db.prepare('SELECT COUNT(*) as t FROM moskit_contacts');

const stmtUpsert = db.prepare(`
  INSERT INTO conversations (chat_id, phone, contact_name, messages, last_activity)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    messages = excluded.messages,
    last_activity = excluded.last_activity,
    phone = excluded.phone,
    contact_name = excluded.contact_name,
    updated_at = datetime('now')
`);

const stmtGet = db.prepare('SELECT * FROM conversations WHERE chat_id = ?');
const stmtUpdateDeal = db.prepare(
  "UPDATE conversations SET deal_id = ?, last_data = ?, last_action = ?, processed = 1, updated_at = datetime('now') WHERE chat_id = ?"
);
const stmtUpdateProcessed = db.prepare(
  "UPDATE conversations SET last_data = ?, last_action = ?, processed = 1, updated_at = datetime('now') WHERE chat_id = ?"
);
// Usado por finalizarCiclo: grava deal_id, dados, acao, processed e last_processed_at de uma vez.
// Os ramos faziam isso em DOIS comandos (stmtUpdateDeal + um db.prepare inline so pro
// last_processed_at), repetidos em cada um dos tres ramos.
const stmtFinalizarCiclo = db.prepare(
  "UPDATE conversations SET deal_id = ?, last_data = ?, last_action = ?, processed = 1, last_processed_at = datetime('now'), updated_at = datetime('now') WHERE chat_id = ?"
);
const stmtGetPending = db.prepare("SELECT * FROM conversations WHERE processed = 0 OR processed IS NULL");

db.exec(`
  CREATE TABLE IF NOT EXISTS comprovantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    phone TEXT,
    caminho_arquivo TEXT,
    valor_pago_centavos INTEGER,
    confianca INTEGER,
    parece_comprovante INTEGER,
    observacao TEXT,
    match INTEGER,
    notificado_telegram INTEGER DEFAULT 0,
    deal_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_comprovantes_chat ON comprovantes(chat_id)"); } catch {}

const stmtComprovanteInsert = db.prepare(`
  INSERT INTO comprovantes (chat_id, phone, caminho_arquivo, valor_pago_centavos, confianca, parece_comprovante, observacao, match, notificado_telegram)
  VALUES (@chat_id, @phone, @caminho_arquivo, @valor_pago_centavos, @confianca, @parece_comprovante, @observacao, @match, @notificado_telegram)
`);
const stmtComprovanteUltimo = db.prepare(
  'SELECT * FROM comprovantes WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
);
const stmtComprovanteSetDeal = db.prepare('UPDATE comprovantes SET deal_id = ? WHERE id = ?');
const stmtComprovantePorDeal = db.prepare(
  'SELECT * FROM comprovantes WHERE deal_id = ? AND match = 1 ORDER BY id DESC LIMIT 1'
);
const stmtComprovantePorSufixoTelefone = db.prepare(
  "SELECT * FROM comprovantes WHERE match = 1 AND (chat_id LIKE '%' || ? || '%' OR phone LIKE '%' || ? || '%') ORDER BY id DESC LIMIT 1"
);

db.exec(`
  CREATE TABLE IF NOT EXISTS atividades_sincronizadas (
    activity_id INTEGER PRIMARY KEY,
    evento_calendar_id TEXT,
    deal_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
const stmtAtividadeJaSincronizada = db.prepare('SELECT 1 FROM atividades_sincronizadas WHERE activity_id = ?');
const stmtAtividadeMarcarSincronizada = db.prepare(
  'INSERT OR IGNORE INTO atividades_sincronizadas (activity_id, evento_calendar_id, deal_id) VALUES (?, ?, ?)'
);

// ------------------------------------------------------------
// Estado da rotina de notas de reuniao (Gemini -> nota no negocio)
// ------------------------------------------------------------
// Uma linha por e-mail. E a fonte da verdade da idempotencia — o rotulo do Gmail e so espelho para
// humano, e o marcador dentro da nota e a reconciliacao de ultimo recurso.
//
// DUAS tabelas, real e dry-run, e isso NAO e detalhe. Se o dry-run gravasse na tabela real, a
// primeira execucao de verdade encontraria tudo CONCLUIDO e nao faria nada — o teste teria consumido
// silenciosamente o trabalho que ele deveria apenas simular.
//
// O indice unico em doc_id impede que o MESMO Doc, reenviado ou encaminhado por outra mensagem,
// vire uma segunda nota no negocio.
for (const tabela of ['notas_reuniao', 'notas_reuniao_dryrun']) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tabela} (
      gmail_message_id TEXT PRIMARY KEY,
      doc_id           TEXT,
      evento_id        TEXT,
      assunto          TEXT,
      deal_id          INTEGER,
      metodo           TEXT,
      diagnostico      TEXT,
      extracao         TEXT,
      marcador         TEXT,
      estado           TEXT NOT NULL,
      tentativas       INTEGER DEFAULT 0,
      ultimo_erro      TEXT,
      criado_em        TEXT DEFAULT (datetime('now')),
      atualizado_em    TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${tabela}_doc ON ${tabela}(doc_id) WHERE doc_id IS NOT NULL`); } catch {}

  // Estado do ANEXO (o PDF do Doc na aba "Arquivos"), em colunas proprias.
  //
  // Precisa ser ALTER TABLE, nao so linha nova no CREATE acima: o CREATE e `IF NOT EXISTS`, entao em
  // qualquer banco que ja exista — producao inclusive — ele nao roda e as colunas novas simplesmente
  // nao apareceriam. Esta e a primeira migracao destas duas tabelas; todos os outros ALTER do arquivo
  // sao de `conversations`.
  //
  // E `anexo_estado` e coluna SEPARADA de `estado` de proposito: a guarda de ESTADOS_TERMINAIS e a
  // query `pendentes` sao a trava contra nota duplicada no prontuario do cliente, e um estado novo
  // circulando por elas mudaria esse comportamento sem que ninguem tivesse pedido.
  for (const coluna of [
    'anexo_token TEXT',       // segredo da URL publica; NULL = sem URL viva
    'anexo_caminho TEXT',     // PDF em disco, apagado assim que o Moskit confirma a copia
    'anexo_nome TEXT',        // nome deterministico: e por ele que a deduplicacao encontra o anexo
    'anexo_estado TEXT',      // NULL | ANEXANDO | ANEXADO | SEM_DOC | DESISTIU
    'anexo_id INTEGER',       // id do attachment no Moskit
    'anexo_expira_em TEXT',
    'anexo_tentativas INTEGER DEFAULT 0',
  ]) {
    try { db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna}`); } catch {}
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_${tabela}_anexo_token ON ${tabela}(anexo_token) WHERE anexo_token IS NOT NULL`); } catch {}
}

// Saude da rotina, uma linha so. Guarda a ultima vez que a busca no Gmail devolveu ALGUMA mensagem —
// nao a ultima vez que rodou. A distincao e o ponto: ciclo vazio e o estado normal (o que ja foi
// processado sai da busca pelo rotulo), entao "nao veio nada agora" nao significa nada. O que precisa
// de aviso e silencio prolongado.
db.exec(`
  CREATE TABLE IF NOT EXISTS notas_reuniao_saude (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    ultimo_email_em TEXT,
    ultimo_aviso_em TEXT
  )
`);
db.exec("INSERT OR IGNORE INTO notas_reuniao_saude (id, ultimo_email_em) VALUES (1, datetime('now'))");
const stmtNotasSaude = db.prepare('SELECT * FROM notas_reuniao_saude WHERE id = 1');
const stmtNotasViuEmail = db.prepare(
  "UPDATE notas_reuniao_saude SET ultimo_email_em = datetime('now'), ultimo_aviso_em = NULL WHERE id = 1"
);
const stmtNotasAvisouSilencio = db.prepare(
  "UPDATE notas_reuniao_saude SET ultimo_aviso_em = datetime('now') WHERE id = 1"
);

// Os statements sao montados por tabela para que o dry-run use exatamente o mesmo codigo do modo
// real — um caminho de execucao separado para o dry-run so provaria que o caminho separado funciona.
function stmtsNotas(dryRun) {
  const t = dryRun ? 'notas_reuniao_dryrun' : 'notas_reuniao';
  return {
    get: db.prepare(`SELECT * FROM ${t} WHERE gmail_message_id = ?`),
    porDoc: db.prepare(`SELECT * FROM ${t} WHERE doc_id = ?`),
    inserir: db.prepare(`INSERT OR IGNORE INTO ${t} (gmail_message_id, assunto, estado) VALUES (?, ?, 'RESERVADO')`),
    avancar: db.prepare(`
      UPDATE ${t}
         SET estado = @estado, doc_id = COALESCE(@doc_id, doc_id), evento_id = COALESCE(@evento_id, evento_id),
             deal_id = COALESCE(@deal_id, deal_id), metodo = COALESCE(@metodo, metodo),
             diagnostico = COALESCE(@diagnostico, diagnostico), extracao = COALESCE(@extracao, extracao),
             marcador = COALESCE(@marcador, marcador), ultimo_erro = @ultimo_erro,
             atualizado_em = datetime('now')
       WHERE gmail_message_id = @gmail_message_id
    `),
    falhar: db.prepare(`
      UPDATE ${t} SET tentativas = tentativas + 1, ultimo_erro = ?, atualizado_em = datetime('now')
       WHERE gmail_message_id = ?
    `),
    pendentes: db.prepare(`
      SELECT * FROM ${t}
       WHERE estado NOT IN ('CONCLUIDO', 'ORFAO', 'ERRO_PERMANENTE', 'REVISAR_MANUAL')
       ORDER BY criado_em
    `),
    contarPorEstado: db.prepare(`SELECT estado, COUNT(*) AS total FROM ${t} GROUP BY estado`),

    // Statement proprio para o anexo, em vez de mais campos no `avancar`: aquele UPDATE exige que
    // TODO campo nomeado exista no objeto (e o que `camposVazios()` resolve), entao cada coluna nova
    // ali vira uma armadilha em todas as ~10 chamadas existentes.
    avancarAnexo: db.prepare(`
      UPDATE ${t}
         SET anexo_estado = @anexo_estado,
             anexo_token = COALESCE(@anexo_token, anexo_token),
             anexo_caminho = COALESCE(@anexo_caminho, anexo_caminho),
             anexo_nome = COALESCE(@anexo_nome, anexo_nome),
             anexo_id = COALESCE(@anexo_id, anexo_id),
             anexo_expira_em = COALESCE(@anexo_expira_em, anexo_expira_em),
             atualizado_em = datetime('now')
       WHERE gmail_message_id = @gmail_message_id
    `),
    // Zera a URL viva: token invalidado e PDF ja apagado do disco. O anexo continua no Moskit.
    encerrarAnexo: db.prepare(`
      UPDATE ${t} SET anexo_token = NULL, anexo_caminho = NULL, anexo_expira_em = NULL,
                      atualizado_em = datetime('now')
       WHERE gmail_message_id = ?
    `),
    contarTentativaAnexo: db.prepare(`
      UPDATE ${t} SET anexo_tentativas = anexo_tentativas + 1, atualizado_em = datetime('now')
       WHERE gmail_message_id = ?
    `),
    // A rede de seguranca do anexo. So olha linha cuja NOTA ja concluiu: enquanto a nota nao entrou,
    // quem cuida da linha e o ciclo normal, e duas rotinas mexendo na mesma linha ao mesmo tempo e
    // como nasce anexo duplicado.
    anexosPendentes: db.prepare(`
      SELECT * FROM ${t}
       WHERE estado = 'CONCLUIDO' AND anexo_estado = 'ANEXANDO'
         AND anexo_tentativas < @maxTentativas
       ORDER BY atualizado_em
       LIMIT @limite
    `),
    // Quem ja gastou as tentativas. Statement proprio em vez de reusar `anexosPendentes` com um
    // teto absurdo: sentinela numerico e o tipo de truque que sobrevive ao autor e confunde quem
    // vier depois — a intencao aqui e "desistiu", nao "pendente com limite alto".
    anexosDesistentes: db.prepare(`
      SELECT * FROM ${t}
       WHERE estado = 'CONCLUIDO' AND anexo_estado = 'ANEXANDO'
         AND anexo_tentativas >= @maxTentativas
    `),
    anexosExpirados: db.prepare(`
      SELECT * FROM ${t}
       WHERE anexo_token IS NOT NULL AND anexo_expira_em IS NOT NULL
         AND anexo_expira_em < datetime('now')
    `),
  };
}

// Busca da rota publica de download. Fora de stmtsNotas porque a rota nao tem "modo": o dry-run
// nunca grava PDF em disco, entao nao ha o que servir da tabela de simulacao.
//
// PREPARADO SOB DEMANDA, NUNCA NO CARREGAMENTO DO MODULO — e o unico ponto desta funcionalidade
// capaz de derrubar o bot inteiro, e por isso ele nao existe mais.
//
// O `ALTER TABLE` que cria `anexo_token` esta dentro de `try {} catch {}`, como todo o resto do boot.
// Um `db.prepare` no topo do arquivo transformava esse catch numa armadilha: se a migracao falhasse
// por QUALQUER motivo que nao "coluna ja existe" — disco cheio, banco travado por outro processo,
// arquivo corrompido — o prepare lancava `no such column: anexo_token` durante o `require`, o
// processo morria com exit 1, e o pm2 entrava em loop de restart. O bot inteiro (WhatsApp, agenda,
// CRM) ficava fora do ar por causa de uma coluna de uma funcionalidade DESLIGADA.
//
// Preguicoso, o pior caso vira "a rota de anexo devolve 404" — que e exatamente o que ela ja
// responde para token invalido. Regressao em test-rotas.js (o cenario da migracao impossivel).
let _stmtNotaPorAnexoToken = null;
function stmtNotaPorAnexoToken() {
  if (!_stmtNotaPorAnexoToken) {
    _stmtNotaPorAnexoToken = db.prepare(`
      SELECT gmail_message_id, deal_id, anexo_token, anexo_caminho, anexo_nome, anexo_expira_em
        FROM notas_reuniao
       WHERE anexo_token = ? AND anexo_expira_em > datetime('now')
    `);
  }
  return _stmtNotaPorAnexoToken;
}

// ------------------------------------------------------------
// Mapeamentos de campos personalizados (Moskit)
// ------------------------------------------------------------
function removerAcentos(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Assunto que o prompt manda usar quando ninguem descreveu o caso ainda. Nao e um palpite de area \u2014
// e o placeholder honesto, e por isso passa pelo gate do caso descrito (ver processarConversaDirect).
// Com acento porque vai pro TITULO do negocio no CRM, que e texto lido por gente. A comparacao em
// ehAssuntoNeutro normaliza acentos, entao o "Consulta juridica" sem acento que o prompt manda o modelo
// devolver casa com este valor.
const ASSUNTO_NEUTRO = 'Consulta jurídica';
function ehAssuntoNeutro(assunto) {
  const normalizar = (s) => removerAcentos(String(s || '').toLowerCase().trim());
  return normalizar(assunto) === normalizar(ASSUNTO_NEUTRO);
}

function removerEmoji(str) {
  return String(str || '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\ufe0f]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Tabelas de ID vem de src/moskit-ids.js — fonte unica, importada tambem pelos scripts. Aqui usamos o
// INDICE_BUSCA (canonicas + apelidos, tudo normalizado), nao as tabelas cruas: a busca de opcao exige
// correspondencia exata, entao "Dr. Berto" ou "familia" so chegam ao ID certo pelo indice.
const MAPEAMENTO_ORIGEM = MOSKIT_IDS.INDICE_BUSCA.ORIGEM;
const MAPEAMENTO_TIPO_CONSULTA = MOSKIT_IDS.INDICE_BUSCA.TIPO_CONSULTA;
const MAPEAMENTO_CAPTACAO = MOSKIT_IDS.INDICE_BUSCA.CAPTACAO;
const MAPEAMENTO_AREA_DIREITO = MOSKIT_IDS.INDICE_BUSCA.AREA_DIREITO;
const MAPEAMENTO_RESPONSAVEL_PROCESSO = MOSKIT_IDS.INDICE_BUSCA.RESPONSAVEL_PROCESSO;

// Campos de opcao que o bot classifica, com o nome que a equipe ve no CRM. Usado para detectar valor
// que a IA inventou (detectarOpcoesInvalidas) e para nomear campo em nota/log.
const CAMPOS_CLASSIFICACAO = [
  { campo: 'origem', nome: 'Origem', mapa: MAPEAMENTO_ORIGEM },
  { campo: 'tipo_consulta', nome: 'Tipo de Consulta', mapa: MAPEAMENTO_TIPO_CONSULTA },
  { campo: 'captacao', nome: 'Captação', mapa: MAPEAMENTO_CAPTACAO },
  { campo: 'area_direito', nome: 'Área do Direito', mapa: MAPEAMENTO_AREA_DIREITO },
  { campo: 'advogado_responsavel', nome: 'Responsável pelo processo', mapa: MAPEAMENTO_RESPONSAVEL_PROCESSO },
];

// Campo "Tipo de Consulta" do deal (MULTIPLE_OPTION). Unica fonte de verdade pra leads que nunca
// passaram pelo WhatsApp (Moskit Boost, atividade criada na mao) — ver autorizacaoParaAgendar.
const CF_TIPO_CONSULTA = MOSKIT_IDS.CF.TIPO_CONSULTA;
const TIPO_CONSULTA_GRATIS_ID = MOSKIT_IDS.TIPO_CONSULTA_GRATIS_ID;
const TIPO_CONSULTA_PAGA_ID = MOSKIT_IDS.TIPO_CONSULTA_PAGA_ID;

// Correspondencia EXATA (depois de normalizar) contra o indice de busca do campo, que ja inclui as
// chaves canonicas e os apelidos declarados em src/moskit-ids.js.
//
// O casamento por substring que existia aqui preenchia mais campos ao custo de escolher a opcao errada
// em silencio: "Indicacao" sozinho virava "Indicacao de clientes", "direito" virava "Direito
// Administrativo" e "consulta" virava "consulta gratis" — esse ultimo com consequencia financeira
// (R$0 no CRM). Decisao de 12/08/2026: valor que nao esta na tabela deixa o campo VAZIO e vira aviso
// (ver detectarOpcoesInvalidas/registrarOpcoesInvalidas), nunca um chute.
//
// `aproximado` existe para UM caso legitimo: o motivo de perda, que a IA escreve com as palavras da
// conversa e precisa cair na opcao mais parecida da lista fixa do CRM.
function buscarIdOpcao(mapeamento, valor, opcoes = {}) {
  const id = MOSKIT_IDS.buscarOpcao(mapeamento, valor, opcoes);
  if (id === null && valor) {
    console.log(`  ⚠️ opcao nao reconhecida para "${valor}" — campo fica vazio (cadastrar apelido em src/moskit-ids.js se for recorrente)`);
  }
  return id;
}

// Bloco padrao de condicoes que a equipe manda quando a consulta e PAGA. Se a equipe NUNCA enviou
// esse bloco, a consulta e cortesia — essa e a regra do escritorio, porque o atendente nunca declara
// gratuidade explicitamente.
//
// A deteccao vive em src/bloco-condicoes.js: e impressao digital do template (1 marcador de valor OU
// 3 de estrutura), avaliada por mensagem e sobre a concatenacao do que a equipe escreveu. O detector
// antigo era um punhado de regex soltas e uma delas ("informacoes sobre o atendimento") procurava
// uma frase que nao existe mais no bloco em uso, entao bloco parcial passava como cortesia.
function equipeEnviouCondicoesDeValor(mensagens, opcoes = {}) {
  return detectarBlocoCondicoes(mensagens, opcoes).enviado;
}

// Campo MULTIPLE_OPTION: pode ter mais de uma opcao marcada. Regra conservadora — so e gratis se a
// opcao gratis estiver presente E a paga NAO estiver. Campo vazio, "sem consulta" ou combinacao
// ambigua => false, mantendo a exigencia de comprovante.
function dealEhConsultaGratis(deal) {
  const campo = (deal?.entityCustomFields || []).find((c) => c?.id === CF_TIPO_CONSULTA);
  const opcoes = (campo?.options || []).map(Number);
  if (!opcoes.length || opcoes.includes(TIPO_CONSULTA_PAGA_ID)) return false;
  return opcoes.includes(TIPO_CONSULTA_GRATIS_ID);
}

// O PUT do Moskit e "full replace": qualquer campo ausente do payload some do deal. Preserva o que
// a equipe preencheu na mao e que o bot nao soube resolver nesta rodada.
function mesclarCustomFields(existentes, novos) {
  const mapa = new Map();
  for (const c of (Array.isArray(existentes) ? existentes : [])) {
    if (c?.id && Array.isArray(c.options) && c.options.length) mapa.set(c.id, { id: c.id, options: c.options });
  }
  for (const c of (Array.isArray(novos) ? novos : [])) mapa.set(c.id, c);
  return [...mapa.values()];
}

// Compara por id do custom field + conjunto de options (nao por posicao no array nem
// JSON.stringify direto — o Moskit nao garante a mesma ordem de array em duas leituras, e
// id/options podem vir como string numa leitura e number noutra).
function customFieldsPersistiram(esperados, atuais) {
  const mapaAtual = new Map((Array.isArray(atuais) ? atuais : []).map((c) => [c.id, c]));
  return (Array.isArray(esperados) ? esperados : []).every((esperado) => {
    const atual = mapaAtual.get(esperado.id);
    if (!atual) return false;
    const optsEsperados = (esperado.options || []).map(String).sort();
    const optsAtuais = (atual.options || []).map(String).sort();
    return optsEsperados.length === optsAtuais.length && optsEsperados.every((o, i) => o === optsAtuais[i]);
  });
}

// ------------------------------------------------------------
// Autoria dos campos personalizados: humano ganha do bot
// ------------------------------------------------------------
// O bot reescreve os mesmos campos a cada ciclo, a partir de last_data. Com a verificacao pos-PUT
// (ver atualizarNegocioMoskit) ele ainda insiste com retentativas ate o valor dele grudar — ou seja,
// uma correcao feita na mao pela equipe era desfeita no ciclo seguinte. Regra do escritorio
// (12/08/2026): quem corrige na mao ganha, para sempre.
//
// Dois campos ficam FORA da lista de proposito, porque neles nao existe "opiniao" a preservar — existe
// regra:
//   - TIPO_CONSULTA: quem manda e o checkpoint do bloco de condicoes, que ja sobrepoe marcacao manual
//     de cortesia quando a equipe anuncia o valor.
//   - RESPONSAVEL: e DERIVADO da area (MOSKIT_IDS.ADVOGADO_POR_AREA_ID) e montarPayloadMoskit o
//     reescreve em toda escrita. Trava-lo criaria um CRM incoerente consigo mesmo — area de Familia com
//     responsavel Iury — que e exatamente o erro que a tabela existe para eliminar. Quem quiser outro
//     responsavel muda a AREA, ou a tabela.
const CF_TRAVAVEIS = new Set([
  MOSKIT_IDS.CF.ORIGEM,
  MOSKIT_IDS.CF.CAPTACAO,
  MOSKIT_IDS.CF.AREA_DIREITO,
]);

const CF_NOMES = {
  [MOSKIT_IDS.CF.ORIGEM]: 'Origem',
  [MOSKIT_IDS.CF.CAPTACAO]: 'Captação',
  [MOSKIT_IDS.CF.AREA_DIREITO]: 'Área do Direito',
  [MOSKIT_IDS.CF.RESPONSAVEL]: 'Responsável pelo processo',
  [MOSKIT_IDS.CF.TIPO_CONSULTA]: 'Tipo de Consulta',
};

function nomeCampo(id) {
  return CF_NOMES[id] || id;
}

function parseJsonSeguro(texto, padrao) {
  try {
    const v = JSON.parse(texto);
    return v ?? padrao;
  } catch {
    return padrao;
  }
}

function opcoesIguais(a, b) {
  const na = (Array.isArray(a) ? a : []).map(String).sort();
  const nb = (Array.isArray(b) ? b : []).map(String).sort();
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

function lerRegistroCampos(chatId) {
  if (!chatId) return null;
  const row = db.prepare('SELECT custom_fields_bot, campos_travados FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row) return null;
  return {
    escritos: parseJsonSeguro(row.custom_fields_bot, null) || {},
    temRegistro: !!row.custom_fields_bot,
    travados: new Set(parseJsonSeguro(row.campos_travados, null) || []),
  };
}

function gravarRegistroCampos(chatId, escritos, travados) {
  if (!chatId) return;
  db.prepare('UPDATE conversations SET custom_fields_bot = ?, campos_travados = ? WHERE chat_id = ?')
    .run(JSON.stringify(escritos), JSON.stringify([...travados]), chatId);
}

// Decide campo por campo se o bot pode escrever, comparando o que esta no CRM com o ultimo valor que
// o PROPRIO bot escreveu (custom_fields_bot):
//   - campo vazio no CRM              => escreve (nao ha nada de ninguem para preservar)
//   - remoto == ultimo valor do bot   => escreve (o valor de la e dele mesmo)
//   - remoto != ultimo valor do bot   => TRAVA para sempre (alguem corrigiu na mao) e nao escreve
//   - sem registro (linha antiga)     => nao escreve nesta rodada e adota o remoto como referencia;
//                                        do proximo ciclo em diante a comparacao acima ja vale
// Sem chatId (backfills, scripts) nao ha onde guardar autoria: segue o comportamento antigo.
function filtrarCamposPorAutoria(chatId, dealRemoto, camposDoBot, opcoes = {}) {
  const registro = lerRegistroCampos(chatId);
  if (!registro) return { campos: camposDoBot, travasNovas: [], baseline: [], registro: null };

  const remotos = new Map(
    (dealRemoto?.entityCustomFields || [])
      .filter((c) => c?.id)
      .map((c) => [c.id, (c.options || []).map(Number)])
  );

  const campos = [];
  const travasNovas = [];
  const baseline = [];

  for (const campo of camposDoBot) {
    if (!CF_TRAVAVEIS.has(campo.id)) { campos.push(campo); continue; }

    if (registro.travados.has(campo.id)) {
      console.log(`  🔒 ${nomeCampo(campo.id)}: travado por correcao manual — bot nao escreve`);
      continue;
    }

    const remoto = remotos.get(campo.id);
    if (!remoto || !remoto.length) { campos.push(campo); continue; }

    const registrado = registro.escritos[campo.id];
    if (registrado === undefined) {
      // `forcarAutoria` e o escape hatch da reconciliacao manual (?incluir-legado=1): assume que o valor
      // de la e do bot e escreve a decisao atual. Fora dele, o CRM ganha.
      if (opcoes.forcarAutoria) {
        console.log(`  🔁 ${nomeCampo(campo.id)}: sem registro de autoria, mas forcarAutoria ligado — sobrescrevendo o valor do CRM (${remoto.join(',')})`);
        campos.push(campo);
        continue;
      }
      baseline.push({ id: campo.id, options: remoto });
      console.log(`  🧷 ${nomeCampo(campo.id)}: sem registro de autoria — preservando o valor que esta no CRM (${remoto.join(',')}) nesta rodada`);
      continue;
    }

    if (!opcoesIguais(registrado, remoto)) {
      travasNovas.push(campo.id);
      console.log(`  🔒 ${nomeCampo(campo.id)}: valor no CRM (${remoto.join(',')}) diferente do que o bot escreveu (${[].concat(registrado).join(',')}) — alguem corrigiu na mao, travando para sempre`);
      continue;
    }

    campos.push(campo);
  }

  return { campos, travasNovas, baseline, registro };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function extrairTelefone(from) {
  return from.replace(/@[a-z0-9.-]+$/, '');
}

const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado'];

// Data (YYYY-MM-DD) e dia da semana no fuso do escritorio — o Date do Node guarda UTC, e uma
// mensagem enviada as 21h em Fortaleza cai no dia seguinte em UTC.
function diaLocal(d) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ_ESCRITORIO });
}
function diaSemanaLocal(d) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ_ESCRITORIO, weekday: 'short' }).format(d);
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes);
  return DIAS_SEMANA[idx >= 0 ? idx : d.getDay()];
}

// A data-ancora em texto do escritorio, NUNCA em ISO. Medido em producao (13/08/2026): entregar a
// ancora como "2026-08-10T18:54:58.000Z" fazia o modelo COPIAR essa string quando nao conseguia
// derivar o horario da conversa — e o valor copiado e uma data valida, entao passava por qualquer
// checagem de parse. Deu 5 casos em 32 conversas com horario, 3 deles com reuniao real na agenda
// (deals 48370184, 48407621, 48177138 — ver o comentario em src/evidencia.js).
//
// Duas defesas em uma: o formato aqui nao se parece com o que o modelo tem que devolver (se ele
// copiar, o valor nem chega a lugar nenhum — motivoHorarioImplausivel rejeita de saida por formato),
// e a hora fica na do escritorio, igual a todo o resto do pipeline, em vez de UTC.
function descreverAncora(isoAncora) {
  const d = new Date(isoAncora);
  if (isNaN(d.getTime())) return '(desconhecida — nao resolva dias relativos)';
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_ESCRITORIO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  const [ano, mes, dia] = diaLocal(d).split('-');
  return `${dia}/${mes}/${ano} (${diaSemanaLocal(d)}), ${hora} — hora do escritorio`;
}

// Lista os proximos 14 dias com o nome do dia da semana, pra que o modelo so precise CONSULTAR a
// tabela em vez de calcular "que dia cai a proxima quarta" — a conta que ele erra (ver a regra
// ATENCAO AO DIA DA SEMANA no PROMPT_EXTRAIR).
function montarReferenciaDeDatas(isoAncora) {
  const base = new Date(isoAncora);
  if (isNaN(base.getTime())) return '  (data-ancora invalida — nao resolva dias relativos)';
  const linhas = [];
  for (let i = 0; i <= 14; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    linhas.push(`  ${diaLocal(d)} = ${diaSemanaLocal(d)}${i === 0 ? '   <- DATA-ANCORA (dia da ultima mensagem)' : ''}`);
  }
  return linhas.join('\n');
}

// O modelo precisa distinguir o que foi combinado ontem do que foi combinado hoje — sem isso um
// acordo antigo e ja superado parece tao atual quanto a ultima mensagem. Cabecalho por dia em vez
// de timestamp por mensagem pra nao inflar o prompt em conversa de 100+ mensagens.
// Cada linha comeca com o indice da mensagem no array `messages`. E esse numero que o modelo cita em
// `observacoes.msg_idx`, e e por ele que o codigo confere o role de quem falou (ver src/evidencia.js).
// Efeito colateral util: um cliente que digite "Equipe do escritório: ..." dentro da propria mensagem
// aparece embaixo do indice DELE, sem indice proprio — nao ganha mais o mesmo peso visual.
// `inicio` e a JANELA DO ATENDIMENTO (conversations.atendimento_inicio_msg_idx): num segundo
// atendimento do mesmo telefone, o modelo nao pode ver o caso ANTIGO — era assim que a area e o
// assunto do caso encerrado classificavam o caso novo. O indice impresso continua ABSOLUTO no array
// de mensagens: e ele que o modelo cita em observacoes.msg_idx e que src/evidencia.js confere contra
// `mensagens[msg_idx]`, que segue sendo o array inteiro.
function montarHistorico(mensagens, { inicio = 0 } = {}) {
  const linhas = [];
  let diaAnterior = null;
  const primeira = Number.isFinite(inicio) && inicio > 0 ? inicio : 0;
  for (let i = primeira; i < mensagens.length; i++) {
    const m = mensagens[i];
    const label = m.role === 'equipe' ? 'Equipe do escritório' : m.role === 'sistema' ? 'Sistema' : 'Cliente';
    const d = m.timestamp ? new Date(m.timestamp) : null;
    if (d && !isNaN(d.getTime())) {
      const dia = diaLocal(d);
      if (dia !== diaAnterior) {
        linhas.push(`--- ${dia} (${diaSemanaLocal(d)}) ---`);
        diaAnterior = dia;
      }
    }
    linhas.push(`[${i}] ${label}: ${m.text}`);
  }
  return linhas.join('\n');
}

// assunto entra aqui pra que um deal criado sem tema no nome seja cobrado nos ciclos seguintes
// (camposPendentes -> acao "atualizar_campos" -> PUT -> deal renomeado). Sem isso a IA escolhe
// "nota", que nao faz PUT, e o nome fica congelado sem o tema pra sempre.
const CAMPOS_OBRIGATORIOS = ['assunto', 'origem', 'tipo_consulta', 'area_direito', 'advogado_responsavel'];

function camposPendentes(dados) {
  if (!dados) return CAMPOS_OBRIGATORIOS;
  return CAMPOS_OBRIGATORIOS.filter((k) => {
    if (!dados[k] || dados[k] === 'null') return true;
    // ASSUNTO = ASSUNTO_NEUTRO conta como PENDENTE, e nao como preenchido. Sem esta linha o
    // comentario acima descrevia uma intencao que o codigo contradizia: "Consulta juridica" e o
    // PLACEHOLDER honesto que o prompt manda usar quando ninguem descreveu o caso, nao um assunto.
    // Contá-lo como preenchido fechava o ciclo para sempre — assunto nunca voltava a "pendentes", o
    // prompt informava "nenhum campo pendente", o modelo escolhia a acao `nota`, `nota` nao faz PUT,
    // e o nome do deal ficava CONGELADO no placeholder mesmo depois de o last_data ja ter o tema real.
    //
    // MEDIDO no corpus em 02/09/2026: deal 48407608 chamado so "Rayra Pureza" com
    // last_data.assunto = "Abatimento do FIES"; mesmo padrao em 48287898 ("Adocao") e 48206720
    // ("Rescisao de contrato"). O dado existia e nunca subia para o titulo.
    //
    // Consequencia deliberada: essas conversas passam de `nota` para `atualizar_campos`, ou seja
    // voltam a fazer PUT. Isso e seguro porque atualizarNegocioMoskit respeita renomeacao humana por
    // autoria (CHAVE_AUTORIA_NOME) — deal renomeado a mao NAO e reescrito. Ha regressao provando
    // exatamente isso em test-pipeline.js; se ela cair, esta linha volta atras.
    return k === 'assunto' && ehAssuntoNeutro(dados[k]);
  });
}

// Detecta a pergunta padrao da EQUIPE ("como voce conheceu o escritorio?", geralmente com lista
// numerada de opcoes) seguida da resposta do CLIENTE — o sinal mais confiavel que existe, e o unico
// GAP REAL medido no modelo (nao bug de merge): deal 48317782, a equipe perguntou "Voce pode nos
// contar como conheceu o nosso escritorio? 1.Indicacao 2.Artigo 3.Instagram 4.Youtube" e o cliente
// respondeu "verifiquei no instagram" — o modelo nao usou essa resposta. A regra 2 do prompt ja pede
// isso em linguagem natural desde entao; esta funcao torna o mesmo sinal deterministico, sem
// depender do modelo lembrar a cada rodada. So a PRIMEIRA resposta do cliente apos a pergunta conta
// (a equipe pode perguntar de novo depois, numa conversa longa, mas a resposta imediata e o vinculo
// causal real).
function detectarRespostaPerguntaOrigem(mensagens) {
  const lista = mensagens || [];
  for (let i = 0; i < lista.length; i++) {
    if (lista[i].role !== 'equipe') continue;
    const pergunta = removerAcentos(lista[i].text || '').toLowerCase();
    if (!/como\s+(voce\s+)?conheceu|como\s+(voce\s+)?chegou\s+(ate\s+)?(a\s+)?(gente|nos|escritorio)/.test(pergunta)) continue;
    // Ate 5 mensagens de TEXTO do cliente (nunca placeholder de anexo — "📎 [cliente enviou...]" nao
    // e resposta nenhuma) apos a pergunta: MEDIDO no deal 48317782 que a resposta de fato so vem
    // depois de o cliente mandar 4 anexos e responder a OUTRA pergunta pendente ("Essa e a proposta
    // de distrato da empresa" / "Um dos socios do escritorio foi meu professor" / "Berto Igor" ×2) —
    // parar na primeira mensagem de texto (sem pular anexo) ou nao ter janela nenhuma perderia esse
    // sinal real. Nao quebra mais na primeira que nao bate: continua ate achar ou esgotar a janela.
    let vistas = 0;
    for (let j = i + 1; j < lista.length && vistas < 5; j++) {
      if (lista[j].role !== 'cliente') continue;
      const textoOriginal = lista[j].text || '';
      if (/^📎\s*\[cliente enviou/.test(textoOriginal)) continue;
      vistas++;
      const resposta = removerAcentos(textoOriginal).toLowerCase();
      if (/instagram|\binsta\b/.test(resposta)) return { origem: 'Instagram', trecho: textoOriginal };
      if (/jusbrasil/.test(resposta)) return { origem: 'JusBrasil', trecho: textoOriginal };
      if (/you\s?tube/.test(resposta)) return { origem: 'Youtube', trecho: textoOriginal };
      if (/\bartigo\b/.test(resposta)) return { origem: 'Artigo', trecho: textoOriginal };
      if (/\bsite\b/.test(resposta)) return { origem: 'Site', trecho: textoOriginal };
      if (/indica[cç][aã]o/.test(resposta)) return { origem: 'Indicacao de/ou amigos e parentes', trecho: textoOriginal };
    }
  }
  return null;
}

// Reconhece cancais de entrada explicitos no texto da conversa e forca a origem (e, no caso do
// socio, a captacao) — deterministico, sem depender do modelo lembrar disso a cada rodada. Muta e
// devolve `dados` (mesmo contrato das outras sanitizacoes do pipeline).
//
// Texto SEM ACENTO (removerAcentos): MEDIDO em 21/08/2026 no deal 48206716 ("vi a página do Advogado
// Bruno Rocha") — a regex "pagina" sem acento nunca batia contra "página" com acento no texto real,
// entao esta regra nunca acionava pra essa grafia, que e a mais comum em portugues. "site do
// escritorio" e outro sinal claro que o modelo tambem deixava passar (deals 48412103/48359253).
//
// Vocabulario ampliado em 02/09/2026 a partir do que recuperar-origem-perdida.js ja media so em
// auditoria (SO-LEITURA, pra conferencia humana) — aqui o padrao PRECISA ser confiavel o bastante
// pra forcar o campo sem revisao, entao alguns sinais daquele script foram deixados de fora ou
// reescritos com mais contexto:
// - "amigo"/"parente" SOZINHOS ficaram de fora: sao comuns em conversa juridica sem ser sobre
//   ORIGEM ("meu parente teve um problema parecido"). So conta indicacao com verbo/substantivo de
//   indicacao explicito.
// - "artigo"/"materia"/"noticia" SOZINHOS tambem ficaram de fora: em conversa juridica "artigo" e
//   most-likely "artigo da lei" ("artigo 927 do codigo civil"), nao "vi um artigo no blog". So conta
//   com verbo de consumo de midia (vi/li) na frente.
// - "Video (Youtube/Instagram/TikTok)" do script de auditoria era ambiguo de proposito (pra
//   conferencia humana escolher) — aqui nao entra, porque um padrao deterministico tem que apontar
//   pra UM valor canonico, nunca adivinhar entre tres.
// - "google" isolado ficou de fora (armadilha ja medida: todo convite de Google Meet/Calendar
//   injeta "google" no texto — deal 48219774). So conta com verbo de busca explicito.
function aplicarPadroesDeterministicosDeOrigem(dados, mensagens) {
  // So o texto do CLIENTE: e ele quem informa como chegou ate o escritorio. Sem esta restricao, a
  // PROPRIA pergunta da equipe ("...1.Indicacao 2.Artigo 3.Instagram 4.Youtube") bateria no padrao
  // generico de Instagram/Artigo/Youtube antes mesmo do cliente responder qualquer coisa —
  // detectarRespostaPerguntaOrigem ja cobre esse caso separadamente, olhando os roles.
  const textoCompleto = removerAcentos((mensagens || []).filter((m) => m.role === 'cliente').map((m) => m.text).join(' ')).toLowerCase();
  const PADROES_SOCIO = [
    { regex: /pagina\s+do\s+(bruno|dr\.?\s*bruno|advogado\s+bruno)/i, socio: 'Bruno' },
    { regex: /pagina\s+do\s+(berto|dr\.?\s*berto|caballero)/i, socio: 'Berto' },
    { regex: /pagina\s+do\s+(iury|dr\.?\s*iury)/i, socio: 'Iury' },
    { regex: /instagram\s+do\s+(bruno|dr\.?\s*bruno)/i, socio: 'Bruno' },
    { regex: /instagram\s+do\s+(berto|dr\.?\s*berto|caballero)/i, socio: 'Berto' },
    { regex: /instagram\s+do\s+(iury|dr\.?\s*iury)/i, socio: 'Iury' },
  ];
  for (const padrao of PADROES_SOCIO) {
    if (padrao.regex.test(textoCompleto)) {
      if (dados.origem !== 'Instagram') console.log(`  ℹ️ pagina/Instagram de ${padrao.socio} detectada — origem forçada para Instagram`);
      dados.origem = 'Instagram';
      dados.captacao = padrao.socio;
      return dados;
    }
  }

  // Pergunta da equipe + resposta do cliente: sinal mais confiavel que existe, checado antes dos
  // padroes genericos abaixo (mais especifico primeiro).
  const porPergunta = detectarRespostaPerguntaOrigem(mensagens);
  if (porPergunta) {
    if (dados.origem !== porPergunta.origem) console.log(`  ℹ️ equipe perguntou a origem e cliente respondeu ("${porPergunta.trecho}") — origem forçada para ${porPergunta.origem}`);
    dados.origem = porPergunta.origem;
    return dados;
  }

  const PADROES_GENERICOS = [
    { regex: /\bsite\s+(do\s+escritorio|de\s+voces)\b/, origem: 'Site' },
    { regex: /\bjusbrasil\b/, origem: 'JusBrasil' },
    { regex: /\byou\s?tube\b/, origem: 'Youtube' },
    { regex: /\binstagram\b|\binsta\b|link\s+(da|na)\s+bio/, origem: 'Instagram' },
    { regex: /\b(vi|li)\s+(um\s+)?artigo\b/, origem: 'Artigo' },
    { regex: /\b(vi|li)\s+(uma\s+)?mat[eé]ria\b/, origem: 'Artigo' },
    { regex: /\b(vi|li)\s+(uma\s+)?not[ií]cia\b/, origem: 'Artigo' },
    { regex: /achei\s*(no|pelo)\s*google|pesquisei\s*(no|na)?\s*google/, origem: 'Site' },
    { regex: /indica[cç][aã]o\s+de\s+(um\s+)?(amigo|parente)|(amigo|parente)\s+(me\s+)?indicou|indicad[oa]\s+por\s+(um\s+)?(amigo|parente)/, origem: 'Indicacao de/ou amigos e parentes' },
    { regex: /j[aá]\s+(sou|fui|foi)\s+cliente|outro\s+caso\s+(com|no)\s+(escrit[oó]rio|voces)/, origem: 'Indicacao de clientes' },
    { regex: /an[uú]ncio|trafego\s+pago|facebook\s+ads|impulsionad/, origem: 'VSL - Trafego pago' },
    { regex: /landing\s+page/, origem: 'Landing Page' },
  ];
  for (const padrao of PADROES_GENERICOS) {
    if (padrao.regex.test(textoCompleto)) {
      if (dados.origem !== padrao.origem) console.log(`  ℹ️ padrao "${padrao.regex}" detectado — origem forçada para ${padrao.origem}`);
      dados.origem = padrao.origem;
      return dados;
    }
  }
  return dados;
}

// GATE DO CASO DESCRITO. Area do direito, advogado responsavel e assunto so entram no CRM se alguem
// tiver CONTADO o caso nesta conversa — observacao validada contra a mensagem real (cliente ou equipe,
// ver src/evidencia.js). Sem isso o modelo deduzia a area do SOCIO que o lead mencionou: "gostaria de
// agendar uma consulta com o Dr. Berto" virava area=LGPD e assunto="Direito Digital", porque LGPD e o
// primeiro item do perfil do Berto no prompt. Foi assim que uma cliente de Direito Administrativo
// (remocao por motivo de saude) entrou no CRM como LGPD, com briefing errado, e precisou de correcao
// manual no deal 48423360.
//
// Zera para null, nunca para um valor de fachada: mergeDados so sobrescreve com valor nao-nulo, entao
// uma area boa de um ciclo anterior sobrevive a uma rodada em que a evidencia nao aparecer.
// Muta `dados` (mesmo contrato das outras sanitizacoes do pipeline) e devolve o veredito.
//
// `_casoDescritoValidado`: marcador interno (nunca vai pro Moskit — montarPayloadMoskit so le campos
// nomeados) que persiste em last_data uma vez que o gate passou com evidencia real. Sem ele, chamar
// esta funcao de novo sobre o objeto MESCLADO (mesclarParaCrm), usando so a evidencia DESTA rodada,
// apagava de volta uma area/advogado legitimos herdados de uma rodada anterior toda vez que a
// conversa seguinte nao reemitisse cliente_descreveu_caso/equipe_descreveu_caso (ex: uma rodada so
// sobre reagendamento) — revertendo ate o NOME do deal em atualizarNegocioMoskit, a mesma classe de
// corrupcao (deal 48423360) que este gate existe pra evitar. O marcador so nasce quando a evidencia
// realmente apareceu; um palpite antigo gravado em last_data ANTES de o gate existir nunca o carrega
// e continua sendo limpo normalmente (ver teste "mesclarParaCrm: o palpite antigo nao volta").
function aplicarGateCasoDescrito(dados, obsValidas) {
  const casoDescritoAgora = !!(ultimaObservacao(obsValidas, 'cliente_descreveu_caso')
    || ultimaObservacao(obsValidas, 'equipe_descreveu_caso'));
  const casoDescrito = casoDescritoAgora || dados?._casoDescritoValidado === true;
  if (casoDescrito) {
    if (dados) dados._casoDescritoValidado = true;
    return { casoDescrito };
  }
  if (!dados) return { casoDescrito };

  if (dados.area_direito || dados.advogado_responsavel) {
    console.log(`  🚫 area/advogado descartados — ninguem descreveu o caso nesta conversa (area="${dados.area_direito}", advogado="${dados.advogado_responsavel}")`);
  }
  dados.area_direito = null;
  dados.advogado_responsavel = null;
  // "Consulta juridica" e o placeholder que o proprio prompt manda usar enquanto o caso esta vago —
  // esse passa. Qualquer outro assunto sem caso descrito e palpite (tipicamente o nome da area) e nao
  // pode virar titulo de negocio no CRM.
  if (dados.assunto && !ehAssuntoNeutro(dados.assunto)) {
    console.log(`  🚫 assunto descartado (sem caso descrito): "${dados.assunto}"`);
    dados.assunto = null;
  }
  return { casoDescrito };
}

// Lead que ainda nao contou o caso nao vira contato nem deal no CRM (decisao do escritorio,
// 12/08/2026): melhor nenhum registro do que um registro com area/assunto adivinhados, que a equipe
// so descobre errado depois.
//
// Duas excecoes, porque a partir dai o custo de nao ter deal deixa de ser cadastral: com dupla
// confirmacao de horario o evento na agenda, o Meet e o contrato do ZapSign dependem de existir dealId
// (finalizarCiclo so roda nos ramos que escrevem), e com o bloco de condicoes enviado a consulta ja
// foi cobrada. Nesses casos o deal nasce mesmo assim — com area/advogado vazios para a equipe
// preencher, nunca com palpite.
function deveEsperarCasoDescrito(acao, casoDescrito, apuracao, blocoEnviado) {
  return acao === 'criar' && !casoDescrito && !apuracao?.confirmado && !blocoEnviado;
}

// MESMA excecao de deveEsperarCasoDescrito (dupla confirmacao de horario / bloco de condicoes
// enviado), agora aplicada aos 5 CAMPOS_OBRIGATORIOS. criarNegocioMoskit nunca validou nada: campo
// vazio so e omitido do payload (buscarIdOpcao retorna null), e o deal nasce incompleto sem erro
// nenhum. Decisao do escritorio, 02/09/2026: bloquear a CRIACAO enquanto faltar qualquer um dos 5
// evita esse deal fantasma.
//
// `dadosMesclados` tem que vir do objeto MESCLADO com o historico (mesclarParaCrm), nunca da
// extracao crua desta rodada: um campo completo num ciclo anterior nao pode contar como pendente so
// porque a rodada atual nao voltou a mencionar tudo (ex: cliente so confirmando horario).
function deveEsperarCamposObrigatorios(dadosMesclados, apuracao, blocoEnviado) {
  return camposPendentes(dadosMesclados).length > 0 && !apuracao?.confirmado && !blocoEnviado;
}

// ACHADO em 03/09/2026, investigando por que deals do bot com assunto real capturado (ex: "Pericia de
// readaptacao") voltavam a mostrar o placeholder neutro dias depois, sem ninguem ter corrigido nada
// manualmente. Reproduzido de forma deterministica: rodada 1 captura o assunto real com evidencia;
// rodada 2 e so agendamento/confirmacao, sem caso novo — e o MODELO, seguindo a propria instrucao do
// prompt de usar "Consulta juridica" quando o caso esta vago, devolve o campo `assunto` PREENCHIDO com
// o placeholder em vez de omiti-lo. Como o placeholder e uma string nao-nula, o `if` abaixo o tratava
// como dado novo de verdade e sobrescrevia o assunto real — silenciosamente, sem log de "descartado"
// nenhum (esse log so existe em aplicarGateCasoDescrito, que roda DEPOIS do merge, sobre o objeto JA
// corrompido, e nao tem como saber que o valor neutro vinha de cima de um valor bom).
// `_casoDescritoValidado` protege area_direito/advogado_responsavel dessa mesma classe de regressao
// (ver aplicarGateCasoDescrito), mas nunca protegia assunto, porque o gate so nula um assunto quando
// ele NAO e o placeholder — o placeholder sempre "passava", inclusive por cima de um valor bom.
// Fix: o placeholder do modelo so conta como novidade quando ainda NAO existe um assunto real
// herdado. Testes: "mesclarParaCrm: placeholder nao apaga assunto real herdado" (test-pipeline.js).
function mergeDados(anteriores, novos) {
  const merged = { ...(anteriores || {}) };
  for (const key of Object.keys(novos || {})) {
    let valor = novos[key];
    if (valor === null || valor === undefined || valor === 'null') continue;
    if (key === 'assunto' && ehAssuntoNeutro(valor) && merged.assunto && !ehAssuntoNeutro(merged.assunto)) {
      continue;
    }
    merged[key] = valor;
  }
  return merged;
}

// O ADVOGADO E CONSEQUENCIA DA AREA, nunca uma escolha independente (MOSKIT_IDS.AREA_PARA_ADVOGADO).
// Antes disto o responsavel era o que o modelo dissesse: area de Familia podia sair com responsavel
// Berto e nada no codigo reclamava. Aqui a area manda, e a sugestao do modelo e so um palpite que pode
// ser descartado.
//
// Area sem dono ("Outros") ou nome de area que nao esta na tabela => responsavel VAZIO, para a equipe
// decidir. `captacao` nao e tocada: e quem trouxe o lead, nao quem cuida do caso.
function derivarAdvogadoDaArea(dados) {
  if (!dados) return;

  if (!dados.area_direito) {
    if (dados.advogado_responsavel) {
      console.log(`  🚫 advogado "${dados.advogado_responsavel}" descartado — sem area do direito definida, o responsavel nao pode ser derivado`);
      dados.advogado_responsavel = null;
    }
    return;
  }

  // Pelo ID da opcao, nao pelo nome: apelido de area ("Direito Medico", "familia") chega resolvido e a
  // tabela do responsavel nunca discorda da tabela de areas sobre como uma area se chama.
  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  const dono = idArea ? (MOSKIT_IDS.ADVOGADO_POR_AREA_ID[idArea] || null) : null;
  if (!dono) {
    if (dados.advogado_responsavel) {
      console.log(`  🚫 advogado "${dados.advogado_responsavel}" descartado — a area "${dados.area_direito}" nao tem responsavel definido na tabela do escritorio`);
      dados.advogado_responsavel = null;
    }
    return;
  }

  if (dados.advogado_responsavel && removerAcentos(String(dados.advogado_responsavel).toLowerCase().trim()) !== dono.toLowerCase()) {
    console.log(`  ⚠️ advogado sugerido "${dados.advogado_responsavel}" ignorado — "${dados.area_direito}" e do ${dono}`);
  }
  dados.advogado_responsavel = dono;
}

// Assunto que e so o nome de uma area do direito nao e assunto: e o palpite de area vazando pro TITULO
// do negocio (foi assim que o deal do caso 48423360 nasceu "… - Direito Digital"). Vale mesmo quando o
// caso FOI descrito: nesse caso o modelo tinha material para resumir o tema e devolveu a area.
function rejeitarAssuntoQueEhArea(dados) {
  if (!dados?.assunto) return;
  // Pelo indice de busca: pega tanto "LGPD" quanto os apelidos ("Direito Digital", "familia").
  if (!buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.assunto)) return;
  console.log(`  🚫 assunto "${dados.assunto}" e nome de area, nao tema do caso — trocado por "${ASSUNTO_NEUTRO}"`);
  dados.assunto = ASSUNTO_NEUTRO;
}

// Tudo que o bot AFIRMA sobre o caso passa por aqui: evidencia do caso descrito, advogado derivado da
// area e assunto que nao pode ser nome de area. Idempotente de proposito — roda na extracao da rodada e
// DE NOVO no objeto mesclado que vai pro CRM (ver mesclarParaCrm).
function sanitizarClassificacao(dados, obsValidas) {
  const { casoDescrito } = aplicarGateCasoDescrito(dados, obsValidas);
  rejeitarAssuntoQueEhArea(dados);
  derivarAdvogadoDaArea(dados);
  return { casoDescrito };
}

// O gate limpava so a extracao da rodada, mas o que vai pro CRM (e o que volta pro last_data) e o
// objeto MESCLADO com os ciclos anteriores — e mergeDados ressuscitava o palpite antigo de area/assunto
// gravado antes destas travas existirem, reenviando-o para sempre. Mesclar e sanitizar tem que ser uma
// coisa so.
//
// Omitir um campo do payload nunca APAGA nada no CRM: mesclarCustomFields devolve o valor remoto para o
// corpo do PUT. Omitir significa "nao disputo este campo nesta rodada".
function mesclarParaCrm(dadosAnteriores, dados, obsValidas) {
  const mesclados = mergeDados(dadosAnteriores || {}, dados);
  sanitizarClassificacao(mesclados, obsValidas);
  // "Nao identificado" e a opcao SEMPRE que a conversa nao revelar canal nenhum (index.js, regra 2 do
  // prompt) — mas isso so pode ser forcado APOS o merge, nunca antes: forcar em `dados` (a extracao
  // crua desta rodada) apagaria uma origem real de uma rodada anterior, ja que mergeDados so preserva
  // o valor antigo quando o novo e null. Aqui, so entra em vigor quando NENHUMA rodada (esta ou
  // anterior) jamais capturou nada — os 3 deals que ficaram com o campo literalmente ausente no CRM
  // (48401150/48402576/48402595, 21/08/2026) sao exatamente o caso que isso fecha.
  if (!mesclados.origem) mesclados.origem = 'Nao identificado';
  return mesclados;
}

// ------------------------------------------------------------
// Moskit API
// ------------------------------------------------------------
async function buscarOuCriarContato(phone, name) {
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  const phoneClean = phoneDigits.slice(-13);

  // Ultima barreira antes de escrever no CRM. As camadas acima ja barram numero interno, mas se um
  // caminho novo chegar ate aqui, e melhor explodir do que criar contato de socio no Moskit.
  if (ehInterno(phoneDigits)) {
    throw new Error(`buscarOuCriarContato chamada para numero interno (${phoneClean}) — abortado`);
  }

  // 1) Espelho local primeiro. A tabela moskit_contacts ja e um dump do CRM (preenchida por
  //    /importar-moskit) e ate agora so alimentava o banner "Cliente NOVO/EXISTENTE". A busca na API
  //    abaixo le APENAS a primeira pagina de /contacts ordenada por id desc: contato antigo nunca
  //    aparecia ali, o codigo caia no POST e criava DUPLICATA — em toda rodada criar/nota/atualizar.
  //
  // MEDIDO em 03/09/2026, limpando a aba "Agendamento de Consulta": comparar o telefone INTEIRO
  // (slice(-13) na chave, `.includes()` na API) faz o MESMO numero salvo com e sem DDI nao casar —
  // `"8694751616".includes("558694751616")` e false, e as duas chaves de 13 digitos tambem diferem.
  // Todo lead que ja existia no Moskit Boost com o telefone em formato local virava contato novo +
  // deal duplicado. Achado no par da Jessica (558694751616 x 8694751616) e depois medido em toda a
  // aba: 46 dos 87 negocios abertos tinham outro negocio no mesmo telefone pelos ultimos 8 digitos,
  // contra 20 pela comparacao inteira. `mesmoTelefone` (src/telefone.js) ja era a comparacao correta
  // do projeto — o comentario dela diz "sobrevivem a diferencas de DDI/nono digito" — e e a mesma
  // regra que `ehInterno` usa pra decidir se um numero e da equipe. Duas respostas diferentes pra
  // "esses dois telefones sao a mesma pessoa?" dependendo do caminho de codigo e exatamente o que
  // src/moskit-ids.js existe pra evitar.
  if (phoneClean.length >= 8) {
    const espelho = stmtMoskitGet.get(phoneClean);
    if (espelho?.moskit_id) return espelho.moskit_id;

    // Sufixo: pega o mesmo cliente gravado sob outra grafia. AMBIGUIDADE NAO DECIDE — se dois
    // contatos DIFERENTES compartilham o sufixo, nao da pra saber qual e; cai pra busca na API em
    // vez de chutar (mesmo "candidato unico ou nada" de decidirDeal, em src/notas-reuniao.js).
    const sufixo = phoneClean.slice(-SUFIXO_COMPARACAO);
    const candidatos = stmtMoskitPorSufixo.all(sufixo).filter((c) => c.moskit_id);
    const ids = new Set(candidatos.map((c) => c.moskit_id));
    if (ids.size === 1) {
      const achado = candidatos[0];
      console.log(`  📇 contato ${achado.moskit_id} achado pelo sufixo do telefone (espelho tem "${achado.phone}", chegou "${phoneClean}") — evitando duplicata`);
      return achado.moskit_id;
    }
    if (ids.size > 1) {
      console.log(`  ⚠️ sufixo ...${sufixo} bate com ${ids.size} contatos diferentes no espelho — seguindo para a busca na API em vez de escolher um`);
    }
  }

  // 2) Fallback na API, agora paginando de verdade (mesmo mecanismo de importarContatosMoskit).
  //    Menos de 8 digitos nao identifica um telefone com seguranca — evita ".includes()" casando com
  //    qualquer numero que contenha a mesma sequencia.
  //
  // MEDIDO em 24/08/2026 (estudar-deals-duplicados.js --sondar-crm --so-bot): 14 contatos duplicados
  // de verdade na conta — mesmo telefone, dois `contacts.id` diferentes, cada um com seu proprio
  // deal (o deal em si nasceu certo; o contato por baixo dele e que era o segundo). A maioria
  // concentrada em 10/08/2026, dia em que o auto-deploy foi testado com varios `pm2 restart` em
  // sequencia — exatamente o cenario que faz o Moskit devolver 429 sob rajada de reprocessamento.
  // A causa: `break` silencioso em qualquer status fora de 200-299 (nao passa pelo catch — o
  // `validateStatus: s<500` faz o axios devolver o 429 como resposta normal, nao excecao) OU
  // qualquer excecao de rede no catch abaixo terminavam a busca e CAIAM NO POST /contacts,
  // exatamente como se o contato genuinamente nao existisse. Rede instavel != contato novo — mesmo
  // raciocinio de garantirDealExiste (index.js) sobre nao tratar erro como "nao existe". Agora um
  // status fora de 200-299 ou uma excecao INTERROMPEM com erro (a fila retenta depois) em vez de
  // duplicar o contato; so a paginacao chegar ao fim de verdade (ultima pagina, sem pageToken) e que
  // autoriza concluir "nao existe, pode criar".
  if (phoneDigits.length >= 8) {
    let pageToken = null;
    let chegouAoFim = false;
    for (let pagina = 0; pagina < MAX_PAGINAS_BUSCA_CONTATO; pagina++) {
      let listRes;
      try {
        listRes = await axios.get(`${MOSKIT_BASE}/contacts`, {
          params: { limit: 100, sort: 'id', order: 'desc', ...(pageToken ? { pageToken } : { page: 1 }) },
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
          timeout: TIMEOUT_HTTP_MS,
        });
      } catch (e) {
        throw new Error(`busca de contato por telefone falhou (${e.message}) — nao seguro pra concluir que o contato nao existe`);
      }
      if (listRes.status < 200 || listRes.status >= 300) {
        throw new Error(`busca de contato por telefone respondeu HTTP ${listRes.status} — nao seguro pra concluir que o contato nao existe`);
      }

      const contatos = Array.isArray(listRes.data) ? listRes.data : [];
      // `mesmoTelefone` no lugar do `.includes(phoneDigits)` antigo: o includes so casava quando o
      // numero SALVO era igual ou mais longo que o buscado, entao contato do Moskit Boost gravado
      // sem DDI ("8694751616") nunca casava com o numero que chega do WhatsApp ("558694751616") —
      // ver o comentario do espelho local acima, com a medicao de 03/09/2026.
      const found = contatos.find((c) => (c.phones || [])
        .some((p) => mesmoTelefone(p.number, phoneDigits)));
      if (found) {
        // Alimenta o espelho pra que a proxima rodada nem precise da rede.
        stmtMoskitUpsert.run(phoneClean, found.id, found.name || '', JSON.stringify(found));
        return found.id;
      }

      pageToken = listRes.headers?.['x-moskit-listing-next-page-token']
        || listRes.headers?.['x-ollow-listing-next-page-token'];
      if (!pageToken || contatos.length === 0) { chegouAoFim = true; break; }
    }
    if (!chegouAoFim) {
      // Teto de MAX_PAGINAS_BUSCA_CONTATO atingido sem achar nem chegar ao fim real da lista — nao
      // sabemos se existe ou nao, e criar as ciegas e exatamente o bug que isto corrige.
      throw new Error(`busca de contato por telefone nao terminou em ${MAX_PAGINAS_BUSCA_CONTATO} paginas — nao seguro pra concluir que o contato nao existe`);
    }
  }

  const createRes = await axios.post(
    `${MOSKIT_BASE}/contacts`,
    {
      name: `*${name || 'Cliente sem nome'}`,
      createdBy: { id: LAYLA_USER_ID },
      responsible: { id: LAYLA_USER_ID },
      phones: [{ number: phone }],
    },
    { headers: apiHeaders, validateStatus: (s) => s < 500, timeout: TIMEOUT_HTTP_MS }
  );

  // validateStatus aceita 4xx: sem conferir o status, um 400/409 devolvia `undefined` como contactId
  // e seguia para o payload do deal com `contacts: [{ id: undefined }]`.
  if (createRes.status < 200 || createRes.status >= 300 || !createRes.data?.id) {
    throw new Error(`POST /contacts falhou (${createRes.status}): ${JSON.stringify(createRes.data)?.slice(0, 200)}`);
  }

  // Espelho atualizado na criacao — sem isso o proximo ciclo nao acha o contato recem-criado (ele
  // esta na primeira pagina hoje, mas sai dela assim que outros contatos forem criados) e duplica.
  if (phoneClean.length >= 8) {
    stmtMoskitUpsert.run(phoneClean, createRes.data.id, name || '', JSON.stringify(createRes.data));
  }

  return createRes.data.id;
}

// MEDIDO em 24/08/2026 (estudar-deals-duplicados.js --sondar-crm): `params:{page:1}` e ignorado em
// silencio pela API (mesmo quirk de /activities e /deals — so `?start=` pagina de verdade), e sem
// `limit` a resposta e sempre os ~10 deals mais recentes de TODA a conta — nao do contato. Um
// contato com deal de dias atras ja sai dessa janela. Corrigido: pagina de verdade por `?start=` e
// usa `contacts[]` que a PROPRIA listagem devolve (confirmado empiricamente — nao precisa mais de um
// GET por deal, o N+1 que existia aqui). Bounded por MAX_PAGINAS_BUSCA_DEAL (mesmo espirito de
// MAX_PAGINAS_BUSCA_CONTATO): paginar a conta inteira (3000+ deals) e impraticavel num ciclo de
// processamento, mas os deals mais RECENTES sao onde o cenario real do bug vive (deal criado ha
// poucos dias, buscado de novo num reprocessamento). Erro de rede/status fora de 200-299 LANCA em vez
// de devolver null — mesmo raciocinio de buscarOuCriarContato: rede instavel nao e prova de que o
// deal nao existe, e concluir isso as ciegas e o que criava a duplicata.
async function buscarDealPorContato(contactId) {
  let start = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS_BUSCA_DEAL; pagina++) {
    let listRes;
    try {
      listRes = await axios.get(`${MOSKIT_BASE}/deals`, {
        params: { start, sort: 'id', order: 'desc' },
        headers: apiHeaders,
        validateStatus: (s) => s < 500,
      });
    } catch (e) {
      throw new Error(`busca de deal por contato falhou (${e.message}) — nao seguro pra concluir que o deal nao existe`);
    }
    if (listRes.status < 200 || listRes.status >= 300) {
      throw new Error(`busca de deal por contato respondeu HTTP ${listRes.status} — nao seguro pra concluir que o deal nao existe`);
    }
    const deals = Array.isArray(listRes.data) ? listRes.data : [];
    const found = deals.find((d) => (d.contacts || []).some((c) => String(c.id) === String(contactId)));
    if (found) return found.id;
    if (deals.length < 10) return null; // pagina incompleta = fim de verdade da lista
    start += deals.length;
  }
  // Teto de paginas atingido sem achar: dentro da janela recente coberta, nao ha deal deste contato —
  // diferente da falha de rede acima, aqui a busca terminou de verdade (so nao viu a conta inteira).
  return null;
}

function montarPayloadMoskit(dadosBrutos, contactId, opcoes = {}) {
  // Ultimo ponto de estrangulamento antes de qualquer escrita no CRM (criar, atualizar, virada de
  // cobranca, backfill, reconciliacao): a area DEFINE o responsavel. Sem isto, um caminho que nao passe
  // pelo pipeline — backfill lendo last_data antigo, por exemplo — ainda conseguiria gravar area de
  // Familia com responsavel Berto. Copia para nao mutar o objeto de quem chamou.
  const dados = { ...(dadosBrutos || {}) };
  derivarAdvogadoDaArea(dados);

  const customFields = [];

  // CHECKPOINT: o bloco de condicoes de valor e o unico fato que decide paga x cortesia.
  //   nunca enviado  => cortesia (price 0)
  //   enviado, quando for => paga (price 35000), inclusive retroativamente num deal ja criado
  // Nao ha mais a pre-condicao de "so concluir cortesia depois que a equipe confirmar o horario":
  // como o deal se corrige sozinho quando o bloco chega depois, concluir cortesia cedo nao custa nada.
  // condicoesValorEnviadas === undefined (mensagens indisponiveis) => cai em paga, padrao seguro.
  const tratarComoGratis = opcoes.condicoesValorEnviadas === false;
  const tipoConsultaFinal = tratarComoGratis ? 'consulta gratis' : dados.tipo_consulta;

  const idOrigem = buscarIdOpcao(MAPEAMENTO_ORIGEM, dados.origem);
  if (idOrigem) customFields.push({ id: MOSKIT_IDS.CF.ORIGEM, options: [idOrigem] });

  const idTipoConsulta = buscarIdOpcao(MAPEAMENTO_TIPO_CONSULTA, tipoConsultaFinal);
  if (idTipoConsulta) customFields.push({ id: CF_TIPO_CONSULTA, options: [idTipoConsulta] });

  const idCaptacao = buscarIdOpcao(MAPEAMENTO_CAPTACAO, dados.captacao);
  if (idCaptacao) customFields.push({ id: MOSKIT_IDS.CF.CAPTACAO, options: [idCaptacao] });

  const idArea = buscarIdOpcao(MAPEAMENTO_AREA_DIREITO, dados.area_direito);
  if (idArea) customFields.push({ id: MOSKIT_IDS.CF.AREA_DIREITO, options: [idArea] });

  const idResponsavel = buscarIdOpcao(MAPEAMENTO_RESPONSAVEL_PROCESSO, dados.advogado_responsavel);
  if (idResponsavel) customFields.push({ id: MOSKIT_IDS.CF.RESPONSAVEL, options: [idResponsavel] });

  const nomeLimpo = removerEmoji(dados.nome);
  const assuntoLimpo = removerEmoji(dados.assunto);
  const nomeDeal = assuntoLimpo ? `${nomeLimpo || 'Cliente sem nome'} - ${assuntoLimpo}` : (nomeLimpo || 'Cliente sem nome');
  if (!assuntoLimpo) console.log(`  ⚠️ assunto vazio — deal vai ficar so com o nome do cliente ("${nomeLimpo || 'Cliente sem nome'}")`);
  const payload = {
    name: nomeDeal,
    status: 'OPEN',
    stage: { id: Number(process.env.MOSKIT_STAGE_ID) },
    createdBy: { id: LAYLA_USER_ID },
    responsible: { id: LAYLA_USER_ID },
    contacts: [{ id: contactId }],
    entityCustomFields: customFields,
    // Mesma constante que a verificacao do comprovante usa. Com o literal 35000 aqui, mudar o valor
    // no .env fazia o preco do negocio e a conferencia do pagamento discordarem em silencio.
    price: tratarComoGratis ? 0 : COMPROVANTE_VALOR_ESPERADO_CENTAVOS,
    dealProducts: [{ product: { id: PRODUTO_CONSULTA_PAGA_ID }, quantity: 1, price: 0, initialPrice: 0, finalPrice: 0 }],
  };

  return payload;
}

async function criarNegocioMoskit(dados, contactId, opcoes = {}) {
  const payload = montarPayloadMoskit(dados, contactId, opcoes);
  const response = await axios.post(`${MOSKIT_BASE}/deals`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  // Registra a autoria dos campos (e do nome) ja no nascimento do deal: e o que permite ao proximo ciclo
  // saber que o que esta no CRM foi escrito pelo bot, e nao corrigido por alguem da equipe.
  registrarAutoriaCampos(opcoes.chatId, payload.entityCustomFields, [], [], payload.name);
  return response.data;
}

// Chave reservada no mesmo registro de autoria para o NOME do deal (os outros ids sao sempre "CF_...",
// entao nao ha colisao possivel).
const CHAVE_AUTORIA_NOME = '__name';

function nomeEscritoPeloBot(chatId) {
  const registro = lerRegistroCampos(chatId);
  const nome = registro?.escritos?.[CHAVE_AUTORIA_NOME];
  return typeof nome === 'string' && nome.trim() ? nome.trim() : null;
}

// Guarda em custom_fields_bot o que o bot acabou de escrever. Preserva o que ja estava registrado para
// os campos que nao entraram nesta rodada (ex: campo travado, ou campo que a IA nao resolveu).
function registrarAutoriaCampos(chatId, camposEscritos, travasNovas = [], baseline = [], nomeEscrito = null) {
  if (!chatId) return;
  const registro = lerRegistroCampos(chatId);
  if (!registro) return;

  const escritos = { ...registro.escritos };
  for (const c of [...(camposEscritos || []), ...(baseline || [])]) {
    if (c?.id) escritos[c.id] = (c.options || []).map(Number);
  }
  if (nomeEscrito) escritos[CHAVE_AUTORIA_NOME] = String(nomeEscrito).trim();
  const travados = new Set([...registro.travados, ...travasNovas]);
  gravarRegistroCampos(chatId, escritos, travados);
}

async function atualizarNegocioMoskit(dealId, dados, contactId, opcoes = {}) {
  const payload = montarPayloadMoskit(dados, contactId, opcoes);
  // Tudo que o bot decidiu sobre este lead NESTA rodada, antes do merge com o que ja existia
  // remotamente (que so acontece no GET abaixo) — e exatamente o que confirmamos apos o PUT.
  // Reatribuido abaixo se algum campo sair do payload por autoria humana: confirmar um campo que o bot
  // deliberadamente NAO mandou faria a atualizacao falhar para sempre.
  let camposEsperados = payload.entityCustomFields;
  let travasNovas = [];
  let baselineCampos = [];

  // O PUT substitui o deal inteiro. Le o estado atual antes pra (1) nao apagar campo personalizado
  // que a equipe preencheu na mao e o bot nao resolveu nesta rodada, e (2) preservar marcacao manual
  // de "consulta gratis" — mas so ENQUANTO o bloco de condicoes nao tiver sido enviado.
  // Depois do bloco quem manda e o checkpoint: foi a propria equipe que anunciou o valor, entao a
  // consulta e paga e o deal tem que subir pra R$350 mesmo que alguem tenha marcado gratis na mao.
  const blocoEnviado = opcoes.condicoesValorEnviadas === true;
  try {
    const atualRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 200 && atualRes.status < 300) {
      // Nome do deal, pela mesma regra de autoria dos campos personalizados:
      //   - nome cru do bot (sem tema) ou nome que o BOT escreveu por ultimo => pode atualizar
      //   - qualquer outro nome => alguem da equipe renomeou, preserva para sempre
      // A trava antiga era "preserva tudo que nao seja o nome cru", e por isso um titulo que nasceu com
      // assunto errado ("Cliente - Direito Digital") ficava congelado mesmo depois de o bot descobrir o
      // tema real — outro caminho pelo qual a classificacao errada sobrevivia no CRM.
      const nomeRemoto = String(atualRes.data?.name || '').trim();
      const nomeCruDoBot = removerEmoji(dados.nome) || 'Cliente sem nome';
      const nomeDoBot = nomeEscritoPeloBot(opcoes.chatId);
      const escritoPeloBot = nomeRemoto === nomeCruDoBot || (!!nomeDoBot && nomeRemoto === nomeDoBot);
      if (nomeRemoto && !escritoPeloBot) {
        if (nomeRemoto !== payload.name) console.log(`  ⏭️ nome do deal ${dealId} preservado ("${nomeRemoto}") — renomeado fora do bot`);
        payload.name = atualRes.data.name;
      } else if (nomeRemoto && nomeRemoto !== payload.name) {
        console.log(`  ✏️ titulo do deal ${dealId} atualizado: "${nomeRemoto}" → "${payload.name}"`);
      }

      // Estagio: montarPayloadMoskit sempre monta o estagio INICIAL, e o PUT e full replace — sem
      // preservar aqui, toda atualizacao arrasta o deal de volta pro comeco do funil, desfazendo o
      // que moverParaEstagio/a equipe tinham avancado.
      const stageAtual = atualRes.data?.stage?.id;
      if (stageAtual) payload.stage = { id: stageAtual };

      // Atividades: reenviadas COMO VIERAM do GET. O PUT e full replace, e omitir `activities`
      // significa para o Moskit "desvincule estas atividades" — o que ele RECUSA quando alguma ja foi
      // concluida, derrubando o PUT inteiro com 422 `field: oldActivities`.
      //
      // MEDIDO em 19/08/2026 no deal 48441223: a consulta de 13/08 foi marcada como concluida na mao
      // (`doneDate` 17/08, `doneSource: MANUAL`) e, a partir dali, TODA atualizacao daquele negocio
      // passou a falhar — o chat 553799437737 queimou as 3 tentativas da fila e foi descartado sem
      // que ninguem soubesse. Experimento controlado (mesmo payload, so trocando a presenca deste
      // campo): 422 sem, 200 com.
      //
      // Nao e caso raro — consulta concluida e o caminho NORMAL de sucesso. Ou seja: todo negocio bem
      // atendido acabava impedido de receber qualquer atualizacao no CRM. `putDealComVerificacao`
      // nunca sofreu disso porque envia o corpo do GET inteiro; esta linha alinha os dois caminhos.
      if (Array.isArray(atualRes.data?.activities)) payload.activities = atualRes.data.activities;

      // Status/fechamento: montarPayloadMoskit sempre monta `status: 'OPEN'` e o PUT e full replace —
      // sem preservar aqui, qualquer atualizacao de campo REABRE um negocio ganho e apaga
      // closeDate/lostReason. Atinge justamente os negocios bem atendidos, e o caminho mais provavel
      // de acontecer e o cliente antigo que volta a escrever (ver src/cliente-retorno.js).
      // Fechar/reabrir e decisao exclusiva de fecharNegocioSeAplicavel, que por sua vez se recusa a
      // tocar em deal fora de OPEN: o caminho de campos nao pode fazer pelas costas o que a funcao de
      // fechamento se proibe de fazer.
      const statusAtual = atualRes.data?.status;
      if (statusAtual && statusAtual !== payload.status) {
        console.log(`  🔒 status do deal ${dealId} preservado ("${statusAtual}") — atualizacao de campos nao reabre negocio`);
        payload.status = statusAtual;
      }
      if (atualRes.data?.closeDate) payload.closeDate = atualRes.data.closeDate;
      if (atualRes.data?.lostReason) payload.lostReason = atualRes.data.lostReason;

      if (dealEhConsultaGratis(atualRes.data)) {
        const novoTipo = payload.entityCustomFields.find((c) => c.id === CF_TIPO_CONSULTA);
        if (novoTipo && !novoTipo.options.includes(TIPO_CONSULTA_GRATIS_ID)) {
          if (blocoEnviado) {
            console.log(`  💳 Deal ${dealId} estava marcado "consulta gratis", mas a equipe enviou o bloco de condicoes — reclassificando para PAGA`);
          } else {
            console.log(`  🆓 Deal ${dealId} ja marcado como "consulta gratis" no Moskit — preservando (nao rebaixa pra paga)`);
            novoTipo.options = [TIPO_CONSULTA_GRATIS_ID];
            payload.price = 0;
          }
        }
      }
      // Autoria: campo corrigido na mao pela equipe sai do payload. mesclarCustomFields (abaixo)
      // devolve o valor remoto pro corpo do PUT, entao a correcao humana continua la — o bot
      // simplesmente para de disputar aquele campo.
      const autoria = filtrarCamposPorAutoria(opcoes.chatId, atualRes.data, payload.entityCustomFields, {
        forcarAutoria: opcoes.forcarAutoria === true,
      });
      payload.entityCustomFields = autoria.campos;
      camposEsperados = autoria.campos;
      travasNovas = autoria.travasNovas;
      baselineCampos = autoria.baseline;

      payload.entityCustomFields = mesclarCustomFields(atualRes.data?.entityCustomFields, payload.entityCustomFields);
    }
  } catch (e) {
    console.error(`  ❌ Erro ao ler deal ${dealId} antes de atualizar (seguindo sem mesclar): ${e.message}`);
  }

  const response = await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, payload, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
    validateStatus: (s) => s >= 200 && s < 300,
  });

  // O Moskit pode aceitar o PUT (2xx) e so aplicar o valor de fato alguns segundos depois (mesmo
  // cache/lag de propagacao documentado em putDealComVerificacao, abaixo). Sem esta confirmacao o
  // bot cria a nota de "Campos preenchidos" achando que deu certo mesmo quando o campo nao pegou —
  // foi exatamente isso que exigiu correcao manual no deal 48423360 (LGPD ficou preso no CRM depois
  // do bot ja ter decidido corretamente "Direito Administrativo"). Se nao ha custom field resolvido
  // nesta rodada, pula a confirmacao: zero GETs extras, zero latencia no caso comum.
  if (camposEsperados.length > 0) {
    const { confirmado, deal } = await confirmarAposRetentativas(
      dealId,
      (d) => customFieldsPersistiram(camposEsperados, d?.entityCustomFields)
    );
    if (!confirmado) {
      throw new Error(
        `Moskit aceitou o PUT no deal ${dealId} (2xx) mas os campos personalizados nao se confirmaram ` +
        `apos retentativas (esperado: ${JSON.stringify(camposEsperados)}, lido: ${JSON.stringify(deal?.entityCustomFields)})`
      );
    }
  }

  // So depois do PUT confirmado: registrar autoria de um valor que nao entrou faria o bot achar,
  // no ciclo seguinte, que a divergencia foi correcao humana.
  registrarAutoriaCampos(opcoes.chatId, camposEsperados, travasNovas, baselineCampos, payload.name);
  for (const id of travasNovas) {
    await enviarTelegram(
      `🔒 *Campo travado por correção manual*\nDeal: https://app.ollow.com.br/?/deal/${dealId}\n"${nomeCampo(id)}" foi corrigido manualmente no CRM — o bot não vai mais sobrescrever este campo nesta negociação.`
    ).catch(() => {});
  }
  return response.data;
}

// Confirma que o deal ainda existe no Moskit antes de atualiza-lo — se foi apagado por fora do bot
// (ex: alguem da equipe removeu manualmente), recria com os dados mais recentes em vez de falhar
// pra sempre com 404 a cada nova tentativa (ver agendarProcessamento).
async function garantirDealExiste(dealId, dados, contactId, opcoes = {}) {
  if (!dealId) return null;
  try {
    const checkRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (checkRes.status !== 404) return dealId;
    console.log(`  ⚠️ Deal ${dealId} nao existe mais no Moskit — criando novo`);
  } catch (e) {
    // Timeout, erro de rede ou 5xx (validateStatus so aceita <500, entao qualquer coisa alem disso cai
    // aqui) NAO significa que o deal sumiu — so que nao deu pra confirmar. Tratar como 404 criava um
    // deal DUPLICADO no CRM na primeira instabilidade do Moskit, porque criarNegocioMoskit faz um POST
    // incondicional sem checar se o cliente ja tem negocio. Relanca para o chamador (processarConversaDirect)
    // cair na fila de retry (src/fila.js) em vez de seguir como se a ausencia tivesse sido confirmada.
    throw new Error(`Nao foi possivel confirmar se o deal ${dealId} ainda existe no Moskit (erro transitorio, nao 404 confirmado): ${e.message}`);
  }
  const deal = await criarNegocioMoskit(dados, contactId, opcoes);
  return deal.id;
}

// Roda na rodada em que o bloco de condicoes aparece pela primeira vez numa conversa que JA tem deal.
// O deal nasceu como cortesia (price 0) e agora precisa virar paga (R$350).
//
// Precisa ser chamada fora do switch de `acao` porque a virada nao depende do que a IA decidiu nesta
// rodada: os ramos "aguardar"/"ignorar"/"inviavel" retornam antes de qualquer escrita, e o ramo
// "nota" nunca chama atualizarNegocioMoskit (so garantirDealExiste, que faz PUT apenas se o deal
// sumiu). Sem isso, o bloco chegando num desses ciclos nao viraria nada no CRM.
async function aplicarViradaCobranca(chatId, row, dados, opcoesPayload, phone) {
  const dealId = row.deal_id;
  if (!dealId) return; // deal ainda nao existe — vai nascer ja como paga
  try {
    const contactId = await buscarOuCriarContato(phone, dados?.nome || row.contact_name);
    // `dados` aqui e o last_data cru de ciclos anteriores, e esta rodada nem chegou na extracao — nao
    // existe evidencia do caso para sustentar area/advogado/assunto. Sanitizar sem observacao nenhuma
    // deixa esses campos de fora do payload, e a virada faz so o que tem que fazer: corrigir o tipo de
    // consulta e o valor. Campo omitido nao apaga nada no CRM (mesclarCustomFields devolve o remoto).
    const dadosVirada = { ...(dados || {}) };
    sanitizarClassificacao(dadosVirada, []);
    await atualizarNegocioMoskit(dealId, dadosVirada, contactId, opcoesPayload);
    console.log(`  💳 Deal ${dealId} reclassificado para PAGA (price 35000) pelo checkpoint do bloco de condicoes`);

    // Se a consulta ja foi pro Google Agenda como cortesia, o evento NAO e cancelado — cancelar
    // reuniao de cliente real por inferencia e pior que o erro. Avisa pra alguem cobrar.
    if (row.evento_calendar_criado) {
      const quando = formatarHorarioEscritorio(row.evento_calendar_data) || 'horario nao registrado';
      await enviarTelegram(
        `⚠️ *Consulta agendada como cortesia virou PAGA*\n\n` +
        `Cliente: ${dados?.nome || row.contact_name || chatId}\n` +
        `Telefone: ${chatId}\n` +
        `Horário: ${quando}\n\n` +
        `A equipe enviou as condições de valor DEPOIS de a consulta já estar na agenda. ` +
        `O evento foi mantido e o deal atualizado para R$350 — confirmar o pagamento com o cliente.`
      );
    }
  } catch (e) {
    console.error(`  ❌ Erro ao aplicar virada de cobranca no deal ${dealId}: ${e.message}`);
    // Nao regrava bloco_condicoes_enviado=0: a proxima rodada nao repetiria a virada. Reverte pra
    // que a correcao seja tentada de novo no proximo ciclo.
    db.prepare('UPDATE conversations SET bloco_condicoes_enviado = 0, bloco_condicoes_msg_idx = NULL WHERE chat_id = ?').run(chatId);
  }
}

// Valores que a IA devolveu para campos de opcao e que NAO existem na lista do CRM (nem como apelido).
// Esses campos ficam vazios no deal — o que e o comportamento seguro —, mas silenciosamente. Aqui eles
// viram lista para uma nota unica no deal e um aviso no Telegram.
function detectarOpcoesInvalidas(dados) {
  if (!dados) return [];
  return CAMPOS_CLASSIFICACAO
    .filter(({ campo, mapa }) => {
      const valor = dados[campo];
      return valor && valor !== 'null' && buscarIdOpcao(mapa, valor) === null;
    })
    .map(({ campo, nome }) => ({ campo, nome, valor: dados[campo] }));
}

// Telegram uma unica vez por conjunto de valores invalidos (hash), mesmo padrao de
// registrarPendenciaContrato. E assim que um apelido novo chega ao conhecimento de quem mantem
// src/moskit-ids.js, em vez de o valor errado se repetir calado a cada ciclo.
async function registrarOpcoesInvalidas(dealId, chatId, invalidas) {
  if (!dealId || !invalidas?.length) return false;
  const hash = invalidas.map((i) => `${i.campo}=${i.valor}`).sort().join('|');

  const atual = chatId ? db.prepare('SELECT opcao_invalida_hash FROM conversations WHERE chat_id = ?').get(chatId) : null;
  if (atual?.opcao_invalida_hash === hash) return false;

  const lista = invalidas.map((i) => `• ${i.nome}: "${i.valor}"`).join('\n');
  try {
    await enviarTelegram(`⚠️ *Valor fora da lista do CRM*\nDeal \`${dealId}\`\n${lista}`);
    if (chatId) db.prepare('UPDATE conversations SET opcao_invalida_hash = ? WHERE chat_id = ?').run(hash, chatId);
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao avisar opcao invalida no deal ${dealId}: ${e.message}`);
    return false;
  }
}

// Briefing pre-consulta do advogado. Antes isto era uma trava de uma vez so (briefing_added): o
// PRIMEIRO resumo que a IA produzisse ficava no deal para sempre. No deal 48423360 esse primeiro
// resumo dizia "caso relacionado à LGPD" — deduzido do advogado que a cliente mencionou, sem uma linha
// sobre o caso — e continuou sendo o texto que o advogado leria antes da consulta mesmo depois de o
// bot descobrir que era remocao por motivo de saude (Direito Administrativo).
//
// Agora quem decide e o HASH do resumo: mudou de verdade => posta a versao nova. Texto igual nao gera
// nota nenhuma, e o mesmo criterio dos outros hashes de nota (agendamento_pendente_hash etc).
//
// O texto da nota tem duas partes (ver src/briefing.js): um CABECALHO montado em codigo a partir dos
// dados ja validados (nome, telefone, area, advogado, modalidade, horario) e a NARRATIVA que a IA
// escreve (resumo_atendimento). O hash e sobre o texto final, entao remarcacao ou valor novo no
// cabecalho repostam a nota mesmo que a narrativa nao tenha mudado.
//
// A trilha de notas e o historico de verdade: cada mudanca real posta uma nota NOVA com titulo
// versionado ("📋 Briefing · v3 · 17/08/2026 15:30") e o historico nativo do Moskit mostra a evolucao.
// O marcador [ollow-briefing] no fim identifica a nota como briefing. Versao vem de uma coluna do
// banco (briefing_versao) — se uma nota for apagada na mao o numero continua, e so cosmetica.
async function registrarBriefing(dealId, chatId, contexto) {
  if (!dealId) return false;

  // Precisa vir ANTES de montar o texto: o numero da reuniao entra no proprio cabecalho (a linha
  // "Consulta:"/"Retorno N:", ver rotuloCompromisso) e por isso faz parte do que e hasheado.
  const atual = chatId
    ? db.prepare('SELECT briefing_hash, briefing_added, briefing_versao, reuniao_num FROM conversations WHERE chat_id = ?').get(chatId)
    : null;
  const numeroReuniao = Number(atual?.reuniao_num) || 1;

  const texto = briefing.montarTextoBriefing({
    ...(contexto || {}),
    rotuloConsulta: reuniaoRetorno.rotuloCompromisso(numeroReuniao),
  });
  if (!texto.trim()) {
    console.log(`  ⏭️ briefing sem conteudo — nao postado`);
    return false;
  }

  const hash = briefing.hashTextoBriefing(texto);
  if (atual?.briefing_hash === hash) {
    console.log(`  ⏭️ briefing inalterado — nao repostado`);
    return false;
  }

  // Conversa anterior a esta mudanca: ja tem briefing no deal, mas nao tem hash. Adota o resumo atual
  // como referencia SEM repostar — senao todo deal ativo receberia uma nota duplicada no primeiro
  // ciclo depois do deploy. Da proxima mudanca real em diante o hash ja funciona normalmente.
  if (atual && !atual.briefing_hash && atual.briefing_added) {
    db.prepare('UPDATE conversations SET briefing_hash = ? WHERE chat_id = ?').run(hash, chatId);
    console.log(`  🧷 briefing anterior a esta versao — hash registrado sem repostar nota`);
    return false;
  }

  const versao = (atual?.briefing_versao || 0) + 1;
  const data = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_ESCRITORIO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  // "Reunião N" e numeracao SEQUENCIAL simples (1, 2, 3...), diferente do vocabulario da agenda
  // (rotuloCompromisso: "Consulta"/"Retorno N-1") — o titulo da nota conta reunioes, o cabecalho
  // dela usa o mesmo nome que esta na agenda. Os dois se encontram aqui.
  const titulo = `📋 Briefing · v${versao} · Reunião ${numeroReuniao} · ${data}`;
  await criarNotaMoskit(dealId, `${titulo}\n\n${texto}\n\n${briefing.MARCADOR_BRIEFING}`);
  if (chatId) {
    db.prepare('UPDATE conversations SET briefing_added = 1, briefing_hash = ?, briefing_versao = ? WHERE chat_id = ?').run(hash, versao, chatId);
  }
  console.log(`  ✅ ${titulo} registrado no deal ${dealId}`);
  return true;
}

async function criarNotaMoskit(dealId, texto) {
  if (!dealId) {
    console.error('  ⚠️ criarNotaMoskit chamada sem dealId — nota descartada');
    return;
  }
  // Sem validateStatus: 4xx aqui nao e esperado e precisa virar excecao. Com `s < 500` um
  // POST rejeitado passava como sucesso e a nota simplesmente nunca aparecia no deal.
  await axios.post(
    `${MOSKIT_BASE}/deals/${dealId}/notes`,
    { description: texto, user: { id: LAYLA_USER_ID } },
    { headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' } }
  );
}

// A consulta na AGENDA do Moskit. Contrato levantado em 12/08/2026 com test-moskit-atividade-real.js
// contra a API real (o repositorio so lia /activities ate entao): `dueDate` e instante absoluto
// ("2026-08-07T12:00:00.000+00:00"), `duration` em minutos, `deals`/`contacts` como arrays de {id}.
//
// NUNCA LANCA — de proposito. Quando esta funcao roda, o evento no Google Agenda ja existe e a dupla
// confirmacao ja aconteceu; deixar uma excecao subir aqui derrubaria o avanco de estagio e a geracao
// do contrato no ZapSign por causa da agenda do CRM. A falha vira Telegram, que e onde o escritorio ve.
async function criarAtividadeMoskit(dealId, payload) {
  if (!dealId || !payload) return null;
  try {
    const res = await axios.post(`${MOSKIT_BASE}/activities`, payload, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    // Resposta 2xx sem id e tao inutil quanto um erro: sem o id nao da pra remarcar nem pra impedir
    // que a sincronizacao periodica crie um evento duplicado no Google Agenda.
    const atividadeId = res.data?.id;
    if (res.status >= 300 || !atividadeId) {
      const texto = `⚠️ A consulta NAO entrou na agenda do Moskit (falha ao criar a atividade, HTTP ${res.status}). O evento no Google Agenda foi criado normalmente — marque a atividade na mao para ela aparecer na agenda do CRM.`;
      console.error(`  ❌ Atividade nao criada no Moskit (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
      // Achado em 14/08/2026: 21 de 27 consultas com evento no Google NUNCA tiveram a Atividade
      // criada, e a unica trilha que sobrou foi o console (o log da VPS nao guarda historico longo o
      // bastante). Telegram nao depende disso — mesmo padrao ja aplicado em
      // registrarErroAgendamento/registrarErroContrato.
      await enviarTelegram(`❌ *Atividade NAO criada no Moskit*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
      return null;
    }
    return atividadeId;
  } catch (e) {
    const texto = `⚠️ A consulta NAO entrou na agenda do Moskit (${e.message}). O evento no Google Agenda foi criado normalmente — marque a atividade na mao para ela aparecer na agenda do CRM.`;
    console.error(`  ❌ Erro ao criar atividade no Moskit: ${e.message}`);
    await enviarTelegram(`❌ *Atividade NAO criada no Moskit*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
    return null;
  }
}

// Move o horario da atividade quando a consulta e remarcada. Mesmo contrato de nao-lancar: o evento
// no Google ja foi movido quando chegamos aqui, e o pior desfecho e a agenda do CRM ficar no horario
// velho — o que precisa virar Telegram, nao excecao.
async function atualizarAtividadeMoskit(atividadeId, dueDate, dealId) {
  if (!atividadeId) return false;
  // dueDate nulo aqui significa que horarioNaiveParaInstante recusou o horario DEPOIS de o evento no
  // Google ja ter sido movido: as duas agendas ficam divergentes, e a do CRM mostrando o horario
  // antigo e pior que nao mostrar nada, porque parece certo. Era um `return false` mudo, o unico ramo
  // de falha do agendamento sem alerta nenhum.
  if (!dueDate) {
    console.error(`  ❌ Atividade ${atividadeId}: horario invalido pra remarcar — agenda do CRM continua no horario antigo`);
    if (dealId) {
      await enviarTelegram(`⚠️ *Atividade do Moskit NAO remarcada*\nDeal: \`${dealId}\`\nA reunião foi remarcada no Google Agenda, mas a atividade ${atividadeId} na agenda do Moskit NÃO foi movida (horário inválido na conversão de fuso). A agenda do CRM está mostrando o horário ANTIGO — corrigir na mão.`).catch(() => {});
    }
    return false;
  }
  try {
    // MEDIDO em 12/08/2026 com test-moskit-atividade-real.js contra a API real: `/activities` tem a
    // MESMA peculiaridade do PUT de deal — um payload minimo `{dueDate}` e rejeitado com 422, e so o
    // corpo do GET de volta (com o dueDate trocado) move o horario. Por isso o GET abaixo nao e
    // firula: sem ele nenhuma remarcacao jamais chegaria na agenda do CRM.
    const atualRes = await axios.get(`${MOSKIT_BASE}/activities/${atividadeId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser lida para remarcar (HTTP ${atualRes.status})`);
      if (dealId) await enviarTelegram(`⚠️ *Atividade do Moskit NAO remarcada*\nDeal: \`${dealId}\`\nA atividade na agenda do Moskit NAO foi remarcada (nao consegui ler a atividade) e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.`).catch(() => {});
      return false;
    }

    const res = await axios.put(`${MOSKIT_BASE}/activities/${atividadeId}`, { ...atualRes.data, dueDate }, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (res.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao remarcada no Moskit (HTTP ${res.status})`);
      if (dealId) await enviarTelegram(`⚠️ *Atividade do Moskit NAO remarcada*\nDeal: \`${dealId}\`\nA atividade na agenda do Moskit NAO foi remarcada e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.`).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao remarcar atividade ${atividadeId} no Moskit: ${e.message}`);
    if (dealId) await enviarTelegram(`⚠️ *Atividade do Moskit NAO remarcada*\nDeal: \`${dealId}\`\nA atividade na agenda do Moskit NAO foi remarcada (${e.message}) e continua no horario antigo. O Google Agenda ja esta no horario novo — corrija a atividade na mao.`).catch(() => {});
    return false;
  }
}

// MEDIDO em 14/08/2026 contra a API real, nos deals 48474073 e 48464876: o Moskit aceita o
// `POST /activities` com `deals: [{id: dealId}]` (HTTP 2xx, id devolvido) mas, quando o negocio foi
// criado/escrito quase ao MESMO tempo que a atividade (segundos a poucas horas de diferenca), o
// vinculo com o negocio nao gruda — a atividade fica so vinculada ao contato. Os dois casos que
// funcionaram nasceram contra um negocio que ja estava parado ha dias (rodada tardia de auto-cura).
// Nada nisso e visivel em criarAtividadeMoskit: a resposta do POST e 2xx com id, entao passa como
// sucesso. Esta funcao confere e corrige, reaproveitando o padrao GET-then-PUT de
// atualizarAtividadeMoskit (PUT minimo e rejeitado com 422). Devolve true se ficou (ou ja estava) ok.
async function garantirVinculoAtividadeDeal(atividadeId, dealId) {
  if (!atividadeId || !dealId) return false;
  try {
    const atualRes = await axios.get(`${MOSKIT_BASE}/activities/${atividadeId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (atualRes.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser lida para conferir vinculo com o deal (HTTP ${atualRes.status})`);
      return false;
    }
    const jaVinculada = (atualRes.data?.deals || []).some((d) => Number(d?.id) === Number(dealId));
    if (jaVinculada) return true;

    const res = await axios.put(`${MOSKIT_BASE}/activities/${atividadeId}`, { ...atualRes.data, deals: [{ id: dealId }] }, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
      validateStatus: (s) => s < 500,
    });
    if (res.status >= 300) {
      console.error(`  ❌ Atividade ${atividadeId} nao pode ser religada ao deal ${dealId} (HTTP ${res.status})`);
      return false;
    }
    console.log(`  🔗 Atividade ${atividadeId} religada ao deal ${dealId} (o Moskit tinha criado sem o vinculo)`);
    return true;
  } catch (e) {
    console.error(`  ❌ Erro ao conferir/religar vinculo da atividade ${atividadeId} com o deal ${dealId}: ${e.message}`);
    return false;
  }
}

// Varre as atividades do Moskit paginando por OFFSET (`?start=`).
//
// MEDIDO em 12/08/2026 contra a API real, testando um parametro de cada vez. Em `/activities`:
//   - `?page=`      IGNORADO — page=1 ate page=5 devolvem os MESMOS 10 registros
//   - `?pageToken=` IGNORADO — devolve a mesma pagina e repete o mesmo token (diferente de
//                   `/contacts`, onde esse mecanismo funciona e buscarOuCriarContato depende dele)
//   - `?limit=`     IGNORADO — sempre 10, qualquer que seja o valor
//   - `?offset=` / `?skip=` / `?from=` / `?maxId=` / `?beforeId=` — todos ignorados
//   - **`?start=`   FUNCIONA** — offset real: start=10 devolve os 10 seguintes, sem sobreposicao
//   - `?sort=`/`?order=` funcionam (order=asc devolve as mais antigas)
//
// Nenhum desses parametros ignorados devolve erro: a chamada responde 200 com a primeira pagina de
// novo. Um loop mal escrito aqui nao quebra — ele rele os mesmos 10 registros e parece ter varrido
// tudo. Foi assim que a sincronizacao e a auditoria passaram a enxergar so as 10 atividades mais
// recentes achando que varriam 100.
//
// Devolve tambem `truncou`, para o chamador poder AVISAR quando o teto cortou a varredura — teto
// silencioso aqui se leria como "varri tudo e nao achei nada", que e exatamente o engano acima.
async function listarAtividadesMoskit(maxPaginas = MAX_PAGINAS_ATIVIDADES) {
  const atividades = [];
  let truncou = false;

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const res = await axios.get(`${MOSKIT_BASE}/activities`, {
      params: { start: atividades.length, limit: 100, sort: 'id', order: 'desc' },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (res.status < 200 || res.status >= 300) break;

    const lote = Array.isArray(res.data) ? res.data : [];
    atividades.push(...lote);

    // Pagina incompleta = fim da lista. Nao da pra confiar no header `x-moskit-listing-total`: ele
    // dizia 1165 numa base cuja varredura completa devolveu 190 registros unicos.
    if (lote.length < 10) break;
    if (pagina === maxPaginas - 1) truncou = true; // ainda vinha pagina cheia quando o teto chegou
  }

  return { atividades, truncou };
}

// CONFIRMADO empiricamente em 04/08/2026 via test-moskit-put.js contra um deal de teste: o PUT com
// o corpo do GET de volta (padrao abaixo) FUNCIONA e preserva name/price/contacts/entityCustomFields
// — a duvida de corrigir-tipo-consulta.js estava desatualizada. Um PUT so com {stage:{id}} (payload
// minimo) e REJEITADO pelo Moskit com 422, nao apenas ignorado.
//
// `verificar(dealLido)` decide se a mudanca "pegou". O GET logo apos um PUT pode devolver dado velho
// por alguns segundos (confirmado no mesmo teste: uma espera de 1.5s ainda nao foi suficiente numa
// das rodadas) — por isso reconfere algumas vezes antes de declarar falha, em vez de arriscar um
// falso negativo numa automacao sem checkpoint humano. Retorna o deal lido na confirmacao.
// Mecanismo de retry compartilhado: GET repetido (1.5s/2s/3s) ate `verificar(deal)` bater, ou
// devolve o ultimo lido sem confirmar. Nao lanca — quem decide se isso e erro (e a mensagem) e o
// chamador, porque o que se verifica (stage/status escalar vs. array de entityCustomFields) e
// diferente em cada caso.
async function confirmarAposRetentativas(dealId, verificar, origem = 'BOT_WHATSAPP') {
  const esperasMs = [1500, 2000, 3000];
  let ultimoLido = null;
  for (const ms of esperasMs) {
    await new Promise((r) => setTimeout(r, ms));
    const conferir = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
    });
    ultimoLido = conferir.data;
    if (verificar(ultimoLido)) return { confirmado: true, deal: ultimoLido };
  }
  return { confirmado: false, deal: ultimoLido };
}

async function putDealComVerificacao(dealId, mudancas, verificar, origem = 'BOT_WHATSAPP') {
  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
  });
  const dealAtual = { ...getRes.data, ...mudancas };
  // O Moskit rejeita PUT cujo corpo traga status null ("Enum cannot be null"). Quando o GET vem sem
  // status, assume OPEN (o PUT aqui so acontece em operacoes de avancar/fechar — nunca reabre um
  // WON/LOST, e o status real de um deal em movimento no funil e OPEN).
  if (dealAtual.status === null || dealAtual.status === undefined || dealAtual.status === '') {
    dealAtual.status = STATUS_DEAL.OPEN;
  }
  await axios.put(`${MOSKIT_BASE}/deals/${dealId}`, dealAtual, {
    headers: { ...apiHeaders, 'X-Ollow-Origin': origem },
  });

  const { confirmado, deal } = await confirmarAposRetentativas(dealId, verificar, origem);
  if (!confirmado) {
    throw new Error(`Moskit aceitou o PUT no deal ${dealId} mas a mudanca nao se confirmou (mudancas: ${JSON.stringify(mudancas)}, lido: stage=${deal?.stage?.id} status=${deal?.status})`);
  }
  return deal;
}

async function moverParaEstagio(dealId, stageId) {
  await putDealComVerificacao(
    dealId,
    { stage: { id: stageId } },
    (deal) => Number(deal?.stage?.id) === Number(stageId)
  );
}

// So move o deal se for AVANCO no funil (nunca deixa voltar).
// Se FUNIL_DRY_RUN estiver ativo (padrao), so avisa no Telegram a sugestao, sem mover de verdade.
// Sem dedup de proposito — mesmo comportamento de frequencia que a nota tinha (roda a cada ciclo
// enquanto o deal nao avancar); so o canal mudou. FUNIL_DRY_RUN=false esta ligado em producao (ver
// memoria funil-automacao-completa), entao isso fica inerte no dia a dia hoje.
async function moverEstagioSeAvancar(dealId, estagioKey) {
  const alvo = MOSKIT_STAGE_MAP[estagioKey];
  if (!alvo) return;

  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  const stageAtualId = getRes.data?.stage?.id;
  const atual = Object.values(MOSKIT_STAGE_MAP).find((s) => s.id === stageAtualId);

  if (atual && atual.priority >= alvo.priority) {
    console.log(`  ⏭️ estagio sugerido (${estagioKey}) nao avanca em relacao ao atual — ignorando`);
    return;
  }

  const nomeEstagio = estagioKey.replace(/_/g, ' ');
  if (FUNIL_DRY_RUN) {
    console.log(`  🤖 [dry-run] moveria deal ${dealId} para "${nomeEstagio}" — nao movido de verdade`);
    await enviarTelegram(`🤖 *[dry-run] Avanço de estágio sugerido*\nDeal: \`${dealId}\`\nIA sugere mover para "${nomeEstagio}" (revisão manual necessária — FUNIL_DRY_RUN ativo)`).catch(() => {});
    return;
  }

  await moverParaEstagio(dealId, alvo.id);
  console.log(`  ➡️ Deal ${dealId} movido automaticamente para "${nomeEstagio}"`);
}

// Fecha o negocio como Ganho/Perdido — eixo DIFERENTE de moverEstagioSeAvancar: `status`, nao
// `stage` (confirmado em 04/08/2026 contra a API real: deal.status so aceita OPEN/WON/LOST, nao e
// mais um estagio na esteira). Nunca reabre nem refecha um deal que ja saiu de OPEN.
//
// So age se houver OBSERVACAO VALIDADA correspondente (nao um campo solto que o modelo preencheu) —
// mesmo espirito de pagamento_confirmado exigir comprovante em vez de confiar na alegacao pura,
// porque fechar ou perder um negocio errado nao tem volta facil no CRM.
async function fecharNegocioSeAplicavel(dealId, statusKey, motivoTexto, obsValidas, nomeCliente, telefone) {
  const evidencia = statusKey === 'ganho'
    ? ultimaObservacao(obsValidas, 'equipe_declarou_ganho')
    : (ultimaObservacao(obsValidas, 'equipe_declarou_perdido') || ultimaObservacao(obsValidas, 'cliente_declarou_perdido'));

  if (!evidencia) {
    console.log(`  ⏭️ status_negocio_sugerido "${statusKey}" sem observacao validada correspondente — ignorando`);
    return;
  }

  const getRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  if (getRes.data?.status !== STATUS_DEAL.OPEN) {
    console.log(`  ⏭️ deal ${dealId} ja esta com status "${getRes.data?.status}" — nunca reabre/refecha`);
    return;
  }

  if (FUNIL_FECHAMENTO_DRY_RUN) {
    const quem = nomeCliente ? `"${nomeCliente}"${telefone ? ` (${telefone})` : ''}` : `deal ${dealId}`;
    console.log(`  🤖 [dry-run] fecharia ${quem} como "${statusKey}"${motivoTexto ? ` (motivo: ${motivoTexto})` : ''} — nao fechado de verdade`);
    await enviarTelegram([
      `🤖 *[dry-run] Fechamento sugerido*`,
      `Cliente: ${nomeCliente || 'nao informado'}${telefone ? ` (\`${telefone}\`)` : ''}`,
      `Deal: \`${dealId}\``,
      `Resultado sugerido: ${statusKey}`,
      motivoTexto ? `Motivo: ${motivoTexto}` : '',
      '',
      'Revisão manual é necessária — fechar no Moskit se confirmar.',
    ].filter(Boolean).join('\n'));
    return;
  }

  const closeDate = new Date().toISOString();

  if (statusKey === 'ganho') {
    // Best-effort: avanca pro estagio final mapeado antes de fechar, mas nao bloqueia o fechamento
    // se isso falhar — o status fechado e o sinal mais importante aqui, nao a posicao no funil.
    const estagioFinal = MOSKIT_STAGE_MAP.contrato_enviado;
    const atual = Object.values(MOSKIT_STAGE_MAP).find((s) => s.id === getRes.data?.stage?.id);
    if (estagioFinal && (!atual || atual.priority < estagioFinal.priority)) {
      try {
        await moverParaEstagio(dealId, estagioFinal.id);
      } catch (e) {
        console.error(`  ⚠️ nao consegui avancar deal ${dealId} pro estagio final antes de fechar como ganho: ${e.message}`);
      }
    }

    await putDealComVerificacao(
      dealId,
      { status: STATUS_DEAL.WON, closeDate },
      (deal) => deal?.status === STATUS_DEAL.WON
    );
    console.log(`  🏆 Deal ${dealId} fechado automaticamente como GANHO`);
    await enviarTelegram(`🏆 *Negocio ganho!*\nDeal \`${dealId}\` fechado automaticamente com base na conversa.`);
    return;
  }

  // "perdido": nunca toca em stage — um lead pode ser perdido de qualquer estagio do funil.
  // `aproximado`: o motivo vem com as palavras da conversa ("achou o valor muito alto"), nao com o nome
  // exato da opcao do CRM — aqui a aproximacao e o comportamento certo, e o pior caso e cair no motivo
  // padrao "nao informou o motivo".
  const idMotivo = buscarIdOpcao(LOST_REASON, motivoTexto, { aproximado: true }) || LOST_REASON_PADRAO_ID;
  await putDealComVerificacao(
    dealId,
    { status: STATUS_DEAL.LOST, closeDate, lostReason: { id: idMotivo } },
    (deal) => deal?.status === STATUS_DEAL.LOST
  );
  console.log(`  💔 Deal ${dealId} fechado automaticamente como PERDIDO (motivo: ${motivoTexto || 'nao informado'})`);
  await enviarTelegram(`💔 *Negocio perdido*\nDeal \`${dealId}\` fechado automaticamente.\nMotivo: ${motivoTexto || 'nao informado'}`);
}

async function handlePagamentoConfirmado(dealId, dados, chatId) {
  if (!(dados.pagamento_confirmado === true || dados.pagamento_confirmado === 'true')) {
    return { verificadoPorComprovante: false };
  }

  const comprovante = chatId ? stmtComprovanteUltimo.get(chatId) : null;

  if (!comprovante) {
    // Cliente disse que pagou mas nunca enviou imagem verificavel — mantem comportamento antigo
    // (nao regredir casos legitimos de "ja paguei" sem foto), so deixando claro na nota.
    console.log(`  💳 Pagamento confirmado (sem comprovante verificado), movendo deal ${dealId} para Consulta Agendada...`);
    await moverParaEstagio(dealId, MOSKIT_STAGE_CONSULTA_AGENDADA);
    console.log(`  ✅ Deal ${dealId} movido para Consulta Agendada`);
    await enviarTelegram(`💳 *Pagamento confirmado sem comprovante*\nDeal: \`${dealId}\`\nDeal movido para Consulta Agendada — cliente disse que pagou, mas não enviou/nunca chegou imagem verificável.`).catch(() => {});
    return { verificadoPorComprovante: false };
  }

  stmtComprovanteSetDeal.run(dealId, comprovante.id);
  const valorFormatado = comprovante.valor_pago_centavos !== null ? `R$${(comprovante.valor_pago_centavos / 100).toFixed(2)}` : 'ilegível';

  if (comprovante.match) {
    console.log(`  💳 Comprovante confere (${valorFormatado}), movendo deal ${dealId} para Consulta Agendada...`);
    await moverParaEstagio(dealId, MOSKIT_STAGE_CONSULTA_AGENDADA);
    console.log(`  ✅ Deal ${dealId} movido para Consulta Agendada`);
    return { verificadoPorComprovante: true };
  }

  console.log(`  ⚠️ Comprovante NAO confere (${valorFormatado}) — deal ${dealId} NAO movido, revisao manual necessaria`);
  await enviarTelegram(`⚠️ *Comprovante NÃO confere*\nDeal: \`${dealId}\`\nValor lido: ${valorFormatado} — revisão manual necessária, deal não movido.`).catch(() => {});
  return { verificadoPorComprovante: false };
}

// Decide se um deal ja pode virar evento/Meet no calendario. Duas portas:
//   1) comprovante verificado pela IA de visao (match = 1) — consulta paga
//   2) campo "Tipo de Consulta" do deal = "consulta gratis" no Moskit — cobre leads do Moskit
//      Boost / atividades marcadas na mao, que nunca passam pela verificacao via WhatsApp
// Campo em branco continua bloqueado (comportamento seguro de antes). Erro de leitura tambem:
// numa indisponibilidade do Moskit, "erro => tratar como gratis" viraria uma leva de agendamentos
// nao autorizados, entao sempre falha FECHADA.
// Usado por sincronizarAtividadesMoskit/backfillMeetLinks, que so tem o dealId (nao o chatId).
// Retorna { permitido, motivo, comprovante } — motivo: 'comprovante' | 'consulta_gratis' |
// 'retorno' | 'aguardando' | 'sem_deal' | 'erro'.
async function autorizacaoParaAgendar(dealId) {
  if (!dealId) return { permitido: false, motivo: 'sem_deal', comprovante: null };

  // Caminho rapido: esse deal ja teve um comprovante vinculado por handlePagamentoConfirmado
  const porDeal = stmtComprovantePorDeal.get(dealId);
  if (porDeal) return { permitido: true, motivo: 'comprovante', comprovante: porDeal };

  // Reuniao de retorno (ver src/reuniao-retorno.js): o deal ja teve uma reuniao REALIZADA — a
  // consulta original ja foi paga, e cobrar comprovante de novo para um acompanhamento do MESMO
  // caso travaria essa Atividade em "aguardando_pagamento" para sempre. Determinístico por desenho
  // (evento passado / nota do Gemini concluida, por deal_id) — nunca o titulo digitado pela equipe,
  // que abriria um contorno do gate de pagamento.
  if (REUNIAO_RETORNO_ATIVO && consultaJaRealizadaPorDeal(dealId).realizada) {
    return { permitido: true, motivo: 'retorno', comprovante: null };
  }

  try {
    const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (dealRes.status < 200 || dealRes.status >= 300) {
      console.error(`  ❌ GET /deals/${dealId} retornou ${dealRes.status} — tratando como NAO liberado`);
      return { permitido: false, motivo: 'erro', comprovante: null };
    }

    // Mesmo GET de sempre — aproveita a resposta pra ler o "Tipo de Consulta" antes de gastar
    // outra chamada buscando o contato/telefone.
    if (LIBERAR_CONSULTA_GRATIS && dealEhConsultaGratis(dealRes.data)) {
      return { permitido: true, motivo: 'consulta_gratis', comprovante: null };
    }

    // Fallback: acha o telefone do contato do deal e cruza com comprovantes por numero
    const contactId = dealRes.data?.contacts?.[0]?.id;
    if (!contactId) return { permitido: false, motivo: 'aguardando', comprovante: null };

    const contactRes = await axios.get(`${MOSKIT_BASE}/contacts/${contactId}`, {
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    const numero = contactRes.data?.phones?.[0]?.number;
    const digitos = String(numero || '').replace(/\D/g, '');
    if (digitos.length < 8) return { permitido: false, motivo: 'aguardando', comprovante: null }; // evita match vazio/curto (mesmo bug corrigido em buscarOuCriarContato)

    const sufixo = digitos.slice(-8);
    const comprovante = stmtComprovantePorSufixoTelefone.get(sufixo, sufixo) || null;
    return {
      permitido: !!comprovante,
      motivo: comprovante ? 'comprovante' : 'aguardando',
      comprovante,
    };
  } catch (e) {
    console.error(`  ❌ Erro ao avaliar liberacao do deal ${dealId}: ${e.message}`);
    return { permitido: false, motivo: 'erro', comprovante: null };
  }
}

// Titulo e descricao do evento ficam aqui pra que a criacao e a correcao posterior
// (sincronizarMetadadosEvento) usem exatamente a mesma regra.
// O `· #<dealId>` no fim serve a rotina de notas de reuniao: o assunto do e-mail do Gemini reproduz
// o titulo do evento entre aspas (`Notas: "Consulta — Lia (Berto) · #48292471" de 14/08/2026`), entao
// o numero do negocio chega DENTRO do assunto e o bot identifica o deal sem precisar achar o evento
// na agenda. Tira o Google Calendar do caminho critico: evento apagado, renomeado ou movido de
// calendario deixa de derrubar a identificacao.
//
// SUFIXO, NUNCA PREFIXO. A rota de backfill do Meet reconhece consulta na agenda com
// `/^Consulta\s*—/.test(ev.summary)` (ver adicionarMeetEmEventos mais abaixo) — casamento por INICIO.
// Com o numero na frente ela simplesmente pararia de enxergar qualquer consulta, sem erro nenhum.
//
// O `dealId` vem por parametro pelo mesmo motivo de montarDescricaoEvento: sincronizarMetadadosEvento
// COMPARA este resumo com o que esta no Google, e duas fontes diferentes para o mesmo dado fariam o
// evento ser repatchado a cada ciclo. Pelo MESMO motivo, `numeroReuniao` (ver src/reuniao-retorno.js)
// tem que vir sempre do banco (row.reuniao_num), NUNCA recalculado aqui dentro — os tres call sites
// (Atividade do Moskit, sincronizarMetadadosEvento, criacao do evento) usam o mesmo numero, senao
// sincronizarMetadadosEvento veria "mudou" e repatcharia o evento pra sempre.
//
// rotuloCompromisso decide o vocabulario: a 1a reuniao do caso continua "Consulta" (sem numeroReuniao
// tambem cai em "Consulta", entao todo call site antigo que nao passa o 3o argumento continua igual).
function montarResumoEvento(dados, dealId, numeroReuniao) {
  const presencial = dados.modalidade_consulta === 'presencial';
  const rotulo = reuniaoRetorno.rotuloCompromisso(numeroReuniao);
  const base = `${rotulo}${presencial ? ' (Presencial)' : ''} — ${dados.nome || 'Cliente'} (${dados.advogado_responsavel || 'a definir'})`;
  return dealId ? `${base} · #${dealId}` : base;
}

// `dealId` vem SEMPRE por parametro, nunca lido do banco aqui dentro. Motivo: esta funcao roda na
// criacao do evento e de novo em sincronizarMetadadosEvento, que COMPARA a descricao gerada com a
// que ja esta no Google para decidir se precisa dar patch. Se as duas chamadas derivassem o dealId
// de fontes diferentes, a comparacao daria "mudou" em todo ciclo e o evento seria repatchado para
// sempre. E ler do banco seria exatamente esse caso: stmtFinalizarCiclo so grava conversations.deal_id
// DEPOIS de handleAgendamentoCalendar, entao na criacao de um deal novo o banco ainda traz null.
//
// A linha `[deal:...]` e o que permite a rotina de notas de reuniao (sincronizarNotasReuniao) achar o
// negocio de forma deterministica. Sem ela, a identificacao depende do "Telefone:" abaixo, que so
// existe em evento criado pelo bot — a sondagem de 16/08/2026 mediu que 1/3 das reunioes com notas
// nasceu de evento criado a mao, sem vinculo nenhum. Fica na DESCRICAO e nao no titulo porque o
// titulo e o que o cliente ve no convite.
function montarDescricaoEvento(dados, chatId, dealId) {
  return [
    `Assunto: ${dados.assunto || 'nao informado'}`,
    `Telefone: ${chatId}`,
    dealId ? `[deal:${dealId}]` : '',
    dados.email_cliente ? `Email do cliente: ${dados.email_cliente}` : '',
    dados.resumo_atendimento || '',
  ].filter(Boolean).join('\n');
}

// Mesmo sufixo `· #dealId` de montarResumoEvento (SUFIXO, NUNCA PREFIXO — mesmo motivo), mas
// aplicado a um titulo que JA EXISTE (o que a equipe digitou na Atividade do Moskit), em vez de
// gerado do zero a partir de `dados` do pipeline do bot. sincronizarAtividadesMoskit cobre consultas
// que nunca passam pela conversa de WhatsApp (Atividade criada a mao no Moskit, ou pelo Moskit
// Boost) — sem esse sufixo, a rotina de notas de reuniao dependia so dos metodos mais fracos da
// cascata (atividade do Moskit / e-mail de participante) pra essas reunioes, em vez do metodo 1
// (titulo com #dealId, "alta confianca", que dispensa ate achar o evento na agenda). Idempotente de
// proposito: nao duplica o sufixo se ja estiver la.
function comSufixoDealId(titulo, dealId) {
  const t = titulo || 'Consulta agendada';
  if (!dealId) return t;
  return new RegExp(`·\\s*#${dealId}\\b`).test(t) ? t : `${t} · #${dealId}`;
}

// Mesmo marcador `[deal:...]` de montarDescricaoEvento, acrescentado a uma descricao que ja existe
// (atv.notes + o link do negocio) em vez de montada do zero. Idempotente pelo mesmo motivo do
// comentario acima — a atividade "evento nativo" so passa por aqui UMA vez (ver
// stmtAtividadeMarcarSincronizada/stmtAtividadeJaSincronizada em sincronizarAtividadesMoskit).
function comMarcadorDeal(descricao, dealId) {
  const d = descricao || '';
  if (!dealId) return d;
  return /\[deal:\d+\]/.test(d) ? d : [d, `[deal:${dealId}]`].filter(Boolean).join('\n\n');
}

// Cria, na AGENDA do Moskit, a atividade que corresponde ao evento recem-criado no Google Agenda.
//
// O PONTO CRITICO AQUI E O `stmtAtividadeMarcarSincronizada` NO FIM. sincronizarAtividadesMoskit roda
// a cada SYNC_INTERVAL_MS e cria um evento no Google para toda atividade de consulta futura que nao
// esteja nessa tabela — ou seja, sem essa linha o proprio bot criaria um SEGUNDO evento para a mesma
// consulta minutos depois. Marcar a atividade como ja sincronizada, apontando para o evento que
// acabamos de criar, e o que fecha o circuito entre as duas agendas.
//
// Nao lanca: quem chama esta no meio do caminho feliz do agendamento (nota, Telegram, estagio,
// contrato) e nada disso pode cair porque a agenda do CRM falhou. Devolve true se entrou na agenda.
async function registrarConsultaNaAgendaMoskit({ dealId, dados, chatId, horarioIso, meetLink, eventoId, row }) {
  if (!dealId) return false;
  if (row?.atividade_moskit_id) return false; // ja tem atividade — nao duplicar na agenda do CRM

  if (AGENDA_MOSKIT_DRY_RUN) {
    // Um Telegram so: esta funcao roda no ramo de CRIACAO do evento, guardado por
    // evento_calendar_criado — uma vez por conversa, nao a cada ciclo.
    const quando = formatarHorarioEscritorio(horarioIso);
    console.log(`  ⏭️ [dry-run] atividade do Moskit NAO criada para o deal ${dealId} (AGENDA_MOSKIT_DRY_RUN ativo)`);
    await enviarTelegram(`🤖 *[dry-run] Atividade do Moskit NAO criada*\nDeal: \`${dealId}\`\nA consulta de ${quando} NAO foi lançada na agenda do Moskit (AGENDA_MOSKIT_DRY_RUN ativo) — marque a atividade na mão. O evento no Google Agenda foi criado normalmente.`).catch(() => {});
    return false;
  }

  const dueDate = horarioNaiveParaInstante(horarioIso, TZ_ESCRITORIO);
  if (!dueDate) {
    console.error(`  ⚠️ horario "${horarioIso}" nao converteu para instante — atividade do Moskit nao criada`);
    return false;
  }

  // O contato ja foi resolvido antes neste ciclo (buscarOuCriarContato) e ficou no espelho local;
  // vincular a atividade a ele e o que a faz aparecer tambem na ficha do cliente, nao so no negocio.
  const phoneClean = String(chatId || '').replace(/\D/g, '').slice(-13);
  const contatoId = phoneClean.length >= 8 ? stmtMoskitGet.get(phoneClean)?.moskit_id || null : null;

  const payload = montarPayloadAtividade({
    dealId,
    contatoId,
    titulo: montarResumoEvento(dados, dealId, row?.reuniao_num), // mesmo titulo do evento do Google: e o mesmo compromisso
    assunto: dados.assunto,
    dueDate,
    presencial: dados.modalidade_consulta === 'presencial',
    meetLink,
  });

  const atividadeId = await criarAtividadeMoskit(dealId, payload);
  if (!atividadeId) return false;

  // Confere se o POST realmente vinculou a atividade ao negocio — ver o comentario de
  // garantirVinculoAtividadeDeal, o 2xx do POST acima nao garante isso.
  const vinculada = await garantirVinculoAtividadeDeal(atividadeId, dealId);
  if (!vinculada) {
    const texto = `⚠️ A atividade ${atividadeId} foi criada na agenda do Moskit mas NAO ficou vinculada ao negócio (o Moskit as vezes perde esse vínculo quando o negócio acabou de ser escrito) — vincule na mão para ela aparecer na tela do negócio.`;
    await enviarTelegram(`❌ *Atividade criada sem vínculo com o negócio*\nDeal: \`${dealId}\`\n${texto}`).catch(() => {});
  }

  db.prepare('UPDATE conversations SET atividade_moskit_id = ? WHERE chat_id = ?').run(atividadeId, chatId);
  stmtAtividadeMarcarSincronizada.run(atividadeId, eventoId, dealId); // <- trava anti-evento-duplicado
  console.log(`  🗓️ Consulta marcada na agenda do Moskit (atividade ${atividadeId}, deal ${dealId})`);
  return true;
}

// Corrige titulo/descricao de um evento ja criado quando os dados melhoraram depois — tipico do
// evento que nasceu com "(a definir)" porque o ciclo que o criou nao tinha o advogado ainda.
// Nao mexe em data/hora, entao nao exige confirmacao (diferente de remarcar).
async function sincronizarMetadadosEvento(dados, chatId, row, dealId) {
  const auth = getGoogleAuthClient();
  if (!auth) return;

  const novoResumo = montarResumoEvento(dados, dealId, row?.reuniao_num);
  const novaDescricao = montarDescricaoEvento(dados, chatId, dealId);
  if (novoResumo.includes('(a definir)')) return; // ainda nao sabemos o advogado — nao piora o que esta la

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const atual = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });
    if (atual.data.summary === novoResumo && atual.data.description === novaDescricao) return;

    await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.evento_calendar_id,
      requestBody: { summary: novoResumo, description: novaDescricao },
    });
    console.log(`  ✏️ Evento do chat ${chatId} atualizado: "${novoResumo}"`);
  } catch (e) {
    console.error(`  ❌ Erro ao atualizar titulo/descricao do evento: ${e.message}`);
  }
}

async function criarEventoGoogleCalendar(dados, chatId, dealId, numeroReuniao) {
  const auth = getGoogleAuthClient();
  if (!auth) {
    console.log('  ⏭️ Google Calendar nao configurado (faltam google-oauth-client.json/google-oauth-token.json/GOOGLE_CALENDAR_ID) — pulando');
    return null;
  }

  // Chegar aqui com horario invalido significa que a dupla confirmacao JA aconteceu (cliente e equipe
  // concordaram) e ainda assim nao vai existir reuniao. Isso tem que LANCAR, nao devolver null: o
  // catch de quem chama vira nota no deal + Telegram. Antes era `return null` silencioso, e foi
  // exatamente esse silencio que deixou o caso do Arthur (deal 48370184) invisivel — a partir do
  // guard de formato, o sintoma deixou de ser "reuniao no horario errado" e passou a ser "reuniao que
  // ninguem marcou e ninguem soube", repetindo a cada ciclo de 5 min so no console.
  const inicioNaive = normalizarHorarioNaive(dados.data_hora_consulta);
  if (!inicioNaive) {
    const erro = new Error(`horario da consulta invalido ("${dados.data_hora_consulta}") — esperado AAAA-MM-DDTHH:MM:00 em hora do escritorio`);
    // Marca o erro pra handleAgendamentoCalendar distinguir "dado ruim" (sem data confiavel, aborta
    // tudo) de falha real da API do Google (rede/OAuth/quota — nesse caso a Atividade do Moskit ainda
    // pode e deve nascer, ver comentario la).
    erro.horarioInvalido = true;
    throw erro;
  }
  const fimNaive = somarMinutosNaive(inicioNaive, 60); // duracao media de 1h
  const presencial = dados.modalidade_consulta === 'presencial';

  const calendar = google.calendar({ version: 'v3', auth });
  const event = {
    summary: montarResumoEvento(dados, dealId, numeroReuniao),
    description: montarDescricaoEvento(dados, chatId, dealId),
    start: { dateTime: inicioNaive, timeZone: TZ_ESCRITORIO },
    end: { dateTime: fimNaive, timeZone: TZ_ESCRITORIO },
    ...(presencial ? {} : {
      conferenceData: {
        createRequest: {
          requestId: `meet-${chatId}-${Date.parse(`${inicioNaive}Z`)}`, // so precisa ser deterministico e unico
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
    ...(dados.email_cliente ? { attendees: [{ email: dados.email_cliente }] } : {}),
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
    conferenceDataVersion: 1,
    sendUpdates: dados.email_cliente ? 'all' : undefined,
  });

  console.log(`  📅 Evento criado no Google Calendar: ${res.data.htmlLink}`);
  return res.data;
}

// DUPLA CONFIRMACAO: o evento so nasce quando o cliente aceitou E a equipe confirmou o MESMO horario.
// `apuracao` vem de apurarDuplaConfirmacao() sobre observacoes ja validadas contra as mensagens reais
// (src/evidencia.js), entao cada perna esta amarrada a uma mensagem com o role correto — o modelo nao
// consegue mais simplesmente afirmar que houve confirmacao.
//
// O horario agendado e o das observacoes, nao o `dados.data_hora_consulta`: e o horario que as duas
// partes concordaram nesta rodada, e nao herda valor antigo via mergeDados.
// Timestamp da MENSAGEM que fechou a perna mais recente da dupla confirmacao (max(cliente, equipe)
// por msg_idx) — nunca Date.now(). Usado so por classificarReuniao (ver src/reuniao-retorno.js):
// um reprocessamento dias depois (fila, processar_pendentes.js, refresh de briefing) tem que chegar
// no MESMO veredito de quando a confirmacao realmente fechou, e o relogio da maquina muda a cada
// reprocessamento enquanto o timestamp da mensagem nao muda nunca. `mensagens` ausente (chamada
// direta de teste, sem o array) devolve null — reuniaoRetorno.classificarReuniao cai para "agora".
function timestampConfirmacao(apuracao, mensagens) {
  const idx = Math.max(apuracao?.cliente?.msg_idx ?? -1, apuracao?.equipe?.msg_idx ?? -1);
  if (idx < 0 || !Array.isArray(mensagens)) return null;
  return mensagens[idx]?.timestamp || null;
}

async function handleAgendamentoCalendar(dealId, dados, chatId, pagamentoVerificado, row, apuracao, mensagens) {
  const podeAgendar = !!apuracao?.confirmado;
  const dadosEvento = podeAgendar
    ? { ...dados, data_hora_consulta: apuracao.horarioIso }
    : dados;

  // Camada de defesa teorica (nao confirmada em incidente real, achada revisando o codigo em
  // 14/08/2026): quando podeAgendar e true, o override acima DESCARTA o `data_hora_consulta` bruto
  // que o modelo devolveu nesta rodada em favor de `apuracao.horarioIso` — se a apuracao fechar com
  // um par ANTIGO mas autoconsistente (ja igual ao que esta no banco), `atualizarEventoSeRemarcado`
  // faz um `return` silencioso (`row.evento_calendar_data === novoInicioNaive`) sem instrumentacao
  // nenhuma. So avisa (Telegram + hash proprio) quando ja existe reuniao marcada e os dois valores
  // discordam.
  if (row?.evento_calendar_criado && podeAgendar) {
    const brutoNaive = normalizarHorarioNaive(dados?.data_hora_consulta);
    const efetivoNaive = normalizarHorarioNaive(dadosEvento?.data_hora_consulta);
    if (brutoNaive && efetivoNaive && brutoNaive !== efetivoNaive) {
      const hash = `${brutoNaive}|${efetivoNaive}`;
      const atual = db.prepare('SELECT agendamento_divergencia_hash FROM conversations WHERE chat_id = ?').get(chatId);
      if (atual?.agendamento_divergencia_hash !== hash) {
        console.log(`  ⚠️ deal ${dealId}: apuracao fechou em ${efetivoNaive} mas o modelo devolveu ${brutoNaive} nesta rodada — divergencia registrada`);
        await enviarTelegram(`⚠️ *Divergência apuração × IA*\nDeal: \`${dealId}\`\nA dupla confirmação fechou em ${formatarHorarioEscritorio(efetivoNaive)}, mas a IA havia entendido ${formatarHorarioEscritorio(brutoNaive)} nesta rodada — vale conferir a conversa manualmente.`).catch(() => {});
        db.prepare('UPDATE conversations SET agendamento_divergencia_hash = ? WHERE chat_id = ?').run(hash, chatId);
      }
    }
  }

  if (row?.evento_calendar_criado) {
    if (!row?.evento_calendar_id) {
      console.log(`  ⚠️ Chat ${chatId} ja tem evento_calendar_criado=1 mas sem evento_calendar_id salvo (conversa anterior a essa correcao) — nao da pra atualizar automaticamente, revisar manualmente se precisar remarcar`);
      return;
    }
    // Corrigir titulo/descricao nao move nada, entao roda sempre — inclusive quando a remarcacao
    // esta travada por falta de confirmacao.
    if (dados.data_hora_consulta) await sincronizarMetadadosEvento(dados, chatId, row, dealId);

    // Auto-cura: achado em 14/08/2026 que 21 de 27 consultas com evento no Google NUNCA tiveram a
    // Atividade criada no Moskit (falha silenciosa de POST /activities, sem log nem nota nem
    // Telegram — ja corrigido em criarAtividadeMoskit). Esse ramo (evento JA existia) nunca tentava
    // criar a Atividade que falta — so `atualizarAtividadeMoskit` quando ela ja existe.
    //
    // Roda ANTES do `if (!podeAgendar) return` de proposito: o evento no Google ja existe
    // (`row.evento_calendar_criado`), entao a reuniao ja foi confirmada de verdade numa rodada
    // anterior — a auto-cura nao depende de a IA reconfirmar a dupla confirmacao HOJE. Foi assim que
    // a primeira versao deste fix (dentro do `if (podeAgendar)`) deixou o deal 48287898 sem cura: o
    // eco-da-data-ancora corretamente rejeitou o horario extraido nessa rodada, `podeAgendar` deu
    // false, e o `return` logo abaixo nunca deixava a auto-cura rodar.
    // `registrarConsultaNaAgendaMoskit` ja e idempotente (`if (row?.atividade_moskit_id) return
    // false`), entao chamar aqui e seguro tanto quando a Atividade ja existe quanto quando falta. Sem
    // meetLink aqui de proposito — buscar o link do Meet exigiria reler o evento do Google; a
    // Atividade nascer sem o link nas notas e aceitavel, o essencial e ela existir (ver "Limitacao
    // aceita" no plano).
    const naAgendaMoskit = await registrarConsultaNaAgendaMoskit({
      dealId, dados: dadosEvento, chatId, horarioIso: row.evento_calendar_data, meetLink: null, eventoId: row.evento_calendar_id, row,
    });
    if (naAgendaMoskit) {
      // `row` e o snapshot lido ANTES deste ciclo — registrarConsultaNaAgendaMoskit acabou de gravar
      // atividade_moskit_id no banco, mas o objeto em memoria continua com o valor antigo (nulo).
      // Sem atualiza-lo aqui, atualizarEventoSeRemarcado (logo abaixo) nao acha a atividade que acabou
      // de nascer e nao move o dueDate dela quando a remarcacao acontece NO MESMO ciclo da auto-cura —
      // a atividade fica presa na data antiga (row.evento_calendar_data) pra sempre, sem nenhum sinal.
      row = { ...row, atividade_moskit_id: db.prepare('SELECT atividade_moskit_id FROM conversations WHERE chat_id = ?').get(chatId)?.atividade_moskit_id };
    }

    // Remarcar uma reuniao ja marcada exige o MESMO criterio de criar. Sem essa trava, qualquer
    // data extraida movia a reuniao de um cliente real — inclusive um horario que a equipe apenas
    // PROPOS e o cliente nunca respondeu.
    if (!podeAgendar) {
      // So anota se houver horario em jogo. Sem isso, toda conversa ja agendada geraria uma nota de
      // "nao remarcada" a cada ciclo, mesmo quando ninguem falou de horario nenhum.
      if (apuracao?.cliente || apuracao?.equipe) {
        console.log(`  ⏭️ deal ${dealId}: reuniao NAO remarcada — ${descreverPendencia(apuracao)}`);
        await registrarAgendamentoPendente(dealId, chatId, apuracao, true, row);
      }
      return;
    }

    // Reuniao de retorno (2a+ reuniao do MESMO caso — ver src/reuniao-retorno.js). A partir daqui ha
    // um horario NOVO confirmado para um deal que ja tem evento na agenda: sem esta checagem, o
    // codigo abaixo (atualizarEventoSeRemarcado) trataria isso SEMPRE como remarcacao, dando PATCH
    // no evento que talvez ja tenha ACONTECIDO — apagando o registro da reuniao anterior, sem a
    // reuniao nova nunca entrar na agenda do Moskit (registrarConsultaNaAgendaMoskit sai na guarda de
    // atividade_moskit_id ja existente).
    if (REUNIAO_RETORNO_ATIVO) {
      const consultaAnterior = consultaDoAtendimento(row);
      const classificacao = reuniaoRetorno.classificarReuniao({
        consulta: consultaAnterior,
        horarioNovoIso: apuracao.horarioIso,
        confirmadoEm: timestampConfirmacao(apuracao, mensagens),
        timeZone: TZ_ESCRITORIO,
        toleranciaHoras: REUNIAO_TOLERANCIA_REMARCACAO_HORAS,
      });

      if (classificacao.retorno) {
        const porque = reuniaoRetorno.descreverMotivo(classificacao.motivo);
        const dataFormatadaRetorno = formatarHorarioEscritorio(apuracao.horarioIso);

        if (REUNIAO_RETORNO_DRY_RUN) {
          // Desvio DELIBERADO da convencao de CLIENTE_RETORNO_DRY_RUN ("segue como hoje"): "como
          // hoje" aqui seria mover o evento da consulta que ja aconteceu, e medir nao justifica
          // destruir esse registro. O dry-run so avisa e retorna, sem chamar atualizarEventoSeRemarcado.
          const hash = `dry|${apuracao.horarioIso}|${classificacao.motivo}`;
          if (row?.reuniao_aviso_hash !== hash) {
            console.log(`  🤖 [dry-run] deal ${dealId}: reuniao NOVA seria aberta para ${dataFormatadaRetorno} (${porque}) — evento anterior NAO sera movido`);
            await enviarTelegram([
              '🔁 *Reunião de retorno detectada (dry-run)*',
              `Negócio: \`${dealId}\``,
              `Novo horário confirmado: ${dataFormatadaRetorno}`,
              `Motivo: ${porque}`,
              '',
              '🤖 [dry-run] nada foi alterado — o evento anterior NÃO foi movido nem uma reunião nova foi criada.',
            ].join('\n')).catch(() => {});
            try { db.prepare('UPDATE conversations SET reuniao_aviso_hash = ? WHERE chat_id = ?').run(hash, chatId); } catch (e) { console.error(`  ⚠️ nao gravei reuniao_aviso_hash: ${e.message}`); }
          }
          return;
        }

        // Arquiva a reuniao atual (evento/Atividade) e zera o estado do compromisso — deal_id, bloco
        // de condicoes e contrato continuam intocados, e o proprio caso. Relendo `row` do banco, a
        // chamada recursiva cai no ramo "evento nao existe" abaixo, que cria o evento novo e a
        // Atividade nova com o titulo/numero certos (row.reuniao_num ja incrementado).
        const numeroNovo = abrirNovaReuniao(chatId, row);
        console.log(`  🔁 deal ${dealId}: reuniao ${numeroNovo} aberta para ${dataFormatadaRetorno} (${porque}) — reuniao anterior preservada em reunioes_anteriores`);
        const rowAtualizado = db.prepare('SELECT * FROM conversations WHERE chat_id = ?').get(chatId);
        return handleAgendamentoCalendar(dealId, dados, chatId, pagamentoVerificado, rowAtualizado, apuracao, mensagens);
      }
    }

    await atualizarEventoSeRemarcado(dealId, dadosEvento, chatId, row);

    // Evento ja existia e a dupla confirmacao continua valida — o deal tem consulta marcada de
    // verdade. "consulta_agendada" fica orfa desde que foi mapeada (MOSKIT_STAGE_MAP): a IA nunca
    // sugere esse estagio (estagio_funil_sugerido so cobre o que vem DEPOIS da consulta), entao sem
    // esta chamada nenhum deal chegava la. So avanca (nunca volta, ver moverEstagioSeAvancar).
    await moverEstagioSeAvancar(dealId, 'consulta_agendada');
    // Este ramo roda em TODO ciclo enquanto a confirmacao continuar valida (nao so na primeira
    // vez) — handleContratoZapSign tem seu proprio guard de idempotencia (contrato_zapsign_criado).
    await handleContratoZapSign(dealId, dados, chatId, row);
    return;
  }

  if (!podeAgendar) {
    // So vale anotar quando existe algum horario em jogo — conversa que nem chegou a falar de data
    // nao e "pendencia", e so uma conversa em andamento.
    if (apuracao?.cliente || apuracao?.equipe || dados.data_hora_consulta) {
      console.log(`  ⏭️ deal ${dealId}: evento NAO criado — ${descreverPendencia(apuracao || { motivo: 'falta_ambos' })}`);
      await registrarAgendamentoPendente(dealId, chatId, apuracao, false, row);
    }
    return;
  }

  // Google e Moskit sao tentados de forma DESACOPLADA a partir daqui: uma falha real da API do
  // Google (rede, token expirado, quota) nao pode impedir a Atividade de nascer na agenda do Moskit
  // — foi exatamente essa dependencia (Moskit so era tentado DEPOIS do Google ter sucesso, dentro do
  // mesmo try) que deixou as DUAS agendas vazias no deal 48474073 quando so o Google falhou.
  //
  // "Data invalida" (eco da data-ancora, formato estranho — `erro.horarioInvalido`) e um caso
  // DIFERENTE e continua abortando tudo: sem uma data confiavel nao existe reuniao pra marcar em
  // lugar nenhum, nem Google nem Moskit.
  let evento = null;
  let erroGoogle = null;
  try {
    evento = await criarEventoGoogleCalendar(dadosEvento, chatId, dealId, row?.reuniao_num);
  } catch (e) {
    if (e.horarioInvalido) {
      console.error(`  ❌ Erro ao criar evento no Google Calendar: ${e.message}`);
      await registrarErroAgendamento(dealId, chatId, e.message, false);
      return; // dado ruim: sem isso, o avanco de estagio abaixo rodaria com uma data que nao presta
    }
    erroGoogle = e; // falha real de API/rede/OAuth — a Atividade do Moskit ainda pode e deve nascer
    console.error(`  ❌ Erro ao criar evento no Google Calendar: ${e.message}`);
  }

  if (evento) {
    db.prepare('UPDATE conversations SET evento_calendar_criado = 1, evento_calendar_id = ?, evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(evento.id, apuracao.horarioIso, chatId);
  }
  const dataFormatada = formatarHorarioEscritorio(apuracao.horarioIso);
  const meetLink = evento ? extrairMeetLink(evento) : null;

  // Tenta a Atividade do Moskit INDEPENDENTE do Google ter dado certo — o que garante que o deal
  // tenha a consulta marcada em pelo menos uma agenda mesmo com o Google fora do ar. Com eventoId
  // nulo, `registrarConsultaNaAgendaMoskit` ainda grava `atividades_sincronizadas` (trava
  // anti-duplicado), so sem apontar pra um evento que nao existe.
  const naAgendaMoskit = await registrarConsultaNaAgendaMoskit({
    dealId, dados: dadosEvento, chatId, horarioIso: apuracao.horarioIso, meetLink, eventoId: evento?.id || null, row,
  });

  if (evento) {
    await notificarTelegramMeet({
      nome: dados.nome,
      telefone: chatId,
      advogado: dados.advogado_responsavel,
      dataHoraTexto: dataFormatada,
      meetLink,
      dealId,
    });
  } else if (erroGoogle) {
    // A dupla confirmacao e a data sao boas — so a chamada ao Google falhou de verdade. O Telegram de
    // registrarErroAgendamento carrega o aviso; `naAgendaMoskit` so ajusta o texto dele (a consulta
    // pode ja ter entrado no Moskit mesmo com o Google falhando).
    await registrarErroAgendamento(dealId, chatId, erroGoogle.message, false, naAgendaMoskit);
  }
  // evento nulo sem erroGoogle = Google nao configurado (getGoogleAuthClient() devolveu null, tipico
  // de ambiente sem as credenciais) — nao e falha de producao, so segue: a Atividade do Moskit ja foi
  // tentada acima.

  // Avanca de estagio e dispara o contrato sempre que a consulta esta marcada em QUALQUER UMA das
  // duas agendas — e essa marcacao real, nao so a intencao do Google ter dado certo, que importa
  // pro funil (e e exatamente isso que o usuario pediu: a Atividade aparecer no deal).
  if (evento || naAgendaMoskit) {
    await moverEstagioSeAvancar(dealId, 'consulta_agendada');
    await handleContratoZapSign(dealId, dados, chatId, row);
  }
}

// Gera automaticamente o contrato de Prestacao de Servico no ZapSign, preenchido com os dados que
// o bot ja tem, assim que o agendamento da consulta e confirmado (dupla confirmacao cliente+equipe
// — mesmo criterio de handleAgendamentoCalendar, que e quem chama esta funcao). So dispara UMA vez
// por deal: o guard abaixo e necessario porque o ramo "evento ja existia" chama esta funcao em todo
// ciclo de reprocessamento enquanto a confirmacao continuar valida, nao so na primeira vez.
async function handleContratoZapSign(dealId, dados, chatId, row) {
  if (!dealId || row?.contrato_zapsign_criado) return;

  const faltantes = zapsign.camposContratoFaltantes(dados);
  if (faltantes.length) {
    await registrarPendenciaContrato(dealId, chatId, faltantes);
    return;
  }

  try {
    const resultado = await zapsign.criarDocumentoZapSign(dados, chatId, new Date().toISOString());
    if (!resultado.ok) {
      // Corrida rara: os dados passaram no gate acima mas mudaram/zeraram entre o check e a
      // chamada (nao deveria acontecer no fluxo normal, mas nao custa nao mandar documento vazio).
      await registrarPendenciaContrato(dealId, chatId, resultado.faltantes || []);
      return;
    }
    db.prepare(
      'UPDATE conversations SET contrato_zapsign_criado = 1, contrato_zapsign_doc_token = ?, contrato_zapsign_status = ?, contrato_zapsign_pendente_hash = NULL WHERE chat_id = ?'
    ).run(resultado.docToken, resultado.status || 'pending', chatId);
    await moverEstagioSeAvancar(dealId, 'contrato_enviado');
  } catch (e) {
    console.error(`  ❌ Erro ao criar contrato no ZapSign (deal ${dealId}): ${e.message}`);
    // Erro real de API (token/template invalido, rede, etc) — nao confundir com dado faltante.
    // Nao relanca: mesmo raciocinio de criarEventoGoogleCalendar, a causa mais provavel aqui e
    // configuracao errada, nao falha transitoria, entao nao faz sentido entrar na fila de retry.
    await registrarErroContrato(dealId, chatId, e.message);
  }
}

// Telegram quando falta algum dado pro contrato (CPF, profissao, endereco, e-mail, valor de
// honorarios...) — mesmo padrao de registrarAgendamentoPendente: hash evita repetir o aviso a cada
// ciclo de 5 min enquanto a mesma lista de campos continuar faltando. Como o bot nunca manda
// mensagem pro cliente (so le o que a Zernio ja trouxe), este aviso e o unico jeito de a equipe
// saber que precisa pedir esses dados pelo WhatsApp real dela.
async function registrarPendenciaContrato(dealId, chatId, faltantes) {
  if (!dealId || !faltantes?.length) return;
  const hash = faltantes.slice().sort().join(',');

  const atual = db.prepare('SELECT contrato_zapsign_pendente_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.contrato_zapsign_pendente_hash === hash) return;

  try {
    await enviarTelegram(`⏳ *Contrato NÃO gerado — dado faltando*\nDeal: \`${dealId}\`\nFaltam: ${faltantes.join(', ')}. Peça esses dados ao cliente pelo WhatsApp.`);
    db.prepare('UPDATE conversations SET contrato_zapsign_pendente_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao avisar pendencia de contrato no deal ${dealId}: ${e.message}`);
  }
}

// Telegram quando os dados estavam completos mas a CHAMADA a API do ZapSign falhou de verdade
// (token/template invalido, rede, etc) — eixo diferente de registrarPendenciaContrato (dado
// faltante). Mesmo padrao de registrarErroAgendamento: uma falha de API tende a afetar TODOS os
// contratos seguintes, nao so este deal, e sem Telegram ninguem percebe ate abrir o deal na mao.
async function registrarErroContrato(dealId, chatId, mensagemErro) {
  if (!dealId) return;
  const hash = String(mensagemErro || '').slice(0, 200);

  const atual = db.prepare('SELECT contrato_zapsign_erro_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.contrato_zapsign_erro_hash === hash) return;

  const texto = `❌ Falha ao gerar contrato no ZapSign: ${mensagemErro}. Verificar manualmente (ZAPSIGN_API_KEY/ZAPSIGN_TEMPLATE_TOKEN configurados corretamente?).`;
  try {
    await enviarTelegram(`❌ *Falha ao gerar contrato*\nDeal: \`${dealId}\`\nTelefone: \`${chatId}\`\n${texto}`);
    db.prepare('UPDATE conversations SET contrato_zapsign_erro_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar FALHA de contrato no deal ${dealId}: ${e.message}`);
  }
}

// Telegram quando ha horario em jogo mas o agendamento esta travado. O hash evita repetir o mesmo
// aviso a cada ciclo de 5 min enquanto a situacao nao muda.
//
// MEDIDO em 14/08/2026 (deals 48292471/48287898): a apuracao ja identificava a pendencia certa
// (motivo falta_cliente) e o Telegram ja e incondicional quando remarcacao=true — mas em pelo menos
// um caso (Lia) NENHUM campo que o modelo devolveu naquela rodada carregava o horario novo, entao o
// hash de dedup (que so olha pra motivo/horario relatado) nunca mudou enquanto a reuniao ficava mais
// perto, e o aviso nao insistiu. `row` (novo parametro) traz o que ESTA na agenda pra dois reforcos:
// (1) uma divergencia de CONTEUDO explicita quando a perna validada discorda do banco (pega o caso da
// Solange, cuja equipe confirmou "18/08" com trecho limpo mas o banco seguia em "16/08"); (2) uma
// escalada por PROXIMIDADE que reenvia o Telegram mesmo com hash igual, quando a reuniao ja marcada
// esta perto (`AGENDAMENTO_URGENCIA_HORAS`) — essa e a garantia que nao depende do modelo acertar
// nada, porque nem sempre ele acerta.
async function registrarAgendamentoPendente(dealId, chatId, apuracao, remarcacao, row) {
  if (!dealId) return;
  const motivo = apuracao?.motivo || 'falta_ambos';
  const horarioRelatado = apuracao?.equipe?.horario_iso || apuracao?.cliente?.horario_iso || null;
  const descartados = apuracao?.horariosDescartados || [];
  const bancoNaive = row?.evento_calendar_data || null;

  // Divergencia de CONTEUDO: a perna validada (quando existe) discorda do horario ja marcado. So faz
  // sentido comparar quando ja existe reuniao (bancoNaive truthy) — sem isso e so uma proposta nova,
  // nao uma divergencia.
  const divergeDoConteudo = !!(bancoNaive && horarioRelatado && bancoNaive !== horarioRelatado);
  const hash = `${horarioRelatado}|${motivo}|${remarcacao ? 'R' : 'C'}|${descartados.length}|${divergeDoConteudo ? bancoNaive : ''}`;

  // Urgencia por PROXIMIDADE — funciona mesmo sem nenhum sinal de conteudo (ver comentario da funcao).
  let urgente = false;
  if (remarcacao && bancoNaive) {
    const instante = horarioNaiveParaInstante(bancoNaive, TZ_ESCRITORIO);
    if (instante) {
      const horasAteReuniao = (new Date(instante).getTime() - Date.now()) / 3_600_000;
      urgente = Math.abs(horasAteReuniao) <= AGENDAMENTO_URGENCIA_HORAS;
    }
  }

  const atual = db.prepare('SELECT agendamento_pendente_hash FROM conversations WHERE chat_id = ?').get(chatId);
  const hashMudou = atual?.agendamento_pendente_hash !== hash;
  if (!hashMudou && !urgente) return; // nada novo, e a reuniao (se existir) nao esta perto o bastante

  const quando = formatarHorarioEscritorio(horarioRelatado) || 'horário ainda não definido';
  const acao = remarcacao ? 'Reunião NÃO remarcada' : 'Consulta NÃO lançada na agenda';

  try {
    // Telegram para toda mudanca de pendencia (hashMudou), inclusive a pendencia de ROTINA (falta a
    // confirmacao de um dos lados num agendamento novo, sem remarcacao nem horario descartado) — que
    // antes so virava nota, para nao gerar "ruido diario" no Telegram. Agora que a nota some, o
    // Telegram e o unico jeito de a equipe saber; o titulo distingue os tres casos, mas todos avisam.
    // Uma REMARCACAO travada continua o caso mais grave: ja existe reuniao na agenda e ela agora esta
    // no horario errado — foi o que fez o cliente do deal 47543238 esperar sozinho ("Estou aguardando
    // aqui para o horario agendado") com o evento parado no dia velho. Se a pendencia e de remarcacao
    // E a reuniao esta perto (`urgente`), reenvia mesmo com hash igual — a proximidade sozinha ja
    // justifica.
    if (hashMudou || urgente) {
      const titulo = remarcacao
        ? '⚠️ *Reunião NÃO remarcada — agenda com horário velho*'
        : (descartados.length ? '⚠️ *Horário da consulta recusado pela validação*' : `⏳ *${acao}*`);
      await enviarTelegram([
        titulo,
        `Chat: \`${chatId}\``,
        dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
        `Horário relatado na conversa: ${quando}`,
        bancoNaive ? `Agenda atual: ${formatarHorarioEscritorio(bancoNaive)}${divergeDoConteudo ? ' (diferente do que foi comunicado na conversa)' : ''}` : '',
        `Situação: ${descreverPendencia({ motivo })}`,
        // Horario que o modelo devolveu e a rede deterministica recusou (eco da data-ancora, formato
        // com fuso, madrugada). Muda o diagnostico: nao e "o cliente ainda nao respondeu", e "o
        // horario extraido nao servia" — sem isso a equipe procura a confirmacao que ja existe.
        descartados.length ? `Recusado: ${descartados.map((d) => `"${d.valor}" — ${d.motivo}`).join('; ')}` : '',
        urgente && !hashMudou ? '⏰ Reenviando: a reunião está próxima e a pendência continua sem resolver.' : '',
        '',
        remarcacao
          ? 'A reunião que já está na agenda pode estar no horário ANTIGO. Conferir a conversa e remarcar na mão.'
          : 'O evento é criado/movido quando as duas confirmações aparecerem na conversa. Conferir na conversa qual horário foi combinado e marcar na mão se já estiver fechado.',
      ].filter(Boolean).join('\n'));
    }
    if (hashMudou) db.prepare('UPDATE conversations SET agendamento_pendente_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao avisar pendencia de agendamento no deal ${dealId}: ${e.message}`);
  }
}

// Telegram quando a dupla confirmacao ACONTECEU mas a criacao/remarcacao do evento FALHOU de
// verdade (token do Google expirado, erro de rede, quota da API, etc). Ate esta funcao existir,
// esse caminho so gerava um console.error — a equipe nao tinha nenhum jeito de saber que uma
// consulta ja confirmada pelas duas partes nao foi pra agenda. O hash evita repetir o mesmo aviso
// de erro a cada ciclo de 5 min enquanto a causa nao for corrigida (ex: token continuar expirado).
// `naAgendaMoskit` (opcional) so ajusta o texto: a consulta pode ja ter entrado no Moskit mesmo com
// o Google tendo falhado (ver handleAgendamentoCalendar).
async function registrarErroAgendamento(dealId, chatId, mensagemErro, remarcacao, naAgendaMoskit) {
  if (!dealId) return;
  const hash = `${mensagemErro}|${remarcacao ? 'R' : 'C'}`;

  const atual = db.prepare('SELECT agendamento_erro_hash FROM conversations WHERE chat_id = ?').get(chatId);
  if (atual?.agendamento_erro_hash === hash) return;

  const acao = remarcacao ? 'reunião NÃO remarcada' : 'evento NÃO criado';
  try {
    // As duas partes ja combinaram um horario e o evento no Google nao existe (ou nao foi movido) —
    // isso tem que chegar em quem pode marcar na mao, hoje.
    await enviarTelegram([
      `❌ *Consulta confirmada mas NÃO agendada*`,
      `Chat: \`${chatId}\``,
      dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
      `Motivo: ${mensagemErro}`,
      '',
      naAgendaMoskit
        ? `A consulta JÁ ENTROU na agenda do Moskit, mas o evento no Google Calendar/Meet NÃO foi criado. Será tentado de novo automaticamente no próximo reprocessamento.`
        : `Cliente e equipe já confirmaram o horário, mas ${acao} NEM no Google NEM no Moskit. Marcar na mão e verificar a integração.`,
    ].filter(Boolean).join('\n'));
    db.prepare('UPDATE conversations SET agendamento_erro_hash = ? WHERE chat_id = ?').run(hash, chatId);
  } catch (e) {
    console.error(`  ❌ Erro ao anotar FALHA de agendamento no deal ${dealId}: ${e.message}`);
  }
}

// Se o cliente pediu pra remarcar (nova data_hora_consulta diferente da ja salva no evento),
// atualiza o evento existente (so start/end, preserva o link do Meet) em vez de ignorar a mudanca.
async function atualizarEventoSeRemarcado(dealId, dados, chatId, row) {
  const auth = getGoogleAuthClient();
  if (!auth) return;

  // Ja veio saneado de processarConversaDirect (normalizarHorarioNaive/motivoHorarioImplausivel), mas
  // handleAgendamentoCalendar tambem e chamado direto pelos testes e pelo reprocessamento manual —
  // aqui e a ultima linha antes de um PATCH em reuniao de cliente real. Nao pode ser `return` mudo:
  // quem chega aqui tem evento na agenda E dupla confirmacao valida, entao o horario velho continuar
  // no lugar e um erro que precisa aparecer.
  const novoInicioNaive = normalizarHorarioNaive(dados.data_hora_consulta);
  if (!novoInicioNaive) {
    if (dados.data_hora_consulta) {
      console.log(`  ⚠️ remarcacao ignorada: horario invalido ("${dados.data_hora_consulta}")`);
      await registrarErroAgendamento(dealId, chatId, `horario da consulta invalido ("${dados.data_hora_consulta}") — a reuniao na agenda continua no horario anterior`, true);
    }
    return;
  }

  // evento_calendar_data grava sempre a mesma string naive usada no payload (criacao: acima em
  // handleAgendamentoCalendar; atualizacao: mais abaixo) — comparar por igualdade de STRING e mais
  // simples e robusto que reconverter timestamps, e dispensa reler o evento do Google so pra essa
  // checagem (era o `calendar.events.get` + `inicioAtual` que existiam so pra isso).
  if (row?.evento_calendar_data === novoInicioNaive) return; // nao mudou de verdade, evita ruido a cada ciclo

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const novoFimNaive = somarMinutosNaive(novoInicioNaive, 60);
    const patched = await calendar.events.patch({
      calendarId: GOOGLE_CALENDAR_ID,
      eventId: row.evento_calendar_id,
      requestBody: {
        start: { dateTime: novoInicioNaive, timeZone: TZ_ESCRITORIO },
        end: { dateTime: novoFimNaive, timeZone: TZ_ESCRITORIO },
      },
    });

    db.prepare('UPDATE conversations SET evento_calendar_data = ?, agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL WHERE chat_id = ?').run(novoInicioNaive, chatId);

    const dataFormatada = formatarHorarioEscritorio(novoInicioNaive);
    const meetLink = extrairMeetLink(patched.data);
    console.log(`  🔁 Reunião remarcada para ${dataFormatada} (chat ${chatId})`);

    // As duas agendas movem juntas. Sem isto, a agenda do CRM continuaria mostrando o horario velho
    // — pior que nao ter compromisso nenhum la, porque parece certo e esta errado. O guard de
    // "nao mudou de verdade" la em cima ja impede um PUT redundante a cada ciclo.
    if (row?.atividade_moskit_id) {
      await atualizarAtividadeMoskit(row.atividade_moskit_id, horarioNaiveParaInstante(novoInicioNaive, TZ_ESCRITORIO), dealId);
    }

    await notificarTelegramMeet({
      nome: dados.nome,
      telefone: chatId,
      advogado: dados.advogado_responsavel,
      dataHoraTexto: dataFormatada,
      meetLink,
      dealId,
      remarcado: true,
    });
  } catch (e) {
    console.error(`  ❌ Erro ao tentar remarcar evento do chat ${chatId}: ${e.message}`);
    // Mesma logica do erro em criarEventoGoogleCalendar: a remarcacao so chega aqui quando a dupla
    // confirmacao ja aconteceu (podeAgendar=true) — sem nota, a equipe nao sabe que o novo horario
    // nao foi pra agenda e o cliente pode aparecer no horario velho.
    await registrarErroAgendamento(dealId, chatId, e.message, true);
  }
}

// ------------------------------------------------------------
// OpenAI
// ------------------------------------------------------------
const PROMPT_CLASSIFICAR = `
Analise a conversa de WhatsApp e classifique o lead.

CONTEXTO DO CRM: {contextoCrm}

Raciocine passo a passo:
1. O lead demonstrou interesse em contratar servicos juridicos?
2. Ha evidencias de que ele quer agendar ou ja agendou consulta?
3. A conversa parece genuina ou e automatica/spam/numero errado/interna?
4. O lead ja e cliente existente apenas atualizando algo?

Apos raciocinar, retorne APENAS um JSON:
{"classificacao": "criar_negocio", "justificativa": "motivo"}
OU
{"classificacao": "inviavel", "justificativa": "motivo"}

"criar_negocio": lead demonstrou interesse real em contratar. Fez perguntas sobre servicos/honorarios, agendou consulta, explicou o caso juridico. Exemplos abaixo.

"inviavel":
- Spam ou mensagem automatica (ex: "Seu horario foi confirmado")
- Numero errado ("quem e?", "enganou")
- Cliente existente apenas avisando que esta a caminho ou que chegou ("Chego ja na clinica", "Cheguei")
  ATENCAO: isso NAO vale quando o CONTEXTO DO CRM diz que ja existe negocio ou consulta em andamento
  E o cliente esta ACEITANDO ou ALTERANDO um horario ("pode ser", "confirmado", "prefiro sexta").
  Nesse caso classifique "criar_negocio": e exatamente essa mensagem que fecha o agendamento, e
  descarta-la deixa a consulta travada sem a confirmacao do cliente.
  TAMBEM NAO vale quando o CONTEXTO DO CRM diz que o cliente JA FOI ATENDIDO e ele volta contando um
  caso NOVO ou pedindo outra consulta. Cliente antigo com problema novo e o lead mais qualificado que
  existe: classifique "criar_negocio".
- Membro da equipe falando de trabalho interno ("Passa pra Layla", "cria tarefa no astrea")
- Lead dizendo "ja resolvi", "obrigado" sem contexto
- Conversa muito curta/sem contexto (1 msg generica)

EXEMPLOS REAIS:

--- criar_negocio ---
Cliente: "Ola, acessei o site do escritorio e gostaria de uma consulta."
Cliente: "Meu nome e Carlos Eduardo. E sobre meu tio que morreu e deixou uma casa mas ele nao fez testamento e os irmao ta querendo vender sem eu receber nada. Vi o Instagram do Bruno, ele parece entender bem dessas coisas de familia."
Resposta: {"classificacao": "criar_negocio", "justificativa": "lead explicou o caso juridico, mencionou origem (Site + Instagram do Bruno) e pediu consulta"}

--- criar_negocio ---
Cliente: "Cliquei no link da bio no Instagram do Dr. Berto Caballero, gostaria de tratar sobre meu caso. Trabalho no programa mais medicos e tenho 32 meses de atuacao. Estou com um processo sobre abatimento da divida do FIES."
Resposta: {"classificacao": "criar_negocio", "justificativa": "lead veio pelo Instagram do Berto, explicou o caso juridico especifico e demonstrou interesse em contratar"}

--- inviavel (membro da equipe) ---
Cliente: "Passa pra Layla. Rayane, temos que cobrar um valor da Teresinha (despejo). Me lembra amanha."
Cliente: "Pode marcar. Pede logo os contratos e documentos que ele pode enviar."
Resposta: {"classificacao": "inviavel", "justificativa": "conversa interna da equipe do escritorio, nao e um lead"}

--- inviavel (socio/equipe — contato interno) ---
Cliente: "Ola Dr. Berto Igor Caballero (8694231397), so comunicando que o processo da Ana Clara ja esta pronto."
Cliente: "Pode deixar que eu mesmo aviso ela."
Resposta: {"classificacao": "inviavel", "justificativa": "remetente e socio do escritorio falando sobre trabalho interno"}

--- inviavel (cliente existente) ---
Cliente: "Chego ja na clinica"
Cliente: "Estou a caminho"
Cliente: "Ok"
Cliente: "Cheguei"
Resposta: {"classificacao": "inviavel", "justificativa": "cliente existente apenas confirmando horario de consulta, nao e lead novo"}

--- criar_negocio (cliente antigo, caso NOVO) ---
CONTEXTO DO CRM: negocio 48292471 ja existe no CRM; este cliente JA FOI ATENDIDO (consulta em 14/08/2026 15:30)
Cliente: "Doutor, bom dia! Aquela questao do FIES ficou resolvida, obrigado."
Cliente: "Agora apareceu outra coisa: recebi uma notificacao de despejo do imovel que eu alugo, o prazo e de 15 dias. Da pra marcar outra consulta?"
Resposta: {"classificacao": "criar_negocio", "justificativa": "cliente ja atendido voltou com um caso NOVO (despejo) e pediu outra consulta"}

--- inviavel (sem interesse) ---
Cliente: "Obrigado."
Resposta: {"classificacao": "inviavel", "justificativa": "mensagem generica de agradecimento, sem contexto ou interesse"}

Conversa:
{historico}
`;

const PROMPT_EXTRAIR = `
Analise a conversa completa e extraia dados para criar/atualizar um negocio no CRM. Retorne APENAS um JSON valido.

Raciocine passo a passo antes de responder:
1. Esta conversa ja tem um deal no CRM? Se sim, quais campos estao pendentes?
2. Quais campos obrigatorios consigo identificar com confianca?
3. O cliente contou algum fato do caso dele? Se NAO (so saudacao, so pedido de consulta, so o nome de um advogado), area_direito e advogado_responsavel ficam null e o assunto e "Consulta juridica".
4. ATENCAO: advogado_responsavel eh DEFINIDO pela area_direito, NAO por qual socio o lead mencionou.
5. O lead fez pagamento ou enviou comprovante?
6. Qual acao e mais adequada?

CONTEXTO ATUAL:
- Data/hora da ultima mensagem desta conversa: {dataAtual}
- CALENDARIO DE REFERENCIA (consulte esta tabela, NUNCA calcule datas de cabeca):
{calendarioReferencia}
- Deal ja existe no CRM: {temDeal}
- Dados ja extraidos anteriormente: {dadosAnteriores}
- Cliente ja existe no CRM: {infoCliente}

REGRAS DE DECISAO:
- "criar": lead DEMONSTROU interesse + agendou consulta. Crie o deal com TODOS os campos obrigatorios preenchidos e nota com resumo.
- "aguardar": lead NAO marcou/confirmou consulta. So explicando o caso. Nao criar nada.
- "nota": deal JA EXISTE + todos os campos ok. So adicione nota.
- "atualizar_campos": deal EXISTE + algum campo pendente. Devolva o que identificou AGORA e TAMBEM os campos listados como "AINDA PENDENTES" no contexto, se a conversa inteira permitir preenche-los. Nao repita campos que ja estao preenchidos e corretos.
- "ignorar": passou pela classificacao mas nao foi possivel extrair informacoes uteis. Ignorar permanentemente.

CAMPOS OBRIGATORIOS (nunca podem ser null em criar):
1. assunto — tema curto do caso, 2 a 5 palavras (ex: "Inventario", "Usucapiao de imovel", "Abatimento do FIES", "Rescisao de contrato"). E o que aparece no titulo do negocio no CRM, entao seja especifico e direto, sem frase completa. NUNCA deixe null: se o cliente ainda NAO contou o caso, use exatamente "Consulta juridica" — NUNCA use o nome de uma area do direito como assunto (isso transforma um palpite de area no titulo do negocio).
2. origem — SEMPRE preencher, e tente ao MAXIMO identificar antes de desistir. Procure ATIVAMENTE por
   canal de entrada em QUALQUER ponto da conversa, nao so na primeira mensagem: "vi/acessei/segui a
   pagina, o Instagram ou o link da bio do Dr. X" -> Instagram; "vi seu video/reels" -> Youtube;
   "vi/acessei/entrei no site" -> Site; "achei/pesquisei no Google" (busca ativa, nao so a palavra
   "google" solta) -> Site; "li um artigo/uma materia/uma noticia sobre voces" -> Artigo; "vi no
   JusBrasil" -> JusBrasil; "indicacao de [alguem]"/"minha amiga indicou"/"fulano me indicou" ->
   Indicacao de amigos e parentes; "ja fui cliente"/"outro caso com voces" -> Indicacao de clientes;
   "vi um anuncio"/"trafego pago"/"impulsionado" -> VSL - Trafego pago; "cliquei na landing page" ->
   Landing Page. A EQUIPE por vezes pergunta diretamente "como conheceu nosso escritorio?" com uma
   lista numerada de opcoes — a RESPOSTA do cliente a essa pergunta e o sinal MAIS CONFIAVEL que existe
   e tem que ser usada (deal 48317782 ficou "Nao identificado" porque a equipe perguntou "Voce pode
   nos contar como conheceu o nosso escritorio? 1.Indicacao 2.Artigo 3.Instagram 4.Youtube" e o
   cliente respondeu "verifiquei no instagram", e essa resposta nao foi usada). So depois de procurar
   isso na conversa INTEIRA, se nao achar nada, use "Nao identificado" — mas "Nao identificado" so e
   aceitavel quando a conversa REALMENTE nao tem nenhum desses sinais, nunca por nao ter procurado.
3. tipo_consulta — "consulta paga" por padrao. Use "consulta gratis" APENAS se a equipe disser explicitamente que a consulta e cortesia/gratuita/sem custo/isenta. Use "sem consulta" so se o lead disser EXPLICITAMENTE que nao quer contratar.
4. area_direito — Use seu conhecimento juridico para inferir a area A PARTIR DO QUE O CLIENTE CONTOU SOBRE O CASO, e de nada mais. Se ele so cumprimentou, so pediu consulta, so disse por qual canal chegou ou so citou o nome de um advogado ("quero falar com o Dr. Berto"), voce NAO sabe a area: devolva null. E PROIBIDO derivar a area de captacao, de origem, do advogado que o lead mencionou ou dos PERFIS DOS ADVOGADOS abaixo — o caminho e sempre area -> advogado, nunca advogado -> area. Deixar null e o resultado correto e esperado nessa situacao; a area entra numa rodada seguinte, quando o cliente descrever o caso.
   CASO RECORRENTE NESTE ESCRITORIO — FIES: caso envolvendo financiamento estudantil (FIES) — negativa administrativa, transferencia de curso, renegociacao, aditamento, recurso — e SEMPRE "Direito Educacional", mesmo que o cliente nao diga isso com essas palavras (deals 48474073, 48466404, 48464876, 48320992 nasceram com area_direito null porque o modelo nao fez essa ligacao sozinho, apesar do caso estar descrito).
5. advogado_responsavel — Determinado UNICAMENTE pela area_direito, pela TABELA AREA -> ADVOGADO abaixo. Se area_direito estiver null ou incerta, mantenha null. NAO derive do nome do lead ou de qual socio ele mencionou. (O sistema reaplica essa tabela em cima do que voce responder: se divergir, o valor da tabela vence.)
6. captacao — Se mencionou rede social de Berto, Bruno ou Iury, ou foi indicado por um deles, preencha com o nome do socio (INDEPENDENTE de area_direito estar definida). CASO CONTRARIO, preencha com o MESMO valor de advogado_responsavel (que pode ser null se area_direito nao identificada).
7. pagamento_confirmado — boolean. True APENAS se DISSE que pagou OU enviou comprovante. Senao false.

CAMPOS OPCIONAIS (usados pra agendar a reuniao no Google Agenda — deixe null se nao tiver certeza):
8. data_hora_consulta — data/hora ISO 8601 (ex: "2026-07-31T10:00:00") que o cliente CONFIRMOU pra consulta, OU que a equipe do escritorio confirmou ter marcado com o cliente (mensagem "Equipe do escritório:"). Use "Data/hora da ultima mensagem desta conversa" (fornecida no CONTEXTO ATUAL) como referencia (data-ancora) pra resolver dias relativos tipo "sexta de manha", "amanha as 10h", "dia 9 de janeiro" — NUNCA invente uma data se nem o cliente nem a equipe confirmaram um dia/horario especifico. Se so disse "pode ser" sem dia/horario, ou se ainda esta negociando, deixe null.
   SEMPRE RECALCULE: derive a data da CONVERSA + tabela CALENDARIO DE REFERENCIA a cada rodada. NUNCA copie o data_hora_consulta que aparece em "Dados ja extraidos anteriormente" — esse valor pode ter sido calculado errado antes. Se o que voce derivar agora divergir do valor anterior, use o que voce derivou agora.
   ATENCAO AO DIA DA SEMANA: se a conversa citar um dia pelo NOME ("quarta-feira", "na sexta") sem dizer o numero do dia, procure esse dia na tabela CALENDARIO DE REFERENCIA e use a PRIMEIRA ocorrencia DEPOIS da data-ancora. NUNCA calcule de cabeca. Se o dia citado for o mesmo dia da semana da data-ancora, use a ocorrencia da semana seguinte, a nao ser que a mensagem diga "hoje". Exemplo: data-ancora 2026-07-30 (quinta-feira), mensagem diz "quarta-feira" -> a tabela mostra 2026-08-05 = quarta-feira -> use 2026-08-05, NUNCA 2026-08-03.
   ATENCAO A PROPOSTA SEM RESPOSTA: se a ultima mensagem sobre horario for uma PROPOSTA da equipe que o cliente ainda nao aceitou (ex: "Podemos marcar na quarta as 17:30?" e nenhuma resposta depois), NAO troque a data — mantenha o horario ANTERIOR ja confirmado, ou null se nunca houve um.
   ATENCAO AO ANO: o resultado tem que ser uma data no FUTURO em relacao a data-ancora. Se o cliente mencionar so dia e mes (ex: "dia 9 de janeiro", "15 de marco") sem dizer o ano, calcule: se essa data (dia+mes) no ANO da data-ancora ja passou ou eh igual a data-ancora, use o ANO SEGUINTE. Exemplo: data-ancora 2026-07-24, cliente diz "dia 9 de janeiro" → 09/01 no ano 2026 ja passou → use 2027-01-09, NUNCA 2026-01-09.
   FORMATO OBRIGATORIO: exatamente "AAAA-MM-DDTHH:MM:00" — hora do ESCRITORIO, sem "Z" e sem offset, e os segundos SEMPRE "00". Consulta e marcada em minuto redondo e dentro do horario comercial. Se o horario que voce ia devolver tem segundos diferentes de 00, ou cai de madrugada, ele nao veio da conversa: devolva null.
   NUNCA use a data-ancora como resposta. Ela e a hora em que a ULTIMA MENSAGEM foi enviada, nao a hora da consulta. Se a conversa nao diz um dia/horario que as duas partes trataram, o valor correto e null — null e uma resposta certa, a hora da mensagem e sempre errada.
9. email_cliente — email do cliente, APENAS se ele literalmente escreveu um email na conversa. Nunca invente ou derive de outro campo.
10. estagio_funil_sugerido — analise a conversa (incluindo mensagens "Equipe do escritório:") e identifique se houve avanco no funil de vendas alem da consulta paga/agendada. Use null se nao houver sinal claro. Valores possiveis:
   - "aguardando_condicao": a consulta ja aconteceu (equipe ou cliente mencionam que a reuniao/consulta ja ocorreu) e agora esta aguardando retorno/decisao do cliente.
   - "elaboracao_proposta": equipe menciona que vai preparar/enviar uma Proposta de Honorarios pro cliente.
   - "negociacao": cliente reage a proposta discutindo condicoes, valores ou prazos de pagamento dos honorarios.
   - "elaboracao_contrato": condicoes foram fechadas/aceitas e a equipe menciona que vai preparar o contrato.
   - "contrato_enviado": equipe confirma que o contrato foi enviado pro cliente.
   Seja conservador: so sugira um estagio se houver uma frase clara indicando esse avanco. Na duvida, deixe null.
11. modalidade_consulta — "presencial" ou "online". Como a consulta sera realizada, se isso foi mencionado na conversa (ex: cliente ou equipe dizem "presencial", "no escritorio", "pessoalmente" → presencial; "por video", "online", "por chamada" → online). Se nao houver nenhuma indicacao clara, use "online" (padrao — gera link de Google Meet). So use "presencial" se estiver EXPLICITO que sera sem video-chamada.
12. status_negocio_sugerido — null, "ganho" ou "perdido". Eixo DIFERENTE de estagio_funil_sugerido: nao e posicao no funil, e o FECHAMENTO do negocio (o CRM nao deixa reabrir depois). Use APENAS com frase explicita e inequivoca:
   - "ganho": a EQUIPE confirma que o cliente ASSINOU o contrato e o caso esta fechado/o cliente virou cliente ativo do escritorio. "contrato enviado" ou "vamos fechar" NAO bastam — isso e so contrato_enviado.
   - "perdido": a EQUIPE ou o CLIENTE confirmam explicitamente que o negocio NAO vai adiante (cliente desistiu do processo, contratou outro escritorio, recusou a proposta definitivamente, nao quis pagar a consulta).
   Seja MAIS conservador aqui do que em qualquer outro campo: fechar ou perder um negocio errado nao tem volta facil no CRM. Na menor duvida, deixe null.
13. motivo_perda_sugerido — SO preencha se status_negocio_sugerido = "perdido". Frase curta com o motivo, nas palavras da conversa (ex: "fechou com outro escritorio", "achou o valor alto", "desistiu do processo"). Null se status_negocio_sugerido nao for "perdido", ou se nao houver motivo claro.

CAMPOS DO CONTRATO (usados so pra preencher automaticamente o contrato de Prestacao de Servico no ZapSign quando a consulta e agendada — SAO DADOS SENSIVEIS. Extraia APENAS se a pessoa (cliente ou equipe) escreveu literalmente na conversa. NUNCA infira, calcule ou derive CPF/endereco/profissao/estado civil a partir de outro campo, do nome ou de qualquer suposicao — e melhor deixar null do que errar um desses. Deixe null se nao tiver 100% de certeza):
14. cpf — APENAS se o cliente escreveu literalmente o numero do CPF na conversa.
15. profissao — APENAS se o cliente mencionou explicitamente sua profissao.
16. estado_civil — APENAS se mencionado explicitamente ("sou casado", "sou solteira", "divorciado", etc).
17. endereco — APENAS se o cliente escreveu um endereco (rua/numero/bairro/cidade) na conversa.
18. valor_honorarios_inicial — valor em reais (numero, sem "R$") dos honorarios ADVOCATICIOS do CASO negociados pela EQUIPE (proposta de honorarios) — DIFERENTE do valor da consulta (R$350). So preencha se a equipe mencionou um valor especifico de honorarios nesta conversa.
19. valor_honorarios_liminar — idem, valor em reais dos honorarios de LIMINAR, se mencionado pela equipe. Null se nao houver liminar no caso.
20. valor_mensalidade — idem, valor em reais de MENSALIDADE do contrato, se mencionado pela equipe. Null se o contrato nao tiver mensalidade.

OBSERVACOES (obrigatorio — array "observacoes" no nivel raiz do JSON):
Cada linha da conversa comeca com um indice entre colchetes, tipo "[12] Cliente: ...". Relate os fatos abaixo CITANDO o indice da mensagem que prova cada um. O sistema confere a citacao: se o indice nao existir, se o papel de quem falou nao bater com o tipo, ou se o trecho nao aparecer mesmo na mensagem, a observacao e DESCARTADA. Nao invente citacao — observacao descartada e pior que observacao ausente.

Formato de cada item: {"tipo": "...", "msg_idx": 12, "trecho": "pedaco literal da mensagem", "horario_iso": "2026-08-05T17:30:00"}
O campo "trecho" tem que ser copiado LITERALMENTE da mensagem citada (pode ser um pedaco curto dela).
O campo "horario_iso" e OBRIGATORIO em todo tipo que termina em "_horario" — sempre preencha, nunca deixe de fora e nunca escreva texto tipo "quarta que vem". Se a mensagem nao repete o dia/hora (ex: cliente so respondeu "pode ser"), use o horario da proposta a que ela responde.

REGRA DE PAPEL (a que mais causa observacao descartada): o prefixo do tipo tem que bater com o rotulo da linha citada. Linha "[7] Cliente: ..." so aceita tipo comecando com "cliente_". Linha "[7] Equipe do escritório: ..." so aceita tipo comecando com "equipe_". Antes de escrever cada observacao, olhe o rotulo daquele indice e escolha o prefixo por ele — nao pelo conteudo da frase. Um cliente dizendo "consigo sexta as 14h" e "cliente_propos_horario", nunca "equipe_propos_horario".

Tipos permitidos:
- "cliente_descreveu_caso" (mensagem do CLIENTE) — o cliente contou O QUE ACONTECEU ou o que precisa resolver, com algum fato concreto do caso ("meu tio morreu e deixou uma casa sem testamento", "fui exonerada do cargo por motivo de saude", "recebi uma notificacao da ANPD"). Sem horario_iso. NAO valem como descricao do caso: saudacao ("ola", "bom dia"), pedido de consulta sem conteudo ("gostaria de agendar uma consulta"), preferencia de advogado ("quero falar com o Dr. Berto"), canal de origem ("vi seu Instagram") nem pergunta sobre preco. Esta observacao e o que autoriza o sistema a gravar area_direito/advogado_responsavel/assunto: se ninguem descreveu o caso, NAO emita esta observacao e devolva area_direito e advogado_responsavel null.
- "equipe_descreveu_caso" (mensagem da EQUIPE) — a EQUIPE descreveu o caso do cliente na conversa (resumo depois de uma ligacao, "ela quer entrar com acao de remocao por motivo de saude"). Sem horario_iso. Vale como a mesma evidencia do tipo acima. NAO vale a equipe apenas encaminhar o lead para um advogado ("vou passar pro Dr. Berto") — isso nao diz qual e o caso.
- "equipe_anunciou_valor" (mensagem da EQUIPE) — a equipe informou que a consulta tem custo, em qualquer formato: o bloco padrao de condicoes, "a consulta e 350", "o investimento e de trezentos e cinquenta", valor negociado diferente, parcelamento. Sem horario_iso.
- "equipe_propos_horario" (mensagem da EQUIPE) — a equipe SUGERIU um dia/hora, sem fechar ("podemos quarta as 17:30?").
- "equipe_confirmou_horario" (mensagem da EQUIPE) — a equipe afirmou que a consulta ESTA marcada ("marquei sua consulta pra sexta 14h", "ficou confirmado dia 10 as 15h"). Uma PERGUNTA nunca e confirmacao.
- "cliente_propos_horario" (mensagem do CLIENTE) — o cliente sugeriu um dia/hora ("consigo sexta as 14h").
- "cliente_aceitou_horario" (mensagem do CLIENTE) — o cliente ACEITOU explicitamente um dia/hora ja falado ("pode ser", "confirmado", "ok", "fechado", "estarei la"). "vou ver", "te aviso", "acho que sim" NAO sao aceite.
- "cliente_alegou_pagamento" (mensagem do CLIENTE) — o cliente disse que pagou ou enviou comprovante.
- "equipe_declarou_ganho" (mensagem da EQUIPE) — a equipe confirma que o contrato foi ASSINADO e o cliente virou cliente do escritorio ("assinou o contrato", "fechamos com o cliente", "cliente confirmado, vamos iniciar o processo"). Sem horario_iso.
- "equipe_declarou_perdido" (mensagem da EQUIPE) — a equipe confirma que o negocio NAO vai adiante ("cliente desistiu", "nao vamos seguir com esse caso", "ele fechou com outro escritorio"). Sem horario_iso.
- "cliente_declarou_perdido" (mensagem do CLIENTE) — o cliente diz explicitamente que nao vai contratar/seguir ("vou contratar outro advogado", "desisti do processo", "nao quero mais fechar"). Sem horario_iso.

Regras de horario nas observacoes:
- Resolva o horario_iso com a mesma tabela CALENDARIO DE REFERENCIA usada em data_hora_consulta, e com as mesmas regras de dia da semana, de ano, de FORMATO OBRIGATORIO ("AAAA-MM-DDTHH:MM:00", segundos sempre 00) e a proibicao de usar a data-ancora como resposta.
- Se o cliente aceitou uma proposta sem repetir o dia/hora ("pode ser"), use o horario da proposta a que ele respondeu.
- Relate TODAS as ocorrencias, inclusive as antigas e as que se contradizem. O sistema usa a mais recente de cada tipo e sabe detectar sozinho que uma proposta nova reabriu a negociacao — nao tente filtrar nem resumir isso voce.
- REGRA CRITICA: percorra a conversa DE TRAS PRA FRENTE e garanta que a ULTIMA mensagem que menciona dia/hora esteja na lista, seja ela do cliente ou da equipe. Vale mesmo que ela desmarque, adie ou troque um horario que ja estava confirmado antes ("surgiu um imprevisto, consegue na sexta as 16h?"). Omitir essa mensagem faz o sistema agendar num horario que ja foi abandonado — e o pior erro possivel aqui. Se a EQUIPE propuser mais de um horario em sequencia (mesmo com uma mensagem de sistema/edicao entre elas), cada proposta e uma observacao "equipe_propos_horario" propria — nao descarte a anterior nem assuma que a mensagem seguinte repete o mesmo horario. A resposta do cliente vale para a proposta MAIS RECENTE que a precede, mesmo que a resposta nao repita o horario.
- So agendamos na agenda quando o CLIENTE aceitou E a EQUIPE confirmou o MESMO horario. Se so um dos dois falou, relate so o que existe; nao complete o que falta.

INSTRUCOES PARA resumo_atendimento (briefing pre-consulta do advogado):
Escreva um resumo ESPECIFICO e ACIONAVEL, nao generico. Use os fatos concretos que aparecem na conversa: nomes de pessoas ou empresas envolvidas, datas, valores, numero de processo, tipo de documento, prazos, providencias ja tomadas. Evite frases vagas tipo "cliente quer analise do caso" — prefira algo como "cliente foi notificado pela ANPD em 15/03 sobre vazamento de dados de clientes e quer saber se pode ser responsabilizado".
Os seis topicos abaixo sao o VOCABULARIO do resumo, nao um limite de tamanho. Separe os topicos com quebra de linha \n (NAO use "|"). Um topico pode ocupar mais de uma linha quando o caso tem mais a dizer — caso complexo merece resumo longo, e o advogado prefere ler tres linhas sobre o caso a uma linha generica. Topico SEM informacao na conversa e OMITIDO por completo: nao escreva o rotulo, nao escreva "Nao mencionado", "Nada mencionado", "Nao informado" nem nada equivalente. Quem le a nota sabe que topico ausente e topico sem dado, e uma linha de duas palavras so ocupa espaco.
📌 Caso: [o que aconteceu, com os detalhes concretos disponiveis — partes envolvidas, datas, valores, documentos]
📌 Objetivo do cliente: [o que especificamente ele quer resolver, saber ou contratar]
📌 Urgencia/prazo: [prazo, audiencia, notificacao ou data mencionada]
📌 Ja tentou: [acoes anteriores mencionadas pelo cliente]
📌 Pendencias: [o que ainda falta resolver ou o que o advogado deve preparar para a consulta — documentos a pedir, situacao a investigar]
📌 Documentos citados: [documentos, contratos, processos, comprovantes que o cliente citou na conversa]
Regra de ouro: NUNCA invente detalhe que nao esteja na conversa. Leia o que escreveu pensando "com isso o advogado prepara a reuniao?" — cada topico tem que ser util antes da consulta, nao um resumo administrativo do atendimento.

EXEMPLOS REAIS DE CAPTACAO (captacao = quem TROUXE o lead; adv_resp = quem CUIDA da area — podem ser pessoas diferentes):
- "Instagram do Bruno" + area=Familia → origem: Instagram, captacao: Bruno, adv_resp: Bruno
- "link da bio no Instagram do Dr. Berto" + area=Educacional → origem: Instagram, captacao: Berto, adv_resp: Iury (Educacional e do Iury, mesmo o lead tendo vindo pelo Berto)
- "vi a pagina do Bruno" + sem caso descrito → origem: Instagram, captacao: Bruno, adv_resp: null (sem area definida)
- "acessei o site do escritorio" + sem mencao a socio → origem: Site, captacao: [mesmo adv_resp, ou null se adv null]
- "minha prima falou, ela e amiga do escritorio" → origem: Indicacao de amigos e parentes, captacao: [mesmo adv_resp]

CONTRAEXEMPLO (lead que ainda nao contou o caso — caso real que entrou errado no CRM):
Cliente: "Olá!" / "Bom dia!" / "Tudo bem?" / "Gostaria de agendar uma consulta com o Dr. Berto, por videoconferencia."
Resposta correta: area_direito: null, advogado_responsavel: null, assunto: "Consulta juridica", captacao: "Berto", origem: [o canal, se ele disse], modalidade_consulta: "online", observacoes SEM "cliente_descreveu_caso".
ERRADO (foi o que aconteceu e nao pode repetir): area_direito: "LGPD", assunto: "Direito Digital" — deduzidos do perfil do Dr. Berto, sem uma linha sobre o caso. O cliente era servidora publica com caso de remocao por motivo de saude (Direito Administrativo).

Formato de resposta (use dados reais extraidos, nao descricoes):
{
  "acao": "criar",
  "justificativa": "Lead agendou consulta sobre inventario",
  "confianca": 8,
  "observacoes": [
    {"tipo": "cliente_descreveu_caso", "msg_idx": 2, "trecho": "meu pai faleceu e deixou uma casa"},
    {"tipo": "equipe_anunciou_valor", "msg_idx": 4, "trecho": "O valor da consulta é de R$350,00"},
    {"tipo": "equipe_propos_horario", "msg_idx": 7, "trecho": "podemos marcar na quarta às 17:30", "horario_iso": "2026-08-05T17:30:00"},
    {"tipo": "cliente_aceitou_horario", "msg_idx": 8, "trecho": "pode ser", "horario_iso": "2026-08-05T17:30:00"},
    {"tipo": "equipe_confirmou_horario", "msg_idx": 9, "trecho": "marquei sua consulta", "horario_iso": "2026-08-05T17:30:00"}
  ],
  "dados": {
    "nome": "Carlos Eduardo",
    "assunto": "Inventario",
    "origem": "Site",
    "advogado_responsavel": "Bruno",
    "captacao": "Bruno",
    "tipo_consulta": "consulta paga",
    "area_direito": "Direito de Familia",
    "pagamento_confirmado": false,
    "data_hora_consulta": "2026-08-05T17:30:00",
    "email_cliente": null,
    "estagio_funil_sugerido": null,
    "modalidade_consulta": "online",
    "status_negocio_sugerido": null,
    "motivo_perda_sugerido": null,
    "resumo_atendimento": "📌 Caso: pai do cliente faleceu em marco e deixou uma casa no bairro Renascenca, sem testamento.\nOs dois irmaos moram no imovel e ja procuraram um comprador, e o cliente diz que eles se recusam a falar sobre a parte dele na heranca.\nO cliente e o filho mais novo e nao consta na escritura, que esta no nome so do pai.\n📌 Objetivo do cliente: entender seus direitos no inventario e formalizar a partilha antes que os irmaos vendam a casa.\n📌 Pendencias: pedir a certidao de obito e a matricula atualizada do imovel para a consulta; confirmar se ja existe inventario aberto.\n📌 Documentos citados: escritura da casa no nome do pai (o cliente disse que a irma tem a via original).",
    "cpf": null,
    "profissao": null,
    "estado_civil": null,
    "endereco": null,
    "valor_honorarios_inicial": null,
    "valor_honorarios_liminar": null,
    "valor_mensalidade": null
  }
}

Valores permitidos:
- origem: Indicacao de clientes, JusBrasil, Instagram, Artigo, Indicacao de parceiros, Landing Page, Youtube, Site, Indicacao de/ou amigos e parentes, Nao identificado, VSL - Trafego Pago
- tipo_consulta: consulta gratis, consulta paga, sem consulta
- captacao: Berto, Bruno, Iury
- area_direito: Direito Administrativo, Direito Educacional, Direito Imobiliario, Direito Previdenciario, Direito de Familia, Direito do Consumidor, Direito do Trabalho, LGPD, Direito Empresarial, Outros, Solucoes Medicas
- advogado_responsavel: Berto, Bruno ou Iury — sempre pela TABELA AREA -> ADVOGADO abaixo

TABELA AREA -> ADVOGADO (regra do escritorio; e de mao unica, area define advogado e nunca o contrario):
- Direito Administrativo, LGPD                                                              -> Berto
- Direito Imobiliario, Direito de Familia, Direito Empresarial                              -> Bruno
- Solucoes Medicas, Direito Educacional, Direito Previdenciario, Direito do Consumidor,
  Direito do Trabalho                                                                       -> Iury
- Outros                                                                                    -> null (sem responsavel automatico)

PERFIS DOS ADVOGADOS (tabela de mao unica: serve para ir de AREA -> ADVOGADO. NUNCA use no sentido
inverso: o lead mencionar um advogado nao diz nada sobre a area do caso dele):
1. Berto Caballero — Direito Digital (LGPD, crimes digitais, propriedade intelectual) e Direito Administrativo (licitacoes, servidores publicos, concurseiros).
2. Bruno Rocha — Direito Imobiliario (compra/venda, locacao, usucapiao, reintegracao) e Direito de Familia (divorcio, guarda, alimentos, inventario).
3. Iury Carvalho — Solucoes Medicas (defesa de profissionais da saude, erro medico, planos de saude).

Conversa completa:
{historico}
`;

async function classificarConversa(historico, contextoCrm) {
  const prompt = PROMPT_CLASSIFICAR
    .replace('{contextoCrm}', contextoCrm || 'nenhum negocio nem consulta registrados para este contato')
    .replace('{historico}', historico);
  const conteudo = await openaiChat([
    { role: 'system', content: 'Voce e um assistente juridico especializado em qualificacao de leads para escritorio de advocacia. Analise conversas de WhatsApp e decida objetivamente se o lead tem potencial de contratar ou nao. Seja rigoroso: apenas leads com intencao real devem ser classificados como criar_negocio. Responda apenas JSON.' },
    { role: 'user', content: prompt },
  ], 'json');

  if (!conteudo) throw new Error('OpenAI retornou resposta vazia na classificacao.');
  const parsed = JSON.parse(conteudo);
  return parsed;
}

async function extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual) {
  // A lista de pendentes precisa ir SEMPRE, inclusive (principalmente) quando ja existem dados
  // anteriores — senao o modelo nunca fica sabendo que um campo obrigatorio continua vazio e a
  // regra "atualize APENAS o que identificou agora" faz ele ignorar o campo pra sempre.
  const pendentes = camposPendentes(dadosAnteriores);
  // O RESUMO ANTERIOR NAO VAI NO PROMPT, e isto e um conserto medido, nao uma preferencia. A regra
  // "atualize APENAS o que identificou agora" faz o modelo COPIAR o resumo antigo palavra por
  // palavra quando ele esta ali — e com ele vem o formato antigo inteiro. MEDIDO em 02/09/2026 nas
  // MESMAS 40 conversas, com o prompt novo em vigor nas duas rodadas:
  //   com o resumo anterior no prompt : 1,62 literal "nao mencionado" por resumo, mediana 300 chars
  //   sem o resumo anterior no prompt : 0    literais,                            mediana 466 chars
  // Ou seja: enquanto o texto velho viajava junto, TODA melhoria de prompt era invisivel para
  // conversa que ja tinha last_data — que e justamente o caso de refrescarBriefingsPertoDaConsulta,
  // o briefing que o advogado le minutos antes da consulta. Os OUTROS campos continuam indo (sao
  // dado, e o modelo precisa deles para nao reabrir o que ja foi decidido); so a narrativa e
  // reescrita do zero a cada rodada. Se o modelo devolver resumo null, mergeDados preserva o antigo
  // do banco como sempre — `dadosAnteriores` segue intacto fora daqui.
  const anterioresParaPrompt = dadosAnteriores ? { ...dadosAnteriores } : null;
  if (anterioresParaPrompt) delete anterioresParaPrompt.resumo_atendimento;
  const contextoAnteriores = anterioresParaPrompt
    ? `${JSON.stringify(anterioresParaPrompt)}\n- Campos obrigatorios AINDA PENDENTES (preencha estes se a conversa permitir, mesmo que nao tenham sido mencionados agora): ${pendentes.length ? pendentes.join(', ') : 'nenhum'}\n- O resumo_atendimento anterior NAO esta acima de proposito: reescreva-o do zero a partir da conversa, sem copiar texto de rodada passada.`
    : `{ "pendentes": "${pendentes.join(', ')}" }`;
  const prompt = PROMPT_EXTRAIR
    .replace('{historico}', historico)
    .replace('{temDeal}', temDeal ? 'sim' : 'nao')
    .replace('{calendarioReferencia}', montarReferenciaDeDatas(dataAtual || new Date().toISOString()))
    .replace('{dadosAnteriores}', contextoAnteriores)
    .replace('{infoCliente}', infoCliente || 'Nao')
    .replace('{dataAtual}', descreverAncora(dataAtual || new Date().toISOString()));
  const conteudo = await openaiChat([
    { role: 'system', content: 'Voce e um analista juridico especializado em extracao de dados de conversas de WhatsApp para leads de escritorio de advocacia. Extraia APENAS informacoes que voce tem CERTEZA. Nao invente. Se nao tiver certeza de um campo, deixe como null (a nao ser que a regra diga o contrario). Responda apenas JSON.' },
    { role: 'user', content: prompt },
  ], 'json');

  if (!conteudo) throw new Error('OpenAI retornou resposta vazia.');
  const parsed = JSON.parse(conteudo);
  return parsed;
}

// ------------------------------------------------------------
// Timers e fila de processamento (via processo filho)
// ------------------------------------------------------------
const timers = {};
const CHILD_LOCK_FILE = path.join(TEMP_DIR, 'worker.lock');
const DEPLOY_LOCK_FILE = path.join(TEMP_DIR, 'deploy.lock');

// atrasoMs existe pra que sincronizarConversas nao precise mexer em `timers` na mao — era assim que
// ela vazava timer, atribuindo direto sem o clearTimeout de baixo.
function agendarProcessamento(chatId, atrasoMs = TEMPO_INATIVIDADE_MS) {
  if (process.env.WORKER_MODE) return; // worker nao se auto-agenda
  if (timers[chatId]) clearTimeout(timers[chatId]);
  timers[chatId] = setTimeout(() => processarConversa(chatId), atrasoMs);
}

function pidEstaAtivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // processo existe mas sem permissao de sinal — ainda ativo
  }
}

// Retorna true se ja existe um worker rodando de verdade.
// Se a trava for orfa (pid gravado nao existe mais), remove e libera pra um novo worker.
function workerJaRodando() {
  if (!fs.existsSync(CHILD_LOCK_FILE)) return false;
  const pid = Number(fs.readFileSync(CHILD_LOCK_FILE, 'utf8').trim());
  if (pidEstaAtivo(pid)) return true;
  console.log(`  ⚠️ worker.lock orfao (pid ${pid} nao existe mais) — liberando fila`);
  try { fs.unlinkSync(CHILD_LOCK_FILE); } catch {}
  return false;
}

// Mesma logica de workerJaRodando(), pro processo de auto-deploy (deploy.js) — evita disparar
// dois deploys em paralelo quando o GitHub reentrega o mesmo push (retry de webhook).
function deployJaRodando() {
  if (!fs.existsSync(DEPLOY_LOCK_FILE)) return false;
  const pid = Number(fs.readFileSync(DEPLOY_LOCK_FILE, 'utf8').trim());
  if (pidEstaAtivo(pid)) return true;
  console.log(`  ⚠️ deploy.lock orfao (pid ${pid} nao existe mais) — liberando`);
  try { fs.unlinkSync(DEPLOY_LOCK_FILE); } catch {}
  return false;
}

function processarConversa(chatId) {
  // Worker: processar diretamente
  if (process.env.WORKER_MODE) {
    processarConversaDirect(chatId).catch(e => console.error(`❌ Worker ${chatId}:`, e.message));
    return;
  }

  // Servidor: salvar na fila e disparar worker
  delete timers[chatId];

  enfileirar(chatId);

  if (workerJaRodando()) return;

  const child = require('child_process').spawn(process.execPath, [
    path.join(__dirname, 'worker.js'),
  ], {
    stdio: 'inherit',
    detached: false,
  });

  try { fs.writeFileSync(CHILD_LOCK_FILE, String(child.pid)); } catch (e) {
    console.error(`  ⚠️ nao consegui gravar worker.lock: ${e.message}`);
  }

  child.on('exit', () => {
    try { fs.unlinkSync(CHILD_LOCK_FILE); } catch {}
  });
}

// Fim de ciclo comum aos tres ramos que escrevem (criar / nota / atualizar_campos).
//
// Estas quatro operacoes estavam COPIADAS nos tres ramos, e foi essa triplicacao que produziu os
// dois piores bugs desta semana: o ramo "nota" nao chamava atualizarNegocioMoskit (a virada de
// cobranca nao chegava ao CRM) e o ramo "criar" tinha uma verificacao de deal incompleta. Com um
// lugar so, corrigir passa a valer para os tres de uma vez.
async function finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, resumo, obsValidas, mensagens }) {
  // Antes de qualquer outra consequencia: se algum campo de classificacao ficou vazio porque a IA
  // inventou um valor que nao existe no CRM, isso precisa aparecer para a equipe.
  await registrarOpcoesInvalidas(dealId, chatId, detectarOpcoesInvalidas(dadosMesclados || dados));

  const resultadoPagamento = await handlePagamentoConfirmado(dealId, dados, chatId);
  await handleAgendamentoCalendar(
    dealId, dadosMesclados, chatId, resultadoPagamento.verificadoPorComprovante, row, apuracao, mensagens
  );

  if (dados.estagio_funil_sugerido) {
    await moverEstagioSeAvancar(dealId, dados.estagio_funil_sugerido);
  }

  // Fechamento (ganho/perdido) so DEPOIS do avanco de estagio: um mesmo ciclo com "contrato
  // assinado" + "ganho" deve deixar o deal ja no estagio final antes de fechar, nao fechado no meio
  // do funil.
  if (dados.status_negocio_sugerido) {
    const nomeFechamento = dadosMesclados?.nome || dados?.nome || row?.contact_name || 'nao informado';
    await fecharNegocioSeAplicavel(dealId, dados.status_negocio_sugerido, dados.motivo_perda_sugerido, obsValidas, nomeFechamento, chatId);
  }

  // Sempre persiste o deal_id — o ramo "nota" usava um UPDATE que nao gravava esse campo.
  stmtFinalizarCiclo.run(dealId, JSON.stringify(dadosMesclados), acao, chatId);
  console.log(`  ✅ ${resumo}`);
}

// ------------------------------------------------------------
// Cliente que volta: abertura do segundo atendimento
// ------------------------------------------------------------
// Os prepares abaixo sao PREGUICOSOS, e isso nao e estilo: as colunas de atendimento entram por
// ALTER TABLE dentro de try {} catch {} como todo o boot, e um prepare no carregamento do modulo
// transformaria esse catch numa armadilha — migracao falhando por qualquer motivo que nao "coluna ja
// existe" (disco cheio, banco travado, arquivo corrompido) mataria o require com "no such column", o
// processo sairia com exit 1 e o pm2 entraria em loop de restart: WhatsApp, agenda e CRM fora do ar
// por causa de uma funcionalidade que nasce DESLIGADA. Mesmo motivo de stmtNotaPorAnexoToken().
let _stmtAbrirAtendimento = null;
function stmtAbrirAtendimento() {
  if (!_stmtAbrirAtendimento) {
    // Uma UPDATE so: o estado do atendimento anterior tem que sair inteiro ou nao sair. Meia limpeza
    // (deal_id novo com bloco_condicoes_enviado antigo) e pior que nenhuma — a consulta nova nasceria
    // paga sem a equipe ter mandado bloco nenhum.
    _stmtAbrirAtendimento = db.prepare(`
      UPDATE conversations SET
        atendimento_inicio_msg_idx = ?, atendimento_num = ?, deals_anteriores = ?,
        retorno_aviso_hash = NULL,
        deal_id = NULL, last_data = NULL, last_action = 'aguardar',
        bloco_condicoes_enviado = 0, bloco_condicoes_msg_idx = NULL,
        evento_calendar_criado = 0, evento_calendar_id = NULL, evento_calendar_data = NULL,
        atividade_moskit_id = NULL,
        contrato_zapsign_criado = 0, contrato_zapsign_doc_token = NULL, contrato_zapsign_status = NULL,
        contrato_zapsign_pendente_hash = NULL, contrato_zapsign_erro_hash = NULL,
        custom_fields_bot = NULL, campos_travados = NULL,
        briefing_added = 0, briefing_hash = NULL, briefing_versao = 0, briefing_refresh_para = NULL,
        campos_nota_hash = NULL,
        agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL, agendamento_apuracao = NULL,
        agendamento_divergencia_hash = NULL, agendamento_pendencia_avisada = NULL,
        opcao_invalida_hash = NULL,
        vinculo_falhas = 0, vinculo_desistiu = 0, vinculo_backoff_ate = NULL, vinculo_aviso_hash = NULL,
        last_processed_at = datetime('now')
      WHERE chat_id = ?
    `);
  }
  return _stmtAbrirAtendimento;
}

let _stmtRetornoAvisoHash = null;
function stmtRetornoAvisoHash() {
  if (!_stmtRetornoAvisoHash) {
    _stmtRetornoAvisoHash = db.prepare('UPDATE conversations SET retorno_aviso_hash = ? WHERE chat_id = ?');
  }
  return _stmtRetornoAvisoHash;
}

let _stmtNotaReuniaoDoDeal = null;
function stmtNotaReuniaoDoDeal() {
  if (!_stmtNotaReuniaoDoDeal) {
    _stmtNotaReuniaoDoDeal = db.prepare(
      "SELECT assunto FROM notas_reuniao WHERE deal_id = ? AND estado = 'CONCLUIDO' ORDER BY criado_em DESC LIMIT 1"
    );
  }
  return _stmtNotaReuniaoDoDeal;
}

// Janela do atendimento atual. Coluna ausente (migracao que nao rodou) vira 0 — a conversa inteira,
// que e exatamente o comportamento de antes desta funcionalidade existir.
function janelaAtendimento(row) {
  const i = Number(row?.atendimento_inicio_msg_idx);
  return Number.isFinite(i) && i > 0 ? i : 0;
}

function lerDealsAnteriores(row) {
  try {
    const lista = JSON.parse(row?.deals_anteriores || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

// A consulta deste atendimento ja aconteceu? Duas fontes locais, zero rede (ver
// src/cliente-retorno.js). A segunda e a nota do Gemini: ela so existe se a reuniao ocorreu de fato, e
// cobre a consulta marcada direto no CRM, que nunca passou por evento_calendar_data.
function consultaDoAtendimento(row) {
  let notaReuniaoEm = null;
  if (row?.deal_id) {
    try {
      const nota = stmtNotaReuniaoDoDeal().get(row.deal_id);
      const parsed = nota?.assunto ? notasReuniao.parseAssuntoGemini(nota.assunto) : null;
      // O assunto do Gemini traz a DATA da reuniao, sem hora — entao vale o FIM do dia do escritorio.
      // Cortar mais tarde no maximo perde um retorno; cortar mais cedo abriria negocio novo no meio de
      // um atendimento ainda em curso, que e o erro caro.
      if (parsed?.dataIso) notaReuniaoEm = `${parsed.dataIso}T23:59:59`;
    } catch {}
  }
  return clienteRetorno.consultaJaRealizada({
    eventoCalendarData: row?.evento_calendar_data || null,
    notaReuniaoEm,
    agora: new Date().toISOString(),
    timeZone: TZ_ESCRITORIO,
    folgaHoras: RETORNO_FOLGA_HORAS,
  });
}

// Mesma pergunta de consultaDoAtendimento, mas para quem so tem o dealId — autorizacaoParaAgendar e
// chamada por sincronizarAtividadesMoskit/backfillMeetLinks, que nunca tem a linha de `conversations`
// em maos. `conversations.deal_id` e o mesmo dealId quando a conversa passou pelo bot; sem linha
// nenhuma (Atividade nativa, sem chat) sobra so a nota do Gemini, que consultaDoAtendimento ja sabe
// ler pelo deal_id.
function consultaJaRealizadaPorDeal(dealId) {
  let eventoCalendarData = null;
  if (dealId) {
    try {
      eventoCalendarData = db.prepare('SELECT evento_calendar_data FROM conversations WHERE deal_id = ?').get(dealId)?.evento_calendar_data || null;
    } catch {}
  }
  return consultaDoAtendimento({ deal_id: dealId, evento_calendar_data: eventoCalendarData });
}

// Todas as reunioes conhecidas de um deal — a ATUAL (reuniao_num + evento_calendar_data da linha em
// `conversations`) mais as ja arquivadas em reunioes_anteriores — no formato que
// reuniaoRetorno.numeroDaReuniao espera: [{numero, horarioIso}]. Usado pela rotina de notas de
// reuniao pra descobrir a qual reuniao um e-mail do Gemini se refere, pela DATA do assunto.
function reunioesConhecidasDoDeal(dealId) {
  if (!dealId) return [];
  let linha;
  try {
    linha = db.prepare('SELECT reuniao_num, evento_calendar_data, reunioes_anteriores FROM conversations WHERE deal_id = ?').get(dealId);
  } catch {
    return [];
  }
  if (!linha) return [];
  const lista = lerReunioesAnteriores(linha).map((r) => ({ numero: r.numero, horarioIso: r.horarioIso }));
  lista.push({ numero: Number(linha.reuniao_num) || 1, horarioIso: linha.evento_calendar_data || null });
  return lista;
}

function textoConsultaAnterior(retorno) {
  const naive = retorno?.consulta?.quando ? instanteParaNaiveLocal(retorno.consulta.quando) : null;
  return formatarHorarioEscritorio(naive) || 'data desconhecida';
}

// Dedup por LINHA, nao por texto: o mesmo veredito volta a cada ciclo enquanto a conversa nao mudar, e
// um aviso repetido a cada 5 min afoga justamente o caso que importa (a mesma licao de
// agendamento_pendente_hash e vinculo_aviso_hash).
async function avisarRetornoUmaVez({ chatId, row, retorno, telegrama }) {
  const hash = crypto.createHash('sha1')
    .update([retorno.decisao, retorno.motivo, retorno.consulta?.quando || '', retorno.assuntoNovo || '', String(row?.deal_id || '')].join('|'))
    .digest('hex');
  if (row?.retorno_aviso_hash === hash) {
    console.log('  ⏭️ aviso de retorno identico ao ultimo — nao repetido');
    return false;
  }
  if (telegrama) await enviarTelegram(telegrama);
  try { stmtRetornoAvisoHash().run(hash, chatId); } catch (e) { console.error(`  ⚠️ nao gravei retorno_aviso_hash: ${e.message}`); }
  return true;
}

// Abre o atendimento NOVO: empilha o negocio atual em deals_anteriores, corta a janela de mensagens e
// zera todo o estado herdado. NAO cria o negocio novo aqui, de proposito — nesta rodada a IA leu o
// historico do caso ANTIGO, e o que ela extraiu esta contaminado por ele. Quem cria e o ciclo seguinte,
// com a janela limpa; por isso a conversa e reagendada em vez de ficar esperando mensagem nova.
//
// Devolve true quando o atendimento foi realmente aberto (o ciclo atual precisa parar ali).
async function abrirNovoAtendimento({ chatId, row, retorno, dados, dadosAnteriores }) {
  const consultaTexto = textoConsultaAnterior(retorno);
  const numero = (Number(row?.atendimento_num) || 1) + 1;
  const assuntoAntigo = retorno.assuntoAnterior || 'não identificado';
  const assuntoNovo = retorno.assuntoNovo || 'não identificado ainda';
  const porque = clienteRetorno.descreverMotivo(retorno.motivo);
  const quem = dados?.nome || dadosAnteriores?.nome || row?.contact_name || 'nao informado';

  const telegrama = [
    '🔁 *Cliente de retorno*',
    `Cliente: ${quem} (\`${chatId}\`)`,
    `Consulta anterior: ${consultaTexto}`,
    `Negócio anterior: \`${row?.deal_id}\` — ${assuntoAntigo}`,
    `Caso novo: ${assuntoNovo} (${porque})`,
    '',
    CLIENTE_RETORNO_DRY_RUN
      ? '🤖 [dry-run] nada foi alterado — o atendimento novo NÃO foi aberto.'
      : `${numero}º atendimento aberto. O negócio novo é criado no próximo ciclo; o anterior fica intacto.`,
  ].join('\n');

  if (CLIENTE_RETORNO_DRY_RUN) {
    console.log(`  🤖 [dry-run] abriria o ${numero}o atendimento (corte na msg ${retorno.corteMsgIdx}, ${porque}) — nada gravado`);
    await avisarRetornoUmaVez({ chatId, row, retorno, telegrama });
    return false;
  }

  const anteriores = lerDealsAnteriores(row);
  anteriores.push({
    deal_id: row.deal_id,
    assunto: retorno.assuntoAnterior || null,
    area: dadosAnteriores?.area_direito || null,
    consulta_em: retorno.consulta?.quando || null,
    encerrado_em: new Date().toISOString(),
  });

  stmtAbrirAtendimento().run(retorno.corteMsgIdx, numero, JSON.stringify(anteriores), chatId);
  console.log(`  🔁 ${numero}o atendimento aberto para ${chatId} — corte na msg ${retorno.corteMsgIdx} (${porque}); negocio ${row.deal_id} preservado`);

  // O Telegram avisa a equipe; o corte em si nao vira nota no negocio (a acao ja foi concluida com
  // sucesso — quem quiser o historico tem deals_anteriores e o Telegram).
  try { await enviarTelegram(telegrama); } catch (e) { console.error(`  ⚠️ Telegram de retorno falhou: ${e.message}`); }

  // Conversa muda NUNCA e reprocessada por conta propria (nada aqui reprocessa so porque o tempo
  // passou): sem este reagendamento o atendimento novo ficaria aberto e vazio ate o cliente escrever.
  if (process.env.WORKER_MODE) {
    try { enfileirar(chatId); } catch (e) { console.error(`  ⚠️ nao consegui enfileirar ${chatId}: ${e.message}`); }
  } else {
    agendarProcessamento(chatId, RETORNO_REPROCESSO_MS);
  }
  return true;
}

// ------------------------------------------------------------
// Reuniao de retorno: abertura da 2a+ reuniao do MESMO caso
// ------------------------------------------------------------
// Prepare preguicoso, mesmo motivo de stmtAbrirAtendimento/stmtNotaPorAnexoToken: as colunas de
// reuniao entram por ALTER TABLE dentro de try {} catch {} no boot, e um prepare no carregamento do
// modulo transformaria esse catch numa armadilha.
let _stmtAbrirNovaReuniao = null;
function stmtAbrirNovaReuniao() {
  if (!_stmtAbrirNovaReuniao) {
    _stmtAbrirNovaReuniao = db.prepare(`
      UPDATE conversations SET
        reuniao_num = ?, reunioes_anteriores = ?,
        evento_calendar_criado = 0, evento_calendar_id = NULL, evento_calendar_data = NULL,
        atividade_moskit_id = NULL,
        briefing_added = 0, briefing_hash = NULL, briefing_versao = 0, briefing_refresh_para = NULL,
        agendamento_pendente_hash = NULL, agendamento_erro_hash = NULL,
        agendamento_divergencia_hash = NULL, agendamento_pendencia_avisada = NULL
      WHERE chat_id = ?
    `);
  }
  return _stmtAbrirNovaReuniao;
}

function lerReunioesAnteriores(row) {
  try {
    const lista = JSON.parse(row?.reunioes_anteriores || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

// Abre a reuniao NOVA no MESMO negocio: arquiva a reuniao atual (evento/Atividade) em
// reunioes_anteriores e zera o estado do compromisso, para o ciclo em curso continuar e criar o
// evento/Atividade/briefing novos, numerados como "Retorno N" (ver src/reuniao-retorno.js).
//
// Ao contrario de abrirNovoAtendimento (caso NOVO, negocio diferente), esta reuniao e sobre o MESMO
// caso: deal_id, bloco_condicoes_enviado, contrato_zapsign_*, custom_fields_bot/campos_travados e
// last_data continuam intocados de proposito — nada aqui muda a classificacao do negocio.
//
// Uma UPDATE so, mesmo motivo de stmtAbrirAtendimento: meia limpeza (Atividade nova apontando pro
// evento_calendar_id antigo, por exemplo) e pior que nenhuma.
function abrirNovaReuniao(chatId, row) {
  const numeroAnterior = Number(row?.reuniao_num) || 1;
  const numeroNovo = numeroAnterior + 1;
  const anteriores = lerReunioesAnteriores(row);
  anteriores.push({
    numero: numeroAnterior,
    horarioIso: row?.evento_calendar_data || null,
    evento_id: row?.evento_calendar_id || null,
    atividade_id: row?.atividade_moskit_id || null,
    encerrada_em: new Date().toISOString(),
  });
  stmtAbrirNovaReuniao().run(numeroNovo, JSON.stringify(anteriores), chatId);
  return numeroNovo;
}

// ------------------------------------------------------------
// Pipeline principal
// ------------------------------------------------------------
async function processarConversaDirect(chatId) {
  delete timers[chatId];

  try {
    const row = stmtGet.get(chatId);
    if (!row) {
      console.log(`  ⏭️ processarConversa: ${chatId} nao encontrado no banco`);
      return;
    }

    const mensagens = JSON.parse(row.messages);
    if (mensagens.length === 0) {
      console.log(`  ⏭️ processarConversa: ${chatId} sem mensagens`);
      return;
    }

    console.log(`\n🔰 Processando ${chatId} (${mensagens.length} msgs acumuladas)`);

    const temDeal = !!row.deal_id;
    const dadosAnteriores = row.last_data ? JSON.parse(row.last_data) : null;
    const phone = row.phone || extrairTelefone(chatId);
    const phoneClean = chaveConversa(phone) || chaveConversa(chatId);

    // Safety: ignorar socios/equipe. Marca a conversa como resolvida para que ela pare de aparecer
    // em stmtGetPending a cada boot — as 5 conversas internas eram reenfileiradas indefinidamente.
    if (ehInterno(phoneClean) || ehInterno(chatId)) {
      console.log(`  ⏭️ numero interno (equipe/socio) — ignorando permanentemente`);
      // Preserva o que ja tinha sido classificado antes (dadosAnteriores) — nao ha extracao nova
      // nesta rodada pra mesclar. MEDIDO em 21/08/2026 (deal 48222273): gravar `{}` aqui apagava a
      // classificacao valida de uma rodada anterior so porque o numero passou a bater em TEAM_PHONES,
      // mesmo sem nenhuma evidencia nova que justificasse a perda.
      stmtUpdateProcessed.run(JSON.stringify(dadosAnteriores || {}), 'interno', chatId);
      return;
    }

    // Buscar info do cliente no Moskit
    const contatoMoskit = stmtMoskitGet.get(phoneClean);
    const infoCliente = contatoMoskit ? `Sim — ${contatoMoskit.name}` : 'Nao';

    // JANELA DO ATENDIMENTO. Cliente que ja foi atendido e voltou com um caso novo continua nesta
    // MESMA linha (uma por chat_id, para sempre), e a fronteira gravada por abrirNovoAtendimento e o
    // que impede o atendimento novo de herdar o caso e a cobranca do anterior. Sem coluna (ou sem
    // migracao) o corte e 0, que e a conversa inteira — o comportamento de antes desta funcionalidade.
    // Os indices seguem ABSOLUTOS: e por eles que src/evidencia.js confere `mensagens[msg_idx]`.
    const inicioAtendimento = janelaAtendimento(row);
    if (inicioAtendimento > 0) {
      console.log(`  🔁 ${row.atendimento_num || 2}o atendimento desta conversa — lendo a partir da msg ${inicioAtendimento} de ${mensagens.length}`);
    }

    const historico = montarHistorico(mensagens, { inicio: inicioAtendimento });

    // CHECKPOINT da cobranca. Calculado uma vez e passado pra todos os payloads desta rodada
    // (ver montarPayloadMoskit). `viradaCobranca` marca a rodada em que o bloco apareceu pela
    // primeira vez — e nela que um deal ja criado como cortesia precisa ser corrigido pra R$350.
    // A janela e o que faz a cobranca recomecar do zero no atendimento novo: sem ela, o bloco que a
    // equipe mandou no atendimento ANTERIOR tornaria a consulta nova paga sem ninguem ter cobrado.
    const bloco = detectarBlocoCondicoes(mensagens, { inicio: inicioAtendimento });
    const blocoJaRegistrado = row.bloco_condicoes_enviado === 1;
    const viradaCobranca = bloco.enviado && !blocoJaRegistrado;
    // chatId viaja no mesmo objeto porque criarNegocioMoskit/atualizarNegocioMoskit precisam saber
    // ONDE registrar a autoria dos campos personalizados (custom_fields_bot/campos_travados), e todos
    // os ramos — inclusive aplicarViradaCobranca e garantirDealExiste — ja repassam `opcoesPayload`.
    const opcoesPayload = { condicoesValorEnviadas: bloco.enviado, chatId };

    if (viradaCobranca) {
      db.prepare('UPDATE conversations SET bloco_condicoes_enviado = 1, bloco_condicoes_msg_idx = ? WHERE chat_id = ?').run(bloco.msgIdx, chatId);
      console.log(`  💳 Checkpoint: bloco de condicoes detectado na msg ${bloco.msgIdx} (${bloco.motivo}, valor=${bloco.marcadores.valor} estrutura=${bloco.marcadores.estrutura}) — consulta e PAGA`);
      // Antes da classificacao de proposito: mesmo que esta rodada acabe como "inviavel" ou
      // "aguardar", o deal ja existente precisa ser corrigido de cortesia pra paga.
      await aplicarViradaCobranca(chatId, row, dadosAnteriores, opcoesPayload, phone);
    } else if (!bloco.enviado) {
      const anexos = contarAnexosIlegiveisEquipe(mensagens, { inicio: inicioAtendimento });
      console.log(`  🆓 Checkpoint: bloco de condicoes nunca enviado — tratando como cortesia${anexos ? ` (⚠️ ${anexos} anexo(s) da equipe ilegivel(is))` : ''}`);
    }

    // Etapa 1: Classificar
    console.log('  Classificando lead...');
    // Sem este contexto, a regra "cliente existente so confirmando horario => inviavel" descartava a
    // propria mensagem que fecha a dupla confirmacao, e a conversa parava antes da extracao.
    // A consulta ja realizada entra no contexto porque a regra "cliente existente so avisando que
    // chegou => inviavel" engolia justamente o cliente antigo trazendo um caso NOVO — que e o lead
    // mais qualificado que existe (ver src/cliente-retorno.js).
    const consultaAnterior = consultaDoAtendimento(row);
    const contextoCrm = [
      temDeal ? `negocio ${row.deal_id} ja existe no CRM` : 'nenhum negocio criado ainda',
      row.evento_calendar_criado ? 'consulta JA lancada na agenda' : 'consulta ainda NAO lancada na agenda',
      consultaAnterior.realizada ? `este cliente JA FOI ATENDIDO (consulta em ${textoConsultaAnterior({ consulta: consultaAnterior })})` : '',
    ].filter(Boolean).join('; ');
    const classificacao = await classificarConversa(historico, contextoCrm);
    console.log('  Classificacao:', JSON.stringify(classificacao));

    if (classificacao.classificacao === 'inviavel') {
      console.log(`  ⏭️ Inviavel (${classificacao.justificativa}) — ignorando`);
      // Preserva dadosAnteriores pelo mesmo motivo do ramo 'interno' acima: classificarConversa roda
      // ANTES de extrairDadosAtendimento, entao nao ha `dados` novo nenhum nesta rodada — so a
      // conclusao de que esta rodada especifica nao vale a pena extrair. Uma classificacao boa de uma
      // rodada anterior (ex.: origem via "pagina do socio", PADROES_SOCIO abaixo) nao pode ser apagada
      // so porque uma mensagem TRIVIAL depois ("obrigado!", "ok") foi julgada inviavel. MEDIDO em
      // 21/08/2026: 12 dos 29 deals afetados por este bug ainda tinham o sinal de origem na conversa,
      // perdido so porque esta linha gravava `{}` sem condicao.
      stmtUpdateProcessed.run(JSON.stringify(dadosAnteriores || {}), 'inviavel', chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      return;
    }

    // Etapa 2: Extrair (apenas para criar_negocio)
    console.log('  Chamando OpenAI para extracao...');
    const dataAtual = mensagens[mensagens.length - 1]?.timestamp || new Date().toISOString();
    const result = await extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual);
    console.log('  OpenAI respondeu:', JSON.stringify(result));

    let acao = result.acao;
    const justificativa = result.justificativa || '';
    const dados = result.dados || {};

    // Valida as observacoes contra as mensagens reais ANTES de deixar qualquer uma influenciar a
    // agenda. Observacao que cita indice inexistente, papel errado ou trecho inventado e descartada.
    // `mensagens` INTEIRO, sempre: e o array contra o qual msg_idx faz sentido. O filtro da janela vem
    // depois — o modelo nao viu as mensagens do atendimento anterior, entao citar uma delas e sinal de
    // indice chutado, e uma confirmacao de horario da consulta passada nao pode reabrir agendamento no
    // atendimento novo.
    const { validas: obsTodas, rejeitadas: obsRejeitadas } = validarObservacoes(result.observacoes, mensagens);
    const obsValidas = inicioAtendimento > 0 ? obsTodas.filter((o) => o.msg_idx >= inicioAtendimento) : obsTodas;
    for (const o of obsTodas) {
      if (!obsValidas.includes(o)) console.log(`  🚫 observacao fora da janela do atendimento (msg ${o.msg_idx} < ${inicioAtendimento}): ${o.tipo}`);
    }
    for (const r of obsRejeitadas) {
      console.log(`  🚫 observacao descartada (${r.motivo}): ${JSON.stringify(r.obs)}`);
    }
    for (const o of obsValidas) {
      if (o._dataCorrigida) {
        console.log(`  🗓️ horario_iso corrigido (dia relativo "hoje/amanha/depois de amanha" batido contra o timestamp da msg ${o.msg_idx}): "${o._dataCorrigida}" → "${o.horario_iso}"`);
      }
      if (o._horarioImplausivel) {
        console.log(`  🚫 horario_iso descartado na msg ${o.msg_idx} — ${o._horarioImplausivel.motivo}`);
      }
      if (o._propagacaoRecusada) {
        console.log(`  🚫 propagacao de dia recusada na msg ${o.msg_idx} — ${o._propagacaoRecusada.motivo}`);
      }
    }

    // A mesma rede deterministica das observacoes, agora no campo solto do modelo.
    // data_hora_consulta NAO passa por validarObservacoes, e e por ele que o eco da data-ancora
    // chegou na agenda do deal 48407621 (valor gravado: "2026-08-07T20:19:05.000Z", que e a hora de
    // envio da ultima mensagem). Continua valendo pra remarcacao: atualizarEventoSeRemarcado le este
    // campo, nao apuracao.horarioIso.
    if (dados.data_hora_consulta) {
      const motivo = motivoHorarioImplausivel(dados.data_hora_consulta, dataAtual, diaLocal(new Date(dataAtual)));
      if (motivo) {
        console.log(`  🚫 data_hora_consulta descartada ("${dados.data_hora_consulta}") — ${motivo}`);
        dados.data_hora_consulta = null;
      } else {
        dados.data_hora_consulta = normalizarHorarioNaive(dados.data_hora_consulta);
      }
    }

    const apuracao = apurarDuplaConfirmacao(obsValidas);
    // Viaja junto com a apuracao pra chegar em registrarAgendamentoPendente: e a diferenca entre
    // "ninguem confirmou ainda" e "alguem confirmou mas o horario extraido nao servia".
    // _horarioImplausivel e _propagacaoRecusada tem o mesmo formato ({valor, motivo}) e o mesmo papel
    // aqui: um horario que a rede deterministica recusou como perna de confirmacao. Sem incluir a
    // segunda, uma consulta bloqueada pela regra "propagacao nao anda pra tras" (o incidente do deal
    // 47543238) aparecia so como "faltou confirmacao" — indistinguivel de uma conversa comum ainda
    // incompleta — em vez de "o codigo recusou de proposito por seguranca", que e o que de fato houve.
    apuracao.horariosDescartados = obsValidas
      .filter((o) => o._horarioImplausivel || o._propagacaoRecusada)
      .map((o) => ({ msg_idx: o.msg_idx, ...(o._horarioImplausivel || o._propagacaoRecusada) }));
    console.log(`  🔐 Dupla confirmacao: ${apuracao.confirmado
      ? `OK para ${apuracao.horarioIso} (cliente msg ${apuracao.cliente.msg_idx}, equipe msg ${apuracao.equipe.msg_idx})`
      : `NAO — ${descreverPendencia(apuracao)}`}`);

    // Espelha a decisao no banco pra ela ser auditavel depois do fato (ver a coluna
    // agendamento_apuracao no topo). So o que importa pra reconstruir o "por que": as observacoes de
    // horario com o indice da mensagem que as sustenta, e as pernas que a apuracao escolheu.
    try {
      db.prepare('UPDATE conversations SET agendamento_apuracao = ? WHERE chat_id = ?').run(JSON.stringify({
        em: new Date().toISOString(),
        ancora: dataAtual,
        confirmado: apuracao.confirmado,
        motivo: apuracao.motivo,
        horarioIso: apuracao.horarioIso,
        cliente: apuracao.cliente ? { tipo: apuracao.cliente.tipo, msg_idx: apuracao.cliente.msg_idx, horario_iso: apuracao.cliente.horario_iso, trecho: apuracao.cliente.trecho } : null,
        equipe: apuracao.equipe ? { tipo: apuracao.equipe.tipo, msg_idx: apuracao.equipe.msg_idx, horario_iso: apuracao.equipe.horario_iso, trecho: apuracao.equipe.trecho } : null,
        horariosDescartados: apuracao.horariosDescartados,
        data_hora_consulta: dados.data_hora_consulta || null,
        observacoesHorario: obsValidas
          .filter((o) => /_horario$/.test(o.tipo))
          .map((o) => ({ tipo: o.tipo, msg_idx: o.msg_idx, horario_iso: o.horario_iso, trecho: o.trecho, ...(o._dataCorrigida ? { _dataCorrigida: o._dataCorrigida } : {}), ...(o._horarioImplausivel ? { _horarioImplausivel: o._horarioImplausivel } : {}), ...(o._propagacaoRecusada ? { _propagacaoRecusada: o._propagacaoRecusada } : {}) })),
        observacoesRejeitadas: obsRejeitadas.map((r) => ({ motivo: r.motivo, tipo: r.obs?.tipo, msg_idx: r.obs?.msg_idx, horario_iso: r.obs?.horario_iso })),
      }), chatId);
    } catch (e) {
      console.error(`  ❌ Erro ao gravar apuracao de agendamento: ${e.message}`);
    }
    // Sanitizar nome: rejeitar placeholders genericos que a IA inventa
    if (dados.nome) {
      const nome = dados.nome.trim();
      const genericos = /^(cliente|do cliente|nome do cliente|lead|cliente sem nome|sem nome|n\/a|nao informado|nao identificado|null|undefined)$/i;
      if (genericos.test(nome) || nome.length < 3) {
        console.log(`  ⚠️ nome generico/invalido rejeitado: "${dados.nome}"`);
        dados.nome = null;
      }
    }
    // Fallback: usar nome do contato do WhatsApp se a IA nao extraiu
    if (!dados.nome && row.contact_name) {
      const nomeWhatsApp = row.contact_name.trim();
      const genericos = /^(cliente|do cliente|nome do cliente|lead|cliente sem nome|sem nome|n\/a|nao informado|nao identificado|null|undefined|teste)$/i;
      if (!genericos.test(nomeWhatsApp) && nomeWhatsApp.length >= 3 && !/^\d+$/.test(nomeWhatsApp)) {
        console.log(`  ℹ️ usando nome do WhatsApp: "${nomeWhatsApp}"`);
        dados.nome = nomeWhatsApp;
      }
    }
    aplicarPadroesDeterministicosDeOrigem(dados, mensagens);
    const { casoDescrito } = sanitizarClassificacao(dados, obsValidas);

    // CLIENTE QUE VOLTA (ver src/cliente-retorno.js). Roda aqui, DEPOIS de sanitizarClassificacao (que
    // e quem deixa `dados.assunto` comparavel) e ANTES de todo ramo de escrita: e o unico ponto em que
    // ainda da pra impedir o caso novo de sobrescrever a classificacao do negocio anterior.
    // Sem teto de atendimentos: cliente de escritorio volta mais de uma vez, e todo sinal usado aqui
    // se refere ao atendimento ATUAL (evento_calendar_data e last_data foram zerados no corte anterior,
    // e obsValidas ja esta filtrado pela janela). O corte novo cai sempre depois do atual.
    if (CLIENTE_RETORNO_ATIVO && row.deal_id) {
      const retorno = clienteRetorno.decidirRetorno({
        consulta: consultaAnterior, mensagens, obsValidas, dadosAnteriores, dados,
      });
      console.log(`  🔁 Retorno: ${retorno.decisao} — ${clienteRetorno.descreverMotivo(retorno.motivo)}`);

      if (retorno.decisao === 'novo_atendimento') {
        const aberto = await abrirNovoAtendimento({ chatId, row, retorno, dados, dadosAnteriores });
        // Aberto = este ciclo para aqui. O que a IA extraiu nesta rodada esta contaminado pelo caso
        // ANTIGO (ela leu o historico inteiro), e e o ciclo reagendado, com a janela ja cortada, que
        // cria o negocio novo. Em dry-run nada foi gravado e o fluxo segue como sempre foi.
        if (aberto) return;
      } else if (retorno.decisao === 'ambiguo') {
        // Resolvido pela dupla confirmacao (ver src/reuniao-retorno.js): cliente e equipe ja
        // confirmaram um horario posterior ao FIM da consulta realizada — nao ha ambiguidade "caso
        // novo ou continuacao?" que interesse aqui, e reuniao nova do MESMO caso. Sem esta saida, o
        // ramo abaixo forcaria `acao = 'aguardar'`, que retorna ANTES de finalizarCiclo rodar
        // (handleAgendamentoCalendar nunca seria chamado) — o retorno jamais seria agendado.
        const horarioConfirmadoInstante = apuracao?.confirmado
          ? horarioNaiveParaInstante(apuracao.horarioIso, TZ_ESCRITORIO)
          : null;
        const resolvidoComoRetorno = REUNIAO_RETORNO_ATIVO
          && horarioConfirmadoInstante
          && retorno.consulta?.fimComFolga
          && horarioConfirmadoInstante > retorno.consulta.fimComFolga;

        if (resolvidoComoRetorno) {
          console.log(`  🔁 Retorno: ambiguo resolvido pela dupla confirmacao (${formatarHorarioEscritorio(apuracao.horarioIso)} e posterior a consulta realizada) — segue como reuniao nova do mesmo caso`);
        } else {
          const consultaTexto = textoConsultaAnterior(retorno);
          await avisarRetornoUmaVez({
            chatId, row, retorno,
            telegrama: [
              '🔁 *Cliente antigo escreveu de novo — é caso novo?*',
              `Cliente: ${dados?.nome || dadosAnteriores?.nome || row?.contact_name || 'nao informado'} (\`${chatId}\`)`,
              `Negócio: \`${row.deal_id}\` — consulta em ${consultaTexto}`,
              `Motivo da dúvida: ${clienteRetorno.descreverMotivo(retorno.motivo)}`,
              '',
              'O bot NÃO reclassificou nada. Se for um caso novo, abra o negócio manualmente.',
            ].join('\n'),
          });
          // Caso novo suspeito nao reescreve a classificacao do caso ANTIGO enquanto a equipe nao
          // decide — mesma tecnica de aplicarGateCasoDescrito, e pelo mesmo motivo: campo em branco a
          // equipe preenche, campo com o dado do caso errado ninguem descobre lendo.
          dados.area_direito = null;
          dados.advogado_responsavel = null;
          dados.assunto = null;
          acao = 'aguardar';
        }
      }
    }

    const confianca = result.confianca ?? 0;

    console.log(`  → Ação decidida: "${acao}" (${justificativa}) | confianca: ${confianca}`);

    if (acao === 'criar' && confianca < 6) {
      console.log(`  ⏭️ confianca baixa (${confianca}/10), tratando como ignorar`);
      acao = 'ignorar';
    }

    if (deveEsperarCasoDescrito(acao, casoDescrito, apuracao, bloco.enviado)) {
      console.log(`  ⏳ "criar" sem caso descrito (e sem horario confirmado nem bloco de condicoes) — tratando como aguardar, nada e criado no CRM`);
      acao = 'aguardar';
    }

    // CAMPOS OBRIGATORIOS na CRIACAO — ver deveEsperarCamposObrigatorios. Roda ANTES de
    // buscarOuCriarContato (dentro do ramo "criar" abaixo): bloquear depois criaria um contato no
    // Moskit a toa em todo ciclo que so vai virar "aguardar".
    if (acao === 'criar') {
      const dadosMescladosGate = mesclarParaCrm(dadosAnteriores, dados, obsValidas);
      if (deveEsperarCamposObrigatorios(dadosMescladosGate, apuracao, bloco.enviado)) {
        const pendentesGate = camposPendentes(dadosMescladosGate);
        if (BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN) {
          console.log(`  🔍 [dry-run] bloquearia "criar" por campo(s) pendente(s) (${pendentesGate.join(', ')}) — criando mesmo assim (BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN ativo)`);
        } else {
          console.log(`  ⏳ "criar" com campo(s) obrigatorio(s) pendente(s) (${pendentesGate.join(', ')}) e sem horario confirmado nem bloco de condicoes — tratando como aguardar, nada e criado no CRM`);
          acao = 'aguardar';
        }
      }
    }

    if (acao === 'ignorar') {
      stmtUpdateProcessed.run(JSON.stringify(mesclarParaCrm(dadosAnteriores, dados, obsValidas)), acao, chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      console.log(`  ⏭️ ignorado ${chatId} (${justificativa})`);
      return;
    }

    if (acao === 'aguardar') {
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);
      stmtUpdateProcessed.run(JSON.stringify(dadosMesclados), acao, chatId);
      db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
      console.log(`  ⏳ Aguardando mais mensagens de ${chatId}`);
      return;
    }

    if (!dados.nome) {
      console.log(`  ⚠️ nome nao extraido, continuando com 'Cliente sem nome'`);
    }

    if (acao === 'criar') {
      console.log('  Buscando/criando contato no Moskit...');
      const contactId = await buscarOuCriarContato(phone, dados.nome);
      console.log(`  Contato ID: ${contactId}`);

      // Mescla com o que ja tinha sido extraido antes — sem isso um campo que veio null nesta
      // rodada (tipicamente o assunto) descarta o valor bom de um ciclo anterior. Os branches
      // aguardar/nota/atualizar_campos ja faziam isso; o criar era o unico que usava dados cru.
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);

      // Tres bugs viviam aqui, todos por causa de um if/else que decidia o caminho antes de saber
      // o resultado da verificacao:
      //   1) deal vivo => nenhum dos dois ramos de escrita rodava, e o ciclo "criar" nao mandava
      //      campo nenhum pro CRM;
      //   2) deal 404 => dealId virava null mas o else ja tinha sido descartado, entao nenhum deal
      //      novo nascia e o null descia pra criarNotaMoskit/stmtUpdateDeal, APAGANDO o deal_id;
      //   3) a verificacao de 404 era copia inline e incompleta de garantirDealExiste, que ja
      //      recria o deal e e usada pelos outros dois ramos.
      let dealId = row.deal_id
        ? await garantirDealExiste(row.deal_id, dadosMesclados, contactId, opcoesPayload)
        : await buscarDealPorContato(contactId);

      if (dealId) {
        console.log(`  Deal ${dealId} ja existe — atualizando...`);
        await atualizarNegocioMoskit(dealId, dadosMesclados, contactId, opcoesPayload);
        console.log(`  ✅ Deal ${dealId} atualizado`);
      } else {
        console.log('  Criando novo deal...');
        const deal = await criarNegocioMoskit(dadosMesclados, contactId, opcoesPayload);
        dealId = deal.id;
        console.log(`  ✅ Novo Deal ${dealId} criado`);
      }

      // Se o deal foi recriado com outro id, o banco precisa saber agora — o briefing e o
      // evento_calendar_* abaixo dependem disso, e nao no fim do ciclo.
      if (dealId !== row.deal_id) {
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(dealId, chatId);
        row.deal_id = dealId;
        row.briefing_added = 0;
      }

      await finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, obsValidas, mensagens,
        resumo: `Processamento de ${chatId} concluido` });

      // So DEPOIS de finalizarCiclo (que chama handleAgendamentoCalendar): postar o Briefing com
      // apuracao.horarioIso otimisticamente, ANTES de saber se o Google/Moskit confirmaram o
      // agendamento de verdade, deixava a nota dizendo um horario que podia nunca ter sido marcado —
      // se handleAgendamentoCalendar falhasse (rede/OAuth/quota do Google), so uma nota de erro
      // SEPARADA era postada, sem corrigir o Briefing ja publicado. evento_calendar_data so e gravado
      // no banco QUANDO o agendamento realmente aconteceu (ver criarEventoGoogleCalendar/
      // atualizarEventoSeRemarcado), entao reler daqui garante que o Briefing so cite um horario de
      // fato confirmado.
      const rowPosAgendamento = db.prepare('SELECT evento_calendar_data FROM conversations WHERE chat_id = ?').get(chatId);
      await registrarBriefing(dealId, chatId, {
        dados: dadosMesclados,
        contato: row.contact_name,
        telefone: chatId,
        horarioConsulta: formatarHorarioEscritorio(rowPosAgendamento?.evento_calendar_data),
      });
      return;
    }

    if (acao === 'nota') {
      if (!row.deal_id) {
        console.log(`  ⏭️ acao "nota" mas sem deal_id — ignorando`);
        stmtUpdateProcessed.run(JSON.stringify(mesclarParaCrm(dadosAnteriores, dados, obsValidas)), acao, chatId);
        db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
        return;
      }

      const contactId = await buscarOuCriarContato(phone, dados.nome || dadosAnteriores?.nome);
      let dealId = row.deal_id;
      const dealVerificado = await garantirDealExiste(dealId, mesclarParaCrm(dadosAnteriores, dados, obsValidas), contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(dealId, chatId);
        row.briefing_added = 0;
        console.log(`  ✅ Deal recriado como ${dealId} (o anterior nao existia mais no Moskit)`);
      }

      if (!dados.resumo_atendimento) {
        console.log(`  ⏭️ acao "nota" sem resumo — ignorando`);
      }

      await finalizarCiclo({
        dealId, dados, dadosMesclados: mesclarParaCrm(dadosAnteriores, dados, obsValidas),
        chatId, row, apuracao, acao, obsValidas, mensagens, resumo: `Nota adicionada para ${chatId}`,
      });

      if (dados.resumo_atendimento) {
        // Ver comentario equivalente no ramo "criar" — briefing so depois de finalizarCiclo, com o
        // horario RECEM-CONFIRMADO no banco, nunca com apuracao.horarioIso otimista.
        const rowPosAgendamento = db.prepare('SELECT evento_calendar_data FROM conversations WHERE chat_id = ?').get(chatId);
        await registrarBriefing(dealId, chatId, {
          dados: mesclarParaCrm(dadosAnteriores, dados, obsValidas),
          contato: row.contact_name,
          telefone: chatId,
          horarioConsulta: formatarHorarioEscritorio(rowPosAgendamento?.evento_calendar_data),
        });
      }
      return;
    }

    if (acao === 'atualizar_campos') {
      if (!row.deal_id) {
        console.log(`  ⏭️ acao "atualizar_campos" mas sem deal_id — ignorando`);
        stmtUpdateProcessed.run(JSON.stringify(mesclarParaCrm(dadosAnteriores, dados, obsValidas)), acao, chatId);
        db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);
        return;
      }

      let dealId = row.deal_id;
      // Nao redeclarar `dadosAnteriores` aqui: havia uma segunda declaracao com o mesmo nome
      // sombreando a do escopo da funcao. A externa e `null` quando nao ha dados salvos, a interna
      // era `{}` — e as linhas abaixo usavam a sombra enquanto os ramos "criar" e "nota" usavam a
      // externa. Tres ramos que parecem identicos operando sobre objetos diferentes.
      const dadosMesclados = mesclarParaCrm(dadosAnteriores, dados, obsValidas);
      const pendentes = camposPendentes(dadosMesclados);

      console.log('  Dados anteriores:', JSON.stringify(dadosAnteriores));
      console.log('  Dados novos:', JSON.stringify(dados));
      console.log('  Dados mesclados:', JSON.stringify(dadosMesclados));
      console.log(`  Campos ainda pendentes: ${pendentes.length > 0 ? pendentes.join(', ') : 'nenhum'}`);

      const contactId = await buscarOuCriarContato(phone, dadosMesclados.nome || dadosAnteriores?.nome);

      const dealVerificado = await garantirDealExiste(dealId, dadosMesclados, contactId, opcoesPayload);
      if (dealVerificado !== dealId) {
        dealId = dealVerificado;
        // deal_id tem que ser gravado AQUI, nao so em stmtFinalizarCiclo no fim do ciclo: os branches
        // "criar"/"nota" ja fazem isso, mas este ficava sem — se qualquer chamada seguinte (nota de
        // campos, briefing, pagamento, agendamento) lancasse antes do fim do ciclo, a linha ficava com
        // o deal_id ANTIGO (inexistente) e o proximo ciclo recriava outro deal de novo.
        db.prepare('UPDATE conversations SET deal_id = ?, briefing_added = 0, briefing_hash = NULL, campos_nota_hash = NULL, custom_fields_bot = NULL, campos_travados = NULL WHERE chat_id = ?').run(dealId, chatId);
        row.deal_id = dealId;
        row.briefing_added = 0;
        console.log(`  ✅ Deal recriado como ${dealId} (o anterior nao existia mais no Moskit)`);
      } else {
        console.log(`  Atualizando deal ${dealId} com novos campos...`);
        await atualizarNegocioMoskit(dealId, dadosMesclados, contactId, opcoesPayload);
        console.log(`  ✅ Deal ${dealId} atualizado no Moskit`);
      }

      if (pendentes.length === 0) {
        console.log('  🎯 Todos os campos obrigatorios preenchidos!');
      }

      await finalizarCiclo({ dealId, dados, dadosMesclados, chatId, row, apuracao, acao, obsValidas, mensagens,
        resumo: `Deal ${dealId} atualizado com campos pendentes` });

      // BRIEFING COM A LACUNA ANOTADA, e nao briefing nenhum. Este bloco vivia dentro de
      // `if (pendentes.length === 0)`, e o portao era um beco sem saida: aplicarGateCasoDescrito
      // anula `area_direito` e `advogado_responsavel` de proposito quando ninguem descreveu o caso
      // (decisao de 12/08 — melhor vazio que adivinhado), os dois estao em CAMPOS_OBRIGATORIOS, e
      // entao conversa sem caso descrito NUNCA podia receber briefing. O resumo era pedido a OpenAI,
      // pago, escrito e descartado sem uma linha de log. MEDIDO em 02/09/2026 (avaliar-extracao.js,
      // 277 conversas): 19 barradas aqui, 14 delas com resumo pronto, e em todas as 14 quem segurou
      // foram exatamente esses dois campos. O ramo "criar" nunca teve essa condicao — a assimetria
      // entre os dois ramos era o defeito, e o gate do caso descrito continua intacto porque e ele
      // que protege o CRM de palpite.
      if (BRIEFING_SEM_PENDENTES || pendentes.length === 0) {
        // Ver comentario equivalente no ramo "criar" — briefing so depois de finalizarCiclo, com o
        // horario RECEM-CONFIRMADO no banco, nunca com apuracao.horarioIso otimista.
        const rowPosAgendamento = db.prepare('SELECT evento_calendar_data FROM conversations WHERE chat_id = ?').get(chatId);
        await registrarBriefing(dealId, chatId, {
          dados: dadosMesclados,
          contato: row.contact_name,
          telefone: chatId,
          horarioConsulta: formatarHorarioEscritorio(rowPosAgendamento?.evento_calendar_data),
          // Viaja no contexto e chega ao cabecalho por `montarTextoBriefing` (spread em
          // registrarBriefing). Lista vazia nao produz linha nenhuma.
          pendentes,
        });
      }
      return;
    }

    console.log(`  ⏭️ acao desconhecida "${acao}" — ignorando`);
    stmtUpdateProcessed.run(JSON.stringify(mesclarParaCrm(dadosAnteriores, dados, obsValidas)), acao, chatId);
    db.prepare("UPDATE conversations SET last_processed_at = datetime('now') WHERE chat_id = ?").run(chatId);

  } catch (erro) {
    console.error(`\n❌ Erro ao processar ${chatId}:`);
    if (erro.response) {
      console.error('  Status:', erro.response.status);
      console.error('  Dados:', JSON.stringify(erro.response.data, null, 2));
    } else {
      console.error('  Message:', erro.message);
    }
    console.error('  Stack:', erro.stack);
    // RELANCA. Antes engolia o erro aqui e chamava agendarProcessamento(), que e no-op sob
    // WORKER_MODE — e esta funcao so roda no worker. Resultado: o catch do worker.js nunca era
    // atingido, o chatId entrava em `sucessos` e saia da fila como se tivesse dado certo. Uma
    // falha de rede descartava o lead em silencio. Quem decide o que fazer com a falha e a fila.
    throw erro;
  }
}

// ------------------------------------------------------------
// Servidor Webhook (Zernio)
// ------------------------------------------------------------
const app = express();
// Guarda o corpo cru (bytes) pra poder validar a assinatura HMAC do webhook — depois de
// express.json() fazer o parse, o buffer original nao existe mais.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Timeout global: responde 503 se a requisicao demorar mais de 240s (sync pode ser lenta)
app.use((req, res, next) => {
  res.setTimeout(240000, () => {
    console.error(`⏰ TIMEOUT na requisicao ${req.method} ${req.path} apos 240s`);
    if (!res.headersSent) res.status(503).json({ error: 'timeout' });
  });
  next();
});

// ------------------------------------------------------------
// Autenticacao
// ------------------------------------------------------------
// O servico e publicado na internet pelo ngrok e ate aqui NENHUMA das 10 rotas exigia credencial:
// dava pra forcar processamento, criar evento no Google Agenda do escritorio, mover deal, e
// consultar nome+id de qualquer cliente do CRM a partir do telefone.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// Compara em tempo constante (evita vazar o segredo por diferenca de timing char a char).
// timingSafeEqual exige buffers do mesmo tamanho, entao valores de tamanho diferente ja falham direto.
function comparacaoSegura(enviado, esperado) {
  const bufEnviado = Buffer.from(String(enviado || ''));
  const bufEsperado = Buffer.from(String(esperado || ''));
  if (bufEnviado.length !== bufEsperado.length) return false;
  return crypto.timingSafeEqual(bufEnviado, bufEsperado);
}

// A URL do webhook no Zernio e FIXA (nao da pra apontar pra um caminho com segredo, tipo
// /webhook/<segredo>) — mas o Zernio suporta assinar cada entrega com HMAC-SHA256 do corpo cru,
// usando um secret configurado no dashboard deles (Settings > Webhooks) ou via API. O segredo aqui
// e o MESMO valor cadastrado la, e a assinatura vem no header X-Zernio-Signature (hex minusculo).
function assinaturaValida(req) {
  const recebida = req.get('X-Zernio-Signature') || req.get('X-Late-Signature');
  if (!recebida || !req.rawBody) return false;
  const esperada = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  return comparacaoSegura(recebida, esperada);
}

// Segredo do webhook de auto-deploy (repositorio no GitHub > Settings > Webhooks). Usado pela
// rota /deploy-webhook pra manter esta maquina sempre com a versao mais recente do codigo a
// cada `git push` — ver deploy.js. Sem DEPLOY_WEBHOOK_SECRET, a rota fica desabilitada (503).
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || null;
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH || 'main';

// O GitHub assina cada entrega com HMAC-SHA256 do corpo cru, no header X-Hub-Signature-256
// (formato "sha256=<hex>") — mesma ideia de assinaturaValida() acima, so que com o prefixo
// "sha256=" que o GitHub usa e o Zernio nao.
function assinaturaGithubValida(req) {
  const recebida = req.get('X-Hub-Signature-256');
  if (!recebida || !recebida.startsWith('sha256=') || !req.rawBody) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', DEPLOY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  return comparacaoSegura(recebida, esperada);
}

// Segredo do webhook do ZapSign (documento assinado/recusado/e-mail nao entregue). DIFERENTE de
// assinaturaValida/assinaturaGithubValida: a ZapSign nao assina o corpo com HMAC — a autenticacao
// e um header HTTP customizado que a gente mesmo escolhe ao cadastrar o webhook (painel:
// Configuracoes > Integracoes > API ZapSign > Webhooks > Headers, ou via
// POST /api/v1/user/company/webhook/ com {url, type, headers}). O NOME do header e fixo aqui
// (X-Zapsign-Webhook-Secret) — cadastre esse mesmo nome e o valor de ZAPSIGN_WEBHOOK_SECRET do lado
// de la. Sem ZAPSIGN_WEBHOOK_SECRET configurado, periodo de tolerancia (mesmo padrao de /webhook)
// — pior caso de aceitar sem checar aqui e uma nota indevida no CRM, nao um risco de seguranca
// como /deploy-webhook (execucao de codigo) ou /webhook (injecao de mensagem "equipe").
const ZAPSIGN_WEBHOOK_SECRET = process.env.ZAPSIGN_WEBHOOK_SECRET || null;

function zapsignWebhookValido(req) {
  if (!ZAPSIGN_WEBHOOK_SECRET) return true;
  const recebido = req.get('X-Zapsign-Webhook-Secret');
  return comparacaoSegura(recebido, ZAPSIGN_WEBHOOK_SECRET);
}

// Sem ADMIN_TOKEN a rota fica DESLIGADA (503), nao aberta. Perder /sincronizar por falta de config
// e preferivel a deixar /cliente-existente respondendo pra qualquer um.
function exigeAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN nao configurado — rota administrativa desabilitada' });
  }
  const enviado = req.get('X-Admin-Token') || req.query.token;
  if (!comparacaoSegura(enviado, ADMIN_TOKEN)) return res.status(401).json({ error: 'nao autorizado' });
  next();
}

// Adaptador de rota async: o Express 4 NAO encaminha rejeicao de handler async pro error middleware,
// entao um erro deixava a requisicao pendurada ate o timeout de 240s.
const rota = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`❌ ${req.method} ${req.path}: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  });
};

// Health check — unica rota aberta de proposito; nao revela nada.
app.get('/', (req, res) => {
  res.send('Bot WhatsApp rodando via Zernio!');
});

// Serve o PDF da transcricao para que o MOSKIT possa baixa-lo.
//
// Por que existe uma rota sem autenticacao: POST /deals/{id}/attachments nao aceita upload — o corpo
// e {"url": "..."} e quem busca o arquivo e o servidor do Moskit, que nao tem como mandar
// ADMIN_TOKEN. Ou o arquivo esta acessivel por URL, ou ele nao entra na aba Arquivos.
//
// O conteudo e a transcricao de uma consulta juridica, entao a rota e desenhada para durar pouco:
//   - token de 256 bits (2^256 e o espaco de busca; nao ha o que enumerar);
//   - `anexo_expira_em` filtrado na propria consulta SQL, teto de NOTAS_ANEXO_TTL_HORAS;
//   - o token e invalidado assim que o Moskit confirma a copia — quase sempre em segundos.
//
// `:nome` e DECORATIVO e nunca toca o disco. Ele existe so porque o Moskit deriva o `filename` do
// anexo a partir da URL, e "notas-reuniao-14-08-2026.pdf" e melhor no CRM que um token hexadecimal.
// O caminho real vem do banco. Montar caminho com pedaco de URL e o que abriria path traversal aqui.
app.get('/arquivo-nota/:token/:nome', (req, res) => {
  // Um unico 404 para token desconhecido, token expirado e arquivo sumido. Distinguir os tres diria
  // a quem sondasse que aquele token JA existiu — e quando.
  const recusar = () => res.status(404).send('Nao encontrado');

  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return recusar();

  let linha;
  try {
    linha = stmtNotaPorAnexoToken().get(token);
  } catch (e) {
    // Banco sem as colunas do anexo (migracao nao aplicada). Antes isso derrubava o processo no
    // boot; agora custa um 404 nesta rota e mais nada.
    console.error(`❌ GET /arquivo-nota: consulta indisponivel (${e.message})`);
    return recusar();
  }

  // A clausula WHERE ja casou o token, mas a comparacao explicita e de tempo constante fecha o canal
  // lateral que a busca no indice deixa aberto.
  if (!linha || !comparacaoSegura(token, linha.anexo_token)) return recusar();
  if (!linha.anexo_caminho || !fs.existsSync(linha.anexo_caminho)) return recusar();

  let pdf;
  try {
    pdf = fs.readFileSync(linha.anexo_caminho);
  } catch (e) {
    console.error(`❌ GET /arquivo-nota: falha ao ler ${linha.anexo_caminho}: ${e.message}`);
    return recusar();
  }

  console.log(`  📎 anexo servido (deal ${linha.deal_id}, ${pdf.length} bytes) ua="${req.get('user-agent') || '-'}"`);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    // O nome vem do BANCO, nunca de req.params: e o mesmo nome que a deduplicacao procura depois.
    'Content-Disposition': `inline; filename="${linha.anexo_nome || 'notas-reuniao.pdf'}"`,
    // Transcricao de consulta nao deve ficar em cache de intermediario nenhum.
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.send(pdf);
});

// Rota para forçar processamento manual (debug)
app.post('/processar/:chatId', exigeAdmin, (req, res) => {
  const chatId = req.params.chatId;
  console.log(`\n🔧 Forçando processamento de ${chatId} via rota /processar`);
  res.json({ ok: true, chatId });
  try {
    processarConversa(chatId);
  } catch (e) {
    console.error(`❌ POST /processar/${chatId}: ${e.message}`);
  }
});

// Rota para sincronizar conversas via API Zernio
app.post('/sincronizar', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Sincronizando conversas via API Zernio...');
  const resultado = await sincronizarConversas();
  res.json({ ok: true, ...resultado });
}));

// Rota para sincronizar Atividades do Moskit (Reunião/Videoconferência) com o Google Calendar,
// independente de o deal ter sido criado pelo bot ou pelo Moskit Boost / manualmente
app.post('/sincronizar-atividades', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Sincronizando atividades do Moskit com o Google Calendar...');
  const resultado = await sincronizarAtividadesMoskit();
  res.json({ ok: true, ...resultado });
}));

// Auditoria da classificacao: compara o que esta no CRM com o que o bot apurou na conversa.
// DRY-RUN por padrao (nao escreve nada) — `?aplicar=1` corrige o que o proprio bot escreveu e
// `?incluir-legado=1` alcanca tambem os deals sem registro de autoria (anteriores a esta versao), que no
// modo normal sao preservados. Campo corrigido na mao pela equipe nunca e tocado, em nenhum modo.
app.get('/auditoria-classificacao', exigeAdmin, rota(async (req, res) => {
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true';
  const incluirLegado = req.query['incluir-legado'] === '1' || req.query['incluir-legado'] === 'true';
  const limite = Math.min(Number(req.query.limite) || 100, 500);
  console.log(`\n🔍 Auditoria de classificacao (${aplicar ? 'APLICANDO correcoes' : 'so leitura'}${incluirLegado ? ', incluindo legado' : ''})...`);
  const relatorio = await reconciliarClassificacao({ aplicar, incluirLegado, limite });
  res.json({ ok: true, ...relatorio });
}));

// Auditoria SO-LEITURA: mostra quais atividades seriam liberadas sem comprovante por estarem
// marcadas como "consulta gratis" no Moskit. Nao toca em Calendar, Moskit nem Telegram — serve
// pra conferir o alcance antes de ligar LIBERAR_CONSULTA_GRATIS.
app.get('/auditoria-consulta-gratis', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria de consultas gratis (so leitura)...');
  const linhas = [];
  try {
    const { atividades, truncou } = await listarAtividadesMoskit();
    if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS_ATIVIDADES} paginas atingido — auditoria cobre so as ${atividades.length} atividades mais recentes`);
    const agora = Date.now();

    for (const atv of atividades) {
      if (!ATIVIDADE_TIPOS_CONSULTA.has(atv.type?.id)) continue;
      if (atv.doneDate) continue;
      if (!atv.dueDate || new Date(atv.dueDate).getTime() <= agora) continue;

      const dealId = atv.deals?.[0]?.id || null;
      const linha = {
        activity_id: atv.id,
        title: atv.title,
        dueDate: atv.dueDate,
        dealId,
        ja_sincronizada: !!stmtAtividadeJaSincronizada.get(atv.id),
        opcoes_tipo_consulta: null,
        tem_comprovante: false,
        decisao: 'bloqueada',
      };

      if (dealId) {
        linha.tem_comprovante = !!stmtComprovantePorDeal.get(dealId);
        const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${dealId}`, {
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
        });
        if (dealRes.status >= 200 && dealRes.status < 300) {
          const campo = (dealRes.data?.entityCustomFields || []).find((c) => c?.id === CF_TIPO_CONSULTA);
          linha.opcoes_tipo_consulta = campo?.options || [];
          if (linha.tem_comprovante) linha.decisao = 'liberada por comprovante';
          else if (dealEhConsultaGratis(dealRes.data)) linha.decisao = 'liberaria por consulta gratis';
        } else {
          linha.decisao = `erro ao ler deal (HTTP ${dealRes.status})`;
        }
      } else {
        linha.decisao = 'bloqueada (atividade sem deal)';
      }

      linhas.push(linha);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }

  const liberariaPorGratis = linhas.filter((l) => l.decisao === 'liberaria por consulta gratis').length;
  console.log(`  🔍 ${linhas.length} atividades futuras analisadas — ${liberariaPorGratis} seriam liberadas por consulta gratis`);
  res.json({ ok: true, flag_ativa: LIBERAR_CONSULTA_GRATIS, total: linhas.length, liberaria_por_consulta_gratis: liberariaPorGratis, atividades: linhas });
}));

// Auditoria SO-LEITURA das TRES fontes de horario de uma consulta: o espelho local
// (conversations.evento_calendar_data), o evento no Google Agenda e a Atividade na agenda do Moskit.
//
// Existe porque nada no sistema cruzava essas fontes, e foi cruzando as tres na mao que os 5 casos de
// horario errado apareceram (13/08/2026). Divergencia entre elas e invisivel no dia a dia: cada tela
// mostra um horario e todas parecem certas. Os casos reais que esta rota pega:
//   deal 48226006 (Priscilla) — banco/Google em 07/08 14:00, decisao do bot em 10/08 14:00
//   deal 47543238 (Rafael)    — evento parado em 29/07 depois de remarcado pra 04/08
//   deal 48370184 (Arthur)    — valor gravado = hora de envio da ultima mensagem
//
// ?todas=1 inclui consulta passada (o padrao e so futura). ?desde=AAAA-MM-DD limita a janela.
app.get('/auditoria-agenda', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria de agenda: banco x Google x Moskit (so leitura)...');
  const incluirPassadas = req.query.todas === '1';
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
  const hojeLocal = diaLocal(new Date());

  const auth = getGoogleAuthClient();
  const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;
  const linhas = [];

  const rows = db.prepare(`
    SELECT chat_id, contact_name, deal_id, evento_calendar_id, evento_calendar_data,
           atividade_moskit_id, agendamento_apuracao
      FROM conversations
     WHERE evento_calendar_id IS NOT NULL AND evento_calendar_id <> ''
  `).all();

  for (const row of rows) {
    const noBanco = row.evento_calendar_data || null;
    let apuracao = null;
    try { apuracao = row.agendamento_apuracao ? JSON.parse(row.agendamento_apuracao) : null; } catch {}

    // Horario do Google, trazido pra hora do escritorio. Evento cancelado conta como divergencia:
    // "cancelled" com o banco achando que a consulta existe e o pior estado possivel.
    let noGoogle = null;
    let statusGoogle = null;
    if (calendar) {
      try {
        const { data } = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.evento_calendar_id });
        statusGoogle = data.status;
        noGoogle = data.start?.dateTime ? instanteParaNaiveLocal(data.start.dateTime) : null;
      } catch (e) {
        statusGoogle = `erro: ${e.code || e.message}`;
      }
    }

    // Horario da Atividade no Moskit. dueDate e instante absoluto (ver "As duas agendas" no
    // CLAUDE.md), entao volta pro naive local pela MESMA conversao usada na comparacao acima.
    let noMoskit = null;
    let statusMoskit = null;
    let semVinculoComDeal = false;
    if (row.atividade_moskit_id) {
      try {
        const r = await axios.get(`${MOSKIT_BASE}/activities/${row.atividade_moskit_id}`, {
          headers: apiHeaders,
          validateStatus: (s) => s < 500,
        });
        if (r.status >= 200 && r.status < 300) {
          noMoskit = r.data?.dueDate ? instanteParaNaiveLocal(r.data.dueDate) : null;
          // MEDIDO em 14/08/2026 (deals 48474073, 48464876): o POST as vezes cria a atividade sem
          // vincular ao negocio (so ao contato) — ver garantirVinculoAtividadeDeal.
          semVinculoComDeal = !(r.data?.deals || []).some((d) => Number(d?.id) === Number(row.deal_id));
        } else {
          statusMoskit = `HTTP ${r.status}`;
        }
      } catch (e) {
        statusMoskit = `erro: ${e.message}`;
      }
    }

    const referencia = (noBanco || '').slice(0, 16) || noGoogle || noMoskit;
    const diaReferencia = (referencia || '').slice(0, 10);
    if (!incluirPassadas && diaReferencia && diaReferencia < hojeLocal) continue;
    if (desde && diaReferencia && diaReferencia < desde) continue;

    // `problemas` e so o que significa "a consulta pode estar no horario errado AGORA" — e a lista que
    // alguem vai ler pra corrigir na mao. Tudo que e contexto vai pra `observacoes`: um item que
    // dispara em toda linha nao e problema, e ruido, e afoga justamente os 3 casos que importam.
    const problemas = [];
    const observacoes = [];
    const bancoMinuto = noBanco ? noBanco.slice(0, 16) : null;
    const futura = diaReferencia && diaReferencia >= hojeLocal;

    if (noBanco && !normalizarHorarioNaive(noBanco)) {
      problemas.push(`espelho local em formato invalido ("${noBanco}") — nao e hora naive do escritorio, provavel timestamp copiado`);
    }
    if (bancoMinuto && noGoogle && bancoMinuto !== noGoogle) {
      problemas.push(`banco (${bancoMinuto}) e Google (${noGoogle}) divergem`);
    }
    if (noGoogle && noMoskit && noGoogle !== noMoskit) {
      problemas.push(`Google (${noGoogle}) e agenda do Moskit (${noMoskit}) divergem`);
    }
    if (apuracao?.horarioIso && bancoMinuto && apuracao.horarioIso.slice(0, 16) !== bancoMinuto) {
      problemas.push(`ultima decisao do bot (${apuracao.horarioIso}) nao chegou na agenda (banco em ${bancoMinuto}) — remarcacao travada?`);
    }
    // apurarDuplaConfirmacao sempre grava horarioIso:null quando confirmado e false (falta_cliente/
    // falta_equipe/falta_ambos) — exatamente o caso que este audit precisa enxergar (MEDIDO em
    // 14/08/2026, deals 48292471/48287898: a perna validada da equipe as vezes tem o horario CERTO,
    // mesmo com confirmado:false por a perna do cliente ter sido descartada). Ver perna isolada, nao
    // so horarioIso, pra nao ficar cego nesse caso.
    const pernaValidada = apuracao?.equipe?.horario_iso || apuracao?.cliente?.horario_iso || null;
    if (!apuracao?.horarioIso && pernaValidada && bancoMinuto && pernaValidada.slice(0, 16) !== bancoMinuto) {
      problemas.push(`equipe/cliente comunicou ${pernaValidada} na conversa mas a agenda mostra ${bancoMinuto} — confirmacao nao fechou (${apuracao?.motivo || 'motivo desconhecido'})`);
    }
    if (row.atividade_moskit_id && !noMoskit) {
      problemas.push(`atividade ${row.atividade_moskit_id} nao pode ser lida na agenda do Moskit${statusMoskit ? ` (${statusMoskit})` : ''}`);
    }
    if (row.atividade_moskit_id && noMoskit && semVinculoComDeal) {
      problemas.push(`atividade ${row.atividade_moskit_id} existe mas nao esta vinculada ao negocio (so ao contato) — some da tela do negocio no Moskit`);
    }
    if (apuracao?.horariosDescartados?.length) {
      problemas.push(`horario recusado pela validacao: ${apuracao.horariosDescartados.map((d) => `"${d.valor}" (${d.motivo})`).join('; ')}`);
    }

    if (statusGoogle && statusGoogle !== 'confirmed') {
      // Cancelado nao e defeito por si: a equipe cancela consulta o tempo todo. Vira problema so se o
      // bot ainda acha que ela vai acontecer.
      (futura ? problemas : observacoes).push(`evento no Google com status "${statusGoogle}"`);
    }
    if (!row.atividade_moskit_id) {
      // atividade_moskit_id nasceu em 12/08/2026; consulta anterior a isso nunca teve Atividade no CRM
      // e nao ha o que corrigir numa consulta que ja passou.
      (futura ? problemas : observacoes).push('consulta sem Atividade na agenda do Moskit (so existe no Google)');
    }
    if (!apuracao) {
      observacoes.push('sem apuracao gravada (conversa nao reprocessada depois da coluna agendamento_apuracao existir)');
    }

    linhas.push({
      chat_id: row.chat_id,
      cliente: row.contact_name,
      deal_id: row.deal_id,
      evento_calendar_id: row.evento_calendar_id,
      horario_no_banco: noBanco,
      horario_no_google: noGoogle,
      horario_na_agenda_moskit: noMoskit,
      status_google: statusGoogle,
      decisao_do_bot: apuracao?.horarioIso || null,
      motivo_pendencia: apuracao?.confirmado === false ? apuracao?.motivo : null,
      problemas,
      observacoes,
    });
  }

  const comProblema = linhas.filter((l) => l.problemas.length);
  console.log(`  🔍 ${linhas.length} consultas conferidas — ${comProblema.length} com divergencia`);
  for (const l of comProblema) {
    console.log(`  ⚠️ deal ${l.deal_id} (${l.cliente}): ${l.problemas.join(' | ')}`);
  }
  res.json({
    ok: true,
    google_configurado: !!calendar,
    escopo: incluirPassadas ? 'todas as consultas' : `consultas de ${hojeLocal} em diante`,
    total: linhas.length,
    com_divergencia: comProblema.length,
    consultas: linhas,
  });
}));

// Auditoria SO-LEITURA: lista estagios do funil (pipeline "Funil de Vendas", id 40631) com priority
// maior que a do ultimo estagio mapeado hoje em MOSKIT_STAGE_MAP (contrato_enviado), e amostra os
// valores reais de deal.status ja em uso no Moskit. Nao escreve nada — serve pra descobrir os
// nomes/IDs dos estagios finais do funil (ex.: Contrato Assinado, Ganho, Perdido) antes de mapea-los.
app.get('/auditoria-funil-completo', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔍 Auditoria do funil completo (so leitura)...');
  const maxPriorityMapeada = Math.max(...Object.values(MOSKIT_STAGE_MAP).map((s) => s.priority));

  let stages = [];
  let stagesFonte = null;
  for (const tentativa of [
    { fonte: '/stages', req: () => axios.get(`${MOSKIT_BASE}/stages`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
    { fonte: '/pipelines/40631', req: () => axios.get(`${MOSKIT_BASE}/pipelines/40631`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
    { fonte: '/pipelines', req: () => axios.get(`${MOSKIT_BASE}/pipelines`, { headers: apiHeaders, validateStatus: (s) => s < 500 }) },
  ]) {
    try {
      const respTentativa = await tentativa.req();
      if (respTentativa.status >= 200 && respTentativa.status < 300 && respTentativa.data) {
        const candidato = Array.isArray(respTentativa.data)
          ? respTentativa.data
          : (respTentativa.data.stages || [respTentativa.data]);
        if (candidato.length) {
          stages = candidato;
          stagesFonte = tentativa.fonte;
          break;
        }
      }
    } catch (e) {
      console.log(`  ⚠️ ${tentativa.fonte} falhou: ${e.message}`);
    }
  }

  const estagiosAlemDoMapeado = stages
    .filter((s) => Number.isFinite(s?.priority) && s.priority > maxPriorityMapeada)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => ({ id: s.id, name: s.name, priority: s.priority }));

  // ATENCAO: `page`/`limit` sao ignorados em silencio aqui (sempre devolve so os 10 mais recentes) —
  // esta amostra e so uma indicacao rapida, nao uma varredura de todos os deals. MEDIDO em 21/08/2026
  // (ver estudar-deals-sem-origem.js): quem pagina de verdade e `?start=`, mesmo padrao de
  // listarAtividadesMoskit — pra uma varredura completa de /deals, troque `page` por `start` e itere.
  const dealsRes = await axios.get(`${MOSKIT_BASE}/deals`, {
    params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
    headers: apiHeaders,
    validateStatus: (s) => s < 500,
  });
  const deals = dealsRes.data || [];
  const statusVistos = {};
  let exemploNaoAberto = null;
  for (const d of deals) {
    const st = d?.status || '(vazio)';
    statusVistos[st] = (statusVistos[st] || 0) + 1;
    if (st !== 'OPEN' && !exemploNaoAberto) exemploNaoAberto = d;
  }

  console.log(`  🔍 ${estagiosAlemDoMapeado.length} estagio(s) alem do mapeado, ${deals.length} deal(s) na amostra (limit ignorado pela API)`);
  res.json({
    ok: true,
    fonte_estagios: stagesFonte,
    max_priority_mapeada_hoje: maxPriorityMapeada,
    estagios_alem_do_mapeado: estagiosAlemDoMapeado,
    amostra_deals: deals.length,
    amostra_aviso: 'API do Moskit ignora limit em /deals — amostra e so os ~10 deals mais recentes',
    status_vistos_na_amostra: statusVistos,
    exemplo_deal_status_diferente_de_open: exemploNaoAberto,
  });
}));

// Rota de uso unico (manual) pra adicionar link do Google Meet a eventos futuros
// que ja existiam no calendario antes dessa funcionalidade existir
app.post('/backfill-meet-links', exigeAdmin, rota(async (req, res) => {
  const dryRun = req.query.dryRun === '1';
  console.log(`\n🔧 ${dryRun ? '[dry-run] Simulando' : 'Adicionando'} Meet a eventos futuros existentes...`);
  const resultado = await backfillMeetLinks(dryRun);
  res.json({ ok: true, ...resultado });
}));

// Rota para importar todos os contatos do Moskit
app.post('/importar-moskit', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Importando contatos do Moskit...');
  const resultado = await importarContatosMoskit();
  const count = stmtMoskitCount.get();
  res.json({ ok: true, ...resultado, total_no_banco: count.t });
}));

// Rota para consultar se um telefone existe no Moskit.
// Sem auth isto era um oraculo de enumeracao: telefone -> nome + id do cliente no CRM.
app.get('/cliente-existente/:telefone', exigeAdmin, (req, res) => {
  const contato = stmtMoskitGet.get(chaveConversa(req.params.telefone));
  if (contato) {
    res.json({ existe: true, moskit_id: contato.moskit_id, nome: contato.name });
  } else {
    res.json({ existe: false });
  }
});

// Rota para backfill: criar deals pendentes de conversas com last_action='criar' sem deal_id
app.post('/backfill-deals', exigeAdmin, rota(async (req, res) => {
  console.log('\n🔧 Backfill: processando conversas criar sem deal_id...');
  const resultado = await backfillDeals();
  res.json({ ok: true, ...resultado });
}));

// Webhook — Zernio envia eventos aqui
function tratarWebhook(req, res) {
  res.sendStatus(200);

  // Se req.body veio vazio ou deu problema no parse, ignorar
  if (!req.body || Object.keys(req.body).length === 0) {
    console.log('  ⏭️ webhook recebido sem body (provavel timeout/parse error)');
    return;
  }

  const body = req.body;
  const msg = body?.message;
  if (!msg) return;

  // Mensagem recebida do cliente
  if (body.event === 'message.received' && msg.direction === 'incoming') {
    const from = chaveConversa(msg.sender?.id);
    const contactName = msg.sender?.name || from;
    if (!from) {
      // Nao e telefone reconhecivel (id alfanumerico, grupo, remetente vazio). Loga em vez de
      // sumir em silencio — se aparecer no log, o formato do Zernio mudou.
      console.log(`  ⏭️ webhook: sender.id "${msg.sender?.id}" nao vira chave de conversa — ignorado`);
      return;
    }

    let corpo;
    let audioAtt = null;
    if (msg.text) {
      corpo = String(msg.text).trim();
      if (!corpo) return;
    } else if (msg.attachments && msg.attachments.length > 0) {
      const att = msg.attachments[0];
      const nomeArquivo = att.payload?.filename || att.payload?.name;
      if (att.type === 'image') {
        corpo = nomeArquivo ? `📎 [cliente enviou: ${nomeArquivo}]` : '📎 [cliente enviou uma imagem]';
      } else if (att.type === 'document' || att.type === 'file') {
        corpo = `📎 [cliente enviou: ${nomeArquivo || 'documento'}]`;
      } else if (att.type === 'audio') {
        corpo = '📎 [cliente enviou um audio]';
        audioAtt = att; // transcricao assincrona apos o placeholder estar no banco (abaixo)
      } else if (att.type === 'video') {
        corpo = '📎 [cliente enviou um video]';
      } else if (att.type === 'sticker') {
        corpo = '📎 [cliente enviou uma figurinha]';
      } else {
        corpo = `📎 [cliente enviou ${att.type}]`;
      }
      // O audio NAO passa por baixarComprovante: alem de salvar com nome/erro de "comprovante",
      // notificaria "NOVO COMPROVANTE" no Telegram a toa. Ele e baixado e transcrito no proprio
      // caminho de audio, la embaixo.
      if (att.type !== 'audio') {
        // .catch obrigatorio: sem ele a rejeicao caia no handler global de unhandledRejection e o
        // comprovante sumia sem ninguem saber.
        baixarComprovante(from, att)
          .then(async (caminho) => {
            await notificarTelegram(from, att, caminho);
            if (att.type === 'image' && caminho) await processarComprovante(from, from, caminho);
          })
          .catch((e) => console.error(`  ❌ Erro ao tratar anexo de ${from}: ${e.message}`));
      }
    } else {
      return;
    }

    processarMensagemRecebida(from, from, contactName, corpo, 'cliente', msg.id);
    // Transcricao depois do placeholder estar no banco: se o processo morrer no meio, a conversa
    // segue processando sem o conteudo do audio em vez de perder a mensagem inteira.
    if (audioAtt && msg.id) {
      processarAudioCliente(from, audioAtt, msg.id)
        .catch((e) => console.error(`  ❌ Erro ao transcrever audio de ${from}: ${e.message}`));
    }
    return;
  }

  // Mensagem enviada pela equipe (usado pra detectar avanco no funil — proposta, contrato, etc.)
  if (body.event === 'message.sent' && msg.direction === 'outgoing') {
    const chatId = chaveConversa(body.conversation?.participantId);
    const contactName = body.conversation?.participantName || chatId;
    if (!chatId) {
      console.log(`  ⏭️ webhook: participantId "${body.conversation?.participantId}" nao vira chave de conversa — ignorado`);
      return;
    }

    // Nome do arquivo tambem do lado da equipe: o polling ja capturava e o webhook descartava, entao
    // "tabela-honorarios.pdf" virava "[equipe enviou document]" e sumia da deteccao de cobranca.
    const anexo = msg.attachments?.[0];
    const nomeAnexo = anexo?.payload?.filename || anexo?.payload?.name || anexo?.filename;
    const corpo = msg.text
      ? String(msg.text).trim()
      : (anexo ? `📎 [equipe enviou${nomeAnexo ? `: ${nomeAnexo}` : ` ${anexo.type}`}]` : null);
    if (!corpo) return;

    processarMensagemRecebida(chatId, chatId, contactName, corpo, 'equipe', msg.id);
  }
}

// A URL do webhook e sempre /webhook (o Zernio nao permite apontar pra um caminho customizado).
// Em periodo de tolerancia — sem WEBHOOK_SECRET configurado — aceita sem checar assinatura, so pra
// dar tempo de subir o codigo sem blackout; passa a EXIGIR assinatura valida assim que o secret for
// cadastrado aqui E no dashboard do Zernio (Settings > Webhooks).
app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET && !assinaturaValida(req)) return res.sendStatus(401);
  tratarWebhook(req, res);
});

// Auto-deploy: o GitHub chama esta rota a cada push (repositorio > Settings > Webhooks) pra
// manter esta maquina sempre com a versao mais recente do codigo. So dispara pro branch
// DEPLOY_BRANCH (padrao main); a execucao de verdade (git pull + npm install + npm test, e SO
// reinicia o pm2 se tudo passar) fica isolada em deploy.js, roda como processo filho desacoplado
// pra sobreviver ao proprio restart que ela vai provocar neste processo.
app.post('/deploy-webhook', (req, res) => {
  if (!DEPLOY_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'DEPLOY_WEBHOOK_SECRET nao configurado — auto-deploy desabilitado' });
  }
  if (!assinaturaGithubValida(req)) return res.sendStatus(401);

  const evento = req.get('X-GitHub-Event');
  if (evento !== 'push') return res.status(202).json({ ok: true, ignorado: `evento ${evento || 'desconhecido'}` });

  const branchRef = req.body?.ref; // ex.: "refs/heads/main"
  if (branchRef !== `refs/heads/${DEPLOY_BRANCH}`) {
    return res.status(202).json({ ok: true, ignorado: `branch ${branchRef || 'desconhecido'}` });
  }

  if (deployJaRodando()) {
    console.log('  ⏭️ deploy ja em andamento — entrega duplicada do GitHub ignorada');
    return res.status(202).json({ ok: true, ignorado: 'deploy ja em andamento' });
  }

  console.log(`\n🚀 Push em ${DEPLOY_BRANCH} recebido — disparando deploy.js`);
  const child = require('child_process').spawn(process.execPath, [
    path.join(__dirname, 'deploy.js'),
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  try { fs.writeFileSync(DEPLOY_LOCK_FILE, String(child.pid)); } catch (e) {
    console.error(`  ⚠️ nao consegui gravar deploy.lock: ${e.message}`);
  }

  res.status(202).json({ ok: true, deploy: 'iniciado' });
});

// Status de assinatura do contrato (doc_signed/doc_refused/email_bounce) — configurar no painel do
// ZapSign apontando pra https://<seu-dominio>/zapsign-webhook, com o header customizado descrito em
// zapsignWebhookValido. Responde 200 antes de processar, mesmo padrao de /webhook — a ZapSign nao
// precisa esperar o Moskit responder pra considerar a entrega bem-sucedida.
app.post('/zapsign-webhook', (req, res) => {
  res.sendStatus(200);
  if (!zapsignWebhookValido(req)) {
    console.log('  ⚠️ /zapsign-webhook: header de autenticacao invalido ou ausente — evento ignorado');
    return;
  }
  processarWebhookZapSign(req.body).catch((e) => {
    console.error(`  ❌ Erro ao processar webhook do ZapSign: ${e.message}`);
  });
});

// So gera nota pros eventos que interessam ao escritorio (assinado/recusado/e-mail nao entregue) —
// doc_created/doc_deleted so atualizam o status em silencio, pra nao poluir o deal com nota
// redundante do que o proprio bot ja anotou ao criar o documento.
async function processarWebhookZapSign(payload) {
  const info = zapsign.interpretarStatusWebhook(payload);
  if (!info.docToken) return;

  const row = db.prepare('SELECT deal_id FROM conversations WHERE contrato_zapsign_doc_token = ?').get(info.docToken);
  if (!row?.deal_id) {
    console.log(`  ⚠️ webhook ZapSign: doc_token ${info.docToken} nao corresponde a nenhum deal conhecido`);
    return;
  }

  db.prepare('UPDATE conversations SET contrato_zapsign_status = ? WHERE contrato_zapsign_doc_token = ?')
    .run(info.status || info.eventType || null, info.docToken);

  // Fechamento do negocio (WON/LOST) continua exclusivo de equipe_declarou_ganho/perdido na
  // conversa (ver fecharNegocioSeAplicavel) — assinatura do contrato NAO fecha o deal
  // automaticamente, e uma decisao de produto que nao foi pedida e fica de fora de proposito.
  if (info.recusado) {
    await enviarTelegram(`❌ *Cliente recusou assinar o contrato*\nDeal: \`${row.deal_id}\`\nContrato de Prestação de Serviço (ZapSign).`).catch(() => {});
  } else if (info.emailFalhou) {
    await enviarTelegram(`⚠️ *Falha ao entregar e-mail de assinatura*\nDeal: \`${row.deal_id}\`\nContrato (ZapSign) — verificar o endereço ou reenviar manualmente.`).catch(() => {});
  }
}

function processarMensagemRecebida(chatId, phone, contactName, corpo, role, idZernio) {
  try {
    const phoneClean = chaveConversa(phone || chatId);
    const existente = stmtMoskitGet.get(phoneClean);
    const statusCliente = existente ? `🔵 Cliente EXISTENTE (${existente.name})` : '🟢 Cliente NOVO';

    const origem = role === 'equipe' ? '📤 MSG enviada pela equipe pra' : '📩 MSG recebida de';
    console.log(`\n${origem}: ${chatId} | ${statusCliente} | corpo:`, (corpo || '').substring(0, 200));

    // Ignorar conversas de socios/equipe (numero da conversa em si eh interno, nao um cliente).
    // Barra na ENTRADA: sem isso a mensagem era gravada e so descartada no fim do pipeline, e a
    // conversa interna crescia no banco a toa (a do Bruno acumulou 318 mensagens).
    if (ehInterno(phoneClean) || ehInterno(chatId)) {
      console.log(`  ⏭️ numero interno (equipe/socio) — nao registrado como lead`);
      return;
    }

    const row = stmtGet.get(chatId);
    const mensagens = row ? JSON.parse(row.messages) : [];
    const nova = {
      role: role || 'cliente',
      text: corpo,
      timestamp: new Date().toISOString(),
      // id do Zernio gravado desde a entrada: e o que permite ao polling reconhecer esta mensagem
      // depois. Sem ele, o polling nao a via e re-adicionava o historico inteiro.
      id_zernio: idZernio || null,
    };

    // O webhook pode reentregar o mesmo evento (retry do Zernio). `jaExiste` so barra quando o id
    // bate, ou quando o texto e longo o bastante pra coincidencia ser implausivel — rajada de
    // imagens (mesmo placeholder, varios envios) continua passando.
    if (jaExiste(nova, mensagens)) {
      console.log(`  ⏭️ mensagem ja registrada — ignorando reentrega do webhook`);
      return;
    }
    mensagens.push(nova);

    stmtUpsert.run(chatId, phone, contactName, JSON.stringify(mensagens), new Date().toISOString());
    console.log(`  -> salva no banco (${mensagens.length} msgs acumuladas), timer resetado`);

    agendarProcessamento(chatId);
  } catch (erro) {
    console.error('❌ Erro no processamento da mensagem:', erro.message);
    console.error(erro.stack);
  }
}

// ------------------------------------------------------------
// Sincronizar conversas via API Zernio
// ------------------------------------------------------------
// Tipos de atividade do Moskit que representam consulta/reuniao marcada (GET /activityTypes):
// 87134 = Reuniao, 87361 = Videoconferencia. Ligacao/Email/Whatsapp nao viram evento de calendario.
const ATIVIDADE_TIPOS_CONSULTA = MOSKIT_IDS.ATIVIDADE_TIPOS_CONSULTA;

// Marca, na nota do Moskit, que a reuniao foi liberada sem comprovante — sem isso nao ha como
// auditar depois quais consultas foram agendadas sem pagamento (ou, no caso de retorno, sem cobrar
// de novo por uma reuniao que ja foi paga na consulta original).
function seloConsultaGratis(motivo) {
  if (motivo === 'consulta_gratis') return '\n🆓 Consulta gratuita (marcada no Moskit) — evento criado sem comprovante de pagamento.';
  if (motivo === 'retorno') return '\n🔁 Reunião de retorno do caso já atendido — liberada sem novo comprovante.';
  return '';
}

// Evita dois ciclos sobrepostos: o setInterval dispara a cada 3 min e a rota manual pode disparar
// por cima. Com o gate liberado cada atividade faz varias chamadas de rede, e duas execucoes
// simultaneas criariam evento, Meet e aviso no Telegram duplicados pro mesmo cliente.
let sincronizacaoAtividadesEmAndamento = false;

// Sincroniza Atividades do Moskit (marcadas manualmente ou por qualquer integracao, incluindo
// o Moskit Boost) com o Google Calendar — cobre consultas que nunca passaram pela conversa
// que o bot analisa (ex: deals vindos do Boost, ou atividade criada direto no Moskit).
// Pausa entre atividades da varredura. Sem ela, cada atividade nova podia disparar ate 6 chamadas
// HTTP de volta em volta (checar evento nativo no Google, ate 2 GETs de autorizacao no Moskit,
// criar/patch do evento no Google, POST de nota no Moskit, Telegram) sem nenhum delay — o mesmo
// padrao de rajada que ja causou o incidente de 429/timeout medido em reconciliarVinculoAtividades
// (ver RECONCILIACAO_PAUSA_MS/VINCULO_PAUSA_MS, mais abaixo), so que esta rotina nunca ganhou a
// mesma defesa. Um backlog de N atividades (pos-indisponibilidade, importacao em massa via Moskit
// Boost) e o cenario que dispara isso.
const SYNC_ATIVIDADES_PAUSA_MS = Number(process.env.SYNC_ATIVIDADES_PAUSA_MS) || 300;

async function sincronizarAtividadesMoskit() {
  const relatorio = { atividades_verificadas: 0, eventos_criados: 0, ja_sincronizadas: 0, aguardando_pagamento: 0, liberadas_consulta_gratis: 0, liberadas_retorno: 0, ignoradas: 0, erros: 0 };

  if (!getGoogleAuthClient()) {
    console.log('  ⏭️ Google Calendar nao configurado — pulando sincronizacao de atividades');
    return relatorio;
  }

  if (sincronizacaoAtividadesEmAndamento) {
    console.log('  ⏭️ Sincronizacao de atividades ja em andamento — pulando este ciclo');
    return relatorio;
  }
  sincronizacaoAtividadesEmAndamento = true;

  try {
    const { atividades, truncou } = await listarAtividadesMoskit();
    relatorio.atividades_verificadas = atividades.length;
    relatorio.varredura_truncada = truncou;
    console.log(`  📅 ${atividades.length} atividades recentes encontradas no Moskit`);
    // Teto silencioso aqui se leria como "varri tudo e nao tinha nada" — que foi exatamente o engano
    // enquanto `?page=` era ignorado e a varredura via 10 de 1165.
    if (truncou) console.log(`  ⚠️ teto de ${MAX_PAGINAS_ATIVIDADES} paginas atingido — atividades mais antigas que essas nao foram verificadas neste ciclo`);

    const agora = Date.now();
    let primeira = true;

    for (const atv of atividades) {
      try {
        if (!ATIVIDADE_TIPOS_CONSULTA.has(atv.type?.id)) continue;
        if (atv.doneDate) continue; // ja realizada/concluida
        if (!atv.dueDate || new Date(atv.dueDate).getTime() <= agora) continue; // so agenda futura

        if (stmtAtividadeJaSincronizada.get(atv.id)) {
          relatorio.ja_sincronizadas++;
          continue;
        }

        // So pausa quando a atividade realmente vai gerar chamada de rede — os filtros acima (tipo,
        // estado, ja sincronizada) sao locais e nao tocam Google/Moskit, pausar antes deles
        // desperdicaria tempo em atividades que nem chegam a fazer request nenhum.
        if (!primeira) await new Promise((r) => setTimeout(r, SYNC_ATIVIDADES_PAUSA_MS));
        primeira = false;

        const dealId = atv.deals?.[0]?.id || null;
        const calendar = google.calendar({ version: 'v3', auth: getGoogleAuthClient() });

        // O proprio Moskit ja sincroniza algumas atividades nativamente com esse calendario,
        // usando o ID "oll<activity_id>". Se ja existir, nao criar um evento duplicado —
        // so garantir que ele tenha o link do Meet (quando o pagamento ja estiver verificado).
        const ollEventId = `oll${atv.id}`;
        let eventoNativo = null;
        try {
          const getRes = await calendar.events.get({ calendarId: GOOGLE_CALENDAR_ID, eventId: ollEventId });
          eventoNativo = getRes.data;
        } catch {
          // 404 esperado: Moskit nao sincronizou essa nativamente, seguimos e criamos nosso proprio evento
        }

        if (eventoNativo) {
          if (eventoNativo.hangoutLink || eventoNativo.conferenceData?.entryPoints?.length) {
            // Unica chance de enriquecer titulo/descricao desta atividade: depois de marcada como
            // sincronizada ela nunca mais passa por aqui (stmtAtividadeJaSincronizada filtra no topo
            // do loop). Se ja tinha Meet mas nao tinha o numero do negocio, e agora ou nunca.
            const summaryComDeal = comSufixoDealId(eventoNativo.summary, dealId);
            const descComDeal = comMarcadorDeal(eventoNativo.description, dealId);
            if (dealId && (summaryComDeal !== eventoNativo.summary || descComDeal !== eventoNativo.description)) {
              await calendar.events.patch({
                calendarId: GOOGLE_CALENDAR_ID,
                eventId: ollEventId,
                requestBody: { summary: summaryComDeal, description: descComDeal },
              });
            }
            stmtAtividadeMarcarSincronizada.run(atv.id, ollEventId, dealId);
            relatorio.ja_sincronizadas++;
            continue;
          }

          const authNativa = await autorizacaoParaAgendar(dealId);
          if (!authNativa.permitido) {
            relatorio.aguardando_pagamento++;
            console.log(`  ⏳ Atividade "${atv.title}" (nativa do Moskit) aguardando comprovante verificado — Meet ainda nao sera criado`);
            continue;
          }
          if (authNativa.motivo === 'consulta_gratis') {
            relatorio.liberadas_consulta_gratis++;
            console.log(`  🆓 Atividade "${atv.title}" (nativa do Moskit) liberada SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
          } else if (authNativa.motivo === 'retorno') {
            relatorio.liberadas_retorno++;
            console.log(`  🔁 Atividade "${atv.title}" (nativa do Moskit) liberada SEM comprovante — deal ${dealId} ja teve reuniao realizada`);
          }

          const patched = await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ollEventId,
            conferenceDataVersion: 1,
            requestBody: {
              // Mesma logica do curto-circuito acima: esta e a outra (e ultima) janela em que esta
              // atividade passa por aqui, entao o numero do negocio entra no MESMO patch que cria o
              // Meet — nao vale a pena um segundo round-trip so pra isso.
              summary: comSufixoDealId(eventoNativo.summary, dealId),
              description: comMarcadorDeal(eventoNativo.description, dealId),
              conferenceData: { createRequest: { requestId: `meet-native-${atv.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
            },
          });
          stmtAtividadeMarcarSincronizada.run(atv.id, ollEventId, dealId);
          relatorio.ja_sincronizadas++;

          const meetLinkNativo = extrairMeetLink(patched.data);
          const dataFormatadaNativo = new Date(atv.dueDate).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });
          console.log(`  ✅ Link do Meet adicionado ao evento nativo "${atv.title}" (${ollEventId}): ${meetLinkNativo}`);

          await notificarTelegramMeet({ nome: atv.title, telefone: null, advogado: null, dataHoraTexto: dataFormatadaNativo, meetLink: meetLinkNativo, dealId });
          continue;
        }

        // Moskit ainda nao sincronizou essa atividade — so criamos o evento (e o Meet) quando
        // o pagamento ja estiver verificado, senao ficaria uma reuniao/link marcada sem confirmacao real.
        const auth = await autorizacaoParaAgendar(dealId);
        if (!auth.permitido) {
          relatorio.aguardando_pagamento++;
          console.log(`  ⏳ Atividade "${atv.title}" aguardando comprovante verificado — evento ainda nao sera criado`);
          continue;
        }
        if (auth.motivo === 'consulta_gratis') {
          relatorio.liberadas_consulta_gratis++;
          console.log(`  🆓 Atividade "${atv.title}" liberada SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
        } else if (auth.motivo === 'retorno') {
          relatorio.liberadas_retorno++;
          console.log(`  🔁 Atividade "${atv.title}" liberada SEM comprovante — deal ${dealId} ja teve reuniao realizada`);
        }

        const inicio = new Date(atv.dueDate);
        const fim = new Date(inicio.getTime() + (atv.duration || 60) * 60 * 1000);

        // Id deterministico: se o insert der certo mas a resposta se perder (timeout, processo
        // morto antes de marcar no banco), o ciclo seguinte recebe 409 em vez de criar um evento
        // duplicado. So [a-v0-9] e aceito pelo Google.
        const eventIdAtv = `moskitatv${atv.id}`;
        let evento;
        try {
          evento = await calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            requestBody: {
              id: eventIdAtv,
              summary: comSufixoDealId(atv.title, dealId),
              description: comMarcadorDeal([
                atv.notes || '',
                dealId ? `Negócio no Moskit: https://app.ollow.com.br/?/deal/${dealId}` : '',
              ].filter(Boolean).join('\n\n'), dealId),
              start: { dateTime: inicio.toISOString() },
              end: { dateTime: fim.toISOString() },
              conferenceData: {
                createRequest: {
                  requestId: `meet-atv-${atv.id}`,
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            },
            conferenceDataVersion: 1,
          });
        } catch (e) {
          const status = e.code || e.response?.status;
          if (status !== 409) throw e;
          console.log(`  ⏭️ Evento ${eventIdAtv} ja existia no calendario — marcando como sincronizado`);
          stmtAtividadeMarcarSincronizada.run(atv.id, eventIdAtv, dealId);
          relatorio.ja_sincronizadas++;
          continue;
        }

        stmtAtividadeMarcarSincronizada.run(atv.id, evento.data.id, dealId);
        relatorio.eventos_criados++;
        // Com timeZone explicito: sem ele este log sai na hora do SISTEMA (a VPS roda em UTC, 3h
        // adiantado) enquanto o aviso do Telegram, tres linhas abaixo, sai na hora do escritorio —
        // o mesmo compromisso aparecia em dois horarios diferentes dependendo de onde se olhava.
        console.log(`  ✅ Evento criado pra atividade "${atv.title}" (${inicio.toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO })})`);

        const meetLink = extrairMeetLink(evento.data);
        const dataFormatada = inicio.toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });

        await notificarTelegramMeet({
          nome: atv.title,
          telefone: null,
          advogado: null,
          dataHoraTexto: dataFormatada,
          meetLink,
          dealId,
        });
      } catch (e) {
        console.error(`  ❌ Erro ao sincronizar atividade ${atv.id}: ${e.message}`);
        relatorio.erros++;
      }
    }

    console.log(`\n📅 Sincronizacao de atividades concluida: ${relatorio.eventos_criados} eventos criados, ${relatorio.ja_sincronizadas} ja sincronizadas, ${relatorio.aguardando_pagamento} aguardando pagamento, ${relatorio.liberadas_consulta_gratis} liberadas por consulta gratis, ${relatorio.liberadas_retorno} liberadas por retorno, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro na sincronizacao de atividades: ${e.message}`);
    relatorio.erros++;
  } finally {
    sincronizacaoAtividadesEmAndamento = false;
  }

  return relatorio;
}

// Adiciona link do Google Meet a eventos futuros ja existentes no calendario que ainda
// nao tem link (criados antes dessa funcionalidade existir, ou nativamente pelo Moskit).
// Roda uma vez (via rota manual), nao faz parte do ciclo periodico.
async function backfillMeetLinks(dryRun) {
  const relatorio = { eventos_verificados: 0, links_adicionados: 0, ja_tinham_link: 0, aguardando_pagamento: 0, liberadas_consulta_gratis: 0, liberadas_retorno: 0, erros: 0, candidatos: [] };
  const auth = getGoogleAuthClient();
  if (!auth) {
    console.log('  ⏭️ Google Calendar (OAuth2) nao configurado — pulando backfill de Meet links');
    return relatorio;
  }

  const calendar = google.calendar({ version: 'v3', auth });
  let pageToken;
  try {
    do {
      const res = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        timeMin: new Date().toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      const eventos = res.data.items || [];
      relatorio.eventos_verificados += eventos.length;

      for (const ev of eventos) {
        try {
          if (ev.status === 'cancelled') continue;
          // So mexe em evento que e uma consulta de verdade: tem link de negocio do Moskit
          // na descricao (evento criado pelo bot na Fase 5, ou nativamente pelo Moskit/"oll"),
          // o marcador `[deal:id]` que todo evento criado pelo bot carrega (montarDescricaoEvento),
          // ou segue o padrao de titulo usado pelo bot na Fase 4 ("Consulta — nome (advogado)") ou
          // pela reuniao de retorno ("Retorno N — nome (advogado)", ver src/reuniao-retorno.js).
          // Sem esse filtro, o backfill mexe em QUALQUER evento futuro do calendario
          // (aniversarios, reunioes internas recorrentes etc.) — ja aconteceu uma vez.
          const eDeConsulta = /\/deal\/\d+/.test(ev.description || '')
            || /\[deal:\d+\]/.test(ev.description || '')
            || /^Consulta\s*—/.test(ev.summary || '')
            || /^Retorno\s+\d+\s*—/.test(ev.summary || '');
          if (!eDeConsulta) continue;

          if (ev.hangoutLink || ev.conferenceData?.entryPoints?.length) {
            relatorio.ja_tinham_link++;
            continue;
          }

          // Eventos com link de negocio na descricao (Fase 5 / nativos do Moskit) so ganham Meet
          // se ja houver comprovante verificado — os "Consulta — " (Fase 4) ja nasceram gated.
          const dealMatch = (ev.description || '').match(/\/deal\/(\d+)/);
          const dealId = dealMatch ? Number(dealMatch[1]) : null;

          let motivoLiberacao = null;
          if (dealId) {
            const authBackfill = await autorizacaoParaAgendar(dealId);
            if (!authBackfill.permitido) {
              relatorio.aguardando_pagamento++;
              console.log(`  ⏳ Evento "${ev.summary}" aguardando comprovante verificado — Meet ainda nao sera adicionado`);
              continue;
            }
            motivoLiberacao = authBackfill.motivo;
            if (motivoLiberacao === 'consulta_gratis') {
              relatorio.liberadas_consulta_gratis++;
              console.log(`  🆓 Evento "${ev.summary}" liberado SEM comprovante — deal ${dealId} marcado como "consulta gratis"`);
            } else if (motivoLiberacao === 'retorno') {
              relatorio.liberadas_retorno++;
              console.log(`  🔁 Evento "${ev.summary}" liberado SEM comprovante — deal ${dealId} ja teve reuniao realizada`);
            }
          }

          if (dryRun) {
            relatorio.candidatos.push({ id: ev.id, summary: ev.summary, start: ev.start?.dateTime || ev.start?.date, motivo: motivoLiberacao });
            continue;
          }

          const patched = await calendar.events.patch({
            calendarId: GOOGLE_CALENDAR_ID,
            eventId: ev.id,
            conferenceDataVersion: 1,
            requestBody: {
              conferenceData: {
                createRequest: { requestId: `meet-backfill-${ev.id}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
              },
            },
          });
          const meetLink = extrairMeetLink(patched.data);
          relatorio.links_adicionados++;
          console.log(`  ✅ Link do Meet adicionado ao evento "${ev.summary}": ${meetLink}`);

          const dataHoraTexto = new Date(ev.start?.dateTime || ev.start?.date).toLocaleString('pt-BR', { timeZone: TZ_ESCRITORIO });

          await notificarTelegramMeet({ nome: ev.summary, telefone: null, advogado: null, dataHoraTexto, meetLink, dealId });
        } catch (e) {
          relatorio.erros++;
          console.error(`  ❌ Erro ao adicionar Meet no evento ${ev.id}: ${e.message}`);
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);

    console.log(`\n🔗 Backfill de Meet concluido: ${relatorio.links_adicionados} links adicionados, ${relatorio.ja_tinham_link} ja tinham, ${relatorio.aguardando_pagamento} aguardando pagamento, ${relatorio.liberadas_consulta_gratis} liberadas por consulta gratis, ${relatorio.liberadas_retorno} liberadas por retorno, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro no backfill de Meet links: ${e.message}`);
    relatorio.erros++;
  }

  return relatorio;
}

async function sincronizarConversas() {
  const relatorio = { conversas_encontradas: 0, atualizadas: 0, novas_mensagens: 0, erros: 0 };

  try {
    console.log('\n🔁 Iniciando sincronizacao com API Zernio...');

    const { data: convResp } = await axios.get('https://zernio.com/api/v1/inbox/conversations', {
      params: { platform: 'whatsapp', limit: 100, sortOrder: 'desc' },
      headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },
      validateStatus: (s) => s < 500,
    });

    const conversations = convResp?.data || [];
    relatorio.conversas_encontradas = conversations.length;
    console.log(`  📞 ${conversations.length} conversas WhatsApp encontradas na API`);

    for (const conv of conversations) {
      const phone = chaveConversa(conv.participantId);
      const contactName = conv.participantName || phone;
      if (!phone) continue;

      // O polling tambem precisa da trava: era por aqui que a conversa interna era gravada e
      // enfileirada, mesmo com o webhook barrando na outra ponta.
      if (ehInterno(phone)) continue;

      const row = stmtGet.get(phone);
      const lastActivity = row?.last_activity ? new Date(row.last_activity).getTime() : 0;

      if (row && new Date(conv.updatedTime).getTime() <= lastActivity) {
        continue;
      }

      try {
        const { data: msgsResp } = await axios.get(
          `https://zernio.com/api/v1/inbox/conversations/${conv.id}/messages`,
          {
            params: { accountId: conv.accountId, limit: 100, sortOrder: 'asc' },
            headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },
            validateStatus: (s) => s < 500,
          }
        );

        const msgsApi = msgsResp?.messages || [];
        if (!msgsApi.length) continue;

        const mensagensExistentes = row ? JSON.parse(row.messages) : [];
        // Dedup por id_zernio OU por conteudo (so texto longo nao-anexo). Antes era so por id, e
        // mensagem gravada pelo webhook — que nao tinha id — era invisivel aqui, fazendo o historico
        // inteiro ser re-adicionado.
        let novas = 0;
        const audiosPendentes = [];

        for (const m of msgsApi) {
          if (m.direction !== 'incoming' && m.direction !== 'outgoing') continue;

          const role = m.direction === 'outgoing' ? 'equipe' : 'cliente';
          let texto;
          let audioAtt = null;
          if (m.attachments && m.attachments.length > 0) {
            const att = m.attachments[0];
            const quem = role === 'equipe' ? 'equipe enviou' : 'cliente enviou';
            texto = att.filename ? `📎 [${quem}: ${att.filename}]` : `📎 [${quem} ${att.type}]`;
            // Rede de seguranca para os audios que o webhook perdeu (bot fora do ar, reentrega
            // falha). Transcreve depois de salvar, fire-and-forget — nao segura o ciclo de polling.
            if (role === 'cliente' && att.type === 'audio') audioAtt = att;
          } else {
            texto = m.message || '';
          }
          if (!texto) continue;

          const nova = { role, text: texto, timestamp: m.createdAt, id_zernio: m.id };
          if (jaExiste(nova, mensagensExistentes)) continue;
          mensagensExistentes.push(nova);
          novas++;
          if (audioAtt && m.id) audiosPendentes.push({ att: audioAtt, id: m.id });
        }

        if (novas > 0) {
          // Ordena por timestamp: o polling insere mensagens ANTIGAS no fim do array (relogio do
          // Zernio x hora de chegada no webhook), e montarHistorico renderiza na ordem do array —
          // sem isso o historico mostra os dias voltando no tempo.
          const mensagensFinais = normalizarMensagens(mensagensExistentes);
          stmtUpsert.run(phone, phone, contactName, JSON.stringify(mensagensFinais), conv.updatedTime);
          relatorio.atualizadas++;
          relatorio.novas_mensagens += novas;
          console.log(`  ✅ ${phone} (${contactName}): +${novas} mensagens`);

          for (const { att, id } of audiosPendentes) {
            processarAudioCliente(phone, att, id)
              .catch((e) => console.error(`  ❌ Erro ao transcrever audio de ${phone} (polling): ${e.message}`));
          }

          if (mensagensExistentes.length > 0) {
            const inativo = Date.now() - new Date(conv.updatedTime).getTime();
            // Sempre pelo helper: a atribuicao direta em `timers` que existia aqui nao fazia
            // clearTimeout, entao a cada ciclo de polling o timer anterior ficava vivo e a mesma
            // conversa era processada mais de uma vez.
            const restante = Math.max(0, TEMPO_INATIVIDADE_MS - inativo);
            agendarProcessamento(phone, restante);
          }
        }
      } catch (e) {
        console.error(`  ❌ Erro ao sincronizar ${phone}: ${e.message}`);
        relatorio.erros++;
      }
    }

    console.log(`\n🔁 Sincronizacao concluida: ${relatorio.conversas_encontradas} conversas, ${relatorio.atualizadas} atualizadas, ${relatorio.novas_mensagens} novas mensagens, ${relatorio.erros} erros`);
  } catch (e) {
    console.error(`\n❌ Erro na sincronizacao: ${e.message}`);
    relatorio.erros++;
  }

  return relatorio;
}

// ------------------------------------------------------------
// Importar contatos do Moskit
// ------------------------------------------------------------
async function importarContatosMoskit() {
  let nextToken = '';
  let total = 0;
  let importados = 0;

  console.log('\n📥 Importando contatos do Moskit...');

  while (true) {
    const params = { limit: 100 };
    if (nextToken) params.nextPageToken = nextToken;
    try {
      const res = await axios.get(`${MOSKIT_BASE}/contacts`, {
        params,
        headers: apiHeaders,
        validateStatus: (s) => s < 500,
      });
      const contatos = res.data || [];
      if (!contatos.length) break;

      for (const c of contatos) {
        const phones = c.phones || [];
        for (const p of phones) {
          // chaveConversa (src/telefone.js) e a MESMA regra que buscarOuCriarContato usa pra ler este
          // espelho depois. Antes este loop tinha seu proprio minimo (>=10 digitos), diferente do
          // resto do sistema (MIN_DIGITOS=8) — um contato de 8-9 digitos (fixo sem DDD) nunca entrava
          // no espelho, e toda busca por ele caia no fallback lento da API, justo o caso que o espelho
          // existe para evitar (contato duplicado).
          const num = chaveConversa(p.number);
          if (num) {
            stmtMoskitUpsert.run(num, c.id, c.name || '', JSON.stringify(c));
            importados++;
          }
        }
      }
      total += contatos.length;

      const headers = res.headers;
      nextToken = headers['x-moskit-listing-next-page-token'] || headers['x-ollow-listing-next-page-token'] || '';
      if (!nextToken) break;
    } catch (e) {
      console.error(`  ❌ Erro na importacao: ${e.message}`);
      break;
    }
  }

  console.log(`  ✅ ${importados} telefones importados de ${total} contatos do Moskit`);
  return { total_contatos: total, telefones_importados: importados };
}

// ------------------------------------------------------------
// Reconciliacao da classificacao (o CRM tem que refletir a decisao ATUAL do bot)
// ------------------------------------------------------------
// Por que existe: todas as travas de classificacao agem NO MOMENTO do ciclo. Se um PUT falhar fora de um
// ciclo, se a conversa parar de receber mensagens, ou se alguem mexer no CRM depois, nada nunca
// reconferia — foi assim que "LGPD" ficou preso no deal 48423360 enquanto o bot dizia "Direito
// Administrativo" a cada rodada. Aqui o bot volta e confere.
//
// Regras (as mesmas do caminho normal de escrita, por reuso de atualizarNegocioMoskit):
//   - campo vazio no CRM e o bot sabe o valor        => preenche
//   - divergente e o valor de la foi escrito pelo bot => corrige
//   - divergente e travado por correcao manual        => NAO toca, entra no resumo do Telegram
//   - sem registro de autoria (deal anterior a isto)  => NAO toca (incluirLegado forca)
//   - deal WON/LOST                                   => NAO toca, so reporta
const RECONCILIACAO_INTERVAL_MS = Number(process.env.RECONCILIACAO_INTERVAL_MS) || 30 * 60 * 1000;
const RECONCILIACAO_ATIVA = process.env.RECONCILIACAO_ATIVA !== 'false'; // default ligada
const RECONCILIACAO_DIAS = Number(process.env.RECONCILIACAO_DIAS) || 30;
// Pausa entre as leituras da varredura: uma passada por 64 deals ja levou 429 do Moskit.
const RECONCILIACAO_PAUSA_MS = Number(process.env.RECONCILIACAO_PAUSA_MS) || 300;
// Reconciliação de vínculo de atividade (ver reconciliarVinculoAtividades): o Moskit rate-limita
// (HTTP 429) e o timeout global e de 30s — medido 14-17/08/2026, uma varredura retentada a cada
// RECONCILIACAO_INTERVAL_MS contra um vinculo quebrado nunca religava e enchia o Telegram de erro.
// VINCULO_MAX_TENTATIVAS: falhas consecutivas antes de desistir (estado terminal). Apos isso a linha
// so volta a ser conferida quando o script religar-atividade.js limpar o estado.
// VINCULO_BACKOFF_CICLOS: cooldown inicial em ciclos de RECONCILIACAO_INTERVAL_MS, dobrado a cada
// falha (1, 2, 4...) — e o intervalo com que a varredura volta a bater no Moskit, nunca mais que isso.
// VINCULO_PAUSA_MS: pausa entre as leituras da varredura, maior que a da classificacao porque aqui
// cada linha nao-vinculada custa GET+PUT (nao so um GET).
const VINCULO_MAX_TENTATIVAS = Number(process.env.VINCULO_MAX_TENTATIVAS) || 3;
const VINCULO_BACKOFF_CICLOS = Number(process.env.VINCULO_BACKOFF_CICLOS) || 4;
const VINCULO_PAUSA_MS = Number(process.env.VINCULO_PAUSA_MS) || 600;
// Ultimo resumo enviado ao Telegram. Sem isso, uma pendencia que depende de acao humana (campo travado)
// seria reenviada a cada rodada. Memoria de processo de proposito: um restart avisa de novo, o que e
// barato e melhor do que perder o aviso.
let ultimoResumoReconciliacao = null;
// Mesma ideia, para a reconciliacao de pendencias de agendamento em conversa silenciosa (ver
// reconciliarPendenciasAgendamento) — so evita repetir o LOG de resumo; cada pendencia urgente ja
// manda seu proprio Telegram individual, deduplicado por linha via agendamento_pendencia_avisada.
let ultimoResumoReconciliacaoPendencias = null;

// Nome canonico da area a partir do ID da opcao — o caminho inverso de buscarIdOpcao, usado pela
// reconciliacao para adotar a area que esta no CRM como fonte da verdade.
function nomeAreaPorId(idOpcao) {
  if (!idOpcao) return null;
  const alvo = Number(idOpcao);
  return Object.keys(MOSKIT_IDS.AREA_DIREITO).find((k) => MOSKIT_IDS.AREA_DIREITO[k] === alvo) || null;
}

// Os campos de classificacao que o bot afirma hoje, montados pelas MESMAS regras do payload real.
function camposClassificacaoDe(dados, condicoesValorEnviadas) {
  const payload = montarPayloadMoskit(dados, 0, { condicoesValorEnviadas });
  return payload.entityCustomFields || [];
}

// modo 'recentes' (default): igual a sempre, por updated_at, dentro da janela de RECONCILIACAO_DIAS.
// modo 'antigos': ignora a janela de dias e ordena por reconciliado_em (nunca visto primeiro) — e a
// forma de alcancar o deal que o modo 'recentes' nunca revisita porque parou de receber mensagem ha
// mais de RECONCILIACAO_DIAS ou caiu fora do top-N mais recentes. Cada linha processada por QUALQUER
// modo grava reconciliado_em = agora, o que faz a proxima rodada em modo 'antigos' avancar para a
// fatia seguinte em vez de reler sempre os mesmos registros.
async function reconciliarClassificacao({ aplicar = false, incluirLegado = false, limite = 100, modo = 'recentes' } = {}) {
  const linhas = modo === 'antigos'
    ? db.prepare(`
        SELECT chat_id, deal_id, last_data, bloco_condicoes_enviado, messages, atendimento_inicio_msg_idx
        FROM conversations
        WHERE deal_id IS NOT NULL AND last_data IS NOT NULL
        ORDER BY reconciliado_em IS NOT NULL, reconciliado_em ASC
        LIMIT ?
      `).all(limite)
    : db.prepare(`
        SELECT chat_id, deal_id, last_data, bloco_condicoes_enviado, messages, atendimento_inicio_msg_idx
        FROM conversations
        WHERE deal_id IS NOT NULL AND last_data IS NOT NULL
          AND (updated_at IS NULL OR updated_at >= datetime('now', ?))
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(`-${RECONCILIACAO_DIAS} days`, limite);

  const relatorio = {
    aplicar, incluir_legado: incluirLegado, janela_dias: RECONCILIACAO_DIAS, modo,
    analisados: 0, sem_divergencia: 0,
    corrigidos: [], a_corrigir: [], travados: [], legado: [], fechados: [],
    nao_rebaixados: [], deals_apagados: [], bloco_recalculado: [], erros: [],
  };

  let primeira = true;
  for (const linha of linhas) {
    const dados = parseJsonSeguro(linha.last_data, null);
    if (!dados) continue;

    // BLOCO DE CONDICOES RECALCULADO DAS MENSAGENS, nao lido da coluna. `bloco_condicoes_enviado` foi
    // adicionada depois de muitas conversas existirem, e nelas o valor e 0 — que significa "nunca
    // enviou o bloco", ou seja CORTESIA. Confiar na coluna aqui rebaixaria consulta paga para R$0 em
    // massa (13 deals na varredura de 12/08/2026). As mensagens estao no banco: e delas que sai a
    // verdade. Se o recalculo discordar da coluna, a coluna e corrigida de passagem.
    const mensagens = parseJsonSeguro(linha.messages, null) || [];
    // A janela do atendimento vale aqui tambem: sem ela, a reconciliacao recalcularia a cobranca do
    // negocio NOVO a partir do bloco de condicoes que a equipe mandou no atendimento ANTERIOR, e
    // rebaixaria/subiria o preco de um deal que nunca viu bloco nenhum.
    const blocoRecalculado = mensagens.length
      ? detectarBlocoCondicoes(mensagens, { inicio: janelaAtendimento(linha) }).enviado
      : linha.bloco_condicoes_enviado === 1;
    if (blocoRecalculado !== (linha.bloco_condicoes_enviado === 1)) {
      relatorio.bloco_recalculado.push({ chat_id: linha.chat_id, coluna: linha.bloco_condicoes_enviado, mensagens: blocoRecalculado ? 1 : 0 });
      console.log(`  💳 ${linha.chat_id}: bloco de condicoes recalculado das mensagens (coluna dizia ${linha.bloco_condicoes_enviado}, agora ${blocoRecalculado ? 1 : 0})`);
      // Persistir so quando for pra valer: dry-run tem que ser leitura pura, senao "conferir sem
      // escrever" deixa de ser verdade e ninguem confia no relatorio. O valor recalculado vale para esta
      // rodada de qualquer forma (esta em `blocoRecalculado`).
      if (aplicar) {
        db.prepare('UPDATE conversations SET bloco_condicoes_enviado = ? WHERE chat_id = ?').run(blocoRecalculado ? 1 : 0, linha.chat_id);
      }
    }

    relatorio.analisados++;
    // Marca esta linha como vista NESTA rodada, para o cursor do modo 'antigos' avancar. So em
    // aplicar=true: dry-run e leitura pura, mesma regra do bloco_condicoes_enviado acima — senao
    // "conferir sem escrever" (GET /auditoria-classificacao sem ?aplicar=1) deixaria de ser verdade.
    if (aplicar) {
      db.prepare("UPDATE conversations SET reconciliado_em = datetime('now') WHERE chat_id = ?").run(linha.chat_id);
    }

    try {
      // Espaco entre as leituras: a varredura de 64 deals ja tomou 429 do Moskit.
      if (!primeira) await new Promise((r) => setTimeout(r, RECONCILIACAO_PAUSA_MS));
      primeira = false;

      const dealRes = await axios.get(`${MOSKIT_BASE}/deals/${linha.deal_id}`, {
        headers: apiHeaders,
        validateStatus: (s) => s < 500,
      });
      if (dealRes.status === 404) {
        // Caso conhecido e acionavel (alguem apagou o deal no CRM e o banco ainda aponta pra ele), nao
        // um erro de integracao — separar evita esconder falha de verdade num monte de 404.
        relatorio.deals_apagados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id });
        continue;
      }
      if (dealRes.status < 200 || dealRes.status >= 300) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: `HTTP ${dealRes.status}` });
        continue;
      }
      const deal = dealRes.data;

      if (deal?.status && deal.status !== STATUS_DEAL.OPEN) {
        relatorio.fechados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, status: deal.status });
        continue;
      }

      const remotos = new Map((deal?.entityCustomFields || []).filter((c) => c?.id).map((c) => [c.id, (c.options || []).map(Number)]));
      const registro = lerRegistroCampos(linha.chat_id) || { escritos: {}, travados: new Set() };

      // NUNCA REBAIXAR: se o deal ja esta como consulta paga no CRM, o payload nao pode ser montado como
      // cortesia (montarPayloadMoskit tira o price junto com o campo). Corrigir PARA paga e seguro
      // — tem evidencia do bloco na conversa; rebaixar para R$0 nao e, porque a cobranca pode ter sido
      // combinada por telefone ou vindo num anexo que o detector nao le. Decisao do escritorio, 12/08/2026.
      const tipoRemotoEhPaga = (remotos.get(CF_TIPO_CONSULTA) || []).includes(TIPO_CONSULTA_PAGA_ID);
      const condicoesParaPayload = blocoRecalculado || tipoRemotoEhPaga;
      if (tipoRemotoEhPaga && !blocoRecalculado) {
        relatorio.nao_rebaixados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, motivo: 'CRM esta "consulta paga" e o bloco nao aparece nas mensagens — nao rebaixado' });
      }

      // A AREA QUE MANDA AQUI E A DO CRM, quando existe: ela foi curada pela equipe, enquanto a do
      // last_data pode ser palpite anterior as travas. Trocando a area no objeto (em vez de remendar o
      // campo do responsavel depois), tudo que deriva dela — inclusive o responsavel — sai coerente, e o
      // relatorio promete exatamente o que a escrita vai fazer. Area vazia no CRM continua sendo
      // preenchida com a do bot.
      const nomeAreaDoCrm = nomeAreaPorId((remotos.get(MOSKIT_IDS.CF.AREA_DIREITO) || [])[0]);
      const dadosParaEscrita = nomeAreaDoCrm ? { ...dados, area_direito: nomeAreaDoCrm } : dados;

      const esperados = camposClassificacaoDe(dadosParaEscrita, condicoesParaPayload);
      if (!esperados.length) continue;

      const divergentes = esperados.filter((e) => !opcoesIguais(remotos.get(e.id), e.options));
      if (!divergentes.length) { relatorio.sem_divergencia++; continue; }

      const detalhe = (campo) => ({
        chat_id: linha.chat_id,
        deal_id: linha.deal_id,
        campo: nomeCampo(campo.id),
        no_crm: (remotos.get(campo.id) || []).join(',') || '(vazio)',
        do_bot: (campo.options || []).join(','),
      });

      let corrigiveis = 0;
      for (const campo of divergentes) {
        const remoto = remotos.get(campo.id);
        const registrado = registro.escritos[campo.id];
        const temValorRemoto = !!(remoto && remoto.length);

        // Campo fora de CF_TRAVAVEIS (tipo de consulta e responsavel) e regido por regra, nao por
        // opiniao: nao existe autoria a respeitar nele, e o caminho de escrita tambem nao o filtra.
        // Sem esta linha os 4 responsaveis incoerentes cairiam em "legado" e nunca seriam corrigidos.
        if (!CF_TRAVAVEIS.has(campo.id)) {
          corrigiveis++;
          relatorio[aplicar ? 'corrigidos' : 'a_corrigir'].push(detalhe(campo));
          continue;
        }

        if (registro.travados.has(campo.id)) { relatorio.travados.push(detalhe(campo)); continue; }
        if (temValorRemoto && registrado === undefined && !incluirLegado) { relatorio.legado.push(detalhe(campo)); continue; }
        // Valor remoto que o bot nao escreveu: o caminho de escrita vai TRAVAR este campo (correcao
        // manual) em vez de corrigir. Nao prometemos no relatorio o que nao vai acontecer.
        if (temValorRemoto && registrado !== undefined && !opcoesIguais(registrado, remoto) && !incluirLegado) {
          relatorio.travados.push(detalhe(campo));
          continue;
        }
        corrigiveis++;
        relatorio[aplicar ? 'corrigidos' : 'a_corrigir'].push(detalhe(campo));
      }

      if (!corrigiveis || !aplicar) continue;

      const contactId = deal?.contacts?.[0]?.id;
      if (!contactId) {
        relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: 'deal sem contato — nao da pra montar o payload' });
        continue;
      }

      // Reusa o caminho normal de escrita: merge com o remoto, autoria/trava e confirmacao pos-PUT — uma
      // correcao que nao gruda no CRM vira erro visivel, nao sucesso silencioso.
      await atualizarNegocioMoskit(linha.deal_id, dadosParaEscrita, contactId, {
        chatId: linha.chat_id,
        condicoesValorEnviadas: condicoesParaPayload,
        forcarAutoria: incluirLegado,
      });
      console.log(`  🔁 Deal ${linha.deal_id} reconciliado (${divergentes.length} campo(s))`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: e.message });
      console.error(`  ❌ Reconciliacao do deal ${linha.deal_id}: ${e.message}`);
    }
  }

  return relatorio;
}

// Rotina periodica: corrige sozinha o que o proprio bot escreveu e avisa no Telegram o que ela NAO pode
// tocar (campo corrigido na mao, deal fechado, deal legado sem autoria) — essas dependem de decisao
// humana, entao viram aviso, nunca escrita.
// Alterna com o modo 'antigos' a cada 2 execucoes: o modo 'recentes' (sempre por updated_at, dentro
// de RECONCILIACAO_DIAS) nunca alcanca um deal que parou de receber mensagem ha mais de
// RECONCILIACAO_DIAS ou caiu fora do top-N mais recentes — esses ficavam esquecidos para sempre.
let contadorReconciliacaoPeriodica = 0;
async function rodarReconciliacaoPeriodica() {
  contadorReconciliacaoPeriodica++;
  const modo = contadorReconciliacaoPeriodica % 2 === 0 ? 'antigos' : 'recentes';
  const r = await reconciliarClassificacao({ aplicar: true, modo });

  const pendencias = [...r.travados, ...r.legado];
  if (!r.corrigidos.length && !pendencias.length) return r;

  console.log(`  🔁 Reconciliacao: ${r.analisados} deals conferidos, ${r.corrigidos.length} corrigidos, ${pendencias.length} pendencia(s) humana(s)`);

  const linhasResumo = [
    r.corrigidos.length ? `✅ ${r.corrigidos.length} campo(s) corrigido(s) automaticamente` : '',
    ...pendencias.slice(0, 10).map((p) => `• Deal \`${p.deal_id}\` — ${p.campo}: CRM "${p.no_crm}" x bot "${p.do_bot}"`),
    pendencias.length > 10 ? `… e mais ${pendencias.length - 10}` : '',
  ].filter(Boolean);

  const resumo = `🔁 *Reconciliação de classificação*\n${linhasResumo.join('\n')}`;
  if (resumo === ultimoResumoReconciliacao) return r; // nada novo desde a ultima rodada
  ultimoResumoReconciliacao = resumo;
  if (pendencias.length) {
    await enviarTelegram(`${resumo}\n\nEsses o bot não toca (correção manual, deal fechado ou negócio anterior ao registro de autoria).`);
  }
  return r;
}

// Rede de seguranca para o quirk medido em 14/08/2026 (ver garantirVinculoAtividadeDeal): mesmo com a
// conferencia logo apos criar, uma atividade pode ficar sem o vinculo com o negocio (ex.: a conferencia
// falhou por rede no mesmo ciclo). Varre toda conversa com atividade_moskit_id gravado e religa a que
// estiver solta — mesmo espirito de reconciliarClassificacao, rodando na mesma cadencia.
//
// MEDIDO 14-17/08/2026 (6 negocios): o Moskit responde 429/timeout de 30s quando a varredura bate
// forte, e um vinculo quebrado era retentado a cada RECONCILIACAO_INTERVAL_MS SEM NUNCA RELIGAR,
// inundando o Telegram com o mesmo aviso (o dedup por string do resumo nao segurava porque o
// subconjunto de falhas mudava a cada rodada). Por isso, aqui:
//   - falha registra vinculo_falhas e coloca a linha em cooldown (vinculo_backoff_ate), que DOBRA a
//     cada falha — a varredura nunca volta a bater no Moskit antes do cooldown vencer;
//   - ao atingir VINCULO_MAX_TENTATIVAS a linha entra em estado terminal (vinculo_desistiu=1) e recebe
//     UM aviso final no Telegram com o comando do script religar-atividade.js (dedup por
//     vinculo_aviso_hash);
//   - estado terminal so e desfeito pelo script manual: e um vínculo que precisa de acao humana, nao
//     de mais retentativa.
// Erro transitorio (429/timeout) nao gera mais Telegram nenhum — nao e "conferir na mao", e o Moskit
// dizendo calma. So desistencia (nova) e religacao (de verdade) avisam.
async function reconciliarVinculoAtividades({ aplicar = false } = {}) {
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, atividade_moskit_id, vinculo_falhas, vinculo_desistiu, vinculo_backoff_ate, vinculo_aviso_hash
      FROM conversations
     WHERE atividade_moskit_id IS NOT NULL
  `).all();

  const relatorio = { aplicar, analisados: 0, ja_ok: 0, religadas: [], a_religar: [], desistidas: [], avisadas: [], cooldown: 0, paradas: 0, erros_transitorios: 0 };

  const stmtResetVinculo = db.prepare(`
    UPDATE conversations SET vinculo_falhas = 0, vinculo_desistiu = 0, vinculo_backoff_ate = NULL, vinculo_aviso_hash = NULL WHERE chat_id = ?
  `);
  const stmtFalhaVinculo = db.prepare(`
    UPDATE conversations SET vinculo_falhas = ?, vinculo_backoff_ate = ?, vinculo_desistiu = ? WHERE chat_id = ?
  `);
  const stmtAvisoVinculo = db.prepare(`UPDATE conversations SET vinculo_aviso_hash = ? WHERE chat_id = ?`);

  const agora = Date.now();

  let primeira = true;
  for (const linha of linhas) {
    relatorio.analisados++;

    // Estado terminal: so o script religar-atividade.js desfaz. Nem chama a rede — retentativa aqui e
    // exatamente o que enchia o Telegram de erro.
    if (linha.vinculo_desistiu === 1) { relatorio.paradas++; continue; }
    // Cooldown: ainda na janela de backoff, nao bater no Moskit de novo.
    if (linha.vinculo_backoff_ate && agora < Number(linha.vinculo_backoff_ate)) { relatorio.cooldown++; continue; }

    try {
      if (!primeira) await new Promise((r) => setTimeout(r, VINCULO_PAUSA_MS));
      primeira = false;

      const res = await axios.get(`${MOSKIT_BASE}/activities/${linha.atividade_moskit_id}`, {
        headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' },
        validateStatus: (s) => s < 500,
      });
      if (res.status >= 300) {
        await registrarFalhaVinculo(linha, `HTTP ${res.status}`, aplicar, relatorio, stmtFalhaVinculo, stmtAvisoVinculo, agora);
        continue;
      }
      const vinculada = (res.data?.deals || []).some((d) => Number(d?.id) === Number(linha.deal_id));
      if (vinculada) {
        // Ja esta ok: limpa qualquer estado de falha anterior (cooldown/falhas residuais precisam
        // zerar para uma recuperacao espontanea nao ficar contando tentativa antiga).
        if (aplicar) stmtResetVinculo.run(linha.chat_id);
        relatorio.ja_ok++;
        continue;
      }

      if (!aplicar) {
        relatorio.a_religar.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id });
        continue;
      }
      const religou = await garantirVinculoAtividadeDeal(linha.atividade_moskit_id, linha.deal_id);
      if (!religou) {
        await registrarFalhaVinculo(linha, 'PUT de religacao falhou', aplicar, relatorio, stmtFalhaVinculo, stmtAvisoVinculo, agora);
        continue;
      }
      if (aplicar) stmtResetVinculo.run(linha.chat_id);
      relatorio.religadas.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id });
      console.log(`  🔁 Deal ${linha.deal_id}: atividade ${linha.atividade_moskit_id} religada ao negocio`);
    } catch (e) {
      console.error(`  ❌ Reconciliacao de vinculo da atividade ${linha.atividade_moskit_id} (deal ${linha.deal_id}): ${e.message}`);
      // A contagem de erros_transitorios acontece DENTRO de registrarFalhaVinculo (ramo de cooldown),
      // mesma fonte para os tres caminhos de falha (status>=300, PUT que falhou e excecao) — sem isso
      // uma excecao era contada duas vezes (aqui e la dentro).
      await registrarFalhaVinculo(linha, e.message, aplicar, relatorio, stmtFalhaVinculo, stmtAvisoVinculo, agora).catch(() => {});
    }
  }

  return relatorio;
}

// Registra uma falha na reconciliacao de vinculo: incrementa a contagem consecutiva, coloca a linha em
// cooldown exponencial e, ao estourar VINCULO_MAX_TENTATIVAS, marca o estado terminal e manda o aviso
// final (uma unica vez por desistencia, dedup por vinculo_aviso_hash).
async function registrarFalhaVinculo(linha, erro, aplicar, relatorio, stmtFalhaVinculo, stmtAvisoVinculo, agora) {
  const falhas = (Number(linha.vinculo_falhas) || 0) + 1;
  const multiplicador = Math.pow(2, Math.min(falhas, 10) - 1);
  const backoffAte = agora + VINCULO_BACKOFF_CICLOS * RECONCILIACAO_INTERVAL_MS * multiplicador;

  const desistiu = falhas >= VINCULO_MAX_TENTATIVAS;
  if (aplicar) {
    stmtFalhaVinculo.run(falhas, desistiu ? null : backoffAte, desistiu ? 1 : 0, linha.chat_id);
  }

  if (desistiu) {
    relatorio.desistidas.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id, erro });
    if (aplicar) {
      const hash = `desistida|${linha.deal_id}|${linha.atividade_moskit_id}`;
      if (linha.vinculo_aviso_hash !== hash) {
        relatorio.avisadas.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, atividade_moskit_id: linha.atividade_moskit_id, erro });
        stmtAvisoVinculo.run(hash, linha.chat_id);
        await enviarTelegram([
          '❌ *Atividade sem vínculo com o negócio — desistiu de religar sozinho*',
          `Deal: \`${linha.deal_id}\``,
          `Atividade: \`${linha.atividade_moskit_id}\``,
          `Último erro: ${erro}`,
          '',
          'O bot tentou religar várias vezes e o Moskit não deixou (rate-limit/timeout). A atividade continua sem aparecer na tela do negócio. Vincular na mão:',
          '',
          '```',
          `node religar-atividade.js ${linha.deal_id} ${linha.atividade_moskit_id} --aplicar`,
          '```',
        ].filter(Boolean).join('\n'));
      }
    }
    console.log(`  ❌ Deal ${linha.deal_id}: atividade ${linha.atividade_moskit_id} desistiu de religar apos ${falhas} tentativa(s) (${erro})`);
    return;
  }

  relatorio.erros_transitorios++;
  console.log(`  ⏸️ Deal ${linha.deal_id}: atividade ${linha.atividade_moskit_id} em cooldown (tentativa ${falhas}/${VINCULO_MAX_TENTATIVAS}, ${erro})`);
}

async function rodarReconciliacaoVinculoAtividades() {
  const r = await reconciliarVinculoAtividades({ aplicar: true });
  const silencioso = !r.religadas.length && !r.avisadas.length && !r.paradas && !r.cooldown && !r.erros_transitorios && !r.desistidas.length;
  if (silencioso && r.analisados === r.ja_ok) return r;

  console.log(`  🔁 Reconciliacao de vinculo de atividade: ${r.analisados} conferida(s), ${r.ja_ok} ja ok, ${r.religadas.length} religada(s), ${r.desistidas.length} desistida(s), ${r.cooldown} em cooldown, ${r.paradas} parada(s)`);

  if (r.religadas.length) {
    await enviarTelegram([
      '🔁 *Reconciliação de vínculo de atividade*',
      ...r.religadas.map((e) => `✅ Deal \`${e.deal_id}\` — atividade \`${e.atividade_moskit_id}\` religada ao negócio automaticamente`),
    ].join('\n'));
  }
  return r;
}

// Rede de seguranca pra pendencia de agendamento numa conversa que PAROU DE VEZ. A escalada por
// proximidade dentro de registrarAgendamentoPendente (ver AGENDAMENTO_URGENCIA_HORAS) so roda quando a
// conversa E REPROCESSADA — e nada neste codebase reprocessa uma conversa so porque o tempo passou
// (so mensagem nova, via webhook ou sincronizarConversas achando algo novo no Zernio). Uma pendencia
// sem nenhuma mensagem nova de nenhum lado fica congelada pra sempre. Medido em 14/08/2026, deal
// 48466404 (Teresinha): pagou e perguntou o endereco do escritorio — claramente acha que a consulta
// esta marcada — mas ninguem mais escreveu na conversa desde entao e a pendencia nunca escalou.
//
// NAO chama a OpenAI nem reprocessa a conversa — so lê o que ja esta gravado. `agendamento_pendente_hash`
// tem o formato `${horarioRelatado}|${motivo}|...` desde a criacao da funcao (ver registrarAgendamentoPendente),
// entao da pra reconstruir o horario em jogo mesmo quando `agendamento_apuracao` esta NULL (coluna
// recente — conversas que nao rodam mais um ciclo completo desde 13/08 nunca a preenchem).
async function reconciliarPendenciasAgendamento({ aplicar = false } = {}) {
  const linhas = db.prepare(`
    SELECT chat_id, deal_id, agendamento_pendente_hash, agendamento_pendencia_avisada
      FROM conversations
     WHERE agendamento_pendente_hash IS NOT NULL
  `).all();

  const relatorio = { aplicar, analisados: 0, avisados: [], erros: [] };
  const janelaHoras = AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS * 24;

  for (const linha of linhas) {
    relatorio.analisados++;
    if (linha.agendamento_pendente_hash === linha.agendamento_pendencia_avisada) continue; // ja avisado, nada mudou

    try {
      const [horarioRelatado, motivo] = String(linha.agendamento_pendente_hash).split('|');

      // Sinal independente de proximidade: comprovante ja verificado pra esse deal e compromisso real,
      // nao hipotese — avisa incondicionalmente, mesmo que o horario esteja fora da janela ou ausente.
      const comprovante = linha.deal_id
        ? db.prepare('SELECT 1 FROM comprovantes WHERE deal_id = ? AND match = 1 LIMIT 1').get(linha.deal_id)
        : null;

      let urgente = !!comprovante;
      if (!urgente && horarioRelatado && horarioRelatado !== 'null') {
        const instante = horarioNaiveParaInstante(horarioRelatado, TZ_ESCRITORIO);
        if (instante) {
          const horasAteReuniao = (new Date(instante).getTime() - Date.now()) / 3_600_000;
          // Janela grande pra frente (a antecedencia que essa varredura existe pra dar) e um pouco
          // pra tras (a reuniao pode ja ter passado sem ninguem notar — vale avisar tambem).
          urgente = horasAteReuniao <= janelaHoras && horasAteReuniao >= -AGENDAMENTO_URGENCIA_HORAS;
        }
      }
      if (!urgente) continue;

      relatorio.avisados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, horarioRelatado, motivo, comprovante: !!comprovante });
      if (!aplicar) continue;

      await enviarTelegram([
        '⏰ *Pendência de agendamento parada — conversa SILENCIOSA*',
        `Chat: \`${linha.chat_id}\``,
        linha.deal_id ? `Negócio: https://app.ollow.com.br/?/deal/${linha.deal_id}` : '',
        horarioRelatado && horarioRelatado !== 'null' ? `Horário em jogo: ${formatarHorarioEscritorio(horarioRelatado)}` : 'Horário em jogo: nenhum ainda extraído',
        `Situação: ${descreverPendencia({ motivo })}`,
        comprovante ? '💳 Comprovante JÁ verificado para este negócio — compromisso real, não hipótese.' : '',
        '',
        'O bot NÃO reprocessa uma conversa sozinho quando ela para de receber mensagem — conferir manualmente e mandar mensagem pra retomar se precisar.',
      ].filter(Boolean).join('\n'));
      db.prepare('UPDATE conversations SET agendamento_pendencia_avisada = ? WHERE chat_id = ?').run(linha.agendamento_pendente_hash, linha.chat_id);
      console.log(`  ⏰ Deal ${linha.deal_id}: pendencia de agendamento parada e urgente — Telegram enviado`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: e.message });
      console.error(`  ❌ Reconciliacao de pendencia de agendamento (deal ${linha.deal_id}): ${e.message}`);
    }
  }

  return relatorio;
}

async function rodarReconciliacaoPendenciasAgendamento() {
  const r = await reconciliarPendenciasAgendamento({ aplicar: true });
  if (!r.avisados.length && !r.erros.length) return r;

  console.log(`  ⏰ Reconciliacao de pendencia de agendamento: ${r.analisados} conferida(s), ${r.avisados.length} avisada(s), ${r.erros.length} erro(s)`);

  const linhasResumo = [
    r.avisados.length ? `⏰ ${r.avisados.length} pendência(s) urgente(s) em conversa(s) silenciosa(s)` : '',
    ...r.erros.slice(0, 10).map((e) => `• Deal \`${e.deal_id}\`: ${e.erro}`),
    r.erros.length > 10 ? `… e mais ${r.erros.length - 10}` : '',
  ].filter(Boolean);

  const resumo = `⏰ *Reconciliação de pendências de agendamento*\n${linhasResumo.join('\n')}`;
  if (resumo === ultimoResumoReconciliacaoPendencias) return r; // nada novo desde a ultima rodada
  ultimoResumoReconciliacaoPendencias = resumo;
  // Cada pendencia urgente ja manda o proprio Telegram individual (acima) — este resumo e so log,
  // nao precisa duplicar no Telegram (a diferenca do padrao das outras 2 reconciliacoes, que so
  // resumem no fim: aqui cada caso ja e um alerta acionavel por si so, avisar de novo seria eco).
  return r;
}

// ------------------------------------------------------------
// Refresh do briefing perto da consulta agendada
// ------------------------------------------------------------
// O briefing so atualiza quando a conversa e reprocessada, e reprocessamento depende de mensagem nova
// (webhook ou polling do Zernio). Uma consulta marcada sem mais conversa nenhuma deixaria o briefing
// congelado no estado de quando a conversa parou — mesmo que o cliente tenha pagado, enviado dado
// novo ou a consulta tenha sido remarcada depois. Medido no mesmo padrao de reconciliarPendenciasAgendamento
// (deal 48466404, Teresinha: pagou e pediu o endereco depois da ultima reprocessao).
//
// Esta rotina reprocessa (uma vez por horario de consulta) as conversas com consulta marcada nas
// proximas BRIEFING_REFRESH_ANTECEDENCIA_HORAS horas. O reprocessamento inteiro roda na fila/worker
// normal (processarConversa) — a rotina so enfileira; o briefing vira nota nova se o texto mudou de
// verdade (hash). Custa ~2 chamadas OpenAI por reprocessamento, por isso o teto por ciclo e a dedup
// por horario (briefing_refresh_para): consulta nova/remarcada volta a ser processada, a MESMA nao.
async function refrescarBriefingsPertoDaConsulta({ aplicar = false, maxPorCiclo = BRIEFING_REFRESH_MAX_POR_CICLO } = {}) {
  const agora = new Date();
  const janelaMs = BRIEFING_REFRESH_ANTECEDENCIA_HORAS * 3600000;

  const linhas = db.prepare(`
    SELECT chat_id, deal_id, contact_name, evento_calendar_data, briefing_refresh_para
      FROM conversations
     WHERE evento_calendar_criado = 1
       AND deal_id IS NOT NULL
       AND evento_calendar_data IS NOT NULL
  `).all();

  const relatorio = { aplicar, analisados: 0, enfileirados: [], erros: [] };

  for (const linha of linhas) {
    if (relatorio.enfileirados.length >= maxPorCiclo) break;
    relatorio.analisados++;
    if (linha.briefing_refresh_para === linha.evento_calendar_data) continue; // ja refrescado pra esse horario
    const instante = horarioNaiveParaInstante(linha.evento_calendar_data, TZ_ESCRITORIO);
    if (!instante) continue;
    const horasAte = (new Date(instante).getTime() - agora.getTime()) / 3600000;
    if (horasAte < 0 || horasAte > BRIEFING_REFRESH_ANTECEDENCIA_HORAS) continue;

    relatorio.enfileirados.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, evento_calendar_data: linha.evento_calendar_data });
    if (!aplicar) continue;

    try {
      // Marca o horario ANTES de enfileirar: se a conversa ja estiver na fila, processarConversa so
      // reagenda o timer — e o dedup evita que a MESMA consulta seja enfileirada a cada ciclo de
      // 30 min enquanto o worker demora. Falha do processamento vai pelo caminho normal da fila
      // (retry + desistencia + Telegram), nao por esta rotina.
      db.prepare('UPDATE conversations SET briefing_refresh_para = ? WHERE chat_id = ?').run(linha.evento_calendar_data, linha.chat_id);
      agendarProcessamento(linha.chat_id, 0);
      console.log(`  🧷 Briefing: consulta de ${linha.chat_id} em ${formatarHorarioEscritorio(linha.evento_calendar_data)} — reprocessamento agendado`);
    } catch (e) {
      relatorio.erros.push({ chat_id: linha.chat_id, deal_id: linha.deal_id, erro: e.message });
      console.error(`  ❌ Refresh de briefing (deal ${linha.deal_id}): ${e.message}`);
    }
  }

  return relatorio;
}

// ------------------------------------------------------------
// Backfill: criar deals pendentes
// ------------------------------------------------------------
async function backfillDeals() {
  const relatorio = { processados: 0, deals_criados: 0, deals_existentes: 0, erros: 0 };

  console.log('\n🔙 Backfill: buscando conversas criar sem deal_id...');

  const rows = db.prepare("SELECT chat_id, contact_name, phone, last_data FROM conversations WHERE last_action = 'criar' AND deal_id IS NULL").all();

  relatorio.processados = rows.length;
  console.log(`  ${rows.length} conversas encontradas`);

  for (const row of rows) {
    const chatId = row.chat_id;
    const phone = chaveConversa(row.phone || chatId);
    const dados = row.last_data ? JSON.parse(row.last_data) : {};

    // Esta rota criava negocio SEM nenhuma checagem de numero interno — era o caminho mais direto
    // para um socio virar deal, bastando a conversa dele ter ficado com last_action='criar'.
    if (ehInterno(phone) || ehInterno(chatId)) {
      console.log(`  ⏭️ ${chatId} e numero interno — nao cria deal`);
      stmtUpdateProcessed.run(JSON.stringify({}), 'interno', chatId);
      relatorio.ignorados = (relatorio.ignorados || 0) + 1;
      continue;
    }

    try {
      // Buscar contato no Moskit
      let contactId = null;
      const contatoLocal = stmtMoskitGet.get(phone);
      if (contatoLocal) {
        contactId = contatoLocal.moskit_id;
        console.log(`  📞 Contato local encontrado: ${contatoLocal.name} (${contactId})`);
      } else {
        // Buscar na API do Moskit
        const listRes = await axios.get(`${MOSKIT_BASE}/contacts`, {
          params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
          headers: apiHeaders, validateStatus: (s) => s < 500,
        });
        const contatos = Array.isArray(listRes.data) ? listRes.data : [];
        // Menos de 8 digitos nao e suficiente pra identificar um telefone com seguranca
        // (evita falso-positivo tipo ".includes()" casando com qualquer numero que contenha o mesmo trecho)
        const sufixo = phone.slice(-8);
        if (sufixo.length >= 8) {
          for (const c of contatos) {
            const phones = (c.phones || []).map(p => String(p.number || '').replace(/\D/g, ''));
            if (phones.some(p => p.includes(sufixo))) {
              contactId = c.id;
              console.log(`  📞 Contato via API: ${c.name} (${contactId})`);
              break;
            }
          }
        }
      }

      if (!contactId) {
        console.log(`  ❌ Contato nao encontrado para ${phone} — pulando`);
        relatorio.erros++;
        continue;
      }

      // Verificar se ja existe deal para este contato
      let dealId = null;
      const dealsRes = await axios.get(`${MOSKIT_BASE}/deals`, {
        params: { page: 1, limit: 100, sort: 'id', order: 'desc' },
        headers: apiHeaders, validateStatus: (s) => s < 500,
      });
      const deals = Array.isArray(dealsRes.data) ? dealsRes.data : [];
      for (const d of deals) {
        try {
          const { data: det } = await axios.get(`${MOSKIT_BASE}/deals/${d.id}`, {
            headers: apiHeaders, validateStatus: (s) => s < 500,
          });
          const conts = (det?.contacts || []).map(x => String(x.id));
          if (conts.includes(String(contactId))) {
            dealId = d.id;
            break;
          }
        } catch {}
      }

      if (dealId) {
        console.log(`  ✅ Deal ja existe: ${dealId} — salvando no banco`);
        db.prepare("UPDATE conversations SET deal_id = ?, updated_at = datetime('now') WHERE chat_id = ?").run(dealId, chatId);
        relatorio.deals_existentes++;
      } else {
        console.log(`  🔶 Criando novo deal para ${phone}...`);
        try {
          // Passa pelas MESMAS travas do pipeline: `dados` aqui e last_data cru, que pode carregar um
          // palpite de area gravado antes delas existirem, e nao ha observacao nenhuma pra sustentar.
          // `chatId` vai junto para que a autoria dos campos fique registrada desde o nascimento.
          sanitizarClassificacao(dados, []);
          const deal = await criarNegocioMoskit(dados, contactId, { chatId });
          console.log(`  ✅ Deal criado: ${deal.id}`);
          db.prepare("UPDATE conversations SET deal_id = ?, updated_at = datetime('now') WHERE chat_id = ?").run(deal.id, chatId);

          if (dados.resumo_atendimento) {
            await registrarBriefing(deal.id, chatId, {
              dados,
              contato: row.contact_name || dados.nome,
              telefone: phone || chatId,
              horarioConsulta: null,
            });
          }

          relatorio.deals_criados++;
        } catch (e) {
          console.error(`  ❌ Erro ao criar deal: ${e.message}`);
          relatorio.erros++;
        }
      }
    } catch (e) {
      console.error(`  ❌ Erro ao processar ${chatId}: ${e.message}`);
      relatorio.erros++;
    }
  }

  console.log(`\n🔙 Backfill concluido: ${relatorio.processados} processados, ${relatorio.deals_criados} criados, ${relatorio.deals_existentes} existentes, ${relatorio.erros} erros`);
  return relatorio;
}

// Transporte comum do download de anexos da Zernio (comprovante e audio): streama para o disco e
// devolve o caminho do arquivo, ou null se nao conseguiu baixar.
// MEDIDO em 19/08/2026: 118 ocorrencias de "Erro ao baixar anexo: 401" nos logs de producao, e nem
// uma delas dizia QUAL url, de que host, ou se a chave tinha sido enviada — o erro era impossivel de
// diagnosticar sem reproduzir. Tambem havia "Invalid URL", que e o axios recebendo algo que nem e
// endereco.
//
// O host importa mais que a url: se o anexo vem de CDN da Meta/WhatsApp, mandar o header `apikey` do
// Zernio nao ajuda e a url e assinada e curta — 401 ali significa "expirou", nao "credencial errada".
// Se vem do proprio Zernio, 401 aponta para a chave. Sao consertos opostos, e o log agora distingue.
//
// A url NAO vai inteira para o log de proposito: ela e um link direto para midia de cliente.
function descreverUrlAnexo(url) {
  try {
    const u = new URL(String(url));
    return `${u.host}${u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname}`;
  } catch {
    return '(url invalida)';
  }
}

// Que credencial (se alguma) acompanha o download de um anexo.
//
// MEDIDO em 19/08/2026 contra a API real, mesma rota e mesma chave, so trocando o esquema:
//   Authorization: Bearer <chave>  -> HTTP 200
//   apikey: <chave>                -> HTTP 401
// Esta funcao mandava `apikey`, e era a UNICA chamada ao Zernio no arquivo inteiro que fazia isso
// (sincronizarConversas e a leitura de mensagens sempre usaram Bearer, e por isso nunca falharam).
// O efeito: 113 "Erro ao baixar anexo: 401" no log e NENHUM comprovante verificado desde 24/07 —
// a foto do PIX nunca chegava na IA de visao, entao o negocio nao avancava e o Telegram nao avisava
// que o cliente pagou. Audio do cliente cai no mesmo caminho e tambem parou de ser transcrito.
//
// E a credencial so vai para o PROPRIO Zernio. A URL vem do webhook, e um link assinado de CDN
// (Meta) nao precisa de auth nenhuma: mandar a chave do escritorio para um host de terceiro e
// vazamento de credencial — que era exatamente o que o codigo fazia, para qualquer URL que chegasse.
// Comparacao por hostname exato ou sufixo com ponto: "malzernio.com" NAO e o Zernio.
function ehHostZernio(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'zernio.com' || host.endsWith('.zernio.com');
}

function montarHeadersAnexo(alvo) {
  if (!ZERNIO_API_KEY) return { headers: {}, credencial: 'SEM credencial (ZERNIO_API_KEY ausente)' };
  if (!ehHostZernio(alvo?.hostname)) return { headers: {}, credencial: 'sem credencial (host de terceiro)' };
  return { headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` }, credencial: 'com Bearer' };
}

// A API do Zernio devolve a URL da midia RELATIVA — MEDIDO em 19/08/2026 contra a API real:
// 9 de 9 anexos das conversas recentes vieram como "/api/v1/whatsapp/media/<id>?accountId=...".
// `new URL()` recusa isso, entao o download morria em "Anexo com URL invalida" ANTES de tocar a rede:
// e por isso que sincronizarConversas — a rede de seguranca que existe justamente para pegar o que o
// webhook perdeu — nunca baixou comprovante nem audio nenhum. O webhook entrega a mesma midia em
// forma absoluta, e aquela caia no 401 do esquema de auth errado: os dois caminhos quebrados, por
// motivos diferentes, com o mesmo sintoma de "nada acontece".
//
// So caminho que comeca em `/api/` e resolvido. Resolver qualquer string contra a base transformaria
// lixo em requisicao — "/caminho/local" e "nao-e-url" continuam sendo recusados sem tocar a rede
// (tem regressao desde que a guarda de URL invalida existe).
const ZERNIO_BASE = 'https://zernio.com';

function resolverUrlAnexo(url) {
  const texto = String(url ?? '');
  return texto.startsWith('/api/') ? `${ZERNIO_BASE}${texto}` : texto;
}

async function baixarParaArquivo(url, caminho) {
  // Barra antes do axios: sem isto o unico sintoma era "Invalid URL", sem dizer o que chegou.
  const endereco = resolverUrlAnexo(url);
  let alvo;
  try {
    alvo = new URL(endereco);
  } catch {
    console.error(`  ❌ Anexo com URL invalida (${JSON.stringify(String(url).slice(0, 60))}) — nada a baixar`);
    return null;
  }
  if (!/^https?:$/.test(alvo.protocol)) {
    console.error(`  ❌ Anexo com protocolo inesperado (${alvo.protocol}) — nao vou buscar`);
    return null;
  }

  const { headers: headersAnexo, credencial } = montarHeadersAnexo(alvo);

  try {
    const response = await axios({
      method: 'GET',
      url: endereco,
      responseType: 'stream',
      headers: headersAnexo,
    });
    const writer = fs.createWriteStream(caminho);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return caminho;
  } catch (e) {
    const status = e.response?.status;
    console.error(
      `  ❌ Erro ao baixar anexo de ${descreverUrlAnexo(endereco)} (${status ? `HTTP ${status}` : e.message}, ${credencial})` +
      (status === 401 || status === 403
        ? ' — 401/403 em host do Zernio agora significa chave invalida (o esquema Bearer ja esta medido e correto);'
          + ' em CDN de terceiro, e link assinado que EXPIROU'
        : '')
    );
    return null;
  }
}

async function baixarComprovante(phone, att) {
  const url = att.url || att.downloadUrl || att.payload?.url;
  if (!url) {
    console.log('  ⏭️ Sem URL para download do anexo');
    return null;
  }
  const nome = att.payload?.filename || att.payload?.name || (att.type === 'image' ? 'imagem.jpeg' : 'documento.pdf');
  const pasta = path.join(__dirname, 'comprovantes', phone);
  fs.mkdirSync(pasta, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = path.join(pasta, `${timestamp}_${nome}`);
  const baixado = await baixarParaArquivo(url, caminho);
  if (baixado) console.log(`  💾 Comprovante salvo: ${caminho}`);
  return baixado;
}

// ------------------------------------------------------------
// Transcricao de audio (cliente) — ver src/transcricao.js
// ------------------------------------------------------------
// Extensoes que a API de transcricao aceita. Voice notes do WhatsApp sao .ogg (Android) ou
// .m4a (iPhone). O SDK infere o MIME pelo nome do arquivo, entao o default importa.
const EXTENSOES_AUDIO_VALIDAS = new Set(['.ogg', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.wav', '.webm', '.flac']);

function baixarAnexoAudio(phone, att) {
  const url = att.url || att.downloadUrl || att.payload?.url;
  if (!url) {
    console.log('  🎧 Sem URL para download do audio');
    return null;
  }
  const nomeBruto = att.payload?.filename || att.payload?.name || '';
  const ext = path.extname(nomeBruto).toLowerCase();
  const nome = nomeBruto && EXTENSOES_AUDIO_VALIDAS.has(ext)
    ? nomeBruto
    : (nomeBruto ? `${nomeBruto}.ogg` : 'audio.ogg');
  const pasta = path.join(__dirname, 'comprovantes', phone);
  fs.mkdirSync(pasta, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = path.join(pasta, `${timestamp}_${nome}`);
  return baixarParaArquivo(url, caminho).then((baixado) => {
    if (baixado) console.log(`  🎧 Audio salvo: ${caminho}`);
    return baixado;
  });
}

// Fila de transcricoes por chat: dois audios seguidos na mesma conversa nao podem ler o mesmo
// snapshot do array de mensagens (o segundo sobrescreveria a transcricao do primeiro). As tarefas
// encadeiam por chat e a entrada e removida so pela ultima.
const transcricoesEmAndamento = new Map();

// Baixa, transcreve e registra o texto do audio no historico. Falha em qualquer etapa mantem o
// placeholder — a conversa segue processando sem o conteudo. `transcreve` e injetavel (teste).
async function processarAudioCliente(chatId, att, idZernio, transcreve = transcreverAudio) {
  const anterior = transcricoesEmAndamento.get(chatId) || Promise.resolve();
  const proxima = anterior
    .catch(() => {}) // falha de um audio nao bloqueia o proximo da mesma conversa
    .then(async () => {
      const caminho = await baixarAnexoAudio(chatId, att);
      if (!caminho) return;
      const texto = await transcreve(caminho);
      if (!texto) return;
      await atualizarTranscricaoNaConversa(chatId, idZernio, texto);
    });
  transcricoesEmAndamento.set(chatId, proxima);
  return proxima.finally(() => {
    if (transcricoesEmAndamento.get(chatId) === proxima) transcricoesEmAndamento.delete(chatId);
  });
}

// Substitui o placeholder do audio pela transcricao dentro do historico, preservando role e
// timestamp da mensagem original. Idempotente: reentrega do webhook nao transcreve de novo.
function atualizarTranscricaoNaConversa(chatId, idZernio, texto) {
  if (!idZernio || !texto) return false;
  const row = stmtGet.get(chatId);
  if (!row) return false;
  const mensagens = JSON.parse(row.messages || '[]');
  const alvo = mensagens.find((m) => m.id_zernio === idZernio);
  if (!alvo) {
    console.log(`  🎧 mensagem ${idZernio} nao encontrada na conversa ${chatId} — transcricao descartada`);
    return false;
  }
  if (String(alvo.text || '').startsWith('🎧')) {
    console.log(`  🎧 mensagem ${idZernio} ja transcrita — ignorando`);
    return false;
  }
  alvo.text = `🎧 Transcrição do áudio: ${texto}`;
  db.prepare("UPDATE conversations SET messages = ?, updated_at = datetime('now') WHERE chat_id = ?").run(
    JSON.stringify(mensagens), chatId
  );
  console.log(`  🎧 Audio de ${chatId} transcrito (${texto.length} chars)`);
  // Reagenda do zero: o timer comeca a contar da transcricao, entao o pipeline (5 min depois)
  // enxerga o conteudo em vez de rodar com apenas o placeholder.
  agendarProcessamento(chatId);
  return true;
}

// ============================================================
// Notas de reuniao do Gemini (Google Meet) -> nota no negocio do Moskit
// ============================================================
//
// O ciclo: acha os e-mails de notas ainda nao processados, descobre a QUE NEGOCIO cada um pertence,
// extrai os dados juridicos com a OpenAI e escreve uma nota no deal.
//
// O e-mail e so o gatilho. A ancora de identidade e o EVENTO da agenda: e nele que estao o Doc das
// notas (attachments[].fileUrl) e o telefone do cliente (linha "Telefone:" da descricao), que e a
// chave de conversations.chat_id. A decisao de qual negocio usar mora em src/notas-reuniao.js, sem
// rede; aqui so se busca o que ela precisa.
//
// MEDIDO em 16/08/2026, e vale ter em mente ao mexer: dos 6 eventos que geraram notas nos ultimos 30
// dias, 4 foram criados pelo bot (tem "Telefone:") e 2 foram criados a mao ("Consulta online - Berto
// e Aurinete", "Consulta online- Iury e Arthur") e nao tem vinculo nenhum. O fallback nao e caso
// raro: e ~1/3 do volume, e parte dele vai terminar em orfao mesmo. Por isso o orfao aqui e um
// desfecho de primeira classe — com diagnostico e comando de religar — e nao um erro escondido.

// Rotulos do Gmail. O seletor da fila e a AUSENCIA deles, nunca `is:unread`: se alguem abre o e-mail
// no celular, o ciclo seguinte nunca mais veria aquela reuniao e nada avisaria. Marcar como lido
// continua acontecendo, mas como efeito do processamento, jamais como criterio.
const NOTAS_ROTULOS = { processado: 'Notas/Processado', orfao: 'Notas/Orfao', erro: 'Notas/Erro' };
const cacheRotulosGmail = new Map();

async function garantirRotuloGmail(gmail, nome) {
  if (cacheRotulosGmail.has(nome)) return cacheRotulosGmail.get(nome);
  const lista = await gmail.users.labels.list({ userId: 'me' });
  for (const l of lista.data.labels || []) cacheRotulosGmail.set(l.name, l.id);
  if (cacheRotulosGmail.has(nome)) return cacheRotulosGmail.get(nome);

  const criado = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: nome, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  cacheRotulosGmail.set(nome, criado.data.id);
  return criado.data.id;
}

// O corpo do e-mail vem em partes MIME aninhadas e em base64url. O text/plain e o que alimenta a IA
// (ja traz o resumo inteiro do Gemini); o text/html so interessa como fallback para achar o link do
// Doc, porque e nele que o link existe — no text/plain o Google manda so a ancora "Abrir notas da
// reuniao", sem URL nenhuma.
function extrairCorpoGmail(payload) {
  let texto = '';
  let html = '';

  const percorrer = (parte) => {
    if (!parte) return;
    const dados = parte.body?.data;
    if (dados) {
      const decodificado = Buffer.from(dados, 'base64url').toString('utf8');
      if (parte.mimeType === 'text/plain') texto += decodificado;
      else if (parte.mimeType === 'text/html') html += decodificado;
    }
    for (const filha of parte.parts || []) percorrer(filha);
  };

  percorrer(payload);
  return { texto: texto.trim(), html };
}

const cabecalhoGmail = (payload, nome) =>
  (payload?.headers || []).find((h) => h.name?.toLowerCase() === nome.toLowerCase())?.value || '';

// Acha o evento da agenda que corresponde ao e-mail. Casa primeiro pelo Doc (identidade exata) e so
// depois pelo titulo — o titulo pode se repetir entre dois clientes no mesmo dia, o Doc nunca.
async function acharEventoDaReuniao(calendar, { dataIso, tituloEvento, docId }) {
  const janela = notasReuniao.janelaDoDia(dataIso, TZ_ESCRITORIO);
  if (!janela) return null;

  const res = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin: janela.timeMin,
    timeMax: janela.timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  const eventos = (res.data.items || []).filter((e) => e.status !== 'cancelled');

  if (docId) {
    const porDoc = eventos.filter((e) => notasReuniao.extrairDocIdDeEvento(e) === docId);
    if (porDoc.length === 1) return porDoc[0];
  }

  if (tituloEvento) {
    const porTitulo = eventos.filter((e) => (e.summary || '').trim() === tituloEvento.trim());
    // Dois eventos com o titulo identico no mesmo dia: nao da pra saber qual gerou estas notas.
    // Devolver "nenhum" faz o caso cair para orfao, que e o desfecho correto.
    if (porTitulo.length === 1) return porTitulo[0];
  }

  return null;
}

const stmtDealsPorTelefone = db.prepare(
  "SELECT DISTINCT deal_id FROM conversations WHERE deal_id IS NOT NULL AND chat_id LIKE '%' || ? || '%'"
);
// O e-mail do cliente vive dentro do JSON de last_data. Busca local, sem rede: /contacts do Moskit
// nao tem busca server-side, so paginacao — procurar por la custaria dezenas de chamadas por e-mail.
//
// ESCAPE nao e preciosismo: `_` e caractere COMUM em e-mail e curinga de um caractere no LIKE, entao
// "joao_silva@x.com" casaria tambem com "joaoXsilva@x.com" — ou seja, apontaria para o negocio de
// outra pessoa. Num passo cuja unica funcao e dizer de quem e a reuniao, isso e exatamente o erro que
// nao pode acontecer.
const stmtDealsPorEmail = db.prepare(
  "SELECT DISTINCT deal_id FROM conversations WHERE deal_id IS NOT NULL AND last_data LIKE ? ESCAPE '\\'"
);
const escaparLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

function buscarDealsPorTelefone(telefone) {
  if (!telefone || telefone.length < 8) return [];
  // Os ultimos 8 digitos sao o mesmo criterio de identidade que ehInterno usa: cobre variacao de
  // DDI/nono digito sem casar numero de outra pessoa.
  return stmtDealsPorTelefone.all(String(telefone).slice(-8)).map((r) => r.deal_id).filter(Boolean);
}

function buscarDealsPorEmail(emails) {
  const achados = [];
  for (const email of emails || []) {
    for (const r of stmtDealsPorEmail.all(`%${escaparLike(email)}%`)) if (r.deal_id) achados.push(r.deal_id);
  }
  return [...new Set(achados)];
}

// Ultimo recurso antes do orfao: a consulta pode ter sido marcada direto no CRM, sem passar por
// conversa nenhuma. Compara o horario da atividade com o inicio da reuniao.
async function buscarDealsPorAtividade(inicioIso) {
  if (!inicioIso) return { ids: [], truncou: false };

  const alvo = new Date(inicioIso).getTime();
  if (Number.isNaN(alvo)) return { ids: [], truncou: false };

  const { atividades, truncou } = await listarAtividadesMoskit();
  const JANELA_MS = 90 * 60 * 1000; // a reuniao pode ter comecado atrasada, ou a atividade estar arredondada

  const ids = atividades
    .filter((a) => MOSKIT_IDS.ATIVIDADE_TIPOS_CONSULTA.has(a?.type?.id))
    .filter((a) => a?.dueDate && Math.abs(new Date(a.dueDate).getTime() - alvo) <= JANELA_MS)
    .map((a) => a?.deals?.[0]?.id)
    .filter(Boolean);

  return { ids: [...new Set(ids.map(Number))], truncou };
}

// O Doc do Gemini, em PDF, para virar anexo na aba "Arquivos" do negocio.
//
// Nunca lanca, devolve null — o produto principal e a nota no CRM; se o PDF nao sair, o pior
// desfecho aceitavel e "sem anexo". Falhar aqui nao pode custar a nota.
//
// Nao exige consentimento OAuth novo: `drive.readonly` (autorizar-google-notas.js) ja cobre exportar
// em qualquer formato. Refazer o consentimento invalidaria o refresh token em uso e derrubaria o
// agendamento — preco alto demais por um anexo.
// Devolve `{ bytes, transitorio }`, e essa distincao NAO e detalhe de estilo: quem chama grava
// SEM_DOC — um estado que a rede de seguranca nunca retoma — e SEM_DOC precisa significar "esta
// reuniao nao tem transcricao", nunca "o Drive piscou". Confundir os dois perde de vez o PDF de uma
// consulta que existia, e ainda grava no banco a afirmacao contraria, enganando quem for auditar.
async function exportarPdfDoDoc(drive, docId) {
  const definitivo = (bytes) => ({ bytes, transitorio: false });

  if (!drive || !docId) return definitivo(null);
  try {
    const res = await drive.files.export(
      { fileId: docId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const bytes = Buffer.from(res.data);
    // Confere a assinatura em vez de confiar no 200: o Drive responde 200 com corpo HTML em algumas
    // falhas de permissao, e um HTML salvo como .pdf entra no CRM parecendo anexo legitimo.
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      console.log(`  ⏭️ Doc ${docId}: export nao devolveu um PDF (${bytes.length} bytes) — sem anexo`);
      return definitivo(null); // formato/permissao: retentar nao muda o resultado
    }
    return definitivo(bytes);
  } catch (e) {
    // 404/403 sao veredito: o Doc nao existe ou esta fora do alcance desta credencial. Qualquer
    // outra coisa (5xx, 429, timeout, DNS) e o Drive de mau humor — e merece nova tentativa.
    const status = e?.response?.status ?? e?.code;
    const semVolta = status === 404 || status === 403;
    console.log(`  ⏭️ Doc ${docId} nao exportado em PDF (${e.message})${semVolta ? '' : ' — tentarei de novo no proximo ciclo'}`);
    return { bytes: null, transitorio: !semVolta };
  }
}

// Procura o marcador nas notas ja existentes do deal. E o que decide, apos um crash no meio do POST,
// entre "ja postei" e "preciso postar" — sem isso, so restaria repostar as cegas (nota duplicada no
// prontuario do cliente) ou desistir sempre.
//
// Pagina com `?start=`: medido em 16/08/2026, /deals/{id}/notes devolve 10 por pagina e ignora
// `limit`. O deal da Lia ja tinha 40 notas — olhar so a primeira pagina responderia "nao achei" para
// uma nota que existe.
// Paginador das rotas de coleção de um deal (`/notes`, `/attachments`).
//
// Existe para ser UM lugar só: o `?start=` é a única paginação que estas rotas respeitam (medido em
// 16/08/2026 — `limit` é ignorado e a página é sempre 10), e a regra "página incompleta = fim" é a
// mesma nas duas. Antes eram duas cópias linha-a-linha; a diferença real cabia em três linhas.
//
// Devolve o item achado, ou `null`. Bater no teto de páginas **lança**: "não achei" e "não terminei
// de procurar" levam a ações opostas, e confundir os dois é exatamente como se duplica uma nota ou
// um anexo no prontuário do cliente.
async function acharEmColecaoDoDeal({ rota, achar, descricao }) {
  let vistos = 0;

  for (let pagina = 0; pagina < NOTAS_MAX_PAGINAS_BUSCA; pagina++) {
    const res = await axios.get(`${MOSKIT_BASE}${rota}`, {
      params: { start: vistos },
      headers: apiHeaders,
      validateStatus: (s) => s < 500,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GET ${rota} devolveu HTTP ${res.status}`);
    }

    const lote = Array.isArray(res.data) ? res.data : [];
    const achado = lote.find(achar);
    if (achado) return achado;

    vistos += lote.length;
    if (lote.length < 10) return null; // pagina incompleta = fim da lista
  }

  throw new Error(`${descricao} atingiu o teto de ${NOTAS_MAX_PAGINAS_BUSCA} paginas`);
}

async function notaComMarcadorExiste(dealId, marcador) {
  const achado = await acharEmColecaoDoDeal({
    rota: `/deals/${dealId}/notes`,
    achar: (n) => String(n?.description || '').includes(marcador),
    descricao: `busca do marcador no deal ${dealId}`,
  });
  return !!achado;
}

// Procura, na aba Arquivos do negocio, um anexo com este nome exato.
//
// E o `notaComMarcadorExiste` do anexo, e existe pelo mesmo motivo: depois de um crash entre "vou
// anexar" e "anexei", so o CRM sabe a verdade. A diferenca e que o anexo nao tem onde carregar um
// marcador — o POST so aceita uma url — entao a identidade E o nome do arquivo, que por isso e
// deterministico (ver nomeAnexoNota).
//
// Pagina por `start`, o unico parametro que a doc declara para esta rota. Em /activities foi medido
// que `page`, `offset` e afins sao ignorados EM SILENCIO, devolvendo a primeira pagina de novo — um
// loop errado aqui reler os mesmos 10 registros e pareceria ter varrido tudo.
function anexoComNomeExiste(dealId, nome) {
  return acharEmColecaoDoDeal({
    rota: `/deals/${dealId}/attachments`,
    achar: (a) => a?.filename === nome,
    descricao: `busca do anexo no deal ${dealId}`,
  });
}

// Anexa o PDF do Doc do Gemini na aba "Arquivos" do negocio.
//
// CONTRATO: nunca lanca. A nota no CRM e o produto principal; o anexo e um bonus, e o pior desfecho
// aceitavel e "a nota entrou, sem anexo". Como esta funcao e chamada ANTES do bracket da nota (para
// que o rodape possa afirmar o anexo com honestidade), lancar aqui derrubaria o registro da consulta
// inteiro — trocaria um bonus ausente por um prontuario vazio.
//
// O bracket da nota (POSTANDO -> POSTADA) nao cobre este efeito: sao dois POSTs diferentes, em
// recursos diferentes, e cada um precisa do seu par de commits.
// `nomeForcado` existe para a retomada: o nome ja foi gravado em `anexo_nome` e e a chave de
// deduplicacao, entao recalcula-lo a partir de uma data que a linha nao guarda seria a unica forma
// de gerar um nome DIFERENTE do que ja esta no CRM — ou seja, de anexar a mesma transcricao duas vezes.
async function anexarDocNoDeal({ dealId, docId, gmailMessageId, dataIso, marcador, drive, stmts, dryRun, nomeForcado = null }) {
  const semAnexo = (motivo) => ({ anexado: false, motivo });

  try {
    if (!NOTAS_ANEXO_ATIVO) return semAnexo('desligado');
    if (!dealId) return semAnexo('sem_deal');

    // Sem Doc nao ha o que anexar — decisao de produto: nao geramos PDF a partir do resumo do
    // e-mail, que ja esta inteiro dentro da propria nota.
    if (!docId) {
      stmts.avancarAnexo.run({
        gmail_message_id: gmailMessageId, anexo_estado: 'SEM_DOC',
        anexo_token: null, anexo_caminho: null, anexo_nome: null, anexo_id: null, anexo_expira_em: null,
      });
      return semAnexo('sem_doc');
    }

    if (!PUBLIC_BASE_URL) {
      console.log('  ⏭️ PUBLIC_BASE_URL nao configurada — o Moskit nao teria de onde baixar o PDF; nota segue sem anexo');
      return semAnexo('sem_url_base');
    }

    const nome = nomeForcado || notasReuniao.nomeAnexoNota(marcador, dataIso);

    // O bracket abre AQUI, antes de qualquer rede, e a tentativa e contada UMA vez so.
    //
    // Abrir depois — so antes do POST — deixava um buraco: uma falha na listagem de deduplicacao
    // (o Moskit responde 429/timeout de 30s quando a varredura bate forte, ver a secao de
    // reconciliacao de vinculo) caia no catch com `anexo_estado` ainda NULL, e `anexosPendentes` so
    // casa 'ANEXANDO' — o PDF daquela reuniao sumia para sempre, sem retry e sem rastro.
    //
    // E contar a tentativa aqui, e nao tambem no catch, e o que impede o mesmo defeito ja corrigido
    // na reconciliacao de vinculo: incrementar nos dois lugares fazia UMA falha custar DUAS
    // tentativas, cortando o orcamento pela metade.
    stmts.avancarAnexo.run({
      gmail_message_id: gmailMessageId, anexo_estado: 'ANEXANDO',
      anexo_token: null, anexo_caminho: null, anexo_nome: nome, anexo_id: null, anexo_expira_em: null,
    });
    stmts.contarTentativaAnexo.run(gmailMessageId);

    // Dedup ANTES de exportar: o export do Drive e a escrita em disco custam caro, e numa retomada o
    // anexo mais provavel ja esta la.
    const jaExiste = await anexoComNomeExiste(dealId, nome);
    if (jaExiste) {
      console.log(`  📎 anexo ja existia no deal ${dealId} (${nome}) — nao duplico`);
      const anterior = stmts.get.get(gmailMessageId);
      stmts.avancarAnexo.run({
        gmail_message_id: gmailMessageId, anexo_estado: 'ANEXADO',
        anexo_token: null, anexo_caminho: null, anexo_nome: nome, anexo_id: jaExiste.id || null, anexo_expira_em: null,
      });
      // `avancarAnexo` usa COALESCE: passar null PRESERVA o valor antigo. Sem este encerramento
      // explicito, a retomada de um ANEXANDO deixaria o token vivo e o PDF no disco ate o TTL vencer
      // — uma transcricao de consulta servida por horas sem necessidade nenhuma, ja que o arquivo
      // comprovadamente ja esta no CRM.
      try { if (anterior?.anexo_caminho && fs.existsSync(anterior.anexo_caminho)) fs.unlinkSync(anterior.anexo_caminho); } catch {}
      stmts.encerrarAnexo.run(gmailMessageId);
      return { anexado: true, motivo: 'ja_existia' };
    }

    const { bytes: pdf, transitorio } = await exportarPdfDoDoc(drive, docId); // nunca lanca
    if (!pdf) {
      // Transitorio fica em ANEXANDO: a rede de seguranca tenta de novo no proximo ciclo. Marcar
      // SEM_DOC aqui gravaria "esta reuniao nao tem transcricao" por causa de um 5xx passageiro.
      if (transitorio) return semAnexo('export_transitorio');
      stmts.avancarAnexo.run({
        gmail_message_id: gmailMessageId, anexo_estado: 'SEM_DOC',
        anexo_token: null, anexo_caminho: null, anexo_nome: null, anexo_id: null, anexo_expira_em: null,
      });
      return semAnexo('export_falhou');
    }

    if (dryRun) {
      console.log(`  📎 [dry-run] anexaria ${nome} (${pdf.length} bytes) no deal ${dealId} via ${PUBLIC_BASE_URL}/arquivo-nota/<token>/${nome}`);
      stmts.avancarAnexo.run({
        gmail_message_id: gmailMessageId, anexo_estado: 'ANEXADO',
        anexo_token: null, anexo_caminho: null, anexo_nome: nome, anexo_id: null, anexo_expira_em: null,
      });
      return { anexado: true, motivo: 'dry_run' };
    }

    const pasta = path.join(__dirname, 'notas-reuniao', String(dealId));
    fs.mkdirSync(pasta, { recursive: true });
    const caminho = path.join(pasta, nome);
    fs.writeFileSync(caminho, pdf);

    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + NOTAS_ANEXO_TTL_HORAS * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const url = `${PUBLIC_BASE_URL}/arquivo-nota/${token}/${nome}`;

    // Continua ANEXANDO (aberto la em cima), agora com o token que torna a URL viva e o caminho do
    // PDF — e o que a retomada e a varredura de expirados precisam para limpar o que ficou no meio.
    stmts.avancarAnexo.run({
      gmail_message_id: gmailMessageId, anexo_estado: 'ANEXANDO',
      anexo_token: token, anexo_caminho: caminho, anexo_nome: nome, anexo_id: null, anexo_expira_em: expiraEm,
    });

    const post = await axios.post(
      `${MOSKIT_BASE}/deals/${dealId}/attachments`,
      { url },
      { headers: { ...apiHeaders, 'X-Ollow-Origin': 'BOT_WHATSAPP' } }
    );
    const anexoId = post.data?.id || null;

    stmts.avancarAnexo.run({
      gmail_message_id: gmailMessageId, anexo_estado: 'ANEXADO',
      anexo_token: null, anexo_caminho: null, anexo_nome: null, anexo_id: anexoId, anexo_expira_em: null,
    });
    console.log(`  📎 anexo criado no deal ${dealId}: ${nome} (attachment ${anexoId})`);

    await conferirAnexoNoMoskit({ dealId, anexoId, nome, tamanho: pdf.length, gmailMessageId, caminho, stmts });
    return { anexado: true, motivo: 'criado' };

  } catch (e) {
    // Deixa `anexo_estado` em ANEXANDO para a rede de seguranca retomar. Nao rotula, nao avisa, nao
    // lanca: falha de anexo nao e evento digno de interromper o registro da consulta.
    //
    // E NAO conta tentativa aqui: ela ja foi contada uma vez, ao abrir o bracket. Incrementar nos
    // dois lugares faria uma unica falha custar duas tentativas — o defeito que ja apareceu na
    // reconciliacao de vinculo (commit e78156f).
    console.log(`  ⏭️ anexo do deal ${dealId} falhou (${e.message}) — a nota segue sem ele`);
    return semAnexo('erro');
  }
}

// Confere o que o Moskit REALMENTE guardou e, batendo, mata a URL publica na hora.
//
// Nao e zelo: o transporte e uma URL baixada por um terceiro, e o modo de falha que este projeto
// mais combate e o silencioso. Se o tunel devolver a pagina de aviso do ngrok gratis em vez do PDF,
// o POST responde 2xx do mesmo jeito e o anexo aparece na aba com o nome certo — so quem ABRIR o
// arquivo descobre. Comparar tamanho e mimeType e o que transforma isso em alerta.
async function conferirAnexoNoMoskit({ dealId, anexoId, nome, tamanho, gmailMessageId, caminho, stmts }) {
  const encerrar = () => {
    try { if (caminho && fs.existsSync(caminho)) fs.unlinkSync(caminho); } catch {}
    try { stmts.encerrarAnexo.run(gmailMessageId); } catch {}
  };

  if (!anexoId) { encerrar(); return; }

  try {
    // A doc avisa que a url "pode levar alguns segundos para funcionar", entao le mais de uma vez.
    // Um GET unico, cedo demais, diria "vazio" e eu culparia o transporte a toa.
    let guardado = null;
    for (let i = 0; i < 3; i++) {
      // Le PRIMEIRO, dorme depois: os metadados (size/mimeType) costumam estar prontos antes da url
      // ficar navegavel, e dormir antes da primeira leitura so atrasaria o caminho feliz.
      const res = await axios.get(`${MOSKIT_BASE}/deals/${dealId}/attachments/${anexoId}`, {
        headers: apiHeaders, validateStatus: (s) => s < 500,
      });
      if (res.status >= 200 && res.status < 300) {
        guardado = res.data;
        if (guardado?.size) break;
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 3000));
    }

    const tamanhoGuardado = Number(guardado?.size || 0);
    const ehPdf = /pdf/i.test(guardado?.mimeType || '');

    if (guardado && tamanhoGuardado === tamanho && ehPdf) {
      encerrar(); // copiou: a URL publica nao precisa mais existir
      return;
    }

    // Nao apaga o arquivo local aqui: se o Moskit ainda estiver para buscar, apagar garantiria a
    // falha. A varredura de expirados limpa depois.
    await enviarTelegram(
      `⚠️ *Anexo de notas suspeito* (deal ${dealId})\n` +
      `Arquivo: \`${nome}\`\n` +
      `Enviado: ${tamanho} bytes · Guardado: ${tamanhoGuardado || '?'} bytes (${guardado?.mimeType || 'tipo desconhecido'})\n` +
      `Se o tamanho nao bate, o que entrou no CRM provavelmente NAO e o PDF — suspeite da pagina de aviso do ngrok.\n` +
      `Negócio: https://app.ollow.com.br/?/deal/${dealId}`
    ).catch(() => {});
  } catch (e) {
    console.log(`  ⏭️ nao consegui conferir o anexo ${anexoId} do deal ${dealId}: ${e.message}`);
  }
}

// Varre os PDFs cujo TTL venceu sem confirmacao e apaga disco + token.
//
// Existe porque `comprovantes/` nunca foi limpo e cresce para sempre — aqui o custo de repetir esse
// padrao seria maior: cada arquivo e a transcricao de uma consulta juridica atras de uma URL sem
// autenticacao. Arquivo que ninguem veio buscar nao pode ficar servido indefinidamente.
// Rede de seguranca do anexo: linhas cuja NOTA ja concluiu mas cujo anexo ficou preso em ANEXANDO.
//
// So mexe em `estado = 'CONCLUIDO'` (garantido pela query): enquanto a nota nao entrou, quem cuida
// da linha e o ciclo normal, e duas rotinas escrevendo na mesma linha e como nasce anexo duplicado.
//
// Nao chama OpenAI — a extracao ja esta gravada. O custo de uma tentativa aqui e um GET de listagem
// mais, no maximo, um export do Drive.
async function retomarAnexosPendentes({ stmts, drive, dryRun, limite = 5 }) {
  if (!NOTAS_ANEXO_ATIVO || dryRun) return 0;

  const pendentes = stmts.anexosPendentes.all({ maxTentativas: NOTAS_ANEXO_MAX_TENTATIVAS, limite });
  let resolvidos = 0;

  for (const [i, linha] of pendentes.entries()) {
    // Pausa ENTRE os itens (nunca antes do primeiro): o limite do Moskit e 6 req/s e cada anexo custa
    // varias chamadas. Sem isto a varredura viraria uma rajada e o 429 mataria os itens seguintes.
    if (i > 0) await new Promise((r) => setTimeout(r, NOTAS_ANEXO_PAUSA_MS));

    const r = await anexarDocNoDeal({
      dealId: linha.deal_id,
      docId: linha.doc_id,
      gmailMessageId: linha.gmail_message_id,
      marcador: linha.marcador,
      nomeForcado: linha.anexo_nome, // a chave de dedup ja escolhida; recalcular arriscaria duplicar
      drive, stmts, dryRun,
    });
    if (r.anexado) resolvidos++;
  }

  // Desiste em silencio, MAS deixa rastro: diferente da nota, anexo faltando nao e incidente — a
  // consulta esta registrada, so o PDF nao subiu. Telegram aqui viraria ruido diario.
  const desistiram = stmts.anexosDesistentes.all({ maxTentativas: NOTAS_ANEXO_MAX_TENTATIVAS });
  for (const l of desistiram) {
    stmts.avancarAnexo.run({
      gmail_message_id: l.gmail_message_id, anexo_estado: 'DESISTIU',
      anexo_token: null, anexo_caminho: null, anexo_nome: null, anexo_id: null, anexo_expira_em: null,
    });
    try { if (l.anexo_caminho && fs.existsSync(l.anexo_caminho)) fs.unlinkSync(l.anexo_caminho); } catch {}
    console.log(`  ⏭️ anexo do deal ${l.deal_id} desistiu apos ${l.anexo_tentativas} tentativas (a nota esta no CRM)`);
  }

  if (pendentes.length) console.log(`  📎 retomada de anexos: ${resolvidos}/${pendentes.length} resolvido(s)`);
  return resolvidos;
}

function limparAnexosExpirados(stmts) {
  let apagados = 0;
  for (const linha of stmts.anexosExpirados.all()) {
    try { if (linha.anexo_caminho && fs.existsSync(linha.anexo_caminho)) fs.unlinkSync(linha.anexo_caminho); } catch {}
    try { stmts.encerrarAnexo.run(linha.gmail_message_id); apagados++; } catch {}
  }
  if (apagados) console.log(`  🧹 ${apagados} anexo(s) expirado(s): URL invalidada e PDF removido do disco`);
  return apagados;
}

// ------------------------------------------------------------
// O ciclo
// ------------------------------------------------------------

function montarQueryNotas() {
  const excluir = Object.values(NOTAS_ROTULOS).map((r) => `-label:"${r}"`).join(' ');
  return `from:${NOTAS_REMETENTE} newer_than:${NOTAS_JANELA_DIAS}d ${excluir}`;
}

// Processa UM e-mail, do zero ou retomando de onde parou. A ordem existe para que todo artefato caro
// seja gravado antes do proximo passo arriscado, e para que a unica operacao NAO idempotente (o POST
// da nota) fique entre dois commits.

async function processarNotaReuniao({ gmail, calendar, drive, mensagem, stmts, dryRun, dealIdForcado = null }) {
  const id = mensagem.id;
  const linha = stmts.get.get(id) || {};
  const assunto = cabecalhoGmail(mensagem.payload, 'Subject');

  // GUARDA DE ESTADO TERMINAL — e a que impede a nota duplicada no caso mais provavel de todos.
  //
  // O rotulo do Gmail e o que tira a mensagem da busca, mas ele e aplicado DEPOIS de o estado virar
  // terminal, e o `messages.list` do mesmo ciclo roda logo em seguida. Duas rotas levavam ao estrago:
  //
  //   1. A retomada de um POSTANDO falha -> vira REVISAR_MANUAL, sem rotulo -> a busca a devolve ->
  //      o loop principal nao casa nenhum dos `if` de retomada abaixo (o estado nao e mais POSTANDO)
  //      e reprocessa do ZERO: paga OpenAI e posta de novo uma nota que talvez ja exista.
  //   2. No caminho de SUCESSO: a retomada conclui e rotula, mas se o indice de busca do Gmail
  //      atrasar, a mensagem volta na lista com estado CONCLUIDO — e, de novo, nada abaixo a barra.
  //
  // O marcador dentro da nota nao cobre isso: ele so e consultado dentro do ramo POSTANDO.
  //
  // `dealIdForcado` (religamento manual) atravessa de proposito — e o unico jeito de ressuscitar um
  // orfao. Menos quando ja foi postada: ai religar so criaria a segunda nota, e quem pediu precisa
  // saber disso em vez de descobrir no prontuario do cliente.
  const ESTADOS_TERMINAIS = new Set(['CONCLUIDO', 'SEM_TRANSCRICAO', 'ORFAO', 'ERRO_PERMANENTE', 'REVISAR_MANUAL']);
  if (ESTADOS_TERMINAIS.has(linha.estado)) {
    if (!dealIdForcado) {
      console.log(`  ⏭️ ${id}: ja resolvido nesta caixa (${linha.estado}) — o rotulo ainda nao apareceu na busca`);
      return { estado: linha.estado, dealId: linha.deal_id, jaResolvido: true };
    }
    if (linha.estado === 'CONCLUIDO') {
      throw new Error(`mensagem ${id} ja foi postada no deal ${linha.deal_id} — religar criaria uma segunda nota`);
    }
  }

  // Retomada de POSTADA: a nota JA existe no CRM e so o Gmail nao soube. Refaz apenas o rotulo.
  if (linha.estado === 'POSTADA') {
    if (!dryRun) await rotularNota(gmail, id, NOTAS_ROTULOS.processado);
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'CONCLUIDO', ultimo_erro: null });
    console.log(`  🔁 ${id}: rotulo pendente aplicado (a nota ja estava no CRM)`);
    return { estado: 'CONCLUIDO', dealId: linha.deal_id };
  }

  // Retomada de POSTANDO: ambiguo — o processo morreu entre "vou postar" e "postei", e a nota pode
  // ou nao existir. Nao reposta as cegas.
  if (linha.estado === 'POSTANDO' && linha.deal_id && linha.marcador) {
    const existe = await notaComMarcadorExiste(linha.deal_id, linha.marcador);
    if (existe) {
      if (!dryRun) await rotularNota(gmail, id, NOTAS_ROTULOS.processado);
      stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'CONCLUIDO', ultimo_erro: null });
      console.log(`  🔁 ${id}: nota ja existia no deal ${linha.deal_id} — nada reposto`);
      return { estado: 'CONCLUIDO', dealId: linha.deal_id };
    }
    console.log(`  🔁 ${id}: marcador ausente no deal ${linha.deal_id} — postagem sera refeita`);
  }

  stmts.inserir.run(id, assunto);

  // --- 1. Fonte -------------------------------------------------------------
  const { texto: corpo, html } = extrairCorpoGmail(mensagem.payload);
  if (!corpo && !html) {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'ERRO_PERMANENTE', ultimo_erro: 'e-mail sem corpo' });
    if (!dryRun) await rotularNota(gmail, id, NOTAS_ROTULOS.erro);
    return { estado: 'ERRO_PERMANENTE' };
  }

  const doAssunto = notasReuniao.parseAssuntoGemini(assunto);
  // Assunto ilegivel nao descarta o e-mail: o dia sai do proprio carimbo de recebimento. Perde-se o
  // titulo (usado para casar o evento), nao a reuniao inteira.
  const dataIso = doAssunto?.dataIso
    || new Date(Number(mensagem.internalDate)).toLocaleDateString('en-CA', { timeZone: TZ_ESCRITORIO });

  const docIdDoCorpo = notasReuniao.extrairDocId(html) || notasReuniao.extrairDocId(corpo);
  const evento = await acharEventoDaReuniao(calendar, {
    dataIso,
    tituloEvento: doAssunto?.tituloEvento,
    docId: docIdDoCorpo,
  }).catch((e) => {
    console.error(`  ⚠️ falha ao buscar o evento na agenda: ${e.message}`);
    return null;
  });

  const sinais = notasReuniao.extrairSinais({ evento, assunto, corpo });
  const docId = sinais.docId || docIdDoCorpo;

  // O mesmo Doc chegando por outra mensagem (encaminhamento, reenvio) nao pode virar segunda nota.
  //
  // O guard cobre QUALQUER estado da primeira copia, nao so CONCLUIDO. Antes olhava apenas o caso
  // concluido, e o resto caia num buraco: se a primeira copia tivesse virado orfa, o UPDATE deste
  // e-mail com o mesmo doc_id batia no indice unico, lancava, e o e-mail voltava a cada 10 min para
  // sempre — sem rotulo, sem aviso, so repetindo a violacao de constraint no log.
  const jaPeloDoc = docId ? stmts.porDoc.get(docId) : null;
  if (jaPeloDoc && jaPeloDoc.gmail_message_id !== id) {
    const concluida = jaPeloDoc.estado === 'CONCLUIDO';
    const motivo = concluida
      ? `duplicata do Doc ja processado em ${jaPeloDoc.gmail_message_id}`
      : `duplicata do Doc de ${jaPeloDoc.gmail_message_id}, que esta em ${jaPeloDoc.estado} — resolver por la`;

    stmts.avancar.run({
      ...camposVazios(), gmail_message_id: id,
      estado: concluida ? 'CONCLUIDO' : 'ERRO_PERMANENTE',
      ultimo_erro: motivo,
    });
    // Rotula nos dois casos para o e-mail sair da busca. A copia canonica continua sendo a outra
    // mensagem — e e la que o religamento manual acontece, se for preciso.
    if (!dryRun) await rotularNota(gmail, id, concluida ? NOTAS_ROTULOS.processado : NOTAS_ROTULOS.erro).catch(() => {});
    console.log(`  ⏭️ ${id}: ${motivo}`);
    return { estado: concluida ? 'CONCLUIDO' : 'ERRO_PERMANENTE', dealId: jaPeloDoc.deal_id };
  }

  // --- 2. Qual negocio ------------------------------------------------------
  const porTelefone = buscarDealsPorTelefone(sinais.telefone);
  const porEmail = porTelefone.length ? [] : buscarDealsPorEmail(sinais.emails);
  // A varredura de /activities e a unica chamada cara da cascata: so roda quando nada local resolveu.
  const precisaAtividades = !sinais.dealIdNoTitulo && !sinais.dealIdMarcado
    && !porTelefone.length && !sinais.idSolto && !porEmail.length;
  const { ids: porAtividade, truncou: truncouAtividades } = precisaAtividades
    ? await buscarDealsPorAtividade(sinais.inicioIso).catch((e) => {
      console.error(`  ⚠️ falha ao varrer atividades: ${e.message}`);
      return { ids: [], truncou: false };
    })
    : { ids: [], truncou: false };

  const apurada = notasReuniao.decidirDeal(sinais, { porTelefone, porEmail, porAtividade, truncouAtividades });

  // Religamento manual de um orfao (reprocessar-nota-reuniao.js). A cascata roda mesmo assim, e o
  // que ela teria decidido fica no diagnostico: se um humano precisou corrigir, e porque alguma
  // regra falhou, e o registro do que ela viu e o que permite consertar a regra depois.
  const resolucao = dealIdForcado
    ? {
      dealId: Number(dealIdForcado),
      metodo: 'manual',
      confianca: 'alta',
      candidatos: [Number(dealIdForcado)],
      diagnostico: { ...apurada.diagnostico, cascataTeriaDecidido: { dealId: apurada.dealId, metodo: apurada.metodo } },
    }
    : apurada;

  stmts.avancar.run({
    ...camposVazios(),
    gmail_message_id: id,
    estado: 'DEAL_RESOLVIDO',
    doc_id: docId,
    evento_id: sinais.eventoId,
    deal_id: resolucao.dealId,
    metodo: resolucao.metodo,
    diagnostico: JSON.stringify(resolucao.diagnostico),
    ultimo_erro: null,
  });

  if (!resolucao.dealId) {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'ORFAO', ultimo_erro: resolucao.metodo });
    if (!dryRun) {
      await rotularNota(gmail, id, NOTAS_ROTULOS.orfao);
      await avisarOrfao({ id, assunto, resolucao });
    }
    console.log(`  ❓ ${id}: orfao (${resolucao.metodo}) — "${assunto}"`);
    return { estado: 'ORFAO', resolucao };
  }

  // --- 3. Ha transcricao? ----------------------------------------------------
  // Decisao de 02/09/2026: a nota deixou de extrair conteudo por IA — vira so o link da
  // transcricao. Sem Doc nenhum referenciado (nem no evento, nem no e-mail), nao ha nada util para
  // postar: a reuniao nao gerou nota nenhuma no negocio (silencioso, nao e erro).
  if (!docId) {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'SEM_TRANSCRICAO', ultimo_erro: null });
    if (!dryRun) await rotularNota(gmail, id, NOTAS_ROTULOS.processado);
    console.log(`  ℹ️ ${id}: sem transcricao (reuniao sem Doc/gravacao) — nenhuma nota no deal ${resolucao.dealId}`);
    return { estado: 'SEM_TRANSCRICAO', dealId: resolucao.dealId };
  }

  // --- 4. A nota ------------------------------------------------------------
  const marcador = notasReuniao.marcadorNota(id, docId);

  // O anexo vem ANTES da nota de proposito: so assim o rodape pode afirmar "transcricao anexada" e
  // ser verdade. `anexarDocNoDeal` nunca lanca — se falhar, `anexado` volta false, a linha some do
  // rodape e a nota entra igual (com o link cru do Doc — retentativas transitorias continuam
  // tentando religar o PDF depois, via retomarAnexosPendentes).
  const { anexado, motivo: motivoAnexo } = await anexarDocNoDeal({
    dealId: resolucao.dealId, docId, gmailMessageId: id, dataIso, marcador, drive, stmts, dryRun,
  });

  // 'export_falhou' e veredito do Drive (404/403 — permanente, nao transitorio): o Doc referenciado
  // no evento/e-mail nao existe de verdade ou esta fora do alcance da credencial. Sem PDF nenhum
  // para anexar e sem certeza de que o link abre para alguem, trata igual a "sem transcricao" —
  // postar um link morto nao e "util".
  if (motivoAnexo === 'export_falhou') {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'SEM_TRANSCRICAO', ultimo_erro: null });
    if (!dryRun) await rotularNota(gmail, id, NOTAS_ROTULOS.processado);
    console.log(`  ℹ️ ${id}: Doc referenciado mas inacessivel (${motivoAnexo}) — nenhuma nota no deal ${resolucao.dealId}`);
    return { estado: 'SEM_TRANSCRICAO', dealId: resolucao.dealId };
  }

  const texto = notasReuniao.montarTextoNota({
    marcador,
    meta: {
      dataBr: dataIso.split('-').reverse().join('/'),
      tituloEvento: sinais.tituloEvento || doAssunto?.tituloEvento,
      anexado,
      linkDoc: `https://docs.google.com/document/d/${docId}`,
      metodo: resolucao.metodo,
      confianca: resolucao.confianca,
      numeroReuniao: reuniaoRetorno.numeroDaReuniao(reunioesConhecidasDoDeal(resolucao.dealId), dataIso),
    },
  });

  if (dryRun) {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'CONCLUIDO', marcador, ultimo_erro: null });
    console.log(`\n  📝 [dry-run] nota que IRIA para o deal ${resolucao.dealId} (${resolucao.metodo}):\n${texto}\n`);
    return { estado: 'CONCLUIDO', dealId: resolucao.dealId, resolucao, texto };
  }

  // O bracket: grava a INTENCAO antes da rede, para que um crash no meio deixe rastro suficiente
  // para a retomada decidir sem adivinhar.
  stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'POSTANDO', marcador, ultimo_erro: null });
  await criarNotaMoskit(resolucao.dealId, texto); // 4xx LANCA, de proposito
  stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'POSTADA', ultimo_erro: null });

  await rotularNota(gmail, id, NOTAS_ROTULOS.processado);
  stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'CONCLUIDO', ultimo_erro: null });

  console.log(`  ✅ ${id}: nota criada no deal ${resolucao.dealId} (${resolucao.metodo}/${resolucao.confianca})`);
  return { estado: 'CONCLUIDO', dealId: resolucao.dealId, resolucao };
}

// Todos os campos do UPDATE precisam existir no objeto nomeado, mesmo quando nao mudam — o
// COALESCE do statement e quem preserva o valor antigo.
const camposVazios = () => ({
  doc_id: null, evento_id: null, deal_id: null, metodo: null,
  diagnostico: null, extracao: null, marcador: null,
});

// Registra a falha e DESISTE depois de NOTAS_MAX_TENTATIVAS. Sem isto o e-mail voltava a cada ciclo
// para sempre: pagando OpenAI de novo quando a falha era depois da extracao, e — pior — em silencio,
// porque nada lia a coluna `tentativas` que vinha sendo incrementada.
//
// Desistir aqui significa estado terminal + rotulo + Telegram UMA vez. O e-mail sai da busca, o
// trabalho ja feito continua na tabela, e religar e um comando manual.
async function registrarFalhaNota({ stmts, gmail, id, erro, dryRun, ambiguo = false }) {
  stmts.falhar.run(erro, id);
  const linha = stmts.get.get(id);
  if (!linha) return false; // falhou antes de existir linha (ex.: o proprio messages.get) — nada a escalar

  // `ambiguo` significa uma coisa so: a RETOMADA de um POSTANDO nao conseguiu descobrir se a nota ja
  // existe no CRM. Nao e o mesmo que "o POST falhou" — um POST que falha deixa o estado em POSTANDO e
  // o ciclo seguinte resolve sozinho, conferindo o marcador e repostando se faltar. Inferir isso do
  // estado mandaria uma falha de rede comum direto para revisao manual, desperdicando a reconciliacao
  // que existe justamente para esse caso.
  if (ambiguo) {
    stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'REVISAR_MANUAL', ultimo_erro: erro });
    if (!dryRun) {
      // Rotular e o que tira a mensagem da busca. Sem isso ela voltava no `messages.list` do MESMO
      // ciclo — e a guarda de estado terminal a barraria, mas depender de uma unica defesa aqui e
      // pouco: o desfecho ruim e uma segunda nota no prontuario do cliente.
      await rotularNota(gmail, id, NOTAS_ROTULOS.erro).catch(() => {});
      await enviarTelegram(`⚠️ *Nota de reunião em estado ambíguo*\nMensagem \`${id}\`, deal \`${linha.deal_id}\`.\nNão foi possível confirmar se a nota já existe: ${erro}\nConferir na mão antes de reprocessar.`).catch(() => {});
    }
    return true;
  }

  if (linha.tentativas < NOTAS_MAX_TENTATIVAS) return false;

  stmts.avancar.run({ ...camposVazios(), gmail_message_id: id, estado: 'ERRO_PERMANENTE', ultimo_erro: erro });
  if (!dryRun) {
    await rotularNota(gmail, id, NOTAS_ROTULOS.erro).catch(() => {});
    await enviarTelegram([
      '❌ *Nota de reunião desistida após 3 tentativas*',
      `Mensagem: \`${id}\``,
      linha.deal_id ? `Negócio: \`${linha.deal_id}\`` : 'Negócio: não identificado',
      `Último erro: ${erro}`,
      '',
      `Depois de resolver: \`node reprocessar-nota-reuniao.js ${id} <dealId> --aplicar\``,
    ].join('\n')).catch(() => {});
  }
  console.error(`  🛑 ${id}: desistido apos ${linha.tentativas} tentativas — ${erro}`);
  return true;
}

// Silencio prolongado = alguma coisa quebrou calada. Roda no fim do ciclo, olhando a ultima vez que a
// busca devolveu ALGUMA mensagem — nunca "este ciclo veio vazio", que e o estado normal.
async function conferirSilencioNotas({ viuMensagem, dryRun }) {
  if (viuMensagem) {
    stmtNotasViuEmail.run();
    return;
  }
  if (dryRun) return; // durante a semana de dry-run tem gente olhando; aviso aqui seria ruido

  const saude = stmtNotasSaude.get();
  const desde = saude?.ultimo_email_em ? Date.parse(`${saude.ultimo_email_em}Z`) : null;
  if (!desde) return;

  const dias = (Date.now() - desde) / (24 * 60 * 60 * 1000);
  if (dias < NOTAS_SILENCIO_DIAS) return;

  // Um aviso por janela de silencio, nao um a cada 10 min.
  const avisou = saude.ultimo_aviso_em ? Date.parse(`${saude.ultimo_aviso_em}Z`) : null;
  if (avisou && (Date.now() - avisou) / (24 * 60 * 60 * 1000) < NOTAS_SILENCIO_DIAS) return;

  stmtNotasAvisouSilencio.run();
  await enviarTelegram([
    '🔕 *Notas de reunião: nenhum e-mail novo há ' + Math.floor(dias) + ' dias*',
    'Pode ser que simplesmente não houve reunião com notas — ou que o token do Google expirou,',
    'ou que o Google mudou o formato do assunto e a busca parou de casar.',
    '',
    'Conferir: `node sondar-notas.js` e a caixa do escritório por e-mails de `gemini-notes@google.com`.',
  ].join('\n')).catch(() => {});
}

async function rotularNota(gmail, messageId, rotulo) {
  const labelId = await garantirRotuloGmail(gmail, rotulo);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId], removeLabelIds: ['UNREAD'] },
  });
}

async function avisarOrfao({ id, assunto, resolucao }) {
  const d = resolucao.diagnostico || {};
  const linhas = [
    '❓ *Notas de reunião sem negócio identificado*',
    `Assunto: ${assunto}`,
    d.tituloEvento ? `Evento: ${d.tituloEvento}` : '⚠️ Nenhum evento correspondente na agenda',
    `Motivo: ${resolucao.metodo}${resolucao.candidatos?.length ? ` (candidatos: ${resolucao.candidatos.join(', ')})` : ''}`,
    // Divergencia entre os dois marcadores tem conserto diferente: o problema esta no EVENTO, nao na
    // regra. Quase sempre evento copiado de outro cliente com so um dos dois atualizado.
    resolucao.metodo === 'marcadores_divergentes'
      ? `⚠️ O título diz #${d.tituloDizia} e a descrição diz [deal:${d.descricaoDizia}]. Corrija o evento na agenda antes de religar.`
      : '',
    d.atividadesTruncadas ? '⚠️ A varredura de atividades bateu no teto — pode haver candidato não visto.' : '',
    '',
    `Para vincular na mão: \`node reprocessar-nota-reuniao.js ${id} <dealId>\``,
  ].filter(Boolean);
  await enviarTelegram(linhas.join('\n')).catch(() => {});
}

// Evita dois ciclos sobrepostos (o setInterval e a rota manual podem coincidir). Mesmo motivo de
// sincronizacaoAtividadesEmAndamento: cada mensagem faz varias chamadas de rede e duas execucoes
// simultaneas gerariam nota e rotulo duplicados.
let sincronizacaoNotasEmAndamento = false;

async function sincronizarNotasReuniao({ dryRun = NOTAS_REUNIAO_DRY_RUN, limite = NOTAS_MAX_POR_CICLO, soAmostrar = false } = {}) {
  if (sincronizacaoNotasEmAndamento) {
    console.log('  ⏭️ Sincronizacao de notas de reuniao ja em andamento — pulando');
    return { pulado: true };
  }

  const auth = getGoogleAuthClientNotas();
  if (!auth) {
    return { erro: 'credencial de Gmail/Drive ausente — rodar node autorizar-google-notas.js' };
  }

  sincronizacaoNotasEmAndamento = true;
  const stmts = stmtsNotas(dryRun);
  const relatorio = { processadas: 0, notas: 0, orfaos: 0, erros: 0, itens: [] };

  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });
    const calendar = google.calendar({ version: 'v3', auth });

    // Cria os tres rotulos ANTES de montar a busca. A query e feita de `-label:"Notas/..."`, e no
    // primeiro ciclo eles ainda nao existem — um `-label:` de rotulo inexistente nao tem
    // comportamento garantido, e se ele nao casar nada a rotina volta vazia e parece estar
    // funcionando sem fazer nada. Uma chamada resolve e tira a duvida do caminho.
    for (const rotulo of Object.values(NOTAS_ROTULOS)) await garantirRotuloGmail(gmail, rotulo);

    // Dívida primeiro: um e-mail que ficou preso em POSTADA/POSTANDO tem de ser resolvido antes de
    // aceitar trabalho novo, senao a pendencia envelhece atras da fila.
    //
    // Pulado na amostragem: `soAmostrar` promete só leitura, e esta retomada CHEGA A POSTAR. Hoje a
    // rota fixa dryRun=true, entao nao havia dano — mas era uma armadilha esperando a primeira
    // chamada com dryRun=false.
    const pendentes = soAmostrar
      ? []
      : stmts.pendentes.all().filter((p) => ['POSTANDO', 'POSTADA'].includes(p.estado));
    for (const p of pendentes) {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: p.gmail_message_id, format: 'full' });
        await processarNotaReuniao({ gmail, calendar, drive, mensagem: msg.data, stmts, dryRun });
      } catch (e) {
        console.error(`  ❌ retomada de ${p.gmail_message_id} falhou: ${e.message}`);
        await registrarFalhaNota({ stmts, gmail, id: p.gmail_message_id, erro: e.message, dryRun, ambiguo: p.estado === 'POSTANDO' });
      }
    }

    const lista = await gmail.users.messages.list({ userId: 'me', q: montarQueryNotas(), maxResults: limite });
    const mensagens = lista.data.messages || [];
    console.log(`📨 Notas de reuniao: ${mensagens.length} e-mail(s) a processar${dryRun ? ' [DRY-RUN]' : ''}`);

    for (const ref of mensagens) {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' });

        if (soAmostrar) {
          relatorio.itens.push(await amostrarNota({ calendar, mensagem: msg.data }));
          continue;
        }

        const r = await processarNotaReuniao({ gmail, calendar, drive, mensagem: msg.data, stmts, dryRun });
        relatorio.processadas++;
        if (r.estado === 'CONCLUIDO' && r.dealId) relatorio.notas++;
        if (r.estado === 'ORFAO') relatorio.orfaos++;
        if (r.estado === 'ERRO_PERMANENTE') relatorio.erros++;
      } catch (e) {
        relatorio.erros++;
        console.error(`  ❌ ${ref.id}: ${e.message}`);
        if (String(e.message).includes('invalid_grant')) {
          // Nao conta como tentativa do e-mail: a culpa e da credencial, nao dele. Contar aqui
          // gastaria as 3 chances de todos os e-mails da caixa num unico token expirado.
          await enviarTelegram('❌ *Notas de reunião: token do Google expirou*\nRodar `node autorizar-google-notas.js` na VPS. Enquanto isso, nenhuma nota de reunião entra no CRM.').catch(() => {});
          break; // as proximas falhariam igual
        }
        // Garante que exista linha antes de contar a tentativa: se a falha foi no proprio
        // `messages.get`, `processarNotaReuniao` nem chegou ao INSERT, e sem linha o contador nao
        // sobe — a mensagem tentaria para sempre, que e o defeito que NOTAS_MAX_TENTATIVAS existe
        // para matar.
        stmts.inserir.run(ref.id, '(assunto nao lido)');
        const desistiu = await registrarFalhaNota({ stmts, gmail, id: ref.id, erro: e.message, dryRun });
        if (desistiu) relatorio.desistidas = (relatorio.desistidas || 0) + 1;
      }
    }

    // Depois do trabalho novo: o anexo e bonus, entao nunca disputa vez com a nota. Os dois nunca
    // lancam — uma falha aqui nao pode perder o relatorio do ciclo que ja rodou.
    if (!soAmostrar) {
      await retomarAnexosPendentes({ stmts, drive, dryRun }).catch((e) =>
        console.error(`  ❌ retomada de anexos falhou: ${e.message}`));
      try { limparAnexosExpirados(stmts); } catch (e) { console.error(`  ❌ limpeza de anexos: ${e.message}`); }
    }

    await conferirSilencioNotas({ viuMensagem: mensagens.length > 0, dryRun }).catch(() => {});

    return relatorio;
  } finally {
    sincronizacaoNotasEmAndamento = false;
  }
}

// Só leitura: mostra o que a cascata decidiria, sem extrair nada nem escrever em lugar nenhum.
// É o teste de regressão manual para quando o Google mudar o formato do e-mail.
async function amostrarNota({ calendar, mensagem }) {
  const assunto = cabecalhoGmail(mensagem.payload, 'Subject');
  const { texto: corpo, html } = extrairCorpoGmail(mensagem.payload);
  const doAssunto = notasReuniao.parseAssuntoGemini(assunto);
  const dataIso = doAssunto?.dataIso
    || new Date(Number(mensagem.internalDate)).toLocaleDateString('en-CA', { timeZone: TZ_ESCRITORIO });

  const docIdDoCorpo = notasReuniao.extrairDocId(html) || notasReuniao.extrairDocId(corpo);
  const evento = await acharEventoDaReuniao(calendar, { dataIso, tituloEvento: doAssunto?.tituloEvento, docId: docIdDoCorpo })
    .catch(() => null);

  const sinais = notasReuniao.extrairSinais({ evento, assunto, corpo });
  const porTelefone = buscarDealsPorTelefone(sinais.telefone);
  const porEmail = porTelefone.length ? [] : buscarDealsPorEmail(sinais.emails);
  const resolucao = notasReuniao.decidirDeal(sinais, { porTelefone, porEmail, porAtividade: [] });

  return {
    id: mensagem.id,
    assunto,
    data: dataIso,
    evento_encontrado: !!evento,
    titulo_evento: sinais.tituloEvento,
    telefone: sinais.telefone,
    doc_id: sinais.docId || docIdDoCorpo || null,
    corpo_chars: corpo.length,
    deal_id: resolucao.dealId,
    metodo: resolucao.metodo,
    confianca: resolucao.confianca,
    // A varredura de /activities NAO roda aqui: e a unica etapa cara da cascata e a amostragem
    // precisa ser barata o bastante para rodar a vontade. Um item sem deal aqui ainda pode resolver
    // no ciclo real.
    observacao: resolucao.dealId ? null : 'sem deal por sinal local; o ciclo real ainda tentaria /activities',
  };
}

app.get('/notas-reuniao/amostrar', exigeAdmin, rota(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 10, 50);
  const r = await sincronizarNotasReuniao({ soAmostrar: true, limite, dryRun: true });
  res.json(r);
}));

// Quantos clientes de retorno existem, e o que a decisao veria em cada um. SO LEITURA e SEM IA: e o
// jeito de medir a prevalencia (e a taxa de acerto) antes de ligar CLIENTE_RETORNO_ATIVO em producao,
// no mesmo espirito de /notas-reuniao/amostrar. Sem obsValidas nao ha veredito final — o que a rota
// mostra e o que o pipeline vai encontrar: consulta realizada e mensagens depois dela.
app.get('/clientes-retorno/amostrar', exigeAdmin, rota(async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 20, 100);
  const linhas = db.prepare(
    'SELECT chat_id, contact_name, deal_id, messages, last_data, evento_calendar_data FROM conversations ' +
    'WHERE deal_id IS NOT NULL AND evento_calendar_data IS NOT NULL ORDER BY last_processed_at DESC LIMIT ?'
  ).all(limite * 5);

  const candidatos = [];
  for (const linha of linhas) {
    const consulta = consultaDoAtendimento(linha);
    if (!consulta.realizada) continue;
    const mensagens = parseJsonSeguro(linha.messages, null) || [];
    const corte = clienteRetorno.primeiraMensagemApos(mensagens, consulta.fimComFolga);
    if (corte === null) continue;
    const dados = parseJsonSeguro(linha.last_data, null) || {};
    candidatos.push({
      chat_id: linha.chat_id,
      contato: linha.contact_name || null,
      deal_id: linha.deal_id,
      consulta_em: consulta.quando,
      consulta_fonte: consulta.fonte,
      assunto_atual: dados.assunto || null,
      area_atual: dados.area_direito || null,
      msgs_depois_da_consulta: mensagens.length - corte,
      corte_seria_na_msg: corte,
      // O veredito depende de observacao validada de caso descrito DEPOIS da consulta, que so existe
      // dentro de um ciclo (custa OpenAI). Aqui fica o que falta para o pipeline decidir.
      falta: 'observacao validada de caso descrito depois da consulta + assunto/area diferentes',
    });
    if (candidatos.length >= limite) break;
  }

  res.json({
    ok: true,
    ativo: CLIENTE_RETORNO_ATIVO,
    dry_run: CLIENTE_RETORNO_DRY_RUN,
    folga_horas: RETORNO_FOLGA_HORAS,
    varridas: linhas.length,
    candidatos: candidatos.length,
    itens: candidatos,
  });
}));

app.post('/notas-reuniao/sincronizar', exigeAdmin, rota(async (req, res) => {
  const r = await sincronizarNotasReuniao({ dryRun: req.query.aplicar === '1' ? false : NOTAS_REUNIAO_DRY_RUN });
  res.json(r);
}));

// Aviso e o unico canal pelo qual o escritorio descobre comprovante recebido, orfao de nota e
// remarcacao travada. Perder um por formatacao e pior que manda-lo feio.
//
// MEDIDO em 19/08/2026: 400 do Telegram aparecendo repetidas vezes nos logs de producao. A causa e o
// `parse_mode: 'Markdown'` — basta o texto interpolar um nome de arquivo com `_` desbalanceado (e
// comprovante de WhatsApp se chama `comprovante_pix_18.pdf`) para o Telegram recusar a mensagem
// inteira. O aviso simplesmente nao chegava, e o unico rastro era esta linha de erro.
//
// Agora o Markdown e uma TENTATIVA: recusada, o mesmo texto vai como plain text. Alerta feio chega;
// alerta nenhum, nao.
async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const enviar = (comMarkdown) => axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    ...(comMarkdown ? { parse_mode: 'Markdown' } : {}),
  });

  try {
    await enviar(true);
    console.log('  ✅ Notificacao enviada ao Telegram');
    return;
  } catch (e) {
    // Só 400 é problema de formatação. 401/403 (token errado, bot bloqueado) e falha de rede não se
    // resolvem tirando o Markdown — reenviar ali seria só gastar uma segunda chamada para o mesmo erro.
    if (e.response?.status !== 400) {
      console.error(`  ❌ Erro ao notificar Telegram: ${e.message}`);
      return;
    }
    console.error(`  ⚠️ Telegram recusou o Markdown (${e.response?.data?.description || '400'}) — reenviando como texto puro`);
  }

  try {
    await enviar(false);
    console.log('  ✅ Notificacao enviada ao Telegram (sem formatacao)');
  } catch (e) {
    console.error(`  ❌ Erro ao notificar Telegram, mesmo sem formatacao: ${e.message}`);
  }
}

async function notificarTelegramMeet({ nome, telefone, advogado, dataHoraTexto, meetLink, dealId, remarcado }) {
  const texto = [
    remarcado ? `🔁 *Consulta remarcada!*` : (meetLink ? `📅 *Nova consulta com Meet pronto!*` : `📅 *Nova consulta agendada (presencial)!*`),
    `Cliente: ${nome || 'nao informado'}${telefone ? ` (${telefone})` : ''}`,
    `Advogado: ${advogado || 'a definir'}`,
    remarcado ? `Novo horário: ${dataHoraTexto}` : `Quando: ${dataHoraTexto}`,
    meetLink ? (remarcado ? `Link do Meet (o mesmo de antes): ${meetLink}` : `Link do Meet: ${meetLink}`) : '',
    dealId ? `Negócio: https://app.ollow.com.br/?/deal/${dealId}` : '',
    '',
    meetLink
      ? (remarcado
        ? 'Avise o cliente e o advogado responsável do novo horário no WhatsApp (o link do Meet continua o mesmo).'
        : 'Copie o link e envie pro cliente e pro advogado responsável no WhatsApp.')
      : 'Avise o cliente e o advogado responsável do horário combinado (sem link de videochamada).',
  ].filter(Boolean).join('\n');
  await enviarTelegram(texto);
}

function extrairMeetLink(eventoData) {
  if (!eventoData) return null;
  if (eventoData.hangoutLink) return eventoData.hangoutLink;
  const entryPoints = eventoData.conferenceData?.entryPoints || [];
  return entryPoints.find((e) => e.entryPointType === 'video')?.uri || null;
}

async function notificarTelegram(phone, att, caminho) {
  const tipo = att.type === 'image' ? 'imagem' : att.type === 'document' || att.type === 'file' ? 'documento' : att.type;
  const nome = att.payload?.filename || att.payload?.name || '';
  let texto = `📸 *NOVO COMPROVANTE*\nCliente: \`${phone}\`\nTipo: ${tipo}`;
  if (nome) texto += `\nArquivo: ${nome}`;
  if (caminho) texto += `\nSalvo em: \`${caminho}\``;
  await enviarTelegram(texto);
}

const PROMPT_COMPROVANTE = `
Analise esta imagem de um comprovante de pagamento (PIX, transferencia ou cartao) enviado por um cliente de escritorio de advocacia.

Extraia o valor pago e avalie se a imagem realmente parece um comprovante de pagamento valido.

REGRAS:
- Se a imagem estiver ilegivel, cortada, ou voce nao tiver certeza do valor, marque parece_comprovante como false e valor_pago_centavos como null. NUNCA chute um valor que voce nao consegue ler com clareza.
- valor_pago_centavos deve ser o valor total pago, em centavos (ex: R$350,00 vira 35000).
- confianca de 0 a 10 sobre sua propria leitura do valor.

Retorne APENAS um JSON no formato:
{"parece_comprovante": true, "valor_pago_centavos": 35000, "confianca": 9, "observacao": "Comprovante de PIX no valor de R$350,00"}
`;

async function verificarComprovante(caminho) {
  const resultadoPadrao = { parece_comprovante: false, valor_pago_centavos: null, confianca: 0, observacao: 'Nao verificado' };
  if (!caminho) return resultadoPadrao;

  try {
    const buffer = fs.readFileSync(caminho);
    const ext = path.extname(caminho).toLowerCase().replace('.', '') || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    const conteudo = await openaiChat([
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT_COMPROVANTE },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ], 'json');

    if (!conteudo) return resultadoPadrao;
    const parsed = JSON.parse(conteudo);
    return {
      parece_comprovante: !!parsed.parece_comprovante,
      valor_pago_centavos: typeof parsed.valor_pago_centavos === 'number' ? parsed.valor_pago_centavos : null,
      confianca: Number(parsed.confianca) || 0,
      observacao: parsed.observacao || '',
    };
  } catch (e) {
    console.error(`  ❌ Erro ao verificar comprovante: ${e.message}`);
    return { ...resultadoPadrao, observacao: 'Erro ao processar imagem: ' + e.message };
  }
}

async function processarComprovante(chatId, phone, caminho) {
  const resultado = await verificarComprovante(caminho);
  const match = resultado.parece_comprovante
    && resultado.valor_pago_centavos !== null
    && resultado.confianca >= 7
    && resultado.valor_pago_centavos >= COMPROVANTE_VALOR_ESPERADO_CENTAVOS;

  stmtComprovanteInsert.run({
    chat_id: chatId,
    phone,
    caminho_arquivo: caminho,
    valor_pago_centavos: resultado.valor_pago_centavos,
    confianca: resultado.confianca,
    parece_comprovante: resultado.parece_comprovante ? 1 : 0,
    observacao: resultado.observacao,
    match: match ? 1 : 0,
    notificado_telegram: 1,
  });

  const valorFormatado = resultado.valor_pago_centavos !== null ? `R$${(resultado.valor_pago_centavos / 100).toFixed(2)}` : 'ilegível';
  const valorEsperadoFormatado = `R$${(COMPROVANTE_VALOR_ESPERADO_CENTAVOS / 100).toFixed(2)}`;

  if (match) {
    await enviarTelegram(`✅ *Comprovante confere*\nCliente: \`${phone}\`\nValor lido: ${valorFormatado} (esperado ${valorEsperadoFormatado})`);
  } else {
    await enviarTelegram(`⚠️ *Comprovante NÃO confere — revisar manualmente*\nCliente: \`${phone}\`\nValor lido: ${valorFormatado} (esperado ${valorEsperadoFormatado})\nObs: ${resultado.observacao}`);
  }

  // Registra o resultado no historico da conversa pra IA de classificacao/extracao enxergar
  try {
    const row = stmtGet.get(chatId);
    if (row) {
      const mensagens = JSON.parse(row.messages || '[]');
      mensagens.push({
        role: 'sistema',
        text: match
          ? `✅ Comprovante verificado: ${valorFormatado} confirmado`
          : `⚠️ Comprovante recebido mas NÃO confere (valor lido: ${valorFormatado}, esperado ${valorEsperadoFormatado})`,
        timestamp: new Date().toISOString(),
      });
      db.prepare('UPDATE conversations SET messages = ? WHERE chat_id = ?').run(JSON.stringify(mensagens), chatId);
    }
  } catch (e) {
    console.error(`  ❌ Erro ao registrar verificacao no historico: ${e.message}`);
  }

  return { ...resultado, match };
}

// ------------------------------------------------------------
// Tratamento de erros globais
// ------------------------------------------------------------
process.on('uncaughtException', (erro) => {
  console.error('\n❌ Erro nao tratado (uncaughtException):', erro.message);
  console.error(erro.stack);
});

process.on('unhandledRejection', (erro) => {
  console.error('\n❌ Promise rejeitada sem catch (unhandledRejection):', erro?.message || erro);
  if (erro?.stack) console.error(erro.stack);
});

// ------------------------------------------------------------
// Start (apenas se nao for worker)
// ------------------------------------------------------------
if (!process.env.WORKER_MODE) {
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  if (!ADMIN_TOKEN) {
    console.warn('\n⚠️  ADMIN_TOKEN nao definido — as rotas administrativas estao DESABILITADAS (503).');
    console.warn('    Defina ADMIN_TOKEN no .env para poder usar /sincronizar, /processar, backfills etc.\n');
  }
  if (!WEBHOOK_SECRET) {
    console.warn('\n⚠️  WEBHOOK_SECRET nao definido — POST /webhook esta ACEITANDO QUALQUER ORIGEM.');
    console.warn('    Quem tiver a URL do ngrok consegue injetar mensagem com role="equipe", que e a');
    console.warn('    evidencia que autoriza agendamento na dupla confirmacao.');
    console.warn('    Defina WEBHOOK_SECRET no .env com o MESMO valor cadastrado no Zernio (Settings');
    console.warn('    > Webhooks > secret) — a assinatura HMAC no header X-Zernio-Signature passa a');
    console.warn('    ser exigida em toda entrega.\n');
  } else {
    console.log(`   Webhook autenticado: POST /webhook exige assinatura HMAC valida (X-Zernio-Signature)`);
  }
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);

  if (DEPLOY_WEBHOOK_SECRET) {
    console.log(`   Auto-deploy: POST /deploy-webhook ativo (branch "${DEPLOY_BRANCH}", assinatura X-Hub-Signature-256 exigida)`);
  } else {
    console.log(`   Auto-deploy: POST /deploy-webhook DESABILITADO (defina DEPLOY_WEBHOOK_SECRET no .env pra ativar)`);
  }

  const pendentes = stmtGetPending.all();
  for (const row of pendentes) {
    const inativo = Date.now() - new Date(row.last_activity).getTime();
    agendarProcessamento(row.chat_id, Math.max(0, TEMPO_INATIVIDADE_MS - inativo));
  }
  console.log(`${pendentes.length} conversas pendentes carregadas`);

  // Sincronizacao periodica: o webhook so recebe mensagens incoming; mensagens
  // enviadas pela equipe (outgoing) so aparecem via API, entao precisamos
  // puxar periodicamente pra detectar avancos no funil (proposta, contrato etc.)
  const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 3 * 60 * 1000;
  setInterval(() => {
    sincronizarConversas().catch((e) => console.error(`  ❌ Erro na sincronizacao periodica: ${e.message}`));
  }, SYNC_INTERVAL_MS);

  // Sincronizacao periodica de Atividades do Moskit (Reuniao/Videoconferencia) -> Google Calendar,
  // cobre consultas marcadas fora do fluxo do bot (Moskit Boost, agendamento manual)
  setInterval(() => {
    sincronizarAtividadesMoskit().catch((e) => console.error(`  ❌ Erro na sincronizacao de atividades: ${e.message}`));
  }, SYNC_INTERVAL_MS);

  // Notas de reuniao do Gemini -> nota no negocio. Cadencia propria e bem maior que a das duas
  // acima: reuniao termina algumas vezes por dia, e cada ciclo custa uma chamada de IA por e-mail.
  // Nasce em dry-run (NOTAS_REUNIAO_DRY_RUN) — a chave so vira depois de conferir, no acervo real,
  // as notas que TERIAM sido postadas.
  if (NOTAS_REUNIAO_ATIVO) {
    const modo = NOTAS_REUNIAO_DRY_RUN ? 'DRY-RUN (nao escreve no CRM)' : 'ATIVO';
    console.log(`   Notas de reuniao: a cada ${Math.round(NOTAS_SYNC_INTERVAL_MS / 60000)} min — ${modo}`);
    if (!getGoogleAuthClientNotas()) {
      console.log('   ⚠️ ...mas a credencial de Gmail/Drive nao existe: rodar `node autorizar-google-notas.js`');
    }
    setInterval(() => {
      sincronizarNotasReuniao().catch((e) => console.error(`  ❌ Erro na sincronizacao de notas de reuniao: ${e.message}`));
    }, NOTAS_SYNC_INTERVAL_MS);
  }

  // Reconciliacao da classificacao: rede de seguranca para o CRM nao ficar diferente do que o bot apurou
  // (PUT que nao pegou, conversa que parou de receber mensagem, alteracao feita fora do bot). Intervalo
  // proprio, bem maior que o da sincronizacao: e uma varredura de deals, 1 GET por deal.
  //
  // As TRES reconciliacoes (classificacao, vinculo, pendencias) varrem o Moskit. Se disparassem no
  // MESMO instante a cada ciclo, triplicariam o burst de GETs de uma vez — medido 14-17/08/2026, o
  // rate-limit do Moskit (HTTP 429) foi o que impediu a rotina de vinculo de religar qualquer coisa.
  // `agendarReconciliacao` desloca a FASE de cada uma (0/5/10 min), entao os picos nao coincidem.
  function agendarReconciliacao(nome, fn, faseMin) {
    const dispara = () => fn().catch((e) => console.error(`  ❌ Erro na ${nome}: ${e.message}`));
    setTimeout(dispara, faseMin * 60 * 1000);
    setInterval(dispara, RECONCILIACAO_INTERVAL_MS);
  }
  if (RECONCILIACAO_ATIVA) {
    console.log(`   Reconciliacao de classificacao: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min (janela de ${RECONCILIACAO_DIAS} dias)`);
    agendarReconciliacao('reconciliacao periodica', rodarReconciliacaoPeriodica, 0);

    // Mesma cadencia e mesma flag: religa sozinha a Atividade que o Moskit criou sem vincular ao
    // negocio (ver garantirVinculoAtividadeDeal/reconciliarVinculoAtividades).
    console.log(`   Reconciliacao de vinculo de atividade: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min`);
    agendarReconciliacao('reconciliacao de vinculo de atividade', rodarReconciliacaoVinculoAtividades, 5);

    // Mesma cadencia e mesma flag: avisa sobre pendencia de agendamento numa conversa que PAROU DE VEZ
    // (ver reconciliarPendenciasAgendamento) — a escalada por proximidade so roda dentro de um ciclo
    // de reprocessamento, e uma conversa muda nunca e reprocessada de novo.
    console.log(`   Reconciliacao de pendencia de agendamento: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min (janela de ${AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS} dias)`);
    agendarReconciliacao('reconciliacao de pendencia de agendamento', rodarReconciliacaoPendenciasAgendamento, 10);
  } else {
    console.log('   Reconciliacao de classificacao: DESLIGADA (RECONCILIACAO_ATIVA=false)');
  }

  // Refresh do briefing antes da consulta. Independe de RECONCILIACAO_ATIVA (nao varre o Moskit —
  // so le o banco local e enfileira); mesma cadencia e fase deslocada pra nao somar burst.
  if (BRIEFING_REFRESH_ATIVO) {
    console.log(`   Refresh de briefing pre-consulta: a cada ${Math.round(RECONCILIACAO_INTERVAL_MS / 60000)} min (ate ${BRIEFING_REFRESH_ANTECEDENCIA_HORAS}h antes, max ${BRIEFING_REFRESH_MAX_POR_CICLO}/ciclo)`);
    agendarReconciliacao('refresco de briefing pre-consulta', () => refrescarBriefingsPertoDaConsulta({ aplicar: true }), 15);
  } else {
    console.log('   Refresh de briefing pre-consulta: DESLIGADO (BRIEFING_REFRESH_ATIVO=false)');
  }

  // Expor via ngrok para receber webhooks do Zernio
  const { spawn } = require('child_process');
  const ngrokPath = process.platform === 'win32'
    ? require('path').join(__dirname, 'ngrok', 'ngrok.exe')
    : require('path').join(__dirname, 'ngrok', 'ngrok');
  // Porta propria para a API local do ngrok: a 4040 (padrao) pode estar ocupada por
  // outro agente (ex: bot de comprovantes na 3010) e ai leriamos o tunnel errado
  // A API local do ngrok fica na 4040; se ela ja estiver ocupada por outro agente, o proximo sobe
  // na 4041, e assim por diante. Nao da pra fixar por flag (--web-addr nao existe no CLI, so em
  // arquivo de config), entao varremos a faixa e pegamos o tunnel que aponta pra NOSSA porta.
  const ngrokProcess = spawn(ngrokPath, process.env.NGROK_URL
    ? ['http', String(PORT), '--url=' + process.env.NGROK_URL]
    : ['http', String(PORT)], { stdio: 'ignore', windowsHide: true });
  const NGROK_API_PORTS = [4040, 4041, 4042, 4043, 4044, 4045];
  const tentarNgrok = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      for (const apiPort of NGROK_API_PORTS) {
        try {
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
          const data = await res.json();
          // Ignora tuneis de outros projetos (ex: bot de comprovantes na 3010)
          const tunnel = data.tunnels?.find(t => String(t.config?.addr || '').endsWith(`:${PORT}`));
          const url = tunnel?.public_url;
          if (url) {
            console.log(`\n🌐 Tunnel publico (ngrok): ${url}  [api local :${apiPort}]`);
            console.log(`   Configure o webhook no Zernio para: ${url}/webhook`);
            require('fs').writeFileSync('tunnel_url.txt', url);
            return;
          }
        } catch {}
      }
    }
    console.error('\n⚠️ Nao foi possivel obter URL do ngrok');
  };
  tentarNgrok();
});
} // fim if !WORKER_MODE

// Exportar para worker process
// extrairDadosAtendimento/montarHistorico ficam exportados pra que os scripts de teste usem a MESMA
// logica do bot em vez de manter copias (que ja divergiram — ver test-cenarios-classificacao.js).
module.exports = {
  processarConversa,
  processarConversaDirect,
  equipeEnviouCondicoesDeValor,
  // Cliente que volta (ver src/cliente-retorno.js) — exportados para test-pipeline.js.
  janelaAtendimento,
  consultaDoAtendimento,
  lerDealsAnteriores,
  abrirNovoAtendimento,
  avisarRetornoUmaVez,
  dealEhConsultaGratis,
  extrairDadosAtendimento,
  classificarConversa,
  montarHistorico,
  mergeDados,
  montarPayloadMoskit,
  enviarTelegram, // worker.js avisa quando desiste de uma conversa
  // Exportado para regressao: a guarda de URL invalida e o log que identifica o host sao o que
  // tornou os 401 de download diagnosticaveis.
  baixarParaArquivo,
  // A decisao de credencial, exportada: e ela que impede a chave do escritorio de sair para um host
  // que nao seja o Zernio.
  montarHeadersAnexo,
  ehHostZernio,
  resolverUrlAnexo,
  // Exportadas para teste (test-pipeline.js / test-guards-internos.js). Sao as funcoes novas dos
  // Lotes 1 e 2 que nao tinham nenhuma cobertura. registrarAgendamentoPendente fica de fora de
  // proposito: e totalmente observavel atraves de handleAgendamentoCalendar.
  buscarOuCriarContato,
  buscarDealPorContato,
  aplicarViradaCobranca,
  atualizarNegocioMoskit,
  garantirDealExiste,
  importarContatosMoskit,
  // Gate do caso descrito e autoria de campos: funcoes puras (ou so-banco) exercitadas direto em
  // test-pipeline.js, porque processarConversaDirect depende da OpenAI e nao roda nos testes.
  aplicarGateCasoDescrito,
  aplicarPadroesDeterministicosDeOrigem,
  detectarRespostaPerguntaOrigem,
  deveEsperarCasoDescrito,
  deveEsperarCamposObrigatorios,
  sanitizarClassificacao,
  mesclarParaCrm,
  // Exportada para avaliar-extracao.js: e ela que define o portao do briefing (`pendentes.length === 0`
  // no ramo atualizar_campos), entao medir quantos resumos sao produzidos e descartados exige a MESMA
  // funcao. Espelhar a lista de campos obrigatorios no script faria as duas divergirem em silencio.
  camposPendentes,
  // Exportados para auditar-crm-relatar.js pelo MESMO motivo de camposPendentes: o relatorio precisa
  // dizer "este deal esta sem campo obrigatorio" e "este titulo e generico" usando a definicao da
  // PRODUCAO, nao uma copia. Uma lista espelhada no script divergiria em silencio no dia em que
  // alguem acrescentasse um campo obrigatorio aqui — e o relatorio continuaria dando tudo certo.
  CAMPOS_OBRIGATORIOS,
  ASSUNTO_NEUTRO,
  ehAssuntoNeutro,
  // Exportada em 03/09/2026 pro script de correção de nome genérico (PLANO-CORRECAO-QUALIDADE-DEALS.md,
  // Fase 3): antes de renomear um deal com o assunto salvo em last_data, precisa confirmar que esse
  // assunto NÃO é ele mesmo o nome de uma área — a auditoria não checa isso (só vê "existe algo em
  // last_data.assunto"), e usar uma cópia da regra aqui divergiria da produção no dia em que a lista de
  // áreas mudasse.
  rejeitarAssuntoQueEhArea,
  removerAcentos,
  // Paginador generico de subcolecao do deal (/notes, /attachments): ?start=, pagina de 10, `limit`
  // ignorado, e LANCA ao bater no teto de paginas em vez de devolver "nao achei" — a distincao entre
  // "nao existe" e "nao terminei de procurar" leva a acoes opostas.
  acharEmColecaoDoDeal,
  // Consumo de tokens acumulado, para medir custo por conversa sem estimar por caractere.
  lerUsoIA,
  zerarUsoIA,
  derivarAdvogadoDaArea,
  detectarOpcoesInvalidas,
  registrarOpcoesInvalidas,
  registrarBriefing,
  filtrarCamposPorAutoria,
  reconciliarClassificacao,
  reconciliarVinculoAtividades,
  reconciliarPendenciasAgendamento,
  refrescarBriefingsPertoDaConsulta,
  garantirVinculoAtividadeDeal, // religar-atividade.js (script manual) religa e limpa o estado terminal
  buscarIdOpcao,
  handleAgendamentoCalendar,
  // Exportadas para teste: a data-ancora em texto do escritorio (nao em ISO) e o que impede o modelo
  // de copiar a hora da ultima mensagem como horario da consulta, e a formatacao naive-como-UTC de
  // somarMinutosNaive nunca teve teste direto — a virada de dia (23:30 + 60min) passava no escuro.
  descreverAncora,
  somarMinutosNaive,
  formatarHorarioEscritorio,
  // Exportada para teste: a paginacao por pageToken (e NAO por ?page=) e o tipo de detalhe que passa
  // despercebido — o codigo antigo "paginava" e lia sempre os mesmos 10 registros sem erro nenhum.
  listarAtividadesMoskit,
  // Exportada para teste: e a rotina que decide se uma atividade criada direto no Moskit ganha o
  // sufixo #dealId/marcador [deal:...] no evento do Google (ver comSufixoDealId/comMarcadorDeal).
  sincronizarAtividadesMoskit,
  comSufixoDealId,
  comMarcadorDeal,
  finalizarCiclo,
  moverParaEstagio,
  moverEstagioSeAvancar,
  criarNotaMoskit,
  fecharNegocioSeAplicavel,
  // Exportados para teste da transcricao de audio (test-transcricao.js): atualizarTranscricaoNaConversa
  // e uma operacao de banco pura, e processarAudioCliente aceita `transcreve` injetado.
  atualizarTranscricaoNaConversa,
  processarAudioCliente,
  // Exportado para teste de rota: com WORKER_MODE=1 o modulo carrega SEM subir servidor, sem ngrok,
  // sem os timers de sincronizacao e sem reprocessar as conversas pendentes. O teste chama
  // app.listen() por conta propria e exercita so o HTTP.
  app,
  // Notas de reuniao (Gemini -> nota no negocio). Exportados para o script de religar orfao e para
  // inspecao manual — nao ha teste automatico que os chame, porque todos falam com a rede.
  sincronizarNotasReuniao,
  processarNotaReuniao,
  notaComMarcadorExiste,
  registrarFalhaNota,
  conferirSilencioNotas,
  stmtsNotas,
  getGoogleAuthClientNotas,
  // Anexo do Doc na aba "Arquivos". Exportados para as regressoes de test-pipeline.js: o bracket e a
  // deduplicacao por nome sao o que impede uma segunda copia da transcricao no prontuario do cliente.
  anexarDocNoDeal,
  anexoComNomeExiste,
  retomarAnexosPendentes,
  limparAnexosExpirados,
};
