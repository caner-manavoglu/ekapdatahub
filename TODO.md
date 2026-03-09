# Proje To-Do (Guncel)

Bu dosya guncel durum listesidir. Tamamlanan ve bekleyen maddeler birlikte takip edilir.

## P0 - Kritik

- [x] `AUTH-04` Panel secimi bypass kapat.
  - Kapsam: panel secimi olmadan `docs.html` ve `downloads.html` gibi statik sayfalarin dogrudan acilmasini engelle.
  - Bitis kriteri: sadece `/panel/dokumantasyon` veya `/panel/ekapv3` secimi sonrasi ilgili sayfalar aciliyor; dogrudan statik HTML erisimi `302 /` veya `403`.

- [x] `AUTH-05` Login `next` yonlendirme akisini gercekten aktif et.
  - Kapsam: auth guard login'e atarken `next` parametresi gondersin; login sonrasi sanitize edilmis hedefe donulsun.
  - Bitis kriteri: kullanici korunmus bir sayfaya gittiginde login sonrasi ayni sayfaya donuyor.

- [x] `OPS-02` EKAP v3 devam edebilir indirme (resume) tasarimi.
  - Kapsam: yarim kalan islerde son islenen sayfadan devam secenegi.
  - Bitis kriteri: operator tek tikla kaldigi yerden devam ettirebiliyor.

- [x] `PERF-01` Worker havuzu + eszamanlilik limiti.
  - Kapsam: tek tek isleme yerine kontrollu paralel isleme (`concurrency: 4-8`).
  - Bitis kriteri: throughput artisi saglanirken hata orani stabil kaliyor.

- [x] `REL-01` Akilli retry (gecici hata odakli).
  - Kapsam: sadece `429/5xx/timeout` durumlarinda exponential backoff + jitter.
  - Bitis kriteri: gecici hatalarda basariyla toparlanma, kalici hatalarda hizli fail.

- [x] `REL-02` Rate limit korumasi.
  - Kapsam: hedef sistemi zorlamayacak request araligi/throttle mekanizmasi.
  - Bitis kriteri: istek hizi kontrollu ve hedef tarafta bloklama/timeout azalir.

- [ ] `DATA-01` Idempotent indirme ve veri cekme.
  - Kapsam: ayni dosya/ilanin tekrar islenmesini engelleyen unique key/hash kontrolu.
  - Bitis kriteri: tekrar calistirmada duplicate kayit veya duplicate dosya uretilmez.

- [ ] `IO-01` Dosya yazmada atomik guvenlik.
  - Kapsam: once `.part` yaz, tamamlaninca atomik rename yap.
  - Bitis kriteri: yarim/bozuk dosyalar son klasore dusmez.

## P1 - Yuksek Oncelik

- [x] `UX-10` Dokumantasyon panelinde detay bildirimlerini geri getir.
  - Kapsam: `setDetailNotice` no-op yerine gorunur inline status/toast alani.
  - Bitis kriteri: PDF indirme basari/hata mesaji kullaniciya gorunuyor.

- [x] `OPS-01` Yikici islemler icin audit log.
  - Kapsam: silme endpointlerinde kim/ne zaman/ne sildi bilgisini kaydet.
  - Bitis kriteri: admin islemleri geriye donuk izlenebilir.

- [ ] `ARCH-01` Kuyruk ayrimi (liste/detay/pdf).
  - Kapsam: liste cekme, detay cekme ve pdf indirme adimlarini ayri job queue olarak modelle.
  - Bitis kriteri: bir adimdaki yavaslama diger adimlari kilitlemiyor.

- [ ] `DB-03` Toplu DB yazimi + index iyilestirme.
  - Kapsam: tek tek upsert yerine batch upsert ve sorgu desenine uygun index seti.
  - Bitis kriteri: DB yazma suresi azalir, lock/saturation gozlenmez.

- [ ] `PERF-02` Tarayici optimizasyonu.
  - Kapsam: gereksiz asset (gorsel/font/script) yuklerini azalt; mumkunse API/HTTP yoluna gec.
  - Bitis kriteri: sayfa basina ortalama indirme/cekme suresi dusurulur.

- [ ] `REL-03` Tum sayfalar modunda guvenli otomatik bitis.
  - Kapsam: art arda `N` bos sayfa gorulurse isi kontrollu sonlandir.
  - Bitis kriteri: sonsuz dongu olmadan dogal veri sonu yakalanir.

- [ ] `REL-04` Stage bazli timeout ve net hata kodlari.
  - Kapsam: liste/detay/indirme adimlari icin ayri timeout politikalari.
  - Bitis kriteri: timeout nedeni ve asama bilgisi log/API durumunda net gorulur.

- [ ] `OBS-01` Izlenebilirlik ve metrikler.
  - Kapsam: basari orani, ortalama sure, hata tipleri, aktif is sayisi metrikleri.
  - Bitis kriteri: performans regresyonlari dashboard/log uzerinden hizla tespit edilir.

## P2 - Teknik Borc

- [x] `DB-02` EKAP v3 log index tutarliligi.
  - Kapsam: `runId_1` index ile dokuman semasi uyumlulugu (`runId` alanini ekle veya indeksi kaldir).
  - Bitis kriteri: kullanilan sorgularla birebir uyumlu, gereksiz index yok.

- [x] `SEC-05` Login rate limitte IP guvenilirligi.
  - Kapsam: `x-forwarded-for` guven modelini proxy-aware hale getir (trusted proxy veya dogrudan `req.ip` stratejisi).
  - Bitis kriteri: spoof edilmis header ile rate-limit bypass edilemiyor.

- [ ] `REL-05` Circuit breaker uygulamasi.
  - Kapsam: surekli hata durumunda gecici durdurma ve kontrollu yeniden deneme.
  - Bitis kriteri: hedef servis sorunlarinda sistem kendini koruyarak toparlaniyor.

- [ ] `OPS-03` Calisma oncesi saglik kontrolleri.
  - Kapsam: disk alani, yazma izni, ag durumu, hedef endpoint erisimi pre-check.
  - Bitis kriteri: kritik kosullar saglanmadan is baslatilmiyor.

- [ ] `PERF-03` Yuk/soak test paketi.
  - Kapsam: gercekci veriyle 10-30 dk test, darbozaz olcumleri ve parametre tuning.
  - Bitis kriteri: kapasite sinirlari ve guvenli default ayarlar dokumante.

## Onerilen Uygulama Sirasi

1. `OPS-02`
2. `PERF-01`
3. `REL-01`
4. `REL-02`
5. `DATA-01`
6. `IO-01`
7. `ARCH-01`
8. `DB-03`
9. `PERF-02`
10. `REL-03`
11. `REL-04`
12. `OBS-01`
13. `REL-05`
14. `OPS-03`
15. `PERF-03`
