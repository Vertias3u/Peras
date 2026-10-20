#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
if [[ $# -gt 0 ]]; then shift; fi
# The default Run action is safe: each run gets isolated state and never kills other roots.
RUN_ROOT="${PERAS_NATIVE_RUN_ROOT:-$(mktemp -d /private/tmp/peras-native-run.XXXXXX)}"
case "$RUN_ROOT" in /private/tmp/*|/tmp/*) ;; *) echo 'Run root must be a dedicated /private/tmp directory' >&2; exit 2;; esac
node "$ROOT_DIR/native/scripts/scratch-runtime.mjs" "$RUN_ROOT" "${PERAS_NATIVE_SCENARIO:-normal}"
export HOME="$RUN_ROOT/home" PERAS_HOME="$RUN_ROOT/state" CLAUDE_CONFIG_DIR="$RUN_ROOT/claude" CODEX_HOME="$RUN_ROOT/codex-home" PERAS_SWIFTBAR_DIR="$RUN_ROOT/swiftbar"
NODE_EXECUTABLE="$(command -v node)"
export PATH="$RUN_ROOT/fake-bin:$(dirname "$NODE_EXECUTABLE"):/usr/bin:/bin"
export PERAS_NO_NOTIFY=1 PERAS_NATIVE_FAKE_CODEX_LOG="$RUN_ROOT/fake-codex-executed.jsonl"
APP_ARGS=(--root "$PERAS_HOME" --bridge-config "$RUN_ROOT/bridge-config.json")
APP_BUNDLE="$RUN_ROOT/PerasNativePreview.app"
CONTENTS="$APP_BUNDLE/Contents"
if [[ -x "$CONTENTS/MacOS/PerasNativePreview" ]]; then
  "$CONTENTS/MacOS/PerasNativePreview" --stop --root "$PERAS_HOME"
fi
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/fixtures"
FIXTURES="$ROOT_DIR/test/fixtures/native-v1"
if [[ ! -d "$FIXTURES" ]]; then echo "Missing Contract A fixtures: $FIXTURES" >&2; exit 1; fi
cp "$FIXTURES/"*.json "$CONTENTS/Resources/fixtures/"
node "$ROOT_DIR/native/scripts/export-atlas.mjs" "$CONTENTS/Resources"
node "$ROOT_DIR/native/scripts/source-provenance.mjs" "$RUN_ROOT" snapshot
SOURCES=()
while IFS= read -r source; do SOURCES+=("$source"); done < <(node -e 'const fs=require("node:fs"),r=process.argv[1],m=JSON.parse(fs.readFileSync(r+"/provenance.json"));for(const f of Object.keys(m.source).filter(f=>f.endsWith(".swift")).sort()) console.log(r+"/source-snapshot/"+f)' "$RUN_ROOT")
ARCH="$(uname -m)"
if [[ "$MODE" == --compile-check ]]; then
  for ARCH in arm64 x86_64; do
    swiftc -O -target "$ARCH-apple-macos13.0" -module-cache-path "$RUN_ROOT/module-cache" "${SOURCES[@]}" -o "$RUN_ROOT/compile-check-$ARCH"
  done
  printf 'macOS 13 arm64 and x86_64 compile/link checks passed\n'
  exit 0
fi
swiftc -O -target "$ARCH-apple-macos13.0" -module-cache-path "$RUN_ROOT/module-cache" "${SOURCES[@]}" -o "$CONTENTS/MacOS/PerasNativePreview"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PerasNativePreview</string>
<key>CFBundleIdentifier</key><string>eu.vertias.peras.native.fixture-preview</string>
<key>CFBundleName</key><string>Peras Native Preview</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP_BUNDLE" >/dev/null
node "$ROOT_DIR/native/scripts/source-provenance.mjs" "$RUN_ROOT" bundle
printf 'App: %s\nHOME: %s\nPERAS_HOME: %s\n' "$APP_BUNDLE" "$HOME" "$PERAS_HOME"
case "$MODE" in
  --build) ;;
  --headless) "$CONTENTS/MacOS/PerasNativePreview" --headless "${APP_ARGS[@]}" --output "$RUN_ROOT/evidence" "$@" ;;
  --probe|--benchmark|--share-probe|--desktop-probe) /usr/bin/open -n -W --env "HOME=$HOME" --env "PERAS_HOME=$PERAS_HOME" --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" --env "CODEX_HOME=$CODEX_HOME" --env "PERAS_SWIFTBAR_DIR=$PERAS_SWIFTBAR_DIR" --env "PATH=$PATH" "$APP_BUNDLE" --args "${APP_ARGS[@]}" "$MODE" --output "$RUN_ROOT/evidence" "$@" ;;
  --debug) /usr/bin/lldb -- "$CONTENTS/MacOS/PerasNativePreview" "${APP_ARGS[@]}" "$@" ;;
  --logs|--telemetry) /usr/bin/open -n --env "HOME=$HOME" --env "PERAS_HOME=$PERAS_HOME" --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" --env "CODEX_HOME=$CODEX_HOME" --env "PERAS_SWIFTBAR_DIR=$PERAS_SWIFTBAR_DIR" --env "PATH=$PATH" "$APP_BUNDLE" --args "${APP_ARGS[@]}" "$@"; /usr/bin/log stream --info --style compact --predicate 'process == "PerasNativePreview"' ;;
  --verify) /usr/bin/open -n --env "HOME=$HOME" --env "PERAS_HOME=$PERAS_HOME" --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" --env "CODEX_HOME=$CODEX_HOME" --env "PERAS_SWIFTBAR_DIR=$PERAS_SWIFTBAR_DIR" --env "PATH=$PATH" "$APP_BUNDLE" --args "${APP_ARGS[@]}" "$@"; sleep 1; test -f "$PERAS_HOME/probe/instance.json" ;;
  run) /usr/bin/open -n --env "HOME=$HOME" --env "PERAS_HOME=$PERAS_HOME" --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" --env "CODEX_HOME=$CODEX_HOME" --env "PERAS_SWIFTBAR_DIR=$PERAS_SWIFTBAR_DIR" --env "PATH=$PATH" "$APP_BUNDLE" --args "${APP_ARGS[@]}" "$@" ;;
  *) echo 'usage: build_and_run.sh [run|--build|--headless|--compile-check|--probe|--benchmark|--debug|--logs|--telemetry|--verify]' >&2; exit 2 ;;
esac
