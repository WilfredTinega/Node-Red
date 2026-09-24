#!/bin/sh
# Starts as root only to give the dashboard's own files to its uid, then runs
# the server as that uid. Bind-mounted folders arrive owned by whoever made
# them (root when Docker creates them, a person's uid when made by hand), so
# without this the server can't open /auth/users.json (EACCES).
#
# Only files the dashboard writes are touched: the two folders, users.json,
# adminAuth.js and everything in the secrets folder. /auth may hold other
# people's files, and those are left alone. Nothing is ever created here.
set -e

uid="${APP_UID:-10001}"
users_file="${USERS_FILE:-/auth/users.json}"
auth_dir="$(dirname "$users_file")"
secrets_dir="$(dirname "${SECRET_KEY_FILE:-/secrets/password.key}")"

if [ "$(id -u)" = "0" ]; then
  if [ -d "$auth_dir" ]; then
    chown "$uid" "$auth_dir" || true
    # Node-RED runs as another uid and must read these two.
    for f in "$users_file" "$auth_dir/adminAuth.js"; do
      if [ -f "$f" ]; then
        chown "$uid" "$f" || true
        chmod 644 "$f" || true
      fi
    done
  fi
  if [ -d "$secrets_dir" ]; then
    chown -R "$uid" "$secrets_dir" || true
    chmod 700 "$secrets_dir" || true
  fi
  exec su-exec "$uid" "$@"
fi

# Already running as a normal user (e.g. `user:` set in compose): nothing to fix.
exec "$@"
