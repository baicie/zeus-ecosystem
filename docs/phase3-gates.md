# Phase 3 completion gates

| Gate | Requirement | Current state |
| --- | --- | --- |
| G3a | Public repository, main, pinned read-only policy CI, working test suite | Code prepared; require green CI |
| G3b | Immutable version policy, compatibility matrix, app inventory, permission review | Code prepared; review and merge required |
| G3c-core | Install registry-published Core packages in isolated consumer; exercise signal and cleanup | Automated smoke; evaluate actual CI results |
| G3c-ui | Registry-published compatible UI + Core, no peer mismatch or double engine, browser E2E | BLOCKED pending verified UI release |
| G4 | AI Workbench + AI Host application migration | NOT STARTED |
| G5 | image, SBOM, size, public build-info and deployment evidence | NOT STARTED |
| G6 | Admin production cutover with rollback | NOT STARTED |

No gate is complete solely because a PR exists. CI evidence or audited artifacts are mandatory.

## Operator-only configuration

The connected GitHub integration cannot configure repository rulesets, environments, secrets or self-hosted runners. The repository owner should enable main branch protection/rulesets with mandatory PR review and required successful `Policy / Node 22`, `Policy / Node 24`; avoid hard-coding the published Core smoke as a mandatory merge check if registry availability is outside the team's control. Create no production environment or secret before Phase 4/6 approval.

### Safety policy

Read-only tests run on PRs with `contents: read`; no production publish or deployment triggers, self-hosted runner labels or write tokens are present in this bootstrap.
