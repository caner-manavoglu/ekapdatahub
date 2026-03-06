const path = require("path");
const express = require("express");
const { MongoClient } = require("mongodb");
const config = require("../config");
const { runScraper } = require("../scraper");
const { buildSelectedSummaryText } = require("../announcementExtractor");
const { cleanVeriHtml } = require("../htmlCleaner");
const { buildIlanPdfFileName, renderIlanPdfBuffer } = require("../pdfWriter");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const WEB_PORT = Number.parseInt(process.env.WEB_PORT || "8787", 10);
const SCRAPE_TIMEZONE = "Europe/Istanbul";
const DELETE_CONFIRMATION_TEXT = "onaylıyorum";

let mongoClient;
let collection;
const scrapeState = {
  running: false,
  stopRequested: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastResult: null,
  lastError: null,
  currentRunOptions: null,
  logs: [],
};

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendScrapeLog(entry) {
  scrapeState.logs.push(entry);
  if (scrapeState.logs.length > 300) {
    scrapeState.logs.shift();
  }
}

function parseScrapeOptions(body) {
  const options = {};
  const payload = body && typeof body === "object" ? body : {};
  const pageSize =
    payload.pageSize !== undefined
      ? Math.max(1, toInt(payload.pageSize, config.pageSize))
      : config.pageSize;

  options.pageSize = pageSize;

  if (payload.maxPages !== undefined) {
    options.maxPages = Math.max(0, toInt(payload.maxPages, config.maxPages));
  }

  if (payload.startSkip !== undefined) {
    options.startSkip = Math.max(0, toInt(payload.startSkip, config.startSkip));
  }

  if (payload.startPage !== undefined || payload.endPage !== undefined) {
    const startPage = Math.max(1, toInt(payload.startPage, 1));
    const endPage = Math.max(startPage, toInt(payload.endPage, startPage));
    options.startSkip = (startPage - 1) * pageSize;
    options.maxPages = endPage - startPage + 1;
    options.pageRange = {
      startPage,
      endPage,
    };
  }

  if (payload.dryRun !== undefined) {
    options.dryRun = Boolean(payload.dryRun);
  }

  if (payload.generatePdf !== undefined) {
    options.generatePdf = Boolean(payload.generatePdf);
  }

  if (payload.storeFullIlanContent !== undefined) {
    options.storeFullIlanContent = Boolean(payload.storeFullIlanContent);
  }

  return options;
}

function fallbackText(...values) {
  for (const value of values) {
    const normalized = cleanText(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function sanitizeSelectedSummaryText(text) {
  const normalized = cleanText(text);
  if (!normalized) {
    return "";
  }

  return normalized
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(":")) {
        return line;
      }

      const separatorIndex = line.indexOf(":");
      const label = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();
      const prefixMatch = label.match(/^(\d+(?:\.\d+)*)/);

      if (prefixMatch) {
        const prefix = escapeRegex(prefixMatch[1]);
        const prefixRegex = new RegExp(`^(?:${prefix}\\.?\\s*[:\\-–—]?\\s*){1,3}`, "i");
        value = value.replace(prefixRegex, "").trim();
      }

      return `${label}: ${value}`;
    })
    .join("\n");
}

function normalizeConfirmation(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
}

function parseDateRange(dateKey) {
  const normalizedDateKey = String(dateKey || "").trim();
  if (!isValidDateKey(normalizedDateKey)) {
    return null;
  }

  const start = new Date(`${normalizedDateKey}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function toIlanViewModel(ilan, rawIlan) {
  const raw = rawIlan || {};
  const compact = ilan || {};
  const secilenAlanlar = compact?.secilenAlanlar || raw?.secilenAlanlar || null;

  const tamHtml =
    compact?.dokumantasyon?.tamHtml ||
    compact?.veriHtml ||
    raw?.veriHtml ||
    null;

  const temizHtml =
    compact?.dokumantasyon?.temizHtml ||
    compact?.veriHtmlCleanHtml ||
    raw?.veriHtmlCleanHtml ||
    null;

  const temizText = fallbackText(
    compact?.dokumantasyon?.temizText,
    compact?.veriHtmlCleanText,
    raw?.veriHtmlCleanText,
  );

  const secilenAlanlarMetin = fallbackText(
    buildSelectedSummaryText(secilenAlanlar),
    sanitizeSelectedSummaryText(compact?.secilenAlanlarMetin),
    sanitizeSelectedSummaryText(raw?.secilenAlanlarMetin),
  );

  return {
    id: compact?.id || raw?.id || null,
    baslik: compact?.baslik || raw?.baslik || null,
    ilanTarihi: compact?.ilanTarihi || raw?.ilanTarihi || null,
    secilenAlanlar,
    secilenAlanlarMetin,
    dokumantasyon: {
      tamHtml,
      temizHtml,
      temizText,
    },
  };
}

function toTenderViewModel(doc) {
  const compactIlanList = Array.isArray(doc?.item?.ilanList) ? doc.item.ilanList : [];
  const rawIlanList = Array.isArray(doc?.raw?.item?.ilanList) ? doc.raw.item.ilanList : [];

  const ilanList =
    compactIlanList.length > 0
      ? compactIlanList.map((ilan, index) => toIlanViewModel(ilan, rawIlanList[index]))
      : rawIlanList.map((ilan) => toIlanViewModel(ilan, ilan));

  return {
    _id: doc?._id || null,
    ikn: doc?.ikn || null,
    ihaleAdi: doc?.ihaleAdi || null,
    idareAdi: doc?.idareAdi || null,
    ihaleDurum: doc?.ihaleDurum || null,
    ihaleBilgi: doc?.ihaleBilgi || doc?.item?.ihaleBilgi || null,
    listRow: doc?.listRow || null,
    stats: doc?.stats || {
      ilanCount: ilanList.length,
    },
    updatedAt: doc?.updatedAt || null,
    createdAt: doc?.createdAt || null,
    ilanList,
  };
}

function toListItem(doc) {
  const compactIlan = Array.isArray(doc?.item?.ilanList) ? doc.item.ilanList[0] : null;
  const rawIlan = Array.isArray(doc?.raw?.item?.ilanList) ? doc.raw.item.ilanList[0] : null;
  const ilan = toIlanViewModel(compactIlan || rawIlan, rawIlan || compactIlan);

  const preview = fallbackText(
    ilan?.secilenAlanlarMetin,
    ilan?.dokumantasyon?.temizText,
  ).slice(0, 280);

  return {
    _id: doc?._id || null,
    ikn: doc?.ikn || null,
    ihaleAdi: doc?.ihaleAdi || null,
    idareAdi: doc?.idareAdi || null,
    ihaleDurum: doc?.ihaleDurum || null,
    ilanTarihi: ilan?.ilanTarihi || null,
    ilkIlanBaslik: ilan?.baslik || null,
    preview,
    updatedAt: doc?.updatedAt || null,
    stats: doc?.stats || null,
  };
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "ekap-web", timestamp: new Date().toISOString() });
});

app.get("/api/scrape/status", (_, res) => {
  res.json({
    data: {
      running: scrapeState.running,
      stopRequested: scrapeState.stopRequested,
      lastRunStartedAt: scrapeState.lastRunStartedAt,
      lastRunFinishedAt: scrapeState.lastRunFinishedAt,
      lastResult: scrapeState.lastResult,
      lastError: scrapeState.lastError,
      currentRunOptions: scrapeState.currentRunOptions,
      logs: scrapeState.logs,
    },
  });
});

app.post("/api/scrape/run", (req, res) => {
  if (scrapeState.running) {
    res.status(409).json({
      error: "Scrape işlemi zaten çalışıyor.",
      data: {
        running: true,
        stopRequested: scrapeState.stopRequested,
        lastRunStartedAt: scrapeState.lastRunStartedAt,
      },
    });
    return;
  }

  const scrapeOptions = parseScrapeOptions(req.body);

  scrapeState.running = true;
  scrapeState.stopRequested = false;
  scrapeState.lastRunStartedAt = new Date().toISOString();
  scrapeState.lastRunFinishedAt = null;
  scrapeState.lastResult = null;
  scrapeState.lastError = null;
  scrapeState.currentRunOptions = scrapeOptions;
  scrapeState.logs = [];

  void (async () => {
    try {
      const result = await runScraper({
        ...scrapeOptions,
        onLog: (entry) => appendScrapeLog(entry),
        shouldStop: () => scrapeState.stopRequested,
      });

      scrapeState.lastResult = result;
    } catch (error) {
      scrapeState.lastError = error?.message || String(error);
      appendScrapeLog({
        level: "error",
        message: `[WEB_ERROR] ${scrapeState.lastError}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      scrapeState.running = false;
      scrapeState.stopRequested = false;
      scrapeState.lastRunFinishedAt = new Date().toISOString();
      scrapeState.currentRunOptions = null;
    }
  })();

  res.status(202).json({
    data: {
      running: true,
      stopRequested: false,
      startedAt: scrapeState.lastRunStartedAt,
      currentRunOptions: scrapeOptions,
    },
  });
});

app.post("/api/scrape/stop", (req, res) => {
  if (!scrapeState.running) {
    res.status(409).json({
      error: "Çalışan bir scrape işlemi yok.",
      data: {
        running: false,
      },
    });
    return;
  }

  scrapeState.stopRequested = true;
  appendScrapeLog({
    level: "warn",
    message: "[STOP] Durdurma isteği alındı. İşlem uygun noktada sonlandırılacak.",
    timestamp: new Date().toISOString(),
  });

  res.json({
    data: {
      running: true,
      stopRequested: true,
      lastRunStartedAt: scrapeState.lastRunStartedAt,
    },
  });
});

app.get("/api/tenders", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const filter = {};
    if (q) {
      const safeQ = escapeRegex(q);
      filter.$or = [
        { ikn: { $regex: safeQ, $options: "i" } },
        { ihaleAdi: { $regex: safeQ, $options: "i" } },
        { idareAdi: { $regex: safeQ, $options: "i" } },
      ];
    }

    const projection = {
      _id: 1,
      ikn: 1,
      ihaleAdi: 1,
      idareAdi: 1,
      ihaleDurum: 1,
      updatedAt: 1,
      stats: 1,
      "item.ilanList": { $slice: 1 },
      "raw.item.ilanList": { $slice: 1 },
    };

    const [total, rows] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(projection)
        .sort({ updatedAt: 1, createdAt: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    const data = rows.map(toListItem);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tenders/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "Geçersiz id" });
      return;
    }

    const doc = await collection.findOne({ _id: id });
    if (!doc) {
      res.status(404).json({ error: "Kayıt bulunamadı" });
      return;
    }

    res.json({ data: toTenderViewModel(doc) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tenders/:id/pdf", async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "Geçersiz id" });
      return;
    }

    const kindRaw = String(req.query.kind || "full").trim().toLowerCase();
    const kind = kindRaw === "selected" ? "selected" : kindRaw === "full" ? "full" : "";
    if (!kind) {
      res.status(400).json({ error: "Geçersiz PDF türü. full veya selected olmalı." });
      return;
    }

    const ilanIndex = Math.max(0, toInt(req.query.ilanIndex, 0));
    const doc = await collection.findOne({ _id: id });
    if (!doc) {
      res.status(404).json({ error: "Kayıt bulunamadı" });
      return;
    }

    const tender = toTenderViewModel(doc);
    const ilanList = Array.isArray(tender?.ilanList) ? tender.ilanList : [];

    if (ilanList.length === 0) {
      res.status(404).json({ error: "İlana ait doküman bulunamadı." });
      return;
    }

    if (ilanIndex >= ilanList.length) {
      res.status(400).json({ error: "Geçersiz ilan index." });
      return;
    }

    const ilan = ilanList[ilanIndex];
    const fullText = fallbackText(
      ilan?.dokumantasyon?.temizText,
      cleanVeriHtml(ilan?.dokumantasyon?.tamHtml || "").cleanText,
    );
    const selectedText = fallbackText(
      ilan?.secilenAlanlarMetin,
      buildSelectedSummaryText(ilan?.secilenAlanlar || null),
    );

    const contentText = kind === "selected" ? selectedText : fullText;

    const pdfBuffer = await renderIlanPdfBuffer(
      {
        ikn: tender?.ikn || null,
        ihaleAdi: tender?.ihaleAdi || null,
        idareAdi: tender?.idareAdi || null,
        ihaleDurum: tender?.ihaleDurum || null,
        ilanIndex,
        ilanBaslik: ilan?.baslik || null,
        ilanTarihi: ilan?.ilanTarihi || null,
        kind,
        contentText,
      },
      { fontPath: config.pdfFontPath },
    );

    const fileName = buildIlanPdfFileName({
      ikn: tender?.ikn,
      ilanBaslik: ilan?.baslik || tender?.ihaleAdi,
      kind,
      ilanIndex,
    });
    const asciiFileName = fileName
      .replace(/[^ -~]/g, "-")
      .replace(/"/g, "")
      .replace(/;+/g, "-");
    const encodedFileName = encodeURIComponent(fileName);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
    );
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

app.get("/api/downloads/dates", async (_, res, next) => {
  try {
    const rows = await collection
      .aggregate([
        {
          $addFields: {
            scrapeTimestamp: { $ifNull: ["$updatedAt", "$createdAt"] },
          },
        },
        {
          $match: {
            scrapeTimestamp: { $type: "date" },
          },
        },
        {
          $project: {
            _id: 0,
            date: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$scrapeTimestamp",
                timezone: SCRAPE_TIMEZONE,
              },
            },
          },
        },
        {
          $group: {
            _id: "$date",
            count: { $sum: 1 },
          },
        },
        {
          $sort: { _id: -1 },
        },
      ])
      .toArray();

    res.json({
      data: rows.map((item) => ({
        date: item._id,
        count: item.count || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/downloads", async (req, res, next) => {
  try {
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 50)));
    const skip = (page - 1) * limit;
    const q = String(req.query.q || "").trim();
    const date = String(req.query.date || "").trim();

    const filter = {};
    if (q) {
      const safeQ = escapeRegex(q);
      filter.$or = [
        { ikn: { $regex: safeQ, $options: "i" } },
        { ihaleAdi: { $regex: safeQ, $options: "i" } },
        { idareAdi: { $regex: safeQ, $options: "i" } },
      ];
    }

    if (date) {
      const range = parseDateRange(date);
      if (!range) {
        res.status(400).json({ error: "Geçersiz tarih formatı. YYYY-MM-DD bekleniyor." });
        return;
      }

      filter.updatedAt = {
        $gte: range.start,
        $lt: range.end,
      };
    }

    const projection = {
      _id: 1,
      ikn: 1,
      ihaleAdi: 1,
      idareAdi: 1,
      ihaleDurum: 1,
      updatedAt: 1,
      stats: 1,
      "item.ilanList": { $slice: 1 },
      "raw.item.ilanList": { $slice: 1 },
    };

    const [total, rows] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter)
        .project(projection)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    const data = rows.map(toListItem);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        date: date || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/downloads/delete", async (req, res, next) => {
  try {
    if (scrapeState.running) {
      res.status(409).json({ error: "Scrape çalışırken silme yapılamaz." });
      return;
    }

    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const mode = String(payload.mode || "").trim();
    const confirmation = normalizeConfirmation(payload.confirmation);

    if (confirmation !== DELETE_CONFIRMATION_TEXT) {
      res.status(400).json({
        error: `"${DELETE_CONFIRMATION_TEXT}" yazmadan silme işlemi yapılamaz.`,
      });
      return;
    }

    if (mode === "selected") {
      const idsRaw = Array.isArray(payload.ids) ? payload.ids : [];
      const ids = [...new Set(idsRaw.map((id) => String(id || "").trim()).filter(Boolean))];

      if (ids.length === 0) {
        res.status(400).json({ error: "Silme için en az bir kayıt seçilmelidir." });
        return;
      }

      const result = await collection.deleteMany({
        _id: { $in: ids },
      });

      res.json({
        data: {
          mode,
          deletedCount: result.deletedCount || 0,
        },
      });
      return;
    }

    if (mode === "byDate") {
      const date = String(payload.date || "").trim();
      const range = parseDateRange(date);

      if (!range) {
        res.status(400).json({ error: "Silme için geçerli tarih (YYYY-MM-DD) zorunludur." });
        return;
      }

      const result = await collection.deleteMany({
        updatedAt: {
          $gte: range.start,
          $lt: range.end,
        },
      });

      res.json({
        data: {
          mode,
          date,
          deletedCount: result.deletedCount || 0,
        },
      });
      return;
    }

    res.status(400).json({ error: "Geçersiz silme modu." });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/indirilenler", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "downloads.html"));
});

app.get("/downloads", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "downloads.html"));
});

app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _, res, __) => {
  console.error("[WEB_ERROR]", error);
  res.status(500).json({ error: "Sunucu hatası" });
});

async function start() {
  mongoClient = new MongoClient(config.mongodbUri);
  await mongoClient.connect();
  collection = mongoClient.db(config.mongodbDb).collection(config.mongodbCollection);

  app.listen(WEB_PORT, () => {
    console.log(`[WEB] UI hazir: http://127.0.0.1:${WEB_PORT}`);
  });
}

start().catch((error) => {
  console.error("[WEB_FATAL]", error);
  process.exit(1);
});
