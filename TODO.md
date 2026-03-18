# TODO - Indirme Hizlandirma

## P0 (En Yuksek Etki)
- [x] UI tiklama akisini minimuma indir; liste ve PDF indirmeyi API-first akisa tasi.
- [x] Worker havuzunu kademeli optimize et (`workerCount` 2-4, `jobChunkSize` 2-3) ve stabil kombinasyonu sabitle.
- [x] Tarih araligini shard et; buyuk araliklari kucuk parcalara bolup paralel calistir.
- [x] Retry/backoff ayarlarini hiz odakli optimize et; gereksiz uzun timeoutlari dusur.

## P1
- [x] Context reset frekansini optimize et; gereksiz sik resetleri azalt.
- [x] Fast mode ekle; agir dogrulamalari (ornek: SHA256) opsiyonel yap, minimum PDF kontrolunu koru.
- [x] Log/history yazimlarini batch hale getir; satir-basi pahali yazimlari azalt.

## P2
- [x] Playwright tarafinda gereksiz kaynaklari (image/font/analytics) blokla.
- [x] Dosya adlandirma ve klasor akisini run-bazli sadelestir; gereksiz `exists` kontrollerini azalt.
- [x] Otomatik benchmark/tuning ekle; satir/saniye, hata, retry metriklerine gore parametreleri optimize et.
