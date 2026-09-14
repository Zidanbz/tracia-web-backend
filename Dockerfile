# Stage 1: Build Dependencies & Download Chrome
FROM node:24-bookworm-slim AS dependencies

ENV PUPPETEER_CACHE_DIR=/cache/puppeteer
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npx puppeteer browsers install chrome

# Stage 2: Production Runtime
FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app

COPY --from=dependencies --chown=pptruser:pptruser /build/node_modules ./node_modules
COPY --from=dependencies --chown=pptruser:pptruser /cache/puppeteer /home/pptruser/.cache/puppeteer
COPY --chown=pptruser:pptruser . .

RUN mkdir -p storage/whatsapp-auth storage/imports \
  && chown -R pptruser:pptruser storage

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_NO_SANDBOX=false \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

USER pptruser
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "./bin/www"]
