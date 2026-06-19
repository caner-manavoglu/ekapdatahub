const test = require("node:test");
const assert = require("node:assert/strict");

const { app, _internal } = require("../src/web/server");

let server;
let baseUrl = "";

function makeFakeCollection() {
  return {
    async countDocuments() {
      return 0;
    },
    find() {
      return {
        project() {
          return this;
        },
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return [];
        },
      };
    },
    async deleteMany(filter) {
      const ids = Array.isArray(filter?._id?.$in) ? filter._id.$in : [];
      return { deletedCount: ids.length };
    },
  };
}

function makeFakeAuditCollection() {
  return {
    async insertOne() {
      return { acknowledged: true };
    },
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

test("GET /api/health should return ok payload", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload?.ok, true);
});

test("GET /api/tenders should be publicly reachable", async () => {
  const response = await fetch(`${baseUrl}/api/tenders?page=1&limit=5`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(payload?.data));
  assert.equal(payload?.meta?.page, 1);
});

test("POST /api/downloads/delete should work without auth", async () => {
  const response = await fetch(`${baseUrl}/api/downloads/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
});

test("POST /api/ekapv3/files/open-dir should work without auth", async () => {
  const response = await fetch(`${baseUrl}/api/ekapv3/files/open-dir`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "mahkeme" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload?.data?.opened, true);
});

test("GET /dokumantasyon should render directly without login redirect", async () => {
  const response = await fetch(`${baseUrl}/dokumantasyon`, {
    redirect: "manual",
  });

  assert.equal(response.status, 200);
});
