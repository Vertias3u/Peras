# Peras 0.5 stress tests

Run `node --test test/stress/` (or `node --test test/stress/*.test.mjs`).
The extensionless directory entry point supports Node 18/22 without adding a
second set of tests to normal Node test discovery. No root test command changed.

Every fixture starts with `test/helpers.mjs`'s `sandbox()`. HOME, PERAS_HOME,
CODEX_HOME, CLAUDE_CONFIG_DIR and SwiftBar paths are disposable. A local stdio
Codex RPC fixture replaces the executable; no auth, network, listeners, real
notifications, setup, process-list inspection, or production-home access is used.
The busy-lock test names this test process as the lock owner and removes its
own lock; it does not require inspecting another process.

Confirmed bugs retain their original assertions and have static `todo: "BUG: …"`
annotations. A fixed implementation will therefore show a passing TODO, making
it straightforward to remove that annotation. The seeded PRNG is `0x5eed0500`
(1592591616); diagnostics print it.

## Ranked findings

1. **High — subagent limit bypass under contention.** `src/spawn.mjs:48` falls
   back to a separate saved counter when the ledger is busy. Reproduction:
   `claude: busy spawn ledger still enforces the exact subagent line` and its
   Codex counterpart. Fifty starts pass a line of two while a live writer holds
   the ledger lock. Suggested fix: when a configured subagent guard cannot claim
   an atomic slot, refuse that spawn with an actionable busy reason; never admit
   from an unshared count.
2. **High — late readings bypass usage stops.** `src/store.mjs:74` /
   `src/window.mjs:33` replace a newer 80% reading with an older 20% reading in
   the same window. Reproduction: `late lower reading cannot overwrite a newer
   reading and bypass a pause`; the 70% pause allows the tool. Suggested fix:
   merge readings under a lock, ordered by seenAt and window instance, and
   preserve the monotonic lower bound within the same instance.
3. **High — corrupt saved-reset cache loses a Codex deny.**
   `src/saved-resets.mjs:48` dereferences null cached credits before returning
   the already-computed deny. Reproduction: `corrupt cached saved reset credit
   entries cannot crash the snapshot or hook`, plus `corruption: codex-cache >
   nested`. Direct hook/snapshot calls throw; the real CLI hook catches the
   exception and allows the action. Suggested fix: validate cached entries and
   isolate optional reset hints from the enforcement result.
4. **High — strict mode accepts broken control-state shapes.**
   `src/store.mjs:127` checks JSON syntax but treats a number, array, or malformed
   manualPause as no pause. Reproduction: the three `strict Claude hook rejects
   malformed control-state shape …` tests. Actual exit is 0, expected strict
   block is 2. Suggested fix: validate the controls object and pause/resume
   fields in strict mode before defaulting missing fields.
5. **Medium — out-of-order history changes burn enforcement.**
   `src/rules.mjs:141` uses arrival order for find/findLast. Reproduction:
   `seeded property: the same readings in any arrival order have the same burn
   verdict`. The same 10→20→40 points can measure a rise of 0 rather than 30.
   Suggested fix: choose timestamp extrema or sort/deduplicate validated points
   before selecting the baseline.
6. **Medium — backwards clock hides current Codex use.** `src/codex.mjs:150`
   considers a negative cache age fresh. Reproduction: `a future-dated Codex
   cache cannot hide current usage after the clock moves backwards`. A cache
   one hour ahead prevents the reader from returning 80%; a 70% stop allows.
   Suggested fix: require a finite timestamp and `0 <= age < maxAge` (with a
   small, explicit clock-skew tolerance if desired).
7. **Medium — native snapshots stall at scale.** `src/store.mjs:267` evaluates
   the same global rate rules/history for every observed session. Reproduction:
   `scale claude: 100k usage points, 1000 sessions, 200 rules > native snapshot
   completes within 5 seconds`, and the Codex counterpart. Snapshot computation
   takes tens of seconds in isolation; hook checks remain below one second.
   Suggested fix: share global history/baseline calculations and evaluate only
   session-dependent rules per session. The 1000 input sessions are correctly
   bounded to 100 by the reader, but the remaining repeated work is still large.
8. **Medium — unbounded epoch seconds poison output/native payloads.**
   `src/codex.mjs:112` and `src/saved-resets.mjs:25` accept `1e308` seconds.
   Reproduction: `Codex answer: huge-reset never crashes; native accepts it`,
   and `saved resets: 1 credits, expiresAt huge` / the 1000-credit counterpart.
   Multiplication overflows milliseconds, dates contain NaN, and native
   validation rejects the payload. Suggested fix: validate safe, Date-supported
   millisecond timestamps at ingestion and revalidate cached data.
9. **Medium — corrupt window values print NaN.** `src/window.mjs:44` accepts a
   live window with `usedPct: "broken"`. Reproduction: `corruption: window >
   nested` and `corruption: codex-window > nested`. Status prints `NaN%` and
   `on pace for NaN% at reset`. Suggested fix: validate numeric, bounded usage
   values before treating disk windows as live; expose a reading issue.
10. **Low — countdown violates its open-interval contract.** `src/rules.mjs:162`
    rounds a sub-millisecond remaining allowance to exactly now. Reproduction:
    `emptyAt cannot round a tiny remaining allowance down to now`. Suggested
    fix: require `now < t < resetMs`, or ceil a valid positive duration.

## Coverage without a detected bug

- 64 actual hook processes per provider, with burn and subagent rules together:
  exactly 7 admissions / 57 denials; no corrupt JSON; hooks below 5 seconds.
- Further 64-process burn, manual-pause and resume waves for each provider:
  burn latches persist, explicit controls survive, stale hooks do not resurrect
  released burns, and no-rise continuation is allowed after resume.
- Forty state-file targets, nine corruption forms each, both provider hooks,
  strict Claude checks, status/why/doctor, and native validation (exceptions are
  the TODO cases above). This includes control state, hook memory, spawn ledger,
  rules, usage, windows, install records, Codex cache/backoff, saved-reset
  reminders, health, receipts, allowances/planning, preferences and native records.
- Read-only PERAS_HOME preserves an enforceable stop; missing directories,
  Unicode/space HOME (`é ü 名前 space`), and paths over 600 bytes work.
- Clock jumps of −60, −1, 0, +1, +60 and +300 minutes, future history points,
  already-reset windows, mid-burst resets, reminder expiry and repeat suppression.
- Missing/null/wrong-type Codex fields, numeric strings, negative/>100/huge
  percentages, unknown fields, fractional and past resets; 0/1/1000 saved reset
  credits with null/past/valid far-future expiry; malformed raw credit lists.
- Real v0.4.1 modules, extracted with git archive into the sandbox, read the
  files written by v0.5 hooks, burn latches, pause/resume and new rules. Legacy
  paths and core JSON object/list/number shapes are unchanged; old status and
  old native snapshot validation pass for both providers. This checks rollback
  readability, not whether v0.4 enforces v0.5-only rule kinds.
- 4000 seeded cases for below-line pauses, resume/no-new-rise behavior and
  ordinary countdown bounds. Native payloads are checked before and after JSON
  serialization, including the scale states.

Loopback and external process-inspection tests are outside this suite. On this
sandbox, the existing full suite needs its six loopback editor tests and the
`F1 pruning keeps current…` process-inspection test skipped:

```sh
npm test -- --test-skip-pattern='F1 pruning keeps current|local editor saves rules|editor rejects external origins|settings CLI starts and reuses|private editor expires|editor configures pacing|editor saves, edits and deletes burn'
```

Timing diagnostics include per-provider min/p50/p95/max hook wall time (five
samples with the scale inputs present), plus the complete native snapshot time.
The timings are local measurements, not performance guarantees.

## Recorded validation (2026-10-28, Node 22.23.1)

- Requested directory command: 464 checks; 446 pass, 18 expected TODO failures,
  0 unexpected failures, 0 skips (147.7 seconds).
- Full suite with the seven sandbox-incompatible cases excluded: 968 checks;
  948 pass, 18 TODO, 2 existing notifier skips, 0 unexpected failures.
- Final targeted scale run uses **200 distinct active rate rules** (spans 1–200
  minutes): 2 passing hook benchmarks and 2 expected snapshot-latency TODOs.
  These replace the earlier scale run's 100 distinct spans repeated twice.
- Ordinary 64-process admission bursts: Claude max 860 ms; Codex max 940 ms.

| Provider | Scale hook min | p50 | p95 / max | Native snapshot |
| --- | ---: | ---: | ---: | ---: |
| Claude | 598 ms | 620 ms | 634 ms | 45,271 ms |
| Codex | 625 ms | 642 ms | 668 ms | 57,461 ms |

Five hook samples per provider; 100,000 usage points, 1,000 input sessions
(bounded to 100 on read), 200 distinct rules. The native payload is valid after
the slow computation; the TODO asserts the violated 5-second latency bound.

Only files under `test/stress/` were added. The pre-existing shared claim is
still on TEAMSHARE.md: that file is a symlink outside this sandbox's writable
roots, so its shared log/claim could not be changed here.
