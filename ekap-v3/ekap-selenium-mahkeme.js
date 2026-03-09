const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const chromedriver = require('chromedriver');

const BASE_URL = 'https://ekapv2.kik.gov.tr/sorgulamalar/kurul-kararlari';

const DEFAULT_FROM = '2026/02/01';
const DEFAULT_TO = '2026/02/15';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const prefix = `--${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toCalendarValue = (value) => {
  if (!value) return value;

  const ymdSlash = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  const ymdDash = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dmy = /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/;

  let match = value.match(ymdSlash);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;

  match = value.match(ymdDash);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;

  match = value.match(dmy);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;

  throw new Error(`Invalid date format: ${value}. Use YYYY/MM/DD, YYYY-MM-DD or DD.MM.YYYY`);
};

const normalizeMonthText = (value) =>
  value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const monthMap = {
  ocak: 1,
  subat: 2,
  mart: 3,
  nisan: 4,
  mayis: 5,
  haziran: 6,
  temmuz: 7,
  agustos: 8,
  eylul: 9,
  ekim: 10,
  kasim: 11,
  aralik: 12,
};

const parseMonthYearLabel = (label) => {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const month = monthMap[normalizeMonthText(parts[0])];
  const year = Number(parts[1]);
  if (!month || Number.isNaN(year)) return null;

  return { month, year };
};

const fromDate = toCalendarValue(getArg('from', process.env.FROM_DATE || DEFAULT_FROM));
const toDate = toCalendarValue(getArg('to', process.env.TO_DATE || DEFAULT_TO));
const maxPagesRaw = Number(getArg('maxPages', process.env.MAX_PAGES || '500'));
const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.floor(maxPagesRaw) : 500;
const startPageRaw = Number(getArg('startPage', process.env.START_PAGE || '1'));
const startPage = Number.isFinite(startPageRaw) && startPageRaw >= 1 ? Math.floor(startPageRaw) : 1;
const allPagesArg = (getArg('allPages', process.env.ALL_PAGES || '') || '').toLowerCase();
const allPages = allPagesArg === '1' || allPagesArg === 'true' || allPagesArg === 'yes' || allPagesArg === 'on';
const endPageArg = getArg('endPage', process.env.END_PAGE || '');
const hasEndPage = !allPages && endPageArg !== '';
const endPageRaw = hasEndPage ? Number(endPageArg) : null;
if (hasEndPage && (!Number.isFinite(endPageRaw) || endPageRaw < startPage)) {
  throw new Error(`Invalid endPage: ${endPageArg}. endPage must be >= startPage (${startPage}).`);
}
const endPage =
  hasEndPage && Number.isFinite(endPageRaw) && endPageRaw >= startPage
    ? Math.floor(endPageRaw)
    : startPage + maxPages - 1;
const dateInputIndex = Number(getArg('dateInputIndex', process.env.DATE_INPUT_INDEX || '0'));
const timeoutRetriesRaw = Number(getArg('timeoutRetries', process.env.TIMEOUT_RETRIES || '2'));
const timeoutRetries =
  Number.isFinite(timeoutRetriesRaw) && timeoutRetriesRaw >= 0 ? Math.floor(timeoutRetriesRaw) : 2;

const browserMode = (getArg('browserMode', process.env.BROWSER_MODE || '') || '').toLowerCase();
const legacyHeadlessArg = (getArg('headless', process.env.HEADLESS || '') || '').toLowerCase();
if (browserMode && browserMode !== 'headless' && browserMode !== 'visible') {
  throw new Error(`Invalid browserMode: ${browserMode}. Use "headless" or "visible".`);
}
const isHeadless = browserMode ? browserMode === 'headless' : legacyHeadlessArg === 'true';

const downloadsDir = path.join(process.cwd(), 'indirilenler', 'mahkeme');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

const getNewestFileTimestamp = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let newest = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.crdownload') || entry.name.endsWith('.part')) continue;
    const stat = fs.statSync(path.join(dir, entry.name));
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }

  return newest;
};

const hasPartialDownload = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.some(
    (entry) => entry.isFile() && (entry.name.endsWith('.crdownload') || entry.name.endsWith('.part')),
  );
};

const waitForDownloadStart = async (dir, baseline, timeoutMs = 20000, intervalMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newest = getNewestFileTimestamp(dir);
    if (newest > baseline || hasPartialDownload(dir)) return;
    await sleep(intervalMs);
  }
  throw new Error('Download did not start.');
};

const waitForDownloadComplete = async (dir, baseline, timeoutMs = 120000, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newest = getNewestFileTimestamp(dir);
    if (newest > baseline && !hasPartialDownload(dir)) return;
    await sleep(intervalMs);
  }
  throw new Error('Download timed out.');
};

const buildDriver = () => {
  const options = new chrome.Options();
  const userDataDirArg = getArg('userDataDir', '');
  const userDataDir = userDataDirArg || fs.mkdtempSync(path.join(os.tmpdir(), 'ekapv2-chrome-'));

  options.addArguments(
    `--user-data-dir=${userDataDir}`,
    '--disable-features=InsecureDownloadWarnings,InsecureDownloadBlocking',
    '--safebrowsing-disable-download-protection',
    '--allow-running-insecure-content',
  );

  if (isHeadless) {
    options.addArguments('--headless=new');
  }

  options.setUserPreferences({
    'download.default_directory': downloadsDir,
    'download.prompt_for_download': false,
    'download.directory_upgrade': true,
    'safebrowsing.enabled': true,
  });

  const service = new chrome.ServiceBuilder(chromedriver.path);
  return new Builder().forBrowser('chrome').setChromeOptions(options).setChromeService(service).build();
};

const getVisibleElements = async (driver, selector) => {
  const elements = await driver.findElements(By.css(selector));
  const visible = [];
  for (const element of elements) {
    if (await element.isDisplayed()) visible.push(element);
  }
  return visible;
};

const clickByJs = async (driver, element) => {
  await driver.executeScript('arguments[0].scrollIntoView({block: "center"});', element);
  await driver.executeScript('arguments[0].click();', element);
};

const waitForDatepickerOpen = async (driver) => {
  await driver.wait(async () => {
    const cells = await getVisibleElements(driver, 'td.dx-calendar-cell[data-value]');
    return cells.length > 0;
  }, 10000);
};

const getVisibleCalendarMonths = async (driver) => {
  const labels = await driver.executeScript(`
    return [...document.querySelectorAll('.dx-calendar-caption-button')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);
  `);

  return labels.map(parseMonthYearLabel).filter(Boolean);
};

const clickCalendarNavigator = async (driver, direction) => {
  const selector =
    direction === 'next'
      ? 'div.dx-calendar-navigator-next-view, button.dx-calendar-navigator-next-view'
      : 'div.dx-calendar-navigator-previous-view, button.dx-calendar-navigator-previous-view';

  const buttons = await getVisibleElements(driver, selector);
  if (!buttons.length) throw new Error(`Calendar ${direction} navigator not found.`);
  await clickByJs(driver, buttons[0]);
};

const selectDateCell = async (driver, dateValue) => {
  const [targetYearRaw, targetMonthRaw] = dateValue.split('/');
  const targetYear = Number(targetYearRaw);
  const targetMonth = Number(targetMonthRaw);
  const targetSerial = targetYear * 12 + targetMonth;

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const cells = await getVisibleElements(driver, `td.dx-calendar-cell[data-value="${dateValue}"]`);
    if (cells[0]) {
      await clickByJs(driver, cells[0]);
      return;
    }

    const months = await getVisibleCalendarMonths(driver);
    if (!months.length) {
      throw new Error('Calendar caption not found while selecting date.');
    }

    const serials = months.map((m) => m.year * 12 + m.month);
    const minSerial = Math.min(...serials);
    const maxSerial = Math.max(...serials);

    if (targetSerial < minSerial) {
      await clickCalendarNavigator(driver, 'prev');
    } else {
      await clickCalendarNavigator(driver, 'next');
    }

    await sleep(120);
  }

  throw new Error(`Could not locate date cell ${dateValue} in calendar.`);
};

const openDateRangePicker = async (driver) => {
  const inputs = await driver.wait(
    until.elementsLocated(By.css('input.dx-texteditor-input[role="combobox"]')),
    15000,
  );

  if (!inputs[dateInputIndex]) {
    throw new Error(`Date input index ${dateInputIndex} not found.`);
  }

  await clickByJs(driver, inputs[dateInputIndex]);
  await waitForDatepickerOpen(driver);
};

const clickSearch = async (driver) => {
  const searchButton = await driver.wait(until.elementLocated(By.css('#search-button')), 15000);
  await clickByJs(driver, searchButton);
};

const waitGridReady = async (driver) => {
  await driver.wait(async () => {
    const icons = await getVisibleElements(driver, 'div#show-detail-button.grid-detail-icon');
    return icons.length > 0;
  }, 20000);
};

const waitForNewWindowHandle = async (driver, oldHandles, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handles = await driver.getAllWindowHandles();
    const newHandle = handles.find((h) => !oldHandles.includes(h));
    if (newHandle) return newHandle;
    await sleep(250);
  }
  return null;
};

const isConnectionTimedOutError = (err) =>
  /ERR_CONNECTION_TIMED_OUT/i.test(((err && err.message) || String(err)).toUpperCase());

const restoreMainWindow = async (driver, mainHandle) => {
  const handles = await driver.getAllWindowHandles();
  for (const handle of handles) {
    if (handle === mainHandle) continue;
    try {
      await driver.switchTo().window(handle);
      await driver.close();
    } catch (closeErr) {
      // Best effort cleanup.
    }
  }

  const remaining = await driver.getAllWindowHandles();
  if (remaining.includes(mainHandle)) {
    await driver.switchTo().window(mainHandle);
    return;
  }
  if (remaining[0]) {
    await driver.switchTo().window(remaining[0]);
  }
};

const clickDownloadInDetail = async (driver, baseline) => {
  const downloadButton = await driver.wait(
    until.elementLocated(By.css('#ctl00_ContentPlaceHolder1_downloadKarar')),
    20000,
  );

  await clickByJs(driver, downloadButton);
  await waitForDownloadStart(downloadsDir, baseline, 25000);
  await waitForDownloadComplete(downloadsDir, baseline, 180000);
};

const processCurrentPageRows = async (driver, pageNo) => {
  let rowIndex = 0;
  let timeoutRetryCount = 0;
  let downloaded = 0;
  let failed = 0;
  let retries = 0;

  while (true) {
    const icons = await getVisibleElements(driver, 'div#show-detail-button.grid-detail-icon');
    if (rowIndex >= icons.length) break;

    const icon = icons[rowIndex];
    const baseline = getNewestFileTimestamp(downloadsDir);
    const mainHandle = await driver.getWindowHandle();
    const handlesBefore = await driver.getAllWindowHandles();

    try {
      await clickByJs(driver, icon);

      const detailHandle = await waitForNewWindowHandle(driver, handlesBefore, 10000);
      if (detailHandle) {
        await driver.switchTo().window(detailHandle);
      }

      await clickDownloadInDetail(driver, baseline);

      if (detailHandle) {
        await driver.close();
        await driver.switchTo().window(mainHandle);
      }

      console.log(`Page ${pageNo}, row ${rowIndex + 1}: downloaded.`);
      downloaded += 1;
      rowIndex += 1;
      timeoutRetryCount = 0;
    } catch (err) {
      console.error(`Page ${pageNo}, row ${rowIndex + 1}: failed -> ${err.message}`);
      await restoreMainWindow(driver, mainHandle);

      if (isConnectionTimedOutError(err) && timeoutRetryCount < timeoutRetries) {
        timeoutRetryCount += 1;
        retries += 1;
        console.warn(
          `Page ${pageNo}, row ${rowIndex + 1}: ERR_CONNECTION_TIMED_OUT, retrying (${timeoutRetryCount}/${timeoutRetries})`,
        );
        await sleep(1200 * timeoutRetryCount);
        continue;
      }

      failed += 1;
      rowIndex += 1;
      timeoutRetryCount = 0;
    }

    await sleep(400);
  }

  return { downloaded, failed, retries };
};

const moveToNextPage = async (driver, currentPage) => {
  const target = String(currentPage + 1);

  const nextPageButton = await driver.wait(async () => {
    const pages = await getVisibleElements(driver, 'div.dx-page[role="button"]');
    for (const page of pages) {
      const text = (await page.getText()).trim();
      if (text === target) return page;
    }
    return null;
  }, 5000).catch(() => null);

  if (!nextPageButton) return false;

  await clickByJs(driver, nextPageButton);

  await driver
    .wait(async () => {
      const selected = await driver.executeScript(
        `
          const selectedPage = [...document.querySelectorAll('div.dx-page.dx-selection')]
            .find((el) => el.offsetParent !== null);
          return selectedPage ? selectedPage.textContent.trim() : null;
        `,
      );
      return selected === target;
    }, 10000)
    .catch(async () => {
      await sleep(1200);
    });

  await sleep(600);
  return true;
};

const run = async () => {
  const driver = buildDriver();
  let totalDownloaded = 0;
  let totalFailed = 0;
  let totalRetries = 0;

  try {
    console.log(`Going to ${BASE_URL}`);
    console.log(`Date range: ${fromDate} -> ${toDate}`);
    console.log(`Page range: ${allPages ? `${startPage} -> TUMU` : `${startPage} -> ${endPage}`}`);
    console.log(`Browser mode: ${isHeadless ? 'headless' : 'visible'}`);
    console.log(`Timeout retries per row: ${timeoutRetries}`);

    await driver.get(BASE_URL);

    await openDateRangePicker(driver);
    await selectDateCell(driver, fromDate);
    await selectDateCell(driver, toDate);

    await clickSearch(driver);
    await waitGridReady(driver);

    let currentPage = 1;

    while (currentPage < startPage) {
      const moved = await moveToNextPage(driver, currentPage);
      if (!moved) {
        throw new Error(`Could not reach startPage=${startPage}. Last available page: ${currentPage}`);
      }
      currentPage += 1;
      await waitGridReady(driver);
    }

    for (; allPages || currentPage <= endPage; currentPage += 1) {
      console.log(`Processing page ${currentPage}`);
      const pageStats = await processCurrentPageRows(driver, currentPage);
      totalDownloaded += pageStats.downloaded;
      totalFailed += pageStats.failed;
      totalRetries += pageStats.retries;

      if (!allPages && currentPage >= endPage) {
        console.log('Reached endPage. Finished.');
        break;
      }

      const moved = await moveToNextPage(driver, currentPage);
      if (!moved) {
        console.log('No more pages. Finished.');
        break;
      }

      await waitGridReady(driver);
    }
    console.log(
      `[SUMMARY] downloaded=${totalDownloaded} failed=${totalFailed} retries=${totalRetries}`,
    );
  } finally {
    await driver.quit();
  }
};

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
