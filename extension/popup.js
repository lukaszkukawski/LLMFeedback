const statusEl = document.getElementById("status");
const selectedMetaEl = document.getElementById("selectedMeta");
const countsMetaEl = document.getElementById("countsMeta");
const messageEl = document.getElementById("message");
const commentEl = document.getElementById("comment");

const newSessionBtn = document.getElementById("newSessionBtn");
const markAreaBtn = document.getElementById("markAreaBtn");
const pickElementBtn = document.getElementById("pickElementBtn");
const addAnnotationBtn = document.getElementById("addAnnotationBtn");
const exportBtn = document.getElementById("exportBtn");
const jsonBtn = document.getElementById("jsonBtn");

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.style.color = isError ? "#b42318" : "#1d3e74";
}

function callRuntime(message) {
  return chrome.runtime.sendMessage(message);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function short(value, len = 90) {
  if (!value) {
    return "";
  }
  return value.length > len ? `${value.slice(0, len)}...` : value;
}

function formatRegion(region) {
  if (!region) {
    return "brak";
  }

  const x = region.pageX ?? 0;
  const y = region.pageY ?? 0;
  const w = region.width ?? 0;
  const h = region.height ?? 0;
  return `x=${x}, y=${y}, w=${w}, h=${h}`;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function initSession(reset = false) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, error: "Brak aktywnej karty." };
  }

  await ensureContentScript(tab.id);
  return callRuntime({ type: "INIT_SESSION", tab, reset });
}

async function refreshUi() {
  const response = await callRuntime({ type: "GET_STATE" });
  if (!response.ok) {
    setMessage(response.error || "Nie udało się pobrać stanu.", true);
    return;
  }

  const state = response.state;
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const regions = Array.isArray(state.regions) ? state.regions : [];
  const annotations = Array.isArray(state.annotations) ? state.annotations : [];

  statusEl.textContent = `Sesja: ${state.sessionActive ? "aktywna" : "brak"}`;

  selectedMetaEl.textContent = state.selectedRegion
    ? `Wybrany obszar: ${formatRegion(state.selectedRegion.region)} (${short(state.selectedRegion.url)})`
    : "Wybrany obszar: brak";

  countsMetaEl.textContent = `Kroki: ${timeline.length} | Obszary: ${regions.length} | Notatki: ${annotations.length}`;
}

newSessionBtn.addEventListener("click", async () => {
  const response = await initSession(true);
  if (!response.ok) {
    setMessage(response.error || "Nie udało się utworzyć sesji.", true);
    return;
  }

  setMessage("Wyczyszczono sesję.");
  await refreshUi();
});

markAreaBtn.addEventListener("click", async () => {
  const initResponse = await initSession(false);
  if (!initResponse.ok) {
    setMessage(initResponse.error || "Nie udało się przygotować sesji.", true);
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    setMessage("Brak aktywnej karty.", true);
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "START_REGION_MODE" });
  if (!response?.ok) {
    setMessage(response?.error || "Nie udało się uruchomić trybu zaznaczania.", true);
    return;
  }

  setMessage("Rysuj prostokąt na stronie. ESC anuluje.");
});

pickElementBtn.addEventListener("click", async () => {
  const initResponse = await initSession(false);
  if (!initResponse.ok) {
    setMessage(initResponse.error || "Nie udało się przygotować sesji.", true);
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    setMessage("Brak aktywnej karty.", true);
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: "START_ELEMENT_MODE" });
  if (!response?.ok) {
    setMessage(response?.error || "Nie udało się uruchomić trybu wyboru elementu.", true);
    return;
  }

  setMessage("Kliknij docelowy element na stronie. ESC anuluje.");
});

addAnnotationBtn.addEventListener("click", async () => {
  const comment = commentEl.value.trim();
  if (!comment) {
    setMessage("Wpisz notatkę.", true);
    return;
  }

  const tab = await getActiveTab();
  const response = await callRuntime({
    type: "ADD_ANNOTATION",
    comment,
    tabId: tab?.id || null
  });

  if (!response.ok) {
    setMessage(response.error || "Nie udało się dodać notatki.", true);
    return;
  }

  commentEl.value = "";
  setMessage("Dodano notatkę do zaznaczonego obszaru.");
  await refreshUi();
});

exportBtn.addEventListener("click", async () => {
  const response = await callRuntime({ type: "EXPORT_TO_BACKEND" });
  if (!response.ok) {
    const queuedInfo = response.queuedId ? ` (kolejka: ${response.queuedId})` : "";
    setMessage(`Błąd wysyłki: ${response.error}${queuedInfo}`, true);
    return;
  }

  const result = response.result || {};
  setMessage(`Zapisano raport: ${result.reportId || "ok"}`);
});

jsonBtn.addEventListener("click", async () => {
  const response = await callRuntime({ type: "EXPORT_JSON_FILE" });
  if (!response.ok) {
    setMessage(response.error || "Export JSON nieudany.", true);
    return;
  }

  setMessage(`Wyeksportowano ${response.fileName}`);
});

refreshUi().catch((error) => {
  setMessage(error.message || "Błąd inicjalizacji popupu.", true);
});
