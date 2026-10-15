# Changelog

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
