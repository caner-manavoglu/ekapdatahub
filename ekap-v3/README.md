# EKAP v2 Selenium Scriptleri

Bu proje, EKAP v2 kurul kararları ekranında tarih aralığına göre sonuçları tarayıp karar dosyalarını indirmek için iki ayrı script içerir.

- `ekap-selenium-mahkeme.js`
- `ekap-selenium-uyusmazlik.js`

## Kurulum

```bash
npm install
```

## DİKKAT EDİLMESİ GEREKEN HUSUS

HATA ALINMASI DURUMUNDA LÜTFEN VSCODE VEYA DİĞER CODE DERLEYİCİYİ KAPATMAYIN.

## Hızlı Kullanım

Görünür Chrome ile:

```bash
npm run mahkeme:visible
npm run uyusmazlik:visible
```

Görünmez Chrome (headless) ile:

```bash
npm run mahkeme:headless
npm run uyusmazlik:headless
```

## Kolay Kullanım 

Scriptleri doğrudan `node` ile çalıştırıp parametre verebilirsiniz:

Eğer chrome sayfasının açılıp kapanması görmek isteniyor ise --browserMode=visible olarak belirtilmeli. 
Görünmesine ihtiyaç yoksa --browserMode=headless olarak çalıştırılmalı. Bu sayede uygulama arka planda çalışacak ve indirmeleri yapacaktır.

node ekap-selenium-mahkeme.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=headless

node ekap-selenium-uyusmazlik.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=visible

Kullanılabilir parametreler:

- `--from=`: Başlangıç tarihi (`YYYY/MM/DD`, `YYYY-MM-DD`, `DD.MM.YYYY`)
- `--to=`: Bitiş tarihi (`YYYY/MM/DD`, `YYYY-MM-DD`, `DD.MM.YYYY`)
- `--maxPages=`: En fazla taranacak sayfa sayısı
- `--dateInputIndex=`: Tarih input index'i (varsayılan `0`)
- `--timeoutRetries=`: `ERR_CONNECTION_TIMED_OUT` hatasında aynı satır için tekrar deneme sayısı (varsayılan `2`)
- `--browserMode=`: `headless` veya `visible`
- `--userDataDir=`: Chrome kullanıcı profili yolu

Notlar:

- Geriye uyumluluk için eski `--headless=true|false` parametresi de çalışır.
- İndirme klasörleri:
- `mahkeme`: `downloads-mahkeme`
- `uyusmazlik`: `downloads-uyusmazlik`

## Timeout Retry Davranışı

`ERR_CONNECTION_TIMED_OUT` hatası alınırsa script aynı satırı atlamaz.

- Aynı satır için tekrar dener.
- Deneme sayısı `--timeoutRetries` ile yönetilir.
- Limit dolarsa bir sonraki satıra geçer.

## Örnekler

Tüm sayfalar, görünmez mod:

```bash
node ekap-selenium-uyusmazlik.js --from=2026/01/01 --to=2026/01/31 --maxPages=500 --browserMode=headless
```

Sadece ilk 3 sayfa, görünür mod:

```bash
node ekap-selenium-mahkeme.js --from=01.02.2026 --to=15.02.2026 --maxPages=3 --browserMode=visible
```
