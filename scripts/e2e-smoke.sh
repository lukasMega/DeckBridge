#!/usr/bin/env bash
# Black-box smoke test: extract a release zip, boot the binary in mock mode,
# verify it serves all ports cleanly, then confirm a clean SIGTERM shutdown.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${1:-}" ]; then
  ZIP="$1"
else
  ZIP="$(ls -t "$ROOT"/dist/*.zip 2>/dev/null | head -1 || true)"
fi
[ -f "$ZIP" ] || { echo "no zip found (pass path as argument or build with 'mise run package -- dev')"; exit 1; }

# CORA ports are hardcoded — fail early if occupied to avoid testing the wrong process.
# WebUI port (3000) is skipped: the app auto-selects a fallback in 64000-65000 if taken.
for port in 5343 5344; do
  nc -z -w1 127.0.0.1 "$port" 2>/dev/null \
    && { echo "FAIL: port $port already in use — stop any running deckbridge instance first"; exit 1; }
done

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"
APPDIR="$(dirname "$(find "$WORK" -name deckbridge -type f -maxdepth 2 | head -1)")"
OUT="$WORK/stdout.log"; ERR="$WORK/stderr.log"

# Remove tray binary so no GUI spawns in headless CI. app.ts auto-detects a
# deckbridge-tray sidecar next to the executable when DECKBRIDGE_TRAY_BIN is unset, so the file
# must be gone (stripping DECKBRIDGE_TRAY_BIN below is not enough on its own).
rm -f "$APPDIR/deckbridge-tray"

# Boot in mock mode — no HID probe warnings, no real device required.
# env -u: strip dev env vars (mise [env] sets them) so the binary exercises
# the embedded-extraction path, exactly like an end-user machine.
( cd "$APPDIR" && exec env -u DECKBRIDGE_NATIVE_LIB -u HIDAPI_LIB -u DECKBRIDGE_TRAY_BIN DECKBRIDGE_MOCK=1 ./deckbridge ) >"$OUT" 2>"$ERR" &
APP_PID=$!

# Determine the actual WebUI port from the startup log (up to ~15 s).
# The app logs: "WebUI: http://localhost:<port>"
WEBUI_PORT=""
for _ in $(seq 1 60); do
  WEBUI_PORT="$(grep -o 'WebUI: http://localhost:[0-9]*' "$OUT" 2>/dev/null | grep -o '[0-9]*$' || true)"
  [ -n "$WEBUI_PORT" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "FAIL: app died before logging WebUI port"; cat "$ERR"; exit 1; }
  sleep 0.25
done
[ -n "$WEBUI_PORT" ] || { echo "FAIL: WebUI port never logged after 15s"; cat "$ERR"; kill "$APP_PID" 2>/dev/null; exit 1; }

# Wait-for-ready (up to ~15 s)
ready=0
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$WEBUI_PORT/api/state" >/dev/null 2>&1 && { ready=1; break; }
  kill -0 "$APP_PID" 2>/dev/null || { echo "FAIL: app died before becoming ready"; cat "$ERR"; exit 1; }
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "FAIL: WebUI never came up after 15s"; cat "$ERR"; kill "$APP_PID" 2>/dev/null; exit 1; }

# CORA ports (primary + child)
nc -z -w2 127.0.0.1 5343 || { echo "FAIL: :5343 not listening"; kill "$APP_PID"; exit 1; }
nc -z -w2 127.0.0.1 5344 || { echo "FAIL: :5344 not listening"; kill "$APP_PID"; exit 1; }

# Bundled libhidapi present (WS1 tie-in — soft check)
REQS="$(curl -fsS "http://127.0.0.1:$WEBUI_PORT/api/requirements" 2>/dev/null || echo '')"
if echo "$REQS" | grep -q '"name":"libhidapi"' && ! echo "$REQS" | grep -q '"name":"libhidapi","ok":true'; then
  echo "WARN: /api/requirements reports libhidapi not found (zip may lack bundled lib)"
fi

# Mock driver active
curl -fsS "http://127.0.0.1:$WEBUI_PORT/api/state" | grep -q '"driverMode":"mock"' \
  || { echo "FAIL: driverMode is not mock"; kill "$APP_PID"; exit 1; }

# Embedded native libs were extracted and wired up
grep -q 'env DECKBRIDGE_NATIVE_LIB = .*/native-' "$OUT" \
  || { echo "FAIL: DECKBRIDGE_NATIVE_LIB does not point into an extracted native-<hash> dir"; kill "$APP_PID"; exit 1; }

# Let one retry interval pass; nothing new should appear on stderr.
sleep 2

# No unexpected warn/error lines on stderr.
# All warn/error go to stderr with shape "[component] message".
# Allow-list covers platform-inherent benign lines.
ALLOW='\[elgato\] mDNS subprocess (failed to start|exited unexpectedly)|running without mDNS discovery|\[ffi\] deckbridge-native hid enum load failed|\[ffi\] mirabox_hid_find_path threw|\[hid\] no device found|\[elgato(-child)?\] socket error: ECONNRESET'
if grep -vE "$ALLOW" "$ERR" | grep -qE '^\['; then
  echo "FAIL: unexpected stderr lines:"
  grep -vE "$ALLOW" "$ERR" | grep -E '^\['
  kill "$APP_PID"; exit 1
fi

# Startup banner present on stdout
grep -q 'startup complete' "$OUT" \
  || { echo "FAIL: no startup-complete marker in stdout"; kill "$APP_PID"; exit 1; }

# Clean shutdown via SIGTERM
kill -TERM "$APP_PID"
rc=0; wait "$APP_PID" 2>/dev/null || rc=$?
[ "$rc" -eq 0 ] || { echo "FAIL: exit code $rc (expected 0)"; echo "--- stderr ---"; cat "$ERR"; echo "--- stdout ---"; cat "$OUT"; exit 1; }
grep -q 'shutting down\.\.\.' "$OUT" || { echo "FAIL: no shutdown log line in stdout"; exit 1; }

echo "E2E SMOKE PASS: $(basename "$ZIP") (WebUI :$WEBUI_PORT)"
