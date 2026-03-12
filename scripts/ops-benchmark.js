#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMetric(value, digits = 2) {
  const number = toNumber(value, NaN);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** Math.max(0, digits);
  return Math.round(number * factor) / factor;
}

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:8787",
    samples: 5,
    maxRegressionPct: 20,
    outputDir: ".ops/benchmarks",
    baseline: "",
    cookie: process.env.OPS_BENCHMARK_COOKIE || "",
    username: process.env.OPS_BENCHMARK_USERNAME || "",
    password: process.env.OPS_BENCHMARK_PASSWORD || "",
    saveRemote: false,
    source: "ops-benchmark-script",
  };

  for (const token of argv) {
    if (!token.startsWith("--")) continue;
    const separatorIndex = token.indexOf("=");
    const key = separatorIndex > 2 ? token.slice(2, separatorIndex) : token.slice(2);
    const rawValue = separatorIndex > 2 ? token.slice(separatorIndex + 1) : "true";
    const value = String(rawValue || "").trim();
    if (!key) continue;

    if (key === "baseUrl") args.baseUrl = value || args.baseUrl;
    else if (key === "samples") args.samples = Math.max(1, toInt(value, args.samples));
    else if (key === "maxRegressionPct") args.maxRegressionPct = Math.max(1, toNumber(value, args.maxRegressionPct));
    else if (key === "outputDir") args.outputDir = value || args.outputDir;
    else if (key === "baseline") args.baseline = value;
    else if (key === "cookie") args.cookie = value;
    else if (key === "username") args.username = value;
    else if (key === "password") args.password = value;
    else if (key === "saveRemote") args.saveRemote = ["1", "true", "yes", "on"].includes(value.toLowerCase());
    else if (key === "source") args.source = value || args.source;
  }

  return args;
}

function sanitizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function percentile(values, p) {
  const list = Array.isArray(values)
    ? values.map((value) => toNumber(value, NaN)).filter((value) => Number.isFinite(value))
    : [];
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function buildHeaders(cookie, csrfToken) {
  const headers = {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }
  return headers;
}

async function loginAndGetSession(baseUrl, username, password) {
  if (!username || !password) {
    return {
      cookie: "",
      csrfToken: "",
    };
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Login failed: ${response.status}`);
  }

  const setCookie = response.headers.get("set-cookie");
  const cookie = String(setCookie || "").split(";")[0] || "";
  return {
    cookie,
    csrfToken: String(payload?.data?.csrfToken || "").trim(),
  };
}

async function timedFetch(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, options);
  const bodyText = await response.text();
  const finishedAt = performance.now();
  return {
    status: response.status,
    ok: response.ok,
    durationMs: finishedAt - startedAt,
    bodyText,
  };
}

function summarizeEndpoint(endpoint, samples) {
  const rows = Array.isArray(samples) ? samples : [];
  const durations = rows.map((item) => toNumber(item?.durationMs, NaN)).filter((value) => Number.isFinite(value));
  const failures = rows.filter((item) => !item?.ok).length;
  const averageMs = durations.length > 0
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : 0;

  return {
    id: endpoint.id,
    path: endpoint.path,
    method: endpoint.method,
    count: rows.length,
    failures,
    minMs: toMetric(Math.min(...durations, 0), 2),
    maxMs: toMetric(Math.max(...durations, 0), 2),
    avgMs: toMetric(averageMs, 2),
    p50Ms: toMetric(percentile(durations, 0.5), 2),
    p95Ms: toMetric(percentile(durations, 0.95), 2),
    statuses: rows.map((item) => item.status),
  };
}

function readJsonFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw);
}

function findLatestBenchmarkFile(outputDir) {
  const absoluteDir = path.resolve(outputDir);
  if (!fs.existsSync(absoluteDir)) return null;
  const files = fs
    .readdirSync(absoluteDir)
    .filter((name) => /^ops-benchmark-\d{8}T\d{6}Z\.json$/i.test(name))
    .sort();
  if (!files.length) return null;
  return path.join(absoluteDir, files[files.length - 1]);
}

function buildRegressionDiff(currentSummary, baselineSummary, maxRegressionPct) {
  const baselineMap = new Map();
  for (const row of Array.isArray(baselineSummary) ? baselineSummary : []) {
    baselineMap.set(String(row?.id || ""), row);
  }

  const regressions = [];
  for (const row of currentSummary) {
    const id = String(row?.id || "");
    if (!id) continue;
    const baseline = baselineMap.get(id);
    const baselineP95 = toNumber(baseline?.p95Ms, 0);
    const currentP95 = toNumber(row?.p95Ms, 0);
    if (baselineP95 <= 0 || currentP95 <= 0) continue;
    const changePct = ((currentP95 - baselineP95) / baselineP95) * 100;
    if (changePct > maxRegressionPct) {
      regressions.push({
        id,
        path: row.path,
        baselineP95Ms: toMetric(baselineP95, 2),
        currentP95Ms: toMetric(currentP95, 2),
        changePct: toMetric(changePct, 2),
      });
    }
  }
  return regressions;
}

async function postBenchmarkSnapshot(baseUrl, snapshot, cookie, csrfToken) {
  const response = await fetch(`${baseUrl}/api/ops/benchmark`, {
    method: "POST",
    headers: {
      ...buildHeaders(cookie, csrfToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Remote benchmark save failed: ${response.status}`);
  }

  return payload?.data || {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = sanitizeBaseUrl(args.baseUrl);
  if (!baseUrl) {
    throw new Error("baseUrl bos olamaz.");
  }

  const sessionFromLogin = await loginAndGetSession(baseUrl, args.username, args.password);
  const cookie = args.cookie || sessionFromLogin.cookie;
  const csrfToken = sessionFromLogin.csrfToken;
  const headers = buildHeaders(cookie, csrfToken);

  const endpoints = [
    { id: "health", method: "GET", path: "/api/health" },
    { id: "opsDashboard", method: "GET", path: "/api/ops/dashboard" },
    { id: "opsAlerts", method: "GET", path: "/api/ops/alerts?limit=10" },
    { id: "ekapStatus", method: "GET", path: "/api/ekapv3/status" },
    { id: "ekapHistory", method: "GET", path: "/api/ekapv3/history?page=1&limit=10" },
    { id: "scrapeStatus", method: "GET", path: "/api/scrape/status" },
  ];

  const samplesByEndpoint = new Map();
  for (const endpoint of endpoints) {
    samplesByEndpoint.set(endpoint.id, []);
  }

  for (let sampleIndex = 0; sampleIndex < args.samples; sampleIndex += 1) {
    for (const endpoint of endpoints) {
      const url = `${baseUrl}${endpoint.path}`;
      const sample = await timedFetch(url, {
        method: endpoint.method,
        headers,
      });
      samplesByEndpoint.get(endpoint.id).push(sample);
    }
  }

  const summary = endpoints.map((endpoint) => summarizeEndpoint(endpoint, samplesByEndpoint.get(endpoint.id)));

  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const baselineFile = args.baseline
    ? path.resolve(args.baseline)
    : findLatestBenchmarkFile(outputDir);
  let baselineSummary = [];
  if (baselineFile && fs.existsSync(baselineFile)) {
    const baselinePayload = readJsonFile(baselineFile);
    baselineSummary = Array.isArray(baselinePayload?.endpoints) ? baselinePayload.endpoints : [];
  }

  const regressions = buildRegressionDiff(summary, baselineSummary, args.maxRegressionPct);
  const timestamp = new Date().toISOString();
  const fileStamp = timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const filePath = path.join(outputDir, `ops-benchmark-${fileStamp}.json`);

  const snapshot = {
    source: args.source,
    generatedAt: timestamp,
    baseUrl,
    sampleCount: args.samples,
    maxRegressionPct: toMetric(args.maxRegressionPct, 2),
    baselineFile: baselineFile || null,
    endpoints: summary,
    regressions,
    summary: {
      endpointCount: summary.length,
      regressionCount: regressions.length,
      failureCount: summary.reduce((sum, row) => sum + Math.max(0, toInt(row?.failures, 0)), 0),
    },
  };

  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  let remoteSaveResult = null;
  if (args.saveRemote) {
    remoteSaveResult = await postBenchmarkSnapshot(baseUrl, snapshot, cookie, csrfToken);
  }

  console.log(`[BENCHMARK] saved=${filePath}`);
  console.log(`[BENCHMARK] samples=${args.samples} regressions=${regressions.length}`);
  if (baselineFile) {
    console.log(`[BENCHMARK] baseline=${baselineFile}`);
  }
  if (remoteSaveResult) {
    console.log(
      `[BENCHMARK] remoteSaved benchmarkId=${remoteSaveResult?.benchmarkId || "-"} createdAt=${
        remoteSaveResult?.createdAt || "-"
      }`,
    );
  }

  if (regressions.length > 0) {
    for (const regression of regressions) {
      console.error(
        `[REGRESSION] ${regression.id} p95 ${regression.baselineP95Ms}ms -> ${regression.currentP95Ms}ms (${regression.changePct}%)`,
      );
    }
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`[BENCHMARK_ERROR] ${error?.message || error}`);
  process.exitCode = 1;
});
