const test = require("node:test");
const assert = require("node:assert/strict");

const { cleanVeriHtml } = require("../src/htmlCleaner");

test("cleanVeriHtml should remove xmlns attributes and create clean text", () => {
  const source = '<div xmlns:xs="x"><span class="idareBilgi">Merhaba</span><br/>Dunya</div>';
  const result = cleanVeriHtml(source);

  assert.equal(typeof result.cleanHtml, "string");
  assert.equal(typeof result.cleanText, "string");
  assert.match(result.cleanText, /Merhaba/);
  assert.match(result.cleanText, /Dunya/);
  assert.doesNotMatch(result.cleanHtml, /xmlns:xs=/);
});

test("cleanVeriHtml should return empty strings for invalid input", () => {
  const result = cleanVeriHtml(null);

  assert.equal(result.cleanHtml, "");
  assert.equal(result.cleanText, "");
});
