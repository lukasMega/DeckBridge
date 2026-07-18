#!/bin/sh
# Installs DeckBridge as a systemd service on a headless Linux box
# (DietPi / Raspberry Pi OS). Idempotent — safe to re-run (e.g. after
# upgrading the binary).
#
# Usage: sudo ./install.sh [path-to-deckbridge-binary]
#   (defaults to ./deckbridge next to this script's caller cwd)

set -eu

BIN_SRC="${1:-./deckbridge}"
INSTALL_DIR=/opt/deckbridge
DATA_DIR=/var/lib/deckbridge
SERVICE_USER=deckbridge
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root (sudo ./install.sh)" >&2
  exit 1
fi

if [ ! -f "$BIN_SRC" ]; then
  echo "deckbridge binary not found at '$BIN_SRC'" >&2
  echo "Usage: sudo ./install.sh [path-to-deckbridge-binary]" >&2
  exit 1
fi

echo "==> Installing binary to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$BIN_SRC" "$INSTALL_DIR/deckbridge"
chmod 755 "$INSTALL_DIR/deckbridge"

echo "==> Ensuring group 'plugdev' exists"
getent group plugdev >/dev/null 2>&1 || groupadd --system plugdev

echo "==> Ensuring system user '$SERVICE_USER' exists"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --gid plugdev "$SERVICE_USER"
else
  usermod -aG plugdev "$SERVICE_USER"
fi

echo "==> Preparing data dir $DATA_DIR"
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER:plugdev" "$DATA_DIR"

echo "==> Installing udev rule"
cp "$SCRIPT_DIR/99-deckbridge.rules" /etc/udev/rules.d/99-deckbridge.rules
udevadm control --reload
udevadm trigger

echo "==> Installing systemd unit"
cp "$SCRIPT_DIR/deckbridge.service" /etc/systemd/system/deckbridge.service
systemctl daemon-reload

echo
echo "Install complete. Next steps:"
echo "  1. Plug in your stream deck (replug if it was already connected, so"
echo "     the new udev rule applies)."
echo "  2. sudo systemctl enable --now deckbridge"
echo "  3. journalctl -u deckbridge -f     # watch the logs"
