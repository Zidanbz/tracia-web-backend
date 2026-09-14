ARG PUPPETEER_VERSION=24.32.1

# Stage 1: Build Dependencies
FROM node:24-bookworm-slim AS dependencies

ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Production Runtime with Puppeteer / Chrome support
FROM ghcr.io/puppeteer/puppeteer:${PUPPETEER_VERSION}

USER root
WORKDIR /app

# Copy dependencies & backend source
COPY --from=dependencies --chown=pptruser:pptruser /build/node_modules ./node_modules
COPY --chown=pptruser:pptruser . .

# Buat direktori penyimpanan runtime
RUN mkdir -p storage/whatsapp-auth storage/imports \
  && chown -R pptruser:pptruser storage

# Tambahkan PUPPETEER_EXECUTABLE_PATH ke Chrome bawaan image
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_NO_SANDBOX=false \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

USER pptruser
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "./bin/www"]
