# lenspack serve with the demo UI. Config, packs and boards come from a mounted
# directory, so one image serves any deployment:
#   docker build -t lenspack .
#   docker run -v "$PWD/config:/config:ro" -p 8787:8787 lenspack
# Sign-in is the built-in admin and a password unless lenspack.yaml says
# otherwise: pass LENSPACK_ADMIN_PASSWORD, or mount /data and read the one made
# at first start from /data/admin-password.txt (then delete it):
#   docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8787:8787 lenspack
# Without a volume on /data, a made password is lost with the container;
# replicas share one /data, or one LENSPACK_ADMIN_PASSWORD and sessionSecret.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @lenspack/example-demo build \
 && pnpm store prune
ENV NODE_ENV=production LENSPACK_STATE_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
ENTRYPOINT ["node", "packages/serve/dist/cli.js", "serve", "--ui", "examples/demo/dist"]
CMD ["--config", "/config/lenspack.yaml"]
