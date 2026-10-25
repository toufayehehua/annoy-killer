import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const sharp = require(process.env.ANNOY_KILLER_NODE_MODULES
  ? join(process.env.ANNOY_KILLER_NODE_MODULES, "sharp")
  : "sharp");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "chrome/design/brand-v1-connected/app-icon.png");
const source = await readFile(sourcePath);
const { data: rgb, info } = await sharp(source).removeAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
assert.equal(channels, 3);
assert.equal(width, height, "Approved source must be square");

// Asset export only: remove the white presentation canvas outside the black
// tile. Flooding from the canvas edge keeps enclosed white face details intact.
const count = width * height;
const exterior = new Uint8Array(count);
const queue = new Uint32Array(count);
let head = 0;
let tail = 0;
function enqueue(index) {
  if (exterior[index]) return;
  const offset = index * 3;
  const min = Math.min(rgb[offset], rgb[offset + 1], rgb[offset + 2]);
  const max = Math.max(rgb[offset], rgb[offset + 1], rgb[offset + 2]);
  if (min <= 10 || max - min > 12) return;
  exterior[index] = 1;
  queue[tail++] = index;
}
for (let x = 0; x < width; x++) {
  enqueue(x);
  enqueue((height - 1) * width + x);
}
for (let y = 0; y < height; y++) {
  enqueue(y * width);
  enqueue(y * width + width - 1);
}
while (head < tail) {
  const index = queue[head++];
  const x = index % width;
  if (x > 0) enqueue(index - 1);
  if (x < width - 1) enqueue(index + 1);
  if (index >= width) enqueue(index - width);
  if (index < count - width) enqueue(index + width);
}

const rgba = Buffer.alloc(count * 4);
let minX = width;
let minY = height;
let maxX = -1;
let maxY = -1;
let preserved = 0;
for (let index = 0; index < count; index++) {
  const from = index * 3;
  const to = index * 4;
  if (exterior[index]) {
    // Unmatte antialiased black tile edges from the white presentation canvas.
    const light = Math.round((rgb[from] + rgb[from + 1] + rgb[from + 2]) / 3);
    rgba[to + 3] = light >= 245 ? 0 : 255 - light;
  } else {
    rgba[to] = rgb[from];
    rgba[to + 1] = rgb[from + 1];
    rgba[to + 2] = rgb[from + 2];
    rgba[to + 3] = 255;
    preserved++;
  }
  if (rgba[to + 3]) {
    minX = Math.min(minX, index % width);
    minY = Math.min(minY, Math.floor(index / width));
    maxX = Math.max(maxX, index % width);
    maxY = Math.max(maxY, Math.floor(index / width));
  }
}
assert(preserved > count * 0.5, "Exterior removal unexpectedly reached the icon");
assert(minX > 0 && minY > 0 && maxX < width - 1 && maxY < height - 1,
  "The presentation background must be removed on all four sides");
const crop = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
assert(Math.abs(crop.width - crop.height) < 20, "Expected a near-square app tile");
const cropped = await sharp(rgba, { raw: { width, height, channels: 4 } })
  .extract(crop).png().toBuffer();

// A true circular black background, not a rounded-square tile. Uniformly scale
// the approved artwork so the diagonal slash endpoints stay inside the circle.
const masterSize = 1024;
const artworkSize = 870;
const artworkOffset = (masterSize - artworkSize) / 2;
const artwork = await sharp(cropped).resize(artworkSize, artworkSize, {
  fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3"
}).png().toBuffer();
const circleMask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="512" cy="512" r="512" fill="white"/></svg>`
);
const circular = await sharp({ create: {
  width: masterSize, height: masterSize, channels: 4,
  background: { r: 0, g: 0, b: 0, alpha: 1 }
}}).composite([
  { input: artwork, left: artworkOffset, top: artworkOffset },
  { input: circleMask, blend: "dest-in" }
]).png().toBuffer();
await Promise.all(["chrome", "edge"].map(channel =>
  sharp(circular).toFile(join(root, channel, "design/brand-v1-connected/app-icon-circle.png"))));

for (const size of [16, 32, 48, 128]) {
  for (const channel of ["chrome", "edge"]) {
    const output = join(root, channel, `icons/icon-${size}.png`);
    await sharp(circular).resize(size, size, {
      fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3"
    }).png({ compressionLevel: 9 }).toFile(output);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    assert.equal(metadata.hasAlpha, true);
    const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
    for (const index of [0, size - 1, size * (size - 1), size * size - 1]) {
      assert.equal(pixels[index * 4 + 3], 0, `${channel} ${size}px corner must be transparent`);
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const alpha = pixels[(y * size + x) * 4 + 3];
        if (distance > size / 2 + 1.5) assert(alpha <= 8, "Pixels outside the circle must be transparent apart from resampling ringing");
        if (distance < size / 2 - 1.5) assert(alpha >= 248, "Circle interior must be opaque apart from resampling ringing");
      }
    }
  }
}
console.log(JSON.stringify({
  source: sourcePath,
  sha256: createHash("sha256").update(source).digest("hex"),
  crop,
  preservedInteriorPixels: preserved,
  shape: "circle",
  sizes: [16, 32, 48, 128]
}, null, 2));
