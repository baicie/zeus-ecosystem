# The AI Host runtime image: Node plus one bundled ESM file.
#
# ## Why single-file
#
# The previous single-stage image carried the whole workspace dependency tree:
# 269.2 MB compressed / 676.2 MB uncompressed, of which `/app/node_modules`
# alone was 428 MB (rolldown bindings, three esbuild copies, typescript,
# playwright). None of it is imported at runtime — the server needs `node:*`
# builtins plus the published `@zeus-web/ai-core`, which is plain ESM.
#
# ## What changed with the move
#
# The builder used to copy `packages/`, `examples/ai-host` and
# `rolldown.config.ts` from the old monorepo and run a full workspace build.
# Here the host is one workspace package built against published tarballs, so
# the builder installs from the lockfile and bundles.
FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app

ARG PNPM_VERSION=10.33.4
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/ai-host/package.json apps/ai-host/package.json

RUN pnpm install --frozen-lockfile --filter @zeus-ecosystem/ai-host...

COPY apps/ai-host ./apps/ai-host

# esbuild, not tsup: tsup rewrites every `node:` specifier to a bare package
# name, so `node:sqlite` became `sqlite` and the bundle failed at startup with
# ERR_MODULE_NOT_FOUND. Calling esbuild directly keeps the prefix.
RUN cd apps/ai-host \
  && pnpm exec esbuild src/server.ts --bundle --format=esm --platform=node \
       --target=node22 "--external:node:*" --outfile=/out/server.mjs \
  && grep -q 'from "node:sqlite"' /out/server.mjs \
  && echo "bundle keeps the node: prefix"

# A bundle that cannot resolve its database driver is not shippable, and the
# failure only shows at startup. This checks resolution without executing the
# module: importing it starts a server.
RUN node --experimental-sqlite -e "\
  const { readFileSync } = require('node:fs'); \
  const source = readFileSync('/out/server.mjs', 'utf8'); \
  const specifiers = [...source.matchAll(/from \"([^\"]+)\"/g)].map(m => m[1]); \
  const external = specifiers.filter(s => !s.startsWith('node:')); \
  if (external.length > 0) { console.error('bundle imports non-builtin modules:', external); process.exit(1) } \
  for (const needed of ['node:sqlite', 'node:http', 'node:fs']) { \
    if (!specifiers.includes(needed)) { console.error('bundle no longer imports', needed); process.exit(1) } \
  } \
  console.log('bundle imports only node: builtins'); \
  "

FROM node:24.18.0-bookworm-slim AS runtime

# The app commit, because it is the one that describes this image. Core and UI
# identity live in build-info, which is not shipped in this image; holding a
# Core SHA here would name a commit that did not build this bundle.
ARG ZEUS_APP_COMMIT
LABEL org.opencontainers.image.revision="$ZEUS_APP_COMMIT" \
  org.opencontainers.image.source="https://github.com/baicie/zeus-ecosystem" \
  org.opencontainers.image.title="zeus-ai-host"

WORKDIR /app
ENV NODE_ENV=production

# Ownership at copy time. A later `chown -R /app` rewrote every file into a
# second layer and alone cost 98.9 MB of the old image.
RUN useradd --system --uid 10001 --create-home zeus \
  && mkdir -p /data \
  && chown zeus:zeus /data

COPY --chown=zeus:zeus --from=build /out/server.mjs ./server.mjs

USER zeus

# `node:sqlite` needs the flag on 22.x and early 24.x; passing it where it is
# unnecessary is harmless, so the runtime sets it unconditionally rather than
# branching on the version inside an entrypoint script.
ENV NODE_OPTIONS=--experimental-sqlite
ENV ZEUS_AI_DB=/data/ai.sqlite
ENV ZEUS_AI_HOST=0.0.0.0
ENV ZEUS_AI_WORKSPACE=/data/workspace
ENV ZEUS_AI_WORKSPACE_ID=reference
ENV PORT=8788

EXPOSE 8788
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
