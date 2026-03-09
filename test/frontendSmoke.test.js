const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function readPublicFile(name) {
  const filePath = path.join(__dirname, "..", "src", "web", "public", name);
  return fs.readFileSync(filePath, "utf8");
}

test("main pages should include auth bootstrap script", () => {
  const indexHtml = readPublicFile("index.html");
  const docsHtml = readPublicFile("docs.html");
  const downloadsHtml = readPublicFile("downloads.html");
  const ekapv3Html = readPublicFile("ekapv3.html");

  assert.match(indexHtml, /<script src="\/auth\.js" defer><\/script>/);
  assert.match(docsHtml, /<script src="\/auth\.js" defer><\/script>/);
  assert.match(downloadsHtml, /<script src="\/auth\.js" defer><\/script>/);
  assert.match(ekapv3Html, /<script src="\/auth\.js" defer><\/script>/);
});

test("status areas should be screen-reader friendly", () => {
  const docsHtml = readPublicFile("docs.html");
  const downloadsHtml = readPublicFile("downloads.html");
  const ekapv3Html = readPublicFile("ekapv3.html");

  assert.match(docsHtml, /id="scrapeStatus"[^>]*aria-live="polite"/);
  assert.match(downloadsHtml, /id="downloadStatus"[^>]*aria-live="polite"/);
  assert.match(ekapv3Html, /id="v3Status"[^>]*aria-live="polite"/);
});

test("documentation page tabs should include tab semantics", () => {
  const docsHtml = readPublicFile("docs.html");

  assert.match(docsHtml, /role="tablist"/);
  assert.match(docsHtml, /id="tabFull"[^>]*role="tab"/);
  assert.match(docsHtml, /id="tabSummary"[^>]*role="tab"/);
  assert.match(docsHtml, /id="panelFull"[^>]*role="tabpanel"/);
  assert.match(docsHtml, /id="panelSummary"[^>]*role="tabpanel"/);
  assert.match(docsHtml, /id="detailNotice"[^>]*aria-live="polite"/);
  assert.match(docsHtml, /id="scrapeAllPagesCheckbox"/);
});

test("home page should include panel selection links", () => {
  const indexHtml = readPublicFile("index.html");

  assert.match(indexHtml, /href="\/panel\/dokumantasyon"/);
  assert.match(indexHtml, /href="\/panel\/ekapv3"/);
});

test("downloads page should provide documentation return link", () => {
  const downloadsHtml = readPublicFile("downloads.html");

  assert.match(downloadsHtml, /href="\/dokumantasyon"/);
  assert.match(downloadsHtml, /<title>EKAP Kayıt Yönetimi<\/title>/);
  assert.doesNotMatch(downloadsHtml, /id="deleteByDateButton"/);
  assert.doesNotMatch(downloadsHtml, /Tarihi Toplu Sil/);
});

test("ekap v3 page should not include downloads page nav link", () => {
  const ekapv3Html = readPublicFile("ekapv3.html");

  assert.doesNotMatch(ekapv3Html, /href="\/indirilenler"/);
  assert.match(ekapv3Html, /id="allPages"/);
  assert.match(ekapv3Html, /id="resumeFromLast"/);
});

test("login page should include required fields and scripts", () => {
  const loginHtml = readPublicFile("login.html");

  assert.match(loginHtml, /id="loginForm"/);
  assert.match(loginHtml, /id="loginUsername"/);
  assert.match(loginHtml, /id="loginPassword"/);
  assert.match(loginHtml, /<script src="\/auth\.js" defer><\/script>/);
  assert.match(loginHtml, /<script src="\/login\.js" defer><\/script>/);
});
