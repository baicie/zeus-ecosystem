import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  BASELINE,
  checkAll,
  checkGate,
  extractReport,
  measure,
} from '../checks/assert-gate-baseline.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A P0 report with the given engines and checks per result. */
function p0(engines, perSurface = [16, 8]) {
  const results = []

  for (const browser of engines) {
    for (const count of perSurface) {
      results.push({ browser, surface: count === 16 ? 'interactive' : 'replay', status: 'passed', checks: Array.from({ length: count }, () => ({ ok: true })) })
    }
  }

  return { results, passed: true }
}

function fixture(gate, report) {
  const root = mkdtempSync(join(tmpdir(), 'zeus-baseline-'))
  roots.push(root)
  const file = join(root, BASELINE[gate].report)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(report))

  return root
}

test('measures a full three-engine p0 run', () => {
  const found = measure(p0(['chromium', 'firefox', 'webkit']))

  assert.equal(found.results, 6)
  assert.equal(found.checks, 72)
  assert.equal(found.engines, 3)
})

test('accepts the migration baseline', () => {
  const root = fixture('p0', p0(['chromium', 'firefox', 'webkit']))

  assert.deepEqual(checkGate(root, 'p0', BASELINE.p0), [])
})

test('rejects a run that dropped a surface', () => {
  // Half the assertions, with every remaining one passing, is the exact shape
  // of a silently weakened gate.
  const root = fixture('p0', p0(['chromium', 'firefox', 'webkit'], [16]))
  const errors = checkGate(root, 'p0', BASELINE.p0)

  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /48 checks, below the 72 baseline/)
  assert.match(errors.join('\n'), /3 result\(s\), expected at least 6/)
})

test('rejects a run that dropped an engine', () => {
  const root = fixture('p0', p0(['chromium']))
  const errors = checkGate(root, 'p0', BASELINE.p0)

  assert.match(errors.join('\n'), /below the 72 baseline/)
})

test('rejects a gate that reported failure', () => {
  const report = { ...p0(['chromium', 'firefox', 'webkit']), passed: false }
  const root = fixture('p0', report)

  assert.match(checkGate(root, 'p0', BASELINE.p0).join('\n'), /did not pass/)
})

test('rejects absent engines even when enough checks ran', () => {
  const report = { ...p0(['chromium', 'firefox', 'webkit']), absentEngines: ['webkit'] }
  const root = fixture('p0', report)

  assert.match(checkGate(root, 'p0', BASELINE.p0).join('\n'), /1 requested engine/)
})

test('rejects a missing report', () => {
  const root = mkdtempSync(join(tmpdir(), 'zeus-baseline-'))
  roots.push(root)

  assert.match(checkGate(root, 'p0', BASELINE.p0)[0], /no report/)
})

test('rejects a report that is not JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'zeus-baseline-'))
  roots.push(root)
  const file = join(root, BASELINE.p0.report)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, 'not json at all')

  assert.match(checkGate(root, 'p0', BASELINE.p0)[0], /not valid JSON/)
})

test('reads a report that follows log lines', () => {
  // The gates tee their own progress to stdout, and CI captures both.
  const report = extractReport('starting...\n{"passed":true,"results":[]}\n')

  assert.equal(report.passed, true)
})

test('counts a flat checks list, which is how CSP reports', () => {
  assert.equal(measure({ checks: new Array(5).fill({}), passed: true }).checks, 5)
})

test('aggregates every gate', () => {
  assert.equal(checkAll(mkdtempSync(join(tmpdir(), 'zeus-empty-'))).length, 3)
})
