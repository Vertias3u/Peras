import path from "node:path";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";

const defaults = { mascots: true, weekly: true, warnings: true, pauses: true, resets: false };
const file = (env) => path.join(perasHome(env), "preferences.json");
export function preferences(env) {
  let saved;
  try { saved = readJson(file(env)); } catch { /* Keep defaults if unreadable. */ }
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof saved?.[key] === "boolean" ? saved[key] : value]));
}
export function setPreference(env, name, value) {
  if (!(name in defaults) || !["on", "off"].includes(value)) throw new Error("Choose mascots|weekly|warnings|pauses|resets and on|off.");
  const next = { ...preferences(env), [name]: value === "on" };
  writeJsonAtomic(file(env), next);
  return next;
}
export function countdown(resetsAt, now) {
  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - now) / 60_000));
  if (!minutes) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  if (hours < 24) return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}
