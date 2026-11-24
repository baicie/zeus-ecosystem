import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  installCommand,
  runFixture,
} from '../run-published-fixtures.mjs'
import {
  parseProjectName,
  renderMarkdown,
  summarize,
  verdictOf,
} from '../summarize-published-matrix.mjs'

test('each manager installs with peers treated strictly', () => {
  // A peer conflict must fail the install, not warn: the whole point is
  // whether a consumer can install the published pair.
  assert.deepEqual(installCommand('npm')[1].slice(0, 1), ['install'])
  assert.ok(installCommand('npm')[1].includes('--strict-peer-deps'))
  assert.ok(installCommand('pnpm')[1].includes('--strict-peer-dependencies'))
})

test('refuses a fixture that does not exist', () => {
  const result = runFixture('not-a-fixture', { manager: 'pnpm' })

  assert.equal(result.ok, false)
  assert.equal(result.steps[0].step, 'locate')
})

test('splits a Playwright project name into fixture and browser', () => {
  assert.deepEqual(parseProjectName('native-chromium'), {
    fixture: 'native',
    browser: 'chromium',
  })
  assert.deepEqual(parseProjectName('web-components-webkit'), {
    fixture: 'web-components',
    browser: 'webkit',
  })
  assert.equal(parseProjectName('not-a-project'), undefined)
})

function report(suites) {
  return {
    suites: suites.map(entry => ({
      title: entry.project,
      specs: [
        {
          title: entry.test,
          tests: [{ results: [{ status: entry.status, error: entry.error }] }],
        },
      ],
    })),
  }
}

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
