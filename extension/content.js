(() => {
  if (window.__UI_FEEDBACK_RECORDER_V2_INSTALLED__) {
    return;
  }
  window.__UI_FEEDBACK_RECORDER_V2_INSTALLED__ = true;

  let sessionActive = false;
  let regionMode = false;
  let elementMode = false;
  let drawing = false;
  let drawStart = null;
  let drawPreview = null;
  let interactionLayer = null;
  let floatingLauncher = null;
  let floatingPanel = null;
  let floatingStatus = null;
  let floatingScrollButton = null;
  let floatingScrollKnob = null;
  let floatingFilePath = null;
  let floatingMarkAreaBtn = null;
  let floatingPickElementBtn = null;
  let refreshCornerButtons = null;
  let panelScrollBlockEnabled = true;
  let panelVisible = false;
  let floatingCorner = "bottom-right";
  let scrollTimer = null;
  let scrollLockActive = false;
  const scrollLockReasons = new Set();
  let lockedScrollX = 0;
  let lockedScrollY = 0;
  let prevHtmlOverflow = "";
  let prevBodyOverflow = "";
  let prevHtmlOverscroll = "";
  let prevBodyOverscroll = "";
  let prevHtmlUserSelect = "";
  let prevBodyUserSelect = "";
  let overlaysHiddenForScreenshot = false;
  let domainEnabled = false;
  const regionVisuals = new Map();
  const DEBUG_LOGS = false;
  const DOMAIN_SETTINGS_KEY = "uiFeedbackDomainSettings";
  const WIDGET_PREFS_KEY = "uiFeedbackWidgetPrefs";
  const DOMAIN_PROTOCOLS = new Set(["http:", "https:"]);
  const WIDGET_CORNERS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);
  const DEFAULT_WIDGET_CORNER = "bottom-right";

  function debugLog(...args) {
    if (!DEBUG_LOGS) {
      return;
    }
    console.log("[ui-feedback/content]", ...args);
  }

  function getCurrentDomainKey() {
    return String(location.hostname || "").toLowerCase();
  }

  function isDomainToggleSupported() {
    return DOMAIN_PROTOCOLS.has(String(location.protocol || "").toLowerCase());
  }

  async function readDomainEnabledFromStorage() {
    if (!isDomainToggleSupported()) {
      return false;
    }

    const domain = getCurrentDomainKey();
    if (!domain) {
      return false;
    }

    try {
      const result = await chrome.storage.local.get(DOMAIN_SETTINGS_KEY);
      const map = result?.[DOMAIN_SETTINGS_KEY];
      if (!map || typeof map !== "object") {
        return false;
      }
      return map[domain] === true;
    } catch {
      return false;
    }
  }

  function getWidgetPrefsScopeKey() {
    if (!isDomainToggleSupported()) {
      return "__global__";
    }
    const domain = getCurrentDomainKey();
    return domain || "__global__";
  }

  function normalizeCorner(value) {
    return WIDGET_CORNERS.has(value) ? value : DEFAULT_WIDGET_CORNER;
  }

  function resolveCornerFromPrefsMap(map) {
    if (!map || typeof map !== "object") {
      return DEFAULT_WIDGET_CORNER;
    }
    const scopedValue = map[getWidgetPrefsScopeKey()];
    if (typeof scopedValue === "string" && WIDGET_CORNERS.has(scopedValue)) {
      return scopedValue;
    }
    const globalValue = map.__global__;
    if (typeof globalValue === "string" && WIDGET_CORNERS.has(globalValue)) {
      return globalValue;
    }
    return DEFAULT_WIDGET_CORNER;
  }

  async function readFloatingCornerFromStorage() {
    try {
      const result = await chrome.storage.local.get(WIDGET_PREFS_KEY);
      return resolveCornerFromPrefsMap(result?.[WIDGET_PREFS_KEY]);
    } catch {
      return DEFAULT_WIDGET_CORNER;
    }
  }

  async function writeFloatingCornerToStorage(corner) {
    const nextCorner = normalizeCorner(corner);
    try {
      const result = await chrome.storage.local.get(WIDGET_PREFS_KEY);
      const map =
        result?.[WIDGET_PREFS_KEY] && typeof result[WIDGET_PREFS_KEY] === "object"
          ? { ...result[WIDGET_PREFS_KEY] }
          : {};
      map[getWidgetPrefsScopeKey()] = nextCorner;
      await chrome.storage.local.set({ [WIDGET_PREFS_KEY]: map });
    } catch {
      // Ignore storage failures; corner still applies for current session.
    }
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return !!ok;
      } catch {
        return false;
      }
    }
  }

  function isExtensionContextInvalidatedError(errorLike) {
    const message =
      typeof errorLike === "string" ? errorLike : String(errorLike?.message || "");
    return /extension context invalidated/i.test(message);
  }

  function handleExtensionContextInvalidated() {
    sessionActive = false;
    regionMode = false;
    elementMode = false;
    drawing = false;
    drawStart = null;
    hideDrawPreview();
    if (interactionLayer) {
      interactionLayer.style.display = "none";
    }
    setCursor(false);
    setScrollLockReason("region", false);
    setScrollLockReason("element", false);
    updateModeButtons();
    if (floatingStatus) {
      floatingStatus.textContent =
        "Rozszerzenie zostało przeładowane. Odśwież stronę (Cmd/Ctrl+R), aby kontynuować.";
      floatingStatus.style.color = "#b42318";
    }
  }

  function safeSendMessage(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError && isExtensionContextInvalidatedError(runtimeError)) {
          handleExtensionContextInvalidated();
        }
        if (typeof callback === "function") {
          callback(response);
        }
      });
      return true;
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        handleExtensionContextInvalidated();
        if (typeof callback === "function") {
          callback({
            ok: false,
            error:
              "Rozszerzenie zostało przeładowane. Odśwież stronę (Cmd/Ctrl+R) i spróbuj ponownie."
          });
        }
        return false;
      }
      throw error;
    }
  }

  function setUiOverlayVisibility(visible) {
    const nodes = document.querySelectorAll("[data-ui-feedback-control='1']");
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (!visible) {
        if (node.dataset.uiFeedbackPrevVisibility === undefined) {
          node.dataset.uiFeedbackPrevVisibility = node.style.visibility || "";
        }
        node.style.visibility = "hidden";
        continue;
      }

      if (node.dataset.uiFeedbackPrevVisibility !== undefined) {
        node.style.visibility = node.dataset.uiFeedbackPrevVisibility;
        delete node.dataset.uiFeedbackPrevVisibility;
      } else {
        node.style.visibility = "";
      }
    }
  }

  function hideUiOverlaysForScreenshot() {
    if (overlaysHiddenForScreenshot) {
      return;
    }
    overlaysHiddenForScreenshot = true;
    setUiOverlayVisibility(false);
  }

  function showUiOverlaysAfterScreenshot() {
    if (!overlaysHiddenForScreenshot) {
      return;
    }
    overlaysHiddenForScreenshot = false;
    setUiOverlayVisibility(true);
  }

  function hideFloatingUi() {
    panelVisible = false;
    setScrollLockReason("panel", false);
    if (floatingPanel) {
      floatingPanel.style.display = "none";
    }
    if (floatingLauncher) {
      floatingLauncher.style.display = "none";
    }
  }

  function showFloatingUi() {
    ensureFloatingControls();
    if (floatingLauncher) {
      floatingLauncher.style.display = "flex";
    }
    if (floatingPanel) {
      floatingPanel.style.display = panelVisible ? "block" : "none";
    }
  }

  function applyDomainEnabledState(enabled) {
    domainEnabled = !!enabled;

    if (domainEnabled) {
      showUiOverlaysAfterScreenshot();
      showFloatingUi();
      return;
    }

    stopRegionMode();
    stopElementMode();
    clearAllRegionVisuals();
    showUiOverlaysAfterScreenshot();
    hideFloatingUi();
  }

  async function initializeUiStateFromStorage() {
    const [enabled, corner] = await Promise.all([
      readDomainEnabledFromStorage(),
      readFloatingCornerFromStorage()
    ]);
    floatingCorner = normalizeCorner(corner);
    applyDomainEnabledState(enabled);
  }

  function resolveDomainEnabledFromSettingsMap(map) {
    if (!isDomainToggleSupported()) {
      return false;
    }
    const domain = getCurrentDomainKey();
    if (!domain) {
      return false;
    }
    if (!map || typeof map !== "object") {
      return false;
    }
    return map[domain] === true;
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local") {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(changes, DOMAIN_SETTINGS_KEY)) {
      const nextMap = changes[DOMAIN_SETTINGS_KEY]?.newValue;
      const enabled = resolveDomainEnabledFromSettingsMap(nextMap);
      applyDomainEnabledState(enabled);
    }

    if (Object.prototype.hasOwnProperty.call(changes, WIDGET_PREFS_KEY)) {
      const nextMap = changes[WIDGET_PREFS_KEY]?.newValue;
      const nextCorner = resolveCornerFromPrefsMap(nextMap);
      if (nextCorner !== floatingCorner) {
        floatingCorner = nextCorner;
        applyFloatingCorner();
        if (typeof refreshCornerButtons === "function") {
          refreshCornerButtons();
        }
      }
    }
  }

  function setScrollLockReason(reason, enabled) {
    if (enabled) {
      scrollLockReasons.add(reason);
    } else {
      scrollLockReasons.delete(reason);
    }
    setScrollLock(scrollLockReasons.size > 0);
  }

  function updatePanelScrollLock() {
    setScrollLockReason("panel", panelVisible && panelScrollBlockEnabled);
    if (floatingScrollButton) {
      floatingScrollButton.style.background = panelScrollBlockEnabled ? "#137fec" : "#344152";
      floatingScrollButton.style.border = "1px solid rgba(255,255,255,0.12)";
      if (floatingScrollKnob) {
        floatingScrollKnob.style.left = panelScrollBlockEnabled ? "13px" : "1px";
      }
    }
  }

  function applyModeButtonStyle(button, active, activeType = "primary") {
    if (!button) {
      return;
    }

    if (active && activeType === "primary") {
      button.style.border = "1px solid rgba(19, 127, 236, 0.9)";
      button.style.background = "#137fec";
      button.style.color = "#fff";
      button.style.boxShadow = "0 8px 20px rgba(19, 127, 236, 0.35)";
      return;
    }

    button.style.border = "1px solid rgba(255, 255, 255, 0.14)";
    button.style.background = "rgba(255, 255, 255, 0.06)";
    button.style.color = "#e2e8f0";
    button.style.boxShadow = "none";
  }

  function updateModeButtons() {
    if (elementMode) {
      applyModeButtonStyle(floatingMarkAreaBtn, false);
      applyModeButtonStyle(floatingPickElementBtn, true, "primary");
      return;
    }
    if (regionMode) {
      applyModeButtonStyle(floatingMarkAreaBtn, true, "primary");
      applyModeButtonStyle(floatingPickElementBtn, false);
      return;
    }
    // Default panel state matches design: area button emphasized.
    applyModeButtonStyle(floatingMarkAreaBtn, true, "primary");
    applyModeButtonStyle(floatingPickElementBtn, false);
  }

  function makeDraggable(target, handle = null) {
    const dragHandle = handle || target;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;

    const onPointerDown = (event) => {
      if (event.button !== 0) {
        return;
      }
      const rect = target.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      target.style.right = "auto";
      target.style.bottom = "auto";
      target.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event) => {
      if (!dragging) {
        return;
      }
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        moved = true;
      }

      const left = Math.max(4, Math.min(window.innerWidth - 40, originLeft + dx));
      const top = Math.max(4, Math.min(window.innerHeight - 40, originTop + dy));
      target.style.left = `${Math.round(left)}px`;
      target.style.top = `${Math.round(top)}px`;
      event.preventDefault();
    };

    const onPointerUp = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      target.releasePointerCapture(event.pointerId);
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    dragHandle.addEventListener("pointerdown", onPointerDown, true);
    dragHandle.addEventListener("pointermove", onPointerMove, true);
    dragHandle.addEventListener("pointerup", onPointerUp, true);
    dragHandle.addEventListener("pointercancel", onPointerUp, true);
  }

  function applyFloatingCorner() {
    if (!floatingLauncher || !floatingPanel) {
      return;
    }

    const margin = 12;
    const gap = 10;
    const launcherSize = 40;

    floatingLauncher.style.left = "auto";
    floatingLauncher.style.right = "auto";
    floatingLauncher.style.top = "auto";
    floatingLauncher.style.bottom = "auto";

    floatingPanel.style.left = "auto";
    floatingPanel.style.right = "auto";
    floatingPanel.style.top = "auto";
    floatingPanel.style.bottom = "auto";

    if (floatingCorner === "top-right") {
      floatingLauncher.style.right = `${margin}px`;
      floatingLauncher.style.top = `${margin}px`;
      floatingPanel.style.right = `${margin}px`;
      floatingPanel.style.top = `${margin + launcherSize + gap}px`;
      return;
    }

    if (floatingCorner === "bottom-right") {
      floatingLauncher.style.right = `${margin}px`;
      floatingLauncher.style.bottom = `${margin}px`;
      floatingPanel.style.right = `${margin}px`;
      floatingPanel.style.bottom = `${margin + launcherSize + gap}px`;
      return;
    }

    if (floatingCorner === "top-left") {
      floatingLauncher.style.left = `${margin}px`;
      floatingLauncher.style.top = `${margin}px`;
      floatingPanel.style.left = `${margin}px`;
      floatingPanel.style.top = `${margin + launcherSize + gap}px`;
      return;
    }

    // bottom-left
    floatingLauncher.style.left = `${margin}px`;
    floatingLauncher.style.bottom = `${margin}px`;
    floatingPanel.style.left = `${margin}px`;
    floatingPanel.style.bottom = `${margin + launcherSize + gap}px`;
  }

  function ensureUiFeedbackStyles() {
    if (document.getElementById("ui-feedback-recorder-styles")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "ui-feedback-recorder-styles";
    style.textContent = `
      @keyframes uiFeedbackRecPulse {
        0% { transform: scale(0.75); opacity: 0.9; }
        70% { transform: scale(1.75); opacity: 0; }
        100% { transform: scale(1.75); opacity: 0; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureFloatingControls() {
    if (floatingLauncher && floatingPanel) {
      return;
    }

    ensureUiFeedbackStyles();

    floatingLauncher = document.createElement("button");
    floatingLauncher.type = "button";
    floatingLauncher.title = "Otwórz panel LLM Feedback";
    floatingLauncher.dataset.uiFeedbackControl = "1";
    floatingLauncher.style.position = "fixed";
    floatingLauncher.style.left = "auto";
    floatingLauncher.style.top = "auto";
    floatingLauncher.style.width = "40px";
    floatingLauncher.style.height = "40px";
    floatingLauncher.style.borderRadius = "20px";
    floatingLauncher.style.border = "1px solid rgba(0, 240, 255, 0.5)";
    floatingLauncher.style.background = "#1A1A1B";
    floatingLauncher.style.cursor = "pointer";
    floatingLauncher.style.zIndex = "2147483647";
    floatingLauncher.style.boxShadow = "0 0 15px rgba(0, 240, 255, 0.3)";
    floatingLauncher.style.display = "flex";
    floatingLauncher.style.alignItems = "center";
    floatingLauncher.style.justifyContent = "center";
    floatingLauncher.style.overflow = "hidden";
    floatingLauncher.style.transition = "transform 120ms ease";
    floatingLauncher.style.userSelect = "none";
    floatingLauncher.style.padding = "0";

    const launcherInner = document.createElement("div");
    launcherInner.dataset.uiFeedbackControl = "1";
    launcherInner.style.position = "relative";
    launcherInner.style.width = "100%";
    launcherInner.style.height = "100%";
    launcherInner.style.display = "flex";
    launcherInner.style.alignItems = "center";
    launcherInner.style.justifyContent = "center";
    launcherInner.style.pointerEvents = "none";

    const leftBracket = document.createElement("span");
    leftBracket.dataset.uiFeedbackControl = "1";
    leftBracket.textContent = "{";
    leftBracket.style.position = "absolute";
    leftBracket.style.left = "6px";
    leftBracket.style.top = "7px";
    leftBracket.style.fontSize = "18px";
    leftBracket.style.fontWeight = "700";
    leftBracket.style.lineHeight = "1";
    leftBracket.style.color = "#00F0FF";
    leftBracket.style.textShadow = "0 0 8px rgba(0, 240, 255, 0.6)";
    leftBracket.style.pointerEvents = "none";

    const rightBracket = document.createElement("span");
    rightBracket.dataset.uiFeedbackControl = "1";
    rightBracket.textContent = "}";
    rightBracket.style.position = "absolute";
    rightBracket.style.right = "6px";
    rightBracket.style.top = "7px";
    rightBracket.style.fontSize = "18px";
    rightBracket.style.fontWeight = "700";
    rightBracket.style.lineHeight = "1";
    rightBracket.style.color = "#00F0FF";
    rightBracket.style.textShadow = "0 0 8px rgba(0, 240, 255, 0.6)";
    rightBracket.style.pointerEvents = "none";

    const sparkleWrap = document.createElement("div");
    sparkleWrap.dataset.uiFeedbackControl = "1";
    sparkleWrap.style.position = "relative";
    sparkleWrap.style.display = "flex";
    sparkleWrap.style.alignItems = "center";
    sparkleWrap.style.justifyContent = "center";
    sparkleWrap.style.pointerEvents = "none";

    const sparkleGlow = document.createElement("div");
    sparkleGlow.dataset.uiFeedbackControl = "1";
    sparkleGlow.style.position = "absolute";
    sparkleGlow.style.width = "16px";
    sparkleGlow.style.height = "16px";
    sparkleGlow.style.borderRadius = "9999px";
    sparkleGlow.style.background =
      "radial-gradient(circle at center, #00F0FF 0%, rgba(0, 240, 255, 0.2) 70%, transparent 100%)";
    sparkleGlow.style.filter = "blur(2px)";
    sparkleGlow.style.opacity = "0.6";
    sparkleGlow.style.pointerEvents = "none";

    const sparkleIcon = document.createElement("span");
    sparkleIcon.dataset.uiFeedbackControl = "1";
    sparkleIcon.textContent = "✦";
    sparkleIcon.style.position = "relative";
    sparkleIcon.style.zIndex = "1";
    sparkleIcon.style.fontSize = "14px";
    sparkleIcon.style.lineHeight = "1";
    sparkleIcon.style.color = "#00F0FF";
    sparkleIcon.style.pointerEvents = "none";

    sparkleWrap.appendChild(sparkleGlow);
    sparkleWrap.appendChild(sparkleIcon);
    launcherInner.appendChild(leftBracket);
    launcherInner.appendChild(rightBracket);
    launcherInner.appendChild(sparkleWrap);
    floatingLauncher.appendChild(launcherInner);

    floatingPanel = document.createElement("div");
    floatingPanel.dataset.uiFeedbackControl = "1";
    floatingPanel.style.position = "fixed";
    floatingPanel.style.left = "auto";
    floatingPanel.style.top = "auto";
    floatingPanel.style.width = "360px";
    floatingPanel.style.maxWidth = "calc(100vw - 24px)";
    floatingPanel.style.background = "#121a23";
    floatingPanel.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    floatingPanel.style.borderRadius = "16px";
    floatingPanel.style.boxShadow = "0 18px 42px rgba(2, 8, 20, 0.55)";
    floatingPanel.style.zIndex = "2147483647";
    floatingPanel.style.display = "none";
    floatingPanel.style.pointerEvents = "auto";
    floatingPanel.style.overflow = "hidden";
    floatingPanel.style.color = "#e2e8f0";
    floatingPanel.style.fontFamily =
      "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";

    const header = document.createElement("div");
    header.dataset.uiFeedbackControl = "1";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "8px";
    header.style.padding = "10px 12px";
    header.style.background = "rgba(0, 0, 0, 0.2)";
    header.style.borderBottom = "1px solid rgba(255, 255, 255, 0.06)";
    header.style.cursor = "move";
    header.style.userSelect = "none";

    const headerLeft = document.createElement("div");
    headerLeft.dataset.uiFeedbackControl = "1";
    headerLeft.style.display = "flex";
    headerLeft.style.alignItems = "center";
    headerLeft.style.gap = "8px";

    const headerDot = document.createElement("div");
    headerDot.dataset.uiFeedbackControl = "1";
    headerDot.style.width = "8px";
    headerDot.style.height = "8px";
    headerDot.style.borderRadius = "9999px";
    headerDot.style.background = "#137fec";
    headerDot.style.boxShadow = "0 0 8px rgba(19, 127, 236, 0.8)";

    const headerTitle = document.createElement("div");
    headerTitle.dataset.uiFeedbackControl = "1";
    headerTitle.textContent = "LLM FEEDBACK";
    headerTitle.style.fontSize = "10px";
    headerTitle.style.fontWeight = "700";
    headerTitle.style.letterSpacing = "0.12em";
    headerTitle.style.textTransform = "uppercase";
    headerTitle.style.color = "#f8fafc";

    headerLeft.appendChild(headerDot);
    headerLeft.appendChild(headerTitle);
    header.appendChild(headerLeft);

    const panelBody = document.createElement("div");
    panelBody.dataset.uiFeedbackControl = "1";
    panelBody.style.padding = "12px";
    panelBody.style.display = "grid";
    panelBody.style.gap = "10px";

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 1fr";
    row.style.gap = "8px";

    const row2 = document.createElement("div");
    row2.style.display = "grid";
    row2.style.gridTemplateColumns = "0.95fr 1.35fr";
    row2.style.gap = "8px";

    const row3 = document.createElement("div");
    row3.style.display = "grid";
    row3.style.gridTemplateColumns = "1fr 1fr";
    row3.style.gap = "8px";

    const makeIcon = (paths, size = 14) => {
      const holder = document.createElement("span");
      holder.dataset.uiFeedbackControl = "1";
      holder.style.display = "inline-flex";
      holder.style.width = `${size}px`;
      holder.style.height = `${size}px`;
      holder.style.pointerEvents = "none";
      holder.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
      return holder;
    };

    const setButtonIconLabel = (button, label, paths, iconSize = 14) => {
      const icon = makeIcon(paths, iconSize);
      const text = document.createElement("span");
      text.dataset.uiFeedbackControl = "1";
      text.textContent = label;
      text.style.pointerEvents = "none";
      button.replaceChildren(icon, text);
      return text;
    };

    const markAreaBtn = document.createElement("button");
    markAreaBtn.type = "button";
    markAreaBtn.dataset.uiFeedbackControl = "1";
    markAreaBtn.style.border = "1px solid rgba(19, 127, 236, 0.9)";
    markAreaBtn.style.background = "#137fec";
    markAreaBtn.style.color = "#fff";
    markAreaBtn.style.borderRadius = "10px";
    markAreaBtn.style.padding = "10px 10px";
    markAreaBtn.style.cursor = "pointer";
    markAreaBtn.style.fontSize = "11px";
    markAreaBtn.style.fontWeight = "600";
    markAreaBtn.style.boxShadow = "0 8px 20px rgba(19, 127, 236, 0.35)";
    markAreaBtn.style.display = "flex";
    markAreaBtn.style.alignItems = "center";
    markAreaBtn.style.justifyContent = "center";
    markAreaBtn.style.gap = "6px";
    setButtonIconLabel(
      markAreaBtn,
      "Zaznacz obszar",
      '<path d="M4 9V4H9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 4H20V9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 15V20H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 20H4V15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    );

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.dataset.uiFeedbackControl = "1";
    clearBtn.style.border = "1px solid rgba(239, 68, 68, 0.25)";
    clearBtn.style.background = "rgba(239, 68, 68, 0.08)";
    clearBtn.style.color = "#fca5a5";
    clearBtn.style.borderRadius = "10px";
    clearBtn.style.padding = "10px 10px";
    clearBtn.style.cursor = "pointer";
    clearBtn.style.fontSize = "11px";
    clearBtn.style.fontWeight = "700";
    clearBtn.style.textTransform = "uppercase";
    clearBtn.style.letterSpacing = "0.04em";
    clearBtn.style.display = "flex";
    clearBtn.style.alignItems = "center";
    clearBtn.style.justifyContent = "center";
    clearBtn.style.gap = "6px";
    setButtonIconLabel(
      clearBtn,
      "Wyczyść",
      '<path d="M3 6H21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 6V4H16V6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 6L8 20H16L17 6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
      13
    );

    const pickElementBtn = document.createElement("button");
    pickElementBtn.type = "button";
    pickElementBtn.dataset.uiFeedbackControl = "1";
    pickElementBtn.style.border = "1px solid rgba(255, 255, 255, 0.14)";
    pickElementBtn.style.background = "rgba(255, 255, 255, 0.06)";
    pickElementBtn.style.color = "#e2e8f0";
    pickElementBtn.style.borderRadius = "10px";
    pickElementBtn.style.padding = "10px 8px";
    pickElementBtn.style.cursor = "pointer";
    pickElementBtn.style.fontSize = "11px";
    pickElementBtn.style.lineHeight = "1.2";
    pickElementBtn.style.fontWeight = "600";
    pickElementBtn.style.display = "flex";
    pickElementBtn.style.alignItems = "center";
    pickElementBtn.style.justifyContent = "center";
    pickElementBtn.style.gap = "6px";
    setButtonIconLabel(
      pickElementBtn,
      "Wybierz element",
      '<path d="M4 4L11 20L13.5 13.5L20 11L4 4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
      13
    );
    floatingMarkAreaBtn = markAreaBtn;
    floatingPickElementBtn = pickElementBtn;

    floatingScrollButton = document.createElement("button");
    floatingScrollButton.type = "button";
    floatingScrollButton.textContent = "";
    floatingScrollButton.title = "Przełącz blokadę scrolla gdy panel jest otwarty";
    floatingScrollButton.dataset.uiFeedbackControl = "1";
    floatingScrollButton.style.border = "1px solid rgba(255,255,255,0.12)";
    floatingScrollButton.style.background = "#137fec";
    floatingScrollButton.style.borderRadius = "9999px";
    floatingScrollButton.style.width = "30px";
    floatingScrollButton.style.height = "16px";
    floatingScrollButton.style.padding = "0";
    floatingScrollButton.style.cursor = "pointer";
    floatingScrollButton.style.position = "relative";

    floatingScrollKnob = document.createElement("div");
    floatingScrollKnob.dataset.uiFeedbackControl = "1";
    floatingScrollKnob.style.position = "absolute";
    floatingScrollKnob.style.top = "1px";
    floatingScrollKnob.style.left = "13px";
    floatingScrollKnob.style.width = "12px";
    floatingScrollKnob.style.height = "12px";
    floatingScrollKnob.style.borderRadius = "9999px";
    floatingScrollKnob.style.background = "#fff";
    floatingScrollKnob.style.boxShadow = "0 1px 3px rgba(0,0,0,0.35)";
    floatingScrollKnob.style.transition = "left 140ms ease";
    floatingScrollKnob.style.pointerEvents = "none";
    floatingScrollButton.appendChild(floatingScrollKnob);

    const lockGroup = document.createElement("div");
    lockGroup.dataset.uiFeedbackControl = "1";
    lockGroup.style.display = "flex";
    lockGroup.style.alignItems = "center";
    lockGroup.style.gap = "6px";
    lockGroup.style.background = "rgba(255, 255, 255, 0.05)";
    lockGroup.style.border = "1px solid rgba(255, 255, 255, 0.08)";
    lockGroup.style.borderRadius = "9999px";
    lockGroup.style.padding = "2px 7px";

    const lockLabel = document.createElement("span");
    lockLabel.dataset.uiFeedbackControl = "1";
    lockLabel.textContent = "Blokada scrolla";
    lockLabel.style.fontSize = "9px";
    lockLabel.style.fontWeight = "700";
    lockLabel.style.letterSpacing = "0.02em";
    lockLabel.style.color = "#cbd5e1";
    lockLabel.style.whiteSpace = "nowrap";

    lockGroup.appendChild(lockLabel);
    lockGroup.appendChild(floatingScrollButton);
    header.appendChild(lockGroup);

    const cornerField = document.createElement("div");
    cornerField.dataset.uiFeedbackControl = "1";
    cornerField.style.display = "grid";
    cornerField.style.gap = "4px";
    cornerField.style.alignContent = "start";
    cornerField.style.background = "rgba(255, 255, 255, 0.05)";
    cornerField.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    cornerField.style.borderRadius = "10px";
    cornerField.style.padding = "6px";

    const cornerLabel = document.createElement("label");
    cornerLabel.dataset.uiFeedbackControl = "1";
    cornerLabel.textContent = "Pozycja";
    cornerLabel.style.fontSize = "8px";
    cornerLabel.style.textTransform = "uppercase";
    cornerLabel.style.letterSpacing = "0.06em";
    cornerLabel.style.fontWeight = "700";
    cornerLabel.style.color = "#64748b";

    const cornerGrid = document.createElement("div");
    cornerGrid.dataset.uiFeedbackControl = "1";
    cornerGrid.style.display = "grid";
    cornerGrid.style.gridTemplateColumns = "1fr 1fr";
    cornerGrid.style.gap = "4px";
    cornerGrid.style.padding = "2px 2px 0";

    const cornerButtons = new Map();
    const cornerItems = [
      { value: "top-left", title: "Lewy górny róg" },
      { value: "top-right", title: "Prawy górny róg" },
      { value: "bottom-left", title: "Lewy dolny róg" },
      { value: "bottom-right", title: "Prawy dolny róg" }
    ];

    const updateCornerButtons = () => {
      for (const [value, button] of cornerButtons.entries()) {
        const isActive = value === floatingCorner;
        button.style.background = isActive ? "#137fec" : "rgba(255, 255, 255, 0.1)";
        button.style.boxShadow = isActive ? "0 0 4px rgba(19, 127, 236, 0.5)" : "none";
      }
    };
    refreshCornerButtons = updateCornerButtons;

    for (const item of cornerItems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.uiFeedbackControl = "1";
      btn.title = item.title;
      btn.style.height = "10px";
      btn.style.width = "100%";
      btn.style.border = "0";
      btn.style.borderRadius = "3px";
      btn.style.cursor = "pointer";
      btn.style.padding = "0";
      btn.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          floatingCorner = item.value;
          applyFloatingCorner();
          updateCornerButtons();
          writeFloatingCornerToStorage(floatingCorner);
        },
        true
      );
      cornerButtons.set(item.value, btn);
      cornerGrid.appendChild(btn);
    }

    cornerField.appendChild(cornerLabel);
    cornerField.appendChild(cornerGrid);

    const fileNameInput = document.createElement("input");
    fileNameInput.type = "text";
    fileNameInput.placeholder = "bug_report_01";
    fileNameInput.dataset.uiFeedbackControl = "1";
    fileNameInput.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    fileNameInput.style.background = "rgba(255, 255, 255, 0.05)";
    fileNameInput.style.color = "#f8fafc";
    fileNameInput.style.borderRadius = "10px";
    fileNameInput.style.padding = "8px 9px";
    fileNameInput.style.fontSize = "10px";
    fileNameInput.style.minWidth = "0";
    fileNameInput.style.outline = "none";

    const fileNameField = document.createElement("div");
    fileNameField.dataset.uiFeedbackControl = "1";
    fileNameField.style.display = "grid";
    fileNameField.style.gap = "4px";
    fileNameField.style.alignContent = "start";
    fileNameField.style.background = "rgba(255, 255, 255, 0.05)";
    fileNameField.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    fileNameField.style.borderRadius = "10px";
    fileNameField.style.padding = "6px";

    const fileNameLabel = document.createElement("label");
    fileNameLabel.dataset.uiFeedbackControl = "1";
    fileNameLabel.textContent = "Nazwa pliku";
    fileNameLabel.style.fontSize = "8px";
    fileNameLabel.style.textTransform = "uppercase";
    fileNameLabel.style.letterSpacing = "0.06em";
    fileNameLabel.style.fontWeight = "700";
    fileNameLabel.style.color = "#64748b";

    fileNameField.appendChild(fileNameLabel);
    fileNameField.appendChild(fileNameInput);

    const saveFileBtn = document.createElement("button");
    saveFileBtn.type = "button";
    saveFileBtn.dataset.uiFeedbackControl = "1";
    saveFileBtn.style.border = "1px solid rgba(19, 127, 236, 0.8)";
    saveFileBtn.style.background = "rgba(19, 127, 236, 0.9)";
    saveFileBtn.style.color = "#fff";
    saveFileBtn.style.borderRadius = "10px";
    saveFileBtn.style.padding = "10px";
    saveFileBtn.style.cursor = "pointer";
    saveFileBtn.style.fontSize = "11px";
    saveFileBtn.style.fontWeight = "700";
    saveFileBtn.style.display = "flex";
    saveFileBtn.style.alignItems = "center";
    saveFileBtn.style.justifyContent = "center";
    saveFileBtn.style.gap = "6px";
    setButtonIconLabel(
      saveFileBtn,
      "Zapisz plik",
      '<path d="M5 4H16L19 7V20H5V4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 4V10H15V4" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 16H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      13
    );

    floatingFilePath = document.createElement("div");
    floatingFilePath.dataset.uiFeedbackControl = "1";
    floatingFilePath.style.fontSize = "10px";
    floatingFilePath.style.minHeight = "14px";
    floatingFilePath.style.color = "#93c5fd";
    floatingFilePath.style.display = "grid";
    floatingFilePath.style.gap = "4px";
    floatingFilePath.style.background = "rgba(0, 0, 0, 0.3)";
    floatingFilePath.style.border = "1px solid rgba(255, 255, 255, 0.08)";
    floatingFilePath.style.borderRadius = "10px";
    floatingFilePath.style.padding = "8px";

    floatingStatus = document.createElement("span");
    floatingStatus.style.fontSize = "10px";
    floatingStatus.style.minHeight = "14px";
    floatingStatus.style.color = "#34d399";
    floatingStatus.textContent = "Panel gotowy.";

    const setFloatingStatus = (text, isError = false) => {
      if (!floatingStatus) {
        return;
      }
      floatingStatus.textContent = text;
      floatingStatus.style.color = isError ? "#fca5a5" : "#34d399";
    };

    const statusBar = document.createElement("div");
    statusBar.dataset.uiFeedbackControl = "1";
    statusBar.style.display = "flex";
    statusBar.style.alignItems = "center";
    statusBar.style.justifyContent = "space-between";
    statusBar.style.gap = "10px";
    statusBar.style.padding = "7px 10px";
    statusBar.style.background = "rgba(0, 0, 0, 0.32)";
    statusBar.style.borderTop = "1px solid rgba(255, 255, 255, 0.06)";

    const statusLeft = document.createElement("div");
    statusLeft.dataset.uiFeedbackControl = "1";
    statusLeft.style.display = "flex";
    statusLeft.style.alignItems = "center";
    statusLeft.style.gap = "6px";

    const statusIcon = document.createElement("span");
    statusIcon.dataset.uiFeedbackControl = "1";
    statusIcon.textContent = "ℹ";
    statusIcon.style.fontSize = "11px";
    statusIcon.style.color = "#00d1ff";

    statusLeft.appendChild(statusIcon);
    statusLeft.appendChild(floatingStatus);

    const statusRight = document.createElement("div");
    statusRight.dataset.uiFeedbackControl = "1";
    statusRight.style.display = "flex";
    statusRight.style.alignItems = "center";
    statusRight.style.gap = "5px";

    const versionText = document.createElement("span");
    versionText.dataset.uiFeedbackControl = "1";
    versionText.textContent = "v1.0.1";
    versionText.style.fontSize = "8px";
    versionText.style.color = "#64748b";

    const versionDot = document.createElement("div");
    versionDot.dataset.uiFeedbackControl = "1";
    versionDot.style.width = "4px";
    versionDot.style.height = "4px";
    versionDot.style.borderRadius = "9999px";
    versionDot.style.background = "#10b981";

    statusRight.appendChild(versionText);
    statusRight.appendChild(versionDot);
    statusBar.appendChild(statusLeft);
    statusBar.appendChild(statusRight);

    const sanitizeFileStem = (input) => {
      if (typeof input !== "string") {
        return "";
      }
      let stem = input.trim();
      if (!stem) {
        return "";
      }
      stem = stem.replace(/\.(json|md)$/gi, "");
      stem = stem.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
      stem = stem.replace(/\s+/g, "-");
      stem = stem.replace(/-+/g, "-").replace(/^-|-$/g, "");
      return stem.slice(0, 120);
    };

    const getStemFromPath = (input, extensionPattern) => {
      const raw = String(input || "");
      const name = raw.split(/[\\/]/).pop() || "";
      return name.replace(extensionPattern, "");
    };

    const isRequestedStemUsed = (requestedStem, mdPath) => {
      if (!requestedStem) {
        return true;
      }

      const mdStem = getStemFromPath(mdPath, /\.md$/i);
      const allowed = (stem) => stem === requestedStem || stem.startsWith(`${requestedStem}-`);

      if (mdStem) {
        return allowed(mdStem);
      }
      return false;
    };

    const renderFilePathRow = (label, pathValue) => {
      const rowEl = document.createElement("div");
      rowEl.dataset.uiFeedbackControl = "1";
      rowEl.style.display = "grid";
      rowEl.style.gridTemplateColumns = "40px 1fr";
      rowEl.style.alignItems = "center";
      rowEl.style.columnGap = "4px";

      const labelEl = document.createElement("strong");
      labelEl.textContent = `${label}:`;
      labelEl.style.fontSize = "10px";
      labelEl.style.color = "#94a3b8";
      rowEl.appendChild(labelEl);

      if (!pathValue) {
        const emptyEl = document.createElement("span");
        emptyEl.textContent = "-";
        emptyEl.style.color = "#64748b";
        rowEl.appendChild(emptyEl);
        return rowEl;
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.uiFeedbackControl = "1";
      const fullPath = String(pathValue);
      const shortName = fullPath.split(/[\\/]/).pop() || fullPath;
      btn.textContent = shortName;
      btn.title = `Kliknij, aby skopiować pełną ścieżkę\n${fullPath}`;
      btn.style.border = "0";
      btn.style.padding = "0";
      btn.style.margin = "0";
      btn.style.background = "transparent";
      btn.style.color = "#93c5fd";
      btn.style.cursor = "pointer";
      btn.style.textAlign = "left";
      btn.style.textDecoration = "underline";
      btn.style.overflow = "hidden";
      btn.style.textOverflow = "ellipsis";
      btn.style.whiteSpace = "nowrap";

      btn.addEventListener(
        "click",
        async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const ok = await copyTextToClipboard(fullPath);
          setFloatingStatus(ok ? `Skopiowano ścieżkę ${label}.` : "Nie udało się skopiować ścieżki.", !ok);
        },
        true
      );

      rowEl.appendChild(btn);
      return rowEl;
    };

    const renderSavedPaths = (mdPath) => {
      if (!floatingFilePath) {
        return;
      }
      floatingFilePath.replaceChildren(renderFilePathRow("MD", mdPath));
    };

    renderSavedPaths("");

    const startRegionModeFromPanel = () => {
      if (!domainEnabled) {
        setFloatingStatus("Rozszerzenie wyłączone dla tej domeny.", true);
        return;
      }
      if (!sessionActive) {
        setFloatingStatus("Tworzenie sesji...", false);
      }

      safeSendMessage(
        { type: "INIT_SESSION_FROM_CONTENT", reset: false },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            setFloatingStatus(
              response?.error || chrome.runtime.lastError?.message || "Błąd sesji.",
              true
            );
            return;
          }

          sessionActive = true;
          stopElementMode();
          regionMode = true;
          drawing = false;
          drawStart = null;
          updateModeButtons();
          ensureInteractionLayer();
          interactionLayer.style.display = "block";
          setCursor(true);
          setScrollLockReason("region", true);
          setFloatingStatus("Tryb zaznaczania aktywny.");
        }
      );
    };

    const startElementModeFromPanel = () => {
      if (!domainEnabled) {
        setFloatingStatus("Rozszerzenie wyłączone dla tej domeny.", true);
        return;
      }
      if (!sessionActive) {
        setFloatingStatus("Tworzenie sesji...", false);
      }

      safeSendMessage(
        { type: "INIT_SESSION_FROM_CONTENT", reset: false },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            setFloatingStatus(
              response?.error || chrome.runtime.lastError?.message || "Błąd sesji.",
              true
            );
            return;
          }

          sessionActive = true;
          stopRegionMode();
          elementMode = true;
          hideDrawPreview();
          updateModeButtons();
          setCursor(true);
          setScrollLockReason("element", true);
          setFloatingStatus("Kliknij element na stronie. Domyślnie zapisujemy tylko tekst (bez HTML).");
        }
      );
    };

    const resetSessionFromPanel = ({
      successMessage,
      errorMessage,
      onFailureMessage = ""
    }) => {
      safeSendMessage(
        { type: "INIT_SESSION_FROM_CONTENT", reset: true },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            const fallback = errorMessage || "Błąd czyszczenia sesji.";
            if (onFailureMessage) {
              setFloatingStatus(onFailureMessage, true);
            } else {
              setFloatingStatus(
                response?.error || chrome.runtime.lastError?.message || fallback,
                true
              );
            }
            return;
          }

          sessionActive = true;
          stopRegionMode();
          stopElementMode();
          clearAllRegionVisuals();
          setFloatingStatus(successMessage || "Wyczyszczono sesję.");
        }
      );
    };

    markAreaBtn.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        startRegionModeFromPanel();
      },
      true
    );

    clearBtn.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetSessionFromPanel({
          successMessage: "Wyczyszczono sesję.",
          errorMessage: "Błąd czyszczenia."
        });
      },
      true
    );

    pickElementBtn.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        startElementModeFromPanel();
      },
      true
    );

    floatingScrollButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        panelScrollBlockEnabled = !panelScrollBlockEnabled;
        updatePanelScrollLock();
        setFloatingStatus(
          panelScrollBlockEnabled
            ? "Scroll zablokowany dla otwartego panelu."
            : "Scroll odblokowany dla otwartego panelu."
        );
      },
      true
    );

    const exportToBackend = (fileName) => {
      setFloatingStatus("Zapisywanie pliku...", false);
      safeSendMessage(
        {
          type: "EXPORT_TO_BACKEND",
          fileName
        },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            setFloatingStatus(
              response?.error || chrome.runtime.lastError?.message || "Błąd zapisu pliku.",
              true
            );
            return;
          }

          const result = response.result || {};
          const mdPath = result.markdownPath || "";
          renderSavedPaths(mdPath);

          const requestedStem = sanitizeFileStem(fileName);
          if (!isRequestedStemUsed(requestedStem, mdPath)) {
            sessionActive = true;
            stopRegionMode();
            stopElementMode();
            clearAllRegionVisuals();
            setFloatingStatus("Zapisano raport. Sesja została wyczyszczona.");
            return;
          }

          sessionActive = true;
          stopRegionMode();
          stopElementMode();
          clearAllRegionVisuals();
          setFloatingStatus(`Zapisano raport: ${result.reportId || "ok"}. Sesja została wyczyszczona.`);
        }
      );
    };

    const saveFile = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const fileName = fileNameInput.value.trim();
      exportToBackend(fileName);
    };

    saveFileBtn.addEventListener("click", saveFile, true);
    fileNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        saveFile(event);
      }
    });

    row.appendChild(markAreaBtn);
    row.appendChild(pickElementBtn);
    row2.appendChild(cornerField);
    row2.appendChild(fileNameField);
    row3.appendChild(saveFileBtn);
    row3.appendChild(clearBtn);
    panelBody.appendChild(row);

    panelBody.appendChild(row2);
    panelBody.appendChild(row3);
    panelBody.appendChild(floatingFilePath);
    floatingPanel.appendChild(header);
    floatingPanel.appendChild(panelBody);
    floatingPanel.appendChild(statusBar);

    floatingLauncher.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        panelVisible = !panelVisible;
        floatingPanel.style.display = panelVisible ? "block" : "none";
        updatePanelScrollLock();
      },
      true
    );

    document.documentElement.appendChild(floatingLauncher);
    document.documentElement.appendChild(floatingPanel);
    applyFloatingCorner();
    updateModeButtons();
    updateCornerButtons();
    updatePanelScrollLock();
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) {
      return CSS.escape(value);
    }
    return String(value).replace(/([#.;?+*~':"!^$\[\]()=>|/@])/g, "\\$1");
  }

  function sanitizeText(value, maxLen) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    return clip(clean, maxLen);
  }

  function getStableSelector(el) {
    if (!(el instanceof Element)) {
      return "";
    }

    const tag = el.tagName.toLowerCase();
    if (el.id) {
      return `#${cssEscape(el.id)}`;
    }

    const stableAttrs = ["data-testid", "data-test", "name"];
    for (const attr of stableAttrs) {
      const value = el.getAttribute(attr);
      if (value && value.trim()) {
        return `${tag}[${attr}="${cssEscape(value.trim())}"]`;
      }
    }

    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) {
      return `${tag}[aria-label="${cssEscape(ariaLabel.trim())}"]`;
    }

    return getCssSelector(el);
  }

  function getNearestLabelOrHeading(el) {
    if (!(el instanceof Element)) {
      return "none";
    }

    const ownAriaLabel = el.getAttribute("aria-label");
    if (ownAriaLabel && ownAriaLabel.trim()) {
      return sanitizeText(ownAriaLabel, 120);
    }

    const ownPlaceholder = el.getAttribute("placeholder");
    if (ownPlaceholder && ownPlaceholder.trim()) {
      return sanitizeText(ownPlaceholder, 120);
    }

    const id = el.getAttribute("id");
    if (id) {
      try {
        const linkedLabel = document.querySelector(`label[for="${cssEscape(id)}"]`);
        if (linkedLabel) {
          const value = sanitizeText(linkedLabel.textContent || "", 120);
          if (value) {
            return value;
          }
        }
      } catch {
        // Ignore invalid selectors for malformed ids.
      }
    }

    const wrappedLabel = el.closest("label");
    if (wrappedLabel) {
      const value = sanitizeText(wrappedLabel.textContent || "", 120);
      if (value) {
        return value;
      }
    }

    let current = el;
    while (current) {
      const legend = current.querySelector(":scope > legend");
      if (legend) {
        const value = sanitizeText(legend.textContent || "", 120);
        if (value) {
          return value;
        }
      }
      const heading = current.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6");
      if (heading) {
        const value = sanitizeText(heading.textContent || "", 120);
        if (value) {
          return value;
        }
      }
      current = current.parentElement;
    }

    return "none";
  }

  function getElementRole(el) {
    if (!(el instanceof Element)) {
      return "none";
    }
    const explicit = sanitizeText(el.getAttribute("role") || "", 60);
    if (explicit) {
      return explicit;
    }
    return "none";
  }

  function getCompactHtmlSnippet(el) {
    if (!(el instanceof Element)) {
      return "";
    }
    const compact = String(el.outerHTML || "").replace(/\s+/g, " ").trim();
    return clip(compact, 320);
  }

  function getCssSelector(el) {
    if (!(el instanceof Element)) {
      return "";
    }

    const path = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.nodeName.toLowerCase();
      if (current.id) {
        selector += `#${cssEscape(current.id)}`;
        path.unshift(selector);
        break;
      }

      const classList = [...current.classList].slice(0, 2).map(cssEscape);
      if (classList.length > 0) {
        selector += `.${classList.join(".")}`;
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (sibling) => sibling.nodeName === current.nodeName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
      if (path.length >= 6) {
        break;
      }
    }

    return path.join(" > ");
  }

  function getXPath(el) {
    if (!(el instanceof Element)) {
      return "";
    }

    if (el.id) {
      return `//*[@id=\"${el.id}\"]`;
    }

    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.nodeName === current.nodeName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.nodeName.toLowerCase()}[${index}]`);
      current = current.parentElement;
    }

    return `/${parts.join("/")}`;
  }

  function clip(value, maxLen) {
    if (typeof value !== "string") {
      return value;
    }
    return value.length > maxLen ? `${value.slice(0, maxLen)}...[truncated]` : value;
  }

  function elementPayload(el, options = {}) {
    if (!(el instanceof Element)) {
      return null;
    }

    const includeOuterHtml = options.includeOuterHtml !== false;
    const maxTextChars = Number(options.maxTextChars || 300);
    const maxOuterHtmlChars = Number(options.maxOuterHtmlChars || 4000);
    const captureMode = options.captureMode === "full" ? "full" : "compact";
    const rect = el.getBoundingClientRect();
    return {
      cssSelector: getCssSelector(el),
      stableSelector: getStableSelector(el),
      xpath: getXPath(el),
      text: sanitizeText(el.textContent || "", maxTextChars),
      textCompact: sanitizeText(el.textContent || "", 160),
      nearestLabelOrHeading: getNearestLabelOrHeading(el),
      compactHtmlSnippet: getCompactHtmlSnippet(el),
      outerHtmlSnippet: includeOuterHtml ? clip(el.outerHTML || "", maxOuterHtmlChars) : "",
      captureMode,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      tagName: el.tagName,
      role: getElementRole(el),
      inputType: el instanceof HTMLInputElement ? el.type || "text" : null
    };
  }

  function serializeError(input) {
    if (!input) {
      return "Unknown error";
    }
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof Error) {
      return `${input.name}: ${input.message}`;
    }
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }

  const ALWAYS_RECORDED_EVENT_TYPES = new Set([
    "ui.region.select",
    "ui.element.select",
    "ui.region.note.add",
    "ui.region.css.attach",
    "ui.region.html.attach",
    "ui.region.remove"
  ]);

  const AUTO_RECORDED_EVENT_TYPES = new Set([
    "ui.click",
    "ui.input",
    "nav.change",
    "console.error",
    "network.failure",
    "js.error",
    "js.unhandledrejection"
  ]);

  function shouldRecordTimelineEvent(type) {
    if (ALWAYS_RECORDED_EVENT_TYPES.has(type)) {
      return true;
    }
    return AUTO_RECORDED_EVENT_TYPES.has(type);
  }

  function sendEvent(type, data = {}, element = null) {
    if (!domainEnabled) {
      return;
    }
    if (!sessionActive) {
      return;
    }
    if (!shouldRecordTimelineEvent(type)) {
      return;
    }

    safeSendMessage({
      type: "TIMELINE_EVENT",
      event: {
        type,
        url: location.href,
        element,
        data
      }
    });
  }

  function setCursor(enabled) {
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
  }

  function setScrollLock(enabled) {
    const html = document.documentElement;
    const body = document.body;
    if (!html || !body) {
      return;
    }

    if (enabled) {
      if (scrollLockActive) {
        return;
      }
      scrollLockActive = true;
      lockedScrollX = window.scrollX;
      lockedScrollY = window.scrollY;

      prevHtmlOverflow = html.style.overflow;
      prevBodyOverflow = body.style.overflow;
      prevHtmlOverscroll = html.style.overscrollBehavior;
      prevBodyOverscroll = body.style.overscrollBehavior;
      prevHtmlUserSelect = html.style.userSelect;
      prevBodyUserSelect = body.style.userSelect;

      html.style.overflow = "hidden";
      body.style.overflow = "hidden";
      html.style.overscrollBehavior = "none";
      body.style.overscrollBehavior = "none";
      html.style.userSelect = "none";
      body.style.userSelect = "none";
      window.scrollTo(lockedScrollX, lockedScrollY);
      return;
    }

    if (!scrollLockActive) {
      return;
    }

    scrollLockActive = false;
    html.style.overflow = prevHtmlOverflow;
    body.style.overflow = prevBodyOverflow;
    html.style.overscrollBehavior = prevHtmlOverscroll;
    body.style.overscrollBehavior = prevBodyOverscroll;
    html.style.userSelect = prevHtmlUserSelect;
    body.style.userSelect = prevBodyUserSelect;
  }

  function ensureDrawPreview() {
    if (drawPreview) {
      return;
    }

    drawPreview = document.createElement("div");
    drawPreview.style.position = "fixed";
    drawPreview.style.zIndex = "2147483647";
    drawPreview.style.pointerEvents = "none";
    drawPreview.style.border = "2px solid #ff4d4f";
    drawPreview.style.background = "rgba(255, 77, 79, 0.12)";
    drawPreview.style.display = "none";
    drawPreview.dataset.uiFeedbackControl = "1";
    document.documentElement.appendChild(drawPreview);
  }

  function ensureInteractionLayer() {
    if (interactionLayer) {
      return;
    }

    interactionLayer = document.createElement("div");
    interactionLayer.style.position = "fixed";
    interactionLayer.style.left = "0";
    interactionLayer.style.top = "0";
    interactionLayer.style.width = "100vw";
    interactionLayer.style.height = "100vh";
    interactionLayer.style.zIndex = "2147483644";
    interactionLayer.style.cursor = "crosshair";
    interactionLayer.style.background = "transparent";
    interactionLayer.style.display = "none";
    interactionLayer.style.pointerEvents = "auto";
    document.documentElement.appendChild(interactionLayer);

    interactionLayer.addEventListener("mousedown", onMouseDown, true);
    interactionLayer.addEventListener("mousemove", onMouseMove, true);
    interactionLayer.addEventListener("mouseup", onMouseUp, true);
    interactionLayer.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true, passive: false }
    );
  }

  function showDrawPreview(rect) {
    ensureDrawPreview();
    drawPreview.style.left = `${rect.left}px`;
    drawPreview.style.top = `${rect.top}px`;
    drawPreview.style.width = `${rect.width}px`;
    drawPreview.style.height = `${rect.height}px`;
    drawPreview.style.display = "block";
  }

  function hideDrawPreview() {
    if (drawPreview) {
      drawPreview.style.display = "none";
    }
  }

  function normalizedRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    return { left, top, width, height };
  }

  function buildRegion(viewRect) {
    return {
      pageX: Math.round(viewRect.left + window.scrollX),
      pageY: Math.round(viewRect.top + window.scrollY),
      width: Math.round(viewRect.width),
      height: Math.round(viewRect.height),
      viewportX: Math.round(viewRect.left),
      viewportY: Math.round(viewRect.top),
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight
    };
  }

  function removeRegionVisual(regionId) {
    const visual = regionVisuals.get(regionId);
    if (!visual) {
      return;
    }

    visual.marker.remove();
    visual.removeButton.remove();
    if (visual.noteButton) {
      visual.noteButton.remove();
    }
    if (visual.cssButton) {
      visual.cssButton.remove();
    }
    if (visual.htmlButton) {
      visual.htmlButton.remove();
    }
    if (visual.editorBox) {
      visual.editorBox.remove();
    }
    regionVisuals.delete(regionId);
  }

  function clearAllRegionVisuals() {
    for (const regionId of Array.from(regionVisuals.keys())) {
      removeRegionVisual(regionId);
    }
  }

  function updateRegionVisualPosition(regionId) {
    const visual = regionVisuals.get(regionId);
    if (!visual || !visual.region) {
      return;
    }

    if (visual.followElement && visual.elementMeta) {
      const element = findElementFromMeta(visual.elementMeta);
      if (element) {
        const rect = element.getBoundingClientRect();
        const useOffsetMode = visual.followMode === "offset";
        const nextLeft = useOffsetMode
          ? rect.left + Number(visual.anchorOffsetX || 0)
          : rect.left;
        const nextTop = useOffsetMode
          ? rect.top + Number(visual.anchorOffsetY || 0)
          : rect.top;
        const nextWidth = useOffsetMode
          ? Math.max(1, Number(visual.anchorWidth || visual.region.width || 1))
          : Math.max(1, rect.width);
        const nextHeight = useOffsetMode
          ? Math.max(1, Number(visual.anchorHeight || visual.region.height || 1))
          : Math.max(1, rect.height);
        const liveRegion = buildRegion({
          left: nextLeft,
          top: nextTop,
          width: nextWidth,
          height: nextHeight
        });
        visual.region = liveRegion;
        if (visual.regionItemRef && typeof visual.regionItemRef === "object") {
          visual.regionItemRef.region = { ...liveRegion };
        }
      }
    }

    const region = visual.region;
    const left = Math.round(region.pageX - window.scrollX);
    const top = Math.round(region.pageY - window.scrollY);
    const width = Math.max(1, Math.round(region.width || 0));
    const height = Math.max(1, Math.round(region.height || 0));

    const isOutside =
      left + width < -24 ||
      top + height < -24 ||
      left > window.innerWidth + 24 ||
      top > window.innerHeight + 24;

    visual.marker.style.display = isOutside ? "none" : "block";
    visual.removeButton.style.display = isOutside ? "none" : "block";
    if (visual.noteButton) {
      visual.noteButton.style.display = isOutside ? "none" : "block";
    }
    if (visual.cssButton) {
      visual.cssButton.style.display = isOutside ? "none" : "block";
    }
    if (visual.htmlButton) {
      visual.htmlButton.style.display = isOutside ? "none" : "block";
    }

    if (isOutside) {
      return;
    }

    visual.marker.style.left = `${left}px`;
    visual.marker.style.top = `${top}px`;
    visual.marker.style.width = `${width}px`;
    visual.marker.style.height = `${height}px`;

    visual.removeButton.style.left = `${left + width - 2}px`;
    visual.removeButton.style.top = `${Math.max(0, top - 20)}px`;

    if (visual.noteButton) {
      visual.noteButton.style.left = `${left + width - 30}px`;
      visual.noteButton.style.top = `${Math.max(0, top - 20)}px`;
    }
    if (visual.cssButton) {
      visual.cssButton.style.left = `${left + width - 58}px`;
      visual.cssButton.style.top = `${Math.max(0, top - 20)}px`;
    }
    if (visual.htmlButton) {
      visual.htmlButton.style.left = `${left + width - 86}px`;
      visual.htmlButton.style.top = `${Math.max(0, top - 20)}px`;
    }
  }

  function updateAllRegionVisualPositions() {
    for (const regionId of regionVisuals.keys()) {
      updateRegionVisualPosition(regionId);
    }
  }

  function getRegionVisual(regionId) {
    return regionVisuals.get(regionId) || null;
  }

  function findElementFromMeta(elementMeta) {
    if (!elementMeta || typeof elementMeta !== "object") {
      return null;
    }

    if (typeof elementMeta.cssSelector === "string" && elementMeta.cssSelector) {
      try {
        const bySelector = document.querySelector(elementMeta.cssSelector);
        if (bySelector instanceof Element) {
          return bySelector;
        }
      } catch {
        // Ignore invalid selectors and fallback to xpath.
      }
    }

    if (typeof elementMeta.xpath === "string" && elementMeta.xpath) {
      try {
        const result = document.evaluate(
          elementMeta.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        if (result.singleNodeValue instanceof Element) {
          return result.singleNodeValue;
        }
      } catch {
        // Ignore invalid xpath.
      }
    }

    return null;
  }

  function buildComputedCssSnapshot(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    const computed = window.getComputedStyle(element);
    const lines = [];
    lines.push(`/* tag: ${element.tagName.toLowerCase()} */`);
    if (typeof element.className === "string" && element.className.trim()) {
      lines.push(`/* class: ${element.className.trim()} */`);
    }

    for (const property of computed) {
      const value = computed.getPropertyValue(property);
      if (!value) {
        continue;
      }
      lines.push(`${property}: ${String(value).trim()};`);
    }

    return clip(lines.join("\n"), 30000);
  }

  function collectCssSources(element) {
    if (!(element instanceof Element)) {
      return [];
    }

    const sources = [];
    const seen = new Set();
    const MAX_ITEMS = 40;
    const addSource = (sourceType, stylesheetHref, selector, media) => {
      if (sources.length >= MAX_ITEMS) {
        return;
      }
      const key = `${sourceType}|${stylesheetHref}|${selector}|${media}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      sources.push({
        sourceType,
        stylesheetHref: clip(stylesheetHref || "", 500),
        selector: clip(selector || "", 500),
        media: clip(media || "", 200)
      });
    };

    if (element.getAttribute("style")) {
      addSource("inline", "[inline-style]", "[style]", "");
    }

    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) {
        continue;
      }

      const href = sheet.href || "[inline-style-tag]";
      const visitRules = (ruleList, mediaText = "") => {
        for (const rule of Array.from(ruleList || [])) {
          if (sources.length >= MAX_ITEMS) {
            return;
          }

          if (rule.type === CSSRule.STYLE_RULE) {
            const selectorText = rule.selectorText || "";
            if (!selectorText) {
              continue;
            }
            try {
              if (element.matches(selectorText)) {
                addSource("stylesheet", href, selectorText, mediaText);
              }
            } catch {
              // Ignore invalid/unsupported selectors.
            }
            continue;
          }

          if (rule.type === CSSRule.MEDIA_RULE) {
            visitRules(rule.cssRules, rule.conditionText || mediaText);
            continue;
          }
        }
      };

      visitRules(rules, "");
    }

    return sources;
  }

  function applyRegionCssButtonStyle(visual) {
    if (!visual?.cssButton) {
      return;
    }
    const attached = !!visual.cssAttached;
    visual.cssButton.style.background = attached ? "#0f766e" : "#121a23";
    visual.cssButton.style.border = attached
      ? "1px solid rgba(16, 185, 129, 0.5)"
      : "1px solid rgba(255, 255, 255, 0.1)";
    visual.cssButton.title = attached
      ? "CSS załączony (kliknij aby odświeżyć)"
      : "Załącz CSS elementu do raportu";
  }

  function applyRegionHtmlButtonStyle(visual) {
    if (!visual?.htmlButton) {
      return;
    }
    const attached = !!visual.htmlAttached;
    visual.htmlButton.style.background = attached ? "#7c3aed" : "#121a23";
    visual.htmlButton.style.border = attached
      ? "1px solid rgba(167, 139, 250, 0.5)"
      : "1px solid rgba(255, 255, 255, 0.1)";
    visual.htmlButton.title = attached
      ? "HTML załączony (kliknij aby odświeżyć)"
      : "Załącz pełny HTML elementu do raportu";
  }

  function closeRegionEditor(regionId) {
    const visual = getRegionVisual(regionId);
    if (!visual?.editorBox) {
      return;
    }
    visual.editorBox.remove();
    visual.editorBox = null;
  }

  function openRegionEditor(regionItem) {
    const regionId = regionItem.id;
    const region = regionItem.region;
    const visual = getRegionVisual(regionId);
    if (!visual) {
      return;
    }

    closeRegionEditor(regionId);

    const editorBox = document.createElement("div");
    editorBox.dataset.uiFeedbackEditor = "1";
    editorBox.dataset.uiFeedbackControl = "1";
    editorBox.style.position = "fixed";
    editorBox.style.left = "8px";
    editorBox.style.top = "8px";
    editorBox.style.width = "240px";
    editorBox.style.background = "#ffffff";
    editorBox.style.border = "1px solid #d0d7e2";
    editorBox.style.borderRadius = "8px";
    editorBox.style.boxShadow = "0 6px 20px rgba(0,0,0,0.2)";
    editorBox.style.padding = "8px";
    editorBox.style.zIndex = "2147483647";
    editorBox.style.pointerEvents = "auto";

    const title = document.createElement("div");
    title.textContent = "Notatka do obszaru";
    title.style.fontSize = "12px";
    title.style.fontWeight = "600";
    title.style.marginBottom = "6px";

    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.placeholder = "Wpisz uwagę...";
    textarea.style.width = "100%";
    textarea.style.boxSizing = "border-box";
    textarea.style.fontSize = "12px";
    textarea.style.marginBottom = "6px";
    textarea.style.resize = "vertical";
    if (typeof visual.lastSavedNote === "string" && visual.lastSavedNote.length > 0) {
      textarea.value = visual.lastSavedNote;
    }

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Zapisz";
    saveBtn.dataset.uiFeedbackControl = "1";
    saveBtn.style.flex = "1";
    saveBtn.style.border = "1px solid #2563eb";
    saveBtn.style.background = "#2563eb";
    saveBtn.style.color = "#fff";
    saveBtn.style.borderRadius = "6px";
    saveBtn.style.padding = "5px 8px";
    saveBtn.style.cursor = "pointer";
    saveBtn.style.fontSize = "12px";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Anuluj";
    cancelBtn.dataset.uiFeedbackControl = "1";
    cancelBtn.style.flex = "1";
    cancelBtn.style.border = "1px solid #c5ced8";
    cancelBtn.style.background = "#fff";
    cancelBtn.style.color = "#1f2937";
    cancelBtn.style.borderRadius = "6px";
    cancelBtn.style.padding = "5px 8px";
    cancelBtn.style.cursor = "pointer";
    cancelBtn.style.fontSize = "12px";

    const status = document.createElement("div");
    status.style.fontSize = "11px";
    status.style.minHeight = "14px";
    status.style.marginTop = "6px";
    status.style.color = "#b42318";

    const saveNote = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const comment = textarea.value.trim();
      if (!comment) {
        status.textContent = "Wpisz treść notatki.";
        return;
      }

      debugLog("ADD_ANNOTATION_FOR_REGION:send", {
        regionId,
        commentLength: comment.length
      });

      safeSendMessage(
        {
          type: "ADD_ANNOTATION_FOR_REGION",
          regionId,
          comment,
          region: regionItem.region,
          selectionType: regionItem.selectionType || "area",
          element: regionItem.element,
          url: regionItem.url
        },
        (response) => {
          debugLog("ADD_ANNOTATION_FOR_REGION:response", response);
          if (chrome.runtime.lastError || !response?.ok) {
            status.textContent =
              response?.error || chrome.runtime.lastError?.message || "Błąd zapisu notatki.";
            return;
          }

          visual.lastSavedNote = comment;
          status.style.color = "#0f766e";
          status.textContent = "Notatka zapisana.";
          sendEvent("ui.region.note.add", { regionId });
          setTimeout(() => closeRegionEditor(regionId), 250);
        }
      );
    };

    const closeEditor = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeRegionEditor(regionId);
    };

    saveBtn.addEventListener("click", saveNote, true);
    cancelBtn.addEventListener("click", closeEditor, true);
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        saveNote(event);
      }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    editorBox.appendChild(title);
    editorBox.appendChild(textarea);
    editorBox.appendChild(actions);
    editorBox.appendChild(status);

    document.documentElement.appendChild(editorBox);

    // Position editor outside selected area and inside viewport.
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const areaRect = visual.marker
      ? visual.marker.getBoundingClientRect()
      : {
          left: (region.pageX || 0) - window.scrollX,
          right: (region.pageX || 0) - window.scrollX + (region.width || 0),
          top: (region.pageY || 0) - window.scrollY,
          bottom: (region.pageY || 0) - window.scrollY + (region.height || 0)
        };

    const editorW = editorBox.offsetWidth || 240;
    const editorH = editorBox.offsetHeight || 170;
    const minLeft = margin;
    const maxLeft = Math.max(margin, viewportW - editorW - margin);
    const minTop = margin;
    const maxTop = Math.max(margin, viewportH - editorH - margin);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const intersects = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    const overlapArea = (a, b) => {
      const overlapW = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapH = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return overlapW * overlapH;
    };

    const makeRect = (left, top) => ({
      left,
      top,
      right: left + editorW,
      bottom: top + editorH
    });

    const candidates = [
      // Right side
      {
        left: areaRect.right + margin,
        top: clamp(areaRect.top, minTop, maxTop)
      },
      // Left side
      {
        left: areaRect.left - margin - editorW,
        top: clamp(areaRect.top, minTop, maxTop)
      },
      // Below
      {
        left: clamp(areaRect.left, minLeft, maxLeft),
        top: areaRect.bottom + margin
      },
      // Above
      {
        left: clamp(areaRect.left, minLeft, maxLeft),
        top: areaRect.top - margin - editorH
      }
    ];

    // Prefer fully visible candidates that do not overlap the selected area.
    let chosen = null;
    for (const candidate of candidates) {
      const left = clamp(candidate.left, minLeft, maxLeft);
      const top = clamp(candidate.top, minTop, maxTop);
      const rect = makeRect(left, top);
      const fullyVisible =
        rect.left >= minLeft &&
        rect.top >= minTop &&
        rect.right <= viewportW - margin &&
        rect.bottom <= viewportH - margin;

      if (fullyVisible && !intersects(rect, areaRect)) {
        chosen = rect;
        break;
      }
    }

    // If impossible (tiny viewport / huge area), pick minimal overlap.
    if (!chosen) {
      let best = null;
      for (const candidate of candidates) {
        const left = clamp(candidate.left, minLeft, maxLeft);
        const top = clamp(candidate.top, minTop, maxTop);
        const rect = makeRect(left, top);
        const score = overlapArea(rect, areaRect);
        if (!best || score < best.score) {
          best = { rect, score };
        }
      }
      chosen = best ? best.rect : makeRect(minLeft, minTop);
    }

    editorBox.style.left = `${Math.round(chosen.left)}px`;
    editorBox.style.top = `${Math.round(chosen.top)}px`;

    visual.editorBox = editorBox;
    safeSendMessage(
      {
        type: "GET_REGION_NOTE",
        regionId
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          return;
        }
        if (typeof response.comment === "string" && response.comment.length > 0) {
          visual.lastSavedNote = response.comment;
          textarea.value = response.comment;
        }
      }
    );
    textarea.focus();
  }

  function drawPersistentRegion(regionItem, options = {}) {
    if (!regionItem?.id || !regionItem.region) {
      return;
    }

    const regionId = regionItem.id;
    const region = regionItem.region;
    const elementRect = regionItem.element?.rect || null;
    const regionViewportX = Number(region.viewportX);
    const regionViewportY = Number(region.viewportY);
    const hasAnchorRect =
      !!elementRect &&
      Number.isFinite(Number(elementRect.x)) &&
      Number.isFinite(Number(elementRect.y)) &&
      Number.isFinite(regionViewportX) &&
      Number.isFinite(regionViewportY);
    const followMode = options.followMode === "offset" ? "offset" : "snap";
    removeRegionVisual(regionId);

    const marker = document.createElement("div");
    marker.style.position = "fixed";
    marker.style.left = "0";
    marker.style.top = "0";
    marker.style.width = "1px";
    marker.style.height = "1px";
    marker.style.border = "2px dashed #ff4d4f";
    marker.style.background = "rgba(255, 77, 79, 0.08)";
    marker.style.pointerEvents = "none";
    marker.style.zIndex = "2147483646";
    marker.dataset.uiFeedbackRegionId = regionId;
    marker.dataset.uiFeedbackControl = "1";

    const badge = document.createElement("span");
    const badgeKind = options.badgeKind === "element" ? "element" : "obszar";
    badge.textContent = badgeKind;
    badge.style.position = "absolute";
    badge.style.top = "-18px";
    badge.style.left = "0";
    badge.style.fontSize = "10px";
    badge.style.background = "#ff4d4f";
    badge.style.color = "#fff";
    badge.style.padding = "2px 4px";
    badge.style.borderRadius = "4px";
    marker.appendChild(badge);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.title = "Usuń ten obszar";
    removeButton.dataset.uiFeedbackRemove = "1";
    removeButton.dataset.uiFeedbackRegionId = regionId;
    removeButton.dataset.uiFeedbackControl = "1";
    removeButton.style.position = "fixed";
    removeButton.style.left = "0";
    removeButton.style.top = "0";
    removeButton.style.width = "24px";
    removeButton.style.height = "24px";
    removeButton.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    removeButton.style.borderRadius = "7px";
    removeButton.style.background = "#121a23";
    removeButton.style.color = "#ffffff";
    removeButton.style.fontSize = "12px";
    removeButton.style.lineHeight = "12px";
    removeButton.style.cursor = "pointer";
    removeButton.style.zIndex = "2147483647";
    removeButton.style.padding = "0";
    removeButton.style.boxShadow = "0 6px 14px rgba(0,0,0,0.35)";
    removeButton.style.display = "flex";
    removeButton.style.alignItems = "center";
    removeButton.style.justifyContent = "center";

    const removeIcon = document.createElement("span");
    removeIcon.dataset.uiFeedbackControl = "1";
    removeIcon.style.display = "inline-flex";
    removeIcon.style.width = "14px";
    removeIcon.style.height = "14px";
    removeIcon.style.pointerEvents = "none";
    removeIcon.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    removeButton.appendChild(removeIcon);

    const noteButton = document.createElement("button");
    noteButton.type = "button";
    noteButton.title = "Dodaj notatkę do obszaru";
    noteButton.dataset.uiFeedbackRegionId = regionId;
    noteButton.dataset.uiFeedbackControl = "1";
    noteButton.style.position = "fixed";
    noteButton.style.left = "0";
    noteButton.style.top = "0";
    noteButton.style.width = "24px";
    noteButton.style.height = "24px";
    noteButton.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    noteButton.style.borderRadius = "7px";
    noteButton.style.background = "#121a23";
    noteButton.style.color = "#ffffff";
    noteButton.style.fontSize = "12px";
    noteButton.style.lineHeight = "12px";
    noteButton.style.cursor = "pointer";
    noteButton.style.zIndex = "2147483647";
    noteButton.style.padding = "0";
    noteButton.style.boxShadow = "0 6px 14px rgba(0,0,0,0.35)";
    noteButton.style.display = "flex";
    noteButton.style.alignItems = "center";
    noteButton.style.justifyContent = "center";

    const noteIcon = document.createElement("span");
    noteIcon.dataset.uiFeedbackControl = "1";
    noteIcon.style.display = "inline-flex";
    noteIcon.style.width = "14px";
    noteIcon.style.height = "14px";
    noteIcon.style.pointerEvents = "none";
    noteIcon.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 6.5C5 5.12 6.12 4 7.5 4H16.5C17.88 4 19 5.12 19 6.5V13.5C19 14.88 17.88 16 16.5 16H11L7 19V16H7.5C6.12 16 5 14.88 5 13.5V6.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 7.8V12.2M9.8 10H14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    noteButton.appendChild(noteIcon);

    const isElementSelection =
      regionItem.selectionType === "element" || options.badgeKind === "element";
    let cssButton = null;
    let htmlButton = null;

    if (isElementSelection) {
      cssButton = document.createElement("button");
      cssButton.type = "button";
      cssButton.title = "Załącz CSS elementu do raportu";
      cssButton.dataset.uiFeedbackRegionId = regionId;
      cssButton.dataset.uiFeedbackControl = "1";
      cssButton.style.position = "fixed";
      cssButton.style.left = "0";
      cssButton.style.top = "0";
      cssButton.style.width = "24px";
      cssButton.style.height = "24px";
      cssButton.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      cssButton.style.borderRadius = "7px";
      cssButton.style.background = "#121a23";
      cssButton.style.color = "#ffffff";
      cssButton.style.fontSize = "12px";
      cssButton.style.lineHeight = "12px";
      cssButton.style.cursor = "pointer";
      cssButton.style.zIndex = "2147483647";
      cssButton.style.padding = "0";
      cssButton.style.boxShadow = "0 6px 14px rgba(0,0,0,0.35)";
      cssButton.style.display = "flex";
      cssButton.style.alignItems = "center";
      cssButton.style.justifyContent = "center";

      const cssIcon = document.createElement("span");
      cssIcon.dataset.uiFeedbackControl = "1";
      cssIcon.style.display = "inline-flex";
      cssIcon.style.width = "14px";
      cssIcon.style.height = "14px";
      cssIcon.style.pointerEvents = "none";
      cssIcon.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L4 12L9 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 3L20 12L15 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      cssButton.appendChild(cssIcon);

      htmlButton = document.createElement("button");
      htmlButton.type = "button";
      htmlButton.title = "Załącz pełny HTML elementu do raportu";
      htmlButton.dataset.uiFeedbackRegionId = regionId;
      htmlButton.dataset.uiFeedbackControl = "1";
      htmlButton.style.position = "fixed";
      htmlButton.style.left = "0";
      htmlButton.style.top = "0";
      htmlButton.style.width = "24px";
      htmlButton.style.height = "24px";
      htmlButton.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      htmlButton.style.borderRadius = "7px";
      htmlButton.style.background = "#121a23";
      htmlButton.style.color = "#ffffff";
      htmlButton.style.fontSize = "12px";
      htmlButton.style.lineHeight = "12px";
      htmlButton.style.cursor = "pointer";
      htmlButton.style.zIndex = "2147483647";
      htmlButton.style.padding = "0";
      htmlButton.style.boxShadow = "0 6px 14px rgba(0,0,0,0.35)";
      htmlButton.style.display = "flex";
      htmlButton.style.alignItems = "center";
      htmlButton.style.justifyContent = "center";

      const htmlIcon = document.createElement("span");
      htmlIcon.dataset.uiFeedbackControl = "1";
      htmlIcon.style.display = "inline-flex";
      htmlIcon.style.width = "14px";
      htmlIcon.style.height = "14px";
      htmlIcon.style.pointerEvents = "none";
      htmlIcon.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 7L3 12L8 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 7L21 12L16 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 5L10 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      htmlButton.appendChild(htmlIcon);
    }

    let removeTriggered = false;
    const onRemoveRegion = (event) => {
      if (removeTriggered) {
        return;
      }
      removeTriggered = true;
      event.preventDefault();
      event.stopPropagation();

      safeSendMessage(
        {
          type: "REMOVE_REGION",
          regionId
        },
        (response) => {
          if (chrome.runtime.lastError) {
            removeRegionVisual(regionId);
            sendEvent("ui.region.remove", { regionId, localOnly: true });
            return;
          }
          if (response?.ok) {
            removeRegionVisual(regionId);
            sendEvent("ui.region.remove", { regionId });
            return;
          }

          if (
            response?.error === "Unknown message type." ||
            response?.error === "Nie znaleziono obszaru."
          ) {
            removeRegionVisual(regionId);
            sendEvent("ui.region.remove", { regionId, fallback: true });
          }
        }
      );
    };

    removeButton.addEventListener("pointerdown", onRemoveRegion, true);
    removeButton.addEventListener("click", onRemoveRegion, true);
    noteButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        openRegionEditor(regionItem);
      },
      true
    );
    if (cssButton) {
      cssButton.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          const visual = getRegionVisual(regionId);
          if (visual?.cssAttached) {
            safeSendMessage(
              {
                type: "DETACH_REGION_CSS",
                regionId
              },
              (response) => {
                if (chrome.runtime.lastError || !response?.ok) {
                  if (floatingStatus) {
                    floatingStatus.textContent =
                      response?.error || chrome.runtime.lastError?.message || "Błąd odłączania CSS.";
                    floatingStatus.style.color = "#b42318";
                  }
                  return;
                }
                if (!regionItem.element || typeof regionItem.element !== "object") {
                  regionItem.element = {};
                }
                regionItem.element.cssSnapshot = "";
                regionItem.element.cssSources = [];
                if (visual) {
                  visual.cssAttached = false;
                  applyRegionCssButtonStyle(visual);
                }
                if (floatingStatus) {
                  floatingStatus.textContent = "CSS elementu odłączony.";
                  floatingStatus.style.color = "#0f766e";
                }
                sendEvent("ui.region.css.attach", { regionId, enabled: false });
              }
            );
            return;
          }

          const elementMeta = visual?.elementMeta || regionItem.element || null;
          const element = findElementFromMeta(elementMeta);
          if (!element) {
            if (floatingStatus) {
              floatingStatus.textContent = "Nie znaleziono elementu do pobrania CSS.";
              floatingStatus.style.color = "#b42318";
            }
            return;
          }

          const cssSnapshot = buildComputedCssSnapshot(element);
          const cssSources = collectCssSources(element);
          if (!cssSnapshot) {
            if (floatingStatus) {
              floatingStatus.textContent = "Nie udało się pobrać CSS elementu.";
              floatingStatus.style.color = "#b42318";
            }
            return;
          }

          safeSendMessage(
            {
              type: "ATTACH_REGION_CSS",
              regionId,
              cssSnapshot,
              cssSources
            },
            (response) => {
              if (chrome.runtime.lastError || !response?.ok) {
                if (floatingStatus) {
                  floatingStatus.textContent =
                    response?.error || chrome.runtime.lastError?.message || "Błąd zapisu CSS.";
                  floatingStatus.style.color = "#b42318";
                }
                return;
              }

              if (!regionItem.element || typeof regionItem.element !== "object") {
                regionItem.element = {};
              }
              regionItem.element.cssSnapshot = cssSnapshot;
              regionItem.element.cssSources = cssSources;

              if (visual) {
                visual.cssAttached = true;
                applyRegionCssButtonStyle(visual);
              }

              if (floatingStatus) {
                floatingStatus.textContent = "CSS elementu załączony do raportu.";
                floatingStatus.style.color = "#0f766e";
              }
              sendEvent("ui.region.css.attach", {
                regionId,
                enabled: true,
                cssChars: cssSnapshot.length,
                cssSources: cssSources.length
              });
            }
          );
        },
        true
      );
    }
    if (htmlButton) {
      htmlButton.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          const visual = getRegionVisual(regionId);
          if (visual?.htmlAttached) {
            safeSendMessage(
              {
                type: "DETACH_REGION_HTML",
                regionId
              },
              (response) => {
                if (chrome.runtime.lastError || !response?.ok) {
                  if (floatingStatus) {
                    floatingStatus.textContent =
                      response?.error || chrome.runtime.lastError?.message || "Błąd odłączania HTML.";
                    floatingStatus.style.color = "#b42318";
                  }
                  return;
                }
                if (!regionItem.element || typeof regionItem.element !== "object") {
                  regionItem.element = {};
                }
                regionItem.element.outerHtmlSnippet = "";
                if (visual) {
                  visual.htmlAttached = false;
                  applyRegionHtmlButtonStyle(visual);
                }
                if (floatingStatus) {
                  floatingStatus.textContent = "HTML elementu odłączony.";
                  floatingStatus.style.color = "#0f766e";
                }
                sendEvent("ui.region.html.attach", { regionId, enabled: false });
              }
            );
            return;
          }

          const elementMeta = visual?.elementMeta || regionItem.element || null;
          const element = findElementFromMeta(elementMeta);
          if (!element) {
            if (floatingStatus) {
              floatingStatus.textContent = "Nie znaleziono elementu do pobrania HTML.";
              floatingStatus.style.color = "#b42318";
            }
            return;
          }

          const outerHtmlSnippet = clip(element.outerHTML || "", 200000);
          if (!outerHtmlSnippet) {
            if (floatingStatus) {
              floatingStatus.textContent = "Nie udało się pobrać HTML elementu.";
              floatingStatus.style.color = "#b42318";
            }
            return;
          }

          safeSendMessage(
            {
              type: "ATTACH_REGION_HTML",
              regionId,
              outerHtmlSnippet
            },
            (response) => {
              if (chrome.runtime.lastError || !response?.ok) {
                if (floatingStatus) {
                  floatingStatus.textContent =
                    response?.error || chrome.runtime.lastError?.message || "Błąd zapisu HTML.";
                  floatingStatus.style.color = "#b42318";
                }
                return;
              }

              if (!regionItem.element || typeof regionItem.element !== "object") {
                regionItem.element = {};
              }
              regionItem.element.outerHtmlSnippet = outerHtmlSnippet;

              if (visual) {
                visual.htmlAttached = true;
                applyRegionHtmlButtonStyle(visual);
              }

              if (floatingStatus) {
                floatingStatus.textContent = "HTML elementu załączony do raportu.";
                floatingStatus.style.color = "#0f766e";
              }
              sendEvent("ui.region.html.attach", { regionId, enabled: true, htmlChars: outerHtmlSnippet.length });
            }
          );
        },
        true
      );
    }

    document.documentElement.appendChild(marker);
    document.documentElement.appendChild(removeButton);
    document.documentElement.appendChild(noteButton);
    if (cssButton) {
      document.documentElement.appendChild(cssButton);
    }
    if (htmlButton) {
      document.documentElement.appendChild(htmlButton);
    }
    regionVisuals.set(regionId, {
      marker,
      removeButton,
      noteButton,
      cssButton,
      htmlButton,
      editorBox: null,
      lastSavedNote: null,
      region: { ...region },
      followElement: !!options.followElement,
      followMode,
      elementMeta: regionItem.element || null,
      cssAttached: !!regionItem.element?.cssSnapshot,
      htmlAttached: !!regionItem.element?.outerHtmlSnippet,
      anchorOffsetX: followMode === "offset" && hasAnchorRect
        ? Math.round(regionViewportX - Number(elementRect.x))
        : 0,
      anchorOffsetY: followMode === "offset" && hasAnchorRect
        ? Math.round(regionViewportY - Number(elementRect.y))
        : 0,
      anchorWidth: Math.max(1, Number(region.width || 1)),
      anchorHeight: Math.max(1, Number(region.height || 1)),
      regionItemRef: regionItem
    });
    applyRegionCssButtonStyle(getRegionVisual(regionId));
    applyRegionHtmlButtonStyle(getRegionVisual(regionId));
    updateRegionVisualPosition(regionId);
  }

  function stopRegionMode() {
    regionMode = false;
    drawing = false;
    drawStart = null;
    hideDrawPreview();
    if (interactionLayer) {
      interactionLayer.style.display = "none";
    }
    setCursor(false);
    setScrollLockReason("region", false);
    updateModeButtons();
  }

  function stopElementMode() {
    elementMode = false;
    hideDrawPreview();
    if (!regionMode) {
      setCursor(false);
    }
    setScrollLockReason("element", false);
    updateModeButtons();
  }

  function onMouseDown(event) {
    if (!domainEnabled) {
      return;
    }
    if (!sessionActive || !regionMode || event.button !== 0) {
      return;
    }
    const targetEl = event.target instanceof Element ? event.target : null;
    if (targetEl?.closest("[data-ui-feedback-control='1']")) {
      return;
    }

    drawing = true;
    drawStart = { x: event.clientX, y: event.clientY };
    showDrawPreview({ left: event.clientX, top: event.clientY, width: 1, height: 1 });

    event.preventDefault();
    event.stopPropagation();
  }

  function onMouseMove(event) {
    if (!domainEnabled) {
      return;
    }
    if (!sessionActive) {
      return;
    }

    if (regionMode && drawing && drawStart) {
      const rect = normalizedRect(drawStart.x, drawStart.y, event.clientX, event.clientY);
      showDrawPreview(rect);

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!elementMode) {
      return;
    }

    const targetEl = event.target instanceof Element ? event.target : null;
    if (!targetEl || targetEl.closest("[data-ui-feedback-control='1']")) {
      hideDrawPreview();
      return;
    }

    const rect = targetEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      hideDrawPreview();
      return;
    }
    showDrawPreview({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }

  function onMouseUp(event) {
    if (!domainEnabled) {
      return;
    }
    if (!sessionActive || !regionMode || !drawing || !drawStart) {
      return;
    }

    const rect = normalizedRect(drawStart.x, drawStart.y, event.clientX, event.clientY);
    const tooSmall = rect.width < 8 || rect.height < 8;
    stopRegionMode();

    event.preventDefault();
    event.stopPropagation();

    if (tooSmall) {
      return;
    }

    const centerX = Math.round(rect.left + rect.width / 2);
    const centerY = Math.round(rect.top + rect.height / 2);
    hideDrawPreview();
    if (interactionLayer) {
      interactionLayer.style.display = "none";
    }
    const centerEl = document.elementFromPoint(centerX, centerY);

    const region = buildRegion(rect);
    safeSendMessage(
      {
        type: "REGION_SELECTED",
        region,
        element: elementPayload(centerEl, {
          includeOuterHtml: false,
          maxTextChars: 20000,
          maxOuterHtmlChars: 200000,
          captureMode: "full"
        }),
        url: location.href
      },
      (response) => {
        debugLog("REGION_SELECTED:response", response);
        if (chrome.runtime.lastError) {
          return;
        }
        if (response?.ok && response.selectedRegion) {
          drawPersistentRegion(response.selectedRegion, {
            followElement: true,
            followMode: "offset",
            badgeKind: "obszar"
          });
        }
      }
    );

    sendEvent("ui.region.select", {
      region
    }, elementPayload(centerEl, {
      includeOuterHtml: false,
      maxTextChars: 20000,
      maxOuterHtmlChars: 200000,
      captureMode: "full"
    }));
  }

  function onClickCapture(event) {
    if (!domainEnabled) {
      return;
    }
    if (!sessionActive) {
      return;
    }

    const targetEl = event.target instanceof Element ? event.target : null;
    if (targetEl?.closest("[data-ui-feedback-control='1']")) {
      return;
    }

    if (regionMode || drawing) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (elementMode) {
      event.preventDefault();
      event.stopPropagation();

      if (!targetEl) {
        stopElementMode();
        return;
      }

      const rect = targetEl.getBoundingClientRect();
      const region = buildRegion({
        left: rect.left,
        top: rect.top,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
      });
      const element = elementPayload(targetEl, {
        includeOuterHtml: false,
        maxTextChars: 20000,
        maxOuterHtmlChars: 200000,
        captureMode: "full"
      });

      safeSendMessage(
        {
          type: "ELEMENT_SELECTED",
          element,
          region,
          url: location.href
        },
        (response) => {
          if (chrome.runtime.lastError) {
            if (floatingStatus) {
              floatingStatus.textContent = chrome.runtime.lastError.message || "Błąd wyboru elementu.";
              floatingStatus.style.color = "#b42318";
            }
            return;
          }

          if (response?.ok && response.selectedRegion) {
            drawPersistentRegion(response.selectedRegion, {
              followElement: true,
              badgeKind: "element"
            });
            sendEvent("ui.element.select", { region }, element);
            if (floatingStatus) {
              floatingStatus.textContent = "Element zaznaczony. Dodaj notatkę lub użyj ikon {} (CSS) i </> (HTML).";
              floatingStatus.style.color = "#0f766e";
            }
          } else if (floatingStatus) {
            floatingStatus.textContent = response?.error || "Nie udało się zaznaczyć elementu.";
            floatingStatus.style.color = "#b42318";
          }
        }
      );

      stopElementMode();
      return;
    }

    const target = targetEl;
    sendEvent(
      "ui.click",
      {
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY
      },
      elementPayload(target, {
        includeOuterHtml: false,
        maxTextChars: 120,
        captureMode: "compact"
      })
    );
  }

  function onInputCapture(event) {
    if (!sessionActive) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }
    let value = "";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      value = target.type === "password" ? "[MASKED_PASSWORD]" : target.value;
    } else {
      value = target.value;
    }

    sendEvent(
      "ui.input",
      {
        eventType: event.type,
        value,
        inputType: target instanceof HTMLInputElement ? target.type : target.tagName.toLowerCase(),
        name: target.getAttribute("name") || "",
        id: target.getAttribute("id") || ""
      },
      elementPayload(target, {
        includeOuterHtml: false,
        maxTextChars: 120,
        captureMode: "compact"
      })
    );
  }

  function onScroll() {
    if (!sessionActive) {
      return;
    }

    updateAllRegionVisualPositions();

    if (scrollTimer) {
      clearTimeout(scrollTimer);
    }

    scrollTimer = setTimeout(() => {
      sendEvent("ui.scroll", {
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        viewportW: window.innerWidth,
        viewportH: window.innerHeight
      });
    }, 120);
  }

  function onPageBridgeEvent(event) {
    if (!sessionActive) {
      return;
    }

    const detail = event.detail;
    if (!detail?.kind) {
      return;
    }

    if (detail.kind === "console.error") {
      sendEvent("console.error", detail.payload || {});
      return;
    }

    if (detail.kind === "network.failure") {
      sendEvent("network.failure", detail.payload || {});
      return;
    }

    if (detail.kind === "nav.change") {
      sendEvent("nav.change", detail.payload || {});
    }
  }

  function onWindowError(event) {
    if (!sessionActive) {
      return;
    }

    sendEvent("js.error", {
      message: event.message || "",
      source: event.filename || "",
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || ""
    });
  }

  function onUnhandledRejection(event) {
    if (!sessionActive) {
      return;
    }

    sendEvent("js.unhandledrejection", {
      reason: serializeError(event.reason)
    });
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && (regionMode || elementMode)) {
      if (regionMode) {
        stopRegionMode();
      }
      if (elementMode) {
        stopElementMode();
      }
      if (floatingStatus) {
        floatingStatus.textContent = "Tryb wyboru anulowany.";
        floatingStatus.style.color = "#0f766e";
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!scrollLockActive) {
      return;
    }

    const target = event.target;
    const isEditable =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement &&
        !["button", "checkbox", "radio", "submit", "reset"].includes(
          String(target.type || "").toLowerCase()
        )) ||
      (target instanceof Element && target.isContentEditable);
    if (isEditable) {
      return;
    }

    const isScrollKey =
      event.key === " " ||
      event.code === "Space" ||
      event.key === "PageDown" ||
      event.key === "PageUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "Home" ||
      event.key === "End";

    if (isScrollKey) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onWheel(event) {
    if (!scrollLockActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onTouchMove(event) {
    if (!scrollLockActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onDragStart(event) {
    if (!scrollLockActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onWindowScrollLock() {
    if (!scrollLockActive) {
      return;
    }
    if (window.scrollX !== lockedScrollX || window.scrollY !== lockedScrollY) {
      window.scrollTo(lockedScrollX, lockedScrollY);
    }
  }

  function onWindowResize() {
    applyFloatingCorner();
    updateAllRegionVisualPositions();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "SET_DOMAIN_ENABLED") {
      applyDomainEnabledState(message.enabled !== false);
      sendResponse({
        ok: true,
        enabled: domainEnabled,
        domain: getCurrentDomainKey()
      });
      return true;
    }

    if (message.type === "GET_DOMAIN_ENABLED") {
      sendResponse({
        ok: true,
        enabled: domainEnabled,
        domain: getCurrentDomainKey()
      });
      return true;
    }

    if (message.type === "SET_SESSION_ACTIVE") {
      sessionActive = !!message.enabled;
      if (!sessionActive) {
        showUiOverlaysAfterScreenshot();
        stopRegionMode();
        stopElementMode();
        clearAllRegionVisuals();
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "CLEAR_REGION_VISUALS") {
      clearAllRegionVisuals();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "START_REGION_MODE") {
      if (!domainEnabled) {
        sendResponse({ ok: false, error: "Rozszerzenie jest wyłączone dla tej domeny." });
        return true;
      }
      if (!sessionActive) {
        sendResponse({ ok: false, error: "Sesja nie jest aktywna." });
        return true;
      }
      stopElementMode();
      regionMode = true;
      drawing = false;
      drawStart = null;
      ensureInteractionLayer();
      interactionLayer.style.display = "block";
      setCursor(true);
      setScrollLockReason("region", true);
      if (floatingStatus) {
        floatingStatus.textContent = "Tryb zaznaczania aktywny.";
        floatingStatus.style.color = "#0f766e";
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "START_ELEMENT_MODE") {
      if (!domainEnabled) {
        sendResponse({ ok: false, error: "Rozszerzenie jest wyłączone dla tej domeny." });
        return true;
      }
      if (!sessionActive) {
        sendResponse({ ok: false, error: "Sesja nie jest aktywna." });
        return true;
      }
      stopRegionMode();
      elementMode = true;
      hideDrawPreview();
      setCursor(true);
      setScrollLockReason("element", true);
      if (floatingStatus) {
        floatingStatus.textContent = "Kliknij element na stronie. Domyślnie zapisujemy tylko tekst (bez HTML).";
        floatingStatus.style.color = "#0f766e";
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "PING") {
      sendResponse({
        ok: true,
        sessionActive,
        regionMode,
        elementMode,
        domainEnabled
      });
      return true;
    }

    if (message.type === "SET_OVERLAY_VISIBILITY") {
      const shouldBeVisible = message.visible !== false;
      if (shouldBeVisible) {
        showUiOverlaysAfterScreenshot();
      } else {
        hideUiOverlaysForScreenshot();
      }
      sendResponse({ ok: true, visible: shouldBeVisible });
      return true;
    }

    return false;
  });

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("input", onInputCapture, true);
  document.addEventListener("change", onInputCapture, true);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("scroll", onWindowScrollLock, { capture: true, passive: true });
  window.addEventListener("resize", onWindowResize, { passive: true });
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection, true);
  window.addEventListener("ui-feedback-page-event", onPageBridgeEvent);
  chrome.storage.onChanged.addListener(onStorageChanged);
  initializeUiStateFromStorage().catch(() => {
    domainEnabled = false;
    hideFloatingUi();
  });
})();
