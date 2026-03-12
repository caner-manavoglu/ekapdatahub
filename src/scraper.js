const fs = require("node:fs");
const path = require("node:path");
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

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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
    writeBatchSize: Math.max(
      10,
      Math.min(1_000, toInt(options.writeBatchSize, baseConfig.writeBatchSize)),
    ),
    adaptiveDetailConcurrency:
      typeof options.adaptiveDetailConcurrency === "boolean"
        ? options.adaptiveDetailConcurrency
        : toBool(options.adaptiveDetailConcurrency, baseConfig.adaptiveDetailConcurrency),
    detailConcurrencyMin: Math.max(
      1,
      Math.min(16, toInt(options.detailConcurrencyMin, baseConfig.detailConcurrencyMin)),
    ),
    detailConcurrencyMax: Math.max(
      1,
      Math.min(16, toInt(options.detailConcurrencyMax, baseConfig.detailConcurrencyMax)),
    ),
    detailPageTargetMs: Math.max(
      500,
      toInt(options.detailPageTargetMs, baseConfig.detailPageTargetMs),
    ),
    conditionalRequests:
      typeof options.conditionalRequests === "boolean"
        ? options.conditionalRequests
        : toBool(options.conditionalRequests, baseConfig.conditionalRequests),
    conditionalCacheTtlMs: Math.max(
      10_000,
      toInt(options.conditionalCacheTtlMs, baseConfig.conditionalCacheTtlMs),
    ),
    conditionalCacheSize: Math.max(
      10,
      toInt(options.conditionalCacheSize, baseConfig.conditionalCacheSize),
    ),
    responseCacheEnabled:
      typeof options.responseCacheEnabled === "boolean"
        ? options.responseCacheEnabled
        : toBool(options.responseCacheEnabled, baseConfig.responseCacheEnabled),
    responseCacheTtlMs: Math.max(
      1_000,
      toInt(options.responseCacheTtlMs, baseConfig.responseCacheTtlMs),
    ),
    responseCacheSize: Math.max(
      10,
      toInt(options.responseCacheSize, baseConfig.responseCacheSize),
    ),
    circuitBreakerEnabled:
      typeof options.circuitBreakerEnabled === "boolean"
        ? options.circuitBreakerEnabled
        : toBool(options.circuitBreakerEnabled, baseConfig.circuitBreakerEnabled),
    circuitBreakerThreshold: Math.max(
      1,
      toInt(options.circuitBreakerThreshold, baseConfig.circuitBreakerThreshold),
    ),
    circuitBreakerCooldownMs: Math.max(
      1_000,
      toInt(options.circuitBreakerCooldownMs, baseConfig.circuitBreakerCooldownMs),
    ),
    circuitBreakerHalfOpenPages: Math.max(
      1,
      toInt(options.circuitBreakerHalfOpenPages, baseConfig.circuitBreakerHalfOpenPages),
    ),
    incrementalSync:
      typeof options.incrementalSync === "boolean"
        ? options.incrementalSync
        : toBool(options.incrementalSync, baseConfig.incrementalSync),
    incrementalStopUnchangedStreak: Math.max(
      5,
      toInt(
        options.incrementalStopUnchangedStreak,
        baseConfig.incrementalStopUnchangedStreak,
      ),
    ),
    incrementalCheckpointPath:
      options.incrementalCheckpointPath || baseConfig.incrementalCheckpointPath,
    adaptivePagination:
      typeof options.adaptivePagination === "boolean"
        ? options.adaptivePagination
        : toBool(options.adaptivePagination, baseConfig.adaptivePagination),
    adaptivePageSizeMin: Math.max(
      1,
      toInt(options.adaptivePageSizeMin, baseConfig.adaptivePageSizeMin),
    ),
    adaptivePageSizeMax: Math.max(
      1,
      toInt(options.adaptivePageSizeMax, baseConfig.adaptivePageSizeMax),
    ),
    adaptivePageSizeStep: Math.max(
      1,
      toInt(options.adaptivePageSizeStep, baseConfig.adaptivePageSizeStep),
    ),
    adaptivePageTargetMs: Math.max(
      200,
      toInt(options.adaptivePageTargetMs, baseConfig.adaptivePageTargetMs),
    ),
    httpKeepAlive:
      typeof options.httpKeepAlive === "boolean"
        ? options.httpKeepAlive
        : toBool(options.httpKeepAlive, baseConfig.httpKeepAlive),
    httpMaxSockets: Math.max(4, toInt(options.httpMaxSockets, baseConfig.httpMaxSockets)),
    httpMaxFreeSockets: Math.max(
      1,
      toInt(options.httpMaxFreeSockets, baseConfig.httpMaxFreeSockets),
    ),
    httpKeepAliveMs: Math.max(100, toInt(options.httpKeepAliveMs, baseConfig.httpKeepAliveMs)),
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function tuneAdaptivePageSize({
  currentTake,
  minTake,
  maxTake,
  step,
  targetMs,
  listLatencyMs,
  rowsReturned,
  pageFailedCount,
}) {
  const current = clamp(toInt(currentTake, 10), 1, Math.max(1, toInt(maxTake, 40)));
  const min = clamp(toInt(minTake, 1), 1, current <= 0 ? 1 : Math.max(1, toInt(maxTake, 40)));
  const max = Math.max(min, toInt(maxTake, current));
  const stride = Math.max(1, toInt(step, 1));
  const target = Math.max(200, toInt(targetMs, 1_200));
  const latency = Math.max(0, toInt(listLatencyMs, target));
  const returned = Math.max(0, toInt(rowsReturned, 0));
  const failed = Math.max(0, toInt(pageFailedCount, 0));

  if (failed > 0) {
    return clamp(current - stride, min, max);
  }

  if (returned < current) {
    return current;
  }

  if (latency <= Math.floor(target * 0.65)) {
    return clamp(current + stride, min, max);
  }

  if (latency >= Math.ceil(target * 1.35)) {
    return clamp(current - stride, min, max);
  }

  return current;
}

function tuneDetailConcurrency({
  currentConcurrency,
  minConcurrency,
  maxConcurrency,
  pageFailedCount,
  pageDurationMs,
  targetMs,
}) {
  const current = clamp(
    toInt(currentConcurrency, 1),
    1,
    Math.max(1, Math.min(16, toInt(maxConcurrency, 16))),
  );
  const min = clamp(
    toInt(minConcurrency, 1),
    1,
    Math.max(1, Math.min(16, toInt(maxConcurrency, 16))),
  );
  const max = Math.max(min, Math.min(16, toInt(maxConcurrency, current)));
  const failed = Math.max(0, toInt(pageFailedCount, 0));
  const duration = Math.max(0, toInt(pageDurationMs, 0));
  const target = Math.max(500, toInt(targetMs, 8_000));

  if (failed > 0) {
    return clamp(current - 1, min, max);
  }

  if (duration <= Math.floor(target * 0.7)) {
    return clamp(current + 1, min, max);
  }

  if (duration >= Math.ceil(target * 1.4)) {
    return clamp(current - 1, min, max);
  }

  return current;
}

function shouldOpenCircuitBreaker(consecutiveFailures, threshold) {
  const failures = Math.max(0, toInt(consecutiveFailures, 0));
  const limit = Math.max(1, toInt(threshold, 1));
  return failures >= limit;
}

function computePercentile(samples, percentile) {
  const values = Array.isArray(samples)
    ? samples
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const p = Math.max(0, Math.min(1, Number(percentile) || 0));
  const rawIndex = (sorted.length - 1) * p;
  const lowerIndex = Math.floor(rawIndex);
  const upperIndex = Math.ceil(rawIndex);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = rawIndex - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function buildDistributionStats(samples) {
  const values = Array.isArray(samples)
    ? samples
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p95: null,
    };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    min,
    max,
    avg: sum / values.length,
    p50: computePercentile(values, 0.5),
    p95: computePercentile(values, 0.95),
  };
}

function classifyErrorType(error) {
  const statusCode = Number(error?.response?.status || 0);
  if (statusCode > 0) {
    return `http:${statusCode}`;
  }
  const code = normalizeFingerprintPart(error?.code).toUpperCase();
  if (code) {
    return `code:${code}`;
  }
  const message = normalizeFingerprintPart(error?.message).toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("network")) return "network";
  return "unknown";
}

async function withRetry(fn, { retries, delayMs, label, logger, onRetry }) {
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
      if (typeof onRetry === "function") {
        onRetry({
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          waitMs,
          label,
          error,
        });
      }
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

function chunkArray(items, chunkSize) {
  const rows = Array.isArray(items) ? items : [];
  const size = Math.max(1, toInt(chunkSize, 1));
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
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

function normalizeFingerprintPart(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value).trim();
}

function normalizeTextValue(value) {
  return normalizeFingerprintPart(value)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIkn(value) {
  const normalized = normalizeTextValue(value).toUpperCase();
  if (!normalized) return "";
  return normalized.replace(/[^0-9A-Z/.-]/g, "");
}

function toDateMs(value) {
  const text = normalizeFingerprintPart(value);
  if (!text) return Number.NaN;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

const DEDUPE_CONFLICT_POLICY = "prefer-latest-ihaleTarihSaat";

function shouldReplaceDedupedRow(existingRow, incomingRow) {
  const existingMs = toDateMs(existingRow?.ihaleTarihSaat);
  const incomingMs = toDateMs(incomingRow?.ihaleTarihSaat);
  if (Number.isFinite(existingMs) && Number.isFinite(incomingMs)) {
    return incomingMs > existingMs;
  }
  return false;
}

function buildPageRowDedupeKey(row) {
  const ikn = normalizeIkn(row?.ikn);
  if (ikn) {
    return `ikn:${ikn}`;
  }
  const sourceId = normalizeFingerprintPart(row?.id);
  if (sourceId) {
    return `id:${sourceId}`;
  }
  const fallback = [
    normalizeTextValue(row?.ihaleAdi),
    normalizeTextValue(row?.idareAdi),
    normalizeTextValue(row?.ihaleTarihSaat),
  ]
    .filter(Boolean)
    .join("|");
  return fallback ? `fallback:${fallback}` : "";
}

function buildNormalizedUniqueKey(row, detailItem) {
  const ikn = normalizeIkn(detailItem?.ikn || row?.ikn);
  if (ikn) {
    return `ikn:${ikn}`;
  }
  const sourceId = normalizeFingerprintPart(detailItem?.id || row?.id);
  if (sourceId) {
    return `source:${sourceId}`;
  }
  return buildPageRowDedupeKey(row);
}

function buildListRowFingerprint(row) {
  const fields = [
    row?.id,
    row?.ikn,
    row?.ihaleAdi,
    row?.idareAdi,
    row?.ihaleDurum,
    row?.ihaleTarihSaat,
    row?.ihaleIlAdi,
    row?.ihaleTipAciklama,
    row?.ihaleUsulAciklama,
  ];
  return fields.map(normalizeFingerprintPart).join("|");
}

function getStoredListRowFingerprint(existingDoc) {
  const bySync = normalizeFingerprintPart(existingDoc?.sync?.listRowFingerprint);
  if (bySync) return bySync;
  if (existingDoc?.listRow) {
    return buildListRowFingerprint(existingDoc.listRow);
  }
  return "";
}

function isRowUnchangedAgainstExisting(row, existingDoc) {
  if (!row?.id || !existingDoc) {
    return false;
  }
  const current = buildListRowFingerprint(row);
  const stored = getStoredListRowFingerprint(existingDoc);
  if (!stored) {
    return false;
  }
  return current === stored;
}

async function readIncrementalCheckpoint(filePath, logger) {
  if (!filePath) return null;

  const absolutePath = path.resolve(String(filePath));
  try {
    const raw = await fs.promises.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      path: absolutePath,
      payload: parsed,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    logger.warn(
      `[INCREMENTAL] Checkpoint okunamadi (${absolutePath}): ${error?.message || String(error)}`,
    );
    return null;
  }
}

async function writeIncrementalCheckpoint(filePath, payload, logger) {
  if (!filePath) return;

  const absolutePath = path.resolve(String(filePath));
  try {
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.promises.rename(tmpPath, absolutePath);
  } catch (error) {
    logger.warn(
      `[INCREMENTAL] Checkpoint yazilamadi (${absolutePath}): ${error?.message || String(error)}`,
    );
  }
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

  const normalizedUniqueKey = buildNormalizedUniqueKey(row, detailItem);
  const normalizedIkn = normalizeIkn(detailItem?.ikn || row?.ikn);
  const normalizedIhaleAdi = normalizeTextValue(detailItem?.ihaleAdi || row?.ihaleAdi);
  const normalizedIdareAdi = normalizeTextValue(detailItem?.idareAdi || row?.idareAdi);
  const normalizedDurum = normalizeTextValue(detailItem?.ihaleDurum || row?.ihaleDurum);

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
    sync: {
      listRowFingerprint: buildListRowFingerprint(row),
      lastSyncedAt: new Date(),
      normalizedUniqueKey: normalizedUniqueKey || null,
      conflictPolicy: DEDUPE_CONFLICT_POLICY,
    },
    quality: {
      schemaVersion: 1,
      normalized: {
        ikn: normalizedIkn || null,
        ihaleAdi: normalizedIhaleAdi || null,
        idareAdi: normalizedIdareAdi || null,
        ihaleDurum: normalizedDurum || null,
      },
    },
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
    keepAlive: cfg.httpKeepAlive,
    maxSockets: cfg.httpMaxSockets,
    maxFreeSockets: cfg.httpMaxFreeSockets,
    keepAliveMs: cfg.httpKeepAliveMs,
    conditionalRequests: cfg.conditionalRequests,
    conditionalCacheTtlMs: cfg.conditionalCacheTtlMs,
    conditionalCacheSize: cfg.conditionalCacheSize,
    responseCacheEnabled: cfg.responseCacheEnabled,
    responseCacheTtlMs: cfg.responseCacheTtlMs,
    responseCacheSize: cfg.responseCacheSize,
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
  let pagesProcessed = 0;
  let skip = cfg.startSkip;
  const adaptiveMinTake = Math.max(1, Math.min(cfg.adaptivePageSizeMin, cfg.adaptivePageSizeMax));
  const adaptiveMaxTake = Math.max(adaptiveMinTake, cfg.adaptivePageSizeMax);
  let currentTake = clamp(cfg.pageSize, adaptiveMinTake, adaptiveMaxTake);
  const detailMinConcurrency = Math.max(
    1,
    Math.min(16, Math.min(cfg.detailConcurrencyMin, cfg.detailConcurrencyMax)),
  );
  const detailMaxConcurrency = Math.max(
    detailMinConcurrency,
    Math.min(16, cfg.detailConcurrencyMax),
  );
  let currentDetailConcurrency = clamp(
    cfg.detailConcurrency,
    detailMinConcurrency,
    detailMaxConcurrency,
  );
  let totalCount = null;
  let processed = 0;
  let saved = 0;
  let failed = 0;
  let pdfCreated = 0;
  let skippedUnchanged = 0;
  let dedupeSkipped = 0;
  let dedupeReplacements = 0;
  let retryCount = 0;
  let stopped = false;
  let incrementalStopTriggered = false;
  let incrementalStopReason = null;
  let unchangedStreak = 0;
  const waitForRateLimit = createRateLimiter(cfg.rateLimitMs);
  const incrementalEnabled = Boolean(cfg.incrementalSync && cfg.startSkip === 0);
  const incrementalDisabledReason = cfg.incrementalSync && cfg.startSkip > 0 ? "startSkip" : null;
  const adaptivePaginationEnabled = Boolean(
    cfg.adaptivePagination && cfg.startSkip === 0 && cfg.maxPages === 0,
  );
  const adaptiveDetailConcurrencyEnabled = Boolean(cfg.adaptiveDetailConcurrency);
  const circuitBreakerEnabled = Boolean(cfg.circuitBreakerEnabled);
  let circuitState = "closed";
  let circuitTrips = 0;
  let circuitConsecutiveFailures = 0;
  let circuitOpenUntil = 0;
  let circuitHalfOpenRemaining = 0;
  let circuitListFetchFailures = 0;
  const listLatencySamples = [];
  const detailLatencySamples = [];
  const queueDepthSamples = [];
  const errorTypeCounts = new Map();
  const recordErrorType = (scope, error) => {
    const key = `${normalizeFingerprintPart(scope) || "unknown"}:${classifyErrorType(error)}`;
    errorTypeCounts.set(key, (errorTypeCounts.get(key) || 0) + 1);
  };
  let adaptiveAdjustments = 0;
  let detailConcurrencyAdjustments = 0;
  const seenRowIds = new Set();
  const recentRows = [];
  let firstSeenRow = null;
  let loadedIncrementalCheckpoint = null;

  if (incrementalDisabledReason === "startSkip") {
    logger.warn("[INCREMENTAL] startSkip > 0 oldugu icin incremental mod devre disi birakildi.");
  }
  if (!adaptivePaginationEnabled && cfg.adaptivePagination && cfg.startSkip > 0) {
    logger.warn("[PAGINATION] startSkip > 0 oldugu icin adaptive pagination devre disi.");
  }
  if (!adaptivePaginationEnabled && cfg.adaptivePagination && cfg.maxPages > 0) {
    logger.warn("[PAGINATION] maxPages > 0 oldugu icin adaptive pagination devre disi.");
  }
  if (adaptivePaginationEnabled) {
    logger.info(
      `[PAGINATION] adaptive aktif: take=${currentTake} min=${adaptiveMinTake} max=${adaptiveMaxTake} step=${cfg.adaptivePageSizeStep} targetMs=${cfg.adaptivePageTargetMs}`,
    );
  }
  if (adaptiveDetailConcurrencyEnabled) {
    logger.info(
      `[CONCURRENCY] adaptive aktif: workers=${currentDetailConcurrency} min=${detailMinConcurrency} max=${detailMaxConcurrency} targetMs=${cfg.detailPageTargetMs}`,
    );
  }
  if (circuitBreakerEnabled) {
    logger.info(
      `[CIRCUIT] aktif: threshold=${cfg.circuitBreakerThreshold} cooldownMs=${cfg.circuitBreakerCooldownMs} halfOpenPages=${cfg.circuitBreakerHalfOpenPages}`,
    );
  }

  if (incrementalEnabled) {
    loadedIncrementalCheckpoint = await readIncrementalCheckpoint(
      cfg.incrementalCheckpointPath,
      logger,
    );
    if (loadedIncrementalCheckpoint?.payload?.lastSeen?.id) {
      logger.info(
        `[INCREMENTAL] Checkpoint yuklendi: lastSeenId=${loadedIncrementalCheckpoint.payload.lastSeen.id}`,
      );
    } else {
      logger.info("[INCREMENTAL] Checkpoint bulunamadi, tam tarama ile baslanacak.");
    }
  }
  const checkpointLastSeenId = normalizeFingerprintPart(
    loadedIncrementalCheckpoint?.payload?.lastSeen?.id,
  );

  try {
    while (true) {
      if (circuitBreakerEnabled && circuitState === "open") {
        const waitMs = Math.max(0, circuitOpenUntil - Date.now());
        if (waitMs > 0) {
          logger.warn(`[CIRCUIT] open durumda, ${waitMs}ms bekleniyor.`);
          await sleep(waitMs);
        }
        circuitState = "half-open";
        circuitHalfOpenRemaining = cfg.circuitBreakerHalfOpenPages;
        logger.info(`[CIRCUIT] half-open deneme basladi (kalan=${circuitHalfOpenRemaining}).`);
      }

      if (shouldStop()) {
        stopped = true;
        logger.warn("[STOP] Durdurma isteği alındı. Scrape güvenli şekilde sonlandırılıyor.");
        break;
      }

      if (cfg.maxPages > 0 && page >= cfg.maxPages) {
        break;
      }

      const requestedTake = currentTake;
      const listStartedAt = Date.now();
      let listResult = null;
      try {
        listResult = await withRetry(
          () => ekapClient.fetchList({ skip, take: requestedTake }),
          {
            retries: cfg.retryCount,
            delayMs: cfg.retryDelayMs,
            label: `liste sayfası skip=${skip} take=${requestedTake}`,
            logger,
            onRetry: () => {
              retryCount += 1;
            },
          },
        );
      } catch (error) {
        listLatencySamples.push(Date.now() - listStartedAt);
        failed += 1;
        circuitListFetchFailures += 1;
        recordErrorType("list", error);
        logger.error(`[ERROR] Liste sayfasi alinamadi skip=${skip}: ${errorToMessage(error)}`);

        if (!circuitBreakerEnabled) {
          throw error;
        }

        circuitConsecutiveFailures += 1;
        if (shouldOpenCircuitBreaker(circuitConsecutiveFailures, cfg.circuitBreakerThreshold)) {
          circuitState = "open";
          circuitTrips += 1;
          circuitOpenUntil = Date.now() + cfg.circuitBreakerCooldownMs;
          logger.error(
            `[CIRCUIT] open oldu (list-failure). consecutive=${circuitConsecutiveFailures}, cooldownMs=${cfg.circuitBreakerCooldownMs}`,
          );
        }
        await sleep(Math.min(1_000, cfg.circuitBreakerCooldownMs));
        continue;
      }
      const listLatencyMs = Date.now() - listStartedAt;
      listLatencySamples.push(listLatencyMs);

      let rows = Array.isArray(listResult?.list) ? listResult.list : [];
      if (totalCount === null && Number.isFinite(listResult?.totalCount)) {
        totalCount = listResult.totalCount;
      }
      if (listResult?._responseCache?.hit) {
        logger.info(`[CACHE] Liste cache hit (skip=${skip}, take=${requestedTake})`);
      }
      if (listResult?._conditional?.notModified) {
        logger.info(`[CONDITIONAL] Liste 304 (skip=${skip}, take=${requestedTake})`);
      }

      if (rows.length === 0) {
        logger.info(`[INFO] Kayıt kalmadı. skip=${skip}`);
        break;
      }

      let pageDuplicateRows = 0;
      let pageConflictReplacements = 0;
      if (rows.length > 1) {
        const dedupedRows = [];
        const indexByKey = new Map();
        for (const row of rows) {
          const dedupeKey = buildPageRowDedupeKey(row);
          if (!dedupeKey) {
            dedupedRows.push(row);
            continue;
          }
          const existingIndex = indexByKey.get(dedupeKey);
          if (existingIndex === undefined) {
            indexByKey.set(dedupeKey, dedupedRows.length);
            dedupedRows.push(row);
            continue;
          }

          pageDuplicateRows += 1;
          const existingRow = dedupedRows[existingIndex];
          if (shouldReplaceDedupedRow(existingRow, row)) {
            dedupedRows[existingIndex] = row;
            pageConflictReplacements += 1;
          }
        }
        rows = dedupedRows;
      }

      logger.info(
        `[PAGE ${page + 1}] skip=${skip} take=${requestedTake} workers=${currentDetailConcurrency} rows=${rows.length} listMs=${listLatencyMs} totalCount=${totalCount ?? "-"} duplicates=${pageDuplicateRows}`,
      );
      queueDepthSamples.push(rows.length);
      if (pageDuplicateRows > 0) {
        dedupeSkipped += pageDuplicateRows;
        dedupeReplacements += pageConflictReplacements;
        logger.warn(
          `[DEDUPE] page=${page + 1} skipped=${pageDuplicateRows} replaced=${pageConflictReplacements} policy=${DEDUPE_CONFLICT_POLICY}`,
        );
      }
      pagesProcessed += 1;

      if (!firstSeenRow) {
        const firstRowWithId = rows.find((row) => row?.id);
        if (firstRowWithId) {
          firstSeenRow = {
            id: String(firstRowWithId.id),
            ihaleTarihSaat: firstRowWithId.ihaleTarihSaat || null,
          };
        }
      }

      for (const row of rows) {
        const rowId = normalizeFingerprintPart(row?.id);
        if (!rowId || seenRowIds.has(rowId)) continue;
        seenRowIds.add(rowId);
        recentRows.push({
          id: rowId,
          ihaleTarihSaat: row?.ihaleTarihSaat || null,
        });
        if (recentRows.length >= 100) break;
      }

      const pagePlans = rows.map(() => ({ skipUnchanged: false }));
      let pageHasAnyChangedRow = false;
      let checkpointAnchorReached = false;
      if (incrementalEnabled && !cfg.dryRun && collection) {
        const rowIds = rows
          .map((row) => normalizeFingerprintPart(row?.id))
          .filter(Boolean);
        const existingDocs = rowIds.length
          ? await collection
              .find(
                { _id: { $in: rowIds } },
                {
                  projection: {
                    _id: 1,
                    listRow: 1,
                    sync: 1,
                  },
                },
              )
              .toArray()
          : [];
        const existingById = new Map(
          existingDocs.map((doc) => [normalizeFingerprintPart(doc?._id), doc]),
        );

        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const rowId = normalizeFingerprintPart(row?.id);
          if (!rowId) {
            pageHasAnyChangedRow = true;
            unchangedStreak = 0;
            continue;
          }
          const existingDoc = existingById.get(rowId);
          const unchanged = isRowUnchangedAgainstExisting(row, existingDoc);
          if (unchanged) {
            pagePlans[i].skipUnchanged = true;
            unchangedStreak += 1;
            if (checkpointLastSeenId && rowId === checkpointLastSeenId) {
              checkpointAnchorReached = true;
            }
          } else {
            pageHasAnyChangedRow = true;
            unchangedStreak = 0;
          }
        }
      } else {
        unchangedStreak = 0;
        pageHasAnyChangedRow = true;
      }

      let stopLoggedAtPage = false;
      let pageFailedCount = 0;
      const pageStartedAt = Date.now();
      const pendingWriteOps = [];
      await runWithConcurrency(rows, currentDetailConcurrency, async (row, rowIndex) => {
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

        if (pagePlans[rowIndex]?.skipUnchanged) {
          skippedUnchanged += 1;
          if (skippedUnchanged <= 10 || skippedUnchanged % 25 === 0) {
            logger.info(
              `[SKIP] Değişmediği için atlandı. ihaleId=${row.id} skipTotal=${skippedUnchanged}`,
            );
          }
          return;
        }

        if (!row?.id) {
          failed += 1;
          pageFailedCount += 1;
          logger.warn(`[WARN] Satırda id yok, atlandı. ikn=${row?.ikn || "-"}`);
          return;
        }

        let detailStartedAt = 0;
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

          detailStartedAt = Date.now();
          const detailResult = await withRetry(
            () => ekapClient.fetchDetail({ ihaleId: row.id }),
            {
              retries: cfg.retryCount,
              delayMs: cfg.retryDelayMs,
              label: `detay ihaleId=${row.id}`,
              logger,
              onRetry: () => {
                retryCount += 1;
              },
            },
          );
          detailLatencySamples.push(Date.now() - detailStartedAt);

          const detailItem = detailResult?.item;
          if (detailResult?._responseCache?.hit) {
            logger.info(`[CACHE] Detay cache hit (ihaleId=${row.id})`);
          }
          if (detailResult?._conditional?.notModified) {
            logger.info(`[CONDITIONAL] Detay 304 (ihaleId=${row.id})`);
          }
          if (!detailItem) {
            failed += 1;
            pageFailedCount += 1;
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
            pendingWriteOps.push({
              updateOne: {
                filter: { _id: document._id },
                update: {
                  $set: document,
                  $setOnInsert: { createdAt: new Date() },
                },
                upsert: true,
              },
            });
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
          if (detailStartedAt > 0) {
            detailLatencySamples.push(Date.now() - detailStartedAt);
          }
          recordErrorType("detail", error);
          failed += 1;
          pageFailedCount += 1;
          logger.error(
            `[ERROR] Detay işleme hatası ihaleId=${row.id}: ${errorToMessage(error)}`,
          );
        }
      });

      if (!cfg.dryRun && pendingWriteOps.length > 0) {
        const batches = chunkArray(pendingWriteOps, cfg.writeBatchSize);
        for (const batch of batches) {
          try {
            await collection.bulkWrite(batch, { ordered: false });
            saved += batch.length;
          } catch (error) {
            recordErrorType("bulk-write", error);
            const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors.length : batch.length;
            const successCount = Math.max(0, batch.length - writeErrors);
            saved += successCount;
            failed += writeErrors;
            pageFailedCount += writeErrors;
            logger.error(
              `[ERROR] Bulk write hatasi batch=${batch.length} failed=${writeErrors}: ${errorToMessage(error)}`,
            );
          }
        }
      }

      const pageDurationMs = Date.now() - pageStartedAt;

      if (stopped) {
        break;
      }

      if (circuitBreakerEnabled) {
        const pageHasFailure = pageFailedCount > 0;
        if (circuitState === "half-open") {
          if (pageHasFailure) {
            circuitState = "open";
            circuitTrips += 1;
            circuitConsecutiveFailures = cfg.circuitBreakerThreshold;
            circuitOpenUntil = Date.now() + cfg.circuitBreakerCooldownMs;
            logger.warn(
              `[CIRCUIT] half-open basarisiz, tekrar open (cooldownMs=${cfg.circuitBreakerCooldownMs}).`,
            );
          } else {
            circuitHalfOpenRemaining -= 1;
            if (circuitHalfOpenRemaining <= 0) {
              circuitState = "closed";
              circuitConsecutiveFailures = 0;
              logger.info("[CIRCUIT] closed durumuna dondu.");
            }
          }
        } else if (circuitState === "closed") {
          if (pageHasFailure) {
            circuitConsecutiveFailures += 1;
            if (shouldOpenCircuitBreaker(circuitConsecutiveFailures, cfg.circuitBreakerThreshold)) {
              circuitState = "open";
              circuitTrips += 1;
              circuitOpenUntil = Date.now() + cfg.circuitBreakerCooldownMs;
              logger.warn(
                `[CIRCUIT] open oldu. consecutive=${circuitConsecutiveFailures}, cooldownMs=${cfg.circuitBreakerCooldownMs}`,
              );
            }
          } else {
            circuitConsecutiveFailures = 0;
          }
        }
      }

      if (incrementalEnabled && !pageHasAnyChangedRow) {
        if (checkpointAnchorReached) {
          incrementalStopTriggered = true;
          incrementalStopReason = "checkpoint-anchor";
          logger.info(
            `[INCREMENTAL] Checkpoint id satirina ulasildi (${checkpointLastSeenId}), tarama erken sonlandirildi.`,
          );
          break;
        }
        if (unchangedStreak >= cfg.incrementalStopUnchangedStreak) {
          incrementalStopTriggered = true;
          incrementalStopReason = "unchanged-streak";
          logger.info(
            `[INCREMENTAL] ${unchangedStreak} ardışık değişmeyen kayıta ulaşıldı, tarama erken sonlandırıldı.`,
          );
          break;
        }
      }

      if (adaptivePaginationEnabled) {
        const tunedTake = tuneAdaptivePageSize({
          currentTake: requestedTake,
          minTake: adaptiveMinTake,
          maxTake: adaptiveMaxTake,
          step: cfg.adaptivePageSizeStep,
          targetMs: cfg.adaptivePageTargetMs,
          listLatencyMs,
          rowsReturned: rows.length,
          pageFailedCount,
        });
        if (tunedTake !== requestedTake) {
          adaptiveAdjustments += 1;
          currentTake = tunedTake;
          logger.info(
            `[PAGINATION] take ayarlandi: ${requestedTake} -> ${tunedTake} (listMs=${listLatencyMs}, pageFailed=${pageFailedCount}, rows=${rows.length})`,
          );
        }
      }

      if (adaptiveDetailConcurrencyEnabled) {
        const tunedConcurrency = tuneDetailConcurrency({
          currentConcurrency: currentDetailConcurrency,
          minConcurrency: detailMinConcurrency,
          maxConcurrency: detailMaxConcurrency,
          pageFailedCount,
          pageDurationMs,
          targetMs: cfg.detailPageTargetMs,
        });
        if (tunedConcurrency !== currentDetailConcurrency) {
          detailConcurrencyAdjustments += 1;
          logger.info(
            `[CONCURRENCY] worker ayarlandi: ${currentDetailConcurrency} -> ${tunedConcurrency} (pageMs=${pageDurationMs}, pageFailed=${pageFailedCount})`,
          );
          currentDetailConcurrency = tunedConcurrency;
        }
      }

      page += 1;
      skip += requestedTake;
    }

    const result = {
      processed,
      saved,
      failed,
      pdfCreated,
      skippedUnchanged,
      stopped,
      dryRun: cfg.dryRun,
      pageSize: cfg.pageSize,
      maxPages: cfg.maxPages,
      detailConcurrency: cfg.detailConcurrency,
      writeBatchSize: cfg.writeBatchSize,
      totalCount,
      pagesProcessed,
      effectivePageSize: currentTake,
      effectiveDetailConcurrency: currentDetailConcurrency,
      dedupe: {
        skipped: dedupeSkipped,
        replaced: dedupeReplacements,
        conflictPolicy: DEDUPE_CONFLICT_POLICY,
      },
      incremental: {
        enabled: incrementalEnabled,
        stopTriggered: incrementalStopTriggered,
        stopReason: incrementalStopReason,
        stopUnchangedStreak: cfg.incrementalStopUnchangedStreak,
        checkpointPath: incrementalEnabled ? path.resolve(cfg.incrementalCheckpointPath) : null,
        checkpointLoaded: Boolean(loadedIncrementalCheckpoint),
      },
      adaptivePagination: {
        enabled: adaptivePaginationEnabled,
        adjustments: adaptiveAdjustments,
        minTake: adaptiveMinTake,
        maxTake: adaptiveMaxTake,
        step: cfg.adaptivePageSizeStep,
        targetMs: cfg.adaptivePageTargetMs,
      },
      adaptiveDetailConcurrency: {
        enabled: adaptiveDetailConcurrencyEnabled,
        adjustments: detailConcurrencyAdjustments,
        minWorkers: detailMinConcurrency,
        maxWorkers: detailMaxConcurrency,
        targetMs: cfg.detailPageTargetMs,
      },
      conditionalRequests: ekapClient.getConditionalStats(),
      responseCache: ekapClient.getResponseCacheStats(),
      circuitBreaker: {
        enabled: circuitBreakerEnabled,
        state: circuitState,
        trips: circuitTrips,
        consecutiveFailures: circuitConsecutiveFailures,
        listFetchFailures: circuitListFetchFailures,
        threshold: cfg.circuitBreakerThreshold,
        cooldownMs: cfg.circuitBreakerCooldownMs,
        halfOpenPages: cfg.circuitBreakerHalfOpenPages,
      },
      observability: {
        retries: retryCount,
        listLatencyMs: buildDistributionStats(listLatencySamples),
        detailLatencyMs: buildDistributionStats(detailLatencySamples),
        queueDepth: buildDistributionStats(queueDepthSamples),
        errorTypes: Object.fromEntries(
          [...errorTypeCounts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ),
      },
    };

    if (incrementalEnabled) {
      await writeIncrementalCheckpoint(
        cfg.incrementalCheckpointPath,
        {
          updatedAt: new Date().toISOString(),
          lastSeen:
            firstSeenRow ||
            loadedIncrementalCheckpoint?.payload?.lastSeen || {
              id: null,
              ihaleTarihSaat: null,
            },
          sampleRows:
            recentRows.length > 0
              ? recentRows
              : loadedIncrementalCheckpoint?.payload?.sampleRows || [],
          lastRun: {
            processed,
            saved,
            failed,
            skippedUnchanged,
            pagesProcessed,
            stopped: stopped || incrementalStopTriggered,
          },
        },
        logger,
      );
    }

    logger.info(
      `[DONE] processed=${result.processed} saved=${result.saved} failed=${result.failed} skipped=${result.skippedUnchanged} dedupeSkipped=${result.dedupe.skipped} dedupeReplaced=${result.dedupe.replaced} pdfCreated=${result.pdfCreated} stopped=${result.stopped} dryRun=${result.dryRun} concurrency=${result.detailConcurrency} writeBatchSize=${result.writeBatchSize} incremental=${result.incremental.enabled ? "on" : "off"} adaptivePagination=${result.adaptivePagination.enabled ? "on" : "off"} pageAdjustments=${result.adaptivePagination.adjustments} adaptiveConcurrency=${result.adaptiveDetailConcurrency.enabled ? "on" : "off"} workerAdjustments=${result.adaptiveDetailConcurrency.adjustments} conditionalNotModified=${result.conditionalRequests.notModified} responseCacheHits=${result.responseCache.hits} circuitTrips=${result.circuitBreaker.trips} circuitState=${result.circuitBreaker.state} retries=${result.observability.retries} listP95=${result.observability.listLatencyMs.p95 ?? "-"} detailP95=${result.observability.detailLatencyMs.p95 ?? "-"}`,
    );

    return result;
  } finally {
    ekapClient.close();
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
    chunkArray,
    tuneAdaptivePageSize,
    tuneDetailConcurrency,
    shouldOpenCircuitBreaker,
    computePercentile,
    buildDistributionStats,
    classifyErrorType,
    normalizeIkn,
    buildPageRowDedupeKey,
    shouldReplaceDedupedRow,
    buildNormalizedUniqueKey,
    buildListRowFingerprint,
    isRowUnchangedAgainstExisting,
  },
};
