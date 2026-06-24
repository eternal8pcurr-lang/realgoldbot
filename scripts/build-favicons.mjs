// Build step: takes the RealGold symbol (a transparent gold emblem) and produces
// every favicon/app-icon format browsers ask for, written into public/ so
// Cloudflare Pages serves them at the site root.
//
// The symbol ships on a transparent background, which looks invisible/ugly on
// dark browser tabs — so we center it on a solid BLACK square with a little
// padding. Run by hand whenever you replace the source:  npm run favicons
// (Not part of `npm run deploy` — the generated files live in public/ and are
// deployed like any other static asset.)

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const SRC = join(root, "RealGold-Symbol-Clear (2).png");
const outDir = join(root, "public");

const BLACK = { r: 0, g: 0, b: 0, alpha: 1 };
// Fraction of the square the emblem occupies (rest is black margin).
const INNER = 0.86;

// Trim the transparent border off the source once, so our padding is consistent
// regardless of any empty space baked into the original export.
const trimmed = await sharp(SRC)
  .trim()
  .toBuffer();

// Render the emblem centered on a black square of the given pixel size.
async function renderIcon(size) {
  const inner = Math.round(size * INNER);
  const emblem = await sharp(trimmed)
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: BLACK },
  })
    .composite([{ input: emblem, gravity: "center" }])
    .png()
    .toBuffer();
}

const pngTargets = [
  { name: "favicon-16x16.png", size: 16 },
  { name: "favicon-32x32.png", size: 32 },
  { name: "favicon-48x48.png", size: 48 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];

const pngBySize = new Map();
for (const t of pngTargets) {
  const buf = await renderIcon(t.size);
  writeFileSync(join(outDir, t.name), buf);
  pngBySize.set(t.size, buf);
}

// Build a classic favicon.ico containing PNG-encoded 16/32/48 entries.
// ICO supports PNG payloads; all current browsers (and IE11+) read them.
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4); // image count

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  const dirEntries = entries.map((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0); // width
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette count
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, o + 8); // size of image data
    dir.writeUInt32LE(offset, o + 12); // offset of image data
    offset += e.data.length;
    return e.data;
  });
  return Buffer.concat([header, dir, ...dirEntries]);
}

const ico = buildIco([
  { size: 16, data: pngBySize.get(16) },
  { size: 32, data: pngBySize.get(32) },
  { size: 48, data: pngBySize.get(48) },
]);
writeFileSync(join(outDir, "favicon.ico"), ico);

console.log(
  `Favicons built from RealGold-Symbol-Clear (2).png (black background) -> public/: ` +
    `${pngTargets.map((t) => t.name).join(", ")}, favicon.ico (16/32/48)`
);
