// The Linux relay installer served to a VM (OrbStack route, issue #257). The VM runs one short
// `curl | sh`; the steps live here so they can be read, tested and fixed without a UI change.

/** Own listener, not the WebUI: that one is loopback-only, so a VM can't reach it. */
export const RELAY_SCRIPT_PORT = 44661;
export const RELAY_SCRIPT_PATH = '/relay.sh';

const RELEASE_BASE = 'https://github.com/lukasMega/DeckBridge/releases/download';

export interface RelayScriptParams {
  /** DeckBridge's version, with or without a leading `v`. */
  version: string;
  /** The address the relay dials: DeckBridge's LAN IP. */
  target: string;
  targetPort: number;
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Values go into a shell script, so anything unexpected is refused, not quoted. */
export function relayScript(p: RelayScriptParams): string {
  const version = p.version.replace(/^v/, '');
  if (!VERSION_RE.test(version)) throw new Error('relay script: bad version');
  if (!IPV4_RE.test(p.target)) throw new Error('relay script: bad target');
  if (!Number.isInteger(p.targetPort) || p.targetPort < 1 || p.targetPort > 65_535) {
    throw new Error('relay script: bad target port');
  }
  // Everything runs inside main(), called last: a cut-off download executes nothing.
  return `#!/bin/sh
# DeckBridge relay installer, served by DeckBridge. Safe to run again.
set -eu

VERSION='${version}'
TARGET='${p.target}'
TARGET_PORT='${p.targetPort}'
BASE='${RELEASE_BASE}/deckbridge-v${version}'

main() {
  case "$(uname -m)" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64 | amd64) arch=x86_64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  zip="deckbridge-v\${VERSION}-linux-\${arch}.zip"

  if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq curl unzip
  fi

  # The machine's own home: a Mach-O from the mounted /Users would run on the Mac itself.
  mkdir -p "$HOME/relay"
  cd "$HOME/relay"

  if [ ! -x ./deckbridge ] || [ "$(cat .version 2>/dev/null || true)" != "$VERSION" ]; then
    curl -fL -o "$zip" "$BASE/$zip"
    curl -fsSL "$BASE/SHA256SUMS.txt" | grep "$zip" | sha256sum -c
    unzip -o "$zip"
    rm -f "$zip"
    echo "$VERSION" > .version
  fi

  exec ./deckbridge relay --target "$TARGET" --target-port "$TARGET_PORT" --no-advertise
}

main "$@"
`;
}
