const state = {
  q: "",
  page: 1,
  limit: 5,
  totalPages: 1,
  total: 0,
  list: [],
  selectedId: null,
  selectedDetail: null,
  selectedIlanIndex: 0,
  activeTab: "full",
  scrapeRunning: false,
  listRequestToken: 0,
  detailRequestToken: 0,
};
let scrapePollTimer = null;
let scrapePollInFlight = false;

const el = {
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  refreshButton: document.getElementById("refreshButton"),
  scrapeButton: document.getElementById("scrapeButton"),
  stopScrapeButton: document.getElementById("stopScrapeButton"),
  scrapeStatus: document.getElementById("scrapeStatus"),
  scrapeStartPageInput: document.getElementById("scrapeStartPageInput"),
  scrapeEndPageInput: document.getElementById("scrapeEndPageInput"),
  scrapeAllPagesCheckbox: document.getElementById("scrapeAllPagesCheckbox"),
  tenderList: document.getElementById("tenderList"),
  cardTemplate: document.getElementById("tenderCardTemplate"),
  listMeta: document.getElementById("listMeta"),
  pageMeta: document.getElementById("pageMeta"),
  prevPageButton: document.getElementById("prevPageButton"),
  nextPageButton: document.getElementById("nextPageButton"),
  emptyState: document.getElementById("emptyState"),
  detailView: document.getElementById("detailView"),
  detailIkn: document.getElementById("detailIkn"),
  detailTitle: document.getElementById("detailTitle"),
  detailIdare: document.getElementById("detailIdare"),
  detailNotice: document.getElementById("detailNotice"),
  ilanSelect: document.getElementById("ilanSelect"),
  downloadFullPdfButton: document.getElementById("downloadFullPdfButton"),
  downloadSelectedPdfButton: document.getElementById("downloadSelectedPdfButton"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  fullViewer: document.querySelector('[data-view="full"]'),
  summaryViewer: document.querySelector('[data-view="summary"]'),
  fullDocFrame: document.getElementById("fullDocFrame"),
  summaryText: document.getElementById("summaryText"),
};

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeFrameDocument(title, contentHtml) {
  const body = contentHtml && String(contentHtml).trim() ? String(contentHtml) : "<p><em>İçerik yok.</em></p>";

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; margin: 16px; color: #0f1724; line-height: 1.52; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #ced7e2; padding: 8px; vertical-align: top; }
  .ilanBaslik { font-weight: 700; }
  .idareBilgi { font-weight: 600; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function parseDownloadFileName(contentDisposition) {
  const value = String(contentDisposition || "");
  if (!value) {
    return "";
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (_) {
      return utf8Match[1];
    }
  }

  const basicMatch = value.match(/filename="?([^";]+)"?/i);
  return basicMatch?.[1] || "";
}

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

function updatePdfButtonsState() {
  const ilanList = Array.isArray(state.selectedDetail?.ilanList) ? state.selectedDetail.ilanList : [];
  const hasDownloadableIlan = Boolean(state.selectedId) && ilanList.length > 0;

  if (el.downloadFullPdfButton) {
    el.downloadFullPdfButton.disabled = !hasDownloadableIlan;
  }

  if (el.downloadSelectedPdfButton) {
    el.downloadSelectedPdfButton.disabled = !hasDownloadableIlan;
  }
}

async function downloadCurrentIlanPdf(kind) {
  const normalizedKind = kind === "selected" ? "selected" : "full";
  const ilanList = Array.isArray(state.selectedDetail?.ilanList) ? state.selectedDetail.ilanList : [];

  if (!state.selectedId || ilanList.length === 0) {
    setDetailNotice("PDF indirmek için önce bir kayıt ve ilan seçin.", "error");
    return;
  }

  const ilanIndex = Math.max(0, Math.min(ilanList.length - 1, state.selectedIlanIndex));
  const params = new URLSearchParams({
    kind: normalizedKind,
    ilanIndex: String(ilanIndex),
  });

  const url = `/api/tenders/${encodeURIComponent(state.selectedId)}/pdf?${params.toString()}`;

  if (el.downloadFullPdfButton) {
    el.downloadFullPdfButton.disabled = true;
  }
  if (el.downloadSelectedPdfButton) {
    el.downloadSelectedPdfButton.disabled = true;
  }

  try {
    const response = await fetch(url, {
      credentials: "same-origin",
    });
    handleUnauthorizedResponse(response);
    if (!response.ok) {
      let errorMessage = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (payload?.error) {
          errorMessage = payload.error;
        }
      } catch (_) {
        const rawText = await response.text();
        if (rawText) {
          errorMessage = rawText;
        }
      }
      throw new Error(errorMessage);
    }

    const blob = await response.blob();
    const fileName =
      parseDownloadFileName(response.headers.get("content-disposition")) ||
      `ekap-${normalizedKind}-ilan-${ilanIndex + 1}.pdf`;

    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
    setDetailNotice(`${fileName} indirildi.`, "success");
  } catch (error) {
    console.error(error);
    setDetailNotice(error?.message || "PDF indirilemedi.", "error");
  } finally {
    updatePdfButtonsState();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  handleUnauthorizedResponse(response);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
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
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`);
  }

  return payload;
}

function setScrapeStatus(message, type = "neutral") {
  el.scrapeStatus.textContent = `Scrape: ${message}`;
  el.scrapeStatus.style.borderColor = "";
  el.scrapeStatus.style.background = "";
  el.scrapeStatus.style.color = "";

  if (type === "running") {
    el.scrapeStatus.style.borderColor = "rgba(255, 214, 10, 0.6)";
    el.scrapeStatus.style.background = "rgba(255, 214, 10, 0.16)";
    el.scrapeStatus.style.color = "#604a00";
  } else if (type === "success") {
    el.scrapeStatus.style.borderColor = "rgba(71, 211, 190, 0.65)";
    el.scrapeStatus.style.background = "rgba(71, 211, 190, 0.16)";
    el.scrapeStatus.style.color = "#0b5d4f";
  } else if (type === "error") {
    el.scrapeStatus.style.borderColor = "rgba(255, 107, 107, 0.65)";
    el.scrapeStatus.style.background = "rgba(255, 107, 107, 0.16)";
    el.scrapeStatus.style.color = "#8f2f2a";
  }
}

function applyScrapeAllPagesUi() {
  const checked = Boolean(el.scrapeAllPagesCheckbox?.checked);
  [el.scrapeStartPageInput, el.scrapeEndPageInput].forEach((input) => {
    if (!input) return;
    input.disabled = checked;
    input.readOnly = checked;
    input.classList.toggle("is-disabled", checked);
  });
}

function setDetailNotice(message, type = "neutral") {
  if (!el.detailNotice) {
    return;
  }

  const text = String(message || "").trim();
  el.detailNotice.classList.remove("is-neutral", "is-success", "is-error");

  if (!text) {
    el.detailNotice.textContent = "";
    el.detailNotice.hidden = true;
    return;
  }

  el.detailNotice.textContent = text;
  el.detailNotice.hidden = false;

  if (type === "success") {
    el.detailNotice.classList.add("is-success");
    return;
  }

  if (type === "error") {
    el.detailNotice.classList.add("is-error");
    return;
  }

  el.detailNotice.classList.add("is-neutral");
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

function withAsyncError(handler, onError) {
  return (event) => {
    runSafeAsync(() => handler(event), onError);
  };
}

function handleListError(error, fallbackMessage = "Liste yüklenemedi.") {
  console.error(error);
  el.tenderList.innerHTML = `<p>Hata: ${escapeHtml(getErrorMessage(error, fallbackMessage))}</p>`;
}

function handleScrapeError(error, fallbackMessage = "Scrape işlemi başarısız.") {
  console.error(error);
  setScrapeStatus(getErrorMessage(error, fallbackMessage), "error");
}

function handlePdfError(error, fallbackMessage = "PDF indirilemedi.") {
  console.error(error);
  setDetailNotice(getErrorMessage(error, fallbackMessage), "error");
}

async function syncScrapeStatus() {
  try {
    const payload = await fetchJson("/api/scrape/status");
    const data = payload?.data || {};
    state.scrapeRunning = Boolean(data.running);
    el.scrapeButton.disabled = state.scrapeRunning;
    el.stopScrapeButton.disabled = !state.scrapeRunning;

    if (data.running) {
      const range = data.currentRunOptions?.pageRange;
      if (data.stopRequested) {
        setScrapeStatus("Durduruluyor", "running");
      } else if (range?.allPages) {
        setScrapeStatus("Çalışıyor (Tüm sayfalar)", "running");
      } else if (range?.startPage && range?.endPage) {
        setScrapeStatus(`Çalışıyor (Sayfa ${range.startPage}-${range.endPage})`, "running");
      } else {
        setScrapeStatus("Çalışıyor", "running");
      }
      return data;
    }

    if (data.lastError) {
      setScrapeStatus("Hata", "error");
      return data;
    }

    if (data.lastResult) {
      const r = data.lastResult;
      const doneLabel = r.stopped ? "Durduruldu" : "Tamamlandı";
      setScrapeStatus(
        `${doneLabel} (${r.saved ?? 0} kayıt, ${r.failed ?? 0} hata)`,
        r.stopped ? "neutral" : "success",
      );
      return data;
    }

    setScrapeStatus("Hazır");
    return data;
  } catch (error) {
    console.error(error);
    setScrapeStatus("Durum alınamadı", "error");
    return null;
  }
}

function startScrapePolling() {
  if (scrapePollTimer) {
    return;
  }

  scrapePollTimer = setInterval(() => {
    if (scrapePollInFlight) {
      return;
    }
    scrapePollInFlight = true;

    void (async () => {
      try {
        const data = await syncScrapeStatus();
        if (!data?.running) {
          stopScrapePolling();
          await loadList();
        }
      } catch (error) {
        handleListError(error, "Liste yenilenemedi.");
      } finally {
        scrapePollInFlight = false;
      }
    })();
  }, 2_000);
}

function stopScrapePolling() {
  if (!scrapePollTimer) {
    return;
  }
  clearInterval(scrapePollTimer);
  scrapePollTimer = null;
  scrapePollInFlight = false;
}

function getScrapeRangePayload() {
  const allPages = Boolean(el.scrapeAllPagesCheckbox?.checked);
  if (allPages) {
    return {
      allPages: true,
      startPage: 1,
      endPage: null,
    };
  }

  const startPageRaw = Number.parseInt(el.scrapeStartPageInput.value || "1", 10);
  const endPageRaw = Number.parseInt(el.scrapeEndPageInput.value || "1", 10);

  const startPage = Number.isNaN(startPageRaw) ? 1 : Math.max(1, startPageRaw);
  const endPage = Number.isNaN(endPageRaw) ? startPage : Math.max(startPage, endPageRaw);

  el.scrapeStartPageInput.value = String(startPage);
  el.scrapeEndPageInput.value = String(endPage);

  return {
    allPages: false,
    startPage,
    endPage,
  };
}

async function loadList() {
  const requestToken = ++state.listRequestToken;
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("limit", String(state.limit));
  if (state.q) {
    params.set("q", state.q);
  }

  el.tenderList.innerHTML = "<p>Yükleniyor...</p>";
  const payload = await fetchJson(`/api/tenders?${params.toString()}`);
  if (requestToken !== state.listRequestToken) {
    return;
  }

  state.list = payload.data || [];
  state.total = payload.meta?.total || 0;
  state.totalPages = payload.meta?.totalPages || 1;

  if (state.page > state.totalPages) {
    state.page = state.totalPages;
    return loadList();
  }

  if (!state.selectedId && state.list.length > 0) {
    state.selectedId = state.list[0]._id;
  }

  if (state.selectedId && !state.list.some((item) => item._id === state.selectedId)) {
    state.selectedId = state.list[0]?._id || null;
  }

  renderList();

  if (state.selectedId) {
    await loadDetail(state.selectedId);
  } else {
    renderEmptyDetail();
  }
}

function renderList() {
  el.tenderList.innerHTML = "";

  if (state.list.length === 0) {
    el.tenderList.innerHTML = "<p>Kayıt bulunamadı.</p>";
  }

  for (const tender of state.list) {
    const fragment = el.cardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".tender-card");

    card.dataset.id = tender._id;
    if (tender._id === state.selectedId) {
      card.classList.add("is-active");
    }

    const title = tender.ihaleAdi || "Başlık yok";
    const idare = tender.idareAdi || "İdare bilgisi yok";
    const preview = tender.preview || "Temiz içerik özeti bulunamadı.";

    fragment.querySelector(".tender-card__ikn").textContent = tender.ikn || "İKN yok";
    fragment.querySelector(".tender-card__title").textContent = title;
    fragment.querySelector(".tender-card__idare").textContent = idare;
    fragment.querySelector(".tender-card__preview").textContent = preview;
    fragment.querySelector(".tender-card__meta").textContent = `Güncellendi: ${formatDate(tender.updatedAt)}`;

    card.addEventListener("click", () => {
      runSafeAsync(
        () => selectTender(tender._id),
        (error) => handleListError(error, "Detay yüklenemedi."),
      );
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        runSafeAsync(
          () => selectTender(tender._id),
          (error) => handleListError(error, "Detay yüklenemedi."),
        );
      }
    });

    el.tenderList.appendChild(fragment);
  }

  el.listMeta.textContent = `${state.total} kayıt`;
  el.pageMeta.textContent = `Sayfa ${state.page} / ${state.totalPages}`;
  el.prevPageButton.disabled = state.page <= 1;
  el.nextPageButton.disabled = state.page >= state.totalPages;
}

async function selectTender(id) {
  if (!id) {
    return;
  }

  state.selectedId = id;
  renderList();
  await loadDetail(id);
}

async function loadDetail(id) {
  const requestToken = ++state.detailRequestToken;
  const payload = await fetchJson(`/api/tenders/${encodeURIComponent(id)}`);
  if (requestToken !== state.detailRequestToken) {
    return;
  }
  state.selectedDetail = payload.data || null;
  state.selectedIlanIndex = 0;
  renderDetail();
}

function renderEmptyDetail() {
  el.detailView.hidden = true;
  el.emptyState.hidden = false;
  setDetailNotice("");
  updatePdfButtonsState();
}

function renderDetail() {
  const detail = state.selectedDetail;
  if (!detail) {
    renderEmptyDetail();
    return;
  }

  el.emptyState.hidden = true;
  el.detailView.hidden = false;

  el.detailIkn.textContent = detail.ikn || "İKN yok";
  el.detailTitle.textContent = detail.ihaleAdi || "Başlık yok";
  el.detailIdare.textContent = detail.idareAdi || "İdare bilgisi yok";
  setDetailNotice("");

  const ilanList = Array.isArray(detail.ilanList) ? detail.ilanList : [];
  el.ilanSelect.innerHTML = "";

  ilanList.forEach((ilan, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}. ${ilan.baslik || "Başlık yok"} ${ilan.ilanTarihi ? `(${ilan.ilanTarihi})` : ""}`;
    el.ilanSelect.appendChild(option);
  });

  if (ilanList.length === 0) {
    const option = document.createElement("option");
    option.value = "0";
    option.textContent = "İlan bulunamadı";
    el.ilanSelect.appendChild(option);
  }

  el.ilanSelect.value = String(state.selectedIlanIndex);
  updatePdfButtonsState();
  renderCurrentIlan();
}

function renderCurrentIlan() {
  const ilan = state.selectedDetail?.ilanList?.[state.selectedIlanIndex] || null;

  const fullHtml = ilan?.dokumantasyon?.tamHtml || "";
  const summaryText = ilan?.secilenAlanlarMetin || "";

  el.fullDocFrame.srcdoc = makeFrameDocument("Tam Dokümantasyon", fullHtml);
  el.summaryText.textContent = summaryText || "Seçili alan özeti bulunamadı.";

  renderActiveTab();
}

function renderActiveTab() {
  const tab = state.activeTab;

  el.fullViewer.hidden = tab !== "full";
  el.summaryViewer.hidden = tab !== "summary";

  for (const tabButton of el.tabs) {
    const isActive = tabButton.dataset.tab === tab;
    tabButton.classList.toggle("is-active", isActive);
    tabButton.setAttribute("aria-selected", isActive ? "true" : "false");
    tabButton.tabIndex = isActive ? 0 : -1;
  }
}

el.searchForm.addEventListener(
  "submit",
  withAsyncError(async (event) => {
    event.preventDefault();
    state.q = el.searchInput.value.trim();
    state.page = 1;
    state.selectedId = null;
    await loadList();
  }, (error) => handleListError(error, "Liste yüklenemedi.")),
);

el.refreshButton.addEventListener(
  "click",
  withAsyncError(async () => {
    await loadList();
  }, (error) => handleListError(error, "Liste yenilenemedi.")),
);

if (el.scrapeAllPagesCheckbox) {
  el.scrapeAllPagesCheckbox.addEventListener("change", () => {
    applyScrapeAllPagesUi();
  });
}

el.scrapeButton.addEventListener(
  "click",
  withAsyncError(async () => {
    if (state.scrapeRunning) {
      return;
    }

    const payload = getScrapeRangePayload();

    state.scrapeRunning = true;
    el.scrapeButton.disabled = true;
    el.stopScrapeButton.disabled = false;
    if (payload.allPages) {
      setScrapeStatus("Çalışıyor (Tüm sayfalar)", "running");
    } else {
      setScrapeStatus(`Çalışıyor (Sayfa ${payload.startPage}-${payload.endPage})`, "running");
    }

    try {
      await postJson("/api/scrape/run", payload);
      await syncScrapeStatus();
      startScrapePolling();
    } catch (error) {
      state.scrapeRunning = false;
      el.scrapeButton.disabled = false;
      el.stopScrapeButton.disabled = true;
      throw error;
    }
  }, (error) => handleScrapeError(error, "Scrape başlatılamadı.")),
);

el.stopScrapeButton.addEventListener(
  "click",
  withAsyncError(async () => {
    if (!state.scrapeRunning) {
      return;
    }

    await postJson("/api/scrape/stop", {});
    setScrapeStatus("Durdurma istendi", "running");
    startScrapePolling();
  }, (error) => handleScrapeError(error, "Scrape durdurma isteği gönderilemedi.")),
);

el.prevPageButton.addEventListener(
  "click",
  withAsyncError(async () => {
    if (state.page <= 1) {
      return;
    }
    state.page -= 1;
    await loadList();
  }, (error) => handleListError(error, "Önceki sayfa yüklenemedi.")),
);

el.nextPageButton.addEventListener(
  "click",
  withAsyncError(async () => {
    if (state.page >= state.totalPages) {
      return;
    }
    state.page += 1;
    await loadList();
  }, (error) => handleListError(error, "Sonraki sayfa yüklenemedi.")),
);

el.ilanSelect.addEventListener("change", () => {
  state.selectedIlanIndex = Number.parseInt(el.ilanSelect.value, 10) || 0;
  renderCurrentIlan();
});

if (el.downloadFullPdfButton) {
  el.downloadFullPdfButton.addEventListener(
    "click",
    withAsyncError(async () => {
      await downloadCurrentIlanPdf("full");
    }, (error) => handlePdfError(error, "Tam PDF indirilemedi.")),
  );
}

if (el.downloadSelectedPdfButton) {
  el.downloadSelectedPdfButton.addEventListener(
    "click",
    withAsyncError(async () => {
      await downloadCurrentIlanPdf("selected");
    }, (error) => handlePdfError(error, "Seçili alan PDF indirilemedi.")),
  );
}

for (const tabButton of el.tabs) {
  tabButton.addEventListener("click", () => {
    state.activeTab = tabButton.dataset.tab;
    renderActiveTab();
  });

  tabButton.addEventListener("keydown", (event) => {
    if (el.tabs.length < 2) {
      return;
    }

    const currentIndex = el.tabs.indexOf(tabButton);
    if (currentIndex < 0) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % el.tabs.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + el.tabs.length) % el.tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = el.tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = el.tabs[nextIndex];
    state.activeTab = nextTab.dataset.tab;
    renderActiveTab();
    nextTab.focus();
  });
}

(async () => {
  try {
    if (window.EkapAuth?.ready) {
      await window.EkapAuth.ready;
    }
    const data = await syncScrapeStatus();
    if (data?.running) {
      startScrapePolling();
    }
    applyScrapeAllPagesUi();
    await loadList();
  } catch (error) {
    console.error(error);
    el.tenderList.innerHTML = `<p>Yükleme hatası: ${escapeHtml(error.message)}</p>`;
  }
})();
