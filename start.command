#!/bin/bash
# EKAP Data Hub - macOS tek tık başlatıcı
# Bu dosyaya çift tıklayın. İlk açılışta bağımlılıkları kurar, sonra paneli açar.

set -e
cd "$(dirname "$0")"

echo "=== EKAP Data Hub başlatılıyor ==="

# Node kontrolü
if ! command -v node >/dev/null 2>&1; then
  echo "HATA: Node.js bulunamadı. Kurun: brew install node@20"
  echo "Çıkmak için Enter'a basın."
  read -r
  exit 1
fi

# .env yoksa örnekten oluştur
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo ".env dosyası .env.example'dan oluşturuldu. Gerekirse MONGODB_URI değerini düzenleyin."
fi

# Kök bağımlılıklar
if [ ! -d node_modules ]; then
  echo "Bağımlılıklar kuruluyor (npm install)..."
  npm install
fi

# ekap-v3 bağımlılıkları + Playwright
if [ -d ekap-v3 ] && [ ! -d ekap-v3/node_modules ]; then
  echo "ekap-v3 bağımlılıkları kuruluyor..."
  ( cd ekap-v3 && npm install && npx playwright install chromium )
fi

# Docker varsa ve mongo konteyneri çalışmıyorsa başlat
if command -v docker >/dev/null 2>&1; then
  if ! docker ps --format '{{.Names}}' | grep -q '^ekap-mongo$'; then
    if docker ps -a --format '{{.Names}}' | grep -q '^ekap-mongo$'; then
      docker start ekap-mongo >/dev/null 2>&1 || true
    else
      docker run -d --name ekap-mongo -p 27017:27017 mongo:7 >/dev/null 2>&1 || true
    fi
  fi
fi

# Panel açıldıktan 3 sn sonra tarayıcıyı aç
( sleep 3 && open "http://127.0.0.1:8787" ) &

echo "Web panel başlatılıyor → http://127.0.0.1:8787"
echo "(Durdurmak için bu pencerede Ctrl+C)"
npm run web
