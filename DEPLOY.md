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

```sh
mkdir -p /opt/nodered-auth /opt/nodered-user-admin-secrets /opt/nodered-user-admin-config
chown 1000:1000 /opt/nodered-auth /opt/nodered-user-admin-secrets /opt/nodered-user-admin-config
```

- `/opt/nodered-auth` holds `users.json` and the `adminAuth.js` that the dashboard writes. The
  Node-RED instances read both files.
- `/opt/nodered-user-admin-secrets` holds `password.key`, `github.json`, `backup.json` and
  `dashboard-update.json`. Only the dashboard container mounts it.
- `/opt/nodered-user-admin-config` is optional. It can hold `instances.json`, which gives ports
  names and lists Node-RED instances on other machines.

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

The page is at `http://<server>:1881`. It uses host networking, so it can see every Node-RED
port. **Change the default `administrator` password straight away.**

## 4. Connect each Node-RED to the shared accounts

In each instance's `settings.js`:

```js
adminAuth: require('/auth/adminAuth.js'),               // Node-RED in Docker
adminAuth: require('/opt/nodered-auth/adminAuth.js'),   // Node-RED installed on the host
```

- **Docker:** mount the folder with `-v /opt/nodered-auth:/auth`. Set
  `NODERED_INSTANCE=<host port>` (for example `1880`). This is the key the dashboard shows
  for that instance.
- **Host install:** nothing more is needed if it listens on `PORT` or on 1880. Otherwise set
  `NODERED_INSTANCE`.

Restart the instance. Account changes take effect at the next login.

## 5. Dashboard updates

1. You push to `main`.
2. The `docker` workflow tests the commit, then builds and pushes `:<sha>` and `:latest`.
3. The dashboard shows **Update available**. It shows this only after a `push` run on the
   configured branch has *succeeded* for a commit other than the one it runs.
4. **Update** pulls `ghcr.io/<repo>:<sha>` and recreates the dashboard's own container.
   It finds that container by the label `nodered-admin.role=dashboard`.

Things to keep in mind:
- Runs started by hand (`workflow_dispatch`) publish images, but the dashboard does not offer them.
- A push made while a build is running waits for that build. It is never cancelled halfway.
- If the workflow file is renamed, set `DASHBOARD_WORKFLOW` on the dashboard to the new name.

## 6. Letting the dashboard write to Docker

Out of the box, the `docker-proxy` service lets the dashboard list, restart and start containers
only. The **Update** buttons also need these settings under `docker-proxy` → `environment`:

```yaml
IMAGES: 1
POST: 1
```

Then run `docker compose up -d`. **This is root-equivalent.** With these settings the dashboard
can create containers with any image, mount, or privilege. Anyone who controls the dashboard, or
its GitHub token, controls the server. Turn them on only after the dashboard is behind HTTPS
(`SECURE_COOKIE: "1"`) and the default administrator password has been changed. The proxy
listens on `127.0.0.1:2375` only, so keep it that way.

## 7. Back up the key

Back up **`/opt/nodered-user-admin-secrets/password.key`** somewhere off the server. Without it,
the viewable passwords and the stored GitHub token cannot be decrypted. Node-RED logins keep
working, because they use the bcrypt hashes in `users.json`.
