FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN (npm ci --omit=dev --only=production) || (npm install --omit=dev)

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# Copie apenas o que precisa (evita lixo do contexto)
COPY server.js ./server.js
# Se preferir, copie outros arquivos explicitamente (package.json, etc)

# --- Higienização do arquivo, e um log pra você ver no build ---
# 1) remove CRLF de fim de linha (Windows)
# 2) remove BOM UTF-8, se existir
# 3) remove uma barra invertida no início da primeira linha, se existir
RUN sed -i 's/\r$//' server.js \
 && (printf '%s' "$(tail -c +4 server.js)" > server.js || true) \
 && head -c 1 server.js | grep -q '\\' && sed -i '1s/^\\//' server.js || true \
 && echo '--- HEAD server.js ---' && head -n 2 server.js

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node","server.js"]