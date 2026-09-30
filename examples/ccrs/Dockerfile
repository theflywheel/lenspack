# CCRS's dashboard analytics, answered by lenspack. Build from the repository root:
#   docker build -f examples/ccrs/Dockerfile -t ccrs-lenspack .
# Run beside a CCRS deployment:
#   docker run -e CCRS_PG_URL=postgres://… -e CCRS_UPSTREAM=http://kong:8000 -p 8795:8795 ccrs-lenspack
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm store prune
ENV HOST=0.0.0.0 PORT=8795 NODE_ENV=production
EXPOSE 8795
USER node
CMD ["node_modules/.bin/tsx", "examples/ccrs/server.ts"]
