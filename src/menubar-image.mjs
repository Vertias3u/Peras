import fs from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { mascotFrame } from "./mascots.mjs";

// A bundled Retina glyph atlas keeps rendering local and dependency-free.
const atlas = JSON.parse(fs.readFileSync(new URL("./menubar-atlas.json", import.meta.url), "utf8"));
const sprites = Object.fromEntries(Object.entries(atlas.sprites).map(([name, s]) => [name, { ...s, pixels: inflateSync(Buffer.from(s.data, "base64")) }]));

// The pixel pear from the logo (site/logo.svg), drawn here rather than taken
// from an emoji font. Each pear pixel is 2×2, so it stays sharp on Retina.
const PEAR = [
  ["body", [[7, 3, 3, 1], [6, 4, 5, 2], [5, 6, 7, 1], [4, 7, 9, 1], [3, 8, 11, 4], [4, 12, 9, 1], [5, 13, 7, 1]]],
  ["shine", [[5, 8, 1, 2]]],
  ["stem", [[8, 1, 1, 2]]],
  ["leaf", [[9, 1, 2, 1], [10, 0, 2, 1]]],
];
// Lime on a dark bar; the darker greens of site/logo-light.svg on a light one.
const PEAR_COLORS = {
  dark: { body: [183, 243, 74], shine: [228, 251, 184], stem: [237, 241, 233], leaf: [127, 169, 51] },
  light: { body: [127, 169, 51], shine: [183, 243, 74], stem: [29, 35, 30], leaf: [78, 107, 18] },
};
function pearSprite(colors, scale = 2, left = 3, top = 6) {
  const pixels = Buffer.alloc(atlas.width * atlas.height * 4);
  for (const [part, rects] of PEAR) {
    for (const [x, y, w, h] of rects) {
      for (let py = (top / scale + y) * scale; py < (top / scale + y + h) * scale; py++) {
        for (let px = (x - left) * scale; px < (x - left + w) * scale; px++) pixels.set([...colors[part], 255], (py * atlas.width + px) * 4);
      }
    }
  }
  return { advance: 11 * scale, pixels };
}
sprites["pear-dark"] = pearSprite(PEAR_COLORS.dark);
sprites["pear-light"] = pearSprite(PEAR_COLORS.light);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const header = Buffer.alloc(4), footer = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, footer]);
}
function png(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A 2x PNG showing pear, provider icon, and each provider's 5-hour percentage. */
export function titleImage(readings, { dark = true } = {}) {
  const foreground = dark ? [237, 241, 233] : [28, 30, 27];
  const glyphs = [{ name: dark ? "pear-dark" : "pear-light", gap: 10 }];
  for (const r of readings) {
    glyphs.push({ name: r.provider === "codex" ? "codex" : "claude", gap: 6, color: r.provider === "codex" ? foreground : null });
    const text = Number.isFinite(r.pct) ? `${Math.round(Math.max(0, Math.min(100, r.pct)))}%` : "–";
    const color = r.stopped ? [229, 72, 77] : foreground;
    for (const name of text) glyphs.push({ name, gap: 0, color });
    glyphs[glyphs.length - 1].gap = 14;
  }
  glyphs[glyphs.length - 1].gap = 0;
  const width = glyphs.reduce((n, g) => n + sprites[g.name].advance + g.gap, 0);
  const pixels = Buffer.alloc(width * atlas.height * 4);
  let x = 0;
  for (const g of glyphs) {
    const s = sprites[g.name];
    for (let y = 0; y < atlas.height; y++) {
      for (let col = 0; col < Math.min(s.advance, atlas.width); col++) {
        const from = (y * atlas.width + col) * 4, to = (y * width + x + col) * 4;
        if (!s.pixels[from + 3]) continue;
        for (let c = 0; c < 3; c++) pixels[to + c] = g.color?.[c] ?? s.pixels[from + c];
        pixels[to + 3] = s.pixels[from + 3];
      }
    }
    x += s.advance + g.gap;
  }
  return { width: width / 2, height: atlas.height / 2, png: png(width, atlas.height, pixels) };
}

/** A rounded usage track, with a clear lane above it for a future walking mascot. */
export function providerLabelImage(provider) {
  const text = provider === "codex" ? "Codex" : "Claude";
  const width = [...text].reduce((sum, char) => sum + sprites[char].advance, 0);
  const pixels = Buffer.alloc(width * atlas.height * 4);
  let left = 0;
  for (const char of text) {
    const glyph = sprites[char];
    for (let y = 0; y < atlas.height; y++) for (let x = 0; x < glyph.advance; x++) {
      const from = (y * atlas.width + x) * 4, to = (y * width + left + x) * 4;
      pixels.set([255, 255, 255, glyph.pixels[from + 3]], to);
    }
    left += glyph.advance;
  }
  return { width: width / 2, height: atlas.height / 2, png: png(width, atlas.height, pixels) };
}

export function progressImage(pct, { tone = "green", dark = true, mascot = null } = {}) {
  const width = 192, height = 40, top = 28, trackHeight = 8, radius = 4;
  const background = dark ? [65, 68, 65] : [207, 212, 207];
  const fills = { claude: [217, 119, 87], codex: [109, 154, 250], green: dark ? [183, 243, 74] : [78, 107, 18], yellow: [245, 165, 36], red: [229, 72, 77] };
  const fill = fills[tone] ?? fills.green;
  const fraction = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) / 100 : 0;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = top; y < top + trackHeight; y++) {
    for (let x = 0; x < width; x++) {
      // Supersample the ends so the 2x bitmap has smooth rounded corners.
      let coverage = 0, used = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
        const xx = x + dx, yy = y + dy;
        const cx = Math.max(radius, Math.min(width - radius, xx));
        const cy = top + radius;
        if ((xx - cx) ** 2 + (yy - cy) ** 2 > radius ** 2) continue;
        coverage++;
        if (xx < fraction * width) used++;
      }
      if (!coverage) continue;
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round((fill[c] * used + background[c] * (coverage - used)) / coverage);
      pixels[at + 3] = Math.round(255 * coverage / 4);
    }
  }
  const actor = mascot && mascotFrame(mascot.provider, mascot.timeMs, { paused: mascot.paused, trackWidth: width });
  if (actor) {
    for (let y = 0; y < actor.height; y++) for (let x = 0; x < actor.width; x++) {
      const sx = actor.flip ? actor.width - 1 - x : x;
      const from = (y * actor.width + sx) * 4, to = (y * width + actor.x + x) * 4;
      for (let c = 0; c < 4; c++) pixels[to + c] = actor.pixels[from + c];
    }
  }
  return { width: width / 2, height: height / 2, png: png(width, height, pixels) };
}
