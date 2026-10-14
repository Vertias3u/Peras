import fs from "node:fs";
import { inflateSync } from "node:zlib";

const atlas = JSON.parse(fs.readFileSync(new URL("./mascot-atlas.json", import.meta.url), "utf8"));
const decode = (f) => ({ ms: f.ms, pixels: inflateSync(Buffer.from(f.data, "base64")) });
const pets = Object.fromEntries(["claude", "codex"].map((name) => {
  const p = atlas[name];
  return [name, { right: p.right.map(decode), left: p.left?.map(decode), idle: decode(p.idle), mirrorLeft: p.mirrorLeft }];
}));

/** Mascot position is decorative; usage remains the track's fill fraction. */
export function mascotFrame(provider, timeMs = 0, { paused = false, trackWidth = 192 } = {}) {
  const pet = pets[provider];
  if (!pet) return null;
  const travel = trackWidth - atlas.width;
  const phase = ((timeMs % 10000) + 10000) % 10000 / 5000;
  const left = phase >= 1;
  const position = paused ? 0.5 : left ? 2 - phase : phase;
  const frames = left && pet.left ? pet.left : pet.right;
  let frame = pet.idle;
  if (!paused) {
    const duration = frames.reduce((sum, f) => sum + f.ms, 0);
    let t = ((timeMs % duration) + duration) % duration;
    frame = frames.at(-1);
    for (const f of frames) { if (t < f.ms) { frame = f; break; } t -= f.ms; }
  }
  return { width: atlas.width, height: atlas.height, x: Math.round(travel * position), flip: !paused && left && Boolean(pet.mirrorLeft), pixels: frame.pixels };
}
