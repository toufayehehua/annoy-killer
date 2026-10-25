const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
document.documentElement.lang = chrome.i18n.getUILanguage();
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform);
for (const element of document.querySelectorAll("[data-i18n]")) {
  const key = element.dataset.i18n;
  const slots = { refine: [`<kbd>${isMac ? "Command" : "Ctrl"}</kbd>`, '<kbd>Shift</kbd>', `<kbd>${isMac ? "Option" : "Alt"}</kbd>`],
    exitUndo: ['<kbd>ESC</kbd>', '<kbd>Enter</kbd>'],
    toggleGuide: '<kbd id="toggle-key-label"></kbd>' };
  if (slots[key]) element.innerHTML = t(key, slots[key]);
  else element.textContent = t(key);
}
for (const element of document.querySelectorAll("[data-i18n-alt]")) {
  element.alt = t(element.dataset.i18nAlt);
}
const shortcuts = AnnoyKillerShortcuts;
const select = document.querySelector("#shortcut-key");
const toggleKeyLabel = document.querySelector("#toggle-key-label");
for (const key of shortcuts.keys) {
  select.add(new Option(t("doubleTap", shortcuts.label(key)), key));
}
let savedKey = shortcuts.defaultKey;
function renderShortcut() {
  select.value = savedKey;
  toggleKeyLabel.textContent = shortcuts.label(savedKey);
}
renderShortcut();
async function save(key) {
  select.disabled = true;
  try {
    await chrome.storage.local.set({ toggleShortcutKey: key });
    savedKey = key;
  } catch (error) {
    console.debug("无法保存快捷键。", error);
  } finally {
    renderShortcut();
    select.disabled = false;
  }
}
select.addEventListener("change", () => save(select.value));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.toggleShortcutKey) {
    savedKey = shortcuts.validKey(changes.toggleShortcutKey.newValue);
    renderShortcut();
  }
});
chrome.storage.local.get("toggleShortcutKey").then(stored => {
  savedKey = shortcuts.validKey(stored.toggleShortcutKey);
  renderShortcut();
  select.disabled = false;
}).catch(error => console.debug("无法读取快捷键。", error));

const syncSwitch = document.querySelector("#rule-sync");
const syncSites = document.querySelector("#sync-sites");
const syncEmpty = document.querySelector("#sync-empty");
const syncSitesToggle = document.querySelector("#sync-sites-toggle");
const syncStorage = document.querySelector("#sync-storage");
const syncRuleKeys = ["hiddenRulesByPage", "hiddenRulesBySite", "visibleExceptionsByPage"];
const syncVisibleLimit = 3;
let syncBusy = false;
let syncExpanded = false;
let manualSyncBusy = false;
let syncDetailsVersion = 0;
let syncRecordIdsBySite = new Map();

function syncSiteName(scope) {
  if (scope === "file://" || scope.startsWith("file://")) return t("syncLocalFiles");
  try {
    return new URL(scope).host || scope;
  } catch {
    return scope;
  }
}

function collectSyncSites(stored) {
  const sites = new Map();
  const ensureSite = scope => {
    const name = syncSiteName(scope);
    if (!name) return null;
    if (!sites.has(name)) sites.set(name, { name, records: [], updatedAt: 0 });
    return sites.get(name);
  };
  for (const [scope, rules] of Object.entries(stored.hiddenRulesByPage || {})) {
    if (Array.isArray(rules) && rules.length) ensureSite(scope);
  }
  for (const [id, record] of Object.entries(stored.ruleSyncState?.records || {})) {
    if (!record?.r) continue;
    const site = sites.get(syncSiteName(record.r[1]));
    if (!site) continue;
    site.records.push([id, record]);
    site.updatedAt = Math.max(site.updatedAt, Number(record.v?.[0]) || 0);
  }
  return [...sites.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

async function filterObservedEmptySites(sites) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return sites;
  }
  const states = await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
    type: "annoy-killer:get-hidden-rule-state"
  }, { frameId: 0 }).catch(() => null)));
  const hiddenCounts = new Map();
  for (const state of states) {
    if (!state?.pageKey || !Number.isInteger(state.hiddenCount)) continue;
    const site = syncSiteName(state.pageKey);
    hiddenCounts.set(site, Math.max(hiddenCounts.get(site) || 0, state.hiddenCount));
  }
  return sites.filter(site => !hiddenCounts.has(site.name) || hiddenCounts.get(site.name) > 0);
}

function syncSiteState(site, stored, remote) {
  if (stored.ruleSyncEnabled === false) return "paused";
  if (stored.ruleSyncError === true || !remote) return "error";
  return site.records.length && site.records.every(([id, record]) =>
    JSON.stringify(remote[id]) === JSON.stringify(record)) ? "synced" : "pending";
}

function formatSyncBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const value = bytes / 1024;
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} KB`;
}

async function renderSyncDetails() {
  const version = ++syncDetailsVersion;
  const stored = await chrome.storage.local.get([...syncRuleKeys, "ruleSyncEnabled", "ruleSyncState", "ruleSyncError"]);
  let remote;
  let bytesInUse;
  try {
    [remote, bytesInUse] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.sync.getBytesInUse(null)
    ]);
  } catch (error) {
    console.debug("无法读取规则同步详情。", error);
  }
  if (version !== syncDetailsVersion) return;

  const sites = await filterObservedEmptySites(collectSyncSites(stored));
  if (version !== syncDetailsVersion) return;
  syncRecordIdsBySite = new Map(sites.map(site => [site.name, site.records.map(([id]) => id)]));
  const visibleSites = syncExpanded ? sites : sites.slice(0, syncVisibleLimit);
  syncSites.replaceChildren(...visibleSites.map(site => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const result = document.createElement("span");
    const status = document.createElement("span");
    const state = syncSiteState(site, stored, remote);
    name.className = "sync-site-name";
    name.textContent = site.name;
    name.title = site.name;
    status.className = "sync-site-status";
    status.dataset.state = state;
    status.textContent = t(`syncStatus${state[0].toUpperCase()}${state.slice(1)}`);
    result.className = "sync-site-result";
    result.append(status);
    if (state === "pending" || state === "error") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sync-now";
      button.dataset.site = site.name;
      button.disabled = manualSyncBusy;
      button.textContent = t(manualSyncBusy ? "syncingNow" : "syncNow");
      result.append(button);
    }
    item.append(name, result);
    return item;
  }));
  syncEmpty.hidden = sites.length !== 0;
  syncSitesToggle.hidden = sites.length <= syncVisibleLimit;
  syncSitesToggle.textContent = t(syncExpanded ? "syncCollapse" : "syncViewAll");
  syncSitesToggle.setAttribute("aria-expanded", String(syncExpanded));
  syncStorage.textContent = t("syncStorageUsage",
    [formatSyncBytes(bytesInUse), formatSyncBytes(chrome.storage.sync.QUOTA_BYTES)]);
}

syncSitesToggle.addEventListener("click", () => {
  syncExpanded = !syncExpanded;
  renderSyncDetails().catch(error => console.debug("无法读取规则同步详情。", error));
});

syncSites.addEventListener("click", async event => {
  const button = event.target.closest(".sync-now");
  if (!button || manualSyncBusy) return;
  const ids = syncRecordIdsBySite.get(button.dataset.site) || [];
  manualSyncBusy = true;
  await renderSyncDetails().catch(error => console.debug("无法读取规则同步详情。", error));
  try {
    await chrome.runtime.sendMessage({ type: "annoy-killer:sync-rules-now", ids });
  } catch (error) {
    console.debug("无法手动同步屏蔽规则。", error);
  } finally {
    manualSyncBusy = false;
    await Promise.all([renderSync(), renderSyncDetails()])
      .catch(error => console.debug("无法读取规则同步详情。", error));
  }
});

async function renderSync() {
  const stored = await chrome.storage.local.get(["ruleSyncEnabled", "ruleSyncError"]);
  syncSwitch.checked = stored.ruleSyncEnabled !== false;
  syncSwitch.setAttribute("aria-invalid", String(syncSwitch.checked && stored.ruleSyncError === true));
  syncSwitch.disabled = syncBusy;
}
syncSwitch.addEventListener("change", async () => {
  syncBusy = syncSwitch.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "annoy-killer:set-rule-sync", enabled: syncSwitch.checked
    });
    if (!response?.ok) throw new Error(response?.error || "Rule sync setting failed");
  } catch (error) {
    console.debug("无法更改规则同步设置。", error);
  } finally {
    syncBusy = false;
    await Promise.all([
      renderSync(),
      renderSyncDetails()
    ]).catch(error => console.debug("无法读取规则同步设置。", error));
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.ruleSyncEnabled || changes.ruleSyncError)) {
    renderSync().catch(error => console.debug("无法读取规则同步设置。", error));
  }
  if ((area === "local" && [...syncRuleKeys, "ruleSyncEnabled", "ruleSyncState", "ruleSyncError"].some(key => changes[key])) ||
      area === "sync") {
    renderSyncDetails().catch(error => console.debug("无法读取规则同步详情。", error));
  }
});
renderSync().catch(error => console.debug("无法读取规则同步设置。", error));
renderSyncDetails().catch(error => console.debug("无法读取规则同步详情。", error));
