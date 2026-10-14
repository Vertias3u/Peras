# Peras 🍐

**Stop Claude Code before it burns the rest of your limit.**

Peras watches your Claude Pro/Max usage window. When it hits the line you set, it pauses the agent or asks you first, so the last stretch of your week is spent on purpose.

> **0.1: early, and tested against real Claude Code.** Hit a bug or want a line Peras doesn't have? [Open an issue](https://github.com/Vertias3u/Peras/issues).
> ⭐ **Star it** if it saves your week.

---

## The problem

You leave Claude Code on a long task. It works through your weekly allowance, and you find out when the wall hits, with days left in the week.

Usage trackers *show* you the number. **Nothing acts on it.**

## What Peras does

At a threshold you pick, one of three things happens:

| Action | What happens |
|---|---|
| **warn** | A desktop notification. The agent keeps going. |
| **ask** | The next tool call waits for your OK in Claude Code's own permission prompt, once per session. With Remote Control on, you can approve it **from your phone**. |
| **pause** | Tool calls are refused with a clear reason and the turn ends. It lifts when the window resets, or when you run `peras resume`. |

Defaults (all changeable):

- weekly **75%** → warn
- weekly **90%** → pause
- 5-hour **95%** → warn

```sh
npm i -g peras             # Node 18+, no dependencies
peras setup                # adds the hooks + status line to Claude Code, with a backup
peras status               # 5h and weekly usage, your lines, paused or not
peras resume               # lift a pause for the rest of this window
peras set weekly 85 pause  # change a line: 5h|weekly, warn|ask|pause, 1-100|off
peras doctor               # check everything is wired up
peras remove               # takes out exactly what setup added
```

Or without installing: `npx peras setup`.

## How it works

- Claude Code already passes your 5-hour and weekly usage to its **status line**. Peras reads it from there.
- Before every tool call, a Claude Code **hook** asks Peras: go, ask, or stop.
- **Local only.** No account, no server, nothing leaves your machine.
- **It never touches your login.** No token handling and no base-URL change, so Remote Control keeps working.
- **Already have a status line** (ccstatusline or your own)? Peras chains in front of it and passes everything through unchanged. `peras remove` restores yours exactly.

## Honest limits

- **Pro/Max only.** Claude Code only reports the usage window for claude.ai subscriptions. API-key users have no window to watch.
- **Interactive sessions first.** `claude -p` runs don't refresh the status line. Peras uses the last reading from any interactive session, which is never higher than the truth, so a pause there is always justified, but it can be late.
- **A paused `claude -p` run just ends.** It exits without an error, so a script can't tell it was paused. Check `peras status`.
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

*Not affiliated with Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks.*
