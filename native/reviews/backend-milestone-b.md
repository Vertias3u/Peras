# Milestone B backend review — 2026-10-17

Read-only review of `native-protocol`, `native-bridge`, `native-operations`, `planResume`/`commitResume`, and their relevant callers. No Claude-owned source was changed. These findings concern the frozen pre-controls-split snapshot, not any later concurrent edits by Claude. The snapshot and exact input hashes are retained at `/private/tmp/peras-v04-live-review-04spd6m7/backend-snapshot` and in `backend-snapshot-hashes.json` beside this report.

All repros create disposable state and use an injected fake Codex reader or a fake executable guard. They never launch the real Codex. Findings are ordered by impact. B06 is an intentional-unbound-settings contract gap, not an HMAC forgery.

## B01 — P1: an old timed Pause can replace a newer indefinite pause

Location: `src/native-operations.mjs:40–46`, handler at line 17; `src/store.mjs:pauseNow`.

The token is verified against a snapshot, then the handler separately calls `pauseNow`. There is no writer boundary that revalidates the reviewed manual-pause identity. The latter rereads state but unconditionally overwrites its manual pause. Another writer can create an indefinite pause between validation and that write; the old timed click then changes it to a pause ending in one hour. Disabling native Resume does not protect this already-live Pause path.

Repro: `backend-atomicity-repro.mjs` uses a genuine signer and inserts a real, separate Node process at the commit state-read cut-point. No signer behavior or production source is replaced. The child writes `{since:1791979200001, until:null}`; the old click returns `ok:true` and saves `{since:1791979200000, until:1791982800000}`. This is deterministic scheduling of the external-writer race, not a probabilistic stress test. See `backend-atomicity-results.json`.

Expected: verify the reviewed identity again inside the same serialized explicit-control commit that saves it, or refuse the stale action. Include Pause when gating the explicit-controls cutover.

## B02 — P1: bridge startup silently upgrades hooks and emits non-JSON before hello

Location: `src/cli.mjs:735–739` and `refreshStaleHooks` at 721–730.

`menubar bridge` falls through the general `WRITES` preflight. With an installed runtime version different from the CLI, it copies the runtime, rewrites the hook install record/settings and prints a human update message before `runBridge` sends `hello`. Native launch is therefore a guard/config writer without an app command and violates protocol-1 hello-first JSON-only stdout. Upgrade failures can also interpolate local file paths into stdout.

Repro: `backend-review-repro.mjs`, `staleHookStartup`: install Claude hooks in a temporary home with version 0.3.1, then start the real Node CLI `menubar bridge --protocol 1` with empty stdin. First line is `(Updated the hooks from Peras 0.3.1 to 0.3.2 first. Restart open sessions to pick them up.)`; it is not JSON. The install record and `app/bin`, `app/src`, `app/package.json` change without a command. This uses the frozen package version 0.3.2; the relevant condition is version mismatch.

Expected: separate bridge launch from mutating CLI upgrade preflight, with an explicit typed repair/migration gate. The native client must reject this prefix rather than discard arbitrary text before hello.

## B03 — P2: inherited operation names crash the bridge and disclose source paths

Location: `src/native-protocol.mjs:293–299`; `src/native-bridge.mjs:57–58,80`.

`OPERATIONS[c.op]` accepts inherited properties of an ordinary object. `constructor` or `__proto__` is truthy but has no parameter specification. `Object.keys(spec.params)` throws a TypeError rather than a ProtocolError. The serialized command chain rejects outside its ProtocolError handler, producing an unhandled rejection and terminating Node. Its stderr includes the complete installation/source path; when installed under a user home that also exposes the username.

Repro: send `{"type":"command","protocol":1,"id":"inherited","op":"constructor","params":{},"actionToken":"t"}` to the CLI bridge. `backend-review-results.json.inheritedOperation` records exit 1, a TypeError, and `stderrHasSourcePath:true`. An unknown operation should receive a fixed typed refusal while keeping the bridge usable.

Expected: validate an own, string operation name and contain unexpected command-handler failures using safe fixed diagnostics.

## B04 — P2: building a snapshot writes state the hooks consume

Location: `src/native-bridge.mjs:19–20`, through `providers.snapshot` → `store.context` → `allowances.allowanceMeters` → `planning.pacingMeter`, and successful `refreshCodex`.

The existing no-write test uses a failing Codex reader and no pacing plan. It misses both mutating paths. With fresh weekly usage and pacing configured but no saved anchor, `nativePayloads` creates `planning/<key>.json`'s anchor (a saved enforcement ceiling). With a successful fake Codex reader, it changes `windows/<key>.json`, `allowances/<key>.json`, `usage/<key>.json` and the Codex cache. These are not merely the separate refresh/backoff record.

Repro: `backend-review-repro.mjs`, `snapshotPacingWrite` and `snapshotCodexWrite`, records the exact changed-file lists and the created 10-point pacing anchor. These are inherited domain side effects reached by the new bridge; the finding is that the claimed read-only snapshot boundary and its test are incomplete. Provider monitoring may legitimately need to persist fresh usage, but that write ownership must be explicit and must not be mistaken for pure snapshot serialization.

Expected: separate/identify permitted monitoring/accounting writes from building the native view, and test fresh-day pacing plus successful provider reads. Do not describe the current function as writing nothing the hooks read.

## B05 — P2: accepted profile labels expose full paths/usernames on the wire

Location: `src/native-protocol.mjs:212` and `planning.profileSummary`.

`saveProfile` accepts slash-containing names up to 48 characters, and the serializer copies `profiles.names` and `profiles.active` verbatim. Fixture privacy assertions exercise only innocuous names. A valid existing name `/Users/review-alice/private-notes` appears as a complete path and username in the snapshot. The sample is synthetic; no real private account data was used.

Repro: `backend-review-repro.mjs`, `profilePrivacy`, calls the ordinary profile API with that name and serializes real provider payloads; `containsFullPrivatePath:true` is recorded. Project basename labels are also intentionally serialized, so a basename equal to a username is not automatically private by this schema.

Expected: settle the wire-label privacy contract and use safe display labels/opaque action identity where necessary. Preserving arbitrary existing profile names and claiming that no wire string can contain a local path are incompatible without an explicit handling rule.

## B06 — P2: global settings mutate without any eligible offer

Location: `src/native-operations.mjs:36–38`; protocol `offeredActions` contains provider actions only.

`preference.set`/`display.set` bypass offer selection, `offerBlocked` and token verification altogether. A missing-setup snapshot contains no settings offer, yet a syntactically valid command with an arbitrary nonempty token changes the setting and returns `ok:true`. `unbound-v0` is a documented intentional settings exception, so this is not evidence that HMAC provider tokens can be forged; it is a gap against the requested mutation/eligible-offer contract. The client cannot invent these controls while following eligible/disabledReason alone.

Repro: `backend-review-repro.mjs`, `unofferedSettings`, uses `actionToken:"definitely-not-an-offered-token"`; mascots changes to false while all snapshot action operations are `pause`. A protocol clarification request is in TEAMSHARE In flight. Until resolved, the app should omit settings buttons rather than manufacture eligibility.

Expected: expose/document fixed global offers and their eligibility and have dispatch enforce the same contract, or explicitly settle a narrower exception with the owner.

## Checks that passed and limits

- Provider HMAC verification rejects forged, cross-bridge, cross-provider, modified-impact and expired tokens; `token-invariant-results.json` records independent checks. Existing bridge tests cover same-id cached replies and Extra's grant-consuming token. No provider HMAC forgery was found.
- Resume extraction preserves return values and saved state against `HEAD:src/store.mjs` in five differential cases: manual pause, weekly grant replacement, observed project/prompt scopes, corrupt usage with a manual pause, and invalid duration. `resume-parity.mjs` and its results are retained. The CLI/notification/self-test continue to call `resume`; native Resume remains not_ready in this audited snapshot. Unserialized direct `commitResume` is not claimed safe for enabling later native control mutations.
- Isolated npm verification at this review gate: 226 passed, 2 native-notification tests skipped; package check 51 files/175.6 kB and demo-week check pass. A PATH-prepended fake Codex guard recorded zero executable invocations. Native app/check/performance outcomes are recorded separately in `native/README.md`.
- This is a focused backend/interface review. No claim is made about signed distribution, host strict-mode behavior, a completed explicit-controls migration, broad fuzzing or an exhaustive repository security audit. Concurrent backend changes must be reviewed against the retained hashes before treating an issue as fixed.

## Reproduce safely

From `~/peras-v04`:

```sh
node native/reviews/backend-review-repro.mjs
node native/reviews/backend-atomicity-repro.mjs
node native/reviews/resume-parity.mjs
```

All three write results into fresh system temporary directories by default and seed only disposable homes. To reproduce the precise reviewed source instead of the latest worktree, set `PERAS_REVIEW_SOURCE_ROOT=/private/tmp/peras-v04-live-review-04spd6m7/backend-snapshot`. `PERAS_REVIEW_OUTPUT` may select an existing scratch output directory. The frozen tree is an uncommitted local evidence copy, not a new worktree or a product source edit. Portable repros are expected to change behavior after Claude fixes the relevant backend paths; that is the purpose of retaining both the original results and source hashes.
