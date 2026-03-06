const cheerio = require("cheerio");

function normalizeText(text) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanVeriHtml(rawHtml) {
  const original = typeof rawHtml === "string" ? rawHtml : "";
  const $ = cheerio.load(`<section id=\"root\">${original}</section>`, {
    decodeEntities: false,
    xmlMode: false,
  });

  const root = $("#root");
  root.find("script, style, noscript").remove();

  // Remove XML namespace attributes copied from source payload.
  root.find("*").each((_, element) => {
    const attribs = element.attribs || {};
    for (const attributeName of Object.keys(attribs)) {
      if (attributeName.toLowerCase().startsWith("xmlns")) {
        $(element).removeAttr(attributeName);
      }
    }
  });

  root.find("br").replaceWith("\n");
  root.find("p, div, tr, table, center, li").each((_, element) => {
    $(element).append("\n");
  });

  const cleanText = normalizeText(root.text());
  const cleanHtml = (root.html() || "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();

  return {
    cleanHtml,
    cleanText,
  };
}

module.exports = {
  cleanVeriHtml,
};
