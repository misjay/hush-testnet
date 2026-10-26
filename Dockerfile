# Hush testnet server. Node 22.18+ runs the TypeScript sources directly.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    HUSH_DB=/data/hush.db \
    PORT=8787 \
    HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY web ./web

# SQLite lives on a volume so vaults and the ledger survive restarts.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "--disable-warning=UNDICI-EHPA", "src/server.ts"]
