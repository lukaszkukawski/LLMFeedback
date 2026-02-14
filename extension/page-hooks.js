(() => {
  if (window.__UI_FEEDBACK_PAGE_HOOKS_INSTALLED__) {
    return;
  }
  window.__UI_FEEDBACK_PAGE_HOOKS_INSTALLED__ = true;

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
      return value;
    }
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const originalConsoleError = console.error;
  console.error = function patchedConsoleError(...args) {
    try {
      emit("console.error", { message: args.map(toText).join(" ") });
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
            statusText: response.statusText
          });
        }
        return response;
      } catch (error) {
        emit("network.failure", {
          transport: "fetch",
          method,
          url,
          status: "FETCH_THROW",
          message: toText(error)
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
          statusText: this.statusText || ""
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
