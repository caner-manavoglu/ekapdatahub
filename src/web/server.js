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
const EKAP_V3_DOWNLOAD_TYPES = ["mahkeme", "uyusmazlik"];
const EKAP_V3_DOWNLOAD_DIRS = {
  mahkeme: path.join(EKAP_V3_DOWNLOAD_ROOT_DIR, "mahkeme"),
  uyusmazlik: path.join(EKAP_V3_DOWNLOAD_ROOT_DIR, "uyusmazlik"),
};
const EKAP_V3_LOG_COLLECTION =
  process.env.EKAP_V3_LOG_COLLECTION || "ekap_v3_download_logs";
const AUDIT_LOG_COLLECTION = process.env.AUDIT_LOG_COLLECTION || "audit_logs";

let mongoClient;
let collection;
let ekapV3LogCollection;
let auditLogCollection;
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
const authSessions = new Map();
const loginAttemptState = new Map();

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

function normalizeEkapV3Type(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase("tr-TR");
  return normalized === "uyusmazlik" ? "uyusmazlik" : normalized === "mahkeme" ? "mahkeme" : "";
}

function parseEkapV3Options(body) {
  const payload = body && typeof body === "object" ? body : {};
  const type = normalizeEkapV3Type(payload.type);
  if (!type) {
    throw new Error("Geçersiz tür. mahkeme veya uyusmazlik olmalı.");
  }

  const fromDate = String(payload.fromDate || "").trim();
  const toDate = String(payload.toDate || "").trim();
  if (!fromDate || !toDate) {
    throw new Error("Başlangıç ve bitiş tarihi zorunludur.");
  }

  const allPages = toBool(payload.allPages, false);
  const startPage = allPages ? 1 : Math.max(1, toInt(payload.startPage, 1));
  const endPage = allPages ? null : Math.max(startPage, toInt(payload.endPage, startPage));
  const browserModeRaw = String(payload.browserMode || "headless")
    .trim()
    .toLocaleLowerCase("tr-TR");
  const browserMode = browserModeRaw === "visible" ? "visible" : "headless";

  return {
    type,
    fromDate,
    toDate,
    startPage,
    endPage,
    allPages,
    browserMode,
  };
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
  await Promise.all(
    EKAP_V3_DOWNLOAD_TYPES.map((type) =>
      fs.promises.mkdir(EKAP_V3_DOWNLOAD_DIRS[type], { recursive: true }),
    ),
  );
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

function setCollectionsForTest(nextCollection, nextEkapV3LogCollection, nextAuditLogCollection) {
  collection = nextCollection;
  ekapV3LogCollection = nextEkapV3LogCollection;
  auditLogCollection = nextAuditLogCollection;
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
      /^\/ekapv3\/(start|stop)$/.test(pathname) ||
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

app.post("/api/ekapv3/start", async (req, res, next) => {
  try {
    if (ekapV3State.running) {
      res.status(409).json({ error: "EKAP v3 indirme işlemi zaten çalışıyor." });
      return;
    }

    const options = parseEkapV3Options(req.body);
    await ensureEkapV3DownloadDirs();
    const scriptName =
      options.type === "mahkeme"
        ? "ekap-selenium-mahkeme.js"
        : "ekap-selenium-uyusmazlik.js";
    const args = [
      scriptName,
      `--from=${options.fromDate}`,
      `--to=${options.toDate}`,
      `--startPage=${options.startPage}`,
      `--browserMode=${options.browserMode}`,
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
      endPage: options.endPage,
      allPages: options.allPages,
      browserMode: options.browserMode,
      status: "running",
      stopRequested: false,
      downloadedCount: 0,
      failedCount: 0,
      retryCount: 0,
      pagesProcessed: [],
      exitCode: null,
      signal: null,
    };

    ekapV3State.running = true;
    ekapV3State.stopRequested = false;
    ekapV3State.currentRun = currentRun;
    ekapV3State.lastError = null;
    ekapV3State.logs = [];
    appendEkapV3Log("info", `[RUN] Baslatildi: ${scriptName} ${args.slice(1).join(" ")}`);

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
          endPage: options.endPage,
          allPages: options.allPages,
        },
        browserMode: options.browserMode,
        status: "running",
        stopRequested: false,
        downloadedCount: 0,
        failedCount: 0,
        retryCount: 0,
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

        if (/ERR_CONNECTION_TIMED_OUT.*retrying/i.test(line)) {
          current.retryCount += 1;
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

app.get("/api/ekapv3/history", async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, toInt(req.query.limit, 100)));
    const rows = ekapV3LogCollection
      ? await ekapV3LogCollection
          .find({})
          .sort({ startedAt: -1, createdAt: -1 })
          .limit(limit)
          .toArray()
      : [];

    res.json({
      data: rows.map((row) => ({
        runId: row?._id || null,
        type: row?.type || null,
        dateRange: row?.dateRange || null,
        selectedPages: row?.selectedPages || null,
        status: row?.status || null,
        stopRequested: Boolean(row?.stopRequested),
        downloadedCount: row?.downloadedCount || 0,
        failedCount: row?.failedCount || 0,
        retryCount: row?.retryCount || 0,
        pagesProcessed: Array.isArray(row?.pagesProcessed)
          ? row.pagesProcessed
          : [],
        startedAt: row?.startedAt || null,
        finishedAt: row?.finishedAt || null,
        exitCode: row?.exitCode ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/ekapv3/files", async (req, res, next) => {
  try {
    const typeFilter = resolveEkapV3DownloadType(req.query.type);
    const limit = Math.min(2000, Math.max(1, toInt(req.query.limit, 500)));
    const targets = typeFilter ? [typeFilter] : [...EKAP_V3_DOWNLOAD_TYPES];

    const grouped = await Promise.all(targets.map((type) => readEkapV3FilesByType(type)));
    const rows = grouped
      .flat()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, limit);

    const countByType = {
      mahkeme: grouped[targets.indexOf("mahkeme")]?.length || 0,
      uyusmazlik: grouped[targets.indexOf("uyusmazlik")]?.length || 0,
    };

    res.json({
      data: rows.map((row) => ({
        type: row.type,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        updatedAt: row.updatedAt,
      })),
      meta: {
        total: rows.length,
        type: typeFilter || null,
        countByType,
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
  await ensureTenderCollectionIndexes(collection);
  await ensureEkapV3LogIndexes(ekapV3LogCollection);
  await ensureAuditLogIndexes(auditLogCollection);
  await ensureEkapV3DownloadDirs();

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
    AUTH_USERS,
    AUTH_ENABLED,
  },
};
