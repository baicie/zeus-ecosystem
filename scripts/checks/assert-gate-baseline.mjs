/**
 * Fails when a browser gate suddenly asserts less, or runs fewer engines.
 *
 * ## What this guards
 *
 * The migration baseline, measured from real runs:
 *
 *   p0    interactive x 3 engines x 16 checks = 48
 *         replay      x 3 engines x  8 checks = 24   → 72 total
 *   byok  3 engines x 23 checks              = 69
 *   csp   5 checks (single engine by design)
 *
 * A gate can keep printing `"passed": true` while checking half as much — a
 * filter that matched fewer cases, a loop that stopped early, someone deleting
 * a check while chasing a red run. Counting is the cheapest way to notice.
 *
 * ## Why engines are counted separately
 *
 * A gate that ran one engine and reported success would still produce 24 checks
 * for interactive. Requiring three engines is what makes the count mean what it
 * says. BYOK defaults to chromium when the environment does not ask for more,
 * so without this check a three-engine claim could quietly become one.
 *
 * Counts are a floor, not an equality: adding assertions is fine, removing them
 * is a deliberate act that changes this file in the same PR.
 *
 * Usage: node scripts/checks/assert-gate-baseline.mjs [--root <ecosystem root>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Per-gate floors.
 *
 * `results` is how many engine/surface entries must be present, because the two
 * gates report differently: P0 emits one entry per engine *and surface*, BYOK
 * one per engine, CSP a single flat list.
 */
export const BASELINE = {
  p0: {
    report: 'apps/ai-workbench/temp/ai-workbench-p0/report.json',
    results: 6,
    checks: 72,
  },
  byok: {
    report: 'apps/ai-workbench/temp/ai-workbench-byok/report.json',
    results: 3,
    checks: 69,
  },
  csp: {
    report: 'apps/ai-workbench/temp/ai-workbench-csp/report.json',
    results: 0,
    checks: 5,
  },
}

/** Reads the first JSON object in a file, since gates also log to stdout. */
export function extractReport(text) {
  const start = text.indexOf('{')

  if (start === -1) return undefined

  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/**
 * Counts what a gate actually asserted.
 *
 * Handles both shapes the gates emit: a `results[]` list (one entry per engine,
 * or per engine and surface) and a flat top-level `checks[]`.
 */
export function measure(report) {
  const results = Array.isArray(report?.results) ? report.results : []
  let checks = 0
  const engines = new Set()

  for (const result of results) {
    if (Array.isArray(result.checks)) checks += result.checks.length
    if (typeof result.browser === 'string') engines.add(result.browser)
  }

  if (Array.isArray(report?.checks)) checks += report.checks.length

  return {
    results: results.length,
    checks,
    engines: engines.size,
    passed: report?.passed === true,
    absentEngines: Array.isArray(report?.absentEngines)
      ? report.absentEngines.length
      : 0,
  }
}

export function checkGate(root, name, baseline) {
  const file = join(root, baseline.report)

  if (!existsSync(file)) return [`${name}: no report at ${baseline.report}`]

  const report = extractReport(readFileSync(file, 'utf8'))

  if (report === undefined) return [`${name}: the report is not valid JSON`]

  const found = measure(report)
  const errors = []

  /*
   * A gate that says it failed is a failure here too, even if it asserted a
   * lot. The two conditions answer different questions.
   */
  if (!found.passed) errors.push(`${name}: the gate did not pass`)

  if (found.absentEngines > 0) {
    errors.push(`${name}: ${found.absentEngines} requested engine(s) were absent`)
  }

  if (found.checks < baseline.checks) {
    errors.push(`${name}: ${found.checks} checks, below the ${baseline.checks} baseline`)
  }

  if (found.results < baseline.results) {
    errors.push(
      `${name}: ${found.results} result(s), expected at least ${baseline.results} (one per engine${name === 'p0' ? ' and surface' : ''})`,
    )
  }

  return errors
}

export function checkAll(root = process.cwd()) {
  return Object.entries(BASELINE).flatMap(([name, baseline]) =>
    checkGate(root, name, baseline),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--root')
  const root = resolve(index === -1 ? process.cwd() : process.argv[index + 1])
  const errors = checkAll(root)

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`)
    process.exit(1)
  }

  console.log('gate baseline holds: every gate still asserts at least as much as the migration did')
}
