# Zeus Ecosystem

Independent integration applications and reference deployments for the Zeus
framework and Zeus UI.

[Core](https://github.com/baicie/zeus) · [UI](https://github.com/baicie/zeus-ui) · [Migration checklist](docs/migration-checklist.md)

## Status

The validated pair is **Core `0.2.0-rc.5` + UI `0.1.0-beta.35`**, with
`@zeus-js/vite-plugin` on its own `0.0.6` line.

Three applications live here, all built from published packages only:

| App | What it is |
| --- | --- |
| `apps/ai-workbench` | The AI shell: conversation, BYOK, CSP boundary, replay surface |
| `apps/ai-host` | The reference host behind it: SSE, commands, approvals, SQLite |
| `apps/admin` | The product shell: router, query, i18n, users, forms, data grid |

Migration state is tracked per stage, not as one boolean. The vocabulary, and
the evidence each stage requires, is in
[docs/migration-checklist.md](docs/migration-checklist.md):

```
SOURCE_MIGRATED        code is here, on published packages
LOCAL_TESTED           typecheck, unit tests and build pass locally
CI_VALIDATED           a CI run on the latest HEAD is green
VISUAL_VALIDATED       screenshots compared against a reviewed baseline
IMAGE_VALIDATED        the image builds, starts and answers its health path
DEPLOYMENT_REHEARSED   a plan and a rollback were exercised
PRODUCTION_ACCEPTED    a real deployment was accepted
LEGACY_REMOVED         the old implementation is gone
```

Admin reaches `DEPLOYMENT_REHEARSED` with a real cross-version rehearsal
against the previously published image; the AI apps reach `IMAGE_VALIDATED`.
None is `PRODUCTION_ACCEPTED` — no production deployment has happened, and the
plan script refuses to produce a production plan at all.

`VISUAL_VALIDATED` is the one stage nobody has finished, and the reason is
narrow: the reference build decides its interface language differently from the
current one, so seven of eight scenarios render in different languages and a
pixel comparison would measure the translation. The eighth is compared.
`DesignReview` needs a person looking at the screenshots, and a script that
filled it in would be recording an opinion nobody holds.

Page permissions, separately, are proven in a browser: `check:permissions`
drives a viewer's session against a real server and asserts the disabled
controls, the enabled personal preferences, the 403 error pages, the server
refusing the write, and — the case that catches a blanket "disable it for
everyone" — an administrator still able to save.

## Evidence dimensions

Migration stage answers "how far along is this app". A separate question is
"what exactly was measured", and `delivery-evidence/v1` records it per image:
`BUILD_PASS`, `STARTUP_PASS`, `HEALTH_PASS`, `READINESS_PASS`,
`FUNCTIONAL_PASS`, `VISUAL_PASS`, `PERSISTENCE_PASS`, `CROSS_VERSION_PASS`,
`ROLLBACK_PASS`, `LIVE_PASS`. Unmeasured stays `NOT_RUN`.

An image that builds, starts and answers its health path is not a product that
works, and the two were previously the same sentence.

## Ownership

| Repository | Owns |
| --- | --- |
| `zeus` | Framework runtime, compiler, core packages, framework-level fixtures |
| `zeus-ui` | Web components, gallery/docs, component-level checks |
| **`zeus-ecosystem`** | Product applications, app-level E2E, published-package integration, image delivery, deployment evidence |

This repository consumes published `@zeus-js/*` and `@zeus-web/*` packages. No
cross-repository workspace links, source aliases or vendored copies.

## Checks

```bash
npm run check                    # dependency policy and regression tests
npm run check:published-fixtures # fixtures use exact published versions only
npm run check:pair               # install a published pair and inspect the tree
npm run check:admin-browser      # 14 product scenarios, three engines
npm run check:admin-visual       # structure + pixels against a pinned reference
npm run check:permissions        # what a viewer may and may not do, in a browser
```

The two gates that need a browser use Playwright. Browsers come from
`cdn.playwright.dev` by default; where that host is unreachable,
`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`
installs the same pinned build.

CI runs four workflows:

| Workflow | Answers |
| --- | --- |
| `published-consumer.yml` | Can a third party install and use the published pair? |
| `ai-apps.yml` | Do the AI apps typecheck, test, build and pass their browser gates? |
| `app-images.yml` | Does each image build, start, answer health, and stay within budget? |
| `ci.yml` | Do the repository's own policies hold? |

## Contracts

| File | Records |
| --- | --- |
| `infra/contracts/published-pair.json` | Core and UI version, tag, tag object and commit — resolved from the tags, checked against them |
| `infra/contracts/products.json` | Each product's Dockerfile, port, health path, size budget and deployment unit |

`scripts/checks/check-published-pair-contract.mjs` fails when a manifest drifts
from the recorded pair. `--offline` runs the structural half without a token.

## Images and deployment

`scripts/release/build-image.mjs` builds, inspects and health-checks an image,
then writes `delivery-evidence/v1`. A build that was not pushed records an
**image ID** and no digest, because a digest only exists once a registry stores
the manifest and the deployment plan is built from digests.

`scripts/release/deployment-plan.mjs` writes a plan and never applies one.
`scripts/release/rehearsal.mjs` exercises the plan and a rollback against local
containers, and removes only what it created.

## Documentation

- [Delivery status](docs/delivery-status.md) — the three generated documents in prose: what is blocked, and by whom
- [Dependency policy](docs/dependency-policy.md)
- [Compatibility matrix](docs/compatibility-matrix.json)
- [Migration checklist](docs/migration-checklist.md) — the status vocabulary above
- [Production cutover runbook](docs/production-cutover-runbook.md) — never executed; needs authorization
- [Legacy cleanup manifest](docs/legacy-cleanup-manifest.md) — what Phase 7 will delete, and what it cannot
- [App inventory](docs/demo-catalog.md)
- [Architecture](docs/architecture.md)

## Readiness

Three scripts read what is on disk and act on none of it:

```bash
npm run check:candidate                  # twelve dimensions → PASS / INCOMPLETE / BLOCKED
npm run check:cutover-preflight -- --unit admin
npm run check:cleanup -- --zeus ../zeus
```

They report `BLOCKED` today, and that is the honest answer: no image from this
repository has been pushed to a registry, no application is in production, and
one build-configuration reference to the legacy app remains. A script that
reported anything else would be describing a different repository.

No production changes are permitted before explicit release/deployment approval.
