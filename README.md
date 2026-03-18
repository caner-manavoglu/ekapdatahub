# EKAP -> MongoDB Scraper

Bu proje, EKAP arama servisinden ihale kayıtlarını sayfalı olarak çeker, her ihale için detay API çağrısı yapar, tam dokümantasyon + temizlenmiş dokümantasyon üretir, MongoDB'ye yazar ve her satır (ihale) için ayrı PDF üretir.

## Ne yapar?

- `POST /b_ihalearama/api/Ihale/GetListByParameters` ile listeyi alır.
- Her satır için `row.id` değerini `ihaleId` olarak kullanıp:
  - `POST /b_ihalearama/api/IhaleDetay/GetByIhaleIdIhaleDetay` çağrısı yapar.
- `item.ilanList[].veriHtml` için:
  - namespace/xml attribute'larını temizler,
  - metinleştirilmiş çıktı (`veriHtmlCleanText`) üretir,
  - temizlenmiş HTML (`veriHtmlCleanHtml`) üretir.
- Sonucu MongoDB'de `upsert` eder (`_id = sourceIhaleId`).
- Incremental modda değişmeyen kayıtları atlayıp taramayı erken sonlandırabilir.
- Kayıtları normalize ederek `sync.normalizedUniqueKey` üretir ve sayfa içi duplicate kayıtları conflict policy ile temizler.
- Detay içeriğini varsayılan olarak kısaltır ve sadece seçili alanları saklar.
- Çalışma sonunda p50/p95 latency, retry sayısı, queue depth ve hata tipleri metriklerini raporlar.
- Her ihale için `reports/pdfs` altında ayrı PDF oluşturur.
- Web arayüzünde ihaleleri listeler ve ilan bazında:
  - `Tam Dokümantasyon (HTML)`
  - `Temiz Dokümantasyon (HTML + Text)`
  - `Seçili Alanlar Özeti`
    görünümlerini sunar.

## Kurulum

```bash
npm install
cp .env.example .env
```

MongoDB'yi Docker ile ayağa kaldırmak için:

```bash
docker run -d --name ekap-mongo -p 27017:27017 mongo:7
```

## Çalıştırma

```bash
npm start
```

Sadece test amaçlı (MongoDB'ye yazmadan):

```bash
npm run start:dry
```

`start:dry` varsayılan olarak PDF üretmez.
Dry-run sırasında özellikle PDF üretmek isterseniz `GENERATE_PDF=true` verilebilir.

Testleri çalıştırmak için:

```bash
npm test
```

CI kontrol setini (syntax + repo guard + test) çalıştırmak için:

```bash
npm run ci
```

Mongo index denetimini (`explain` dahil) çalıştırmak için:

```bash
npm run db:audit-indexes
```

Operasyon benchmark/regresyon kontrolünü çalıştırmak için:

```bash
npm run ops:benchmark
```

Sık kullanılan örnek:

```bash
npm run ops:benchmark -- --samples=8 --maxRegressionPct=25 --saveRemote=true
```

Bu script `/.ops/benchmarks` altında zaman damgalı snapshot üretir, varsa son snapshot ile p95 karşılaştırması yapar ve eşik aşımında `exit code 2` döner.

Frontend arayüzünü başlatmak için:

```bash
npm run web
```

Arayüz: `http://127.0.0.1:8787`

Bu komut tek başına yeterlidir. Login sonrası ana sayfada iki seçenek görünür:
- `Dokümantasyon` (`/dokumantasyon`)
- `EKAP v3` (`/ekapv3.html`)

`Dokümantasyon` sayfasında `Verileri Çek`/`Durdur` ile klasik scrape akışını yönetebilirsiniz.
`/indirilenler` sayfasında çekim tarihine göre kayıtları listeleyebilir, metin araması yapabilir, seçili kayıtları veya seçilen tarihin tamamını silebilirsiniz.
Silme işlemleri için `onaylıyorum` metni zorunludur.
`AUTH_ENABLED=true` ise panele giriş zorunludur (`/login`).
`EKAP v3` sayfasında Operasyon Dashboard kartları ile indirme/scrape KPI ve aktif alarm durumu tek panelde izlenir.

Eski klasör yapısından (`ekap-v3/downloads-mahkeme`, `ekap-v3/downloads-uyusmazlik`) yeni yapıya tek seferlik geçiş gerekiyorsa:

```bash
npm run migrate:legacy-downloads
```

Not: Bu migration komutu geçiş dönemi içindir ve 30 Eylül 2026 sonrası kaldırılması planlanmıştır.

## Ortam Değişkenleri

- `MONGODB_URI`: Mongo bağlantısı
- `MONGODB_DB`: Veritabanı adı
- `MONGODB_COLLECTION`: Koleksiyon adı
- `GENERATE_PDF`: `true` ise her satır için PDF oluşturur (`DRY_RUN=true` iken belirtilmezse varsayılan `false`)
- `PDF_OUTPUT_DIR`: PDF çıktı klasörü
- `PDF_FONT_PATH`: PDF için kullanılacak Unicode font dosya yolu (öneri: `Arial Unicode.ttf`)
- `STORE_FULL_ILAN_CONTENT`: `true` ise ham detay içeriğini de `raw` alanına yazar
- `PAGE_SIZE`: Sayfa başına kayıt sayısı
- `MAX_PAGES`: Kaç sayfa işleneceği (`0` = sınırsız)
- `START_SKIP`: Kaç kayıttan başlanacağı
- `REQUEST_TIMEOUT_MS`: HTTP timeout
- `RETRY_COUNT`: Hata durumunda deneme sayısı
- `RETRY_DELAY_MS`: Denemeler arası temel bekleme (artan backoff uygulanır)
- `RATE_LIMIT_MS`: İstekler arası bekleme
- `DETAIL_CONCURRENCY`: Detay işlemede eşzamanlı worker sayısı (`1-16`, varsayılan `4`)
- `WRITE_BATCH_SIZE`: MongoDB `bulkWrite` batch büyüklüğü (`10-1000`)
- `SCRAPE_INCREMENTAL`: `true` ise değişmeyen kayıtları atlayarak artımlı çalışır
- `SCRAPE_INCREMENTAL_STOP_STREAK`: Art arda değişmeyen kayıt eşiği; eşik aşılırsa tarama erken biter
- `SCRAPE_INCREMENTAL_CHECKPOINT`: Incremental son görülen kayıt checkpoint dosya yolu
- `SCRAPE_ADAPTIVE_PAGINATION`: `true` ise full scan sırasında `take/pageSize` dinamik ayarlanır
- `SCRAPE_PAGE_SIZE_MIN`: Adaptive mod alt sınır `take`
- `SCRAPE_PAGE_SIZE_MAX`: Adaptive mod üst sınır `take`
- `SCRAPE_PAGE_SIZE_STEP`: Adaptive mod artış/azalış adımı
- `SCRAPE_PAGE_TARGET_MS`: Liste isteği hedef latency (ms), adaptive tuning bu hedefe göre çalışır
- `SCRAPE_ADAPTIVE_DETAIL_CONCURRENCY`: `true` ise detay worker sayısı sayfa performansına göre dinamik ayarlanır
- `DETAIL_CONCURRENCY_MIN`: Adaptive detail mod alt worker sınırı
- `DETAIL_CONCURRENCY_MAX`: Adaptive detail mod üst worker sınırı
- `DETAIL_PAGE_TARGET_MS`: Sayfa başına detay işleme hedef süresi (ms)
- `SCRAPE_CONDITIONAL_REQUESTS`: `true` ise uygun endpointlerde `If-None-Match` / `If-Modified-Since` ile koşullu istek dener
- `SCRAPE_CONDITIONAL_CACHE_TTL_MS`: Koşullu istek validator/data cache TTL süresi
- `SCRAPE_CONDITIONAL_CACHE_SIZE`: Koşullu istek validator/data cache üst sınırı
- `SCRAPE_RESPONSE_CACHE_ENABLED`: `true` ise aynı list/detail isteklerini kısa TTL içinde doğrudan memory cache'den döndürür
- `SCRAPE_RESPONSE_CACHE_TTL_MS`: Response cache TTL süresi
- `SCRAPE_RESPONSE_CACHE_SIZE`: Response cache üst sınırı
- `SCRAPE_CIRCUIT_BREAKER_ENABLED`: `true` ise ardışık hata eşiğinde circuit breaker devreye girer
- `SCRAPE_CIRCUIT_BREAKER_THRESHOLD`: Circuit breaker açılma eşiği (ardışık hata sayısı)
- `SCRAPE_CIRCUIT_BREAKER_COOLDOWN_MS`: Open durumunda bekleme süresi
- `SCRAPE_CIRCUIT_BREAKER_HALF_OPEN_PAGES`: Half-open modda başarılı geçmesi gereken sayfa adedi
- `HTTP_KEEP_ALIVE`: `true` ise liste/detay isteklerinde keep-alive agent kullanılır
- `HTTP_MAX_SOCKETS`: Keep-alive agent için maksimum socket sayısı
- `HTTP_MAX_FREE_SOCKETS`: Keep-alive agent için maksimum boş socket sayısı
- `HTTP_KEEP_ALIVE_MS`: Keep-alive bağlantı saklama süresi
- `STORE_RAW_HTML`: `STORE_FULL_ILAN_CONTENT=true` ise orijinal `veriHtml` saklanır
- `DRY_RUN`: `true` ise Mongo'ya yazmaz
- `WEB_PORT`: Frontend/API sunucu portu
- `WEB_HOST`: Sunucunun bind adresi (varsayılan `127.0.0.1`, uzak erişim için `0.0.0.0`)
- `AUTH_ENABLED`: `true` ise web panel ve API auth kontrolü aktif olur
- `AUTH_COOKIE_NAME`: Oturum cookie adı
- `AUTH_COOKIE_SECURE`: `true` ise cookie sadece HTTPS üzerinden gönderilir
- `AUTH_TRUST_PROXY`: `true` ise rate-limit IP tespiti için proxy zinciri (`req.ips` / `x-forwarded-for`) kullanılır
- `AUTH_SESSION_TTL_MS`: Oturum süresi (ms)
- `AUTH_LOGIN_WINDOW_MS`: Hatalı login denemesi pencere süresi (ms)
- `AUTH_LOGIN_MAX_ATTEMPTS`: Pencere başına izin verilen maksimum hatalı deneme
- `AUTH_USERS`: JSON dizi (username/password/role). Password: `plain:<sifre>` veya `sha256:<hex>`
- `AUDIT_LOG_COLLECTION`: Silme gibi yıkıcı işlemler için audit kayıt koleksiyonu
- `OPS_ALERT_COLLECTION`: Operasyon alarm olay kayıtları koleksiyonu
- `OPS_BENCHMARK_COLLECTION`: Benchmark snapshot kayıtları koleksiyonu
- `OPS_DASHBOARD_WINDOW_HOURS`: Ops dashboard varsayılan KPI penceresi (saat)
- `OPS_ALERT_EVALUATE_INTERVAL_MS`: Alarm kurallarının arka planda değerlendirme aralığı (ms)
- `OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT`: İndirme hata oranı alarm eşiği (%)
- `OPS_ALERT_SCRAPE_LIST_P95_MS`: Scrape liste p95 alarm eşiği (ms)
- `OPS_ALERT_SCRAPE_DETAIL_P95_MS`: Scrape detay p95 alarm eşiği (ms)
- `OPS_ALERT_SCRAPE_QUEUE_P95`: Scrape queue depth p95 alarm eşiği
- `OPS_ALERT_STALLED_RUN_MINUTES`: İndirme run tıkanma alarm eşiği (dakika)
- `EKAP_V3_WORKER_COUNT`: EKAP v3 varsayılan worker sayısı (önerilen başlangıç `3`)
- `EKAP_V3_WORKER_COUNT_MAX`: EKAP v3 worker üst sınırı
- `EKAP_V3_JOB_CHUNK_SIZE`: EKAP v3 varsayılan job chunk boyutu (önerilen `2`)
- `EKAP_V3_JOB_CHUNK_SIZE_MAX`: EKAP v3 job chunk üst sınırı
- `EKAP_V3_TIMEOUT_RETRIES`: Satır bazlı timeout sonrası tekrar deneme sayısı
- `EKAP_V3_RETRY_BASE_DELAY_MS`: Retry başlangıç bekleme süresi
- `EKAP_V3_RETRY_MAX_DELAY_MS`: Retry üst sınır bekleme süresi
- `EKAP_V3_RETRY_JITTER_RATIO`: Retry jitter oranı (`0.0-1.0`)
- `EKAP_V3_DATE_SHARD_ENABLED`: `true` ise büyük tarih aralıkları shard planına uygun olduğunda paralel çalıştırılır
- `EKAP_V3_DATE_SHARD_DAYS`: Bir shard başına gün sayısı
- `EKAP_V3_DATE_SHARD_MIN_SPAN_DAYS`: Shard mode için minimum tarih aralığı (gün)
- `EKAP_V3_DATE_SHARD_MAX_PARALLEL`: Aynı anda çalışacak maksimum shard sayısı
- `EKAP_V3_PREFLIGHT_CHECK_ENDPOINT`: `true` ise EKAP UI endpoint kontrolü yapılır
- `EKAP_V3_PREFLIGHT_STRICT`: `true` ise endpoint timeout/network hatasında start isteği bloklanır
- `EKAP_V3_PREFLIGHT_ENDPOINT_METHOD`: Endpoint health check HTTP metodu (`HEAD`/`GET`)
- `CONTEXT_RESET_HARD_FACTOR`: Context reset için hard limit katsayısı (soft limit x katsayı)
- `CHECKPOINT_FLUSH_EVERY`: Checkpoint dosyasına yazmadan önce birikecek event sayısı
- `CHECKPOINT_FLUSH_INTERVAL_MS`: Checkpoint batch yazım maksimum bekleme süresi (ms)
- `FAST_MODE`: `true` ise ağır doğrulamalar (örn. SHA256) varsayılan olarak kapanır
- `COMPUTE_SHA256`: İndirilen dosya SHA256 hesaplamasını aç/kapat (`true/false`)
- `BLOCK_RESOURCES`: Playwright tarafında image/font/analytics gibi gereksiz kaynakları bloklar (`true/false`)
- `AUTO_TUNE`: Önceki run benchmarklarına göre worker/chunk/reset parametrelerini otomatik ayarlar (`true/false`)
- `AUTO_TUNE_FILE`: Auto-tune profil dosya yolu (opsiyonel)
- `RUN_TAG`: Bu run için dosya adı prefix'i (opsiyonel)
- `API_FIRST_LIST`: EKAP v3 Playwright listesi UI tiklamasi yerine API-first akistan alınır (`true/false`)
- `API_FIRST_LIST_STRICT`: API-first liste akisi hata verirse UI fallback yerine hataya duser (`true/false`)
- `API_FIRST_DOWNLOAD`: EKAP v3 Playwright indirmede PDF'i once API request ile dener (`true/false`)
- `API_FIRST_STRICT`: API-first basarisiz olursa UI fallback yerine hataya duser (`true/false`)
- `OPS_BENCHMARK_COOKIE`: Benchmark scripti için hazır session cookie (opsiyonel)
- `OPS_BENCHMARK_USERNAME`: Benchmark scripti login kullanıcı adı (opsiyonel)
- `OPS_BENCHMARK_PASSWORD`: Benchmark scripti login şifresi (opsiyonel)

## Rol Yetkileri (auth aktifken)

- `viewer`: okuma endpointleri (`GET /api/tenders*`, `GET /api/downloads*`, `GET /api/ekapv3/*`)
- `operator`: `viewer` + çalıştır/durdur (`POST /api/scrape/*`, `POST /api/ekapv3/start`, `POST /api/ekapv3/stop`, `POST /api/ekapv3/files/open-dir`)
- `admin`: `operator` + silme endpointleri (`POST /api/downloads/delete`, `POST /api/ekapv3/files/delete`)

## MongoDB Doküman Yapısı (özet)

```json
{
  "_id": "<row.id>",
  "sourceIhaleId": "<row.id>",
  "ikn": "2026/271215",
  "ihaleAdi": "...",
  "item": {
    "ikn": "2026/271215",
    "ihaleAdi": "...",
    "ilanList": [
      {
        "id": "6864602",
        "ilanTarihi": "2026-02-26T00:00:00",
        "dokumantasyon": {
          "tamHtml": "<tam html>",
          "temizHtml": "<temiz html>",
          "temizText": "<temiz metin>"
        },
        "secilenAlanlar": {
          "ihaleKayitNumarasi": "2026/271215",
          "idarenin": {
            "madde11Adi": "...",
            "madde12Adresi": "...",
            "madde13TelefonNumarasi": "..."
          },
          "ihaleKonusuHizmetAlimi": {
            "madde31Adi": "...",
            "madde32NiteligiTuruVeMiktari": "..."
          }
        },
        "secilenAlanlarMetin": "Kompakt metin"
      }
    ]
  },
  "updatedAt": "2026-03-06T..."
}
```
