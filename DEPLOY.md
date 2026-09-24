# Deploying the Node-RED user admin dashboard

## 1. Put the code on GitHub

1. Create a **private** repository on GitHub (for example `OWNER/nodered-user-admin`).
2. Push this folder to its `main` branch.
3. On the **Actions** tab, the `docker` workflow builds the image for `linux/amd64` and
   `linux/arm64` (Raspberry Pi). When it finishes, the image is at
   `ghcr.io/<owner>/<repo>` (lowercase), tagged with the full commit sha and `latest`.
   The `ci` workflow checks every push and pull request, and it does not publish anything.

## 2. Create the token the dashboard uses

Create a **classic personal access token** with the scopes **`repo`** and **`read:packages`**.
The dashboard uses it to read the Actions runs, to pull the private image, and for flow backups.
You paste it on the dashboard's GitHub page, which stores it encrypted with `password.key`.

## 3. One-time server setup

The dashboard runs as **uid 10001** inside its container (`ARG UID` in the Dockerfile), not as
uid 1000 like Node-RED. So a Node-RED process, or the default Linux user, can neither read the
key in the secrets folder nor rewrite `users.json`.

```sh
mkdir -p /opt/nodered-auth /opt/nodered-user-admin-secrets /opt/nodered-user-admin-config
```

No `chown` is needed: the container starts as root, gives the two folders, `users.json`,
`adminAuth.js` and the secrets files to uid 10001 (making the first two `0644` and the secrets
folder `0700`), then runs the server as that uid. Other files in `/opt/nodered-auth` are not
touched. If you prefer to prepare the ownership yourself, this is what it does:

```sh
chown -R 10001:10001 /opt/nodered-auth /opt/nodered-user-admin-secrets
chmod 755 /opt/nodered-auth && chmod 644 /opt/nodered-auth/users.json
chmod 700 /opt/nodered-user-admin-secrets
```

Installing the dashboard never creates a Node-RED instance. `docker-compose.yml` defines only
the dashboard and its Docker proxy; the dashboard finds the instances that already exist.

- `/opt/nodered-auth` holds `users.json` and the `adminAuth.js` that the dashboard writes, both
  `0644`: every Node-RED, whatever uid it runs as, reads them; only the dashboard writes them.
  Node-RED containers mount it **read-only** (`/opt/nodered-auth:/auth:ro`).
- `/opt/nodered-user-admin-secrets` holds `password.key`, `settings.json`, `github.json`,
  `backup.json`, `dashboard-update.json` and, after the first start, `initial-admin-password`.
  All `0600`, folder `0700`. Only the dashboard container mounts it.
- `/opt/nodered-user-admin-config` is optional. It can hold `instances.json`, which gives ports
  names, lists Node-RED instances on other machines, and marks which instances use the shared
  accounts (`"sharedLogins": true`). It is mounted read-only, so its owner does not matter.

The dashboard never writes anywhere else: not into any Node-RED `/data` or `~/.node-red`, and
never `flows*.json`, `settings.js` or `.config.*.json`. If `/opt/nodered-auth` already has files:
- `users.json` keeps every existing user and its file permissions. Only the `administrator`
  account is added (or given full access again). A `users.json` it can't read is left alone.
- An `adminAuth.js` that this dashboard didn't write is left alone, and the log says so. Move it
  away yourself if you want the dashboard's version.
- Other files are not touched. No file there is ever deleted.

If the folders are missing when the dashboard starts, Docker creates them owned by root and the
entrypoint gives them to uid 10001 before the server starts, so this works too. If the log shows
`EACCES` on `/auth/users.json`, the container was started with `user:` set in compose (the
entrypoint then can't change ownership): remove it, or run the `chown` lines above.

If the package is private, log the server in to the registry once, using the same token:

```sh
echo <token> | docker login ghcr.io -u <github user> --password-stdin
```

In `docker-compose.yml`, replace `ghcr.io/OWNER/REPO:latest` with your repository in lowercase.
Also check `PUBLIC_HOST` and `TZ`. Set `SECURE_COOKIE: "1"` once the dashboard is served
over HTTPS. Then start it:

```sh
docker compose up -d
```

### The first login

`DEFAULT_ADMIN_PASSWORD` is left unset in `docker-compose.yml`. On the first start, the dashboard
makes a random password for `administrator`, writes it to
`/opt/nodered-user-admin-secrets/initial-admin-password` (`0600`, readable by root and
uid 10001) and logs one line saying so. The password itself is never logged. Read it with
`sudo cat /opt/nodered-user-admin-secrets/initial-admin-password`, log in at
`http://<server>:1881`, and **change it straight away**; then delete the file. Setting
`DEFAULT_ADMIN_PASSWORD` in the compose file instead is only for throwaway installs
(`docker-compose.local.yml` does that for the local test stack).

### Passwords are stored as hashes only

`users.json` holds bcrypt hashes and nothing else, by default. When an admin generates a
password, the dashboard shows it once in the response and does not keep it. Under
**Settings** (`viewablePasswords`), an admin can turn on *viewable passwords*: from then on each
password set or reset is also stored encrypted (AES-256-GCM with `password.key`) so admins can
view it later. Turning the setting off removes every stored copy at once. Passwords set while
the setting was off cannot be viewed until they are reset. The setting lives in
`/opt/nodered-user-admin-secrets/settings.json`.

### How the dashboard sees the server

The dashboard runs on the compose network, not the host's. That keeps the Docker proxy private
(see section 6). It reaches the host's ports through `host.docker.internal` (`PROBE_HOST`) and
reads the host's listening ports from the host's socket tables, mounted read-only at `/hostnet`
(`/proc/1/net:/hostnet:ro`, `HOST_NET_DIR=/hostnet`). To find Node-RED installed as a package,
it sends one `GET /` (1.5 s timeout, no redirects) to each listening port when someone opens
the Instances page (at most every 15 seconds). Well-known ports such as SSH, mail, databases,
MQTT and the Docker API are skipped, as is its own published port (`PUBLIC_PORT`, default
`PORT`). List any other port that must not be touched in `SCAN_SKIP_PORTS` (e.g. `"8080,9000"`),
or set `SCAN_HOST_PORTS: "0"` to turn the scan off and name the instances in `instances.json`.

**Trade-off:** a Node-RED bound to `127.0.0.1` only on the host is not reachable from the compose
network, so it is neither discovered nor probed, and cannot be backed up. Either bind it to all
interfaces (a firewall can still keep it local), or run the dashboard on the host network
instead: replace `ports`, `extra_hosts` and the `/hostnet` mount with `network_mode: host`, and
set `PROBE_HOST: 127.0.0.1`, `HOST_NET_DIR: /proc/net`, `DOCKER_API: http://127.0.0.1:2375`,
publishing the proxy on `127.0.0.1:2375`. In that layout **every process on the host** can use the
proxy, with everything section 6 says that means, so prefer the default.

## 4. Connect each Node-RED to the shared accounts

The dashboard never edits `settings.js` itself. You make this change by hand, one instance at a
time. Once an instance is switched, **only** the accounts on the Users page can log in to it.
Any users in its old `adminAuth` block stop working. So before you switch an instance:

1. Log in to the dashboard as `administrator` and change its password. Then add every person who
   needs this instance on the Users page.
2. Keep a copy of the old file (`cp settings.js settings.js.before-shared-logins`). To go back,
   restore the copy and restart.
3. Check the Node-RED user can read `/opt/nodered-auth/users.json` (it is `0644`, so any user
   can, unless the permissions were changed by hand). If it can't, every login is refused.

Then, in the instance's `settings.js`:

```js
adminAuth: require('/auth/adminAuth.js'),               // Node-RED in Docker
adminAuth: require('/opt/nodered-auth/adminAuth.js'),   // Node-RED installed on the host
```

- **Docker:** mount the folder read-only with `-v /opt/nodered-auth:/auth:ro`. Set
  `NODERED_INSTANCE=<host port>` (for example `1880`). This is the key the dashboard shows
  for that instance. Without it, users limited to certain instances are refused on this one, the
  Instances page marks the container with a key warning, and Node-RED logs a warning at start.
  Adding the mount means recreating the container. Give the new container the
  **same `/data`** as the old one. Check it first with
  `docker inspect -f '{{json .Mounts}}' <container>`. If `/data` is an anonymous volume (a
  long hex name), mount that volume by name with `-v <that name>:/data`. Otherwise the new
  container starts with no flows.
- **Host install:** nothing more is needed if it listens on `PORT` or on 1880. Otherwise set
  `NODERED_INSTANCE`. Add `"sharedLogins": true` to its `instances.json` entry so backups may
  log in to it (containers mounting `/auth` are recognised on their own).

Restart the instance. Account changes take effect at the next login, and an editor session's
permissions are refreshed within 8 hours (`sessionExpiryTime` in `adminAuth.js`; Node-RED's own
default is 7 days). Node-RED reads `adminAuth.js` only when it starts. The dashboard replaces
its copy in one step on each start, so a running Node-RED is never affected. It uses the new
copy at its next restart.

### The backup login

Backups read each instance's flows. Instances without a login need none. Instances that ask for
one are logged in to with the account **`nodered-backup`**, which the dashboard creates itself
in `users.json` the first time a backup needs it: permissions `read`, marked as a system account
on the Users page, with a random password kept only encrypted in `backup.json`. It is never the
`administrator` account. If someone deletes or resets `nodered-backup`, the next backup makes a
new password and repairs the record; its access level cannot be edited. You can name a
different login on the Backups page instead.

A login is only ever sent to instances that use the shared accounts: containers mounting
`/auth`, and `instances.json` entries with `"sharedLogins": true`. Anything else that asks for a
login, including every instance on another machine that is not marked so, is skipped with the
error "not using the shared accounts, no login sent". So a stray service that merely looks like
Node-RED never receives a password.

## 5. Dashboard updates

1. You push to `main`.
2. The `docker` workflow tests the commit, then builds and pushes `:<sha>` and `:latest`.
3. The dashboard shows **Update available**. It shows this only after a `push` run on the
   configured branch has *succeeded* for a commit other than the one it runs.
4. **Update** pulls `ghcr.io/<repo>:<sha>` and recreates the dashboard's own container.
   It finds that container by the label `nodered-admin.role=dashboard` and its own container id,
   and starts a short-lived helper container on the dashboard's own network to do the swap.
   Only one update runs at a time; a second request while one is in progress is refused.

Things to keep in mind:
- Runs started by hand (`workflow_dispatch`) publish images, but the dashboard does not offer them.
- A push made while a build is running waits for that build. It is never cancelled halfway.
- If the workflow file is renamed, set `DASHBOARD_WORKFLOW` on the dashboard to the new name.

## 6. Letting the dashboard write to Docker

Out of the box, the `docker-proxy` service lets the dashboard list, inspect, restart and start
containers only. The **Update** buttons also need these settings under `docker-proxy` →
`environment`:

```yaml
IMAGES: 1
POST: 1
```

Then run `docker compose up -d`.

What **Update** does to a Node-RED container: it pulls the newest image for the container's own
tag and stops the container. It renames the old one and creates a new one with the same name,
mounts (bind folders, named and anonymous volumes, `--mount` volumes, tmpfs), environment,
labels, ports, restart policy and networks. It removes the old container only after the new one
is still running 5 seconds later, and it removes it **without** its volumes. If anything fails,
including the rename right after the stop, the new container is removed and the old one is
renamed back and started, unchanged. It refuses containers started with `--rm`, because stopping
those deletes them and their volumes. It also refuses containers pinned to an image digest.
Restart and Update stop Node-RED like `docker restart` does, so anything kept only in memory
(memory context) is lost. Flows and credentials are not affected.

**This is root-equivalent.** With these settings the dashboard
can create containers with any image, mount, or privilege. Anyone who controls the dashboard, or
its GitHub token, controls the server. Turn them on only after the dashboard is behind HTTPS
(`SECURE_COOKIE: "1"`) and the initial administrator password has been changed.

The proxy has **no `ports:`** and is reachable only from the compose network, i.e. by the
dashboard. Do not publish it, not even on `127.0.0.1`: a port on loopback is open to every
process on the host, so a Node-RED installed on the host (a function node is enough) could read
`/containers/<dashboard>/archive?path=/secrets` through it, and with `POST=1` create a
privileged container and become root.

## 7. Back up the key

Back up **`/opt/nodered-user-admin-secrets/password.key`** somewhere off the server. Without it,
the viewable passwords (if turned on), the backup login and the stored GitHub token cannot be
decrypted. Node-RED logins keep working, because they use the bcrypt hashes in `users.json`.

## Forgot the administrator password

From the server, inside the running dashboard container:

```sh
docker exec nodered-user-admin node reset-admin.js 'NewPassword123'   # or leave the password out for a random one, which it prints
```

It rewrites only the `administrator` entry in `users.json` (full access, no instance limits) and
works at the next login. Node-RED instances need no restart.

## Local test stack

`docker-compose.local.yml` runs the same topology on this machine: the dashboard on `1891`
(`PUBLIC_PORT: "1891"`, `PORT: "1881"` inside) with `DEFAULT_ADMIN_PASSWORD: oponde9422`.
A test Node-RED on `1890` (mounting `./local-test/auth:/auth:ro`) is opt-in through the
`test-nodered` profile, so the plain command starts no Node-RED:

```sh
docker compose -f docker-compose.local.yml up -d --build                          # dashboard + proxy
docker compose -f docker-compose.local.yml --profile test-nodered up -d --build   # plus the test Node-RED
```

The folders under `local-test/` need no `chown`; the container's entrypoint does it.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `1881` | Port the server listens on inside the container. |
| `PUBLIC_PORT` | `PORT` | Host port it is published on; skipped by the port scan. |
| `PROBE_HOST` | `127.0.0.1` | Where host ports are reached; `host.docker.internal` on the compose network. |
| `HOST_NET_DIR` | `/proc/net` | Folder with the host's `tcp`/`tcp6` tables; `/hostnet` on the compose network. |
| `DOCKER_API` | (off) | The Docker socket proxy, e.g. `http://docker-proxy:2375`. |
| `DEFAULT_ADMIN_PASSWORD` | (unset) | First `administrator` password; unset means random, see `INITIAL_PASSWORD_FILE`. |
| `INITIAL_PASSWORD_FILE` | `/secrets/initial-admin-password` | Where the random first password is written (`0600`). |
| `SETTINGS_FILE` | `/secrets/settings.json` | `{ "viewablePasswords": false }`. |
| `USERS_FILE`, `SECRET_KEY_FILE`, `BACKUP_FILE`, `GITHUB_FILE`, `DASHBOARD_UPDATE_FILE`, `INSTANCES_FILE` | `/auth/users.json`, `/secrets/…`, `/config/instances.json` | Data files. |
| `SCAN_HOST_PORTS`, `SCAN_SKIP_PORTS` | `1`, (none) | Port scan on/off and extra ports to skip. |
| `PUBLIC_HOST`, `AUTH_HOST_DIR`, `TZ`, `SECURE_COOKIE`, `LOCKED_ADMIN` | | As before. |
| `UID` (build arg) | `10001` | The uid the container runs as. |
