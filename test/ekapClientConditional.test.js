const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const EkapClient = require("../src/ekapClient");

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("EkapClient should send If-None-Match and use cached payload on 304", async () => {
  let listRequestCount = 0;
  let seenValidatorHeader = false;

  const server = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    if (req.url === "/list") {
      listRequestCount += 1;
      if (listRequestCount === 1) {
        res.setHeader("ETag", '"v1"');
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ totalCount: 1, list: [{ id: "first" }] }));
        return;
      }

      const ifNoneMatch = String(req.headers["if-none-match"] || "");
      seenValidatorHeader = ifNoneMatch === '"v1"';
      if (ifNoneMatch === '"v1"') {
        res.statusCode = 304;
        res.end();
        return;
      }

      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "validator missing" }));
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new EkapClient({
    listUrl: `${baseUrl}/list`,
    detailUrl: `${baseUrl}/detail`,
    timeout: 2000,
    conditionalRequests: true,
    conditionalCacheTtlMs: 60_000,
    conditionalCacheSize: 100,
    responseCacheEnabled: false,
  });

  try {
    const first = await client.fetchList({ skip: 0, take: 10 });
    const second = await client.fetchList({ skip: 0, take: 10 });

    assert.equal(Array.isArray(first.list), true);
    assert.equal(first.list.length, 1);
    assert.equal(Array.isArray(second.list), true);
    assert.equal(second.list.length, 1);
    assert.equal(second?._conditional?.notModified, true);
    assert.equal(second?._conditional?.cacheHit, true);
    assert.equal(seenValidatorHeader, true);

    const stats = client.getConditionalStats();
    assert.equal(stats.enabled, true);
    assert.ok(stats.requests >= 2);
    assert.ok(stats.validatorsUsed >= 1);
    assert.ok(stats.validatorsStored >= 1);
    assert.ok(stats.notModified >= 1);
    assert.ok(stats.cacheHits >= 1);
  } finally {
    client.close();
    await closeServer(server);
  }
});

test("EkapClient should serve repeated requests from response cache within ttl", async () => {
  let requestCount = 0;
  const server = await startServer(async (req, res) => {
    if (req.url === "/list") {
      requestCount += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ totalCount: 1, list: [{ id: `row-${requestCount}` }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new EkapClient({
    listUrl: `${baseUrl}/list`,
    detailUrl: `${baseUrl}/detail`,
    timeout: 2000,
    conditionalRequests: false,
    responseCacheEnabled: true,
    responseCacheTtlMs: 60_000,
    responseCacheSize: 100,
  });

  try {
    const first = await client.fetchList({ skip: 0, take: 10 });
    const second = await client.fetchList({ skip: 0, take: 10 });

    assert.equal(requestCount, 1);
    assert.equal(first.list?.[0]?.id, "row-1");
    assert.equal(second.list?.[0]?.id, "row-1");
    assert.equal(second?._responseCache?.hit, true);

    const stats = client.getResponseCacheStats();
    assert.equal(stats.enabled, true);
    assert.ok(stats.hits >= 1);
    assert.ok(stats.writes >= 1);
  } finally {
    client.close();
    await closeServer(server);
  }
});
