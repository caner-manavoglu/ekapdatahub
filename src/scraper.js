const { MongoClient } = require("mongodb");
const baseConfig = require("./config");
const EkapClient = require("./ekapClient");
const { cleanVeriHtml } = require("./htmlCleaner");
const { writeTenderPdf } = require("./pdfWriter");
const { ensureTenderCollectionIndexes } = require("./dbIndexes");
const {
  extractRequestedFields,
  buildSelectedSummaryText,
} = require("./announcementExtractor");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function resolveOptions(options = {}) {
  return {
    listUrl: options.listUrl || baseConfig.listUrl,
    detailUrl: options.detailUrl || baseConfig.detailUrl,
    pageSize: Math.max(1, toInt(options.pageSize, baseConfig.pageSize)),
    maxPages: Math.max(0, toInt(options.maxPages, baseConfig.maxPages)),
    startSkip: Math.max(0, toInt(options.startSkip, baseConfig.startSkip)),
    requestTimeoutMs: Math.max(
      1_000,
      toInt(options.requestTimeoutMs, baseConfig.requestTimeoutMs),
    ),
    retryCount: Math.max(0, toInt(options.retryCount, baseConfig.retryCount)),
    retryDelayMs: Math.max(0, toInt(options.retryDelayMs, baseConfig.retryDelayMs)),
    rateLimitMs: Math.max(0, toInt(options.rateLimitMs, baseConfig.rateLimitMs)),
    detailConcurrency: Math.max(
      1,
      Math.min(16, toInt(options.detailConcurrency, baseConfig.detailConcurrency)),
    ),
    mongodbUri: options.mongodbUri || baseConfig.mongodbUri,
    mongodbDb: options.mongodbDb || baseConfig.mongodbDb,
    mongodbCollection: options.mongodbCollection || baseConfig.mongodbCollection,
    generatePdf:
      typeof options.generatePdf === "boolean"
        ? options.generatePdf
        : baseConfig.generatePdf,
    pdfOutputDir: options.pdfOutputDir || baseConfig.pdfOutputDir,
    pdfFontPath: options.pdfFontPath || baseConfig.pdfFontPath,
    storeFullIlanContent:
      typeof options.storeFullIlanContent === "boolean"
        ? options.storeFullIlanContent
        : baseConfig.storeFullIlanContent,
    dryRun:
      typeof options.dryRun === "boolean" ? options.dryRun : baseConfig.dryRun,
    storeRawHtml:
      typeof options.storeRawHtml === "boolean"
        ? options.storeRawHtml
        : baseConfig.storeRawHtml,
  };
}

function createLogger(onLog) {
  if (typeof onLog !== "function") {
    return {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    };
  }

  const emit = (level, message) => {
    onLog({
      level,
      message,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}

function errorToMessage(error) {
  if (error?.response?.data) {
    return JSON.stringify(error.response.data);
  }

  return error?.message || String(error);
}

function isRetryableHttpError(error) {
  const statusCode = Number(error?.response?.status || 0);
  if (statusCode === 429 || statusCode >= 500) {
    return true;
  }

  const code = String(error?.code || "").trim().toUpperCase();
  if (
    code &&
    [
      "ECONNABORTED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ERR_NETWORK",
    ].includes(code)
  ) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return message.includes("timeout") || message.includes("network error");
}

function computeBackoffDelayMs(baseDelayMs, attemptIndex) {
  const base = Math.max(0, toInt(baseDelayMs, 0));
  if (base === 0) {
    return 0;
  }

  const attempt = Math.max(0, toInt(attemptIndex, 0));
  const exponential = base * 2 ** Math.min(6, attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.3)));
  return exponential + jitter;
}

async function withRetry(fn, { retries, delayMs, label, logger }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableHttpError(error);
      if (!retryable) {
        throw error;
      }

      const hasNextAttempt = attempt < retries;
      if (!hasNextAttempt) {
        break;
      }

      const waitMs = computeBackoffDelayMs(delayMs, attempt);
      logger.warn(
        `[RETRY] ${label} başarısız (deneme ${attempt + 1}/${retries + 1}), ${waitMs}ms sonra tekrar denenecek.`,
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function createRateLimiter(rateLimitMs) {
  const delay = Math.max(0, toInt(rateLimitMs, 0));
  if (delay <= 0) {
    return async () => {};
  }

  let queue = Promise.resolve();
  let lastStartedAt = 0;

  return async () => {
    let release = () => {};
    const turn = new Promise((resolve) => {
      release = resolve;
    });

    const previous = queue;
    queue = turn;
    await previous;

    const now = Date.now();
    const elapsed = now - lastStartedAt;
    if (lastStartedAt > 0 && elapsed < delay) {
      await sleep(delay - elapsed);
    }
    lastStartedAt = Date.now();
    release();
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const rows = Array.isArray(items) ? items : [];
  const workerFn = typeof worker === "function" ? worker : async () => {};
  const limit = Math.max(1, Math.min(Math.max(1, rows.length), toInt(concurrency, 1)));
  let nextIndex = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= rows.length) {
        return;
      }
      await workerFn(rows[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
}

function cleanIlanList(ilanList, storeRawHtml) {
  if (!Array.isArray(ilanList)) {
    return [];
  }

  return ilanList.map((ilan) => {
    const { cleanHtml, cleanText } = cleanVeriHtml(ilan?.veriHtml);

    const cleaned = {
      ...ilan,
      veriHtmlCleanHtml: cleanHtml,
      veriHtmlCleanText: cleanText,
    };

    if (!storeRawHtml) {
      delete cleaned.veriHtml;
    }

    return cleaned;
  });
}

function toSlimListRow(row) {
  return {
    id: row?.id || null,
    ikn: row?.ikn || null,
    ihaleAdi: row?.ihaleAdi || null,
    idareAdi: row?.idareAdi || null,
    ihaleDurum: row?.ihaleDurum || null,
    ihaleTarihSaat: row?.ihaleTarihSaat || null,
    ihaleIlAdi: row?.ihaleIlAdi || null,
    ihaleTipAciklama: row?.ihaleTipAciklama || null,
    ihaleUsulAciklama: row?.ihaleUsulAciklama || null,
  };
}

function buildSlimIlanList(cleanedIlanList, context = {}) {
  const fallbackIkn = context.fallbackIkn || null;
  const ihaleAdi = context.ihaleAdi || null;

  return cleanedIlanList.map((ilan) => {
    const selectedFields = extractRequestedFields({
      cleanText: ilan?.veriHtmlCleanText || "",
      ikn: fallbackIkn || null,
      ilanTarihi: ilan?.ilanTarihi || null,
      baslik: ilan?.baslik || null,
      ihaleAdi,
    });

    return {
      id: ilan?.id || null,
      baslik: ilan?.baslik || null,
      ilanTarihi: ilan?.ilanTarihi || null,
      dokumantasyon: {
        tamHtml: ilan?.veriHtml || null,
        temizHtml: ilan?.veriHtmlCleanHtml || null,
        temizText: ilan?.veriHtmlCleanText || null,
      },
      secilenAlanlar: selectedFields,
      secilenAlanlarMetin: buildSelectedSummaryText(selectedFields),
    };
  });
}

function buildDocument(row, detailItem, options) {
  const cleanedIlanList = cleanIlanList(detailItem?.ilanList, options.storeRawHtml);
  const slimIlanList = buildSlimIlanList(cleanedIlanList, {
    fallbackIkn: detailItem?.ikn || row?.ikn,
    ihaleAdi: detailItem?.ihaleAdi || row?.ihaleAdi || null,
  });

  const slimDetail = {
    id: detailItem?.id || null,
    ikn: detailItem?.ikn || row?.ikn || null,
    ihaleAdi: detailItem?.ihaleAdi || row?.ihaleAdi || null,
    idareAdi: detailItem?.idareAdi || row?.idareAdi || null,
    ihaleDurum: detailItem?.ihaleDurum || row?.ihaleDurum || null,
    ihaleBilgi: {
      ihaleTarihSaat: detailItem?.ihaleBilgi?.ihaleTarihSaat || null,
      ihaleYeri: detailItem?.ihaleBilgi?.ihaleYeri || null,
      isinYapilacagiYer: detailItem?.ihaleBilgi?.isinYapilacagiYer || null,
    },
    ilanList: slimIlanList,
  };

  const document = {
    _id: row.id,
    sourceIhaleId: row.id,
    ikn: detailItem?.ikn || row?.ikn || null,
    ihaleAdi: detailItem?.ihaleAdi || row?.ihaleAdi || null,
    idareAdi: detailItem?.idareAdi || row?.idareAdi || null,
    ihaleDurum: detailItem?.ihaleDurum || row?.ihaleDurum || null,
    ihaleBilgi: slimDetail.ihaleBilgi,
    listRow: toSlimListRow(row),
    item: slimDetail,
    stats: {
      ilanCount: slimIlanList.length,
      selectedSummaryCount: slimIlanList.filter(
        (ilan) =>
          typeof ilan.secilenAlanlarMetin === "string" && ilan.secilenAlanlarMetin.length > 0,
      ).length,
    },
    updatedAt: new Date(),
  };

  if (options.storeFullIlanContent) {
    document.raw = {
      item: {
        ...detailItem,
        ilanList: cleanedIlanList,
      },
      listRow: row,
    };
  }

  return document;
}

async function runScraper(options = {}) {
  const cfg = resolveOptions(options);
  const logger = createLogger(options.onLog);
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;

  const ekapClient = new EkapClient({
    listUrl: cfg.listUrl,
    detailUrl: cfg.detailUrl,
    timeout: cfg.requestTimeoutMs,
  });

  let mongoClient;
  let collection;

  if (!cfg.dryRun) {
    mongoClient = new MongoClient(cfg.mongodbUri);
    await mongoClient.connect();
    collection = mongoClient.db(cfg.mongodbDb).collection(cfg.mongodbCollection);

    await ensureTenderCollectionIndexes(collection);
  }

  let page = 0;
  let skip = cfg.startSkip;
  let totalCount = null;
  let processed = 0;
  let saved = 0;
  let failed = 0;
  let pdfCreated = 0;
  let stopped = false;
  const waitForRateLimit = createRateLimiter(cfg.rateLimitMs);

  try {
    while (true) {
      if (shouldStop()) {
        stopped = true;
        logger.warn("[STOP] Durdurma isteği alındı. Scrape güvenli şekilde sonlandırılıyor.");
        break;
      }

      if (cfg.maxPages > 0 && page >= cfg.maxPages) {
        break;
      }

      const listResult = await withRetry(
        () => ekapClient.fetchList({ skip, take: cfg.pageSize }),
        {
          retries: cfg.retryCount,
          delayMs: cfg.retryDelayMs,
          label: `liste sayfası skip=${skip}`,
          logger,
        },
      );

      const rows = Array.isArray(listResult?.list) ? listResult.list : [];
      if (totalCount === null && Number.isFinite(listResult?.totalCount)) {
        totalCount = listResult.totalCount;
      }

      if (rows.length === 0) {
        logger.info(`[INFO] Kayıt kalmadı. skip=${skip}`);
        break;
      }

      logger.info(
        `[PAGE ${page + 1}] skip=${skip} rows=${rows.length} totalCount=${totalCount ?? "-"}`,
      );

      let stopLoggedAtPage = false;
      await runWithConcurrency(rows, cfg.detailConcurrency, async (row) => {
        if (stopped) {
          return;
        }

        if (shouldStop()) {
          stopped = true;
          if (!stopLoggedAtPage) {
            stopLoggedAtPage = true;
            logger.warn("[STOP] Durdurma isteği alındı. Mevcut sayfa sonunda duruluyor.");
          }
          return;
        }

        processed += 1;

        if (!row?.id) {
          failed += 1;
          logger.warn(`[WARN] Satırda id yok, atlandı. ikn=${row?.ikn || "-"}`);
          return;
        }

        try {
          await waitForRateLimit();

          if (stopped || shouldStop()) {
            stopped = true;
            if (!stopLoggedAtPage) {
              stopLoggedAtPage = true;
              logger.warn(
                "[STOP] Durdurma isteği alındı. Yeni detay isteği gönderilmeden duruluyor.",
              );
            }
            return;
          }

          const detailResult = await withRetry(
            () => ekapClient.fetchDetail({ ihaleId: row.id }),
            {
              retries: cfg.retryCount,
              delayMs: cfg.retryDelayMs,
              label: `detay ihaleId=${row.id}`,
              logger,
            },
          );

          const detailItem = detailResult?.item;
          if (!detailItem) {
            failed += 1;
            logger.warn(`[WARN] Detay boş döndü. ihaleId=${row.id}`);
            return;
          }

          const document = buildDocument(row, detailItem, {
            storeRawHtml: cfg.storeRawHtml,
            storeFullIlanContent: cfg.storeFullIlanContent,
          });

          if (cfg.dryRun) {
            logger.info(
              `[DRY_RUN] ihaleId=${row.id} ikn=${document.ikn} ilanCount=${document.stats.ilanCount}`,
            );
          } else {
            await collection.updateOne(
              { _id: document._id },
              {
                $set: document,
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true },
            );
            saved += 1;
          }

          if (cfg.generatePdf) {
            const pdfPath = await writeTenderPdf(document, {
              outputDir: cfg.pdfOutputDir,
              fontPath: cfg.pdfFontPath,
            });
            pdfCreated += 1;
            logger.info(`[PDF] olusturuldu: ${pdfPath}`);
          }
        } catch (error) {
          failed += 1;
          logger.error(
            `[ERROR] Detay işleme hatası ihaleId=${row.id}: ${errorToMessage(error)}`,
          );
        }
      });

      if (stopped) {
        break;
      }

      page += 1;
      skip += cfg.pageSize;
    }

    const result = {
      processed,
      saved,
      failed,
      pdfCreated,
      stopped,
      dryRun: cfg.dryRun,
      pageSize: cfg.pageSize,
      maxPages: cfg.maxPages,
      detailConcurrency: cfg.detailConcurrency,
      totalCount,
      pagesProcessed: page,
    };

    logger.info(
      `[DONE] processed=${result.processed} saved=${result.saved} failed=${result.failed} pdfCreated=${result.pdfCreated} stopped=${result.stopped} dryRun=${result.dryRun} concurrency=${result.detailConcurrency}`,
    );

    return result;
  } finally {
    if (mongoClient) {
      await mongoClient.close();
    }
  }
}

module.exports = {
  runScraper,
  _internal: {
    isRetryableHttpError,
    computeBackoffDelayMs,
    createRateLimiter,
    runWithConcurrency,
  },
};
