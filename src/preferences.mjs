import path from "node:path";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";

const defaults = { mascots: true, weekly: true, warnings: true, pauses: true, resets: false, unused: false, agents: false };
const file = (env) => path.join(perasHome(env), "preferences.json");
export function preferences(env) {
  let saved;
  try { saved = readJson(file(env)); } catch { /* Keep defaults if unreadable. */ }
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof saved?.[key] === "boolean" ? saved[key] : value]));
}
function saved(env) {
  try { const value = readJson(file(env)); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
export function setPreference(env, name, value) {
  if (!(name in defaults) || !["on", "off"].includes(value)) throw new Error("Choose mascots|weekly|warnings|pauses|resets|unused|agents and on|off.");
  // Fields this module doesn't list as on/off (weeklyStyle) are kept as written.
  const next = { ...preferences(env), [name]: value === "on" };
  writeJsonAtomic(file(env), { ...saved(env), ...next });
  return next;
}
/**
 * How the menu shows the week: "off" is `weekly: false`, the switch 0.3 reads;
 * otherwise "bar" (the default) or "text", saved beside it.
 */
export const WEEKLY_STYLES = ["bar", "text", "off"];
export function weeklyStyle(env) {
  if (!preferences(env).weekly) return "off";
  return saved(env).weeklyStyle === "text" ? "text" : "bar";
}
export function setWeeklyStyle(env, style) {
  if (!WEEKLY_STYLES.includes(style)) throw new Error("Choose bar, text or off.");
  const next = { ...saved(env), ...preferences(env), weekly: style !== "off", ...(style === "off" ? {} : { weeklyStyle: style }) };
  writeJsonAtomic(file(env), next);
  return weeklyStyle(env);
}
export function countdown(resetsAt, now) {
  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - now) / 60_000));
  if (!minutes) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  if (hours < 24) return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}
