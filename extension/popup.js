const DOMAIN_SETTINGS_KEY = "uiFeedbackDomainSettings";

const domainEl = document.getElementById("domain");
const toggleBtn = document.getElementById("toggleBtn");
const statusEl = document.getElementById("status");

let activeTab = null;
let activeDomain = "";
let domainEnabled = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", !!isError);
}

function getDomainFromUrl(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return String(parsed.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function renderToggle() {
  toggleBtn.classList.remove("on", "off");

  if (!activeDomain) {
    toggleBtn.textContent = "Ta strona nie obsługuje przełącznika domeny";
    toggleBtn.disabled = true;
    return;
  }

  toggleBtn.disabled = false;
  if (domainEnabled) {
    toggleBtn.textContent = "Wyłącz na tej domenie";
    toggleBtn.classList.add("on");
  } else {
    toggleBtn.textContent = "Włącz na tej domenie";
    toggleBtn.classList.add("off");
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function readDomainState(domain) {
  const result = await chrome.storage.local.get(DOMAIN_SETTINGS_KEY);
  const map = result?.[DOMAIN_SETTINGS_KEY];
  if (!map || typeof map !== "object") {
    return false;
  }
  return map[domain] === true;
}

async function writeDomainState(domain, enabled) {
  const result = await chrome.storage.local.get(DOMAIN_SETTINGS_KEY);
  const map =
    result?.[DOMAIN_SETTINGS_KEY] && typeof result[DOMAIN_SETTINGS_KEY] === "object"
      ? { ...result[DOMAIN_SETTINGS_KEY] }
      : {};
  map[domain] = !!enabled;
  await chrome.storage.local.set({ [DOMAIN_SETTINGS_KEY]: map });
}

async function reinjectContentScript(tabId) {
  // Clean orphaned UI from a stale/invalidated content-script context.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const nodes = document.querySelectorAll(
        "[data-ui-feedback-control='1'], [data-ui-feedback-editor='1'], [data-ui-feedback-region-id]"
      );
      for (const node of nodes) {
        if (node instanceof HTMLElement) {
          node.remove();
        }
      }
      document.documentElement.style.cursor = "";
      document.body.style.cursor = "";
      try {
        delete window.__UI_FEEDBACK_RECORDER_V2_INSTALLED__;
      } catch {
        // Ignore non-configurable property edge-cases.
      }
    }
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function applyTabState(enabled) {
  if (!activeTab?.id) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "SET_DOMAIN_ENABLED",
      enabled
    });
    return;
  } catch {
    // Recover from stale "Extension context invalidated" scripts after extension reload.
  }

  try {
    await reinjectContentScript(activeTab.id);
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "SET_DOMAIN_ENABLED",
      enabled
    });
  } catch {
    throw new Error("Nie udało się zsynchronizować strony. Odśwież kartę i spróbuj ponownie.");
  }
}

async function syncCurrentTabStateFromStorage() {
  if (!activeDomain) {
    return;
  }
  const enabled = await readDomainState(activeDomain);
  domainEnabled = enabled;
  renderToggle();
  try {
    await applyTabState(enabled);
  } catch {
    // If this page blocks scripting/messaging, keep popup state only.
  }
}

toggleBtn.addEventListener("click", async () => {
  if (!activeDomain) {
    return;
  }

  const next = !domainEnabled;
  try {
    await writeDomainState(activeDomain, next);
    domainEnabled = next;
    renderToggle();
    await applyTabState(next);
    setStatus(next ? "Włączono dla tej domeny." : "Wyłączono dla tej domeny.");
  } catch (error) {
    setStatus(error?.message || "Nie udało się zapisać ustawienia.", true);
  }
});

async function init() {
  try {
    activeTab = await getActiveTab();
    activeDomain = getDomainFromUrl(activeTab?.url || "");

    domainEl.textContent = activeDomain ? `Domena: ${activeDomain}` : "Domena: nieobsługiwana";

    if (!activeDomain) {
      renderToggle();
      setStatus("Dla tej strony przełącznik domeny jest niedostępny.", true);
      return;
    }

    domainEnabled = await readDomainState(activeDomain);
    renderToggle();
    setStatus(domainEnabled ? "Rozszerzenie jest aktywne na tej domenie." : "Rozszerzenie jest wyłączone na tej domenie.");
    await syncCurrentTabStateFromStorage();
  } catch (error) {
    setStatus(error?.message || "Błąd inicjalizacji popupu.", true);
    toggleBtn.disabled = true;
  }
}

init();
