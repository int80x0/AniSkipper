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
  const CONTROL_ACTIVE_MS = 1700;
  const DEFAULT_HOTKEY = "Alt+Shift+KeyS";
  const DEFAULT_OVERLAY_SIDE = "left";

  let skipSeconds = DEFAULT_SKIP_SECONDS;
  let hotkey = parseHotkey(DEFAULT_HOTKEY);
  let allowedSites = [];
  let overlaySide = DEFAULT_OVERLAY_SIDE;
  let siteAllowed = false;
  let scanScheduled = false;
  let activeVideo = null;
  let controlVisibleUntil = 0;
  let visibilityTimer = null;
  let noticeTimer = null;
  let isControlHovered = false;

  const trackedVideos = new WeakSet();
  const control = buildControl();

  function clampSkipSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_SKIP_SECONDS;
    }
    return Math.min(MAX_SKIP_SECONDS, Math.max(MIN_SKIP_SECONDS, Math.round(parsed)));
  }

  function formatMmSs(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

  function isCurrentUrlAllowed() {
    if (allowedSites.length === 0) {
      return false;
    }

    let pageUrl;
    try {
      pageUrl = new URL(window.location.href);
    } catch (_error) {
      return false;
    }

    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
      return false;
    }

    const pageOrigin = pageUrl.origin;
    const pagePath = normalizePath(pageUrl.pathname);

    for (const rule of allowedSites) {
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

  function normalizeOverlaySide(value) {
    if (value === "right") {
      return "right";
    }
    return DEFAULT_OVERLAY_SIDE;
  }

  function serializeHotkey(value) {
    const parts = [];
    if (value.ctrl) {
      parts.push("Ctrl");
    }
    if (value.alt) {
      parts.push("Alt");
    }
    if (value.shift) {
      parts.push("Shift");
    }
    if (value.meta) {
      parts.push("Meta");
    }
    parts.push(value.code);
    return parts.join("+");
  }

  function eventMatchesHotkey(event) {
    return (
      event.code === hotkey.code &&
      Boolean(event.ctrlKey) === hotkey.ctrl &&
      Boolean(event.altKey) === hotkey.alt &&
      Boolean(event.shiftKey) === hotkey.shift &&
      Boolean(event.metaKey) === hotkey.meta
    );
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target.matches("input, textarea, select")) {
      return true;
    }
    return Boolean(target.closest("[contenteditable=''], [contenteditable='true']"));
  }

  function isPointInsideVideo(video, x, y) {
    if (!video || typeof x !== "number" || typeof y !== "number") {
      return false;
    }
    const rect = video.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function findVideos() {
    return Array.from(document.querySelectorAll("video"));
  }

  function isVisible(video) {
    const rect = video.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) {
      return false;
    }

    const style = window.getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function scoreVideo(video) {
    const rect = video.getBoundingClientRect();
    const areaScore = Math.max(0, rect.width * rect.height);
    const playingScore = video.paused ? 0 : 500000;
    const visibleScore = isVisible(video) ? 100000 : 0;
    return areaScore + playingScore + visibleScore;
  }

  function pickPrimaryVideo() {
    const videos = findVideos();
    if (videos.length === 0) {
      return null;
    }

    let bestVideo = videos[0];
    let bestScore = scoreVideo(bestVideo);

    for (let i = 1; i < videos.length; i += 1) {
      const nextScore = scoreVideo(videos[i]);
      if (nextScore > bestScore) {
        bestScore = nextScore;
        bestVideo = videos[i];
      }
    }

    return bestVideo;
  }

  function skipVideo(video, seconds) {
    if (!video || !Number.isFinite(video.currentTime)) {
      return false;
    }

    const safeSeconds = clampSkipSeconds(seconds);
    const rawTarget = video.currentTime + safeSeconds;
    const maxTarget = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : rawTarget;
    const nextTime = Math.min(rawTarget, maxTarget);

    if (nextTime <= video.currentTime + 0.05) {
      return false;
    }

    video.currentTime = nextTime;
    return true;
  }

  function handleVideoActivity(video, visibleMs = CONTROL_ACTIVE_MS) {
    if (!video || !activeVideo || !siteAllowed) {
      return;
    }
    if (video !== activeVideo) {
      queueScan();
      return;
    }
    showControlFor(visibleMs);
  }

  function ensureVideoListeners(video) {
    if (trackedVideos.has(video)) {
      return;
    }
    trackedVideos.add(video);

    video.addEventListener("loadedmetadata", queueScan, { passive: true });
    video.addEventListener(
      "playing",
      () => {
        queueScan();
        handleVideoActivity(video, 1200);
      },
      { passive: true }
    );
    video.addEventListener("pause", queueScan, { passive: true });
    video.addEventListener("emptied", queueScan, { passive: true });
    video.addEventListener(
      "mousemove",
      () => {
        handleVideoActivity(video);
      },
      { passive: true }
    );
    video.addEventListener(
      "pointerdown",
      () => {
        handleVideoActivity(video, 2200);
      },
      { passive: true }
    );
    video.addEventListener(
      "touchstart",
      () => {
        handleVideoActivity(video, 2500);
      },
      { passive: true }
    );
    video.addEventListener(
      "mouseleave",
      () => {
        if (video === activeVideo && !isControlHovered) {
          hideControlSoon(120);
        }
      },
      { passive: true }
    );
  }

  function skipPrimaryVideo(customSeconds) {
    if (!siteAllowed) {
      return false;
    }

    const video = pickPrimaryVideo();
    if (!video) {
      showNotice("Kein Video-Player gefunden");
      return false;
    }

    const secondsToSkip = clampSkipSeconds(customSeconds ?? skipSeconds);
    const didSkip = skipVideo(video, secondsToSkip);
    if (!didSkip) {
      showNotice("Skip nicht möglich");
      return false;
    }

    showNotice(`Opening geskippt (+${formatMmSs(secondsToSkip)})`);
    handleVideoActivity(video, 2100);
    return true;
  }

  function buildControl() {
    const root = document.createElement("div");
    root.id = "aniskipper-floating-control";
    root.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "display:none",
      "opacity:0",
      "transform:translateY(6px)",
      "transition:opacity 140ms ease,transform 140ms ease",
      "pointer-events:none",
      "user-select:none",
      "font-family:Inter,Segoe UI,system-ui,-apple-system,sans-serif"
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "align-items:stretch",
      "gap:4px",
      "padding:7px",
      "border:1px solid rgba(63,63,70,0.9)",
      "border-radius:12px",
      "background:rgba(9,9,11,0.88)",
      "backdrop-filter:blur(5px)",
      "box-shadow:0 10px 28px rgba(0,0,0,0.45)"
    ].join(";");

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Skip +${formatMmSs(skipSeconds)}`;
    button.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "height:30px",
      "width:100%",
      "padding:0 11px",
      "border:1px solid rgba(250,250,250,0.45)",
      "border-radius:8px",
      "background:#fafafa",
      "color:#09090b",
      "font-size:12px",
      "font-weight:600",
      "cursor:pointer",
      "box-shadow:0 1px 0 rgba(255,255,255,0.38) inset",
      "pointer-events:auto"
    ].join(";");
    button.addEventListener("click", () => {
      skipPrimaryVideo(skipSeconds);
    });

    const hint = document.createElement("div");
    hint.textContent = "Hotkey";
    hint.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "width:100%",
      "min-height:18px",
      "padding:2px 7px",
      "border:1px solid rgba(63,63,70,0.95)",
      "border-radius:999px",
      "background:rgba(24,24,27,0.95)",
      "color:#d4d4d8",
      "font-size:10px",
      "font-weight:500",
      "line-height:1.4",
      "text-align:center"
    ].join(";");

    panel.appendChild(button);
    panel.appendChild(hint);
    root.appendChild(panel);

    root.addEventListener("mouseenter", () => {
      isControlHovered = true;
      showControlFor(5000);
    });
    root.addEventListener("mouseleave", () => {
      isControlHovered = false;
      hideControlSoon(80);
    });

    document.documentElement.appendChild(root);
    return { root, button, hint };
  }

  function clearVisibilityTimer() {
    if (!visibilityTimer) {
      return;
    }
    clearTimeout(visibilityTimer);
    visibilityTimer = null;
  }

  function scheduleVisibilityTimer() {
    clearVisibilityTimer();
    const remaining = controlVisibleUntil - Date.now();
    if (remaining <= 0) {
      applyControlVisibility();
      return;
    }
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null;
      applyControlVisibility();
    }, remaining + 24);
  }

  function showControlFor(durationMs = CONTROL_ACTIVE_MS) {
    if (!siteAllowed) {
      return;
    }
    const safeDuration = Math.max(150, Number(durationMs) || CONTROL_ACTIVE_MS);
    controlVisibleUntil = Date.now() + safeDuration;
    applyControlVisibility();
    scheduleVisibilityTimer();
  }

  function hideControlSoon(delayMs = 0) {
    clearVisibilityTimer();
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null;
      controlVisibleUntil = 0;
      applyControlVisibility();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function ensureControlParent(video) {
    const fullscreenElement = document.fullscreenElement;
    const inFullscreen =
      fullscreenElement instanceof Element &&
      video &&
      fullscreenElement.contains(video);

    const nextParent = inFullscreen ? fullscreenElement : document.documentElement;
    if (control.root.parentElement !== nextParent) {
      nextParent.appendChild(control.root);
    }
  }

  function updateControlPosition(video) {
    if (!video) {
      return;
    }

    ensureControlParent(video);
    control.button.textContent = `Skip +${formatMmSs(skipSeconds)}`;
    control.hint.textContent = serializeHotkey(hotkey).replace("+Key", "+");

    const fullscreenElement = document.fullscreenElement;
    const inFullscreen =
      fullscreenElement instanceof Element &&
      fullscreenElement.contains(video);

    if (inFullscreen) {
      if (overlaySide === "right") {
        control.root.style.left = "auto";
        control.root.style.right = "18px";
      } else {
        control.root.style.left = "18px";
        control.root.style.right = "auto";
      }
      control.root.style.top = "auto";
      control.root.style.bottom = "98px";
      return;
    }

    const rect = video.getBoundingClientRect();
    const controlWidth = control.root.offsetWidth > 0 ? control.root.offsetWidth : 118;
    const controlHeight = control.root.offsetHeight > 0 ? control.root.offsetHeight : 64;
    const xBase = overlaySide === "right" ? rect.right - controlWidth - 14 : rect.left + 14;
    const x = Math.max(8, Math.min(window.innerWidth - controlWidth - 8, xBase));
    const y = Math.max(
      8,
      Math.min(window.innerHeight - controlHeight - 8, rect.bottom - controlHeight - 84)
    );

    control.root.style.right = "auto";
    control.root.style.bottom = "auto";
    control.root.style.left = `${Math.round(x)}px`;
    control.root.style.top = `${Math.round(y)}px`;
  }

  function applyControlVisibility() {
    const hasActiveVisibleVideo = Boolean(siteAllowed && activeVideo && isVisible(activeVideo));
    if (!hasActiveVisibleVideo) {
      control.root.style.display = "none";
      control.root.style.opacity = "0";
      control.root.style.transform = "translateY(6px)";
      control.root.style.pointerEvents = "none";
      return;
    }

    control.root.style.display = "block";
    const shouldShow = isControlHovered || Date.now() < controlVisibleUntil;
    control.root.style.opacity = shouldShow ? "1" : "0";
    control.root.style.transform = shouldShow ? "translateY(0)" : "translateY(6px)";
    control.root.style.pointerEvents = shouldShow ? "auto" : "none";
  }

  function showNotice(text) {
    control.hint.textContent = text;
    showControlFor(2200);
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
      control.hint.textContent = serializeHotkey(hotkey).replace("+Key", "+");
    }, 1900);
  }

  function applyPermissionState(nextAllowed) {
    siteAllowed = Boolean(nextAllowed);
    if (!siteAllowed) {
      activeVideo = null;
      controlVisibleUntil = 0;
      applyControlVisibility();
    }
  }

  async function refreshPermissionState() {
    try {
      const response = await runtimeSendMessage({ type: "ANISKIPPER_IS_SITE_ALLOWED" });
      if (response && typeof response.allowed === "boolean") {
        applyPermissionState(response.allowed);
        return;
      }
    } catch (_error) {
    }

    applyPermissionState(isCurrentUrlAllowed());
  }

  function refreshControl() {
    if (!siteAllowed) {
      activeVideo = null;
      controlVisibleUntil = 0;
      applyControlVisibility();
      return;
    }

    const videos = findVideos();
    videos.forEach(ensureVideoListeners);

    const primaryVideo = pickPrimaryVideo();
    if (!primaryVideo || !isVisible(primaryVideo)) {
      activeVideo = null;
      controlVisibleUntil = 0;
      applyControlVisibility();
      return;
    }

    activeVideo = primaryVideo;
    updateControlPosition(primaryVideo);
    applyControlVisibility();
  }

  function queueScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      refreshControl();
    });
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

  async function loadSettings() {
    const values = await storageGet([
      STORAGE_KEYS.skipSeconds,
      STORAGE_KEYS.hotkey,
      STORAGE_KEYS.allowedSites,
      STORAGE_KEYS.overlaySide
    ]);
    skipSeconds = clampSkipSeconds(values[STORAGE_KEYS.skipSeconds]);
    hotkey = parseHotkey(values[STORAGE_KEYS.hotkey] || DEFAULT_HOTKEY);
    allowedSites = dedupeSiteRules(values[STORAGE_KEYS.allowedSites]);
    overlaySide = normalizeOverlaySide(values[STORAGE_KEYS.overlaySide]);
    await refreshPermissionState();
  }

  function applySettingsFromMessage(message) {
    if (message.skipSeconds !== undefined) {
      skipSeconds = clampSkipSeconds(message.skipSeconds);
    }
    if (typeof message.hotkey === "string") {
      hotkey = parseHotkey(message.hotkey);
    }
    if (Array.isArray(message.allowedSites)) {
      allowedSites = dedupeSiteRules(message.allowedSites);
    }
    if (message.overlaySide !== undefined) {
      overlaySide = normalizeOverlaySide(message.overlaySide);
    }
    refreshPermissionState().then(() => {
      queueScan();
    });
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "ANISKIPPER_SKIP") {
      (async () => {
        await refreshPermissionState();
        if (!siteAllowed) {
          if (typeof sendResponse === "function") {
            sendResponse({
              ok: false,
              error: "Seite nicht freigeschaltet"
            });
          }
          return;
        }

        const didSkip = skipPrimaryVideo(message.seconds);
        if (typeof sendResponse === "function") {
          sendResponse({
            ok: didSkip,
            error: didSkip ? undefined : "Kein passender Video-Player gefunden"
          });
        }
      })();
      return true;
    }

    if (message.type === "ANISKIPPER_UPDATE_SETTINGS") {
      applySettingsFromMessage(message);
      if (typeof sendResponse === "function") {
        sendResponse({ ok: true });
      }
      return true;
    }

    if (message.type === "ANISKIPPER_PING") {
      (async () => {
        await refreshPermissionState();
        if (typeof sendResponse === "function") {
          sendResponse({
            ok: true,
            hasVideo: siteAllowed ? findVideos().length > 0 : false,
            siteAllowed,
            skipSeconds,
            hotkey: serializeHotkey(hotkey)
          });
        }
      })();
      return true;
    }
  }

  function onKeyDown(event) {
    if (!siteAllowed) {
      return;
    }
    if (!eventMatchesHotkey(event)) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    skipPrimaryVideo(skipSeconds);
  }

  function onDocumentMouseMove(event) {
    if (!siteAllowed || !activeVideo) {
      return;
    }
    if (isPointInsideVideo(activeVideo, event.clientX, event.clientY)) {
      showControlFor();
    }
  }

  function onDocumentTouchStart(event) {
    if (!siteAllowed || !activeVideo || !event.touches || event.touches.length === 0) {
      return;
    }
    const touch = event.touches[0];
    if (isPointInsideVideo(activeVideo, touch.clientX, touch.clientY)) {
      showControlFor(2400);
    }
  }

  async function start() {
    await loadSettings();
    queueScan();

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousemove", onDocumentMouseMove, { passive: true });
    document.addEventListener("touchstart", onDocumentTouchStart, {
      passive: true,
      capture: true
    });
    document.addEventListener("fullscreenchange", () => {
      queueScan();
      if (activeVideo) {
        showControlFor(1300);
      }
    });
    document.addEventListener("scroll", queueScan, true);
    window.addEventListener("resize", queueScan, { passive: true });
    window.addEventListener("blur", () => {
      hideControlSoon(0);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        hideControlSoon(0);
      }
    });

    const observer = new MutationObserver(queueScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    if (api.runtime?.onMessage?.addListener) {
      api.runtime.onMessage.addListener(onRuntimeMessage);
    }

    if (api.storage?.onChanged?.addListener) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") {
          return;
        }
        let changed = false;
        if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.skipSeconds)) {
          skipSeconds = clampSkipSeconds(changes[STORAGE_KEYS.skipSeconds].newValue);
          changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.hotkey)) {
          hotkey = parseHotkey(changes[STORAGE_KEYS.hotkey].newValue || DEFAULT_HOTKEY);
          changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.allowedSites)) {
          allowedSites = dedupeSiteRules(changes[STORAGE_KEYS.allowedSites].newValue);
          refreshPermissionState().then(() => {
            queueScan();
          });
          changed = true;
        }
        if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.overlaySide)) {
          overlaySide = normalizeOverlaySide(changes[STORAGE_KEYS.overlaySide].newValue);
          changed = true;
        }
        if (changed && !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.allowedSites)) {
          queueScan();
        }
      });
    }
  }

  start();
})();
