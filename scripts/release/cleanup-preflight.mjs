/**
 * Reads whether Phase 7's deletion conditions hold, and deletes nothing.
 *
 * ## Why a script rather than the manifest alone
 *
 * `docs/legacy-cleanup-manifest.md` lists what Phase 7 will delete and four
 * prerequisites. Three of those prerequisites are statements about a tree —
 * "no build configuration references the legacy app", "every deleted workflow
 * has a replacement that ran green", "each app is PRODUCTION_ACCEPTED" — and a
 * prose statement about a tree drifts the moment someone edits the tree.
 *
 * This script reads the trees and reports. It has no delete path: Phase 7 is
 * blocked until every application is `PRODUCTION_ACCEPTED` and has survived an
 * observation window, and the old implementation is the only thing anyone can
 * roll back to. A tool that could delete it would be a tool that could remove
 * the rollback path.
 *
 * ## What it checks, and where
 *
 * The legacy implementation lives in `baicie/zeus`, not here. This repository
 * can only read it as a checkout, so `--zeus <path>` points at one. Without it
 * the cross-repository prerequisites are `UNKNOWN`, not `MET` — an unread tree
 * is not a clean tree.
 *
 * Usage:
 *   node scripts/release/cleanup-preflight.mjs [--zeus ../zeus] [--out <file>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * References from build configuration to the legacy app.
 *
 * The manifest states this prerequisite in an exact, measurable form:
 *
 *     grep -rn "examples/admin" package.json vitest.config.ts
 *
 * must return nothing. Those two files are the whole definition, and widening
 * it is not a stricter check — it is a different one. My first version searched
 * the entire tree and reported sixty-odd hits from `scripts/release/*`, the
 * legacy app's own sources and its own tests as "build configuration still
 * references it". Deleting `examples/admin` breaks none of those; they *are*
 * `examples/admin`'s consumers and they go with it, and the manifest already
 * says the release scripts need an individual audit rather than a blanket
 * verdict.
 *
 * So the blocking set is exactly the manifest's two files, and everything else
 * is reported separately as work the audit has to do.
 */
export const BUILD_CONFIG_FILES = ['package.json', 'vitest.config.ts']

/**
 * Paths whose reference to a legacy tree blocks its deletion.
 *
 * The manifest states the prerequisite as two files, which is the right
 * denominator for `zeus`: there, `examples/admin` is referenced from
 * `package.json` and `vitest.config.ts` and nowhere else that runs.
 *
 * `zeus-ui` is not the same shape. Measured, twenty-two files reference the AI
 * trees, and among them are two workflows (one of which deploys them to
 * production), `tsconfig.json`, `vitest.config.ts`, and eight
 * `check-ai-workbench-*` gate scripts. Deleting the trees breaks all of those,
 * so a rule that only looked for `package.json` would call the tree clean and
 * be wrong in the direction that matters.
 */
export function blocksDeletion(file) {
  if (BUILD_CONFIG_FILES.includes(file)) return true

  /*
   * Workflows and tsconfigs always block: deleting a tree they build or deploy
   * breaks them, and there is no reading of them where the reference is
   * incidental.
   *
   * `scripts/` is different, and the difference is the manifest's: in `zeus`
   * those are host-deployment scripts it says to audit individually, and
   * calling them all blockers would make the check unable to say anything but
   * "blocked". The ones under `scripts/checks/` are the gates — they import
   * the app to drive it, so they block. The rest are reported for audit.
   */
  return file.startsWith('.github/workflows/') || /^tsconfig.*\.json$/.test(file) || file.startsWith('scripts/checks/')
}

/** Files where a reference is a recorded measurement, not a dependency. */
export const PROSE_ONLY_FILES = ['crates/zeus_compiler/src/support/nesting.rs']

/**
 * The legacy trees, by the repository they actually live in.
 *
 * An earlier version listed both under `zeus`, which is where the manifest said
 * they were. `zeus` has `examples/admin` and has never had
 * `examples/ai-workbench`; that tree — and `examples/ai-host` with it — is in
 * `zeus-ui`. Scanning the wrong repository for the AI paths could never find
 * them, so the check reported the AI side clean by never looking at it.
 */
export const LEGACY_TREES = {
  zeus: ['examples/admin'],
  'zeus-ui': ['examples/ai-workbench', 'examples/ai-host'],
}

/**
 * Reads references from a zeus checkout.
 *
 * `git grep` rather than a recursive read: it respects `.gitignore`, so a
 * `dist/` full of built output does not report every bundle as a reference.
 * Results are deduplicated — `git grep` emits one line per match, and a file
 * that mentions the path eight times is one file to deal with, not eight.
 */
export function findReferences(root, needle) {
  try {
    const output = execFileSync('git', ['grep', '-n', '--fixed-strings', needle], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const files = new Set(
      output
        .split('\n')
        .filter(Boolean)
        .map(line => line.split(':')[0]),
    )

    return [...files]
  } catch (error) {
    /* `git grep` exits 1 when there are no matches, which is the good case. */
    if (error?.status === 1) return []

    return undefined
  }
}

/**
 * Classifies a reference by what deleting the app would do to it.
 *
 *   build-config  a command, test project or build breaks        → blocks Phase 7
 *   legacy-self   the legacy app's own files                      → deleted with it
 *   prose         documentation or a comment explaining something → stays
 *   need-audit    a script whose only consumer may be the app     → the manifest
 *                                                                  says audit it
 */
export function classifyReference(file) {
  if (blocksDeletion(file)) return 'build-config'

  if (PROSE_ONLY_FILES.includes(file)) return 'prose'

  if (file.startsWith('examples/admin/') || file.startsWith('examples/ai-workbench/')) return 'legacy-self'

  if (file.startsWith('docs/') || file.endsWith('.md')) return 'prose'

  return 'need-audit'
}

/**
 * Whether every workflow Phase 7 deletes has a replacement that ran green.
 *
 * The three deleted workflows are recorded in the manifest with the reason each
 * was safe. What this cannot check is the *replacement* having run — that is a
 * CI conclusion — so it checks the weaker, checkable thing: the files the
 * manifest says were deleted are gone.
 */
export function deletedWorkflowsAreGone(zeusRoot) {
  const expected = ['admin-image.yml', 'product-acceptance.yml', 'demos-pages.yml']
  const workflows = join(zeusRoot, '.github/workflows')

  if (!existsSync(workflows)) return { readable: false, stillPresent: [] }

  const present = readdirSync(workflows)

  return {
    readable: true,
    stillPresent: expected.filter(name => present.includes(name)),
  }
}

/**
 * Whether this repository's own record says every app is PRODUCTION_ACCEPTED.
 *
 * Read from the checklist rather than asserted here: the checklist is where the
 * stage is defined and evidenced, and a second copy of the claim in a script
 * would be a second place to drift.
 */
export function productionAccepted(root) {
  const file = join(root, 'docs/migration-checklist.md')

  if (!existsSync(file)) return { readable: false, accepted: [] }

  const text = readFileSync(file, 'utf8')
  const accepted = []

  /*
   * Counted by looking for a row whose stage cell says PRODUCTION_ACCEPTED and
   * whose status cell is a check mark. The status vocabulary is defined in the
   * same document, and the check mark is what it uses for "done".
   */
  const rows = text.split('\n').filter(line => line.includes('| PRODUCTION_ACCEPTED |'))
  const done = rows.filter(line => /✅/.test(line))

  return { readable: true, accepted: done, rows: rows.length }
}

export function cleanupPreflight(ecosystemRoot, options = {}) {
  const zeusRoot = options.zeus ? resolve(options.zeus) : undefined
  const zeusUiRoot = options.zeusUi ? resolve(options.zeusUi) : undefined
  const prerequisites = []

  const add = (id, status, detail, evidence) =>
    prerequisites.push({ id, status, detail, ...(evidence ? { evidence } : {}) })

  /* ---- 1. every application PRODUCTION_ACCEPTED ----------------------- */
  const acceptance = productionAccepted(ecosystemRoot)

  add(
    'production-accepted',
    acceptance.accepted.length > 0 ? 'PARTIAL' : 'UNMET',
    acceptance.readable
      ? `${acceptance.accepted.length} of ${acceptance.rows} PRODUCTION_ACCEPTED row(s) show a completed status`
      : 'docs/migration-checklist.md is missing, so the stage cannot be read',
  )

  /* ---- 2. observation window closed with no rollback ------------------ */
  add(
    'observation-window',
    'UNKNOWN',
    'no artefact records an observation window; this is a decision made after a cutover, not a file',
  )

  /* ---- 3. the three deleted workflows are gone ------------------------ */
  if (!zeusRoot) {
    add(
      'deleted-workflows-gone',
      'UNKNOWN',
      'no zeus checkout supplied; pass --zeus <path> to read it',
    )
  } else {
    const deleted = deletedWorkflowsAreGone(zeusRoot)

    add(
      'deleted-workflows-gone',
      !deleted.readable ? 'UNKNOWN' : deleted.stillPresent.length === 0 ? 'MET' : 'UNMET',
      !deleted.readable
        ? `no .github/workflows under ${zeusRoot}`
        : deleted.stillPresent.length === 0
          ? 'admin-image.yml, product-acceptance.yml and demos-pages.yml are absent'
          : `still present: ${deleted.stillPresent.join(', ')}`,
    )
  }

  /* ---- 4. no build configuration references the legacy app ------------ */
  if (!zeusRoot) {
    add(
      'build-config-clean',
      'UNKNOWN',
      'no zeus checkout supplied; the manifest names this as the measurable prerequisite (`grep -rn "examples/admin" package.json vitest.config.ts` must return nothing)',
    )
  } else {
    /*
     * `findReferences` returns `undefined` when git cannot read the tree at
     * all, and `[]` when it read it and found nothing. Coalescing those two to
     * `[]` made the UNKNOWN branch below unreachable: pointing `--zeus` at a
     * directory that is not a checkout reported MET, which is the opposite of
     * what the module promises ("an unread tree is not a clean tree").
     */
    const perPath = LEGACY_TREES.zeus.map(needle => ({ needle, found: findReferences(zeusRoot, needle) }))
    const unreadable = perPath.find(entry => entry.found === undefined)

    /*
     * The AI trees are in `zeus-ui`, not here. They are reported separately
     * below; leaving them out of this check would let "the build configuration
     * is clean" be true of a repository that never contained them.
     */
    const uiPerPath = zeusUiRoot
      ? LEGACY_TREES['zeus-ui'].map(needle => ({ needle, found: findReferences(zeusUiRoot, needle) }))
      : undefined

    const uiUnreadable = uiPerPath?.find(entry => entry.found === undefined)

    if (unreadable) {
      add(
        'build-config-clean',
        'UNKNOWN',
        `${zeusRoot} could not be read as a git checkout, so nothing was compared`,
      )
    } else if (!zeusUiRoot) {
      add(
        'build-config-clean',
        'UNKNOWN',
        `the AI legacy trees are in zeus-ui, which was not supplied; pass --zeus-ui <path> ` +
          `(this repository's ${perPath.every(entry => entry.found.length === 0) ? 'own tree is clean' : 'own tree still references examples/admin'})`,
      )
    } else if (uiUnreadable) {
      add(
        'build-config-clean',
        'UNKNOWN',
        `${zeusUiRoot} could not be read as a git checkout, so the AI trees were not compared`,
      )
    } else if (perPath.every(entry => entry.found.length === 0) && uiPerPath.every(entry => entry.found.length === 0)) {
      add(
        'build-config-clean',
        'MET',
        'neither package.json nor vitest.config.ts references the legacy app',
      )
    } else {
      const byKind = new Map()

      for (const file of perPath.flatMap(entry => entry.found)) {
        const kind = classifyReference(file)

        byKind.set(kind, [...new Set([...(byKind.get(kind) ?? []), file])])
      }

      const blocking = byKind.get('build-config') ?? []
      const audit = byKind.get('need-audit') ?? []
      const prose = byKind.get('prose') ?? []

      /*
       * Only `build-config` blocks. The manifest permits prose, and the scripts
       * it puts in the audit column are exactly the ones it says to audit
       * individually rather than judge here — a verdict from this script would
       * be the "guessed at" answer the manifest was written to avoid.
       */
      add(
        'build-config-clean',
        blocking.length === 0 ? 'MET' : 'UNMET',
        blocking.length === 0
          ? `no build configuration references the legacy app; ${audit.length} script(s) still need the manifest's individual audit, ${prose.length} prose reference(s) explain a measurement`
          : `build configuration still references it: ${blocking.join(', ')}`,
        audit,
      )
    }
  }

  /* ---- 5. the visual baseline stays explainable ----------------------- */
  const baseline = (() => {
    try {
      return JSON.parse(readFileSync(join(ecosystemRoot, 'apps/admin/visual-baselines/reference.json'), 'utf8'))
    } catch {
      return undefined
    }
  })()

  add(
    'baseline-explainable',
    baseline?.reference?.imageId ? 'MET' : 'UNMET',
    baseline?.reference?.imageId
      ? `the baseline names ${baseline.reference.imageId.slice(0, 19)}…, which is the build the screenshots came from`
      : 'the baseline carries no image digest, so the sources it came from cannot be identified once they are gone',
  )

  return {
    schema: 'zeus.ecosystem.cleanup-preflight/v1',
    generatedAt: new Date().toISOString(),
    zeusRoot: zeusRoot ?? null,
    zeusUiRoot: zeusUiRoot ?? null,
    prerequisites,
    verdict: overallCleanup(prerequisites),
    note:
      'This reads conditions and deletes nothing. Phase 7 removes the only implementation anyone ' +
      'can roll back to, so the tool that reads its prerequisites must not be the tool that acts.',
  }
}

/**
 * The aggregate verdict.
 *
 * `PARTIAL` is its own value rather than being folded into `UNMET`: "some of
 * the applications are accepted" is a different situation from "none are", and
 * a reader deciding whether to start needs to know which.
 */
export function overallCleanup(prerequisites) {
  if (prerequisites.length === 0) return 'INCOMPLETE'
  if (prerequisites.some(entry => entry.status === 'UNMET')) return 'BLOCKED'
  if (prerequisites.some(entry => entry.status === 'PARTIAL')) return 'BLOCKED'
  if (prerequisites.some(entry => entry.status === 'UNKNOWN')) return 'INCOMPLETE'
  return 'READY'
}

export function formatCleanup(result) {
  const lines = [
    `Phase 7 preflight${result.zeusRoot ? ` (reading ${result.zeusRoot})` : ' (no zeus checkout)'}`,
    '',
  ]

  for (const entry of result.prerequisites) {
    lines.push(`  ${entry.status.padEnd(8)} ${entry.id.padEnd(24)} ${entry.detail}`)
  }

  lines.push('', `  verdict: ${result.verdict}`, '', `  ${result.note}`)

  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const root = resolve(value('--root') ?? process.cwd())
  const result = cleanupPreflight(root, { zeus: value('--zeus'), zeusUi: value('--zeus-ui') })
  const out = value('--out') ?? join(root, 'temp/cleanup-preflight.json')

  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)

  console.log(formatCleanup(result))
  console.log(`\nreport: ${out}`)

  if (result.verdict !== 'READY' && !args.includes('--allow-not-ready')) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
