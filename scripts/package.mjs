import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const sourceRoot = `${root}/chrome`;
const manifest = JSON.parse(await readFile(`${sourceRoot}/manifest.json`, 'utf8'));
const locales = (await readdir(`${sourceRoot}/_locales`)).sort();
const baseline = JSON.parse(await readFile(`${sourceRoot}/_locales/en/messages.json`, 'utf8'));
for (const locale of locales) {
  const messages = JSON.parse(await readFile(`${sourceRoot}/_locales/${locale}/messages.json`, 'utf8'));
  if (JSON.stringify(Object.keys(messages).sort()) !== JSON.stringify(Object.keys(baseline).sort())) throw new Error(`Incomplete locale: ${locale}`);
  for (const [key, {message}] of Object.entries(messages)) {
    if (!message || /[<>]/.test(message)) throw new Error(`Invalid message: ${locale}/${key}`);
    if (JSON.stringify(message.match(/\$\d/g)) !== JSON.stringify(baseline[key].message.match(/\$\d/g))) throw new Error(`Placeholder mismatch: ${locale}/${key}`);
  }
  if (messages.description.message.length > 132 || messages.extName.message.length > 75) throw new Error(`Metadata too long: ${locale}`);
}
const files = ['manifest.json', 'background.js', 'content.js', 'rules.js', 'sync.js', 'shortcuts.js', 'options.html', 'options.js', 'options.css',
  ...['16', '32', '48', '128'].map(size => `icons/icon-${size}.png`),
  'images/wechat-pay.png', 'images/wise-pay.png', ...locales.map(locale => `_locales/${locale}/messages.json`)];
for (const file of files) await readFile(`${sourceRoot}/${file}`);
await mkdir(`${sourceRoot}/dist`, {recursive:true});
const output = `dist/annoy-killer-chrome-${manifest.version}.zip`;
const zip = spawnSync('/usr/bin/zip', ['-q', '-X', output, ...files], {cwd:sourceRoot, stdio:'inherit'});
if (zip.status !== 0) throw new Error('Packaging failed');
for (const entry of await readdir(`${sourceRoot}/dist`, {withFileTypes:true})) {
  if (entry.isFile() && /^annoy-killer-chrome-\d+(?:\.\d+){1,3}\.zip$/.test(entry.name) &&
      entry.name !== `annoy-killer-chrome-${manifest.version}.zip`) {
    await rm(`${sourceRoot}/dist/${entry.name}`);
  }
}
console.log(`${sourceRoot}/${output}\n${locales.length} complete Chrome locales; ${files.length} runtime files.`);
