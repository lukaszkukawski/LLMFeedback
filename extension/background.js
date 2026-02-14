const STORAGE_KEY = "uiFeedbackState";
const CORRELATION_WINDOW_MS = 10_000;
const LOCAL_API_URL = "http://127.0.0.1:3030/analyze";
const DEBUG_LOGS = true;

const DEFAULT_STATE = {
  sessionActive: false,
  tabId: null,
  windowId: null,
  nextSeq: 1,
  session: null,
  timeline: [],
  regions: [],
  annotations: [],
  attachments: [],
  selectedRegion: null,
  lastUiEvent: null,
  queuedExports: []
};

function debugLog(...args) {
  if (!DEBUG_LOGS) {
    return;
  }
  console.log("[ui-feedback/background]", ...args);
}

async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = { ...DEFAULT_STATE, ...(result[STORAGE_KEY] || {}) };
  return {
    ...raw,
    sessionActive: !!raw.sessionActive,
    timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
    regions: Array.isArray(raw.regions) ? raw.regions : [],
    annotations: Array.isArray(raw.annotations) ? raw.annotations : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    queuedExports: Array.isArray(raw.queuedExports) ? raw.queuedExports : [],
    selectedRegion:
      raw.selectedRegion && typeof raw.selectedRegion === "object" ? raw.selectedRegion : null
  };
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

let stateMutationQueue = Promise.resolve();

async function mutateState(mutator) {
  const run = async () => {
    const state = await getState();
    const result = await mutator(state);
    await setState(state);
    return result;
  };

  const queued = stateMutationQueue.then(run, run);
  stateMutationQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clip(value, maxLen) {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen)}...[truncated]`;
}

function maskSensitiveString(input) {
  if (typeof input !== "string") {
    return input;
  }

  const jwtRegex = /(?:Bearer\s+)?[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  const bearerRegex = /Bearer\s+[A-Za-z0-9._~-]{16,}/gi;
  const apiKeyRegex = /(api[_-]?key\s*[=:]\s*)([A-Za-z0-9._-]{12,})/gi;
  const tokenRegex = /(token\s*[=:]\s*)([A-Za-z0-9._-]{12,})/gi;

  return input
    .replace(jwtRegex, "[MASKED_JWT]")
    .replace(bearerRegex, "Bearer [MASKED_TOKEN]")
    .replace(apiKeyRegex, "$1[MASKED_API_KEY]")
    .replace(tokenRegex, "$1[MASKED_TOKEN]");
}

function sanitizeValue(value) {
  if (typeof value === "string") {
    return maskSensitiveString(clip(value, 4000));
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = sanitizeValue(item);
    }
    return next;
  }
  return value;
}

function normalizeElement(element) {
  if (!element) {
    return null;
  }

  const captureMode = element.captureMode === "full" ? "full" : "compact";
  const textLimit = captureMode === "full" ? 20000 : 300;
  const htmlLimit = captureMode === "full" ? 200000 : 4000;
  const cssLimit = captureMode === "full" ? 40000 : 12000;

  return {
    cssSelector: clip(element.cssSelector || "", 500),
    xpath: clip(element.xpath || "", 1000),
    text: clip(element.text || "", textLimit),
    outerHtmlSnippet: clip(element.outerHtmlSnippet || "", htmlLimit),
    cssSnapshot: clip(element.cssSnapshot || "", cssLimit),
    cssSources: Array.isArray(element.cssSources)
      ? element.cssSources.slice(0, 80).map((item) => ({
          sourceType: clip(String(item?.sourceType || ""), 40),
          stylesheetHref: clip(String(item?.stylesheetHref || ""), 500),
          selector: clip(String(item?.selector || ""), 500),
          media: clip(String(item?.media || ""), 200)
        }))
      : [],
    captureMode,
    rect: element.rect || null,
    tagName: element.tagName || null,
    inputType: element.inputType || null
  };
}

function normalizeRegion(region) {
  if (!region) {
    return null;
  }

  return {
    pageX: Number(region.pageX || 0),
    pageY: Number(region.pageY || 0),
    width: Number(region.width || 0),
    height: Number(region.height || 0),
    viewportX: Number(region.viewportX || 0),
    viewportY: Number(region.viewportY || 0),
    scrollX: Number(region.scrollX || 0),
    scrollY: Number(region.scrollY || 0),
    viewportW: Number(region.viewportW || 0),
    viewportH: Number(region.viewportH || 0)
  };
}

function buildEvent(state, payload) {
  return {
    id: makeId("evt"),
    seq: state.nextSeq,
    ts: nowIso(),
    type: payload.type,
    url: payload.url || state.session?.pageContext?.url || "",
    element: normalizeElement(payload.element),
    data: sanitizeValue(payload.data || {})
  };
}

async function appendTimelineEvent(payload) {
  return mutateState((state) => {
    if (!state.sessionActive || payload.tabId !== state.tabId || !state.session) {
      return { ignored: true };
    }

    const event = buildEvent(state, payload);

    const isUiEvent = payload.type.startsWith("ui.") || payload.type === "nav.change";
    const isErrorEvent = [
      "js.error",
      "js.unhandledrejection",
      "console.error",
      "network.failure"
    ].includes(payload.type);

    if (isErrorEvent && state.lastUiEvent) {
      const diffMs = Date.now() - state.lastUiEvent.epochMs;
      if (diffMs <= CORRELATION_WINDOW_MS) {
        event.causedByEventId = state.lastUiEvent.id;
      }
    }

    state.timeline.push(event);
    state.nextSeq += 1;

    if (isUiEvent) {
      state.lastUiEvent = {
        id: event.id,
        epochMs: Date.now()
      };
    }

    return { event };
  });
}

async function ensureRecorderInjected(tabId, sessionEnabled = null) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page-hooks.js"],
    world: "MAIN"
  });

  if (typeof sessionEnabled === "boolean") {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "SET_SESSION_ACTIVE",
        enabled: sessionEnabled
      });
    } catch (error) {
      // Tab may navigate while script injection settles.
    }
  }
}

function createEmptySession(tab) {
  return {
    id: makeId("session"),
    startedAt: nowIso(),
    endedAt: null,
    pageContext: {
      url: tab.url || "",
      title: tab.title || ""
    },
    settings: {
      correlationWindowMs: CORRELATION_WINDOW_MS,
      areaSelectionMode: "manual-draw",
      videoRecording: false,
      sensitiveMasking: "password-and-token"
    }
  };
}

async function initSession(tab, reset = false) {
  const state = await mutateState((state) => {
    const mustReset = reset || !state.session;

    if (mustReset) {
      state.nextSeq = 1;
      state.timeline = [];
      state.regions = [];
      state.annotations = [];
      state.attachments = [];
      state.selectedRegion = null;
      state.lastUiEvent = null;
      state.session = createEmptySession(tab);
    } else {
      state.session.pageContext = {
        url: tab.url || state.session.pageContext?.url || "",
        title: tab.title || state.session.pageContext?.title || ""
      };
    }

    state.sessionActive = true;
    state.tabId = tab.id;
    state.windowId = tab.windowId;
    return state;
  });

  debugLog("INIT_SESSION", {
    reset,
    tabId: tab.id,
    sessionId: state.session?.id
  });
  await ensureRecorderInjected(tab.id, true);
  if (reset) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_REGION_VISUALS" });
    } catch (error) {
      // Content script may not be ready yet.
    }
  }

  return state;
}

async function addRegionSelection({ tabId, url, region, element }) {
  return mutateState((state) => {
    debugLog("REGION_SELECTED:request", {
      tabId,
      activeTabId: state.tabId,
      sessionActive: state.sessionActive,
      sessionId: state.session?.id
    });
    if (!state.session || !state.sessionActive || tabId !== state.tabId) {
      debugLog("REGION_SELECTED:rejected", {
        reason: "invalid-session-or-tab",
        tabId,
        activeTabId: state.tabId
      });
      return { ok: false, error: "Brak aktywnej sesji dla tej karty." };
    }

    const normalizedRegion = normalizeRegion(region);
    if (!normalizedRegion || normalizedRegion.width < 8 || normalizedRegion.height < 8) {
      return { ok: false, error: "Niepoprawny obszar zaznaczenia." };
    }

    const item = {
      id: makeId("region"),
      ts: nowIso(),
      url: url || state.session.pageContext.url,
      region: normalizedRegion,
      element: normalizeElement(element)
    };

    state.regions.push(item);
    state.selectedRegion = item;

    debugLog("REGION_SELECTED:stored", {
      regionId: item.id,
      regionsCount: state.regions.length
    });
    return { ok: true, selectedRegion: item };
  });
}

async function addAnnotation({ comment, tabId }) {
  return mutateState((state) => {
    if (!state.session || !state.sessionActive || tabId !== state.tabId) {
      return { ok: false, error: "Brak aktywnej sesji dla tej karty." };
    }

    const text = (comment || "").trim();
    if (!text) {
      return { ok: false, error: "Notatka jest wymagana." };
    }

    if (!state.selectedRegion) {
      const fallbackRegion =
        state.regions.length > 0 ? state.regions[state.regions.length - 1] : null;
      if (!fallbackRegion) {
        return { ok: false, error: "Najpierw zaznacz obszar na stronie." };
      }
      state.selectedRegion = fallbackRegion;
    }

    const annotation = {
      id: makeId("ann"),
      ts: nowIso(),
      url: state.selectedRegion.url || state.session.pageContext.url,
      comment: sanitizeValue(text),
      regionId: state.selectedRegion.id,
      region: state.selectedRegion.region,
      element: normalizeElement(state.selectedRegion.element),
      linkedEventId: state.lastUiEvent?.id || null,
      screenshotId: null
    };

    state.annotations.push(annotation);
    state.selectedRegion = null;

    return { ok: true, annotation };
  });
}

async function addGeneralInfo({ tabId, comment, url }) {
  return mutateState((state) => {
    if (!state.session || !state.sessionActive || tabId !== state.tabId) {
      return { ok: false, error: "Brak aktywnej sesji dla tej karty." };
    }

    const text = (comment || "").trim();
    if (!text) {
      return { ok: false, error: "Notatka jest wymagana." };
    }

    const annotation = {
      id: makeId("ann"),
      ts: nowIso(),
      url: url || state.session.pageContext.url,
      comment: sanitizeValue(text),
      scope: "general",
      regionId: null,
      region: null,
      element: null,
      linkedEventId: state.lastUiEvent?.id || null,
      screenshotId: null
    };

    state.annotations.push(annotation);
    return { ok: true, annotation };
  });
}

async function attachRegionCss({ tabId, regionId, cssSnapshot, cssSources }) {
  return mutateState((state) => {
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }
    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const cssText = String(cssSnapshot || "").trim();
    if (!cssText) {
      return { ok: false, error: "Brak danych CSS do zapisania." };
    }

    const region = state.regions.find((item) => item.id === regionId);
    if (!region) {
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    const mergedElement = {
      ...(region.element || {}),
      captureMode: "full",
      cssSnapshot: cssText,
      cssSources: Array.isArray(cssSources) ? cssSources : region.element?.cssSources || [],
      outerHtmlSnippet: region.element?.outerHtmlSnippet || ""
    };
    region.element = normalizeElement(mergedElement);

    state.annotations = state.annotations.map((item) => {
      if (item.regionId !== regionId) {
        return item;
      }
      const mergedAnnotationElement = {
        ...(item.element || {}),
        ...(region.element || {}),
        captureMode: "full"
      };
      return {
        ...item,
        element: normalizeElement(mergedAnnotationElement)
      };
    });

    if (state.selectedRegion?.id === regionId) {
      state.selectedRegion = region;
    }

    return {
      ok: true,
      regionId,
      cssChars: region.element?.cssSnapshot?.length || 0
    };
  });
}

async function detachRegionCss({ tabId, regionId }) {
  return mutateState((state) => {
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }
    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const region = state.regions.find((item) => item.id === regionId);
    if (!region) {
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    const mergedElement = {
      ...(region.element || {}),
      captureMode: "full",
      cssSnapshot: "",
      cssSources: [],
      outerHtmlSnippet: region.element?.outerHtmlSnippet || ""
    };
    region.element = normalizeElement(mergedElement);

    state.annotations = state.annotations.map((item) => {
      if (item.regionId !== regionId) {
        return item;
      }
      const mergedAnnotationElement = {
        ...(item.element || {}),
        ...(region.element || {}),
        captureMode: "full"
      };
      return {
        ...item,
        element: normalizeElement(mergedAnnotationElement)
      };
    });

    if (state.selectedRegion?.id === regionId) {
      state.selectedRegion = region;
    }

    return { ok: true, regionId };
  });
}

async function attachRegionHtml({ tabId, regionId, outerHtmlSnippet }) {
  return mutateState((state) => {
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }
    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const htmlText = String(outerHtmlSnippet || "").trim();
    if (!htmlText) {
      return { ok: false, error: "Brak danych HTML do zapisania." };
    }

    const region = state.regions.find((item) => item.id === regionId);
    if (!region) {
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    const mergedElement = {
      ...(region.element || {}),
      captureMode: "full",
      cssSnapshot: region.element?.cssSnapshot || "",
      cssSources: region.element?.cssSources || [],
      outerHtmlSnippet: htmlText
    };
    region.element = normalizeElement(mergedElement);

    state.annotations = state.annotations.map((item) => {
      if (item.regionId !== regionId) {
        return item;
      }
      const mergedAnnotationElement = {
        ...(item.element || {}),
        ...(region.element || {}),
        captureMode: "full"
      };
      return {
        ...item,
        element: normalizeElement(mergedAnnotationElement)
      };
    });

    if (state.selectedRegion?.id === regionId) {
      state.selectedRegion = region;
    }

    return {
      ok: true,
      regionId,
      htmlChars: region.element?.outerHtmlSnippet?.length || 0
    };
  });
}

async function detachRegionHtml({ tabId, regionId }) {
  return mutateState((state) => {
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }
    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const region = state.regions.find((item) => item.id === regionId);
    if (!region) {
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    const mergedElement = {
      ...(region.element || {}),
      captureMode: "full",
      cssSnapshot: region.element?.cssSnapshot || "",
      outerHtmlSnippet: ""
    };
    region.element = normalizeElement(mergedElement);

    state.annotations = state.annotations.map((item) => {
      if (item.regionId !== regionId) {
        return item;
      }
      const mergedAnnotationElement = {
        ...(item.element || {}),
        ...(region.element || {}),
        captureMode: "full"
      };
      return {
        ...item,
        element: normalizeElement(mergedAnnotationElement)
      };
    });

    if (state.selectedRegion?.id === regionId) {
      state.selectedRegion = region;
    }

    return { ok: true, regionId };
  });
}

async function addAnnotationForRegion({ tabId, regionId, comment, regionSnapshot, element, url }) {
  return mutateState((state) => {
    debugLog("ADD_ANNOTATION_FOR_REGION:request", {
      tabId,
      activeTabId: state.tabId,
      sessionActive: state.sessionActive,
      regionId,
      regionsCount: state.regions.length
    });
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }

    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const text = (comment || "").trim();
    if (!text) {
      return { ok: false, error: "Notatka jest wymagana." };
    }

    let region = state.regions.find((item) => item.id === regionId);
    if (!region && regionSnapshot) {
      const recovered = {
        id: regionId || makeId("region"),
        ts: nowIso(),
        url: url || state.session.pageContext.url,
        region: normalizeRegion(regionSnapshot),
        element: normalizeElement(element)
      };
      if (recovered.region) {
        state.regions.push(recovered);
        region = recovered;
        debugLog("ADD_ANNOTATION_FOR_REGION:recovered-region", {
          regionId: recovered.id,
          regionsCount: state.regions.length
        });
      }
    }

    if (!region) {
      debugLog("ADD_ANNOTATION_FOR_REGION:missing-region", {
        regionId,
        knownRegions: state.regions.map((x) => x.id)
      });
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    const annotation = {
      id: makeId("ann"),
      ts: nowIso(),
      url: region.url || state.session.pageContext.url,
      comment: sanitizeValue(text),
      regionId: region.id,
      region: region.region,
      element: normalizeElement(region.element),
      linkedEventId: state.lastUiEvent?.id || null,
      screenshotId: null
    };

    state.annotations.push(annotation);
    state.selectedRegion = region;

    debugLog("ADD_ANNOTATION_FOR_REGION:stored", {
      annotationId: annotation.id,
      regionId,
      annotationsCount: state.annotations.length
    });
    return { ok: true, annotation };
  });
}

async function getRegionNote({ tabId, regionId }) {
  const state = await getState();
  if (!state.session) {
    return { ok: false, error: "Brak sesji." };
  }
  if (tabId != null && state.tabId != null && tabId !== state.tabId) {
    return { ok: false, error: "Nieprawidłowa karta sesji." };
  }

  for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
    const item = state.annotations[i];
    if (item && item.regionId === regionId && typeof item.comment === "string") {
      return { ok: true, comment: item.comment };
    }
  }

  return { ok: true, comment: "" };
}

async function addLegacyElementSelection({ tabId, url, element, regionSnapshot }) {
  return mutateState((state) => {
    if (!state.session || !state.sessionActive || tabId !== state.tabId) {
      return { ok: false, error: "Brak aktywnej sesji dla tej karty." };
    }

    const rect = element?.rect || null;
    if (!rect || typeof rect.width !== "number" || typeof rect.height !== "number") {
      return { ok: false, error: "Brak poprawnego rect elementu." };
    }

    const normalizedRegion = normalizeRegion(regionSnapshot);
    const region =
      normalizedRegion ||
      {
        pageX: Math.round((rect.x || 0) + (state.lastUiEvent?.scrollX || 0)),
        pageY: Math.round((rect.y || 0) + (state.lastUiEvent?.scrollY || 0)),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        viewportX: Math.round(rect.x || 0),
        viewportY: Math.round(rect.y || 0),
        scrollX: 0,
        scrollY: 0,
        viewportW: 0,
        viewportH: 0
      };

    const item = {
      id: makeId("region"),
      ts: nowIso(),
      url: url || state.session.pageContext.url,
      region,
      element: normalizeElement(element)
    };

    state.regions.push(item);
    state.selectedRegion = item;
    return { ok: true, selectedRegion: item, legacy: true };
  });
}

async function removeRegion({ tabId, regionId }) {
  return mutateState((state) => {
    debugLog("REMOVE_REGION:request", {
      tabId,
      activeTabId: state.tabId,
      regionId,
      regionsCount: state.regions.length
    });
    if (!state.session) {
      return { ok: false, error: "Brak sesji." };
    }

    // Allow delete even if worker restarted and `sessionActive` is temporarily false.
    if (tabId != null && state.tabId != null && tabId !== state.tabId) {
      return { ok: false, error: "Nieprawidłowa karta sesji." };
    }

    const index = state.regions.findIndex((item) => item.id === regionId);
    if (index < 0) {
      return { ok: false, error: "Nie znaleziono obszaru." };
    }

    state.regions.splice(index, 1);
    const beforeCount = state.annotations.length;
    state.annotations = state.annotations.filter((item) => item.regionId !== regionId);
    const removedAnnotations = beforeCount - state.annotations.length;

    if (state.selectedRegion?.id === regionId) {
      state.selectedRegion = null;
    }

    debugLog("REMOVE_REGION:done", {
      regionId,
      regionsCount: state.regions.length,
      removedAnnotations
    });
    return { ok: true, regionId, removedAnnotations };
  });
}

function buildPayload(state, options = {}) {
  const payload = {
    session: state.session,
    timeline: state.timeline,
    regions: state.regions,
    annotations: state.annotations,
    attachments: state.attachments
  };
  const fileName = String(options.fileName || "").trim();
  if (fileName) {
    payload.exportOptions = { fileName };
  }
  return payload;
}

async function queueExport(reason, payload) {
  return mutateState((state) => {
    const queued = {
      id: makeId("queue"),
      ts: nowIso(),
      reason,
      payload: payload || buildPayload(state)
    };
    state.queuedExports.push(queued);
    return queued;
  });
}

async function exportToBackend(fileName = "") {
  const state = await getState();
  if (!state.session) {
    return { ok: false, error: "Brak sesji do eksportu." };
  }

  const payload = buildPayload(state, { fileName });

  try {
    const response = await fetch(LOCAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      const queued = await queueExport("backend-error", payload);
      return {
        ok: false,
        error: body.error || `HTTP ${response.status}`,
        queuedId: queued.id
      };
    }

    return {
      ok: true,
      result: body
    };
  } catch (error) {
    const queued = await queueExport("network-error", payload);
    return {
      ok: false,
      error: error.message,
      queuedId: queued.id
    };
  }
}

async function exportSessionJsonDownload() {
  const state = await getState();
  if (!state.session) {
    return { ok: false, error: "Brak sesji do eksportu." };
  }

  const payload = buildPayload(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);

  const fileName = `ui-feedback-${Date.now()}.json`;
  await chrome.downloads.download({
    url,
    filename: fileName,
    saveAs: true
  });

  setTimeout(() => URL.revokeObjectURL(url), 3_000);
  return { ok: true, fileName };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "INIT_SESSION": {
          const tab = message.tab;
          if (!tab?.id) {
            sendResponse({ ok: false, error: "Brak aktywnej karty." });
            return;
          }
          const state = await initSession(tab, !!message.reset);
          sendResponse({ ok: true, state });
          return;
        }

        case "INIT_SESSION_FROM_CONTENT": {
          const tab = sender.tab;
          if (!tab?.id) {
            sendResponse({ ok: false, error: "Brak aktywnej karty." });
            return;
          }
          const state = await initSession(
            {
              id: tab.id,
              windowId: tab.windowId,
              url: tab.url || "",
              title: tab.title || ""
            },
            !!message.reset
          );
          sendResponse({ ok: true, state });
          return;
        }

        case "GET_STATE": {
          const state = await getState();
          sendResponse({ ok: true, state });
          return;
        }

        case "TIMELINE_EVENT": {
          const result = await appendTimelineEvent({
            ...message.event,
            tabId: sender.tab?.id
          });
          sendResponse({ ok: true, result });
          return;
        }

        case "REGION_SELECTED": {
          const result = await addRegionSelection({
            tabId: sender.tab?.id,
            url: message.url,
            region: message.region,
            element: message.element
          });
          sendResponse(result);
          return;
        }

        case "ELEMENT_SELECTED": {
          const result = await addLegacyElementSelection({
            tabId: sender.tab?.id,
            url: message.url || sender.tab?.url || "",
            element: message.element,
            regionSnapshot: message.region
          });
          sendResponse(result);
          return;
        }

        case "ADD_ANNOTATION": {
          const result = await addAnnotation({
            comment: message.comment,
            tabId: sender.tab?.id || message.tabId
          });
          sendResponse(result);
          return;
        }

        case "ADD_GENERAL_INFO": {
          const result = await addGeneralInfo({
            tabId: sender.tab?.id || message.tabId,
            comment: message.comment,
            url: message.url || sender.tab?.url || ""
          });
          sendResponse(result);
          return;
        }

        case "ATTACH_REGION_CSS": {
          const result = await attachRegionCss({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || ""),
            cssSnapshot: message.cssSnapshot || "",
            cssSources: Array.isArray(message.cssSources) ? message.cssSources : []
          });
          sendResponse(result);
          return;
        }

        case "DETACH_REGION_CSS": {
          const result = await detachRegionCss({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || "")
          });
          sendResponse(result);
          return;
        }

        case "ATTACH_REGION_HTML": {
          const result = await attachRegionHtml({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || ""),
            outerHtmlSnippet: message.outerHtmlSnippet || ""
          });
          sendResponse(result);
          return;
        }

        case "DETACH_REGION_HTML": {
          const result = await detachRegionHtml({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || "")
          });
          sendResponse(result);
          return;
        }

        case "ADD_ANNOTATION_FOR_REGION": {
          const result = await addAnnotationForRegion({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || ""),
            comment: message.comment,
            regionSnapshot: message.region,
            element: message.element,
            url: message.url
          });
          sendResponse(result);
          return;
        }

        case "GET_REGION_NOTE": {
          const result = await getRegionNote({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || "")
          });
          sendResponse(result);
          return;
        }

        case "REMOVE_REGION": {
          const result = await removeRegion({
            tabId: sender.tab?.id || message.tabId,
            regionId: String(message.regionId || "")
          });
          sendResponse(result);
          return;
        }

        case "EXPORT_TO_BACKEND": {
          const result = await exportToBackend(message.fileName || "");
          sendResponse(result);
          return;
        }

        case "EXPORT_JSON_FILE": {
          const result = await exportSessionJsonDownload();
          sendResponse(result);
          return;
        }

        default:
          sendResponse({
            ok: false,
            error: "Unknown message type.",
            messageType: String(message?.type || "")
          });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await mutateState((state) => {
    if (state.tabId !== tabId) {
      return;
    }

    state.sessionActive = false;
    if (state.session && !state.session.endedAt) {
      state.session.endedAt = nowIso();
    }
  });
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) {
    return;
  }

  const state = await getState();
  if (!state.sessionActive || details.tabId !== state.tabId) {
    return;
  }

  await appendTimelineEvent({
    tabId: details.tabId,
    type: "nav.change",
    url: details.url,
    data: {
      transitionType: details.transitionType,
      transitionQualifiers: details.transitionQualifiers || []
    }
  });

  setTimeout(() => {
    ensureRecorderInjected(details.tabId, true).catch(() => {});
  }, 250);
});
