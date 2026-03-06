const DELETE_CONFIRMATION_TEXT = "onaylıyorum";

const state = {
  date: "",
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
  rows: [],
  selectedIds: new Set(),
  pendingDeleteAction: null,
};

const el = {
  filterForm: document.getElementById("downloadsFilterForm"),
  dateFilterSelect: document.getElementById("dateFilterSelect"),
  clearFilterButton: document.getElementById("clearFilterButton"),
  deleteSelectedButton: document.getElementById("deleteSelectedButton"),
  deleteByDateButton: document.getElementById("deleteByDateButton"),
  downloadStatus: document.getElementById("downloadStatus"),
  downloadsMeta: document.getElementById("downloadsMeta"),
  tableBody: document.getElementById("downloadsTableBody"),
  selectAllCheckbox: document.getElementById("selectAllCheckbox"),
  prevPageButton: document.getElementById("prevPageButton"),
  nextPageButton: document.getElementById("nextPageButton"),
  pageMeta: document.getElementById("pageMeta"),
  confirmOverlay: document.getElementById("confirmOverlay"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmMessage: document.getElementById("confirmMessage"),
  confirmInput: document.getElementById("confirmInput"),
  confirmError: document.getElementById("confirmError"),
  cancelConfirmButton: document.getElementById("cancelConfirmButton"),
  approveConfirmButton: document.getElementById("approveConfirmButton"),
};

function normalizeConfirmation(value) {
  return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return response.json();
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
  el.downloadStatus.textContent = message;
  el.downloadStatus.style.borderColor = "";
  el.downloadStatus.style.background = "";
  el.downloadStatus.style.color = "";

  if (type === "success") {
    el.downloadStatus.style.borderColor = "rgba(71, 211, 190, 0.65)";
    el.downloadStatus.style.background = "rgba(71, 211, 190, 0.16)";
    el.downloadStatus.style.color = "#fff";
  } else if (type === "error") {
    el.downloadStatus.style.borderColor = "rgba(255, 107, 107, 0.65)";
    el.downloadStatus.style.background = "rgba(255, 107, 107, 0.16)";
    el.downloadStatus.style.color = "#fff";
  }
}

function renderDateOptions(rows) {
  const currentDate = state.date;
  el.dateFilterSelect.innerHTML = '<option value="">Tüm Tarihler</option>';

  for (const row of rows) {
    const option = document.createElement("option");
    option.value = row.date;
    option.textContent = `${row.date} (${row.count} kayıt)`;
    el.dateFilterSelect.appendChild(option);
  }

  const exists = rows.some((row) => row.date === currentDate);
  if (currentDate && !exists) {
    state.date = "";
  }

  el.dateFilterSelect.value = state.date;
}

async function loadDateOptions() {
  const payload = await fetchJson("/api/downloads/dates");
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  renderDateOptions(rows);
}

async function loadList() {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("limit", String(state.limit));
  if (state.date) {
    params.set("date", state.date);
  }

  el.tableBody.innerHTML = '<tr><td colspan="5">Yükleniyor...</td></tr>';
  const payload = await fetchJson(`/api/downloads?${params.toString()}`);

  state.rows = Array.isArray(payload?.data) ? payload.data : [];
  state.total = payload?.meta?.total || 0;
  state.totalPages = payload?.meta?.totalPages || 1;

  if (state.page > state.totalPages) {
    state.page = state.totalPages;
    return loadList();
  }

  const visibleIds = new Set(state.rows.map((row) => row._id));
  for (const selectedId of [...state.selectedIds]) {
    if (!visibleIds.has(selectedId)) {
      state.selectedIds.delete(selectedId);
    }
  }

  renderTable();
}

function renderTable() {
  if (state.rows.length === 0) {
    el.tableBody.innerHTML = '<tr><td colspan="5">Kayıt bulunamadı.</td></tr>';
  } else {
    el.tableBody.innerHTML = state.rows
      .map((row) => {
        const checked = state.selectedIds.has(row._id) ? "checked" : "";
        return `<tr>
  <td><input type="checkbox" data-id="${escapeHtml(row._id)}" ${checked} /></td>
  <td>${escapeHtml(row.ikn || "-")}</td>
  <td>${escapeHtml(row.ihaleAdi || "-")}</td>
  <td>${escapeHtml(row.idareAdi || "-")}</td>
  <td>${escapeHtml(formatDate(row.updatedAt))}</td>
</tr>`;
      })
      .join("");
  }

  const allChecked =
    state.rows.length > 0 && state.rows.every((row) => state.selectedIds.has(row._id));
  el.selectAllCheckbox.checked = allChecked;

  el.downloadsMeta.textContent = `${state.total} kayıt`;
  el.pageMeta.textContent = `Sayfa ${state.page} / ${state.totalPages}`;
  el.prevPageButton.disabled = state.page <= 1;
  el.nextPageButton.disabled = state.page >= state.totalPages;
  el.deleteSelectedButton.disabled = state.selectedIds.size === 0;
  el.deleteByDateButton.disabled = !state.date;
}

function openConfirmationDialog({ title, message, action }) {
  state.pendingDeleteAction = action;
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmInput.value = "";
  el.confirmError.hidden = true;
  el.confirmOverlay.hidden = false;
  el.confirmInput.focus();
}

function closeConfirmationDialog() {
  state.pendingDeleteAction = null;
  el.confirmOverlay.hidden = true;
  el.confirmInput.value = "";
  el.confirmError.hidden = true;
}

async function runSelectedDelete() {
  const ids = [...state.selectedIds];
  if (ids.length === 0) {
    setStatus("Önce kayıt seçin.", "error");
    return;
  }

  openConfirmationDialog({
    title: "Seçili Kayıtları Sil",
    message: `${ids.length} kayıt silinecek. Bu işlem geri alınamaz.`,
    action: async (confirmation) => {
      const payload = await postJson("/api/downloads/delete", {
        mode: "selected",
        ids,
        confirmation,
      });
      const deletedCount = payload?.data?.deletedCount || 0;
      state.selectedIds.clear();
      setStatus(`${deletedCount} kayıt silindi.`, "success");
      await loadDateOptions();
      await loadList();
    },
  });
}

async function runDeleteByDate() {
  if (!state.date) {
    setStatus("Toplu silme için bir tarih seçin.", "error");
    return;
  }

  openConfirmationDialog({
    title: "Tarihteki Tüm Kayıtları Sil",
    message: `${state.date} tarihli tüm kayıtlar silinecek. Bu işlem geri alınamaz.`,
    action: async (confirmation) => {
      const payload = await postJson("/api/downloads/delete", {
        mode: "byDate",
        date: state.date,
        confirmation,
      });
      const deletedCount = payload?.data?.deletedCount || 0;
      state.selectedIds.clear();
      setStatus(`${deletedCount} kayıt silindi.`, "success");
      await loadDateOptions();
      state.page = 1;
      await loadList();
    },
  });
}

el.filterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.date = el.dateFilterSelect.value;
  state.page = 1;
  await loadList();
});

el.clearFilterButton.addEventListener("click", async () => {
  state.date = "";
  state.page = 1;
  el.dateFilterSelect.value = "";
  await loadList();
});

el.deleteSelectedButton.addEventListener("click", async () => {
  await runSelectedDelete();
});

el.deleteByDateButton.addEventListener("click", async () => {
  await runDeleteByDate();
});

el.prevPageButton.addEventListener("click", async () => {
  if (state.page <= 1) {
    return;
  }
  state.page -= 1;
  await loadList();
});

el.nextPageButton.addEventListener("click", async () => {
  if (state.page >= state.totalPages) {
    return;
  }
  state.page += 1;
  await loadList();
});

el.selectAllCheckbox.addEventListener("change", () => {
  if (el.selectAllCheckbox.checked) {
    state.rows.forEach((row) => state.selectedIds.add(row._id));
  } else {
    state.rows.forEach((row) => state.selectedIds.delete(row._id));
  }
  renderTable();
});

el.tableBody.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (target.type !== "checkbox") {
    return;
  }

  const id = String(target.dataset.id || "").trim();
  if (!id) {
    return;
  }

  if (target.checked) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }
  renderTable();
});

el.cancelConfirmButton.addEventListener("click", () => {
  closeConfirmationDialog();
});

el.confirmOverlay.addEventListener("click", (event) => {
  if (event.target === el.confirmOverlay) {
    closeConfirmationDialog();
  }
});

el.approveConfirmButton.addEventListener("click", async () => {
  if (typeof state.pendingDeleteAction !== "function") {
    closeConfirmationDialog();
    return;
  }

  const confirmation = normalizeConfirmation(el.confirmInput.value);
  if (confirmation !== DELETE_CONFIRMATION_TEXT) {
    el.confirmError.hidden = false;
    return;
  }

  try {
    setStatus("Silme işlemi sürüyor...");
    await state.pendingDeleteAction(confirmation);
    closeConfirmationDialog();
  } catch (error) {
    setStatus(error.message || "Silme hatası", "error");
  }
});

(async () => {
  try {
    setStatus("Yükleniyor...");
    await loadDateOptions();
    await loadList();
    setStatus("Hazır");
  } catch (error) {
    setStatus(error.message || "Yükleme hatası", "error");
    el.tableBody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
  }
})();
