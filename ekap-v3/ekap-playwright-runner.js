const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const BASE_URL = 'https://ekapv2.kik.gov.tr/sorgulamalar/kurul-kararlari';

const DEFAULT_FROM = '2026/02/01';
const DEFAULT_TO = '2026/02/15';
const DEFAULT_MIN_DOWNLOAD_BYTES = 1_024;
const DEFAULT_RETRY_MAX_DELAY_MS = 25_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 900;
const DEFAULT_RETRY_JITTER_RATIO = 0.25;

const SELECTORS = {
  dateInputs: ['input.dx-texteditor-input[role="combobox"]', 'input.dx-texteditor-input'],
  searchButtons: ['#search-button', 'button#search-button', '.search-button', 'button.dx-button'],
  detailIcons: ['div#show-detail-button.grid-detail-icon', 'div.grid-detail-icon', '#show-detail-button'],
  noData: ['.dx-datagrid-nodata'],
  pagination: ['div.dx-page[role="button"]', '.dx-page[role="button"]'],
  selectedPage: ['div.dx-page.dx-selection', '.dx-page.dx-selection'],
  downloadButtons: [
    '#ctl00_ContentPlaceHolder1_downloadKararUyuşmazlik',
    'a#ctl00_ContentPlaceHolder1_downloadKararUyuşmazlik',
    'input#ctl00_ContentPlaceHolder1_downloadKararUyuşmazlik',
    '#ctl00_ContentPlaceHolder1_downloadKarar',
    'a#ctl00_ContentPlaceHolder1_downloadKarar',
    'input#ctl00_ContentPlaceHolder1_downloadKarar',
    '[id$="downloadKarar"]',
    '[id*="downloadKarar"]',
  ],
};

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMonthText = (value) =>
  value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const parseMonthYearLabel = (label) => {
  const parts = String(label || '').trim().split(/\s+/);
  if (parts.length < 2) return null;

  const month = monthMap[normalizeMonthText(parts[0])];
  const year = Number(parts[1]);
  if (!month || Number.isNaN(year)) return null;

  return { month, year };
};

const toCalendarValue = (value) => {
  if (!value) return value;

  const ymdSlash = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  const ymdDash = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dmy = /^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/;

  let match = String(value).match(ymdSlash);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;

  match = String(value).match(ymdDash);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;

  match = String(value).match(dmy);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;

  throw new Error(`Invalid date format: ${value}. Use YYYY/MM/DD, YYYY-MM-DD or DD.MM.YYYY`);
};

const sanitizeFileName = (value) =>
  String(value || 'download.pdf')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

const ensureUniquePath = (dir, fileName) => {
  const parsed = path.parse(fileName);
  const baseName = parsed.name || 'download';
  const ext = parsed.ext || '.pdf';
  let candidate = path.join(dir, `${baseName}${ext}`);
  let seq = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName} (${seq})${ext}`);
    seq += 1;
  }

  return candidate;
};

const toBoundedInt = (value, fallback, min = 1, max = Number.POSITIVE_INFINITY) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const toBoolArg = (value, fallback = false) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
};

const normalizeTextKey = (value) =>
  String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const hashText = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const computeBackoffDelayMs = (attempt, baseDelayMs, maxDelayMs, jitterRatio) => {
  const base = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = base * jitterRatio;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(base + delta));
};

const isRetryableBrowserError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return false;
  if (message.includes('timed out') || message.includes('timeout')) return true;
  if (message.includes('err_connection_') || message.includes('net::err_')) return true;
  if (message.includes('target closed')) return true;
  if (message.includes('detail popup/page did not open after clicking detail icon')) return true;
  if (message.includes('visible selector bulunamadi')) return true;
  if (message.includes('download button element handle not available')) return true;
  if (/\b5\d{2}\b/.test(message)) return true;
  return false;
};

const retryWithPolicy = async ({
  label,
  maxAttempts,
  baseDelayMs,
  maxDelayMs,
  jitterRatio,
  shouldRetry,
  onRetry,
  task,
}) => {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task(attempt);
    } catch (error) {
      const canRetry = attempt < maxAttempts && (typeof shouldRetry === 'function' ? shouldRetry(error) : true);
      if (!canRetry) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio);
      if (typeof onRetry === 'function') {
        onRetry({
          label,
          attempt,
          maxAttempts,
          delayMs,
          error,
        });
      }
      await sleep(delayMs);
    }
  }
  throw new Error(`Retry policy exhausted: ${label}`);
};

const loadJsonFileSafe = (filePath, fallback) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
};

const writeJsonFileAtomic = async (targetPath, payload) => {
  const dirPath = path.dirname(targetPath);
  await fs.promises.mkdir(dirPath, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, targetPath);
};

const ensureDirWriteAccess = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
  const probePath = path.join(dirPath, `.write-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.promises.writeFile(probePath, 'ok', 'utf8');
  await fs.promises.unlink(probePath).catch(() => {});
};

const waitForStableFile = async (targetPath, timeoutMs = 7000, intervalMs = 250) => {
  const startedAt = Date.now();
  let lastSize = -1;
  let stableTicks = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile()) {
        throw new Error('not-a-file');
      }
      if (stat.size > 0 && stat.size === lastSize) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
      }
      lastSize = stat.size;
      if (stableTicks >= 2) {
        return;
      }
    } catch (_) {
      // File may not be visible yet; keep polling.
    }
    await sleep(intervalMs);
  }

  throw new Error(`Downloaded file did not stabilize in time: ${path.basename(targetPath)}`);
};

const parseContentDispositionFileName = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const starMatch = raw.match(/filename\*\s*=\s*([^;]+)/i);
  if (starMatch && starMatch[1]) {
    let token = starMatch[1].trim().replace(/^"(.*)"$/, '$1');
    const encodedMatch = token.match(/^[^']*'[^']*'(.*)$/);
    if (encodedMatch && encodedMatch[1]) {
      token = encodedMatch[1];
    }
    try {
      return decodeURIComponent(token).trim();
    } catch (_) {
      return token.trim();
    }
  }

  const plainMatch = raw.match(/filename\s*=\s*("([^"]+)"|[^;]+)/i);
  if (!plainMatch || !plainMatch[1]) return '';
  return String(plainMatch[2] || plainMatch[1]).trim().replace(/^"(.*)"$/, '$1');
};

const ensurePdfExtension = (fileName, fallbackStem = 'ekap') => {
  const safe = sanitizeFileName(fileName || '');
  if (!safe) {
    return `${sanitizeFileName(fallbackStem) || 'ekap'}.pdf`;
  }
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
};

const decodeHtmlAttribute = (value) =>
  String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const collectHiddenInputsFromHtml = (html) => {
  const source = String(html || '');
  const result = {};
  const inputTagRegex = /<input\b[^>]*>/gi;
  let tagMatch;

  while ((tagMatch = inputTagRegex.exec(source))) {
    const tag = tagMatch[0];
    const typeMatch = tag.match(/\btype\s*=\s*["']?([^"'\s>]+)["']?/i);
    const type = String(typeMatch?.[1] || '').toLowerCase();
    if (type && type !== 'hidden') continue;

    const nameMatch = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch || !nameMatch[1]) continue;
    const valueMatch = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    result[nameMatch[1]] = decodeHtmlAttribute(valueMatch?.[1] || '');
  }

  return result;
};

const extractPostbackTargetsFromHtml = (html) => {
  const source = String(html || '');
  const targets = [];
  const targetSet = new Set();
  const pushTarget = (target) => {
    const safe = String(target || '').trim();
    if (!safe) return;
    if (targetSet.has(safe)) return;
    targetSet.add(safe);
    targets.push(safe);
  };

  const doPostbackRegex = /__doPostBack\(\s*['"]([^'"]*downloadKarar[^'"]*)['"]/gi;
  let postbackMatch;
  while ((postbackMatch = doPostbackRegex.exec(source))) {
    pushTarget(postbackMatch[1]);
  }

  const idRegex = /\bid\s*=\s*["']([^"']*downloadKarar[^"']*)["']/gi;
  let idMatch;
  while ((idMatch = idRegex.exec(source))) {
    pushTarget(String(idMatch[1]).replace(/_/g, '$'));
  }

  pushTarget('ctl00$ContentPlaceHolder1$downloadKararUyuşmazlik');
  pushTarget('ctl00$ContentPlaceHolder1$downloadKarar');

  return targets;
};

const downloadViaKararPostback = async ({
  context,
  detailUrl,
  downloadsDir,
  meta,
  minDownloadBytes,
  enforcePdfHeader,
}) => {
  const safeDetailUrl = String(detailUrl || '').trim();
  if (!safeDetailUrl) {
    throw new Error('Detail URL missing for Karar postback download.');
  }

  const getResponse = await context.request.fetch(safeDetailUrl, {
    method: 'GET',
    timeout: 35_000,
    failOnStatusCode: false,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE_URL,
    },
  });

  if (!getResponse.ok()) {
    throw new Error(`Karar detail GET failed: status=${getResponse.status()}`);
  }

  const detailHtml = await getResponse.text();
  const hidden = collectHiddenInputsFromHtml(detailHtml);
  if (!hidden.__VIEWSTATE) {
    throw new Error('Karar detail page did not contain __VIEWSTATE.');
  }

  const targets = extractPostbackTargetsFromHtml(detailHtml);
  if (!targets.length) {
    throw new Error('Karar detail page did not expose any download postback targets.');
  }

  let lastError = null;
  for (const eventTarget of targets) {
    try {
      const formPayload = { ...hidden };
      formPayload.__EVENTTARGET = eventTarget;
      formPayload.__EVENTARGUMENT = '';

      const postResponse = await context.request.fetch(safeDetailUrl, {
        method: 'POST',
        timeout: 35_000,
        failOnStatusCode: false,
        headers: {
          Accept: 'application/pdf,application/octet-stream,*/*',
          Referer: safeDetailUrl,
        },
        form: formPayload,
      });

      if (!postResponse.ok()) {
        throw new Error(`status=${postResponse.status()}`);
      }

      const payload = await postResponse.body();
      if (!payload || payload.length < minDownloadBytes) {
        throw new Error(`too-small=${payload ? payload.length : 0}`);
      }

      const headers = postResponse.headers();
      const contentType = String(headers['content-type'] || '').toLowerCase();
      const looksLikePdf = payload.subarray(0, 4).toString('utf8') === '%PDF';
      if (!looksLikePdf && contentType && !contentType.includes('pdf')) {
        throw new Error(`non-pdf-content-type=${contentType}`);
      }

      const contentDisposition = String(headers['content-disposition'] || '');
      const headerFileName = parseContentDispositionFileName(contentDisposition);
      const fallbackFileName = buildFallbackFileNameFromMeta(meta);
      const targetName = ensurePdfExtension(headerFileName || fallbackFileName);
      const targetPath = ensureUniquePath(downloadsDir, targetName);
      await fs.promises.writeFile(targetPath, payload);
      await waitForStableFile(targetPath);

      const validation = await validateDownloadedFile({
        targetPath,
        minDownloadBytes,
        enforcePdfHeader,
      });

      return {
        status: 'downloaded',
        fileName: path.basename(targetPath),
        ...validation,
        transport: 'karar-postback',
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Karar postback download failed: ${lastError?.message || 'unknown error'}`);
};

const buildFallbackFileNameFromMeta = (meta) => {
  const kararNo = sanitizeFileName(meta?.kararNo || '');
  const kararTarihi = sanitizeFileName(String(meta?.kararTarihi || '').replace(/[./\\]/g, '-'));
  const stem = [kararNo, kararTarihi].filter(Boolean).join('_');
  return ensurePdfExtension(stem || `ekap-${Date.now()}`);
};

const extractApiDownloadSpecFromButton = async (downloadButton) =>
  downloadButton.evaluate((button) => {
    const parsePostback = (text) => {
      const script = String(text || '');
      if (!script) return null;

      const patterns = [
        /__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/i,
        /WebForm_PostBackOptions\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/i,
      ];
      for (const pattern of patterns) {
        const match = script.match(pattern);
        if (match && match[1]) {
          return {
            target: String(match[1] || '').trim(),
            argument: String(match[2] || '').trim(),
          };
        }
      }
      return null;
    };

    const collectFormFields = (form) => {
      if (!form) return {};
      const payload = {};
      const fields = Array.from(form.elements || []);
      for (const field of fields) {
        if (!field || !field.name || field.disabled) continue;
        const type = String(field.type || '').toLowerCase();
        if ((type === 'checkbox' || type === 'radio') && !field.checked) continue;
        if (field.tagName === 'SELECT' && field.multiple) {
          const selectedValues = Array.from(field.selectedOptions || []).map((opt) => String(opt.value || ''));
          payload[field.name] = selectedValues.join(',');
          continue;
        }
        payload[field.name] = String(field.value || '');
      }
      return payload;
    };

    const locationHref = String(window.location.href || '');
    const hrefRaw = String(button.getAttribute('href') || '').trim();
    const hrefScript = hrefRaw.toLowerCase().startsWith('javascript:') ? hrefRaw.slice(11) : '';
    const onclickScript = String(button.getAttribute('onclick') || '');
    const scriptText = `${onclickScript}\n${hrefScript}`;
    const postback = parsePostback(scriptText);
    const form = button.form || document.forms?.[0] || null;
    const method = String(form?.getAttribute('method') || 'POST').trim().toUpperCase() || 'POST';
    const actionRaw = String(form?.getAttribute('action') || locationHref).trim() || locationHref;
    const actionUrl = new URL(actionRaw, locationHref).toString();
    const formPayload = collectFormFields(form);

    if (hrefRaw && !hrefRaw.toLowerCase().startsWith('javascript:')) {
      return {
        mode: 'GET',
        url: new URL(hrefRaw, locationHref).toString(),
        form: {},
        source: 'href',
      };
    }

    if (postback?.target) {
      formPayload.__EVENTTARGET = postback.target;
      formPayload.__EVENTARGUMENT = postback.argument || '';
      return {
        mode: 'POST',
        url: actionUrl,
        form: formPayload,
        source: 'postback',
      };
    }

    const buttonName = String(button.getAttribute('name') || button.name || '').trim();
    if (buttonName) {
      formPayload[buttonName] = String(button.getAttribute('value') || button.value || '1');
      return {
        mode: method === 'GET' ? 'GET' : 'POST',
        url: actionUrl,
        form: formPayload,
        source: 'form-submit',
      };
    }

    return {
      mode: 'UNKNOWN',
      url: actionUrl,
      form: formPayload,
      source: 'unknown',
    };
  });

const downloadViaApiRequest = async ({
  context,
  popup,
  downloadButton,
  downloadsDir,
  meta,
  minDownloadBytes,
  enforcePdfHeader,
}) => {
  const spec = await extractApiDownloadSpecFromButton(downloadButton);
  if (!spec || !spec.url || spec.mode === 'UNKNOWN') {
    throw new Error('API-first request spec could not be inferred from detail page.');
  }

  const requestOptions = {
    method: String(spec.mode || 'GET').toUpperCase(),
    timeout: 35_000,
    failOnStatusCode: false,
    headers: {
      Accept: 'application/pdf,application/octet-stream,*/*',
      Referer: popup.url(),
    },
  };

  if (requestOptions.method === 'POST') {
    requestOptions.form = spec.form && typeof spec.form === 'object' ? spec.form : {};
  } else if (requestOptions.method === 'GET' && spec.form && Object.keys(spec.form).length > 0) {
    const url = new URL(spec.url);
    for (const [key, value] of Object.entries(spec.form)) {
      url.searchParams.set(String(key), String(value ?? ''));
    }
    spec.url = url.toString();
  }

  const response = await context.request.fetch(spec.url, requestOptions);
  const statusCode = Number(response.status());
  if (!response.ok()) {
    throw new Error(`API-first request failed: status=${statusCode} source=${spec.source}`);
  }

  const payload = await response.body();
  if (!payload || payload.length < minDownloadBytes) {
    throw new Error(`API-first response too small: ${payload ? payload.length : 0} bytes`);
  }

  const headers = response.headers();
  const contentType = String(headers['content-type'] || '').toLowerCase();
  if (
    contentType &&
    !contentType.includes('pdf') &&
    !contentType.includes('octet-stream') &&
    !contentType.includes('application/download')
  ) {
    // Do not hard-fail solely by content-type; header can be wrong.
    console.warn(`[API-FIRST] non-pdf content-type detected: ${contentType}`);
  }

  const contentDisposition = String(headers['content-disposition'] || '');
  const headerFileName = parseContentDispositionFileName(contentDisposition);
  const fallbackFileName = buildFallbackFileNameFromMeta(meta);
  const targetName = ensurePdfExtension(headerFileName || fallbackFileName);
  const targetPath = ensureUniquePath(downloadsDir, targetName);
  await fs.promises.writeFile(targetPath, payload);
  await waitForStableFile(targetPath);

  const validation = await validateDownloadedFile({
    targetPath,
    minDownloadBytes,
    enforcePdfHeader,
  });

  return {
    status: 'downloaded',
    fileName: path.basename(targetPath),
    ...validation,
    transport: 'api-first',
  };
};

const waitForVisibleSelector = async (page, selectors, timeoutMs = 15000) => {
  const list = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
  if (!list.length) {
    throw new Error('No selector candidates provided.');
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const foundSelector = await page.evaluate((candidates) => {
      for (const selector of candidates) {
        const node = document.querySelector(selector);
        if (node && node.offsetParent !== null) {
          return selector;
        }
      }
      return '';
    }, list);

    if (foundSelector) {
      return foundSelector;
    }
    await sleep(150);
  }

  throw new Error(`Visible selector bulunamadi. candidates=${list.join(', ')}`);
};

const waitForAnyGridSignal = async (page, timeoutMs = 20000) => {
  await page.waitForFunction(
    ({ iconSelectors, noDataSelectors }) => {
      const hasAnyVisible = (selectors) =>
        (Array.isArray(selectors) ? selectors : []).some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((el) => el.offsetParent !== null),
        );

      if (hasAnyVisible(iconSelectors)) return true;
      if (hasAnyVisible(noDataSelectors)) return true;
      return false;
    },
    {
      iconSelectors: SELECTORS.detailIcons,
      noDataSelectors: SELECTORS.noData,
    },
    { timeout: timeoutMs },
  );
};

const getVisibleDetailIconCount = async (page) =>
  page.evaluate((selectors) => {
    const seen = new Set();
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (el && el.offsetParent !== null) {
          seen.add(el);
        }
      }
    }
    return seen.size;
  }, SELECTORS.detailIcons);

const clickVisibleDetailIconAt = async (page, index) => {
  const clicked = await page.evaluate(
    ({ selectors, targetIndex }) => {
      const nodes = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (el && el.offsetParent !== null && !seen.has(el)) {
            seen.add(el);
            nodes.push(el);
          }
        }
      }
      if (targetIndex < 0 || targetIndex >= nodes.length) {
        return false;
      }
      nodes[targetIndex].click();
      return true;
    },
    {
      selectors: SELECTORS.detailIcons,
      targetIndex: index,
    },
  );

  if (!clicked) {
    throw new Error(`Detail icon index ${index} not found.`);
  }
};

const openDetailPopupOrPage = async ({
  context,
  page,
  rowIndex,
  attempts = 3,
  perAttemptTimeoutMs = 7000,
}) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const popupPromise = page.waitForEvent('popup', { timeout: perAttemptTimeoutMs }).catch(() => null);
    const contextPagePromise = context.waitForEvent('page', { timeout: perAttemptTimeoutMs }).catch(() => null);

    await clickVisibleDetailIconAt(page, rowIndex);
    const [popupFromPage, popupFromContext] = await Promise.all([popupPromise, contextPagePromise]);
    const popup = popupFromPage || (popupFromContext && popupFromContext !== page ? popupFromContext : null);
    if (popup) {
      return popup;
    }

    const openedInline = await page
      .evaluate(
        (downloadSelectors) =>
          downloadSelectors.some((selector) =>
            Array.from(document.querySelectorAll(selector)).some((el) => el.offsetParent !== null),
          ),
        SELECTORS.downloadButtons,
      )
      .catch(() => false);
    if (openedInline) {
      return page;
    }

    await sleep(Math.min(1200, 250 * attempt));
  }

  throw new Error('Detail popup/page did not open after clicking detail icon.');
};

const readPdfHeader = async (filePath) => {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead).toString('utf8') : '';
  } finally {
    await handle.close();
  }
};

const computeFileSha256 = async (filePath) => {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
};

const validateDownloadedFile = async ({
  targetPath,
  minDownloadBytes,
  enforcePdfHeader,
}) => {
  const fileName = path.basename(targetPath);
  const dirPath = path.dirname(targetPath);
  const parsed = path.parse(fileName);
  if (fileName.endsWith('.crdownload') || fileName.endsWith('.part')) {
    throw new Error(`Temporary download file remained: ${fileName}`);
  }
  if (!/\.pdf$/i.test(fileName)) {
    throw new Error(`Invalid extension, expected pdf: ${fileName}`);
  }

  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch (error) {
    throw new Error(`Downloaded file missing: ${error?.message || String(error)}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Download target is not a file: ${fileName}`);
  }
  if (stat.size < minDownloadBytes) {
    throw new Error(`Downloaded file too small (${stat.size} bytes): ${fileName}`);
  }

  const dirEntries = await fs.promises.readdir(dirPath).catch(() => []);
  const tempSibling = dirEntries.find(
    (entry) =>
      String(entry || '').startsWith(parsed.name) &&
      (entry.endsWith('.crdownload') || entry.endsWith('.part')),
  );
  if (tempSibling) {
    throw new Error(`Temporary sibling file detected: ${tempSibling}`);
  }

  if (enforcePdfHeader) {
    const header = await readPdfHeader(targetPath);
    if (!header.startsWith('%PDF')) {
      throw new Error(`Invalid PDF header: ${fileName}`);
    }
  }

  const sha256 = await computeFileSha256(targetPath);
  return {
    sizeBytes: stat.size,
    sha256,
  };
};

const extractDecisionMetaFromPopup = async (popup) =>
  popup.evaluate(() => {
    const text = String(document?.body?.innerText || '');

    const byRegex = (pattern) => {
      const match = text.match(pattern);
      return match && match[1] ? String(match[1]).trim() : '';
    };

    const kararNo =
      byRegex(/karar\s*no\s*[:\-]?\s*([^\n\r]+)/i) ||
      byRegex(/karar\s*say[ıi]s[ıi]\s*[:\-]?\s*([^\n\r]+)/i);
    const kararTarihi = byRegex(/karar\s*tarih(?:i)?\s*[:\-]?\s*([0-9]{1,2}[.\/-][0-9]{1,2}[.\/-][0-9]{2,4})/i);

    return {
      kararNo,
      kararTarihi,
      url: String(window?.location?.href || ''),
    };
  });

const buildDecisionIdempotencyKey = ({ type, meta, suggestedFileName }) => {
  const kararNo = normalizeTextKey(meta?.kararNo || '');
  const kararTarihi = normalizeTextKey(meta?.kararTarihi || '');
  const fileName = normalizeTextKey(suggestedFileName || '');
  const urlHash = hashText(String(meta?.url || '')).slice(0, 16);

  const baseParts = [normalizeTextKey(type), kararNo || 'no', kararTarihi || 'date'];
  if (kararNo || kararTarihi) {
    return baseParts.join('|');
  }
  return [...baseParts, fileName || 'file', urlHash].join('|');
};

const createIdempotencyStore = async ({ downloadsDir, type }) => {
  const manifestPath = path.join(downloadsDir, '.idempotency-manifest.json');
  const raw = loadJsonFileSafe(manifestPath, {});
  const entries = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  const seen = new Map(Object.entries(entries));
  const inflight = new Set();
  let writeChain = Promise.resolve();

  const persist = () => {
    const payload = {
      version: 1,
      type,
      updatedAt: new Date().toISOString(),
      entries: Object.fromEntries(seen),
    };
    writeChain = writeChain
      .then(() => writeJsonFileAtomic(manifestPath, payload))
      .catch(() => {});
    return writeChain;
  };

  return {
    manifestPath,
    reserve(key) {
      const safeKey = String(key || '').trim();
      if (!safeKey) return { accepted: false, reason: 'empty-key' };
      if (inflight.has(safeKey)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (seen.has(safeKey)) {
        const entry = seen.get(safeKey);
        const fileName = String(entry?.fileName || '').trim();
        const filePath = fileName ? path.join(downloadsDir, fileName) : '';
        if (filePath && fs.existsSync(filePath)) {
          return { accepted: false, reason: 'duplicate' };
        }
        // Manifestte var ama dosya yoksa stale kabul et, tekrar indir.
        seen.delete(safeKey);
        void persist();
      }
      inflight.add(safeKey);
      return { accepted: true, reason: 'reserved' };
    },
    commit(key, value) {
      const safeKey = String(key || '').trim();
      if (!safeKey) return;
      inflight.delete(safeKey);
      seen.set(safeKey, {
        ...(value && typeof value === 'object' ? value : {}),
        updatedAt: new Date().toISOString(),
      });
      void persist();
    },
    release(key) {
      const safeKey = String(key || '').trim();
      if (!safeKey) return;
      inflight.delete(safeKey);
    },
    has(key) {
      return seen.has(String(key || '').trim());
    },
    size() {
      return seen.size;
    },
    async flush() {
      await persist();
    },
  };
};

const createCheckpointManager = ({
  checkpointPath,
  enabled,
  runMeta,
}) => {
  const active = Boolean(enabled && checkpointPath);
  let state = {
    version: 1,
    runMeta: runMeta || {},
    updatedAt: new Date().toISOString(),
    lastProcessed: null,
    lastSuccess: null,
    totals: {
      downloaded: 0,
      failed: 0,
      retries: 0,
      duplicates: 0,
    },
  };
  let writeChain = Promise.resolve();

  const persist = () => {
    if (!active) return writeChain;
    state.updatedAt = new Date().toISOString();
    writeChain = writeChain
      .then(() => writeJsonFileAtomic(checkpointPath, state))
      .catch(() => {});
    return writeChain;
  };

  if (active) {
    const loaded = loadJsonFileSafe(checkpointPath, null);
    if (loaded && typeof loaded === 'object') {
      state = {
        ...state,
        ...loaded,
        runMeta: {
          ...(loaded.runMeta && typeof loaded.runMeta === 'object' ? loaded.runMeta : {}),
          ...(runMeta && typeof runMeta === 'object' ? runMeta : {}),
        },
      };
    }
  }

  return {
    enabled: active,
    path: checkpointPath,
    markProcessed({ pageNo, rowNo, success, duplicate, retryIncrement = 0 }) {
      if (!active) return;
      const page = toBoundedInt(pageNo, 0, 0);
      const row = toBoundedInt(rowNo, 0, 0);
      if (page <= 0 || row <= 0) return;

      state.lastProcessed = {
        page,
        row,
        at: new Date().toISOString(),
      };
      if (success) {
        state.lastSuccess = {
          page,
          row,
          at: new Date().toISOString(),
        };
        state.totals.downloaded = toBoundedInt(state.totals.downloaded, 0, 0) + 1;
      } else if (duplicate) {
        state.totals.duplicates = toBoundedInt(state.totals.duplicates, 0, 0) + 1;
      } else {
        state.totals.failed = toBoundedInt(state.totals.failed, 0, 0) + 1;
      }
      if (retryIncrement > 0) {
        state.totals.retries = toBoundedInt(state.totals.retries, 0, 0) + retryIncrement;
      }
      void persist();
      console.log(
        `[CHECKPOINT] page=${page} row=${row} success=${success ? '1' : '0'} duplicate=${duplicate ? '1' : '0'}`,
      );
    },
    markRetry(count = 1) {
      if (!active) return;
      const inc = toBoundedInt(count, 0, 0);
      if (inc <= 0) return;
      state.totals.retries = toBoundedInt(state.totals.retries, 0, 0) + inc;
      void persist();
    },
    async finish(summary) {
      if (!active) return;
      state.finishedAt = new Date().toISOString();
      if (summary && typeof summary === 'object') {
        state.summary = {
          ...(state.summary && typeof state.summary === 'object' ? state.summary : {}),
          ...summary,
        };
      }
      await persist();
    },
    getLastSuccess() {
      const last = state.lastSuccess;
      if (!last || typeof last !== 'object') return null;
      const page = toBoundedInt(last.page, 0, 0);
      const row = toBoundedInt(last.row, 0, 0);
      if (page <= 0 || row <= 0) return null;
      return { page, row };
    },
  };
};

const clickLocator = async (locator) => {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: 7000 });
  } catch (error) {
    const handle = await locator.elementHandle();
    if (!handle) throw error;
    await handle.evaluate((el) => el.click());
  }
};

const clickLocatorWithFallbacks = async (locator) => {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: 6000 });
    return;
  } catch (_) {
    // fallback-1
  }
  try {
    await locator.click({ timeout: 6000, force: true });
    return;
  } catch (_) {
    // fallback-2
  }
  const handle = await locator.elementHandle();
  if (!handle) {
    throw new Error('Download button element handle not available.');
  }
  await handle.evaluate((el) => {
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    el.click();
  });
};

const waitForDatepickerOpen = async (page) => {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('td.dx-calendar-cell[data-value]')).some(
        (el) => el.offsetParent !== null,
      ),
    { timeout: 10000 },
  );
};

const getVisibleCalendarMonths = async (page) => {
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dx-calendar-caption-button'))
      .filter((el) => el.offsetParent !== null)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean),
  );

  return labels.map(parseMonthYearLabel).filter(Boolean);
};

const clickCalendarNavigator = async (page, direction) => {
  const selector =
    direction === 'next'
      ? 'div.dx-calendar-navigator-next-view, button.dx-calendar-navigator-next-view'
      : 'div.dx-calendar-navigator-previous-view, button.dx-calendar-navigator-previous-view';

  const clicked = await page.evaluate((targetSelector) => {
    const button = Array.from(document.querySelectorAll(targetSelector)).find(
      (el) => el.offsetParent !== null,
    );
    if (!button) return false;
    button.click();
    return true;
  }, selector);

  if (!clicked) {
    throw new Error(`Calendar ${direction} navigator not found.`);
  }
};

const selectDateCell = async (page, dateValue) => {
  const [targetYearRaw, targetMonthRaw] = String(dateValue).split('/');
  const targetYear = Number(targetYearRaw);
  const targetMonth = Number(targetMonthRaw);
  const targetSerial = targetYear * 12 + targetMonth;

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const clicked = await page.evaluate((value) => {
      const cell = Array.from(document.querySelectorAll('td.dx-calendar-cell[data-value]')).find(
        (el) => el.offsetParent !== null && el.getAttribute('data-value') === value,
      );
      if (!cell) return false;
      cell.click();
      return true;
    }, dateValue);

    if (clicked) {
      return;
    }

    const months = await getVisibleCalendarMonths(page);
    if (!months.length) {
      throw new Error('Calendar caption not found while selecting date.');
    }

    const serials = months.map((m) => m.year * 12 + m.month);
    const minSerial = Math.min(...serials);

    if (targetSerial < minSerial) {
      await clickCalendarNavigator(page, 'prev');
    } else {
      await clickCalendarNavigator(page, 'next');
    }

    await sleep(120);
  }

  throw new Error(`Could not locate date cell ${dateValue} in calendar.`);
};

const openDateRangePicker = async (page, dateInputIndex) => {
  const selectorCandidates = [...SELECTORS.dateInputs];

  let targetSelector = '';
  let visibleIndexes = [];
  for (const candidate of selectorCandidates) {
    await page.waitForSelector(candidate, { state: 'attached', timeout: 20000 }).catch(() => {});
    const indexes = await page
      .locator(candidate)
      .evaluateAll((els) =>
        els
          .map((el, idx) => ({ idx, visible: el.offsetParent !== null }))
          .filter((row) => row.visible)
          .map((row) => row.idx),
      )
      .catch(() => []);

    if (indexes.length > 0) {
      targetSelector = candidate;
      visibleIndexes = indexes;
      break;
    }
  }

  if (!targetSelector || visibleIndexes.length <= dateInputIndex) {
    throw new Error(`Date input index ${dateInputIndex} not found.`);
  }

  const inputs = page.locator(targetSelector);
  await clickLocator(inputs.nth(visibleIndexes[dateInputIndex]));
  await waitForDatepickerOpen(page);
};

const clickSearch = async (page) => {
  const selector = await waitForVisibleSelector(page, SELECTORS.searchButtons, 15000);
  const searchButton = page.locator(selector).first();
  await clickLocator(searchButton);
};

const clickMahkemeKararlariTab = async (page) => {
  await page.waitForFunction(
    () => {
      const normalize = (value) =>
        String(value || '')
          .toLocaleLowerCase('tr-TR')
          .replace(/ı/g, 'i')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

      const tabs = Array.from(document.querySelectorAll('div#tab-item.tab-item, div.tab-item')).filter(
        (el) => el.offsetParent !== null,
      );
      const target = tabs.find((el) => {
        const text = normalize(el.textContent || '');
        return text.includes('mahkeme') && text.includes('karar');
      });
      if (!target) return false;
      target.click();
      return true;
    },
    { timeout: 20000 },
  );

  await sleep(500);
};

const waitGridReady = async (page) => {
  await waitForAnyGridSignal(page, 20000);
};

const closeExtraPages = async (context, mainPage) => {
  const pages = context.pages();
  for (const p of pages) {
    if (p === mainPage) continue;
    try {
      await p.close();
    } catch (_) {
      // Best effort cleanup.
    }
  }

  try {
    await mainPage.bringToFront();
  } catch (_) {
    // no-op
  }
};

const clickDownloadInDetail = async ({
  context,
  popup,
  downloadsDir,
  downloadType,
  idempotencyStore,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
}) => {
  const meta = await extractDecisionMetaFromPopup(popup).catch(() => ({
    kararNo: '',
    kararTarihi: '',
    url: '',
  }));

  const selector = await waitForVisibleSelector(popup, SELECTORS.downloadButtons, 20000);
  const downloadButton = popup.locator(selector).first();
  await downloadButton.waitFor({ state: 'visible', timeout: 10000 });

  let targetPath = '';
  try {
    if (apiFirstDownload) {
      try {
        const postbackResult = await downloadViaKararPostback({
          context,
          detailUrl: popup.url(),
          downloadsDir,
          meta,
          minDownloadBytes,
          enforcePdfHeader,
        });
        if (idempotencyStore) {
          const decisionKey = buildDecisionIdempotencyKey({
            type: downloadType,
            meta,
            suggestedFileName: postbackResult.fileName,
          });
          idempotencyStore.commit(decisionKey, {
            key: decisionKey,
            type: downloadType,
            kararNo: meta?.kararNo || '',
            kararTarihi: meta?.kararTarihi || '',
            fileName: postbackResult.fileName,
            sha256: postbackResult.sha256,
            sizeBytes: postbackResult.sizeBytes,
            transport: postbackResult.transport || 'karar-postback',
          });
        }
        return {
          status: 'downloaded',
          fileName: postbackResult.fileName,
          sizeBytes: postbackResult.sizeBytes,
          sha256: postbackResult.sha256,
          transport: postbackResult.transport || 'karar-postback',
        };
      } catch (postbackError) {
        if (apiFirstStrict) {
          throw new Error(`Karar postback strict mode failed: ${postbackError?.message || String(postbackError)}`);
        }
        console.warn(
          `Karar postback failed, fallback to inferred-api/ui download -> ${
            postbackError?.message || String(postbackError)
          }`,
        );
      }

      try {
        const selector = await waitForVisibleSelector(popup, SELECTORS.downloadButtons, 20000);
        const downloadButton = popup.locator(selector).first();
        await downloadButton.waitFor({ state: 'visible', timeout: 10000 });

        const apiResult = await downloadViaApiRequest({
          context,
          popup,
          downloadButton,
          downloadsDir,
          meta,
          minDownloadBytes,
          enforcePdfHeader,
        });
        if (idempotencyStore) {
          const decisionKey = buildDecisionIdempotencyKey({
            type: downloadType,
            meta,
            suggestedFileName: apiResult.fileName,
          });
          idempotencyStore.commit(decisionKey, {
            key: decisionKey,
            type: downloadType,
            kararNo: meta?.kararNo || '',
            kararTarihi: meta?.kararTarihi || '',
            fileName: apiResult.fileName,
            sha256: apiResult.sha256,
            sizeBytes: apiResult.sizeBytes,
            transport: apiResult.transport || 'api-first',
          });
        }
        return {
          status: 'downloaded',
          fileName: apiResult.fileName,
          sizeBytes: apiResult.sizeBytes,
          sha256: apiResult.sha256,
          transport: apiResult.transport || 'api-first',
        };
      } catch (apiError) {
        if (apiFirstStrict) {
          throw new Error(`API-first strict mode failed: ${apiError?.message || String(apiError)}`);
        }
        console.warn(`API-first failed, fallback to UI download -> ${apiError?.message || String(apiError)}`);
      }
    }

    const selector = await waitForVisibleSelector(popup, SELECTORS.downloadButtons, 20000);
    const downloadButton = popup.locator(selector).first();
    await downloadButton.waitFor({ state: 'visible', timeout: 10000 });

    const waitDownload = () => context.waitForEvent('download', { timeout: 30000 });
    let download;
    try {
      const pendingDownload = waitDownload();
      await clickLocatorWithFallbacks(downloadButton);
      download = await pendingDownload;
    } catch (firstError) {
      const pendingDownload = waitDownload();
      await clickLocator(downloadButton);
      download = await pendingDownload.catch(() => {
        throw firstError;
      });
    }

    const targetName = sanitizeFileName(download.suggestedFilename() || `ekap-${Date.now()}.pdf`);
    targetPath = ensureUniquePath(downloadsDir, targetName);
    await download.saveAs(targetPath);

    const failure = await download.failure();
    if (failure) {
      throw new Error(`Download failed: ${failure}`);
    }
    await waitForStableFile(targetPath);

    const validation = await validateDownloadedFile({
      targetPath,
      minDownloadBytes,
      enforcePdfHeader,
    });

    if (idempotencyStore) {
      const decisionKey = buildDecisionIdempotencyKey({
        type: downloadType,
        meta,
        suggestedFileName: path.basename(targetPath),
      });
      idempotencyStore.commit(decisionKey, {
        key: decisionKey,
        type: downloadType,
        kararNo: meta?.kararNo || '',
        kararTarihi: meta?.kararTarihi || '',
        fileName: path.basename(targetPath),
        sha256: validation.sha256,
        sizeBytes: validation.sizeBytes,
        transport: 'ui-download',
      });
    }

    return {
      status: 'downloaded',
      fileName: path.basename(targetPath),
      ...validation,
      transport: 'ui-download',
    };
  } catch (error) {
    if (targetPath) {
      await fs.promises.unlink(targetPath).catch(() => {});
    }
    throw error;
  }
};

const processCurrentPageRows = async ({
  context,
  page,
  downloadsDir,
  pageNo,
  retryPolicy,
  startRow,
  idempotencyStore,
  checkpointManager,
  downloadType,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
}) => {
  let rowIndex = Math.max(0, toBoundedInt(startRow, 1, 1) - 1);
  let downloaded = 0;
  let failed = 0;
  let retries = 0;
  let duplicates = 0;

  while (true) {
    const iconCount = await getVisibleDetailIconCount(page);
    if (rowIndex >= iconCount) break;
    const rowNo = rowIndex + 1;

    try {
      const result = await retryWithPolicy({
        label: `page=${pageNo} row=${rowNo}`,
        maxAttempts: retryPolicy.maxAttempts,
        baseDelayMs: retryPolicy.baseDelayMs,
        maxDelayMs: retryPolicy.maxDelayMs,
        jitterRatio: retryPolicy.jitterRatio,
        shouldRetry: (error) => isRetryableBrowserError(error),
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          retries += 1;
          checkpointManager?.markRetry(1);
          console.warn(
            `Page ${pageNo}, row ${rowNo}: retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms -> ${error.message}`,
          );
        },
        task: async () => {
          let popup = null;
          let inlineDetail = false;
          try {
            popup = await openDetailPopupOrPage({
              context,
              page,
              rowIndex,
              attempts: 3,
              perAttemptTimeoutMs: 7000,
            });
            inlineDetail = popup === page;
            if (!inlineDetail) {
              await popup.waitForLoadState('domcontentloaded', { timeout: 20000 });
            }
            const output = await clickDownloadInDetail({
              context,
              popup,
              downloadsDir,
              downloadType,
              idempotencyStore,
              minDownloadBytes,
              enforcePdfHeader,
              apiFirstDownload,
              apiFirstStrict,
            });
            if (!inlineDetail) {
              await popup.close().catch(() => {});
            } else {
              await page.keyboard.press('Escape').catch(() => {});
            }
            return output;
          } catch (error) {
            if (popup && popup !== page) {
              await popup.close().catch(() => {});
            }
            if (inlineDetail) {
              await page.keyboard.press('Escape').catch(() => {});
            }
            await closeExtraPages(context, page);
            throw error;
          }
        },
      });

      downloaded += 1;
      checkpointManager?.markProcessed({
        pageNo,
        rowNo,
        success: true,
        duplicate: false,
      });
      console.log(
        `Page ${pageNo}, row ${rowNo}: downloaded. file=${result?.fileName || '-'} transport=${
          result?.transport || 'unknown'
        } size=${
          result?.sizeBytes || 0
        } sha256=${result?.sha256 || '-'}`,
      );
    } catch (err) {
      console.error(`Page ${pageNo}, row ${rowNo}: failed -> ${err.message}`);
      await closeExtraPages(context, page);
      failed += 1;
      checkpointManager?.markProcessed({
        pageNo,
        rowNo,
        success: false,
        duplicate: false,
      });
    }

    rowIndex += 1;
    await sleep(400);
  }

  return { downloaded, failed, retries, duplicates };
};

const moveToNextPage = async (page, currentPage) => {
  const target = String(currentPage + 1);

  const moved = await page.evaluate(
    ({ nextPageText, pageSelectors }) => {
      const pages = [];
      const seen = new Set();
      for (const selector of pageSelectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (el && el.offsetParent !== null && !seen.has(el)) {
            seen.add(el);
            pages.push(el);
          }
        }
      }
      const nextButton = pages.find((el) => (el.textContent || '').trim() === nextPageText);
      if (!nextButton) return false;
      nextButton.click();
      return true;
    },
    {
      nextPageText: target,
      pageSelectors: SELECTORS.pagination,
    },
  );

  if (!moved) {
    return false;
  }

  await page
    .waitForFunction(
      ({ selectedPageText, selectedPageSelectors }) => {
        for (const selector of selectedPageSelectors) {
          const selected = Array.from(document.querySelectorAll(selector)).find(
            (el) => el.offsetParent !== null,
          );
          if (selected) {
            return (selected.textContent || '').trim() === selectedPageText;
          }
        }
        return false;
      },
      {
        selectedPageText: target,
        selectedPageSelectors: SELECTORS.selectedPage,
      },
      { timeout: 10000 },
    )
    .catch(async () => {
      await sleep(1200);
    });

  await sleep(600);
  return true;
};

const launchBrowserContext = async (userDataDir, isHeadless) =>
  chromium.launchPersistentContext(userDataDir, {
    headless: isHeadless,
    acceptDownloads: true,
    args: [
      '--disable-features=InsecureDownloadWarnings,InsecureDownloadBlocking',
      '--safebrowsing-disable-download-protection',
      '--allow-running-insecure-content',
    ],
  });

const setupSearchPage = async ({ context, cfg, fromDate, toDate, dateInputIndex, retryPolicy }) => {
  const page = context.pages()[0] || (await context.newPage());

  await retryWithPolicy({
    label: 'setup-search-page',
    maxAttempts: Math.max(2, toBoundedInt(retryPolicy?.maxAttempts, 2, 1)),
    baseDelayMs: toBoundedInt(retryPolicy?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS, 50),
    maxDelayMs: toBoundedInt(retryPolicy?.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, 100),
    jitterRatio: Number.isFinite(retryPolicy?.jitterRatio) ? retryPolicy.jitterRatio : DEFAULT_RETRY_JITTER_RATIO,
    shouldRetry: (error) => isRetryableBrowserError(error),
    onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      console.warn(`[RETRY] setup-search-page ${attempt}/${maxAttempts - 1} in ${delayMs}ms -> ${error.message}`);
    },
    task: async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      if (cfg.useMahkemeTab) {
        await clickMahkemeKararlariTab(page);
      }

      await openDateRangePicker(page, dateInputIndex);
      await selectDateCell(page, fromDate);
      await selectDateCell(page, toDate);
      await page.keyboard.press('Escape').catch(() => {});

      await clickSearch(page);
      await waitGridReady(page);
    },
  });

  return page;
};

const advanceToPage = async (page, fromPage, targetPage, retryPolicy) => {
  let currentPage = fromPage;
  while (currentPage < targetPage) {
    const moved = await retryWithPolicy({
      label: `advance-to-page-${currentPage + 1}`,
      maxAttempts: Math.max(2, toBoundedInt(retryPolicy?.maxAttempts, 2, 1)),
      baseDelayMs: toBoundedInt(retryPolicy?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS, 50),
      maxDelayMs: toBoundedInt(retryPolicy?.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, 100),
      jitterRatio: Number.isFinite(retryPolicy?.jitterRatio) ? retryPolicy.jitterRatio : DEFAULT_RETRY_JITTER_RATIO,
      shouldRetry: (error) => isRetryableBrowserError(error),
      onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
        console.warn(`[RETRY] advance page ${attempt}/${maxAttempts - 1} in ${delayMs}ms -> ${error.message}`);
      },
      task: async () => moveToNextPage(page, currentPage),
    });
    if (!moved) {
      return {
        reached: false,
        currentPage,
      };
    }
    currentPage += 1;
    await waitGridReady(page);
  }

  return {
    reached: true,
    currentPage,
  };
};

const processPagesFromCurrent = async ({
  context,
  page,
  downloadsDir,
  retryPolicy,
  currentPage,
  allPages,
  endPage,
  workerId,
  startRow = 1,
  idempotencyStore,
  checkpointManager,
  downloadType,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
}) => {
  const workerSuffix = workerId ? ` [worker ${workerId}]` : '';
  let pageCursor = currentPage;
  let nextStartRow = Math.max(1, toBoundedInt(startRow, 1, 1));
  let downloaded = 0;
  let failed = 0;
  let retries = 0;
  let duplicates = 0;
  let pageErrors = 0;
  let noMorePages = false;
  let reachedEndPage = false;

  while (allPages || pageCursor <= endPage) {
    console.log(`Processing page ${pageCursor}${workerSuffix}`);
    try {
      const pageStats = await processCurrentPageRows({
        context,
        page,
        downloadsDir,
        pageNo: pageCursor,
        retryPolicy,
        startRow: nextStartRow,
        idempotencyStore,
        checkpointManager,
        downloadType,
        minDownloadBytes,
        enforcePdfHeader,
        apiFirstDownload,
        apiFirstStrict,
      });
      downloaded += pageStats.downloaded;
      failed += pageStats.failed;
      retries += pageStats.retries;
      duplicates += pageStats.duplicates;
    } catch (error) {
      pageErrors += 1;
      console.error(`Page ${pageCursor}: worker failed -> ${error.message}`);
      await closeExtraPages(context, page);
    }

    nextStartRow = 1;

    if (!allPages && pageCursor >= endPage) {
      reachedEndPage = true;
      break;
    }

    const moved = await moveToNextPage(page, pageCursor);
    if (!moved) {
      noMorePages = true;
      break;
    }

    await waitGridReady(page);
    pageCursor += 1;
  }

  return {
    downloaded,
    failed,
    retries,
    duplicates,
    pageErrors,
    currentPage: pageCursor,
    noMorePages,
    reachedEndPage,
  };
};

const buildPageJobs = (startPage, endPage, chunkSize) => {
  const jobs = [];
  let cursor = startPage;
  let seq = 1;

  while (cursor <= endPage) {
    const chunkEnd = Math.min(endPage, cursor + chunkSize - 1);
    jobs.push({
      id: seq,
      startPage: cursor,
      endPage: chunkEnd,
    });
    seq += 1;
    cursor = chunkEnd + 1;
  }

  return jobs;
};

const createPageJobQueue = (jobs) => {
  let cursor = 0;
  let noMorePagesAt = null;

  return {
    getNextJob() {
      if (cursor >= jobs.length) {
        return null;
      }

      const next = jobs[cursor];
      if (noMorePagesAt !== null && next.startPage > noMorePagesAt) {
        return null;
      }

      cursor += 1;
      return next;
    },
    markNoMorePages(pageNo) {
      const safe = toBoundedInt(pageNo, 0, 0);
      if (safe <= 0) {
        return;
      }
      if (noMorePagesAt === null || safe < noMorePagesAt) {
        noMorePagesAt = safe;
      }
    },
    getNoMorePagesAt() {
      return noMorePagesAt;
    },
    remainingJobs() {
      if (cursor >= jobs.length) {
        return 0;
      }

      if (noMorePagesAt === null) {
        return jobs.length - cursor;
      }

      let count = 0;
      for (let i = cursor; i < jobs.length; i += 1) {
        if (jobs[i].startPage > noMorePagesAt) {
          break;
        }
        count += 1;
      }
      return count;
    },
  };
};

const createAdaptiveConcurrencyController = ({
  enabled,
  initialLimit,
  minLimit,
  maxLimit,
  queue,
  windowSize = 6,
  cooldownJobs = 2,
}) => {
  const isEnabled = Boolean(enabled);
  let currentLimit = Math.max(minLimit, Math.min(maxLimit, initialLimit));
  let activeSlots = 0;
  const waiters = [];
  const recent = [];
  let cooldown = 0;

  const grantSlots = () => {
    while (waiters.length > 0 && activeSlots < currentLimit) {
      const next = waiters.shift();
      activeSlots += 1;
      next();
    }
  };

  const setLimit = (nextLimit, reason) => {
    const safeNext = Math.max(minLimit, Math.min(maxLimit, nextLimit));
    if (safeNext === currentLimit) {
      return;
    }

    const prev = currentLimit;
    currentLimit = safeNext;
    cooldown = cooldownJobs;
    console.log(`[POOL] adaptive concurrency ${prev} -> ${currentLimit} (${reason})`);

    grantSlots();
  };

  return {
    enabled: isEnabled,
    async acquireSlot() {
      if (!isEnabled) {
        return;
      }
      if (activeSlots < currentLimit) {
        activeSlots += 1;
        return;
      }
      await new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    releaseSlot() {
      if (!isEnabled) {
        return;
      }
      if (activeSlots > 0) {
        activeSlots -= 1;
      }
      grantSlots();
    },
    recordJobResult(stats) {
      if (!isEnabled) {
        return;
      }

      const payload = stats && typeof stats === 'object' ? stats : {};
      const downloaded = toBoundedInt(payload.downloaded, 0, 0);
      const failed = toBoundedInt(payload.failed, 0, 0);
      const retries = toBoundedInt(payload.retries, 0, 0);
      const pageErrors = toBoundedInt(payload.pageErrors, 0, 0);
      const workerFatalErrors = toBoundedInt(payload.workerFatalErrors, 0, 0);
      const attempts = downloaded + failed;

      recent.push({
        attempts,
        failed,
        retries,
      });
      if (recent.length > windowSize) {
        recent.shift();
      }

      if (workerFatalErrors > 0) {
        setLimit(currentLimit - 1, 'worker fatal');
        return;
      }

      if (pageErrors > 0) {
        setLimit(currentLimit - 1, 'page error');
        return;
      }

      if (cooldown > 0) {
        cooldown -= 1;
        return;
      }

      const totals = recent.reduce(
        (acc, item) => {
          acc.attempts += item.attempts;
          acc.failed += item.failed;
          acc.retries += item.retries;
          return acc;
        },
        { attempts: 0, failed: 0, retries: 0 },
      );
      if (totals.attempts < 10) {
        return;
      }

      const failureRate = totals.failed / totals.attempts;
      const retryRate = totals.retries / totals.attempts;

      if ((failureRate >= 0.35 || retryRate >= 0.2) && currentLimit > minLimit) {
        setLimit(currentLimit - 1, `high-error f=${failureRate.toFixed(2)} r=${retryRate.toFixed(2)}`);
        return;
      }

      if (
        failureRate <= 0.08 &&
        retryRate <= 0.05 &&
        currentLimit < maxLimit &&
        queue.remainingJobs() > 0
      ) {
        setLimit(currentLimit + 1, `stable f=${failureRate.toFixed(2)} r=${retryRate.toFixed(2)}`);
      }
    },
  };
};

const runSingleWorker = async ({
  cfg,
  fromDate,
  toDate,
  dateInputIndex,
  startPage,
  startRow,
  endPage,
  allPages,
  retryPolicy,
  isHeadless,
  downloadsDir,
  idempotencyStore,
  checkpointManager,
  downloadType,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
  contextResetAfterPages,
}) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekapv2-chrome-'));
  let context;
  let page;
  let currentPage = 1;
  let nextStartRow = Math.max(1, toBoundedInt(startRow, 1, 1));
  let pagesSinceReset = 0;

  const totals = {
    downloaded: 0,
    failed: 0,
    retries: 0,
    duplicates: 0,
    pageErrors: 0,
    workerFatalErrors: 0,
  };

  const resetSession = async () => {
    if (context) {
      await context.close().catch(() => {});
      context = null;
      page = null;
    }
    context = await launchBrowserContext(userDataDir, isHeadless);
    page = await setupSearchPage({ context, cfg, fromDate, toDate, dateInputIndex, retryPolicy });
    currentPage = 1;
  };

  try {
    await resetSession();

    const firstAdvance = await advanceToPage(page, currentPage, startPage, retryPolicy);
    currentPage = firstAdvance.currentPage;
    if (!firstAdvance.reached) {
      throw new Error(`Could not reach startPage=${startPage}. Last available page: ${currentPage}`);
    }

    while (true) {
      const chunkEndPage = allPages
        ? currentPage + Math.max(1, contextResetAfterPages) - 1
        : Math.min(endPage, currentPage + Math.max(1, contextResetAfterPages) - 1);

      const stats = await processPagesFromCurrent({
        context,
        page,
        downloadsDir,
        retryPolicy,
        currentPage,
        allPages: false,
        endPage: chunkEndPage,
        workerId: null,
        startRow: nextStartRow,
        idempotencyStore,
        checkpointManager,
        downloadType,
        minDownloadBytes,
        enforcePdfHeader,
        apiFirstDownload,
        apiFirstStrict,
      });

      totals.downloaded += stats.downloaded;
      totals.failed += stats.failed;
      totals.retries += stats.retries;
      totals.duplicates += stats.duplicates;
      totals.pageErrors += stats.pageErrors;
      pagesSinceReset += Math.max(0, stats.currentPage - currentPage + 1);
      currentPage = stats.currentPage;
      nextStartRow = 1;

      if (stats.noMorePages) {
        console.log('No more pages. Finished.');
        break;
      }

      if (!allPages && stats.reachedEndPage && currentPage >= endPage) {
        console.log('Reached endPage. Finished.');
        break;
      }

      const moved = await moveToNextPage(page, currentPage);
      if (!moved) {
        console.log('No more pages. Finished.');
        break;
      }
      await waitGridReady(page);
      currentPage += 1;

      if (pagesSinceReset >= contextResetAfterPages) {
        console.log(`[POOL] single-worker periodic context reset after ${pagesSinceReset} pages.`);
        pagesSinceReset = 0;
        const targetPage = currentPage;
        await resetSession();
        const advance = await advanceToPage(page, currentPage, targetPage, retryPolicy);
        if (!advance.reached) {
          throw new Error(`Could not restore page ${targetPage} after context reset.`);
        }
        currentPage = advance.currentPage;
      }
    }

    return totals;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
};

const runQueueWorker = async ({
  workerId,
  queue,
  concurrencyController,
  cfg,
  fromDate,
  toDate,
  dateInputIndex,
  retryPolicy,
  isHeadless,
  downloadsDir,
  idempotencyStore,
  checkpointManager,
  downloadType,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
  contextResetAfterJobs,
}) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `ekapv2-chrome-w${workerId}-`));
  let context;
  let page;
  let currentPage = 1;
  let jobsSinceReset = 0;

  const totals = {
    downloaded: 0,
    failed: 0,
    retries: 0,
    duplicates: 0,
    pageErrors: 0,
    workerFatalErrors: 0,
  };

  const resetSession = async () => {
    if (context) {
      await context.close().catch(() => {});
      context = null;
      page = null;
    }

    context = await launchBrowserContext(userDataDir, isHeadless);
    page = await setupSearchPage({ context, cfg, fromDate, toDate, dateInputIndex, retryPolicy });
    currentPage = 1;
  };

  try {
    await resetSession();

    while (true) {
      await concurrencyController.acquireSlot();
      let jobStats = null;
      let shouldBreak = false;

      try {
        const job = queue.getNextJob();
        if (!job) {
          shouldBreak = true;
          continue;
        }

        const noMorePagesAt = queue.getNoMorePagesAt();
        if (noMorePagesAt !== null && job.startPage > noMorePagesAt) {
          shouldBreak = true;
          continue;
        }

        if (currentPage > job.startPage) {
          console.warn(
            `[POOL] worker=${workerId} restart required to reach page ${job.startPage} from page ${currentPage}.`,
          );
          await resetSession();
        }

        const advanceResult = await advanceToPage(page, currentPage, job.startPage, retryPolicy);
        currentPage = advanceResult.currentPage;

        if (!advanceResult.reached) {
          queue.markNoMorePages(currentPage);
          console.log(`[POOL] worker=${workerId} no more pages at ${currentPage}.`);
          shouldBreak = true;
          continue;
        }

        console.log(`[POOL] worker=${workerId} job=${job.id} range=${job.startPage}-${job.endPage}`);
        const stats = await processPagesFromCurrent({
          context,
          page,
          downloadsDir,
          retryPolicy,
          currentPage,
          allPages: false,
          endPage: job.endPage,
          workerId,
          startRow: 1,
          idempotencyStore,
          checkpointManager,
          downloadType,
          minDownloadBytes,
          enforcePdfHeader,
          apiFirstDownload,
          apiFirstStrict,
        });

        jobStats = stats;
        totals.downloaded += stats.downloaded;
        totals.failed += stats.failed;
        totals.retries += stats.retries;
        totals.duplicates += stats.duplicates;
        totals.pageErrors += stats.pageErrors;
        currentPage = stats.currentPage;
        jobsSinceReset += 1;

        if (stats.noMorePages) {
          queue.markNoMorePages(currentPage);
          console.log(`[POOL] worker=${workerId} no more pages at ${currentPage}.`);
          shouldBreak = true;
        }

        if (!shouldBreak && jobsSinceReset >= contextResetAfterJobs && queue.remainingJobs() > 0) {
          console.log(`[POOL] worker=${workerId} periodic context reset after ${jobsSinceReset} jobs.`);
          jobsSinceReset = 0;
          await resetSession();
        }
      } finally {
        if (jobStats) {
          concurrencyController.recordJobResult({
            downloaded: jobStats.downloaded || 0,
            failed: jobStats.failed || 0,
            retries: jobStats.retries || 0,
            pageErrors: jobStats.pageErrors || 0,
            workerFatalErrors: 0,
          });
        }
        concurrencyController.releaseSlot();
      }

      if (shouldBreak) {
        break;
      }
    }
  } catch (error) {
    totals.workerFatalErrors = 1;
    console.error(`[POOL] worker=${workerId} fatal -> ${error.message}`);
    concurrencyController.recordJobResult({
      downloaded: 0,
      failed: 0,
      retries: 0,
      pageErrors: 0,
      workerFatalErrors: 1,
    });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return totals;
};

const runWorkerPool = async ({
  workerCount,
  chunkSize,
  adaptiveConcurrencyEnabled,
  contextResetAfterJobs,
  startPage,
  endPage,
  cfg,
  fromDate,
  toDate,
  dateInputIndex,
  retryPolicy,
  isHeadless,
  downloadsDir,
  idempotencyStore,
  checkpointManager,
  downloadType,
  minDownloadBytes,
  enforcePdfHeader,
  apiFirstDownload,
  apiFirstStrict,
}) => {
  const jobs = buildPageJobs(startPage, endPage, chunkSize);
  const queue = createPageJobQueue(jobs);
  const concurrencyController = createAdaptiveConcurrencyController({
    enabled: adaptiveConcurrencyEnabled,
    initialLimit: workerCount,
    minLimit: 1,
    maxLimit: workerCount,
    queue,
  });

  console.log(
    `[POOL] enabled workers=${workerCount} chunkSize=${chunkSize} jobs=${jobs.length} adaptive=${
      concurrencyController.enabled ? 'on' : 'off'
    }`,
  );

  const workers = Array.from({ length: workerCount }, (_, index) =>
    runQueueWorker({
      workerId: index + 1,
      queue,
      concurrencyController,
      cfg,
      fromDate,
      toDate,
      dateInputIndex,
      retryPolicy,
      isHeadless,
      downloadsDir,
      idempotencyStore,
      checkpointManager,
      downloadType,
      minDownloadBytes,
      enforcePdfHeader,
      apiFirstDownload,
      apiFirstStrict,
      contextResetAfterJobs,
    }),
  );

  const results = await Promise.all(workers);
  const summary = results.reduce(
    (acc, item) => {
      acc.downloaded += item.downloaded;
      acc.failed += item.failed;
      acc.retries += item.retries;
      acc.duplicates += item.duplicates;
      acc.pageErrors += item.pageErrors;
      acc.workerFatalErrors += item.workerFatalErrors;
      return acc;
    },
    {
      downloaded: 0,
      failed: 0,
      retries: 0,
      duplicates: 0,
      pageErrors: 0,
      workerFatalErrors: 0,
    },
  );

  if (summary.workerFatalErrors >= workerCount) {
    throw new Error('All queue workers failed.');
  }

  const noMorePagesAt = queue.getNoMorePagesAt();
  if (noMorePagesAt !== null && noMorePagesAt < endPage) {
    console.log(`[POOL] no more pages after ${noMorePagesAt}.`);
  }

  return summary;
};

async function runEkapDownloader(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const prefix = `--${name}=`;
    const hit = args.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : fallback;
  };

  const fromDate = toCalendarValue(getArg('from', process.env.FROM_DATE || DEFAULT_FROM));
  const toDate = toCalendarValue(getArg('to', process.env.TO_DATE || DEFAULT_TO));
  const maxPagesRaw = Number(getArg('maxPages', process.env.MAX_PAGES || '500'));
  const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.floor(maxPagesRaw) : 500;
  const startPageRaw = Number(getArg('startPage', process.env.START_PAGE || '1'));
  const startPage = Number.isFinite(startPageRaw) && startPageRaw >= 1 ? Math.floor(startPageRaw) : 1;
  const startRowRaw = Number(getArg('startRow', process.env.START_ROW || '1'));
  const startRow = Number.isFinite(startRowRaw) && startRowRaw >= 1 ? Math.floor(startRowRaw) : 1;

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
  const timeoutRetries = Number.isFinite(timeoutRetriesRaw) && timeoutRetriesRaw >= 0 ? Math.floor(timeoutRetriesRaw) : 2;
  const retryMaxAttempts = Math.max(1, timeoutRetries + 1);
  const retryPolicy = {
    maxAttempts: retryMaxAttempts,
    baseDelayMs: toBoundedInt(
      getArg('retryBaseDelayMs', process.env.RETRY_BASE_DELAY_MS || String(DEFAULT_RETRY_BASE_DELAY_MS)),
      DEFAULT_RETRY_BASE_DELAY_MS,
      50,
      120000,
    ),
    maxDelayMs: toBoundedInt(
      getArg('retryMaxDelayMs', process.env.RETRY_MAX_DELAY_MS || String(DEFAULT_RETRY_MAX_DELAY_MS)),
      DEFAULT_RETRY_MAX_DELAY_MS,
      100,
      240000,
    ),
    jitterRatio: Number.parseFloat(
      String(getArg('retryJitterRatio', process.env.RETRY_JITTER_RATIO || String(DEFAULT_RETRY_JITTER_RATIO))),
    ),
  };
  if (!Number.isFinite(retryPolicy.jitterRatio) || retryPolicy.jitterRatio < 0) {
    retryPolicy.jitterRatio = DEFAULT_RETRY_JITTER_RATIO;
  }
  retryPolicy.jitterRatio = Math.min(1, retryPolicy.jitterRatio);

  const browserMode = (getArg('browserMode', process.env.BROWSER_MODE || '') || '').toLowerCase();
  const legacyHeadlessArg = (getArg('headless', process.env.HEADLESS || '') || '').toLowerCase();
  if (browserMode && browserMode !== 'headless' && browserMode !== 'visible') {
    throw new Error(`Invalid browserMode: ${browserMode}. Use "headless" or "visible".`);
  }
  const isHeadless = browserMode ? browserMode === 'headless' : legacyHeadlessArg === 'true';

  const workerCount = toBoundedInt(getArg('workerCount', process.env.WORKER_COUNT || '1'), 1, 1, 16);
  const chunkSize = toBoundedInt(getArg('jobChunkSize', process.env.JOB_CHUNK_SIZE || '1'), 1, 1, 100);
  const contextResetAfterJobs = toBoundedInt(
    getArg('contextResetAfterJobs', process.env.CONTEXT_RESET_AFTER_JOBS || '12'),
    12,
    1,
    200,
  );
  const contextResetAfterPages = toBoundedInt(
    getArg('contextResetAfterPages', process.env.CONTEXT_RESET_AFTER_PAGES || '20'),
    20,
    1,
    1000,
  );
  const adaptiveConcurrency = toBoolArg(
    getArg('adaptiveConcurrency', process.env.ADAPTIVE_CONCURRENCY || 'true'),
    true,
  );
  const minDownloadBytes = toBoundedInt(
    getArg('minDownloadBytes', process.env.MIN_DOWNLOAD_BYTES || String(DEFAULT_MIN_DOWNLOAD_BYTES)),
    DEFAULT_MIN_DOWNLOAD_BYTES,
    128,
    50 * 1024 * 1024,
  );
  const enforcePdfHeader = toBoolArg(getArg('enforcePdfHeader', process.env.ENFORCE_PDF_HEADER || 'true'), true);
  const apiFirstDownload = toBoolArg(getArg('apiFirstDownload', process.env.API_FIRST_DOWNLOAD || 'true'), true);
  const apiFirstStrict = toBoolArg(getArg('apiFirstStrict', process.env.API_FIRST_STRICT || 'false'), false);
  const checkpointPath = String(getArg('checkpointPath', process.env.CHECKPOINT_PATH || '')).trim();
  const checkpointEnabled = toBoolArg(getArg('checkpoint', process.env.CHECKPOINT_ENABLED || 'true'), true);
  const resetCheckpoint = toBoolArg(getArg('resetCheckpoint', process.env.RESET_CHECKPOINT || 'false'), false);

  const type = String(cfg.downloadType || '').trim();
  if (!type) {
    throw new Error('downloadType is required.');
  }

  const downloadsDir = path.join(process.cwd(), 'indirilenler', type);
  await ensureDirWriteAccess(downloadsDir);

  const idempotencyStore = null;

  if (resetCheckpoint && checkpointPath) {
    await fs.promises.unlink(checkpointPath).catch(() => {});
  }
  const checkpointManager = createCheckpointManager({
    checkpointPath,
    enabled: checkpointEnabled,
    runMeta: {
      type,
      fromDate,
      toDate,
    },
  });

  const effectiveWorkerCount = allPages || startRow > 1 ? 1 : workerCount;

  console.log(`Going to ${BASE_URL}`);
  console.log(`Date range: ${fromDate} -> ${toDate}`);
  console.log(
    `Page range: ${allPages ? `${startPage} -> TUMU` : `${startPage} -> ${endPage}`} (startRow=${startRow})`,
  );
  console.log(`Browser mode: ${isHeadless ? 'headless' : 'visible'}`);
  console.log(`Retry policy: attempts=${retryPolicy.maxAttempts} base=${retryPolicy.baseDelayMs}ms max=${retryPolicy.maxDelayMs}ms jitter=${retryPolicy.jitterRatio}`);
  console.log(`Worker count: ${effectiveWorkerCount}`);
  console.log(`Job chunk size: ${chunkSize}`);
  console.log(`Context reset: jobs=${contextResetAfterJobs} pages=${contextResetAfterPages}`);
  console.log(`Adaptive concurrency: ${adaptiveConcurrency && effectiveWorkerCount > 1 ? 'on' : 'off'}`);
  console.log(`Download validation: minBytes=${minDownloadBytes} pdfHeader=${enforcePdfHeader ? 'on' : 'off'}`);
  console.log(`API-first download: enabled=${apiFirstDownload ? 'on' : 'off'} strict=${apiFirstStrict ? 'on' : 'off'}`);
  console.log('Duplicate control: off (all rows will be downloaded)');
  if (checkpointManager.enabled) {
    console.log(`Checkpoint: ${checkpointManager.path}`);
    const last = checkpointManager.getLastSuccess();
    if (last) {
      console.log(`[CHECKPOINT] loaded lastSuccess page=${last.page} row=${last.row}`);
    }
  } else {
    console.log('Checkpoint: disabled');
  }
  if (allPages && workerCount > 1) {
    console.warn('[POOL] allPages=true oldugu icin worker havuzu kapatildi (single worker).');
  }
  if (startRow > 1 && workerCount > 1) {
    console.warn('[POOL] startRow>1 oldugu icin worker havuzu kapatildi (single worker).');
  }

  let summary = null;
  let runError = null;
  try {
    summary =
      effectiveWorkerCount > 1
        ? await runWorkerPool({
            workerCount: effectiveWorkerCount,
            chunkSize,
            adaptiveConcurrencyEnabled: adaptiveConcurrency,
            contextResetAfterJobs,
            startPage,
            endPage,
            cfg,
            fromDate,
            toDate,
            dateInputIndex,
            retryPolicy,
            isHeadless,
            downloadsDir,
            idempotencyStore,
            checkpointManager,
            downloadType: type,
            minDownloadBytes,
            enforcePdfHeader,
            apiFirstDownload,
            apiFirstStrict,
          })
        : await runSingleWorker({
            cfg,
            fromDate,
            toDate,
            dateInputIndex,
            startPage,
            startRow,
            endPage,
            allPages,
            retryPolicy,
            isHeadless,
            downloadsDir,
            idempotencyStore,
            checkpointManager,
            downloadType: type,
            minDownloadBytes,
            enforcePdfHeader,
            apiFirstDownload,
            apiFirstStrict,
            contextResetAfterPages,
          });
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    await checkpointManager.finish(
      summary || {
        status: 'failed',
        error: runError?.message || null,
      },
    );
  }

  if (!summary) {
    return;
  }

  console.log(
    `[SUMMARY] downloaded=${summary.downloaded} failed=${summary.failed} duplicates=${summary.duplicates || 0} retries=${summary.retries} pageErrors=${summary.pageErrors} workerFatal=${summary.workerFatalErrors}`,
  );
}

module.exports = {
  runEkapDownloader,
};
