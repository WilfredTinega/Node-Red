# The front-end build is the same on every architecture, so it runs natively
# on the build machine instead of under arm64 emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js backup.js github.js docker.js self-update.js ./
COPY nodered ./nodered
# The commit this image was built from; the dashboard compares it with the
# newest GitHub Actions build to know when an update is available.
ARG REVISION=dev
ENV APP_REVISION=$REVISION
# Lets the dashboard find its own container when it updates itself.
LABEL nodered-admin.role="dashboard" org.opencontainers.image.revision=$REVISION
# uid 1000 matches the node-red user, so both can write /auth/users.json
USER 1000
EXPOSE 1881
CMD ["node", "server.js"]
