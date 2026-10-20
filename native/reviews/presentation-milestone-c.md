# Milestone C presentation: semantics review (Claude, 2026-10-18)

Reviewed commit `60df585` read-only against the backend at `067c46b` plus one backend fix (C01). Scope: does the app say what the backend means? I did not review visuals, motion, performance or the share renderer's pixels.

## Findings

**C01 · P2 · reason values in the wrong unit. Backend fixed; Swift should follow.**
`ReasonPresentation.values` picks `%` for `kind == "window"` and "points" for every other kind. Two kinds came out wrong:
- **Pace lines** (`kind: "pace"`) are percentages of the window, but showed as points. Allowance pacing (`kind: "pacing"`) is points, and that one was already right.
- **Prompt lines** carried the weekly percentage in `used` against a rise allowance in `at`. The result read like "47 points observed · 3 points line".

The backend now sends `unit: "points" | "percent"` on every reason, and a prompt reason's `used` is the rise since the prompt. That gives "5 points observed · 3 points line". Please use `raw["unit"]` and drop the kind check. Test: `test/native-operations.test.mjs`, the "share a unit" case.

**C02 · P2 · profile buttons can't be told apart.**
`profile.use` is live since `067c46b`, with one offer per saved profile. `PresentationText.action` returns "Use saved profile" for all of them. Show `params.name`; it is already the private wire label, with "Profile N" for names that look like paths.

**C03 · P2 · the strict switch doesn't say which way it goes.**
`failurePolicy.set` is live, with `params.policy` set to the target. "Change failure handling" doesn't tell the user whether the click turns blocking on or off. Suggested wording:
- Turn on: "Block Claude Code's tools when Peras can't check them". Show `failurePolicy.claudeVersion` if present.
- Turn off: "Let tools run when Peras can't check them (you're told)".

Show strict as active only when `failurePolicy.mode == "strict"`.

**C04 · P2 · stop lines ignore their new `state`.**
`thresholds[]` now carry `state: clear|crossed|lifted|inactive` and `liftedUntilMs`. `ConfiguredThreshold` still labels everything "configured" or "conditional/scheduled". Suggested labels:
- crossed: "acting now";
- lifted: "lifted until <time>";
- inactive: "outside its hours";
- clear: "configured".

`inactive` is narrower than "conditional": a line with `during` that is active right now is `crossed` or `clear`.

**C05 · P3 · codes that fall through to the generic text.**
In `PresentationText.disabled`, these need their own text:
- `runtime_outdated`: the hooks are older than this runtime. Run `peras setup`.
- `requires_upgrade`: strict needs a newer Claude Code.

As result codes (FixtureStore `onResult`), these need their own text:
- `test_failed`: the self-test failed; the status page has the details.
- `requires_upgrade`, `unknown_version`, `unsupported`: strict mode was refused, and nothing was written.
- `setup_missing`.

`busy` is already handled.

**C06 · P3 · the pacing reserve is a percentage.**
PlanningStrip says "reserve target N points". The engine reserves N% of the week, and the CLI and hooks say "N% reserved". Use the same word.

**C07 · P3 · risk: the strict decoder blanks the whole app on one new enum value.**
`Snapshot.decode` throws for any verdict, health or freshness value it doesn't know. The backend's additive-field rule doesn't cover new enum values, so a backend addition would make the popover show nothing. No change is needed today, because the two sides agree. Either degrade per provider, or we both treat new enum values as protocol-breaking. Your call; tell me which.

## Checked and correct

- **Resume impact:** `lifts` ids match `reasons[].id`, and `extends[]` maps to the reason and its old expiry. "Provider-wide" is accurate, because the plan comes from `cwd: null` across observed sessions.
- **Extra:** "adds 3 points to each matching global daily meter … until `expiresAtMs`" matches `grantExtra` and `extraUntil`. The pacing meter, which is daily, is included in the backend too, and "usage is not erased" is true.
- **Windows:** current, stale, expired and missing are handled as the backend means them. Expired shows "awaiting reading" rather than the old number. The menu title's `~` for stale is right.
- **Planning:** limit, base and extra, `extraExpiresAtMs`, estimated, waiting-for-reading and non-working day all match the meter fields.
- **Manual pause:** "Until resumed" when `expiresAtMs` is null. The project-only wording appears only when every stopping reason is project-scoped.
- **Settings:** each row shows the backend's own from-and-to flip, so there's no local state to drift.
- **Share model:** carries provider, window, freshness and a clamped `used` only. No labels, ids, profiles, projects or times.
- **Results:** `state_changed` and ok wait for a fresh snapshot before allowing another click, and a token is never reused automatically.
