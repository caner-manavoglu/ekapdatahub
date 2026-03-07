const state = {
  running: false,
  stopRequested: false,
  currentRun: null,
  lastRun: null,
  logs: [],
  history: [],
  files: [],
};

const el = {
  status: document.getElementById("v3Status"),
  runMeta: document.getElementById("v3RunMeta"),
  form: document.getElementById("v3Form"),
  jobType: document.getElementById("jobType"),
  fromDate: document.getElementById("fromDate"),
  toDate: document.getElementById("toDate"),
  startPage: document.getElementById("startPage"),
  endPage: document.getElementById("endPage"),
  browserMode: document.getElementById("browserMode"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  liveLog: document.getElementById("v3LiveLog"),
  historyMeta: document.getElementById("v3HistoryMeta"),
  historyBody: document.getElementById("v3HistoryBody"),
  filesMeta: document.getElementById("v3FilesMeta"),
  filesBody: document.getElementById("v3FilesBody"),
  filesTypeFilter: document.getElementById("v3FilesTypeFilter"),
  filesRefreshButton: document.getElementById("v3FilesRefreshButton"),
};

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

async function fetchJson(url) {
  const response = await fetch(url);
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
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
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

function readFormPayload() {
  const fromDate = String(el.fromDate.value || "").trim();
  const toDate = String(el.toDate.value || "").trim();
  const startPage = parsePositiveInt(el.startPage.value, 1);
  const endPage = parsePositiveInt(el.endPage.value, startPage);

  if (!fromDate || !toDate) {
    throw new Error("Başlangıç ve bitiş tarihi zorunlu.");
  }
  if (endPage < startPage) {
    throw new Error("Bitiş sayfası başlangıç sayfasından küçük olamaz.");
  }

  return {
    type: el.jobType.value === "uyusmazlik" ? "uyusmazlik" : "mahkeme",
    fromDate,
    toDate,
    startPage,
    endPage,
    browserMode: el.browserMode.value === "visible" ? "visible" : "headless",
  };
}

function renderStatus() {
  el.startButton.disabled = state.running;
  el.stopButton.disabled = !state.running;

  if (state.running) {
    const run = state.currentRun;
    setStatus("Çalışıyor", "running");
    if (run) {
      el.runMeta.textContent = `${run.type} | ${run.fromDate} -> ${run.toDate} | ${run.startPage}-${run.endPage}`;
    } else {
      el.runMeta.textContent = "Çalışıyor";
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
    el.runMeta.textContent = `${r.type} | ${r.fromDate} -> ${r.toDate} | ${r.startPage}-${r.endPage}`;
    return;
  }

  setStatus("Hazır");
  el.runMeta.textContent = "Çalışma yok";
}

function renderLogs() {
  if (!state.logs.length) {
    el.liveLog.textContent = "Henüz log yok.";
    return;
  }

  el.liveLog.textContent = state.logs
    .map((entry) => {
      const level = String(entry?.level || "info").toUpperCase();
      return `[${formatDate(entry?.timestamp)}] [${level}] ${entry?.message || ""}`;
    })
    .join("\n");
  el.liveLog.scrollTop = el.liveLog.scrollHeight;
}

function renderHistory() {
  const rows = state.history;
  el.historyMeta.textContent = `${rows.length} kayıt`;

  if (!rows.length) {
    el.historyBody.innerHTML = '<tr><td colspan="7">Kayıt bulunamadı.</td></tr>';
    return;
  }

  el.historyBody.innerHTML = rows
    .map((row) => {
      const dateRange = `${row?.dateRange?.from || "-"} -> ${row?.dateRange?.to || "-"}`;
      const selectedPages = `${row?.selectedPages?.startPage ?? "-"} -> ${row?.selectedPages?.endPage ?? "-"}`;
      const processedPages = Array.isArray(row?.pagesProcessed) && row.pagesProcessed.length
        ? row.pagesProcessed.join(", ")
        : "-";
      const result = `ok:${row?.downloadedCount || 0} / fail:${row?.failedCount || 0}`;
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
  el.filesMeta.textContent = `${rows.length} dosya`;

  if (!rows.length) {
    el.filesBody.innerHTML = '<tr><td colspan="5">Dosya bulunamadı.</td></tr>';
    return;
  }

  el.filesBody.innerHTML = rows
    .map((row) => {
      const downloadUrl = `/api/ekapv3/files/download?type=${encodeURIComponent(
        row.type || "",
      )}&fileName=${encodeURIComponent(row.fileName || "")}`;
      return `<tr>
  <td>${escapeHtml(formatDate(row.updatedAt))}</td>
  <td>${escapeHtml(row.type || "-")}</td>
  <td>${escapeHtml(row.fileName || "-")}</td>
  <td>${escapeHtml(formatBytes(row.sizeBytes))}</td>
  <td><a class="btn btn--ghost btn--link v3-mini-btn" href="${downloadUrl}">İndir</a></td>
</tr>`;
    })
    .join("");
}

async function refreshStatus() {
  const payload = await fetchJson("/api/ekapv3/status");
  const data = payload?.data || {};
  state.running = Boolean(data.running);
  state.stopRequested = Boolean(data.stopRequested);
  state.currentRun = data.currentRun || null;
  state.lastRun = data.lastRun || null;
  state.logs = Array.isArray(data.logs) ? data.logs : [];
  renderStatus();
  renderLogs();
}

async function refreshHistory() {
  const payload = await fetchJson("/api/ekapv3/history?limit=200");
  state.history = Array.isArray(payload?.data) ? payload.data : [];
  renderHistory();
}

async function refreshFiles() {
  const selectedType = String(el.filesTypeFilter.value || "").trim();
  const params = new URLSearchParams();
  params.set("limit", "800");
  if (selectedType) {
    params.set("type", selectedType);
  }

  const payload = await fetchJson(`/api/ekapv3/files?${params.toString()}`);
  state.files = Array.isArray(payload?.data) ? payload.data : [];
  renderFiles();
}

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = readFormPayload();
    await postJson("/api/ekapv3/start", payload);
    await refreshStatus();
    await refreshHistory();
  } catch (error) {
    setStatus(error?.message || "Başlatma başarısız.", "error");
  }
});

el.stopButton.addEventListener("click", async () => {
  try {
    await postJson("/api/ekapv3/stop", {});
    await refreshStatus();
  } catch (error) {
    setStatus(error?.message || "Durdurma başarısız.", "error");
  }
});

el.filesTypeFilter.addEventListener("change", async () => {
  try {
    await refreshFiles();
  } catch (error) {
    setStatus(error?.message || "Dosya listesi alınamadı.", "error");
  }
});

el.filesRefreshButton.addEventListener("click", async () => {
  try {
    await refreshFiles();
    setStatus("Dosya listesi yenilendi.");
  } catch (error) {
    setStatus(error?.message || "Dosya listesi alınamadı.", "error");
  }
});

(async () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  el.fromDate.value = `${yyyy}-${mm}-01`;
  el.toDate.value = `${yyyy}-${mm}-${dd}`;

  try {
    await refreshStatus();
    await refreshHistory();
    await refreshFiles();
  } catch (error) {
    setStatus(error?.message || "Durum alınamadı.", "error");
  }

  setInterval(async () => {
    try {
      await refreshStatus();
      await refreshHistory();
    } catch (_) {
      // Silent poll failure.
    }
  }, 2500);

  setInterval(async () => {
    try {
      await refreshFiles();
    } catch (_) {
      // Silent poll failure.
    }
  }, 10000);
})();
