# Zeus Playground: the editor and the untrusted preview, in one image.
#
# ## What this does not do any more
#
# The previous Dockerfile started from `rust:1.95-bookworm`, copied `crates/`
# and `packages/`, installed the wasm32 target and built the compiler from
# source. That belongs to the core repository. Here every Zeus package comes
# from npm — including `@zeus-js/compiler-wasm`, whose published tarball carries
# `zeus-compiler.wasm` — so there is no Rust toolchain in this image and no
# core source tree to copy.
#
# ## Two listeners, one image
#
# `:80` serves the trusted host, `:81` the untrusted preview. The sandbox
# server sends `Content-Security-Policy: sandbox allow-scripts`, which is what
# makes the browser give that document an opaque origin. Serving both on one
# origin would silently drop the isolation, so the second listener is part of
# the product, not a build detail.
FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app

ARG PNPM_VERSION=10.33.4
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/playground/package.json apps/playground/package.json

RUN pnpm install --frozen-lockfile --filter @zeus-ecosystem/playground...

COPY apps/playground ./apps/playground

# The sandbox document may be mounted under a path prefix in production, so its
# asset URLs must be relative; `vite.config.ts` rewrites them at build time.
ARG VITE_ZEUS_SANDBOX_URL
ARG VITE_ZEUS_SANDBOX_ORIGIN
ARG VITE_ZEUS_PLAYGROUND_HOST_ORIGINS
ENV VITE_ZEUS_SANDBOX_URL=$VITE_ZEUS_SANDBOX_URL \
    VITE_ZEUS_SANDBOX_ORIGIN=$VITE_ZEUS_SANDBOX_ORIGIN \
    VITE_ZEUS_PLAYGROUND_HOST_ORIGINS=$VITE_ZEUS_PLAYGROUND_HOST_ORIGINS

RUN pnpm --filter @zeus-ecosystem/playground exec vite build

# `zeus-compiler.wasm` is a published asset of the compiler package, resolved by
# `new URL('./zeus-compiler.wasm', import.meta.url)` inside the bundle. If the
# build stopped emitting it the image would start and fail on first compile, so
# its presence is asserted here rather than discovered in production.
RUN test -n "$(ls apps/playground/dist/assets/*.wasm 2>/dev/null)" \
    || (echo "no .wasm asset in dist: the published compiler package did not resolve" >&2 && exit 1)

FROM nginx:1.29-alpine AS runtime

ARG ZEUS_APP_COMMIT
ARG ZEUS_VERSION
LABEL org.opencontainers.image.revision=$ZEUS_APP_COMMIT \
      org.opencontainers.image.version=$ZEUS_VERSION

COPY apps/playground/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/playground/dist /usr/share/nginx/html

EXPOSE 80 81

# Without this, `docker inspect .State.Health` is empty and the release gate's
# health check falls back to `.State.Status` — which reads `running` forever and
# reports `health check: timeout` sixty seconds later. The other three apps
# declare one; this one did not.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
