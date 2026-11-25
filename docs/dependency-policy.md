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

## Enforced by the contracts

Three files record what the repository depends on, and a script checks each:

| File | Records | Checked by |
| --- | --- | --- |
| `infra/contracts/published-pair.json` | Core and UI version, tag, tag object, commit | `check-published-pair-contract.mjs` |
| `infra/contracts/products.json` | Each product's Dockerfile, port, health path, size budget, unit | `check-published-pair-contract.mjs`, `build-image.mjs` |
| `docs/compatibility-matrix.json` | Whether this pair is validated, and on what evidence | `validate-repository.mjs` |

The pair contract is checked **against reality**, not only against itself:

- each app and fixture manifest must pin exactly the recorded versions;
- each tag must still resolve to the recorded commit, with annotated tags
  peeled — reading `ref.object.sha` without peeling yields a SHA that never
  built anything;
- the matrix's status must agree with the contract's.

`--offline` runs the structural half, so a PR that bumps one manifest without
recording it fails without needing a token.

## Singleton identity

Exact versions do not by themselves guarantee a single runtime engine. That is
what the browser fixtures exist for: they install only published packages and
run in three engines, and the `native` fixture asserts that effects run across
the Core/UI boundary. Duplicate engine copies fail the assertion rather than
passing silently.

## Currently

Core `0.2.0-rc.5` and UI `0.1.0-beta.35` are both published and validated
together: 90 browser checks across five fixtures and three engines, plus
install and build under npm and pnpm on Node 22 and 24.

Two version lines remain independent by design:

- `@zeus-js/vite-plugin` is `0.0.6`, not the Core version. Pinning it to Core
  fails with `ERR_PNPM_NO_MATCHING_VERSION`.
- `@zeus-js/devtools-consumer` is `0.1.1-beta.15` on the same independent line.
- Both are recorded under `independent` in `infra/contracts/published-pair.json`,
  and `check:matrix` refuses to install anything when its pinned copy disagrees
  with that contract.

`0.0.6` also fixed a compiler-line mismatch: `0.0.5` depended on
`@zeus-js/compiler-native@0.1.1-beta.20` while the rc.5 packages depend on
`0.2.0-rc.5`, so two versions coexisted and the plugin loaded the older one.
