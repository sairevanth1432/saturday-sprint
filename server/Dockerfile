# Saturday Sprint app image. Build context is the "Saturday Sprint" folder (the parent of server/),
# so the portal HTML can be compiled into the image:  docker compose up -d --build   (run inside server/)
FROM node:24-slim

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Whole "Saturday Sprint" folder: the portal HTML, content packs (e.g. NIAT-topic-pack/) and server/.
# Student spreadsheets, node_modules, data and secrets are excluded by Dockerfile.dockerignore.
COPY . /app/
# Compile portal + questions + lesson catalog + uploader, then drop build-only packages.
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -f data/.dev-secret \
 && mkdir -p data public/learning-bytes \
 && chown -R node:node /app/server

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
