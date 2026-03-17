# TODO - Indirme Hizlandirma

## P0 (En Yuksek Etki)
- [ ] UI tiklama akisini minimuma indir; liste ve PDF indirmeyi API-first akisa tasi.
- [ ] Worker havuzunu kademeli optimize et (`workerCount` 2-4, `jobChunkSize` 2-3) ve stabil kombinasyonu sabitle.
- [ ] Tarih araligini shard et; buyuk araliklari kucuk parcalara bolup paralel calistir.
- [ ] Retry/backoff ayarlarini hiz odakli optimize et; gereksiz uzun timeoutlari dusur.

## P1
- [ ] Context reset frekansini optimize et; gereksiz sik resetleri azalt.
- [ ] Fast mode ekle; agir dogrulamalari (ornek: SHA256) opsiyonel yap, minimum PDF kontrolunu koru.
- [ ] Log/history yazimlarini batch hale getir; satir-basi pahali yazimlari azalt.

## P2
- [ ] Playwright tarafinda gereksiz kaynaklari (image/font/analytics) blokla.
- [ ] Dosya adlandirma ve klasor akisini run-bazli sadelestir; gereksiz `exists` kontrollerini azalt.
- [ ] Otomatik benchmark/tuning ekle; satir/saniye, hata, retry metriklerine gore parametreleri optimize et.
