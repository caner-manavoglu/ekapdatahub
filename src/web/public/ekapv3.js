const DELETE_CONFIRMATION_TEXT = "onaylıyorum";
const PAGE_LIMIT = 10;

const state = {
  running: false,
  stopRequested: false,
  currentRun: null,
  lastRun: null,
  opsDashboard: null,
  logs: [],
  history: [],
  files: [],
  selectedFileKeys: new Set(),
  pendingDeleteAction: null,
  confirmBusy: false,
  lastFocusedElement: null,
  logPage: 1,
  logLimit: PAGE_LIMIT,
  historyPage: 1,
  historyLimit: PAGE_LIMIT,
  historyTotal: 0,
  historyTotalPages: 1,
  filesPage: 1,
  filesLimit: PAGE_LIMIT,
  filesTotal: 0,
  filesTotalPages: 1,
};
let statusPollInFlight = false;
let filesPollInFlight = false;
let historyPollInFlight = false;
let statusPollFailureCount = 0;
let filesPollFailureCount = 0;
let historyPollFailureCount = 0;
let opsPollInFlight = false;
let opsPollFailureCount = 0;

const el = {
  status: document.getElementById("v3Status"),
  runMeta: document.getElementById("v3RunMeta"),
  opsMeta: document.getElementById("v3OpsMeta"),
  opsKpis: document.getElementById("v3OpsKpis"),
  opsAlertsMeta: document.getElementById("v3OpsAlertsMeta"),
  opsAlertsList: document.getElementById("v3OpsAlertsList"),
  form: document.getElementById("v3Form"),
  openDownloadsButton: document.getElementById("v3OpenDownloadsButton"),
  jobType: document.getElementById("jobType"),
  fromDate: document.getElementById("fromDate"),
  toDate: document.getElementById("toDate"),
  startPage: document.getElementById("startPage"),
  endPage: document.getElementById("endPage"),
  allPages: document.getElementById("allPages"),
  browserMode: document.getElementById("browserMode"),
  workerCount: document.getElementById("workerCount"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  logMeta: document.getElementById("v3LogMeta"),
  clearLogsButton: document.getElementById("v3ClearLogsButton"),
  liveLog: document.getElementById("v3LiveLog"),
  logFirstButton: document.getElementById("v3LogFirstButton"),
  logPrevButton: document.getElementById("v3LogPrevButton"),
  logPageInfo: document.getElementById("v3LogPageInfo"),
  logNextButton: document.getElementById("v3LogNextButton"),
  logLastButton: document.getElementById("v3LogLastButton"),
  logJumpInput: document.getElementById("v3LogJumpInput"),
  logJumpButton: document.getElementById("v3LogJumpButton"),
  historyMeta: document.getElementById("v3HistoryMeta"),
  clearHistoryButton: document.getElementById("v3ClearHistoryButton"),
  historyBody: document.getElementById("v3HistoryBody"),
  historyFirstButton: document.getElementById("v3HistoryFirstButton"),
  historyPrevButton: document.getElementById("v3HistoryPrevButton"),
  historyPageInfo: document.getElementById("v3HistoryPageInfo"),
  historyNextButton: document.getElementById("v3HistoryNextButton"),
  historyLastButton: document.getElementById("v3HistoryLastButton"),
  historyJumpInput: document.getElementById("v3HistoryJumpInput"),
  historyJumpButton: document.getElementById("v3HistoryJumpButton"),
  filesMeta: document.getElementById("v3FilesMeta"),
  filesBody: document.getElementById("v3FilesBody"),
  filesFirstButton: document.getElementById("v3FilesFirstButton"),
  filesPrevButton: document.getElementById("v3FilesPrevButton"),
  filesPageInfo: document.getElementById("v3FilesPageInfo"),
  filesNextButton: document.getElementById("v3FilesNextButton"),
  filesLastButton: document.getElementById("v3FilesLastButton"),
  filesJumpInput: document.getElementById("v3FilesJumpInput"),
  filesJumpButton: document.getElementById("v3FilesJumpButton"),
  filesTypeFilter: document.getElementById("v3FilesTypeFilter"),
  filesRefreshButton: document.getElementById("v3FilesRefreshButton"),
  selectAllFilesCheckbox: document.getElementById("v3SelectAllFilesCheckbox"),
  deleteSelectedButton: document.getElementById("v3DeleteSelectedButton"),
  deleteByTypeButton: document.getElementById("v3DeleteByTypeButton"),
  deleteAllButton: document.getElementById("v3DeleteAllButton"),
  confirmOverlay: document.getElementById("v3ConfirmOverlay"),
  confirmTitle: document.getElementById("v3ConfirmTitle"),
  confirmMessage: document.getElementById("v3ConfirmMessage"),
  cancelConfirmButton: document.getElementById("v3CancelConfirmButton"),
  approveConfirmButton: document.getElementById("v3ApproveConfirmButton"),
};

function withAuthHeaders(headers = {}) {
  if (window.EkapAuth?.withCsrfHeaders) {
    return window.EkapAuth.withCsrfHeaders(headers);
  }
  return {
    ...headers,
  };
}

function handleUnauthorizedResponse(response) {
  if (response?.status === 401 && window.EkapAuth?.redirectToLogin) {
    window.EkapAuth.redirectToLogin();
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseHtmlDateInput(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const utcMs = Date.UTC(year, month - 1, day);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    normalized,
  };
}

function clampPage(value, totalPages) {
  const page = parsePositiveInt(value, 1);
  const safeTotal = Math.max(1, parsePositiveInt(totalPages, 1));
  return Math.min(page, safeTotal);
}

function syncDateInputBounds() {
  const fromParsed = parseHtmlDateInput(el.fromDate?.value);
  const toParsed = parseHtmlDateInput(el.toDate?.value);

  if (el.toDate) {
    if (fromParsed) {
      el.toDate.min = fromParsed.normalized;
    } else {
      el.toDate.removeAttribute("min");
    }
  }

  if (el.fromDate) {
    if (toParsed) {
      el.fromDate.max = toParsed.normalized;
    } else {
      el.fromDate.removeAttribute("max");
    }
  }
}

function formatPageRange(runLike) {
  const allPages = Boolean(runLike?.allPages);
  if (allPages) {
    return "Tümü";
  }
  const startPage = runLike?.startPage ?? "-";
  const endPage = runLike?.endPage ?? "-";
  const startRow = Number(runLike?.startRow || runLike?.selectedPages?.startRow || 1);
  if (startRow > 1) {
    return `${startPage}-${endPage} (satır:${startRow}+)`;
  }
  return `${startPage}-${endPage}`;
}

function extractDownloadedPdfName(message) {
  const text = String(message || "").trim();
  if (!/:\s+downloaded\./i.test(text)) {
    return "";
  }
  const fileMatch = text.match(/\bfile=([^\s]+)/i);
  if (fileMatch && fileMatch[1] && fileMatch[1] !== "-") {
    return fileMatch[1];
  }
  return "";
}

function getDownloadLogEntries() {
  const rows = Array.isArray(state.logs) ? state.logs : [];
  return rows
    .map((entry) => {
      const fileName = extractDownloadedPdfName(entry?.message);
      if (!fileName) return null;
      return {
        ...entry,
        fileName,
      };
    })
    .filter(Boolean);
}

function getLogTotalPages() {
  const total = getDownloadLogEntries().length;
  return Math.max(1, Math.ceil(total / state.logLimit));
}

function applyAllPagesUi() {
  const checked = Boolean(el.allPages?.checked);
  [el.startPage, el.endPage].forEach((input) => {
    if (!input) return;
    input.disabled = checked;
    input.readOnly = checked;
    input.classList.toggle("is-disabled", checked);
    if (checked) {
      input.setAttribute("aria-disabled", "true");
      if (document.activeElement === input) {
        input.blur();
      }
    } else {
      input.removeAttribute("aria-disabled");
    }
  });
}

function buildFileKey(type, fileName) {
  return `${String(type || "").trim()}::${String(fileName || "").trim()}`;
}

function parseFileKey(key) {
  const text = String(key || "");
  const separator = text.indexOf("::");
  if (separator <= 0) {
    return { type: "", fileName: "" };
  }
  return {
    type: text.slice(0, separator),
    fileName: text.slice(separator + 2),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  handleUnauthorizedResponse(response);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: withAuthHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body || {}),
  });
  handleUnauthorizedResponse(response);
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function setStatus(message, type = "neutral") {
  el.status.textContent = message;
  el.status.style.borderColor = "";
  el.status.style.background = "";
  el.status.style.color = "";

  if (type === "running") {
    el.status.style.borderColor = "rgba(255, 214, 10, 0.6)";
    el.status.style.background = "rgba(255, 214, 10, 0.16)";
    el.status.style.color = "#fff";
  } else if (type === "success") {
    el.status.style.borderColor = "rgba(71, 211, 190, 0.65)";
    el.status.style.background = "rgba(71, 211, 190, 0.16)";
    el.status.style.color = "#fff";
  } else if (type === "error") {
    el.status.style.borderColor = "rgba(255, 107, 107, 0.65)";
    el.status.style.background = "rgba(255, 107, 107, 0.16)";
    el.status.style.color = "#fff";
  }
}

function getErrorMessage(error, fallbackMessage = "Beklenmeyen bir hata oluştu.") {
  const message = error?.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  return fallbackMessage;
}

function runSafeAsync(task, onError) {
  try {
    const result = task();
    Promise.resolve(result).catch(onError);
  } catch (error) {
    onError(error);
  }
}

function withAsyncStatus(handler, fallbackMessage = "İşlem başarısız.") {
  return (event) => {
    runSafeAsync(() => handler(event), (error) => {
      console.error(error);
      setStatus(getErrorMessage(error, fallbackMessage), "error");
    });
  };
}

function readFormPayload() {
  const fromDateInput = String(el.fromDate.value || "").trim();
  const toDateInput = String(el.toDate.value || "").trim();
  const fromParsed = parseHtmlDateInput(fromDateInput);
  const toParsed = parseHtmlDateInput(toDateInput);
  const allPages = Boolean(el.allPages.checked);
  const startPage = allPages ? 1 : parsePositiveInt(el.startPage.value, 1);
  const endPage = allPages ? null : parsePositiveInt(el.endPage.value, startPage);
  const workerCount = Math.min(8, Math.max(1, parsePositiveInt(el.workerCount?.value, 1)));

  if (!fromDateInput || !toDateInput) {
    throw new Error("Başlangıç ve bitiş tarihi zorunlu.");
  }
  if (!fromParsed || !toParsed) {
    throw new Error("Tarih formatı geçersiz. Lütfen YYYY-MM-DD formatı kullanın.");
  }
  if (fromParsed.normalized > toParsed.normalized) {
    throw new Error("Başlangıç tarihi bitiş tarihinden büyük olamaz.");
  }
  if (!allPages && endPage < startPage) {
    throw new Error("Bitiş sayfası başlangıç sayfasından küçük olamaz.");
  }

  return {
    type: el.jobType.value === "uyusmazlik" ? "uyusmazlik" : "mahkeme",
    fromDate: fromParsed.normalized,
    toDate: toParsed.normalized,
    startPage,
    endPage,
    allPages,
    workerCount,
    browserMode: el.browserMode.value === "visible" ? "visible" : "headless",
  };
}

function renderStatus() {
  el.startButton.disabled = state.running;
  el.stopButton.disabled = !state.running;
  el.clearLogsButton.disabled = state.logs.length === 0;
  el.clearHistoryButton.disabled = state.running || state.historyTotal === 0;

  if (state.running) {
    const run = state.currentRun;
    setStatus("Çalışıyor", "running");
    if (run) {
      const downloadedCount = Number(run.downloadedCount || 0);
      const failedCount = Number(run.failedCount || 0);
      const retryCount = Number(run.retryCount || 0);
      const duplicateCount = Number(run.duplicateCount || 0);
      const processedCount = downloadedCount + failedCount;
      const totalTargetCountRaw = Number(run.totalTargetCount || 0);
      const hasKnownTotal = Number.isFinite(totalTargetCountRaw) && totalTargetCountRaw > 0;
      const totalTargetCountLabel = hasKnownTotal
        ? `${totalTargetCountRaw}${run.totalTargetCountCapped ? "+" : ""}`
        : "bilinmiyor";
      const downloadedProgress = hasKnownTotal
        ? `${downloadedCount}/${totalTargetCountLabel}`
        : String(downloadedCount);
      const runId = String(run.runId || "-");
      const startedAt = formatDate(run.startedAt);
      const workerInfo = ` | Worker: ${Number(run.workerCount || 1)}`;
      const progressInfo = ` | İndirilen: ${downloadedProgress} | İşlenen: ${processedCount} | Hata: ${failedCount} | Retry: ${retryCount} | Dup: ${duplicateCount} | Toplam: ${totalTargetCountLabel}`;
      if (el.runMeta) {
        el.runMeta.textContent = `run:${runId} | ${startedAt} | ${run.type} | ${run.fromDate} -> ${run.toDate} | ${formatPageRange(run)}${workerInfo}${progressInfo}`;
      }
    } else {
      if (el.runMeta) {
        el.runMeta.textContent = "Çalışıyor";
      }
    }
    return;
  }

  if (state.lastRun) {
    const r = state.lastRun;
    if (r.status === "completed") {
      setStatus("Tamamlandı", "success");
    } else if (r.status === "stopped") {
      setStatus("Durduruldu");
    } else {
      setStatus("Hata", "error");
    }
    const runId = String(r.runId || "-");
    const startedAt = formatDate(r.startedAt);
    const workerInfo = ` | Worker: ${Number(r.workerCount || 1)}`;
    if (el.runMeta) {
      el.runMeta.textContent = `run:${runId} | ${startedAt} | ${r.type} | ${r.fromDate} -> ${r.toDate} | ${formatPageRange(r)}${workerInfo}`;
    }
    return;
  }

  setStatus("Hazır");
  if (el.runMeta) {
    el.runMeta.textContent = "Çalışma yok";
  }
}

function formatMetricValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 2,
  }).format(number);
}

function renderOpsDashboard() {
  const dashboard = state.opsDashboard;
  if (!dashboard) {
    el.opsMeta.textContent = "Veri yok";
    el.opsKpis.innerHTML = `<article class="ops-kpi-card">
  <p class="ops-kpi-card__title">KPI</p>
  <p class="ops-kpi-card__value">-</p>
  <p class="ops-kpi-card__hint">Operasyon verisi bekleniyor</p>
</article>`;
    el.opsAlertsMeta.textContent = "0 alarm";
    el.opsAlertsList.innerHTML = '<li class="ops-alert-item ops-alert-item--ok">Aktif alarm yok.</li>';
    return;
  }

  const generatedAt = formatDate(dashboard.generatedAt);
  const windowHours = Number(dashboard?.window?.hours || 0);
  el.opsMeta.textContent = `${windowHours || "-"} saat | ${generatedAt}`;

  const kpis = Array.isArray(dashboard.kpis) ? dashboard.kpis : [];
  if (!kpis.length) {
    el.opsKpis.innerHTML = `<article class="ops-kpi-card">
  <p class="ops-kpi-card__title">KPI</p>
  <p class="ops-kpi-card__value">-</p>
  <p class="ops-kpi-card__hint">Veri yok</p>
</article>`;
  } else {
    el.opsKpis.innerHTML = kpis
      .map((kpi) => {
        const tone = String(kpi?.tone || "neutral");
        const title = escapeHtml(kpi?.title || "-");
        const value = escapeHtml(String(kpi?.value ?? "-"));
        const hint = escapeHtml(kpi?.hint || "-");
        return `<article class="ops-kpi-card ops-kpi-card--${tone}">
  <p class="ops-kpi-card__title">${title}</p>
  <p class="ops-kpi-card__value">${value}</p>
  <p class="ops-kpi-card__hint">${hint}</p>
</article>`;
      })
      .join("");
  }

  const alerts = Array.isArray(dashboard.alerts) ? dashboard.alerts : [];
  el.opsAlertsMeta.textContent = `${alerts.length} alarm`;
  if (!alerts.length) {
    el.opsAlertsList.innerHTML = '<li class="ops-alert-item ops-alert-item--ok">Aktif alarm yok.</li>';
    return;
  }

  el.opsAlertsList.innerHTML = alerts
    .map((alert) => {
      const severityRaw = String(alert?.severity || "warning").toLowerCase();
      const severity = ["critical", "warning", "info", "ok"].includes(severityRaw)
        ? severityRaw
        : "warning";
      const metric = escapeHtml(alert?.metric || "-");
      const value = formatMetricValue(alert?.value);
      const threshold = formatMetricValue(alert?.threshold);
      const message = escapeHtml(alert?.message || "");
      return `<li class="ops-alert-item ops-alert-item--${severity}">
  <strong>${escapeHtml(String(alert?.source || "ops"))}</strong>
  <span>${message}</span>
  <span class="ops-alert-item__meta">${metric}: ${value} | esik: ${threshold}</span>
</li>`;
    })
    .join("");
}

function renderLogs() {
  const downloadRows = getDownloadLogEntries();
  const total = downloadRows.length;
  const totalPages = getLogTotalPages();
  state.logPage = clampPage(state.logPage, totalPages);

  const startIndex = (state.logPage - 1) * state.logLimit;
  const rows = downloadRows.slice(startIndex, startIndex + state.logLimit);

  el.logMeta.textContent = `${total} PDF`;
  el.clearLogsButton.disabled = state.logs.length === 0;
  el.logPageInfo.textContent = `Sayfa ${state.logPage} / ${totalPages}`;
  el.logFirstButton.disabled = state.logPage <= 1;
  el.logPrevButton.disabled = state.logPage <= 1;
  el.logNextButton.disabled = state.logPage >= totalPages;
  el.logLastButton.disabled = state.logPage >= totalPages;
  el.logJumpInput.max = String(totalPages);
  if (document.activeElement !== el.logJumpInput) {
    el.logJumpInput.value = String(state.logPage);
  }

  if (!rows.length) {
    el.liveLog.textContent = "Henüz indirilen PDF yok.";
    return;
  }

  const viewingLatest = state.logPage === totalPages;

  el.liveLog.textContent = rows.map((entry) => entry.fileName).join("\n");
  if (viewingLatest) {
    el.liveLog.scrollTop = el.liveLog.scrollHeight;
  }
}

function renderHistory() {
  const rows = state.history;
  el.historyMeta.textContent = `${state.historyTotal} kayıt`;
  el.clearHistoryButton.disabled = state.running || state.historyTotal === 0;
  el.historyPageInfo.textContent = `Sayfa ${state.historyPage} / ${state.historyTotalPages}`;
  el.historyFirstButton.disabled = state.historyPage <= 1;
  el.historyPrevButton.disabled = state.historyPage <= 1;
  el.historyNextButton.disabled = state.historyPage >= state.historyTotalPages;
  el.historyLastButton.disabled = state.historyPage >= state.historyTotalPages;
  el.historyJumpInput.max = String(state.historyTotalPages);
  if (document.activeElement !== el.historyJumpInput) {
    el.historyJumpInput.value = String(state.historyPage);
  }

  if (!rows.length) {
    el.historyBody.innerHTML = '<tr><td colspan="7">Kayıt bulunamadı.</td></tr>';
    return;
  }

  el.historyBody.innerHTML = rows
    .map((row) => {
      const dateRange = `${row?.dateRange?.from || "-"} -> ${row?.dateRange?.to || "-"}`;
      const selectedPages = row?.selectedPages?.allPages
        ? "Tümü"
        : `${row?.selectedPages?.startPage ?? "-"} -> ${row?.selectedPages?.endPage ?? "-"}`;
      const processedPages = Array.isArray(row?.pagesProcessed) && row.pagesProcessed.length
        ? row.pagesProcessed.join(", ")
        : "-";
      const totalTargetCountRaw = Number(row?.totalTargetCount || 0);
      const hasKnownTotal = Number.isFinite(totalTargetCountRaw) && totalTargetCountRaw > 0;
      const targetLabel = hasKnownTotal
        ? `${totalTargetCountRaw}${row?.totalTargetCountCapped ? "+" : ""}`
        : "-";
      const duplicateCount = Number(row?.duplicateCount || 0);
      const result = `ok:${row?.downloadedCount || 0} / fail:${row?.failedCount || 0} / hedef:${targetLabel} / worker:${Number(
        row?.workerCount || 1,
      )} / dup:${duplicateCount}`;
      return `<tr>
  <td>${escapeHtml(formatDate(row?.startedAt))}</td>
  <td>${escapeHtml(row?.type || "-")}</td>
  <td>${escapeHtml(dateRange)}</td>
  <td>${escapeHtml(selectedPages)}</td>
  <td>${escapeHtml(processedPages)}</td>
  <td>${escapeHtml(row?.status || "-")}</td>
  <td>${escapeHtml(result)}</td>
</tr>`;
    })
    .join("");
}

function renderFiles() {
  const rows = state.files;
  const selectedCount = state.selectedFileKeys.size;
  el.filesMeta.textContent = `${state.filesTotal} dosya | ${selectedCount} seçili`;
  el.filesPageInfo.textContent = `Sayfa ${state.filesPage} / ${state.filesTotalPages}`;
  el.filesFirstButton.disabled = state.filesPage <= 1;
  el.filesPrevButton.disabled = state.filesPage <= 1;
  el.filesNextButton.disabled = state.filesPage >= state.filesTotalPages;
  el.filesLastButton.disabled = state.filesPage >= state.filesTotalPages;
  el.filesJumpInput.max = String(state.filesTotalPages);
  if (document.activeElement !== el.filesJumpInput) {
    el.filesJumpInput.value = String(state.filesPage);
  }

  if (!rows.length) {
    el.filesBody.innerHTML = '<tr><td colspan="6">Dosya bulunamadı.</td></tr>';
  } else {
    el.filesBody.innerHTML = rows
      .map((row) => {
        const fileKey = buildFileKey(row.type, row.fileName);
        const checked = state.selectedFileKeys.has(fileKey) ? "checked" : "";
        const downloadUrl = `/api/ekapv3/files/download?type=${encodeURIComponent(
          row.type || "",
        )}&fileName=${encodeURIComponent(row.fileName || "")}`;
        return `<tr>
  <td><input type="checkbox" data-file-key="${escapeHtml(fileKey)}" ${checked} /></td>
  <td>${escapeHtml(formatDate(row.updatedAt))}</td>
  <td>${escapeHtml(row.type || "-")}</td>
  <td>${escapeHtml(row.fileName || "-")}</td>
  <td>${escapeHtml(formatBytes(row.sizeBytes))}</td>
  <td><a class="btn btn--ghost btn--link v3-mini-btn" href="${downloadUrl}">İndir</a></td>
</tr>`;
      })
      .join("");
  }

  const allChecked = rows.length > 0 && rows.every((row) => state.selectedFileKeys.has(buildFileKey(row.type, row.fileName)));
  el.selectAllFilesCheckbox.checked = allChecked;
  el.deleteSelectedButton.disabled = state.selectedFileKeys.size === 0;
  el.deleteByTypeButton.disabled = !String(el.filesTypeFilter.value || "").trim() || state.filesTotal === 0;
  el.deleteAllButton.disabled = state.filesTotal === 0;
}

async function refreshStatus() {
  const wasRunning = state.running;
  const payload = await fetchJson("/api/ekapv3/status");
  const data = payload?.data || {};
  const previousLogTotalPages = Math.max(1, Math.ceil(getDownloadLogEntries().length / state.logLimit));
  const wasViewingLatestLogs = state.logPage >= previousLogTotalPages;

  state.running = Boolean(data.running);
  state.stopRequested = Boolean(data.stopRequested);
  state.currentRun = data.currentRun || null;
  state.lastRun = data.lastRun || null;
  state.logs = Array.isArray(data.logs) ? data.logs : [];

  const nextLogTotalPages = Math.max(1, Math.ceil(getDownloadLogEntries().length / state.logLimit));
  state.logPage = wasViewingLatestLogs ? nextLogTotalPages : clampPage(state.logPage, nextLogTotalPages);

  renderStatus();
  renderLogs();

  if (wasRunning !== state.running) {
    await refreshHistory().catch(() => {});
  }
}

async function refreshOpsDashboard() {
  const payload = await fetchJson("/api/ops/dashboard");
  state.opsDashboard = payload?.data || null;
  renderOpsDashboard();
}

async function refreshHistory() {
  const params = new URLSearchParams();
  params.set("page", String(state.historyPage));
  params.set("limit", String(state.historyLimit));
  const payload = await fetchJson(`/api/ekapv3/history?${params.toString()}`);
  state.history = Array.isArray(payload?.data) ? payload.data : [];
  const meta = payload?.meta || {};
  const total = Number(meta.total);
  const totalPages = Number(meta.totalPages);
  const page = Number(meta.page);
  state.historyTotal = Number.isFinite(total) && total >= 0 ? Math.floor(total) : state.history.length;
  state.historyTotalPages = Number.isFinite(totalPages) && totalPages >= 1
    ? Math.floor(totalPages)
    : Math.max(1, Math.ceil(state.historyTotal / state.historyLimit));
  state.historyPage = clampPage(page || state.historyPage, state.historyTotalPages);
  renderHistory();
}

async function refreshFiles() {
  const selectedType = String(el.filesTypeFilter.value || "").trim();
  const params = new URLSearchParams();
  params.set("page", String(state.filesPage));
  params.set("limit", String(state.filesLimit));
  if (selectedType) {
    params.set("type", selectedType);
  }

  const payload = await fetchJson(`/api/ekapv3/files?${params.toString()}`);
  state.files = Array.isArray(payload?.data) ? payload.data : [];
  const meta = payload?.meta || {};
  const total = Number(meta.total);
  const totalPages = Number(meta.totalPages);
  const page = Number(meta.page);
  state.filesTotal = Number.isFinite(total) && total >= 0 ? Math.floor(total) : state.files.length;
  state.filesTotalPages = Number.isFinite(totalPages) && totalPages >= 1
    ? Math.floor(totalPages)
    : Math.max(1, Math.ceil(state.filesTotal / state.filesLimit));
  state.filesPage = clampPage(page || state.filesPage, state.filesTotalPages);
  renderFiles();
}

function openConfirmationDialog({ title, message, action }) {
  state.lastFocusedElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.confirmBusy = false;
  state.pendingDeleteAction = action;
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.cancelConfirmButton.disabled = false;
  el.approveConfirmButton.disabled = false;
  el.confirmOverlay.hidden = false;
  el.cancelConfirmButton.focus();
}

function closeConfirmationDialog() {
  if (state.confirmBusy) {
    return;
  }
  state.pendingDeleteAction = null;
  state.confirmBusy = false;
  el.confirmOverlay.hidden = true;
  el.cancelConfirmButton.disabled = false;
  el.approveConfirmButton.disabled = false;

  const restoreTarget = state.lastFocusedElement;
  state.lastFocusedElement = null;
  if (restoreTarget && typeof restoreTarget.focus === "function") {
    restoreTarget.focus();
  }
}

function getDialogFocusableElements() {
  return Array.from(
    el.confirmOverlay.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function handleConfirmOverlayKeydown(event) {
  if (el.confirmOverlay.hidden) {
    return;
  }

  if (event.key === "Escape") {
    if (!state.confirmBusy) {
      event.preventDefault();
      closeConfirmationDialog();
    }
    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const focusable = getDialogFocusableElements();
  if (!focusable.length) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function getSelectedFilesPayload() {
  const rows = [];
  for (const key of state.selectedFileKeys) {
    const parsed = parseFileKey(key);
    if (!parsed.type || !parsed.fileName) continue;
    rows.push(parsed);
  }
  return rows;
}

async function runDeleteSelectedFiles() {
  const files = getSelectedFilesPayload();
  if (!files.length) {
    setStatus("Önce dosya seçin.", "error");
    return;
  }

  openConfirmationDialog({
    title: "Seçili Dosyaları Sil",
    message: `${files.length} dosya silinecek. Bu işlem geri alınamaz.`,
    action: async (confirmation) => {
      const payload = await postJson("/api/ekapv3/files/delete", {
        mode: "selected",
        files,
        confirmation,
      });
      const deletedCount = payload?.data?.deletedCount || 0;
      state.selectedFileKeys.clear();
      await refreshFiles();
      setStatus(`${deletedCount} dosya silindi.`, "success");
    },
  });
}

async function runDeleteByType() {
  const type = String(el.filesTypeFilter.value || "").trim();
  if (!type) {
    setStatus("Türü toplu silmek için önce tür filtresi seçin.", "error");
    return;
  }

  openConfirmationDialog({
    title: "Tür Bazlı Toplu Silme",
    message: `${type} klasöründeki listelenen dosyalar silinecek. Bu işlem geri alınamaz.`,
    action: async (confirmation) => {
      const payload = await postJson("/api/ekapv3/files/delete", {
        mode: "byType",
        type,
        confirmation,
      });
      const deletedCount = payload?.data?.deletedCount || 0;
      state.selectedFileKeys.clear();
      await refreshFiles();
      setStatus(`${deletedCount} dosya silindi.`, "success");
    },
  });
}

async function runDeleteAllFiles() {
  openConfirmationDialog({
    title: "Tüm Dosyaları Sil",
    message: "Mahkeme ve uyuşmazlık klasörlerindeki tüm dosyalar silinecek. Bu işlem geri alınamaz.",
    action: async (confirmation) => {
      const payload = await postJson("/api/ekapv3/files/delete", {
        mode: "all",
        confirmation,
      });
      const deletedCount = payload?.data?.deletedCount || 0;
      state.selectedFileKeys.clear();
      await refreshFiles();
      setStatus(`${deletedCount} dosya silindi.`, "success");
    },
  });
}

async function runClearLogs() {
  if (!state.logs.length) {
    setStatus("Temizlenecek canlı log kaydı yok.");
    return;
  }

  openConfirmationDialog({
    title: "Canlı Logları Temizle",
    message: "Canlı log kayıtları temizlenecek. Bu işlem geri alınamaz.",
    action: async (confirmation) => {
      const payload = await postJson("/api/ekapv3/logs/clear", {
        confirmation,
      });
      const clearedCount = Number(payload?.data?.clearedCount || 0);
      state.logPage = 1;
      await refreshStatus();
      setStatus(`${clearedCount} log kaydı temizlendi.`, "success");
    },
  });
}

async function runClearHistory() {
  if (state.running) {
    throw new Error("EKAP v3 çalışırken indirme geçmişi temizlenemez.");
  }
  if (state.historyTotal <= 0) {
    setStatus("Temizlenecek indirme geçmişi kaydı yok.");
    return;
  }

  openConfirmationDialog({
    title: "İndirme Geçmişini Temizle",
    message: "İndirme geçmişi kayıtları tamamen temizlenecek. Bu işlem geri alınamaz.",
    action: async (confirmation) => {
      const payload = await postJson("/api/ekapv3/history/clear", {
        confirmation,
      });
      const deletedCount = Number(payload?.data?.deletedCount || 0);
      state.historyPage = 1;
      await refreshHistory();
      await refreshOpsDashboard();
      setStatus(`${deletedCount} geçmiş kaydı temizlendi.`, "success");
    },
  });
}

async function openDownloadsFolder() {
  const type = String(el.filesTypeFilter.value || "").trim();
  await postJson("/api/ekapv3/files/open-dir", {
    type: type || null,
  });
}

el.form.addEventListener(
  "submit",
  withAsyncStatus(async (event) => {
    event.preventDefault();
    const payload = readFormPayload();
    await postJson("/api/ekapv3/download", payload);
    state.logPage = 1;
    state.historyPage = 1;
    await refreshStatus();
    await refreshHistory();
    await refreshOpsDashboard();
  }, "Başlatma başarısız."),
);

el.allPages.addEventListener("change", () => {
  applyAllPagesUi();
});

el.fromDate?.addEventListener("change", () => {
  syncDateInputBounds();
});

el.toDate?.addEventListener("change", () => {
  syncDateInputBounds();
});

el.logPrevButton.addEventListener("click", () => {
  if (state.logPage <= 1) return;
  state.logPage -= 1;
  renderLogs();
});

el.logFirstButton.addEventListener("click", () => {
  if (state.logPage <= 1) return;
  state.logPage = 1;
  renderLogs();
});

el.logNextButton.addEventListener("click", () => {
  const totalPages = getLogTotalPages();
  if (state.logPage >= totalPages) return;
  state.logPage += 1;
  renderLogs();
});

el.logLastButton.addEventListener("click", () => {
  const totalPages = getLogTotalPages();
  if (state.logPage >= totalPages) return;
  state.logPage = totalPages;
  renderLogs();
});

el.logJumpButton.addEventListener("click", () => {
  const totalPages = getLogTotalPages();
  state.logPage = clampPage(el.logJumpInput.value, totalPages);
  renderLogs();
});

el.logJumpInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const totalPages = getLogTotalPages();
  state.logPage = clampPage(el.logJumpInput.value, totalPages);
  renderLogs();
});

el.clearLogsButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await runClearLogs();
  }, "Canlı loglar temizlenemedi."),
);

el.stopButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await postJson("/api/ekapv3/stop", {});
    await refreshStatus();
    await refreshOpsDashboard();
  }, "Durdurma başarısız."),
);

el.filesTypeFilter.addEventListener(
  "change",
  withAsyncStatus(async () => {
    state.filesPage = 1;
    state.selectedFileKeys.clear();
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.historyPrevButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.historyPage <= 1) return;
    state.historyPage -= 1;
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.historyFirstButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.historyPage <= 1) return;
    state.historyPage = 1;
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.historyNextButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.historyPage >= state.historyTotalPages) return;
    state.historyPage += 1;
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.historyLastButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.historyPage >= state.historyTotalPages) return;
    state.historyPage = state.historyTotalPages;
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.historyJumpButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    state.historyPage = clampPage(el.historyJumpInput.value, state.historyTotalPages);
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.historyJumpInput.addEventListener(
  "keydown",
  withAsyncStatus(async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    state.historyPage = clampPage(el.historyJumpInput.value, state.historyTotalPages);
    await refreshHistory();
  }, "Geçmiş listesi alınamadı."),
);

el.clearHistoryButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await runClearHistory();
  }, "İndirme geçmişi temizlenemedi."),
);

el.filesRefreshButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await refreshFiles();
    setStatus("Dosya listesi yenilendi.");
  }, "Dosya listesi alınamadı."),
);

el.openDownloadsButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await openDownloadsFolder();
    const type = String(el.filesTypeFilter.value || "").trim();
    if (type) {
      setStatus(`${type} klasörü açıldı.`, "success");
    } else {
      setStatus("Klasör açıldı.", "success");
    }
  }, "Klasör açılamadı."),
);

el.filesPrevButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.filesPage <= 1) return;
    state.filesPage -= 1;
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.filesFirstButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.filesPage <= 1) return;
    state.filesPage = 1;
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.filesNextButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.filesPage >= state.filesTotalPages) return;
    state.filesPage += 1;
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.filesLastButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.filesPage >= state.filesTotalPages) return;
    state.filesPage = state.filesTotalPages;
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.filesJumpButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    state.filesPage = clampPage(el.filesJumpInput.value, state.filesTotalPages);
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.filesJumpInput.addEventListener(
  "keydown",
  withAsyncStatus(async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    state.filesPage = clampPage(el.filesJumpInput.value, state.filesTotalPages);
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
);

el.selectAllFilesCheckbox.addEventListener("change", () => {
  if (el.selectAllFilesCheckbox.checked) {
    state.files.forEach((row) => state.selectedFileKeys.add(buildFileKey(row.type, row.fileName)));
  } else {
    state.files.forEach((row) => state.selectedFileKeys.delete(buildFileKey(row.type, row.fileName)));
  }
  renderFiles();
});

el.filesBody.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.type !== "checkbox") return;

  const key = String(target.dataset.fileKey || "").trim();
  if (!key) return;

  if (target.checked) {
    state.selectedFileKeys.add(key);
  } else {
    state.selectedFileKeys.delete(key);
  }
  renderFiles();
});

el.deleteSelectedButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await runDeleteSelectedFiles();
  }, "Seçili dosyalar için silme başlatılamadı."),
);

el.deleteByTypeButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await runDeleteByType();
  }, "Tür bazlı toplu silme başlatılamadı."),
);

el.deleteAllButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await runDeleteAllFiles();
  }, "Tüm dosyalar için toplu silme başlatılamadı."),
);

el.cancelConfirmButton.addEventListener("click", () => {
  closeConfirmationDialog();
});

el.confirmOverlay.addEventListener("click", (event) => {
  if (event.target === el.confirmOverlay) {
    closeConfirmationDialog();
  }
});

el.confirmOverlay.addEventListener("keydown", handleConfirmOverlayKeydown);

el.approveConfirmButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    if (state.confirmBusy) {
      return;
    }

    if (typeof state.pendingDeleteAction !== "function") {
      closeConfirmationDialog();
      return;
    }

    const confirmation = DELETE_CONFIRMATION_TEXT;

    state.confirmBusy = true;
    el.approveConfirmButton.disabled = true;
    el.cancelConfirmButton.disabled = true;
    setStatus("Silme işlemi sürüyor...");
    try {
      await state.pendingDeleteAction(confirmation);
      state.confirmBusy = false;
      closeConfirmationDialog();
    } catch (error) {
      state.confirmBusy = false;
      el.approveConfirmButton.disabled = false;
      el.cancelConfirmButton.disabled = false;
      throw error;
    }
  }, "Dosya silme hatası."),
);

(async () => {
  if (window.EkapAuth?.ready) {
    await window.EkapAuth.ready;
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  el.fromDate.value = `${yyyy}-${mm}-01`;
  el.toDate.value = `${yyyy}-${mm}-${dd}`;
  syncDateInputBounds();
  applyAllPagesUi();

  try {
    await refreshStatus();
    await refreshHistory();
    await refreshFiles();
    await refreshOpsDashboard();
  } catch (error) {
    setStatus(error?.message || "Durum alınamadı.", "error");
  }

  setInterval(() => {
    if (statusPollInFlight) {
      return;
    }
    statusPollInFlight = true;

    void (async () => {
      try {
        await refreshStatus();
        statusPollFailureCount = 0;
      } catch (_) {
        statusPollFailureCount += 1;
        if (statusPollFailureCount >= 2) {
          setStatus("Canlı durum güncellenemiyor.", "error");
        }
      } finally {
        statusPollInFlight = false;
      }
    })();
  }, 2500);

  setInterval(() => {
    if (historyPollInFlight) {
      return;
    }
    historyPollInFlight = true;

    void (async () => {
      try {
        await refreshHistory();
        historyPollFailureCount = 0;
      } catch (_) {
        historyPollFailureCount += 1;
        if (historyPollFailureCount >= 2) {
          setStatus("Geçmiş listesi güncellenemiyor.", "error");
        }
      } finally {
        historyPollInFlight = false;
      }
    })();
  }, 15000);

  setInterval(() => {
    if (filesPollInFlight) {
      return;
    }
    filesPollInFlight = true;

    void (async () => {
      try {
        await refreshFiles();
        filesPollFailureCount = 0;
      } catch (_) {
        filesPollFailureCount += 1;
        if (filesPollFailureCount >= 2) {
          setStatus("Dosya listesi güncellenemiyor.", "error");
        }
      } finally {
        filesPollInFlight = false;
      }
    })();
  }, 10000);

  setInterval(() => {
    if (opsPollInFlight) {
      return;
    }
    opsPollInFlight = true;

    void (async () => {
      try {
        await refreshOpsDashboard();
        opsPollFailureCount = 0;
      } catch (_) {
        opsPollFailureCount += 1;
        if (opsPollFailureCount >= 2) {
          setStatus("Operasyon dashboard güncellenemiyor.", "error");
        }
      } finally {
        opsPollInFlight = false;
      }
    })();
  }, 15000);
})();
