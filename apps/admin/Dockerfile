# Zeus Admin: the SPA and its API server in one image.
#
# ## What this does not do any more
#
# The previous Dockerfile compiled the Rust napi compiler in a `rust:1.95` stage
# so the frontend build had a native compiler to call. That is no longer
# necessary: the compiler ships as a published platform package
# (`@zeus-js/compiler-native-darwin-arm64`, `-linux-x64-gnu` and so on), which
# pnpm resolves for the build host. Nothing here compiles Rust, and the toolchain
# is not in the image.
FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app

ARG PNPM_VERSION=10.33.4
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# The commit that started this build. `.dockerignore` removes `.git`, so the
# build has no history to read it from, and `build-info.mjs` calls
# `git rev-parse` before it falls back to the environment. Without this the
# build dies with `spawnSync git ENOENT`, which names a missing binary rather
# than a missing input. The runtime stage declares it again: an ARG does not
# carry across FROM.
ARG ZEUS_APP_COMMIT
ENV ZEUS_APP_COMMIT=${ZEUS_APP_COMMIT}

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/admin/package.json apps/admin/package.json

RUN pnpm install --frozen-lockfile --filter @zeus-ecosystem/admin...

# The build identity needs two things outside the app directory.
#
# `vite.config.ts` imports `scripts/release/build-info.mjs`, which reads
# `infra/contracts/published-pair.json` and the lockfile. Both live at the
# repository root, so a context that copies only `apps/admin` cannot resolve
# them — the same failure the Playground and AI Workbench Dockerfiles already
# document.
COPY infra/contracts ./infra/contracts
COPY scripts/release ./scripts/release

COPY apps/admin ./apps/admin

# The SPA. `vite build` runs the published compiler through the vite plugin,
# and the artifacts of that are what the runtime serves.
RUN pnpm --filter @zeus-ecosystem/admin exec vite build

# The API server, bundled to one file.
#
# `--external:node:*` keeps the builtins external; esbuild is called directly
# because tsup strips the `node:` prefix, which turns `node:sqlite` into a
# package that does not exist and only fails at startup.
RUN cd apps/admin \
  && pnpm exec esbuild server/index.ts --bundle --format=esm --platform=node \
       --target=node22 "--external:node:*" --outfile=/out/server.mjs \
  && grep -q 'from "node:sqlite"' /out/server.mjs

FROM node:24.18.0-bookworm-slim AS runtime

ARG ZEUS_APP_COMMIT
LABEL org.opencontainers.image.revision="$ZEUS_APP_COMMIT" \
  org.opencontainers.image.source="https://github.com/baicie/zeus-ecosystem" \
  org.opencontainers.image.title="zeus-admin"

WORKDIR /app
ENV NODE_ENV=production

# Ownership at copy time. A later `chown -R` rewrites every file into a second
# layer and costs more than the app itself.
RUN useradd --system --uid 10001 --create-home zeus \
  && mkdir -p /data \
  && chown zeus:zeus /data

# The layout matters: the server looks for `../dist` relative to its own file,
# so a bundle at `/app/server.mjs` finds `/app/dist`. Naming the directory
# `public` would have left the SPA unserved and every page a 404.
COPY --chown=zeus:zeus --from=build /app/apps/admin/dist ./dist
COPY --chown=zeus:zeus --from=build /out/server.mjs ./server.mjs

USER zeus

# The admin database is SQLite, behind a flag on Node 22.x and early 24.x.
ENV NODE_OPTIONS=--experimental-sqlite
ENV ZEUS_ADMIN_DB=/data/admin.sqlite
ENV ZEUS_ADMIN_HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
