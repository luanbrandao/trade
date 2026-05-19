#!/usr/bin/env bash
# Install trade bot as systemd service. Run as root.
set -euo pipefail

INSTALL_DIR="/opt/trade"
SERVICE_USER="trade"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ ! -f trade.service ]]; then
  echo "Run from ops/ directory" >&2
  exit 1
fi

echo "==> Creating user $SERVICE_USER"
id -u "$SERVICE_USER" &>/dev/null || useradd --system --shell /usr/sbin/nologin --home "$INSTALL_DIR" "$SERVICE_USER"

echo "==> Creating dirs"
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo "==> Copy project to $INSTALL_DIR"
echo "    rsync -a --exclude node_modules --exclude data --exclude logs ../ $INSTALL_DIR/"
echo "    (run manually, then: cd $INSTALL_DIR && npm install --omit=dev)"
echo
echo "==> Place .env at $INSTALL_DIR/.env (chmod 600, owner $SERVICE_USER)"
echo
echo "==> Install systemd unit"
cp trade.service /etc/systemd/system/trade.service
systemctl daemon-reload
echo "    systemctl enable --now trade.service"
echo "    journalctl -u trade.service -f"
