import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const channel = process.argv.find(argument => argument.startsWith('--channel='))?.slice('--channel='.length) || 'chrome';
assert(['chrome', 'edge'].includes(channel), 'channel must be chrome or edge');
const source = await readFile(new URL(`../${channel}/sync.js`, import.meta.url), 'utf8');
const keys = ['hiddenRulesByPage', 'hiddenRulesBySite', 'visibleExceptionsByPage'];
const scope = 'https://example.test/page';
const rules = (...selectors) => ({ [keys[0]]: { [scope]: selectors.map(selector => ({ selector })) } });
const canonical = value => {
  const normalized = typeof value === 'string' ? { selector: value } : value;
  if (!normalized || typeof normalized !== 'object') return JSON.stringify(normalized);
  const { group: _group, ...identity } = normalized;
  return JSON.stringify(sort(identity));
};
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
}
function device(cloud, initial = {}) {
  const local = structuredClone(initial);
  const alarms = new Map();
  let reads = 0, writes = 0, failure = '';
  const chrome = {
    alarms: {
      async get(name) { return alarms.get(name); },
      async create(name, alarm) { alarms.set(name, alarm); },
      async clear(name) { return alarms.delete(name); }
    },
    storage: {
      local: {
        async get(requested) {
          return structuredClone(Object.fromEntries(requested.map(key => [key, local[key]])));
        },
        async set(values) { Object.assign(local, structuredClone(values)); }
      },
      sync: {
        QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512,
        async get() {
          reads++;
          if (failure === 'read') throw new Error('offline');
          return structuredClone(cloud);
        },
        async set(values) {
          writes++;
          if (failure === 'write') throw new Error('MAX_WRITE_OPERATIONS_PER_MINUTE');
          Object.assign(cloud, structuredClone(values));
        },
        async remove(requested) {
          for (const key of Array.isArray(requested) ? requested : [requested]) delete cloud[key];
        }
      }
    }
  };
  const context = vm.createContext({ chrome, crypto, TextEncoder, console: { debug() {} } });
  vm.runInContext(source, context);
  const sync = context.createRuleSync({ keys, canonicalRuleKey: canonical,
    normalizeRuleList: list => Array.isArray(list) ? list.filter(rule =>
      typeof rule === 'string' ? rule.length > 0 : typeof rule?.selector === 'string') : [] });
  return { local, sync, alarms, chrome,
    set failure(value) { failure = value; },
    get reads() { return reads; }, get writes() { return writes; },
    async edit(values) {
      await sync.saveChanges(structuredClone(local), Object.fromEntries(keys.map(key => [key, values[key] || {}])));
    },
    selectors(key = keys[0], url = scope) {
      return (local[key]?.[url] || []).map(rule => typeof rule === 'string' ? rule : rule.selector).sort();
    }
  };
}

let passed = 0;
async function test(name, run) {
  await run(); passed++; console.log(`PASS ${name}`);
}

await test('default on; migrate and merge rules from two devices; leave preferences local', async () => {
  const cloud = {};
  const a = device(cloud, { ...rules('#a'), toggleShortcutKey: 'q', pickerOpenCount: 10 });
  const b = device(cloud, rules('#b'));
  await a.sync.flush(); await b.sync.flush(); await a.sync.flush();
  assert.deepEqual(a.selectors(), ['#a', '#b']);
  assert.deepEqual(b.selectors(), ['#a', '#b']);
  assert.equal(a.local.toggleShortcutKey, 'q');
  assert(!JSON.stringify(cloud).includes('pickerOpenCount'));
  assert(!Object.hasOwn(cloud, 'ruleSyncEnabled'));
  const writes = a.writes;
  await a.sync.flush();
  assert.equal(a.writes, writes, 'unchanged state must not echo back into sync');
});

await test('concurrent independent additions and deletion converge without resurrection', async () => {
  const cloud = {};
  const a = device(cloud, rules('#old'));
  const b = device(cloud);
  await a.sync.flush(); await b.sync.flush();
  await a.edit(rules('#new-a'));
  await b.edit(rules('#old', '#new-b'));
  await b.sync.flush(); await a.sync.flush(); await b.sync.flush();
  assert.deepEqual(a.selectors(), ['#new-a', '#new-b']);
  assert.deepEqual(b.selectors(), a.selectors());
  const fresh = device(cloud, rules('#old'));
  await fresh.sync.flush();
  assert.deepEqual(fresh.selectors(), a.selectors(), 'legacy rules must not override cloud deletions');
  const tombstone = Object.values(cloud).find(record => !record.r);
  assert(tombstone && !JSON.stringify(tombstone).includes(scope), 'deletions keep only id/version');
});

await test('off performs no sync I/O; reenable merges edits and deletions made while off', async () => {
  const cloud = {};
  const a = device(cloud, rules('#old'));
  const b = device(cloud);
  await a.sync.flush(); await b.sync.flush();
  await b.sync.setEnabled(false);
  const reads = b.reads, writes = b.writes;
  await b.edit(rules('#offline'));
  await b.sync.flush();
  assert.equal(b.reads, reads); assert.equal(b.writes, writes);
  assert.deepEqual(b.selectors(), ['#offline']);
  await a.edit(rules('#old', '#online')); await a.sync.flush();
  await b.sync.setEnabled(true); await a.sync.flush();
  assert.deepEqual(b.selectors(), ['#offline', '#online']);
  assert.deepEqual(a.selectors(), b.selectors());
  const off = device({}, { ...rules('#local-only'), ruleSyncEnabled: false });
  await off.sync.flush(); await off.edit(rules('#changed'));
  assert.equal(off.reads, 0); assert.equal(off.writes, 0);
  assert.deepEqual(off.selectors(), ['#changed']);
});

await test('site rules and page-specific visible exceptions sync together', async () => {
  const cloud = {};
  const a = device(cloud, { ...rules('#page'), [keys[1]]: { 'https://example.test': ['#site'] },
    [keys[2]]: { [scope]: [{ selector: '#exception', fingerprint: { text: '恢复' } }] } });
  const b = device(cloud);
  await a.sync.flush(); await b.sync.flush();
  for (const key of keys) assert.deepEqual(b.local[key], a.local[key]);
  await a.edit(rules('#page')); await a.sync.flush(); await b.sync.flush();
  assert.deepEqual(b.local[keys[1]], {}); assert.deepEqual(b.local[keys[2]], {});
});

await test('offline write survives worker restart and retries; stale cloud cannot undo deletion', async () => {
  const cloud = {};
  const a = device(cloud, rules('#old'));
  await a.sync.flush();
  const stale = structuredClone(cloud);
  a.failure = 'write'; await a.edit(rules('#new')); await a.sync.flush();
  assert.deepEqual(a.selectors(), ['#new']); assert.equal(a.local.ruleSyncError, true);
  assert(a.alarms.has(a.sync.alarm));
  const restarted = device(cloud, a.local);
  await restarted.sync.flush();
  assert.equal(restarted.local.ruleSyncError, false);
  assert.equal(restarted.alarms.size, 0);
  Object.assign(cloud, stale);
  await restarted.sync.flush();
  assert.deepEqual(restarted.selectors(), ['#new']);
  const b = device(cloud); await b.sync.flush();
  assert.deepEqual(b.selectors(), ['#new']);
});

await test('read failure does not erase local rules, including edits before first successful sync', async () => {
  const cloud = {};
  const a = device(cloud, rules('#legacy'));
  a.failure = 'read'; await a.sync.flush(); await a.edit(rules('#fresh'));
  assert.deepEqual(a.selectors(), ['#fresh']);
  a.failure = ''; await a.sync.flush();
  const b = device(cloud, rules('#legacy')); await b.sync.flush();
  assert.deepEqual(b.selectors(), ['#fresh']);
});

await test('full sync storage evicts the oldest cloud rule, keeps local data, and manual sync reprioritizes a site', async () => {
  const oldScope = 'https://old.example/page';
  const newScope = 'https://new.example/page';
  const values = scopes => ({ [keys[0]]: Object.fromEntries(scopes) });
  const cloud = {};
  const a = device(cloud, values([[oldScope, [{ selector: '#old' }]]]));
  await a.sync.flush();
  const oldId = Object.keys(cloud)[0];
  await a.edit(values([
    [oldScope, [{ selector: '#old' }]],
    [newScope, [{ selector: '#new' }]]
  ]));
  const sizes = Object.entries(a.local.ruleSyncState.records).map(([id, record]) =>
    new TextEncoder().encode(id).length + new TextEncoder().encode(JSON.stringify(record)).length);
  a.chrome.storage.sync.QUOTA_BYTES = Math.max(...sizes);
  await a.sync.flush();
  assert.equal(a.local.ruleSyncError, false);
  assert.deepEqual(Object.keys(a.local.hiddenRulesByPage).sort(), [newScope, oldScope]);
  assert.deepEqual(Object.values(cloud).map(record => record.r?.[2]?.selector), ['#new']);
  await a.sync.syncNow([oldId]);
  assert.deepEqual(Object.values(cloud).map(record => record.r?.[2]?.selector), ['#old']);
  assert.deepEqual(Object.keys(a.local.hiddenRulesByPage).sort(), [newScope, oldScope]);
});

await test('sync item limit also keeps only the newest cloud rule', async () => {
  const cloud = {};
  const a = device(cloud, rules('#old'));
  await a.sync.flush();
  a.chrome.storage.sync.MAX_ITEMS = 1;
  await a.edit(rules('#old', '#new'));
  await a.sync.flush();
  assert.equal(a.local.ruleSyncError, false);
  assert.deepEqual(a.selectors(), ['#new', '#old']);
  assert.deepEqual(Object.values(cloud).map(record => record.r?.[2]?.selector), ['#new']);
});

await test('item-size failures preserve local data and remain retryable', async () => {
  const cloud = {};
  const a = device(cloud, rules('#saved'));
  await a.sync.flush();
  const before = structuredClone(cloud);
  const actual = a.chrome.storage.sync.QUOTA_BYTES_PER_ITEM;
  a.chrome.storage.sync.QUOTA_BYTES_PER_ITEM = 1;
  await a.edit(rules('#saved', '#pending')); await a.sync.flush();
  assert.equal(a.local.ruleSyncError, true);
  assert.deepEqual(a.selectors(), ['#pending', '#saved']);
  assert.deepEqual(cloud, before);
  a.chrome.storage.sync.QUOTA_BYTES_PER_ITEM = actual; await a.sync.flush();
  const b = device(cloud); await b.sync.flush();
  assert.deepEqual(b.selectors(), a.selectors());
});

await test('group metadata updates one canonical record and deletion keeps the same tombstone id', async () => {
  const cloud = {};
  const grouped = group => ({ [keys[0]]: { [scope]: [{ selector: '#grouped', group }] } });
  const a = device(cloud, grouped('first'));
  await a.sync.flush();
  const [id] = Object.keys(cloud);
  assert.equal(cloud[id].r[2].group, 'first');

  await a.edit(grouped('second'));
  await a.sync.flush();
  assert.deepEqual(Object.keys(cloud), [id]);
  assert.equal(cloud[id].r[2].group, 'second');
  const b = device(cloud); await b.sync.flush();
  assert.equal(b.local[keys[0]][scope][0].group, 'second');

  await a.edit({});
  await a.sync.flush();
  assert.deepEqual(Object.keys(cloud), [id]);
  assert.equal(Object.hasOwn(cloud[id], 'r'), false);
  await b.sync.flush();
  assert.deepEqual(b.selectors(), []);
});

await test('invalid remote entries are ignored; canonical rule hashing deduplicates legacy selectors', async () => {
  const cloud = {};
  const a = device(cloud, { [keys[0]]: { [scope]: ['#same', { selector: '#same' }] } });
  await a.sync.flush(); assert.equal(Object.keys(cloud).length, 1);
  cloud['ak-rule-v1:' + 'f'.repeat(64)] = { v: [10, 'broken'], r: [5, scope, { selector: '#bad' }] };
  const b = device(cloud); await b.sync.flush();
  assert.deepEqual(b.selectors(), ['#same']);
});

console.log(`${passed}/${passed} rule sync scenarios passed`);
