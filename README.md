# Zeus Ecosystem

The integration and reference-application repository for the Zeus framework and Zeus UI.

**Phase 3a foundation only.** This repository currently contains no migrated applications, production workflows, credentials, or released packages. It deliberately does not claim a successful Core/UI runtime integration.

## Repository responsibilities

- `apps/`: advanced application demos and reference consumers (AI Workbench, AI Host, Admin are planned; not yet migrated).
- `e2e/`: application-level and cross-product end-to-end tests.
- `infra/`: application container and deployment definitions once explicitly approved.
- `docs/`: compatibility evidence, demo catalog, architecture decisions.
- `scripts/`: repository policy and migration validation tools.

The framework and UI component library continue to live in [`baicie/zeus`](https://github.com/baicie/zeus) and [`baicie/zeus-ui`](https://github.com/baicie/zeus-ui).

## Dependency boundaries

- Applications must consume **registry-published, pinned** versions of `@zeus-js/*` and `@zeus-web/*`.
- Never use cross-repository `workspace:*`, `file:`, `link:`, Git URL, or copied upstream package sources for published product packages.
- `workspace:*` is permitted only for packages actually defined **inside this repository**.
- The complete Core + UI runtime compatibility gate is pending a compatible published UI release and independent consumer tests.
- No npm publishing workflow belongs in this consumer repository.

## Checks

```bash
node scripts/validate-repository.mjs
```

This static policy check is **not** a substitute for install/build/E2E gates, which will be added when the first application is migrated.

## Migration sequence

1. Phase 3a: repository and static policy CI (this bootstrap).
2. Phase 3b: compatibility matrix, update policy, and permissions review.
3. Phase 3c: **published-package consumer** installation and runtime verification, after compatible Core/UI versions are available.
4. Phase 4: migrate AI Workbench and AI Host as the first integration workload, only after approved gates.
5. Later: Admin, production acceptance, image/SBOM/size evidence, and controlled cutover.

**No application migration or production deployment is authorized by bootstrapping this repository.**
