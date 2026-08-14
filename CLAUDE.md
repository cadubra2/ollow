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
`test-zapsign.js`. Todos usam `DB_PATH` apontando para um arquivo inexistente (banco descartável) —
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
- `corrigir-*.js` — scripts pontuais de correção de dados já aplicados (histórico, não reexecutar).

### Gerar segredos

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Usado para `ADMIN_TOKEN`, `WEBHOOK_SECRET` e `DEPLOY_WEBHOOK_SECRET`.

## Architecture

Aplicação Express monolítica: **`index.js` (~3100 linhas) contém o servidor, todas as rotas e todo o
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
  telefone.js            normalização de telefone e detecção de números internos (equipe)
  transcricao.js         transcrição de áudios do cliente via OpenAI (contrato: nunca lança)
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
  mesmo com a consulta marcada. `garantirVinculoAtividadeDeal` (`index.js`) confere logo após criar
  (GET + PUT com `deals` corrigido, mesmo padrão de `atualizarAtividadeMoskit`) e
  `reconciliarVinculoAtividades`/`rodarReconciliacaoVinculoAtividades` rodam na mesma cadência de
  `RECONCILIACAO_INTERVAL_MS` como rede de segurança para o que escapar da conferência imediata.
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
  Moskit — e lista divergências, incluindo esse caso de atividade sem vínculo com o negócio. `?todas=1`
  inclui consulta passada. Separa `problemas` (a consulta pode estar no horário errado agora, ou a
  atividade não aparece pro negócio) de `observacoes` (contexto): um alerta que dispara em toda linha
  afoga justamente os casos que importam.
- **Responsável.** A atividade sai no nome da Layla (`LAYLA_USER_ID`), como todo contato, deal e nota
  criados pelo bot. Não confundir com `advogado_responsavel`, que é campo personalizado do deal.
- **Botão de emergência.** `AGENDA_MOSKIT_DRY_RUN=true` desliga a escrita na agenda do CRM sem
  redeploy (o evento no Google continua sendo criado; o deal recebe uma nota `[dry-run]`). O padrão é
  o **inverso** de `FUNIL_DRY_RUN`: sem a variável, a agenda funciona. Aquelas flags seguram palpite
  de IA sobre funil; esta guarda uma regra determinística, então nasce ligada.

### Segurança das rotas

- Rotas administrativas (`/sincronizar`, `/processar/:chatId`, backfills, auditorias) exigem
  `ADMIN_TOKEN` via middleware `exigeAdmin` (header `X-Admin-Token` ou `?token=`). Sem
  `ADMIN_TOKEN` definido, essas rotas respondem 503.
- `POST /webhook` exige assinatura HMAC-SHA256 (`WEBHOOK_SECRET`, header `X-Zernio-Signature`,
  validada em `assinaturaValida`/`comparacaoSegura` com comparação de tempo constante). Sem
  `WEBHOOK_SECRET`, a rota aceita qualquer origem sem checar assinatura. A URL do webhook no
  Zernio é sempre `/webhook` (não há caminho customizado) — o mesmo segredo precisa estar
  cadastrado no painel do Zernio.
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
  **Autoria dos campos personalizados**: o bot guarda em `custom_fields_bot` o último valor que ele
  mesmo escreveu; se o CRM divergir disso, alguém corrigiu na mão — o campo entra em
  `campos_travados` e o bot nunca mais o sobrescreve (`filtrarCamposPorAutoria`). `TIPO_CONSULTA`
  fica de fora: nele quem manda é o checkpoint do bloco de condições.
- **Google Calendar**: OAuth2 com conta real do escritório (`autorizar-google.js`, roda uma vez,
  interativo) — necessário para gerar link de Meet e convidar participantes por e-mail.
- **Telegram**: notifica comprovantes recebidos e conversas descartadas da fila após
  `MAX_TENTATIVAS` falhas.

## Environment

Ver `.env.example` para a lista completa e comentada. Sem process manager configurado (pm2/systemd/
Docker) — supervisionar o processo em produção é responsabilidade de quem faz o deploy. Em dev,
exponha a porta local com ngrok ou `node start-lt.js` (localtunnel).
