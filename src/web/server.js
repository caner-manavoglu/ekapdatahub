const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const { MongoClient } = require("mongodb");
const config = require("../config");
const { runScraper } = require("../scraper");
const { buildSelectedSummaryText } = require("../announcementExtractor");
const { cleanVeriHtml } = require("../htmlCleaner");
const { buildIlanPdfFileName, renderIlanPdfBuffer } = require("../pdfWriter");
const {
  ensureTenderCollectionIndexes,
  ensureEkapV3LogIndexes,
  ensureAuditLogIndexes,
  ensureOpsAlertIndexes,
  ensureOpsBenchmarkIndexes,
} = require("../dbIndexes");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const WEB_PORT = Number.parseInt(process.env.WEB_PORT || "8787", 10);
const WEB_HOST = String(process.env.WEB_HOST || "127.0.0.1").trim() || "127.0.0.1";
const SCRAPE_TIMEZONE = "Europe/Istanbul";
const DELETE_CONFIRMATION_TEXT = "onaylıyorum";
const EKAP_V3_DIR = path.resolve(__dirname, "../../ekap-v3");
const EKAP_V3_DOWNLOAD_ROOT_DIR = path.join(EKAP_V3_DIR, "indirilenler");
const EKAP_V3_CHECKPOINT_DIR = path.join(EKAP_V3_DIR, "checkpoints");
const EKAP_V3_DOWNLOAD_TYPES = ["mahkeme", "uyusmazlik"];
const EKAP_V3_DOWNLOAD_DIRS = {
  mahkeme: path.join(EKAP_V3_DOWNLOAD_ROOT_DIR, "mahkeme"),
  uyusmazlik: path.join(EKAP_V3_DOWNLOAD_ROOT_DIR, "uyusmazlik"),
};
const EKAP_V3_LOG_COLLECTION =
  process.env.EKAP_V3_LOG_COLLECTION || "ekap_v3_download_logs";
const AUDIT_LOG_COLLECTION = process.env.AUDIT_LOG_COLLECTION || "audit_logs";
const OPS_ALERT_COLLECTION = process.env.OPS_ALERT_COLLECTION || "ops_alert_events";
const OPS_BENCHMARK_COLLECTION = process.env.OPS_BENCHMARK_COLLECTION || "ops_benchmark_runs";
const EKAP_V3_COUNT_API_URLS = {
  uyusmazlik: "https://ekapv2.kik.gov.tr/b_ihalearaclari/api/KurulKararlari/GetKurulKararlari",
  mahkeme: "https://ekapv2.kik.gov.tr/b_ihalearaclari/api/KurulKararlari/GetKurulKararlariMk",
};
const EKAP_V3_UI_URL = "https://ekapv2.kik.gov.tr/sorgulamalar/kurul-kararlari";

let mongoClient;
let collection;
let ekapV3LogCollection;
let auditLogCollection;
let opsAlertCollection;
let opsBenchmarkCollection;
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
const ekapV3State = {
  running: false,
  stopRequested: false,
  currentRun: null,
  lastRun: null,
  lastError: null,
  logs: [],
  childProcess: null,
};
const opsState = {
  activeAlertFingerprints: new Set(),
  lastEvaluatedAt: null,
  timer: null,
};
const authSessions = new Map();
const loginAttemptState = new Map();
const ekapV3FilesCache = new Map();

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toBool(value, fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function computePercentile(values, percentile) {
  const list = Array.isArray(values)
    ? values.map((value) => toFiniteNumber(value, NaN)).filter((value) => Number.isFinite(value))
    : [];
  if (list.length === 0) return 0;
  const p = Math.min(1, Math.max(0, toFiniteNumber(percentile, 0.5)));
  const sorted = [...list].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function normalizeAuthRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "admin" || role === "operator" || role === "viewer") {
    return role;
  }
  return "viewer";
}

function parseAuthUsers(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error("AUTH_USERS gecersiz JSON formatinda.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AUTH_USERS bir dizi olmalidir.");
  }

  const users = [];
  const seen = new Set();
  for (const row of parsed) {
    const item = row && typeof row === "object" ? row : {};
    const username = String(item.username || "").trim();
    const password = String(item.password || "");
    const role = normalizeAuthRole(item.role);
    if (!username || !password) continue;

    const key = username.toLocaleLowerCase("tr-TR");
    if (seen.has(key)) continue;
    seen.add(key);
    users.push({
      username,
      usernameKey: key,
      password,
      role,
    });
  }
  return users;
}

const AUTH_ENABLED = toBool(process.env.AUTH_ENABLED, false);
const AUTH_COOKIE_NAME = String(process.env.AUTH_COOKIE_NAME || "ekap_auth").trim() || "ekap_auth";
const AUTH_COOKIE_SECURE = toBool(process.env.AUTH_COOKIE_SECURE, false);
const AUTH_TRUST_PROXY = toBool(process.env.AUTH_TRUST_PROXY, false);
const AUTH_SESSION_TTL_MS = Math.max(60_000, toInt(process.env.AUTH_SESSION_TTL_MS, 8 * 60 * 60 * 1000));
const AUTH_LOGIN_WINDOW_MS = Math.max(10_000, toInt(process.env.AUTH_LOGIN_WINDOW_MS, 15 * 60 * 1000));
const AUTH_LOGIN_MAX_ATTEMPTS = Math.max(1, toInt(process.env.AUTH_LOGIN_MAX_ATTEMPTS, 8));
const WEB_SKIP_OPEN_DIR = toBool(process.env.WEB_SKIP_OPEN_DIR, false);
const EKAP_V3_FILES_CACHE_TTL_MS = Math.max(1_000, toInt(process.env.EKAP_V3_FILES_CACHE_TTL_MS, 5_000));
const EKAP_V3_COUNT_TIMEOUT_MS = Math.max(5_000, toInt(process.env.EKAP_V3_COUNT_TIMEOUT_MS, 30_000));
const EKAP_V3_ROWS_PER_PAGE_ESTIMATE = Math.max(1, toInt(process.env.EKAP_V3_ROWS_PER_PAGE_ESTIMATE, 5));
const EKAP_V3_WORKER_COUNT_DEFAULT = Math.max(1, toInt(process.env.EKAP_V3_WORKER_COUNT, 1));
const EKAP_V3_WORKER_COUNT_MAX = Math.max(
  EKAP_V3_WORKER_COUNT_DEFAULT,
  Math.max(1, toInt(process.env.EKAP_V3_WORKER_COUNT_MAX, 8)),
);
const EKAP_V3_PREFLIGHT_TIMEOUT_MS = Math.max(1_000, toInt(process.env.EKAP_V3_PREFLIGHT_TIMEOUT_MS, 10_000));
const EKAP_V3_PREFLIGHT_CHECK_ENDPOINT = toBool(process.env.EKAP_V3_PREFLIGHT_CHECK_ENDPOINT, true);
const EKAP_V3_PREFLIGHT_STRICT = toBool(process.env.EKAP_V3_PREFLIGHT_STRICT, false);
const EKAP_V3_PREFLIGHT_ENDPOINT_METHOD = ["HEAD", "GET"].includes(
  String(process.env.EKAP_V3_PREFLIGHT_ENDPOINT_METHOD || "HEAD")
    .trim()
    .toUpperCase(),
)
  ? String(process.env.EKAP_V3_PREFLIGHT_ENDPOINT_METHOD || "HEAD")
      .trim()
      .toUpperCase()
  : "HEAD";
const EKAP_V3_PREFLIGHT_MIN_FREE_BYTES = Math.max(
  10 * 1024 * 1024,
  toInt(process.env.EKAP_V3_PREFLIGHT_MIN_FREE_BYTES, 200 * 1024 * 1024),
);
const OPS_DASHBOARD_WINDOW_HOURS = Math.max(1, toInt(process.env.OPS_DASHBOARD_WINDOW_HOURS, 24));
const OPS_ALERT_EVALUATE_INTERVAL_MS = Math.max(
  10_000,
  toInt(process.env.OPS_ALERT_EVALUATE_INTERVAL_MS, 60_000),
);
const OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT = Math.max(
  1,
  toInt(process.env.OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT, 18),
);
const OPS_ALERT_SCRAPE_LIST_P95_MS = Math.max(500, toInt(process.env.OPS_ALERT_SCRAPE_LIST_P95_MS, 7_000));
const OPS_ALERT_SCRAPE_DETAIL_P95_MS = Math.max(
  500,
  toInt(process.env.OPS_ALERT_SCRAPE_DETAIL_P95_MS, 15_000),
);
const OPS_ALERT_SCRAPE_QUEUE_P95 = Math.max(1, toInt(process.env.OPS_ALERT_SCRAPE_QUEUE_P95, 50));
const OPS_ALERT_STALLED_RUN_MINUTES = Math.max(1, toInt(process.env.OPS_ALERT_STALLED_RUN_MINUTES, 20));
const AUTH_USERS = parseAuthUsers(process.env.AUTH_USERS);
const AUTH_ROLE_WEIGHT = {
  viewer: 1,
  operator: 2,
  admin: 3,
};
const PANEL_KEY_DOCS = "docs";
const PANEL_KEY_EKAP_V3 = "ekapv3";
const PANEL_SELECTION_PATHS = {
  [PANEL_KEY_DOCS]: "/panel/dokumantasyon",
  [PANEL_KEY_EKAP_V3]: "/panel/ekapv3",
};
const PANEL_TARGET_PATHS = {
  [PANEL_KEY_DOCS]: "/dokumantasyon",
  [PANEL_KEY_EKAP_V3]: "/ekapv3.html",
};

if (AUTH_TRUST_PROXY) {
  app.set("trust proxy", true);
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

function appendEkapV3Log(level, message) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
  };
  ekapV3State.logs.push(entry);
  if (ekapV3State.logs.length > 500) {
    ekapV3State.logs.shift();
  }
}

function toOpsMetric(value, digits = 2) {
  const number = toFiniteNumber(value, NaN);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round(number * factor) / factor;
}

function toDurationMs(startValue, endValue) {
  const start = toDateOrNull(startValue);
  const end = toDateOrNull(endValue);
  if (!start || !end) return null;
  const diff = end.getTime() - start.getTime();
  if (!Number.isFinite(diff) || diff <= 0) return null;
  return diff;
}

function getLatestEkapV3ActivityAt(runLike, logs) {
  const candidates = [];
  const checkpointUpdatedAt = runLike?.checkpoint?.updatedAt;
  if (checkpointUpdatedAt) {
    candidates.push(checkpointUpdatedAt);
  }
  const logRows = Array.isArray(logs) ? logs : [];
  for (let index = logRows.length - 1; index >= 0; index -= 1) {
    const timestamp = logRows[index]?.timestamp;
    if (timestamp) {
      candidates.push(timestamp);
      break;
    }
  }
  candidates.push(runLike?.startedAt);

  let latest = null;
  for (const value of candidates) {
    const date = toDateOrNull(value);
    if (!date) continue;
    if (!latest || date.getTime() > latest.getTime()) {
      latest = date;
    }
  }
  return latest;
}

function buildOpsWindowKpisFromRuns(runRows) {
  const rows = Array.isArray(runRows) ? runRows : [];
  let downloadedCount = 0;
  let failedCount = 0;
  let retryCount = 0;
  let duplicateCount = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let stoppedRuns = 0;
  let runningRuns = 0;
  const durationMsList = [];

  for (const row of rows) {
    downloadedCount += Math.max(0, toInt(row?.downloadedCount, 0));
    failedCount += Math.max(0, toInt(row?.failedCount, 0));
    retryCount += Math.max(0, toInt(row?.retryCount, 0));
    duplicateCount += Math.max(0, toInt(row?.duplicateCount, 0));

    const status = String(row?.status || "").trim();
    if (status === "completed") completedRuns += 1;
    else if (status === "failed") failedRuns += 1;
    else if (status === "stopped") stoppedRuns += 1;
    else if (status === "running") runningRuns += 1;

    const durationMs = toDurationMs(row?.startedAt, row?.finishedAt);
    if (durationMs !== null) {
      durationMsList.push(durationMs);
    }
  }

  const processedCount = downloadedCount + failedCount;
  const successRatePct = processedCount > 0 ? (downloadedCount / processedCount) * 100 : 100;
  const failureRatePct = processedCount > 0 ? (failedCount / processedCount) * 100 : 0;
  const avgDurationMs =
    durationMsList.length > 0
      ? durationMsList.reduce((sum, item) => sum + item, 0) / durationMsList.length
      : 0;
  const durationP95Ms = computePercentile(durationMsList, 0.95);

  return {
    runCount: rows.length,
    completedRuns,
    failedRuns,
    stoppedRuns,
    runningRuns,
    processedCount,
    downloadedCount,
    failedCount,
    retryCount,
    duplicateCount,
    successRatePct: toOpsMetric(successRatePct, 2),
    failureRatePct: toOpsMetric(failureRatePct, 2),
    avgDurationSec: toOpsMetric(avgDurationMs / 1_000, 2),
    p95DurationSec: toOpsMetric(durationP95Ms / 1_000, 2),
  };
}

function buildScrapeOpsSummary() {
  const lastResult = scrapeState.lastResult && typeof scrapeState.lastResult === "object"
    ? scrapeState.lastResult
    : null;
  const observability = lastResult?.observability && typeof lastResult.observability === "object"
    ? lastResult.observability
    : {};
  const listLatency = observability?.listLatencyMs || {};
  const detailLatency = observability?.detailLatencyMs || {};
  const queueDepth = observability?.queueDepth || {};
  const processed = Math.max(0, toInt(lastResult?.processed, 0));
  const failed = Math.max(0, toInt(lastResult?.failed, 0));
  const failureRatePct = processed > 0 ? (failed / processed) * 100 : 0;

  return {
    running: scrapeState.running,
    lastRunStartedAt: scrapeState.lastRunStartedAt,
    lastRunFinishedAt: scrapeState.lastRunFinishedAt,
    lastError: scrapeState.lastError,
    hasResult: Boolean(lastResult),
    processed,
    saved: Math.max(0, toInt(lastResult?.saved, 0)),
    failed,
    retries: Math.max(0, toInt(observability?.retries, 0)),
    failureRatePct: toOpsMetric(failureRatePct, 2),
    listLatencyMsP95: toOpsMetric(listLatency?.p95, 1),
    detailLatencyMsP95: toOpsMetric(detailLatency?.p95, 1),
    queueDepthP95: toOpsMetric(queueDepth?.p95, 1),
  };
}

function buildOpsKpiCards({ windowHours, downloadWindow, runningDownload, scrapeSummary }) {
  const cards = [
    {
      key: "download_runs",
      title: `Indirme Run (${windowHours} saat)`,
      value: String(downloadWindow.runCount),
      hint: `tamam ${downloadWindow.completedRuns} | hata ${downloadWindow.failedRuns} | durdu ${downloadWindow.stoppedRuns}`,
      tone: "neutral",
    },
    {
      key: "download_success_rate",
      title: "Indirme Basari",
      value: `%${downloadWindow.successRatePct ?? 0}`,
      hint: `${downloadWindow.downloadedCount} basarili / ${downloadWindow.processedCount} islenen`,
      tone: downloadWindow.successRatePct >= 90 ? "good" : downloadWindow.successRatePct >= 75 ? "warn" : "danger",
    },
    {
      key: "download_p95_duration",
      title: "Indirme P95 Sure",
      value: `${downloadWindow.p95DurationSec ?? 0}s`,
      hint: `ortalama ${downloadWindow.avgDurationSec ?? 0}s`,
      tone: "neutral",
    },
    {
      key: "scrape_detail_p95",
      title: "Scrape Detail P95",
      value: scrapeSummary.detailLatencyMsP95 === null ? "-" : `${scrapeSummary.detailLatencyMsP95}ms`,
      hint:
        scrapeSummary.listLatencyMsP95 === null
          ? "liste p95: -"
          : `liste p95: ${scrapeSummary.listLatencyMsP95}ms`,
      tone:
        scrapeSummary.detailLatencyMsP95 !== null &&
        scrapeSummary.detailLatencyMsP95 >= OPS_ALERT_SCRAPE_DETAIL_P95_MS
          ? "danger"
          : "neutral",
    },
    {
      key: "scrape_queue_p95",
      title: "Scrape Queue P95",
      value: scrapeSummary.queueDepthP95 === null ? "-" : String(scrapeSummary.queueDepthP95),
      hint: `retry: ${scrapeSummary.retries}`,
      tone:
        scrapeSummary.queueDepthP95 !== null && scrapeSummary.queueDepthP95 >= OPS_ALERT_SCRAPE_QUEUE_P95
          ? "warn"
          : "neutral",
    },
    {
      key: "active_jobs",
      title: "Aktif Isler",
      value: String((runningDownload ? 1 : 0) + (scrapeSummary.running ? 1 : 0)),
      hint: `indirme:${runningDownload ? "acik" : "kapali"} | scrape:${scrapeSummary.running ? "acik" : "kapali"}`,
      tone: runningDownload || scrapeSummary.running ? "warn" : "good",
    },
  ];

  return cards;
}

function buildOpsAlerts({ downloadWindow, runningDownload, scrapeSummary }) {
  const alerts = [];

  if (downloadWindow.processedCount >= 20 && downloadWindow.failureRatePct >= OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT) {
    alerts.push({
      id: "download.failure-rate",
      severity: "critical",
      source: "download",
      metric: "failureRatePct",
      value: toOpsMetric(downloadWindow.failureRatePct, 2),
      threshold: OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT,
      message: `Indirme hata orani yuksek: %${toOpsMetric(downloadWindow.failureRatePct, 2)} (esik %${OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT})`,
    });
  }

  if (runningDownload) {
    const runningAgeMinutes = toOpsMetric(runningDownload.runningAgeMinutes, 1);
    const lastProgressAgeMinutes = toOpsMetric(runningDownload.lastProgressAgeMinutes, 1);
    const progressThreshold = Math.max(3, Math.floor(OPS_ALERT_STALLED_RUN_MINUTES / 2));
    if (
      runningAgeMinutes !== null &&
      lastProgressAgeMinutes !== null &&
      runningAgeMinutes >= OPS_ALERT_STALLED_RUN_MINUTES &&
      lastProgressAgeMinutes >= progressThreshold
    ) {
      alerts.push({
        id: "download.stalled-run",
        severity: "critical",
        source: "download",
        metric: "runningAgeMinutes",
        value: runningAgeMinutes,
        threshold: OPS_ALERT_STALLED_RUN_MINUTES,
        message: `Indirme isi takilmis gorunuyor: ${runningAgeMinutes} dk calisma, son ilerleme ${lastProgressAgeMinutes} dk once.`,
      });
    }
  }

  if (scrapeSummary.hasResult && scrapeSummary.listLatencyMsP95 !== null) {
    if (scrapeSummary.listLatencyMsP95 >= OPS_ALERT_SCRAPE_LIST_P95_MS) {
      alerts.push({
        id: "scrape.list-p95",
        severity: "warning",
        source: "scrape",
        metric: "listLatencyMsP95",
        value: scrapeSummary.listLatencyMsP95,
        threshold: OPS_ALERT_SCRAPE_LIST_P95_MS,
        message: `Scrape liste p95 suresi esigi asti: ${scrapeSummary.listLatencyMsP95}ms (esik ${OPS_ALERT_SCRAPE_LIST_P95_MS}ms).`,
      });
    }
  }

  if (scrapeSummary.hasResult && scrapeSummary.detailLatencyMsP95 !== null) {
    if (scrapeSummary.detailLatencyMsP95 >= OPS_ALERT_SCRAPE_DETAIL_P95_MS) {
      alerts.push({
        id: "scrape.detail-p95",
        severity: "critical",
        source: "scrape",
        metric: "detailLatencyMsP95",
        value: scrapeSummary.detailLatencyMsP95,
        threshold: OPS_ALERT_SCRAPE_DETAIL_P95_MS,
        message: `Scrape detay p95 suresi esigi asti: ${scrapeSummary.detailLatencyMsP95}ms (esik ${OPS_ALERT_SCRAPE_DETAIL_P95_MS}ms).`,
      });
    }
  }

  if (scrapeSummary.hasResult && scrapeSummary.queueDepthP95 !== null) {
    if (scrapeSummary.queueDepthP95 >= OPS_ALERT_SCRAPE_QUEUE_P95) {
      alerts.push({
        id: "scrape.queue-p95",
        severity: "warning",
        source: "scrape",
        metric: "queueDepthP95",
        value: scrapeSummary.queueDepthP95,
        threshold: OPS_ALERT_SCRAPE_QUEUE_P95,
        message: `Scrape queue depth p95 yuksek: ${scrapeSummary.queueDepthP95} (esik ${OPS_ALERT_SCRAPE_QUEUE_P95}).`,
      });
    }
  }

  return alerts;
}

async function publishOpsAlertTransitions(alerts) {
  const nextIds = new Set((alerts || []).map((item) => String(item?.id || "")));
  const previousIds = opsState.activeAlertFingerprints;
  const triggered = (alerts || []).filter((item) => !previousIds.has(String(item?.id || "")));
  const resolvedIds = [...previousIds].filter((id) => !nextIds.has(id));

  if (triggered.length > 0) {
    for (const alert of triggered) {
      console.error(`[OPS_ALERT][${alert.severity}] ${alert.message}`);
    }
  }

  if (resolvedIds.length > 0) {
    for (const id of resolvedIds) {
      console.log(`[OPS_ALERT][resolved] ${id}`);
    }
  }

  if (opsAlertCollection && (triggered.length > 0 || resolvedIds.length > 0)) {
    const now = new Date();
    const docs = [];
    for (const alert of triggered) {
      docs.push({
        fingerprint: String(alert.id || ""),
        status: "triggered",
        severity: String(alert.severity || "warning"),
        source: String(alert.source || "ops"),
        metric: String(alert.metric || ""),
        value: toFiniteNumber(alert.value, 0),
        threshold: toFiniteNumber(alert.threshold, 0),
        message: String(alert.message || ""),
        payload: alert,
        createdAt: now,
      });
    }
    for (const id of resolvedIds) {
      docs.push({
        fingerprint: String(id || ""),
        status: "resolved",
        severity: "info",
        source: "ops",
        metric: "",
        value: 0,
        threshold: 0,
        message: `Alarm cozuldu: ${id}`,
        payload: null,
        createdAt: now,
      });
    }
    try {
      if (docs.length > 0) {
        await opsAlertCollection.insertMany(docs, { ordered: false });
      }
    } catch (error) {
      console.error("[OPS_ALERT_DB_ERROR]", error?.message || error);
    }
  }

  opsState.activeAlertFingerprints = nextIds;
  opsState.lastEvaluatedAt = new Date().toISOString();
}

async function queryEkapV3RunsForWindow(windowStartDate, limit = 300) {
  if (ekapV3LogCollection) {
    return await ekapV3LogCollection
      .find({
        startedAt: {
          $gte: windowStartDate,
        },
      })
      .sort({ startedAt: -1, createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  const rows = [];
  if (ekapV3State.currentRun) {
    rows.push({ ...ekapV3State.currentRun });
  }
  if (ekapV3State.lastRun) {
    rows.push({ ...ekapV3State.lastRun });
  }
  return rows.filter((row) => {
    const startedAt = toDateOrNull(row?.startedAt);
    return startedAt ? startedAt.getTime() >= windowStartDate.getTime() : true;
  });
}

async function buildOpsDashboardData(options = {}) {
  const requestedWindow = Math.max(1, toInt(options.windowHours, OPS_DASHBOARD_WINDOW_HOURS));
  const windowHours = Math.min(168, requestedWindow);
  const windowStartDate = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const runs = await queryEkapV3RunsForWindow(windowStartDate);
  const downloadWindow = buildOpsWindowKpisFromRuns(runs);
  const scrapeSummary = buildScrapeOpsSummary();
  const activeRun = ekapV3State.running ? ekapV3State.currentRun : null;
  const latestActivityAt = getLatestEkapV3ActivityAt(activeRun, ekapV3State.logs);
  const runningStartedAt = toDateOrNull(activeRun?.startedAt);
  const nowMs = Date.now();
  const runningDownload = activeRun
    ? {
        runId: activeRun?.runId || null,
        type: activeRun?.type || null,
        startedAt: safeIsoDate(activeRun?.startedAt),
        latestActivityAt: safeIsoDate(latestActivityAt),
        runningAgeMinutes:
          runningStartedAt && Number.isFinite(nowMs)
            ? (nowMs - runningStartedAt.getTime()) / (60 * 1000)
            : null,
        lastProgressAgeMinutes:
          latestActivityAt && Number.isFinite(nowMs) ? (nowMs - latestActivityAt.getTime()) / (60 * 1000) : null,
      }
    : null;

  const alerts = buildOpsAlerts({
    downloadWindow,
    runningDownload,
    scrapeSummary,
  });
  if (options.persistAlerts) {
    await publishOpsAlertTransitions(alerts);
  }

  const kpis = buildOpsKpiCards({
    windowHours,
    downloadWindow,
    runningDownload,
    scrapeSummary,
  });

  return {
    generatedAt: new Date().toISOString(),
    window: {
      hours: windowHours,
      from: windowStartDate.toISOString(),
      to: new Date().toISOString(),
    },
    thresholds: {
      downloadFailureRatePct: OPS_ALERT_DOWNLOAD_FAILURE_RATE_PCT,
      stalledRunMinutes: OPS_ALERT_STALLED_RUN_MINUTES,
      scrapeListP95Ms: OPS_ALERT_SCRAPE_LIST_P95_MS,
      scrapeDetailP95Ms: OPS_ALERT_SCRAPE_DETAIL_P95_MS,
      scrapeQueueP95: OPS_ALERT_SCRAPE_QUEUE_P95,
    },
    downloads: {
      window: downloadWindow,
      running: runningDownload,
      latestRunId: activeRun?.runId || ekapV3State.lastRun?.runId || null,
      latestStatus: activeRun?.status || ekapV3State.lastRun?.status || null,
    },
    scrape: scrapeSummary,
    alerts,
    kpis,
    alertState: {
      activeCount: alerts.length,
      lastEvaluatedAt: opsState.lastEvaluatedAt,
    },
  };
}

async function getRecentOpsAlertEvents(limit = 30) {
  if (!opsAlertCollection) {
    return [];
  }
  const safeLimit = Math.min(200, Math.max(1, toInt(limit, 30)));
  const rows = await opsAlertCollection
    .find({})
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();

  return rows.map((row) => ({
    id: row?._id ? String(row._id) : null,
    fingerprint: row?.fingerprint || null,
    status: row?.status || null,
    severity: row?.severity || null,
    source: row?.source || null,
    metric: row?.metric || null,
    value: Number.isFinite(Number(row?.value)) ? Number(row.value) : null,
    threshold: Number.isFinite(Number(row?.threshold)) ? Number(row.threshold) : null,
    message: row?.message || "",
    createdAt: safeIsoDate(row?.createdAt),
  }));
}

function normalizeOpsBenchmarkPayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  const endpointRows = Array.isArray(payload?.endpoints) ? payload.endpoints : [];
  const normalizedEndpoints = endpointRows
    .slice(0, 40)
    .map((row) => ({
      id: String(row?.id || "").trim(),
      path: String(row?.path || "").trim(),
      p50Ms: toOpsMetric(row?.p50Ms, 2),
      p95Ms: toOpsMetric(row?.p95Ms, 2),
      avgMs: toOpsMetric(row?.avgMs, 2),
      maxMs: toOpsMetric(row?.maxMs, 2),
      failures: Math.max(0, toInt(row?.failures, 0)),
    }))
    .filter((row) => row.id);

  const regressions = Array.isArray(payload?.regressions) ? payload.regressions : [];
  const normalizedRegressions = regressions
    .slice(0, 40)
    .map((row) => ({
      id: String(row?.id || "").trim(),
      path: String(row?.path || "").trim(),
      baselineP95Ms: toOpsMetric(row?.baselineP95Ms, 2),
      currentP95Ms: toOpsMetric(row?.currentP95Ms, 2),
      changePct: toOpsMetric(row?.changePct, 2),
    }))
    .filter((row) => row.id);

  return {
    benchmarkId: `ops-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: String(payload?.source || "manual").trim() || "manual",
    baseUrl: String(payload?.baseUrl || "").trim() || null,
    sampleCount: Math.max(1, toInt(payload?.sampleCount, 1)),
    maxRegressionPct: toOpsMetric(payload?.maxRegressionPct, 2),
    baselineFile: String(payload?.baselineFile || "").trim() || null,
    endpoints: normalizedEndpoints,
    regressions: normalizedRegressions,
    summary: {
      endpointCount: normalizedEndpoints.length,
      regressionCount: normalizedRegressions.length,
      failureCount: normalizedEndpoints.reduce((sum, item) => sum + Math.max(0, toInt(item.failures, 0)), 0),
    },
    createdAt: new Date(),
  };
}

function startOpsAlertMonitor() {
  if (opsState.timer) {
    clearInterval(opsState.timer);
    opsState.timer = null;
  }

  opsState.timer = setInterval(() => {
    void buildOpsDashboardData({ persistAlerts: true }).catch((error) => {
      console.error("[OPS_ALERT_MONITOR_ERROR]", error?.message || error);
    });
  }, OPS_ALERT_EVALUATE_INTERVAL_MS);

  if (typeof opsState.timer.unref === "function") {
    opsState.timer.unref();
  }
}

function normalizeEkapV3Type(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("tr-TR");
  return normalized === "uyusmazlik" ? "uyusmazlik" : normalized === "mahkeme" ? "mahkeme" : "";
}

function parseEkapV3InputDate(value, label = "Tarih") {
  const input = String(value || "").trim();
  const ymdMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmyMatch = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

  let year = 0;
  let month = 0;
  let day = 0;
  if (ymdMatch) {
    year = toInt(ymdMatch[1], 0);
    month = toInt(ymdMatch[2], 0);
    day = toInt(ymdMatch[3], 0);
  } else if (dmyMatch) {
    day = toInt(dmyMatch[1], 0);
    month = toInt(dmyMatch[2], 0);
    year = toInt(dmyMatch[3], 0);
  } else {
    throw new Error(`${label} gecersiz. YYYY-MM-DD veya DD.MM.YYYY kullanin.`);
  }

  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${label} gecersiz.`);
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(utcDate.getTime()) ||
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() + 1 !== month ||
    utcDate.getUTCDate() !== day
  ) {
    throw new Error(`${label} gecersiz.`);
  }

  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    year,
    month,
    day,
    normalized: `${yyyy}-${mm}-${dd}`,
    dmy: `${dd}.${mm}.${yyyy}`,
    sortKey: year * 10000 + month * 100 + day,
  };
}

function parseEkapV3Options(body) {
  const payload = body && typeof body === "object" ? body : {};
  const type = normalizeEkapV3Type(payload.type);
  if (!type) {
    throw new Error("Geçersiz tür. mahkeme veya uyusmazlik olmalı.");
  }

  const fromDateRaw = String(payload.fromDate || "").trim();
  const toDateRaw = String(payload.toDate || "").trim();
  if (!fromDateRaw || !toDateRaw) {
    throw new Error("Başlangıç ve bitiş tarihi zorunludur.");
  }
  const fromDateParsed = parseEkapV3InputDate(fromDateRaw, "Baslangic tarihi");
  const toDateParsed = parseEkapV3InputDate(toDateRaw, "Bitis tarihi");
  if (fromDateParsed.sortKey > toDateParsed.sortKey) {
    throw new Error("Baslangic tarihi bitis tarihinden buyuk olamaz.");
  }
  const fromDate = fromDateParsed.normalized;
  const toDate = toDateParsed.normalized;

  const allPages = toBool(payload.allPages, false);
  const startPage = allPages ? 1 : Math.max(1, toInt(payload.startPage, 1));
  const startRow = Math.max(1, toInt(payload.startRow, 1));
  const endPage = allPages ? null : Math.max(startPage, toInt(payload.endPage, startPage));
  const workerCount = Math.min(
    EKAP_V3_WORKER_COUNT_MAX,
    Math.max(1, toInt(payload.workerCount, EKAP_V3_WORKER_COUNT_DEFAULT)),
  );
  const browserModeRaw = String(payload.browserMode || "headless")
    .trim()
    .toLocaleLowerCase("tr-TR");
  const browserMode = browserModeRaw === "visible" ? "visible" : "headless";

  return {
    type,
    fromDate,
    toDate,
    startPage,
    startRow,
    endPage,
    allPages,
    workerCount,
    browserMode,
  };
}

function parsePageAndLimit(query, { defaultLimit, maxLimit }) {
  const payload = query && typeof query === "object" ? query : {};
  const limit = Math.min(maxLimit, Math.max(1, toInt(payload.limit, defaultLimit)));
  const requestedPage = Math.max(1, toInt(payload.page, 1));
  return {
    limit,
    requestedPage,
  };
}

function formatEkapV3CountDateBoundary(value, boundary) {
  const parsed = parseEkapV3InputDate(value, "Tarih");
  return `${parsed.dmy} ${boundary === "start" ? "00:00:00" : "23:59:00"}`;
}

function buildEkapV3CountPayload(type, fromDate, toDate) {
  const filters = [
    {
      key: "KararTarihi1",
      value: formatEkapV3CountDateBoundary(fromDate, "start"),
    },
    {
      key: "KararTarihi2",
      value: formatEkapV3CountDateBoundary(toDate, "end"),
    },
  ];

  if (type === "mahkeme") {
    return {
      sorgulaKurulKararlariMk: {
        keyValuePairs: {
          keyValueOfstringanyType: filters,
        },
      },
    };
  }

  return {
    sorgulaKurulKararlari: {
      keyValuePairs: {
        keyValueOfstringanyType: filters,
      },
    },
  };
}

function parseEkapV3CountResponse(type, payload) {
  const isNoRecordMessage = (value) =>
    /bulunamami|kayıt bulunamam|kayit bulunamam/i.test(String(value || ""));

  if (type === "mahkeme") {
    const root = payload?.SorgulaKurulKararlariMkResponse?.SorgulaKurulKararlariMkResult || {};
    const errorCode = String(root?.HataKodu ?? "").trim();
    const errorMessage = String(root?.HataMesaji ?? "").trim();
    if (errorCode && errorCode !== "0" && !isNoRecordMessage(errorMessage)) {
      throw new Error(errorMessage || `MK API hata kodu: ${errorCode}`);
    }

    const list = Array.isArray(root?.KurulKararTutanakDetayListesi) ? root.KurulKararTutanakDetayListesi : [];
    let totalCount = 0;
    for (const item of list) {
      const rows = item?.KurulKararTutanakDetayi;
      if (Array.isArray(rows)) {
        totalCount += rows.length;
      }
    }

    return {
      totalCount,
      totalCountCapped: totalCount >= 500,
      estimatedPages: totalCount > 0 ? Math.ceil(totalCount / EKAP_V3_ROWS_PER_PAGE_ESTIMATE) : 0,
    };
  }

  const root = payload?.SorgulaKurulKararlariResponse?.SorgulaKurulKararlariResult || {};
  const errorCode = String(root?.hataKodu ?? "").trim();
  const errorMessage = String(root?.hataMesaji ?? "").trim();
  if (errorCode && errorCode !== "0" && !isNoRecordMessage(errorMessage)) {
    throw new Error(errorMessage || `UM API hata kodu: ${errorCode}`);
  }

  const list = Array.isArray(root?.KurulKararTutanakDetayListesi) ? root.KurulKararTutanakDetayListesi : [];
  let totalCount = 0;
  for (const item of list) {
    const rows = item?.kurulKararTutanakDetayi;
    if (Array.isArray(rows)) {
      totalCount += rows.length;
    }
  }

  return {
    totalCount,
    totalCountCapped: totalCount >= 500,
    estimatedPages: totalCount > 0 ? Math.ceil(totalCount / EKAP_V3_ROWS_PER_PAGE_ESTIMATE) : 0,
  };
}

async function fetchEkapV3CountFromApi(options) {
  const type = normalizeEkapV3Type(options?.type);
  const fromDate = String(options?.fromDate || "").trim();
  const toDate = String(options?.toDate || "").trim();
  const url = EKAP_V3_COUNT_API_URLS[type];
  if (!url) {
    throw new Error("Sayim icin gecersiz tur.");
  }
  if (!fromDate || !toDate) {
    throw new Error("Sayim icin tarih araligi zorunlu.");
  }

  const requestPayload = buildEkapV3CountPayload(type, fromDate, toDate);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, EKAP_V3_COUNT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json, text/plain, */*",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Sayim API istegi basarisiz: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    return parseEkapV3CountResponse(type, payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Sayim API istegi zaman asimina ugradi.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function createEkapV3RunId() {
  return `ekapv3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveEkapV3DownloadType(value) {
  const normalized = String(value || "")
    .trim()
    .toLocaleLowerCase("tr-TR");
  if (normalized === "mahkeme" || normalized === "uyusmazlik") {
    return normalized;
  }
  return "";
}

function isSafeFileName(fileName) {
  if (!fileName) return false;
  if (fileName.includes("\0")) return false;
  return path.basename(fileName) === fileName;
}

async function ensureEkapV3DownloadDirs() {
  await fs.promises.mkdir(EKAP_V3_DOWNLOAD_ROOT_DIR, { recursive: true });
  await fs.promises.mkdir(EKAP_V3_CHECKPOINT_DIR, { recursive: true });
  await Promise.all(
    EKAP_V3_DOWNLOAD_TYPES.map((type) =>
      fs.promises.mkdir(EKAP_V3_DOWNLOAD_DIRS[type], { recursive: true }),
    ),
  );
}

function toSafeCheckpointSegment(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";
}

function buildEkapV3CheckpointPath(options) {
  const type = normalizeEkapV3Type(options?.type) || "x";
  const fromDate = toSafeCheckpointSegment(options?.fromDate);
  const toDate = toSafeCheckpointSegment(options?.toDate);
  const fileName = `${type}-${fromDate}-${toDate}.json`;
  return path.join(EKAP_V3_CHECKPOINT_DIR, fileName);
}

async function runEkapV3Preflight(options) {
  const type = normalizeEkapV3Type(options?.type);
  if (!type) {
    throw new Error("Preflight icin gecersiz tur.");
  }

  const downloadDir = EKAP_V3_DOWNLOAD_DIRS[type];
  await fs.promises.mkdir(downloadDir, { recursive: true });
  await fs.promises.mkdir(EKAP_V3_CHECKPOINT_DIR, { recursive: true });

  const probePath = path.join(
    downloadDir,
    `.probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await fs.promises.writeFile(probePath, "ok", "utf8");
  await fs.promises.unlink(probePath).catch(() => {});

  let freeBytes = null;
  try {
    const statfs = await fs.promises.statfs(downloadDir);
    const freeBlocks =
      typeof statfs?.bavail === "bigint" ? Number(statfs.bavail) : Number(statfs?.bavail || 0);
    const blockSize =
      typeof statfs?.bsize === "bigint" ? Number(statfs.bsize) : Number(statfs?.bsize || 0);
    if (Number.isFinite(freeBlocks) && Number.isFinite(blockSize)) {
      freeBytes = Math.max(0, Math.floor(freeBlocks * blockSize));
    }
  } catch (_) {
    freeBytes = null;
  }

  if (freeBytes !== null && freeBytes < EKAP_V3_PREFLIGHT_MIN_FREE_BYTES) {
    throw new Error(
      `Disk bos alan yetersiz. Gereken: ${EKAP_V3_PREFLIGHT_MIN_FREE_BYTES} byte, mevcut: ${freeBytes} byte.`,
    );
  }

  let endpointStatus = null;
  let endpointCheckMethod = EKAP_V3_PREFLIGHT_ENDPOINT_METHOD;
  let endpointCheckOk = false;
  let endpointCheckError = null;

  if (EKAP_V3_PREFLIGHT_CHECK_ENDPOINT) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, EKAP_V3_PREFLIGHT_TIMEOUT_MS);

    try {
      const request = async (method) =>
        fetch(EKAP_V3_UI_URL, {
          method,
          signal: controller.signal,
        });

      let response = await request(endpointCheckMethod);
      if (endpointCheckMethod === "HEAD" && response.status === 405) {
        endpointCheckMethod = "GET";
        response = await request("GET");
      }

      endpointStatus = response.status;
      if (response.status >= 500) {
        endpointCheckError = `EKAP UI endpoint ulasilamaz durumda: HTTP ${response.status}`;
      } else {
        endpointCheckOk = true;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        endpointCheckError = "Preflight endpoint kontrolu zaman asimina ugradi.";
      } else {
        endpointCheckError = `Preflight endpoint kontrolu basarisiz: ${error?.message || String(error)}`;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (endpointCheckError && EKAP_V3_PREFLIGHT_STRICT) {
    throw new Error(endpointCheckError);
  }

  return {
    ok: true,
    type,
    downloadDir,
    freeBytes,
    minRequiredFreeBytes: EKAP_V3_PREFLIGHT_MIN_FREE_BYTES,
    endpoint: EKAP_V3_UI_URL,
    endpointStatus,
    endpointCheckEnabled: EKAP_V3_PREFLIGHT_CHECK_ENDPOINT,
    endpointCheckStrict: EKAP_V3_PREFLIGHT_STRICT,
    endpointCheckMethod,
    endpointCheckOk,
    endpointCheckError,
    checkedAt: new Date().toISOString(),
  };
}

async function openPathInFileManager(targetPath) {
  if (WEB_SKIP_OPEN_DIR) {
    return;
  }

  const absolutePath = path.resolve(String(targetPath || ""));
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  const args = [absolutePath];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    let settled = false;

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Klasör açılamadı: ${error?.message || String(error)}`));
    });

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function setCollectionsForTest(
  nextCollection,
  nextEkapV3LogCollection,
  nextAuditLogCollection,
  nextOpsAlertCollection,
  nextOpsBenchmarkCollection,
) {
  collection = nextCollection;
  ekapV3LogCollection = nextEkapV3LogCollection;
  auditLogCollection = nextAuditLogCollection;
  opsAlertCollection = nextOpsAlertCollection;
  opsBenchmarkCollection = nextOpsBenchmarkCollection;
}

async function writeAuditLog(req, action, details = {}) {
  if (!auditLogCollection) {
    return;
  }

  const actor = req?.auth || {};
  const payload = {
    action: String(action || "unknown"),
    actor: {
      username: String(actor.username || "").trim() || "unknown",
      role: normalizeAuthRole(actor.role),
      ip: getClientAddress(req),
    },
    details: details && typeof details === "object" ? details : {},
    createdAt: new Date(),
  };

  try {
    await auditLogCollection.insertOne(payload);
  } catch (error) {
    // Logging should not block the main operation flow.
    console.error("[AUDIT_LOG_ERROR]", error?.message || error);
  }
}

function normalizeEkapV3SelectedFiles(value) {
  const input = Array.isArray(value) ? value : [];
  const rows = [];
  const seen = new Set();

  for (const item of input) {
    const payload = item && typeof item === "object" ? item : {};
    const type = resolveEkapV3DownloadType(payload.type);
    const fileName = String(payload.fileName || "").trim();
    if (!type || !isSafeFileName(fileName)) continue;

    const key = `${type}::${fileName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ type, fileName });
  }

  return rows;
}

async function deleteEkapV3Files(fileEntries) {
  const entries = Array.isArray(fileEntries) ? fileEntries : [];
  let deletedCount = 0;
  let missingCount = 0;

  for (const entry of entries) {
    const type = resolveEkapV3DownloadType(entry?.type);
    const fileName = String(entry?.fileName || "").trim();
    if (!type || !isSafeFileName(fileName)) continue;

    const dirPath = EKAP_V3_DOWNLOAD_DIRS[type];
    const absolutePath = path.join(dirPath, fileName);
    try {
      const stat = await fs.promises.stat(absolutePath);
      if (!stat.isFile()) {
        missingCount += 1;
        continue;
      }
      await fs.promises.unlink(absolutePath);
      deletedCount += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        missingCount += 1;
        continue;
      }
      throw error;
    }
  }

  return { deletedCount, missingCount };
}

async function readEkapV3FilesByType(type) {
  const dirPath = EKAP_V3_DOWNLOAD_DIRS[type];
  if (!dirPath) return [];

  let entries = [];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    if (!fileName || fileName === ".DS_Store") continue;
    if (fileName.endsWith(".crdownload") || fileName.endsWith(".part")) continue;

    const absolutePath = path.join(dirPath, fileName);
    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (_) {
      continue;
    }
    if (!stat.isFile()) continue;

    rows.push({
      type,
      fileName,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      updatedAtMs: stat.mtimeMs,
    });
  }

  return rows;
}

function clearEkapV3FilesCache() {
  ekapV3FilesCache.clear();
}

async function buildEkapV3FilesSnapshot(typeFilter) {
  const targets = typeFilter ? [typeFilter] : [...EKAP_V3_DOWNLOAD_TYPES];
  const groupedEntries = await Promise.all(
    targets.map(async (type) => ({
      type,
      rows: await readEkapV3FilesByType(type),
    })),
  );
  const groupedByType = new Map(groupedEntries.map((entry) => [entry.type, entry.rows]));
  const allRows = groupedEntries
    .flatMap((entry) => entry.rows)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    allRows,
    countByType: {
      mahkeme: groupedByType.get("mahkeme")?.length || 0,
      uyusmazlik: groupedByType.get("uyusmazlik")?.length || 0,
    },
  };
}

async function getEkapV3FilesSnapshot(typeFilter) {
  const key = typeFilter || "__all";
  const now = Date.now();
  const cached = ekapV3FilesCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await buildEkapV3FilesSnapshot(typeFilter);
  ekapV3FilesCache.set(key, {
    expiresAt: now + EKAP_V3_FILES_CACHE_TTL_MS,
    value,
  });

  return value;
}

function parseScrapeOptions(body) {
  const options = {};
  const payload = body && typeof body === "object" ? body : {};
  const allPages = toBool(payload.allPages, false);
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

  if (allPages) {
    options.startSkip = 0;
    options.maxPages = 0;
    options.pageRange = {
      allPages: true,
      startPage: 1,
      endPage: null,
    };
  } else if (payload.startPage !== undefined || payload.endPage !== undefined) {
    const startPage = Math.max(1, toInt(payload.startPage, 1));
    const endPage = Math.max(startPage, toInt(payload.endPage, startPage));
    options.startSkip = (startPage - 1) * pageSize;
    options.maxPages = endPage - startPage + 1;
    options.pageRange = {
      allPages: false,
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

  if (payload.detailConcurrency !== undefined) {
    options.detailConcurrency = Math.max(
      1,
      Math.min(16, toInt(payload.detailConcurrency, config.detailConcurrency)),
    );
  }

  if (payload.writeBatchSize !== undefined) {
    options.writeBatchSize = Math.max(
      10,
      Math.min(1_000, toInt(payload.writeBatchSize, config.writeBatchSize)),
    );
  }

  if (payload.incremental !== undefined || payload.incrementalSync !== undefined) {
    const raw = payload.incrementalSync !== undefined ? payload.incrementalSync : payload.incremental;
    options.incrementalSync = Boolean(raw);
  } else {
    options.incrementalSync = Boolean(config.incrementalSync);
  }

  if (payload.incrementalStopUnchangedStreak !== undefined) {
    options.incrementalStopUnchangedStreak = Math.max(
      5,
      toInt(payload.incrementalStopUnchangedStreak, config.incrementalStopUnchangedStreak),
    );
  }

  if (payload.adaptivePagination !== undefined) {
    options.adaptivePagination = Boolean(payload.adaptivePagination);
  } else {
    options.adaptivePagination = Boolean(config.adaptivePagination);
  }

  if (payload.adaptivePageSizeMin !== undefined) {
    options.adaptivePageSizeMin = Math.max(
      1,
      toInt(payload.adaptivePageSizeMin, config.adaptivePageSizeMin),
    );
  }

  if (payload.adaptivePageSizeMax !== undefined) {
    options.adaptivePageSizeMax = Math.max(
      1,
      toInt(payload.adaptivePageSizeMax, config.adaptivePageSizeMax),
    );
  }

  if (payload.adaptivePageSizeStep !== undefined) {
    options.adaptivePageSizeStep = Math.max(
      1,
      toInt(payload.adaptivePageSizeStep, config.adaptivePageSizeStep),
    );
  }

  if (payload.adaptivePageTargetMs !== undefined) {
    options.adaptivePageTargetMs = Math.max(
      200,
      toInt(payload.adaptivePageTargetMs, config.adaptivePageTargetMs),
    );
  }

  if (payload.adaptiveDetailConcurrency !== undefined) {
    options.adaptiveDetailConcurrency = Boolean(payload.adaptiveDetailConcurrency);
  } else {
    options.adaptiveDetailConcurrency = Boolean(config.adaptiveDetailConcurrency);
  }

  if (payload.detailConcurrencyMin !== undefined) {
    options.detailConcurrencyMin = Math.max(
      1,
      Math.min(16, toInt(payload.detailConcurrencyMin, config.detailConcurrencyMin)),
    );
  }

  if (payload.detailConcurrencyMax !== undefined) {
    options.detailConcurrencyMax = Math.max(
      1,
      Math.min(16, toInt(payload.detailConcurrencyMax, config.detailConcurrencyMax)),
    );
  }

  if (payload.detailPageTargetMs !== undefined) {
    options.detailPageTargetMs = Math.max(
      500,
      toInt(payload.detailPageTargetMs, config.detailPageTargetMs),
    );
  }

  if (payload.conditionalRequests !== undefined) {
    options.conditionalRequests = Boolean(payload.conditionalRequests);
  } else {
    options.conditionalRequests = Boolean(config.conditionalRequests);
  }

  if (payload.conditionalCacheTtlMs !== undefined) {
    options.conditionalCacheTtlMs = Math.max(
      10_000,
      toInt(payload.conditionalCacheTtlMs, config.conditionalCacheTtlMs),
    );
  }

  if (payload.conditionalCacheSize !== undefined) {
    options.conditionalCacheSize = Math.max(
      10,
      toInt(payload.conditionalCacheSize, config.conditionalCacheSize),
    );
  }

  if (payload.responseCacheEnabled !== undefined) {
    options.responseCacheEnabled = Boolean(payload.responseCacheEnabled);
  } else {
    options.responseCacheEnabled = Boolean(config.responseCacheEnabled);
  }

  if (payload.responseCacheTtlMs !== undefined) {
    options.responseCacheTtlMs = Math.max(
      1_000,
      toInt(payload.responseCacheTtlMs, config.responseCacheTtlMs),
    );
  }

  if (payload.responseCacheSize !== undefined) {
    options.responseCacheSize = Math.max(
      10,
      toInt(payload.responseCacheSize, config.responseCacheSize),
    );
  }

  if (payload.circuitBreakerEnabled !== undefined) {
    options.circuitBreakerEnabled = Boolean(payload.circuitBreakerEnabled);
  } else {
    options.circuitBreakerEnabled = Boolean(config.circuitBreakerEnabled);
  }

  if (payload.circuitBreakerThreshold !== undefined) {
    options.circuitBreakerThreshold = Math.max(
      1,
      toInt(payload.circuitBreakerThreshold, config.circuitBreakerThreshold),
    );
  }

  if (payload.circuitBreakerCooldownMs !== undefined) {
    options.circuitBreakerCooldownMs = Math.max(
      1_000,
      toInt(payload.circuitBreakerCooldownMs, config.circuitBreakerCooldownMs),
    );
  }

  if (payload.circuitBreakerHalfOpenPages !== undefined) {
    options.circuitBreakerHalfOpenPages = Math.max(
      1,
      toInt(payload.circuitBreakerHalfOpenPages, config.circuitBreakerHalfOpenPages),
    );
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

function parseCookieHeader(headerValue) {
  const raw = String(headerValue || "");
  if (!raw) return {};

  const cookies = {};
  for (const chunk of raw.split(";")) {
    const part = chunk.trim();
    if (!part) continue;

    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function buildAuthCookieValue(token, maxAgeSeconds) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Number.parseInt(String(maxAgeSeconds || 0), 10) || 0)}`,
  ];
  if (AUTH_COOKIE_SECURE) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildClearedAuthCookieValue() {
  const parts = [`${AUTH_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (AUTH_COOKIE_SECURE) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearExpiredAuthSessions(now = Date.now()) {
  for (const [token, session] of authSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      authSessions.delete(token);
    }
  }
}

function createAuthSession(user) {
  const now = Date.now();
  clearExpiredAuthSessions(now);

  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = now + AUTH_SESSION_TTL_MS;
  authSessions.set(token, {
    token,
    username: user.username,
    role: user.role,
    csrfToken,
    selectedPanel: "",
    createdAt: now,
    expiresAt,
  });
  return authSessions.get(token);
}

function getAuthSessionFromRequest(req) {
  if (!AUTH_ENABLED) {
    return null;
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  const token = String(cookies[AUTH_COOKIE_NAME] || "").trim();
  if (!token) {
    return null;
  }

  const session = authSessions.get(token);
  if (!session) {
    return null;
  }

  const now = Date.now();
  if (session.expiresAt <= now) {
    authSessions.delete(token);
    return null;
  }

  return session;
}

function clearAuthSessionByToken(token) {
  if (!token) return;
  authSessions.delete(token);
}

function setSessionSelectedPanel(session, panelKey) {
  if (!session || typeof session !== "object") {
    return;
  }
  session.selectedPanel = String(panelKey || "");
}

function sanitizeNextTarget(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/") || text.startsWith("//")) {
    return "/";
  }
  return text;
}

function buildLoginRedirectPath(req, fallbackPath = "/") {
  const nextTarget = sanitizeNextTarget(req?.originalUrl || req?.path || fallbackPath);
  if (!nextTarget || nextTarget === "/") {
    return "/login";
  }
  return `/login?next=${encodeURIComponent(nextTarget)}`;
}

function getClientAddress(req) {
  if (AUTH_TRUST_PROXY) {
    const ips = Array.isArray(req.ips) ? req.ips : [];
    if (ips.length > 0) {
      return String(ips[0] || "").trim() || "unknown";
    }

    const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }
  }

  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function isLoginRateLimited(clientKey) {
  const key = String(clientKey || "").trim() || "unknown";
  const now = Date.now();
  const state = loginAttemptState.get(key);
  if (!state) {
    return { limited: false, retryAfterSec: 0 };
  }

  if (state.windowStartedAt + AUTH_LOGIN_WINDOW_MS <= now) {
    loginAttemptState.delete(key);
    return { limited: false, retryAfterSec: 0 };
  }

  if (state.failedCount < AUTH_LOGIN_MAX_ATTEMPTS) {
    return { limited: false, retryAfterSec: 0 };
  }

  const retryAfterSec = Math.max(
    1,
    Math.ceil((state.windowStartedAt + AUTH_LOGIN_WINDOW_MS - now) / 1000),
  );
  return { limited: true, retryAfterSec };
}

function registerLoginFailure(clientKey) {
  const key = String(clientKey || "").trim() || "unknown";
  const now = Date.now();
  const state = loginAttemptState.get(key);
  if (!state || state.windowStartedAt + AUTH_LOGIN_WINDOW_MS <= now) {
    loginAttemptState.set(key, {
      failedCount: 1,
      windowStartedAt: now,
    });
    return;
  }

  state.failedCount += 1;
}

function clearLoginFailures(clientKey) {
  const key = String(clientKey || "").trim() || "unknown";
  loginAttemptState.delete(key);
}

function safeCompareText(left, right) {
  const leftBuf = Buffer.from(String(left || ""));
  const rightBuf = Buffer.from(String(right || ""));
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function verifyAuthPassword(inputPassword, storedPassword) {
  const input = String(inputPassword || "");
  const stored = String(storedPassword || "");
  if (!stored) return false;

  if (stored.startsWith("plain:")) {
    return safeCompareText(input, stored.slice(6));
  }

  if (stored.startsWith("sha256:")) {
    const expectedHash = stored.slice(7).trim().toLowerCase();
    const computedHash = crypto.createHash("sha256").update(input).digest("hex");
    return safeCompareText(computedHash, expectedHash);
  }

  return safeCompareText(input, stored);
}

function toAuthUserPayload(session) {
  return {
    username: session.username,
    role: session.role,
  };
}

function hasRequiredRole(currentRole, requiredRole) {
  const currentWeight = AUTH_ROLE_WEIGHT[normalizeAuthRole(currentRole)] || 0;
  const requiredWeight = AUTH_ROLE_WEIGHT[normalizeAuthRole(requiredRole)] || 0;
  return currentWeight >= requiredWeight;
}

function resolveApiRequiredRole(method, apiPath) {
  const verb = String(method || "").toUpperCase();
  const pathname = String(apiPath || "");

  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") {
    return "viewer";
  }

  if (verb === "POST" && (pathname === "/downloads/delete" || pathname === "/ekapv3/files/delete")) {
    return "admin";
  }

  if (
    verb === "POST" &&
    (/^\/scrape\/(run|stop)$/.test(pathname) ||
      /^\/ekapv3\/(start|download|check|stop)$/.test(pathname) ||
      pathname === "/ops/benchmark" ||
      pathname === "/ekapv3/files/open-dir")
  ) {
    return "operator";
  }

  return "admin";
}

function requiresCsrfProtection(method) {
  const verb = String(method || "").toUpperCase();
  return !(verb === "GET" || verb === "HEAD" || verb === "OPTIONS");
}

function requireApiAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  if (req.path === "/health" || req.path.startsWith("/auth/")) {
    return next();
  }

  const session = getAuthSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Oturum gerekli." });
    return;
  }

  const requiredRole = resolveApiRequiredRole(req.method, req.path);
  if (!hasRequiredRole(session.role, requiredRole)) {
    res.status(403).json({ error: "Bu islem icin yetkiniz yok." });
    return;
  }

  if (requiresCsrfProtection(req.method)) {
    const csrfHeader = String(req.headers["x-csrf-token"] || "").trim();
    if (!csrfHeader || !safeCompareText(csrfHeader, session.csrfToken)) {
      res.status(403).json({ error: "CSRF token gecersiz." });
      return;
    }
  }

  req.auth = toAuthUserPayload(session);
  next();
}

function requireWebAuthForHtml(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return next();
  }

  if (req.path === "/login" || req.path === "/login.html" || req.path === "/login.js" || req.path === "/auth.js") {
    return next();
  }

  const extension = path.extname(req.path || "");
  const isHtmlLikeRoute = req.path === "/" || req.path === "" || req.path.endsWith(".html") || !extension;
  if (!isHtmlLikeRoute) {
    return next();
  }

  const session = getAuthSessionFromRequest(req);
  if (session) {
    req.auth = toAuthUserPayload(session);
    return next();
  }

  res.redirect(buildLoginRedirectPath(req, "/"));
}

function requirePanelSelection(panelKey) {
  const expectedPanel = String(panelKey || "");

  return (req, res, next) => {
    if (!AUTH_ENABLED) {
      return next();
    }

    const session = getAuthSessionFromRequest(req);
    if (!session) {
      res.redirect(buildLoginRedirectPath(req, "/"));
      return;
    }

    if (String(session.selectedPanel || "") !== expectedPanel) {
      res.redirect("/");
      return;
    }

    req.auth = toAuthUserPayload(session);
    next();
  };
}

function selectPanelAndRedirect(req, res, panelKey, targetPath) {
  if (!AUTH_ENABLED) {
    res.redirect(targetPath);
    return;
  }

  const session = getAuthSessionFromRequest(req);
  if (!session) {
    res.redirect(buildLoginRedirectPath(req, targetPath));
    return;
  }

  setSessionSelectedPanel(session, panelKey);
  req.auth = toAuthUserPayload(session);
  res.redirect(targetPath);
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true, service: "ekap-web", timestamp: new Date().toISOString() });
});

app.get("/api/auth/me", (req, res) => {
  if (!AUTH_ENABLED) {
    res.json({
      data: {
        authenticated: false,
        authEnabled: false,
      },
    });
    return;
  }

  const session = getAuthSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Oturum gerekli." });
    return;
  }

  res.json({
    data: {
      authenticated: true,
      authEnabled: true,
      user: toAuthUserPayload(session),
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!AUTH_ENABLED) {
    res.status(400).json({ error: "Kimlik dogrulama devre disi." });
    return;
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");
  if (!username || !password) {
    res.status(400).json({ error: "Kullanici adi ve sifre zorunlu." });
    return;
  }

  const usernameKey = username.toLocaleLowerCase("tr-TR");
  const clientIp = getClientAddress(req);
  const loginKey = `${clientIp}|${usernameKey}`;
  const rateLimitResult = isLoginRateLimited(loginKey);
  if (rateLimitResult.limited) {
    res
      .status(429)
      .json({ error: `Cok fazla hatali giris denemesi. ${rateLimitResult.retryAfterSec} saniye sonra tekrar deneyin.` });
    return;
  }

  const user = AUTH_USERS.find((item) => item.usernameKey === usernameKey);
  if (!user || !verifyAuthPassword(password, user.password)) {
    registerLoginFailure(loginKey);
    res.status(401).json({ error: "Kullanici adi veya sifre hatali." });
    return;
  }

  clearLoginFailures(loginKey);
  const session = createAuthSession(user);
  const maxAgeSeconds = Math.max(1, Math.floor(AUTH_SESSION_TTL_MS / 1000));
  res.setHeader("Set-Cookie", buildAuthCookieValue(session.token, maxAgeSeconds));
  res.json({
    data: {
      authenticated: true,
      authEnabled: true,
      user: toAuthUserPayload(session),
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  });
});

app.post("/api/auth/logout", (req, res) => {
  if (AUTH_ENABLED) {
    const session = getAuthSessionFromRequest(req);
    if (session?.token) {
      clearAuthSessionByToken(session.token);
    }
    res.setHeader("Set-Cookie", buildClearedAuthCookieValue());
  }

  res.json({
    data: {
      loggedOut: true,
      authEnabled: AUTH_ENABLED,
    },
  });
});

app.use("/api", requireApiAuth);

app.get("/api/ops/dashboard", async (req, res, next) => {
  try {
    const requestedWindow = Math.max(1, toInt(req.query?.windowHours, OPS_DASHBOARD_WINDOW_HOURS));
    const data = await buildOpsDashboardData({ windowHours: Math.min(168, requestedWindow) });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ops/alerts", async (req, res, next) => {
  try {
    const requestedWindow = Math.max(1, toInt(req.query?.windowHours, OPS_DASHBOARD_WINDOW_HOURS));
    const dashboard = await buildOpsDashboardData({ windowHours: Math.min(168, requestedWindow) });
    const recent = await getRecentOpsAlertEvents(toInt(req.query?.limit, 30));
    res.json({
      data: {
        active: dashboard.alerts,
        recent,
        activeCount: dashboard.alerts.length,
        lastEvaluatedAt: dashboard.alertState.lastEvaluatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ops/benchmarks", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, toInt(req.query?.limit, 20)));
    const rows = opsBenchmarkCollection
      ? await opsBenchmarkCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray()
      : [];

    res.json({
      data: rows.map((row) => ({
        benchmarkId: row?.benchmarkId || null,
        source: row?.source || null,
        sampleCount: row?.sampleCount || 0,
        maxRegressionPct: row?.maxRegressionPct ?? null,
        baselineFile: row?.baselineFile || null,
        summary: row?.summary || null,
        createdAt: safeIsoDate(row?.createdAt),
      })),
      meta: {
        limit,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ops/benchmark", async (req, res, next) => {
  try {
    const payload = normalizeOpsBenchmarkPayload(req.body);
    if (opsBenchmarkCollection) {
      await opsBenchmarkCollection.insertOne(payload);
    }
    res.status(202).json({
      data: {
        saved: true,
        benchmarkId: payload.benchmarkId,
        createdAt: safeIsoDate(payload.createdAt),
        summary: payload.summary,
      },
    });
  } catch (error) {
    next(error);
  }
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

app.get("/api/ekapv3/status", (_, res) => {
  const current = ekapV3State.currentRun
    ? {
        ...ekapV3State.currentRun,
        pagesProcessed: [...(ekapV3State.currentRun.pagesProcessed || [])].sort((a, b) => a - b),
      }
    : null;
  const last = ekapV3State.lastRun
    ? {
        ...ekapV3State.lastRun,
        pagesProcessed: [...(ekapV3State.lastRun.pagesProcessed || [])].sort((a, b) => a - b),
      }
    : null;

  res.json({
    data: {
      running: ekapV3State.running,
      stopRequested: ekapV3State.stopRequested,
      currentRun: current,
      lastRun: last,
      lastError: ekapV3State.lastError,
      logs: ekapV3State.logs,
    },
  });
});

const handleEkapV3Start = async (req, res, next) => {
  try {
    if (ekapV3State.running) {
      res.status(409).json({ error: "EKAP v3 indirme işlemi zaten çalışıyor." });
      return;
    }

    const requestedOptions = parseEkapV3Options(req.body);
    let options = {
      ...requestedOptions,
    };
    const checkpointPath = buildEkapV3CheckpointPath(requestedOptions);
    const checkpointMeta = {
      applied: false,
      source: "none",
      checkpointPath,
      checkpointPage: null,
      checkpointRow: null,
    };
    let preflight = null;
    let countPreflight = {
      available: false,
      source: "ekap-api",
      total: null,
      capped: false,
      estimatedPages: null,
      rowsPerPageEstimate: EKAP_V3_ROWS_PER_PAGE_ESTIMATE,
      error: null,
    };

    preflight = await runEkapV3Preflight(options);

    try {
      const count = await fetchEkapV3CountFromApi(options);
      countPreflight = {
        available: true,
        source: "ekap-api",
        total: count.totalCount,
        capped: count.totalCountCapped,
        estimatedPages: count.estimatedPages,
        rowsPerPageEstimate: EKAP_V3_ROWS_PER_PAGE_ESTIMATE,
        error: null,
      };
    } catch (error) {
      countPreflight.error = error?.message || String(error);
    }

    await ensureEkapV3DownloadDirs();
    const scriptName =
      options.type === "mahkeme"
        ? "ekap-playwright-mahkeme.js"
        : "ekap-playwright-uyusmazlik.js";
    const args = [
      scriptName,
      `--from=${options.fromDate}`,
      `--to=${options.toDate}`,
      `--startPage=${options.startPage}`,
      `--startRow=${options.startRow}`,
      `--workerCount=${options.workerCount}`,
      `--browserMode=${options.browserMode}`,
      "--checkpoint=true",
      `--checkpointPath=${checkpointPath}`,
      "--resetCheckpoint=true",
    ];
    if (options.allPages) {
      args.push("--allPages=true");
    } else {
      args.push(`--endPage=${options.endPage}`);
    }

    const runId = createEkapV3RunId();
    const startedAt = new Date().toISOString();
    const currentRun = {
      runId,
      startedAt,
      finishedAt: null,
      type: options.type,
      fromDate: options.fromDate,
      toDate: options.toDate,
      startPage: options.startPage,
      startRow: options.startRow,
      endPage: options.endPage,
      allPages: options.allPages,
      checkpointPath,
      checkpointMeta,
      workerCount: options.workerCount,
      browserMode: options.browserMode,
      status: "running",
      stopRequested: false,
      downloadedCount: 0,
      failedCount: 0,
      retryCount: 0,
      duplicateCount: 0,
      checkpoint: null,
      preflight,
      totalTargetCount: countPreflight.available ? countPreflight.total : null,
      totalTargetCountCapped: countPreflight.available ? countPreflight.capped : false,
      estimatedTotalPages: countPreflight.available ? countPreflight.estimatedPages : null,
      countSource: countPreflight.source,
      pagesProcessed: [],
      exitCode: null,
      signal: null,
    };

    ekapV3State.running = true;
    ekapV3State.stopRequested = false;
    ekapV3State.currentRun = currentRun;
    ekapV3State.lastError = null;
    ekapV3State.logs = [];
    if (checkpointMeta?.checkpointPath) {
      appendEkapV3Log(
        checkpointMeta.applied ? "info" : "warn",
        `[CHECKPOINT] path=${checkpointMeta.checkpointPath} applied=${checkpointMeta.applied ? "1" : "0"} page=${
          checkpointMeta.checkpointPage || "-"
        } row=${checkpointMeta.checkpointRow || "-"}`,
      );
    }
    if (preflight) {
      appendEkapV3Log(
        preflight.endpointCheckOk ? "info" : "warn",
        `[PREFLIGHT] endpointCheck=${preflight.endpointCheckEnabled ? "on" : "off"} strict=${
          preflight.endpointCheckStrict ? "on" : "off"
        } method=${preflight.endpointCheckMethod || "-"} endpointStatus=${preflight.endpointStatus} freeBytes=${
          preflight.freeBytes === null ? "n/a" : preflight.freeBytes
        } minRequired=${preflight.minRequiredFreeBytes}${
          preflight.endpointCheckError ? ` error=${preflight.endpointCheckError}` : ""
        }`,
      );
    }
    appendEkapV3Log("info", `[RUN] Baslatildi: ${scriptName} ${args.slice(1).join(" ")}`);
    appendEkapV3Log("info", `[POOL] workerCount=${options.workerCount}`);
    if (countPreflight.available) {
      appendEkapV3Log(
        "info",
        `[COUNT] source=${countPreflight.source} total=${countPreflight.total}${
          countPreflight.capped ? "+" : ""
        } estimatedPages=${countPreflight.estimatedPages || 0}`,
      );
    } else {
      appendEkapV3Log("warn", `[COUNT] source=${countPreflight.source} unavailable: ${countPreflight.error || "-"}`);
    }

    if (ekapV3LogCollection) {
      await ekapV3LogCollection.insertOne({
        _id: runId,
        type: options.type,
        dateRange: {
          from: options.fromDate,
          to: options.toDate,
        },
        selectedPages: {
          startPage: options.startPage,
          startRow: options.startRow,
          endPage: options.endPage,
          allPages: options.allPages,
        },
        checkpointPath,
        checkpointMeta,
        checkpoint: null,
        preflight,
        workerCount: options.workerCount,
        browserMode: options.browserMode,
        status: "running",
        stopRequested: false,
        downloadedCount: 0,
        failedCount: 0,
        retryCount: 0,
        duplicateCount: 0,
        totalTargetCount: countPreflight.available ? countPreflight.total : null,
        totalTargetCountCapped: countPreflight.available ? countPreflight.capped : false,
        estimatedTotalPages: countPreflight.available ? countPreflight.estimatedPages : null,
        countSource: countPreflight.source,
        countPreflight,
        pagesProcessed: [],
        startedAt: new Date(startedAt),
        finishedAt: null,
        exitCode: null,
        signal: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const child = spawn(process.execPath, args, {
      cwd: EKAP_V3_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ekapV3State.childProcess = child;

    const consumeLine = (level, chunk) => {
      const text = String(chunk || "").trim();
      if (!text) return;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        appendEkapV3Log(level, line);

        const current = ekapV3State.currentRun;
        if (!current) continue;

        const downloadedMatch = line.match(/^Page\s+(\d+),\s+row\s+\d+:\s+downloaded\./i);
        if (downloadedMatch) {
          current.downloadedCount += 1;
          const pageNo = toInt(downloadedMatch[1], 0);
          if (pageNo > 0 && !current.pagesProcessed.includes(pageNo)) {
            current.pagesProcessed.push(pageNo);
          }
          continue;
        }

        const failedMatch = line.match(/^Page\s+(\d+),\s+row\s+\d+:\s+failed\s+->/i);
        if (failedMatch) {
          current.failedCount += 1;
          const pageNo = toInt(failedMatch[1], 0);
          if (pageNo > 0 && !current.pagesProcessed.includes(pageNo)) {
            current.pagesProcessed.push(pageNo);
          }
          continue;
        }

        const duplicateMatch = line.match(/^Page\s+(\d+),\s+row\s+\d+:\s+duplicate-skip\./i);
        if (duplicateMatch) {
          current.duplicateCount = (current.duplicateCount || 0) + 1;
          const pageNo = toInt(duplicateMatch[1], 0);
          if (pageNo > 0 && !current.pagesProcessed.includes(pageNo)) {
            current.pagesProcessed.push(pageNo);
          }
          continue;
        }

        if (/^Page\s+\d+,\s+row\s+\d+:\s+retry\s+\d+\/\d+/i.test(line)) {
          current.retryCount += 1;
          continue;
        }

        const checkpointMatch = line.match(
          /^\[CHECKPOINT\]\s+page=(\d+)\s+row=(\d+)\s+success=(\d)\s+duplicate=(\d)/i,
        );
        if (checkpointMatch) {
          current.checkpoint = {
            page: toInt(checkpointMatch[1], 0),
            row: toInt(checkpointMatch[2], 0),
            success: checkpointMatch[3] === "1",
            duplicate: checkpointMatch[4] === "1",
            updatedAt: new Date().toISOString(),
          };
          continue;
        }

        const processingMatch = line.match(/^Processing\s+page\s+(\d+)/i);
        if (processingMatch) {
          const pageNo = toInt(processingMatch[1], 0);
          if (pageNo > 0 && !current.pagesProcessed.includes(pageNo)) {
            current.pagesProcessed.push(pageNo);
          }
        }
      }
    };

    child.stdout.on("data", (chunk) => consumeLine("info", chunk));
    child.stderr.on("data", (chunk) => consumeLine("error", chunk));

    child.on("error", async (error) => {
      appendEkapV3Log("error", `[CHILD_ERROR] ${error?.message || String(error)}`);
      ekapV3State.lastError = error?.message || String(error);
      if (ekapV3LogCollection && ekapV3State.currentRun?.runId) {
        await ekapV3LogCollection.updateOne(
          { _id: ekapV3State.currentRun.runId },
          {
            $set: {
              status: "failed",
              updatedAt: new Date(),
            },
          },
        );
      }
    });

    child.on("close", async (code, signal) => {
      const finishedAt = new Date().toISOString();
      const current = ekapV3State.currentRun;
      if (!current) {
        ekapV3State.running = false;
        ekapV3State.stopRequested = false;
        ekapV3State.childProcess = null;
        return;
      }

      let status = "completed";
      if (ekapV3State.stopRequested) {
        status = "stopped";
      } else if (code !== 0) {
        status = "failed";
      }

      current.finishedAt = finishedAt;
      current.exitCode = code;
      current.signal = signal || null;
      current.status = status;
      current.stopRequested = ekapV3State.stopRequested;

      ekapV3State.lastRun = {
        ...current,
        pagesProcessed: [...current.pagesProcessed],
      };
      ekapV3State.lastError = status === "failed" ? `Process exited with code ${code}` : null;
      ekapV3State.running = false;
      ekapV3State.stopRequested = false;
      ekapV3State.currentRun = null;
      ekapV3State.childProcess = null;

      appendEkapV3Log(
        status === "completed" ? "info" : status === "stopped" ? "warn" : "error",
        `[DONE] status=${status} exitCode=${code} signal=${signal || "-"}`,
      );

      if (ekapV3LogCollection) {
        await ekapV3LogCollection.updateOne(
          { _id: current.runId },
          {
            $set: {
              status,
              stopRequested: current.stopRequested,
              downloadedCount: current.downloadedCount,
              failedCount: current.failedCount,
              retryCount: current.retryCount,
              duplicateCount: current.duplicateCount || 0,
              checkpoint: current.checkpoint || null,
              pagesProcessed: [...current.pagesProcessed].sort((a, b) => a - b),
              finishedAt: new Date(finishedAt),
              exitCode: code,
              signal: signal || null,
              updatedAt: new Date(),
            },
          },
        );
      }
    });

    res.status(202).json({
      data: {
        running: true,
        currentRun,
      },
    });
  } catch (error) {
    next(error);
  }
};

app.post("/api/ekapv3/start", handleEkapV3Start);
app.post("/api/ekapv3/download", handleEkapV3Start);
app.post("/api/ekapv3/check", async (req, res, next) => {
  try {
    const options = parseEkapV3Options(req.body);
    const count = await fetchEkapV3CountFromApi(options);
    res.json({
      data: {
        type: options.type,
        fromDate: options.fromDate,
        toDate: options.toDate,
        totalCount: count.totalCount,
        totalCountCapped: count.totalCountCapped,
        estimatedPages: count.estimatedPages,
        rowsPerPageEstimate: EKAP_V3_ROWS_PER_PAGE_ESTIMATE,
        source: "ekap-api",
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ekapv3/stop", (req, res) => {
  if (!ekapV3State.running || !ekapV3State.childProcess) {
    res.status(409).json({ error: "Çalışan bir EKAP v3 indirme işlemi yok." });
    return;
  }

  ekapV3State.stopRequested = true;
  if (ekapV3State.currentRun) {
    ekapV3State.currentRun.stopRequested = true;
  }
  appendEkapV3Log("warn", "[STOP] Durdurma isteği alındı.");

  try {
    ekapV3State.childProcess.kill("SIGTERM");
  } catch (error) {
    appendEkapV3Log("error", `[STOP_ERROR] ${error?.message || String(error)}`);
  }

  res.json({
    data: {
      running: true,
      stopRequested: true,
    },
  });
});

app.post("/api/ekapv3/logs/clear", async (req, res, next) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const confirmation = normalizeConfirmation(payload.confirmation);
    if (confirmation !== DELETE_CONFIRMATION_TEXT) {
      res.status(400).json({
        error: `"${DELETE_CONFIRMATION_TEXT}" yazmadan temizleme işlemi yapılamaz.`,
      });
      return;
    }

    const clearedCount = Array.isArray(ekapV3State.logs) ? ekapV3State.logs.length : 0;
    ekapV3State.logs = [];

    await writeAuditLog(req, "ekapv3.logs.clear", {
      clearedCount,
      running: Boolean(ekapV3State.running),
      runId: ekapV3State.currentRun?.runId || null,
    });

    res.json({
      data: {
        clearedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ekapv3/history/clear", async (req, res, next) => {
  try {
    if (ekapV3State.running) {
      res.status(409).json({ error: "EKAP v3 çalışırken indirme geçmişi temizlenemez." });
      return;
    }

    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const confirmation = normalizeConfirmation(payload.confirmation);
    if (confirmation !== DELETE_CONFIRMATION_TEXT) {
      res.status(400).json({
        error: `"${DELETE_CONFIRMATION_TEXT}" yazmadan temizleme işlemi yapılamaz.`,
      });
      return;
    }

    let deletedCount = 0;
    if (ekapV3LogCollection) {
      const result = await ekapV3LogCollection.deleteMany({});
      deletedCount = Number(result?.deletedCount || 0);
    }

    await writeAuditLog(req, "ekapv3.history.clear", {
      deletedCount,
    });

    res.json({
      data: {
        deletedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ekapv3/history", async (req, res, next) => {
  try {
    const { limit, requestedPage } = parsePageAndLimit(req.query, {
      defaultLimit: 10,
      maxLimit: 500,
    });
    const total = ekapV3LogCollection ? await ekapV3LogCollection.countDocuments({}) : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = total > 0 ? Math.min(requestedPage, totalPages) : 1;
    const skip = (page - 1) * limit;
    const rows = ekapV3LogCollection
      ? await ekapV3LogCollection
          .find({})
          .sort({ startedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray()
      : [];

    res.json({
      data: rows.map((row) => ({
        runId: row?._id || null,
        type: row?.type || null,
        dateRange: row?.dateRange || null,
        selectedPages: row?.selectedPages || null,
        checkpointPath: row?.checkpointPath || null,
        checkpointMeta: row?.checkpointMeta || null,
        checkpoint: row?.checkpoint || null,
        preflight: row?.preflight || null,
        workerCount: row?.workerCount || 1,
        status: row?.status || null,
        stopRequested: Boolean(row?.stopRequested),
        downloadedCount: row?.downloadedCount || 0,
        failedCount: row?.failedCount || 0,
        retryCount: row?.retryCount || 0,
        duplicateCount: row?.duplicateCount || 0,
        totalTargetCount: row?.totalTargetCount ?? row?.countPreflight?.total ?? null,
        totalTargetCountCapped: Boolean(row?.totalTargetCountCapped ?? row?.countPreflight?.capped),
        estimatedTotalPages: row?.estimatedTotalPages ?? row?.countPreflight?.estimatedPages ?? null,
        countSource: row?.countSource || row?.countPreflight?.source || null,
        countPreflight: row?.countPreflight || null,
        pagesProcessed: Array.isArray(row?.pagesProcessed)
          ? row.pagesProcessed
          : [],
        startedAt: row?.startedAt || null,
        finishedAt: row?.finishedAt || null,
        exitCode: row?.exitCode ?? null,
      })),
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

app.get("/api/ekapv3/files", async (req, res, next) => {
  try {
    const typeFilter = resolveEkapV3DownloadType(req.query.type);
    const { limit, requestedPage } = parsePageAndLimit(req.query, {
      defaultLimit: 10,
      maxLimit: 2000,
    });
    const snapshot = await getEkapV3FilesSnapshot(typeFilter);
    const allRows = snapshot.allRows;
    const total = allRows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = total > 0 ? Math.min(requestedPage, totalPages) : 1;
    const skip = (page - 1) * limit;
    const rows = allRows.slice(skip, skip + limit);

    res.json({
      data: rows.map((row) => ({
        type: row.type,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        updatedAt: row.updatedAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages,
        type: typeFilter || null,
        countByType: snapshot.countByType,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ekapv3/files/download", async (req, res, next) => {
  try {
    const type = resolveEkapV3DownloadType(req.query.type);
    if (!type) {
      res.status(400).json({ error: "Geçersiz type. mahkeme veya uyusmazlik olmalı." });
      return;
    }

    const fileName = String(req.query.fileName || "").trim();
    if (!isSafeFileName(fileName)) {
      res.status(400).json({ error: "Geçersiz dosya adı." });
      return;
    }

    const dirPath = EKAP_V3_DOWNLOAD_DIRS[type];
    const absolutePath = path.join(dirPath, fileName);
    let stat;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        res.status(404).json({ error: "Dosya bulunamadı." });
        return;
      }
      throw error;
    }

    if (!stat.isFile()) {
      res.status(404).json({ error: "Dosya bulunamadı." });
      return;
    }

    res.download(absolutePath, fileName);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ekapv3/files/open-dir", async (req, res, next) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const type = resolveEkapV3DownloadType(payload.type);
    const targetPath = type ? EKAP_V3_DOWNLOAD_DIRS[type] : EKAP_V3_DOWNLOAD_ROOT_DIR;

    await fs.promises.mkdir(targetPath, { recursive: true });
    await openPathInFileManager(targetPath);

    res.json({
      data: {
        opened: true,
        type: type || null,
        path: targetPath,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ekapv3/files/delete", async (req, res, next) => {
  try {
    if (ekapV3State.running) {
      res.status(409).json({ error: "EKAP v3 çalışırken dosya silme yapılamaz." });
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

    await ensureEkapV3DownloadDirs();

    if (mode === "selected") {
      const files = normalizeEkapV3SelectedFiles(payload.files);
      if (!files.length) {
        res.status(400).json({ error: "Silme için en az bir dosya seçilmelidir." });
        return;
      }

      const result = await deleteEkapV3Files(files);
      clearEkapV3FilesCache();
      await writeAuditLog(req, "ekapv3.files.delete.selected", {
        mode,
        requestCount: files.length,
        deletedCount: result.deletedCount,
        missingCount: result.missingCount,
      });
      res.json({
        data: {
          mode,
          deletedCount: result.deletedCount,
          missingCount: result.missingCount,
        },
      });
      return;
    }

    if (mode === "byType") {
      const type = resolveEkapV3DownloadType(payload.type);
      if (!type) {
        res.status(400).json({ error: "Toplu silme için geçerli tür zorunludur." });
        return;
      }

      const files = await readEkapV3FilesByType(type);
      const result = await deleteEkapV3Files(files);
      clearEkapV3FilesCache();
      await writeAuditLog(req, "ekapv3.files.delete.byType", {
        mode,
        type,
        targetCount: files.length,
        deletedCount: result.deletedCount,
        missingCount: result.missingCount,
      });
      res.json({
        data: {
          mode,
          type,
          targetCount: files.length,
          deletedCount: result.deletedCount,
          missingCount: result.missingCount,
        },
      });
      return;
    }

    if (mode === "all") {
      const grouped = await Promise.all(EKAP_V3_DOWNLOAD_TYPES.map((type) => readEkapV3FilesByType(type)));
      const files = grouped.flat();
      const result = await deleteEkapV3Files(files);
      clearEkapV3FilesCache();
      await writeAuditLog(req, "ekapv3.files.delete.all", {
        mode,
        targetCount: files.length,
        deletedCount: result.deletedCount,
        missingCount: result.missingCount,
      });

      res.json({
        data: {
          mode,
          targetCount: files.length,
          deletedCount: result.deletedCount,
          missingCount: result.missingCount,
        },
      });
      return;
    }

    res.status(400).json({ error: "Geçersiz dosya silme modu." });
  } catch (error) {
    next(error);
  }
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
        .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
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
      await writeAuditLog(req, "downloads.delete.selected", {
        mode,
        requestCount: ids.length,
        deletedCount: result.deletedCount || 0,
      });

      res.json({
        data: {
          mode,
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

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint bulunamadı." });
});

app.use(requireWebAuthForHtml);

app.get("/", (req, res) => {
  if (AUTH_ENABLED) {
    const session = getAuthSessionFromRequest(req);
    if (session) {
      setSessionSelectedPanel(session, "");
      req.auth = toAuthUserPayload(session);
    }
  }

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/index.html", (_, res) => {
  res.redirect("/");
});

app.get("/login", (req, res) => {
  if (AUTH_ENABLED) {
    const session = getAuthSessionFromRequest(req);
    if (session) {
      res.redirect("/");
      return;
    }
  }

  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get(PANEL_SELECTION_PATHS[PANEL_KEY_DOCS], (req, res) => {
  selectPanelAndRedirect(req, res, PANEL_KEY_DOCS, PANEL_TARGET_PATHS[PANEL_KEY_DOCS]);
});

app.get(PANEL_SELECTION_PATHS[PANEL_KEY_EKAP_V3], (req, res) => {
  selectPanelAndRedirect(req, res, PANEL_KEY_EKAP_V3, PANEL_TARGET_PATHS[PANEL_KEY_EKAP_V3]);
});

app.get("/dokumantasyon", requirePanelSelection(PANEL_KEY_DOCS), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "docs.html"));
});

app.get("/docs.html", requirePanelSelection(PANEL_KEY_DOCS), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "docs.html"));
});

app.get("/karsilastirma", (_, res) => {
  res.redirect("/dokumantasyon");
});

app.get("/ekapv3.html", requirePanelSelection(PANEL_KEY_EKAP_V3), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "ekapv3.html"));
});

app.get("/indirilenler", requirePanelSelection(PANEL_KEY_DOCS), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "downloads.html"));
});

app.get("/downloads", requirePanelSelection(PANEL_KEY_DOCS), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "downloads.html"));
});

app.get("/downloads.html", requirePanelSelection(PANEL_KEY_DOCS), (_, res) => {
  res.sendFile(path.join(__dirname, "public", "downloads.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  if (path.extname(req.path || "")) {
    res.status(404).end();
    return;
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _, res, __) => {
  console.error("[WEB_ERROR]", error);
  res.status(500).json({ error: "Sunucu hatası" });
});

async function start() {
  if (AUTH_ENABLED && AUTH_USERS.length === 0) {
    throw new Error(
      "AUTH_ENABLED=true iken AUTH_USERS ayari zorunludur. Ornek: AUTH_USERS='[{\"username\":\"admin\",\"password\":\"plain:degistir\",\"role\":\"admin\"}]'",
    );
  }

  mongoClient = new MongoClient(config.mongodbUri);
  await mongoClient.connect();
  const db = mongoClient.db(config.mongodbDb);
  collection = db.collection(config.mongodbCollection);
  ekapV3LogCollection = db.collection(EKAP_V3_LOG_COLLECTION);
  auditLogCollection = db.collection(AUDIT_LOG_COLLECTION);
  opsAlertCollection = db.collection(OPS_ALERT_COLLECTION);
  opsBenchmarkCollection = db.collection(OPS_BENCHMARK_COLLECTION);
  await ensureTenderCollectionIndexes(collection);
  await ensureEkapV3LogIndexes(ekapV3LogCollection);
  await ensureAuditLogIndexes(auditLogCollection);
  await ensureOpsAlertIndexes(opsAlertCollection);
  await ensureOpsBenchmarkIndexes(opsBenchmarkCollection);
  await ensureEkapV3DownloadDirs();
  startOpsAlertMonitor();
  await buildOpsDashboardData({ persistAlerts: true }).catch((error) => {
    console.error("[OPS_ALERT_INIT_ERROR]", error?.message || error);
  });

  app.listen(WEB_PORT, WEB_HOST, () => {
    console.log(`[WEB] UI hazir: http://${WEB_HOST}:${WEB_PORT}`);
    console.log(`[WEB] Auth: ${AUTH_ENABLED ? "enabled" : "disabled"}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("[WEB_FATAL]", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  _internal: {
    parseAuthUsers,
    parseScrapeOptions,
    parseEkapV3Options,
    formatEkapV3CountDateBoundary,
    buildEkapV3CountPayload,
    parseEkapV3CountResponse,
    runEkapV3Preflight,
    buildOpsDashboardData,
    getRecentOpsAlertEvents,
    normalizeOpsBenchmarkPayload,
    verifyAuthPassword,
    resolveApiRequiredRole,
    hasRequiredRole,
    toAuthUserPayload,
    createAuthSession,
    getAuthSessionFromRequest,
    clearAuthSessionByToken,
    requireApiAuth,
    requireWebAuthForHtml,
    requirePanelSelection,
    setSessionSelectedPanel,
    setCollectionsForTest,
    authSessions,
    loginAttemptState,
    scrapeState,
    ekapV3State,
    opsState,
    AUTH_USERS,
    AUTH_ENABLED,
  },
};
