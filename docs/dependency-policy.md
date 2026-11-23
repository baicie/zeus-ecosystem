# Dependency and publication policy

## Producer and consumer boundaries

- `baicie/zeus`: Core framework packages under `@zeus-js/*`.
- `baicie/zeus-ui`: component packages under `@zeus-web/*`.
- `baicie/zeus-ecosystem`: consumes **published packages**, never source imports from either producer.

Each application is responsible for its own exact Core and UI pins. The root repository does not publish an npm package.

## Enforced automatically

`npm run check:policy` scans the root and `apps/**` / `packages/**` manifests:

1. `@zeus-js/*` and `@zeus-web/*` must have exact, registry-compatible versions.
2. `workspace:*` must only name a package defined within this repository.
3. `file:`, `link:`, Git URL, wildcard or `latest` specifications are not accepted for producer packages.
4. A `validated` entry in the matrix must reference both versions and have evidence.
5. `blocked` entries remain blocked until verified, not green merely because a manifest parses.

## Not yet enforced

Exact versions alone do not ensure runtime singleton identity. Phase 3c must add a *published Core + published UI* consumer with npm and pnpm lockfiles, inspect resolution realpaths and bundler instances, and run Chromium, Firefox and WebKit behavior tests.

## Currently

Core `0.2.0-rc.5` is published. The prior audit recorded UI `0.1.0-beta.34` as incompatible and `0.1.0-beta.35` as unpublished. A new UI release must be independently validated; do not claim that matching version numbers alone proves compatibility.

The smoke in `scripts/core-consumer-smoke.mjs` verifies **Core only** and does not promote any UI pairing in `docs/compatibility-matrix.json`.
