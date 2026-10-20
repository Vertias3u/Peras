# Changelog

## 0.4.1 (2026-10-20)

- The downloaded Peras app now runs from where Peras installs it. 0.4.0 copied the download with macOS's quarantine flag, so macOS ran the app from a temporary copy: it couldn't open at login, and `peras menubar quit` and `peras update --app` couldn't find it. `peras menubar install --native --app` now installs an app Gatekeeper accepts without that flag; an app Gatekeeper doesn't accept keeps it, so macOS still checks it. Installed with 0.4.0? Run `peras update`, then `peras menubar install --native --app ~/.peras/native/Peras.app`. `peras doctor` says so when it's needed. The app itself is unchanged.

## 0.4.0 (2026-10-20)

- **The Peras app.** A menu bar app replaces the SwiftBar menu, so SwiftBar is no longer needed. It costs €4.99 at [peras.vertias.eu/app](https://peras.vertias.eu/app), signed and notarized; the CLI, hooks and SwiftBar menu stay free, and the app's source is MIT like the rest: `npm run build:app` builds it yourself. Open `Peras.zip`, then run `peras menubar install --native --app ~/Downloads/Peras.app`. It checks the app, opens it, and moves Peras's SwiftBar plugin aside only once the app answers; if anything fails, SwiftBar's menu stays as it was. Hooks and the CLI work as before, and `peras menubar install` still gives the SwiftBar menu. Built for macOS 13 or later on Apple silicon and Intel; tested on Apple silicon with the current macOS.
  - One row per agent: the 5-hour bar with its reset time, the weekly bar (or text) with a pace mark, and a ⏸ per running agent (right-click for Pause for 1 Hour). A reading older than five minutes fades.
  - Pause cards say why in plain words. A stop from a rule offers Resume for 1 Hour; your own pause offers plain Resume.
  - The menu bar shows the pixel pear, the pear with each agent's usage, or a pear that fills with usage: `peras menubar display pear|usage|fill`.
  - ⌃⌥P opens the menu from anywhere, including over full-screen apps. Pin it to keep it open as a panel.
  - Settings, a five-step setup with a protection test, and a weekly recap with a private-by-default share image: usage numbers go in only if you choose, and account details, folders and prompts never do.
  - Opens at login (switch it off in Settings). Works with the keyboard and VoiceOver.
  - Going back to 0.3: stop current agent sessions, run `peras menubar quit`, install 0.3.2, run `peras setup` and/or `peras codex setup` for the providers you use, then `peras menubar install`. Start new sessions with a new prompt and check `peras why`. Manual pauses and saved resumes stay compatible; 0.4 hook memory (prompt baselines, recent sessions and pace latches) is not exported. The app takes itself out of your login items.
- Updates to the app are included in the purchase. `peras update` stays on the installed app's 0.x line; `peras update --app ~/Downloads/Peras.app` moves the CLI and the app to a new line together. If a step fails, it restores the prior CLI, app and hook settings from a local backup rather than fetching an older version from npm. A downloaded app that fails its first open is kept aside for retry, with the previous app restored. The menu shows **Newer Peras App Available…** when a newer app is out for your line, and opens your purchase downloads.
- `peras agents on` tells Claude Code and Codex, beside your prompt, how much of both agents' usage is gone: on a session's first prompt, then only when usage crosses 50, 75, 90 or 100%, a reset is within 30 minutes, or the reading is over 15 minutes old. `peras usage` (or `--json`) prints the same on request.
- Usage reminders come from one place, the app or SwiftBar, never both.
- An Extra granted late in the day ends at midnight or at the weekly reset, whichever comes first.
- `peras setup` installs the new Peras completely before switching the hooks to it, so a hook always runs one whole version, even if setup is interrupted. Old copies are removed after a week once nothing uses them, and `peras doctor` shows which version the hooks run.

## 0.3.2 (2026-10-18)

- The menu uses about half the CPU it did. It was re-encoding every image in the menu eight times a second; images that don't change between frames are now encoded once, and a menu that hasn't changed (mascots paused or hidden) isn't sent to SwiftBar again. Walking mascots look exactly as before.
- When Codex answers in a shape Peras doesn't recognize, Peras now says so ("run peras update") instead of quietly treating it as a fresh reading with nothing in it, which kept an old reading on screen with no error. The menu backs off as for any failed read.
- Peras only reads Codex's own usage meter: a single-meter answer that names a different meter is no longer taken for Codex's.
- If Codex says the 5-hour window isn't there (some accounts have run weekly-only), Peras drops it instead of showing, and pausing on, the last reading until its old reset. Only a clear answer does that: when Codex leaves a window's length out, or sends a window Peras can't read, the last reading and any stop on it stay.

## 0.3.1 (2026-10-17)

- A `peras pause` or `peras resume` typed while a Claude Code or Codex hook was running could be undone: the hook wrote back the state it had read a moment earlier. Hooks now keep your pause and resume as they are on disk when they save. The window narrows to the moment of the write, not the whole hook run.
- The menu no longer starts `codex app-server` every second while Codex reads fail (offline, logged out, not installed). It retries after 2, 5, 15, 30, then every 60 seconds, still shows the last error, and one success ends the wait. Hooks keep trying on every call.
- Right after Codex's 5-hour window resets, the menu looks for the new one every second for 15 seconds, then every 5 and 15 seconds, settling back to once a minute after 5 minutes. A window started from ChatGPT shows up within about a second instead of up to a minute.

## 0.3.0 (2026-10-15)

- Workday pacing splits spendable weekly allowance above a chosen reserve across remaining working days. Today's share stays fixed while working, and switching back to a profile with the same plan keeps it; changing the reserve or working days recalculates it from current usage. On non-working days agents get no share, so the plan's warn, ask or pause applies all day. `peras pace 20` starts a Monday–Friday plan.
- Named allowance profiles save and restore rules, allowances and pacing without resetting usage counters or clearing pauses; switch them from the menu or editor.
- Temporary extra points extend a daily/pacing or project allowance for an hour or until midnight. Other stops remain in force; grants can be revoked and expire at weekly reset too.
- Session overview shows recent observed hook activity, folders and applicable rules, with no claim that the sessions are still running.
- Weekly comparison shows peak, last-known remaining and retained intervention changes between two completed observed weeks, with coverage caveats.
- Native macOS notification actions open Status, resume the original unchanged pause for an hour, or snooze an unused-allowance reminder. Actions work through the pear helper after the original sender exits.
- Daily allowances cap observed percentage-point increases in weekly usage and reset at local midnight. `peras budget daily 10 pause`; Codex supports the same commands.
- Project allowances conservatively estimate account increases while a session in that folder is active. `peras budget --here weekly 5 pause`. Parallel account use can count too; gaps can miss usage. Totals reset with the provider's week.
- **Rules and allowances…** in the pear menu, or `peras settings`, opens a private local editor for both agents' rules, schedules, folder overrides, allowances, and notification/display preferences.
- **Weekly review…** in the menu shows usage charts, last-observed remaining allowance, gaps, and retained intervention counts. `peras review` and `peras codex review` provide the same summaries in Terminal.
- When an agent pauses, the menu and Status show the other agent's remaining allowance if both of its windows have fresh readings and it has no active stop.
- Opt-in **Use it or lose it reminders** notify once per weekly window when at least 20% remains and reset is within 48 hours. `peras notify unused on` enables them.
- macOS notifications use a native Peras app with the pixel pear icon. `peras notify test` waits for the sender and reports permission or delivery errors. The universal helper is bundled; users need no compiler.

## 0.2.2 (2026-10-15)

- `peras menubar open` launches SwiftBar again after **Quit**; the quit message and `peras menubar` point to it.
- `peras menubar` typed in a terminal says whether the 🍐 is in the menu bar and lists its commands, instead of printing SwiftBar's raw input. Piped, and as `peras menubar show`, it still prints the raw menu.

## 0.2.1 (2026-10-15)

- The menu bar has **Quit** at the bottom, and `peras menubar quit` does the same. Protection keeps running without it.

## 0.2.0 (2026-10-15)

Peras now watches Codex as well as Claude Code, tells you where the week is headed, and can draw its lines more finely.

**Codex**

- `peras codex setup` adds the same hooks to Codex desktop and CLI. `codex status`, `why`, `set`, `pause`, `resume`, `history`, `doctor` and `remove` work as they do for Claude Code.
- Usage comes from ChatGPT plan windows, read through Codex's local app-server. Peras reads no login files or tokens. Codex's lines, history and pauses are kept apart from Claude Code's.
- Codex has no approval prompt, so an `ask` line there blocks tools until `peras codex resume`.
- `peras status` gives both agents the same panel (bars, resets, forecast, lines), with how old each reading is. A reading that failed to refresh is marked as such.

**Forecasts and finer lines**

- `peras status` says where each window is headed: "on pace for 75% at reset", "full by Thu 14:59".
- **Pace:** `peras set weekly pace pause` acts when the week is on track to run out before it resets. A new default line warns on that once the week is past 50%. The warning says when usage runs out ("weekly runs out Thu 18:26 at this pace"), not a percentage past 100.
- **Per prompt:** `peras set prompt 3 pause` stops one prompt from using more than 3% of the week.
- **Part of the day:** `peras set 01:00-08:00 weekly 50 pause`.
- **Per folder:** `peras set --here weekly 60 pause`. Status, `why` and `resume` include folder lines from sessions seen in the last seven days, wherever you run them.

**New commands**

- `peras why` explains each warning, ask or pause, and when it lifts.
- `peras history` shows past weeks: the peak, the lines crossed, and when it hit the wall.
- `peras pause [1h|18:00]` pauses by hand. `peras resume 1h` lifts a stop for a while instead of until the reset; another timed resume extends it.
- `peras status` shares the week's rise out by chat (an estimate, marked ≈).
- `peras notify` lists and switches desktop notifications: warnings, pauses, and resets.
- `peras test` tries pause and resume on a throwaway copy of the hooks, for both agents.
- `peras events` lists recent warnings, pauses, resumes and resets.
- `peras status` and `peras doctor` show whether each agent's hooks actually ran lately.
- `peras update` installs the newest published Peras and refreshes the hooks and menu bar you already set up. `peras update --check` only looks.

**Menu bar**

- `peras menubar install` puts Peras in the macOS menu bar through SwiftBar: the pixel pear, then each agent's 5-hour usage, red when it's paused. The menu has 5-hour and weekly bars and Pause and Resume for each agent. **Pear only** hides the icons and numbers.
- Each agent's mascot walks along its 5-hour bar and stands still while it's paused. Settings has the display toggles, notifications, the protection test, recent events, and an explainer page on how the limits work.

**Fixes**

- Zero-length and impossibly long pause or resume times are refused.
- Timed pauses and resumes end on a whole minute, so "until 03:05" means 03:05:00, not 03:05:54.
- A pause you started can always be lifted, even when usage can't be read.
- `peras remove` keeps the menu bar while Peras is still set up for another agent.

## 0.1.1 (2026-10-14)

- An `npx` install now says `npx peras-cli resume` when it pauses. It used to name a `peras` command that only existed while npx was running.

## 0.1.0 (2026-10-14)

First release. Peras reads the 5-hour and weekly usage that Claude Code passes to its status line, and at a line you set it warns, asks first, or pauses the agent until the window resets or you run `peras resume`.

- Defaults: weekly 75% warn, weekly 90% pause, 5-hour 95% warn.
- Commands: `setup`, `status`, `resume`, `set`, `doctor`, `remove`, `connect`.
- Local only, no dependencies, never touches your login. Setup chains in front of an existing status line, and `peras remove` restores your settings exactly.
