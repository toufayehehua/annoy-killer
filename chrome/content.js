(() => {
  "use strict";
  const localizedMessageCache = new Map();
  const t = (key, substitutions) => {
    const cacheKey = `${key}\u0000${JSON.stringify(substitutions ?? null)}`;
    try {
      const message = chrome.i18n.getMessage(key, substitutions);
      if (message) localizedMessageCache.set(cacheKey, message);
      return message || localizedMessageCache.get(cacheKey) || "";
    } catch (error) {
      if (isInvalidatedExtensionContext(error)) {
        stopInvalidatedExtensionContext();
        return localizedMessageCache.get(cacheKey) || "";
      }
      throw error;
    }
  };

  if (globalThis.__annoyKillerLoaded) {
    return;
  }
  globalThis.__annoyKillerLoaded = true;

  const PAGE_STORAGE_KEY = "hiddenRulesByPage";
  const SITE_STORAGE_KEY = "hiddenRulesBySite";
  const VISIBLE_PAGE_STORAGE_KEY = "visibleExceptionsByPage";
  const PREVIEW_STORAGE_KEY = "hiddenPreviewEnabled";
  const STYLE_ID = "annoy-killer-persistent-style";
  const SESSION_ATTRIBUTE = "data-annoy-killer-session-hidden";
  const PERSISTENT_ATTRIBUTE = "data-annoy-killer-persistent-hidden";
  const ROOT_STYLE_ATTRIBUTE = "data-annoy-killer-root-style";
  const PICKING_CLASS = "annoy-killer-is-picking";
  const CLICK_THROUGH_CLASS = "annoy-killer-click-through";
  const IFRAME_SHIELD_ATTRIBUTE = "data-ak-iframe-shield";
  const MAXIMUM_SELECTION_RATIO = 0.82;
  const SEARCH_QUERY_PARAMETERS = new Set([
    "q", "query", "search", "keyword", "keywords", "term", "text", "wd", "word", "search_query"
  ]);
  const SEARCH_POSITION_PARAMETERS = new Set(["page", "p", "start", "offset", "pn"]);
  const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
  const SELECTION_LEVEL = Object.freeze({
    BROADEST: "broadest",
    DEFAULT: "default",
    SMALLEST: "smallest"
  });
  const { normalizeRule, createExactMatcher, createSimilarMatcher,
    findMatcherElements, toComponentRule } = AnnoyKillerRules;
  const BLOCK_DISPLAYS = new Set([
    "block",
    "flex",
    "grid",
    "table",
    "table-row",
    "table-cell",
    "list-item"
  ]);


  let active = false;
  let starting = false;
  let finishing = false;
  let selectionLevel = SELECTION_LEVEL.BROADEST;
  let currentCandidate = null;
  let lastPointer = null;
  let pointerFrame = 0;
  let pageKey = getPageKey();
  let siteKey = getSiteKey();
  let persistentPageRules = [];
  let persistentSiteRules = [];
  let persistentVisiblePageRules = [];
  let pendingItems = [];
  let removedPageRules = [];
  let removedSiteRules = [];
  let addedVisiblePageRules = [];
  let removedVisiblePageRules = [];
  let sessionSequence = 0;
  let activeSessionId = 0;
  let itemSequence = 0;
  let uiHost = null;
  let uiTopLayer = null;
  let displacedTopLayers = [];
  let shadowRoot = null;
  let highlight = null;
  let countLabel = null;
  let hiddenToggleButton = null;
  let restoreAllButton = null;
  let resetSnapshot = null;
  let resetBusy = false;
  let captureLayer = null;
  let pressedSelection = null;
  let hiddenPreview = false;
  let clickThrough = false;
  let previewPreferenceWrite = Promise.resolve();
  let autoSaveQueue = Promise.resolve();
  let frozenPersistentRuleElements = new Map();
  let frozenVisibleRuleElements = new Map();
  let hiddenPreviewLayer = null;
  let hiddenPreviewFrame = 0;
  let hiddenPreviewAnchorSequence = 0;
  const hiddenPreviewMasks = new Map();
  const retiringPreviewMasks = new Map();
  const hiddenPreviewMaskStates = new WeakMap();
  const previewRestoredElements = new Set();
  const previewOpacityMotions = new Map();
  let hiddenPreviewClosing = false;
  let hiddenPreviewRevision = 0;
  const PREVIEW_MOTION_DURATION = 240;
  const HIDDEN_EYE_PATH = "M857.6 346.432a38.4 38.4 0 0 0-51.328 16.896l-0.192 0.384a146.24 146.24 0 0 1-11.136 16.064c-8.96 11.328-23.68 27.072-45.632 43.072-43.52 31.68-117.76 65.792-237.888 65.792-120.064 0-194.368-34.112-237.888-65.792a232.192 232.192 0 0 1-45.568-43.008 146.496 146.496 0 0 1-11.136-16.128l-0.256-0.384a38.4 38.4 0 0 0-68.48 34.624l34.304-17.152c-34.368 17.152-34.304 17.216-34.304 17.28l0.064 0.128 0.128 0.256 0.384 0.64a99.84 99.84 0 0 0 4.8 8.32c3.2 5.12 7.872 12.032 14.272 20.032 9.728 12.352 23.488 27.392 42.048 43.008l-46.4 46.4a36.544 36.544 0 0 0 51.712 51.712l51.648-51.712a36.736 36.736 0 0 0 4.352-5.184c24.32 12.992 52.8 24.832 85.76 34.048a36.416 36.416 0 0 0-10.24 16.64l-20.096 70.336A36.544 36.544 0 1 0 396.8 652.8l20.16-70.336a36.416 36.416 0 0 0-1.408-24.192 622.72 622.72 0 0 0 119.872 6.656 36.416 36.416 0 0 0 0.704 17.088l20.16 70.272a36.544 36.544 0 0 0 70.272-20.16L606.4 561.92a36.992 36.992 0 0 0-1.088-3.264 482.88 482.88 0 0 0 100.672-26.112l50.688 50.624a36.544 36.544 0 1 0 51.712-51.712l-33.28-33.28c6.848-4.352 13.312-8.768 19.392-13.184 28.288-20.608 47.936-41.408 60.672-57.536a221.568 221.568 0 0 0 19.008-28.288l0.384-0.704 0.128-0.256 0.064-0.128c0-0.064 0.064-0.128-34.304-17.28l34.368 17.152a38.4 38.4 0 0 0-17.152-51.52z";
  const previewEyeMotions = new Map();
  let persistentApplyQueued = false;
  const persistentMarkedElements = new Set();
  let persistentGroupIdsByElement = new Map();
  const persistentInlineStates = new WeakMap();
  const sessionInlineStates = new WeakMap();
  const persistentTopLayerStates = new WeakMap();
  const sessionTopLayerStates = new WeakMap();
  const observedShadowRoots = new WeakSet();
  const shadowRootStyles = new WeakMap();
  const activeAnimations = new Set();
  const elementsBeingSelected = new WeakSet();
  const overlayElements = new WeakSet();
  const overlayScrollStates = new Map();
  let animationHost = null;
  let animationRoot = null;
  let latestViewportCapture = null;
  let viewportCapturePromise = null;
  let lastLocalCaptureAt = 0;
  const inFlightSelections = new Set();

  let rulesLoadRevision = 0;
  let contextWatchTimer = 0;
  let extensionContextStopped = false;
  let rulesLoadPromise = loadAndApplyRules();
  let toggleQueue = Promise.resolve();
  let shortcutKey = AnnoyKillerShortcuts.defaultKey;
  let shortcutChanged = false;
  const shortcutDetector = AnnoyKillerShortcuts.createDetector(() => shortcutKey, () => {
    selectionLevel = SELECTION_LEVEL.BROADEST;
    updateCandidate();
    const toggle = window.top === window ? queueToggle()
      : chrome.runtime.sendMessage({ type: "annoy-killer:shortcut-toggle" });
    toggle.catch(error => console.debug("无法切换隐藏选择。", error));
  });
  chrome.storage.local.get("toggleShortcutKey").then(stored => {
    if (!shortcutChanged) shortcutKey = AnnoyKillerShortcuts.validKey(stored.toggleShortcutKey);
  }).catch(() => undefined);
  window.addEventListener("keydown", shortcutDetector.handleKey, true);
  window.addEventListener("keyup", shortcutDetector.handleKey, true);
  window.addEventListener("pointerdown", shortcutDetector.reset, true);
  window.addEventListener("blur", shortcutDetector.reset);
  document.addEventListener("visibilitychange", shortcutDetector.reset);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes.toggleShortcutKey) {
      shortcutChanged = true;
      shortcutKey = AnnoyKillerShortcuts.validKey(changes.toggleShortcutKey.newValue);
      shortcutDetector.reset();
    }
    if (changes[PAGE_STORAGE_KEY] || changes[SITE_STORAGE_KEY] ||
        changes[VISIBLE_PAGE_STORAGE_KEY]) {
      rulesLoadPromise = loadAndApplyRules();
    }
  });

  const documentObserver = new MutationObserver((records) => {
    if (!records.some(isRelevantMutation)) return;
    schedulePersistentApplication();
    handlePossibleNavigation();
    if (active) markCrossOriginIframes();
  });
  const observationOptions = {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["id", "class", "style", "open", PERSISTENT_ATTRIBUTE,
      "data-testid", "data-test", "data-cy", "data-qa", "aria-label", "title", "alt", "name", "role", "type", "href", "src"]
  };
  documentObserver.observe(document, observationOptions);

  if (window.top === window) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "annoy-killer:get-hidden-rule-state") {
        loadAndApplyRules()
          .then(() => queueMicrotask(() => sendResponse({
            pageKey: getPageKey(),
            hiddenCount: getHiddenGroupIds().size
          })))
          .catch(() => sendResponse(null));
        return true;
      }
      if (message?.type !== "annoy-killer:toggle") {
        return false;
      }

      // Preserve open/close order even when a second click arrives during startup.
      queueToggle()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    });
  }
  window.addEventListener("popstate", handlePossibleNavigation, true);
  window.addEventListener("hashchange", handlePossibleNavigation, true);
  window.navigation?.addEventListener("currententrychange", handlePossibleNavigation);
  // Also discover late shadow roots and route changes inside embedded frames.
  contextWatchTimer = window.setInterval(() => {
    if (!hasLiveExtensionContext()) {
      stopInvalidatedExtensionContext();
      return;
    }
    handlePossibleNavigation();
    if (persistentPageRules.length || persistentSiteRules.length) schedulePersistentApplication();
  }, 300);

  function hasLiveExtensionContext() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isInvalidatedExtensionContext(error) {
    return /extension context invalidated/i.test(String(error?.message || error));
  }

  function stopInvalidatedExtensionContext() {
    if (extensionContextStopped) return;
    extensionContextStopped = true;
    if (contextWatchTimer) {
      window.clearInterval(contextWatchTimer);
      contextWatchTimer = 0;
    }
    documentObserver.disconnect();
    stopPicking();
    window.removeEventListener("keydown", shortcutDetector.handleKey, true);
    window.removeEventListener("keyup", shortcutDetector.handleKey, true);
    window.removeEventListener("pointerdown", shortcutDetector.reset, true);
    window.removeEventListener("blur", shortcutDetector.reset);
    document.removeEventListener("visibilitychange", shortcutDetector.reset);
    window.removeEventListener("popstate", handlePossibleNavigation, true);
    window.removeEventListener("hashchange", handlePossibleNavigation, true);
    window.navigation?.removeEventListener("currententrychange", handlePossibleNavigation);
    globalThis.__annoyKillerLoaded = false;
  }

  function isRelevantMutation(record) {
    const target = record.target;
    if (target.id === STYLE_ID || target.hasAttribute?.(ROOT_STYLE_ATTRIBUTE)) return false;
    if (record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].every(node =>
          node.nodeType === Node.ELEMENT_NODE &&
          (node.hasAttribute?.("data-annoy-killer-ui") || node.closest?.("[data-annoy-killer-ui]")))) {
      return false;
    }
    if (record.type === "attributes" && record.attributeName === "style") {
      return !hiddenPreview && persistentMarkedElements.has(target) &&
        (target.style.getPropertyValue("display") !== "none" ||
          target.style.getPropertyPriority("display") !== "important");
    }
    return true;
  }

  function queueToggle() {
    toggleQueue = toggleQueue.catch(() => undefined)
      .then(() => active ? finishPicking() : startPicking());
    return toggleQueue;
  }

  function getPageKey() {
    if (location.protocol === "file:") {
      return `file://${location.pathname}${location.search}${location.hash}`;
    }
    return canonicalPageKey(location.href);
  }

  function canonicalPageKey(address) {
    let url;
    try {
      url = new URL(address, location.href);
    } catch {
      return String(address || "");
    }
    if (!/^https?:$/.test(url.protocol)) {
      return `${url.origin}${url.pathname}${url.search}${url.hash}`;
    }
    const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
    if (!names.some((name) => SEARCH_QUERY_PARAMETERS.has(name))) {
      return `${url.origin}${url.pathname}${url.search}${url.hash}`;
    }
    const canonical = new URL(`${url.origin}${url.pathname}`);
    for (const [name, value] of url.searchParams) {
      const normalizedName = name.toLowerCase();
      if (SEARCH_QUERY_PARAMETERS.has(normalizedName) ||
          SEARCH_POSITION_PARAMETERS.has(normalizedName)) {
        canonical.searchParams.append(name, value);
      }
    }
    canonical.hash = url.hash;
    return `${canonical.origin}${canonical.pathname}${canonical.search}${canonical.hash}`;
  }

  function getSiteKey() {
    return location.protocol === "file:" ? "file://" : location.origin;
  }

  async function loadAndApplyRules() {
    const revision = ++rulesLoadRevision;
    const expectedPage = getPageKey();
    const expectedSite = getSiteKey();
    try {
      const stored = await chrome.storage.local.get([
        PAGE_STORAGE_KEY,
        SITE_STORAGE_KEY,
        VISIBLE_PAGE_STORAGE_KEY
      ]);
      if (revision !== rulesLoadRevision || expectedPage !== getPageKey() || expectedSite !== getSiteKey()) {
        return;
      }
      const rulesByPage = stored[PAGE_STORAGE_KEY] || {};
      const removedPageKeys = new Set(removedPageRules.map(ruleKey));
      persistentPageRules = sanitizeRules(Object.entries(rulesByPage)
        .filter(([key]) => canonicalPageKey(key) === expectedPage)
        .flatMap(([, rules]) => rules))
        .filter(rule => !removedPageKeys.has(ruleKey(rule)));
      // Share only component identities from the same origin. Legacy broad
      // same-class rules remain disabled; local files stay page-specific.
      persistentSiteRules = sanitizeGroupedRules(Object.entries(rulesByPage).flatMap(([key, rules]) => {
        if (canonicalPageKey(key) === expectedPage || !/^https?:/.test(key)) return [];
        try {
          if (new URL(key).origin !== expectedSite) return [];
        } catch { return []; }
        return sanitizeRules(rules).map(toComponentRule).filter(Boolean);
      }));
      const visibleRulesByPage = stored[VISIBLE_PAGE_STORAGE_KEY] || {};
      const removedVisibleKeys = new Set(removedVisiblePageRules.map(ruleKey));
      persistentVisiblePageRules = sanitizeRules([
        ...Object.entries(visibleRulesByPage)
          .filter(([key]) => canonicalPageKey(key) === expectedPage)
          .flatMap(([, rules]) => Array.isArray(rules) ? rules : []),
        ...(active ? addedVisiblePageRules : [])
      ]).filter((rule) => !removedVisibleKeys.has(ruleKey(rule)));
      pageKey = expectedPage;
      siteKey = expectedSite;
      applyPersistentStyle();
    } catch (error) {
      console.debug("无法读取已隐藏的干扰项。", error);
    }
  }

  function sanitizeRules(rules) {
    if (!Array.isArray(rules)) {
      return [];
    }

    const normalized = [];
    const seen = new Set();
    for (const storedRule of rules) {
      const rule = normalizeRule(storedRule);
      if (!rule) {
        continue;
      }
      const key = ruleKey(rule);
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(rule);
      }
    }
    return normalized;
  }

  function sanitizeGroupedRules(rules) {
    if (!Array.isArray(rules)) return [];
    const normalized = [];
    const seen = new Set();
    for (const storedRule of rules) {
      const rule = normalizeRule(storedRule);
      if (!rule) continue;
      const key = `${ruleKey(rule)}\u0000${rule.group || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(rule);
    }
    return normalized;
  }

  function applyPersistentStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.documentElement || document).appendChild(style);
    }

    style.textContent = hiddenPreview
      ? hiddenPreviewCss(`[${PERSISTENT_ATTRIBUTE}]`)
      : `[${PERSISTENT_ATTRIBUTE}] { display: none !important; }`;
    schedulePersistentApplication();
  }

  function hiddenPreviewCss(selector) {
    return `${selector} {
      opacity: 0.42 !important;
      outline: 2px dashed rgba(255, 178, 46, 0.96) !important;
      outline-offset: -2px !important;
    }`;
  }

  function getActiveRules() {
    return [...persistentPageRules, ...persistentSiteRules];
  }

  function pendingElementsForRule(rule) {
    const key = ruleKey(rule);
    let found = false;
    const elements = [];
    for (const item of pendingItems) {
      if (ruleKey(item.rule) !== key) continue;
      found = true;
      elements.push(...item.elements.filter((element) => element?.isConnected));
    }
    return found ? elements : null;
  }

  function resolveActiveHiddenRuleElements(rule) {
    if (!active) return resolveRuleElements(rule);
    const pendingElements = pendingElementsForRule(rule);
    if (pendingElements) return pendingElements;
    return (frozenPersistentRuleElements.get(ruleKey(rule)) || [])
      .filter((element) => element?.isConnected);
  }

  function resolveActiveVisibleRuleElements(rule) {
    const key = ruleKey(rule);
    return active && frozenVisibleRuleElements.has(key)
      ? frozenVisibleRuleElements.get(key).filter((element) => element?.isConnected)
      : resolveRuleElements(rule);
  }

  function schedulePersistentApplication() {
    if (persistentApplyQueued) {
      return;
    }
    persistentApplyQueued = true;
    queueMicrotask(() => {
      persistentApplyQueued = false;
      applyPersistentMarkers();
    });
  }

  function applyPersistentMarkers() {
    const nextElements = new Set();
    const nextGroupIdsByElement = new Map();
    const visibleExceptions = new Set();
    for (const rule of persistentVisiblePageRules) {
      for (const element of resolveActiveVisibleRuleElements(rule)) {
        visibleExceptions.add(element);
      }
    }
    for (const rule of getActiveRules()) {
      const matchedElements = resolveActiveHiddenRuleElements(rule);
      const groupId = hiddenRuleGroupId(rule);
      for (const element of matchedElements) {
        if (rule.overlay) overlayElements.add(element);
        if (!visibleExceptions.has(element)) {
          nextElements.add(element);
          const groupIds = nextGroupIdsByElement.get(element) || new Set();
          groupIds.add(groupId);
          nextGroupIdsByElement.set(element, groupIds);
        }
      }
    }

    persistentGroupIdsByElement = nextGroupIdsByElement;

    for (const element of [...persistentMarkedElements]) {
      if (nextElements.has(element)) {
        continue;
      }
      element.removeAttribute?.(PERSISTENT_ATTRIBUTE);
      restoreInlineDisplay(element, persistentInlineStates.get(element));
      if (active) {
        restoreTopLayerForPreview(element, persistentTopLayerStates.get(element));
      } else {
        restoreTopLayerState(element, persistentTopLayerStates.get(element));
      }
      persistentInlineStates.delete(element);
      persistentTopLayerStates.delete(element);
      persistentMarkedElements.delete(element);
    }

    for (const element of nextElements) {
      ensureRootStyle(element.getRootNode());
      if (!persistentMarkedElements.has(element)) {
        if (!persistentInlineStates.has(element)) {
          persistentInlineStates.set(
            element,
            sessionInlineStates.get(element) || readInlineDisplay(element)
          );
        }
        if (!persistentTopLayerStates.has(element)) {
          persistentTopLayerStates.set(
            element,
            sessionTopLayerStates.get(element) || readTopLayerState(element)
          );
        }
        persistentMarkedElements.add(element);
      }
      const liveTopLayerState = readTopLayerState(element);
      const savedTopLayerState = persistentTopLayerStates.get(element);
      if (liveTopLayerState?.open && !savedTopLayerState?.open) {
        persistentTopLayerStates.set(element, liveTopLayerState);
      }
      if (!element.hasAttribute(PERSISTENT_ATTRIBUTE)) {
        element.setAttribute(PERSISTENT_ATTRIBUTE, "");
      }
      if (hiddenPreview && active) {
        restoreInlineDisplay(element, persistentInlineStates.get(element));
        restoreTopLayerForPreview(element, persistentTopLayerStates.get(element));
      } else {
        deactivateTopLayer(element);
        if (element.style.getPropertyValue("display") !== "none" ||
            element.style.getPropertyPriority("display") !== "important") {
          forceInlineHidden(element);
        }
      }
    }
    updateCount();
  }

  function resolveRuleElements(rule) {
    let roots = [document];
    for (const hostMatcher of rule.shadowHosts || []) {
      const nextRoots = [];
      for (const root of roots) {
        for (const host of findMatcherElements(root, hostMatcher)) {
          if (host.shadowRoot) {
            observeShadowRoot(host.shadowRoot);
            nextRoots.push(host.shadowRoot);
          }
        }
      }
      roots = nextRoots;
      if (!roots.length) {
        return [];
      }
    }

    return roots.flatMap((root) => {
      if (root instanceof ShadowRoot) {
        ensureRootStyle(root);
        observeShadowRoot(root);
      }
      return findMatcherElements(root, rule);
    });
  }

  function ensureRootStyle(root) {
    if (!(root instanceof ShadowRoot)) {
      return;
    }
    const selector = `[${PERSISTENT_ATTRIBUTE}], [${SESSION_ATTRIBUTE}]`;
    const cssText = hiddenPreview
      ? hiddenPreviewCss(selector)
      : `${selector} { display: none !important; }`;
    const current = shadowRootStyles.get(root);
    if (current?.sheet && root.adoptedStyleSheets.includes(current.sheet)) {
      current.sheet.replaceSync(cssText);
      return;
    }
    if (current?.style?.isConnected && current.style.parentNode === root) {
      if (current.style.textContent !== cssText) current.style.textContent = cssText;
      return;
    }
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      shadowRootStyles.set(root, { sheet });
    } catch {
      const style = document.createElement("style");
      style.setAttribute(ROOT_STYLE_ATTRIBUTE, "");
      style.textContent = cssText;
      root.append(style);
      shadowRootStyles.set(root, { style });
    }
  }

  function readInlineDisplay(element) {
    return {
      value: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display")
    };
  }

  function forceInlineHidden(element) {
    element.style.setProperty("display", "none", "important");
  }

  function restoreInlineDisplay(element, state) {
    if (!element || !state) {
      return;
    }
    if (state.value) {
      element.style.setProperty("display", state.value, state.priority);
    } else {
      element.style.removeProperty("display");
    }
  }

  function readTopLayerState(element) {
    if (element instanceof HTMLDialogElement) {
      return {
        kind: "dialog",
        open: element.open,
        modal: element.open && element.matches(":modal")
      };
    }
    if (element.hasAttribute?.("popover")) {
      return {
        kind: "popover",
        open: element.matches(":popover-open")
      };
    }
    return null;
  }

  function deactivateTopLayer(element) {
    try {
      if (element instanceof HTMLDialogElement && element.open) {
        element.close();
      } else if (element.hasAttribute?.("popover") && element.matches(":popover-open")) {
        element.hidePopover();
      }
    } catch {
      // The page may have changed the top-layer state between inspection and update.
    }
  }

  function restoreTopLayerState(element, state) {
    if (!element || !state?.open) {
      return;
    }
    try {
      if (state.kind === "dialog" && element instanceof HTMLDialogElement && !element.open) {
        state.modal ? element.showModal() : element.show();
      } else if (state.kind === "popover" && !element.matches(":popover-open")) {
        element.showPopover();
      }
    } catch {
      // Reopening is best-effort if the page removed or reconfigured the element.
    }
  }

  function restoreTopLayerForPreview(element, state) {
    if (!element || !state?.open || readTopLayerState(element)?.open) {
      return;
    }
    const pickerWasModal = uiTopLayer instanceof HTMLDialogElement && uiTopLayer.open;
    const pickerWasPopover = !pickerWasModal && uiHost?.matches?.(":popover-open");
    try {
      if (pickerWasModal) {
        uiTopLayer.close();
      } else if (pickerWasPopover) {
        uiHost.hidePopover();
      }
      restoreTopLayerState(element, state);
    } finally {
      try {
        if (pickerWasModal && active && uiTopLayer?.isConnected) {
          uiTopLayer.showModal();
        } else if (pickerWasPopover && active && uiHost?.isConnected) {
          uiHost.showPopover();
        }
      } catch {
        // The fixed picker remains usable if its top-layer state changed mid-preview.
      }
    }
  }

  function observeShadowRoot(root) {
    if (observedShadowRoots.has(root)) {
      return;
    }
    observedShadowRoots.add(root);
    new MutationObserver(records => {
      if (records.some(isRelevantMutation)) schedulePersistentApplication();
    }).observe(root, observationOptions);
  }

  async function handlePossibleNavigation() {
    if (finishing) {
      return false;
    }
    const nextPageKey = getPageKey();
    if (nextPageKey === pageKey) {
      return false;
    }

    if (active) {
      cancelPicking();
    }
    pageKey = nextPageKey;
    persistentPageRules = [];
    persistentVisiblePageRules = [];
    applyPersistentStyle();
    await loadAndApplyRules();
    return true;
  }

  async function startPicking() {
    if (active || starting || !document.documentElement) {
      return;
    }

    starting = true;
    try {
      await rulesLoadPromise;
      await handlePossibleNavigation();
      await previewPreferenceWrite;
      const previewPreference = await chrome.storage.local.get(PREVIEW_STORAGE_KEY)
        .catch(() => ({}));
      latestViewportCapture = null;
      active = true;
      activeSessionId = ++sessionSequence;
      frozenPersistentRuleElements = new Map(getActiveRules().map((rule) => [
        ruleKey(rule),
        resolveRuleElements(rule).filter((element) => element?.isConnected)
      ]));
      frozenVisibleRuleElements = new Map(persistentVisiblePageRules.map((rule) => [
        ruleKey(rule),
        resolveRuleElements(rule).filter((element) => element?.isConnected)
      ]));
      selectionLevel = SELECTION_LEVEL.BROADEST;
      pendingItems = [];
      removedPageRules = [];
      removedSiteRules = [];
      addedVisiblePageRules = [];
      removedVisiblePageRules = [];
      resetSnapshot = null;
      resetBusy = false;
      hiddenPreview = false;
      clickThrough = false;
      currentCandidate = null;
      ensureSessionStyle();
      createInterface();
      markCrossOriginIframes();
      setHiddenPreview(previewPreference[PREVIEW_STORAGE_KEY] === true, false);
      showPickerPrompts(activeSessionId);
      document.documentElement.classList.add(PICKING_CLASS);
      document.addEventListener("keydown", onKeyChange, true);
      document.addEventListener("keyup", onKeyChange, true);
      window.addEventListener("blur", clearModifierState);
      window.addEventListener("scroll", updateCandidate, true);
      window.addEventListener("resize", updateCandidate, true);
      window.addEventListener("scroll", updatePreviewViewport, true);
      window.addEventListener("resize", updatePreviewViewport, true);
      window.visualViewport?.addEventListener("scroll", updatePreviewViewport);
      window.visualViewport?.addEventListener("resize", updatePreviewViewport);
    } finally {
      starting = false;
    }
  }

  function stopPicking() {
    if (hiddenPreview) {
      setHiddenPreview(false, false);
    }
    active = false;
    frozenPersistentRuleElements = new Map();
    frozenVisibleRuleElements = new Map();
    starting = false;
    finishing = false;
    activeSessionId = 0;
    resetSnapshot = null;
    resetBusy = false;
    selectionLevel = SELECTION_LEVEL.BROADEST;
    currentCandidate = null;
    pressedSelection = null;
    lastPointer = null;
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    setHiddenPreviewInteractionMode(false);
    clearHiddenPreviewMasks();
    document.documentElement?.classList.remove(PICKING_CLASS);
    document.documentElement?.classList.remove(CLICK_THROUGH_CLASS);
    clickThrough = false;
    document.removeEventListener("keydown", onKeyChange, true);
    document.removeEventListener("keyup", onKeyChange, true);
    window.removeEventListener("blur", clearModifierState);
    window.removeEventListener("scroll", updateCandidate, true);
    window.removeEventListener("resize", updateCandidate, true);
    window.removeEventListener("scroll", updatePreviewViewport, true);
    window.removeEventListener("resize", updatePreviewViewport, true);
    window.visualViewport?.removeEventListener("scroll", updatePreviewViewport);
    window.visualViewport?.removeEventListener("resize", updatePreviewViewport);
    clearCrossOriginIframeShields();
    ensureSessionStyle();
    (uiTopLayer || uiHost)?.remove();
    restoreDisplacedTopLayers();
    uiHost = null;
    uiTopLayer = null;
    displacedTopLayers = [];
    shadowRoot = null;
    highlight = null;
    countLabel = null;
    hiddenToggleButton = null;
    restoreAllButton = null;
    captureLayer = null;
    hiddenPreviewLayer = null;
    schedulePersistentApplication();
  }

  function enableToolbarDragging(toolbar) {
    let press = null;
    let suppressClick = false;

    toolbar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || press) return;
      suppressClick = false;
      const rect = toolbar.getBoundingClientRect();
      press = { id: event.pointerId, x: event.clientX, y: event.clientY,
        left: rect.left, top: rect.top, dragging: false };
      // Capture on the original target so stationary clicks still reach its button.
      event.target.setPointerCapture(event.pointerId);
    }, true);

    toolbar.addEventListener("pointermove", (event) => {
      if (!press || press.id !== event.pointerId) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) < 4) return;
      press.dragging = true;
      suppressClick = true;
      event.preventDefault();
      const rect = toolbar.getBoundingClientRect();
      toolbar.style.transform = "none";
      toolbar.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, press.left + dx))}px`;
      const extraHeight = toolbar.querySelector(".coffee-prompt")?.offsetHeight || 0;
      toolbar.style.top = `${Math.max(0, Math.min(innerHeight - rect.height - (extraHeight ? extraHeight + 12 : 0), press.top + dy))}px`;
    }, true);

    const endDrag = (event) => {
      if (press?.id === event.pointerId) press = null;
    };
    toolbar.addEventListener("pointerup", endDrag, true);
    toolbar.addEventListener("pointercancel", endDrag, true);
    toolbar.addEventListener("lostpointercapture", endDrag, true);
    toolbar.addEventListener("click", (event) => {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }, true);
  }

  async function showPickerPrompts(sessionId) {
    const coffee = chrome.runtime.sendMessage({ type: "annoy-killer:picker-opened" })
      .catch(() => null);
    await showShortcutGuide(sessionId);
    const result = await coffee;
    if (!result?.show || !active || activeSessionId !== sessionId || !shadowRoot ||
        shadowRoot.querySelector(".shortcut-guide")) return;
    const button = document.createElement("button");
    button.className = "coffee-prompt";
    button.setAttribute("aria-label", t("coffeePrompt"));
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h12v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8Zm12 1h1a3 3 0 1 1 0 6h-1M4 22h15M8 2v3m4-3v3m4-3v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${t("coffeePrompt")}</span>`;
    button.addEventListener("click", async event => {
      event.stopPropagation();
      button.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: "annoy-killer:open-coffee" });
        if (response?.ok) button.remove();
      } catch {
        // Keep the entry available if opening the options page fails.
      } finally {
        button.disabled = false;
      }
    });
    shadowRoot.querySelector(".toolbar").append(button);
  }

  async function showShortcutGuide(sessionId) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "annoy-killer:claim-shortcut-guide" });
      if (!result?.show || !active || activeSessionId !== sessionId || !shadowRoot) return;
      const guide = document.createElement("div");
      guide.className = "shortcut-guide";
      const operationKeys = [IS_MAC ? "Command" : "Ctrl", "Shift", IS_MAC ? "Option" : "Alt"]
        .map(key => `<kbd>${key}</kbd>`);
      const toggleKey = AnnoyKillerShortcuts.label(shortcutKey);
      guide.innerHTML = `<div role="status"><ol class="guide-steps"><li>${t("refine", operationKeys)}</li><li>${t("exitGuide", ["<kbd>ESC</kbd>", "<kbd>Enter</kbd>"])}</li><li>${t("toggleGuide", `<kbd>${toggleKey}</kbd>`)}</li></ol></div>
        <button class="guide-close" aria-label="${t("closeGuide")}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`;
      guide.addEventListener("pointerenter", hideHighlight);
      guide.querySelector("button").addEventListener("click", event => {
        event.stopPropagation();
        guide.remove();
      });
      shadowRoot.append(guide);
    } catch {
      // A storage or extension reload failure must not block the picker.
    }
  }

  function createInterface() {
    const needsModalLayer = Boolean(document.querySelector(":modal"));
    displacedTopLayers = needsModalLayer ? captureOpenTopLayers() : [];
    uiHost = document.createElement("div");
    uiHost.setAttribute("data-annoy-killer-ui", "");
    uiHost.tabIndex = -1;
    if (!needsModalLayer) {
      uiHost.setAttribute("popover", "manual");
    }
    for (const [property, value] of Object.entries({
      display: "grid",
      placeItems: "center",
      visibility: "visible",
      opacity: "1",
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      pointerEvents: "none",
      zIndex: "2147483647",
      colorScheme: "dark"
    })) {
      uiHost.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value, "important");
    }
    shadowRoot = uiHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        --ak-layer-capture: 0;
        --ak-layer-preview: 10;
        --ak-layer-highlight: 20;
        --ak-layer-toolbar: 30;
        --ak-layer-guide: 40;
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        isolation: isolate;
        pointer-events: none;
        color-scheme: dark;
      }
      :host::backdrop {
        background: transparent;
        pointer-events: none;
      }
      .capture {
        position: fixed;
        inset: 0;
        z-index: var(--ak-layer-capture);
        pointer-events: auto;
        cursor: default;
        touch-action: pan-x pan-y;
      }
      .highlight {
        position: fixed;
        z-index: var(--ak-layer-highlight);
        display: none;
        box-sizing: border-box;
        border: 2px solid rgb(80, 156, 255);
        border-radius: 8px;
        background: rgba(76, 145, 255, 0.16);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.52) inset,
                    0 3px 18px rgba(0, 0, 0, 0.2);
        transition: left 70ms ease, top 70ms ease, width 70ms ease, height 70ms ease;
        will-change: left, top, width, height;
      }
      .highlight.fine {
        border-radius: 5px;
        border-color: rgb(255, 196, 72);
        background: rgba(255, 190, 55, 0.17);
      }
      .toolbar {
        position: fixed;
        z-index: var(--ak-layer-toolbar);
        top: max(12px, env(safe-area-inset-top));
        left: 50%;
        transform: translateX(-50%);
        height: 44px;
        min-width: 450px;
        width: max-content;
        max-width: calc(100vw - 24px);
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        background: rgba(8, 8, 12, 0.42);
        box-shadow: 0 9px 30px rgba(0, 0, 0, 0.28),
                    0 1px 0 rgba(255, 255, 255, 0.08) inset;
        -webkit-backdrop-filter: blur(18px) saturate(1.6) brightness(0.65);
        backdrop-filter: blur(18px) saturate(1.6) brightness(0.65);
        pointer-events: auto;
        font: 500 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: rgba(255, 255, 255, 0.78);
        user-select: none;
        touch-action: none;
      }
      .hidden-toggle {
        margin-right: 8px;
      }
      .shortcut-guide {
        position: fixed;
        z-index: var(--ak-layer-guide);
        top: max(68px, calc(env(safe-area-inset-top) + 56px));
        left: 50%;
        transform: translateX(-50%);
        display: block;
        width: max-content;
        max-width: calc(100vw - 24px);
        box-sizing: border-box;
        padding: 14px 52px 14px 18px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 14px;
        background: rgba(20, 20, 26, 0.82);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(18px);
        color: rgba(255, 255, 255, 0.9);
        font: 400 13px/1.8 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: auto;
      }
      .shortcut-guide .guide-steps {
        display: grid;
        gap: 10px;
        margin: 0;
        padding-left: 20px;
        list-style: decimal;
      }
      .shortcut-guide kbd {
        display: inline-block;
        padding: 0 5px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
        font: inherit;
        line-height: 20px;
      }
      .shortcut-guide .guide-close {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 28px;
        height: 28px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.68);
      }
      .eye {
        width: 18px;
        height: 18px;
        color: rgba(255, 255, 255, 0.72);
      }
      .eye-open {
        display: none;
      }
      .hidden-toggle[aria-pressed="true"] {
        color: white;
        background: rgba(255, 255, 255, 0.13);
      }
      .hidden-toggle[aria-pressed="true"] .eye-open {
        display: block;
      }
      .hidden-toggle[aria-pressed="true"] .eye-closed {
        display: none;
      }
      .count {
        flex: 1 0 auto;
        margin-right: 14px;
        white-space: nowrap;
      }
      .divider {
        width: 1px;
        flex-shrink: 0;
        height: 22px;
        margin: 0 3px;
        background: rgba(255, 255, 255, 0.12);
      }
      button {
        all: unset;
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border-radius: 9px;
        color: rgba(255, 255, 255, 0.78);
        pointer-events: auto;
        cursor: default;
      }
      button:hover {
        color: white;
        background: rgba(255, 255, 255, 0.10);
      }
      button:active {
        background: rgba(255, 255, 255, 0.16);
      }
      button:disabled {
        opacity: 0.34;
      }
      button:disabled:hover,
      button:disabled:active {
        color: rgba(255, 255, 255, 0.78);
        background: transparent;
      }
      button:focus-visible {
        outline: 2px solid rgb(80, 156, 255);
        outline-offset: -2px;
      }
      button svg {
        width: 17px;
        height: 17px;
      }
      .toolbar button {
        display: inline-flex;
        border-radius: 999px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: auto;
        padding: 0 13px;
        flex-shrink: 0;
        white-space: nowrap;
      }
      .toolbar .coffee-prompt {
        position: absolute;
        top: calc(100% + 12px);
        left: 50%;
        transform: translateX(-50%);
        width: max-content;
        max-width: calc(100vw - 24px);
        height: 40px;
        padding: 0 16px;
        gap: 9px;
        border-radius: 13px;
        border: 1px solid rgba(255, 211, 151, 0.24);
        background: rgba(30, 24, 19, 0.94);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22), 0 1px 0 rgba(255, 255, 255, 0.06) inset;
        backdrop-filter: blur(18px);
        color: rgb(244, 211, 166);
        font-size: 13px;
        cursor: pointer;
      }
      .coffee-prompt::before {
        content: "";
        position: absolute;
        top: -5px;
        left: calc(50% - 4px);
        width: 8px;
        height: 8px;
        transform: rotate(45deg);
        border-top: 1px solid rgba(255, 211, 151, 0.24);
        border-left: 1px solid rgba(255, 211, 151, 0.24);
        background: rgb(30, 24, 19);
      }
      .toolbar .coffee-prompt:hover { background: rgba(65, 46, 28, 0.94); }
      .coffee-prompt:hover::before { background: rgb(65, 46, 28); }
      .hidden-previews {
        position: fixed;
        inset: 0;
        z-index: var(--ak-layer-preview);
        isolation: isolate;
        pointer-events: none;
      }
      .hidden-preview-mask {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 0;
        box-sizing: border-box;
        contain: layout paint style;
        overflow: hidden;
        background: transparent;
        -webkit-backdrop-filter: blur(10px) saturate(0.72);
        backdrop-filter: blur(10px) saturate(0.72);
        will-change: transform;
        pointer-events: auto;
        cursor: default;
        touch-action: pan-x pan-y;
      }
      .hidden-preview-restore {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: var(--restore-size);
        height: var(--restore-size);
        border-radius: 0;
        background: transparent;
        color: var(--preview-eye-color, rgba(255, 255, 255, 0.3));
        box-shadow: none;
        transition: color 180ms ease;
      }
      .hidden-preview-restore:hover {
        background: transparent;
        color: var(--preview-eye-color, rgba(255, 255, 255, 0.3));
      }
      .hidden-preview-restore:active {
        background: transparent;
        color: var(--preview-eye-color, rgba(255, 255, 255, 0.3));
      }
      .hidden-preview-restore svg {
        width: var(--preview-eye-size);
        height: var(--preview-eye-size);
        filter: none;
        pointer-events: none;
      }
      @media (max-width: 640px) {
        .shortcut-guide {
          top: max(98px, calc(env(safe-area-inset-top) + 86px));
        }
        .toolbar {
          min-width: 0;
          width: calc(100vw - 24px);
          height: auto;
          flex-wrap: wrap;
          padding: 6px;
          border-radius: 24px;
        }
        .count {
          order: -1;
          flex-basis: 100%;
          margin: 0;
          padding: 4px 0 6px;
          text-align: center;
        }
        .toolbar button {
          flex: 1;
          min-width: 0;
          min-height: 34px;
          height: auto;
          gap: 4px;
          padding: 4px 10px;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .toolbar button svg { flex-shrink: 0; }
        .hidden-toggle {
          margin-right: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .highlight { transition: none; }
        .hidden-preview-restore,
        .hidden-preview-restore svg { animation: none; transition: none; }
      }
    `;

    highlight = document.createElement("div");
    highlight.className = "highlight";

    captureLayer = document.createElement("div");
    captureLayer.className = "capture";
    captureLayer.addEventListener("pointermove", onPointerMove);
    captureLayer.addEventListener("pointerdown", onPagePointerDown);
    captureLayer.addEventListener("pointerup", onPagePointerUp);
    captureLayer.addEventListener("pointercancel", clearPressedSelection);
    captureLayer.addEventListener("click", onPageClick);
    captureLayer.addEventListener("contextmenu", suppressCapturedEvent);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.innerHTML = `
      <button class="hidden-toggle" aria-label="${t("toggleHidden")}" aria-pressed="false" title="${t("showHidden")}">
        <svg class="eye eye-closed" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 3l18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.5 10.5 0 0 1 12 4c5.2 0 8.6 4.4 9.5 6.2.3.5.3 1.1 0 1.6a15 15 0 0 1-2 3M6.2 6.3A15 15 0 0 0 2.5 10.2c-.3.5-.3 1.1 0 1.6C3.4 13.6 6.8 18 12 18c1.2 0 2.3-.2 3.3-.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <svg class="eye eye-open" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2.5 10.2C3.4 8.4 6.8 4 12 4s8.6 4.4 9.5 6.2c.3.5.3 1.1 0 1.6C20.6 13.6 17.2 18 12 18s-8.6-4.4-9.5-6.2a1.7 1.7 0 0 1 0-1.6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <circle cx="12" cy="11" r="3" stroke="currentColor" stroke-width="1.8"/>
        </svg>
        <span class="button-label">${t("show")}</span>
      </button>
      <span class="count"></span>
      <button class="restore-all" aria-label="${t("reset")}" aria-pressed="false" title="${t("previewInitial")}">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4.5 8.5V4.8m0 0h3.7m-3.7 0 2.8 2.7A7 7 0 1 1 5.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="button-label">${t("reset")}</span>
      </button>
      <span class="divider"></span>
      <button class="done" aria-label="${t("done")}" title="${t("saveChanges")}">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="button-label">${t("done")}</span>
      </button>
    `;
    countLabel = toolbar.querySelector(".count");
    hiddenToggleButton = toolbar.querySelector(".hidden-toggle");
    restoreAllButton = toolbar.querySelector(".restore-all");
    updateCount();
    toolbar.addEventListener("pointerenter", hideHighlight);
    enableToolbarDragging(toolbar);

    hiddenToggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (finishing) return;
      const nextPreview = !hiddenPreview || hiddenPreviewClosing;
      setHiddenPreview(nextPreview);
      previewPreferenceWrite = previewPreferenceWrite
        .then(() => chrome.storage.local.set({ [PREVIEW_STORAGE_KEY]: nextPreview }))
        .catch(error => console.debug("无法保存显示状态。", error));
    });
    restoreAllButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleResetPreview();
    });

    toolbar.querySelector(".done").addEventListener("click", (event) => {
      event.stopPropagation();
      finishPicking().catch((error) => console.debug("无法完成隐藏操作。", error));
    });

    hiddenPreviewLayer = document.createElement("div");
    hiddenPreviewLayer.className = "hidden-previews";
    shadowRoot.append(style, captureLayer, highlight, hiddenPreviewLayer, toolbar);
    if (needsModalLayer) {
      uiTopLayer = document.createElement("dialog");
      uiTopLayer.setAttribute("data-annoy-killer-modal-layer", "");
      uiTopLayer.tabIndex = -1;
      for (const [property, value] of Object.entries({
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        maxWidth: "none",
        maxHeight: "none",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        pointerEvents: "none"
      })) {
        uiTopLayer.style.setProperty(
          property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          value,
          "important"
        );
      }
      const backdropStyle = document.createElement("style");
      backdropStyle.textContent = `[data-annoy-killer-modal-layer]::backdrop { background: transparent !important; pointer-events: none !important; }`;
      uiTopLayer.append(backdropStyle, uiHost);
      document.documentElement.appendChild(uiTopLayer);
    } else {
      document.documentElement.appendChild(uiHost);
    }
    try {
      if (needsModalLayer) {
        uiTopLayer.showModal();
        uiTopLayer.focus({ preventScroll: true });
      } else {
        uiHost.showPopover();
      }
    } catch {
      // Older Chromium versions keep the same fixed overlay outside the top layer.
    }
  }

  function getHiddenElements() {
    const hiddenElements = new Set(
      [...persistentMarkedElements].filter((element) => element?.isConnected)
    );
    for (const item of pendingItems) {
      for (const element of item.elements) {
        if (element?.isConnected) {
          hiddenElements.add(element);
        }
      }
    }
    return hiddenElements;
  }

  function hiddenRuleGroupId(rule) {
    return rule?.group ? `group:${rule.group}` : `rule:${ruleKey(rule)}`;
  }

  function pendingItemGroupId(item) {
    return item?.group ? `group:${item.group}` : hiddenRuleGroupId(item?.rule);
  }

  function getHiddenGroupComponents() {
    const groupIdsByElement = new Map();
    for (const [element, groupIds] of persistentGroupIdsByElement) {
      if (element?.isConnected) groupIdsByElement.set(element, new Set(groupIds));
    }
    for (const item of pendingItems) {
      const groupId = pendingItemGroupId(item);
      for (const element of item.elements) {
        if (!element?.isConnected) continue;
        const groupIds = groupIdsByElement.get(element) || new Set();
        groupIds.add(groupId);
        groupIdsByElement.set(element, groupIds);
      }
    }

    const elementsByGroupId = new Map();
    for (const [element, groupIds] of groupIdsByElement) {
      for (const groupId of groupIds) {
        const elements = elementsByGroupId.get(groupId) || new Set();
        elements.add(element);
        elementsByGroupId.set(groupId, elements);
      }
    }

    const remainingGroupIds = new Set(elementsByGroupId.keys());
    const components = [];
    while (remainingGroupIds.size) {
      const firstGroupId = remainingGroupIds.values().next().value;
      const groupIds = new Set();
      const elements = new Set();
      const queue = [firstGroupId];
      remainingGroupIds.delete(firstGroupId);
      while (queue.length) {
        const groupId = queue.pop();
        groupIds.add(groupId);
        for (const element of elementsByGroupId.get(groupId) || []) {
          elements.add(element);
          for (const linkedGroupId of groupIdsByElement.get(element) || []) {
            if (!groupIds.has(linkedGroupId) && remainingGroupIds.delete(linkedGroupId)) {
              queue.push(linkedGroupId);
            }
          }
        }
      }
      components.push({ groupIds, elements });
    }
    return components;
  }

  function getHiddenGroupIds() {
    return new Set(getHiddenGroupComponents().map((component) =>
      [...component.groupIds].sort().join("\u0000")));
  }

  function getHiddenGroupForElement(element) {
    return getHiddenGroupComponents().find((component) => component.elements.has(element));
  }

  function updateCount() {
    updateOverlayScrollLock();
    const hiddenCount = getHiddenGroupIds().size;
    if (countLabel) {
      countLabel.textContent = t("hiddenCount", String(hiddenCount));
    }
    if (restoreAllButton) {
      restoreAllButton.disabled = resetBusy ||
        (!resetSnapshot && hiddenCount === 0 && persistentPageRules.length === 0 &&
          persistentSiteRules.length === 0);
      const label = resetSnapshot ? t("restore") : t("reset");
      restoreAllButton.querySelector(".button-label").textContent = label;
      restoreAllButton.setAttribute("aria-label", label);
      restoreAllButton.setAttribute("aria-pressed", String(Boolean(resetSnapshot)));
      restoreAllButton.title = resetSnapshot ? t("restorePrevious") : t("previewInitial");
    }
    if (hiddenPreview) {
      updateHiddenPreviewMasks();
    }
  }

  function setHiddenPreview(nextPreview, animate = true) {
    const shouldPreview = Boolean(nextPreview && active && !finishing);
    if (hiddenPreview === shouldPreview && !hiddenPreviewClosing) {
      return;
    }
    const revision = ++hiddenPreviewRevision;
    const wasClosing = hiddenPreviewClosing;
    hiddenPreviewClosing = false;
    hiddenToggleButton?.setAttribute("aria-pressed", String(shouldPreview));
    hiddenToggleButton?.setAttribute("title", shouldPreview ? t("collapseHidden") : t("showHidden"));
    const toggleLabel = hiddenToggleButton?.querySelector(".button-label");
    if (toggleLabel) {
      toggleLabel.textContent = shouldPreview ? t("hide") : t("show");
    }
    currentCandidate = null;
    lastPointer = null;
    clearPressedSelection();
    hideHighlight();
    if (!shouldPreview && animate && !prefersReducedPreviewMotion()) {
      hiddenPreviewClosing = true;
      const fades = [];
      for (const element of getHiddenElements()) {
        if (hiddenPreviewRect(element)) {
          fades.push(animatePreviewOpacity(element, Number(getComputedStyle(element).opacity), 0, true));
        }
      }
      for (const mask of hiddenPreviewMasks.values()) {
        mask.classList.add("leaving");
        fades.push(animatePreviewOpacity(mask, Number(getComputedStyle(mask).opacity), 0, true));
      }
      Promise.all(fades).then(() => {
        if (revision === hiddenPreviewRevision && active && hiddenPreviewClosing) {
          setHiddenPreview(false, false);
        }
      });
      return;
    }
    const openingOpacities = new Map([...getHiddenElements()].map(element => [element,
      wasClosing ? Number(getComputedStyle(element).opacity) : 0]));
    const openingMaskOpacities = new Map([...hiddenPreviewMasks.values()].map(mask => [mask,
      Number(getComputedStyle(mask).opacity)]));
    hiddenPreview = shouldPreview;
    setHiddenPreviewInteractionMode(hiddenPreview);
    for (const [element, motion] of previewOpacityMotions) {
      if (![...retiringPreviewMasks.values()].includes(element)) {
        motion.cancel();
      }
    }
    applyPersistentStyle();
    ensureSessionStyle();

    for (const element of persistentMarkedElements) {
      if (!element?.isConnected) {
        continue;
      }
      ensureRootStyle(element.getRootNode());
      if (hiddenPreview) {
        restoreInlineDisplay(element, persistentInlineStates.get(element));
        restoreTopLayerForPreview(element, persistentTopLayerStates.get(element));
      } else {
        deactivateTopLayer(element);
        forceInlineHidden(element);
      }
    }
    for (const item of pendingItems) {
      for (const state of item.elementStates) {
        if (!state.element?.isConnected) {
          continue;
        }
        ensureRootStyle(state.element.getRootNode());
        if (hiddenPreview) {
          restoreInlineDisplay(state.element, state.inlineDisplay);
          restoreTopLayerForPreview(state.element, state.topLayerState);
        } else {
          deactivateTopLayer(state.element);
          forceInlineHidden(state.element);
        }
      }
    }
    if (hiddenPreview) {
      cancelAnimationsForSession(activeSessionId);
      updateHiddenPreviewMasks();
      if (animate) {
        for (const [element, opacity] of openingOpacities) {
          if (hiddenPreviewRect(element)) {
            animatePreviewOpacity(element, opacity, Number(getComputedStyle(element).opacity));
          }
        }
        for (const mask of hiddenPreviewMasks.values()) {
          mask.classList.remove("leaving");
          if (wasClosing) {
            animatePreviewOpacity(mask, openingMaskOpacities.get(mask) || 0, 1);
          }
        }
      }
    } else {
      clearHiddenPreviewMasks();
    }
  }

  function prefersReducedPreviewMotion() {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Inline !important opacity also works on pages whose own styles use it.
  // Preserve the original declarations and never leave animation styles behind.
  function animatePreviewOpacity(element, from, to, hold = false, duration = PREVIEW_MOTION_DURATION) {
    previewOpacityMotions.get(element)?.cancel();
    if (prefersReducedPreviewMotion() || !element.isConnected) {
      return Promise.resolve();
    }
    const original = ["opacity", "transition-property", "transition-duration",
      "transition-timing-function", "transition-delay", "transition-behavior"].map(name => ({ name,
      value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }));
    const written = new Map();
    let frame = 0;
    let lastOpacity = String(from);
    let resolveMotion;
    const finished = new Promise(resolve => { resolveMotion = resolve; });
    const motion = { cancel() {
      cancelAnimationFrame(frame);
      if (previewOpacityMotions.get(element) !== motion) {
        return;
      }
      previewOpacityMotions.delete(element);
      for (const { name, value, priority } of original) {
        const expected = name === "opacity" ? lastOpacity : written.get(name);
        if (element.style.getPropertyValue(name) === expected &&
            element.style.getPropertyPriority(name) === "important") {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        }
      }
      resolveMotion();
    } };
    previewOpacityMotions.set(element, motion);
    element.style.setProperty("transition", "none", "important");
    element.style.setProperty("opacity", lastOpacity, "important");
    lastOpacity = element.style.getPropertyValue("opacity");
    for (const { name } of original) {
      written.set(name, element.style.getPropertyValue(name));
    }
    const startedAt = performance.now();
    const tick = now => {
      if (!element.isConnected) {
        motion.cancel();
        return;
      }
      const progress = Math.min(1, (now - startedAt) / duration);
      lastOpacity = String(from + (to - from) * (1 - Math.pow(1 - progress, 3)));
      element.style.setProperty("opacity", lastOpacity, "important");
      // CSSOM may round floating-point values; compare its serialized value on cleanup.
      lastOpacity = element.style.getPropertyValue("opacity");
      if (progress < 1) frame = requestAnimationFrame(tick);
      else if (hold) resolveMotion();
      else motion.cancel();
    };
    frame = requestAnimationFrame(tick);
    return finished;
  }

  function setPreviewEyeOpenness(mask, openness) {
    const mix = (closed, open) => closed + (open - closed) * openness;
    const smooth = value => {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    };
    mask.dataset.eyeOpenness = String(openness);
    // The lids share their endpoints and meet on the reference icon's curved lid.
    const edge = mix(380, 400);
    const upperControl = mix(500, 225);
    const upper = mix(527, 172);
    const lowerControl = mix(500, 575);
    const lower = mix(527, 628);
    mask.querySelector(".eye-contour").setAttribute("d",
      `M180 ${edge} C260 ${upperControl} 382 ${upper} 512 ${upper} C642 ${upper} 764 ${upperControl} 844 ${edge} C764 ${lowerControl} 642 ${lower} 512 ${lower} C382 ${lower} 260 ${lowerControl} 180 ${edge}Z`);
    const openWeight = smooth(openness / 0.3);
    mask.querySelector(".eye-contour").style.opacity = String(openWeight);
    mask.querySelector(".eye-reference").style.opacity = String(1 - openWeight);
    const iris = mask.querySelector(".eye-iris");
    iris.style.opacity = String(smooth((openness - 0.12) / 0.65));
    iris.setAttribute("transform", `translate(512 ${mix(527, 400)}) scale(1 ${openness})`);
  }

  function animatePreviewEye(mask, target, delay = 0) {
    previewEyeMotions.get(mask)?.cancel();
    if (prefersReducedPreviewMotion() || !mask.isConnected) {
      setPreviewEyeOpenness(mask, target);
      return Promise.resolve();
    }
    const from = Number(mask.dataset.eyeOpenness ?? 1);
    let frame = 0;
    let resolveMotion;
    const finished = new Promise(resolve => { resolveMotion = resolve; });
    const motion = { cancel() {
      cancelAnimationFrame(frame);
      if (previewEyeMotions.get(mask) === motion) previewEyeMotions.delete(mask);
      resolveMotion();
    } };
    previewEyeMotions.set(mask, motion);
    let startedAt = null;
    const tick = now => {
      if (!mask.isConnected) {
        motion.cancel();
        return;
      }
      startedAt ??= now + delay;
      const progress = Math.max(0, Math.min(1, (now - startedAt) / 280));
      const eased = progress * progress * (3 - 2 * progress);
      setPreviewEyeOpenness(mask, from + (target - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else motion.cancel();
    };
    frame = requestAnimationFrame(tick);
    return finished;
  }

  function retireHiddenPreviewMask(element, mask) {
    hiddenPreviewMasks.delete(element);
    retiringPreviewMasks.set(element, mask);
    mask.classList.add("leaving");
    mask.style.pointerEvents = "none";
    previewOpacityMotions.get(mask)?.cancel();
    animatePreviewEye(mask, 1).then(async () => {
      if (retiringPreviewMasks.get(element) !== mask) return;
      await animatePreviewOpacity(mask, Number(getComputedStyle(mask).opacity), 0, true, 120);
      if (retiringPreviewMasks.get(element) === mask) {
        retiringPreviewMasks.delete(element);
        removeHiddenPreviewMask(mask);
        previewOpacityMotions.get(mask)?.cancel();
      }
    });
  }

  function clearHiddenPreviewMasks() {
    ++hiddenPreviewRevision;
    hiddenPreviewClosing = false;
    cancelAnimationFrame(hiddenPreviewFrame);
    hiddenPreviewFrame = 0;
    for (const mask of new Set([...hiddenPreviewMasks.values(), ...retiringPreviewMasks.values()])) {
      removeHiddenPreviewMask(mask);
    }
    hiddenPreviewLayer?.replaceChildren();
    hiddenPreviewMasks.clear();
    retiringPreviewMasks.clear();
    previewRestoredElements.clear();
    for (const motion of previewEyeMotions.values()) {
      motion.cancel();
    }
    for (const motion of previewOpacityMotions.values()) {
      motion.cancel();
    }
  }

  function updatePreviewViewport() {
    if (active && hiddenPreview && hiddenPreviewLayer) {
      // Anchored masks move with the page in the browser's layout pass. Only the
      // fixed fallback needs an immediate geometry refresh while scrolling.
      if ([...hiddenPreviewMasks.values()].some(mask =>
        hiddenPreviewMaskStates.get(mask)?.mode === "fixed")) {
        cancelAnimationFrame(hiddenPreviewFrame);
        hiddenPreviewFrame = 0;
        updateHiddenPreviewMasks();
      }
    }
  }

  function updateHiddenPreviewMasks() {
    if (!active || !hiddenPreview || !hiddenPreviewLayer) {
      return;
    }
    const visibleElements = new Set();
    const hiddenElements = getHiddenElements();
    // Keep masks outside the page DOM so images, iframes and shadow contents can
    // all be covered without changing their layout or adding children to them.
    for (const element of hiddenElements) {
      const anchorHost = hiddenPreviewAnchorHost(element);
      const rect = anchorHost ? hiddenPreviewAnchorRect(element) : hiddenPreviewRect(element);
      if (!rect) {
        continue;
      }
      visibleElements.add(element);
      let mask = hiddenPreviewMasks.get(element);
      if (!mask) {
        const retiringMask = retiringPreviewMasks.get(element);
        if (retiringMask) {
          retiringPreviewMasks.delete(element);
          const opacity = Number(getComputedStyle(retiringMask).opacity);
          previewOpacityMotions.get(retiringMask)?.cancel();
          mask = retiringMask;
          mask.classList.remove("leaving");
          mask.style.removeProperty("pointer-events");
          animatePreviewOpacity(mask, opacity, 1);
          animatePreviewEye(mask, 0);
        } else {
          mask = createHiddenPreviewMask(element);
          mountHiddenPreviewMask(element, mask, anchorHost);
          animatePreviewOpacity(mask, 0, hiddenPreviewClosing ? 0 : 1);
          animatePreviewEye(mask, 0, 100);
        }
        hiddenPreviewMasks.set(element, mask);
      }
      let maskState = hiddenPreviewMaskStates.get(mask);
      if ((anchorHost && maskState?.mode !== "anchor") ||
          (!anchorHost && maskState?.mode !== "fixed") ||
          (anchorHost && maskState?.host !== anchorHost)) {
        removeHiddenPreviewMask(mask);
        mask = createHiddenPreviewMask(element);
        mountHiddenPreviewMask(element, mask, anchorHost);
        hiddenPreviewMasks.set(element, mask);
        maskState = hiddenPreviewMaskStates.get(mask);
        animatePreviewOpacity(mask, 0, hiddenPreviewClosing ? 0 : 1);
        animatePreviewEye(mask, 0, 100);
      }
      const geometry = `${rect.left}px ${rect.top}px ${rect.width}px ${rect.height}px ${maskState?.mode || ""}`;
      if (mask.dataset.geometry !== geometry) {
        mask.dataset.geometry = geometry;
        if (hiddenPreviewMaskStates.get(mask)?.mode === "fixed") {
          mask.style.setProperty("transform", `translate3d(${rect.left}px, ${rect.top}px, 0)`, "important");
          mask.style.setProperty("width", `${rect.width}px`, "important");
          mask.style.setProperty("height", `${rect.height}px`, "important");
        }
        const shortSide = Math.min(rect.width, rect.height);
        const eyeSize = Math.min(80, shortSide * 0.5);
        const restoreSize = Math.min(shortSide, Math.max(36, eyeSize + 16));
        mask.style.setProperty("--preview-eye-size", `${eyeSize}px`);
        mask.style.setProperty("--restore-size", `${restoreSize}px`);
        mask.style.setProperty("--preview-eye-color", previewEyeColor(element));
      }
    }
    for (const [element, mask] of hiddenPreviewMasks) {
      if (!visibleElements.has(element)) {
        if (!hiddenElements.has(element)) {
          retireHiddenPreviewMask(element, mask);
        } else {
          removeHiddenPreviewMask(mask);
          hiddenPreviewMasks.delete(element);
          previewOpacityMotions.get(mask)?.cancel();
          previewEyeMotions.get(mask)?.cancel();
        }
      }
    }
    if (!hiddenPreviewFrame) {
      hiddenPreviewFrame = requestAnimationFrame(() => {
        hiddenPreviewFrame = 0;
        updateHiddenPreviewMasks();
      });
    }
  }

  function hiddenPreviewRect(element) {
    const elementBounds = element.getBoundingClientRect();
    const rect = clipRectToViewport(elementBounds);
    if (!rect || getComputedStyle(element).visibility !== "visible") {
      return null;
    }
    // Scroll containers clip the real module as well as its preview mask.
    for (let current = element; current; current = getComposedParent(current)) {
      if (readTopLayerState(current)?.open) {
        break;
      }
      const parent = getComposedParent(current);
      if (!parent) {
        break;
      }
      if (parent.hasAttribute(SESSION_ATTRIBUTE) || parent.hasAttribute(PERSISTENT_ATTRIBUTE)) {
        return null;
      }
      // The viewport clipping above already accounts for the document scroll root.
      // YouTube keeps BODY scrollable while reporting a zero-height client rect;
      // treating that rect as a real clipping box would suppress every preview mask.
      if (parent === document.body || parent === document.documentElement) {
        continue;
      }
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible" && style.overflowY === "visible") {
        continue;
      }
      const bounds = parent.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        rect.left = Math.max(rect.left, bounds.left);
        rect.right = Math.min(rect.right, bounds.right);
      }
      if (style.overflowY !== "visible") {
        rect.top = Math.max(rect.top, bounds.top);
        rect.bottom = Math.min(rect.bottom, bounds.bottom);
      }
    }
    clipHiddenPreviewBelowPageOverlays(element, rect);
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
    rect.anchorX = elementBounds.left + elementBounds.width / 2;
    rect.anchorY = elementBounds.top + elementBounds.height / 2;
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function clipHiddenPreviewBelowPageOverlays(element, rect) {
    if (rect.bottom - rect.top <= 1 || rect.right - rect.left <= 1) return;
    const sampleXs = [...new Set([
      Math.max(0, Math.min(innerWidth - 1, rect.left + 1)),
      Math.max(0, Math.min(innerWidth - 1, (rect.left + rect.right) / 2)),
      Math.max(0, Math.min(innerWidth - 1, rect.right - 1))
    ].map(value => Math.round(value)))];
    const sampleY = Math.max(0, Math.min(innerHeight - 1, rect.top + 1));
    const overlayBottoms = sampleXs.map(x => pageOverlayBottomAt(element, x, sampleY, rect.top));
    const covered = overlayBottoms.filter(bottom => bottom > rect.top);
    if (covered.length < Math.ceil(sampleXs.length * 2 / 3)) return;
    rect.top = Math.max(rect.top, Math.min(...covered));
  }

  function pageOverlayBottomAt(element, x, y, targetTop) {
    let bottom = targetTop;
    for (const hit of document.elementsFromPoint(x, y)) {
      if (!(hit instanceof Element) || hit.hasAttribute("data-annoy-killer-ui") ||
          hit.closest?.("[data-annoy-killer-ui]")) {
        continue;
      }
      if (hit === element || element.contains(hit)) break;
      const overlay = fixedPageOverlayAncestor(hit, element);
      if (!overlay) continue;
      const bounds = overlay.getBoundingClientRect();
      if (bounds.top <= targetTop + 1 && bounds.bottom > targetTop + 1 &&
          bounds.left <= x && bounds.right >= x) {
        bottom = Math.max(bottom, bounds.bottom);
      }
    }
    return bottom;
  }

  function fixedPageOverlayAncestor(hit, element) {
    for (let current = hit; current; current = getComposedParent(current)) {
      if (!(current instanceof Element)) continue;
      if (current === element || element.contains(current) || current.contains(element) ||
          current.hasAttribute("data-annoy-killer-ui")) {
        return null;
      }
      const position = getComputedStyle(current).position;
      if (position === "fixed" || position === "sticky") return current;
    }
    return null;
  }

  function hiddenPreviewAnchorHost(element) {
    if (!CSS.supports("anchor-name: --ak-preview") ||
        !CSS.supports("position-anchor: --ak-preview") ||
        !CSS.supports("left: anchor(left)") || readTopLayerState(element)?.open) {
      return null;
    }
    const parent = element.parentNode;
    if (element instanceof SVGElement || parent instanceof SVGElement) {
      return null;
    }
    return parent instanceof Element || parent instanceof ShadowRoot ? parent : null;
  }

  function hiddenPreviewAnchorRect(element) {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (bounds.width <= 0 || bounds.height <= 0 || style.visibility !== "visible" ||
        style.display === "none") {
      return null;
    }
    return {
      left: 0,
      top: 0,
      right: bounds.width,
      bottom: bounds.height,
      width: bounds.width,
      height: bounds.height,
      anchorX: bounds.width / 2,
      anchorY: bounds.height / 2
    };
  }

  function mountHiddenPreviewMask(element, mask, anchorHost) {
    if (!anchorHost) {
      hiddenPreviewMaskStates.set(mask, { mode: "fixed", host: hiddenPreviewLayer });
      hiddenPreviewLayer.append(mask);
      return;
    }
    const anchorName = `--ak-preview-${activeSessionId}-${++hiddenPreviewAnchorSequence}`;
    const inlineAnchorName = {
      value: element.style.getPropertyValue("anchor-name"),
      priority: element.style.getPropertyPriority("anchor-name")
    };
    const computedAnchorName = getComputedStyle(element).anchorName;
    const anchorNames = computedAnchorName && computedAnchorName !== "none"
      ? `${computedAnchorName}, ${anchorName}`
      : anchorName;
    element.style.setProperty("anchor-name", anchorNames, "important");
    mask.style.setProperty("position",
      getComputedStyle(element).position === "fixed" ? "fixed" : "absolute", "important");
    mask.style.setProperty("position-anchor", anchorName, "important");
    mask.style.setProperty("left", "anchor(left)", "important");
    mask.style.setProperty("top", "anchor(top)", "important");
    mask.style.setProperty("width", "anchor-size(width)", "important");
    mask.style.setProperty("height", "anchor-size(height)", "important");
    const zIndex = getComputedStyle(element).zIndex;
    mask.style.setProperty("z-index", zIndex === "auto" ? "auto" : zIndex, "important");
    hiddenPreviewMaskStates.set(mask, {
      mode: "anchor",
      host: anchorHost,
      element,
      inlineAnchorName
    });
    element.after(mask);
  }

  function removeHiddenPreviewMask(mask) {
    const state = hiddenPreviewMaskStates.get(mask);
    if (state?.mode === "anchor" && state.element?.isConnected) {
      const { value, priority } = state.inlineAnchorName;
      if (value) state.element.style.setProperty("anchor-name", value, priority);
      else state.element.style.removeProperty("anchor-name");
    }
    hiddenPreviewMaskStates.delete(mask);
    mask.remove();
  }

  function previewEyeColor(element) {
    let current = element;
    let foregroundLuminance = null;
    for (let depth = 0; current instanceof Element && depth < 8; depth += 1) {
      const style = getComputedStyle(current);
      const background = parsedColorLuminance(style.backgroundColor);
      if (background && background.alpha >= 0.15) {
        return background.luminance >= 0.52
          ? "rgba(0, 0, 0, 0.3)"
          : "rgba(255, 255, 255, 0.3)";
      }
      foregroundLuminance ??= parsedColorLuminance(style.color)?.luminance ?? null;
      current = getComposedParent(current);
    }
    // On transparent modules, the page text color is a reliable indication of
    // whether the surrounding surface uses a light or dark theme.
    return foregroundLuminance !== null && foregroundLuminance >= 0.52
      ? "rgba(255, 255, 255, 0.3)"
      : "rgba(0, 0, 0, 0.3)";
  }

  function parsedColorLuminance(value) {
    const channels = String(value).match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3) return null;
    const alpha = channels.length > 3 ? channels[3] : 1;
    const linear = channels.slice(0, 3).map(channel => {
      const normalized = Math.max(0, Math.min(255, channel)) / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return {
      alpha,
      luminance: 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    };
  }

  function createHiddenPreviewMask(element) {
    const mask = document.createElement("div");
    mask.className = "hidden-preview-mask";
    mask.setAttribute("data-annoy-killer-ui", "");
    mask.setAttribute("data-annoy-killer-preview-mask", "");
    for (const [property, value] of Object.entries({
      display: "grid",
      placeItems: "center",
      visibility: "visible",
      opacity: "1",
      left: "0",
      top: "0",
      margin: "0",
      padding: "0",
      border: "0",
      boxSizing: "border-box",
      isolation: "isolate",
      overflow: "hidden",
      background: "transparent",
      WebkitBackdropFilter: "blur(10px) saturate(0.72)",
      backdropFilter: "blur(10px) saturate(0.72)",
      pointerEvents: clickThrough ? "none" : "auto",
      cursor: "default",
      touchAction: "pan-x pan-y"
    })) {
      mask.style.setProperty(property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), value, "important");
    }
    mask.style.borderRadius = getComputedStyle(element).borderRadius;
    mask.addEventListener("pointerenter", () => {
      currentCandidate = null;
      lastPointer = null;
      clearPressedSelection();
      hideHighlight();
    });
    let press = null;
    let clickedWithoutDragging = false;
    mask.addEventListener("pointerdown", event => {
      suppressCapturedEvent(event);
      clickedWithoutDragging = false;
      press = event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    });
    mask.addEventListener("pointerup", event => {
      suppressCapturedEvent(event);
      clickedWithoutDragging = event.button === 0 && press?.id === event.pointerId &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 8;
      press = null;
    });
    mask.addEventListener("pointercancel", () => {
      press = null;
      clickedWithoutDragging = false;
    });
    mask.addEventListener("contextmenu", suppressCapturedEvent);

    const button = document.createElement("button");
    button.className = "hidden-preview-restore";
    button.style.cssText = "all:unset!important;position:static!important;transform:none!important;display:grid!important;place-items:center!important;width:var(--restore-size)!important;height:var(--restore-size)!important;border-radius:0!important;background:transparent!important;color:var(--preview-eye-color,rgba(255,255,255,.3))!important;box-shadow:none!important;pointer-events:auto!important;cursor:default!important";
    button.setAttribute("aria-label", t("restoreItem"));
    button.title = t("restoreModule");
    button.innerHTML = `<svg style="width:var(--preview-eye-size);height:var(--preview-eye-size);filter:none;pointer-events:none" viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
      <path class="eye-reference" d="${HIDDEN_EYE_PATH}" fill="currentColor"/>
      <path class="eye-contour" stroke="currentColor" stroke-width="76.8" stroke-linecap="round" stroke-linejoin="round"/>
      <g class="eye-iris">
        <circle r="105" stroke="currentColor" stroke-width="64"/>
        <circle r="35" fill="currentColor"/>
      </g>
    </svg>`;
    mask.addEventListener("click", (event) => {
      suppressCapturedEvent(event);
      if (event.detail !== 0 && !clickedWithoutDragging) {
        return;
      }
      clickedWithoutDragging = false;
      if (getPageKey() !== pageKey) {
        handlePossibleNavigation();
        return;
      }
      if (!active || finishing || resetBusy || !hiddenPreview || hiddenPreviewClosing || !element.isConnected) {
        return;
      }
      if (getHiddenElements().has(element)) {
        restoreHiddenSelection(element);
      }
    });
    mask.append(button);
    setPreviewEyeOpenness(mask, 1);
    return mask;
  }

  function queuePendingItemRemoval(item) {
    if (!item?.rule) return;
    const scope = item.scope === "site" ? "site" : "page";
    const removedRules = scope === "site" ? removedSiteRules : removedPageRules;
    removeRules([item.rule], removedRules, scope);
  }

  function restoreHiddenItem(element, skipPendingItems = false) {
    if (!active || finishing || !hiddenPreview || hiddenPreviewClosing || !element?.isConnected) {
      return;
    }
    const opacity = Number(getComputedStyle(element).opacity);
    previewOpacityMotions.get(element)?.cancel();
    previewRestoredElements.add(element);
    let needsVisibleException = false;
    if (!skipPendingItems) {
      const nextPendingItems = [];
      for (const item of pendingItems) {
        const stateIndex = item.elementStates.findIndex((state) => state.element === element);
        if (stateIndex < 0) {
          nextPendingItems.push(item);
          continue;
        }
        if (item.elementStates.length === 1) {
          queuePendingItemRemoval(item);
          restorePendingItem(item, true);
          continue;
        }
        const [state] = item.elementStates.splice(stateIndex, 1);
        item.elements = item.elementStates.map((entry) => entry.element);
        restorePendingState(state, true);
        needsVisibleException = true;
        nextPendingItems.push(item);
      }
      pendingItems = nextPendingItems;
    }

    needsVisibleException = restorePersistentRulesForElement(
      element,
      persistentPageRules,
      removedPageRules,
      "page"
    ) || needsVisibleException;
    needsVisibleException = restorePersistentRulesForElement(
      element,
      persistentSiteRules,
      removedSiteRules,
      "site"
    ) || needsVisibleException;
    if (needsVisibleException) {
      addVisibleException(element);
    }
    applyPersistentStyle();
    applyPersistentMarkers();
    if (clearPageRulesWithoutHiddenItems()) {
      applyPersistentStyle();
      applyPersistentMarkers();
    }
    updateCount();
    animatePreviewOpacity(element, opacity, Number(getComputedStyle(element).opacity));
    scheduleSessionAutoSave();
  }

  function restoreHiddenSelection(element) {
    const group = getHiddenGroupForElement(element);
    const groupIds = group?.groupIds || new Set();
    const selection = group ? [...group.elements] : [element];

    const nextPendingItems = [];
    for (const item of pendingItems) {
      if (!groupIds.has(pendingItemGroupId(item))) {
        nextPendingItems.push(item);
        continue;
      }
      queuePendingItemRemoval(item);
      restorePendingItem(item, true);
    }
    pendingItems = nextPendingItems;

    const matchingPageRules = persistentPageRules.filter((rule) =>
      groupIds.has(hiddenRuleGroupId(rule)));
    if (matchingPageRules.length) {
      removeRules(matchingPageRules, removedPageRules, "page");
    }
    const matchingSiteRules = persistentSiteRules.filter((rule) =>
      groupIds.has(hiddenRuleGroupId(rule)));
    appendUniqueRules(persistentVisiblePageRules, matchingSiteRules);
    appendUniqueRules(addedVisiblePageRules, matchingSiteRules);
    for (const candidate of selection) restoreHiddenItem(candidate, true);
  }

  function toggleResetPreview() {
    if (!active || finishing || resetBusy) return;
    const sessionId = activeSessionId;
    const expectedPage = pageKey;
    const selections = [...inFlightSelections]
      .filter(selection => selection.sessionId === sessionId).map(selection => selection.promise);
    resetBusy = true;
    updateCount();
    const promise = (async () => {
      await Promise.allSettled(selections);
      await autoSaveQueue.catch(() => undefined);
      if (!active || activeSessionId !== sessionId || getPageKey() !== expectedPage) return;
      cancelAnimationsForSession(sessionId);
      if (resetSnapshot) {
        restoreResetSnapshot();
      } else {
        resetSnapshot = {
          pendingItems: pendingItems.map(item => ({ ...item, elements: item.elements.slice(),
            elementStates: item.elementStates.map(state => ({ ...state })) })),
          persistentPageRules: persistentPageRules.slice(),
          persistentSiteRules: persistentSiteRules.slice(),
          persistentVisiblePageRules: persistentVisiblePageRules.slice(),
          removedPageRules: removedPageRules.slice(),
          removedSiteRules: removedSiteRules.slice(),
          addedVisiblePageRules: addedVisiblePageRules.slice(),
          removedVisiblePageRules: removedVisiblePageRules.slice(),
          previewRestoredElements: [...previewRestoredElements]
        };
        restoreAllHiddenItems();
      }
    })();
    // Completing immediately after reset still waits for this staged operation.
    const tracked = { sessionId, promise };
    inFlightSelections.add(tracked);
    promise.finally(() => {
      inFlightSelections.delete(tracked);
      if (activeSessionId === sessionId) {
        resetBusy = false;
        updateCount();
      }
    });
  }

  function hasSessionChanges() {
    return pendingItems.length || removedPageRules.length || removedSiteRules.length ||
      addedVisiblePageRules.length || removedVisiblePageRules.length;
  }

  function scheduleSessionAutoSave() {
    const sessionId = activeSessionId;
    autoSaveQueue = autoSaveQueue
      .catch(() => undefined)
      .then(() => autoSaveSessionChanges(sessionId))
      .catch((error) => console.debug("无法自动保存已隐藏的干扰项。", error));
  }

  async function autoSaveSessionChanges(sessionId) {
    if (!active || finishing || resetSnapshot || activeSessionId !== sessionId || !hasSessionChanges()) {
      return;
    }
    const committedItems = pendingItems.slice();
    const result = await commitRulesWithRetry({
      pageKey,
      siteKey,
      pageRules: committedItems.filter((item) => item.scope === "page").map((item) => item.rule),
      siteRules: committedItems.filter((item) => item.scope === "site").map((item) => item.rule),
      removePageRules: removedPageRules.slice(),
      removeSiteRules: removedSiteRules.slice(),
      visiblePageRules: addedVisiblePageRules.slice(),
      removeVisiblePageRules: removedVisiblePageRules.slice()
    });
    if (!active || activeSessionId !== sessionId) {
      return;
    }
    const removedPageKeys = new Set(removedPageRules.map(ruleKey));
    const removedSiteKeys = new Set(removedSiteRules.map(ruleKey));
    const removedVisibleKeys = new Set(removedVisiblePageRules.map(ruleKey));
    persistentPageRules = sanitizeRules(result.pageRules)
      .filter((rule) => !removedPageKeys.has(ruleKey(rule)));
    persistentSiteRules = persistentSiteRules
      .filter((rule) => !removedSiteKeys.has(ruleKey(rule)));
    persistentVisiblePageRules = sanitizeRules([
      ...sanitizeRules(result.visiblePageRules),
      ...addedVisiblePageRules
    ]).filter((rule) => !removedVisibleKeys.has(ruleKey(rule)));
  }

  function restoreResetSnapshot() {
    const snapshot = resetSnapshot;
    resetSnapshot = null;
    if (hiddenPreviewClosing) setHiddenPreview(false, false);
    clearHiddenPreviewMasks();
    for (const item of [...pendingItems].reverse()) restorePendingItem(item, true);
    pendingItems = snapshot.pendingItems;
    persistentPageRules = snapshot.persistentPageRules;
    persistentSiteRules = snapshot.persistentSiteRules;
    persistentVisiblePageRules = snapshot.persistentVisiblePageRules;
    removedPageRules = snapshot.removedPageRules;
    removedSiteRules = snapshot.removedSiteRules;
    addedVisiblePageRules = snapshot.addedVisiblePageRules;
    removedVisiblePageRules = snapshot.removedVisiblePageRules;
    for (const element of snapshot.previewRestoredElements) {
      if (element.isConnected) previewRestoredElements.add(element);
    }
    ensureSessionStyle();
    for (const item of pendingItems) {
      for (const state of item.elementStates) {
        const element = state.element;
        if (!element?.isConnected) continue;
        sessionInlineStates.set(element, state.inlineDisplay);
        sessionTopLayerStates.set(element, state.topLayerState);
        ensureRootStyle(element.getRootNode());
        element.setAttribute(SESSION_ATTRIBUTE, item.token);
        if (hiddenPreview) {
          restoreInlineDisplay(element, state.inlineDisplay);
          restoreTopLayerForPreview(element, state.topLayerState);
        } else {
          deactivateTopLayer(element);
          forceInlineHidden(element);
        }
      }
    }
    applyPersistentStyle();
    applyPersistentMarkers();
    updateCount();
  }

  function restoreAllHiddenItems() {
    if (!active) {
      return;
    }
    if (hiddenPreviewClosing) {
      setHiddenPreview(false, false);
    }
    const restoringElements = [...getHiddenElements()].map(element => [element,
      hiddenPreview ? Number(getComputedStyle(element).opacity) : 0]);
    ++hiddenPreviewRevision;
    hiddenPreviewClosing = false;
    for (const [element] of restoringElements) {
      previewOpacityMotions.get(element)?.cancel();
      if (hiddenPreview) previewRestoredElements.add(element);
    }
    const markedElements = new Set(
      [...persistentMarkedElements].filter((element) => element?.isConnected)
    );
    for (const item of pendingItems) {
      queuePendingItemRemoval(item);
      restorePendingItem(item, true);
    }
    pendingItems = [];
    const pageRulesToRemove = removeRulesMatchingElements(
      persistentPageRules,
      removedPageRules,
      markedElements,
      "page"
    );
    const elementsCoveredByRemovedRules = new Set();
    for (const rule of pageRulesToRemove) {
      for (const element of resolveActiveHiddenRuleElements(rule)) {
        elementsCoveredByRemovedRules.add(element);
      }
    }
    const remainingPageRules = persistentPageRules.slice();
    if (remainingPageRules.length) {
      removeRules(remainingPageRules, removedPageRules, "page");
    }
    removeVisibleExceptionsMatchingElements(elementsCoveredByRemovedRules);
    appendUniqueRules(persistentVisiblePageRules, persistentSiteRules);
    appendUniqueRules(addedVisiblePageRules, persistentSiteRules);
    applyPersistentStyle();
    applyPersistentMarkers();
    if (clearPageRulesWithoutHiddenItems()) {
      applyPersistentStyle();
      applyPersistentMarkers();
    }
    updateCount();
    for (const [element, opacity] of restoringElements) {
      animatePreviewOpacity(element, opacity, Number(getComputedStyle(element).opacity));
    }
  }

  function restorePendingItem(item, keepPickerOnTop) {
    for (const state of [...item.elementStates].reverse()) {
      restorePendingState(state, keepPickerOnTop);
    }
  }

  function restorePendingState(state, keepPickerOnTop) {
    if (!state.element) {
      return;
    }
    if (state.previousToken === null) {
      state.element.removeAttribute(SESSION_ATTRIBUTE);
    } else {
      state.element.setAttribute(SESSION_ATTRIBUTE, state.previousToken);
    }
    restoreInlineDisplay(state.element, state.inlineDisplay);
    if (keepPickerOnTop) {
      restoreTopLayerForPreview(state.element, state.topLayerState);
    } else {
      restoreTopLayerState(state.element, state.topLayerState);
    }
    sessionInlineStates.delete(state.element);
    sessionTopLayerStates.delete(state.element);
  }

  function restorePersistentRulesForElement(element, rules, removedRules, scope) {
    const matchingRules = rules.filter((rule) =>
      resolveActiveHiddenRuleElements(rule).includes(element));
    const directlyRemovable = matchingRules.filter((rule) =>
      scope === "page" && resolveActiveHiddenRuleElements(rule).length === 1
    );
    if (directlyRemovable.length) {
      removeRules(directlyRemovable, removedRules, scope);
    }
    const directlyRemovableKeys = new Set(directlyRemovable.map(ruleKey));
    const visibleRuleKeys = new Set(persistentVisiblePageRules.map(ruleKey));
    return matchingRules.some((rule) =>
      !directlyRemovableKeys.has(ruleKey(rule)) && !visibleRuleKeys.has(ruleKey(rule)));
  }

  function removeRulesMatchingElements(rules, removedRules, elements, scope) {
    const matchingRules = rules.filter((rule) =>
      resolveActiveHiddenRuleElements(rule).some((element) => elements.has(element))
    );
    if (!matchingRules.length) {
      return [];
    }
    removeRules(matchingRules, removedRules, scope);
    return matchingRules;
  }

  function removeRules(rules, removedRules, scope) {
    const matchingKeys = new Set(rules.map(ruleKey));
    appendUniqueRules(removedRules, rules);
    if (scope === "page") {
      persistentPageRules = persistentPageRules.filter((rule) => !matchingKeys.has(ruleKey(rule)));
    } else {
      persistentSiteRules = persistentSiteRules.filter((rule) => !matchingKeys.has(ruleKey(rule)));
    }
  }

  function clearPageRulesWithoutHiddenItems() {
    if (getHiddenElements().size || !persistentPageRules.length) {
      return false;
    }
    const pageElements = new Set(persistentPageRules.flatMap(resolveActiveHiddenRuleElements));
    const sharedElements = new Set(persistentSiteRules.flatMap(resolveActiveHiddenRuleElements));
    removeRules(persistentPageRules.slice(), removedPageRules, "page");
    removeVisibleExceptionsMatchingElements(new Set(
      [...pageElements].filter((element) => !sharedElements.has(element))
    ));
    return true;
  }

  function addVisibleException(element) {
    const exception = createStableRule(element, false, false)?.rule;
    if (!exception) {
      return;
    }
    appendUniqueRules(persistentVisiblePageRules, [exception]);
    appendUniqueRules(addedVisiblePageRules, [exception]);
  }

  function removeVisibleExceptionsMatchingElements(elements) {
    const matchingRules = persistentVisiblePageRules.filter((rule) =>
      resolveActiveVisibleRuleElements(rule).some((element) => elements.has(element))
    );
    if (!matchingRules.length) {
      return [];
    }
    const matchingKeys = new Set(matchingRules.map(ruleKey));
    const addedKeys = new Set(addedVisiblePageRules.map(ruleKey));
    appendUniqueRules(
      removedVisiblePageRules,
      matchingRules.filter((rule) => !addedKeys.has(ruleKey(rule)))
    );
    persistentVisiblePageRules = persistentVisiblePageRules.filter(
      (rule) => !matchingKeys.has(ruleKey(rule))
    );
    addedVisiblePageRules = addedVisiblePageRules.filter(
      (rule) => !matchingKeys.has(ruleKey(rule))
    );
    return matchingRules;
  }

  function appendUniqueRules(target, rules) {
    const existing = new Set(target.map(ruleKey));
    for (const rule of rules) {
      const key = ruleKey(rule);
      if (!existing.has(key)) {
        existing.add(key);
        target.push(rule);
      }
    }
  }

  function cancelRuleRemovalTombstone(rule, scope) {
    const key = ruleKey(rule);
    if (scope === "site") {
      removedSiteRules = removedSiteRules.filter((removedRule) => ruleKey(removedRule) !== key);
    } else {
      removedPageRules = removedPageRules.filter((removedRule) => ruleKey(removedRule) !== key);
    }
  }

  function ruleKey(rule) {
    if (!rule || typeof rule !== "object") return JSON.stringify(rule);
    const { group: _group, ...identity } = rule;
    return JSON.stringify(sortObjectKeys(identity));
  }

  function sortObjectKeys(value) {
    if (Array.isArray(value)) {
      return value.map(sortObjectKeys);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])])
    );
  }

  function onPointerMove(event) {
    if (isPrimaryInteractionModifierEvent(event)) {
      setClickThroughMode(true);
      return;
    }
    if (clickThrough) setClickThroughMode(false);
    selectionLevel = selectionLevelFromEvent(event);
    lastPointer = { x: event.clientX, y: event.clientY };
    if (pointerFrame) {
      return;
    }
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      updateCandidate();
    });
  }

  function isPreviewUiEvent(event) {
    return event.composedPath().some(node =>
      node instanceof Element && node.hasAttribute("data-annoy-killer-ui"));
  }

  function onPreviewPointerMove(event) {
    if (!isClickThroughMode() && !isPreviewUiEvent(event)) onPointerMove(event);
  }

  function onPreviewPointerDown(event) {
    if (!isClickThroughMode() && !isPreviewUiEvent(event)) onPagePointerDown(event);
  }

  function onPreviewPointerUp(event) {
    if (!isClickThroughMode() && !isPreviewUiEvent(event)) onPagePointerUp(event);
  }

  function onPreviewClick(event) {
    if (!isClickThroughMode() && !isPreviewUiEvent(event)) onPageClick(event);
  }

  function onPreviewContextMenu(event) {
    if (!isClickThroughMode() && !isPreviewUiEvent(event)) suppressCapturedEvent(event);
  }

  function setHiddenPreviewInteractionMode(enabled) {
    if (captureLayer) captureLayer.style.pointerEvents = enabled || clickThrough ? "none" : "auto";
    const method = enabled ? "addEventListener" : "removeEventListener";
    document[method]("pointermove", onPreviewPointerMove, true);
    document[method]("pointerdown", onPreviewPointerDown, true);
    document[method]("pointerup", onPreviewPointerUp, true);
    document[method]("pointercancel", clearPressedSelection, true);
    document[method]("click", onPreviewClick, true);
    document[method]("contextmenu", onPreviewContextMenu, true);
  }

  function updateCandidate() {
    if (!active || !lastPointer) {
      return;
    }

    currentCandidate = candidateAtPoint(lastPointer.x, lastPointer.y, selectionLevel);
    drawHighlight(currentCandidate);
  }

  function candidateAtPoint(x, y, level) {
    if (resetBusy) return null;
    if (captureLayer) {
      captureLayer.style.pointerEvents = "none";
    }
    const pickerWasModal = uiTopLayer instanceof HTMLDialogElement && uiTopLayer.open;
    if (pickerWasModal) {
      uiTopLayer.close();
      restoreDisplacedTopLayers(true);
    }
    try {
      let rawTarget = document.elementFromPoint(x, y);
      if (rawTarget && rawTarget.tagName !== "IFRAME") {
        const shielded = findShieldedIframeAtPoint(x, y);
        if (shielded) rawTarget = shielded;
      }
      if (!isSelectable(rawTarget)) {
        return null;
      }
      const candidate = getBlockCandidate(getDeepTarget(rawTarget, x, y), level);
      return candidate && !elementsBeingSelected.has(candidate) ? candidate : null;
    } finally {
      if (pickerWasModal && active && uiTopLayer?.isConnected) {
        try {
          uiTopLayer.showModal();
        } catch {
          // The fixed overlay remains available if the top layer changed mid-hit-test.
        }
      }
      if (captureLayer?.isConnected) {
        captureLayer.style.pointerEvents = hiddenPreview || clickThrough ? "none" : "auto";
      }
    }
  }

  function isSelectable(element) {
    return element instanceof Element &&
      element !== document.documentElement &&
      element !== document.body &&
      !element.hasAttribute("data-annoy-killer-ui") &&
      !element.closest?.("[data-annoy-killer-ui]") &&
      !elementsBeingSelected.has(element) &&
      !element.hasAttribute(SESSION_ATTRIBUTE) &&
      !element.hasAttribute(PERSISTENT_ATTRIBUTE);
  }

  function isCrossOriginIframe(iframe) {
    if (!(iframe instanceof HTMLIFrameElement)) return false;
    const src = iframe.getAttribute("src") || "";
    if (!src || src === "about:blank" || src.startsWith("javascript:") ||
        src.startsWith("data:")) {
      return false;
    }
    try {
      return new URL(src, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  }

  function markCrossOriginIframes() {
    for (const iframe of document.querySelectorAll("iframe")) {
      if (isCrossOriginIframe(iframe) && !iframe.hasAttribute(IFRAME_SHIELD_ATTRIBUTE)) {
        iframe.setAttribute(IFRAME_SHIELD_ATTRIBUTE, "");
      }
    }
  }

  function clearCrossOriginIframeShields() {
    for (const iframe of document.querySelectorAll(`iframe[${IFRAME_SHIELD_ATTRIBUTE}]`)) {
      iframe.removeAttribute(IFRAME_SHIELD_ATTRIBUTE);
    }
  }

  function findShieldedIframeAtPoint(x, y) {
    for (const iframe of document.querySelectorAll(`iframe[${IFRAME_SHIELD_ATTRIBUTE}]`)) {
      const rect = iframe.getBoundingClientRect();
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        return iframe;
      }
    }
    return null;
  }

  function captureOpenTopLayers() {
    let elements = [];
    try {
      elements = [...document.querySelectorAll("dialog:modal, :popover-open")];
    } catch {
      elements = [...document.querySelectorAll("dialog[open]")];
    }
    return [...new Set(elements)]
      .filter((element) => !element.hasAttribute("data-annoy-killer-modal-layer"))
      .map((element) => ({ element, state: readTopLayerState(element) }))
      .filter((entry) => entry.state?.open);
  }

  function restoreDisplacedTopLayers(repromote = false) {
    for (const entry of displacedTopLayers) {
      const element = entry.element;
      if (!element?.isConnected || element.hasAttribute(SESSION_ATTRIBUTE) ||
          element.hasAttribute(PERSISTENT_ATTRIBUTE)) {
        continue;
      }
      if (repromote) {
        promoteTopLayerState(element, entry.state);
      } else {
        restoreTopLayerState(element, entry.state);
      }
    }
  }

  function originalTopLayerState(element) {
    return displacedTopLayers.find((entry) => entry.element === element)?.state ||
      readTopLayerState(element);
  }

  function promoteTopLayerState(element, state) {
    if (!element || !state?.open) {
      return;
    }
    try {
      if (state.kind === "dialog" && element instanceof HTMLDialogElement) {
        if (!element.open) {
          state.modal ? element.showModal() : element.show();
        }
      } else if (state.kind === "popover") {
        if (element.matches(":popover-open")) {
          element.hidePopover();
        }
        element.showPopover();
      }
    } catch {
      restoreTopLayerState(element, state);
    }
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 2 && rect.height >= 2 &&
      style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function getDeepTarget(rawTarget, x, y) {
    let candidate = rawTarget;
    let shadow = candidate.shadowRoot;
    while (shadow && typeof shadow.elementFromPoint === "function") {
      const inner = shadow.elementFromPoint(x, y);
      if (!inner || inner === candidate || !isVisible(inner)) {
        break;
      }
      candidate = inner;
      shadow = candidate.shadowRoot;
    }
    return isVisible(candidate) ? candidate : null;
  }

  function getBlockCandidate(rawTarget, level = SELECTION_LEVEL.BROADEST) {
    const defaultCandidate = getDefaultBlockCandidate(rawTarget);
    const completeItemCandidate = getResultListCandidate(rawTarget, defaultCandidate) ||
      getRepeatedCardCandidate(rawTarget, defaultCandidate);
    if (completeItemCandidate) {
      if (level === SELECTION_LEVEL.SMALLEST) {
        return getFineBlockCandidate(rawTarget, completeItemCandidate);
      }
      return completeItemCandidate;
    }
    if (level === SELECTION_LEVEL.DEFAULT) return defaultCandidate;
    if (level === SELECTION_LEVEL.SMALLEST) {
      return getFineBlockCandidate(rawTarget, defaultCandidate);
    }
    return getBroadestBlockCandidate(rawTarget, defaultCandidate);
  }

  function getRepeatedCardCandidate(rawTarget, defaultCandidate) {
    if (!(rawTarget instanceof Element)) return null;
    const base = defaultCandidate && defaultCandidate.contains(rawTarget) ? defaultCandidate : rawTarget;
    const baseRect = base.getBoundingClientRect();
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (!isSelectable(element) || !isVisible(element)) continue;
      if (isRepeatedCardItem(element, baseRect)) return element;
    }
    return null;
  }

  function isRepeatedCardItem(element, baseRect) {
    if (!(element instanceof HTMLElement) || !element.parentElement) return false;
    const rect = element.getBoundingClientRect();
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    if (!containsRect(rect, baseRect) || rect.width < 160 || rect.height < 96 ||
        rect.width > innerWidth * 0.92 || rect.height > Math.max(900, innerHeight * 1.1) ||
        rect.width * rect.height > viewportArea * 0.72 || !hasCardContent(element)) {
      return false;
    }
    const parent = element.parentElement;
    const parentStyle = getComputedStyle(parent);
    const peers = [...parent.children].filter((peer) => {
      if (peer === element || !(peer instanceof HTMLElement) || !isVisible(peer) ||
          ["absolute", "fixed"].includes(getComputedStyle(peer).position) || !hasCardContent(peer)) {
        return false;
      }
      const other = peer.getBoundingClientRect();
      const similarSize = other.width >= rect.width * 0.65 && other.width <= rect.width * 1.55 &&
        other.height >= rect.height * 0.55 && other.height <= rect.height * 1.8;
      const aligned = Math.abs(other.top - rect.top) <= Math.max(24, Math.min(other.height, rect.height) * 0.18) ||
        Math.abs(other.left - rect.left) <= Math.max(24, Math.min(other.width, rect.width) * 0.18);
      return similarSize && aligned;
    });
    return peers.length > 0 && (/(?:flex|grid)/.test(parentStyle.display) || peers.length > 1);
  }

  function hasCardContent(element) {
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 8) return false;
    const media = [...element.querySelectorAll("img, picture, video, canvas, iframe")].some(isVisible);
    const interactive = element.querySelector('a[href], button, [role="link"], [role="button"]');
    return media && Boolean(interactive || element.children.length >= 2);
  }

  function getResultListCandidate(rawTarget, defaultCandidate) {
    if (!(rawTarget instanceof Element)) return null;
    const base = defaultCandidate && defaultCandidate.contains(rawTarget) ? defaultCandidate : rawTarget;
    const baseRect = base.getBoundingClientRect();
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (!isSelectable(element) || !isVisible(element)) continue;
      if (isResultListItem(element, baseRect)) {
        return element;
      }
    }
    return null;
  }

  function isResultListItem(element, baseRect) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (!containsRect(rect, baseRect) || rect.width < 260 || rect.height < 48 ||
        rect.height > Math.max(680, innerHeight * 0.78) || rect.width > innerWidth * 0.86) {
      return false;
    }
    const style = getComputedStyle(element);
    const isContainer = BLOCK_DISPLAYS.has(style.display) ||
      ["inline-flex", "inline-grid", "inline-block"].includes(style.display);
    if (!isContainer && element.children.length < 2) return false;
    const headings = [...element.querySelectorAll("h1, h2, h3, h4, [role='heading']")]
      .filter(isVisible);
    if (!headings.length || headings.length > 3) return false;
    const links = [...element.querySelectorAll("a[href]")].filter(isVisible);
    if (!links.length) return false;
    const text = element.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 8) return false;
    const nestedResults = [...element.children].filter((child) =>
      child instanceof HTMLElement && child !== element &&
      isResultListItemCandidate(child));
    if (nestedResults.length > 1) return false;
    return hasResultListContext(element);
  }

  function isResultListItemCandidate(element) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 260 || rect.height < 48) return false;
    return element.querySelector("h1, h2, h3, h4, [role='heading']") &&
      element.querySelector("a[href]");
  }

  function hasResultListContext(element) {
    const parent = element.parentElement;
    if (!parent) return false;
    const siblingResults = [...parent.children].filter((child) =>
      child instanceof HTMLElement && isResultListItemCandidate(child));
    if (siblingResults.length >= 2) return true;
    const ancestor = parent.closest("main, [role='main'], section, article, [class*='result' i], [class*='search' i]");
    if (!ancestor || !ancestor.contains(element)) return false;
    return [...ancestor.children].filter((child) =>
      child instanceof HTMLElement && isResultListItemCandidate(child)).length >= 2;
  }

  function containsRect(outer, inner, tolerance = 2) {
    return outer.left <= inner.left + tolerance &&
      outer.top <= inner.top + tolerance &&
      outer.right >= inner.right - tolerance &&
      outer.bottom >= inner.bottom - tolerance;
  }

  function getDefaultBlockCandidate(rawTarget) {
    const overlay = getOverlayCandidate(rawTarget);
    if (overlay) return overlay;
    const alreadyHidden = [...getHiddenElements()];
    let smallestBlock = null;
    let compactBackground = null;
    let compactBackgroundExpanded = false;
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (!isSelectable(element) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      const style = getComputedStyle(element);
      // Never grow into the page shell, even when it is fixed or sticky.
      if (area / viewportArea > MAXIMUM_SELECTION_RATIO) continue;
      // Collapsing an earlier selection must not make the next selection grow
      // into its parent and create overlapping hidden items.
      if (alreadyHidden.some(hidden => hidden !== element &&
          isSameComposedBranch(element, hidden))) continue;
      const textOnly = /^(SPAN|P|H[1-6]|LABEL|STRONG|EM|B|I|SMALL|A)$/.test(element.tagName);
      const hasBoundary = hasPaintedBoundary(style);
      const hasSpace = [style.paddingTop, style.paddingRight, style.paddingBottom,
        style.paddingLeft].some(value => parseFloat(value) >= 8);
      const isMedia = /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(element.tagName);
      const isContainer = BLOCK_DISPLAYS.has(style.display) ||
        ["inline-flex", "inline-grid", "inline-block"].includes(style.display);
      const hasContentGroup = element.children.length > 0 &&
        !/^(SVG|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName);
      const isBlock = isMedia || (isContainer && (!textOnly || hasBoundary || hasSpace) &&
        (hasBoundary || hasSpace || hasContentGroup));
      if (compactBackground) {
        const compactRect = compactBackground.getBoundingClientRect();
        const compactArea = compactRect.width * compactRect.height;
        const sameContent = element.textContent.trim() === compactBackground.textContent.trim();
        const containsCompact = rect.left <= compactRect.left + 1 && rect.top <= compactRect.top + 1 &&
          rect.right >= compactRect.right - 1 && rect.bottom >= compactRect.bottom - 1;
        if (isBlock && sameContent && containsCompact && area <= compactArea * 3.5 &&
            rect.width <= compactRect.width + 64 && rect.height <= compactRect.height + 40) {
          compactBackground = element;
          compactBackgroundExpanded = true;
          continue;
        }
        // Compact footer promos and tool buttons often draw their background in
        // sibling layers. Keep those layers, but stop before the surrounding sidebar.
        if (compactBackgroundExpanded) return compactBackground;
        compactBackground = null;
      }
      if (isBlock && rect.width >= 96 && rect.height >= 28 && rect.height < 48 && area >= 2800) {
        compactBackground = element;
        continue;
      }
      if (!isBlock || rect.width < 96 || rect.height < 48 || area < 6000) continue;
      smallestBlock ||= element;
      // A compact card should not expand to an unrelated page-wide container.
      if (smallestBlock !== element && area >
          smallestBlock.getBoundingClientRect().width *
          smallestBlock.getBoundingClientRect().height * 6) return smallestBlock;
      if (rect.width >= 160 && rect.height >= 88 && area >= 16000) return element;
    }
    return compactBackgroundExpanded ? compactBackground : smallestBlock;
  }

  function getBroadestBlockCandidate(rawTarget, defaultCandidate) {
    if (defaultCandidate && isOverlayContainer(defaultCandidate)) return defaultCandidate;
    const initialBase = defaultCandidate || getFineBlockCandidate(rawTarget, null);
    const base = getLayoutSlotCandidate(initialBase);
    if (!base) return null;
    const baseRect = base.getBoundingClientRect();
    const baseArea = Math.max(1, baseRect.width * baseRect.height);
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (!isSelectable(element) || !isVisible(element) ||
          !createSimilarMatcher(element, element.getRootNode())) continue;
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area / viewportArea <= MAXIMUM_SELECTION_RATIO && area >= baseArea * 1.35 &&
          rect.left <= baseRect.left + 1 && rect.top <= baseRect.top + 1 &&
          rect.right >= baseRect.right - 1 && rect.bottom >= baseRect.bottom - 1) {
        return element;
      }
    }
    let passedBase = false;
    let nearestLarger = null;
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (element === base) {
        passedBase = true;
        continue;
      }
      if (!passedBase || !isSelectable(element) || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area / viewportArea > MAXIMUM_SELECTION_RATIO || area > baseArea * 6) break;
      if (area < baseArea * 1.08 || rect.width < baseRect.width || rect.height < baseRect.height) continue;
      const style = getComputedStyle(element);
      const isContainer = BLOCK_DISPLAYS.has(style.display) ||
        ["inline-flex", "inline-grid", "inline-block"].includes(style.display);
      if (!isContainer || (!element.children.length && !hasPaintedBoundary(style))) continue;
      nearestLarger ||= element;
      if (area >= baseArea * 1.35) return element;
    }
    return nearestLarger || base;
  }

  function getLayoutSlotCandidate(base) {
    if (!(base instanceof HTMLElement)) return base;
    const edgeSlot = getEdgeLayoutSlotCandidate(base);
    if (edgeSlot) return edgeSlot;
    let candidate = base;
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = candidate.parentElement;
      if (!(parent instanceof HTMLElement) || parent === document.body ||
          parent === document.documentElement || !isSelectable(parent) || !isVisible(parent)) break;
      const inner = candidate.getBoundingClientRect();
      const outer = parent.getBoundingClientRect();
      const innerArea = Math.max(1, inner.width * inner.height);
      const outerArea = outer.width * outer.height;
      const viewportArea = Math.max(1, innerWidth * innerHeight);
      const nearlySameBox = outerArea <= innerArea * 1.18 &&
        outer.width <= inner.width + Math.max(24, inner.width * 0.08) &&
        outer.height <= inner.height + Math.max(24, inner.height * 0.14);
      // Live-player controls often sit in a taller, full-width layout slot. Hiding
      // only the controls leaves that slot's background and reserved height behind.
      const compactSingleColumnSlot = inner.width >= outer.width * 0.72 &&
        inner.height >= outer.height * 0.32 && outerArea <= innerArea * 3.2 &&
        outer.height <= Math.max(180, inner.height * 2.8);
      if (!containsRect(outer, inner, 3) || outerArea / viewportArea > MAXIMUM_SELECTION_RATIO ||
          (!nearlySameBox && !compactSingleColumnSlot)) break;
      const style = getComputedStyle(parent);
      const isContainer = BLOCK_DISPLAYS.has(style.display) ||
        ["inline-flex", "inline-grid", "inline-block"].includes(style.display);
      if (!isContainer || hasIndependentLayoutSibling(parent, candidate, innerArea)) break;
      candidate = parent;
    }
    return candidate;
  }

  function getEdgeLayoutSlotCandidate(base) {
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    for (let element = base, depth = 0; element instanceof HTMLElement && depth < 12;
        element = element.parentElement, depth += 1) {
      const parent = element.parentElement;
      if (!(parent instanceof HTMLElement) || parent === document.body ||
          parent === document.documentElement || !isSelectable(element) ||
          !isVisible(element) || !isVisible(parent)) continue;
      const rect = element.getBoundingClientRect();
      const outer = parent.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area / viewportArea > MAXIMUM_SELECTION_RATIO) continue;
      const style = getComputedStyle(element);
      const parentStyle = getComputedStyle(parent);
      if (["absolute", "fixed"].includes(style.position) ||
          !(BLOCK_DISPLAYS.has(parentStyle.display) ||
            ["inline-flex", "inline-grid", "inline-block"].includes(parentStyle.display))) continue;
      const overlapWidth = Math.max(0, Math.min(rect.right, outer.right) - Math.max(rect.left, outer.left));
      const overlapHeight = Math.max(0, Math.min(rect.bottom, outer.bottom) - Math.max(rect.top, outer.top));
      const boundedHorizontalSurface = outer.height <= innerHeight * 1.1 &&
        outer.top <= innerHeight * 0.15 && outer.bottom >= innerHeight * 0.75;
      const boundedVerticalSurface = outer.width <= innerWidth * 1.1 &&
        outer.left <= innerWidth * 0.15 && outer.right >= innerWidth * 0.75;
      const horizontal = rect.width >= 240 && rect.width >= outer.width * 0.55 && rect.height >= 32 &&
        boundedHorizontalSurface &&
        outer.height >= rect.height * 2.4 && outer.height - rect.height >= 72 &&
        overlapWidth >= rect.width * 0.9 && overlapHeight >= rect.height * 0.85 &&
        (Math.abs(rect.top - outer.top) <= 8 || Math.abs(rect.bottom - outer.bottom) <= 8);
      const vertical = rect.height >= 160 && rect.height >= outer.height * 0.55 && rect.width >= 48 &&
        boundedVerticalSurface &&
        outer.width >= rect.width * 2.4 && outer.width - rect.width >= 120 &&
        overlapHeight >= rect.height * 0.9 && overlapWidth >= rect.width * 0.85 &&
        (Math.abs(rect.left - outer.left) <= 8 || Math.abs(rect.right - outer.right) <= 8);
      if (!horizontal && !vertical) continue;
      const hasMainContentSibling = [...parent.children].some((child) => {
        if (child === element || !(child instanceof HTMLElement) || !isVisible(child)) return false;
        if (["absolute", "fixed"].includes(getComputedStyle(child).position)) return false;
        const siblingRect = child.getBoundingClientRect();
        return siblingRect.width * siblingRect.height >= area * 0.6;
      });
      if (hasMainContentSibling) return element;
    }
    return null;
  }

  function hasIndependentLayoutSibling(parent, candidate, candidateArea) {
    return [...parent.children].some((child) => {
      if (child === candidate || !(child instanceof HTMLElement) || !isVisible(child)) return false;
      const style = getComputedStyle(child);
      if (["absolute", "fixed"].includes(style.position)) return false;
      const rect = child.getBoundingClientRect();
      return rect.width * rect.height >= candidateArea * 0.08;
    });
  }

  function coversViewport(rect) {
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    return width >= innerWidth * 0.9 && height >= innerHeight * 0.85;
  }

  function isDimmedBackdrop(style) {
    const color = style.backgroundColor;
    const alpha = color.match(/(?:,|\/)\s*([\d.]+)\s*\)$/);
    return (alpha && Number(alpha[1]) > 0 && Number(alpha[1]) < 1) ||
      (Number(style.opacity) > 0 && Number(style.opacity) < 1 && color !== "rgba(0, 0, 0, 0)") ||
      (style.backdropFilter && style.backdropFilter !== "none");
  }

  function isOverlayContainer(element) {
    if (!(element instanceof HTMLElement) || element === document.body ||
        element === document.documentElement ||
        element.hasAttribute("data-annoy-killer-ui") ||
        element.hasAttribute("data-annoy-killer-modal-layer") || !isVisible(element)) return false;
    if ((element instanceof HTMLDialogElement && element.open) ||
        (element.hasAttribute("popover") && element.matches(":popover-open"))) return true;
    const style = getComputedStyle(element);
    if (!["fixed", "absolute"].includes(style.position)) return false;
    if (element.getAttribute("aria-modal") === "true") return true;
    const rect = element.getBoundingClientRect();
    const named = /modal|dialog|popup|popwin|overlay|backdrop|fullcover/i.test(
      `${element.id} ${element.className}`);
    if (!coversViewport(rect)) {
      return named && Number(style.zIndex) > 0 && rect.width >= 96 && rect.height >= 48;
    }
    if (!(Number(style.zIndex) > 0)) return false;
    if (isDimmedBackdrop(style)) return true;
    // Transparent full-screen portal with a sibling backdrop and dialog. Do not
    // promote ordinary page shells that also contain a full-sized content pane.
    const children = [...element.children].filter(isVisible);
    return children.length > 0 && children.length <= 12 &&
      children.some(child => coversViewport(child.getBoundingClientRect()) &&
        ["fixed", "absolute"].includes(getComputedStyle(child).position) &&
        isDimmedBackdrop(getComputedStyle(child))) &&
      children.every(child => !coversViewport(child.getBoundingClientRect()) ||
        isDimmedBackdrop(getComputedStyle(child)));
  }

  function getOverlayCandidate(rawTarget) {
    let result = null;
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (isSelectable(element) && isOverlayContainer(element)) result = element;
    }
    return result;
  }

  function associatedOverlayElements(element) {
    if (!isOverlayContainer(element) || !element.parentElement) return [];
    const rect = element.getBoundingClientRect();
    const isBackdrop = coversViewport(rect) && isDimmedBackdrop(getComputedStyle(element));
    const siblings = [...element.parentElement.children];
    const z = Number(getComputedStyle(element).zIndex);
    return siblings.filter(other => {
      if (other === element || !isSelectable(other) || !isOverlayContainer(other)) return false;
      const style = getComputedStyle(other);
      const otherBackdrop = coversViewport(other.getBoundingClientRect()) && isDimmedBackdrop(style);
      return isBackdrop !== otherBackdrop && Math.abs(z - Number(style.zIndex)) <= 4;
    }).sort((a, b) => Math.abs(siblings.indexOf(a) - siblings.indexOf(element)) -
      Math.abs(siblings.indexOf(b) - siblings.indexOf(element))).slice(0, 1);
  }

  function updateOverlayScrollLock() {
    const hiddenOverlay = [...getHiddenElements()].some(element => overlayElements.has(element) &&
      getComputedStyle(element).display === "none");
    const owners = [document.documentElement, document.body].filter(Boolean);
    const needsUnlock = hiddenOverlay && owners.some(owner =>
      overlayScrollStates.has(owner) || /hidden|clip/.test(getComputedStyle(owner).overflow));
    let otherOverlay = false;
    if (needsUnlock) {
      // Probe the visual stack, not every DOM node, and never override the lock
      // while a different modal remains visible.
      const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.9]];
      otherOverlay = points.some(([x, y]) => document.elementsFromPoint(innerWidth * x, innerHeight * y)
        .some(element => Boolean(getOverlayCandidate(element)))) ||
        [...document.querySelectorAll("dialog[open], [aria-modal='true']")]
          .some(element => isOverlayContainer(element));
    }
    for (const owner of owners) {
      const saved = overlayScrollStates.get(owner);
      if (!needsUnlock || otherOverlay) {
        for (const state of saved || []) {
          if (owner.style.getPropertyValue(state.name) !== "auto" ||
              owner.style.getPropertyPriority(state.name) !== "important") continue;
          if (state.value) owner.style.setProperty(state.name, state.value, state.priority);
          else owner.style.removeProperty(state.name);
        }
        overlayScrollStates.delete(owner);
      } else {
        const states = saved || [];
        const style = getComputedStyle(owner);
        for (const [name, computed] of [["overflow-x", style.overflowX], ["overflow-y", style.overflowY]]) {
          if (!["hidden", "clip"].includes(computed)) continue;
          if (!states.some(state => state.name === name)) states.push({ name,
            value: owner.style.getPropertyValue(name), priority: owner.style.getPropertyPriority(name) });
          owner.style.setProperty(name, "auto", "important");
        }
        if (states.length) overlayScrollStates.set(owner, states);
      }
    }
  }

  function getFineBlockCandidate(rawTarget, defaultCandidate = getDefaultBlockCandidate(rawTarget)) {
    for (let element = rawTarget; element && element !== document.body &&
        element !== document.documentElement; element = getComposedParent(element)) {
      if (!isSelectable(element) || !isVisible(element)) continue;
      // Fine selection can refine the default target, never grow past it or lose it.
      if (element === defaultCandidate) return defaultCandidate;
      const rect = element.getBoundingClientRect();
      if (rect.width * rect.height > innerWidth * innerHeight * MAXIMUM_SELECTION_RATIO) continue;
      const style = getComputedStyle(element);
      if (isCompactVisualLabel(element, rect, style)) {
        return element instanceof SVGSVGElement ? getSvgLabelContainer(element) : element;
      }
      if (!(element instanceof HTMLElement)) continue;
      const text = element.innerText.trim();
      const isControl = element.matches('a[href], button, input, select, textarea, summary, ' +
        '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"]');
      const textFragment = /^(SPAN|P|H[1-6]|LABEL|STRONG|EM|B|I|SMALL)$/.test(element.tagName);
      const children = [...element.children].filter(isVisible);
      const isGroup = !textFragment && children.length >= 2;
      const hasSpace = [style.paddingTop, style.paddingRight, style.paddingBottom,
        style.paddingLeft].some(value => parseFloat(value) >= 4);
      const graphic = element.querySelector("svg, img, canvas");
      const hasGraphic = graphic && isVisible(graphic);
      const graphicRect = hasGraphic ? graphic.getBoundingClientRect() : null;
      const iconControl = !textFragment && hasGraphic && rect.width <= 128 && rect.height <= 128 &&
        (hasSpace || (rect.width >= graphicRect.width + 4 && rect.height >= graphicRect.height + 4));
      // Fine mode uses component structure, not the large-area threshold of default mode.
      // A 24×44 icon-and-label item is complete; its SVG/path or plain caption is not.
      if (rect.width >= 16 && rect.height >= 20 && rect.width * rect.height >= 400 &&
          ((isControl && (text || hasSpace || hasGraphic)) || iconControl ||
            (text && !textFragment && (isGroup || hasSpace || hasPaintedBoundary(style))))) {
        return getCompleteFineUnit(element, defaultCandidate);
      }
      if (/^(IMG|VIDEO|CANVAS|IFRAME)$/.test(element.tagName) &&
          rect.width >= 64 && rect.height >= 40) return element;
    }
    return defaultCandidate;
  }

  function getCompleteFineUnit(element, limit = null) {
    // Include a component's wrappers and attached count/badge. Stop before adjacent items.
    let unit = element;
    for (let depth = 0; depth < 5; depth += 1) {
      if (unit === limit) break;
      const parent = getComposedParent(unit);
      if (!(parent instanceof HTMLElement) || !isSelectable(parent) || !isVisible(parent)) break;
      const rect = unit.getBoundingClientRect();
      const outer = parent.getBoundingClientRect();
      if (outer.width > rect.width * 1.6 || outer.height > rect.height * 1.4 ||
          outer.left > rect.left + 1 || outer.top > rect.top + 1 ||
          outer.right < rect.right - 1 || outer.bottom < rect.bottom - 1) break;
      const extraText = [...parent.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const hasOtherItem = [...parent.children].some(child => {
        if (child === unit || !isVisible(child)) return false;
        const r = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        if (isAttachedVisualLayer(child, outer, rect)) return false;
        return !isCompactVisualLabel(child, r, style) &&
          !(style.position === "absolute" && r.width <= 64 && r.height <= 32);
      });
      if (extraText || hasOtherItem) break;
      unit = parent;
    }
    return unit;
  }

  function isAttachedVisualLayer(element, outerRect, contentRect) {
    const style = getComputedStyle(element);
    if (style.position !== "absolute" || (element.textContent || "").trim()) return false;
    const interactive = 'a[href], button, input, select, textarea, summary, [role="button"], ' +
      '[role="link"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    if (element.matches(interactive) || element.querySelector(interactive)) return false;
    const rect = element.getBoundingClientRect();
    if (!containsRect(outerRect, rect, 2)) return false;
    const overlapWidth = Math.max(0,
      Math.min(rect.right, contentRect.right) - Math.max(rect.left, contentRect.left));
    const overlapHeight = Math.max(0,
      Math.min(rect.bottom, contentRect.bottom) - Math.max(rect.top, contentRect.top));
    const contentArea = Math.max(1, contentRect.width * contentRect.height);
    const isVisual = /^(IMG|PICTURE|SVG|CANVAS|VIDEO)$/.test(element.tagName) ||
      hasPaintedBoundary(style) ||
      Boolean(element.querySelector("img, picture, svg, canvas, video"));
    return isVisual && overlapWidth * overlapHeight >= contentArea * 0.55;
  }

  function hasPaintedBoundary(style) {
    return style.backgroundImage !== "none" ||
      !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor) ||
      style.boxShadow !== "none" ||
      [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth,
        style.borderLeftWidth].some(value => parseFloat(value) > 0);
  }

  function isCompactVisualLabel(element, rect, style) {
    // Small badges are useful targets only as a complete text-and-surface unit.
    if (rect.width < 16 || rect.height < 14 ||
        rect.width > 160 || rect.height > 72 || rect.width * rect.height < 240) return false;
    if (element instanceof SVGSVGElement) return isSvgLabel(element, rect);
    if (!(element instanceof HTMLElement)) return false;
    const text = element.innerText.trim();
    const pseudoStyles = ["::before", "::after"].map(pseudo => getComputedStyle(element, pseudo))
      .filter(pseudo => pseudo.content !== "none" && pseudo.content !== "normal" &&
        pseudo.display !== "none" && pseudo.visibility !== "hidden");
    const labelText = text + pseudoStyles.map(pseudo => pseudo.content).join("");
    if (labelText.length > 64 || !/[\p{L}\p{N}]/u.test(labelText)) return false;
    if (hasPaintedBoundary(style) || pseudoStyles.some(hasPaintedBoundary)) return true;
    // Some badges draw their background/border in a sibling of the text node.
    // Pick their common container so neither the lettering nor decoration is left behind.
    return [...element.children].some(child => {
      if (!isVisible(child) || !hasPaintedBoundary(getComputedStyle(child))) return false;
      const childRect = child.getBoundingClientRect();
      return childRect.width * childRect.height >= rect.width * rect.height * 0.55 &&
        childRect.left >= rect.left - 1 && childRect.top >= rect.top - 1 &&
        childRect.right <= rect.right + 1 && childRect.bottom <= rect.bottom + 1;
    });
  }

  function isSvgLabel(svg, rect) {
    // Lettering can be outlined paths rather than DOM text. Keep the SVG atomic:
    // recognize a wide badge surface with contrasting artwork inside it.
    if (rect.width / rect.height < 1.35) return false;
    const shapes = [...svg.querySelectorAll("rect, circle, ellipse, path, polygon, text, use")]
      .filter(shape => !shape.closest("defs, clipPath, mask") && isVisible(shape))
      .map(shape => ({ shape, rect: shape.getBoundingClientRect(), style: getComputedStyle(shape) }))
      .filter(entry => !["none", "transparent", "rgba(0, 0, 0, 0)"].includes(entry.style.fill) &&
        Number(entry.style.fillOpacity) > 0);
    const area = rect.width * rect.height;
    return shapes.some(background => {
      if (!["rect", "circle", "ellipse"].includes(background.shape.localName) ||
          background.rect.width * background.rect.height < area * 0.8) return false;
      return shapes.some(foreground => foreground !== background &&
        foreground.style.fill !== background.style.fill &&
        foreground.rect.width * foreground.rect.height < area * 0.8 &&
        foreground.rect.left >= background.rect.left - 1 &&
        foreground.rect.top >= background.rect.top - 1 &&
        foreground.rect.right <= background.rect.right + 1 &&
        foreground.rect.bottom <= background.rect.bottom + 1);
    });
  }

  function getSvgLabelContainer(svg) {
    const parent = getComposedParent(svg);
    if (!(parent instanceof HTMLElement) || !isSelectable(parent) || !isVisible(parent) ||
        parent.children.length !== 1 || parent.firstElementChild !== svg ||
        parent.textContent.trim()) return svg;
    const rect = svg.getBoundingClientRect();
    const outer = parent.getBoundingClientRect();
    // Include the badge's own wrapper/background, but never the surrounding nav item.
    return outer.width <= Math.min(160, rect.width * 1.75) &&
      outer.height <= Math.min(72, rect.height * 2) &&
      outer.left <= rect.left + 1 && outer.top <= rect.top + 1 &&
      outer.right >= rect.right - 1 && outer.bottom >= rect.bottom - 1 ? parent : svg;
  }

  function getComposedParent(element) {
    if (element.parentElement) {
      return element.parentElement;
    }
    const root = element.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function drawHighlight(element) {
    if (!highlight || !element || !element.isConnected || !isVisible(element)) {
      hideHighlight();
      return;
    }

    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) {
      hideHighlight();
      return;
    }

    highlight.style.display = "block";
    highlight.style.left = `${left}px`;
    highlight.style.top = `${top}px`;
    highlight.style.width = `${right - left}px`;
    highlight.style.height = `${bottom - top}px`;
    highlight.classList.toggle("fine", selectionLevel !== SELECTION_LEVEL.BROADEST);
  }

  function hideHighlight() {
    if (highlight) {
      highlight.style.display = "none";
    }
  }

  function onPagePointerDown(event) {
    if (isClickThroughMode()) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (getPageKey() !== pageKey) {
      handlePossibleNavigation();
      return;
    }

    selectionLevel = selectionLevelFromEvent(event);
    lastPointer = { x: event.clientX, y: event.clientY };
    currentCandidate = candidateAtPoint(event.clientX, event.clientY, selectionLevel);
    drawHighlight(currentCandidate);
    if (event.button === 0 && currentCandidate?.isConnected) {
      try {
        captureLayer?.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; selection still works without it.
      }
      pressedSelection = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        candidate: currentCandidate
      };
    }
  }

  function onPagePointerUp(event) {
    if (isClickThroughMode()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      captureLayer?.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    if (!pressedSelection || pressedSelection.pointerId !== event.pointerId || event.button !== 0) {
      clearPressedSelection();
      return;
    }

    const distance = Math.hypot(event.clientX - pressedSelection.x, event.clientY - pressedSelection.y);
    const releaseLevel = selectionLevelFromEvent(event);
    const releaseCandidate = candidateAtPoint(event.clientX, event.clientY, releaseLevel);
    const candidate = pressedSelection.candidate;
    const shouldHide = distance <= 8 && candidate?.isConnected && releaseCandidate?.isConnected &&
      isSameComposedBranch(candidate, releaseCandidate);
    clearPressedSelection();
    if (shouldHide) {
      lastPointer = null;
      currentCandidate = null;
      hideHighlight();
      trackHiddenSelection(candidate, [SELECTION_LEVEL.BROADEST, SELECTION_LEVEL.DEFAULT]
        .includes(releaseLevel), releaseLevel === SELECTION_LEVEL.BROADEST);
    }
  }

  function createHiddenGroupId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function trackHiddenSelection(candidate, includeBackdrop = false, matchSimilar = false) {
    const targets = [candidate, ...(includeBackdrop ? associatedOverlayElements(candidate) : [])];
    const group = createHiddenGroupId();
    const selectionPromise = Promise.all(targets.map((element, index) =>
      hideCandidate(element, matchSimilar && index === 0, group)));
    const tracked = { sessionId: activeSessionId, promise: selectionPromise };
    inFlightSelections.add(tracked);
    selectionPromise.finally(() => inFlightSelections.delete(tracked));
  }

  function clearPressedSelection() {
    pressedSelection = null;
  }

  function isSameComposedBranch(first, second) {
    if (first === second) {
      return true;
    }
    for (let current = first; current; current = getComposedParent(current)) {
      if (current === second) {
        return true;
      }
    }
    for (let current = second; current; current = getComposedParent(current)) {
      if (current === first) {
        return true;
      }
    }
    return false;
  }

  function onPageClick(event) {
    if (isClickThroughMode()) return;
    event.preventDefault();
    event.stopImmediatePropagation();

  }

  function suppressCapturedEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  async function hideCandidate(element, matchSimilar = false, group = createHiddenGroupId()) {
    if (elementsBeingSelected.has(element)) {
      return;
    }
    const hidesOverlay = isOverlayContainer(element);
    elementsBeingSelected.add(element);
    try {
    const ruleResult = createStableRule(element, matchSimilar);
    if (!ruleResult) {
      return;
    }
    ruleResult.rule = normalizeRule({
      ...ruleResult.rule,
      ...(hidesOverlay ? { overlay: true } : {}),
      group
    });
    if (!ruleResult.rule) return;
    if (hidesOverlay) {
      overlayElements.add(element);
    }

    const sessionId = activeSessionId;
    const rect = element.getBoundingClientRect();
    const token = `${sessionId}-${++itemSequence}`;
    currentCandidate = null;
    hideHighlight();
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const snapshot = reducedMotion || hiddenPreview ? null : await createParticleSnapshot(element, rect);
    if (!active || activeSessionId !== sessionId || !element.isConnected) {
      return;
    }
    const selectedOpacity = Number(getComputedStyle(element).opacity);
    previewOpacityMotions.get(element)?.cancel();
    previewRestoredElements.delete(element);
    const matchingVisibleExceptions = persistentVisiblePageRules.filter((rule) =>
      resolveActiveVisibleRuleElements(rule).includes(element)
    );
    if (matchingVisibleExceptions.length) {
      const coveredByPersistentRule = getActiveRules().some((rule) =>
        resolveActiveHiddenRuleElements(rule).includes(element)
      );
      removeVisibleExceptionsMatchingElements(new Set([element]));
      if (coveredByPersistentRule) {
        applyPersistentStyle();
        applyPersistentMarkers();
        if (hiddenPreview) {
          animatePreviewOpacity(element, selectedOpacity, Number(getComputedStyle(element).opacity));
        }
        if (snapshot && !hiddenPreview) {
          playParticleAnimation(snapshot, rect, sessionId);
        }
        return;
      }
    }
    if (element.hasAttribute(SESSION_ATTRIBUTE) || element.hasAttribute(PERSISTENT_ATTRIBUTE)) {
      return;
    }

    const elements = ruleResult.rule.all
      ? findMatcherElements(element.getRootNode(), ruleResult.rule)
        .filter(candidate => candidate === element || isSelectable(candidate))
      : [element];
    const previousOpacities = new Map(elements.map(candidate => [candidate,
      candidate === element ? selectedOpacity : Number(getComputedStyle(candidate).opacity)]));
    for (const candidate of elements) {
      previewOpacityMotions.get(candidate)?.cancel();
      previewRestoredElements.delete(candidate);
    }
    const animationEntries = snapshot && !hiddenPreview ? [{ snapshot, rect }] : [];
    const elementStates = elements.map((matchedElement) => ({
      element: matchedElement,
      previousToken: matchedElement.getAttribute(SESSION_ATTRIBUTE),
      inlineDisplay: readInlineDisplay(matchedElement),
      topLayerState: originalTopLayerState(matchedElement)
    }));
    for (const state of elementStates) {
      ensureRootStyle(state.element.getRootNode());
      sessionInlineStates.set(state.element, state.inlineDisplay);
      sessionTopLayerStates.set(state.element, state.topLayerState);
      state.element.setAttribute(SESSION_ATTRIBUTE, token);
      if (!hiddenPreview) {
        deactivateTopLayer(state.element);
        forceInlineHidden(state.element);
      }
    }
    ensureSessionStyle();
    const pendingItem = {
      elements: elementStates.map((state) => state.element),
      elementStates,
      rule: ruleResult.rule,
      scope: ruleResult.scope,
      group,
      token,
      sessionId
    };
    cancelRuleRemovalTombstone(ruleResult.rule, ruleResult.scope);
    pendingItems.push(pendingItem);
    updateCount();
    scheduleSessionAutoSave();
    if (hiddenPreview) {
      for (const [candidate, opacity] of previousOpacities) {
        animatePreviewOpacity(candidate, opacity, Number(getComputedStyle(candidate).opacity));
      }
    }

    for (let index = 0; index < animationEntries.length; index += 1) {
      try {
        playParticleAnimation(
          animationEntries[index].snapshot,
          animationEntries[index].rect,
          sessionId,
          index * 65
        );
      } catch (error) {
        console.debug("粒子动画已降级。", error);
      }
    }

    } finally {
      elementsBeingSelected.delete(element);
    }
  }

  function ensureSessionStyle() {
    const id = `${STYLE_ID}-session`;
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      (document.documentElement || document).appendChild(style);
    }
    const sessionRule = hiddenPreview
      ? hiddenPreviewCss(`[${SESSION_ATTRIBUTE}]`)
      : `[${SESSION_ATTRIBUTE}] { display: none !important; }`;
    const shieldRule = active && !clickThrough
      ? `\niframe[${IFRAME_SHIELD_ATTRIBUTE}] { pointer-events: none !important; }`
      : "";
    style.textContent = `${sessionRule}\nhtml.${PICKING_CLASS}:not(.${CLICK_THROUGH_CLASS}), html.${PICKING_CLASS}:not(.${CLICK_THROUGH_CLASS}) * { cursor: default !important; }${shieldRule}`;
  }

  function onKeyChange(event) {
    if (["Enter", "Escape"].includes(event.key) && event.type === "keydown" && !event.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finishPicking().catch(error => console.debug("无法完成隐藏操作。", error));
      return;
    }
    if (event.type === "keydown" && isOperationModifierKey(event.key)) {
      shadowRoot?.querySelector(".shortcut-guide")?.remove();
    }

    if (isPrimaryInteractionModifierKey(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setClickThroughMode(event.type === "keydown");
      return;
    }

    if (isSelectionModifierKey(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    const nextSelectionLevel = selectionLevelFromEvent(event);
    if (selectionLevel !== nextSelectionLevel) {
      selectionLevel = nextSelectionLevel;
      updateCandidate();
    }
  }

  function selectionLevelFromEvent(event) {
    if (event.altKey) return SELECTION_LEVEL.SMALLEST;
    if (event.shiftKey) return SELECTION_LEVEL.DEFAULT;
    return SELECTION_LEVEL.BROADEST;
  }

  function isSelectionModifierKey(key) {
    return key === "Alt" || key === "Shift";
  }

  function isPrimaryInteractionModifierKey(key) {
    return key === (IS_MAC ? "Meta" : "Control");
  }

  function isPrimaryInteractionModifierEvent(event) {
    return IS_MAC ? event.metaKey : event.ctrlKey;
  }

  function isOperationModifierKey(key) {
    return isPrimaryInteractionModifierKey(key) || isSelectionModifierKey(key);
  }

  function isClickThroughMode() {
    return clickThrough || document.documentElement?.classList.contains(CLICK_THROUGH_CLASS);
  }

  function setClickThroughMode(enabled) {
    if (clickThrough === enabled) return;
    clickThrough = enabled;
    clearPressedSelection();
    if (enabled) currentCandidate = null;
    document.documentElement?.classList.toggle(CLICK_THROUGH_CLASS, enabled);
    if (captureLayer) {
      captureLayer.style.pointerEvents = hiddenPreview || enabled ? "none" : "auto";
    }
    if (hiddenPreview) setHiddenPreviewInteractionMode(!enabled);
    for (const mask of new Set([...hiddenPreviewMasks.values(), ...retiringPreviewMasks.values()])) {
      mask.style.setProperty("pointer-events", enabled ? "none" : "auto", "important");
    }
    ensureSessionStyle();
    if (enabled) hideHighlight();
    else updateCandidate();
  }

  function clearModifierState(event) {
    if (event && event.target !== window) {
      return;
    }
    selectionLevel = SELECTION_LEVEL.BROADEST;
    setClickThroughMode(false);
    updateCandidate();
  }

  function cancelPicking() {
    if (finishing) {
      return;
    }
    setHiddenPreview(false, false);
    const sessionId = activeSessionId;
    for (const item of [...pendingItems].reverse()) {
      restorePendingItem(item, false);
    }
    pendingItems = [];
    persistentPageRules = sanitizeRules([...persistentPageRules, ...removedPageRules]);
    persistentSiteRules = sanitizeRules([...persistentSiteRules, ...removedSiteRules]);
    const addedVisibleKeys = new Set(addedVisiblePageRules.map(ruleKey));
    persistentVisiblePageRules = sanitizeRules([
      ...persistentVisiblePageRules.filter((rule) => !addedVisibleKeys.has(ruleKey(rule))),
      ...removedVisiblePageRules
    ]);
    removedPageRules = [];
    removedSiteRules = [];
    addedVisiblePageRules = [];
    removedVisiblePageRules = [];
    applyPersistentStyle();
    applyPersistentMarkers();
    cancelAnimationsForSession(sessionId);
    stopPicking();
  }

  async function finishPicking() {
    if (!active || finishing) {
      return;
    }
    if (await handlePossibleNavigation()) {
      return;
    }
    if (!active || finishing) {
      return;
    }

    setHiddenPreview(false, false);
    finishing = true;
    const sessionId = activeSessionId;
    captureLayer?.remove();
    hideHighlight();
    document.removeEventListener("keydown", onKeyChange, true);
    document.removeEventListener("keyup", onKeyChange, true);
    await Promise.allSettled(
      [...inFlightSelections]
        .filter((selection) => selection.sessionId === sessionId)
        .map((selection) => selection.promise)
    );
    await autoSaveQueue.catch(() => undefined);
    if (!active || activeSessionId !== sessionId) {
      return;
    }
    const committedItems = pendingItems.slice();
    const newPageRules = committedItems
      .filter((item) => item.scope === "page")
      .map((item) => item.rule);
    const newSiteRules = committedItems
      .filter((item) => item.scope === "site")
      .map((item) => item.rule);
    const removedPageRulesToCommit = removedPageRules.slice();
    const removedSiteRulesToCommit = removedSiteRules.slice();
    const visiblePageRulesToCommit = addedVisiblePageRules.slice();
    const removedVisiblePageRulesToCommit = removedVisiblePageRules.slice();
    const committedPageKey = pageKey;
    const committedSiteKey = siteKey;

    if (newPageRules.length || newSiteRules.length ||
        removedPageRulesToCommit.length || removedSiteRulesToCommit.length ||
        visiblePageRulesToCommit.length || removedVisiblePageRulesToCommit.length) {
      try {
        const result = await commitRulesWithRetry({
          pageKey: committedPageKey,
          siteKey: committedSiteKey,
          pageRules: newPageRules,
          siteRules: newSiteRules,
          removePageRules: removedPageRulesToCommit,
          removeSiteRules: removedSiteRulesToCommit,
          visiblePageRules: visiblePageRulesToCommit,
          removeVisiblePageRules: removedVisiblePageRulesToCommit
        });
        persistentPageRules = sanitizeRules(result.pageRules);
        persistentVisiblePageRules = sanitizeRules(result.visiblePageRules);
      } catch (error) {
        if (active && activeSessionId === sessionId && shadowRoot && captureLayer) {
          shadowRoot.prepend(captureLayer);
          document.addEventListener("keydown", onKeyChange, true);
          document.addEventListener("keyup", onKeyChange, true);
          finishing = false;
          updateCandidate();
        }
        console.debug("无法保存已隐藏的干扰项。", error);
        throw error;
      }
    }

    for (const item of committedItems) {
      for (const state of item.elementStates) {
        if (state.element) {
          if (!persistentTopLayerStates.has(state.element)) {
            persistentTopLayerStates.set(state.element, state.topLayerState);
          }
          state.element.removeAttribute(SESSION_ATTRIBUTE);
          restoreInlineDisplay(state.element, state.inlineDisplay);
          sessionInlineStates.delete(state.element);
          sessionTopLayerStates.delete(state.element);
        }
      }
    }
    applyPersistentStyle();
    pendingItems = [];
    removedPageRules = [];
    removedSiteRules = [];
    addedVisiblePageRules = [];
    removedVisiblePageRules = [];
    stopPicking();
  }

  async function commitRulesWithRetry(payload) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await chrome.runtime.sendMessage({
          type: "annoy-killer:commit-rules",
          ...payload
        });
        if (!result?.ok) {
          throw new Error(result?.error || "保存失败");
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
        }
      }
    }
    throw lastError || new Error("保存失败");
  }

  function createStableRule(element, matchSimilar = false, allowMarker = true) {
    if (!(element instanceof Element) || element === document.body || element === document.documentElement) {
      return null;
    }

    const root = element.getRootNode();
    const shadowHosts = createShadowHostMatchers(element);
    if (shadowHosts === null) {
      return null;
    }

    const matcher = matchSimilar && !shadowHosts.length
      ? createSimilarMatcher(element, root) || createExactMatcher(element, root)
      : createExactMatcher(element, root, allowMarker);
    return matcher
      ? { rule: normalizeRule({ ...matcher, shadowHosts }), scope: "page" }
      : null;
  }

  function createShadowHostMatchers(element) {
    const hosts = [];
    let root = element.getRootNode();
    while (root instanceof ShadowRoot) {
      const host = root.host;
      const parentRoot = host.getRootNode();
      const matcher = createExactMatcher(host, parentRoot);
      if (!matcher) {
        return null;
      }
      hosts.unshift(matcher);
      root = parentRoot;
    }
    return hosts;
  }

  async function captureViewport(trackedElement = null) {
    const captureGap = performance.now() - lastLocalCaptureAt;
    if (lastLocalCaptureAt && captureGap < 540) {
      await new Promise((resolve) => setTimeout(resolve, 540 - captureGap));
    }
    const capturedVisuals = [highlight, shadowRoot?.querySelector(".toolbar"),
      shadowRoot?.querySelector(".shortcut-guide")].filter(Boolean);
    const capturedAnimationHost = animationHost;
    const previousVisualVisibility = capturedVisuals.map((element) => element.style.visibility || "");
    const previousAnimationVisibility = capturedAnimationHost?.style.visibility || "";
    for (const element of capturedVisuals) {
      element.style.visibility = "hidden";
    }
    if (capturedAnimationHost) {
      capturedAnimationHost.style.visibility = "hidden";
    }

    try {
      if (capturedVisuals.length || capturedAnimationHost) {
        await nextPaint();
        await nextPaint();
      }
      const captureState = {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        scrollX,
        scrollY,
        trackedElement,
        trackedRect: trackedElement?.isConnected ? copyRect(trackedElement.getBoundingClientRect()) : null
      };
      const response = await chrome.runtime.sendMessage({ type: "annoy-killer:capture-visible-tab" });
      if (!response?.ok || !response.dataUrl) {
        throw new Error(response?.error || "页面截图失败");
      }
      const image = await loadImage(response.dataUrl);
      if (captureState.viewportWidth !== innerWidth || captureState.viewportHeight !== innerHeight ||
          captureState.scrollX !== scrollX || captureState.scrollY !== scrollY) {
        throw new Error("截图期间页面位置发生变化");
      }
      lastLocalCaptureAt = performance.now();
      return {
        image,
        ...captureState,
        capturedAt: performance.now()
      };
    } finally {
      for (let index = 0; index < capturedVisuals.length; index += 1) {
        const element = capturedVisuals[index];
        if (element.isConnected) {
          element.style.visibility = previousVisualVisibility[index];
        }
      }
      if (capturedAnimationHost?.isConnected) {
        capturedAnimationHost.style.visibility = previousAnimationVisibility;
      }
    }
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => reject(new Error("截图解码超时")), 1500);
      image.onload = () => {
        clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("截图解码失败"));
      };
      image.src = source;
    });
  }

  async function getViewportCapture(trackedElement = null, force = false) {
    if (force) {
      latestViewportCapture = null;
    }
    const current = latestViewportCapture;
    if (current && current.viewportWidth === innerWidth && current.viewportHeight === innerHeight &&
        current.scrollX === scrollX && current.scrollY === scrollY &&
        performance.now() - current.capturedAt < 450) {
      return current;
    }
    if (!viewportCapturePromise) {
      viewportCapturePromise = captureViewport(trackedElement)
        .then((capture) => {
          latestViewportCapture = capture;
          return capture;
        })
        .finally(() => {
          viewportCapturePromise = null;
        });
    }
    return viewportCapturePromise;
  }

  async function createParticleSnapshot(element, rect) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const capture = await getViewportCapture(element, attempt > 0);
        const snapshotRect = capture.trackedElement === element && capture.trackedRect
          ? capture.trackedRect
          : rect;
        if (capture.trackedElement === element &&
            !rectsClose(snapshotRect, element.getBoundingClientRect(), 3)) {
          continue;
        }
        return createSnapshotFromCapture(capture, snapshotRect, element);
      } catch {
        latestViewportCapture = null;
      }
    }
    return createDirectSnapshot(element, element.getBoundingClientRect());
  }

  function copyRect(rect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function rectsClose(first, second, tolerance) {
    return ["left", "top", "right", "bottom"].every(
      (key) => Math.abs(first[key] - second[key]) <= tolerance
    );
  }

  function createSnapshotFromCapture(capture, rect, element) {
    const screenRect = clipRectToViewport(rect);
    if (!screenRect) {
      return createDirectSnapshot(element, rect);
    }

    const ratioX = capture.image.naturalWidth / Math.max(1, capture.viewportWidth);
    const ratioY = capture.image.naturalHeight / Math.max(1, capture.viewportHeight);
    // 粒子最终只有数个 CSS 像素，不需要保留截图的完整 Retina 分辨率。
    // 限制取样面既能维持纹理，又显著降低 getImageData 的同步主线程开销。
    const desiredScale = Math.min(1.2, ratioX, ratioY);
    const maxPixels = 1_050_000;
    const safeScale = Math.min(
      desiredScale,
      Math.sqrt(maxPixels / Math.max(1, screenRect.width * screenRect.height))
    );
    const width = Math.max(1, Math.round(screenRect.width * safeScale));
    const height = Math.max(1, Math.round(screenRect.height * safeScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return createDirectSnapshot(element, rect);
    }
    context.drawImage(
      capture.image,
      screenRect.left * ratioX,
      screenRect.top * ratioY,
      screenRect.width * ratioX,
      screenRect.height * ratioY,
      0,
      0,
      width,
      height
    );
    applyElementShapeMask(context, element, screenRect, width, height);
    return {
      sourceCanvas: canvas,
      imageData: context.getImageData(0, 0, width, height),
      width,
      height,
      screenRect,
      colors: getElementColors(element),
      viewportCapture: capture
    };
  }

  function applyElementShapeMask(context, element, screenRect, width, height) {
    const style = getComputedStyle(element);
    const elementRect = element.getBoundingClientRect();
    const scaleX = width / Math.max(1, screenRect.width);
    const scaleY = height / Math.max(1, screenRect.height);
    const x = (elementRect.left - screenRect.left) * scaleX;
    const y = (elementRect.top - screenRect.top) * scaleY;
    const boxWidth = elementRect.width * scaleX;
    const boxHeight = elementRect.height * scaleY;
    const radii = [
      parseCornerRadius(style.borderTopLeftRadius, elementRect.width, elementRect.height, scaleX, scaleY),
      parseCornerRadius(style.borderTopRightRadius, elementRect.width, elementRect.height, scaleX, scaleY),
      parseCornerRadius(style.borderBottomRightRadius, elementRect.width, elementRect.height, scaleX, scaleY),
      parseCornerRadius(style.borderBottomLeftRadius, elementRect.width, elementRect.height, scaleX, scaleY)
    ];

    context.save();
    context.globalCompositeOperation = "destination-in";
    context.fillStyle = "#000";
    roundedRectPath(context, x, y, boxWidth, boxHeight, radii);
    context.fill();
    context.restore();
  }

  function parseCornerRadius(value, boxWidth, boxHeight, scaleX, scaleY) {
    const parts = String(value).split(/\s+/);
    const horizontal = parts[0] || "0";
    const vertical = parts[1] || horizontal;
    return {
      x: Math.max(0, parseRadiusPart(horizontal, boxWidth) * scaleX),
      y: Math.max(0, parseRadiusPart(vertical, boxHeight) * scaleY)
    };
  }

  function parseRadiusPart(value, axisSize) {
    const number = Number.parseFloat(value) || 0;
    return String(value).includes("%") ? axisSize * number / 100 : number;
  }

  function roundedRectPath(context, x, y, width, height, radii) {
    const maximumX = Math.max(0, width / 2);
    const maximumY = Math.max(0, height / 2);
    const [topLeft, topRight, bottomRight, bottomLeft] = radii.map((radius) => ({
      x: Math.min(maximumX, radius.x),
      y: Math.min(maximumY, radius.y)
    }));
    context.beginPath();
    context.moveTo(x + topLeft.x, y);
    context.lineTo(x + width - topRight.x, y);
    context.quadraticCurveTo(x + width, y, x + width, y + topRight.y);
    context.lineTo(x + width, y + height - bottomRight.y);
    context.quadraticCurveTo(x + width, y + height, x + width - bottomRight.x, y + height);
    context.lineTo(x + bottomLeft.x, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - bottomLeft.y);
    context.lineTo(x, y + topLeft.y);
    context.quadraticCurveTo(x, y, x + topLeft.x, y);
    context.closePath();
  }

  function createDirectSnapshot(element, rect) {
    const screenRect = clipRectToViewport(rect);
    const colors = getElementColors(element);
    if (!screenRect) {
      return { sourceCanvas: null, imageData: null, width: 1, height: 1, screenRect: null, colors };
    }
    const scale = Math.min(1.1, Math.sqrt(800_000 / Math.max(1, screenRect.width * screenRect.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(screenRect.width * scale));
    canvas.height = Math.max(1, Math.round(screenRect.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !(element instanceof HTMLImageElement || element instanceof HTMLCanvasElement ||
                      element instanceof HTMLVideoElement)) {
      return { sourceCanvas: null, imageData: null, width: canvas.width, height: canvas.height, screenRect, colors };
    }

    try {
      const sourceWidth = element instanceof HTMLImageElement ? element.naturalWidth : element.width;
      const sourceHeight = element instanceof HTMLImageElement ? element.naturalHeight : element.height;
      const cropX = ((screenRect.left - rect.left) / rect.width) * sourceWidth;
      const cropY = ((screenRect.top - rect.top) / rect.height) * sourceHeight;
      const cropWidth = (screenRect.width / rect.width) * sourceWidth;
      const cropHeight = (screenRect.height / rect.height) * sourceHeight;
      context.drawImage(element, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
      let imageData = null;
      try {
        imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        // A tainted image can still be drawn faithfully; only color sampling is unavailable.
      }
      return { sourceCanvas: canvas, imageData, width: canvas.width, height: canvas.height, screenRect, colors };
    } catch {
      return { sourceCanvas: null, imageData: null, width: canvas.width, height: canvas.height, screenRect, colors };
    }
  }

  function clipRectToViewport(rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    return right > left && bottom > top
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  }

  function getElementColors(element) {
    const colors = [];
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const style = getComputedStyle(current);
      for (const color of [style.color, style.backgroundColor, style.borderTopColor]) {
        if (color && !/rgba?\(0, 0, 0(?:, 0)?\)/.test(color) && color !== "transparent") {
          colors.push(color);
        }
      }
      current = current.parentElement;
    }
    return colors.length ? colors : ["rgb(190, 190, 195)", "rgb(235, 235, 238)"];
  }

  function playParticleAnimation(snapshot, originalRect, sessionId, startDelay = 0) {
    if (!snapshot?.sourceCanvas || !snapshot.screenRect ||
        matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lowPower = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory || 8) <= 4;
    while (activeAnimations.size >= (lowPower ? 1 : 2)) {
      cleanupAnimation(activeAnimations.values().next().value);
    }
    ensureAnimationRoot();
    const clipped = snapshot.screenRect;
    // Measured from the supplied Safari recording: simultaneous granular breakup,
    // a restrained right/up drift, and a roughly 1.1 s tail. No wipe or glow.
    const bounds = {
      left: Math.max(0, clipped.left - 70),
      top: Math.max(0, clipped.top - 130),
      right: Math.min(innerWidth, clipped.right + 180),
      bottom: Math.min(innerHeight, clipped.bottom + 80)
    };
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
    const sourceCanvas = document.createElement("canvas");
    const sourceRatio = Math.min(devicePixelRatio || 1, 1.5,
      Math.sqrt(950_000 / Math.max(1, clipped.width * clipped.height)));
    sourceCanvas.width = Math.max(1, Math.round(clipped.width * sourceRatio));
    sourceCanvas.height = Math.max(1, Math.round(clipped.height * sourceRatio));
    Object.assign(sourceCanvas.style, {
      left: clipped.left + "px", top: clipped.top + "px",
      width: clipped.width + "px", height: clipped.height + "px",
      contain: "strict", willChange: "opacity"
    });
    sourceCanvas.dataset.annoyKillerLayer = "source";
    sourceCanvas.setAttribute("aria-hidden", "true");
    const context = sourceCanvas.getContext("2d", { alpha: true });
    if (!context) return;
    context.drawImage(snapshot.sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height);
    const seed = hashString(sessionId + ":" + originalRect.left + ":" + originalRect.top);
    const renderer = createDustRenderer(snapshot, clipped, bounds, lowPower, seed);
    const particleCanvas = renderer.canvas;
    Object.assign(particleCanvas.style, {
      left: bounds.left + "px", top: bounds.top + "px",
      width: bounds.width + "px", height: bounds.height + "px", contain: "strict"
    });
    particleCanvas.dataset.annoyKillerLayer = "particles";
    particleCanvas.dataset.annoyKillerParticleCount = String(renderer.count);
    particleCanvas.dataset.annoyKillerRenderer = renderer.kind;
    particleCanvas.setAttribute("aria-hidden", "true");
    animationRoot.append(sourceCanvas, particleCanvas);
    const sourceAnimation = sourceCanvas.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 115, delay: startDelay, easing: "ease-out", fill: "forwards"
    });
    const animation = {
      sessionId, sourceCanvas, particleCanvas, textureCanvas: snapshot.sourceCanvas,
      sourceAnimation, renderer, rafId: 0, stopped: false
    };
    activeAnimations.add(animation);
    const startedAt = performance.now() + startDelay;
    const draw = now => {
      if (animation.stopped) return;
      const elapsed = now - startedAt;
      if (elapsed >= 1250 || document.hidden) {
        cleanupAnimation(animation);
        return;
      }
      if (elapsed >= 0) renderer.render(elapsed);
      animation.rafId = requestAnimationFrame(draw);
    };
    animation.rafId = requestAnimationFrame(draw);
  }

  function createDustRenderer(snapshot, clipped, bounds, lowPower, seed) {
    let canvas = document.createElement("canvas");
    const pixelRatio = Math.min(devicePixelRatio || 1, lowPower ? 1 : 1.5,
      Math.sqrt((lowPower ? 650_000 : 1_400_000) / Math.max(1, bounds.width * bounds.height)));
    const resize = () => {
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
    };
    resize();
    const gl = canvas.getContext("webgl", {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, preserveDrawingBuffer: false,
      powerPreference: "low-power", failIfMajorPerformanceCaveat: true
    });
    if (gl) {
      const shaders = [];
      let program, buffer, texture;
      const dispose = () => {
        if (buffer) gl.deleteBuffer(buffer);
        if (texture) gl.deleteTexture(texture);
        if (program) gl.deleteProgram(program);
        for (const shader of shaders) gl.deleteShader(shader);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      };
      try {
        const compile = (type, text) => {
          const shader = gl.createShader(type);
          shaders.push(shader);
          gl.shaderSource(shader, text);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Dust shader");
          return shader;
        };
        program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, `
          precision highp float;
          attribute vec2 aUV;
          attribute vec4 aSeed;
          uniform vec2 uSize;
          uniform vec2 uOffset;
          uniform vec2 uBounds;
          uniform float uTime;
          uniform float uRatio;
          uniform float uSpacing;
          varying vec2 vUV;
          varying float vAlpha;
          void main() {
            float age = max(0.0, uTime - aSeed.w * 0.055);
            float life = 0.86 + aSeed.z * 0.34;
            float t = clamp(age / life, 0.0, 1.0);
            float travel = pow(t, 1.28);
            float angle = aSeed.x * 6.2831853;
            float spread = 16.0 + aSeed.y * 66.0;
            vec2 wind = vec2(46.0 + 22.0 * aUV.x, -25.0);
            vec2 drift = wind + vec2(cos(angle), sin(angle)) * spread;
            // Nearby grains share a slow curl, independent grains disperse within it.
            vec2 curl = vec2(sin(aUV.y * 8.0 + t * 3.0),
                            cos(aUV.x * 7.0 + t * 2.0));
            vec2 pos = uOffset + aUV * uSize + drift * travel +
                       curl * (12.0 * t * t);
            gl_Position = vec4(pos / uBounds * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
            gl_PointSize = max(0.7, uSpacing * (1.0 + aSeed.z * 0.5) *
                              (1.0 - 0.22 * t) * uRatio);
            vUV = aUV;
            vAlpha = (1.0 - smoothstep(0.18 + aSeed.y * 0.12, 1.0, t)) *
                     smoothstep(0.0, 0.055, age);
          }`));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
          precision mediump float;
          uniform sampler2D uImage;
          varying vec2 vUV;
          varying float vAlpha;
          void main() {
            vec4 color = texture2D(uImage, vUV);
            float edge = 1.0 - smoothstep(0.37, 0.5, length(gl_PointCoord - 0.5));
            float alpha = color.a * vAlpha * edge;
            gl_FragColor = vec4(color.rgb * alpha, alpha);
          }`));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Dust link");
        gl.useProgram(program);
        const maximum = lowPower ? 85_000 : 180_000;
        const spacing = Math.max(lowPower ? 1.65 : 1.25,
          Math.sqrt(clipped.width * clipped.height / maximum));
        const columns = Math.max(1, Math.floor(clipped.width / spacing));
        const rows = Math.max(1, Math.floor(clipped.height / spacing));
        const count = columns * rows;
        const vertices = new Float32Array(count * 6);
        const random = mulberry32(seed);
        let offset = 0;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < columns; x++) {
            vertices[offset++] = (x + 0.12 + random() * 0.76) / columns;
            vertices[offset++] = (y + 0.12 + random() * 0.76) / rows;
            vertices[offset++] = random();
            vertices[offset++] = random();
            vertices[offset++] = random();
            vertices[offset++] = random();
          }
        }
        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        for (const [name, size, byteOffset] of [["aUV", 2, 0], ["aSeed", 4, 8]]) {
          const location = gl.getAttribLocation(program, name);
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, 24, byteOffset);
        }
        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot.sourceCanvas);
        gl.uniform1i(gl.getUniformLocation(program, "uImage"), 0);
        gl.uniform2f(gl.getUniformLocation(program, "uSize"), clipped.width, clipped.height);
        gl.uniform2f(gl.getUniformLocation(program, "uOffset"),
          clipped.left - bounds.left, clipped.top - bounds.top);
        gl.uniform2f(gl.getUniformLocation(program, "uBounds"), bounds.width, bounds.height);
        gl.uniform1f(gl.getUniformLocation(program, "uRatio"), pixelRatio);
        gl.uniform1f(gl.getUniformLocation(program, "uSpacing"), spacing);
        const timeLocation = gl.getUniformLocation(program, "uTime");
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        return { canvas, count, kind: "webgl", dispose, render(milliseconds) {
          // One upload on creation; one uniform and one draw call per frame.
          // No readback, per-grain JS work, DOM mutation, or frame allocations.
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.uniform1f(timeLocation, milliseconds / 1000);
          gl.drawArrays(gl.POINTS, 0, count);
        } };
      } catch {
        dispose();
      }
      canvas = document.createElement("canvas");
      resize();
    }
    // Hardware-disabled / software-GL environments use a bounded 2D fallback.
    // It keeps the same silhouette, timing and native colors at lower density.
    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    const particles = [];
    const maxCount = lowPower ? 3200 : 6500;
    const spacing = Math.max(1.5, Math.sqrt(clipped.width * clipped.height / maxCount));
    const random = mulberry32(seed);
    for (let y = spacing / 2; y < clipped.height; y += spacing) {
      for (let x = spacing / 2; x < clipped.width; x += spacing) {
        const sample = snapshot.imageData
          ? samplePixelColor(snapshot.imageData.data, snapshot.width, snapshot.height,
            x / clipped.width * snapshot.width, y / clipped.height * snapshot.height)
          : { color: snapshot.colors?.[Math.floor(random() * snapshot.colors.length)] || "#aaa", alpha: 1 };
        const angle = random() * Math.PI * 2;
        const spread = 16 + random() * 66;
        particles.push({ x, y, color: sample.color, alpha: sample.alpha,
          vx: 46 + 22 * x / clipped.width + Math.cos(angle) * spread,
          vy: -25 + Math.sin(angle) * spread, life: 860 + random() * 340,
          delay: random() * 55, size: Math.min(2.8, spacing * (0.62 + random() * 0.52)) });
      }
    }
    context?.scale(pixelRatio, pixelRatio);
    return { canvas, count: particles.length, kind: "canvas2d", dispose() {}, render(elapsed) {
      if (!context) return;
      context.clearRect(0, 0, bounds.width, bounds.height);
      for (const p of particles) {
        const age = elapsed - p.delay;
        if (age <= 0 || age >= p.life || p.alpha < 0.02) continue;
        const t = age / p.life;
        const travel = Math.pow(t, 1.28);
        const fade = Math.min(1, Math.max(0, (t - 0.23) / 0.77));
        context.globalAlpha = p.alpha * (1 - fade * fade * (3 - 2 * fade)) * Math.min(1, age / 55);
        context.fillStyle = p.color;
        const size = p.size * (1 - t * 0.22);
        context.fillRect(clipped.left - bounds.left + p.x + p.vx * travel +
          Math.sin(p.y / clipped.height * 8 + t * 3) * 12 * t * t,
          clipped.top - bounds.top + p.y + p.vy * travel +
          Math.cos(p.x / clipped.width * 7 + t * 2) * 12 * t * t, size, size);
      }
      context.globalAlpha = 1;
    } };
  }

  function ensureAnimationRoot() {
    if (animationHost?.isConnected) {
      return;
    }
    animationHost = document.createElement("div");
    animationHost.setAttribute("data-annoy-killer-animation", "");
    animationRoot = animationHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; } canvas { position: fixed; pointer-events: none; }`;
    animationRoot.append(style);
    document.documentElement.appendChild(animationHost);
  }


  function samplePixelColor(data, width, height, x, y) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alphaTotal = 0;
    const centerX = Math.round(x);
    const centerY = Math.round(y);
    const offsets = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [offsetX, offsetY] of offsets) {
      const pixelX = Math.max(0, Math.min(width - 1, centerX + offsetX));
      const pixelY = Math.max(0, Math.min(height - 1, centerY + offsetY));
      const index = (pixelY * width + pixelX) * 4;
      const alpha = data[index + 3] / 255;
      red += data[index] * alpha;
      green += data[index + 1] * alpha;
      blue += data[index + 2] * alpha;
      alphaTotal += alpha;
    }
    const divisor = Math.max(0.001, alphaTotal);
    return {
      color: `rgb(${Math.round(red / divisor)}, ${Math.round(green / divisor)}, ${Math.round(blue / divisor)})`,
      alpha: alphaTotal / offsets.length
    };
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    return () => {
      let value = seed += 0x6D2B79F5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }


  function cancelAnimationsForSession(sessionId) {
    for (const animation of [...activeAnimations]) {
      if (animation.sessionId === sessionId) {
        cleanupAnimation(animation);
      }
    }
  }

  function cleanupAnimation(animation) {
    if (!animation || animation.stopped) {
      return;
    }
    animation.stopped = true;
    cancelAnimationFrame(animation.rafId);
    animation.sourceAnimation?.cancel();
    animation.renderer?.dispose();
    for (const canvas of [
      animation.sourceCanvas,
      animation.particleCanvas,
      animation.textureCanvas
    ]) {
      if (!canvas) {
        continue;
      }
      canvas.remove();
      canvas.width = 0;
      canvas.height = 0;
    }
    activeAnimations.delete(animation);
    if (!activeAnimations.size) {
      animationHost?.remove();
      animationHost = null;
      animationRoot = null;
    }
  }
})();
