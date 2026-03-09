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
  assert.equal(_internal.resolveApiRequiredRole("POST", "/scrape/run"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/start"), "operator");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/downloads/delete"), "admin");
  assert.equal(_internal.resolveApiRequiredRole("POST", "/ekapv3/files/delete"), "admin");
});

test("parseScrapeOptions should support allPages mode", () => {
  const parsedAllPages = _internal.parseScrapeOptions({
    allPages: true,
    startPage: 5,
    endPage: 11,
    pageSize: 20,
  });

  assert.equal(parsedAllPages.startSkip, 0);
  assert.equal(parsedAllPages.maxPages, 0);
  assert.equal(parsedAllPages.pageRange?.allPages, true);
  assert.equal(parsedAllPages.pageRange?.startPage, 1);
  assert.equal(parsedAllPages.pageRange?.endPage, null);

  const parsedRange = _internal.parseScrapeOptions({
    allPages: false,
    startPage: 3,
    endPage: 6,
    pageSize: 10,
  });

  assert.equal(parsedRange.startSkip, 20);
  assert.equal(parsedRange.maxPages, 4);
  assert.equal(parsedRange.pageRange?.allPages, false);
  assert.equal(parsedRange.pageRange?.startPage, 3);
  assert.equal(parsedRange.pageRange?.endPage, 6);
});

test("parseEkapV3Options should support allPages mode", () => {
  const parsedAllPages = _internal.parseEkapV3Options({
    type: "mahkeme",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 5,
    endPage: 10,
    allPages: true,
    browserMode: "visible",
  });

  assert.equal(parsedAllPages.allPages, true);
  assert.equal(parsedAllPages.startPage, 1);
  assert.equal(parsedAllPages.endPage, null);
  assert.equal(parsedAllPages.browserMode, "visible");

  const parsedRange = _internal.parseEkapV3Options({
    type: "uyusmazlik",
    fromDate: "2026-03-01",
    toDate: "2026-03-09",
    startPage: 3,
    endPage: 8,
    allPages: false,
    browserMode: "headless",
  });

  assert.equal(parsedRange.allPages, false);
  assert.equal(parsedRange.startPage, 3);
  assert.equal(parsedRange.endPage, 8);
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
