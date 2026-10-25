// Called through the background's storage queue so remote merges and page saves cannot race.
globalThis.createRuleSync = function ({ keys, canonicalRuleKey, normalizeRuleList }) {
  const ENABLED = "ruleSyncEnabled";
  const STATE = "ruleSyncState";
  const ERROR = "ruleSyncError";
  const PREFIX = "ak-rule-v1:";
  const ALARM = "annoy-killer:sync-rules";
  const encoder = new TextEncoder();

  function stateFrom(stored) {
    return stored[STATE] || { device: crypto.randomUUID(), clock: 0, records: {} };
  }

  async function ruleId(rule) {
    const bytes = encoder.encode(JSON.stringify([rule[0], rule[1], canonicalRuleKey(rule[2])]));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return PREFIX + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function flatten(stored) {
    const entries = [];
    for (const [index, key] of keys.entries()) {
      for (const [scope, rules] of Object.entries(stored[key] || {})) {
        for (const rule of normalizeRuleList(rules)) {
          const value = [index, scope, rule];
          entries.push(ruleId(value).then(id => [id, value]));
        }
      }
    }
    return Object.fromEntries(await Promise.all(entries));
  }

  function newer(a, b) {
    return !b || a.v[0] > b.v[0] || (a.v[0] === b.v[0] && a.v[1] > b.v[1]);
  }

  async function validRecord(id, record) {
    if (!/^ak-rule-v1:[a-f0-9]{64}$/.test(id) || !record || !Array.isArray(record.v) ||
        record.v.length !== 2 || !Number.isSafeInteger(record.v[0]) || record.v[0] < 0 ||
        typeof record.v[1] !== "string" || record.v[1].length > 64) return false;
    if (!Object.hasOwn(record, "r")) return true; // Durable deletion marker.
    const r = record.r;
    return Array.isArray(r) && r.length === 3 && Number.isInteger(r[0]) && keys[r[0]] !== undefined &&
      typeof r[1] === "string" && r[1].length > 0 && normalizeRuleList([r[2]]).length === 1 &&
      await ruleId(r) === id;
  }

  function materialize(state) {
    const values = Object.fromEntries(keys.map(key => [key, Object.create(null)]));
    for (const { r } of Object.values(state.records)) {
      if (r) (values[keys[r[0]]][r[1]] ||= []).push(r[2]);
    }
    return values;
  }

  async function schedule() {
    if (!await chrome.alarms.get(ALARM)) {
      await chrome.alarms.create(ALARM, { delayInMinutes: 0.5 });
    }
  }

  async function saveChanges(before, values) {
    const stored = await chrome.storage.local.get([STATE, ENABLED]);
    if (!stored[STATE] && stored[ENABLED] === false) {
      await chrome.storage.local.set(values);
      return;
    }
    const state = stateFrom(stored);
    const [oldRules, newRules] = await Promise.all([flatten(before), flatten(values)]);
    const version = [Math.max(Date.now(), state.clock + 1), state.device];
    state.clock = version[0];
    for (const [id, rule] of Object.entries(newRules)) {
      if (!oldRules[id] || JSON.stringify(oldRules[id]) !== JSON.stringify(rule)) {
        state.records[id] = { v: version, r: rule };
      }
    }
    for (const id of Object.keys(oldRules)) {
      if (!newRules[id]) state.records[id] = { v: version };
    }
    // Keep edits and deletion markers together, even while this device has sync off.
    await chrome.storage.local.set({ ...values, [STATE]: state });
    if (stored[ENABLED] !== false) await schedule().catch(error => console.debug("Rule sync scheduling failed", error));
  }

  function entrySize(id, value) {
    return encoder.encode(id).length + encoder.encode(JSON.stringify(value)).length;
  }

  function selectNewestRecords(records, remote) {
    const reserved = Object.entries(remote).filter(([id]) => !id.startsWith(PREFIX));
    let availableBytes = chrome.storage.sync.QUOTA_BYTES -
      reserved.reduce((total, [id, value]) => total + entrySize(id, value), 0);
    let availableItems = chrome.storage.sync.MAX_ITEMS - reserved.length;
    const selected = {};
    const newestFirst = Object.entries(records).sort(([firstId, first], [secondId, second]) =>
      second.v[0] - first.v[0] || second.v[1].localeCompare(first.v[1]) || secondId.localeCompare(firstId));
    for (const [id, record] of newestFirst) {
      const size = entrySize(id, record);
      if (size > chrome.storage.sync.QUOTA_BYTES_PER_ITEM) throw new Error("QUOTA_BYTES_PER_ITEM");
      if (availableItems <= 0 || size > availableBytes) continue;
      selected[id] = record;
      availableBytes -= size;
      availableItems -= 1;
    }
    return selected;
  }

  async function flush() {
    const stored = await chrome.storage.local.get([...keys, STATE, ENABLED]);
    if (stored[ENABLED] === false) {
      await chrome.alarms.clear(ALARM);
      return;
    }
    // A repeating retry survives worker termination, including during a storage write.
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    try {
      const state = stateFrom(stored);
      for (const [id, rule] of Object.entries(await flatten(stored))) {
        // Unversioned rules from before sync was enabled must not resurrect cloud deletions.
        if (!state.records[id]) state.records[id] = { v: [0, state.device], r: rule };
      }
      const remote = await chrome.storage.sync.get(null);
      for (const [id, record] of Object.entries(remote)) {
        if (!await validRecord(id, record)) continue;
        state.clock = Math.max(state.clock, record.v[0]);
        if (newer(record, state.records[id])) state.records[id] = record;
      }
      const values = materialize(state);
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
        JSON.stringify(stored[key] || {}) !== JSON.stringify(value)));
      await chrome.storage.local.set({ ...changed, [STATE]: state });
      const selected = selectNewestRecords(state.records, remote);
      const removals = Object.keys(remote).filter(id => id.startsWith(PREFIX) && !selected[id]);
      const updates = Object.fromEntries(Object.entries(selected).filter(([id, record]) =>
        JSON.stringify(remote[id]) !== JSON.stringify(record)));
      // Free cloud quota before uploading the newest records. Local rules remain
      // materialized from the complete state and are never deleted by eviction.
      if (removals.length) await chrome.storage.sync.remove(removals);
      if (Object.keys(updates).length) {
        await chrome.storage.sync.set(updates);
      }
      await chrome.storage.local.set({ [ERROR]: false });
      await chrome.alarms.clear(ALARM);
    } catch (error) {
      // Sync failure must never discard locally saved rules or pending deletions.
      await chrome.storage.local.set({ [ERROR]: true });
      console.debug("Rule sync pending", error);
    }
  }

  async function setEnabled(enabled) {
    await chrome.storage.local.set({ [ENABLED]: enabled, [ERROR]: false });
    if (enabled) await flush();
    else await chrome.alarms.clear(ALARM);
    return { enabled };
  }

  async function syncNow(ids) {
    const stored = await chrome.storage.local.get([STATE, ENABLED]);
    if (stored[ENABLED] === false) return { enabled: false };
    const state = stateFrom(stored);
    const requested = new Set(Array.isArray(ids) ? ids : []);
    const records = Object.entries(state.records).filter(([id, record]) => requested.has(id) && record.r);
    if (records.length) {
      const version = [Math.max(Date.now(), state.clock + 1), state.device];
      state.clock = version[0];
      for (const [id, record] of records) state.records[id] = { ...record, v: version };
      await chrome.storage.local.set({ [STATE]: state });
    }
    await flush();
    return { enabled: true };
  }

  return { saveChanges, flush, setEnabled, syncNow, alarm: ALARM, prefix: PREFIX };
};
