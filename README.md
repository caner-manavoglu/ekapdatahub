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
- Detay içeriğini varsayılan olarak kısaltır ve sadece seçili alanları saklar.
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
