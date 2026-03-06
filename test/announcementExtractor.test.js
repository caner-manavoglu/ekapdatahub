const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractRequestedFields,
  buildSelectedSummaryText,
} = require("../src/announcementExtractor");

const sampleText = `
PLANLAMA VE FİZİBİLİTE VE YAPABİLİRLİK ETÜDLERİ DANIŞMANLIK HİZMETİ ALINACAKTIR
Meriç Ergene-Marmara Havzaları Master Planı danışmanlık hizmeti işi için, yeterli tecrübeye sahip adaylar teklif vermek üzere ön yeterlik başvurusuna davet edilmektedir. Ön yeterlik değerlendirmesi sonucu yeterliği tespit edilenler arasından adaylar teklif vermeye davet edilecektir.
İhale Kayıt Numarası (İKN):2025/2489049
1- İdarenin
1.1. Adı :ETÜT, PLANLAMA VE TAHSİSLER DAİRESİ BAŞKANLIĞI
1.2. Adresi :Mustafa Kemal Mahallesi Ankara
1.3. Telefon numarası :03124545280
2- İhalenin
2.1. Tarih ve saati :24.02.2026 11:00
3- İhale konusu hizmet alımının
3.1. Adı :Meriç Ergene-Marmara Havzaları Master Planı
3.2. Niteliği, türü ve miktarı :1 Adet rapor
3.3. Yapılacağı/teslim edileceği yer :Ankara
3.4. Süresi/teslim tarihi :1155 gün
3.5. İşe başlama tarihi :Sözleşmeden itibaren 5 gün
4.2.1. Adayın ihalenin yapıldığı yıldan önceki yıla ait yıl sonu bilançosu veya eşdeğer belgeleri:
Bu bölüm 4.2.1 içeriği.
4.2.2. İş hacmini gösteren belgeler:
Bu bölüm 4.2.2 içeriği.
4.3. Teknik yeteneğe ilişkin belgeler ve bu belgelerin taşıması gereken kriterler:
4.3.1. İş deneyim belgeleri:
Bu bölüm 4.3.1 içeriği.
4.3.2. Organizasyon yapısı ve personel durumuna ilişkin belgeler:
Bu bölüm 4.3.2 içeriği.
4.3.3. Kalite yönetim belgeleri:
Bu bölüm 4.3.3 içeriği.
4.4. Bu ihalede benzer iş olarak kabul edilecek işler:
4.4.1.Benzer iş açıklaması.
5- Beşinci paragraf.
6- Altıncı paragraf.
10- Onuncu paragraf.
12- On ikinci paragraf.
13- On üçüncü paragraf.
15- Diğer hususlar paragrafı.
`;

test("extractRequestedFields should extract selected fields", () => {
  const extracted = extractRequestedFields({
    cleanText: sampleText,
    ikn: "2025/2489049",
    ilanTarihi: "2026-01-16",
    baslik: "PLANLAMA VE FİZİBİLİTE VE YAPABİLİRLİK ETÜDLERİ DANIŞMANLIK HİZMETİ ALINACAKTIR",
  });

  assert.match(extracted.ihaleBasligi, /PLANLAMA VE FİZİBİLİTE/);
  assert.equal(extracted.ilanTarihi, "2026-01-16");
  assert.equal(extracted.ihaleKayitNumarasi, "2025/2489049");
  assert.match(extracted.idarenin.madde11Adi, /ETÜT/);
  assert.match(extracted.ihaleKonusuHizmetAlimi.madde32NiteligiTuruVeMiktari, /1 Adet/);
  assert.match(extracted.yeterlikVeKriterler.madde422IsHacminiGosterenBelgeler, /İş hacmini gösteren belgeler/i);
  assert.doesNotMatch(extracted.yeterlikVeKriterler.madde422IsHacminiGosterenBelgeler, /^\s*4\.2\.2/i);
  assert.match(extracted.yeterlikVeKriterler.madde43TeknikYetenegeIliskinBelgelerBasligi, /Teknik yeteneğe/i);
  assert.doesNotMatch(extracted.yeterlikVeKriterler.madde43TeknikYetenegeIliskinBelgelerBasligi, /^\s*4\.3/i);
  assert.match(extracted.digerMaddeler.madde15, /Diğer hususlar/);
  assert.doesNotMatch(extracted.digerMaddeler.madde15, /^\s*15\s*[-–—]/i);
});

test("buildSelectedSummaryText should produce compact text", () => {
  const extracted = extractRequestedFields({
    cleanText: sampleText,
    ikn: "2025/2489049",
    ilanTarihi: "2026-01-16",
    baslik: "PLANLAMA VE FİZİBİLİTE VE YAPABİLİRLİK ETÜDLERİ DANIŞMANLIK HİZMETİ ALINACAKTIR",
  });

  const summary = buildSelectedSummaryText(extracted);
  assert.match(summary, /İhale Başlığı:/);
  assert.match(summary, /İlan Tarihi:/);
  assert.match(summary, /4\.2\.1:/);
  assert.match(summary, /4\.3:/);
  assert.match(summary, /4\.4:/);
  assert.match(summary, /15:/);
  assert.doesNotMatch(summary, /4\.3 Başlık:/i);
  assert.doesNotMatch(summary, /4\.4 Başlık:/i);
  assert.doesNotMatch(summary, /4\.2\.1:\s*4\.2\.1/i);
  assert.doesNotMatch(summary, /4\.2\.2:\s*4\.2\.2/i);
  assert.doesNotMatch(summary, /4\.3\.1:\s*4\.3\.1/i);
  assert.doesNotMatch(summary, /4\.3 Başlık:\s*4\.3/i);
  assert.doesNotMatch(summary, /15:\s*15\s*[-–—]/i);
});
