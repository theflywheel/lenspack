# lenspack serve with the demo UI. Config, packs and boards come from a mounted
# directory, so one image serves any deployment:
#   docker build -t lenspack .
#   docker run -v "$PWD/config:/config:ro" -p 8787:8787 lenspack
# The same image runs the chat inside Apache Superset (see packages/superset):
#   docker run -v "$PWD/config:/config:ro" -v lenspack-data:/data -p 8795:8795 \
#     -e LENSPACK_SUPERSET_URL=http://superset:8088 lenspack superset --config /config/superset.yaml
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
# LENSPACK_HOST is Superset mode's listen address; serve's comes from its config.
ENV NODE_ENV=production LENSPACK_STATE_DIR=/data LENSPACK_UI=examples/demo/dist LENSPACK_HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787 8795
USER node
ENTRYPOINT ["node", "packages/serve/dist/cli.js"]
CMD ["serve", "--config", "/config/lenspack.yaml"]
