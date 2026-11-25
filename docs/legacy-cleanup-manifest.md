# Legacy cleanup manifest

Phase 7 deletes the old application implementations. It is blocked until each
application is `PRODUCTION_ACCEPTED` and has survived an observation window with
no rollback — not because the deletion is difficult, but because the old
implementation is the only thing anyone can roll back to.

This is the inventory it will act on. Nothing here has been deleted.

## What the old implementation is

`examples/admin`, `examples/ai-workbench` and the AI host inside
`baicie/zeus` — the sources the migrated apps were copied from. They still build
against `workspace:*` and `file:` specifiers, which is exactly what the
migration exists to remove.

## References, by kind

| Kind | Location in `zeus` | Disposition |
| --- | --- | --- |
| Application source | `examples/admin/`, `examples/ai-workbench/` | Delete with Phase 7 |
| Deployment workflow | `.github/workflows/admin-image.yml` | **Deleted 2026-11-25** |
| Product acceptance | `.github/workflows/product-acceptance.yml` | **Deleted 2026-11-25** |
| Pages deployment | `.github/workflows/demos-pages.yml` | **Deleted 2026-11-25**; `playground-pages.yml` kept |
| Release scripts | `scripts/release/deployment-*.ts`, `admin-db.ts`, `admin-demo-snapshot.ts` | Audit individually — some are host-deployment, not app |
| Browser fixtures | `examples/ai-workbench` gates | Already replaced by `apps/ai-workbench/scripts/checks` |
| Visual reference | `examples/admin` at a recorded commit | **Keep until visual parity is accepted** |

## What cannot be deleted yet

| Item | Why |
| --- | --- |
| `examples/admin` at commit `132c777e` | It is the source of the visual reference. The published image is the reference now, but the commit is how the image is explained |
| `ghcr.io/baicie/zeus-admin:main` | The rollback target named in the rehearsal. Deleting it removes the only previously-deployed artefact this repository has |
| Any `deployment-*.ts` the production host still runs | Unknown without host access; marked here rather than guessed |
| `examples/admin/server` | `check:admin` imports it and drives the app in three engines — it is the only browser coverage of the old app that still runs |
| `scripts/release/verify-ui-provenance.ts` | The check is intact; only its `ci.yml` caller went with the image workflow. The migrated Admin runs the same binding through `zeus-ecosystem/scripts/release/build-image.mjs` |

## What was deleted on 2026-11-25

Three workflows, by the repository owner's decision, recorded here because it is
the one deletion in this file that happened before `PRODUCTION_ACCEPTED`:

| Workflow | Why it was safe |
| --- | --- |
| `admin-image.yml` | Built the legacy image and mirrored it to TCR. **Its `deploy` job had never run**: the last 30 runs show `Mirror to TCR: skipped` (unconfigured) and `Deploy: skipped`, because the job requires a successful mirror. Deleting it removed a build, not a deployment path. |
| `product-acceptance.yml` | Timed out or failed since 2026-11-17 and its assertions were about the legacy app. |
| `demos-pages.yml` | Published the legacy demo site; nothing in the current delivery chain reads it. |

`ci.yml`'s `Verify UI provenance` step went with them — it built
`examples/admin/dist` and bound it to a lockfile. The migrated Admin writes a
`build-info.json` through `zeus-ecosystem/scripts/release/build-image.mjs`, so
the binding is checked where that artefact is produced.

`check:admin` stays: it starts the legacy app itself and drives it in three
engines, and it is the only browser coverage of that app left.

## What can be deleted now

Three workflows were, above. The rest is the rollback path and the visual
reference, and those wait for `PRODUCTION_ACCEPTED`.

## Prerequisites, restated precisely

Phase 7 may begin when all of these hold:

1. AI Workbench, AI Host and Admin are each `PRODUCTION_ACCEPTED`, with the
   evidence `docs/migration-checklist.md` requires for that stage.
2. The observation window after cutover closed with no rollback.
3. Every workflow listed above has a replacement that has run green at least
   once on the new implementation.
4. `zeus` and `zeus-ui` no longer reference `examples/admin` from anything that
   runs. The measurable form is the manifest's own:

   ```bash
   grep -rn "examples/admin" package.json vitest.config.ts
   ```

   Running it against `zeus` at `6e623d5f` leaves exactly one hit:

   ```
   vitest.config.ts:13   a project that includes examples/admin/server/**
   ```

   `package.json`'s `"example:admin": "pnpm -C examples/admin dev"` — which an
   earlier version of this file listed — **is already gone**. That is the
   argument for `scripts/release/cleanup-preflight.mjs`: a written claim about
   a tree drifts the moment the tree changes, and a preflight that reads the
   tree does not.

   The other two kinds of reference, neither of which blocks:

   ```
   crates/zeus_compiler/src/support/nesting.rs:1369   a doc comment naming a
                                 real JSX depth measured in examples/admin
   examples/admin/**                                  the app's own files
   ```

   The first is a measurement someone took. Deleting it would lose why the
   nesting limit is what it is, so it moves into prose rather than being
   removed. The second goes with the app.

   `scripts/release/*` and `scripts/check/*` references are the manifest's
   "audit individually" column, and the preflight reports them as such rather
   than judging them — a verdict from a script would be the guess the column
   was written to avoid.

5. The visual baseline in `apps/admin/visual-baselines/reference.json` remains
   explainable after the sources it came from are gone — the image digest is
   recorded there for exactly this reason.

## Reading the prerequisites

`scripts/release/cleanup-preflight.mjs` reads them and deletes nothing:

```bash
node scripts/release/cleanup-preflight.mjs --zeus ../zeus
```

It refuses `--zeus`, so a tree it has not read is `UNKNOWN` rather than `MET`.
Measured at `zeus@6e623d5f` / `zeus-ecosystem@aa590b3`:

```
UNMET    production-accepted      0 of 3 PRODUCTION_ACCEPTED row(s) complete
UNKNOWN  observation-window       a decision after a cutover, not a file
MET      deleted-workflows-gone   the three workflows are absent
UNMET    build-config-clean       vitest.config.ts still includes examples/admin/server/**
MET      baseline-explainable     the baseline names the digest it came from
```

`UNKNOWN` is not a soft `MET`. The observation window is the reason Phase 7 is
blocked even for an application accepted tomorrow: nothing has been
observed, because nothing has been deployed.

**The tool has no delete path, deliberately.** Phase 7 removes the only
implementation anyone can roll back to, so the tool that reads its
prerequisites must not be the tool that acts.

## Per-repository split

**`zeus`** — `examples/admin`, `examples/ai-workbench`, `admin-image.yml`,
`product-acceptance.yml`, and the release scripts whose only consumer is them.

**`zeus-ui`** — nothing. The components were never the legacy implementation;
they are what the migrated apps install.

**`zeus-ecosystem`** — nothing to delete. This repository *is* the replacement.
