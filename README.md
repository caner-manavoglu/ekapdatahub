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

## Web Paneli ve API

`npm run web` ile panel + REST API ayağa kalkar. Başlıca uç noktalar:

| Yöntem | Yol | Açıklama |
|--------|-----|----------|
| GET | `/api/health` | Servis sağlık kontrolü |
| GET/POST | `/api/scrape/status` · `/run` · `/stop` | Klasik scrape akışını yönet |
| GET/POST | `/api/ekapv3/status` · `/start` · `/download` · `/check` · `/stop` | EKAP v3 indirme akışı |
| GET | `/api/ekapv3/history` · `/files` | İndirme geçmişi ve dosya listesi |
| GET | `/api/ekapv3/files/download` | İndirilen dosyayı al |
| GET | `/api/tenders` · `/tenders/:id` · `/tenders/:id/pdf` | İhale arama, detay, PDF |
| GET/POST | `/api/downloads` · `/downloads/dates` · `/downloads/delete` | Kayıt yönetimi |
| GET/POST | `/api/ops/dashboard` · `/alerts` · `/benchmarks` · `/benchmark` | Operasyon metrikleri |

Panel sayfaları: `/` (panel seçimi), `/dokumantasyon`, `/downloads`, `/ekapv3.html`.

### Kimlik Doğrulama

Auth varsayılan olarak **kapalıdır** (`AUTH_ENABLED=false`). Açmak için `.env` içinde
`AUTH_ENABLED=true` ve `AUTH_USERS` (JSON dizi) tanımlanır.

### Güvenlik Notu

`.env` ve `.env.*` (örn. `.env.dev`) dosyaları gizli bilgi içerir; `.gitignore` ile
takip dışıdır ve commit edilmemelidir. Yalnızca `.env.example` paylaşılır.
`npm run check:repo`, sensitive/oversize dosya commit'ini engeller.

---

# EKAP v3 Playwright Scriptleri

EKAP v2 kurul kararları ekranında tarih aralığına göre sonuçları tarayıp karar dosyalarını
indirmek için iki Playwright scripti vardır (`ekap-v3/` altında):

- `ekap-playwright-mahkeme.js`
- `ekap-playwright-uyusmazlik.js`

> **DİKKAT:** Hata alınması durumunda VSCode veya diğer code editörünü kapatmayın.

## Hızlı Kullanım

```bash
cd ekap-v3
npm run mahkeme:visible      # görünür Chrome
npm run mahkeme:headless     # arka planda (headless)
npm run uyusmazlik:visible
npm run uyusmazlik:headless
```

## Parametreli Kullanım

`headless` arka planda çalışır; `visible` Chrome penceresini gösterir.

```bash
node ekap-playwright-mahkeme.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=headless
node ekap-playwright-uyusmazlik.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=visible
```

Belirli sayfa aralığı:

```bash
node ekap-playwright-mahkeme.js --from=2026/02/01 --to=2026/02/15 --startPage=3 --endPage=7 --browserMode=headless
```

### Parametreler

- `--from=` / `--to=`: Tarih (`YYYY/MM/DD`, `YYYY-MM-DD`, `DD.MM.YYYY`)
- `--maxPages=`: En fazla taranacak sayfa sayısı
- `--startPage=`: İşleme başlanacak sayfa (varsayılan `1`)
- `--startRow=`: Başlangıç sayfasında başlanacak satır (resume/checkpoint, varsayılan `1`)
- `--endPage=`: İşlenecek son sayfa (verilmezse `startPage + maxPages - 1`)
- `--dateInputIndex=`: Tarih input index'i (varsayılan `0`)
- `--timeoutRetries=`: `ERR_CONNECTION_TIMED_OUT` için tekrar deneme (varsayılan `2`)
- `--retryBaseDelayMs=`: Retry başlangıç bekleme (varsayılan `900`)
- `--retryMaxDelayMs=`: Retry üst sınır bekleme (varsayılan `25000`)
- `--retryJitterRatio=`: Retry jitter oranı `0.0-1.0` (varsayılan `0.25`)
- `--browserMode=`: `headless` veya `visible`
- `--workerCount=`: Sayfa bazlı kuyruk worker sayısı (belirli sayfa aralığında, varsayılan `1`)
- `--jobChunkSize=`: Kuyruktaki her işin kapsadığı sayfa adedi (varsayılan `1`)
- `--adaptiveConcurrency=`: `true/false`, hata oranına göre worker havuzunu dinamik ayarla (varsayılan `true`)
- `--contextResetAfterJobs=`: Worker başına kaç job sonra context reset (varsayılan `12`)
- `--contextResetAfterPages=`: Tek worker modunda kaç sayfa sonra context reset (varsayılan `20`)
- `--minDownloadBytes=`: İndirilen dosya minimum byte kontrolü (varsayılan `1024`)
- `--enforcePdfHeader=`: `%PDF` header doğrulaması (`true/false`, varsayılan `true`)
- `--apiFirstDownload=`: `true/false`, PDF'i önce API request ile dener (varsayılan `true`)
- `--apiFirstStrict=`: `true/false`, API-first başarısızsa UI fallback yerine hata (varsayılan `false`)
- `--checkpoint=`: Checkpoint mekanizması (`true/false`, varsayılan `true`)
- `--checkpointPath=`: Checkpoint dosya yolu
- `--resetCheckpoint=`: Başlangıçta checkpoint sıfırlansın mı (`true/false`, varsayılan `false`)
- `--userDataDir=`: Chrome kullanıcı profili yolu

**Notlar:**
- Geriye uyumluluk: eski `--headless=true|false` parametresi de çalışır.
- `--allPages=true` modunda worker havuzu devre dışı, tek worker ile devam.
- `--startRow>1` iken satır bazlı resume nedeniyle worker havuzu devre dışı.
- İndirme klasörleri: `indirilenler/mahkeme`, `indirilenler/uyusmazlik`
- Checkpoint dosyası: `checkpoints/<type>-<from>-<to>.json`
- Duplicate kontrolü kapalı; aynı satırlar tekrar çalıştırmada yeniden indirilir.

### API-first İndirme

- Download butonunun POST/GET bilgisi popup sayfasından çıkarılıp doğrudan request ile PDF indirilir.
- API-first başarısızsa (strict kapalıysa) UI click download fallback çalışır.
- Popup/download event kırılganlığını ve toplam indirme süresini azaltır.
- Log satırında `transport=api-first` veya `transport=ui-download` görünür.

### Timeout Retry Davranışı

`ERR_CONNECTION_TIMED_OUT` alınırsa script aynı satırı atlamaz; tekrar dener
(`--timeoutRetries`). Limit dolarsa sonraki satıra geçer. Backoff + jitter tüm kritik
adımlarda tutarlı uygulanır.
