#!/usr/bin/env node
/**
 * One page to look at, instead of a dozen CI artifacts.
 *
 * ## Why this exists
 *
 * Three applications now produce visual evidence in three different shapes: the
 * Admin gate writes `temp/admin-visual/report.json` with per-scenario diffs and
 * diff images, the AI workbench writes its own comparison under
 * `apps/ai-workbench/temp/`, and the Playground writes
 * `temp/playground-visual/report.json`. Each lives in a different directory
 * with a different schema, and a reviewer who wants to know "did anything move"
 * has to open three artifacts and read three formats.
 *
 * K4 asks for one reviewable page. This collects whatever evidence exists,
 * says plainly which applications produced none, and keeps every scenario's
 * verdict separate from the design review — a difference is not a verdict, and
 * only a person can decide whether a moved button is a regression or a change.
 *
 * ## What it will not do
 *
 * It does not approve anything. `REVIEW_REQUIRED` is the only design status this
 * can produce, because the reviewer is the person reading the page.
 *
 * ```text
 * pnpm visual:review           # writes temp/visual-review/index.html
 * ```
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const out = join(root, 'temp/visual-review')

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

let nextImageId = 0
const images = []

/** Copies an image beside the page and returns the `src` to use. */
function embed(filePath) {
  if (!filePath || !existsSync(filePath)) return undefined
  const id = `img-${nextImageId++}`
  const name = `${id}${path.extname(filePath)}`
  const bytes = readFileSync(filePath)
  images.push({ name, bytes })
  return name
}

/**
 * The three applications, and where each one's evidence lands.
 *
 * `read` returns scenarios in one shape regardless of the producer:
 * `{ id, verdict, detail, reference, actual, diff }`. A producer whose report
 * is missing contributes an `absent` entry rather than being skipped — "this
 * app produced no visual evidence" is the single most important thing a review
 * page can say.
 */
const BASELINES = {
  admin: join(root, 'apps/admin/visual-baselines/reference.json'),
  'ai-workbench': join(root, 'apps/ai-workbench/visual-baselines/reference.json'),
  playground: join(root, 'apps/playground/visual-baselines/reference.json'),
}

const APPLICATIONS = [
  {
    id: 'admin',
    name: 'Admin',
    baseline: BASELINES.admin,
    read() {
      const report = readJson(join(root, 'apps/admin/temp/admin-visual/report.json'))
      if (!report) return undefined
      return (report.comparisons ?? []).map(comparison => ({
        id: comparison.scenario ?? comparison.id ?? 'unknown',
        verdict: comparison.kind === 'UNUSABLE' ? 'NOT_RUN' : (comparison.screenshot?.verdict ?? comparison.verdict ?? 'UNKNOWN'),
        detail: comparison.screenshot?.detail ?? comparison.detail ?? '',
        reference: embed(comparison.referenceImage),
        actual: embed(comparison.candidateImage),
        diff: embed(comparison.diffImage),
      }))
    },
    approval: () => readJson(BASELINES.admin)?.approvalStatus,
  },
  {
    id: 'ai-workbench',
    name: 'AI Workbench',
    baseline: BASELINES['ai-workbench'],
    read() {
      const report = readJson(join(root, 'apps/ai-workbench/temp/ai-workbench-visual/report.json'))
      if (!report) return undefined
      return (report.comparisons ?? report.scenarios ?? []).map(entry => ({
        id: entry.scenario ?? entry.id ?? 'unknown',
        verdict: entry.verdict ?? (entry.passed ? 'PASS' : 'REVIEW_REQUIRED'),
        detail: entry.detail ?? '',
        reference: embed(entry.referenceImage),
        actual: embed(entry.candidateImage),
        diff: embed(entry.diffImage),
      }))
    },
    approval: () => readJson(BASELINES['ai-workbench'])?.approvalStatus,
  },
  {
    id: 'playground',
    name: 'Playground',
    baseline: BASELINES.playground,
    read() {
      const report = readJson(join(root, 'apps/playground/temp/playground-visual/report.json'))
      /*
       * No comparison yet, but a baseline exists. Showing the baseline's own
       * scenarios as `REFERENCE_ONLY` is more honest than "no evidence": the
       * screenshots exist, a person can look at them, and what is missing is the
       * comparison run — not the evidence.
       */
      if (!report) {
        const baseline = readJson(BASELINES.playground)
        if (!baseline?.scenarios) return undefined
        return Object.keys(baseline.scenarios).map(id => ({
          id,
          verdict: 'REFERENCE_ONLY',
          detail: 'the baseline has this scenario; no comparison has been run against it yet',
          reference: embed(join(root, 'apps/playground/visual-baselines/screenshots', `${id}.png`)),
          actual: undefined,
          diff: undefined,
        }))
      }
      return (report.comparisons ?? []).map(entry => ({
        id: entry.id,
        verdict: entry.status === 'MATCH' ? 'PASS' : 'REVIEW_REQUIRED',
        detail: entry.detail ?? '',
        /*
         * The reference PNGs are committed beside the baseline; the current
         * run's captures are written to `temp/` by the comparison. A scenario
         * with no current capture (the comparison was not run this time) still
         * shows its reference, which is what a reviewer needs in order to know
         * what they are being asked to look at.
         */
        reference: embed(join(root, 'apps/playground/visual-baselines/screenshots', `${entry.id}.png`)),
        actual: embed(join(root, 'apps/playground/temp/playground-visual', `${entry.id}.png`)),
        diff: undefined,
      }))
    },
    approval: () => readJson(BASELINES.playground)?.approvalStatus,
  },
]

const escape = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const sections = APPLICATIONS.map(application => {
  const scenarios = application.read()
  const approval = application.approval?.()
  return { application, scenarios, approval }
})

/*
 * Overall status, from what exists.
 *
 * Any application with no evidence makes the whole review INCOMPLETE: a page
 * that shows two applications and says nothing about the third reads as though
 * there are two.
 */
const absent = sections.filter(section => !section.scenarios)
const noteworthy = sections.flatMap(section => (section.scenarios ?? []).filter(scenario => scenario.verdict !== 'PASS'))
const status = absent.length > 0 ? 'INCOMPLETE' : noteworthy.length > 0 ? 'REVIEW_REQUIRED' : 'MATCH'

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Zeus visual review</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --bg: #fff; --muted: #666; --line: #e3e5e8; --warn: #b45309; --bad: #b91c1c; --ok: #15803d; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e8ec; --bg: #16181d; --muted: #9aa0aa; --line: #2c313a; } }
  body { font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .status.MATCH { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .status.REVIEW_REQUIRED { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
  .status.INCOMPLETE { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  .status.REFERENCE_ONLY { background: color-mix(in srgb, var(--muted) 15%, transparent); color: var(--muted); }
  .muted { color: var(--muted); }
  .absent { padding: 12px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .shots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
  .shots figure { margin: 0; }
  .shots img { width: 100%; border: 1px solid var(--line); border-radius: 6px; display: block; }
  .shots figcaption { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<h1>Zeus visual review</h1>
<p>Every scenario the three applications produced, in one place.
Design approval is a person's decision and is never granted here.</p>
<p><span class="status ${status}">${status}</span>
${absent.length > 0 ? `<span class="muted"> — ${absent.map(section => section.application.name).join(', ')} produced no visual evidence</span>` : ''}
</p>
${sections
  .map(({ application, scenarios, approval }) => {
    if (!scenarios) {
      return `<h2>${escape(application.name)}</h2>
<div class="absent">No comparison report at ${escape(relative(root, join(root, 'apps', application.id, 'temp')))}.
Either the gate has not run against a reference, or it ran and wrote nowhere this page can read.</div>`
    }
    const rows = scenarios
      .map(
        scenario => `<tr>
  <td><code>${escape(scenario.id)}</code></td>
  <td><span class="status ${scenario.verdict === 'PASS' ? 'MATCH' : scenario.verdict === 'NOT_RUN' ? 'INCOMPLETE' : scenario.verdict === 'REFERENCE_ONLY' ? 'REFERENCE_ONLY' : 'REVIEW_REQUIRED'}">${escape(scenario.verdict)}</span></td>
  <td class="muted">${escape(scenario.detail)}</td>
</tr>
${
  scenario.reference || scenario.actual
    ? `<tr><td colspan="3"><div class="shots">
  ${scenario.reference ? `<figure><img src="${scenario.reference}" alt="reference"><figcaption>reference</figcaption></figure>` : ''}
  ${scenario.actual ? `<figure><img src="${scenario.actual}" alt="actual"><figcaption>actual</figcaption></figure>` : ''}
  ${scenario.diff ? `<figure><img src="${scenario.diff}" alt="diff"><figcaption>diff</figcaption></figure>` : ''}
</div></td></tr>`
    : ''
}`
      )
      .join('\n')
    return `<h2>${escape(application.name)} <span class="muted">— baseline ${escape(approval ?? 'unknown')}</span></h2>
<table><thead><tr><th>Scenario</th><th>Verdict</th><th>Detail</th></tr></thead><tbody>
${rows}
</tbody></table>`
  })
  .join('\n')}
<h2>What this page does not decide</h2>
<p class="muted">A difference is not a regression. Whether a moved element, a
different colour or a new label is intended is a design decision, and this page
records only that the difference exists.</p>
</body>
</html>
`

mkdirSync(out, { recursive: true })
for (const image of images) writeFileSync(join(out, image.name), image.bytes)
writeFileSync(join(out, 'index.html'), html)

console.log(`visual review: ${status}`)
for (const { application, scenarios, approval } of sections) {
  if (!scenarios) {
    console.log(`  ${application.name}: no evidence`)
    continue
  }
  const differing = scenarios.filter(scenario => scenario.verdict !== 'PASS').length
  console.log(`  ${application.name}: ${scenarios.length} scenario(s), ${differing} needing review, baseline ${approval ?? 'unknown'}`)
}
console.log(`\nopen ${relative(process.cwd(), join(out, 'index.html'))}`)
