# Proje To-Do (Guncel)

Bu dosya guncel durum listesidir. Tamamlanan ve bekleyen maddeler birlikte takip edilir.

## P0 - Kritik

- [x] `AUTH-04` Panel secimi bypass kapat.
  - Kapsam: panel secimi olmadan `docs.html` ve `downloads.html` gibi statik sayfalarin dogrudan acilmasini engelle.
  - Bitis kriteri: sadece `/panel/dokumantasyon` veya `/panel/ekapv3` secimi sonrasi ilgili sayfalar aciliyor; dogrudan statik HTML erisimi `302 /` veya `403`.

- [x] `AUTH-05` Login `next` yonlendirme akisini gercekten aktif et.
  - Kapsam: auth guard login'e atarken `next` parametresi gondersin; login sonrasi sanitize edilmis hedefe donulsun.
  - Bitis kriteri: kullanici korunmus bir sayfaya gittiginde login sonrasi ayni sayfaya donuyor.

## P1 - Yuksek Oncelik

- [x] `UX-10` Dokumantasyon panelinde detay bildirimlerini geri getir.
  - Kapsam: `setDetailNotice` no-op yerine gorunur inline status/toast alani.
  - Bitis kriteri: PDF indirme basari/hata mesaji kullaniciya gorunuyor.

- [x] `OPS-01` Yikici islemler icin audit log.
  - Kapsam: silme endpointlerinde kim/ne zaman/ne sildi bilgisini kaydet.
  - Bitis kriteri: admin islemleri geriye donuk izlenebilir.

- [ ] `OPS-02` EKAP v3 devam edebilir indirme (resume) tasarimi.
  - Kapsam: yarim kalan islerde son islenen sayfadan devam secenegi.
  - Bitis kriteri: operator tek tikla kaldigi yerden devam ettirebiliyor.

## P2 - Teknik Borc

- [x] `DB-02` EKAP v3 log index tutarliligi.
  - Kapsam: `runId_1` index ile dokuman semasi uyumlulugu (`runId` alanini ekle veya indeksi kaldir).
  - Bitis kriteri: kullanilan sorgularla birebir uyumlu, gereksiz index yok.

- [x] `SEC-05` Login rate limitte IP guvenilirligi.
  - Kapsam: `x-forwarded-for` guven modelini proxy-aware hale getir (trusted proxy veya dogrudan `req.ip` stratejisi).
  - Bitis kriteri: spoof edilmis header ile rate-limit bypass edilemiyor.

## Onerilen Uygulama Sirasi

1. `OPS-02`
