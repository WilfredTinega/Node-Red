# Node-RED admin host agent

The dashboard runs unprivileged and cannot restart, update, or reconfigure a
Node-RED that is installed on the server as an OS service (npm + systemd, a
user service, or pm2). This small agent does those three things, and only
those, so the dashboard's **Restart / Update / Connect** buttons work for
host-installed instances without SSH.

> **This agent runs as root.** It is deliberately separate from the dashboard
> so the privileged code is small and reviewable. Read `host-agent.js` before
> installing. Install it only if you want the dashboard to perform these
> actions on the host.

## What it does

Over a **root-only local unix socket**, it accepts exactly three actions for a
Node-RED identified by the port it listens on:

- **restart** — detects how that Node-RED is run (system systemd unit, user
  systemd unit, pm2, or a bare process) and restarts it that way, then checks
  it answers again.
- **update** — runs `npm install -g node-red@latest` as the owner of the global
  modules, reports the old→new version, then restarts.
- **connect** — copies `settings.js` to `settings.js.bak-<timestamp>`, then adds
  a managed block that sets `NODERED_INSTANCE` and points `adminAuth` at the
  shared `adminAuth.js`. Re-running replaces its own block; it never edits an
  existing block by hand and never removes your other settings.

It **never** reads or writes `flows.json`, `flows_cred.json`, or
`.config.*.json`. Your flows and credentials are not touched.

## Install

Copy this `host-agent/` folder to the server and run:

```sh
sudo sh install.sh
```

Then give the dashboard access to the socket (see the message the installer
prints, or `../DEPLOY.md`). Optionally set `HOST_AGENT_TOKEN` on both sides to
require a shared secret on every request.

## Uninstall

```sh
sudo systemctl disable --now nodered-admin-agent.service
sudo rm -rf /opt/nodered-admin-agent /etc/systemd/system/nodered-admin-agent.service
sudo systemctl daemon-reload
```

## Protocol (for reference)

Newline-delimited JSON on the socket:

```
request:  {"action":"restart","port":1880}
          {"action":"update","port":1880}
          {"action":"connect","port":1880,"authDir":"/opt/nodered-auth"}
response: {"ok":true,"message":"...","steps":[{"name":"...","ok":true,"detail":"..."}]}
```
