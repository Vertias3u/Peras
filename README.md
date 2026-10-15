<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Vertias3u/Peras/main/site/logo.svg">
    <img src="https://raw.githubusercontent.com/Vertias3u/Peras/main/site/logo-light.svg" width="96" height="96" alt="Peras logo: a pixel pear">
  </picture>
</p>

<h1 align="center">Peras</h1>

**Stop Claude Code or Codex before it burns the rest of your limit.**

Peras watches your Claude Pro/Max usage window, tells you where it's headed, and pauses the agent (or asks you first) at the line you set. The last stretch of your week gets spent on purpose.

> **0.2: early, and tested against real Claude Code.** Hit a bug or want a line Peras doesn't have? [Open an issue](https://github.com/Vertias3u/Peras/issues).
> ⭐ **Star it** if it saves your week.

```sh
npx peras-cli setup        # or: npm i -g peras-cli && peras setup   (Node 18+, no dependencies)
```

---

## The problem

You leave Claude Code on a long task. It works through your weekly allowance, and you find out when the wall hits, with days left in the week.

Usage trackers *show* you the number. **Nothing acts on it.**

## What it looks like

```
$ peras status
Peras 🍐 watching ~/.claude

  5h  ▰▰▱▱▱▱▱▱▱▱  24%   resets 18:24      on pace for 75% at reset
  7d  ▰▰▰▰▰▰▰▰▱▱  78%   resets Sat 12:00  full by Thu 14:59
      seen 2 min ago · protection active

⚠️ weekly 78% (line 75%), weekly runs out Thu 14:59 at this pace (resets Sat 12:00).

This week by chat (≈: shared out by what each spent; claude.ai use counts too):
  ≈ +41%    ~/code/app   7f3a9c21
  ≈ +12%    ~/code/blog  b81e04d7
  ≈ +5%     ~/code/app   c0ffee99

Lines: weekly 75% warn · weekly 90% pause · 5-hour 95% warn · weekly pace warn (from 50%)

Peras 🍐 watching ~/.codex

  5h  ▰▱▱▱▱▱▱▱▱▱  12%   resets 17:12      on pace for 21% at reset
  7d  ▰▰▰▰▱▱▱▱▱▱  41%   resets Sun 20:00  full by Sun 15:25
      seen just now · protection active

✓ Under every line.

Lines: weekly 75% warn · weekly 90% pause · 5-hour 95% warn · weekly pace warn (from 50%)
```

Your status line in Claude Code gets the same, coloured by your own lines: `🍐 ⚠️ · 5h 24% · 7d 78% (full Thu 14:59) · this chat ≈+12%`

*(Output from Peras itself, run on a demo week.)*

## What Peras does

At a line you pick, one of three things happens:

| Action | What happens |
|---|---|
| **warn** | A desktop notification. The agent keeps going. |
| **ask** | The next tool call waits for your OK in Claude Code's own permission prompt, once per session. With Remote Control on, you can approve it **from your phone**. |
| **pause** | Tool calls are refused with a clear reason and the turn ends. It lifts by itself, or when you run `peras resume`. |

And a line can watch more than the raw %:

- 📈 **Pace.** `peras set weekly pace pause` acts when the week is on track to run out *before it resets*, not after it already has.
- 🎯 **Per prompt.** `peras set prompt 3 pause` stops one prompt from eating more than 3% of your week. Your next prompt starts fresh.
- 🌙 **Part of the day.** `peras set 01:00-08:00 weekly 50 pause`: overnight runs stop at 50%, daytime keeps your normal lines.
- 📁 **Per folder.** `peras set --here weekly 60 pause`: the side project stops at 60%, work goes on to 90%.

Defaults (all changeable):

- weekly **75%** → warn
- weekly **90%** → pause
- 5-hour **95%** → warn
- weekly **on pace to run out early** → warn

Run `peras update` to check npm for a newer published release, update the global CLI, and refresh the Claude/Codex hooks and SwiftBar menu you already installed. Your rules, pauses, history, and menu preferences stay in place. It does not install hooks for agents you haven't set up. `peras update --check` only reports availability. A newer local or development version is never downgraded to an older published release. If the CLI is already updated but the hook copies are older, `peras update` refreshes those copies too. Restart open agent sessions after an upgrade and review changed hooks in Codex if prompted. Updates use your npm global prefix; permission or network failures are reported, without automatic sudo.

## Commands

```sh
peras setup                 # adds the hooks + status line to Claude Code, with a backup
peras update                # latest published CLI + installed hooks and menu bar
peras update --check        # check for a newer release without installing it
peras status                # both agents: usage, reset times, pauses, reading ages
peras why                   # rules behind each warning, ask, or pause
peras history               # past weeks: peak, lines crossed, when it hit the wall
peras pause [1h|18:00]      # pause Claude Code now, for a while or until you resume
peras resume [1h]           # lift a pause: for the rest of the window, or for 1h
peras set weekly 85 pause   # a line: 5h|weekly, warn|ask|pause, 1-100|off
peras set reset             # back to the defaults
peras menubar install       # 🍐 in the macOS menu bar, with Pause / Resume
peras menubar display pear  # pear only (usage restores the icons and percentages)
peras menubar quit          # close the menu bar; protection keeps running
peras menubar open          # open it again
peras doctor                # check everything is wired up, hooks included
peras notify                # which desktop notifications are on (peras notify resets on)
peras test                  # try pause and resume on a throwaway copy of the hooks
peras remove                # takes out exactly what setup added
```

The package is `peras-cli`; the command is `peras`.

**Upgrading?** `npm i -g peras-cli@latest`, then run `peras setup` again: the hooks run their own copy, and `peras status` tells you when it's out of date.

**Menu bar:** needs [SwiftBar](https://github.com/swiftbar/SwiftBar) (free: `brew install --cask swiftbar`, open it once and pick a plugins folder).

## Codex desktop and CLI

Codex desktop and CLI use the same user-level hooks. Peras reads ChatGPT plan usage through Codex's local app-server, and keeps Codex's limits, usage history, and pause state separate from Claude Code.

```sh
peras codex setup          # add Peras's hooks to ~/.codex/hooks.json
peras codex status         # Codex usage, reset times, pauses, and reading ages
peras codex doctor         # check hooks, runtime, and usage access
peras codex why            # explain Codex's current stop rules
peras codex set weekly 85 pause
peras codex pause 1h
peras codex resume
peras codex history
peras codex remove         # remove only Peras's Codex hooks
```

After setup, open `/hooks` in Codex CLI to review and trust Peras's hooks, then restart open sessions. Codex doctor checks configured hooks, the runtime, and usage access. Hook trust and enabled state must be confirmed inside Codex.

Codex supports hook denial but cannot create an approval prompt. A Peras `ask` line therefore blocks tools until you run `peras codex resume`. Hook coverage has [documented exceptions](https://learn.chatgpt.com/docs/hooks#tool-coverage). API-key-only Codex sessions do not provide ChatGPT plan usage windows. Peras reads no login files or tokens.

`peras status` shows both providers. Codex normally refreshes at most once a minute. Readings more than five minutes old are marked as older, and a failed refresh is shown explicitly. Saved readings count only until their windows reset. A manual pause still blocks Codex tools if usage fetching fails.

`peras why` explains each active rule, its folder scope when relevant, and when it lifts. The menu bar title shows a pear, the Claude icon and its 5-hour percentage, then the Codex icon and its 5-hour percentage. Choose **Menu bar display → Pear only** in the dropdown to hide the icons and percentages, or select **Pear + icons and percentages** to restore them. The choice is saved across setup and upgrades. Missing readings show a dash; paused agents' percentages turn red. The dropdown shows compact 5-hour and weekly progress bars and each agent's pause/resume controls. Reset times appear beside each usage bar. Status includes reading ages, warning details, and refresh errors. Status opens a local browser readout with usage, resets, and active pause reasons, refreshed every 10 seconds. Explain limits opens a bundled, offline webpage in your browser, covering the usage windows, warnings, pauses, and menu controls. Run either provider's setup before `peras menubar install`. **Quit**, at the bottom of the dropdown, closes SwiftBar (it says "Quit SwiftBar (all plugins)" when other SwiftBar plugins share its folder). The hooks don't need the menu, so protection keeps running; `peras menubar open` brings the pear back, and so does SwiftBar at login if it's in your Login Items. Typed on its own, `peras menubar` says whether the pear is in the menu bar and lists these commands.

Status, explanations, and Resume include folder rules from sessions seen by the hooks in the last seven days, even when run outside those folders. Start a new turn after updating to register existing sessions. Removing Claude's setup keeps the shared menu bar while another provider or account is installed. A timed resume can be extended with another timed resume, or changed to last until reset with plain `resume`; zero-length durations are rejected.

Clawd and the Codex companion walk above their 5-hour usage tracks, and stand still when their agent is paused or waiting for approval. The motion is decorative; the fill still measures usage. Animation runs locally with no model calls, and usage is fetched on its normal schedule. Setup replaces the older menu bar plugin entry so SwiftBar loads the streaming renderer automatically.

Each provider shows hook health: Protection active means a tool guard ran within the last 15 minutes, or a successful protection self-test refreshed a previously verified, unchanged setup within that time. Status identifies the verification source and retains the last live hook time. Needs trust / activation, Setup missing, Hooks disabled, and Not recently verified explain when protection cannot be confirmed. This is evidence for that provider and account; it does not verify every open session. `peras status` and `peras doctor` show the same health in Terminal. Timed pauses show the end time and remaining duration beside the Resume controls. Usage bars show countdowns alongside reset times.

In Settings → Menu bar display, toggle Show mascots and Show weekly bars independently. In Settings → Notifications, choose Warnings, Pauses and approval requests, and Usage resets. Warning and pause alerts default to on; resets default to off. Reset alerts need the menu bar running and fire once when a tracked window reaches its reported reset time. Notification settings do not disable enforcement. Preferences survive setup and upgrades. **Use it or lose it reminders** start off: enable them in Notifications or with `peras notify unused on`. Once per provider and weekly window, Peras reminds you when at least 20% remains and reset is within 48 hours. A matching menu row stays visible while eligible, even with weekly bars hidden. Reminders need the menu running and a weekly reading no older than five minutes; failed refreshes suppress them until a fresh reading arrives. Run `peras notify test` for a sample. On macOS alerts use a bundled native Peras app with the pear icon, with no compiler needed. Allow its one-time notification request, or enable Peras in System Settings → Notifications. `peras notify test` waits for the native sender and reports permission or delivery errors. Linux alerts supply the pear icon to the desktop notifier. From Terminal, `peras notify` lists the notification settings and `peras notify resets on` switches one; `peras menubar preference mascots|weekly on|off` sets the display toggles.

Choose **Settings → Protection test…** in the pear menu to run the installed hook commands against disposable state. It checks unpaused → allowed, paused → denied, and resumed → allowed for Claude and Codex. Results appear in Status; `peras test` runs the same check from Terminal. The test does not pause your working agents or make model calls. It validates the hook commands, while hook health separately reports live activation.

**Settings → Recent events…** opens the latest 50 event summaries in Status. Warnings, automatic pauses, approval requests, manual pauses/resumes, timed pause expiry, usage-window resets, and protection test results are recorded locally—even with desktop alerts disabled. `peras events` prints the same history. Logs rotate to keep storage bounded, and contain no prompts or tool commands. History starts with new events after this update; it does not reconstruct older activity.

Per-prompt thresholds work for both interactive agents: `peras set prompt 3 pause` for Claude and `peras codex set prompt 3 pause` for Codex. The allowance is a rise of three percentage points of weekly usage from that session's latest prompt baseline; the next prompt starts a new baseline. Usage is account-wide, so parallel sessions can contribute to the rise. When a Codex per-prompt rule is enabled, each prompt reads fresh rate limits, and tool calls reuse a reading at most 10 seconds old instead of the menu's one-minute cache.

Claude's installed status line emits ANSI colors following your thresholds. `peras codex statusline` provides the same compact colored usage readout for terminal integrations; `NO_COLOR=1` or `PERAS_COLOR=0` disables color. Codex's native footer uses the built-in items selected through `/statusline` and cannot run this Peras command; see [Codex footer customization](https://learn.chatgpt.com/docs/developer-commands). Its native footer is not modified by Peras setup.

## Plan your allowance

Set a daily allowance in percentage points of the provider's weekly usage:

```sh
peras budget daily 10 pause
peras codex budget daily 10 pause
peras budget                       # configured allowances and observed totals
peras budget daily off pause        # remove the daily pause allowance
```

A rise from 30% to 40% is ten points. Daily totals reset at **local midnight**, including daylight-saving changes. Accounting starts at the first observed reading each day; usage before that baseline is not reconstructed. A weekly reset does not erase points already counted today. Existing warning, ask, pause and resume behavior applies to allowances too.

Give a project its own weekly allowance from that folder:

```sh
peras budget --here weekly 5 pause
peras codex budget --here weekly 5 pause
peras budget --here weekly off pause
```

Project accounting is a **conservative estimate**: Peras counts account-wide weekly increases while a session in that folder or a child folder has been active within five minutes. Concurrent sessions and activity outside that project can contribute. Gaps longer than five minutes are skipped, so they can miss usage. This is not an exact per-project token meter. It starts when configured, resets with the provider's weekly window, and only pauses sessions in that folder. Nested configured projects can both count the same rise. Allowances are stored separately for each provider and account.

**Settings → Rules and allowances…**, or `peras settings`, opens the visual editor. Choose Claude or Codex, add or edit usage thresholds, pace and prompt rules, time schedules, folder overrides, and daily/project allowances. Notification and menu preferences are there too. Changes take effect on the next hook check. The editor listens only on `127.0.0.1`, requires a private session token, rejects outside origins and conflicting saves, and exits after 30 idle minutes. It does not send configuration off your computer.

**Settings → Weekly review…** opens charts and summaries in Status. `peras review` and `peras codex review` print peak usage, remaining allowance at the last reading, tracking gaps, and retained warning/pause/approval counts. Peras retains up to eight weeks of sampled usage. A late last reading cannot prove what expired unused: the review labels it as last observed, and gaps are never filled with zero usage. Intervention counts cover retained event history only.

When one agent pauses, the menu and combined Status can show the other's remaining 5-hour and weekly allowance. Both readings must be no older than five minutes, with no refresh error or active stop. This is a heads-up for choosing where to continue; Peras does not move your task or bypass provider limits.

## Pacing, profiles, and a little extra room

```sh
peras pace 20                         # keep 20% reserved; work Mon–Fri
peras pace 20 mon,tue,wed,thu,fri warn # choose workdays and action
peras pace off
peras profile save "Normal day"       # save current rules, allowances and pacing
peras profile save "Heavy work"
peras profile use "Normal day"
peras profile list
peras profile delete "Heavy work"
peras extra daily 3 1h                # three more points for today, for up to an hour
peras extra --here 3 today            # three project points until local midnight
peras extra                          # active grants and IDs
peras extra revoke GRANT_ID
peras sessions                       # recent observed sessions for both agents
peras compare                        # compare two completed tracked weeks
```

Add `codex` after `peras` for Codex's pacing, profiles, extras, sessions or comparison.

**Workday pacing** divides the weekly allowance above your chosen reserve among configured working days remaining before reset. Today's share is fixed at its first fresh reading, starting from the daily usage already observed when the plan is enabled. It stays fixed as you work, and is recalculated at local midnight or the weekly reset. On non-working days agents get no share at all, so every tool call meets the plan's action (with the default `pause`, agents stay paused all day). Add the days you work to the plan, or choose `warn`. Re-saving the same allocation or switching back to its profile does not renew today's share; changing the reserve or working days recalculates it from current usage. Existing limits still apply; a reserve is a planning target, not a guarantee that activity outside Peras cannot spend it.

**Profiles** save rules (including schedules and folder overrides), allowances and pacing for the selected provider/account. Switching keeps observed usage, existing pauses and temporary extras. Display and notification preferences are separate. Save names such as Normal day, Heavy work and Overnight after configuring each the way you want. The pear menu lets you switch saved profiles; the editor also shows when current settings differ from the active profile.

**Temporary extras** extend an existing daily/pacing or project allowance. They do not resume the entire agent, remove another rule or refill provider usage. Grants need a reading from the current weekly window, which may be older than five minutes, and end at the earlier of the chosen expiry, local midnight, or weekly reset. The editor can grant and revoke them. Daily extras extend both a configured daily allowance and its workday share; project extras affect only that folder's allowance. Usage counters keep counting throughout.

**Session overview**, in Settings or Status, lists sessions whose hooks Peras observed in the last seven days, their folders, last hook activity, current action and applicable limits. It contains no prompts or tool commands and is not a process monitor. A recently seen session may already have ended.

**Weekly comparison**, in the pear menu and Status, compares the two most recent completed observed weeks: peak usage, last-known remaining allowance and retained intervention counts. `peras compare` provides a text summary. Partial tracking is marked; differences can reflect different workloads or gaps, so this does not prove limits caused a reduction.

On **macOS**, native pear notifications include **Open Status**. Pause/approval alerts also offer **Resume for 1 hour**, and unused-allowance reminders offer **Remind me in 1 hour**. Resume applies only to the original provider/account and refuses if the pause has changed or the action is over an hour old; it opens Status instead. Snoozed reminders repeat once after the hour only while the menu is running, reminders remain enabled, and fresh usage still qualifies. Existing older notifications may lack the new actions. Linux continues to receive pear notifications without these native Mac action buttons.

## How it works

- Claude Code already passes your 5-hour and weekly usage to its **status line**. Peras reads it from there and keeps a small history in `~/.peras`.
- Before every tool call, a Claude Code **hook** asks Peras: go, ask, or stop.
- **Local only.** No account, no server, nothing leaves your machine.
- **It never touches your login.** No token handling and no base-URL change, so Remote Control keeps working.
- **Already have a status line** (ccstatusline or your own)? Peras chains in front of it and passes everything through unchanged. `peras remove` restores yours exactly.

## Honest limits

- **Pro/Max only.** Claude Code only reports the usage window for claude.ai subscriptions. API-key users have no window to watch.
- **Interactive sessions first.** `claude -p` runs don't refresh the status line. Peras uses the last reading from any interactive session, which is never higher than the truth, so a pause there is always justified, but it can be late. Per-prompt lines only work in interactive sessions.
- **A paused `claude -p` run just ends.** It exits without an error, so a script can't tell it was paused. Check `peras status`.
- **The forecast is a straight line** from the last day's pace (or the week's average), and it waits until there's enough to go on. A quiet afternoon or a burst changes it.
- **"By chat" is an estimate.** Your limit is one number for the whole account, so Peras shares each rise out by what each chat spent. claude.ai and the desktop app use the same limit and aren't seen.
- **Per-prompt lines are account-wide.** Another chat running at the same time counts toward your prompt's rise, so it errs toward pausing.
- **Changed your Node install?** Run `peras setup` again. If the hooks can't start node, they say so instead of passing silently.
- **A guard rail, not a wall.** Hooks run inside Claude Code. Peras protects your own sessions; it is not security against a hostile process.
- **No phone ping when it asks.** You can approve from your phone, but Claude Code doesn't push a notification for these prompts, so open the app to see it.

## Level up: PassControl 🛂

**Peras watches one number. [PassControl](https://passcontrol.vertias.eu) runs the whole control tower.** Same maker. Free beta, in the cloud or self-hosted.

**🛑 Stop anything, from anywhere**
- Kill an agent mid-task from your phone's browser. Works on a Pro/Max login too.
- Stop one session and leave the rest running.

**✋ Nothing risky without your yes**
- Tool rules for Claude Code: block a command outright, or make it ask you first.
- Approve or Deny with one Telegram tap or on the dashboard. No answer, no run.

**🔐 Agents use your accounts, never your secrets**
- API keys stay in a vault. The gateway adds them on the way out, and scrubs them if a provider echoes one back.
- The same goes for GitHub, Notion, Discord and Telegram bot tokens. GitHub writes go through one exact rule at a time.

**💸 Spend that can't run away**
- Daily or monthly caps per agent, in dollars or tokens, enforced outside the agent. New agents start at $20 a day.
- Its own cap for every sub-agent, per session. A ping in Slack, Discord or Telegram when a session passes your number.

**👀 See it live**
- `passcontrol watch`: every call through your sidecar, its cost, and why anything was refused, in real time.
- Your agent sees its own budget in its status line.

**🧾 Proof, not promises**
- A signed receipt for every API call, naming the session and sub-agent it came from. Anyone can verify it in a browser.
- Seal a coding session and prove nothing was left out.

**🔌 One command to plug in** Claude Code, Codex or OpenRouter, plus local models on Ollama when self-hosted. Failover to a backup provider is built in.

Peras works fine on its own. PassControl is for when you want the keys, the budgets and the off switch in one place.

## License

MIT

---

*Not affiliated with Anthropic or OpenAI. "Claude" and "Claude Code" are Anthropic's trademarks; "Codex" and "ChatGPT" are OpenAI's.*
