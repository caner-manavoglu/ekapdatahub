function cleanExtract(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const cleaned = String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s:–-]+/, "")
    .trim();

  return cleaned || null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSectionPrefix(label) {
  const match = String(label || "").match(/^(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

function stripLeadingSectionPrefix(value, label) {
  let text = cleanExtract(value);
  if (!text) {
    return null;
  }

  const sectionPrefix = extractSectionPrefix(label);
  if (sectionPrefix) {
    const sectionRegex = new RegExp(
      `^(?:${escapeRegex(sectionPrefix)}\\.?\\s*[:\\-–—]?\\s*){1,3}`,
      "i",
    );
    text = text.replace(sectionRegex, "");
  }

  return cleanExtract(text);
}

function extractByRegex(text, regex) {
  const match = text.match(regex);
  if (!match) {
    return null;
  }

  if (match.length > 1) {
    return cleanExtract(match[1]);
  }

  return cleanExtract(match[0]);
}

function findFirstMatchIndex(text, regexList, afterIndex = -1) {
  let minIndex = -1;
  let matchLength = 0;

  for (const regex of regexList) {
    const match = regex.exec(text);
    if (!match) {
      continue;
    }

    if (match.index <= afterIndex) {
      continue;
    }

    if (minIndex === -1 || match.index < minIndex) {
      minIndex = match.index;
      matchLength = match[0].length;
    }
  }

  return { index: minIndex, length: matchLength };
}

function captureBlock(text, startRegexList, endRegexList, removeStartMatch = false) {
  const start = findFirstMatchIndex(text, startRegexList);
  if (start.index < 0) {
    return null;
  }

  const end = findFirstMatchIndex(text, endRegexList, start.index + 1);
  const from = removeStartMatch ? start.index + start.length : start.index;
  const to = end.index >= 0 ? end.index : text.length;

  return cleanExtract(text.slice(from, to));
}

function captureParagraphByNumber(text, sectionNumber, nextSections) {
  const startRegexes = [
    new RegExp(`(?:^|\\n)\\s*${sectionNumber}\\s*[-–—]\\s*`, "i"),
    new RegExp(`\\b${sectionNumber}\\s*[-–—]\\s*`, "i"),
  ];

  const endRegexes = nextSections.flatMap((next) => [
    new RegExp(`(?:^|\\n)\\s*${next}\\s*[-–—]\\s*`, "i"),
    new RegExp(`\\b${next}\\s*[-–—]\\s*`, "i"),
  ]);

  return captureBlock(text, startRegexes, endRegexes, true);
}

function extractLawSentence(text, baslik) {
  const direct = extractByRegex(text, /([^\n]*4734 sayılı Kamu İhale Kanununun[^.]*\.)/i);
  if (direct) {
    return direct;
  }

  const stopIndexCandidates = [
    text.search(/İhale Kayıt Numarası\s*\(İKN\)/i),
    text.search(/(?:^|\n)\s*1\s*[-–—]\s*İdarenin/i),
  ].filter((index) => index >= 0);

  const stopIndex = stopIndexCandidates.length > 0 ? Math.min(...stopIndexCandidates) : text.length;
  let chunk = text.slice(0, stopIndex);

  if (baslik) {
    const normalizedTitle = String(baslik).trim();
    const titleIndex = chunk.indexOf(normalizedTitle);
    if (titleIndex >= 0) {
      chunk = chunk.slice(titleIndex + normalizedTitle.length);
    }
  }

  chunk = chunk.replace(/İhaleye ilişkin ayrıntılı bilgiler[\s\S]*$/i, "").trim();
  const firstSentence = extractByRegex(chunk.replace(/\n+/g, " "), /(.+?\.)/);
  return firstSentence;
}

function extractRequestedFields({ cleanText, ikn, ilanTarihi, baslik, ihaleAdi }) {
  const text = cleanExtract(cleanText) || "";
  const ihaleBasligi = cleanExtract(ihaleAdi) || cleanExtract(baslik);

  const ihaleKayitNumarasi =
    cleanExtract(ikn) ||
    extractByRegex(text, /İhale Kayıt Numarası\s*\(İKN\)\s*:?\s*([0-9]{4}\/[0-9]+)/i);

  const lawSentence = extractLawSentence(text, baslik);

  const idareAdi = extractByRegex(
    text,
    /1\.1\.\s*Ad[ıi]\s*:?\s*([\s\S]*?)(?=1\.2\.|1\.2\s|$)/i,
  );
  const idareAdresi = extractByRegex(
    text,
    /1\.2\.\s*Adresi\s*:?\s*([\s\S]*?)(?=1\.3\.|1\.3\s|$)/i,
  );
  const idareTelefon = extractByRegex(
    text,
    /1\.3\.\s*Telefon(?:\s*numaras[ıi])?\s*:?\s*([\s\S]*?)(?=1\.4\.|2\.1\.|2\s*[-–—]|$)/i,
  );

  const ihaleTarihSaat = extractByRegex(
    text,
    /2\.1\.\s*Tarih(?:i)?(?:\s*ve\s*saati)?\s*:?\s*([\s\S]*?)(?=2\.2\.|3\.1\.|3\s*[-–—]|$)/i,
  );

  const hizmetAdi = extractByRegex(
    text,
    /3\.1\.?\s*Ad[ıi]\s*:?\s*([\s\S]*?)(?=3\.2\.|3\.2\s|$)/i,
  );
  const hizmetNitelik = extractByRegex(
    text,
    /3\.2\.\s*Niteliği,\s*türü\s*ve\s*miktarı\s*:?\s*([\s\S]*?)(?=3\.3\.|3\.3\s|$)/i,
  );
  const hizmetYer = extractByRegex(
    text,
    /3\.3\.\s*Yapılacağı\/teslim edileceği yer\s*:?\s*([\s\S]*?)(?=3\.4\.|3\.4\s|$)/i,
  );
  const hizmetSureTeslim = extractByRegex(
    text,
    /3\.4\.\s*Süresi(?:\/teslim tarihi)?\s*:?\s*([\s\S]*?)(?=3\.5\.|3\.5\s|$)/i,
  );
  const hizmetIseBaslama = extractByRegex(
    text,
    /3\.5\.\s*İşe başlama tarihi\s*:?\s*([\s\S]*?)(?=4\.|4\s*[-–—]|$)/i,
  );

  const madde421 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.2\.1\.?\s*`, "i")],
    [new RegExp(String.raw`(?:^|\n)\s*4\.2\.2\.?\s*`, "i")],
    true,
  );

  const madde422 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.2\.2\.?\s*`, "i")],
    [new RegExp(String.raw`(?:^|\n)\s*4\.3\.?\s*`, "i")],
    true,
  );

  const baslik43 = extractByRegex(
    text,
    /(?:^|\n)\s*4\.3\.?\s*([^\n]*Teknik yeteneğe ilişkin belgeler[^\n]*)/i,
  );

  const madde431 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.3\.1\.?\s*`, "i")],
    [new RegExp(String.raw`(?:^|\n)\s*4\.3\.2\.?\s*`, "i")],
    true,
  );

  const madde432 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.3\.2\.?\s*`, "i")],
    [
      new RegExp(String.raw`(?:^|\n)\s*4\.3\.3\.?\s*`, "i"),
      new RegExp(String.raw`(?:^|\n)\s*4\.4\.?\s*`, "i"),
    ],
    true,
  );

  const madde433 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.3\.3\.?\s*`, "i")],
    [new RegExp(String.raw`(?:^|\n)\s*4\.4\.?\s*`, "i")],
    true,
  );

  const baslik44 = extractByRegex(
    text,
    /(?:^|\n)\s*4\.4\.?\s*([^\n]*Bu ihalede benzer iş olarak kabul edilecek işler[^\n]*)/i,
  );

  const madde441 = captureBlock(
    text,
    [new RegExp(String.raw`(?:^|\n)\s*4\.4\.1\.?\s*`, "i")],
    [new RegExp(String.raw`(?:^|\n)\s*5\s*[-–—]\s*`, "i")],
    true,
  );

  const madde5 = captureParagraphByNumber(text, "5", ["6"]);
  const madde6 = captureParagraphByNumber(text, "6", ["7", "8", "9", "10"]);
  const madde10 = captureParagraphByNumber(text, "10", ["11", "12"]);
  const madde12 = captureParagraphByNumber(text, "12", ["13"]);
  const madde13 = captureParagraphByNumber(text, "13", ["14", "15"]);
  const madde15 = captureParagraphByNumber(text, "15", ["16"]);

  return {
    ihaleBasligi,
    ilanTarihi: cleanExtract(ilanTarihi),
    kanunMaddesiCumlesi: lawSentence,
    ihaleKayitNumarasi,
    idarenin: {
      madde11Adi: idareAdi,
      madde12Adresi: idareAdresi,
      madde13TelefonNumarasi: idareTelefon,
    },
    ihalenin: {
      madde21TarihVeSaati: ihaleTarihSaat,
    },
    ihaleKonusuHizmetAlimi: {
      madde31Adi: hizmetAdi,
      madde32NiteligiTuruVeMiktari: hizmetNitelik,
      madde33YapilacagiTeslimEdilecegiYer: hizmetYer,
      madde34SuresiTeslimTarihi: hizmetSureTeslim,
      madde35IseBaslamaTarihi: hizmetIseBaslama,
    },
    yeterlikVeKriterler: {
      madde421AdayinBilancoKismi: madde421,
      madde422IsHacminiGosterenBelgeler: madde422,
      madde43TeknikYetenegeIliskinBelgelerBasligi: baslik43,
      madde431: madde431,
      madde432: madde432,
      madde433: madde433,
      madde44BenzerIsBasligi: baslik44,
      madde441: madde441,
    },
    digerMaddeler: {
      madde5: madde5,
      madde6: madde6,
      madde10: madde10,
      madde12: madde12,
      madde13: madde13,
      madde15: madde15,
    },
  };
}

function buildSelectedSummaryText(selected) {
  if (!selected || typeof selected !== "object") {
    return "";
  }

  const lines = [];

  const push = (label, value) => {
    const cleanValue = stripLeadingSectionPrefix(value, label);
    if (cleanValue) {
      lines.push(`${label}: ${cleanValue}`);
    }
  };

  push("İhale Başlığı", selected.ihaleBasligi);
  push("İlan Tarihi", selected.ilanTarihi);
  push("Kanun Cümlesi", selected.kanunMaddesiCumlesi);
  push("İhale Kayıt Numarası", selected.ihaleKayitNumarasi);
  push("1.1 Adı", selected.idarenin?.madde11Adi);
  push("1.2 Adresi", selected.idarenin?.madde12Adresi);
  push("1.3 Telefon", selected.idarenin?.madde13TelefonNumarasi);
  push("2.1 Tarih ve Saati", selected.ihalenin?.madde21TarihVeSaati);
  push("3.1 Adı", selected.ihaleKonusuHizmetAlimi?.madde31Adi);
  push("3.2 Niteliği Türü Miktarı", selected.ihaleKonusuHizmetAlimi?.madde32NiteligiTuruVeMiktari);
  push("3.3 Yapılacağı Yer", selected.ihaleKonusuHizmetAlimi?.madde33YapilacagiTeslimEdilecegiYer);
  push("3.4 Süresi", selected.ihaleKonusuHizmetAlimi?.madde34SuresiTeslimTarihi);
  push("3.5 İşe Başlama", selected.ihaleKonusuHizmetAlimi?.madde35IseBaslamaTarihi);
  push("4.2.1", selected.yeterlikVeKriterler?.madde421AdayinBilancoKismi);
  push("4.2.2", selected.yeterlikVeKriterler?.madde422IsHacminiGosterenBelgeler);
  push("4.3", selected.yeterlikVeKriterler?.madde43TeknikYetenegeIliskinBelgelerBasligi);
  push("4.3.1", selected.yeterlikVeKriterler?.madde431);
  push("4.3.2", selected.yeterlikVeKriterler?.madde432);
  push("4.3.3", selected.yeterlikVeKriterler?.madde433);
  push("4.4", selected.yeterlikVeKriterler?.madde44BenzerIsBasligi);
  push("4.4.1", selected.yeterlikVeKriterler?.madde441);
  push("5", selected.digerMaddeler?.madde5);
  push("6", selected.digerMaddeler?.madde6);
  push("10", selected.digerMaddeler?.madde10);
  push("12", selected.digerMaddeler?.madde12);
  push("13", selected.digerMaddeler?.madde13);
  push("15", selected.digerMaddeler?.madde15);

  return lines.join("\n\n");
}

module.exports = {
  extractRequestedFields,
  buildSelectedSummaryText,
};
