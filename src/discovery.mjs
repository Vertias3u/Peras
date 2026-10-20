// PassControl links for the app: a fixed list, one suggestion at a time, and a
// record of the ones dismissed. Nothing here makes a request; a page opens only
// when someone clicks, and its address carries a fixed tag, never anything local.
import path from "node:path";
import { perasHome, readJson, writeJsonAtomic } from "./store.mjs";

const SITE = "https://passcontrol.vertias.eu";

// Only pages checked live. Session control and approvals have no page of their
// own yet: they go to the nearest one until PassControl publishes one.
const PAGES = {
  passcontrol: "/",
  session_control: "/learn/ai-agent-access-revocation",
  approvals: "/",
  central_controls: "/",
  credentials: "/learn/ai-agent-credential-gateway",
  api_budgets: "/learn/ai-agent-budget-controls",
};

// Each claim is one `peras connect` already makes: the app never promises more than the CLI.
export const LINKS = [
  { id: "passcontrol", title: "PassControl, by the maker of Peras", detail: "Controls beyond usage limits: free beta, optional, nothing connects on its own." },
  { id: "session_control", title: "Stop one agent, not all of them", detail: "Stop any agent from your phone's browser, mid-task, on a Pro or Max login too." },
  { id: "approvals", title: "Approve risky tools from your phone", detail: "A Telegram ping, and Approve or Deny from there, before a risky tool runs." },
  { id: "central_controls", title: "Every agent, every machine, one place", detail: "Stop, cap and get alerts for agents wherever they run." },
  { id: "credentials", title: "Keep API keys out of the agent", detail: "API keys and bot tokens kept in a vault, never in the agent." },
  { id: "api_budgets", title: "Cap API spend per agent", detail: "Daily or monthly caps per agent, for API keys. Separate from your plan's usage." },
];
export const LINK_IDS = LINKS.map((l) => l.id);
export const SUGGESTION_IDS = ["intro", "session_control", "approvals"];

/** The page for a link id, tagged with where in Peras it was clicked. */
export function linkURL(id) {
  if (!Object.hasOwn(PAGES, id)) throw new Error("Unknown link.");
  return `${SITE}${PAGES[id]}?ref=peras&ctx=${id}`;
}

const file = (env) => path.join(perasHome(env), "discovery.json");
export function dismissed(env) {
  let saved;
  try { saved = readJson(file(env)); } catch { /* unreadable: nothing dismissed, the next dismissal rewrites it */ }
  return saved?.dismissed && typeof saved.dismissed === "object" ? saved.dismissed : {};
}
export function dismiss(env, id, now) {
  if (!SUGGESTION_IDS.includes(id)) throw new Error("Unknown suggestion.");
  writeJsonAtomic(file(env), { dismissed: { ...dismissed(env), [id]: now } });
}

/**
 * The one suggestion worth showing now, read from the providers the snapshot
 * already carries: an introduction once a protection test has passed, then a
 * hint that fits what the user is doing. A dismissed one never comes back.
 */
export function suggestion(env, providers) {
  const gone = dismissed(env);
  const protectedNow = providers.some((p) => p.setup?.hooks === "configured" && p.setup.testPassedAtMs !== null);
  if (!protectedNow) return null;
  const relevant = {
    intro: true,
    session_control: providers.some((p) => p.reasons?.some((r) => r.code === "manual_pause")),
    approvals: providers.some((p) => p.thresholds?.some((t) => t.action === "ask")),
  };
  const id = SUGGESTION_IDS.find((s) => relevant[s] && !gone[s]);
  if (!id) return null;
  const link = id === "intro" ? "passcontrol" : id;
  const { title, detail } = LINKS.find((l) => l.id === link);
  return { id, link, title, detail };
}
