# Zeus Ecosystem

Independent integration applications and reference deployments for the Zeus framework and Zeus UI.

[Core](https://github.com/baicie/zeus) · [UI](https://github.com/baicie/zeus-ui) · [Phase 3 gates](docs/phase3-gates.md)

**Status: Phase 3a/3b bootstrap under validation.** No applications, production credentials, images, deployment workflows, or npm releases have been migrated. A compatible published Core + UI pair has **not yet been validated**.

## Ownership

| Repository | Owns |
| --- | --- |
| `zeus` | Framework runtime, compiler, core packages, framework-level fixtures |
| `zeus-ui` | Web components, gallery/docs, component-level checks |
| **`zeus-ecosystem`** | Complex application demos, app-level E2E, independent published-package integration, deployment evidence |

This repository may consume published `@zeus-js/*` and `@zeus-web/*` only; not cross-repository workspace links or source copies.

## Checks

The bootstrap runs without pnpm installation or application migrations.

```bash
node scripts/validate-repository.mjs
npm run check               # policy tests
npm run check:registry      # query published Core metadata
npm run check:core-consumer # isolated npm install and Core signal/cleanup smoke
```

**Important:** the last two commands need npm registry access. The Core-only checks do not attest to UI compatibility or browser functionality.

## Next steps

- [Dependency policy](docs/dependency-policy.md)
- [Compatibility matrix](docs/compatibility-matrix.json)
- [App inventory](docs/demo-catalog.md)
- [Phase 3 gates](docs/phase3-gates.md)
- [Migration checklist](docs/migration-checklist.md)
- [Architecture](docs/architecture.md)

No production changes are permitted before explicit release/deployment approval.
