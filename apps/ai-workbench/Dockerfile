# Static AI Workbench shell.
#
# The browser talks to one origin: nginx serves the bundle and proxies
# `/ai-host/` to the reference host, injecting the bearer token server-side so
# it never reaches JavaScript.
#
# ## Build context
#
# The repository root, not the app directory: the workspace manifest, the
# lockfile and the release contract all live there, and the build asserts the
# last one. `.dockerignore` keeps node_modules, reports and the fixtures' own
# install trees out of it.
#
# ## Why nothing from the old monorepo is copied
#
# This Dockerfile used to copy `packages/`, `examples/ai-workbench` and
# `rolldown.config.ts` from a tree that no longer exists here, and ran a build
# that rebuilt the framework from source. Everything the app needs is a
# published tarball now, so the builder installs from the lockfile and builds
# one workspace package.
FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app

# Pinned so the toolchain in the image matches the one the lockfile was made
# with; `corepack` alone would float with whatever the base image ships.
ARG PNPM_VERSION=10.33.4
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# The commit that started this build. Passed in because `.dockerignore` removes
# `.git`, so the build has no history to read it from.
ARG ZEUS_APP_COMMIT
ENV ZEUS_APP_COMMIT=${ZEUS_APP_COMMIT}

# Manifests first, so a source-only change reuses the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/ai-workbench/package.json apps/ai-workbench/package.json
COPY apps/ai-host/package.json apps/ai-host/package.json

# `--filter` keeps the install to what the two apps need. The host is included
# because the workbench's gates import it, and the workspace resolves both.
RUN pnpm install --frozen-lockfile --filter @zeus-ecosystem/ai-workbench... \
  --filter @zeus-ecosystem/ai-host...

# The release contract and the builder that reads it. Copied before the source
# so `createBuildInfo` can fail closed during the build rather than emitting an
# artifact with an unverified identity.
COPY infra/contracts ./infra/contracts
COPY scripts/release ./scripts/release

COPY apps/ai-workbench ./apps/ai-workbench

# The demo recording is not part of the production build; it belongs to the
# replay surface the P0 gate builds separately.
ENV ZEUS_AI_HOST_ORIGIN=""
RUN pnpm --filter @zeus-ecosystem/ai-workbench exec vite build

# A build that produced no identity, or a synthetic one, is not shippable.
RUN node -e "\
  const info = require('/app/apps/ai-workbench/dist/build-info.json'); \
  if (info.synthetic) { console.error('build-info is synthetic; refusing to build an image'); process.exit(1) } \
  if (!/^[0-9a-f]{40}$/.test(info.app.commit)) { console.error('build-info has no app commit'); process.exit(1) } \
  console.log('build-info ok:', info.product, info.core.version, info.ui.version); \
  "

FROM nginx:1.29-alpine AS runtime

# Only the app commit describes this image. The Core and UI commits live in
# build-info, which is inside the artifact the image serves — an OCI revision
# label holding a Core SHA would name a commit that did not build this bundle.
#
# Re-declared in this stage: an ARG does not carry across FROM.
ARG ZEUS_APP_COMMIT
LABEL org.opencontainers.image.revision="$ZEUS_APP_COMMIT" \
  org.opencontainers.image.source="https://github.com/baicie/zeus-ecosystem" \
  org.opencontainers.image.title="zeus-ai-workbench"

COPY apps/ai-workbench/deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY apps/ai-workbench/deploy/entrypoint.sh /usr/local/bin/zeus-workbench-entrypoint.sh
RUN chmod +x /usr/local/bin/zeus-workbench-entrypoint.sh

# Both variables reach the template: the Host bearer token injected into the
# proxy header, and the operator's opt-in CSP source list for BYOK. A name that
# is not in this filter is left literal in the rendered config.
ENV NGINX_ENVSUBST_FILTER='^(ZEUS_AI_UPSTREAM_TOKEN|ZEUS_BYOK_CONNECT_SRC_SPACED)$'

COPY --from=build /app/apps/ai-workbench/dist /usr/share/nginx/html

# nginx's own workers drop privileges; the master needs to bind :80.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

ENTRYPOINT ["/usr/local/bin/zeus-workbench-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
