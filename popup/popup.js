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

  function renderAllowedSites() {
    siteListEl.innerHTML = "";

    if (allowedSites.length === 0) {
      const empty = document.createElement("li");
      empty.className = "site-item";
      empty.textContent = "Noch keine Seite freigeschaltet.";
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
      removeButton.textContent = "x";
      removeButton.title = "Seite entfernen";
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
          error: response?.error || "Kein aktiver Tab gefunden"
        };
      }
      return response;
    } catch (_error) {
      return {
        ok: false,
        error: "Aktive Seite konnte nicht gelesen werden"
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
      setStatus(tabStatus.error || "Kein aktiver Tab gefunden", "error");
      return;
    }

    activeTab = {
      id: tabStatus.tabId,
      url: tabStatus.url
    };

    if (!tabStatus.allowed) {
      setStatus("Seite nicht freigeschaltet", "neutral");
      return;
    }

    try {
      const ping = await runtimeSendMessage({ type: "ANISKIPPER_PING_ACTIVE_TAB" });
      if (!ping?.ok) {
        setStatus(ping?.error || "Status konnte nicht gelesen werden", "error");
        return;
      }
      if (!ping.allowed) {
        setStatus("Seite nicht freigeschaltet", "neutral");
        return;
      }
      if (ping.hasVideo) {
        setStatus("Player erkannt", "ok");
      } else {
        setStatus("Kein Video-Player auf dieser Seite", "neutral");
      }
    } catch (_error) {
      setStatus("Status konnte nicht gelesen werden", "error");
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
        setStatus(`Gesprungen: +${nextSkipSeconds}s`, "ok");
      } else {
        setStatus(response?.error || "Skip fehlgeschlagen", "error");
      }
    } catch (_error) {
      setStatus("Skip fehlgeschlagen", "error");
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
      setStatus("Seite ist bereits freigeschaltet", "neutral");
      return;
    }
    allowedSites = dedupeSiteRules([...allowedSites, siteRule]);
    renderAllowedSites();
    await persistSettings();
    setStatus("Seite freigeschaltet", "ok");
  }

  async function handleAddManualSite() {
    const normalized = canonicalizeSiteRule(siteInputEl.value);
    if (!normalized) {
      setStatus("Ungültige URL", "error");
      return;
    }
    siteInputEl.value = "";
    await addSiteRule(normalized);
  }

  async function handleAddCurrentSite() {
    const tabStatus = await getActiveTabStatus();
    if (!tabStatus.ok || !tabStatus.url) {
      setStatus("Aktuelle Seite konnte nicht gelesen werden", "error");
      return;
    }

    const normalized = canonicalizeSiteRule(tabStatus.url, true);
    if (!normalized) {
      setStatus("Diese Seite kann nicht freigeschaltet werden", "error");
      return;
    }
    await addSiteRule(normalized);
  }

  function stopHotkeyCapture() {
    isCapturingHotkey = false;
    captureHotkeyEl.textContent = "Ändern";
  }

  function startHotkeyCapture() {
    isCapturingHotkey = true;
    captureHotkeyEl.textContent = "Drücke Tasten...";
    setStatus("Jetzt neue Tastenkombination drücken", "neutral");
  }

  async function handleCaptureHotkeyClick() {
    if (isCapturingHotkey) {
      stopHotkeyCapture();
      setStatus("Hotkey-Aufnahme abgebrochen", "neutral");
      return;
    }
    startHotkeyCapture();
  }

  async function handleResetHotkey() {
    currentHotkey = parseHotkey(DEFAULT_HOTKEY);
    renderHotkey();
    await persistSettings();
    setStatus("Hotkey auf Standard gesetzt", "ok");
  }

  async function handleWindowKeyDown(event) {
    if (!isCapturingHotkey) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      stopHotkeyCapture();
      setStatus("Hotkey-Aufnahme abgebrochen", "neutral");
      return;
    }

    const nextHotkey = buildHotkeyFromEvent(event);
    if (!nextHotkey) {
      setStatus("Bitte mit mindestens einer Modifier-Taste", "error");
      return;
    }

    currentHotkey = nextHotkey;
    renderHotkey();
    stopHotkeyCapture();
    await persistSettings();
    setStatus(`Hotkey gesetzt: ${formatHotkeyForUi(currentHotkey)}`, "ok");
  }

  async function init() {
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
