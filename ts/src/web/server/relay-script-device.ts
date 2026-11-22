// The relay installer for another Linux/macOS device and the OrbStack VM (issue #257). One
// `curl | sh` from the wizard downloads the release, verifies it, runs the relay and reports
// stages to DeckBridge's script listener.
import { RELAY_SCRIPT_PATH } from './relay-script.js';

export const RELAY_EVENT_PATH = '/relay/event';

const RELEASE_BASE = 'https://github.com/lukasMega/DeckBridge/releases/download';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;

export interface DeviceScriptParams {
  /** DeckBridge's version, with or without a leading `v`. */
  version: string;
  /** DeckBridge's LAN IP: the relay dials it and the events go to it. */
  target: string;
  targetPort: number;
  /** The script listener's port (RelayScriptServer). */
  scriptPort: number;
  token: string;
}

function validPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65_535;
}

/** Values go into a shell script, so anything unexpected is refused, not quoted. */
export function deviceScript(p: DeviceScriptParams): string {
  const version = p.version.replace(/^v/, '');
  if (!VERSION_RE.test(version)) throw new Error('relay script: bad version');
  if (!IPV4_RE.test(p.target)) throw new Error('relay script: bad target');
  if (!validPort(p.targetPort)) throw new Error('relay script: bad target port');
  if (!validPort(p.scriptPort)) throw new Error('relay script: bad script port');
  if (!TOKEN_RE.test(p.token)) throw new Error('relay script: bad token');
  const eventUrl = `http://${p.target}:${p.scriptPort}${RELAY_EVENT_PATH}`;
  const selfUrl = `http://${p.target}:${p.scriptPort}${RELAY_SCRIPT_PATH}`;
  // Everything runs inside main(), called last: a cut-off download executes nothing. Messages sent
  // as events hold no quotes or backslashes, so the JSON body needs no escaping.
  return `#!/bin/sh
# DeckBridge relay installer, served by DeckBridge. Safe to run again.
# Options: --node runs the Node.js relay (Macs that block the binary's network);
# --uninstall removes it: curl -fsSL "${selfUrl}?t=<token>" | sh -s -- --uninstall
set -eu

VERSION='${version}'
TARGET='${p.target}'
TARGET_PORT='${p.targetPort}'
EVENT_URL='${eventUrl}'
TOKEN='${p.token}'
BASE='${RELEASE_BASE}/deckbridge-v${version}'
DIR="$HOME/.deckbridge-relay"
STEP=starting
PLATFORM=unknown
SELF_IP=
REPORTED=
RELAY_PID=
HB_PID=
NODE=

# A DeckBridge that went away must never abort the install, hence the \`|| true\`.
event() {
  # Behind NAT (OrbStack) DeckBridge sees the host, not this VM. Retried per event: a VM that
  # just booted may have no address yet.
  if [ -z "$SELF_IP" ] && [ "$(uname -s)" = Linux ]; then
    SELF_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    case "$SELF_IP" in *[!0-9.]*) SELF_IP= ;; esac
  fi
  body="{\\"t\\":\\"$TOKEN\\",\\"stage\\":\\"$1\\",\\"platform\\":\\"$PLATFORM\\",\\"version\\":\\"$VERSION\\""
  if [ -n "\${2:-}" ]; then body="$body,\\"message\\":\\"$2\\""; fi
  if [ -n "$SELF_IP" ]; then body="$body,\\"selfIp\\":\\"$SELF_IP\\""; fi
  body="$body}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 -X POST -H 'Content-Type: application/json' -d "$body" "$EVENT_URL" >/dev/null 2>&1 || true
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null --header='Content-Type: application/json' --post-data="$body" "$EVENT_URL" >/dev/null 2>&1 || true
  fi
}

fail() {
  echo "$1" >&2
  REPORTED=1
  event failed "$1"
  exit 1
}

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$REPORTED" ]; then event failed "Failed while $STEP"; fi
  if [ -n "$HB_PID" ]; then kill "$HB_PID" 2>/dev/null || true; fi
  if [ -n "$RELAY_PID" ]; then kill "$RELAY_PID" 2>/dev/null || true; fi
  rm -f "$DIR/relay.pid"
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else fail "Install curl or wget and run this again."
  fi
}

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "No sha256sum or shasum found to verify the download."
  fi
}

unpack() {
  if command -v unzip >/dev/null 2>&1; then unzip -oq "$1"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" .
  else fail "Install unzip (sudo apt install unzip) and run this again."
  fi
}

# A relay left over from an earlier run holds the same IP and would race the new one.
stop_old() {
  [ -f "$DIR/relay.pid" ] || return 0
  old=$(cat "$DIR/relay.pid" 2>/dev/null || true)
  case "$old" in '' | *[!0-9]*) return 0 ;; esac
  case "$(ps -p "$old" -o args= 2>/dev/null || true)" in
    # Only a relay: after a reboot the stale pid may belong to anything.
    *'deckbridge relay'* | *deckbridge-relay.mjs*) kill "$old" 2>/dev/null || true; sleep 1 ;;
  esac
}

detect() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) fail "This script runs on Linux and macOS. Use the manual command on Windows." ;;
  esac
  case "$(uname -m)" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64 | amd64) arch=x86_64 ;;
    *) if [ -n "$NODE" ]; then arch=$(uname -m); else fail "Unsupported CPU: $(uname -m)"; fi ;;
  esac
  PLATFORM="$os-$arch"
  if [ -n "$NODE" ]; then
    PLATFORM="node-$PLATFORM"
    command -v node >/dev/null 2>&1 || fail "Install Node.js 20 or newer from nodejs.org and run this again."
    v=$(node -v 2>/dev/null || true)
    v=\${v#v}
    case "\${v%%.*}" in '' | *[!0-9]*) fail "Could not read the Node.js version." ;; esac
    [ "\${v%%.*}" -ge 20 ] || fail "This is Node.js $v; the relay needs Node.js 20 or newer (nodejs.org)."
  elif [ "$os" = linux ]; then
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed 's/^glibc //' || true)
    major=\${glibc%%.*}
    minor=\${glibc#*.}
    minor=\${minor%%.*}
    case "$major$minor" in '' | *[!0-9]*) fail "This system has no glibc. The relay needs glibc 2.38 or newer." ;; esac
    if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 38 ]; }; then
      fail "This system has glibc $glibc; the relay needs 2.38+ (Raspberry Pi OS Trixie, Debian 13, Ubuntu 24.04)."
    fi
  fi
}

download() {
  STEP=downloading
  event downloading
  echo "Downloading $1 ..."
  fetch "$BASE/$1" "$1" || fail "Download failed. Check the network, and that release v$VERSION exists."
  fetch "$BASE/SHA256SUMS.txt" SHA256SUMS.txt || fail "Download of the checksum list failed."
  STEP=installing
  event installing
  # The release list names files like "./deckbridge-v1-linux-arm64.zip".
  want=$(awk -v z="$1" '{ n = $2; sub("^[*]", "", n); sub("^[.]/", "", n); if (n == z) print $1 }' SHA256SUMS.txt)
  got=$(sha_of "$1")
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    rm -f "$1" SHA256SUMS.txt
    fail "Checksum mismatch. The download was removed."
  fi
}

install_node() {
  if [ -f ./deckbridge-relay.mjs ] && [ -f .verified-node ]; then return 0; fi
  file="deckbridge-relay-v$VERSION.mjs"
  download "$file"
  mv "$file" deckbridge-relay.mjs
  rm -f SHA256SUMS.txt
  : > .verified-node
}

install() {
  dir="$DIR/$VERSION"
  zip="deckbridge-v$VERSION-$PLATFORM.zip"
  mkdir -p "$dir"
  cd "$dir"
  if [ -n "$NODE" ]; then install_node; return 0; fi
  if [ -x ./deckbridge ] && [ -f .verified ]; then return 0; fi
  download "$zip"
  unpack "$zip"
  # The release zip holds one folder named like the zip; its files belong next to us.
  inner="deckbridge-v$VERSION-$PLATFORM"
  if [ -d "$inner" ]; then cp -R "$inner"/. . && rm -rf "$inner"; fi
  rm -f "$zip" SHA256SUMS.txt
  [ -f ./deckbridge ] || fail "The download holds no deckbridge binary."
  chmod +x ./deckbridge
  : > .verified
}

# exec: run in the background, so $! is the relay itself, not a subshell.
start_relay() {
  if [ -n "$NODE" ]; then exec node ./deckbridge-relay.mjs relay "$@"; fi
  exec ./deckbridge relay "$@"
}

run_relay() {
  STEP=starting
  event starting
  [ "$(uname -s)" = Darwin ] && echo "Allow incoming connections when macOS asks."
  stop_old
  start_relay --target "$TARGET" --target-port "$TARGET_PORT" --no-advertise --name "DeckBridge Relay" </dev/null &
  RELAY_PID=$!
  echo "$RELAY_PID" > "$DIR/relay.pid"
  sleep 2
  kill -0 "$RELAY_PID" 2>/dev/null || fail "The relay stopped right away. Run it again to see why."
  STEP=running
  ( while kill -0 "$RELAY_PID" 2>/dev/null; do event running; sleep 30; done ) &
  HB_PID=$!
  echo "Relay running. Keep this window open; press Ctrl-C to stop it."
  wait "$RELAY_PID" || fail "The relay stopped."
}

uninstall() {
  stop_old
  rm -rf "$DIR"
  echo "DeckBridge relay removed."
}

main() {
  case "\${1:-}" in
    --uninstall) uninstall; return 0 ;;
    --node) NODE=1 ;;
    '') ;;
    *) echo "Unknown option $1. Use --node or --uninstall." >&2; exit 2 ;;
  esac
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  detect
  install
  run_relay
}

main "$@"
`;
}
