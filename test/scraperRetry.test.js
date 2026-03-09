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
