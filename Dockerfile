# The front-end build is the same on every architecture, so it runs natively
# on the build machine instead of under arm64 emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
# su-exec drops from root to the app uid in the entrypoint.
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js backup.js github.js docker.js self-update.js reset-admin.js host-agent-client.js activity-log.js ./
COPY nodered ./nodered
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
# The commit this image was built from; the dashboard compares it with the
# newest GitHub Actions build to know when an update is available.
ARG REVISION=dev
ENV APP_REVISION=$REVISION
# Lets the dashboard find its own container when it updates itself.
LABEL nodered-admin.role="dashboard" org.opencontainers.image.revision=$REVISION
# Its own uid, not 1000: Node-RED (and the default Linux user) run as 1000 and
# must not be able to read /secrets or write users.json. Node-RED only needs
# to read /auth, and the dashboard writes users.json and adminAuth.js 0644.
# The container starts as root so the entrypoint can give the mounted folders
# to this uid, then the server runs as it. No passwd entry is needed.
ARG UID=10001
ENV APP_UID=$UID
EXPOSE 1881
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
