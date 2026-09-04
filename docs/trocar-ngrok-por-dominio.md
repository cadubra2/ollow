# Trocar o túnel ngrok por um domínio próprio

**Por que fazer:** hoje o WhatsApp chega ao bot por um túnel ngrok do plano gratuito. Ele é ponto
único de falha para **duas** coisas ao mesmo tempo:

1. **O webhook do Zernio** — se a sessão do túnel cair, a URL muda, o Zernio continua chamando a
   antiga, e nenhuma mensagem de cliente chega ao bot. O sintoma é *"o cliente mandou e ninguém
   respondeu"*, **sem erro nenhum no log** — foi assim que dois incidentes deste projeto passaram
   despercebidos.
2. **O PDF da transcrição** — o Moskit baixa o arquivo pela URL do túnel (`PUBLIC_BASE_URL`). Túnel
   com URL vencida = anexo que falha, ou pior, anexo que entra parecendo legítimo.

Medido em 04/09/2026: o plano gratuito aceita **uma sessão por conta**, e a página de aviso do ngrok
é servida para qualquer requisição com User-Agent de navegador (`200` com 2808 bytes de HTML).

**O que a VPS já tem** (verificado em 04/09/2026), e que faz este trabalho ser curto:

| | |
|---|---|
| nginx | rodando, escutando 80 e 443 |
| sites já configurados | `chatwoot`, `deskcommcrm` (em `/etc/nginx/sites-enabled/`) |
| certbot | instalado em `/usr/bin/certbot` |
| bot | `pm2` processo `apiollow-bot`, projeto em `/home/ubuntu/ollow`, porta **3000** |

---

## Passo 1 — Criar o registro DNS *(é o único passo que não é na VPS)*

No painel de DNS do domínio do escritório, criar:

| tipo | nome | valor | TTL |
|---|---|---|---|
| `A` | `bot` | `64.181.190.28` | 300 (5 min) |

Isso cria `bot.<seu-dominio>`. Use o domínio que o escritório já usa no e-mail
(`caballeroerocha.com`, se for esse) — **não** precisa de domínio novo, só do subdomínio.

**Confirmar antes de seguir** (roda em qualquer máquina):

```bash
dig +short bot.caballeroerocha.com
```

Tem de responder `64.181.190.28`. Se vier vazio, o DNS ainda não propagou — espere e repita. **Não
avance sem isso:** o certbot falha se o nome não resolver, e o erro dele não diz que a causa é o DNS.

---

## Passo 2 — Configurar o nginx na VPS

```bash
sudo tee /etc/nginx/sites-available/apiollow-bot > /dev/null <<'CONF'
server {
    listen 80;
    server_name bot.caballeroerocha.com;

    # underscores_in_headers fica no PADRAO (off) de proposito: nenhum header que o bot recebe usa
    # "_" (X-Zernio-Signature, X-Hub-Signature-256, X-Admin-Token). Ligar sem necessidade abriria
    # espaco para header estranho passar. Se algum dia uma integracao nova precisar (o Chatwoot
    # precisa: api_access_token), ligue APENAS no server dela.
    client_max_body_size 25m;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
CONF

sudo ln -s /etc/nginx/sites-available/apiollow-bot /etc/nginx/sites-enabled/apiollow-bot
sudo nginx -t
```

`nginx -t` **tem de dizer `syntax is ok` e `test is successful`**. Só então:

```bash
sudo systemctl reload nginx
```

---

## Passo 3 — Certificado TLS

```bash
sudo certbot --nginx -d bot.caballeroerocha.com --redirect
```

O certbot edita o arquivo do passo 2 sozinho, adicionando o bloco `443` e o redirecionamento de
`http` para `https`. A renovação automática já existe na VPS (é a mesma que mantém o Chatwoot).

**Conferir:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bot.caballeroerocha.com/
```

Tem de responder `200` (é o health check do bot). Se responder `502`, o nginx subiu mas o bot não
está na 3000 — confira `pm2 list`.

---

## Passo 4 — Apontar o bot para o domínio

No `/home/ubuntu/ollow/.env`:

```bash
cd /home/ubuntu/ollow
cp .env .env.bak-antes-dominio          # sempre
sed -i 's|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://bot.caballeroerocha.com|' .env
grep -n '^PUBLIC_BASE_URL' .env
```

E acrescentar a linha que desliga o túnel (a chave nasce ligada; sem ela nada muda):

```bash
echo 'TUNEL_NGROK_ATIVO=false' >> .env
```

Reiniciar carregando o ambiente novo:

```bash
pm2 restart apiollow-bot --update-env
```

No log do boot tem de aparecer:

```
🌐 Tunel ngrok DESLIGADO (TUNEL_NGROK_ATIVO=false)
   O webhook precisa chegar por outro caminho — PUBLIC_BASE_URL=https://bot.caballeroerocha.com
```

---

## Passo 5 — Trocar a URL no painel do Zernio *(o passo que de fato liga o WhatsApp)*

No painel do Zernio, no campo de webhook, trocar a URL do ngrok por:

```
https://bot.caballeroerocha.com/webhook
```

O caminho é sempre `/webhook` e o segredo (`WEBHOOK_SECRET`) **não muda** — só o domínio.

⚠️ **Enquanto este passo não for feito, o bot para de receber mensagem.** Faça os passos 4 e 5 em
sequência, no mesmo momento. Se preferir risco zero, inverta: faça o 5 **antes** do 4 — o nginx já
estará respondendo desde o passo 3, então as duas rotas funcionam ao mesmo tempo durante a troca.

---

## Passo 6 — Provar que funcionou (não confie no silêncio)

```bash
# 1) uma mensagem de teste no WhatsApp do escritório, e depois:
pm2 logs apiollow-bot --lines 50 --nostream | grep "MSG recebida"

# 2) o anexo de nota volta a poder ser servido pelo domínio novo
grep -c "anexo servido" <(pm2 logs apiollow-bot --lines 200 --nostream)

# 3) e o certificado não expira sem avisar
sudo certbot certificates | grep -A2 bot.caballeroerocha
```

O sinal de sucesso é `📩 MSG recebida de: ...` aparecendo **depois** da troca. Não basta o `200` no
health check: ele prova que o nginx alcança o bot, não que o Zernio está chamando o endereço novo.

---

## Como voltar atrás, se algo der errado

```bash
cd /home/ubuntu/ollow
cp .env.bak-antes-dominio .env
pm2 restart apiollow-bot --update-env
# o log volta a imprimir a URL do ngrok; recoloque-a no painel do Zernio
```

O nginx e o certificado podem ficar onde estão — não atrapalham nada com o túnel de volta.

---

## Ganho, em uma linha

O WhatsApp deixa de depender de um túnel gratuito que pode mudar de endereço sozinho, e o Moskit
passa a baixar o PDF de um endereço estável e com TLS válido — sem a página de aviso do ngrok no
caminho.
