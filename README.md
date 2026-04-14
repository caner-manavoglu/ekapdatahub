# EKAP Data Hub

EKAP Data Hub, EKAP kaynaklarından ihale/karar verisini toplayan, MongoDB'de saklayan ve web paneli üzerinden operasyonu yöneten bir Node.js uygulamasıdır.

Proje iki ana akışı tek çatı altında birleştirir:
- **Klasik EKAP scrape akışı**: Liste + detay API çağrıları, dokümantasyon temizleme, MongoDB upsert, opsiyonel PDF üretimi.
- **EKAP v3 indirme akışı**: Playwright tabanlı karar dosyası indirme, geçmiş/log takibi, dosya yönetimi.

## Teknik Özet

- Runtime: `Node.js` (CommonJS)
- Depolama: `MongoDB`
- HTTP: `axios`, `express`
- HTML işleme: `cheerio`
- PDF üretimi: `pdfkit`
- v3 otomasyonu: `Playwright` ( `ekap-v3/` altında )

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

## Proje Yapısı

```text
src/
  index.js                # CLI scraper entrypoint
  scraper.js              # liste/detay çekimi ve yazma akışı
  ekapClient.js           # EKAP HTTP istemcisi
  htmlCleaner.js          # veriHtml temizleme
  announcementExtractor.js# seçili alan/özet çıkarımı
  pdfWriter.js            # PDF üretimi
  web/
    server.js             # panel + API sunucusu
    public/               # frontend dosyaları
ekap-v3/
  ekap-playwright-*.js    # mahkeme/uyusmazlik indirme scriptleri
scripts/
  db-index-audit.js
  ops-benchmark.js
```

## Kurulum

```bash
npm install
cp .env.example .env
```

MongoDB'yi lokal çalıştırmak için:

```bash
docker run -d --name ekap-mongo -p 27017:27017 mongo:7
```

## Çalıştırma

```bash
npm start          # CLI scraper
npm run start:dry  # dry-run (DB yazmadan)
npm run web        # web panel + API
```

Panel varsayılan adresi: `http://127.0.0.1:8787`

## Sık Kullanılan Komutlar

```bash
npm test
npm run ci
npm run db:audit-indexes
npm run ops:benchmark
npm run migrate:legacy-downloads
```

## Not

`ekap-v3/README.md` dosyasında Playwright tarafının parametreleri ve kullanım senaryoları ayrıca dokümante edilmiştir.
