const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  writeTenderPdf,
  buildPdfFileName,
  buildIlanPdfFileName,
  renderIlanPdfBuffer,
} = require("../src/pdfWriter");

test("buildPdfFileName should sanitize forbidden characters", () => {
  const document = {
    ikn: "2026/271215",
    sourceIhaleId: "abc:def",
  };

  const fileName = buildPdfFileName(document);
  assert.doesNotMatch(fileName, /[\\/:*?"<>|]/);
  assert.match(fileName, /2026-271215/);
  assert.match(fileName, /abc-def/);
});

test("writeTenderPdf should create a pdf file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekap-pdf-test-"));
  const document = {
    _id: "row-1",
    sourceIhaleId: "row-1",
    ikn: "2026/271215",
    ihaleAdi: "Test Ihalesi",
    idareAdi: "Test Idare",
    ihaleDurum: "6",
    item: {
      ilanList: [
        {
          id: "ilan-1",
          baslik: "Test Baslik",
          ilanTarihi: "2026-02-26",
          veriHtmlCleanText: "Temiz metin satiri 1\nTemiz metin satiri 2",
        },
      ],
    },
  };

  const pdfPath = await writeTenderPdf(document, { outputDir: tempDir });

  assert.equal(fs.existsSync(pdfPath), true);
  const stat = fs.statSync(pdfPath);
  assert.ok(stat.size > 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("buildIlanPdfFileName should sanitize forbidden characters", () => {
  const fileName = buildIlanPdfFileName({
    ikn: "2026/271215",
    ilanBaslik: "Siber Güvenlik: Hizmeti / Alımı",
    kind: "selected",
    ilanIndex: 1,
  });

  assert.doesNotMatch(fileName, /[\\/:*?"<>|]/);
  assert.match(fileName, /2026-271215/);
  assert.match(fileName, /secili-alanlar/);
});

test("renderIlanPdfBuffer should create a non-empty pdf buffer", async () => {
  const buffer = await renderIlanPdfBuffer({
    ikn: "2026/271215",
    ihaleAdi: "Test Ihalesi",
    idareAdi: "Test Idare",
    ihaleDurum: "2",
    ilanIndex: 0,
    ilanBaslik: "Test Baslik",
    ilanTarihi: "2026-02-26",
    kind: "full",
    contentText: "Tam metin satiri 1\nTam metin satiri 2",
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
});
