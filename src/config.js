const dotenv = require("dotenv");

dotenv.config();

function toInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const dryRunFromEnv = toBool(process.env.DRY_RUN, false);
const generatePdfDefault = dryRunFromEnv ? false : true;

const config = {
  listUrl:
    process.env.EKAP_LIST_URL ||
    "https://ekapv2.kik.gov.tr/b_ihalearama/api/Ihale/GetListByParameters",
  detailUrl:
    process.env.EKAP_DETAIL_URL ||
    "https://ekapv2.kik.gov.tr/b_ihalearama/api/IhaleDetay/GetByIhaleIdIhaleDetay",
  pageSize: Math.max(1, toInt(process.env.PAGE_SIZE, 10)),
  maxPages: Math.max(0, toInt(process.env.MAX_PAGES, 0)),
  startSkip: Math.max(0, toInt(process.env.START_SKIP, 0)),
  requestTimeoutMs: Math.max(1_000, toInt(process.env.REQUEST_TIMEOUT_MS, 30_000)),
  retryCount: Math.max(0, toInt(process.env.RETRY_COUNT, 5)),
  retryDelayMs: Math.max(0, toInt(process.env.RETRY_DELAY_MS, 1_500)),
  rateLimitMs: Math.max(0, toInt(process.env.RATE_LIMIT_MS, 300)),
  detailConcurrency: Math.max(1, Math.min(16, toInt(process.env.DETAIL_CONCURRENCY, 4))),
  writeBatchSize: Math.max(10, Math.min(1_000, toInt(process.env.WRITE_BATCH_SIZE, 100))),
  incrementalSync: toBool(process.env.SCRAPE_INCREMENTAL, true),
  incrementalStopUnchangedStreak: Math.max(
    5,
    toInt(process.env.SCRAPE_INCREMENTAL_STOP_STREAK, 40),
  ),
  incrementalCheckpointPath:
    process.env.SCRAPE_INCREMENTAL_CHECKPOINT || ".cache/scrape-incremental.json",
  adaptivePagination: toBool(process.env.SCRAPE_ADAPTIVE_PAGINATION, true),
  adaptivePageSizeMin: Math.max(1, toInt(process.env.SCRAPE_PAGE_SIZE_MIN, 10)),
  adaptivePageSizeMax: Math.max(1, toInt(process.env.SCRAPE_PAGE_SIZE_MAX, 40)),
  adaptivePageSizeStep: Math.max(1, toInt(process.env.SCRAPE_PAGE_SIZE_STEP, 5)),
  adaptivePageTargetMs: Math.max(200, toInt(process.env.SCRAPE_PAGE_TARGET_MS, 1_200)),
  adaptiveDetailConcurrency: toBool(process.env.SCRAPE_ADAPTIVE_DETAIL_CONCURRENCY, true),
  detailConcurrencyMin: Math.max(1, Math.min(16, toInt(process.env.DETAIL_CONCURRENCY_MIN, 1))),
  detailConcurrencyMax: Math.max(1, Math.min(16, toInt(process.env.DETAIL_CONCURRENCY_MAX, 16))),
  detailPageTargetMs: Math.max(500, toInt(process.env.DETAIL_PAGE_TARGET_MS, 8_000)),
  conditionalRequests: toBool(process.env.SCRAPE_CONDITIONAL_REQUESTS, true),
  conditionalCacheTtlMs: Math.max(10_000, toInt(process.env.SCRAPE_CONDITIONAL_CACHE_TTL_MS, 21_600_000)),
  conditionalCacheSize: Math.max(10, toInt(process.env.SCRAPE_CONDITIONAL_CACHE_SIZE, 2_000)),
  responseCacheEnabled: toBool(process.env.SCRAPE_RESPONSE_CACHE_ENABLED, true),
  responseCacheTtlMs: Math.max(1_000, toInt(process.env.SCRAPE_RESPONSE_CACHE_TTL_MS, 30_000)),
  responseCacheSize: Math.max(10, toInt(process.env.SCRAPE_RESPONSE_CACHE_SIZE, 2_000)),
  circuitBreakerEnabled: toBool(process.env.SCRAPE_CIRCUIT_BREAKER_ENABLED, true),
  circuitBreakerThreshold: Math.max(1, toInt(process.env.SCRAPE_CIRCUIT_BREAKER_THRESHOLD, 3)),
  circuitBreakerCooldownMs: Math.max(1_000, toInt(process.env.SCRAPE_CIRCUIT_BREAKER_COOLDOWN_MS, 15_000)),
  circuitBreakerHalfOpenPages: Math.max(1, toInt(process.env.SCRAPE_CIRCUIT_BREAKER_HALF_OPEN_PAGES, 1)),
  httpKeepAlive: toBool(process.env.HTTP_KEEP_ALIVE, true),
  httpMaxSockets: Math.max(4, toInt(process.env.HTTP_MAX_SOCKETS, 32)),
  httpMaxFreeSockets: Math.max(1, toInt(process.env.HTTP_MAX_FREE_SOCKETS, 8)),
  httpKeepAliveMs: Math.max(100, toInt(process.env.HTTP_KEEP_ALIVE_MS, 1_000)),
  mongodbUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  mongodbDb: process.env.MONGODB_DB || "ekap",
  mongodbCollection: process.env.MONGODB_COLLECTION || "ihale_detaylari",
  generatePdf: toBool(process.env.GENERATE_PDF, generatePdfDefault),
  pdfOutputDir: process.env.PDF_OUTPUT_DIR || "reports/pdfs",
  pdfFontPath: process.env.PDF_FONT_PATH || "",
  storeFullIlanContent: toBool(process.env.STORE_FULL_ILAN_CONTENT, false),
  dryRun: dryRunFromEnv,
  storeRawHtml: toBool(process.env.STORE_RAW_HTML, true),
};

module.exports = config;
