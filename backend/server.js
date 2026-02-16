const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const PORT = Number(process.env.PORT || 3030);
const HOST = "127.0.0.1";

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw);
  return {
    outputDir: path.resolve(__dirname, cfg.outputDir || "./reports"),
    writeMarkdown: cfg.writeMarkdown !== false,
    maxOuterHtmlChars: Number(cfg.maxOuterHtmlChars || 200000),
    maxCssChars: Number(cfg.maxCssChars || 40000),
    maxTextChars: Number(cfg.maxTextChars || 20000),
    maxAttachmentChars: Number(cfg.maxAttachmentChars || 5000000),
    maskPasswordInputs: cfg.maskPasswordInputs !== false,
    sensitivePatterns: (cfg.sensitivePatterns || []).map((pattern) => new RegExp(pattern, "gi"))
  };
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

function maskString(input, config) {
  if (typeof input !== "string") {
    return input;
  }

  let output = input;
  for (const regex of config.sensitivePatterns) {
    output = output.replace(regex, "[MASKED]");
  }
  return output;
}

function sanitizeData(value, config) {
  if (typeof value === "string") {
    return maskString(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeData(item, config));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = sanitizeData(item, config);
    }
    return next;
  }
  return value;
}

function sanitizeElement(element, config) {
  if (!element || typeof element !== "object") {
    return null;
  }

  const next = {
    cssSelector: clip(maskString(element.cssSelector || "", config), 500),
    xpath: clip(maskString(element.xpath || "", config), 1000),
    text: clip(maskString(element.text || "", config), config.maxTextChars),
    outerHtmlSnippet: clip(maskString(element.outerHtmlSnippet || "", config), config.maxOuterHtmlChars),
    cssSnapshot: clip(maskString(element.cssSnapshot || "", config), config.maxCssChars),
    cssSources: Array.isArray(element.cssSources)
      ? element.cssSources.slice(0, 80).map((item) => ({
          sourceType: clip(maskString(String(item?.sourceType || ""), config), 40),
          stylesheetHref: clip(maskString(String(item?.stylesheetHref || ""), config), 500),
          selector: clip(maskString(String(item?.selector || ""), config), 500),
          media: clip(maskString(String(item?.media || ""), config), 200)
        }))
      : [],
    rect: element.rect || null,
    tagName: element.tagName || null,
    inputType: element.inputType || null
  };

  if (config.maskPasswordInputs && String(next.inputType || "").toLowerCase() === "password") {
    next.text = "[MASKED_PASSWORD]";
    next.outerHtmlSnippet = "[MASKED_PASSWORD_INPUT]";
  }

  return next;
}

function sanitizeRegion(region) {
  if (!region || typeof region !== "object") {
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

function sanitizePayload(payload, config) {
  const timeline = Array.isArray(payload.timeline)
    ? payload.timeline.map((event) => ({
        id: event.id || null,
        seq: Number(event.seq || 0),
        ts: event.ts || nowIso(),
        type: event.type || "unknown",
        url: maskString(event.url || "", config),
        element: sanitizeElement(event.element, config),
        data: sanitizeData(event.data || {}, config),
        causedByEventId: event.causedByEventId || null
      }))
    : [];

  const regions = Array.isArray(payload.regions)
    ? payload.regions.map((item) => ({
        id: item.id || null,
        ts: item.ts || nowIso(),
        url: maskString(item.url || "", config),
        region: sanitizeRegion(item.region),
        element: sanitizeElement(item.element, config)
      }))
    : [];

  const annotations = Array.isArray(payload.annotations)
    ? payload.annotations.map((item) => ({
        id: item.id || null,
        ts: item.ts || nowIso(),
        url: maskString(item.url || "", config),
        comment: clip(maskString(item.comment || "", config), 4000),
        scope: item.scope === "general" ? "general" : "region",
        regionId: item.regionId || null,
        region: sanitizeRegion(item.region),
        element: sanitizeElement(item.element, config),
        linkedEventId: item.linkedEventId || null,
        screenshotId: item.screenshotId || null
      }))
    : [];

  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((item) => {
        const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
        return {
          id: item.id || null,
          type: item.type || "application/octet-stream",
          source: item.source || "unknown",
          ts: item.ts || nowIso(),
          dataUrl: dataUrl.length > config.maxAttachmentChars ? "[TRUNCATED_ATTACHMENT]" : dataUrl
        };
      })
    : [];

  const session = {
    ...(payload.session || {}),
    id: payload.session?.id || `session_${Date.now()}`,
    startedAt: payload.session?.startedAt || nowIso(),
    endedAt: payload.session?.endedAt || null,
    pageContext: {
      url: maskString(payload.session?.pageContext?.url || "", config),
      title: clip(maskString(payload.session?.pageContext?.title || "", config), 500)
    },
    settings: sanitizeData(payload.session?.settings || {}, config)
  };

  const exportOptions =
    payload.exportOptions && typeof payload.exportOptions === "object"
      ? {
          fileName: clip(maskString(String(payload.exportOptions.fileName || ""), config), 200)
        }
      : null;

  return {
    session,
    timeline,
    regions,
    annotations,
    attachments,
    exportOptions
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Payload must be a JSON object.";
  }
  if (!payload.session || typeof payload.session !== "object") {
    return "Missing session object.";
  }
  if (!Array.isArray(payload.timeline)) {
    return "Missing timeline array.";
  }
  if (!Array.isArray(payload.annotations)) {
    return "Missing annotations array.";
  }
  if (payload.regions && !Array.isArray(payload.regions)) {
    return "Invalid regions array.";
  }
  if (!Array.isArray(payload.attachments)) {
    return "Missing attachments array.";
  }
  if (payload.exportOptions && typeof payload.exportOptions !== "object") {
    return "Invalid exportOptions.";
  }
  return null;
}

function compactCssSelector(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }

  const collapsed = raw.replace(/\s+/g, " ");
  const parts = collapsed.split(">").map((p) => p.trim()).filter(Boolean);
  const tail = parts.length > 2 ? parts.slice(parts.length - 2) : parts;
  const compact = tail.join(" > ");
  return clip(compact, 180);
}

function compactXpath(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }

  const parts = raw.split("/").filter(Boolean);
  const tail = parts.length > 3 ? parts.slice(parts.length - 3) : parts;
  return clip(`/${tail.join("/")}`, 180);
}

function compactElementSelector(element) {
  if (!element || typeof element !== "object") {
    return "";
  }
  return compactCssSelector(element.cssSelector) || compactXpath(element.xpath);
}

function normalizeForMatch(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toUrlPath(input) {
  try {
    const value = String(input || "");
    if (!value) {
      return "";
    }
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(input || "");
  }
}

function limitBullets(items, max) {
  const result = [];
  const seen = new Set();
  for (const raw of items || []) {
    const value = String(raw || "").trim();
    if (!value) {
      continue;
    }
    const sig = value.toLowerCase();
    if (seen.has(sig)) {
      continue;
    }
    seen.add(sig);
    result.push(value);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

function parseTimestampMs(input) {
  const parsed = Date.parse(String(input || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeNoteTitle(note) {
  const clean = String(note || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "Uwagi do poprawy UI";
  }
  return clip(clean, 96);
}

function inferIssuePriority(notes) {
  const text = normalizeForMatch((notes || []).join(" "));
  if (/(crash|fatal|wywala|wywal[a-z]* blad|blokuje|nie dziala wcale|error 5\d\d)/.test(text)) {
    return "P0";
  }
  if (/(blad|error|bug|problem|nie dziala|nie mozna|nie da sie)/.test(text)) {
    return "P1";
  }
  return "P2";
}

function inferIssueType(notes) {
  const text = normalizeForMatch((notes || []).join(" "));
  if (/(logika|oblicz|wylicz|suma|procent|walidac)/.test(text)) {
    return "logic";
  }
  if (/(css|html|layout|widok|screenshot|screen|obszar|element|przycisk|ikona)/.test(text)) {
    return "ui";
  }
  return "ux";
}

function formatTrackerEventData(type, data) {
  const payload = data && typeof data === "object" ? data : {};

  if (type === "console.error") {
    return String(payload.message || "console.error");
  }
  if (type === "js.error") {
    return String(payload.message || "js.error");
  }
  if (type === "js.unhandledrejection") {
    return String(payload.reason || "Unhandled rejection");
  }
  if (type === "network.failure") {
    const method = String(payload.method || "GET");
    const url = String(payload.url || "");
    const status = payload.status != null ? String(payload.status) : "";
    return [method, url, status].filter(Boolean).join(" ");
  }
  if (type === "ui.click") {
    return `click x=${Number(payload.clientX || 0)} y=${Number(payload.clientY || 0)}`;
  }
  if (type === "ui.input") {
    const inputType = String(payload.inputType || "");
    const value = clip(String(payload.value || ""), 80);
    return `${inputType}${value ? ` value=${value}` : ""}`.trim();
  }
  if (type === "ui.scroll") {
    return `scroll x=${Number(payload.scrollX || 0)} y=${Number(payload.scrollY || 0)}`;
  }
  if (type === "nav.change") {
    return String(payload.url || payload.source || "nav.change");
  }
  return "";
}

function selectTrackerEvents(timeline, maxItems = 12) {
  const TRACKER_EVENT_TYPES = new Set([
    "ui.click",
    "ui.input",
    "ui.scroll",
    "nav.change",
    "console.error",
    "network.failure",
    "js.error",
    "js.unhandledrejection"
  ]);

  if (!Array.isArray(timeline) || timeline.length === 0) {
    return [];
  }

  const filtered = timeline.filter((event) => TRACKER_EVENT_TYPES.has(String(event?.type || "")));
  const tail = filtered.length > maxItems ? filtered.slice(filtered.length - maxItems) : filtered;

  return tail.map((event) => ({
    ts: String(event?.ts || ""),
    type: String(event?.type || "unknown"),
    urlPath: toUrlPath(event?.url || ""),
    details: formatTrackerEventData(String(event?.type || ""), event?.data || {})
  }));
}

function collectIssueDrafts(payload, maxIssues, maxBulletsPerSection) {
  const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  const grouped = new Map();
  const dedupe = new Set();
  let duplicatesRemoved = 0;

  for (const item of annotations) {
    const note = String(item?.comment || "").trim();
    if (!note) {
      continue;
    }

    const selector = compactElementSelector(item?.element) || String(item?.element?.tagName || "");
    const urlPath = toUrlPath(item?.url || payload.session?.pageContext?.url || "");
    const dedupeKey = `${normalizeForMatch(note)}|${normalizeForMatch(selector)}|${urlPath}`;
    if (dedupe.has(dedupeKey)) {
      duplicatesRemoved += 1;
      continue;
    }
    dedupe.add(dedupeKey);

    const sectionKey = selector || String(item?.regionId || item?.scope || "general");
    const groupKey = `${urlPath}|${sectionKey}`;
    const tsMs = parseTimestampMs(item?.ts);

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        urlPath,
        notes: [],
        noteEntries: [],
        selectors: new Set(),
        screenshots: new Set(),
        relatedCount: 0,
        scope: String(item?.scope || "region"),
        component: String(item?.element?.tagName || "Unknown"),
        section: selector || String(item?.scope || "general"),
        lastTsMs: tsMs
      });
    }

    const group = grouped.get(groupKey);
    group.notes.push(note);
    group.noteEntries.push({ note, tsMs });
    group.relatedCount += 1;
    group.lastTsMs = Math.max(group.lastTsMs, tsMs);
    if (selector) {
      group.selectors.add(selector);
    }
    if (item?.screenshotId) {
      group.screenshots.add(String(item.screenshotId));
    }
  }

  const drafts = [];
  const groups = Array.from(grouped.values());
  groups.sort((a, b) => b.lastTsMs - a.lastTsMs);

  const newestTsMs = groups.length > 0 ? groups[0].lastTsMs : 0;
  const recentWindowMs = 60 * 60 * 1000;
  const recentGroups =
    newestTsMs > 0
      ? groups.filter((group) => group.lastTsMs >= newestTsMs - recentWindowMs)
      : groups;
  const sourceGroups = recentGroups.length > 0 ? recentGroups : groups;

  for (const group of sourceGroups.slice(0, maxIssues)) {
    const orderedNotes = group.noteEntries
      .slice()
      .sort((a, b) => b.tsMs - a.tsMs)
      .map((entry) => entry.note);
    const sourceNotes = limitBullets(orderedNotes, maxBulletsPerSection);
    const title = summarizeNoteTitle(sourceNotes[0] || "");
    const type = inferIssueType(sourceNotes);
    const priority = inferIssuePriority(sourceNotes);

    drafts.push({
      priority,
      type,
      title,
      urlPath: group.urlPath,
      component: group.component || "Unknown",
      section: group.section || group.scope || "general",
      selectors: Array.from(group.selectors).slice(0, 2),
      sourceNotes,
      screenshots: Array.from(group.screenshots).slice(0, 2),
      relatedAnnotationsCount: group.relatedCount
    });
  }

  return {
    drafts,
    totalAnnotations: annotations.length,
    duplicatesRemoved
  };
}

function buildMarkdown(reportId, payload, screenshotFileMap = {}) {
  const maxIssues = 3;
  const maxBulletsPerSection = 3;
  const issues = collectIssueDrafts(payload, maxIssues, maxBulletsPerSection).drafts;
  const trackerEvents = selectTrackerEvents(payload.timeline, 12);
  const buildVersion = payload.session?.settings?.buildVersion || "n/a";
  const language = "pl";
  const appUrl = payload.session?.pageContext?.url || "";

  const lines = [];
  lines.push("# UI Feedback Report (Deterministic)");
  lines.push("");
  lines.push("## Meta");
  lines.push(`- report_id: ${reportId}`);
  lines.push(`- session_id: ${payload.session?.id || "n/a"}`);
  lines.push(`- app_url: ${appUrl || "n/a"}`);
  lines.push(`- generated_at: ${nowIso()}`);
  lines.push(`- build_version: ${buildVersion}`);
  lines.push(`- language: ${language}`);
  lines.push("");
  lines.push("## Executive Summary");

  if (issues.length === 0) {
    lines.push("1. [P2][ux] Brak issue do raportowania (brak adnotacji).\n");
  } else {
    issues.forEach((item, idx) => {
      lines.push(`${idx + 1}. [${item.priority}][${item.type}] ${item.title}`);
    });
    lines.push("");
  }

  lines.push("## Issues");
  lines.push("");

  issues.forEach((item, idx) => {
    const issueId = `ISSUE-${String(idx + 1).padStart(3, "0")}`;
    lines.push(`### ${issueId}`);
    lines.push(`- priority: ${item.priority}`);
    lines.push(`- type: ${item.type}`);
    lines.push(`- title: ${item.title}`);
    lines.push(`- related_annotations_count: ${item.relatedAnnotationsCount || 0}`);
    lines.push("- source_notes:");

    const sourceNotes = limitBullets(item.sourceNotes, maxBulletsPerSection);
    if (sourceNotes.length === 0) {
      lines.push('  - "-"');
    } else {
      sourceNotes.forEach((note) => lines.push(`  - "${note}"`));
    }

    lines.push("");
    lines.push("#### Scope");
    lines.push(`- url: ${item.urlPath || toUrlPath(appUrl) || "n/a"}`);
    lines.push(`- component: ${item.component || "Unknown"}`);
    lines.push(`- section: ${item.section || "Unknown"}`);
    lines.push("- selectors:");
    if (item.selectors.length === 0) {
      lines.push("  - n/a");
    } else {
      item.selectors.forEach((selector) => lines.push(`  - ${selector}`));
    }

    lines.push("");
    lines.push("#### Evidence");
    lines.push("- screenshots:");
    if (item.screenshots.length === 0) {
      lines.push("  - none");
    } else {
      item.screenshots.forEach((shot) => {
        const mapped = screenshotFileMap[shot];
        if (mapped) {
          lines.push(`  - ${mapped} (${shot})`);
          return;
        }
        lines.push(`  - ${shot}`);
      });
    }

    lines.push("");
  });

  if (trackerEvents.length > 0) {
    lines.push("## Rejestr zdarzen i bledow");
    lines.push("");
    trackerEvents.forEach((event, index) => {
      const parts = [
        `${index + 1}.`,
        event.type,
        event.urlPath ? `@ ${event.urlPath}` : "",
        event.details ? `- ${event.details}` : ""
      ].filter(Boolean);
      const tsLabel = event.ts ? ` (${event.ts})` : "";
      lines.push(`${parts.join(" ")}${tsLabel}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    return null;
  }
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  try {
    return {
      mime: String(match[1] || "").toLowerCase(),
      buffer: Buffer.from(match[2], "base64")
    };
  } catch {
    return null;
  }
}

function mimeToExtension(mime) {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return map[mime] || "bin";
}

async function exportScreenshotFiles(payload, outputDir, reportId) {
  const screenshotFileMap = {};
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (attachments.length === 0) {
    return screenshotFileMap;
  }

  const assetsDirName = `${reportId}-assets`;
  const assetsDir = path.join(outputDir, assetsDirName);
  let assetsDirReady = false;

  for (const item of attachments) {
    const attachmentId = String(item?.id || "").trim();
    if (!attachmentId) {
      continue;
    }
    const parsed = parseDataUrl(item?.dataUrl);
    if (!parsed || !parsed.mime.startsWith("image/")) {
      continue;
    }

    if (!assetsDirReady) {
      await fsp.mkdir(assetsDir, { recursive: true });
      assetsDirReady = true;
    }

    const ext = mimeToExtension(parsed.mime);
    const fileName = `${attachmentId}.${ext}`;
    const filePath = path.join(assetsDir, fileName);
    await fsp.writeFile(filePath, parsed.buffer);
    screenshotFileMap[attachmentId] = path.join(assetsDirName, fileName).replace(/\\/g, "/");
  }

  return screenshotFileMap;
}

async function writeReport(payload, config) {
  await fsp.mkdir(config.outputDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const defaultReportId = `${stamp}-${payload.session.id}`;

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
    return clip(stem, 120);
  };

  const requestedStem = sanitizeFileStem(payload.exportOptions?.fileName || "");
  const baseStem = requestedStem || `report-${defaultReportId}`;

  let finalStem = baseStem;
  let suffix = 1;
  while (true) {
    const candidateJson = path.join(config.outputDir, `${finalStem}.json`);
    const candidateMd = path.join(config.outputDir, `${finalStem}.md`);
    const jsonExists = fs.existsSync(candidateJson);
    const mdExists = config.writeMarkdown ? fs.existsSync(candidateMd) : false;
    if (!jsonExists && !mdExists) {
      break;
    }
    finalStem = `${baseStem}-${suffix}`;
    suffix += 1;
  }

  const reportId = finalStem;
  const jsonPath = path.join(config.outputDir, `${finalStem}.json`);
  const mdPath = path.join(config.outputDir, `${finalStem}.md`);

  await fsp.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  const screenshotFileMap = await exportScreenshotFiles(payload, config.outputDir, finalStem);

  if (config.writeMarkdown) {
    const markdown = buildMarkdown(reportId, payload, screenshotFileMap);
    await fsp.writeFile(mdPath, markdown, "utf8");
  }

  return {
    reportId,
    jsonPath,
    markdownPath: config.writeMarkdown ? mdPath : null
  };
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET"
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true, status: "healthy" });
    return;
  }

  if (req.method === "POST" && req.url === "/analyze") {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        req.socket.destroy();
      }
    });

    req.on("end", async () => {
      const parsed = safeJsonParse(raw);
      if (!parsed) {
        writeJson(res, 400, { ok: false, error: "INVALID_JSON" });
        return;
      }

      const validationError = validatePayload(parsed);
      if (validationError) {
        writeJson(res, 400, { ok: false, error: "INVALID_PAYLOAD", message: validationError });
        return;
      }

      try {
        const config = loadConfig();
        const sanitized = sanitizePayload(parsed, config);
        const result = await writeReport(sanitized, config);

        writeJson(res, 200, {
          ok: true,
          reportId: result.reportId,
          jsonPath: result.jsonPath,
          markdownPath: result.markdownPath
        });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: "WRITE_FAILED", message: error.message });
      }
    });

    return;
  }

  writeJson(res, 404, { ok: false, error: "NOT_FOUND" });
});

server.listen(PORT, HOST, () => {
  console.log(`UI feedback backend listening on http://${HOST}:${PORT}`);
});
