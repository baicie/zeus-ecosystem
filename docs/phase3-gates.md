# Phase 3 completion gates

| Gate | Requirement | Current state |
| --- | --- | --- |
| G3a | Repository, main, pinned read-only CI, working test suite | PASS (main CI) |
| G3b | Dependency policy, evidence matrix, app catalog, permissions review | PASS (main CI, documentation) |
| G3c-core | Published Core registry install and signal lifecycle | PASS (Node 22/24 Core smoke) |
| G3c-pair-install | Published Core + UI strict-peer install, npm/pnpm, lockfiles, realpath | Manual workflow prepared; NOT YET PASSED |
| G3c-browser | Core + UI browser runtime identity, event and cleanup E2E | BLOCKED pending compatible UI release |
| G4 | AI Workbench + Host migrated and accepted | NOT STARTED |
| G5 | Image/SBOM/size/deployment evidence migrated | NOT STARTED |
| G6 | Admin production cutover with rollback and explicit approval | NOT STARTED |

## Published-pair manual check

Open **Actions → Published Core UI pair preflight → Run workflow** and provide exact published Core/UI versions. This job performs strict peer installs using npm and pnpm on Node 22/24, inspects resolution realpaths and lockfiles and uploads evidence even on failure. It does **not** publish or deploy.

The current candidate UI version may be unpublished. **A failed run is the correct outcome until the dependency contract is actually satisfiable.** The workflow is deliberately manual and does not produce false-green mandatory CI.

Passing this installation check alone does **not** establish browser singleton identity or cross-host behavior.

## Repository settings still owned by an administrator

The available integration cannot configure repository rulesets, secrets, environments or runner assignments. Enable a main protection ruleset with review and required CI checks. Keep jobs scoped to `contents: read`; do not transfer npm publish or production SSH tokens into this consumer repository.

For production migration, restore full audit evidence, digest-based rollback and deployment acceptance as separate phases.
