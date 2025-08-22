FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN (npm ci --omit=dev --only=production) || (npm install --omit=dev)

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./server.js
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node","server.js"]