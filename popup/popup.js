(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime) {
    return;
  }

  const STORAGE_KEYS = {
    skipSeconds: "aniskipper.skipSeconds",
    hotkey: "aniskipper.hotkey",
    allowedSites: "aniskipper.allowedSites",
    overlaySide: "aniskipper.overlaySide"
  };
  const DEFAULT_SKIP_SECONDS = 90;
  const MIN_SKIP_SECONDS = 5;
  const MAX_SKIP_SECONDS = 600;
  const DEFAULT_HOTKEY = "Alt+Shift+KeyS";
  const DEFAULT_OVERLAY_SIDE = "left";

  const statusEl = document.getElementById("status");
  const skipSecondsEl = document.getElementById("skipSeconds");
  const overlaySideEl = document.getElementById("overlaySide");
  const skipNowEl = document.getElementById("skipNow");
  const hotkeyDisplayEl = document.getElementById("hotkeyDisplay");
  const captureHotkeyEl = document.getElementById("captureHotkey");
  const resetHotkeyEl = document.getElementById("resetHotkey");
  const siteInputEl = document.getElementById("siteInput");
  const addSiteManualEl = document.getElementById("addSiteManual");
  const addCurrentSiteEl = document.getElementById("addCurrentSite");
  const siteListEl = document.getElementById("siteList");

  let allowedSites = [];
  let activeTab = null;
  let isCapturingHotkey = false;
  let currentHotkey = parseHotkey(DEFAULT_HOTKEY);

  function detectLanguage() {
    const uiLanguage =
      (typeof api.i18n?.getUILanguage === "function" && api.i18n.getUILanguage()) ||
      globalThis.navigator?.language ||
      "en";
    const normalized = String(uiLanguage).toLowerCase();
    return normalized.startsWith("de") ? "de" : "en";
  }

  function t(key, substitutions) {
    const message =
      typeof api.i18n?.getMessage === "function" ? api.i18n.getMessage(key, substitutions) : "";
    return message || key;
  }

  function localizeStaticText() {
    document.documentElement.lang = detectLanguage();

    for (const element of document.querySelectorAll("[data-i18n]")) {
      const key = element.getAttribute("data-i18n");
      if (!key) {
        continue;
      }
      element.textContent = t(key);
    }

    for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
      const key = element.getAttribute("data-i18n-placeholder");
      if (!key) {
        continue;
      }
      element.setAttribute("placeholder", t(key));
    }

    for (const element of document.querySelectorAll("[data-i18n-alt]")) {
      const key = element.getAttribute("data-i18n-alt");
      if (!key) {
        continue;
      }
      element.setAttribute("alt", t(key));
    }
  }

  function normalizeOverlaySide(value) {
    if (value === "right") {
      return "right";
    }
    return DEFAULT_OVERLAY_SIDE;
  }

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

  function parseHotkey(rawValue) {
    if (typeof rawValue !== "string") {
      return parseHotkey(DEFAULT_HOTKEY);
    }

    const tokens = rawValue
      .split("+")
      .map((entry) => entry.trim())
      .filter(Boolean);

    const nextHotkey = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      code: ""
    };

    for (const token of tokens) {
      const lowerToken = token.toLowerCase();
      if (lowerToken === "ctrl" || lowerToken === "control") {
        nextHotkey.ctrl = true;
        continue;
      }
      if (lowerToken === "alt") {
        nextHotkey.alt = true;
        continue;
      }
      if (lowerToken === "shift") {
        nextHotkey.shift = true;
        continue;
      }
      if (lowerToken === "meta" || lowerToken === "cmd" || lowerToken === "command") {
        nextHotkey.meta = true;
        continue;
      }
      nextHotkey.code = token;
    }

    if (!nextHotkey.code || !/^([A-Za-z0-9_]+)$/.test(nextHotkey.code)) {
      return parseHotkey(DEFAULT_HOTKEY);
    }
    if (!nextHotkey.ctrl && !nextHotkey.alt && !nextHotkey.shift && !nextHotkey.meta) {
      return parseHotkey(DEFAULT_HOTKEY);
    }

    return nextHotkey;
  }

  function serializeHotkey(hotkey) {
    const parts = [];
    if (hotkey.ctrl) {
      parts.push("Ctrl");
    }
    if (hotkey.alt) {
      parts.push("Alt");
    }
    if (hotkey.shift) {
      parts.push("Shift");
    }
    if (hotkey.meta) {
      parts.push("Meta");
    }
    parts.push(hotkey.code);
    return parts.join("+");
  }

  function codeToLabel(code) {
    if (!code) {
      return "";
    }
    if (code.startsWith("Key") && code.length === 4) {
      return code.slice(3);
    }
    if (code.startsWith("Digit") && code.length === 6) {
      return code.slice(5);
    }
    if (code.startsWith("Numpad")) {
      return code.replace("Numpad", "Num");
    }
    if (code.startsWith("Arrow")) {
      return code.replace("Arrow", "");
    }
    return code;
  }

  function formatHotkeyForUi(hotkey) {
    const parts = [];
    if (hotkey.ctrl) {
      parts.push("Ctrl");
    }
    if (hotkey.alt) {
      parts.push("Alt");
    }
    if (hotkey.shift) {
      parts.push("Shift");
    }
    if (hotkey.meta) {
      parts.push("Meta");
    }
    parts.push(codeToLabel(hotkey.code));
    return parts.join("+");
  }

  function buildHotkeyFromEvent(event) {
    const code = event.code || "";
    if (
      !code ||
      code.startsWith("Shift") ||
      code.startsWith("Control") ||
      code.startsWith("Alt") ||
      code.startsWith("Meta")
    ) {
      return null;
    }

    const hotkey = {
      ctrl: Boolean(event.ctrlKey),
      alt: Boolean(event.altKey),
      shift: Boolean(event.shiftKey),
      meta: Boolean(event.metaKey),
      code
    };

    if (!hotkey.ctrl && !hotkey.alt && !hotkey.shift && !hotkey.meta) {
      return null;
    }
    return hotkey;
  }

  function setStatus(text, type = "neutral") {
    statusEl.textContent = text;
    if (type === "ok") {
      statusEl.style.color = "#86efac";
      return;
    }
    if (type === "error") {
      statusEl.style.color = "#fca5a5";
      return;
    }
    statusEl.style.color = "#cbd5e1";
  }

  function renderHotkey() {
    hotkeyDisplayEl.value = formatHotkeyForUi(currentHotkey);
  }

  function updateCaptureButtonLabel() {
    captureHotkeyEl.textContent = isCapturingHotkey ? t("buttonCapturePressKeys") : t("buttonChange");
  }

  function renderAllowedSites() {
    siteListEl.innerHTML = "";

    if (allowedSites.length === 0) {
      const empty = document.createElement("li");
      empty.className = "site-item";
      empty.textContent = t("sitesEmpty");
      siteListEl.appendChild(empty);
      return;
    }

    for (const siteRule of allowedSites) {
      const item = document.createElement("li");
      item.className = "site-item";

      const code = document.createElement("code");
      code.textContent = siteRule;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "remove-site";
      removeButton.textContent = "×";
      removeButton.title = t("buttonRemoveSite");
      removeButton.addEventListener("click", async () => {
        allowedSites = allowedSites.filter((entry) => entry !== siteRule);
        renderAllowedSites();
        await persistSettings();
      });

      item.appendChild(code);
      item.appendChild(removeButton);
      siteListEl.appendChild(item);
    }
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

  async function storageSet(values) {
    if (!api.storage?.local) {
      return;
    }
    const maybePromise = api.storage.local.set(values);
    if (maybePromise && typeof maybePromise.then === "function") {
      await maybePromise;
      return;
    }
    await new Promise((resolve) => api.storage.local.set(values, resolve));
  }

  async function runtimeSendMessage(message) {
    const maybePromise = api.runtime.sendMessage(message);
    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
    return new Promise((resolve, reject) => {
      api.runtime.sendMessage(message, (response) => {
        const runtimeError = api.runtime?.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function getActiveTabStatus() {
    try {
      const response = await runtimeSendMessage({
        type: "ANISKIPPER_GET_ACTIVE_TAB_STATUS"
      });
      if (!response || response.ok !== true) {
        return {
          ok: false,
          error: response?.error || t("statusNoActiveTab")
        };
      }
      return response;
    } catch (_error) {
      return {
        ok: false,
        error: t("statusActivePageReadError")
      };
    }
  }

  async function loadSettings() {
    const values = await storageGet([
      STORAGE_KEYS.skipSeconds,
      STORAGE_KEYS.hotkey,
      STORAGE_KEYS.allowedSites,
      STORAGE_KEYS.overlaySide
    ]);
    skipSecondsEl.value = String(clampSkipSeconds(values[STORAGE_KEYS.skipSeconds]));
    overlaySideEl.value = normalizeOverlaySide(values[STORAGE_KEYS.overlaySide]);
    currentHotkey = parseHotkey(values[STORAGE_KEYS.hotkey] || DEFAULT_HOTKEY);
    allowedSites = dedupeSiteRules(values[STORAGE_KEYS.allowedSites]);
    renderHotkey();
    renderAllowedSites();
  }

  async function refreshStatus() {
    const tabStatus = await getActiveTabStatus();
    if (!tabStatus.ok) {
      activeTab = null;
      setStatus(tabStatus.error || t("statusNoActiveTab"), "error");
      return;
    }

    activeTab = {
      id: tabStatus.tabId,
      url: tabStatus.url
    };

    if (!tabStatus.allowed) {
      setStatus(t("statusPageNotEnabled"), "neutral");
      return;
    }

    try {
      const ping = await runtimeSendMessage({ type: "ANISKIPPER_PING_ACTIVE_TAB" });
      if (!ping?.ok) {
        setStatus(ping?.error || t("statusReadFailed"), "error");
        return;
      }
      if (!ping.allowed) {
        setStatus(t("statusPageNotEnabled"), "neutral");
        return;
      }
      if (ping.hasVideo) {
        setStatus(t("statusPlayerDetected"), "ok");
      } else {
        setStatus(t("statusNoPlayerDetected"), "neutral");
      }
    } catch (_error) {
      setStatus(t("statusReadFailed"), "error");
    }
  }

  async function persistSettings() {
    const nextSkipSeconds = clampSkipSeconds(skipSecondsEl.value);
    skipSecondsEl.value = String(nextSkipSeconds);

    await storageSet({
      [STORAGE_KEYS.skipSeconds]: nextSkipSeconds,
      [STORAGE_KEYS.hotkey]: serializeHotkey(currentHotkey),
      [STORAGE_KEYS.allowedSites]: allowedSites,
      [STORAGE_KEYS.overlaySide]: normalizeOverlaySide(overlaySideEl.value)
    });
    await refreshStatus();
  }

  async function handleSkipNow() {
    skipNowEl.disabled = true;
    const nextSkipSeconds = clampSkipSeconds(skipSecondsEl.value);
    try {
      const response = await runtimeSendMessage({
        type: "ANISKIPPER_SKIP_ACTIVE_TAB",
        seconds: nextSkipSeconds
      });
      if (response?.ok) {
        setStatus(t("statusJumped", String(nextSkipSeconds)), "ok");
      } else {
        setStatus(response?.error || t("statusSkipFailed"), "error");
      }
    } catch (_error) {
      setStatus(t("statusSkipFailed"), "error");
    } finally {
      skipNowEl.disabled = false;
      setTimeout(() => {
        refreshStatus();
      }, 900);
    }
  }

  async function addSiteRule(siteRule) {
    if (!siteRule) {
      return;
    }
    if (allowedSites.includes(siteRule)) {
      setStatus(t("statusSiteAlreadyEnabled"), "neutral");
      return;
    }
    allowedSites = dedupeSiteRules([...allowedSites, siteRule]);
    renderAllowedSites();
    await persistSettings();
    setStatus(t("statusSiteEnabled"), "ok");
  }

  async function handleAddManualSite() {
    const normalized = canonicalizeSiteRule(siteInputEl.value);
    if (!normalized) {
      setStatus(t("statusInvalidUrl"), "error");
      return;
    }
    siteInputEl.value = "";
    await addSiteRule(normalized);
  }

  async function handleAddCurrentSite() {
    const tabStatus = await getActiveTabStatus();
    if (!tabStatus.ok || !tabStatus.url) {
      setStatus(t("statusCurrentPageReadError"), "error");
      return;
    }

    const normalized = canonicalizeSiteRule(tabStatus.url, true);
    if (!normalized) {
      setStatus(t("statusCannotEnablePage"), "error");
      return;
    }
    await addSiteRule(normalized);
  }

  function stopHotkeyCapture() {
    isCapturingHotkey = false;
    updateCaptureButtonLabel();
  }

  function startHotkeyCapture() {
    isCapturingHotkey = true;
    updateCaptureButtonLabel();
    setStatus(t("statusPressNewShortcut"), "neutral");
  }

  async function handleCaptureHotkeyClick() {
    if (isCapturingHotkey) {
      stopHotkeyCapture();
      setStatus(t("statusHotkeyCaptureCanceled"), "neutral");
      return;
    }
    startHotkeyCapture();
  }

  async function handleResetHotkey() {
    currentHotkey = parseHotkey(DEFAULT_HOTKEY);
    renderHotkey();
    await persistSettings();
    setStatus(t("statusHotkeyReset"), "ok");
  }

  async function handleWindowKeyDown(event) {
    if (!isCapturingHotkey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      stopHotkeyCapture();
      setStatus(t("statusHotkeyCaptureCanceled"), "neutral");
      return;
    }

    const nextHotkey = buildHotkeyFromEvent(event);
    if (!nextHotkey) {
      setStatus(t("statusHotkeyNeedModifier"), "error");
      return;
    }

    currentHotkey = nextHotkey;
    renderHotkey();
    stopHotkeyCapture();
    await persistSettings();
    setStatus(t("statusHotkeySet", formatHotkeyForUi(currentHotkey)), "ok");
  }

  async function init() {
    localizeStaticText();
    updateCaptureButtonLabel();

    await loadSettings();
    await refreshStatus();

    skipSecondsEl.addEventListener("change", persistSettings);
    overlaySideEl.addEventListener("change", persistSettings);
    skipNowEl.addEventListener("click", handleSkipNow);

    addSiteManualEl.addEventListener("click", handleAddManualSite);
    addCurrentSiteEl.addEventListener("click", handleAddCurrentSite);
    siteInputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      handleAddManualSite();
    });

    captureHotkeyEl.addEventListener("click", handleCaptureHotkeyClick);
    resetHotkeyEl.addEventListener("click", handleResetHotkey);
    window.addEventListener("keydown", handleWindowKeyDown, true);
  }

  init();
})();
