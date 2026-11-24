/**
 * Turns the Playwright JSON report into a readable verdict.
 *
 * ## Why not just let the test reporter speak
 *
 * Playwright's list reporter is unreadable when 15 fixture/browser projects run
 * in parallel, and CI logs are what someone reads at 2am. This produces a
 * matrix table — fixture × browser — so a single failing cell is obvious, plus
 * the first line of each failure.
 *
 * ## Why it exits non-zero on an empty report
 *
 * "No tests ran" and "all tests passed" both look like success to a reporter.
 * For an acceptance gate they are opposite: an empty report means nothing was
 * verified, and treating that as a pass is the failure mode this whole
 * repository keeps guarding against.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Splits a Playwright project name (`native-chromium`) into its parts. */
export function parseProjectName(name) {
  const match = /^(.+)-(chromium|firefox|webkit)$/.exec(name)

  return match ? { fixture: match[1], browser: match[2] } : undefined
}

export function summarize(report) {
  const rows = new Map()
  const failures = []

  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const project = parseProjectName(suite.title ?? spec.title ?? '') ?? {
        fixture: suite.title ?? 'unknown',
        browser: 'unknown',
      }
      const key = `${project.fixture}/${project.browser}`
      const row = rows.get(key) ?? { pass: 0, fail: 0, skip: 0 }
      const results = spec.tests?.flatMap(test => test.results ?? []) ?? []
      const outcome = results[0]?.status ?? 'skipped'

      if (outcome === 'passed') row.pass += 1
      else if (outcome === 'skipped') row.skip += 1
      else {
        row.fail += 1
        const message = results[0]?.error?.message ?? 'failed'

        failures.push({
          test: `${key} :: ${spec.title}`,
          // First line only: the rest is a stack trace, which belongs in the
          // artifact, not in a summary table cell.
          message: message.split('\n')[0].trim(),
        })
      }

      rows.set(key, row)
    }
  }

  const totals = { pass: 0, fail: 0, skip: 0 }

  for (const row of rows.values()) {
    totals.pass += row.pass
    totals.fail += row.fail
    totals.skip += row.skip
  }

  return { rows, totals, failures }
}

/**
 * The verdict.
 *
 * Zero executed tests is not success. A skipped cell is not a pass either —
 * a browser that did not run its fixture has not been verified.
 */
export function verdictOf(summary) {
  if (summary.totals.pass === 0) return { ok: false, reason: 'no tests executed' }
  if (summary.totals.fail > 0) return { ok: false, reason: `${summary.totals.fail} failed` }
  if (summary.totals.skip > 0) return { ok: false, reason: `${summary.totals.skip} skipped` }

  return { ok: true, reason: 'every fixture passed in every browser' }
}

export function renderMarkdown(summary) {
  const fixtures = [...new Set([...summary.rows.keys()].map(key => key.split('/')[0]))].sort()
  const browsers = ['chromium', 'firefox', 'webkit']
  const lines = [
    '### Published consumer matrix',
    '',
    `| fixture | ${browsers.join(' | ')} |`,
    `| --- | ${browsers.map(() => '---').join(' | ')} |`,
  ]

  for (const fixture of fixtures) {
    const cells = browsers.map((browser) => {
      const row = summary.rows.get(`${fixture}/${browser}`)

      if (!row) return '—'
      if (row.fail > 0) return `FAIL (${row.fail})`
      if (row.skip === row.pass + row.skip) return 'SKIP'

      return `PASS (${row.pass})`
    })

    lines.push(`| ${fixture} | ${cells.join(' | ')} |`)
  }

  lines.push(
    '',
    `**${summary.totals.pass} passed, ${summary.totals.fail} failed, ${summary.totals.skip} skipped**`,
  )

  if (summary.failures.length > 0) {
    lines.push('', '| test | first line |', '| --- | --- |')

    for (const failure of summary.failures.slice(0, 25)) {
      lines.push(`| ${failure.test} | ${failure.message.replace(/\|/g, '\\|').slice(0, 160)} |`)
    }
  }

  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = resolve(process.argv[2] ?? 'reports/published-consumer.json')
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const summary = summarize(report)
  const markdown = renderMarkdown(summary)
  const verdict = verdictOf(summary)

  console.log(markdown)

  const summaryFile = process.env.GITHUB_STEP_SUMMARY

  if (summaryFile) appendFileSync(summaryFile, `${markdown}\n`)

  console.log(`matrix ${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.reason}`)
  process.exit(verdict.ok ? 0 : 1)
}
