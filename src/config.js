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
