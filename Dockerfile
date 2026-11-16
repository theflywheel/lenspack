# lenspack serve with the demo UI. Config, packs and boards come from a mounted
# directory, so one image serves any deployment:
#   docker build -t lenspack .
#   docker run -v "$PWD/config:/config:ro" -p 8787:8787 lenspack
# To listen beyond the container's loopback, /config/lenspack.yaml sets
# `host: 0.0.0.0` and an auth block (`auth: { kind: none }` says open on purpose).
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @lenspack/example-demo build \
 && pnpm store prune
ENV NODE_ENV=production
EXPOSE 8787
USER node
ENTRYPOINT ["node", "packages/serve/dist/cli.js", "serve", "--ui", "examples/demo/dist"]
CMD ["--config", "/config/lenspack.yaml"]
