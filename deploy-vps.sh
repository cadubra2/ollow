#!/usr/bin/env bash
# ============================================================
#  Deploy do Bot WhatsApp (Zernio) -> Moskit na VPS Ubuntu
#  Uso: bash deploy-vps.sh   (rodar como ubuntu via SSH)
#
#  PREREQUISITO: os arquivos de config ja foram copiados da
#  maquina Windows via scp (passo 3 do roteiro):
#    .env, google-oauth-client.json, google-oauth-token.json,
#    conversations.db, comprovantes/
# ============================================================
set -euo pipefail

# --- Ngrok: token de autenticacao (NAO commitar; definir no .env da VPS) ---
# Adicione ao .env:  NGROK_AUTHTOKEN=seu-token  (gerar em https://dashboard.ngrok.com)
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
# Dominio publico estatico do ngrok (gratis ou pago). Se definido no .env como
# NGROK_URL, o bot passa a usar --url pra manter a mesma URL entre reinicios
# (o webhook do Zernio NAO pode mudar de URL). Ex: https://thing-booted-mobility.ngrok-free.dev

echo "==> 1/7 Node.js 22 + ferramentas + pm2"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
fi
sudo apt-get update && sudo apt-get install -y nodejs git build-essential python3 unzip
sudo npm install -g pm2
node -v && npm -v

echo "==> 2/7 Clonar projeto (se ainda nao existir)"
cd "$HOME"
if [ ! -d ollow/.git ]; then
  git clone https://github.com/cadubra2/ollow.git
fi
cd ollow
npm install

echo "==> 3/7 Verificar arquivos de config"
for f in .env google-oauth-client.json google-oauth-token.json conversations.db; do
  if [ ! -f "$f" ]; then
    echo "   ! AVISO: $f nao encontrado — copie da maquina Windows via scp e rode novamente"
  else
    echo "   ok: $f"
  fi
done
if [ ! -d comprovantes ]; then
  echo "   ! AVISO: pasta comprovantes/ nao encontrada (recebidos ficam so na VPS daqui pra frente)"
  mkdir -p comprovantes
fi

echo "==> 4/7 Ngrok"
mkdir -p ngrok
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) NGROK_ARCH="arm64" ;;
  *)             NGROK_ARCH="amd64" ;;
esac
if [ ! -x ngrok/ngrok ]; then
  cd ngrok
  curl -fsSLo ngrok.zip "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${NGROK_ARCH}.zip"
  unzip -o ngrok.zip && rm -f ngrok.zip
  chmod +x ngrok
  cd "$HOME/ollow"
fi
if [ -n "$NGROK_AUTHTOKEN" ]; then
  ngrok/ngrok config add-authtoken "$NGROK_AUTHTOKEN"
fi

echo "==> 5/7 Testes"
npm test

echo "==> 6/7 pm2 (sobrevive a queda e a reboot)"
pm2 start index.js --name apiollow-bot || pm2 restart apiollow-bot
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" || true

echo "==> 7/7 Logs"
pm2 logs apiollow-bot

echo ""
echo "Pronto! Confira no log a linha:  Tunnel publico (ngrok): <url>"
echo "Cadastre <url>/webhook (e <url>/deploy-webhook, se usar auto-deploy) no Zernio/GitHub."