const DELETE_CONFIRMATION_TEXT = "onaylıyorum";

const state = {
  running: false,
  stopRequested: false,
  currentRun: null,
  lastRun: null,
  logs: [],
  history: [],
  files: [],
  selectedFileKeys: new Set(),
  pendingDeleteAction: null,
  confirmBusy: false,
  lastFocusedElement: null,
};
let statusPollInFlight = false;
let filesPollInFlight = false;
let statusPollFailureCount = 0;
let filesPollFailureCount = 0;

const el = {
  status: document.getElementById("v3Status"),
  runMeta: document.getElementById("v3RunMeta"),
  form: document.getElementById("v3Form"),
  openDownloadsButton: document.getElementById("v3OpenDownloadsButton"),
  jobType: document.getElementById("jobType"),
  fromDate: document.getElementById("fromDate"),
  toDate: document.getElementById("toDate"),
  startPage: document.getElementById("startPage"),
  endPage: document.getElementById("endPage"),
  allPages: document.getElementById("allPages"),
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
  selectAllFilesCheckbox: document.getElementById("v3SelectAllFilesCheckbox"),
  deleteSelectedButton: document.getElementById("v3DeleteSelectedButton"),
  deleteByTypeButton: document.getElementById("v3DeleteByTypeButton"),
  deleteAllButton: document.getElementById("v3DeleteAllButton"),
  confirmOverlay: document.getElementById("v3ConfirmOverlay"),
  confirmTitle: document.getElementById("v3ConfirmTitle"),
  confirmMessage: document.getElementById("v3ConfirmMessage"),
  confirmInput: document.getElementById("v3ConfirmInput"),
  confirmError: document.getElementById("v3ConfirmError"),
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

function formatPageRange(runLike) {
  const allPages = Boolean(runLike?.allPages);
  if (allPages) {
    return "Tümü";
  }
  const startPage = runLike?.startPage ?? "-";
  const endPage = runLike?.endPage ?? "-";
  return `${startPage}-${endPage}`;
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

function normalizeConfirmation(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
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
  const fromDate = String(el.fromDate.value || "").trim();
  const toDate = String(el.toDate.value || "").trim();
  const allPages = Boolean(el.allPages.checked);
  const startPage = allPages ? 1 : parsePositiveInt(el.startPage.value, 1);
  const endPage = allPages ? null : parsePositiveInt(el.endPage.value, startPage);

  if (!fromDate || !toDate) {
    throw new Error("Başlangıç ve bitiş tarihi zorunlu.");
  }
  if (!allPages && endPage < startPage) {
    throw new Error("Bitiş sayfası başlangıç sayfasından küçük olamaz.");
  }

  return {
    type: el.jobType.value === "uyusmazlik" ? "uyusmazlik" : "mahkeme",
    fromDate,
    toDate,
    startPage,
    endPage,
    allPages,
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
      el.runMeta.textContent = `${run.type} | ${run.fromDate} -> ${run.toDate} | ${formatPageRange(run)}`;
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
    el.runMeta.textContent = `${r.type} | ${r.fromDate} -> ${r.toDate} | ${formatPageRange(r)}`;
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
      const selectedPages = row?.selectedPages?.allPages
        ? "Tümü"
        : `${row?.selectedPages?.startPage ?? "-"} -> ${row?.selectedPages?.endPage ?? "-"}`;
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

  const visibleKeys = new Set(rows.map((row) => buildFileKey(row.type, row.fileName)));
  for (const key of [...state.selectedFileKeys]) {
    if (!visibleKeys.has(key)) {
      state.selectedFileKeys.delete(key);
    }
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
  el.deleteByTypeButton.disabled = !String(el.filesTypeFilter.value || "").trim() || rows.length === 0;
  el.deleteAllButton.disabled = rows.length === 0;
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

function openConfirmationDialog({ title, message, action }) {
  state.lastFocusedElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.confirmBusy = false;
  state.pendingDeleteAction = action;
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmInput.value = "";
  el.confirmError.hidden = true;
  el.cancelConfirmButton.disabled = false;
  el.approveConfirmButton.disabled = false;
  el.confirmOverlay.hidden = false;
  el.confirmInput.focus();
}

function closeConfirmationDialog() {
  if (state.confirmBusy) {
    return;
  }
  state.pendingDeleteAction = null;
  state.confirmBusy = false;
  el.confirmOverlay.hidden = true;
  el.confirmInput.value = "";
  el.confirmError.hidden = true;
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
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
    await postJson("/api/ekapv3/start", payload);
    await refreshStatus();
    await refreshHistory();
  }, "Başlatma başarısız."),
);

el.allPages.addEventListener("change", () => {
  applyAllPagesUi();
});

el.stopButton.addEventListener(
  "click",
  withAsyncStatus(async () => {
    await postJson("/api/ekapv3/stop", {});
    await refreshStatus();
  }, "Durdurma başarısız."),
);

el.filesTypeFilter.addEventListener(
  "change",
  withAsyncStatus(async () => {
    await refreshFiles();
  }, "Dosya listesi alınamadı."),
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

    const confirmation = normalizeConfirmation(el.confirmInput.value);
    if (confirmation !== DELETE_CONFIRMATION_TEXT) {
      el.confirmError.hidden = false;
      return;
    }

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
  applyAllPagesUi();

  try {
    await refreshStatus();
    await refreshHistory();
    await refreshFiles();
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
        await refreshHistory();
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
})();
