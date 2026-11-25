/**
 * Answers whether a production cutover could be planned, and refuses to plan one.
 *
 * ## Why this is not `deployment-plan.mjs --environment production`
 *
 * That script refuses production in code, deliberately, and the refusal is the
 * control: a production change needs an authorization this repository does not
 * have. Adding a flag to it would delete that control and replace it with a
 * convention.
 *
 * So this script does the part that needs no authorization — it reads the
 * eight prerequisites `docs/production-cutover-runbook.md` lists and says which
 * hold at this commit. Its output is a *preflight*, not a plan: it names no
 * image to deploy and cannot be turned into one. When every prerequisite holds
 * and somebody with authority decides to cut over, they run the real planner
 * against a separate authorization.
 *
 * ## Why the prerequisites are read rather than asserted
 *
 * Each of the eight has a fact behind it: a delivery record, a rehearsal
 * report, a registry digest, a CI conclusion, a backup a person took. A
 * checklist someone ticks by hand records their belief. A preflight that reads
 * the artefact records what happened, and where it cannot read — a backup on a
 * host this repository has never touched — it says `UNKNOWN` instead of
 * `PASS`.
 *
 * ## The three verdicts, per prerequisite
 *
 *   MET      an artefact says so, and it says so about this commit
 *   UNMET    an artefact says it is not so, or the artefact is missing
 *   UNKNOWN  only a person or a system outside this repository can answer
 *
 * `UNKNOWN` is not a soft `MET`. The runbook's requirement 8 is a tested
 * restore on the production host; nothing here can see that host, and calling
 * it satisfied because nobody contradicted it is how a cutover starts without
 * a rollback.
 *
 * Usage:
 *   node scripts/release/cutover-preflight.mjs [--unit admin|ai] [--out <file>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isRealCrossVersion, newestPassing, readReports } from './release-candidate.mjs'

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

export function prerequisite(id, status, detail, evidence = undefined) {
  return { id, status, detail, ...(evidence ? { evidence } : {}) }
}

/**
 * Reads the eight prerequisites for one unit.
 *
 * The order is the runbook's order, because a cutover follows it: an image
 * that does not exist makes the rehearsal question moot, and reporting both as
 * unmet makes a single problem look like two.
 */
export function preflight(root, options = {}) {
  const unitId = options.unit ?? 'admin'
  const commit = options.commit ?? git(root, ['rev-parse', 'HEAD'])

  const products = readJson(join(root, 'infra/contracts/products.json'))
  const unit = products?.deploymentUnits?.[unitId]
  const unitProducts = unit?.products ?? []

  const evidenceDir = join(root, 'temp')
  const deliveryRecords = []

  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      if (!name.startsWith('delivery-evidence-')) continue

      const record = readJson(join(evidenceDir, name))

      if (record?.schema === 'zeus.ecosystem.delivery-evidence/v1') deliveryRecords.push(record)
    }
  }

  const forUnit = deliveryRecords.filter(record => record.deploymentUnit === unitId)
  const withDigest = forUnit.filter(record => typeof record.imageDigest === 'string' && record.imageDigest)

  const prerequisites = []

  /* ---- 1. images exist in a registry with digests --------------------- */
  prerequisites.push(
    unitProducts.length > 0 && withDigest.length === unitProducts.length
      ? prerequisite(
          'images-with-digests',
          'MET',
          `${withDigest.length} image(s) in unit "${unitId}" carry a registry digest`,
          withDigest.map(record => `${record.product}@${record.imageDigest.slice(7, 19)}…`),
        )
      : prerequisite(
          'images-with-digests',
          'UNMET',
          `${withDigest.length}/${unitProducts.length} image(s) in unit "${unitId}" have a digest; ` +
            'a local image ID cannot name a rollback target',
        ),
  )

  /* ---- 2. build, start and health passed ------------------------------ */
  const healthPassed = forUnit.filter(
    record => record.checks?.BUILD_PASS === 'PASS' && record.checks?.STARTUP_PASS === 'PASS' && record.checks?.HEALTH_PASS === 'PASS',
  )

  prerequisites.push(
    unitProducts.length > 0 && healthPassed.length === unitProducts.length
      ? prerequisite('image-delivery-evidence', 'MET', `${healthPassed.length} product(s) passed build, start and health`)
      : prerequisite(
          'image-delivery-evidence',
          'UNMET',
          `${healthPassed.length}/${unitProducts.length} product(s) have BUILD_PASS + STARTUP_PASS + HEALTH_PASS`,
        ),
  )

  /* ---- 3. the whole unit is available --------------------------------- */
  prerequisites.push(
    unitProducts.length > 0
      ? prerequisite('complete-unit', 'MET', `unit "${unitId}" declares ${unitProducts.join(', ')} in order ${unit.order.join(' → ')}`)
      : prerequisite('complete-unit', 'UNMET', `no deployment unit "${unitId}" in products.json`),
  )

  /* ---- 4. the previous image set is recorded by digest ---------------- */
  /*
   * This is the one that cannot be reconstructed after the fact. A plan needs
   * `--previous` for every product, and at preflight time nobody has supplied
   * one, so the honest answer is that it has not been recorded — unless a
   * rehearsal report names the running baseline.
   */
  const crossVersion = readReports(root, 'zeus.ecosystem.cross-version-rehearsal/v1')
  const aiRehearsal = readReports(root, 'zeus.ecosystem.ai-rehearsal/v1')
  const relevant = unitId === 'admin' ? crossVersion : aiRehearsal
  const rehearsal = newestPassing(relevant)

  const baselineDigests = rehearsal?.baseline
    ? [rehearsal.baseline.image ?? rehearsal.baseline.imageId].filter(Boolean)
    : []

  prerequisites.push(
    baselineDigests.length > 0 && String(baselineDigests[0]).includes('@sha256:')
      ? prerequisite(
          'previous-image-set',
          'MET',
          `the rehearsal baseline names ${baselineDigests[0]}`,
        )
      : prerequisite(
          'previous-image-set',
          'UNKNOWN',
          rehearsal
            ? 'the rehearsal baseline is a local image ID, not a registry digest; the running set must be read from the host'
            : 'no rehearsal names a baseline; the running image set must be read from the host before the cutover',
        ),
  )

  /* ---- 5. upgrade and rollback were rehearsed against these versions -- */
  const real = rehearsal ? isRealCrossVersion(rehearsal) : { real: false, reason: 'no passing rehearsal' }

  prerequisites.push(
    real.real
      ? prerequisite('rehearsed', 'MET', real.reason, rehearsal.file?.replace(`${root}/`, ''))
      : prerequisite('rehearsed', 'UNMET', real.reason),
  )

  /* ---- 6. data compatibility has evidence, or is unverified ----------- */
  prerequisites.push(
    prerequisite(
      'data-compatibility',
      'UNKNOWN',
      'whether the previous version reads what this one writes has not been established; ' +
        'a plan must carry `unverified` and the rollback then has an unknown recovery point',
    ),
  )

  /* ---- 7. the product's browser gates pass on the release commit ------ */
  const gatesForUnit = {
    admin: ['apps/admin/temp/admin-browser/report.json', 'apps/admin/temp/admin-permissions/report.json'],
    ai: ['apps/ai-workbench/temp/ai-workbench-p0/report.json', 'apps/ai-workbench/temp/ai-workbench-byok/report.json'],
  }[unitId] ?? []

  const gateStates = gatesForUnit.map(relative => ({ relative, report: readJson(join(root, relative)) }))
  const gatesOk = gateStates.length > 0 && gateStates.every(entry => entry.report?.passed === true)

  prerequisites.push(
    gatesOk
      ? prerequisite('browser-gates', 'MET', `${gatesForUnit.length} gate report(s) passed locally`)
      : prerequisite(
          'browser-gates',
          'UNMET',
          gateStates
            .filter(entry => entry.report?.passed !== true)
            .map(entry => `${entry.relative}: ${entry.report ? 'did not pass' : 'no report'}`)
            .join('; ') || `no gate reports are declared for unit "${unitId}"`,
        ),
  )

  /*
   * The local reports are not the CI evidence the runbook asks for. CI runs on
   * the release commit; a local report is this machine's run. Recorded as a
   * separate prerequisite so "the gates passed here" never stands in for "the
   * gates passed on the commit being released".
   */
  prerequisites.push(
    prerequisite(
      'browser-gates-on-commit',
      'UNKNOWN',
      `the CI conclusion for ${commit.slice(0, 12)} must be read from Actions; this script has no token`,
    ),
  )

  /* ---- 8. a database backup exists and its restore was tested --------- */
  prerequisites.push(
    prerequisite(
      'tested-backup',
      'UNKNOWN',
      'nothing in this repository can see the production host; requirement 8 is an operator step',
    ),
  )

  return {
    schema: 'zeus.ecosystem.cutover-preflight/v1',
    generatedAt: new Date().toISOString(),
    commit,
    unit: unitId,
    prerequisites,
    verdict: overallPreflight(prerequisites),
    /*
     * Stated in the document, because the whole point is that this is not a
     * plan and cannot be used as one.
     */
    note:
      'This is a preflight, not a deployment plan. It names no image to deploy and ' +
      'no environment. `deployment-plan.mjs` refuses production in code; that refusal ' +
      'is the control, and it stays.',
  }
}

/**
 * The aggregate verdict.
 *
 * `READY` requires every prerequisite `MET` — not "none failed". `UNKNOWN` is
 * the state of a prerequisite nobody could answer, and a cutover that begins
 * with one of those begins without a rollback.
 */
export function overallPreflight(prerequisites) {
  if (prerequisites.length === 0) return 'INCOMPLETE'
  if (prerequisites.some(entry => entry.status === 'UNMET')) return 'NOT_READY'
  if (prerequisites.some(entry => entry.status === 'UNKNOWN')) return 'INCOMPLETE'
  return 'READY'
}

export function formatPreflight(result) {
  const lines = [`cutover preflight for unit "${result.unit}" at ${result.commit.slice(0, 12)}`, '']

  for (const entry of result.prerequisites) {
    lines.push(`  ${entry.status.padEnd(8)} ${entry.id.padEnd(26)} ${entry.detail}`)
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
  const result = preflight(root, { unit: value('--unit') ?? 'admin' })
  const out = value('--out') ?? join(root, `temp/cutover-preflight-${result.unit}.json`)

  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)

  console.log(formatPreflight(result))
  console.log(`\nreport: ${out}`)

  /*
   * Non-zero unless every prerequisite is met, and the document is written
   * either way — the list is the useful output, and losing it because the
   * verdict was bad is backwards.
   */
  if (result.verdict !== 'READY' && !args.includes('--allow-not-ready')) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
