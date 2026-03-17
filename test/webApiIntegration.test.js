const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AUTH_ENABLED = "true";
process.env.WEB_SKIP_OPEN_DIR = "true";
process.env.AUTH_USERS = '[{"username":"admin","password":"plain:test-admin","role":"admin"}]';

const { app, _internal } = require("../src/web/server");

let server;
let baseUrl = "";
const auditEvents = [];

function makeFakeCollection() {
  return {
    async deleteMany(filter) {
      const ids = Array.isArray(filter?._id?.$in) ? filter._id.$in : [];
      if (ids.length > 0) {
        return { deletedCount: ids.length };
      }
      return { deletedCount: 0 };
    },
  };
}

function makeFakeAuditCollection() {
  return {
    async insertOne(doc) {
      auditEvents.push(doc);
      return { acknowledged: true };
    },
  };
}

async function loginAsAdmin() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: "admin",
      password: "test-admin",
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookie = String(setCookie).split(";")[0];

  return {
    cookie,
    csrfToken: payload?.data?.csrfToken,
  };
}

test.before(async () => {
  _internal.setCollectionsForTest(makeFakeCollection(), null, makeFakeAuditCollection());
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.afterEach(() => {
  auditEvents.length = 0;
  _internal.scrapeState.running = false;
  _internal.scrapeState.stopRequested = false;
  _internal.scrapeState.currentRunOptions = null;
  _internal.scrapeState.lastResult = null;
  _internal.scrapeState.lastError = null;
  _internal.ekapV3State.running = false;
  _internal.ekapV3State.stopRequested = false;
  _internal.ekapV3State.currentRun = null;
  _internal.ekapV3State.lastRun = null;
  _internal.ekapV3State.lastError = null;
  _internal.ekapV3State.logs = [];
  _internal.ekapV3State.childProcess = null;
  _internal.opsState.activeAlertFingerprints = new Set();
  _internal.opsState.lastEvaluatedAt = null;
});

test("POST /api/scrape/run should return 409 when already running", async () => {
  const auth = await loginAsAdmin();
  _internal.scrapeState.running = true;

  const response = await fetch(`${baseUrl}/api/scrape/run`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.match(String(payload?.error || ""), /zaten çalışıyor/i);
});

test("POST /api/scrape/stop should set stopRequested when running", async () => {
  const auth = await loginAsAdmin();
  _internal.scrapeState.running = true;

  const response = await fetch(`${baseUrl}/api/scrape/stop`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload?.data?.stopRequested, true);
});

test("POST /api/downloads/delete should delete selected ids", async () => {
  const auth = await loginAsAdmin();
  _internal.scrapeState.running = false;

  const response = await fetch(`${baseUrl}/api/downloads/delete`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({
      mode: "selected",
      ids: ["a", "b", "b"],
      confirmation: "onaylıyorum",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload?.data?.mode, "selected");
  assert.equal(payload?.data?.deletedCount, 2);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, "downloads.delete.selected");
  assert.equal(auditEvents[0]?.details?.deletedCount, 2);
});

test("POST /api/downloads/delete should reject byDate mode", async () => {
  const auth = await loginAsAdmin();
  _internal.scrapeState.running = false;

  const response = await fetch(`${baseUrl}/api/downloads/delete`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({
      mode: "byDate",
      date: "2026-03-09",
      confirmation: "onaylıyorum",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(String(payload?.error || ""), /geçersiz silme modu/i);
});

test("POST /api/ekapv3/files/open-dir and delete should work with auth", async () => {
  const auth = await loginAsAdmin();
  const randomSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const openResponse = await fetch(`${baseUrl}/api/ekapv3/files/open-dir`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({ type: "mahkeme" }),
  });
  const openPayload = await openResponse.json();
  assert.equal(openResponse.status, 200);
  assert.equal(openPayload?.data?.opened, true);

  const deleteResponse = await fetch(`${baseUrl}/api/ekapv3/files/delete`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({
      mode: "selected",
      files: [
        {
          type: "mahkeme",
          fileName: `__integration-test-${randomSuffix}.pdf`,
        },
      ],
      confirmation: "onaylıyorum",
    }),
  });
  const deletePayload = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.equal(deletePayload?.data?.mode, "selected");
  assert.ok(Number.isFinite(deletePayload?.data?.deletedCount));
  assert.ok(Number.isFinite(deletePayload?.data?.missingCount));
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, "ekapv3.files.delete.selected");
});

test("POST /api/ekapv3/download should reuse start flow", async () => {
  const auth = await loginAsAdmin();
  _internal.ekapV3State.running = true;

  const response = await fetch(`${baseUrl}/api/ekapv3/download`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({
      type: "mahkeme",
      fromDate: "2026-03-01",
      toDate: "2026-03-02",
      startPage: 1,
      endPage: 1,
      allPages: false,
      browserMode: "headless",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.match(String(payload?.error || ""), /zaten çalışıyor/i);
});

test("GET /api/ekapv3/history should include pagination meta", async () => {
  const auth = await loginAsAdmin();

  const response = await fetch(`${baseUrl}/api/ekapv3/history?page=2&limit=10`, {
    headers: {
      Cookie: auth.cookie,
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload?.meta?.total, 0);
  assert.equal(payload?.meta?.page, 1);
  assert.equal(payload?.meta?.limit, 10);
  assert.equal(payload?.meta?.totalPages, 1);
});

test("GET /api/ops/dashboard should return kpis and alerts payload", async () => {
  const auth = await loginAsAdmin();
  const startedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const logAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();

  _internal.ekapV3State.running = true;
  _internal.ekapV3State.currentRun = {
    runId: "ops-run-1",
    type: "mahkeme",
    startedAt,
    status: "running",
  };
  _internal.ekapV3State.logs = [
    {
      level: "info",
      timestamp: logAt,
      message: "stale-log",
    },
  ];
  _internal.scrapeState.lastResult = {
    processed: 50,
    failed: 5,
    observability: {
      retries: 4,
      listLatencyMs: {
        p95: 8_500,
      },
      detailLatencyMs: {
        p95: 16_000,
      },
      queueDepth: {
        p95: 70,
      },
    },
  };

  const response = await fetch(`${baseUrl}/api/ops/dashboard`, {
    headers: {
      Cookie: auth.cookie,
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(payload?.data?.kpis));
  assert.ok(payload.data.kpis.length >= 3);
  assert.ok(Array.isArray(payload?.data?.alerts));
  assert.ok(payload.data.alerts.length >= 1);
  assert.ok(payload?.data?.downloads?.running);
  assert.equal(payload?.data?.scrape?.hasResult, true);
});

test("GET /api/ops/alerts should return active and recent lists", async () => {
  const auth = await loginAsAdmin();

  const response = await fetch(`${baseUrl}/api/ops/alerts?limit=5`, {
    headers: {
      Cookie: auth.cookie,
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(payload?.data?.active));
  assert.ok(Array.isArray(payload?.data?.recent));
  assert.ok(Number.isFinite(Number(payload?.data?.activeCount)));
});

test("POST /api/ops/benchmark should accept benchmark payload", async () => {
  const auth = await loginAsAdmin();
  const response = await fetch(`${baseUrl}/api/ops/benchmark`, {
    method: "POST",
    headers: {
      Cookie: auth.cookie,
      "Content-Type": "application/json",
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify({
      source: "integration-test",
      sampleCount: 3,
      maxRegressionPct: 20,
      endpoints: [
        {
          id: "opsDashboard",
          path: "/api/ops/dashboard",
          p95Ms: 122.5,
          failures: 0,
        },
      ],
      regressions: [],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 202);
  assert.equal(payload?.data?.saved, true);
  assert.match(String(payload?.data?.benchmarkId || ""), /^ops-bench-/);
  assert.equal(payload?.data?.summary?.endpointCount, 1);
});

test("unauthenticated html routes should redirect to login with next target", async () => {
  const docsRoute = await fetch(`${baseUrl}/dokumantasyon`, {
    redirect: "manual",
  });
  assert.equal(docsRoute.status, 302);
  assert.equal(docsRoute.headers.get("location"), "/login?next=%2Fdokumantasyon");

  const docsStatic = await fetch(`${baseUrl}/docs.html`, {
    redirect: "manual",
  });
  assert.equal(docsStatic.status, 302);
  assert.equal(docsStatic.headers.get("location"), "/login?next=%2Fdocs.html");
});

test("panel routes should require selection step before project page access", async () => {
  const auth = await loginAsAdmin();
  const headers = {
    Cookie: auth.cookie,
  };

  const docsDirectBeforeSelect = await fetch(`${baseUrl}/dokumantasyon`, {
    headers,
    redirect: "manual",
  });
  assert.equal(docsDirectBeforeSelect.status, 302);
  assert.equal(docsDirectBeforeSelect.headers.get("location"), "/");

  const selectDocs = await fetch(`${baseUrl}/panel/dokumantasyon`, {
    headers,
    redirect: "manual",
  });
  assert.equal(selectDocs.status, 302);
  assert.equal(selectDocs.headers.get("location"), "/dokumantasyon");

  const docsAfterSelect = await fetch(`${baseUrl}/dokumantasyon`, {
    headers,
    redirect: "manual",
  });
  assert.equal(docsAfterSelect.status, 200);

  const docsStaticAfterSelect = await fetch(`${baseUrl}/docs.html`, {
    headers,
    redirect: "manual",
  });
  assert.equal(docsStaticAfterSelect.status, 200);

  const downloadsWhileDocsSelected = await fetch(`${baseUrl}/indirilenler`, {
    headers,
    redirect: "manual",
  });
  assert.equal(downloadsWhileDocsSelected.status, 200);

  const downloadsStaticWhileDocsSelected = await fetch(`${baseUrl}/downloads.html`, {
    headers,
    redirect: "manual",
  });
  assert.equal(downloadsStaticWhileDocsSelected.status, 200);

  const v3DirectWhileDocsSelected = await fetch(`${baseUrl}/ekapv3.html`, {
    headers,
    redirect: "manual",
  });
  assert.equal(v3DirectWhileDocsSelected.status, 302);
  assert.equal(v3DirectWhileDocsSelected.headers.get("location"), "/");

  const selectV3 = await fetch(`${baseUrl}/panel/ekapv3`, {
    headers,
    redirect: "manual",
  });
  assert.equal(selectV3.status, 302);
  assert.equal(selectV3.headers.get("location"), "/ekapv3.html");

  const downloadsWhileV3Selected = await fetch(`${baseUrl}/indirilenler`, {
    headers,
    redirect: "manual",
  });
  assert.equal(downloadsWhileV3Selected.status, 302);
  assert.equal(downloadsWhileV3Selected.headers.get("location"), "/");

  const docsStaticWhileV3Selected = await fetch(`${baseUrl}/docs.html`, {
    headers,
    redirect: "manual",
  });
  assert.equal(docsStaticWhileV3Selected.status, 302);
  assert.equal(docsStaticWhileV3Selected.headers.get("location"), "/");

  const home = await fetch(`${baseUrl}/`, {
    headers,
    redirect: "manual",
  });
  assert.equal(home.status, 200);

  const docsDirectAfterHome = await fetch(`${baseUrl}/dokumantasyon`, {
    headers,
    redirect: "manual",
  });
  assert.equal(docsDirectAfterHome.status, 302);
  assert.equal(docsDirectAfterHome.headers.get("location"), "/");
});
