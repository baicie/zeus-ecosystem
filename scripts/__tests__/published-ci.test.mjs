import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  installCommand,
  runFixture,
  shouldBuild,
} from '../run-published-fixtures.mjs'
import {
  renderMarkdown,
  summarize,
  verdictOf,
} from '../summarize-published-matrix.mjs'

/**
 * The shape Playwright actually writes: suites nest, and the project name is
 * on each spec's `tests[]`, not on the suite. A summarizer that assumed
 * otherwise reported "0 passed" against a report the runner called 90.
 */
function report(entries) {
  const byFixture = new Map()

  for (const entry of entries) {
    const [fixture] = entry.project.split('-')
    const list = byFixture.get(fixture) ?? []
    list.push(entry)
    byFixture.set(fixture, list)
  }

  /*
   * The nesting is the point: file → describe → specs. A summarizer that reads
   * only `suites[].specs` finds nothing here, which is exactly the bug this
   * fixture has to be able to expose.
   */
  return {
    suites: [...byFixture.entries()].map(([fixture, listed]) => ({
      title: `${fixture}.spec.ts`,
      file: `${fixture}.spec.ts`,
      specs: [],
      suites: [
        {
          title: `${fixture} consumer`,
          specs: listed.map(entry => ({
            title: entry.test,
            tests: [
              {
                projectName: entry.project,
                status: entry.status,
                results: [{ status: entry.status, error: entry.error }],
              },
            ],
          })),
          suites: [],
        },
      ],
    })),
  }
}

test('each manager installs with peers treated strictly', () => {
  // A peer conflict must fail the install, not warn: the whole point is
  // whether a consumer can install the published pair.
  assert.deepEqual(installCommand('npm')[1].slice(0, 1), ['install'])
  assert.ok(installCommand('npm')[1].includes('--strict-peer-deps'))
  assert.ok(installCommand('pnpm')[1].includes('--strict-peer-dependencies'))
})

test('builds by default and only skips on an explicit flag', () => {
  /*
   * The browser job serves each fixture with `vite preview`, so the fixture
   * must be built first. An inverted flag made that step a silent no-op, and
   * the only symptom was "The directory dist does not exist" — which reads
   * like a missing build, not like a broken option.
   *
   * The predicate is asserted directly because the side effect happens after a
   * multi-minute network install, where a test cannot see it cheaply.
   */
  assert.equal(shouldBuild(), true)
  assert.equal(shouldBuild({}), true)
  assert.equal(shouldBuild({ manager: 'pnpm' }), true)
  assert.equal(shouldBuild({ skipBuild: true }), false)
})

test('refuses a fixture that does not exist', () => {
  const result = runFixture('not-a-fixture', { manager: 'pnpm' })

  assert.equal(result.ok, false)
  assert.equal(result.steps[0].step, 'locate')
})

test('reads a nested report and counts each project', () => {
  const summary = summarize(
    report([
      { project: 'native-chromium', test: 'a', status: 'passed' },
      { project: 'native-firefox', test: 'a', status: 'passed' },
      { project: 'native-webkit', test: 'a', status: 'passed' },
      { project: 'react-chromium', test: 'b', status: 'passed' },
    ]),
  )

  assert.equal(summary.totals.pass, 4)
  assert.equal(summary.rows.get('native/webkit').pass, 1)
  assert.equal(verdictOf(summary).ok, true)
})

test('counts a spec that runs in one project per project', () => {
  /*
   * The same spec appears once per project; reading only the top level lost
   * every one of them.
   */
  const summary = summarize(
    report([
      { project: 'ai-chromium', test: 'x', status: 'passed' },
      { project: 'ai-firefox', test: 'x', status: 'passed' },
    ]),
  )

  assert.equal(summary.totals.pass, 2)
})

test('summarizes passing cells', () => {
  const summary = summarize(
    report([
      { project: 'native-chromium', test: 'a', status: 'passed' },
      { project: 'native-firefox', test: 'a', status: 'passed' },
    ]),
  )

  assert.equal(summary.totals.pass, 2)
  assert.equal(summary.totals.fail, 0)
  assert.equal(verdictOf(summary).ok, true)
})

test('an empty report is a failure, not a pass', () => {
  /*
   * "No tests ran" and "all tests passed" look the same to a reporter, and for
   * an acceptance gate they are opposite. A matrix that verified nothing must
   * not go green.
   */
  const summary = summarize({ suites: [] })

  assert.equal(verdictOf(summary).ok, false)
  assert.match(verdictOf(summary).reason, /no tests executed/)
})

test('a skipped cell is not a pass', () => {
  // A browser that did not run its fixture has not verified it.
  const summary = summarize(
    report([
      { project: 'native-chromium', test: 'a', status: 'passed' },
      { project: 'native-webkit', test: 'a', status: 'skipped' },
    ]),
  )

  assert.equal(verdictOf(summary).ok, false)
  assert.match(verdictOf(summary).reason, /skipped/)
})

test('reports a failure with its first line', () => {
  const summary = summarize(
    report([
      { project: 'vue-firefox', test: 'mounts', status: 'failed', error: { message: 'boom\nstack' } },
    ]),
  )

  assert.equal(summary.totals.fail, 1)
  assert.equal(summary.failures[0].message, 'boom')
  assert.equal(verdictOf(summary).ok, false)
})

test('renders a fixture-by-browser table', () => {
  const summary = summarize(
    report([
      { project: 'native-chromium', test: 'a', status: 'passed' },
      { project: 'react-firefox', test: 'a', status: 'passed' },
    ]),
  )
  const markdown = renderMarkdown(summary)

  assert.match(markdown, /\| fixture \| chromium \| firefox \| webkit \|/)
  assert.match(markdown, /\| native \| PASS \(1\) \| — \| — \|/)
})
