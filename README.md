# Zeus Ecosystem

Independent integration applications and reference deployments for the Zeus framework and Zeus UI.

[Core](https://github.com/baicie/zeus) · [UI](https://github.com/baicie/zeus-ui) · [Phase 3 gates](docs/phase3-gates.md)

**Status: Phase 3a/3b and Core-only consumer smoke passed.** No applications, production credentials, images, deployment workflows, or npm releases have been migrated. A compatible published Core + UI pair has **not yet been validated**.

## Ownership

| Repository | Owns |
| --- | --- |
| `zeus` | Framework runtime, compiler, core packages, framework-level fixtures |
| `zeus-ui` | Web components, gallery/docs, component-level checks |
| **`zeus-ecosystem`** | Complex application demos, app-level E2E, independent published-package integration, deployment evidence |

This repository consumes published `@zeus-js/*` and `@zeus-web/*` packages only, not cross-repository workspace links or source copies.

## Checks

```bash
npm run check               # dependency policy and regression tests
npm run check:registry      # query published Core rc.5 metadata
npm run check:core-consumer # independent registry install and signal/cleanup smoke
```

The [manual published-pair workflow](.github/workflows/published-pair-preflight.yml) checks a requested Core/UI pair with strict npm and pnpm installation on Node 22/24. Its result is only install/dependency evidence; browser runtime acceptance remains a separate gate.

## Documentation

- [Dependency policy](docs/dependency-policy.md)
- [Compatibility matrix](docs/compatibility-matrix.json)
- [App inventory](docs/demo-catalog.md)
- [Phase 3 gates](docs/phase3-gates.md)
- [Migration checklist](docs/migration-checklist.md)
- [Architecture](docs/architecture.md)

No production changes are permitted before explicit release/deployment approval.
