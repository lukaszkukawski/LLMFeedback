(() => {
  if (window.__UI_FEEDBACK_PAGE_HOOKS_INSTALLED__) {
    return;
  }
  window.__UI_FEEDBACK_PAGE_HOOKS_INSTALLED__ = true;

  const clip = (value, maxLen = 1200) => {
    const text = String(value == null ? "" : value);
    if (text.length <= maxLen) {
      return text;
    }
    return `${text.slice(0, maxLen)}...[truncated]`;
  };

  const captureCallerStack = () => {
    try {
      const stack = new Error().stack || "";
      const lines = stack.split("\n").slice(2, 8);
      return clip(lines.join(" | "), 1200);
    } catch {
      return "";
    }
  };

  const serializeErrorLike = (value) => {
    if (!value || typeof value !== "object") {
      return null;
    }

    const base = {
      name: clip(value.name || ""),
      message: clip(value.message || ""),
      code: clip(value.code || ""),
      stack: clip(value.stack || "", 2000)
    };

    if (value.config && typeof value.config === "object") {
      base.config = {
        method: clip(value.config.method || ""),
        url: clip(value.config.url || ""),
        baseURL: clip(value.config.baseURL || "")
      };
    }

    if (value.response && typeof value.response === "object") {
      base.response = {
        status: value.response.status,
        statusText: clip(value.response.statusText || ""),
        url: clip(value.response.config?.url || "")
      };
    }

    return base;
  };

  const emit = (kind, payload) => {
    window.dispatchEvent(
      new CustomEvent("ui-feedback-page-event", {
        detail: {
          kind,
          payload
        }
      })
    );
  };

  const toText = (value) => {
    if (value == null) {
      return "Unknown error";
    }
    if (typeof value === "string") {
      return clip(value);
    }
    if (value instanceof Error) {
      return clip(`${value.name}: ${value.message}`);
    }
    try {
      return clip(JSON.stringify(value));
    } catch {
      return clip(String(value));
    }
  };

  const originalConsoleError = console.error;
  console.error = function patchedConsoleError(...args) {
    try {
      const firstErrorArg = args.find((arg) => arg instanceof Error || (arg && typeof arg === "object")) || null;
      emit("console.error", {
        message: args.map(toText).join(" "),
        args: args.slice(0, 6).map(toText),
        error: serializeErrorLike(firstErrorArg),
        callerStack: captureCallerStack()
      });
    } catch {
      // ignore
    }
    return originalConsoleError.apply(this, args);
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const method = (init && init.method) || "GET";
      const url = typeof input === "string" ? input : (input && input.url) || "";
      try {
        const response = await originalFetch.apply(this, [input, init]);
        if (!response.ok) {
          emit("network.failure", {
            transport: "fetch",
            method,
            url,
            status: response.status,
            statusText: response.statusText,
            callerStack: captureCallerStack()
          });
        }
        return response;
      } catch (error) {
        emit("network.failure", {
          transport: "fetch",
          method,
          url,
          status: "FETCH_THROW",
          message: toText(error),
          error: serializeErrorLike(error),
          callerStack: captureCallerStack()
        });
        throw error;
      }
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__uiFeedbackMeta = {
      method: method || "GET",
      url: String(url || "")
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    this.addEventListener("loadend", () => {
      const status = this.status;
      if (status === 0 || status >= 400) {
        emit("network.failure", {
          transport: "xhr",
          method: (this.__uiFeedbackMeta && this.__uiFeedbackMeta.method) || "GET",
          url: (this.__uiFeedbackMeta && this.__uiFeedbackMeta.url) || "",
          status,
          statusText: this.statusText || "",
          responseURL: this.responseURL || "",
          callerStack: captureCallerStack()
        });
      }
    });

    return originalSend.apply(this, args);
  };

  const originalPushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    emit("nav.change", { source: "history.pushState", url: location.href });
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    emit("nav.change", { source: "history.replaceState", url: location.href });
    return result;
  };

  window.addEventListener("popstate", () => {
    emit("nav.change", { source: "window.popstate", url: location.href });
  });

  window.addEventListener("hashchange", () => {
    emit("nav.change", { source: "window.hashchange", url: location.href });
  });
})();
