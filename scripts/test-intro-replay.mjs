import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const channel = process.argv.find(argument => argument.startsWith('--channel='))?.slice('--channel='.length) || 'chrome';
assert(['chrome', 'edge'].includes(channel), 'channel must be chrome or edge');

const rules = { 'https://example.test/': [{ selector: '#promotion' }] };
const storage = { shortcutGuideSeen: true, overlayPickerGuideReplay: true,
  hiddenRulesByPage: structuredClone(rules) };
let installed;
const messages = [];
const menus = [];
const chrome = {
  i18n: { getMessage(key) { return key === 'options' ? '选项' : key; } },
  alarms: { onAlarm: { addListener() {} }, async clear() {} },
  action: { onClicked: { addListener() {} } },
  contextMenus: { removeAll(callback) { menus.length = 0; callback(); },
    create(item) { menus.push(item); }, onClicked: { addListener() {} } },
  runtime: {
    onStartup: { addListener() {} },
    onInstalled: { addListener(callback) { installed = callback; } },
    onMessage: { addListener(callback) { messages.push(callback); } }
  },
  storage: { onChanged: { addListener() {} }, local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .map(key => [key, structuredClone(storage[key])]));
    },
    async set(values) { Object.assign(storage, structuredClone(values)); }
  } }
};
storage.ruleSyncEnabled = false;
const context = vm.createContext({ chrome, console, crypto, TextEncoder });
const syncSource = await readFile(new URL(`../${channel}/sync.js`, import.meta.url), 'utf8');
context.importScripts = () => vm.runInContext(syncSource, context);
vm.runInContext(await readFile(new URL(`../${channel}/background.js`, import.meta.url), 'utf8'), context);
const claim = () => new Promise(resolve => {
  const handled = messages.some(callback => callback(
    { type: 'annoy-killer:claim-shortcut-guide' }, {}, resolve) === true);
  assert(handled);
});
installed({ reason: 'update' });
assert.equal(menus.find(item => item.id === 'annoy-killer-shortcuts').title, '选项');
assert.equal((await claim()).show, true, 'First open after this update replays guidance');
assert.deepEqual(storage.hiddenRulesByPage, rules, 'Existing hiding rules remain untouched');
assert.equal((await claim()).show, false, 'Second open does not replay guidance');
installed({ reason: 'update' });
assert.equal((await claim()).show, false, 'Later reloads/updates do not repeatedly reset guidance');
assert.deepEqual(storage.hiddenRulesByPage, rules);
console.log('PASS one-time upgrade guidance replay; hidden rules preserved');
