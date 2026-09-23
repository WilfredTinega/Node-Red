FROM node:22-alpine AS build
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
COPY server.js backup.js ./
COPY nodered ./nodered
# uid 1000 matches the node-red user, so both can write /auth/users.json
USER 1000
EXPOSE 1881
CMD ["node", "server.js"]
