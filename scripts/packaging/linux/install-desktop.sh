#!/bin/sh
# Adds a DeckBridge entry to the desktop app menu for the current user.
# Ships in the Linux release zip; the entry runs the deckbridge binary next to
# this script, so re-run it after moving or upgrading that folder.
# No root needed. For a headless systemd install, use install.sh instead.
#
# Usage: ./install-desktop.sh
# Remove: delete the two files printed at the end.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BIN="$SCRIPT_DIR/deckbridge"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/128x128/apps"

if [ "$(id -u)" -eq 0 ]; then
  echo "install-desktop.sh adds a per-user menu entry; run it as your user, not root" >&2
  exit 1
fi

if [ ! -x "$BIN" ]; then
  echo "deckbridge binary not found at '$BIN'" >&2
  exit 1
fi

# Exec takes the path double-quoted; these characters would need Desktop Entry
# escaping rules that are easy to get wrong, so refuse them instead.
case "$BIN" in
  *[\"\`\$\\%]*)
    echo "unsupported character in path '$BIN'; move the folder and re-run" >&2
    exit 1
    ;;
esac

mkdir -p "$APPS_DIR" "$ICON_DIR"
ICON="$ICON_DIR/deckbridge.png"
cp "$SCRIPT_DIR/deckbridge.png" "$ICON"

cat >"$APPS_DIR/deckbridge.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DeckBridge
Comment=Use a USB stream deck with the Elgato Stream Deck app
Exec="$BIN" --open
Icon=$ICON
Terminal=false
Categories=Utility;
Keywords=stream;deck;elgato;mirabox;ajazz;
EOF

# Some menus only pick up new entries after a cache refresh.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Menu entry installed:"
echo "  $APPS_DIR/deckbridge.desktop"
echo "  $ICON"
