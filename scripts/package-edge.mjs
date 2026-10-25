import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const sourceRoot = join(root, "edge");
const manifest = JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8"));
const locales = (await readdir(join(sourceRoot, "_locales"))).sort();
const baseline = JSON.parse(await readFile(join(sourceRoot, "_locales", "en", "messages.json"), "utf8"));
const files = [
  "manifest.json", "background.js", "content.js", "rules.js", "sync.js", "shortcuts.js",
  "options.html", "options.js", "options.css",
  ...["16", "32", "48", "128"].map(size => `icons/icon-${size}.png`),
  "images/wechat-pay.png", "images/wise-pay.png",
  ...locales.map(locale => `_locales/${locale}/messages.json`)
];

for (const locale of locales) {
  const messages = JSON.parse(await readFile(join(sourceRoot, "_locales", locale, "messages.json"), "utf8"));
  if (JSON.stringify(Object.keys(messages).sort()) !== JSON.stringify(Object.keys(baseline).sort())) {
    throw new Error(`Incomplete locale: ${locale}`);
  }
  for (const [key, { message }] of Object.entries(messages)) {
    if (!message || /[<>]/.test(message)) throw new Error(`Invalid message: ${locale}/${key}`);
    if (JSON.stringify(message.match(/\$\d/g)) !== JSON.stringify(baseline[key].message.match(/\$\d/g))) {
      throw new Error(`Placeholder mismatch: ${locale}/${key}`);
    }
  }
  if (messages.description.message.length > 132 || messages.extName.message.length > 75) {
    throw new Error(`Metadata too long: ${locale}`);
  }
  if (!messages.syncNote.message.includes("Microsoft Edge")) {
    throw new Error(`Missing Edge sync branding: ${locale}`);
  }
}
for (const file of files) await readFile(join(sourceRoot, file));
for (const file of ["LICENSE", "NOTICE"]) await readFile(join(root, file));
const fallback = await readFile(join(sourceRoot, "options.html"), "utf8");
if (!fallback.includes("使用 Microsoft Edge 同步功能")) throw new Error("Missing Edge sync fallback text");

await mkdir(join(sourceRoot, "dist"), { recursive: true });
const outputName = `annoy-killer-edge-${manifest.version}.zip`;
const output = join(sourceRoot, "dist", outputName);
await rm(output, { force: true });
for (const [cwd, entries] of [[sourceRoot, files], [root, ["LICENSE", "NOTICE"]]]) {
  const zip = spawnSync("/usr/bin/zip", ["-q", "-X", output, ...entries], { cwd, stdio: "inherit" });
  if (zip.status !== 0) throw new Error("Edge packaging failed");
}

for (const entry of await readdir(join(sourceRoot, "dist"), { withFileTypes: true })) {
  if (entry.isFile() && /^annoy-killer-edge-\d+(?:\.\d+){1,3}\.zip$/.test(entry.name) &&
      entry.name !== outputName) {
    await rm(join(sourceRoot, "dist", entry.name));
  }
}
console.log(`${output}\n${locales.length} complete Edge locales; ${files.length} runtime files.`);
