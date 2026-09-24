#!/bin/sh
# Installs the Node-RED admin host agent as a root systemd service.
# Run on the server as root:  sh install.sh
#
# READ host-agent.js FIRST. This agent runs as root and lets the dashboard
# restart, update, and connect host-installed Node-RED instances. Install it
# only if you want the dashboard to perform those actions without SSH.
set -e

DIR=/opt/nodered-admin-agent
here=$(cd "$(dirname "$0")" && pwd)

install -d -m 0755 "$DIR"
install -m 0755 "$here/host-agent.js" "$DIR/host-agent.js"
install -m 0644 "$here/nodered-admin-agent.service" /etc/systemd/system/nodered-admin-agent.service

command -v node >/dev/null || { echo "node is not on PATH; install Node.js first."; exit 1; }

systemctl daemon-reload
systemctl enable nodered-admin-agent.service
# restart (not just enable --now) so a reinstall picks up new code and settings.
systemctl restart nodered-admin-agent.service
systemctl --no-pager status nodered-admin-agent.service | head -5
echo
ls -l /run/nodered-admin/agent.sock 2>/dev/null && echo "(socket should be owned by uid 10001)"

cat <<EOF

Installed. The agent listens on /run/nodered-admin/agent.sock (root only).

Give the dashboard access to the socket. With the provided docker-compose.yml,
add to the nodered-user-admin service:

  volumes:
    - /run/nodered-admin:/run/nodered-admin
  environment:
    HOST_AGENT_SOCKET: /run/nodered-admin/agent.sock

then: docker compose up -d nodered-user-admin

To require a shared secret, set HOST_AGENT_TOKEN in the .service file and the
same value as HOST_AGENT_TOKEN on the dashboard, then restart both.
EOF
