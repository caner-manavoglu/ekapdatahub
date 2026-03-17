# EKAP v2 Playwright Scriptleri

Bu proje, EKAP v2 kurul kararları ekranında tarih aralığına göre sonuçları tarayıp karar dosyalarını indirmek için iki ayrı Playwright scripti içerir.

- `ekap-playwright-mahkeme.js`
- `ekap-playwright-uyusmazlik.js`

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

node ekap-playwright-mahkeme.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=headless

node ekap-playwright-uyusmazlik.js --from=2026/02/01 --to=2026/02/15 --maxPages=50 --browserMode=visible

Belirli bir sayfa aralığı için:

node ekap-playwright-mahkeme.js --from=2026/02/01 --to=2026/02/15 --startPage=3 --endPage=7 --browserMode=headless

Kullanılabilir parametreler:

- `--from=`: Başlangıç tarihi (`YYYY/MM/DD`, `YYYY-MM-DD`, `DD.MM.YYYY`)
- `--to=`: Bitiş tarihi (`YYYY/MM/DD`, `YYYY-MM-DD`, `DD.MM.YYYY`)
- `--maxPages=`: En fazla taranacak sayfa sayısı
- `--startPage=`: İşleme başlanacak sayfa (varsayılan `1`)
- `--startRow=`: Başlangıç sayfasında başlanacak satır (resume/checkpoint için, varsayılan `1`)
- `--endPage=`: İşlenecek son sayfa (verilmezse `startPage + maxPages - 1`)
- `--dateInputIndex=`: Tarih input index'i (varsayılan `0`)
- `--timeoutRetries=`: `ERR_CONNECTION_TIMED_OUT` hatasında aynı satır için tekrar deneme sayısı (varsayılan `2`)
- `--retryBaseDelayMs=`: Retry başlangıç bekleme süresi (varsayılan `900`)
- `--retryMaxDelayMs=`: Retry üst sınır bekleme süresi (varsayılan `25000`)
- `--retryJitterRatio=`: Retry jitter oranı `0.0-1.0` (varsayılan `0.25`)
- `--browserMode=`: `headless` veya `visible`
- `--workerCount=`: Sayfa bazlı kuyruk worker sayısı (sadece belirli sayfa aralığında, varsayılan `1`)
- `--jobChunkSize=`: Kuyruktaki her işin kapsayacağı sayfa adedi (varsayılan `1`)
- `--adaptiveConcurrency=`: `true/false`, hata oranına göre worker havuzunu dinamik azalt/arttir (varsayılan `true`)
- `--contextResetAfterJobs=`: Worker başına kaç job sonra context reset (varsayılan `12`)
- `--contextResetAfterPages=`: Tek worker modunda kaç sayfa sonra context reset (varsayılan `20`)
- `--minDownloadBytes=`: İndirilen dosya minimum byte kontrolü (varsayılan `1024`)
- `--enforcePdfHeader=`: `%PDF` header doğrulaması (`true/false`, varsayılan `true`)
- `--apiFirstDownload=`: `true/false`, PDF indirmeyi once API request ile dener (varsayılan `true`)
- `--apiFirstStrict=`: `true/false`, API-first basarisiz olursa UI fallback yerine hataya duser (varsayılan `false`)
- `--checkpoint=`: Checkpoint mekanizmasını aç/kapat (`true/false`, varsayılan `true`)
- `--checkpointPath=`: Checkpoint dosya yolu
- `--resetCheckpoint=`: Çalışma başında checkpoint sıfırlansın mı (`true/false`, varsayılan `false`)
- `--userDataDir=`: Chrome kullanıcı profili yolu

Notlar:

- Geriye uyumluluk için eski `--headless=true|false` parametresi de çalışır.
- `--allPages=true` modunda worker havuzu devre dışı bırakılır ve tek worker ile devam edilir.
- `--startRow>1` iken satır bazlı resume nedeniyle worker havuzu devre dışı bırakılır.
- İndirme klasörleri:
- `mahkeme`: `indirilenler/mahkeme`
- `uyusmazlik`: `indirilenler/uyusmazlik`
- Checkpoint dosyası: `checkpoints/<type>-<from>-<to>.json`
- Duplicate kontrolü kapalıdır; aynı satırlar tekrar çalıştırmalarda yeniden indirilir.

API-first indirme notu:

- Script download butonunun POST/GET bilgisini popup sayfasindan cikarip dogrudan request ile PDF indirir.
- API-first basarisiz olursa (strict kapaliysa) UI click download fallback calisir.
- Bu model popup/download event kirilganligini ve toplam indirme suresini azaltir.
- Log satirinda `transport=api-first` veya `transport=ui-download` bilgisi gorunur.

## Timeout Retry Davranışı

`ERR_CONNECTION_TIMED_OUT` hatası alınırsa script aynı satırı atlamaz.

- Aynı satır için tekrar dener.
- Deneme sayısı `--timeoutRetries` ile yönetilir.
- Limit dolarsa bir sonraki satıra geçer.
- Backoff + jitter merkezi policy ile tüm kritik adımlarda tutarlı şekilde uygulanır.

## Örnekler

Tüm sayfalar, görünmez mod:

```bash
node ekap-playwright-uyusmazlik.js --from=2026/01/01 --to=2026/01/31 --maxPages=500 --browserMode=headless
```

Sadece ilk 3 sayfa, görünür mod:

```bash
node ekap-playwright-mahkeme.js --from=01.02.2026 --to=15.02.2026 --maxPages=3 --browserMode=visible
```

Belirli aralıkta worker havuzuyla:

```bash
node ekap-playwright-uyusmazlik.js --from=01.02.2026 --to=15.02.2026 --startPage=1 --endPage=20 --workerCount=3 --jobChunkSize=2 --browserMode=headless
```
