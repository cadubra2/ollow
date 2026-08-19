# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bot WhatsApp (via [Zernio](https://zernio.com)) → OpenAI → Moskit CRM, para o escritório de advocacia
Caballero, Rocha & Carvalho. Recebe mensagens de WhatsApp, usa a OpenAI para qualificar o lead e
extrair dados do atendimento, cadastra/atualiza o negócio no Moskit CRM, e agenda a consulta no
Google Calendar (com link do Meet) quando cliente e equipe confirmam o mesmo horário.

**A documentação de processo (POP) é a fonte da verdade sobre o fluxo de negócio**, não o código —
consulte antes de mudar comportamento de negócio: `docs/pop/fluxo-bot-whatsapp-moskit.html` ou o PDF
`docs/pop/Fluxo - Bot WhatsApp e CRM Moskit v1.2.pdf`.

## Commands

```bash
npm install
npm start                # roda o servidor (node index.js), porta padrão 3000
npm test                 # suíte determinística sem rede — roda em qualquer ambiente/CI
npm run test:ia          # chama a OpenAI de verdade (test-dupla-confirmacao.js) — custa créditos
node test-telefone.js    # roda um arquivo de teste isolado (mesmo padrão para os demais test-*.js)
```

`npm test` roda `rodar-testes.js`, que executa em sequência (parando no primeiro que falhar):
`test-telefone.js`, `test-moskit-ids.js`, `test-atividade-moskit.js`, `test-evidencia.js`,
`test-fila.js`, `test-payload.js`, `test-rotas.js`, `test-pipeline.js`, `test-agenda-dry-run.js`,
`test-guards-internos.js`, `test-agendamento-bloco-mensagens.js`, `test-transcricao.js`,
`test-zapsign.js`, `test-notas-reuniao.js`. Todos usam `DB_PATH` apontando para um arquivo inexistente (banco descartável) —
**nunca** deixe um teste abrir `conversations.db` de produção.

**A suíte roda com `TZ=UTC`, o fuso da VPS** — é isso que o `rodar-testes.js` existe para garantir.
Antes ela rodava no fuso de quem executava, que na máquina de dev é `America/Fortaleza`, o *mesmo* do
escritório: todo bug de fuso passava batido porque o relógio do teste e o relógio esperado eram o
mesmo. Para investigar um caso específico, `TZ_TESTES=America/Fortaleza npm test` troca o fuso; rodar
um arquivo isolado (`node test-pipeline.js`) usa o fuso do sistema, então prefira o `npm test` antes
de commitar. A suíte passa em UTC, `America/Fortaleza`, `Asia/Tokyo`, `America/Los_Angeles` e
`Pacific/Kiritimati` — se um teste novo só passa num fuso, ele encontrou um bug de verdade.

### Scripts manuais — NUNCA rodar automaticamente/em CI

Escrevem em dados reais de produção (Moskit e/ou banco real):

- `test-moskit-put.js <dealId> [--aplicar]` e `test-moskit-real.js` — chamadas de escrita reais na
  API de produção do Moskit (criam/movem deals de verdade).
- `testar-briefing-unico.js` — idem, cria contato/deal reais no Moskit.
- `test-zapsign-real.js <email> [--aplicar]` — cria um documento REAL no ZapSign a partir do
  template de produção e dispara um e-mail de assinatura de verdade para o e-mail informado.
- `test-moskit-atividade-real.js <dealId> [--aplicar] [--manter]` — mede o contrato de `/activities`
  contra a API real. Sem `--aplicar` é só leitura (amostra real + o payload que seria enviado); com
  `--aplicar` varre rota × variante de payload até uma ser aceita, cria a atividade DE VERDADE na
  agenda do CRM, mede qual padrão de `PUT` move o `dueDate` e apaga a atividade no fim (`--manter`
  desliga a limpeza). É o script que valida a conversão de fuso antes de mexer no agendamento.
- `test-moskit-anexo-real.js <dealId> [--aplicar] [--url=...] [--subir-tunel] [--manter]` — mede o
  contrato de `/deals/{id}/attachments` e, principalmente, **se o PDF atravessa o túnel intacto até o
  Moskit**. Sem `--aplicar` é só leitura. Com `--aplicar` cria um anexo REAL num deal de teste,
  compara `size`/`mimeType`/primeiros bytes com o PDF original, tenta também um POST multipart (não
  documentado) e apaga tudo no fim. **`--subir-tunel` é explícito e não é o padrão**: no plano
  gratuito o ngrok aceita UMA sessão por conta, então subir um túnel aqui pode derrubar o de produção
  e o bot para de receber webhook do WhatsApp — sem erro nenhum neste script. Prefira `--url=` com um
  PDF já servido publicamente.
- `test-dedupe-agenda-real.js [--aplicar]` — prova, contra o Moskit e o Google reais, que a consulta
  não entra duas vezes na agenda: roda `POST /sincronizar-atividades` duas vezes, com e sem a linha
  em `atividades_sincronizadas`. Sem `--aplicar` é só leitura. Com `--aplicar` cria uma atividade e
  um evento de teste e apaga os dois no fim. Seguro por construção (`WORKER_MODE=1` carrega o
  `index.js` sem servidor e sem os `setInterval`, `DB_PATH` descartável, Telegram desligado, e toda
  atividade futura de cliente real entra pré-marcada para não virar evento) — mas ainda assim
  escreve em produção, então não é `npm test`.
- `GET /auditoria-classificacao?aplicar=1` — escreve nos deals reais (corrige a classificação). Em
  dry-run (sem `aplicar`) é só leitura e pode rodar à vontade.
- `varrer-agenda-horarios.js [inicio] [fim]` — varre o Google Agenda, as atividades do Moskit e o
  `conversations.db` de produção em busca de consulta em horário errado. **Só leitura, sem `--aplicar`
  nenhum** (nada foi deixado atrás de um `if`), mas lê três produções ao mesmo tempo, então fica fora
  do `npm test`. Diferente de `GET /auditoria-agenda`, que parte do banco, este parte da AGENDA — vê o
  que foi marcado direto no CRM ou na mão, inclusive evento que o banco não conhece (foi assim que
  apareceram dois casos de horário errado que a rota não enxergava). Para ler o banco de produção de
  dentro de um worktree, passe `CONVERSATIONS_DB=/caminho/conversations.db`.
- `replay-dupla-confirmacao.js [dealId...]` — replay de conversa REAL contra a OpenAI (custa créditos),
  para descobrir por que uma perna da dupla confirmação se perdeu. Mostra as observações que o modelo
  emitiu, o que foi descartado e por quê, e dá o veredito: regra de prompt, validação, ou horário
  recusado pela rede determinística (que é o comportamento correto). Só leitura — abre o banco de
  produção num handle readonly e usa `DB_PATH` descartável para o boot do `index.js`. Foi ele que
  revelou os dois defeitos descritos em "O eco da data-âncora" e "Propagação de dia corrigido".
- `test-cenarios-classificacao.js` e `test-simulacao.js` — chamam a OpenAI de verdade mas não têm
  asserção automática de pass/fail; servem para inspeção manual, não regressão.
- `sondar-notas.js [dealId]` — mede, contra as APIs reais, os contratos que a rotina de notas de
  reunião assume: se `GET /deals/{id}/notes` devolve o texto (e como pagina), se `events.list` traz
  `attachments[]` pela credencial do bot, e qual a cobertura real do passo "Telefone:" da cascata.
  **Só leitura**, mas lê Moskit e Google de produção, então fica fora do `npm test`.
- `reprocessar-nota-reuniao.js <gmailMessageId> <dealId> [--aplicar]` — religa à mão uma nota de
  reunião que ficou órfã (o id vem no aviso do Telegram). Sem `--aplicar` só imprime a nota que
  iria; com `--aplicar` **escreve no CRM**.
- `religar-atividade.js <dealId> <atividadeId> [--aplicar]` — religa à mão uma Atividade do Moskit que
  ficou sem vínculo com o negócio e **limpa o estado terminal** (`vinculo_desistiu`) que a
  reconciliação deixou depois de desistir. O comando exato vem no aviso final do Telegram. Sem
  `--aplicar` só imprime o vínculo atual e o PUT que seria enviado; com `--aplicar` **escreve no
  CRM** (GET + PUT com o corpo do GET inteiro, `deals` corrigido) e zera o estado no banco para a
  rotina voltar a vigiar.
- `autorizar-google-notas.js` — OAuth interativo do Gmail/Drive para a rotina de notas (roda uma
  vez, porta 8092). Grava `google-oauth-token-notas.json`.
- `corrigir-*.js` — scripts pontuais de correção de dados já aplicados (histórico, não reexecutar).

### Gerar segredos

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Usado para `ADMIN_TOKEN`, `WEBHOOK_SECRET` e `DEPLOY_WEBHOOK_SECRET`.

## Architecture

Aplicação Express monolítica: **`index.js` (~6600 linhas) contém o servidor, todas as rotas e todo o
pipeline de negócio.** Não há camadas separadas de controller/service — funções são declaradas de
cima a baixo no mesmo arquivo e chamadas diretamente. Ao navegar o código, procure por nome de função
em vez de esperar uma estrutura de diretórios.

```
index.js                servidor Express: webhook, rotas administrativas, todo o pipeline
worker.js                processa a fila de conversas pendentes; roda como processo FILHO de index.js
                         (faz require('./index.js') e chama bot.processarConversaDirect)
processar_pendentes.js   reprocessamento manual de conversas presas
autorizar-google.js      gera google-oauth-token.json (rodar uma vez, interativo)
deploy.js                git pull + npm install + npm test + pm2 restart; disparado por POST
                         /deploy-webhook a cada push (processo filho DESACOPLADO — sobrevive ao
                         restart que ele mesmo provoca no processo que o gerou)
src/
  agendamento.js         dupla confirmação de horário (cliente + equipe precisam confirmar o mesmo slot)
  atividade-moskit.js    payload da Atividade (a consulta na agenda do CRM) + conversão do horário
                         naive do escritório para o instante absoluto que o Moskit espera
  bloco-condicoes.js     detecção do bloco de condições de pagamento enviado pela equipe
  evidencia.js           validação das observações extraídas pela IA
  fila.js                fila de retry em disco para o worker (MAX_TENTATIVAS, depois desiste e avisa Telegram)
  mensagens.js           deduplicação e ordenação cronológica de mensagens do WhatsApp
  moskit-ids.js          TODOS os IDs/campos do Moskit — fonte única, ver abaixo
  briefing.js            texto da nota de briefing pré-consulta (cabeçalho determinístico + hash)
  notas-reuniao.js       notas do Gemini → nota no negócio: parse do assunto, cascata que escolhe o
                         deal, filtro de ancoragem sobre a saída da IA, texto da nota, nome do anexo
                         (tudo sem rede)
  telefone.js            normalização de telefone e detecção de números internos (equipe)
  transcricao.js         transcrição de áudios do cliente via OpenAI (contrato: nunca lança)
  zapsign.js             contrato de prestação de serviço: campos do template, valor por extenso,
                         criação do documento e leitura do webhook de assinatura
docs/pop/                POP oficial do processo de negócio (HTML + PDF) — fonte da verdade
```

### Classificação do deal: como o erro é evitado e como é corrigido

Área do direito / responsável / assunto / origem foram a maior fonte de dado errado no CRM (deal
48423360 entrou como LGPD sendo Direito Administrativo). Cinco camadas, todas em `index.js` salvo nota:

1. **Evidência**: `aplicarGateCasoDescrito` só deixa área/advogado/assunto irem ao CRM se houver
   observação validada `cliente_descreveu_caso`/`equipe_descreveu_caso` ([src/evidencia.js](src/evidencia.js)).
   Sem caso descrito o lead nem vira deal (`deveEsperarCasoDescrito`), exceto com dupla confirmação
   de horário ou bloco de condições enviado.
2. **Merge sanitizado**: `mesclarParaCrm` aplica o gate ao objeto **mesclado** com `last_data` — sem
   isso um palpite antigo era ressuscitado e reenviado a cada ciclo.
3. **Regra de negócio em código**: `derivarAdvogadoDaArea` + `MOSKIT_IDS.ADVOGADO_POR_AREA_ID` — a
   área define o responsável, e `montarPayloadMoskit` reaplica isso em **todo** caminho de escrita.
4. **Correspondência exata**: `MOSKIT_IDS.buscarOpcao` (usado por `buscarIdOpcao` e por todos os
   scripts) só aceita chave canônica ou apelido declarado. Valor fora da lista deixa o campo vazio e
   gera nota + Telegram (`detectarOpcoesInvalidas`/`registrarOpcoesInvalidas`), nunca um chute.
5. **Reconciliação**: `reconciliarClassificacao` compara CRM x decisão do bot e corrige o que o
   próprio bot escreveu; roda a cada `RECONCILIACAO_INTERVAL_MS` (padrão 30 min) e sob demanda em
   `GET /auditoria-classificacao` (dry-run; `?aplicar=1`, `?incluir-legado=1`).

**Autoria**: `custom_fields_bot`/`campos_travados` guardam o que o bot escreveu (inclusive o nome do
deal, chave `__name`). Valor divergente disso = correção humana → campo travado para sempre, com nota.

### `src/moskit-ids.js` é a fonte única de verdade para IDs do Moskit

Antes esses mapas (origem, área do direito, tipo de consulta, lost reasons, stage IDs...) estavam
duplicados em seis arquivos diferentes e já tinham divergido silenciosamente, causando classificação
errada de deals reais. **Nenhum ID do Moskit deve ser escrito em nenhum outro arquivo** — sempre
importe de `src/moskit-ids.js`. Se uma opção mudar no CRM, o ajuste é só aqui.

### SQLite (better-sqlite3), schema em `index.js`

Tabelas: `conversations` (uma linha por chat/telefone, mensagens em JSON na coluna `messages`),
`moskit_contacts` (cache de contato por telefone), `comprovantes` (recibos de pagamento verificados
por IA de visão), `atividades_sincronizadas` (dedupe de sync de atividades do Moskit → Calendar).

- `conversations.agendamento_apuracao` (JSON) guarda a última decisão de dupla confirmação: as
  observações de horário validadas, as duas pernas escolhidas e o motivo quando não fechou. Existe
  porque essa decisão só vivia num `console.log` — quando o cliente do deal 47543238 esperou sozinho na
  sala e o do 48226006 ficou com a reunião no dia velho, não havia como saber, depois do fato, se a
  perna do cliente não foi emitida pelo modelo ou se foi descartada na validação, e as duas hipóteses
  levam a correções opostas. É o **estado atual**, uma linha por conversa, não histórico.

- `DB_PATH` (env var) sobrepõe o caminho padrão `conversations.db` — **testes sempre devem setar
  isso** para um arquivo inexistente; senão o `require('./index.js')` do teste abre o banco de
  produção e roda `ALTER TABLE`/writes nele.
- Colunas novas são adicionadas via `ALTER TABLE ... ADD COLUMN` dentro de `try {} catch {}` no
  boot — não há migrations versionadas, é tudo idempotente e cumulativo no topo de `index.js`.

### Pipeline de uma mensagem (visão geral, ver POP para o fluxo de negócio completo)

1. `POST /webhook` (Zernio) → `tratarWebhook` → `processarMensagemRecebida`: valida assinatura HMAC,
   filtra números internos (`ehInterno`/`TEAM_PHONES`), grava mensagem no SQLite, agenda
   processamento após inatividade (`agendarProcessamento`, padrão 5 min).
2. Áudio do cliente (incoming): vira placeholder `📎 [cliente enviou um audio]` na hora; depois
   `processarAudioCliente` baixa o anexo (`baixarAnexoAudio`, pasta `comprovantes/<phone>/`),
   transcreve via `src/transcricao.js` (OpenAI, `gpt-4o-mini-transcribe`) e substitui o placeholder
   por `🎧 Transcrição do áudio: ...` (`atualizarTranscricaoNaConversa`). Falha em qualquer etapa
   mantém o placeholder — nunca trava a conversa. Só áudio incoming é transcrito (áudio da equipe
   não). O polling (`sincronizarConversas`) é a rede de segurança: transcria áudios que o webhook
   perdeu.
2. `processarConversaDirect(chatId)`: monta histórico, chama a OpenAI (`classificarConversa` +
   `extrairDadosAtendimento`) para extrair dados estruturados, decide criar/atualizar deal no
   Moskit (`buscarOuCriarContato`, `criarNegocioMoskit`/`atualizarNegocioMoskit`).
   **Gate do caso descrito** (`aplicarGateCasoDescrito`/`deveEsperarCasoDescrito`): `area_direito`,
   `advogado_responsavel` e `assunto` só vão pro CRM se houver observação validada
   `cliente_descreveu_caso`/`equipe_descreveu_caso`; sem ela o lead nem vira deal (exceto se já
   houver dupla confirmação de horário ou bloco de condições enviado). Sem esse gate a IA deduzia a
   área do sócio que o lead mencionou — "consulta com o Dr. Berto" virava LGPD.
3. Agendamento: `apurarDuplaConfirmacao` (cliente E equipe confirmam o mesmo horário) →
   `handleAgendamentoCalendar` → `criarEventoGoogleCalendar` (OAuth2, precisa de conta Google real
   do escritório — service account não gera link de Meet nem convida participantes) e
   `registrarConsultaNaAgendaMoskit` → `criarAtividadeMoskit` (ver "As duas agendas" abaixo).
4. Progressão de funil (`moverEstagioSeAvancar`) e fechamento (`fecharNegocioSeAplicavel`) são
   guardados por flags `FUNIL_DRY_RUN`/`FUNIL_FECHAMENTO_DRY_RUN` — comece sempre com dry-run
   ligado (padrão) até validar as sugestões da IA na prática.
5. Se qualquer etapa falhar, a conversa cai na fila (`src/fila.js`) e é reprocessada pelo
   `worker.js`, que é lançado como processo filho do próprio `index.js`.

### As duas agendas: Google Agenda e agenda do Moskit

Toda consulta agendada existe em **dois** lugares, e os dois caminhos se cruzam — é aqui que nasce o
risco de evento duplicado.

- **Bot → as duas agendas.** Fechada a dupla confirmação, `handleAgendamentoCalendar` cria o evento
  no Google (`criarEventoGoogleCalendar`) e a Atividade no Moskit
  (`registrarConsultaNaAgendaMoskit` → `criarAtividadeMoskit`), guardando o id em
  `conversations.atividade_moskit_id`. Remarcação move as duas (`atualizarEventoSeRemarcado` +
  `atualizarAtividadeMoskit`).
- **Moskit → Google.** `sincronizarAtividadesMoskit` (a cada `SYNC_INTERVAL_MS`) cria evento no
  Google para atividades marcadas direto no CRM ou pelo Moskit Boost, que nunca passaram por
  conversa nenhuma.
- **A trava.** Logo após criar a Atividade, o bot grava a linha em `atividades_sincronizadas`
  apontando para o evento que ele mesmo acabou de criar. Sem isso, a sincronização acima veria a
  atividade nova como "ainda não sincronizada" e criaria um **segundo** evento no Google para a mesma
  consulta minutos depois. Se mexer nesse trecho, `test-pipeline.js` tem a regressão.
- **`PUT /activities/{id}` exige o corpo do `GET`.** Medido em 12/08/2026 contra a API real: um
  payload mínimo `{dueDate}` volta **422** — mesma peculiaridade do `PUT` de deal. `POST /activities`,
  ao contrário, aceita o payload construído normalmente. Sem o `GET` prévio em
  `atualizarAtividadeMoskit`, nenhuma remarcação chegaria à agenda do CRM.
- **Fuso.** O pipeline inteiro usa horário *naive* (`"2026-08-05T17:30:00"`), que significa sempre
  hora local do escritório. O Google aceita isso com `timeZone` ao lado; o Moskit **não** — `dueDate`
  é instante absoluto. A conversão é `horarioNaiveParaInstante` (`src/atividade-moskit.js`), que
  pergunta o offset ao `Intl` em vez de fixar `-03:00`. Errar aqui não quebra nada: só põe a consulta
  três horas fora do lugar na agenda, em silêncio.
- **O eco da data-âncora, e por que o horário é validado em código.** O maior defeito de horário
  medido em produção (13/08/2026) não era fuso: era o modelo **copiar a data-âncora**. O prompt
  entregava `- Data/hora da ultima mensagem desta conversa: 2026-08-10T18:54:58.000Z`, e quando o
  modelo não conseguia derivar o horário da conversa, devolvia essa string como horário da consulta.
  De 32 conversas com horário registrado, 5 (16%) gravaram o timestamp de uma mensagem, e 3 viraram
  reunião real na agenda (deals 48370184, 48407621, 48177138 — uma delas às 15:54:58). Duas defesas:
  `descreverAncora` (`index.js`) manda a âncora em **texto do escritório** (`"10/08/2026
  (segunda-feira), 15:54"`), que não se parece com o formato de saída, e `motivoHorarioImplausivel`
  (`src/evidencia.js`) recusa em código todo horário com `Z`/offset/milissegundos, com segundos ≠ `00`,
  igual ao horário de envio da última mensagem, fora da janela `HORA_MIN_ATENDIMENTO`–
  `HORA_MAX_ATENDIMENTO`, ou mais de 7 dias antes da âncora. O motivo é **nomeado** porque vai pra nota
  no deal e pro Telegram. Regressões em `test-evidencia.js`.
  **A checagem do eco roda no valor CRU, antes de `corrigirDataRelativa`** (`ehEcoDaAncora`): a correção
  de dia relativo reescreve a data e faria um timestamp copiado deixar de parecer com a âncora. Medido
  no replay do deal 47543238, onde o modelo devolveu `17:11:00` (a hora de envio da última mensagem) nas
  três observações e uma delas escapava por citar "amanhã". Eco não se corrige, se descarta. E o
  *relógio* da âncora em qualquer dia já conta como eco: consulta cair exatamente no minuto da última
  mensagem é 1 em 1440, o eco produz isso sempre.
- **Propagação de dia corrigido não anda pra trás.** `validarObservacoes` propaga a correção de dia
  para observações que citam o mesmo horário bruto sem repetir "amanhã" (a confirmação "Perfeito, está
  agendado!"). Só que **"mesmo valor bruto = mesmo compromisso" não vale quando o valor bruto é lixo** —
  aí todas as observações têm o mesmo valor e o sinal não quer dizer nada. No deal 47543238 a
  confirmação da equipe de **03/08** (o aceite da remarcação) herdava o 29/07 corrigido de uma proposta
  de 28/07; a apuração fechava no horário **antigo**, igual ao que já estava no Google, então a
  remarcação para 04/08 nunca acontecia — e o cliente esperou sozinho na sala. Agora a propagação é
  recusada quando colocaria a consulta antes do dia da mensagem que a afirma, e o caso vira pendência
  com aviso. Os dois lados têm regressão em `test-evidencia.js` (o bloqueio e a propagação legítima do
  deal 48346871).
- **Nenhuma falha de agendamento em silêncio.** Se a dupla confirmação aconteceu e o evento não
  existe, isso **sempre** vira nota no deal + Telegram (`registrarErroAgendamento`). Antes,
  `criarEventoGoogleCalendar` devolvia `null` e o chamador fazia `if (!evento) return`: o horário
  inválido era descartado e ninguém no escritório sabia que a consulta combinada não tinha ido pra
  agenda — o sintoma deixou de ser "reunião no horário errado" e passou a ser "reunião que ninguém
  marcou e ninguém soube", repetindo a cada 5 min só no console. Por isso a função **lança** em vez de
  devolver `null`. `registrarAgendamentoPendente` também avisa no Telegram, mas só no que é acionável
  (remarcação travada ou horário recusado pela validação) — pendência de rotina viraria ruído diário.
- **Dia relativo.** `corrigirDataRelativa` (`src/evidencia.js`) confere em código o dia que o modelo
  resolveu, contra o timestamp da **própria mensagem** citada: `hoje`/`amanhã`/`depois de amanhã` e
  também dia da semana pelo nome (`"na sexta"`, `"quarta-feira"`). No dia da semana a correção é
  conservadora de propósito: se o dia que o modelo escolheu já cai no dia da semana citado, a **semana**
  dele é respeitada ("sexta" e "sexta que vem" são as duas sextas, e a conversa pode ter dito qual com
  palavras que o código não lê). Cuidado ao mexer: em português o nome do dia também é ordinal, e
  `"segunda via"` já foi lido como segunda-feira (tem teste).
- **Atividade criada sem vínculo com o negócio.** MEDIDO em 14/08/2026 nos deals 48474073 e 48464876:
  o `POST /activities` com `deals: [{id: dealId}]` volta 2xx com `id` (passa como sucesso em
  `criarAtividadeMoskit`), mas quando o negócio tinha acabado de ser criado/escrito quase ao MESMO
  tempo (segundos a poucas horas antes), o Moskit às vezes não persiste esse vínculo — a atividade
  fica só ligada ao contato, some da tela do negócio, e o aviso "nenhuma atividade agendada" aparece
  mesmo com a consulta marcada.   `garantirVinculoAtividadeDeal` (`index.js`) confere logo após criar
  (GET + PUT com `deals` corrigido, mesmo padrão de `atualizarAtividadeMoskit`) e
  `reconciliarVinculoAtividades`/`rodarReconciliacaoVinculoAtividades` rodam na mesma cadência de
  `RECONCILIACAO_INTERVAL_MS` como rede de segurança para o que escapar da conferência imediata.
  **A reconciliação desiste — e avisa uma única vez.** MEDIDO 14-17/08/2026 em 6 negócios
  (48287898, 48292471, 48441223, 48447661, 48464876, 48474073): o Moskit responde 429/timeout de 30s
  quando a varredura bate forte, e a rotina antiga retentava a cada 30 min SEM religar nada, inundando
  o Telegram com o mesmo aviso (o dedup por string do resumo não segurava porque o subconjunto de
  falhas mudava a cada rodada). Agora cada linha tem estado próprio em `conversations`
  (`vinculo_falhas`, `vinculo_backoff_ate`, `vinculo_desistiu`, `vinculo_aviso_hash`): falha entra em
  cooldown exponencial (o dobro de ciclos a cada tentativa, sem chamar rede durante ele) e é
  **silenciosa** — 429/timeout não é "conferir na mão", é o Moskit dizendo calma; ao estourar
  `VINCULO_MAX_TENTATIVAS` (padrão 3) a linha desiste (estado terminal, nunca mais retenta sozinha) e
  recebe UM aviso final no Telegram com o comando exato. O aviso é deduplicado por
  `vinculo_aviso_hash` (por linha, não por resumo), e o estado terminal só é desfeito por
  `religar-atividade.js`. As três reconciliações também são escalonadas no boot (0/5/10 min) para não
  triplicar o burst de GETs no mesmo instante. Regressões em `test-pipeline.js`.
- **Remarcação tem que mover a Atividade também, mesmo quando ela acabou de nascer no mesmo ciclo.**
  `handleAgendamentoCalendar` recebe `row` como um snapshot lido ANTES do ciclo. Quando o ramo "evento
  já existia" roda a auto-cura (cria a Atividade que faltava) e, na MESMA rodada, a dupla confirmação
  também remarca o horário, `atualizarEventoSeRemarcado` — chamado logo em seguida com o mesmo `row`
  — não enxergava o `atividade_moskit_id` que acabou de ser gravado no banco (o objeto em memória
  continuava com o valor antigo, nulo), então nunca movia o `dueDate` da Atividade recém-criada: ela
  ficava presa no horário velho enquanto o Google Agenda já ia para o novo. Por isso, logo após a
  auto-cura criar a Atividade, o código relê `atividade_moskit_id` do banco e atualiza o `row` em
  memória antes de chamar `atualizarEventoSeRemarcado`. Regressão em `test-pipeline.js` (o cenário
  que cria E remarca no mesmo ciclo).
- **Auditoria.** `GET /auditoria-agenda` (só leitura, atrás de `exigeAdmin`) cruza as três fontes de
  horário de cada consulta — `conversations.evento_calendar_data`, o evento no Google e a Atividade no
  Moskit — e lista divergências, incluindo esse caso de atividade sem vínculo com o negócio e a
  divergência de perna validada x banco (bullet abaixo). `?todas=1` inclui consulta passada. Separa
  `problemas` (a consulta pode estar no horário errado agora, ou a atividade não aparece pro negócio)
  de `observacoes` (contexto): um alerta que dispara em toda linha afoga justamente os casos que
  importam.
- **Remarcação perdida quando a equipe propõe horário 2x em sequência, e por que o aviso agora escala
  por PROXIMIDADE em vez de só por conteúdo.** MEDIDO em 14/08/2026 nos deals 48292471 (Lia) e 48287898
  (Solange): a equipe propôs um horário novo (a Lia, inclusive duas vezes em sequência rápida, com uma
  mensagem `[edit]` do WhatsApp entre as duas) e o cliente aceitou claramente — mas o modelo não gerou
  NENHUMA observação (`equipe_propos_horario`/`cliente_aceitou_horario`) para essas mensagens na
  rodada que rodou de verdade; só enxergou a confirmação antiga. `validarObservacoes`/
  `apurarDuplaConfirmacao` processaram corretamente o que receberam — o problema é que receberam menos
  do que deviam (falha de extração do modelo, não bug de validação). A dupla confirmação corretamente
  registrou a pendência (`motivo: falta_cliente`) e `registrarAgendamentoPendente` já manda Telegram
  incondicional quando `remarcacao=true` — mas o dedup por hash (que só olha `horario relatado|motivo`)
  não tinha como saber que a urgência estava crescendo: a reunião ficou horas presa no horário velho,
  perto da hora do cliente aparecer, sem nenhum aviso NOVO. `registrarAgendamentoPendente` agora recebe
  `row` e reforça em duas frentes: (1) **escalada por proximidade** — reenvia o Telegram mesmo com hash
  igual quando `evento_calendar_data` está dentro de `AGENDAMENTO_URGENCIA_HORAS` (padrão 48h), a
  garantia que não depende do modelo acertar nada; (2) **enriquecimento por conteúdo** — quando a perna
  validada (`apuracao.equipe/cliente.horario_iso`) diverge do que já está na agenda (padrão Solange,
  cuja equipe confirmou "18/08" com trecho limpo mas o banco seguia em "16/08"), cita os dois horários
  explicitamente e entra no hash de dedup. Camada extra (defesa teórica, não confirmada em incidente
  real): `handleAgendamentoCalendar` monta `dadosEvento` substituindo `data_hora_consulta` por
  `apuracao.horarioIso` quando a confirmação fecha — se ela fechar com um par velho mas autoconsistente
  (já igual ao banco), isso registra a divergência entre o que o modelo entendeu e o que a apuração
  manteve (`agendamento_divergencia_hash`), mesmo sem Telegram (não é incidente confirmado). Regressão
  em `test-pipeline.js` (proximidade, divergência de conteúdo e o dedup normal quando nenhum dos dois
  se aplica).
- **A escalada por proximidade só roda se a conversa for reprocessada — conversa muda nunca é.**
  MEDIDO em 14/08/2026 no deal 48466404 (Teresinha): ela propôs um dia AMBÍGUO ("quarta ou quinta,
  15:30?"), deixou a escolha pra equipe, a equipe escolheu 19/08 e avisou, ela **pagou** e até pediu o
  endereço do escritório — claramente acha que está confirmado. Mas a dupla confirmação nunca fechou
  (ela nunca reafirmou a data específica escolhida — aqui a ambiguidade é real, diferente do bullet
  acima) e a conversa parou de receber mensagem no dia seguinte. A escalada por proximidade de
  `registrarAgendamentoPendente` **só roda dentro de um ciclo de `handleAgendamentoCalendar`**, chamado
  só quando a conversa é reprocessada — e nada neste código reprocessa uma conversa só porque o tempo
  passou (só mensagem nova via webhook, ou `sincronizarConversas` achando `updatedTime` mais recente no
  Zernio). Uma varredura achou **17 negócios** com `agendamento_pendente_hash` gravado, vários parados
  há mais de uma semana. `reconciliarPendenciasAgendamento` (mesmo padrão de `reconciliarClassificacao`,
  `RECONCILIACAO_INTERVAL_MS`) é a rede de segurança: relê `agendamento_pendente_hash` direto do banco
  (formato `horario|motivo|...` desde a criação da função — não depende de `agendamento_apuracao`, que
  fica `NULL` em conversa que nunca rodou um ciclo completo desde que essa coluna existe), com janela
  própria e maior (`AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS`, padrão 7 dias — a única chance de avisar
  sobre conversa muda, então precisa de mais antecedência que a escalada de conversa ativa). Comprovante
  já verificado (`comprovantes.match=1`) pro deal escala **incondicionalmente**, mesmo com horário fora
  da janela — é sinal de compromisso real, não hipótese. NÃO chama a OpenAI. Dedup por linha, coluna
  nova `agendamento_pendencia_avisada` (guarda o hash já avisado, separada de
  `agendamento_pendente_hash`/`agendamento_erro_hash`, que têm ciclo de vida diferente).
- **Responsável.** A atividade sai no nome da Layla (`LAYLA_USER_ID`), como todo contato, deal e nota
  criados pelo bot. Não confundir com `advogado_responsavel`, que é campo personalizado do deal.
- **Botão de emergência.** `AGENDA_MOSKIT_DRY_RUN=true` desliga a escrita na agenda do CRM sem
  redeploy (o evento no Google continua sendo criado; o deal recebe uma nota `[dry-run]`). O padrão é
  o **inverso** de `FUNIL_DRY_RUN`: sem a variável, a agenda funciona. Aquelas flags seguram palpite
  de IA sobre funil; esta guarda uma regra determinística, então nasce ligada.

### Briefing pré-consulta: a nota "📋 Briefing · vN · data" no deal

O advogado abre o negócio no CRM minutos antes da consulta. Se a conversa parou no dia anterior, a
nota que ele lê não pode ser a da hora em que o cliente sumiu. `registrarBriefing` (`index.js`) posta
uma nota no deal com o estado atual da conversa, e o bot reprocessa de propósito antes do horário.

- **Trilha de notas nativa, não edição in place.** Cada mudança real posta uma nota NOVA com título
  versionado `📋 Briefing · v{n} · {dd/mm/aaaa hh:mm}` (data no fuso `TZ_ESCRITORIO`). A remarcação
  conta como mudança real. O histórico do Moskit é o histórico do briefing — não existe "última nota
  viva".
- **Texto composto em duas camadas** ([src/briefing.js](src/briefing.js), módulo puro sem rede):
  o **cabeçalho** é determinístico, montado em código (cliente, telefone, horário da consulta —
  esvazia o campo se não houver); a **narrativa** é o `resumo_atendimento` que a IA produz. A saída
  muda de formato sem depender de o modelo "aprender" o novo cabeçalho.
- **O resumo do prompt ganhou 6 seções** (`Caso` / `Objetivo` / `Urgencia·prazo` / `Ja tentou` /
  `Pendencias` / `Documentos citados`), com regra de ouro: campo que não apareceu na conversa sai
  "Nao mencionado.", nunca "—" vazio nem chute.
- **Hash sobre o texto final** (cabeçalho + narrativa, fora título/versão/data): valor novo,
  narrativa nova ou mudança de horário repostam; só a data do título passando para a frente não.
- **Aguardar mudança não basta.** O refresh da conversa depende de mensagem nova, e consulta marcada
  não gera mensagem. `refrescarBriefingsPertoDaConsulta` roda no intervalo de
  `RECONCILIACAO_INTERVAL_MS` (escalonado 15 min no boot) e reprocessa as conversas com consulta
  marcada nas próximas `BRIEFING_REFRESH_ANTECEDENCIA_HORAS` horas (padrão 4) — janela conservadora
  porque cada reprocessamento custa ~2 chamadas OpenAI. Dedup por linha com coluna
  `briefing_refresh_para` (o horário para o qual já refrescou): remarcação volta a processar. Teto de
  `BRIEFING_REFRESH_MAX_POR_CICLO` (padrão 5). `BRIEFING_REFRESH_ATIVO=false` desliga sem redeploy.
- **Migração.** Linhas com `briefing_added=1` e sem `briefing_hash` adotam o hash sem repostar (a
  nota já existe); linhas com hash do formato antigo (de 4 linhas) repostam naturalmente no próximo
  reprocessamento — virada de formato sem script de backfill.
- **`processar_pendentes.js` reposta no mesmo formato** (mesmo `src/briefing.js`), para a nota
  religada nunca sair com cara diferente da rotina.
- Regressões em `test-briefing.js` (módulo puro) e `test-pipeline.js` (call sites, versão, migração,
  refresh perto da consulta).

### Notas de reunião do Gemini → nota no negócio

O que acontece **dentro** da consulta não voltava para o CRM. `sincronizarNotasReuniao` (`index.js`,
a cada `NOTAS_SYNC_INTERVAL_MS`, padrão 10 min) lê os e-mails de notas do Gemini, descobre a que
negócio pertencem, extrai os dados jurídicos com a OpenAI e escreve uma nota no deal. A decisão fica
em [src/notas-reuniao.js](src/notas-reuniao.js) (puro, sem rede); o `index.js` só busca o que ela pede.

- **O e-mail é o gatilho; o evento da agenda é o enriquecimento.** Assunto real:
  `Notas: "Consulta — Lia 🇧🇷💛💚 (Berto)" de 14/08/2026`, de `gemini-notes@google.com`. O evento
  correspondente traz o Doc das notas em `attachments[].fileUrl` (campo estruturado, sem parsear
  HTML) e o telefone em `description` (`Telefone: 558681876734`), que é a chave de
  `conversations.chat_id` → `deal_id`. Desde que o número do negócio passou a viajar no título (ver
  abaixo), o evento deixou de ser indispensável para *identificar* — continua sendo o que traz o Doc.
  **Não confundir com `meetings-noreply@google.com`**, que manda
  `Problema com as notas: ...` quando o Gemini FALHA — esse e-mail não tem nota nenhuma dentro e
  viraria uma nota vazia no negócio do cliente.
- **O corpo do e-mail já traz o resumo inteiro**; o Doc só acrescenta a transcrição literal, e só
  existe se alguém a ligou na reunião. Por isso o corpo é obrigatório e o Doc é *best-effort*: falha
  no `drive.files.export` marca o rodapé e segue, nunca impede a nota.
- **Candidato único ou órfão, sem exceção.** Duas consultas às 15h com advogados diferentes fariam a
  nota do caso de um cliente cair no negócio de outro — dentro do CRM isso é vazamento de sigilo, e
  ninguém detecta lendo, porque a nota parece plausível no negócio errado. Quando um passo devolve
  DOIS candidatos a cascata **para ali** em vez de tentar o passo seguinte: dois resultados não
  significam "sinal fraco, tente outro", significam "este sinal aponta para dois negócios reais".
  O método usado vai **impresso no rodapé da nota** (`Vínculo: evento_telefone (confiança alta)`) —
  é o que permite descobrir qual regra corrigir quando uma nota aparecer no lugar errado.
- **O fallback não é caso raro.** MEDIDO em 16/08/2026 (`sondar-notas.js`): dos 6 eventos que geraram
  notas nos últimos 30 dias, 4 tinham `Telefone:` (criados pelo bot) e 2 não (`"Consulta online -
  Berto e Aurinete"`, `"Consulta online- Iury e Arthur"`, criados na mão). ~1/3 do volume depende do
  fallback e parte vai terminar em órfão mesmo — por isso o órfão é desfecho de primeira classe, com
  Telegram, diagnóstico do que a cascata viu e o comando `reprocessar-nota-reuniao.js` pronto.
- **Dois marcadores no evento, e o do TÍTULO é o que vale mais.** `montarResumoEvento` põe
  `· #48292471` no fim do título e `montarDescricaoEvento` põe `[deal:48292471]` na descrição. O do
  título é o mais valioso porque **o assunto do e-mail do Gemini reproduz o título entre aspas**
  (`Notas: "Consulta — Lia (Berto) · #48292471" de 14/08/2026`) — ou seja, o número chega dentro do
  próprio assunto e o bot identifica o negócio **sem precisar achar o evento na agenda**. Isso tira o
  Google Calendar do caminho crítico: evento apagado, renomeado, movido de calendário ou fora da
  janela de busca deixa de derrubar a identificação. Também é o único marcador que uma reunião criada
  na mão tende a ganhar, porque o título é onde as pessoas digitam.
- **O número é SUFIXO, nunca prefixo.** A rota que adiciona link do Meet reconhece consulta na agenda
  com `/^Consulta\s*—/.test(ev.summary)` — casamento por **início**. Com o número na frente ela
  simplesmente pararia de enxergar qualquer consulta, sem erro nenhum. Regressão explícita em
  `test-pipeline.js`.
- **`dealId` sempre por parâmetro, nos três call sites.** `sincronizarMetadadosEvento` **compara** o
  título e a descrição que monta com os que estão no Google para decidir se dá `patch`. Derivar o
  `dealId` de fontes diferentes na criação e na comparação faria toda rodada ver "mudou" e repatchar o
  evento para sempre. Ler do banco seria exatamente esse caso: `stmtFinalizarCiclo` só grava
  `conversations.deal_id` DEPOIS de `handleAgendamentoCalendar`, então na criação de um deal novo o
  banco ainda traz `null`. O terceiro call site é o título da Atividade do Moskit
  (`registrarConsultaNaAgendaMoskit`), e não é opcional: `test-pipeline.js` já afirma que ele é igual
  ao `summary` do evento — é o mesmo compromisso nas duas agendas.
- **Marcadores explícitos que discordam = órfão, com motivo próprio.** Se o título disser `#48111111`
  e a descrição `[deal:48222222]`, `decidirDeal` para antes da cascata e devolve
  `marcadores_divergentes`. Não há desempate honesto: é evento copiado de outro cliente com só um dos
  dois atualizado, e escolher qualquer um poria a nota do caso de um cliente no negócio de outro. O
  motivo é separado da ambiguidade comum porque o conserto é diferente — aqui alguém precisa arrumar o
  **evento**, não a regra, e o aviso do Telegram diz isso com todas as letras.
- **A extração do `#NNNNN` só olha título e assunto**, nunca o corpo do e-mail nem a transcrição
  (`RE_DEAL_TITULO`, mínimo de 5 dígitos). Em texto de fala corrida, `#` seguido de número é ruído
  provável — "o protocolo #99887766" numa transcrição não pode virar vínculo com um negócio.
- **Nota duplicada é pior que nota atrasada.** A última linha de toda nota é um marcador
  `[ollow-notas:xxxxxxxx]` derivado da origem. O POST fica entre dois commits (`POSTANDO` → POST →
  `POSTADA`): se o processo morrer no meio, a retomada **não reposta às cegas** — procura o marcador
  em `GET /deals/{id}/notes` e só posta se não achar. Não conseguindo conferir, vira `REVISAR_MANUAL`
  + Telegram. Medido em 16/08/2026: esse GET devolve `description` íntegra (sem truncagem), pagina
  por `?start=` e **ignora `limit`** (sempre 10 por página) — o deal da Lia já tinha 40 notas, então
  olhar só a primeira página responderia "não achei" para uma nota existente, que é exatamente o caso
  em que o código postaria a segunda. Bater no teto de páginas **lança**, nunca devolve "não achei".
- **`is:unread` não é a fila.** O seletor é a AUSÊNCIA dos rótulos `Notas/Processado`, `Notas/Orfao`
  e `Notas/Erro`. Se fosse "não lido", alguém abrindo o e-mail no celular faria o bot nunca mais ver
  aquela reunião — e nada avisaria. Os três rótulos são **criados no início de cada ciclo**, antes de
  montar a busca: a query é feita de `-label:"Notas/..."`, e um `-label:` de rótulo inexistente não
  tem comportamento garantido — se não casar nada, o primeiro ciclo volta vazio e a rotina parece
  funcionar sem fazer nada.
- **Nada reprocessa para sempre, e nada fica em silêncio.** Duas defesas que faltavam e que o
  `tentativas` da tabela sozinho não dava:
  - `registrarFalhaNota` **desiste** após `NOTAS_MAX_TENTATIVAS` (padrão 3, o mesmo de
    `src/fila.js` e pelo mesmo motivo: cada tentativa custa uma chamada de IA com o texto inteiro).
    Antes a coluna era incrementada e **nunca lida** — um e-mail com deal apagado voltava a cada 10
    min para sempre, pagando OpenAI, sem avisar ninguém. Ao desistir: estado terminal, rótulo
    `Notas/Erro` e Telegram com o comando de religar.
  - `conferirSilencioNotas` avisa após `NOTAS_SILENCIO_DIAS` (padrão 10) **sem nenhum e-mail novo**.
    Repare no que é medido: a última vez que a busca devolveu ALGUMA mensagem, gravada em
    `notas_reuniao_saude` — nunca "este ciclo veio vazio", que é o estado normal da maioria dos ciclos.
    Silêncio prolongado tem a mesma cara de "não houve reunião", "o token morreu" e "o Google mudou o
    formato do assunto".
- **Estado terminal nunca é reprocessado — é a trava contra nota duplicada.** O rótulo do Gmail é
  aplicado DEPOIS de o estado virar terminal, e o `messages.list` do mesmo ciclo roda logo em seguida.
  Se o índice de busca do Gmail atrasar, ou se a retomada falhar antes de conseguir rotular, a mesma
  mensagem volta na lista — e os dois `if` de retomada de `processarNotaReuniao` não casam mais (o
  estado deixou de ser `POSTANDO`), então ela seria reprocessada do zero: nova chamada de OpenAI e uma
  **segunda nota** no prontuário do cliente. O marcador não cobre isso, porque só é consultado dentro
  do ramo `POSTANDO`. Por isso a guarda de `ESTADOS_TERMINAIS` é a primeira coisa da função.
  `dealIdForcado` atravessa de propósito (é o único jeito de ressuscitar um órfão) — menos em
  `CONCLUIDO`, onde religar **lança**, porque só criaria a segunda nota.
- **`ambiguo` não é "o POST falhou".** Só a *retomada* de um `POSTANDO` que não conseguiu descobrir se
  a nota já existe escala direto para `REVISAR_MANUAL`. Um POST que falha deixa o estado em `POSTANDO`
  e o ciclo seguinte reconcilia sozinho pelo marcador — inferir a ambiguidade do estado faria uma
  queda de rede comum virar trabalho manual à toa.
- **Doc duplicado é barrado em QUALQUER estado da primeira cópia**, não só em `CONCLUIDO`. O índice
  único em `doc_id` é o que impede a segunda nota; sem cobrir os outros estados, um reenvio cuja
  primeira cópia virou órfã batia na constraint, lançava, e o e-mail voltava a cada ciclo para sempre.
  A cópia canônica continua sendo a primeira, e é lá que o religamento manual acontece.
- **Nenhum sinal de identidade sai do corpo nem da transcrição.** `#NNNNN` só de título e assunto;
  `ID NNNNN` só do assunto. O corpo é o resumo que o Gemini escreveu **a partir da fala** — "o ID
  12345678 do processo administrativo", um número que o cliente leu em voz alta, viraria vínculo de
  confiança *alta* com um negócio qualquer. A transcrição nem chega em `extrairSinais`: não existe
  parâmetro para ela, e há teste garantindo que continue assim.
- **Filtro de ancoragem sobre a saída da IA** (`validarExtracao`, o análogo de `src/evidencia.js`):
  todo valor monetário, CPF/CNPJ, número CNJ e data que apareça na extração e **não** apareça no
  texto-fonte (comparando só os dígitos, para pontuação diferente não gerar falso alarme) é **marcado
  inline** com `[⚠ não localizado no texto]` e vira aviso no rodapé. Marca em vez de apagar de
  propósito: o falso positivo é real (o valor pode ter sido dito por extenso) e apagar destruiria um
  dado que o advogado precisa — o risco a matar não era a presença do número, era a **confiança** que
  ele transmite.
  **Dinheiro é comparado como NÚMERO, não como cadeia de dígitos.** MEDIDO no e-mail real de
  07/08/2026: o Gemini escreve `"precificada em 5000 reais"`, sem formatação de moeda. Se o modelo
  devolver isso como `R$ 5.000,00` — que é o mesmo valor, formatado — a comparação por dígitos
  procuraria `500000` num texto que tem `5000` e marcaria um valor **certo** como não localizado.
  Falso alarme no campo de honorários é pior que nenhum aviso: ensina o advogado a ignorar o símbolo.
  Documento, processo e data continuam por dígitos, onde a identidade é a própria sequência.
- **Credencial separada.** `google-oauth-token-notas.json`, cliente OAuth próprio, porta 8092
  (`autorizar-google-notas.js`). O token do bot tem escopo só de Calendar; somar Gmail/Drive a ele
  exigiria refazer o consentimento, e um consentimento refeito pode invalidar o refresh token em uso
  — derrubar o agendamento para ligar uma funcionalidade nova. **Conferir o publishing status da tela
  de consentimento**: em "Testing" o refresh token expira em 7 dias e a rotina para em silêncio.
- **Botão de emergência.** `NOTAS_REUNIAO_ATIVO=false` (padrão) desliga; `NOTAS_REUNIAO_DRY_RUN=true`
  (padrão) roda o ciclo inteiro e imprime a nota sem escrever nada, gravando o estado em
  `notas_reuniao_dryrun` — tabela **separada** de propósito: se o dry-run gravasse na tabela real, a
  primeira execução de verdade acharia tudo `CONCLUIDO` e não faria nada.
- **Inspeção:** `GET /notas-reuniao/amostrar?limite=N` (só leitura, atrás de `exigeAdmin`) mostra o
  que a cascata decidiria para cada e-mail, sem extrair nem escrever. É o teste de regressão manual
  quando o Google mudar o formato do e-mail. `POST /notas-reuniao/sincronizar?aplicar=1` força um
  ciclo real.

### O PDF da transcrição na aba "Arquivos" do negócio

A nota traz o resumo; o Doc que o Gemini gera vira **anexo** no mesmo negócio (`anexarDocNoDeal`,
`index.js`). Desligado por padrão (`NOTAS_ANEXO_ATIVO`).

- **O Moskit não aceita upload — ele BAIXA de uma URL que a gente dá.** Medido em 18/08/2026 na doc
  oficial (que hoje é "Ollow API V2", `moskit.stoplight.io`): `POST /deals/{id}/attachments` tem
  corpo `{"url": "..."}` em `application/json`, e o `Content-Type` é um enum de um valor só — não há
  `multipart/form-data`. A doc ainda avisa que *"o arquivo não fica disponível instantaneamente"*, ou
  seja, o Moskit copia para o storage dele de forma assíncrona. Os quatro endpoints (`GET` lista com
  paginação por `start`, `POST`, `GET` por id, `DELETE`) usam o mesmo header `apikey` do resto.
- **Por isso existe uma rota pública sem autenticação.** `GET /arquivo-nota/:token/:nome` serve o PDF
  para o Moskit, que não tem como mandar `ADMIN_TOKEN`. É a única rota aberta além do health check, e
  o conteúdo é a transcrição de uma consulta jurídica — o que a protege é token de 256 bits, TTL
  curto (`NOTAS_ANEXO_TTL_HORAS`) e **invalidação imediata assim que o Moskit confirma a cópia**.
  `:nome` é **decorativo e nunca toca o disco**: existe só porque o Moskit deriva o `filename` da
  URL. O caminho real vem do banco — montar caminho com pedaço de URL é o que abriria path traversal
  (`test-rotas.js` tem a regressão, inclusive a tentativa de `../`).
- **O interstício do ngrok grátis é o risco principal, e é silencioso.** O plano gratuito devolve uma
  **página HTML de aviso** para quem ele julga navegador; o bypass é o header
  `ngrok-skip-browser-warning`, que **não controlamos** — quem faz o GET é o Moskit. Nesse caso o
  POST responde 2xx, o anexo aparece na aba com o nome certo, e só quem **abrir** descobre que é um
  HTML. Por isso `conferirAnexoNoMoskit` compara `size` e `mimeType` do que o CRM guardou com o PDF
  enviado e manda Telegram na divergência. Medir antes de ligar: `test-moskit-anexo-real.js`.
- **O nome do arquivo É a chave de deduplicação.** O POST não aceita marcador dentro do arquivo (o
  corpo é só uma url), então, depois de um crash entre "vou anexar" e "anexei", a única pergunta
  possível ao CRM é *"existe anexo com este nome?"*. `nomeAnexoNota` (`src/notas-reuniao.js`) deriva
  o sufixo do mesmo hash de `marcadorNota` — mesma origem, mesmo nome, sempre. Nome instável faria a
  resposta ser sempre "não achei" e poria uma segunda cópia da transcrição no prontuário do cliente.
  A retomada usa o `anexo_nome` **já gravado** (`nomeForcado`), nunca recalcula.
- **Bracket próprio.** O `POSTANDO → POSTADA` da nota não cobre este segundo efeito não-idempotente:
  `ANEXANDO → ANEXADO`, em colunas separadas (`anexo_*`). Separadas de propósito — a guarda de
  `ESTADOS_TERMINAIS` e a query `pendentes` são a trava contra nota duplicada, e um estado novo
  circulando por elas mudaria esse comportamento sem ninguém ter pedido. `anexoComNomeExiste`
  **lança** ao bater no teto de páginas, igual a `notaComMarcadorExiste` e pelo mesmo motivo.
- **O bracket abre antes de QUALQUER rede, e a tentativa é contada uma vez só.** Abrir só antes do
  `POST` deixava um buraco: uma falha na listagem de deduplicação — e o Moskit responde 429/timeout
  de 30s quando a varredura bate forte, como já documentado na reconciliação de vínculo — caía no
  `catch` com `anexo_estado` ainda `NULL`, e `anexosPendentes` só casa `'ANEXANDO'`. O PDF daquela
  reunião sumia para sempre, sem retry e sem rastro. Pelo mesmo motivo o `catch` **não** incrementa
  `anexo_tentativas`: contar nos dois lugares fazia UMA falha custar DUAS tentativas, o defeito já
  corrigido em `e78156f` para `erros_transitorios`.
- **`SEM_DOC` só pode significar "esta reunião não tem transcrição".** É um estado que a rede de
  segurança nunca retoma, então `exportarPdfDoDoc` devolve `{ bytes, transitorio }` e separa os dois
  mundos: 404/403 é veredito (o Doc não existe ou está fora do alcance da credencial) e vira
  `SEM_DOC`; 5xx, 429, timeout e DNS ficam em `ANEXANDO` para nova tentativa. Sem essa distinção, um
  Drive piscando gravaria no banco a afirmação contrária e perderia de vez o PDF de uma consulta que
  existia — enganando também quem fosse auditar depois.
- **`anexarDocNoDeal` NUNCA lança**, e roda **antes** do bracket da nota — é o que permite o rodapé
  afirmar "transcrição anexada" com honestidade. Se lançasse, trocaria um bônus ausente por um
  prontuário sem registro nenhum da consulta.
- **Sem Doc, sem anexo.** Não geramos PDF do resumo do e-mail: ele já está inteiro dentro da nota.
- **Desistir é silencioso.** Anexo faltando não é incidente — a consulta está registrada. Telegram a
  cada falha viraria ruído diário; só a divergência de tamanho (o sintoma do interstício) avisa.
- **Nenhum `db.prepare` no topo do arquivo pode depender dessa migração.** A consulta da rota pública
  é preparada **sob demanda** (`stmtNotaPorAnexoToken()`), e isso não é estilo: os `ALTER TABLE` vivem
  em `try {} catch {}` como todo o boot, e um prepare no carregamento do módulo transformava esse
  catch numa armadilha. Migração falhando por qualquer motivo que não "coluna já existe" — disco
  cheio, banco travado, arquivo corrompido — fazia o `require` lançar `no such column`, o processo
  morrer com **exit 1** e o pm2 entrar em loop de restart: o bot inteiro (WhatsApp, agenda, CRM) fora
  do ar por causa de uma coluna de uma funcionalidade que nasce **desligada**. Medido antes da
  correção. Preguiçoso, o pior caso é um 404 na rota de anexo. Regressão em `test-rotas.js`, que
  simula a migração impossível com uma VIEW chamada `notas_reuniao` (o `CREATE TABLE IF NOT EXISTS`
  pula em silêncio e o `ALTER` falha de verdade).
- **A migração é `ALTER TABLE`, não linha nova no `CREATE`.** As tabelas `notas_reuniao` /
  `notas_reuniao_dryrun` usam `CREATE TABLE IF NOT EXISTS`: em banco que já existe — produção
  inclusive — o `CREATE` não roda e as colunas novas simplesmente não apareceriam.
- **`drive.readonly` já basta** para exportar em PDF: nenhum consentimento OAuth novo, o que evita
  invalidar o refresh token em uso e derrubar o agendamento. `exportarPdfDoDoc` confere a assinatura
  `%PDF-` antes de aceitar os bytes — o Drive responde 200 com corpo HTML em algumas falhas de
  permissão, e um HTML salvo como `.pdf` entra no CRM parecendo anexo legítimo.
- Regressões em `test-notas-reuniao.js` (nome e rodapé, puros), `test-pipeline.js` (fluxo, dedup,
  retomada, TTL, interstício) e `test-rotas.js` (a rota pública).

### Segurança das rotas

- Rotas administrativas (`/sincronizar`, `/processar/:chatId`, backfills, auditorias) exigem
  `ADMIN_TOKEN` via middleware `exigeAdmin` (header `X-Admin-Token` ou `?token=`). Sem
  `ADMIN_TOKEN` definido, essas rotas respondem 503.
- `POST /webhook` exige assinatura HMAC-SHA256 (`WEBHOOK_SECRET`, header `X-Zernio-Signature`,
  validada em `assinaturaValida`/`comparacaoSegura` com comparação de tempo constante). Sem
  `WEBHOOK_SECRET`, a rota aceita qualquer origem sem checar assinatura. A URL do webhook no
  Zernio é sempre `/webhook` (não há caminho customizado) — o mesmo segredo precisa estar
  cadastrado no painel do Zernio.
- `GET /arquivo-nota/:token/:nome` é **pública de propósito** (ver "O PDF da transcrição na aba
  Arquivos"): o Moskit precisa baixar o arquivo e não tem como mandar `ADMIN_TOKEN`. Quem segura a
  porta é o token de 256 bits + `anexo_expira_em`, ambos conferidos na própria consulta SQL, mais a
  invalidação imediata após o CRM confirmar a cópia. Token desconhecido, expirado e arquivo ausente
  respondem **o mesmo 404** — distinguir contaria a quem sondasse que aquele token já existiu.
- `TEAM_PHONES` (env, comparado pelos últimos 8 dígitos via `ehInterno`) nunca deve virar
  lead/deal/contato no CRM.
- `POST /deploy-webhook` exige assinatura HMAC-SHA256 (`DEPLOY_WEBHOOK_SECRET`, header
  `X-Hub-Signature-256`, formato do GitHub, validada em `assinaturaGithubValida`/
  `comparacaoSegura`). Sem `DEPLOY_WEBHOOK_SECRET`, a rota fica **desabilitada** (503) — ao
  contrário de `/webhook`, aqui a ausência do segredo nunca abre a rota. Só dispara para push no
  branch `DEPLOY_BRANCH` (padrão `main`); a execução real (`git pull --ff-only` → `npm install` →
  `npm test` → só então `pm2 restart`) é isolada em `deploy.js`.

### Integrações externas (todas via `axios`, timeout global `TIMEOUT_HTTP_MS`)

- **OpenAI**: chamada HTTPS direta (`openaiChat`), sem SDK — decisão deliberada para evitar hangs.
- **Moskit CRM** (`MOSKIT_BASE`): `PUT` de deal precisa reenviar o corpo do `GET` (peculiaridade da
  API); `GET` logo após um `PUT` pode retornar dados em cache por até ~4s; `limit` de paginação
  sempre retorna 10 independente do valor pedido. Em `/activities` (medido em 12/08/2026, um
  parâmetro por vez) **o único que pagina é `?start=`** — offset real; `page`, `pageToken`, `offset`,
  `skip`, `from`, `maxId` e `beforeId` são todos **ignorados em silêncio**, respondendo 200 com a
  primeira página de novo. Um loop errado aqui não quebra: relê os mesmos 10 registros e parece ter
  varrido tudo. Ver `listarAtividadesMoskit`. Atenção: em `/contacts` quem pagina é o
  `x-moskit-listing-next-page-token` (`buscarOuCriarContato`) — o mecanismo **difere por endpoint**,
  não assuma. `deal.status` só aceita `OPEN`/`WON`/`LOST`.
  **`PUT /deals/{id}` tem que reenviar `activities`, senão o Moskit recusa o negócio inteiro.** MEDIDO
  em 19/08/2026 no deal 48441223: o PUT é *full replace*, e **omitir** `activities` significa para o
  Moskit "desvincule estas atividades" — o que ele recusa quando alguma já foi concluída, devolvendo
  `422 {"messageError":"Completed activity cannot be updated","field":"oldActivities"}`. O campo
  `oldActivities` não existe em nenhum payload nosso: é o nome interno com que ele compara o corpo
  recebido contra o estado atual. Experimento controlado (mesmo payload, só trocando a presença do
  campo): **422 sem, 200 com**. O sintoma em produção: a consulta de 13/08 foi marcada concluída na
  mão em 17/08 e, a partir dali, **toda** atualização daquele negócio falhou — o chat 553799437737
  queimou as 3 tentativas da fila e foi descartado em silêncio. Não é caso raro: consulta concluída é
  o caminho **normal** de sucesso, então o defeito atingia justamente os negócios bem atendidos.
  `putDealComVerificacao` nunca sofreu disso porque envia o corpo do `GET` inteiro;
  `atualizarNegocioMoskit` monta o payload do zero e por isso precisa preservar o campo à mão, como já
  fazia com `name` e `stage`. Regressão em `test-pipeline.js`.
  **Rate limit: 6 req/s e 240/min** (documentado em "Limite de requisições"), com headers
  `X-RateLimit-Remaining-Second`/`-Minute` que **nenhum código nosso lê ainda**. O 429 aparece com
  facilidade — bastaram três requisições quase simultâneas numa sondagem de leitura. É por isso que
  toda varredura tem pausa entre itens (`VINCULO_PAUSA_MS`, `SYNC_ATIVIDADES_PAUSA_MS`,
  `NOTAS_ANEXO_PAUSA_MS`).
  **Autoria dos campos personalizados**: o bot guarda em `custom_fields_bot` o último valor que ele
  mesmo escreveu; se o CRM divergir disso, alguém corrigiu na mão — o campo entra em
  `campos_travados` e o bot nunca mais o sobrescreve (`filtrarCamposPorAutoria`). `TIPO_CONSULTA`
  fica de fora: nele quem manda é o checkpoint do bloco de condições.
- **Google Calendar**: OAuth2 com conta real do escritório (`autorizar-google.js`, roda uma vez,
  interativo) — necessário para gerar link de Meet e convidar participantes por e-mail.
- **Telegram**: notifica comprovantes recebidos e conversas descartadas da fila após
  `MAX_TENTATIVAS` falhas.
  **O `parse_mode: 'Markdown'` é uma tentativa, não um requisito.** MEDIDO em 19/08/2026: `400` do
  Telegram repetido nos logs de produção. Basta o texto interpolar um nome de arquivo com `_`
  desbalanceado — e comprovante de WhatsApp se chama `comprovante_pix_18.pdf` — para o Telegram
  recusar a **mensagem inteira**. O aviso de comprovante recebido, que é o único jeito de o escritório
  saber que o cliente pagou, sumia em silêncio. `enviarTelegram` agora reenvia sem formatação quando
  o erro é `400`; `401`/`403` (token errado, bot bloqueado) **não** são reenviados, porque tirar o
  Markdown não conserta credencial. Regressão em `test-pipeline.js`.
- **Download de anexo do WhatsApp** (`baixarParaArquivo`): valida a URL **antes** do axios e o log
  identifica o **host** (nunca a URL inteira — é mídia de cliente) mais o status. MEDIDO em
  19/08/2026: 118 ocorrências de `Erro ao baixar anexo: 401` em produção, nenhuma dizendo de onde —
  impossível saber se era `ZERNIO_API_KEY` errada ou link assinado da Meta que expirou, que pedem
  consertos opostos. `401`/`403` em URL de mídia costuma ser link expirado; em host do Zernio, suspeite
  da chave. A causa raiz dos 118 continua **em aberto** — depende de uma ocorrência com o log novo.

## Environment

Ver `.env.example` para a lista completa e comentada. Sem process manager configurado (pm2/systemd/
Docker) — supervisionar o processo em produção é responsabilidade de quem faz o deploy. Em dev,
exponha a porta local com ngrok ou `node start-lt.js` (localtunnel).
