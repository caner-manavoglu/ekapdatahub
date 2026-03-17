const test = require("node:test");
const assert = require("node:assert/strict");

const { _internal } = require("../src/scraper");

test("isRetryableHttpError should retry transient status codes and network errors", () => {
  assert.equal(_internal.isRetryableHttpError({ response: { status: 429 } }), true);
  assert.equal(_internal.isRetryableHttpError({ response: { status: 503 } }), true);
  assert.equal(_internal.isRetryableHttpError({ code: "ETIMEDOUT" }), true);
  assert.equal(_internal.isRetryableHttpError({ message: "Network Error" }), true);
});

test("isRetryableHttpError should not retry client errors by default", () => {
  assert.equal(_internal.isRetryableHttpError({ response: { status: 400 } }), false);
  assert.equal(_internal.isRetryableHttpError({ response: { status: 404 } }), false);
});

test("computeBackoffDelayMs should increase exponentially with bounded jitter", () => {
  const base = 100;
  const attempt0 = _internal.computeBackoffDelayMs(base, 0);
  const attempt2 = _internal.computeBackoffDelayMs(base, 2);

  assert.ok(attempt0 >= 100 && attempt0 <= 129);
  assert.ok(attempt2 >= 400 && attempt2 <= 519);
});

test("buildListRowFingerprint should be deterministic for same row", () => {
  const row = {
    id: "123",
    ikn: "2026/111",
    ihaleAdi: "Temizlik Hizmeti",
    idareAdi: "Ornek Idare",
    ihaleDurum: "Aktif",
    ihaleTarihSaat: "2026-03-12T09:00:00",
    ihaleIlAdi: "Ankara",
    ihaleTipAciklama: "Hizmet",
    ihaleUsulAciklama: "Açık",
  };
  const a = _internal.buildListRowFingerprint(row);
  const b = _internal.buildListRowFingerprint({ ...row });
  assert.equal(a, b);
});

test("isRowUnchangedAgainstExisting should compare with stored fingerprint", () => {
  const row = {
    id: "321",
    ikn: "2026/222",
    ihaleAdi: "Bakim Onarim",
    idareAdi: "Test Idare",
    ihaleDurum: "Aktif",
    ihaleTarihSaat: "2026-03-11T12:00:00",
  };
  const sameDoc = {
    _id: "321",
    sync: {
      listRowFingerprint: _internal.buildListRowFingerprint(row),
    },
  };
  const diffDoc = {
    _id: "321",
    sync: {
      listRowFingerprint: `${_internal.buildListRowFingerprint(row)}-changed`,
    },
  };

  assert.equal(_internal.isRowUnchangedAgainstExisting(row, sameDoc), true);
  assert.equal(_internal.isRowUnchangedAgainstExisting(row, diffDoc), false);
  assert.equal(_internal.isRowUnchangedAgainstExisting(row, null), false);
});

test("tuneAdaptivePageSize should increase when list is fast and page is full", () => {
  const tuned = _internal.tuneAdaptivePageSize({
    currentTake: 10,
    minTake: 10,
    maxTake: 40,
    step: 5,
    targetMs: 1200,
    listLatencyMs: 500,
    rowsReturned: 10,
    pageFailedCount: 0,
  });
  assert.equal(tuned, 15);
});

test("tuneAdaptivePageSize should decrease on slow pages or failures", () => {
  const slowTuned = _internal.tuneAdaptivePageSize({
    currentTake: 20,
    minTake: 10,
    maxTake: 40,
    step: 5,
    targetMs: 1200,
    listLatencyMs: 2200,
    rowsReturned: 20,
    pageFailedCount: 0,
  });
  const failedTuned = _internal.tuneAdaptivePageSize({
    currentTake: 20,
    minTake: 10,
    maxTake: 40,
    step: 5,
    targetMs: 1200,
    listLatencyMs: 400,
    rowsReturned: 20,
    pageFailedCount: 2,
  });
  assert.equal(slowTuned, 15);
  assert.equal(failedTuned, 15);
});

test("tuneDetailConcurrency should increase when page is fast and stable", () => {
  const tuned = _internal.tuneDetailConcurrency({
    currentConcurrency: 4,
    minConcurrency: 1,
    maxConcurrency: 8,
    pageFailedCount: 0,
    pageDurationMs: 4000,
    targetMs: 8000,
  });
  assert.equal(tuned, 5);
});

test("tuneDetailConcurrency should decrease on failures or slow pages", () => {
  const byFailure = _internal.tuneDetailConcurrency({
    currentConcurrency: 5,
    minConcurrency: 1,
    maxConcurrency: 8,
    pageFailedCount: 1,
    pageDurationMs: 2000,
    targetMs: 8000,
  });
  const bySlowPage = _internal.tuneDetailConcurrency({
    currentConcurrency: 5,
    minConcurrency: 1,
    maxConcurrency: 8,
    pageFailedCount: 0,
    pageDurationMs: 12000,
    targetMs: 8000,
  });
  assert.equal(byFailure, 4);
  assert.equal(bySlowPage, 4);
});

test("chunkArray should split rows by configured batch size", () => {
  const chunks = _internal.chunkArray([1, 2, 3, 4, 5], 2);
  assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
});

test("normalizeIkn should sanitize whitespace and symbols", () => {
  assert.equal(_internal.normalizeIkn(" 2026 / 12345 "), "2026/12345");
  assert.equal(_internal.normalizeIkn("abc-12"), "ABC-12");
});

test("buildPageRowDedupeKey should prefer ikn and fallback to id", () => {
  assert.equal(
    _internal.buildPageRowDedupeKey({ ikn: "2026/11", id: "x1" }),
    "ikn:2026/11",
  );
  assert.equal(
    _internal.buildPageRowDedupeKey({ ikn: "", id: "x1" }),
    "id:x1",
  );
});

test("shouldReplaceDedupedRow should keep newer ihaleTarihSaat", () => {
  const existing = { ihaleTarihSaat: "2026-03-10T10:00:00" };
  const incomingNewer = { ihaleTarihSaat: "2026-03-11T10:00:00" };
  const incomingOlder = { ihaleTarihSaat: "2026-03-09T10:00:00" };

  assert.equal(_internal.shouldReplaceDedupedRow(existing, incomingNewer), true);
  assert.equal(_internal.shouldReplaceDedupedRow(existing, incomingOlder), false);
});

test("buildNormalizedUniqueKey should prefer normalized ikn", () => {
  const key = _internal.buildNormalizedUniqueKey(
    { id: "row-1", ikn: "2026/55" },
    { id: "detail-1", ikn: "2026/55" },
  );
  assert.equal(key, "ikn:2026/55");
});

test("shouldOpenCircuitBreaker should trigger on threshold", () => {
  assert.equal(_internal.shouldOpenCircuitBreaker(2, 3), false);
  assert.equal(_internal.shouldOpenCircuitBreaker(3, 3), true);
  assert.equal(_internal.shouldOpenCircuitBreaker(5, 3), true);
});

test("computePercentile and buildDistributionStats should return p50/p95", () => {
  const samples = [10, 20, 30, 40, 50];
  assert.equal(_internal.computePercentile(samples, 0.5), 30);
  const stats = _internal.buildDistributionStats(samples);
  assert.equal(stats.count, 5);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 50);
  assert.equal(stats.p50, 30);
  assert.ok(stats.p95 >= 45 && stats.p95 <= 50);
});

test("classifyErrorType should map http/code/message based errors", () => {
  assert.equal(_internal.classifyErrorType({ response: { status: 503 } }), "http:503");
  assert.equal(_internal.classifyErrorType({ code: "ECONNRESET" }), "code:ECONNRESET");
  assert.equal(_internal.classifyErrorType({ message: "request timeout" }), "timeout");
});
