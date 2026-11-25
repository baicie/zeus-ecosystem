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
| Deployment workflow | `.github/workflows/admin-image.yml` | Replace, then delete |
| Product acceptance | `.github/workflows/product-acceptance.yml` | Replace, then delete |
| Pages deployment | `.github/workflows/demos-pages.yml`, `playground-pages.yml` | Keep if they serve the playground |
| Release scripts | `scripts/release/deployment-*.ts`, `admin-db.ts`, `admin-demo-snapshot.ts` | Audit individually — some are host-deployment, not app |
| Browser fixtures | `examples/ai-workbench` gates | Already replaced by `apps/ai-workbench/scripts/checks` |
| Visual reference | `examples/admin` at a recorded commit | **Keep until visual parity is accepted** |

## What cannot be deleted yet

| Item | Why |
| --- | --- |
| `examples/admin` at commit `132c777e` | It is the source of the visual reference. The published image is the reference now, but the commit is how the image is explained |
| `ghcr.io/baicie/zeus-admin:main` | The rollback target named in the rehearsal. Deleting it removes the only previously-deployed artefact this repository has |
| Any `deployment-*.ts` the production host still runs | Unknown without host access; marked here rather than guessed |
| `.github/workflows/demos-pages.yml` | Serves pages this repository's documentation links to |

## What can be deleted now

Nothing. Every entry above is either the rollback path, the visual reference, or
a workflow with no verified replacement. A cleanup that starts before
`PRODUCTION_ACCEPTED` deletes the only way back.

## Prerequisites, restated precisely

Phase 7 may begin when all of these hold:

1. AI Workbench, AI Host and Admin are each `PRODUCTION_ACCEPTED`, with the
   evidence `docs/migration-checklist.md` requires for that stage.
2. The observation window after cutover closed with no rollback.
3. Every workflow listed above has a replacement that has run green at least
   once on the new implementation.
4. `zeus` and `zeus-ui` no longer reference `examples/admin` from anything that
   runs. Measured today, three references remain, and they are not all the same
   kind:

   ```
   package.json:130              "example:admin": "pnpm -C examples/admin dev"
   vitest.config.ts:13           a project that includes examples/admin/server/**
   crates/zeus_compiler/src/support/nesting.rs:1369   a doc comment naming a
                                 real JSX depth measured in examples/admin
   ```

   The first two are build configuration and go with the app. The third is a
   comment recording a measurement — deleting it would lose why the nesting
   limit is what it is, so it moves into prose rather than being removed.

   The measurable form of this prerequisite:

   ```bash
   grep -rn "examples/admin" package.json vitest.config.ts
   ```

   must return nothing. Documentation references are permitted and are listed
   below.
5. The visual baseline in `apps/admin/visual-baselines/reference.json` remains
   explainable after the sources it came from are gone — the image digest is
   recorded there for exactly this reason.

## Per-repository split

**`zeus`** — `examples/admin`, `examples/ai-workbench`, `admin-image.yml`,
`product-acceptance.yml`, and the release scripts whose only consumer is them.

**`zeus-ui`** — nothing. The components were never the legacy implementation;
they are what the migrated apps install.

**`zeus-ecosystem`** — nothing to delete. This repository *is* the replacement.
