importScripts("sync.js");

const TOGGLE_MESSAGE = { type: "annoy-killer:toggle" };
const PAGE_STORAGE_KEY = "hiddenRulesByPage";
const SITE_STORAGE_KEY = "hiddenRulesBySite";
const VISIBLE_PAGE_STORAGE_KEY = "visibleExceptionsByPage";
const captureQueues = new Map();
const lastCaptureAt = new Map();
let storageCommitQueue = Promise.resolve();
let shortcutGuideQueue = Promise.resolve();
let coffeeQueue = Promise.resolve();
const ruleSync = createRuleSync({
  keys: [PAGE_STORAGE_KEY, SITE_STORAGE_KEY, VISIBLE_PAGE_STORAGE_KEY],
  canonicalRuleKey,
  normalizeRuleList
});

function queueStorage(task) {
  storageCommitQueue = storageCommitQueue.catch(() => undefined).then(task);
  return storageCommitQueue;
}

function syncRules() {
  queueStorage(() => ruleSync.flush()).catch(error => console.debug("Rule sync failed", error));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && Object.keys(changes).some(key => key.startsWith(ruleSync.prefix))) syncRules();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ruleSync.alarm) syncRules();
});
chrome.runtime.onStartup.addListener(syncRules);
syncRules();

chrome.action.onClicked.addListener(toggleTab);

chrome.runtime.onInstalled.addListener(() => {
  // Replay first-use guidance once for this upgrade without removing hide rules.
  shortcutGuideQueue = shortcutGuideQueue.catch(() => false).then(async () => {
    const stored = await chrome.storage.local.get("shortcutGuideReplayVersion");
    if (stored.shortcutGuideReplayVersion !== "1.0.30") {
      await chrome.storage.local.set({ shortcutGuideSeen: false, shortcutGuideReplayVersion: "1.0.30" });
    }
  });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "annoy-killer-shortcuts",
      title: chrome.i18n.getMessage("options"),
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: "annoy-killer-coffee",
      title: chrome.i18n.getMessage("coffeeMenu"),
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: "annoy-killer-feedback",
      title: chrome.i18n.getMessage("feedback"),
      contexts: ["action"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "annoy-killer-shortcuts" || info.menuItemId === "annoy-killer-coffee") {
    chrome.runtime.openOptionsPage()
      .catch(error => console.debug("无法打开选项。", error));
    return;
  }
  if (info.menuItemId === "annoy-killer-feedback") {
    chrome.tabs.create({ url: "mailto:toufayehehua@icloud.com" })
      .catch(error => console.debug("无法打开反馈邮件。", error));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "annoy-killer:sync-rules-now" &&
      sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("options.html")) {
    const ids = Array.isArray(message.ids)
      ? message.ids.filter(id => typeof id === "string" && id.startsWith(ruleSync.prefix)).slice(0, 512)
      : [];
    queueStorage(() => ruleSync.syncNow(ids))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "annoy-killer:set-rule-sync" &&
      sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL("options.html") &&
      typeof message.enabled === "boolean") {
    queueStorage(() => ruleSync.setEnabled(message.enabled))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "annoy-killer:picker-opened" && sender.tab && sender.frameId === 0) {
    // Count actual picker openings globally, including shortcut use, across tabs.
    coffeeQueue = coffeeQueue.catch(() => undefined).then(async () => {
      const stored = await chrome.storage.local.get("pickerOpenCount");
      const previous = Number.isSafeInteger(stored.pickerOpenCount) ? stored.pickerOpenCount : 0;
      const count = Math.max(0, previous) + 1;
      await chrome.storage.local.set({ pickerOpenCount: count });
      return count % 5 === 0;
    });
    coffeeQueue.then(show => sendResponse({ show }))
      .catch(() => sendResponse({ show: false }));
    return true;
  }
  if (message?.type === "annoy-killer:open-coffee" && sender.tab && sender.frameId === 0) {
    coffeeQueue = coffeeQueue.catch(() => undefined).then(async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL("options.html#coffee") });
    });
    coffeeQueue.then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "annoy-killer:shortcut-toggle" && sender.tab) {
    toggleTab(sender.tab).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "annoy-killer:claim-shortcut-guide") {
    // Serialize across tabs so the first-use guide is shown once per installation.
    shortcutGuideQueue = shortcutGuideQueue.catch(() => false).then(async () => {
      const stored = await chrome.storage.local.get("shortcutGuideSeen");
      if (stored.shortcutGuideSeen) return false;
      await chrome.storage.local.set({ shortcutGuideSeen: true });
      return true;
    });
    shortcutGuideQueue.then(show => sendResponse({ show }))
      .catch(() => sendResponse({ show: false }));
    return true;
  }

  if (message?.type === "annoy-killer:capture-visible-tab") {
    captureVisibleTab(sender.tab)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "annoy-killer:commit-rules") {
    queueStorage(() => commitRules(message))
      .then((rules) => sendResponse({ ok: true, ...rules }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

async function toggleTab(tab) {
  if (!tab?.id || !tab.url || !/^https?:|^file:/.test(tab.url)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, TOGGLE_MESSAGE, { frameId: 0 });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        files: ["shortcuts.js", "rules.js", "content.js"]
      });
      await chrome.tabs.sendMessage(tab.id, TOGGLE_MESSAGE, { frameId: 0 });
    } catch (error) {
      console.debug("扰人杀手无法在当前页面运行。", error);
    }
  }
}

async function captureVisibleTab(tab) {
  if (!tab?.windowId) {
    throw new Error("无法确定当前窗口");
  }

  const previous = captureQueues.get(tab.windowId) || Promise.resolve();
  const capture = previous.catch(() => undefined).then(async () => {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!activeTab || activeTab.id !== tab.id) {
      throw new Error("页面已不是当前标签页");
    }
    const elapsed = Date.now() - (lastCaptureAt.get(tab.windowId) || 0);
    if (elapsed < 520) {
      await new Promise((resolve) => setTimeout(resolve, 520 - elapsed));
    }
    const [stillActiveTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!stillActiveTab || stillActiveTab.id !== tab.id) {
      throw new Error("页面已不是当前标签页");
    }
    // 粒子只采样微小纹理，无需传输无损整屏 PNG。高质量 JPEG 显著减少
    // 编码、跨进程消息和图片解码开销，视觉差异在粒子尺寸下不可见。
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 92
    });
    lastCaptureAt.set(tab.windowId, Date.now());
    return dataUrl;
  });
  captureQueues.set(tab.windowId, capture);
  return capture;
}

async function commitRules(message) {
  const pageKey = typeof message.pageKey === "string" ? message.pageKey : "";
  const siteKey = typeof message.siteKey === "string" ? message.siteKey : "";
  if (!pageKey || !siteKey) {
    throw new Error("隐藏规则缺少页面范围");
  }

  const stored = await chrome.storage.local.get([
    PAGE_STORAGE_KEY,
    SITE_STORAGE_KEY,
    VISIBLE_PAGE_STORAGE_KEY
  ]);
  const rulesByPage = { ...stored[PAGE_STORAGE_KEY] };
  const rulesBySite = { ...stored[SITE_STORAGE_KEY] };
  const visibleRulesByPage = { ...stored[VISIBLE_PAGE_STORAGE_KEY] };
  rulesByPage[pageKey] = mergeRules(
    removeRules(rulesByPage[pageKey], message.removePageRules),
    message.pageRules
  );
  rulesBySite[siteKey] = mergeRules(
    removeRules(rulesBySite[siteKey], message.removeSiteRules),
    message.siteRules
  );
  visibleRulesByPage[pageKey] = mergeRules(
    removeRules(visibleRulesByPage[pageKey], message.removeVisiblePageRules),
    message.visiblePageRules
  );
  await ruleSync.saveChanges(stored, {
    [PAGE_STORAGE_KEY]: rulesByPage,
    [SITE_STORAGE_KEY]: rulesBySite,
    [VISIBLE_PAGE_STORAGE_KEY]: visibleRulesByPage
  });
  return {
    pageRules: rulesByPage[pageKey],
    siteRules: rulesBySite[siteKey],
    visiblePageRules: visibleRulesByPage[pageKey]
  };
}

function removeRules(currentRules, removedRules) {
  const removedKeys = new Set(normalizeRuleList(removedRules).map(canonicalRuleKey));
  return normalizeRuleList(currentRules).filter((rule) => !removedKeys.has(canonicalRuleKey(rule)));
}

function canonicalRuleKey(rule) {
  const normalized = typeof rule === "string" ? { selector: rule } : rule;
  if (!normalized || typeof normalized !== "object") return JSON.stringify(normalized);
  const { group: _group, ...identity } = normalized;
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

function mergeRules(currentRules, newRules) {
  const merged = new Map();
  for (const rule of [...normalizeRuleList(currentRules), ...normalizeRuleList(newRules)]) {
    merged.set(canonicalRuleKey(rule), rule);
  }
  return [...merged.values()];
}

function normalizeRuleList(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }
  return rules.filter((rule) => {
    if (typeof rule === "string") {
      return rule.length > 0 && rule.length < 1600;
    }
    return rule && typeof rule === "object" &&
      typeof rule.selector === "string" && rule.selector.length > 0 && rule.selector.length < 1600;
  });
}
