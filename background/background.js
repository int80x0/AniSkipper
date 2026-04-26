(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime) {
    return;
  }

  const STORAGE_KEYS = {
    skipSeconds: "aniskipper.skipSeconds",
    allowedSites: "aniskipper.allowedSites"
  };
  const DEFAULT_SKIP_SECONDS = 90;
  const MIN_SKIP_SECONDS = 5;
  const MAX_SKIP_SECONDS = 600;

  function clampSkipSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_SKIP_SECONDS;
    }
    return Math.min(MAX_SKIP_SECONDS, Math.max(MIN_SKIP_SECONDS, Math.round(parsed)));
  }

  function normalizePath(pathname) {
    const path = pathname || "/";
    if (path === "/") {
      return "/";
    }
    return path.replace(/\/+$/, "");
  }

  function canonicalizeSiteRule(rawValue, forceRoot = false) {
    if (typeof rawValue !== "string") {
      return null;
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let url;
    try {
      url = new URL(candidate);
    } catch (_error) {
      return null;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const normalizedPath = forceRoot ? "/" : normalizePath(url.pathname);
    return `${url.origin}${normalizedPath === "/" ? "/" : normalizedPath}`;
  }

  function dedupeSiteRules(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const unique = new Set();
    for (const entry of value) {
      const normalized = canonicalizeSiteRule(String(entry));
      if (normalized) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  function isUrlAllowed(urlString, rules) {
    const normalizedRules = dedupeSiteRules(rules);
    if (normalizedRules.length === 0 || typeof urlString !== "string") {
      return false;
    }

    let pageUrl;
    try {
      pageUrl = new URL(urlString);
    } catch (_error) {
      return false;
    }

    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
      return false;
    }

    const pageOrigin = pageUrl.origin;
    const pagePath = normalizePath(pageUrl.pathname);

    for (const rule of normalizedRules) {
      const ruleUrl = new URL(rule);
      if (ruleUrl.origin !== pageOrigin) {
        continue;
      }

      const rulePath = normalizePath(ruleUrl.pathname);
      if (rulePath === "/") {
        return true;
      }
      if (pagePath === rulePath || pagePath.startsWith(`${rulePath}/`)) {
        return true;
      }
    }

    return false;
  }

  async function storageGet(keys) {
    if (!api.storage?.local) {
      return {};
    }
    const maybePromise = api.storage.local.get(keys);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
    return new Promise((resolve) => api.storage.local.get(keys, resolve));
  }

  async function tabsQuery(queryInfo) {
    if (!api.tabs?.query) {
      return [];
    }
    const maybePromise = api.tabs.query(queryInfo);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
    return new Promise((resolve) => api.tabs.query(queryInfo, resolve));
  }

  async function tabsSendMessage(tabId, message, options) {
    if (!api.tabs?.sendMessage) {
      return null;
    }
    const maybePromise = api.tabs.sendMessage(tabId, message, options);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
    return new Promise((resolve, reject) => {
      api.tabs.sendMessage(tabId, message, options, (response) => {
        const runtimeError = api.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function webNavigationGetAllFrames(details) {
    if (!api.webNavigation?.getAllFrames) {
      return [];
    }
    const maybePromise = api.webNavigation.getAllFrames(details);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
    return new Promise((resolve) => api.webNavigation.getAllFrames(details, resolve));
  }

  async function resolveSettings() {
    const values = await storageGet([STORAGE_KEYS.skipSeconds, STORAGE_KEYS.allowedSites]);
    return {
      skipSeconds: clampSkipSeconds(values[STORAGE_KEYS.skipSeconds]),
      allowedSites: dedupeSiteRules(values[STORAGE_KEYS.allowedSites])
    };
  }

  async function getActiveTab() {
    const activeTabs = await tabsQuery({ active: true, currentWindow: true });
    if (!activeTabs || activeTabs.length === 0 || typeof activeTabs[0].id !== "number") {
      return null;
    }
    return activeTabs[0];
  }

  async function getActiveTabState() {
    const activeTab = await getActiveTab();
    if (!activeTab) {
      return {
        ok: false,
        error: "Kein aktiver Tab gefunden"
      };
    }

    const settings = await resolveSettings();
    const allowed = isUrlAllowed(activeTab.url, settings.allowedSites);

    return {
      ok: true,
      tabId: activeTab.id,
      url: activeTab.url,
      allowed,
      settings
    };
  }

  async function collectFrameIds(tabId) {
    try {
      const frames = await webNavigationGetAllFrames({ tabId });
      if (!frames || frames.length === 0) {
        return [0];
      }
      const ids = frames
        .map((frame) => frame.frameId)
        .filter((frameId) => Number.isInteger(frameId));
      ids.sort((a, b) => a - b);
      if (!ids.includes(0)) {
        ids.unshift(0);
      }
      return Array.from(new Set(ids));
    } catch (_error) {
      return [0];
    }
  }

  async function collectFrameResponses(tabId, message) {
    const frameIds = await collectFrameIds(tabId);
    const responses = [];

    for (const frameId of frameIds) {
      try {
        const response = await tabsSendMessage(tabId, message, { frameId });
        responses.push({ ok: true, frameId, response });
      } catch (error) {
        responses.push({
          ok: false,
          frameId,
          error: error instanceof Error ? error.message : "Frame-Kommunikation fehlgeschlagen"
        });
      }
    }

    return responses;
  }

  async function pingActiveTab() {
    const state = await getActiveTabState();
    if (!state.ok) {
      return state;
    }
    if (!state.allowed) {
      return {
        ok: true,
        allowed: false,
        hasVideo: false
      };
    }

    const responses = await collectFrameResponses(state.tabId, { type: "ANISKIPPER_PING" });
    const successful = responses.filter((entry) => entry.ok && entry.response);

    if (successful.length === 0) {
      return {
        ok: false,
        error: "Seite unterstützt keine Content-Skripte"
      };
    }

    const hasVideo = successful.some((entry) => Boolean(entry.response.hasVideo));
    return {
      ok: true,
      allowed: true,
      hasVideo
    };
  }

  async function sendSkipToActiveTab(customSeconds) {
    const state = await getActiveTabState();
    if (!state.ok) {
      return state;
    }
    if (!state.allowed) {
      return {
        ok: false,
        error: "Seite nicht erlaubt. Füge die Seite zuerst in AniSkipper hinzu."
      };
    }

    const seconds = clampSkipSeconds(customSeconds ?? state.settings.skipSeconds);
    const responses = await collectFrameResponses(state.tabId, {
      type: "ANISKIPPER_SKIP",
      seconds
    });

    let lastError = "Kein passender Video-Player gefunden";
    for (const entry of responses) {
      if (!entry.ok) {
        continue;
      }
      if (entry.response?.ok) {
        return { ok: true };
      }
      if (entry.response?.error) {
        lastError = entry.response.error;
      }
    }

    return {
      ok: false,
      error: lastError
    };
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ANISKIPPER_SKIP_ACTIVE_TAB") {
      (async () => {
        const result = await sendSkipToActiveTab(message.seconds);
        if (typeof sendResponse === "function") {
          sendResponse(result);
        }
      })();
      return true;
    }

    if (message.type === "ANISKIPPER_GET_ACTIVE_TAB_STATUS") {
      (async () => {
        const state = await getActiveTabState();
        if (!state.ok) {
          sendResponse(state);
          return;
        }
        sendResponse({
          ok: true,
          tabId: state.tabId,
          url: state.url,
          allowed: state.allowed
        });
      })();
      return true;
    }

    if (message.type === "ANISKIPPER_PING_ACTIVE_TAB") {
      (async () => {
        const result = await pingActiveTab();
        if (typeof sendResponse === "function") {
          sendResponse(result);
        }
      })();
      return true;
    }

    if (message.type === "ANISKIPPER_IS_SITE_ALLOWED") {
      (async () => {
        const settings = await resolveSettings();
        const tabUrl = sender?.tab?.url;
        sendResponse({
          ok: true,
          allowed: isUrlAllowed(tabUrl, settings.allowedSites),
          tabUrl
        });
      })();
      return true;
    }
  });
})();
