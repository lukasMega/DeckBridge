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
# --container runs the relay in an Apple container (macOS 26, Apple silicon);
# --uninstall removes it, with any automatic start: curl -fsSL "${selfUrl}?t=<token>" | sh -s -- --uninstall
set -eu

VERSION='${version}'
TARGET='${p.target}'
TARGET_PORT='${p.targetPort}'
EVENT_URL='${eventUrl}'
TOKEN='${p.token}'
SELF_URL='${selfUrl}?t=${p.token}'
BASE='${RELEASE_BASE}/deckbridge-v${version}'
DIR="$HOME/.deckbridge-relay"
PLIST="$HOME/Library/LaunchAgents/dev.deckbridge.relay.plist"
UNIT="$HOME/.config/systemd/user/deckbridge-relay.service"
CTR_NAME=deckbridge-relay
STEP=starting
PLATFORM=unknown
SELF_IP=
REPORTED=
RELAY_PID=
HB_PID=
NODE=
CONTAINER=
SERVICE=
CTR_UP=

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
  if [ -n "$CTR_UP" ]; then container rm -f "$CTR_NAME" >/dev/null 2>&1 || true; fi
  # Only the process that started a relay owns the pid file (the installer exits while a service runs).
  if [ -n "$RELAY_PID" ]; then kill "$RELAY_PID" 2>/dev/null || true; rm -f "$DIR/relay.pid"; fi
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
  elif [ -n "$CONTAINER" ]; then
    [ "$os-$arch" = macos-arm64 ] || fail "Apple container needs a Mac with Apple silicon."
    command -v container >/dev/null 2>&1 || fail "Install Apple container from github.com/apple/container/releases, run: container system start, then run this again."
    container system status >/dev/null 2>&1 || fail "Run: container system start, then run this again."
    # The VM runs Linux: the Linux zip is downloaded and unpacked here, on the host.
    PLATFORM=container-linux-arm64
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
  # A native macOS copy may sit in $dir; the container needs the Linux one.
  [ -z "$CONTAINER" ] || dir="$dir-linux"
  plat=\${PLATFORM#container-}
  zip="deckbridge-v$VERSION-$plat.zip"
  mkdir -p "$dir"
  cd "$dir"
  if [ -n "$NODE" ]; then install_node; return 0; fi
  if [ -x ./deckbridge ] && [ -f .verified ]; then return 0; fi
  download "$zip"
  unpack "$zip"
  # The release zip holds one folder named like the zip; its files belong next to us.
  inner="deckbridge-v$VERSION-$plat"
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
  echo "Relay running."
  [ -n "$SERVICE" ] || echo "Keep this window open; press Ctrl-C to stop it."
  wait "$RELAY_PID" || fail "The relay stopped."
}

# Apple container prints the address with its prefix length, e.g. "192.168.64.3/24".
container_ip() {
  container inspect "$CTR_NAME" 2>/dev/null | grep -oiE '"[a-z0-9]*address" *: *"[0-9.]+/[0-9]+"' | head -n 1 | grep -oE '[0-9]+(\\.[0-9]+){3}' || true
}

# The relay dials DeckBridge from a NATed VM; this script, on the host, reports for it.
run_container() {
  STEP=starting
  event starting
  # The first run pulls the image, which can take minutes: keep the wizard's progress alive.
  ( while :; do event starting; sleep 20; done ) &
  HB_PID=$!
  container rm -f "$CTR_NAME" >/dev/null 2>&1 || true
  : > "$DIR/.container"
  CTR_UP=1
  container run -d --name "$CTR_NAME" --memory 256M -v "$DIR:/relay" ubuntu:24.04 "/relay/$VERSION-linux/deckbridge" relay --target "$TARGET" --target-port "$TARGET_PORT" --no-advertise --name "DeckBridge Relay" >/dev/null || fail "Could not start the container. Run: container system start"
  kill "$HB_PID" 2>/dev/null || true
  HB_PID=
  sleep 2
  SELF_IP=$(container_ip)
  [ -n "$SELF_IP" ] || fail "The container has no IP address."
  STEP=running
  echo "Relay running in a container at $SELF_IP."
  [ -n "$SERVICE" ] || echo "Keep this window open; press Ctrl-C to stop it."
  while container ls 2>/dev/null | grep -q "^$CTR_NAME "; do event running; sleep 30; done
  fail "The relay container stopped."
}

can_autostart() {
  if [ "$(uname -s)" = Darwin ]; then command -v launchctl >/dev/null 2>&1; else command -v systemctl >/dev/null 2>&1; fi
}

ask_autostart() {
  [ -z "$SERVICE" ] || return 1
  can_autostart || return 1
  # No terminal (cron, ssh -T): run in the foreground.
  ( : </dev/tty ) 2>/dev/null || return 1
  printf 'Start the relay automatically after a restart? [Y/n] ' >/dev/tty
  read -r ans </dev/tty || return 1
  case "$ans" in [nN]*) return 1 ;; esac
  return 0
}

stop_service() {
  if [ -f "$PLIST" ]; then launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true; rm -f "$PLIST"; fi
  if [ -f "$UNIT" ]; then systemctl --user disable --now deckbridge-relay.service >/dev/null 2>&1 || true; rm -f "$UNIT"; fi
}

# The service runs a saved copy of this script (--service): at boot DeckBridge may not be up to serve it.
install_service() {
  STEP=autostart
  flag=
  [ -z "$NODE" ] || flag=--node
  [ -z "$CONTAINER" ] || flag=--container
  stop_old
  fetch "$SELF_URL" "$DIR/relay.sh" || return 1
  chmod 600 "$DIR/relay.sh"
  if [ "$(uname -s)" = Darwin ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    # launchd's PATH lacks /usr/local/bin (container, node).
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.deckbridge.relay</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$DIR/relay.sh</string><string>--service</string>\${flag:+<string>$flag</string>}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/relay.log</string>
<key>StandardErrorPath</key><string>$DIR/relay.log</string>
</dict></plist>
EOF
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { rm -f "$PLIST"; return 1; }
  else
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$UNIT" <<EOF
[Unit]
Description=DeckBridge relay
After=network-online.target

[Service]
ExecStart=/bin/sh $DIR/relay.sh --service $flag
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload && systemctl --user enable --now deckbridge-relay.service >/dev/null 2>&1; then
      # Lets the user service start at boot, before anyone logs in.
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    else
      rm -f "$UNIT"
      return 1
    fi
  fi
}

uninstall() {
  stop_service
  if [ -f "$DIR/.container" ] && command -v container >/dev/null 2>&1; then
    container rm -f "$CTR_NAME" >/dev/null 2>&1 || true
  fi
  stop_old
  rm -rf "$DIR"
  echo "DeckBridge relay removed."
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --uninstall) uninstall; return 0 ;;
      --node) NODE=1 ;;
      --container) CONTAINER=1 ;;
      --service) SERVICE=1 ;;
      *) echo "Unknown option $arg. Use --node, --container or --uninstall." >&2; exit 2 ;;
    esac
  done
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  detect
  install
  # Running again replaces the service; answering no leaves it off.
  if [ -z "$SERVICE" ]; then stop_service; fi
  if ask_autostart && install_service; then
    echo "The relay now starts automatically. Remove it with: curl -fsSL \\"$SELF_URL\\" | sh -s -- --uninstall"
    return 0
  fi
  if [ -n "$CONTAINER" ]; then run_container; else run_relay; fi
}

main "$@"
`;
}
