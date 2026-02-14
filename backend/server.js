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

  return { session, timeline, regions, annotations, attachments, exportOptions };
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

function selectKeyTimelineEvents(timeline, maxSteps = 5) {
  const KEY_TYPES = new Set([
    "ui.element.select",
    "ui.region.select",
    "ui.region.note.add",
    "ui.general.info.add",
    "nav.change",
    "js.error",
    "js.unhandledrejection",
    "console.error",
    "network.failure"
  ]);
  const IMPORTANT_TYPES = new Set([
    "ui.region.note.add",
    "ui.general.info.add",
    "js.error",
    "js.unhandledrejection",
    "console.error",
    "network.failure"
  ]);

  const keyEvents = Array.isArray(timeline)
    ? timeline.filter((event) => KEY_TYPES.has(event.type))
    : [];

  // Drop immediate duplicates (same type + same compact selector).
  const deduped = [];
  for (const event of keyEvents) {
    const signature = `${event.type}|${compactElementSelector(event.element)}|${event.url || ""}`;
    const last = deduped[deduped.length - 1];
    if (last && last.__sig === signature) {
      continue;
    }
    deduped.push({ ...event, __sig: signature });
  }

  const important = deduped.filter((event) => IMPORTANT_TYPES.has(event.type));
  const selected = [];
  const addedIds = new Set();

  for (const event of important) {
    if (selected.length >= maxSteps) {
      break;
    }
    selected.push(event);
    if (event.id) {
      addedIds.add(event.id);
    }
  }

  if (selected.length < 3) {
    for (const event of deduped) {
      if (selected.length >= maxSteps) {
        break;
      }
      if (event.id && addedIds.has(event.id)) {
        continue;
      }
      selected.push(event);
      if (event.id) {
        addedIds.add(event.id);
      }
    }
  }

  const trimmed = selected.length > maxSteps
    ? selected.slice(selected.length - maxSteps)
    : selected;

  return trimmed
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
    .map(({ __sig, ...event }) => event);
}

function buildMarkdown(reportId, payload) {
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const keyTimeline = selectKeyTimelineEvents(payload.timeline, 5);
  const oneLine = (value, max = 4000) =>
    clip(String(value || "").replace(/\s+/g, " ").trim(), max);

  const lines = [];
  lines.push(`# UI Feedback Report ${reportId}`);
  lines.push("");
  lines.push(`- Session ID: ${payload.session.id}`);
  lines.push(`- Started: ${payload.session.startedAt || "n/a"}`);
  lines.push(`- Ended: ${payload.session.endedAt || "n/a"}`);
  lines.push(`- URL: ${payload.session.pageContext?.url || "n/a"}`);
  lines.push(`- Title: ${payload.session.pageContext?.title || "n/a"}`);
  if (keyTimeline.length > 0) {
    lines.push("");
    lines.push("## Timeline");
    lines.push("");
    for (const event of keyTimeline) {
      const base = `${event.seq}. [${event.type}] ${event.ts} ${event.url}`;
      lines.push(base);
      const compactSelector = compactElementSelector(event.element);
      if (compactSelector) {
        lines.push(`   element: ${compactSelector}`);
      }
      if (event.causedByEventId) {
        lines.push(`   causedByEventId: ${event.causedByEventId}`);
      }
    }
  }

  lines.push("");
  lines.push("## Regions");
  lines.push("");

  if (regions.length === 0) {
    lines.push("- none");
  } else {
    for (const item of regions) {
      const r = item.region || {};
      lines.push(`- [${item.ts}] ${item.url}`);
      lines.push(`  - Region: x=${r.pageX || 0}, y=${r.pageY || 0}, w=${r.width || 0}, h=${r.height || 0}`);
      const compactSelector = compactElementSelector(item.element);
      if (compactSelector) {
        lines.push(`  - Center element: ${compactSelector}`);
      }
      if (item.element?.cssSnapshot) {
        lines.push("  - CSS attached: yes");
      }
      if (item.element?.outerHtmlSnippet) {
        lines.push("  - HTML attached: yes");
      }
    }
  }

  lines.push("");
  lines.push("## Annotations");
  lines.push("");

  if (annotations.length === 0) {
    lines.push("- none");
  } else {
    for (const item of annotations) {
      lines.push(`- [${item.ts}] ${item.comment}`);
      if (item.scope === "general") {
        lines.push("  - Scope: General");
      }
      lines.push(`  - URL: ${item.url}`);
      if (item.region) {
        lines.push(`  - Region: x=${item.region.pageX || 0}, y=${item.region.pageY || 0}, w=${item.region.width || 0}, h=${item.region.height || 0}`);
      }
      if (item.regionId) {
        lines.push(`  - Region ID: ${item.regionId}`);
      }
      const compactSelector = compactElementSelector(item.element);
      if (compactSelector) {
        lines.push(`  - Element: ${compactSelector}`);
      }
      if (item.element?.text) {
        lines.push(`  - Element text: ${oneLine(item.element.text, 280)}`);
      }
      if (item.element?.cssSnapshot) {
        lines.push("  - Element CSS (attached):");
        lines.push("```css");
        lines.push(String(item.element.cssSnapshot));
        lines.push("```");
        if (Array.isArray(item.element.cssSources) && item.element.cssSources.length > 0) {
          lines.push("  - CSS sources:");
          for (const src of item.element.cssSources.slice(0, 20)) {
            const href = src.stylesheetHref || "[unknown]";
            const selector = src.selector || "[selector?]";
            const media = src.media ? ` @media ${src.media}` : "";
            const sourceType = src.sourceType ? `${src.sourceType}` : "stylesheet";
            lines.push(`    - ${sourceType}: ${href} | ${selector}${media}`);
          }
        }
      }
      if (item.element?.outerHtmlSnippet) {
        lines.push("  - Element HTML (attached):");
        lines.push("```html");
        lines.push(String(item.element.outerHtmlSnippet));
        lines.push("```");
      }
      if (item.linkedEventId) {
        lines.push(`  - Linked event: ${item.linkedEventId}`);
      }
      if (item.screenshotId) {
        lines.push(`  - Screenshot: ${item.screenshotId}`);
      }
    }
  }

  lines.push("");
  lines.push("## Attachments");
  lines.push("");
  lines.push(`- Count: ${attachments.length}`);
  lines.push("");

  return lines.join("\n");
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

  if (config.writeMarkdown) {
    const markdown = buildMarkdown(reportId, payload);
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
