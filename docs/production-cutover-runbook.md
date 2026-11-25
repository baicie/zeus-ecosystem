# Production cutover runbook

Nothing in this document has been executed. It is the plan a cutover would
follow, written down before anyone is under pressure to improvise one.

`scripts/release/deployment-plan.mjs` refuses `--environment production` in
code. That refusal is not a comment to be worked around; a production change
needs a separate authorization this repository does not have.

## Prerequisites

Every one of these must be true before a cutover starts. A cutover that begins
with one of them unproven ends with a rollback nobody has rehearsed.

| # | Requirement | How it is established |
| --- | --- | --- |
| 1 | Images exist in a registry with digests | `node scripts/release/verify-plan-digests.mjs --plan <file>` |
| 2 | Each image passed build, start and health | `delivery-evidence/v1` with `BUILD_PASS`, `STARTUP_PASS`, `HEALTH_PASS` |
| 3 | The full deployment unit is available | `products.json` `deploymentUnits`; a partial unit is refused |
| 4 | The previous image set is recorded by digest | `--previous <product>=<ref>@sha256:…` for every product |
| 5 | Upgrade and rollback were rehearsed against these versions | `temp/rehearsal/cross-version-*.json` |
| 6 | Data compatibility has evidence, or is explicitly unverified | `dataCompatibility` in the plan |
| 7 | The product's browser gates pass on the release commit | `Admin / Browser gates`, `AI Workbench / Browser gates` |
| 8 | A database backup exists and its restore was tested | operator, outside this repository |

Requirement 6 is the one that gets skipped. A plan that says `compatible`
without evidence is refused by `validatePlan`, and leaving it `unverified` is
honest — but a cutover with an unverified data claim has an unknown rollback.

## Environment contract

The values a deployment must supply. Secrets are injected by the deployment
platform; none of them are written here or in any artefact.

### AI unit

| Service | Variable | Meaning |
| --- | --- | --- |
| ai-host | `ZEUS_AI_TOKENS` | JSON array of `{ token, tenantId, userId, role }`; 16-character minimum |
| ai-host | `ZEUS_AI_TENANTS` | JSON array of `{ id, databaseFile, workspaceRoot }` |
| ai-host | `ZEUS_AI_ORIGINS` | Origin allowlist; a browser `Origin` not listed is refused 403 |
| ai-host | `ZEUS_AI_MODE` | `replay` or `live`. `replay` with no recording serves an empty timeline while `/health` still reports ok |
| ai-workbench | `ZEUS_AI_UPSTREAM_TOKEN` | Must be a token `ai-host` accepts. nginx reads it at config load; undefined fails the container at start |

Volumes: `ai-host` owns its SQLite file. The workbench is stateless.

### Admin unit

| Variable | Meaning |
| --- | --- |
| `ZEUS_ADMIN_DB` | SQLite path; defaults to `.data/admin.sqlite` in the image |
| `ZEUS_ADMIN_PASSWORD` | Administrator password, 12 characters minimum — the server refuses to start below that |
| `ZEUS_ADMIN_EMAIL` | Administrator identity, default `ada@example.test` |
| `ZEUS_ADMIN_BOOTSTRAP` | `true` on first boot. An existing database with zero users is never treated as fresh |

Volumes: the SQLite file, and nothing else.

## Order

The unit's `order` decides it, not the order arguments arrive in.

```
ai      ai-host, then ai-workbench
admin   admin
```

A workbench deployed before its host proxies to nothing. A partial unit is
refused at planning time rather than reconciled at deploy time.

## Steps

1. **Freeze.** Record the running image set by digest — this is the rollback
   target, and it cannot be reconstructed afterwards.
2. **Back up.** Copy the database file and verify the copy opens. An unverified
   backup is not a backup.
3. **Prepare.** Write the plan, run `verify-plan-digests.mjs` against it, and
   confirm `stages.digest-verified` became true.
4. **Stop the old service** in the unit, in reverse order (`ai-workbench` first).
   Its port must be free before the new one binds.
5. **Start the new service** in the unit's order.
6. **Verify**, in this order — each rung is a different question and a lower one
   answering does not imply a higher one:
   - liveness: the process is running
   - readiness: it answers its health path
   - dependency: it can reach what it needs
   - acceptance: a person can sign in, read a row they wrote, and write one
7. **Watch.** The observation window is a decision made before the cutover, and
   it is not shortened because everything looks fine.

## Abort conditions

Stop and roll back if, during step 6:

- readiness fails after the image's own start budget
- acceptance fails at any rung
- a database migration is not backward compatible and the rollback path needs a
  restore
- any service in the unit is on a different version from the rest of the unit

## Rollback

Restoring the previous image set restores the **binaries, not the database**.

| Situation | Procedure | What is lost |
| --- | --- | --- |
| Only binaries changed | Restart the previous image set | Nothing |
| The new version added tables | Previous binaries usually still read them | Nothing |
| The new version altered or dropped columns | Restore the backup from step 2 | Everything written since the backup |

The third row is why step 2 is verified before step 4. A rollback that restores
a backup has an RPO equal to the time between the backup and the failure, and
that number must be stated in the incident record rather than discovered later.

A rollback of part of a unit is not a rollback of the unit.

## What needs human authorization

- Any change to a production environment
- Creating a release tag
- Running `npm publish`
- The decision that a difference in the visual report is intentional
- Shortening an observation window

## What this repository does not have

- Access to a production environment
- Production credentials
- Evidence that any of the above has been executed

`docs/migration-checklist.md` records the real state: no application is
`PRODUCTION_ACCEPTED`.
