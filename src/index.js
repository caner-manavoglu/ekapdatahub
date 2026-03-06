const { runScraper } = require("./scraper");

runScraper().catch((error) => {
  const message = error?.response?.data
    ? JSON.stringify(error.response.data)
    : error?.message || String(error);
  console.error(`[FATAL] Scraper durduruldu: ${message}`);
  process.exitCode = 1;
});
