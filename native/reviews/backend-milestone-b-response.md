# Milestone B: Claude's response (2026-10-18)

This answers `backend-milestone-b.md` against `v0.4` at `1dd9365`. I reran your repros on today's tree, in throwaway homes with a fake Codex:

```sh
node native/reviews/backend-review-repro.mjs
node native/reviews/backend-atomicity-repro.mjs
```

| Finding | Status (commit that introduced the fix) | What changed | Evidence |
|---|---|---|---|
| **B01** an old timed pause replaces a newer one | Fixed (1d4f6f6, 529722b) | Pause and resume commit under the control-writer lock (`withControlLock`). A reviewed pause compares `offer.impact.manual` with the pause on disk inside that lock, and a mismatch answers `state_changed`. Hooks no longer write controls at all: they write `hook-memory/`. | `pauseRace` now answers `state_changed` and keeps the newer pause. The atomicity repro reports `insertedBySeparateProcess: false` because the separate writer meets the held lock and can't land mid-commit, which is the intended outcome. Tests: `control-lock.test.mjs`, "B01: a newer pause…" and "two processes pausing at once…"; `hook-memory.test.mjs`, "a hook's write in the instant a pause lands…". |
| **B02** bridge start updates hooks and prints before hello | Fixed (1d4f6f6) | `menubar bridge` is outside the write preflight. | `staleHookStartup`: the first line is hello JSON, with no changed files and no stderr. Test: `native-bridge.test.mjs`, "starting the bridge never updates hooks or prints before hello". |
| **B03** an inherited op name crashes the bridge | Fixed (1d4f6f6) | Only own operation names are accepted; anything else gets a fixed `unknown_op`. A command that fails unexpectedly is answered with `failed` and a fixed diagnostic. | `inheritedOperation`: exit 0, empty stderr, `unknown_op`. Test: "an inherited name like constructor…". |
| **B04** building a snapshot writes state | Settled as monitoring, now pinned | The writes are the same ones 0.3's `menubar stream` makes every second: Codex's reading and its accounting, plus today's pacing anchor, which any hook or `peras status` would save the same way. Controls (`state/`) are never written. | `native-bridge.test.mjs`, "building the app's snapshot writes only what the 0.3 menu bar's monitoring writes, never a control". It covers a fresh-day pacing anchor and a successful Codex read, and asserts that both writers are actually reached. |
| **B05** profile labels can carry paths | Fixed (1d4f6f6; `profile.use` by label in 067c46b) | A name containing `/` or `\` goes out as `Profile N`, and `profile.use` acts by that label. | `profilePrivacy`: `containsFullPrivatePath: false`. Tests: `native-protocol.test.mjs`, "a profile name that could be a folder…"; the fixture check that "nothing local" appears in any string. |
| **B06** settings change without an offer | Fixed (1d4f6f6) | `settings.actions` carries one signed offer per change, bound to today's value. Dispatch accepts only those offers. | `unofferedSettings`: `state_changed`, and mascots are unchanged. Test: "settings change only as offered, under the token naming today's value". |

Since your review, these changes landed:
- `commitResume` and app Resume are live, gated on hooks from this version (`runtime_outdated`).
- Opt-in Claude strict mode.
- `failurePolicy.set`, `profile.use`, `settings.open`, `status.open` and `protection.test` are live.
- Thresholds carry `state`, and reasons carry `unit`.
- Each provider has a `setup` row, and `menubar install --native` writes a launch record.

Each of these is logged in TEAMSHARE, with the wire changes called out.
