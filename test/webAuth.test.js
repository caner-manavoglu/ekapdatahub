const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.AUTH_ENABLED = "true";
process.env.AUTH_USERS = '[{"username":"admin","password":"plain:test-admin","role":"admin"}]';

const { _internal } = require("../src/web/server");

function createMockRes() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

test("parseAuthUsers should normalize role and dedupe usernames", () => {
  const parsed = _internal.parseAuthUsers(
    JSON.stringify([
      { username: "Admin", password: "plain:one", role: "admin" },
      { username: "admin", password: "plain:two", role: "viewer" },
      { username: "operator", password: "plain:op", role: "operator" },
      { username: "", password: "plain:x", role: "viewer" },
    ]),
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].username, "Admin");
  assert.equal(parsed[0].role, "admin");
  assert.equal(parsed[1].username, "operator");
  assert.equal(parsed[1].role, "operator");
});

test("verifyAuthPassword should support plain and sha256 formats", () => {
  assert.equal(_internal.verifyAuthPassword("secret-1", "plain:secret-1"), true);
  assert.equal(_internal.verifyAuthPassword("secret-2", "plain:secret-1"), false);

  const hash = crypto.createHash("sha256").update("strong-pass").digest("hex");
  assert.equal(_internal.verifyAuthPassword("strong-pass", `sha256:${hash}`), true);
  assert.equal(_internal.verifyAuthPassword("wrong-pass", `sha256:${hash}`), false);
});

test("resolveApiRequiredRole should map routes correctly", () => {
  assert.equal(_internal.resolveApiRequiredRole("GET", "/tenders"), "viewer");
  assert.equal(_internal.resolveApiRequiredRole("GET", "/ops/dashboard"), "viewer");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/scrape/run"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/start"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/download"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/check"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ops/benchmark"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/downloads/delete"), "admin");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/files/delete"), "admin");
});

test("parseScrapeOptions should support allPages mode", () => {
  const parsedAllPages = _internal.parseScrapeOptions({
    allPages: true,
    startPage: 5,
    endPage: 11,
    pageSize: 20,
    detailConcurrency: 7,
  });

  assert.equal(parsedAllPages.startSkip, 0);
  assert.equal(parsedAllPages.maxPages, 0);
  assert.equal(parsedAllPages.pageRange?.allPages, true);
  assert.equal(parsedAllPages.pageRange?.startPage, 1);
  assert.equal(parsedAllPages.pageRange?.endPage, null);
  assert.equal(parsedAllPages.detailConcurrency, 7);
  assert.equal(parsedAllPages.incrementalSync, true);

  const parsedRange = _internal.parseScrapeOptions({
    allPages: false,
    startPage: 3,
    endPage: 6,
    pageSize: 10,
    writeBatchSize: 180,
    incremental: false,
    incrementalStopUnchangedStreak: 19,
    adaptivePagination: false,
    adaptivePageSizeMin: 8,
    adaptivePageSizeMax: 30,
    adaptivePageSizeStep: 4,
    adaptivePageTargetMs: 900,
    adaptiveDetailConcurrency: false,
    detailConcurrencyMin: 2,
    detailConcurrencyMax: 9,
    detailPageTargetMs: 7000,
    conditionalRequests: false,
    conditionalCacheTtlMs: 65000,
    conditionalCacheSize: 250,
    responseCacheEnabled: false,
    responseCacheTtlMs: 4500,
    responseCacheSize: 120,
    circuitBreakerEnabled: false,
    circuitBreakerThreshold: 4,
    circuitBreakerCooldownMs: 22000,
    circuitBreakerHalfOpenPages: 2,
  });

  assert.equal(parsedRange.startSkip, 20);
  assert.equal(parsedRange.maxPages, 4);
  assert.equal(parsedRange.writeBatchSize, 180);
  assert.equal(parsedRange.pageRange?.allPages, false);
  assert.equal(parsedRange.pageRange?.startPage, 3);
  assert.equal(parsedRange.pageRange?.endPage, 6);
  assert.equal(parsedRange.incrementalSync, false);
  assert.equal(parsedRange.incrementalStopUnchangedStreak, 19);
  assert.equal(parsedRange.adaptivePagination, false);
  assert.equal(parsedRange.adaptivePageSizeMin, 8);
  assert.equal(parsedRange.adaptivePageSizeMax, 30);
  assert.equal(parsedRange.adaptivePageSizeStep, 4);
  assert.equal(parsedRange.adaptivePageTargetMs, 900);
  assert.equal(parsedRange.adaptiveDetailConcurrency, false);
  assert.equal(parsedRange.detailConcurrencyMin, 2);
  assert.equal(parsedRange.detailConcurrencyMax, 9);
  assert.equal(parsedRange.detailPageTargetMs, 7000);
  assert.equal(parsedRange.conditionalRequests, false);
  assert.equal(parsedRange.conditionalCacheTtlMs, 65000);
  assert.equal(parsedRange.conditionalCacheSize, 250);
  assert.equal(parsedRange.responseCacheEnabled, false);
  assert.equal(parsedRange.responseCacheTtlMs, 4500);
  assert.equal(parsedRange.responseCacheSize, 120);
  assert.equal(parsedRange.circuitBreakerEnabled, false);
  assert.equal(parsedRange.circuitBreakerThreshold, 4);
  assert.equal(parsedRange.circuitBreakerCooldownMs, 22000);
  assert.equal(parsedRange.circuitBreakerHalfOpenPages, 2);
});

test("parseEkapV3Options should support allPages mode", () => {
  const parsedAllPages = _internal.parseEkapV3Options({
    type: "mahkeme",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 5,
    startRow: 3,
    endPage: 10,
    allPages: true,
    resumeFromLast: true,
    workerCount: 4,
    browserMode: "visible",
  });

  assert.equal(parsedAllPages.allPages, true);
  assert.equal(parsedAllPages.startPage, 1);
  assert.equal(parsedAllPages.startRow, 3);
  assert.equal(parsedAllPages.endPage, null);
  assert.equal(parsedAllPages.resumeFromLast, true);
  assert.equal(parsedAllPages.workerCount, 4);
  assert.equal(parsedAllPages.jobChunkSize, 2);
  assert.equal(parsedAllPages.timeoutRetries, 1);
  assert.equal(parsedAllPages.retryBaseDelayMs, 450);
  assert.equal(parsedAllPages.retryMaxDelayMs, 8000);
  assert.equal(parsedAllPages.retryJitterRatio, 0.2);
  assert.equal(parsedAllPages.browserMode, "visible");

  const parsedRange = _internal.parseEkapV3Options({
    type: "uyusmazlik",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 3,
    startRow: 0,
    endPage: 8,
    allPages: false,
    workerCount: 99,
    browserMode: "headless",
  });

  assert.equal(parsedRange.allPages, false);
  assert.equal(parsedRange.startPage, 3);
  assert.equal(parsedRange.startRow, 1);
  assert.equal(parsedRange.endPage, 8);
  assert.equal(parsedRange.resumeFromLast, false);
  assert.ok(parsedRange.workerCount >= 1);
  assert.ok(parsedRange.workerCount <= 8);
  assert.equal(parsedRange.jobChunkSize, 2);
  assert.equal(parsedRange.timeoutRetries, 1);
  assert.equal(parsedRange.retryBaseDelayMs, 450);
  assert.equal(parsedRange.retryMaxDelayMs, 8000);
  assert.equal(parsedRange.retryJitterRatio, 0.2);
});

test("ekap v3 count payload helpers should build and parse correctly", () => {
  assert.equal(_internal.formatEkapV3CountDateBoundary("2026-03-01", "start"), "01.03.2026 00:00:00");
  assert.equal(_internal.formatEkapV3CountDateBoundary("2026-03-01", "end"), "01.03.2026 23:59:00");
  assert.equal(_internal.formatEkapV3CountDateBoundary("01.03.2026", "start"), "01.03.2026 00:00:00");

  const umPayload = _internal.buildEkapV3CountPayload("uyusmazlik", "2026-03-01", "2026-03-11");
  const mkPayload = _internal.buildEkapV3CountPayload("mahkeme", "2026-03-01", "2026-03-11");
  assert.ok(umPayload?.sorgulaKurulKararlari?.keyValuePairs?.keyValueOfstringanyType?.length >= 2);
  assert.ok(mkPayload?.sorgulaKurulKararlariMk?.keyValuePairs?.keyValueOfstringanyType?.length >= 2);

  const umParsed = _internal.parseEkapV3CountResponse("uyusmazlik", {
    SorgulaKurulKararlariResponse: {
      SorgulaKurulKararlariResult: {
        hataKodu: "0",
        hataMesaji: "",
        KurulKararTutanakDetayListesi: [
          { kurulKararTutanakDetayi: [{ id: 1 }, { id: 2 }] },
          { kurulKararTutanakDetayi: [{ id: 3 }] },
        ],
      },
    },
  });
  assert.equal(umParsed.totalCount, 3);
  assert.equal(umParsed.totalCountCapped, false);
  assert.equal(umParsed.estimatedPages, 1);

  const mkParsed = _internal.parseEkapV3CountResponse("mahkeme", {
    SorgulaKurulKararlariMkResponse: {
      SorgulaKurulKararlariMkResult: {
        HataKodu: "0",
        HataMesaji: "",
        KurulKararTutanakDetayListesi: [
          { KurulKararTutanakDetayi: Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })) },
        ],
      },
    },
  });
  assert.equal(mkParsed.totalCount, 500);
  assert.equal(mkParsed.totalCountCapped, true);
  assert.equal(mkParsed.estimatedPages, 100);

  const emptyParsed = _internal.parseEkapV3CountResponse("uyusmazlik", {
    SorgulaKurulKararlariResponse: {
      SorgulaKurulKararlariResult: {
        hataKodu: "7",
        hataMesaji: "Kurul Kararlari entegrasyonunda kayıt bulunamamıştır.",
        KurulKararTutanakDetayListesi: [],
      },
    },
  });
  assert.equal(emptyParsed.totalCount, 0);
  assert.equal(emptyParsed.totalCountCapped, false);
  assert.equal(emptyParsed.estimatedPages, 0);
});

test("applyEkapV3ResumeOptions should advance start page from last processed page", () => {
  const base = _internal.parseEkapV3Options({
    type: "mahkeme",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 1,
    endPage: 10,
    allPages: false,
    resumeFromLast: true,
    browserMode: "headless",
  });

  const resume = _internal.applyEkapV3ResumeOptions(base, {
    _id: "run-42",
    pagesProcessed: [1, 2, 5, 4],
  });

  assert.equal(resume.options.startPage, 6);
  assert.equal(resume.options.endPage, 10);
  assert.equal(resume.resumeMeta?.baseRunId, "run-42");
  assert.equal(resume.resumeMeta?.lastProcessedPage, 5);
  assert.equal(resume.resumeMeta?.resumedFromPage, 6);
});

test("applyEkapV3ResumeOptions should reject when selected range is already completed", () => {
  const base = _internal.parseEkapV3Options({
    type: "uyusmazlik",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 3,
    endPage: 5,
    allPages: false,
    resumeFromLast: true,
    browserMode: "headless",
  });

  assert.throws(
    () =>
      _internal.applyEkapV3ResumeOptions(base, {
        _id: "run-43",
        pagesProcessed: [3, 4, 5],
      }),
    /tamamlan/i,
  );
});

test("normalizeOpsBenchmarkPayload should sanitize benchmark data", () => {
  const payload = _internal.normalizeOpsBenchmarkPayload({
    source: "bench-ci",
    sampleCount: 6,
    maxRegressionPct: 22.5,
    baselineFile: "/tmp/baseline.json",
    endpoints: [
      {
        id: "opsDashboard",
        path: "/api/ops/dashboard",
        p95Ms: 120.34,
        failures: 0,
      },
      {
        id: "",
        path: "/api/ops/invalid",
      },
    ],
    regressions: [
      {
        id: "opsDashboard",
        path: "/api/ops/dashboard",
        baselineP95Ms: 80,
        currentP95Ms: 120,
        changePct: 50,
      },
    ],
  });

  assert.match(String(payload?.benchmarkId || ""), /^ops-bench-/);
  assert.equal(payload?.source, "bench-ci");
  assert.equal(payload?.sampleCount, 6);
  assert.equal(payload?.summary?.endpointCount, 1);
  assert.equal(payload?.summary?.regressionCount, 1);
  assert.equal(payload?.endpoints?.[0]?.id, "opsDashboard");
});

test("runEkapV3Preflight should not throw on endpoint timeout when strict mode is disabled", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new Error("timeout");
    error.name = "AbortError";
    throw error;
  };

  try {
    const result = await _internal.runEkapV3Preflight({ type: "mahkeme" });
    assert.equal(result?.ok, true);
    assert.equal(result?.endpointCheckOk, false);
    assert.match(String(result?.endpointCheckError || ""), /zaman asimina ugradi/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("requireApiAuth should enforce role and csrf checks", () => {
  _internal.authSessions.clear();

  const viewerSession = _internal.createAuthSession({
    username: "viewer-user",
    role: "viewer",
  });
  const adminSession = _internal.createAuthSession({
    username: "admin-user",
    role: "admin",
  });

  const getReq = {
    method: "GET",
    path: "/tenders",
    headers: {
      cookie: `ekap_auth=${encodeURIComponent(viewerSession.token)}`,
    },
    ip: "127.0.0.1",
    socket: {},
  };
  const getRes = createMockRes();
  let nextCalled = false;
  _internal.requireApiAuth(getReq, getRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  const denyReq = {
    method: "POST",
    path: "/downloads/delete",
    headers: {
      cookie: `ekap_auth=${encodeURIComponent(viewerSession.token)}`,
      "x-csrf-token": viewerSession.csrfToken,
    },
    ip: "127.0.0.1",
    socket: {},
  };
  const denyRes = createMockRes();
  nextCalled = false;
  _internal.requireApiAuth(denyReq, denyRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(denyRes.statusCode, 403);

  const allowReq = {
    method: "POST",
    path: "/downloads/delete",
    headers: {
      cookie: `ekap_auth=${encodeURIComponent(adminSession.token)}`,
      "x-csrf-token": adminSession.csrfToken,
    },
    ip: "127.0.0.1",
    socket: {},
  };
  const allowRes = createMockRes();
  nextCalled = false;
  _internal.requireApiAuth(allowReq, allowRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
