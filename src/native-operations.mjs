// What a native command does. Each operation calls the same domain function the
// CLI's does, never a CLI handler: those print to stdout (the bridge's wire) and
// judge the folder the process started in.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dismiss, linkURL } from "./discovery.mjs";
import { APP_DOWNLOAD_URL } from "./native-app.mjs";
import { PolicyError, claudeCodeVersion, setFailurePolicy } from "./failure-policy.mjs";
import { setDisplayMode, setDisplayStyle } from "./menubar.mjs";
import { APP_UPDATE, NOT_READY, dismissTokenBody, offerBlocked, offeredActions, settingsOffers, settingsTokenBody, tokenBody } from "./native-protocol.mjs";
import { grantExtra, useProfile } from "./planning.mjs";
import { setPreference, setWeeklyStyle } from "./preferences.mjs";
import { snapshot } from "./providers.mjs";
import { commitResume, pauseNow } from "./store.mjs";

const HOUR = 3600_000;
const sameParams = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
const changed = { ok: false, code: "state_changed", message: "That changed since you saw it. Review it again." };

/** Opens a page Peras wrote itself, or one from its fixed list of links: never an address from a command. */
const openLocal = async (url) => promisify(execFile)(process.platform === "darwin" ? "/usr/bin/open" : "xdg-open", [url]);

// Each runs the exact offer whose token the app sent, read a moment ago.
const providerHandlers = {
  "profile.use": (s, offer, now) => { useProfile(s.env, offer.profile, now); },
  // The version is checked at the click, once: the bridge never runs `claude --version` on its own.
  "failurePolicy.set": (s, offer, now, { claudeVersion }) => { setFailurePolicy(s.env, offer.params.policy, { version: offer.params.policy === "strict" ? claudeVersion(s.env) : undefined }); },
  pause: (s, offer, now) => { pauseNow(s.env, { now, until: offer.params.duration ? now + HOUR : null, reviewed: offer.impact.manual }); },
  resume: (s, offer, now) => { commitResume(s.env, offer.plan, { now, forMs: offer.params.duration ? HOUR : null, reviewed: true }); },
  "extra.daily": (s, offer, now) => { grantExtra(s.env, { period: "daily", points: offer.params.points, until: offer.expiresAtMs }, now, offer.weekly); },
};

// Fixed screens, fixed links and the self-test: nothing to review, nothing from the command but its name and a listed id.
const fixedHandlers = {
  "link.open": async (env, now, { openURL }, command) => { await openURL(command.params.id === APP_UPDATE ? APP_DOWNLOAD_URL : linkURL(command.params.id)); },
  "settings.open": async (env, now, { openURL }) => {
    const { openSettings } = await import("./settings-server.mjs");
    await openSettings(env, { openURL });
  },
  "status.open": async (env, now, { openURL }) => {
    const { writeStatusPage } = await import("./status-page.mjs");
    const snapshots = await Promise.all(["claude", "codex"].map((provider) => snapshot(env, now, { provider, cwd: null })));
    await openURL(pathToFileURL(writeStatusPage(env, snapshots, now)).href);
  },
  "protection.test": async (env, now) => {
    const { runProtectionTest } = await import("./protection-test.mjs");
    if (!runProtectionTest(env, now).passed) return { ok: false, code: "test_failed", message: "The self-test failed. The status page has the details." };
  },
};

const settingsHandlers = {
  "preference.set": (env, c) => { setPreference(env, c.params.name, c.params.value ? "on" : "off"); },
  "display.set": (env, c) => { setDisplayMode(env, c.params.value); },
  "weeklyStyle.set": (env, c) => { setWeeklyStyle(env, c.params.value); },
  "displayStyle.set": (env, c) => { setDisplayStyle(env, c.params.value); },
};

/**
 * Runs one parsed command. A provider operation re-reads that provider, rebuilds
 * what it offers and runs only if the app's token signs the same impact now.
 * Returns { ok, code, message }; messages are fixed text, never a thrown error's,
 * which can carry a path.
 */
export async function runOperation(env, command, { now = Date.now(), signer, notReady = NOT_READY, openURL = openLocal, claudeVersion = claudeCodeVersion } = {}) {
  if (notReady.has(command.op)) return { ok: false, code: "not_ready", message: "This runtime cannot do that from the app yet." };
  try {
    if (command.op === "protection.test") {
      // Offered per provider, with the same disabled reason the snapshot showed.
      const s = await snapshot(env, now, { provider: command.provider, cwd: null });
      const offer = offeredActions(s, now).find((o) => o.op === command.op);
      const blocked = offer ? offerBlocked(s, offer, notReady) : "not_ready";
      if (blocked) return { ok: false, code: blocked, message: "That is not available right now." };
    }
    if (fixedHandlers[command.op]) return (await fixedHandlers[command.op](env, now, { openURL }, command)) ?? { ok: true };
    if (command.op === "discovery.dismiss") {
      if (!signer.verify(command.actionToken, dismissTokenBody(command.params.id), now)) return changed;
      dismiss(env, command.params.id, now);
      return { ok: true };
    }
    if (!command.provider) {
      // Settings run only as offered: the one change from today's value, under its token.
      const offer = settingsOffers(env).find((o) => o.op === command.op && sameParams(o.params, command.params));
      if (!offer || !signer.verify(command.actionToken, settingsTokenBody(offer), now)) return changed;
      settingsHandlers[command.op](env, command);
      return { ok: true };
    }
    const s = await snapshot(env, now, { provider: command.provider, cwd: null });
    const offer = offeredActions(s, now).find((o) => o.op === command.op && sameParams(o.params, command.params));
    if (!offer) return changed;
    const blocked = offerBlocked(s, offer, notReady);
    if (blocked) return { ok: false, code: blocked, message: "That is not available right now." };
    if (!signer.verify(command.actionToken, tokenBody(s.provider, offer), now)) return changed;
    providerHandlers[command.op](s, offer, now, { claudeVersion });
    return { ok: true };
  } catch (error) {
    // Strict mode refused: the version is too old or unreadable. Said in fixed words, so nothing is written.
    if (error instanceof PolicyError) return { ok: false, code: error.code, message: error.code === "requires_upgrade" ? "Strict mode needs a newer Claude Code." : "Peras could not turn strict mode on." };
    // Someone changed your pause or resume while this was being saved, or is saving one now.
    if (error?.code === "state_changed") return changed;
    if (error?.code === "busy") return { ok: false, code: "busy", message: "Another change is being saved. Try again in a moment." };
    return { ok: false, code: "failed", message: "Peras could not save that change." };
  }
}
