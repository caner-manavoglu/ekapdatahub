# EKAP Data Hub

EKAP Data Hub, EKAP kaynaklarından ihale/karar verisini toplayan, MongoDB'de saklayan ve web paneli üzerinden operasyonu yöneten bir Node.js uygulamasıdır.

Proje iki ana akışı tek çatı altında birleştirir:
- **Klasik EKAP scrape akışı**: Liste + detay API çağrıları, dokümantasyon temizleme, MongoDB upsert, opsiyonel PDF üretimi.
- **EKAP v3 indirme akışı**: Playwright tabanlı karar dosyası indirme, geçmiş/log takibi, dosya yönetimi (`ekap-v3/` altında).

## Teknik Özet

- Runtime: `Node.js 20 LTS+` (CommonJS)
- Depolama: `MongoDB 7`
- HTTP: `axios`, `express`
- HTML işleme: `cheerio`
- PDF üretimi: `pdfkit`
- v3 otomasyonu: `Playwright` (`ekap-v3/` altında, ayrı bağımlılık)

Temel akış:
1. EKAP liste endpointinden sayfalı kayıtlar alınır.
2. Her kayıt için detay endpointi çağrılır.
3. `ilanList.veriHtml` temizlenir, özet alanlar çıkarılır.
4. Veri `_id=sourceIhaleId` olacak şekilde MongoDB'ye upsert edilir.
5. İsteğe bağlı PDF üretilir ve web panelinden görüntülenir/indirilir.

## Neler Yapabilir?

- EKAP’taki ihale bilgilerini toplar ve tek bir yerde düzenli şekilde saklar.
- Aynı veriyi tekrar tekrar çekmek yerine, yeni/değişen kayıtları öne alarak zamanı kısaltır.
- İhale detayındaki karmaşık dokümanları daha okunur hale getirir.
- Her kayıt için “ham içerik + temiz içerik + kısa özet” görünümü sunar.
- İstenirse kayıtları PDF olarak dışarı aktarır.
- Web panelden veri çekmeyi başlatıp durdurabilirsiniz.
- Panelde ihale araması yapabilir, detayları inceleyebilir ve PDF indirebilirsiniz.
- EKAP v3 tarafında karar dosyalarını toplu indirebilir, geçmişi görebilir ve dosyaları yönetebilirsiniz.
- Uzun süren işlemlerde hata olduğunda otomatik toparlanmaya çalışır ve süreci takip edilebilir tutar.

---

# Kurulum (Adım Adım)

> Aşağıdaki komutları **sırayla** terminale kopyala-yapıştır yaparak çalıştırabilirsiniz.
> Gereksinimler: **Node.js 20 LTS+**, **Git**, ve bir **MongoDB** (Docker ya da MongoDB Atlas).

## Windows

PowerShell'i açın (Başlat → "PowerShell").

### 1. Araçları kurun (winget)

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
winget install --id Docker.DockerDesktop -e
```

Kurulum sonrası PowerShell'i **kapatıp yeniden açın** (PATH güncellensin). Doğrulayın:

```powershell
node --version
git --version
```

### 2. Projeyi alın

```powershell
cd $HOME\Desktop
git clone <REPO_URL> ekapdatahub
cd ekapdatahub
```

> `<REPO_URL>` yerine deponuzun adresini yazın. Proje zaten elinizdeyse bu adımı atlayın ve `cd` ile klasöre girin.

### 3. Bağımlılıkları kurun

```powershell
npm install
cd ekap-v3
npm install
npx playwright install chromium
cd ..
```

### 4. Ortam dosyasını oluşturun

```powershell
Copy-Item .env.example .env
notepad .env
```

`MONGODB_URI` değerini kendi MongoDB adresinize göre düzenleyin (Docker için `mongodb://127.0.0.1:27017`).

### 5. MongoDB'yi başlatın (Docker)

```powershell
docker run -d --name ekap-mongo -p 27017:27017 mongo:7
```

### 6. Çalıştırın

```powershell
npm run web
```

Tarayıcıdan açın: `http://127.0.0.1:8787`

---

## macOS

Terminal'i açın (Spotlight → "Terminal"). Önce [Homebrew](https://brew.sh) gerekir:

### 1. Homebrew + araçlar

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@20 git
brew install --cask docker
```

Doğrulayın:

```bash
node --version
git --version
```

> Docker Desktop'ı bir kez **uygulamadan açıp** çalıştığından emin olun.

### 2. Projeyi alın

```bash
cd ~/Desktop
git clone <REPO_URL> ekapdatahub
cd ekapdatahub
```

> `<REPO_URL>` yerine deponuzun adresini yazın. Proje zaten elinizdeyse bu adımı atlayın.

### 3. Bağımlılıkları kurun

```bash
npm install
cd ekap-v3
npm install
npx playwright install chromium
cd ..
```

### 4. Ortam dosyasını oluşturun

```bash
cp .env.example .env
open -e .env
```

`MONGODB_URI` değerini düzenleyin (Docker için `mongodb://127.0.0.1:27017`).

### 5. MongoDB'yi başlatın (Docker)

```bash
docker run -d --name ekap-mongo -p 27017:27017 mongo:7
```

### 6. Çalıştırın

```bash
npm run web
```

Tarayıcıdan açın: `http://127.0.0.1:8787`

---

> **MongoDB Atlas kullanıyorsanız**: Docker adımını atlayın, `.env` içindeki
> `MONGODB_URI` değerini Atlas bağlantı dizginizle (`mongodb+srv://...`) değiştirin.

## Çalıştırma Komutları

```bash
npm start          # CLI scraper
npm run start:dry  # dry-run (DB'ye yazmadan)
npm run web        # web panel + API  → http://127.0.0.1:8787
```

## Sık Kullanılan Komutlar

```bash
npm test                       # tüm testler
npm run ci                     # syntax + repo-guard + test
npm run db:audit-indexes       # MongoDB index denetimi
npm run ops:benchmark          # operasyon benchmark
npm run migrate:legacy-downloads
```

## Proje Yapısı

```text
src/
  index.js                 # CLI scraper entrypoint
  scraper.js               # liste/detay çekimi ve yazma akışı
  ekapClient.js            # EKAP HTTP istemcisi
  htmlCleaner.js           # veriHtml temizleme
  announcementExtractor.js # seçili alan/özet çıkarımı
  pdfWriter.js             # PDF üretimi
  config.js                # ortam değişkeni okuma
  dbIndexes.js             # MongoDB index tanımları
  web/
    server.js              # panel + API sunucusu
    public/                # frontend dosyaları
ekap-v3/                   # Playwright tabanlı v3 indirme (ayrı npm paketi)
  ekap-playwright-runner.js
  ekap-playwright-mahkeme.js
  ekap-playwright-uyusmazlik.js
scripts/
  db-index-audit.js
  ops-benchmark.js
  repo-guard.js            # sensitive/oversize dosya commit engeli
  check-syntax.js
```
