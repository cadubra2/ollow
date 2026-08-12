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

`npm test` executa em sequência: `test-telefone.js`, `test-moskit-ids.js`, `test-evidencia.js`,
`test-fila.js`, `test-payload.js`, `test-rotas.js`, `test-pipeline.js`, `test-guards-internos.js`,
`test-agendamento-bloco-mensagens.js`, `test-transcricao.js`. Todos usam `DB_PATH` apontando para
um arquivo inexistente (banco descartável) — **nunca** deixe um teste abrir `conversations.db` de
produção.

### Scripts manuais — NUNCA rodar automaticamente/em CI

Escrevem em dados reais de produção (Moskit e/ou banco real):

- `test-moskit-put.js <dealId> [--aplicar]` e `test-moskit-real.js` — chamadas de escrita reais na
  API de produção do Moskit (criam/movem deals de verdade).
- `testar-briefing-unico.js` — idem, cria contato/deal reais no Moskit.
- `test-zapsign-real.js <email> [--aplicar]` — cria um documento REAL no ZapSign a partir do
  template de produção e dispara um e-mail de assinatura de verdade para o e-mail informado.
- `GET /auditoria-classificacao?aplicar=1` — escreve nos deals reais (corrige a classificação). Em
  dry-run (sem `aplicar`) é só leitura e pode rodar à vontade.
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
   do escritório — service account não gera link de Meet nem convida participantes).
4. Progressão de funil (`moverEstagioSeAvancar`) e fechamento (`fecharNegocioSeAplicavel`) são
   guardados por flags `FUNIL_DRY_RUN`/`FUNIL_FECHAMENTO_DRY_RUN` — comece sempre com dry-run
   ligado (padrão) até validar as sugestões da IA na prática.
5. Se qualquer etapa falhar, a conversa cai na fila (`src/fila.js`) e é reprocessada pelo
   `worker.js`, que é lançado como processo filho do próprio `index.js`.

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
  sempre retorna 10 independente do valor pedido; `deal.status` só aceita `OPEN`/`WON`/`LOST`.
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
