const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

function sanitizeForFilename(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildPdfFileName(document) {
  const safeIkn = sanitizeForFilename(document.ikn || "ikn-yok");
  const safeId = sanitizeForFilename(document.sourceIhaleId || document._id || "id-yok").slice(0, 16);
  return `${safeIkn || "ikn-yok"}--${safeId || "id-yok"}.pdf`;
}

function buildIlanPdfFileName({ ikn, ilanBaslik, kind, ilanIndex = 0 }) {
  const safeIkn = sanitizeForFilename(ikn || "ikn-yok");
  const safeBaslik = sanitizeForFilename(ilanBaslik || "ilan").slice(0, 56);
  const safeKind = kind === "selected" ? "secili-alanlar" : "tam-metin";
  const safeIndex = Number.isInteger(ilanIndex) && ilanIndex >= 0 ? ilanIndex + 1 : 1;
  return `${safeIkn || "ikn-yok"}--ilan-${safeIndex}--${safeBaslik || "ilan"}--${safeKind}.pdf`;
}

function ensureDirectoryExists(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function normalizedText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function resolvePdfFontPath(customFontPath) {
  const candidates = [
    customFontPath,
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function renderIlanPdfBuffer(
  {
    ikn,
    ihaleAdi,
    idareAdi,
    ihaleDurum,
    ilanIndex = 0,
    ilanBaslik,
    ilanTarihi,
    kind = "full",
    contentText,
  },
  { fontPath = "" } = {},
) {
  const normalizedContent = normalizedText(contentText);
  const contentLabel = kind === "selected" ? "Secili Alanlar" : "Tam Metin";
  const selectedFontPath = resolvePdfFontPath(fontPath);

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 40,
      info: {
        Title: ilanBaslik || ihaleAdi || "EKAP Ihale PDF",
        Author: "EKAP Scraper",
        Subject: ikn || "Ihale",
      },
    });

    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));

    if (selectedFontPath) {
      // Use a Unicode-capable font so Turkish characters are preserved.
      pdf.font(selectedFontPath);
    }

    pdf.fontSize(16).text(ilanBaslik || ihaleAdi || "Ilan Basligi Yok");
    pdf.moveDown(0.4);
    pdf.fontSize(11).text(`IKN: ${ikn || "-"}`);
    pdf.fontSize(11).text(`Ihale: ${ihaleAdi || "-"}`);
    pdf.fontSize(11).text(`Idare: ${idareAdi || "-"}`);
    pdf.fontSize(11).text(`Ihale Durum: ${ihaleDurum || "-"}`);
    pdf.fontSize(11).text(`Ilan No: ${Number.isInteger(ilanIndex) ? ilanIndex + 1 : 1}`);
    pdf.fontSize(11).text(`Ilan Tarihi: ${ilanTarihi || "-"}`);
    pdf.fontSize(11).text(`PDF Turu: ${contentLabel}`);
    pdf.fontSize(11).text(`Olusturma Zamani: ${new Date().toISOString()}`);

    pdf.moveDown(0.8);
    pdf.fontSize(13).text(contentLabel);
    pdf.moveDown(0.3);
    pdf.fontSize(10).text(normalizedContent || "Icerik bulunamadi.", {
      align: "left",
    });

    pdf.end();
  });
}

async function writeTenderPdf(document, { outputDir, fontPath = "" }) {
  ensureDirectoryExists(outputDir);

  const fileName = buildPdfFileName(document);
  const filePath = path.join(outputDir, fileName);

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: 40,
      info: {
        Title: document.ihaleAdi || "EKAP Ihale",
        Author: "EKAP Scraper",
        Subject: document.ikn || "Ihale",
      },
    });

    const stream = fs.createWriteStream(filePath);
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);

    pdf.on("error", reject);
    pdf.pipe(stream);

    const selectedFontPath = resolvePdfFontPath(fontPath);
    if (selectedFontPath) {
      // Use a Unicode-capable font so Turkish characters are preserved.
      pdf.font(selectedFontPath);
    }

    pdf.fontSize(16).text(document.ihaleAdi || "Ihale Basligi Yok");
    pdf.moveDown(0.5);
    pdf.fontSize(11).text(`IKN: ${document.ikn || "-"}`);
    pdf.fontSize(11).text(`Ihale ID: ${document.sourceIhaleId || "-"}`);
    pdf.fontSize(11).text(`Idare: ${document.idareAdi || "-"}`);
    pdf.fontSize(11).text(`Ihale Durum: ${document.ihaleDurum || "-"}`);
    pdf.fontSize(11).text(`Olusturma Zamani: ${new Date().toISOString()}`);

    const ilanList = Array.isArray(document?.item?.ilanList) ? document.item.ilanList : [];

    pdf.moveDown(0.8);
    pdf.fontSize(13).text(`Ilan Sayisi: ${ilanList.length}`);

    ilanList.forEach((ilan, index) => {
      pdf.moveDown(0.8);
      pdf.fontSize(12).text(`Ilan ${index + 1}`);
      pdf.fontSize(10).text(`Ilan ID: ${ilan?.id || "-"}`);
      pdf.fontSize(10).text(`Baslik: ${ilan?.baslik || "-"}`);
      pdf.fontSize(10).text(`Ilan Tarihi: ${ilan?.ilanTarihi || "-"}`);
      pdf.moveDown(0.3);

      const selectedSummaryText = normalizedText(ilan?.secilenAlanlarMetin);
      const fallbackCleanText = normalizedText(ilan?.veriHtmlCleanText);
      const contentText = selectedSummaryText || fallbackCleanText;

      if (contentText) {
        pdf.fontSize(10).text(contentText, {
          align: "left",
        });
      } else {
        pdf.fontSize(10).text("Icerik bos");
      }
    });

    pdf.end();
  });
}

module.exports = {
  writeTenderPdf,
  buildPdfFileName,
  buildIlanPdfFileName,
  renderIlanPdfBuffer,
  sanitizeForFilename,
};
