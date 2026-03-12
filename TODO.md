# TODO - Hiz, Stabilite ve Kullanim Kolayligi

Bu dosya sifirdan yeniden olusturuldu. Onceki tum maddeler temizlendi.

## P0 - Kullanici Deneyimi ve Akis Duzeltmeleri (Elestiri Maddeleri)

- [x] `UX-01` Sayfalar arasi dosya secim kaybi
  - Sorun: Kullanici bir sayfada dosya secince diger sayfaya gecince secimler dusuyor.
  - Is: Secimleri sadece filtre degisiminde temizle, pagination gecislerinde koru.
  - Bitis kriteri: Kullanici sayfa degistirse bile secili dosyalar korunuyor.

- [x] `UX-02` Yaniltici "Tum dosyalari sec" metni
  - Sorun: Checkbox sadece mevcut sayfayi seciyor, ama metin tum sonuclari seciyor gibi gorunuyor.
  - Is: Etiketi "Bu sayfadakileri sec" yap veya gercek global secim davranisi ekle.
  - Bitis kriteri: Metin ve davranis birebir uyumlu.

- [x] `UX-03` Canli polling agirligi
  - Sorun: Status + history cok sik cekiliyor, arayuz akiciligini ve backend yukunu etkiliyor.
  - Is: History polling'i seyreklet (15-30 sn) veya sadece state degisiminde cek.
  - Bitis kriteri: Ag trafigi azalirken canli gorunum bozulmuyor.

- [x] `UX-04` Dosya listesinin buyuk veride yavaslamasi
  - Sorun: Her istekte tum dosyalar okunup siralaniyor.
  - Is: Kisa omurlu cache, artimli listeleme veya metadata index yapisi ekle.
  - Bitis kriteri: Buyuk klasorlerde sayfa acilis suresi belirgin sekilde dusuyor.

- [x] `UX-05` Ilerleme metninde toplam hedef yok
  - Sorun: Kullanici "kacinci dosya" bilgisini tam goremiyor.
  - Is: Mumkunse toplam hedefi ekle (`X / N`), bilinmiyorsa acikca "Toplam bilinmiyor" yaz.
  - Bitis kriteri: Indirme ilerlemesi bitis tahminiyle birlikte okunabilir.

- [x] `UX-06` Pagination ergonomisi sinirli
  - Sorun: Sadece onceki/sonraki ile cok sayfada gezinmek yorucu.
  - Is: "Ilk", "Son" ve "Sayfaya git" kontrolleri ekle.
  - Bitis kriteri: 100+ sayfada hizli gezinti mumkun.

- [x] `UX-07` Baslatma sonrasi teknik izlenebilirlik zayif
  - Sorun: API trigger olduktan sonra operasyona ait teknik kimlik hemen gorunmuyor.
  - Is: Run ID ve baslatma zamani bilgisini status satirinda goster.
  - Bitis kriteri: Destek/debug icin tek bakista kimliklenebilir run bilgisi var.

## P1 - Indirme Islemleri (Playwright) Hiz ve Stabilite

- [x] `DL-01` API-first sayim
  - Is: Indirme oncesi toplam kayit sayisini varsa direkt API response'tan al.
  - Bitis kriteri: Tarayici uzerinden sayim adimi gerekmiyor.

- [x] `DL-02` Job queue + worker havuzu
  - Is: Sayfa/satir bazli isleri kuyruga koy, worker sayisini konfigurable yap.
  - Bitis kriteri: Tek hata tum akisi durdurmuyor, throughput artiyor.

- [x] `DL-03` Adaptif concurrency
  - Is: Hata oranina gore worker sayisini dinamik azalt/artir.
  - Bitis kriteri: Stabilite korunurken en yuksek guvenli hizda calisiyor.

- [x] `DL-04` Standart retry policy
  - Is: Timeout/5xx/ag hatalari icin exponential backoff + jitter merkezi hale getir.
  - Bitis kriteri: Tum indirme adimlarinda tutarli retry davranisi var.

- [x] `DL-05` Selector saglamlastirma
  - Is: Kritik selectorler icin fallback stratejileri, gorunurluk ve state tabanli wait kullan.
  - Bitis kriteri: UI degisikliklerinde kirilma orani dusuyor.

- [x] `DL-06` Download dogrulama katmani
  - Is: `.crdownload/.part`, minimum boyut, checksum/headers dogrulamasi ekle.
  - Bitis kriteri: Yarim/incomplete dosyalar basarili sayilmiyor.

- [x] `DL-07` Idempotent dosya anahtari
  - Is: `type + kararNo + tarih` gibi deterministic key ile duplicate indirmeyi engelle.
  - Bitis kriteri: Ayni veri ikinci kez yazilmiyor.

- [x] `DL-08` Checkpoint + resume iyilestirme
  - Is: Son basarili sayfa/satir bilgisi kalici saklansin.
  - Bitis kriteri: Crash/kill sonrasi minimum kayipla devam.

- [x] `DL-09` Preflight saglik kontrolu
  - Is: Baslangicta disk bos alan, yazma izni, hedef endpoint erisimi kontrol et.
  - Bitis kriteri: Kosullar uygun degilse islem baslamadan net hata donuyor.

- [x] `DL-10` Browser context yeniden kullanim
  - Is: Gereksiz context ac/kapat azalt, kontrollu reuse ve periyodik reset uygula.
  - Bitis kriteri: Uzun calismalarda bellek ve startup maliyeti dusuyor.

## P2 - Veri Cekim (API/Scrape) Hiz ve Optimizasyon

- [x] `DC-01` Artimli senkronizasyon (incremental)
  - Is: Son cekilen tarih/id checkpoint'i ile sadece yeni/degisen kayitlari cek.
  - Bitis kriteri: Tekrarlanan full scan ihtiyaci ciddi azalir.

- [x] `DC-02` Batch ve pagination tuning
  - Is: `limit/pageSize` degerlerini sistem kapasitesine gore optimize et.
  - Bitis kriteri: Ortalama API tur suresi ve toplam sure duser.

- [x] `DC-03` HTTP keep-alive ve baglanti havuzu
  - Is: Baglanti tekrar kullanimini ac, uygun timeout/agent ayarlari yap.
  - Bitis kriteri: Baglanti kurulum overhead'i azalir.

- [x] `DC-04` Paralel detay cekimi kontrolu
  - Is: Detay endpoint cagrilarinda sinirli paralellik + backpressure uygula.
  - Bitis kriteri: Rate-limit yemeden throughput artar.

- [x] `DC-05` ETag/Last-Modified destegi
  - Is: Mumkun endpointlerde kosullu istek kullan (`If-None-Match`, `If-Modified-Since`).
  - Bitis kriteri: Degismeyen veride gereksiz payload inmez.

- [x] `DC-06` Gecici veri cache
  - Is: Kisa sureli (TTL) response cache ile ayni sorgunun tekrarini azalt.
  - Bitis kriteri: Tekrarlayan sorgularda cevap suresi anlamli duser.

- [x] `DC-07` DB index ve write optimizasyonu
  - Is: Sorgu yollarina uygun indexler, bulk upsert, write batching uygula.
  - Bitis kriteri: Yazma ve listeleme performansi artar.

- [x] `DC-08` Veri kalite ve dedupe pipeline
  - Is: Normalizasyon + unique key + conflict policy uygula.
  - Bitis kriteri: Tekrarlanan/kirli kayit orani duser.

- [x] `DC-09` Circuit breaker ve fail-fast
  - Is: Ardisik hata durumunda gecici durdurma + kontrollu geri acma ekle.
  - Bitis kriteri: Dis servis arizasinda sistem kendini korur.

- [x] `DC-10` Gozlemlenebilirlik (metrics + tracing)
  - Is: p50/p95 sure, hata tipleri, retry sayisi, queue length metriklerini topla.
  - Bitis kriteri: Darbogaz ve regresyonlar olculebilir hale gelir.

## P3 - Operasyon ve Izleme

- [x] `OPS-01` Dashboard
  - Is: Indirme ve veri cekim KPI'larini tek panelde goster.
  - Bitis kriteri: Operasyon ekibi canli durumu tek ekrandan takip eder.

- [x] `OPS-02` Alarm kurallari
  - Is: Hata orani, sure asimi, kuyruk birikmesi esikleri icin alarm tanimla.
  - Bitis kriteri: Kritik durumlar otomatik bildirilir.

- [x] `OPS-03` Performans regresyon testleri
  - Is: Haftalik benchmark senaryolari ile sure/hata trendini takip et.
  - Bitis kriteri: Yavaslama erkenden yakalanir.
