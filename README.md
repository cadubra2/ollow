# Bot WhatsApp (Zernio) → Moskit CRM

Bot que recebe mensagens do WhatsApp via [Zernio](https://zernio.com), usa a OpenAI para
qualificar o lead e extrair dados do atendimento, e cadastra/atualiza o cliente no CRM Moskit —
incluindo agendamento automático no Google Calendar quando cliente e equipe confirmam o mesmo
horário. Feito para o escritório Caballero, Rocha & Carvalho.

A documentação de processo (POP) é a fonte da verdade sobre o fluxo de negócio: veja
[`docs/pop/fluxo-bot-whatsapp-moskit.html`](docs/pop/fluxo-bot-whatsapp-moskit.html) ou o PDF
`docs/pop/Fluxo - Bot WhatsApp e CRM Moskit v1.2.pdf`. Versões anteriores (sem versão e v1.1)
ficam arquivadas em [`docs/pop/archive/`](docs/pop/archive/), só para histórico.

## Estrutura

```
index.js          servidor Express: webhook, rotas administrativas, todo o pipeline (~3000 linhas)
worker.js          processa a fila de conversas pendentes (roda como processo filho do index.js)
processar_pendentes.js   reprocessamento manual de conversas presas
autorizar-google.js      gera google-oauth-token.json (rodar uma vez, interativo)
deploy.js                git pull + npm install + npm test + pm2 restart — disparado por POST /deploy-webhook
                         a cada push (processo filho desacoplado, roda mesmo com o pai reiniciando)
corrigir-*.js            scripts pontuais de correção de dados já aplicados (histórico)
src/
  agendamento.js         dupla confirmação de horário (cliente + equipe)
  bloco-condicoes.js     detecção do bloco de condições de pagamento
  evidencia.js           validação das observações extraídas pela IA
  fila.js                fila de retry para o worker
  mensagens.js           deduplicação e ordenação cronológica de mensagens
  moskit-ids.js          todos os IDs/campos do Moskit, numa fonte só
  telefone.js            normalização de telefone e detecção de números internos
  transcricao.js         transcrição de áudios do cliente (WhatsApp → OpenAI)
docs/pop/          POP oficial do processo (HTML + PDF)
```

## Setup

1. `npm install`
2. Copie `.env.example` para `.env` e preencha as chaves (OpenAI, Moskit, Zernio, Google, Telegram).
3. Gere `ADMIN_TOKEN` e `WEBHOOK_SECRET` com:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Sem esses dois valores, as rotas administrativas ficam desabilitadas (503) e o `POST /webhook`
   aceita qualquer origem. A URL do webhook no Zernio é fixa (sempre `/webhook`, sem caminho
   customizado) — a autenticação é por **assinatura HMAC**, não pela URL: depois de definir
   `WEBHOOK_SECRET`, cadastre o **mesmo valor** no painel do Zernio em Settings → Webhooks →
   secret (ou via API, campo `secret` do `createWebhookSettings`/`updateWebhookSettings`). O
   Zernio passa a assinar cada entrega com HMAC-SHA256 no header `X-Zernio-Signature`, e o bot
   passa a exigir essa assinatura.
4. Rode `node autorizar-google.js` uma vez para gerar `google-oauth-token.json` (fluxo OAuth2
   interativo, precisa de uma conta Google real do escritório — service account não serve porque
   não gera link de Meet nem convida participantes por e-mail).

## Rodando

```bash
npm start
```

Em desenvolvimento, exponha a porta local (padrão 3000) com ngrok ou `node start-lt.js`
(localtunnel) e cadastre a URL pública `/webhook` no Zernio — a URL não muda quando o
`WEBHOOK_SECRET` é definido, só passa a ser exigida a assinatura HMAC (ver Setup acima).

Não há process manager configurado (pm2/systemd/Docker) — em produção, rodar por trás de um
supervisor de processos é responsabilidade de quem fizer o deploy.

## Deploy na VPS (Ubuntu)

1. Suba uma VPS (Oracle/etc.) e rode `bash deploy-vps.sh` via SSH (instala Node 22, clona o repo,
   instala dependências, baixa o ngrok, roda `npm test` e registra no pm2).
2. Antes de subir, copie os arquivos de config da máquina atual via scp:
   `.env`, `google-oauth-client.json`, `google-oauth-token.json`, `conversations.db` e `comprovantes/`.
3. No `.env` da VPS: defina `NGROK_URL=<dominio-estatico>` (senão a URL do túnel muda a cada
   restart e o webhook do Zernio quebra) e `TZ_ESCRITORIO` se o fuso não for `America/Fortaleza`.
4. O tunnel fica em `~/ollow/ngrok/ngrok` (sem `.exe` no Linux) — o `index.js` escolhe o binário
   pelo SO automaticamente. O token do ngrok vai em `NGROK_AUTHTOKEN` no `.env` da VPS, nunca
   commitado no script.

## Auto-deploy (opcional)

Pra manter uma instância sempre atualizada sozinha a cada `git push`, sem precisar entrar na
máquina manualmente:

1. Rodar o bot com `pm2` (sobrevive a queda e a reboot):
   ```bash
   npm install -g pm2 pm2-windows-startup   # o pacote pm2-windows-startup só é necessário no Windows
   pm2 start index.js --name apiollow-bot
   pm2 save
   pm2-startup install                      # registra o pm2 pra subir sozinho no boot/login
   ```
2. Gerar `DEPLOY_WEBHOOK_SECRET` com o mesmo comando de crypto do Setup e definir no `.env`
   (`DEPLOY_BRANCH` é opcional, padrão `main`).
3. No repositório no GitHub: Settings → Webhooks → Add webhook — Payload URL
   `https://<url-publica>/deploy-webhook`, Content type `application/json`, Secret = o mesmo
   valor de `DEPLOY_WEBHOOK_SECRET`, eventos = só `push`.
4. Cada push no branch configurado dispara `deploy.js`: `git pull --ff-only` → `npm install` →
   `npm test` → só se as três passarem, `pm2 restart apiollow-bot`. Se qualquer etapa falhar, a
   versão antiga continua no ar — nada é aplicado às pressas — e o erro fica em `deploy.log`
   (e no Telegram, se `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` estiverem configurados).

Como a mesma URL pública passa a ser usada por duas integrações (Zernio em `/webhook` e GitHub
em `/deploy-webhook`), prefira um domínio estável (domínio estático do ngrok, ou Cloudflare
Tunnel) em vez do túnel efêmero — senão os dois webhooks precisam ser recadastrados a cada
reinício do túnel.

## Testando

```bash
npm test      # suíte determinística, sem rede — roda em qualquer ambiente/CI
npm run test:ia   # chama a OpenAI de verdade (test-dupla-confirmacao.js) — custa créditos
```

A suíte cobre também a transcrição de áudio (`test-transcricao.js`): o cliente OpenAI é um fake e
o download usa um adapter local, então nenhuma rede é tocada.

**Scripts manuais — NUNCA rodar automaticamente/CI**, pois escrevem em dados reais:

- `test-moskit-put.js <dealId> [--aplicar]` e `test-moskit-real.js` — fazem chamadas de escrita
  reais na API de produção do Moskit CRM (criam/movem deals de verdade).
- `testar-briefing-unico.js` — idem, cria contato/deal reais no Moskit para verificar um bug
  específico.
- `test-cenarios-classificacao.js` e `test-simulacao.js` — chamam a OpenAI de verdade mas não
  têm asserção automática de pass/fail; servem para inspeção manual do resultado da IA, não como
  teste de regressão.

## Variáveis de ambiente

Veja `.env.example` para a lista completa e comentada. Destaques de segurança:

- `ADMIN_TOKEN` — protege `/sincronizar`, `/processar`, backfills etc. (header `X-Admin-Token`).
- `WEBHOOK_SECRET` — protege `/webhook` via assinatura HMAC-SHA256 (header `X-Zernio-Signature`);
  precisa ser cadastrado também no painel do Zernio. Sem ele, a rota fica aberta para qualquer
  origem.
- `DEPLOY_WEBHOOK_SECRET` — protege `/deploy-webhook` via assinatura HMAC-SHA256 (header
  `X-Hub-Signature-256`, formato do GitHub); precisa ser cadastrado também no webhook do
  repositório. Sem ele, a rota fica **desabilitada** (503) — ver seção "Auto-deploy" acima.
- `TEAM_PHONES` — telefones da equipe/sócios, nunca viram lead/deal no CRM.
- `OPENAI_AUDIO_MODEL` — modelo de transcrição de áudio (padrão `gpt-4o-mini-transcribe`,
  ~US$0,003/min). `OPENAI_AUDIO_TIMEOUT_MS` ajusta o timeout da transcrição (padrão 120s).
