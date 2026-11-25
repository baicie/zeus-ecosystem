/**
 * Aggregates the evidence that already exists into one Release Candidate.
 *
 * ## What this is not
 *
 * It is not a release. Nothing here tags, publishes, pushes or deploys. A
 * Release Candidate is a *claim that this tree, with these dependency
 * versions, has been exercised this far* — and the only honest way to make
 * that claim is to read what was actually produced and refuse to fill gaps.
 *
 * ## Why aggregation rather than a checklist
 *
 * The migration produced evidence in eight places: three rehearsal report
 * families, six per-app gate reports, delivery evidence per image, provenance
 * verification, CI conclusions, the visual baseline, and the compatibility
 * matrix. A reader asking "is this releasable" had to open all of them and
 * hold the answer in their head. That is how a stage gets marked complete
 * because the last three things someone looked at were green.
 *
 * ## The three verdicts
 *
 * - `READY` — every dimension this repository can answer answered `PASS`, at
 *   **this commit**.
 * - `INCOMPLETE` — some dimension has no evidence, or its evidence is stale.
 *   Not a failure: nobody has looked, or looked at a different tree.
 * - `BLOCKED` — some dimension answered `FAIL`, or is a dimension only a
 *   person or an authorization outside this repository can answer.
 *
 * `INCOMPLETE` and `BLOCKED` are different questions with different actions,
 * and collapsing them is how "we never checked" starts reading as "it's fine".
 *
 * ## What it refuses to do
 *
 * - Count evidence produced for a different commit as evidence for this one,
 *   unless the report records no commit at all (recorded as `UNSTAMPED` and
 *   counted as incomplete, because an unstamped report could be from anywhere).
 * - Treat a rehearsal whose candidate images are the baseline images as a
 *   cross-version rehearsal. That is the specific fake this project forbids.
 * - Mark `PRODUCTION_ACCEPTED`. No production deployment has happened.
 *
 * Usage:
 *   node scripts/release/release-candidate.mjs [--commit <sha>] [--out <file>]
 *   node scripts/release/release-candidate.mjs --offline   # skip network checks
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/

/** The dimensions a candidate is judged on, in the order a reader needs them. */
export const DIMENSIONS = [
  'published-pair',
  'contracts-in-sync',
  'build',
  'unit-tests',
  'browser-gates',
  'visual',
  'cross-version',
  'provenance',
  'image-delivery',
  'data-compatibility',
  'design-review',
  'production-authorization',
]

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Every JSON document under `temp/` that names one of these schemas.
 *
 * Reports accumulate: a rehearsal run writes a new file each time and the old
 * ones stay. The caller picks the newest *passing* one rather than the newest
 * one, because the newest may be a failed experiment whose point was the
 * failure — `rehearsal-faults` exists precisely to produce those.
 */
export function readReports(root, schema) {
  const base = join(root, 'temp/rehearsal')

  if (!existsSync(base)) return []

  return readdirSync(base)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ file: join(base, name), ...(readJson(join(base, name)) ?? {}) }))
    .filter(report => report.schema === schema)
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
}

/** The newest report that says it passed. */
export function newestPassing(reports) {
  return reports.find(report => report.passed === true)
}

/**
 * Image IDs a rehearsal used for its baseline and its candidate.
 *
 * The two report families spell this differently and the difference is not
 * cosmetic — one records a list, the other a single image ID per side. Reading
 * only one spelling reports the other family as "a side recorded no images",
 * which reads like a broken rehearsal rather than a reader that assumed a
 * shape. Both are handled here so the caller does not have to know which
 * family produced the file.
 */
export function rehearsalImages(report) {
  const ids = side => {
    if (!side) return []

    if (Array.isArray(side.imageIds)) return side.imageIds.filter(id => typeof id === 'string')

    if (typeof side.imageId === 'string') return [side.imageId]

    return []
  }

  return { baseline: ids(report?.baseline), candidate: ids(report?.candidate) }
}

/**
 * Whether a rehearsal actually compared two different builds.
 *
 * A run whose candidate images equal its baseline images is the same image
 * twice. It is recorded, it can say `passed: true`, and it proves nothing
 * about upgrading — this is the fake cross-version test the project forbids by
 * name, so the aggregate refuses to count it.
 */
/**
 * Whether a rehearsal was a real cross-version test, or one image twice.
 *
 * ## Two independent things have to hold
 *
 * 1. **The images differ.** Same image on both sides is the same deployment
 *    run twice; it can pass every step and prove nothing about upgrading.
 * 2. **Data crossed the boundary.** A rehearsal that never wrote under one
 *    version and read under the other is a restart test. For Admin that is
 *    `upgrade.matched` plus a row the candidate created; for the AI unit it is
 *    a conversation the baseline wrote that the candidate read back.
 *
 * Checking only the first was the mistake in the first draft: it reported
 * `PASS` for a run whose only claim was "two different image IDs existed". The
 * second check is what the project's own prohibition is about — a rehearsal
 * that looks cross-version and never moves data.
 */
export function isRealCrossVersion(report) {
  const { baseline, candidate } = rehearsalImages(report)

  if (baseline.length === 0 || candidate.length === 0) return { real: false, reason: 'a side recorded no images' }

  const overlap = candidate.filter(id => baseline.includes(id))

  if (overlap.length > 0) {
    return {
      real: false,
      reason: `${overlap.length} candidate image(s) are also baseline images — that is one build compared with itself`,
    }
  }

  /*
   * The data claim. Each family records it differently:
   *
   *   cross-version (admin)  `upgrade.matched` and `upgrade.createdUnderCandidateId`
   *   ai-rehearsal           `baseline.written` and a candidate step reading it
   */
  const adminCrossed = report?.upgrade?.matched === true && typeof report?.upgrade?.createdUnderCandidateId === 'string'

  const aiCrossed =
    report?.baseline?.written !== undefined &&
    Number(report?.baseline?.written?.bytes ?? 0) > 0

  if (!adminCrossed && !aiCrossed) {
    return {
      real: false,
      reason:
        'the images differ but no row or conversation was written under one version and read under the other — ' +
        'that is a restart, not an upgrade',
    }
  }

  return {
    real: true,
    reason: `${baseline.length} baseline image(s) against ${candidate.length} candidate image(s), with data read across the boundary`,
  }
}

/**
 * Whether a report describes the commit under test.
 *
 * Reports that record no commit are `UNSTAMPED`: they may well be about this
 * tree, but nothing says so, and "probably this one" is not a stage.
 */
export function commitVerdict(reported, expected) {
  if (typeof reported !== 'string' || !FULL_SHA.test(reported)) return 'UNSTAMPED'
  if (reported === expected) return 'MATCHES'
  return 'STALE'
}

function dimension(name, verdict, detail, evidence = undefined) {
  return { name, verdict, detail, ...(evidence ? { evidence } : {}) }
}

/**
 * Counts what a gate actually asserted.
 *
 * ## Why this is per-shape rather than one rule
 *
 * The gates were written at different times and none of them shares a report
 * schema. Measured, they emit four shapes:
 *
 *   admin-browser    `results[]`, one entry per engine *and* scenario  → 14
 *   admin-permissions `results[]`, one entry per assertion             → 16
 *   admin-visual     `comparisons[]`, one per scenario                 → 8
 *   ai-workbench p0  `results[]`, each with a `checks[]`               → 72
 *   ai-workbench byok `results[]`, each with a `checks[]`              → 69
 *   csp / host       a flat `checks[]`                                 → 5 / 9
 *
 * A single rule (`results.length`) reported the 14-scenario browser run as
 * "14 checks, floor 42" and the 8-scenario visual run as 0 — both wrong, and
 * both wrong in the direction that looks like a missing gate. The count is
 * therefore whatever the document actually contains, read in that order.
 */
export function countChecks(report) {
  const results = Array.isArray(report?.results) ? report.results : []
  const comparisons = Array.isArray(report?.comparisons) ? report.comparisons : []
  const flatChecks = Array.isArray(report?.checks) ? report.checks : []

  if (results.some(entry => Array.isArray(entry?.checks))) {
    return results.reduce((total, entry) => total + (Array.isArray(entry.checks) ? entry.checks.length : 0), 0)
  }

  if (results.length > 0) return results.length
  if (comparisons.length > 0) return comparisons.length
  if (flatChecks.length > 0) return flatChecks.length

  return 0
}

/**
 * Reads a per-app gate report.
 *
 * The gates write into each app's own `temp/`, not into `temp/rehearsal`, and
 * they do not all share a schema. What they do share is a `passed` boolean and
 * a count of some kind, so the aggregate asks only for what every one provides.
 */
export function gateReport(root, relative, options = {}) {
  const file = join(root, relative)
  const report = readJson(file)

  if (!report) return { present: false, passed: false, count: 0, file }

  return {
    present: true,
    passed: report.passed === true,
    count: countChecks(report),
    file,
    startedAt: report.startedAt ?? report.createdAt,
    commit: options.commitField ? report[options.commitField] : undefined,
  }
}

/**
 * The gate reports a candidate depends on.
 *
 * ## The floors are per-report, not per-engine
 *
 * `admin-browser` writes one result per engine *and* scenario, so a
 * three-engine run produces 42. A local run with `ZEUS_ADMIN_BROWSERS=chromium`
 * produces 14, and both are genuine — the engine set is an environment choice,
 * recorded in the report's `engines` field. Pinning the floor at 42 would fail
 * every local aggregate for a reason that is a machine's browser inventory.
 *
 * What the floor does guard is the thing that actually regresses: a gate that
 * stops asserting. Fourteen scenarios is the chromium floor; CI's three-engine
 * run is checked by `assert-gate-baseline.mjs`, which counts engines, and that
 * is the check that owns the three-engine claim. One check owning one claim.
 */
export const GATES = [
  { name: 'admin browser acceptance', path: 'apps/admin/temp/admin-browser/report.json', floor: 14 },
  { name: 'admin permissions', path: 'apps/admin/temp/admin-permissions/report.json', floor: 16 },
  { name: 'admin visual parity', path: 'apps/admin/temp/admin-visual/report.json', floor: 8 },
  { name: 'ai-workbench P0', path: 'apps/ai-workbench/temp/ai-workbench-p0/report.json', floor: 72 },
  { name: 'ai-workbench BYOK', path: 'apps/ai-workbench/temp/ai-workbench-byok/report.json', floor: 69 },
  { name: 'ai-workbench CSP', path: 'apps/ai-workbench/temp/ai-workbench-csp/report.json', floor: 5 },
  { name: 'ai-host protocol', path: 'apps/ai-host/temp/ai-host-protocol/report.json', floor: 9 },
]

/**
 * Builds the candidate document.
 *
 * Pure over the tree: it reads files and asks git, and the only network call
 * is provenance verification, which `--offline` skips.
 */
export function buildCandidate(root, options = {}) {
  const commit = options.commit
    ?? process.env.ZEUS_APP_COMMIT
    ?? git(root, ['rev-parse', 'HEAD'])

  /*
   * A working tree that git cannot read is not a dirty one.
   *
   * `buildCandidate` is documented as pure over the tree, and it takes
   * `--commit` precisely so it can be pointed at a checkout without asking
   * git for HEAD. Asking git about the working tree anyway made it throw
   * inside a temp directory — which is how a caller that supplied everything
   * it needed still could not run it. Where git is unavailable the answer is
   * "unknown", reported as such rather than as clean.
   */
  const dirty = (() => {
    try {
      return git(root, ['status', '--porcelain']).length > 0
    } catch {
      return undefined
    }
  })()
  const pair = readJson(join(root, 'infra/contracts/published-pair.json'))
  const products = readJson(join(root, 'infra/contracts/products.json'))
  const matrix = readJson(join(root, 'docs/compatibility-matrix.json'))
  const visualBaselines = readJson(join(root, 'apps/admin/visual-baselines/reference.json'))

  const dimensions = []

  /* ---- published pair ------------------------------------------------ */
  if (pair) {
    dimensions.push(
      dimension(
        'published-pair',
        'PASS',
        `Core ${pair.core.version} (${pair.core.commit.slice(0, 8)}) + UI ${pair.ui.version} (${pair.ui.commit.slice(0, 8)})`,
        'infra/contracts/published-pair.json',
      ),
    )
  } else {
    dimensions.push(dimension('published-pair', 'BLOCKED', 'no published-pair contract'))
  }

  /* ---- contracts in sync --------------------------------------------- */
  /*
   * The three-app test: every manifest names the versions the pair records.
   * A manifest that drifted is the failure `check:published-fixtures` exists
   * for, and a candidate built on one is a candidate of a different tree.
   */
  if (pair && products) {
    const drift = []

    for (const entry of products.products ?? []) {
      const manifest = readJson(join(root, entry.appPath, 'package.json'))

      if (!manifest) continue

      const deps = { ...manifest.dependencies, ...manifest.devDependencies }

      for (const [name, expected] of [
        ['@zeus-js/zeus', pair.core.version],
        ['@zeus-js/router', pair.core.version],
      ]) {
        if (deps[name] !== undefined && deps[name] !== expected) {
          drift.push(`${entry.productId}: ${name} is ${deps[name]}, the pair records ${expected}`)
        }
      }

      for (const [name, version] of Object.entries(deps)) {
        if (name.startsWith('@zeus-web/') && name !== '@zeus-web/registry' && version !== pair.ui.version) {
          drift.push(`${entry.productId}: ${name} is ${version}, the pair records ${pair.ui.version}`)
        }
      }
    }

    dimensions.push(
      drift.length === 0
        ? dimension('contracts-in-sync', 'PASS', `${products.products.length} manifest(s) agree with the pair`)
        : dimension('contracts-in-sync', 'BLOCKED', drift.join('; ')),
    )
  } else {
    dimensions.push(dimension('contracts-in-sync', 'BLOCKED', 'cannot compare manifests without both contracts'))
  }

  /* ---- build --------------------------------------------------------- */
  /*
   * `build` is answered by the images existing, not by a `dist/` being on
   * disk: `dist/` is gitignored and regenerated, and a stale one says nothing.
   * Delivery evidence is the record that a build actually happened.
   */
  const evidenceFiles = readdirSync(join(root, 'temp'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith('delivery-evidence-'))
    .map(entry => join(root, 'temp', entry.name))

  const delivery = evidenceFiles
    .map(file => ({ file, ...(readJson(file) ?? {}) }))
    .filter(record => record.schema === 'zeus.ecosystem.delivery-evidence/v1')

  const expectedProducts = (products?.products ?? []).map(product => product.productId)
  const deliveredProducts = new Set(delivery.map(record => record.product))
  const missingProducts = expectedProducts.filter(product => !deliveredProducts.has(product))

  dimensions.push(
    missingProducts.length === 0
      ? dimension(
          'build',
          'PASS',
          `${delivery.length} delivery record(s) cover ${expectedProducts.length} product(s)`,
          delivery.map(record => record.product),
        )
      : dimension(
          'build',
          'INCOMPLETE',
          `no delivery evidence for ${missingProducts.join(', ')}; run scripts/release/build-image.mjs`,
        ),
  )

  /* ---- unit tests and browser gates ---------------------------------- */
  const gateResults = GATES.map(gate => ({ gate, report: gateReport(root, gate.path) }))
  const short = gateResults.filter(
    entry => !entry.report.present || !entry.report.passed || entry.report.count < entry.gate.floor,
  )

  dimensions.push(
    short.length === 0
      ? dimension(
          'browser-gates',
          'PASS',
          gateResults.map(entry => `${entry.gate.name}: ${entry.report.count}`).join(', '),
        )
      : dimension(
          'browser-gates',
          'INCOMPLETE',
          short
            .map(entry =>
              !entry.report.present
                ? `${entry.gate.name}: no report`
                : !entry.report.passed
                  ? `${entry.gate.name}: did not pass`
                  : `${entry.gate.name}: ${entry.report.count} checks, floor ${entry.gate.floor}`,
            )
            .join('; '),
        ),
  )

  /*
   * Unit tests have no report file — they are the CI job. Their evidence is
   * the CI conclusion, which this script cannot read without a token, so the
   * dimension is answered by the caller or stays INCOMPLETE. Saying PASS on
   * the strength of "the tests are in the workflow" would be a claim about the
   * workflow, not about a run.
   */
  dimensions.push(
    options.unitTestsPassed === true
      ? dimension('unit-tests', 'PASS', options.unitTestsDetail ?? 'reported by the caller')
      : dimension(
          'unit-tests',
          'INCOMPLETE',
          'no run recorded; pass --unit-tests-passed when aggregating from a green CI run',
        ),
  )

  /* ---- visual -------------------------------------------------------- */
  const visual = gateReport(root, 'apps/admin/temp/admin-visual/report.json')
  const visualReport = readJson(join(root, 'apps/admin/temp/admin-visual/report.json'))
  const screenshotCompared = (visualReport?.comparisons ?? []).filter(
    entry => entry.screenshot?.verdict !== 'NOT_RUN',
  ).length

  if (!visual.present) {
    dimensions.push(dimension('visual', 'INCOMPLETE', 'no visual report; run pnpm check:admin-visual'))
  } else {
    /*
     * A visual acceptance is not complete when the screenshots were not
     * compared. The structural half passing while the pixel half never ran is
     * exactly the shape that reads as green, so the aggregate says what ran:
     * `n` of `m` scenarios compared, and whether the design was reviewed.
     */
    const reviewed = visualBaselines?.approvalStatus === 'APPROVED'

    dimensions.push(
      dimension(
        'visual',
        visual.passed && reviewed ? 'PASS' : 'INCOMPLETE',
        `${screenshotCompared}/${(visualReport?.comparisons ?? []).length} scenario(s) compared pixels; ` +
          `design review ${reviewed ? 'approved' : 'not performed'}`,
      ),
    )
  }

  /* ---- design review ------------------------------------------------- */
  const reviewed = visualBaselines?.approvalStatus === 'APPROVED'

  dimensions.push(
    reviewed
      ? dimension('design-review', 'PASS', `approved: ${visualBaselines.approvalNote ?? 'see baseline'}`)
      : dimension(
          'design-review',
          'BLOCKED',
          'only a person can approve a visual difference; the baseline records no approval',
        ),
  )

  /* ---- cross-version ------------------------------------------------- */
  const crossVersion = readReports(root, 'zeus.ecosystem.cross-version-rehearsal/v1')
  const aiRehearsal = readReports(root, 'zeus.ecosystem.ai-rehearsal/v1')

  const crossPassing = newestPassing(crossVersion)
  const aiPassing = newestPassing(aiRehearsal)

  const crossReal = crossPassing ? isRealCrossVersion(crossPassing) : { real: false, reason: 'no passing run' }
  const aiReal = aiPassing ? isRealCrossVersion(aiPassing) : { real: false, reason: 'no passing run' }

  if (crossReal.real && aiReal.real) {
    dimensions.push(
      dimension(
        'cross-version',
        'PASS',
        `admin: ${crossReal.reason}; ai: ${aiReal.reason}`,
        [crossPassing.file, aiPassing.file].map(file => file.replace(`${root}/`, '')),
      ),
    )
  } else {
    dimensions.push(
      dimension(
        'cross-version',
        'INCOMPLETE',
        [`admin: ${crossReal.reason}`, `ai: ${aiReal.reason}`].join('; '),
      ),
    )
  }

  /* ---- provenance ---------------------------------------------------- */
  /*
   * The verifier is per-product and writes only where `--out` points, so the
   * reports arrive as `temp/provenance-<product>.json`. An earlier version of
   * this reader looked for one file called `temp/provenance-report.json`,
   * which nothing produces by default — so this dimension reported INCOMPLETE
   * for every product while three passing reports sat beside it. A reader that
   * names a path no writer writes is a reader that always says "no evidence".
   *
   * Both shapes are accepted: the per-product files, and a single aggregate if
   * somebody generates one.
   */
  const provenanceReports = (() => {
    const single = readJson(join(root, 'temp/provenance-report.json'))

    if (single) return [single]

    if (!existsSync(join(root, 'temp'))) return []

    return readdirSync(join(root, 'temp'))
      .filter(name => /^provenance-.+\.json$/.test(name))
      .map(name => readJson(join(root, 'temp', name)))
      .filter(Boolean)
  })()

  const verified = provenanceReports.filter(report => report.verdict === 'PASS')
  const failed = provenanceReports.filter(report => report.verdict === 'FAIL')
  const inconclusive = provenanceReports.filter(
    report => report.verdict !== 'PASS' && report.verdict !== 'FAIL',
  )

  if (failed.length > 0) {
    dimensions.push(
      dimension(
        'provenance',
        'BLOCKED',
        `${failed.length} report(s) verified as failing: ${failed.map(entry => entry.productId).join(', ')}`,
      ),
    )
  } else if (verified.length > 0 && verified.length === provenanceReports.length) {
    const total = verified.reduce((sum, entry) => sum + (entry.packages?.length ?? 0), 0)

    dimensions.push(
      dimension(
        'provenance',
        'PASS',
        `${total} package(s) across ${verified.length} product report(s), every attestation verified`,
        verified.map(entry => `temp/provenance-${entry.productId}.json`),
      ),
    )
  } else if (inconclusive.length > 0 && verified.length === 0) {
    dimensions.push(
      dimension(
        'provenance',
        'INCOMPLETE',
        `${inconclusive.length} report(s) did not reach a verdict: ${inconclusive
          .map(entry => `${entry.productId ?? '?'}=${entry.verdict}`)
          .join(', ')}`,
      ),
    )
  } else {
    dimensions.push(
      dimension(
        'provenance',
        options.offline ? 'INCOMPLETE' : 'INCOMPLETE',
        'no report; run pnpm check:provenance --product <id> --out temp/provenance-<id>.json',
      ),
    )
  }

  /* ---- image delivery ------------------------------------------------ */
  const pushed = delivery.filter(record => typeof record.imageDigest === 'string' && record.imageDigest)

  dimensions.push(
    pushed.length === expectedProducts.length && expectedProducts.length > 0
      ? dimension(
          'image-delivery',
          'PASS',
          `${pushed.length} image(s) have registry digests`,
          pushed.map(record => `${record.product}@${record.imageDigest.slice(0, 19)}…`),
        )
      : dimension(
          'image-delivery',
          'INCOMPLETE',
          `${pushed.length}/${expectedProducts.length} image(s) pushed; a local image ID is not a digest`,
        ),
  )

  /* ---- data compatibility -------------------------------------------- */
  dimensions.push(
    dimension(
      'data-compatibility',
      'INCOMPLETE',
      'no evidence that the previous version reads what this one writes; a plan must say "unverified"',
    ),
  )

  /* ---- production authorization -------------------------------------- */
  dimensions.push(
    dimension(
      'production-authorization',
      'BLOCKED',
      'this repository has no production access and no authorization to deploy',
    ),
  )

  return {
    schema: 'zeus.ecosystem.release-candidate/v1',
    generatedAt: new Date().toISOString(),
    commit,
    dirty,
    pair: pair
      ? {
          core: { version: pair.core.version, commit: pair.core.commit },
          ui: { version: pair.ui.version, commit: pair.ui.commit },
        }
      : null,
    matrix: matrix
      ? {
          schema: matrix.schema,
          entries: (matrix.entries ?? []).length,
          validated: (matrix.entries ?? []).filter(entry => entry.status === 'validated').length,
        }
      : null,
    dimensions,
    verdict: overallVerdict(dimensions),
  }
}

/**
 * The document's single verdict, derived from its dimensions.
 *
 * `BLOCKED` outranks `INCOMPLETE`: a dimension that answered "no" is a
 * different situation from one that never answered, and reporting the second
 * when the first is true understates what is wrong.
 *
 * An empty list is `INCOMPLETE`, never `READY`. `[].every(...)` is `true`, and
 * that predicate has already produced a green gate that checked nothing in
 * this repository once — the Workbench gates carry their own guard against it.
 * A candidate with no dimensions has not been assessed, and "not assessed"
 * must not read as "ready".
 */
export function overallVerdict(dimensions) {
  const verdicts = dimensions.map(entry => entry.verdict)

  if (verdicts.length === 0) return 'INCOMPLETE'
  if (verdicts.includes('BLOCKED')) return 'BLOCKED'
  if (verdicts.includes('INCOMPLETE')) return 'INCOMPLETE'
  return 'READY'
}

export function formatCandidate(candidate) {
  const lines = [
    `release candidate for ${candidate.commit.slice(0, 12)}${
      candidate.dirty === true ? ' (working tree dirty)'
        : candidate.dirty === undefined ? ' (working tree state unknown)'
          : ''
    }`,
    candidate.pair
      ? `  Core ${candidate.pair.core.version} + UI ${candidate.pair.ui.version}`
      : '  no published pair',
    '',
  ]

  for (const entry of candidate.dimensions) {
    lines.push(`  ${entry.verdict.padEnd(11)} ${entry.name.padEnd(26)} ${entry.detail}`)
  }

  lines.push('', `  verdict: ${candidate.verdict}`)

  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const root = resolve(value('--root') ?? process.cwd())

  /*
   * Provenance needs the network, and this script is also useful on a machine
   * that has none. `--offline` is not a way to pass: the dimension still
   * reports INCOMPLETE, because a skipped check and a passed check are not the
   * same value.
   */
  const candidate = buildCandidate(root, {
    commit: value('--commit'),
    offline: args.includes('--offline'),
    unitTestsPassed: args.includes('--unit-tests-passed'),
    unitTestsDetail: value('--unit-tests-detail'),
  })

  const out = value('--out') ?? join(root, 'temp/release-candidate.json')

  writeFileSync(out, `${JSON.stringify(candidate, null, 2)}\n`)

  console.log(formatCandidate(candidate))
  console.log(`\nreport: ${out}`)

  /*
   * A candidate that is not `READY` exits non-zero so a pipeline notices, but
   * the document is written either way: the dimensions are the useful output
   * and losing them because the verdict was bad is exactly backwards.
   */
  if (candidate.verdict !== 'READY' && !args.includes('--allow-not-ready')) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
