# Native v0.4 app and local verification

AppKit owns the status item, attached popover and one normal-level pinned panel; one retained SwiftUI hosting controller reads the shared `ObservableObject`. The macOS minimum is 13. Normal Run connects to the real local Node engine in a disposable development home. **Codex account readings are synthetic:** the wrapper installs a clearly marked fake `codex` executable; it never starts the real Codex, contacts a provider or uses model credits. Installed production mode reads an external launch record. Local builds are signed ad hoc; the copy sold on Polar is Developer ID-signed and notarized.

## Latest (2026-10-20, fourth round): paid app, build it yourself, site picture

**Owner decision:** the signed, notarized app sells for €4.99 on Polar (`peras.vertias.eu/app` redirects to the checkout via `site/vercel.json`). The CLI, hooks and SwiftBar menu stay free; GitHub gets release notes only. The CLI's no-app message, its help, the README, the site and `LaunchFailure.runtime` point there, with "or build it yourself".

**Build it yourself.** `npm run build:app` (`native/scripts/build-app.mjs`) runs `build_and_run.sh --headless` with all checks in a fresh `/private/tmp` folder, packages the universal app ad hoc with `package-local.mjs` in that build's isolated home, and prints the `--app` install line.

**Site picture.** The menu probe's `--site-image` mode draws only the demo week's menu in dark mode without its "Preview" badge, plus the menu bar title (`site-title.png`). `node scripts/demo-week.mjs site-menu RUN_ROOT` turns the demo week into a protocol-1 snapshot, moves its times forward by whole weeks (less any summer-time change) so resets still show, draws it in Europe/Sofia (`PERAS_LAUNCH_TZ`, new in `launch-built.mjs`) and writes `site/menubar/app-menu.png` and `app-title.png`. The SwiftBar pictures and `site-images` mode are gone; `--check` now requires the figure's description to carry the demo numbers.

## Latest (2026-10-20): 0.4.0 release prep

**Owner decision:** ship 0.4.0 stable to `@latest`; the app goes out as a Developer ID-signed, notarized `Peras.zip` (`--app` install, no CLI download). *Superseded by the fourth round above: the zip is sold on Polar with updates included, and GitHub gets release notes only.* macOS 13 and Intel stay untested: built for both, tested on Apple silicon with the current macOS. A failed first open keeps SwiftBar's menu.

**Runtime line.** The app used to require its exact runtime version, so every later `peras update` (0.4.0 → 0.4.1) would have broken the downloaded app with a message that couldn't fix it. It now runs any runtime from its own major.minor line; another line gets "Peras X needs its own app. Download Peras.zip…" (`LaunchFailure.runtime`). The bridge's protocol number stays the wire contract, so a patch release must not break protocol 1. LaunchChecks **41**.

**Signing.** `package-local.mjs --identity "Developer ID Application: …"` now signs with a secure timestamp (was `--timestamp=none`, which notarization rejects). `native/scripts/notarize-release.mjs --app …/Peras.app --output DIR [--profile peras]` checks Developer ID + hardened runtime + timestamp, submits with the owner's notarytool keychain profile, staples, requires `spctl` "Notarized Developer ID", and writes `Peras.zip` + `.sha256`. The pear notification helper stays locally built and ad-hoc: npm extraction isn't quarantined.

**Upgrade.** Throwaway home, stand-in open/osascript/pkill/pgrep: 0.3.2 (main) setup + codex setup + SwiftBar menu + `set weekly 80 pause` + `pause` → `peras update`'s steps on 0.4.0 → pause still denies the hook, status/why/doctor read it, plugin replaced (one file), `~/.peras` only gained `codex`, `hook-memory`, `notifications-native-v1`, `receipts` → back to 0.3.2: pause still denies, resume allows, one plugin. 0.4 setup builds the pear helper with the real bundle id: the throwaway copy was registered with LaunchServices and is now unregistered; the owner's helper stays registered.

**Downloaded copy.** Every launch path opens `~/.peras/native/Peras.app` by path (CLI, `menubar open`, notification click). A `Peras.app` left in Downloads could still be opened from Spotlight and would run on the same root, so only the installed copy applies the Open at Login default, and the install output says the download can be deleted.

**Verification.** `npm test` 335 (333/2), package, demo; native **489** (headless 21, bridge 38, presentation 72, desktop 45, menu 234, recap 38, launch 41); RecoveryChecks 43. npm tarball installs and runs `peras status`.

## Latest (2026-10-20, third round): no focus ring on open, setup card stays done

**Focus.** With Keyboard navigation on, AppKit rang the pin on every open. `popoverDidShow` now clears the first responder, so nothing is focused until Tab (first Tab: the pin). Keyboard probe `noControlFocusedOnOpen` 3/3; ax Tab/Shift-Tab walks reach every menu button on all 8 menu surfaces. Notifications, More and Setup windows show one Tab stop in the ax walk; no earlier keyboard-navigation-on baseline exists.

**Setup card.** Health `unverified` (a live guard seen for these hooks, not in the last 15 minutes) no longer counts as unfinished setup or a health card: an idle Codex reopened "Finish Peras setup" every 15 minutes. `needs_activation`, `setup_missing` and `hooks_disabled` still do. Native menu checks 234.

## Latest (2026-10-20, second round): full screen, Resume, Open at Login

**Full screen.** Over another app's full-screen Space, macOS revoked Peras's activation while the popover was still showing, so the transient menu closed (several ⌃⌥P presses needed) and a pin during the show left an unfocused titled panel. Over full screen, `open()` now shows first and activates in `popoverDidShow`; a pin during the show waits for `didShow` (also on the desktop, up to ~0.4 s on a cold open). The desktop open path is unchanged. Dev probe `--desktop-probe OUT --fullscreen` (needs another app already full screen): 18/18 on 4 runs, 13/18 on the old code. A key pressed in the first 0.2–0.6 s over full screen still goes to the full-screen app. Only engages when another app's window covers the whole display. Evidence: `/private/tmp/peras-v04-fullscreen/`.

**Resume.** When only your own pause holds, the card offers a plain **Resume** (untimed, as clearing it always was); a rule stop keeps **Resume for 1 Hour**. A timed resume that only clears your pause is logged "Resumed by you." The setup card names the agent it can't pause yet ("Until then, Peras can't pause Codex.") when another is protected.

**Open at Login** (production builds only; development builds never touch login items). On by default once, after the installation checks out; Settings › General has the switch, and the choice is kept in `native/desktop.json` (`openAtLogin`, additive). If a rollback leaves an older runtime (0.3) under this app, the app removes its login item and quits instead of showing a broken second pear.

**Verification.** `npm test` 335 (333 pass / 2 skip), package and demo; native **484** (headless 21, bridge 38, presentation 72, desktop 45, menu 232, recap 38, launch 39).

## Latest (2026-10-20): five-hour reset, notification clicks, accessibility

**Five-hour reset.** Each agent's header shows its five-hour reset beside the % ("resets 19:46", the weekday on another day), also in the tooltip and VoiceOver label. It is hidden for expired or missing readings and once the reset has passed. The backend always sent it; the redesigned row never drew it.

**Notifications.** v0.4 keeps 0.3's generated helper (`eu.vertias.peras.desktop-notifications`, ad hoc, `PERAS_HOME/notifications-native-v1`) as the only poster, so permission, actions and rollback are unchanged; Peras.app posts nothing. Open Status or a click on a notification brings a running Peras.app of the same `PERAS_HOME` forward, otherwise opens the status page; a quit app is never relaunched. Pending: the signed helper identity at the Developer ID step (a new bundle ID asks for permission again), and a first real click proving the menu survives the helper's activation. Assessment: `/private/tmp/peras-v04-notif/assessment.md`.

**Accessibility.** An in-process audit of the development build's own AX tree (menu, pinned panel, Settings, setup; live and all 8 fixtures) found nine issues, now fixed: the shortcut picker and its glyph options are named; the rail reads as an image; the attention block and recap caption are no longer read twice; details have single full stops; menu lines drop the shortcut glyphs from their names; the tooltip and right-click menu sit on the header and rail, not every child; a missing reading reads "No reading"; disabled reasons are hints; the filling pear says "paused" or "warning line crossed".

**In-process QA probes** (development builds only): `node native/scripts/launch-built.mjs ROOT --keyboard-probe OUT [--race-only [--escape-offset-ms N] | --ax-export [--fixture NAME] --direct]` and `--desktop-probe OUT --spaces`. They post events only to Peras's own queue and simulate Space changes; `--ax-export` needs a terminal already trusted for Accessibility. Keyboard 12/12, AX export 9/9 live and fixtures, Spaces 14/14. The close-during-show race did not reproduce in process (0/6 menus left open with or without the deferral, at early and late Escape), so the deferral stays until a physical test decides it. None of this replaces the physical keyboard, VoiceOver, Spaces and full-screen check. Evidence: `/private/tmp/peras-v04-qa/evidence/`.

**Owner device QA (2026-10-20, dogfood e0769b8):** a real notification click and Open Status bring the menu forward, and a quit app is not relaunched; physical keyboard navigation (Tab, Space, Escape, ⌘,, ⌘W) and VoiceOver in the menu and Settings work as intended. Still unchecked by hand: Spaces, full-screen, and the six fast Escapes after a cold launch.

**Verification.** `npm test` 334 (332 pass / 2 skip), package and demo checks; native checks **471** (headless 21, bridge 38, presentation 72, desktop 42, menu 225, recap 38, launch 35). RecoveryChecks not rerun (no launch/install change). Evidence: `/private/tmp/peras-v04-combined/`.

## Current local completion (install recovery, Node probe, first-open keys, performance)

**Interrupted installation.** `Peras.app.previous` is the last copy that checked in, removed only after a successful hello. Every bundle delete renames to `Peras.app.trash-*` first, and a crash between any two steps is repaired by `recoverInstall`, which runs at the start of install, `menubar open` and a no-`--app` native install. A failed rename puts the prior app back at once. A retry after an interruption reports `replaced: true`, and its failed hello restores the last good bundle. Tests fault every filesystem step in process and SIGKILL a real child before and after each step, for both the restore and confirm endings; unrelated SwiftBar plugins stay byte-identical. A real-`ditto` repro on the signed package passes: `/private/tmp/peras-v04-claude-install/result-final.json`.

**Supported-Node probe.** Cause: macOS assesses a newly written executable on its first exec. A freshly copied real Node took **3.0–8.1 s** on first run (0.01 s user), and fresh small scripts occasionally exceeded 1 s under load. The 1 s per-candidate deadline therefore expired, the flaky check failed, and a working Node was refused after every Node upgrade. Each candidate now gets 15 s inside a 30 s total budget, with bounded output and owned-child cleanup unchanged. The CLI waits 20 s for the hello (180 s on a quarantined first open). An install records the Node that just ran the CLI, which macOS has already assessed, so this fits. The open gap: a hung first candidate (15 s) followed by a never-run fallback (up to 8 s) passes 20 s, and an `--app` install would then roll back. Fresh real Node at 1 s: 4/4 refused. At 15 s: 5/5 accepted in 3,629–8,107 ms. Development builds record the last outcome and time, shown only when a check fails; production excludes it. New checks cover the total budget with hung candidates (LaunchChecks **35**) and a never-run Node copy under the default probe (RecoveryChecks **43**; 1,452 ms first run). Evidence: `/private/tmp/peras-v04-claude-probe/summary.json`.

**First-open keys.** A cold first open blocks long enough for Escape to arrive before `didShow`. Escape or a pear click left Peras active with no window, which blanks the menu bar; closing an unpinned menu now yields focus back. NSPopover can also drop a close that arrives mid-show: an instrumented build with only the focus fix kept the menu open after an Escape handled 1 ms before `didShow` (1 run). The build with neither fix closed in 2/2 such runs, so the drop depends on timing. A close during the show now waits for `didShow`; when AppKit would have honored it, this costs the rest of the show animation (about 0.36 s on a cold open). The development-only `--keyboard-probe` (`node native/scripts/launch-built.mjs ROOT --keyboard-probe OUT`) posts Escape into Peras's own queue with `NSApp.postEvent`, never system-wide, and checks **12** items:
- first Escape lands before `didShow`, closes and hands focus back
- reopen and a second Escape after `didShow`
- pear-click close
- the pinned panel takes keys, and Escape on it acts like its close button: unpinned, focus back (AppKit's `cancelOperation` behavior, kept as is; whether pinned Escape should do this is the owner's call)
- the Peras-owned Settings window is key on the active Space and closes back to accessory with focus returned
- no Space changes

Without the fixes, 3 checks fail (first and second Escape, pear click: closed, but Peras still frontmost). With them, 12/12 pass on 3/3 runs and over a throwaway full-screen app (Settings correctly stays accessory there). This is in-process automated evidence; physical-keyboard QA remains pending. Evidence: `/private/tmp/peras-v04-claude-final/keyboard/`.

**Performance**, by the documented methods on development builds from identical inputs, all phases valid. Against the historical figures, visible CPU (2.54% median) is under 2.89%. The cold median (117.1 ms) is still above 110.19 ms, and final5 also measured 114.7 ms on this Mac today, so the cold-draw miss remains open:
- Cold first visible draw, alternating fresh processes: final5 **114.7 ms** median, current **117.1 ms**, with no hidden draws.
- Live native CPU: closed **0.18%** (final5, 7 runs) vs **0.14%** (current, 10 runs). Visible: final5 median **2.33%** (2.27–2.96%), current **2.54%** (2.18–2.91%).
- High visible readings bunch in the first runs after a root is built; the same binary later read 2.18–2.37%. An A/B build with final5's app file showed the same pattern, so no source-attributable change.

No optimization was made; art, patrol speed, phase, reactions and Reduce Motion are untouched. Evidence: `/private/tmp/peras-v04-claude-perf/summary.json`.

**Verification.** All runs used throwaway homes and a blocking fake Codex:
- **330 tests / 2 skips**, package and demo checks; zero fake-Codex executions.
- Native checks **430** (desktop 42, launch 35, menu 184, recap 38, headless 21, presentation 72, bridge 38). The fixture-mode menu probe exports every image except the setup window (`incomplete_cached_text`), identically on final5. Live mode refuses the probe by design.
- RecoveryChecks **43**; macOS 13 arm64/x86_64 compile/link.
- Keyboard, desktop and duplicate-focus probes.
- Fresh-account install/recovery/migration/rollback against the new package: **98 assertions / 44 commands**, zero cleanup errors.

Build `/private/tmp/peras-claude-v04-final`; universal ad hoc package `/private/tmp/peras-claude-v04-package/Peras.app` (47 files, executable SHA-256 `43febb0b252332f0a93b66d61399e59c880e9443e3fc878f70189dbfade53925`) passes strict deep signature verification and contains no keyboard-probe or probe-diagnostic strings. Evidence index: `/private/tmp/peras-v04-claude-final/final-review.json`.

Owner device QA on fbdea25 (2026-10-20): one-press menu and pin over full screen, no focus ring on open, setup card stays done with Codex idle; Spaces, notification clicks, keyboard and VoiceOver passed earlier that day. Still pending, in order: Developer ID signing and notarization of the release build (owner's certificate); download/quarantine/offline trust on that notarized zip; Open at Login on a real restart. macOS 13 and Intel: owner ships untested (2026-10-20).

## Previous recovery and production verification (final5)

Recovery now stops quietly on incompatible core protocol/enums, invalid installation data, unavailable Node, or repeated bridge failure. Transient stops get at most three automatic retries; a hello or one-frame snapshot does not reset that budget. Cached readings are separate, read-only and age-labelled: missing/expired data stays unusable, all actions and links are disabled, animation stops, and the status item drops current-looking percentages. Uncertain commands and old tokens are never replayed. After repair, deliberate Retry Connection or reopen rereads the launch record against the original bundle/runtime version; rapid retries coalesce. Wake/clock refresh does not restart terminal recovery. The shared provider `readError` covers settings and usage failures, so the fixed message is “Peras couldn’t read settings or refresh usage.” No raw diagnostics or private paths are displayed.

The production package compiles **38 runtime Swift files** from **78 recorded inputs** into **47 bundle files**, without tests, probes or fixture resources. All developer arguments are rejected before state writes; the separate development build retains its guarded fixtures, diagnostics and process checks. The original pear icon passes exact normalized RGBA comparison for all **20 generated/extracted representations**. Settings is now a Peras-owned AppKit window hosting three SwiftUI pages. Setup has five factual steps; configuration, observed activation and protection-test success remain distinct.

Accepted build: `/private/tmp/peras-native-recovery-final5`; universal macOS 13 local-only package: `/private/tmp/peras-native-recovery-package-final5/Peras.app`. Executable SHA-256: `b5c8d025655e70a230f8c5ebf818345ae1b06c41f0be3df25389b32ffcede2b4`. The ZIP under `/private/tmp/peras-v04-recovery-u96ydidj/archive-final5/` is **1,432,511 bytes**, SHA-256 `cccc6b4805dc7d06485502b2d019e6f88b2784c22cb744081629fa6ce52b92b1`; fresh extraction and signature verification pass. All 78 sources, 47 bundle files, and the post-Claude checkpoint’s 138 protected plus nine retained hashes match.

Repository checks pass: **325 tests / two skips**, package and demo, with zero fake-Codex executions. Independent final3 native **429** plus recovery **42** checks pass, including 18 owned children reaped; final4 removes one EOF newline, and final5 changes only the fixed message above. Final5 reruns all 429 native checks. Actual final5 fresh-account installation, recovery, migration, rollback and quit pass **98 assertions / 44 commands**, with zero cleanup errors or fake-Codex calls across three accounts. Final5 direct UI review confirms the exact settings-or-usage message without raw canaries, unknown readings without Demo, owned Settings without Diagnostics, and terminal cached Node guidance without provider/link actions. Explicit Retry Connection recovers in the same app process with a fresh bridge. All review apps are stopped/unregistered; fake-Codex executions remain zero. Current evidence: `/private/tmp/peras-v04-recovery-u96ydidj/final-review.json`, including `final-integration/ui-proof/{observations,recovered,cleanup}.json`.

At final5, the supported-Node probe flake, the interrupted `installApp` swap/restore P2, first-open Escape and performance remeasurement were open; the section above closes them. Physical Escape QA is still unproved. Developer ID/notarization remains deferred; notification migration, download/quarantine/offline trust, actual macOS 13/Intel and physical desktop/accessibility QA remain separate gates. No real-home testing or publication occurred in this verification.

## Historical E0 local production verification (before recovery cleanup)

The normal installed app now starts from the external schema-1 `native/launch.json` written by `peras menubar install --native`. It uses the canonical parent of the installed `native/Peras.app`, so Finder's stale inherited `PERAS_HOME` cannot select another account. The launch record, bundle and installed CLI must have the same runtime version. Installation paths and environment remain outside the immutable bundle. Fixture mode and the guarded synthetic development bridge remain available; production has neither a Demo nor a Preview label.

Node resolution probes the recorded absolute executable and recorded fallbacks with `--version`, off the main thread, with bounded time/output and owned-child cleanup. It carries only allowed launch environment values, the actual configured HOME and the canonical state root; empty/relative PATH entries are removed. Missing Node shows the current-LTS repair text. After repair, a deliberate app reopen retries resolution in the same app process; rapid reopens coalesce into one bridge. Existing connected/reconnecting clients remain intact, and mutation tokens are never replayed. SIGTERM follows normal app termination, reaps the bridge and retires the bridge/monitor records.

The actual clean-account setup window distinguishes hook installation, observed activation and an isolated protection test. Missing/outdated providers get their own command: `peras setup` for Claude Code and `peras codex setup` for Codex. Disabled hooks point to their settings and provider doctor command. Reinstalling is not claimed to enable disabled hooks. Test Protection stays disabled until an eligible backend offer exists; merely opening Setup makes no provider configuration changes.

`native/scripts/package-local.mjs` builds both macOS 13 slices from an exact source snapshot, checks resource inputs, combines a universal executable, and verifies the resulting signature. Its default is an ad hoc **local-only** signature. It does not install, download, upload, notarize or staple. The bundle ID is `eu.vertias.peras.native`, separate from the existing notification helper. Numeric bundle version is 0.4.0; `PerasRuntimeVersion` retains `0.4.0-preview.1`. The cross-platform CLI payload is unchanged.

Reproduce a disposable build/package from `~/peras-v04`:

```sh
PERAS_E0_BUILD="$(mktemp -d /private/tmp/peras-native-e0.XXXXXX)"
PERAS_NATIVE_RUN_ROOT="$PERAS_E0_BUILD" ./script/build_and_run.sh --headless
HOME="$PERAS_E0_BUILD/home" PERAS_HOME="$PERAS_E0_BUILD/state" \
CLAUDE_CONFIG_DIR="$PERAS_E0_BUILD/claude" CODEX_HOME="$PERAS_E0_BUILD/codex-home" \
PERAS_SWIFTBAR_DIR="$PERAS_E0_BUILD/swiftbar" \
PATH="$PERAS_E0_BUILD/fake-bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
node native/scripts/package-local.mjs --from-build "$PERAS_E0_BUILD" \
  --output "$PERAS_E0_BUILD/component"
```

The earlier accepted E0 source build was `/private/tmp/peras-native-e0-setup-final`; its production app is `/private/tmp/peras-native-e0-setup-package-final/Peras.app`. All **71 source inputs, 52 production bundle files and 139 protected backend/support inputs** match their recorded hashes. The only source changes after the 98-assertion recovery candidate are provider-specific setup guidance and eight semantic checks. Binary SHA-256: `3f1ae421f0d83f12cd8fa6edbcb5b29578bbe9b8111fcf046e2a4c4fb53dcd8b`. Source provenance SHA-256: `59043f7fab5835dad470b92107e59499c947a33b9cca96e98227d5d29f660e4c`; package provenance SHA-256: `6837a18463b92cb84fdb44aef2be4559998091944360b10f8db05345af7cc2c7`.

- Repository checks pass: **317 tests / 2 known skips**, package (**60 files / 198.3 kB**) and demo. The blocking Codex guard ran zero times. All backend/support inputs are unchanged since those checks.
- Independent checks on the final production executable: **21 native + 38 bridge + 72 presentation/privacy + 42 desktop + 96 menu + 38 recap + 34 launch = 341 assertions**, all eight serializer fixtures and 2,354 original patrol comparisons.
- Actual installed CLI/app integration: **98 assertions / 44 commands**, with fresh isolated clean, custom-root/space/symlink, and SwiftBar-migration accounts. No app/root/development flags, signature check or handshake were mocked. Sparse GUI PATH, moved/unsupported Node fallbacks, repair then rapid reopen, repeat install, explicit update and clean quit pass. Migration retires only Peras's plugin; rollback preserves other plugins. A validly signed incompatible local candidate reaches the actual handshake timeout, then restores every byte of the prior bundle and preserves SwiftBar.
- With the native UI stopped, the actual installed hook shell denies a synthetic paused tool request and permits it after explicit CLI Resume without a fail-open/error fallback. This does not prove activation in a real Claude Code/Codex host. The real Codex binary was never started; installation tests never invoke their blocking Codex guard. Native-only installation does not install hooks into a clean account.
- Final direct production UI review confirms real missing setup/unknown readings, both setup commands, truthful disabled Test Protection and no Demo/Preview label. All task-owned review apps and bridges are quit/reaped afterwards; the earlier read-only fixture preview is left alone.
- The local archive is `/private/tmp/peras-v04-e0-review-k08xtc2a/archive-final-proof/peras-native-0.4.0-preview.1-macos-universal-local-only.zip`: **1,824,613 bytes**, app logical size **6,212,521 bytes**, SHA-256 `8a08243524b00d5b8689ee65682305e34369e96ee415ddf9fb80acf5583635b6`. A new ditto extraction matches all 52 bundled files and passes strict signature verification. Bundle scans find no owner-home or task build/review path markers.

Evidence is under `/private/tmp/peras-v04-e0-review-k08xtc2a/`: `repo-checks/`, `parent-final-production-headless/`, `install-proof-20261019-101229/report.json`, `archive-final-proof/archive-proof.json`, and the final actual-UI/cleanup records. Builds run on macOS 27.0 (26A428), SDK 26.2; both architectures compile/link for macOS 13, but actual macOS 13/Intel runtime QA is still pending.

The owner chose to finish local verification and defer Developer ID/notarization. No Developer ID Application identity is available in the inspected keychain; no signing credential, artifact upload or notarization submission was used. The optional explicit Developer ID path in the local packager omits a secure timestamp and is not a notarization pipeline. Browser/npm download provenance, quarantine prompts, offline first launch, fresh-VM trust and the immutable signed notification helper/action migration remain distribution gates. The existing notification helper still generates machine-specific metadata and ad hoc signs locally; its identity and tickets were reviewed read-only, not changed or delivered by this test.

This E0 pass does not remeasure menu performance. The measured compact-menu source/art/steady animation remain as recorded below; the prior cold-draw median of 110.19 ms and visible native CPU of 2.89% remain open targets, not proof for the production launch path. Physical keyboard/VoiceOver, actual system accessibility preferences, external-display/Spaces/fullscreen and macOS 13/Intel checks remain manual gates. E0 changes are uncommitted; nothing is staged or published, and no real-home setup was performed.

## Current compact menu redesign

The current menu follows `plans/v0.4-menu-redesign.md`: 320 pt wide, system popover material, one compact row per provider, thin configured stop markers, and Bar/Text/Off weekly usage. The normal fixture is **358** pt tall; attention grows it only when needed, with a scroll fallback for short screens. Mascots patrol freely; their position stays decorative. Clawd renders at 22 × 15.5 pt with an 11 × 9.5 pt cup; Codex renders at 30 × 21 pt with a 12 × 10.5 pt cup. Geometry is backing-pixel snapped (Clawd is 16 pt high at 1×). Pause retains the current position and phase. There are exactly the original three bounded reactions.

Settings is a Peras-owned AppKit window with General, Notifications and More toolbar tabs hosting SwiftUI pages. Setup has a separate owned window; fixture/diagnostic controls have another in development builds only. They share the existing store and backend; opening a window never installs hooks or claims activation. Five factual setup steps determine the completion count and dots. Test Protection uses the real eligible backend offer and does not manufacture a live protection receipt. The failure-policy display remains read-only.

The menu uses rounded rolling percentage digits, bounded real-reading bar transitions, finite attention/style springs, a pear-green accent, provider-brand five-hour fills and neutral weekly usage. Paused percentages are indigo and paused fills are subdued. Five-hour warning emphasis uses only backend five-hour threshold state; a warning from a different window does not imply a five-hour crossing. Resume immediately publishes “Resuming…” and waits for the acknowledged, refreshed verdict before removing coffee. Pin/checkmark effects are availability-gated to macOS 14; the macOS 13 fallback is static. Reduce Motion stops patrol and removes the added transitions. Reference-panel accent contrast exceeds 3:1 in both appearances and Increase Contrast variants; simulated previews are not an actual system-accessibility or optical contrast test.

The third menu-bar display, Filling pear, uses nine cached original-coloured, non-template pixel-pear frames that adapt to appearance, with indigo/orange state tones, quantized to eight fill steps from the busiest provider’s known five-hour reading. Missing/expired readings use an outline; the accessibility label includes the actual value and freshness. Settings changes forward only the exact signed backend offers. Unknown additive presentation styles disable their selector and fall back to the legacy setting; core protocol enums remain strict.

Weekly recaps consume only backend-confirmed facts. A clipped/hidden caption does not mark a recap seen. First actual visibility persists the provider/account/recap identity under the resolved root’s `native/recap-seen.json`; fixture previews use a separate ledger. The caption remains for that open session, then clears on close/wake/account change. Reopening or reconnecting cannot replay a seen identity. A different account has its own first display even if the backend reset ID matches. Recaps never manufacture a reset greeting. Unknown pause coverage is omitted, and “to spare” requires `atReset`; last-reading time appears only in private help.

Recap Share Image opens the same private-by-default native preview. Its renderer receives only a separate sanitized model and the two original mascot images. Even explicit inclusion exports only known provider enums, finite percentages, a pause count when known, and `atReset`; no recap/account IDs, labels, paths, tokens or exact times. Opening, repeated opening and close/reopen restore private models and pixels. Copy/Save remain explicit actions; probes do not use the clipboard or open a save panel.

### Menu redesign verification before E0

Verified on macOS 27.0 (26A428), SDK 26.2, with a macOS 13 deployment target. The accepted frozen build is `/private/tmp/peras-native-menu-perf-final`; the final isolated audit copy is `/private/tmp/peras-menu-redesign-xsghpg1b/complete-native-final`. The read-only owner preview is `/private/tmp/peras-menu-redesign-xsghpg1b/owner-preview/PerasNativePreview.app`. All **67 source inputs, 52 bundle files and 139 protected backend/support files** match their recorded hashes; nothing is staged. Binary SHA-256: `dd7324afda5210c9fb78a42337df8f86d6b4bbd7661431d631175f6d09f98e46`. The local ad hoc signature verifies; arm64 and x86_64 compile/link for macOS 13. This does not establish signed installation or an actual Intel/macOS 13 runtime pass.

- Repository checks: **317 passed / 2 known skips**, package check (**60 files / 198.3 kB**) and demo check pass, with zero executions of the blocking real-Codex guard. Backend inputs are unchanged since these checks.
- Independent native checks: **21 native + 38 bridge + 72 presentation/privacy + 42 desktop + 88 menu + 38 recap = 299 assertions**, eight real serializer fixtures and **2,354** original patrol comparisons.
- All 14 menu cases pass. Actual content is 320 × 358 pt normally, 340 pt with weekly Text, 306 pt with Off, 464 pt paused, up to 478 pt for the tested stopped cases and 396 pt with recap. No tested case needs scrolling. Settings is 520 × 548 pt; Setup is 500 × 500 pt. Pin/unpin, shared ownership, hidden-timer and recap visibility/account/reopen checks pass.
- Actual native UI review verifies all three Settings tabs, the signed Resume/display/weekly-style controls and Setup Test Protection. The aggregate menu-export probe remains `ok:false` solely because the own-view Setup PNG omits cached text (`incomplete_cached_text`); direct app accessibility/screenshot review covers that window. A successful export or process exit alone is not treated as complete UI evidence.
- The actual-layer pause→resume/reading-change probe passes all eight repaint checks without forced invalidation. Two current 2× raster proofs check **1,490 opaque baseline pixels**, including the cup, with zero RGBA mismatches. Fractional nearest sampling accepts either texel only at mathematically exact equal-distance boundaries; it does not permit color or position tolerance. The retained shifted-image and RGB/alpha mutation canaries reject altered pixels.
- Final private and recap PNG audits pass: exact sanitized models, opaque 1200 × 1080 output, independent CRC/scanline/metadata allowlists, private reset on repeated opening and close/reopen, and opt-in pixels materially different from private. Only color-space/dimension metadata is present. Font-edge RGB quantization is bounded to 1/255. All 14 recap PNGs are audited; clipboard writes and save panels remain zero.

Evidence is retained under `/private/tmp/peras-menu-redesign-xsghpg1b/`: `repo-checks-redesign-final`, `verified-perf-final/parent-headless`, `verified-perf-final/parent-menu-proof`, `verified-perf-final/parent-desktop-proof`, `verified-perf-final/parent-repaint-corrected`, `verified-native-final/parent-actual-ui-review.json`, and `complete-native-final/parent-share-proof`.

The 60 Hz rail previously constructed presentation models and formatted reset dates on every tick. Those paths now read snapshot-cached scalar usage; reset text is lazy outside the animation loop. Real snapshot observation is retained, so authoritative pause/resume changes repaint both coffee and fill. This removes the measured 12.11% native CPU regression without changing patrol speed, phase, reactions, art or draw timing.

All accepted CPU phases below had actual visible/unoccluded windows when applicable, valid motion state and zero unexpected Space/visibility/activity transitions. Native CPU uses `getrusage`; 100% means one core. Live builds use the same frozen **59-input backend** and newly seeded disposable homes. Separate Node samples lie inside the native phases but have different bounds; the values must not be added as a synchronized total.

| Component / mode / state | Prior enlarged D | Compact final | Final interval / ticks |
| --- | ---: | ---: | --- |
| Native / live / closed | 0.2197% | 0.1996% | 15.571 s / 0 |
| Native / live / visible patrol | 2.3845% | 2.8899% | 15.016 s / about 900 |
| Node / live / closed | 1.4500% | 1.4568% | 15.099 s / — |
| Node / live / visible patrol | 0.8496% | 0.8410% | 14.587 s / — |
| Native / fixture / closed | — | 0.1274% | 6.300 s / 0 |
| Native / fixture / visible patrol | — | 2.9069% | 6.014 s / 360 |
| Native / fixture / paused | — | 0.0443% | 6.300 s / 0 |
| Native / fixture / Reduce Motion | — | 0.6012% | 6.300 s / 0 |

Closed/static/Reduce Motion stop the sprite timer, not all process work. Final visible CPU remains above the prior enlarged D observation and historical sprite-only range; no overall CPU improvement is claimed. Measurements exclude short-lived fake-reader descendants, WindowServer and GPU. The Node counter conversion is independently calibrated against a known CPU interval (ratio 0.999968).

Controlled alternating fresh-process cold opens after two seconds of data readiness measured prior D **121.12 / 120.22 / 103.96 ms**, final **110.73 / 83.55 / 108.73 ms** (medians 120.22 → 108.73 ms). Final warm reopens were 47.89–58.57 ms. A later control repeat of the accepted final build measured **118.30 / 110.19 / 100.00 ms** (median **110.19 ms**), warm 39.22–49.55 ms. These are first actual visible/unoccluded SpriteCanvas draws, with zero hidden draws/ticks and retained reopen phase; they are not optical or reboot-cold latency, and three observations per comparison do not establish percentiles. **The under-100 ms gate is still not consistently met.**

A single hidden-open animation experiment was tested and rejected: its median was 106.15 ms versus the 110.19 ms control, all three opens still missed 100 ms and warm reopen worsened. Its source change was reverted byte-for-byte; the accepted source remains exactly the measured final build. A separate fixture CPU scenario first drew in 235.43 ms after its closed phase; it is retained as a different condition, not folded into the two-second cold comparison. One earlier CPU run interrupted by a Space change is explicitly excluded.

Performance evidence: `perf-before-clean/parent-live-cpu`, `perf-after-clean/parent-live-cpu`, `complete-native-final/parent-renderer-cpu`, `paired-cold-final/paired-cold.json`, `paired-cold-candidate/paired-cold.json`, and `process-metrics-calibration-19.jsonl` under the review root. The experimental bundle is retained at `/private/tmp/peras-native-menu-cold1` and is not the accepted preview.

The development app uses the live local bridge and signed offers with synthetic account readings. Fixture selection, debug reactions and share canaries remain test-only and do not dispatch live mutations. Failure-policy editing remains display-only by owner instruction. The E0 section above now covers production `launch.json`, Node recovery and the verified local installation/migration/rollback round trip. The default development wrapper retains its explicit guarded bridge configuration; Developer ID/notarization remains deferred. OS accessibility preferences were simulated locally without changing global settings; full physical keyboard/VoiceOver, external-display/Spaces/fullscreen and actual macOS 13/Intel runtime QA remain manual. No real-home setup, real Codex, commit or publication was performed for this redesign.

The historical A/C/D sections later in this file retain the earlier presentation and measurements. Their 400 pt menu and enlarged 40 × 28 pt sprite descriptions are superseded by the current compact menu above.


## Build and launch

From `~/peras-v04`:

```sh
./script/build_and_run.sh
./script/build_and_run.sh --headless
./script/build_and_run.sh --compile-check
./script/build_and_run.sh --probe
./script/build_and_run.sh --share-probe
./script/build_and_run.sh --desktop-probe
./script/build_and_run.sh --benchmark --pinned --seconds 15
./script/build_and_run.sh --benchmark --seconds 15
./script/build_and_run.sh --benchmark --fixture normal-usage --seconds 15
```

Every invocation defaults to a new `/private/tmp/peras-native-run.XXXXXX` directory. `PERAS_NATIVE_RUN_ROOT` may select a dedicated scratch directory for reuse. The bootstrap validates its canonical location and existing symlinks before writing. It overrides `HOME`, `PERAS_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PERAS_SWIFTBAR_DIR` and PATH with isolated values, prepending the fake executable directory. Hook/config records are seeded only in that scratch home, with the current package version. The optional `PERAS_NATIVE_SCENARIO=daily-exhausted` selects illustrative daily-budget exhaustion; the default is normal usage.

The wrapper prints the app/config/runtime paths. Build output, module caches, exported sprites, source snapshots and evidence stay under the scratch root. Reusing a root sends a stop request only to its canonical-root app instance before building. There is no generic process kill, live setup, publication or deployment. `--debug` passes the same app arguments to LLDB; `--logs`, `--telemetry` and `--verify` are also available. The Codex Run action calls this script.

To launch an immutable existing build without recompiling it, use the helper, which exports the complete isolated environment from its generated config:

```sh
node native/scripts/launch-built.mjs /private/tmp/peras-native-live-final --probe /private/tmp/peras-native-live-final/review-probe
node native/scripts/launch-built.mjs /private/tmp/peras-native-live-final --benchmark /private/tmp/peras-native-live-final/review-live-cpu --seconds 15
node native/scripts/launch-built.mjs /private/tmp/peras-native-live-final --benchmark /private/tmp/peras-native-live-final/review-renderer-cpu --fixture normal-usage --seconds 15
```

Use a distinct evidence directory for each run. `--fixture NAME` selects fixture-only mode: no backend child or real action dispatch is created. The eight read-only serializer fixtures are `missing-setup`, `normal-usage`, `manual-pause`, `scoped-stop`, `daily-exhausted`, `suggestion-pause`, `pacing-text` and `weekly-recap`. Their chooser, pause/resume/reset simulations and fixture labels live in a separate diagnostics window. `--open-delay SECONDS` changes the probe's initial delay.

## Live connection and controls

`Services/BridgeClient.swift` starts the configured absolute Node executable with the absolute CLI path and fixed argv `menubar bridge --protocol 1`; it parses no shell command. Its explicit environment comes from the scratch config, whose state root must match the app's canonical instance root. A process-owned lock excludes symlink aliases and duplicate instances. Duplicate launches focus the existing instance.

The byte framer bounds each line to 1 MiB and decodes UTF-8 after assembling the whole line. The session requires a protocol-1 hello first, pins `bridgeInstance`, rejects mismatched identities and ignores superseded revisions. Initial hello, initial snapshot, partial-line and idle deadlines are bounded at 5, 10, 10 and 75 seconds respectively; the idle allowance accommodates approximately 30-second token rotations. Failed children retry quietly with exponential delays capped at 30 seconds. Stale callbacks cannot deliver state after their connection is invalidated. Child stderr is discarded rather than shown; diagnostics record fixed failure classes and bounded metadata.

Buttons come from actual snapshot offers and their `eligible`/`disabledReason` fields. Each click uses a fresh UUID and the exact current offer's parameters and token. There is one pending mutation per provider, plus a separate global-action slot. Results never change usage, verdicts or patrol state locally. Success and `state_changed` hold the provider blocked until a subsequent authoritative snapshot; other refusals release the pending slot without implying a saved change. An earlier snapshot received before the acknowledgement does not count as confirmation. Token rotations refresh offers; old, modified or disabled offers cannot dispatch. Disconnects clear offers and pending commands, report uncertain results, and **never replay a mutation** after reconnecting.

The native Settings window consumes only signed `snapshot.settings.actions` offers and displays authoritative values. Mascots off hides sprite/cup layers, stops their timer and retains phase while usage fills remain. Weekly Bar/Text/Off controls the weekly presentation; backend stop and pacing facts remain authoritative. Usage and Filling pear displays refresh from five-hour readings on snapshots; notification preferences stay labelled as events. No optimistic local flip or automatic retry is made. A `busy` result waits for a subsequent snapshot and permits one explicit retry of the matching current offer, with a new click ID; disconnect or account-context changes discard the retry intent. The UI does not fabricate offers or hardcode which provider operations the runtime supports. Provider pause and daily Extra have been exercised through the actual Node engine. Backend correctness/distribution gates remain separate; see the parent-owned [backend review](reviews/backend-milestone-b.md).

Normal termination closes stdin, stops and reaps only the child the app owns; a bounded escalation handles an unresponsive child. Descriptor-scoped no-SIGPIPE protection handles a child that closes its command input while keeping its output/process alive.

## Historical milestone C presentation and private sharing

The 400-point product view uses one two-row cached sprite canvas for actual five-hour fills and configured global thresholds; weekly bars, current stop cards and separate planning meters follow below. Patrol position is decorative, including for VoiceOver. Missing/expired values have no current-looking percentage fill. Threshold glyphs and text distinguish warn/ask/pause; scheduled lines are explicitly conditional. Swift does not evaluate schedules or infer exemptions. Only the backend verdict/reasons describe a current stop. Project-scoped rules remain in the observed-project card, including the fixture's 48% observation against its 40% project rule; they never become global bar markers.

Pause/approval cards retain every reason, scope, observed value, line and expiry. Resume wording distinguishes lifted reasons from replacement of an old bypass expiry with the offered expiry, including a potentially shorter expiry. Daily Extra describes all matching global daily meters and leaves unrelated stops in place. Active profile/modified state remains a compact read-only private UI detail. Keyboard-native offered controls retain transport eligibility/blocking; fixture controls are read-only and simulations live in a separate diagnostics disclosure. Planning values remain separate point meters with estimate/waiting labels, reserve targets and non-working-day handling.

Share image opens an owned native preview with **Include readings off on every opening**. The controller retains only two sanitized `ShareModel` candidates, never a snapshot. The private model is independent of source values. Opt-in adds only known provider/window enums, finite percentage readings and freshness; account/profile/project labels and IDs, paths, tokens, arbitrary fields and exact timestamps remain excluded. The card uses the original pixel pear, fixed motto and canonical URL. A fresh PNG is rendered from `ShareCard` itself through ImageRenderer with an explicit 2× display environment and encoded with no source metadata; no screen/window capture, upload or network request occurs. Copy (⌘C) and Save PNG (⌘S, native save panel) require explicit actions; preview/open/close and probes never modify the clipboard.

`--headless` includes pure presentation/privacy-canary and confirmed-reset checks alongside the existing 21 native and 35 bridge checks. `--share-probe` exports `private.png`, `readings.png`, sanitized model JSON and `share-probe.json` from derived canary input into its scratch evidence directory, exercises its owned preview through opt-in/repeated opening/close/reopen and asserts the private model and card are restored, then exits without starting a bridge, clipboard writes or a save panel. For a frozen build:

```sh
node native/scripts/launch-built.mjs /private/tmp/BUILD_ROOT --share-probe /private/tmp/BUILD_ROOT/share-proof
```

Current C results and remaining gates are recorded below. Earlier 20×14-point measurements remain historical evidence.

## Historical rendering and measurements

`Stores/` owns actor phase outside recreated views. Original atlas data is exported at build time without changing `src/mascot-atlas.json`; decoded images and sprite/cup layers are cached. At the owner's request, the original 40×28 pixel frame now displays at 40×28 points, with nearest-neighbor sampling and origins snapped to backing pixels. The original 8×7 pixel coffee accessory now displays at 16×14 points so its rim and handle remain legible. It aligns with the mascot's feet, keeps a two-point gap from its frame, and switches to the left side near the rail's right edge. The two 64-point rows occupy a 320×128-point rail. Presentation converts source pixels to points before positioning: the 40-point mascot travels 280 points within the rail; reaction displacement/stretch scales with the sprite, while the 320/200/420 ms pause/resume/greeting timings stay unchanged. Pause freezes the actual x/phase; resume retains it through the bounded 200 ms beat. The approved 420 ms greeting primitive briefly stretches at most two points, deduplicates supplied identities and restores the original size. A live greeting requires a new reported current window and a fresh reading after the previously observed window end, within the same bridge/account context while visible. Initial attach, reconnect, context changes and hidden/wake backlog establish baselines without greeting; active reactions drop a greeting. No clock prediction triggers it. Accepted greetings invalidate clean-patrol CPU phases. Fixture greeting buttons supply explicitly simulated identities. OS Reduce Motion and its preview override stop patrol/frame cycling and cancel active flourishes.

The animation timer runs only while the popover is visible, unoccluded, awake and moving. Hidden/static/Reduce Motion stops it and retains phase. The popover has a fixed AppKit root with hosted SwiftUI content; its initial authoritative snapshot receives hidden **layout preparation only**, without drawing, caching a bitmap or showing a window.

Diagnostics/image collection requires explicit `--probe`, `--benchmark` or `--share-probe`; ordinary runs save only the minimal instance record. A probe records actual visible rail drawing, data readiness, separate first/warm draws, hidden ticks, close/reopen phase retention, content PNG and original-layer raster proof. It measures content drawing, not optical presentation. `lifecycle.json` records bounded close/occlusion/activation/Space/input-class events without typed text or pointer positions. Unexpected visibility/activity transitions invalidate CPU samples.

Live CPU mode measures real closed and open engine states. Fixture CPU mode additionally measures deliberately paused/static and Reduce Motion rendering; live backend snapshots cannot overwrite those fixture states. The benchmark holds its actual popover open and vetoes implicit dismissal, but still uses real visibility/occlusion and expected motion/timer state to accept each phase. D benchmarks use the normal panel/window level and no every-Space override. Historical C benchmarks used a temporary raised-window override. `current-phase.json` and benchmark records include phase start/end monotonic times and the owned bridge PID. Native `getrusage` CPU excludes Node, its fake reader, WindowServer and GPU; Node must be sampled separately. CPU percentages use 100% for one full core.

## Historical larger-presentation validation

`/private/tmp/peras-native-large-preview` passes 21 native and 34 bridge checks, plus 2,354 patrol samples. The manual-pause layer proof at actual 2× backing scale verifies 4,600 opaque output pixels with zero RGBA mismatches: 2,576 Claude, 1,544 Codex and 480 cup pixels. Mascots render at 80×56 backing pixels; the visible cup renders at 32×28. Parent npm checks pass (226 tests / 2 skips), package check (51 files / 175.6 kB) and demo check pass; the real-Codex guard reports zero executions. Current C presentation measurements follow; this earlier raster-only build is historical.

## Historical milestone C parent verification and remaining gates

The earlier scratch evidence folders below were removed during the usage pause. Their reported observations remain historical; retained fresh C/D artifacts and measurements are documented in the D section.

The measured immutable app is `/private/tmp/peras-native-c-reviewed/PerasNativePreview.app`. Its 41 snapshotted source inputs, 49 bundle files and separately pinned 52-file Node runtime match their recorded SHA-256 manifests. Final verification and preview use `/private/tmp/peras-native-c-complete/`; only four subsequent source changes concern the share renderer, share lifecycle/probe and share-only diagnostic branch. Patrol, popover layout, bridge and performance instrumentation inputs are unchanged from the measured app. The engine copy prevents concurrent backend edits from changing a run. Native and Node tests use isolated state and the mandatory fake Codex executable. Final share lifecycle verification: **passes**, including an independent PNG decoder, strict model/metadata allowlists, opt-in mode proof and private reset on repeat opening, close and reopen.

Parent checks pass: **253 npm tests / 2 skips**, package check (53 files / 181.2 kB), demo check, **21 native + 35 bridge + 57 presentation/privacy assertions**, five serializer fixtures and 2,354 original-patrol comparisons. The real-engine check exercises daily Extra followed by a Claude-only Pause. Settings checks cover all seven exact signed offers, pending/disconnect/refusal handling and authoritative mascot/weekly/menu-display behavior. The larger manual-pause raster compares 4,600 opaque pixels with zero mismatches, including 480 coffee pixels, at actual 2× backing scale. macOS 13 arm64 and x86_64 both compile/link; the local ad hoc signature verifies. This is not Developer ID/notarized installation evidence.

Share model and PNG audits allow only fixed card data or explicitly included enum-labelled readings. All PNGs are 1200×1080. Standalone probe renders are 77,477 bytes private / 94,023 bytes with readings; actual controller images are 76,815 / 93,903 bytes. All four private controller stages are byte-identical, and their pixels differ from the standalone card by at most the verified one-level rasterization bound. Both standalone and actual-controller metadata are audited. ImageIO adds sRGB and a small EXIF block containing only color space and pixel dimensions. The independent parser rejects private metadata, dates, GPS, comments, software/creator fields and arbitrary text chunks. Rendering/auditing does not write the clipboard or invoke a save panel. Private/readings selection, dimensions and opaque alpha are exact requirements. Independent pixel comparison permits at most one 8-bit RGB level of text-edge quantization; opt-in must differ from private by more than that bound. Earlier failed byte/exact-pixel probes remain preserved: a later original-bundle repro passed, while independent decoding identified one-level rasterization variation. macOS `open -W` exit zero alone is not treated as a successful probe.

| Current C first-open condition | First visible rail draw | Warm reopen |
| --- | ---: | ---: |
| Live engine, data ready after a 2 s startup delay | 253.63 ms | 59.30 ms |
| Live engine, after the 15.58 s closed CPU phase | 410.62 ms | — |
| Fixture renderer, after the 8.40 s closed CPU phase | 559.75 ms | — |

The **under-100 ms cold-open target is missed**. These are separate single observations, not percentiles or an improvement trend. The data-ready probe records an actual visible/unoccluded rail draw, zero hidden draws, 7.98 ms of hidden layout preparation, zero hidden ticks and exactly retained phase on reopen. It measures `NSView.draw` completion, not optical presentation. Own-view cached PNGs can omit cached SwiftUI text and are not full desktop screenshots; the independent sprite raster and complete ShareCard ImageRenderer exports have narrower, explicit purposes.

All CPU phases below passed actual visibility, motion-state and no-transition checks. Percentages use 100% for one core.

| Component / mode / state | CPU % | Interval | Animation ticks |
| --- | ---: | ---: | ---: |
| Native / live / closed | 0.2871% | 15.579 s | 0 |
| Native / live / visible patrol | 2.8800% | 15.004 s | 898 |
| Node / live / closed | 0.8785% | 15.101 s | — |
| Node / live / visible patrol | 0.6557% | 14.542 s | — |
| Native / fixture / closed | 0.1316% | 8.398 s | 0 |
| Native / fixture / visible patrol | 4.2484% | 8.015 s | 476 |
| Native / fixture / both actors paused | 2.2496% | 8.397 s | 0 |
| Native / fixture / Reduce Motion | 2.9623% | 8.397 s | 0 |

Closed, paused and Reduce Motion stop the sprite timer; they do not establish whole-process zero CPU. Current moving CPU exceeds the earlier sprite-spike observations (1.74–1.88%); the scenarios differ, and this is a budget indicator rather than a controlled regression estimate. Performance polish remains open. Separate calibrated Node intervals lie inside their native phases but have different bounds, so their sum is not a synchronized total. These observations exclude transient fake reader descendants, WindowServer and GPU, and use synthetic account data.

Performance and earlier geometry evidence is under the measured root: `parent-headless/`, `parent-share-proof/`, `parent-cold-data-ready/`, `parent-live-benchmark/`, `parent-renderer-benchmark/` and `parent-paused-proof/`. Final native checks, patrol samples, signature/provenance and paused-geometry proof are under `/private/tmp/peras-native-c-complete/`. Final lifecycle verification evidence: `/private/tmp/peras-native-c-complete/parent-share-proof/` (`share-probe.json`, `share-lifecycle.json`, `parent-lifecycle-audit.json`, standalone and actual-controller metadata audits). Repository checks are under `/private/tmp/peras-c-repo-checks-923kp1v7/`; final both-architecture outputs are under `/private/tmp/peras-native-c-complete-compile/`. The earlier hung-child regression is fixed with bounded owned-child cleanup and an independent watchdog; failed evidence remains in the earlier scratch root.

Live presentation consumes actual bridge snapshots and eligible signed offers; the default development account readings are synthetic. The five fixture scenarios, debug reactions and canary share probe remain test-only, with fixture mutations disabled. Thresholds remain explicitly configured/conditional until Claude supplies evaluated active/exempt state; Swift does not infer it. Source-level backend fixes reported by Claude are not independently closed by this C UI review. Claude's supported real-host strict-mode proof remains an owner gate.

Next is milestone D: configurable open/focus shortcut, pin/unpin with one shared model and phase, persistent placement and screen/wake/Space behavior. Carry the cold-draw and CPU misses into that work. E0 then needs the signed/notarized native component, Node detection, first-run setup and clean-install/rollback proof. Actual macOS 13/Intel runtime, external-display behavior, the OS Reduce Motion preference and full keyboard/VoiceOver interaction remain separate checks. No native release installation, commits or publication were performed by Codex.

## Historical verification and performance (20×14 pt mascots)

The following frozen build and measurements precede the owner-requested larger presentation. They do not measure the current 40×28-point mascots or 16×14-point cups; current C geometry and performance are recorded above.

Historical frozen candidate: `/private/tmp/peras-native-live-final/PerasNativePreview.app`. Its `provenance.json` and `source-snapshot/` identify exact compiler inputs and bundle hashes; the backend hash manifest identifies the engine files read at build time. The app is locally ad hoc signed. No Developer ID signing/notarization or release-install/Gatekeeper result is claimed.

The native suite preserves the five real fixtures and 2,354 comparisons against the actual original patrol implementation. Bridge checks cover hello/protocol/identity/revision, exact commands and fresh IDs, disabled/stale/rotated offers, post-ack snapshot ordering, reconnect uncertainty/no replay, arbitrary UTF-8 chunks, oversized frames, bounded retry, malformed/private output, missing/invalid executables, broken command pipes and owned-child cleanup. Actual Process checks use both a deterministic fake bridge and the real Node engine with synthetic Codex. `evidence/bridge-checks/results.json` identifies the executed fake path and log; the log independently records the account-reader executable actually run.

Useful checks for a built app's evidence:

```sh
node native/scripts/verify-patrol.mjs EVIDENCE APP/Contents/Resources
node native/scripts/raster-check.mjs PROBE_EVIDENCE APP/Contents/Resources
```

Historical parent measurements use the same frozen candidate and report separate observations:

| First-open condition | First visible draw | Warm reopen |
| --- | ---: | ---: |
| Data-ready open after a 2 s startup delay | 92.18 ms | 39.98 ms |
| Earlier early-open probe | 234.76 ms | 48.35 ms |
| First open after the benchmark's closed interval | 122.47 ms | — |

The data-ready probe reports `snapshotReadyAtDraw: true`, zero hidden draws and 0.944 ms of hidden snapshot layout preparation. Evidence: `/private/tmp/peras-native-live-final/parent-data-ready-cold`. The under-100 ms target was observed once and is **not consistently met**. These are distinct single observations, not a latency distribution, percentile or demonstrated improvement trend.

Both historical live CPU phases passed visibility and motion-state validation, with no visibility/activity changes and two moving actors while open:

| Component / state | CPU % of one core | Actual measured interval | Native animation ticks |
| --- | ---: | ---: | ---: |
| Native app, closed | 0.0519% | 15.575 s | 0 |
| Native app, visible patrol | 1.9867% | 15.017 s | 901 |
| Node engine, closed | 0.8064% | 15.359 s | — |
| Node engine, visible patrol | 0.4193% | 14.318 s | — |

Native results are in `/private/tmp/peras-native-live-final/parent-live-benchmark/benchmark.json`; separate calibrated Node counter derivations are in `parent-live-benchmark/component-cpu.json`. The Node intervals fall wholly inside their corresponding phases and differ from the native intervals; do not present their sum as one synchronized total. These component measurements exclude short-lived fake Codex descendants, WindowServer and GPU. They are local observations with synthetic account reads, not complete product power or real-provider benchmarks.

Final parent verification passes: 21 native checks plus 34 bridge checks; 2,354 patrol parity samples; actual 2× raster with 942 opaque source pixels and zero mismatches; macOS 13 arm64 and x86_64 compile/link (both Mach-O); strict local ad hoc signature verification. All 28 recorded source inputs, 49 bundle files and 47 backend files match provenance. Binary SHA-256: `dfbdec2d16113999773120b71df59736ae3f9f487e8d99de07b2d732e47b0e31`.

The parent also verified 226 passing npm tests / 2 skips, package check (51 files / 175.6 kB), demo check, all 52 audited backend/support hashes and all 97 protected shipping/live hashes unchanged. A separate short fixture run validated closed, moving and static phases, with zero closed/static ticks; its Reduce Motion phase had zero ticks but visibility changes, so its CPU sample is excluded. Actual macOS 13/Intel runtime, external-display rendering and the OS Reduce Motion preference toggle remain untested. Backend findings are documented in the separate review; a native UI success does not resolve them.


## Historical milestone D and backend-value integration

Milestone C was committed first as `60df585`, by explicit native/script paths only; reviews and Claude's paths were excluded. D remains uncommitted. The current view is a development layout; final visual styling and signed installation remain separate work.

Control–Option–P opens/focuses Peras after successful Carbon registration, with Control–Option–Shift–P as an alternate and an explicit disable toggle in Settings. Collisions receive plain recovery text. No Accessibility permission or global typing monitor is used. Tab/Shift–Tab and focused Return/Space use native controls; Escape dismisses the attached popover. One controller, hosting tree, store, bridge client and actor set move between the popover and normal-level panel. Closing returns to menu-bar-only mode. Missing anchors fall back to that same panel. Pending/disclosure state, focus and motion phase survive transfers. Geometry/shortcut choices are atomically saved under the selected root's `native/desktop.json`; short/negative-origin/disconnected-screen geometry is clamped and content scrolls. The panel does not float above other apps or join every Space.

Sleep/occlusion stop the animation timer; wake and clock/timezone boundaries reset greeting baselines, re-clamp the panel and coalesce a fresh owned bridge connection. Old tokens are invalidated and uncertain clicks are never replayed. Pin/unpin retain the connection. Actual physical keyboard traversal, display unplugging, Spaces/fullscreen and an OS-13 runtime still need manual QA; the automated probe exercises AppKit callbacks and the owned windows.

`runtime_outdated` explains the older hooks and points to terminal `peras setup`. Resume renders the offered `lifts` and `extends`, and the real isolated engine now proves Extra → Pause → signed Resume with Codex unchanged. Failure policy stays **display-only in this slice**, even though the newer backend can offer its setter: configured strict appears only for `mode == strict`; capability and checked version are separate facts. Profile buttons use the offered wire names. Threshold state/expiry come from the backend, with dim outlined inactive/lifted markers. Reason values use the explicit percent/points unit; an absent unit does not invent numeric semantics. Pacing reserve is a percentage. The eighth settings offer labels agent usage correctly. Unknown enum values still reject the snapshot; enum additions need a coordinated protocol decision, while additive fields are retained.

Layer updates now assign only changed contents/geometry/transforms/opacity, and invisible cups keep their cached geometry. Unchanged rail facts do not redraw on token rotations; collapsed settings/debug controls are constructed when expanded. Newly visible content requests its existing canvas directly, after real visibility/occlusion checks. No hidden display, cache/prepaint or earlier probe timestamp is used. Art, 40×28-point mascots, 16×14-point cups, ten-second patrol, 60 Hz timer and 320/200/420 ms reactions are preserved.

### Retained verification

- Final native source/build: `/private/tmp/peras-native-d-perf2`; 45 source inputs / 50 bundle files. Headless checks: **21 native + 38 bridge + 60 presentation/privacy + 42 desktop**; six actual fixtures and **2,354** original patrol samples. The pending-refresh test proves coalescing, uncertainty, no replay and owned-child reaping.
- Required repo checks: **309 passed / 2 skipped**, package **59 files / 196.0 kB**, demo check passes. Isolated homes/provider roots, no notifications and a blocking fake Codex guard; zero guard executions. Evidence: `/private/tmp/peras-v04-d-review-d2mi23jc/repo-checks.json`.
- Final live desktop/paused raster: `/private/tmp/peras-native-d-current/parent-desktop-final` and `parent-paused-proof`; same controller/host/client/actors, focus/pending sentinel/phase retained, normal panel, shortcut collision and sleep continuity pass. **4,600** enlarged opaque pixels match the original atlas exactly, including **480** coffee pixels at actual 2× backing.
- Private share audit: `/private/tmp/peras-native-d-perf1/parent-share-proof/parent-share-audit.json`; share implementation inputs are identical in perf2. Independent PNG CRC/scanline/metadata checks cover standalone and all five controller stages: exact models, 1200×1080 opaque output, RGB quantization at most 1/255; opt-in differs materially, private resets pass, no clipboard/save/upload. Only sRGB and EXIF color space/dimensions occur.

### Fresh performance observations

C and final D use newly seeded disposable homes and the **same archived C backend/bootstrap** (`60df585`, backend at `5da4117`) for the comparison. Alternating fresh-process opens wait two seconds for data/layout; this is first visible rail `NSView.draw` completion, not optical latency or a reboot-cold launch. Three samples per build are too few for percentiles or a reliable trend.

| First-open condition | C | Final D |
| --- | ---: | ---: |
| Cold rail draw, three runs | 200.66 / 126.22 / 127.94 ms | 116.44 / 129.78 / 136.40 ms |
| Median cold draw | 127.94 ms | 129.78 ms |
| Warm reopen range | 59.61–66.36 ms | 58.65–70.72 ms |

The **100 ms cold target remains missed**; the sample medians do not establish an improvement. All six opens have ready snapshots, zero hidden draws/ticks and retained phase. Earlier perf1 reads were 126–145 ms; its canvas request was ineffective before first draw, which D now fixes without changing measurement criteria.

| Component / scenario | Closed CPU | Visible CPU | Native interval |
| --- | ---: | ---: | ---: |
| C native / archived backend | 0.0511% | 2.9877% | 15.580 / 15.002 s |
| D native / same archived backend | 0.0503% | 2.7236% | 15.575 / 15.002 s |
| C Node / archived backend | 0.9718% | 0.6389% | separate inside-phase samples |
| D Node / same archived backend | 0.9478% | 0.6132% | separate inside-phase samples |
| D native / latest pinned backend / panel | 0.2516% | 2.3853% | 15.040 / 15.004 s |
| D Node / latest pinned backend / panel | 1.2836% | 0.8079% | separate inside-phase samples |

The comparison moving CPU is modestly lower; it remains above the historical 1.74–1.88% sprite-only spike. These are individual clean observations, not a population benchmark. Each accepted phase has actual visibility/occlusion and unchanged motion checks. An early closed app run and Space-interrupted runs were discarded; their lower or higher CPU numbers are not acceptance evidence. Native uses `getrusage`; Node uses calibrated `proc_pid_rusage` (timebase 125/3; self-check ratio 0.999982). 100% is one core. Node intervals lie wholly inside native phases but have different bounds, so they are not a synchronized sum. GPU, WindowServer and short-lived fake-reader descendants are excluded.

A separate six-second fixture test of the pinned panel measures closed **0.0564%**, moving **2.4489%**, paused **0.0504%**, Reduce Motion **0.1179%**. Closed/static/reduced phases have **zero animation ticks**; all four phases are valid. This is renderer evidence, not live enforcement. Latest backend is a frozen 58-file copy under `/private/tmp/peras-native-d-current/runtime-backend`.

Retained measurement evidence: `/private/tmp/peras-v04-d-review-d2mi23jc/final-paired-cold.json`, `/private/tmp/peras-native-d-before-final/parent-live-cpu`, `/private/tmp/peras-native-d-final/parent-live-cpu`, `/private/tmp/peras-native-d-current/parent-panel-cpu` and `parent-pinned-renderer`.

Next is E0: production `launch.json`/Node discovery and first-run guidance, graceful installed-app termination, Developer ID/notarized component and clean-account install/migration/rollback. The development launcher still requires its isolated fake-Codex configuration. Discovery/setup/receipt UI and manual desktop QA remain separate; no owner-home setup or publishing occurred.
