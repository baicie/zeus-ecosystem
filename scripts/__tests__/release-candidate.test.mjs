import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  countChecks,
  isRealCrossVersion,
  overallVerdict,
  rehearsalImages,
} from '../release/release-candidate.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('a candidate that is not ready outranks as BLOCKED, not INCOMPLETE', () => {
  /*
   * The two are different actions. "Never checked" is fixed by checking;
   * "checked and refused" is fixed by changing something. Reporting the first
   * when the second is true understates what is wrong.
   */
  assert.equal(
    overallVerdict([
      { verdict: 'PASS' },
      { verdict: 'INCOMPLETE' },
      { verdict: 'BLOCKED' },
    ]),
    'BLOCKED',
  )

  assert.equal(overallVerdict([{ verdict: 'PASS' }, { verdict: 'INCOMPLETE' }]), 'INCOMPLETE')
  assert.equal(overallVerdict([{ verdict: 'PASS' }]), 'READY')
})

test('an empty dimension list is not READY', () => {
  /*
   * `[].every(...)` is true, which is the defect that produced a green gate
   * that ran nothing in this repository once already. A candidate with no
   * dimensions has not been assessed, and "not assessed" must not read as
   * "ready".
   */
  assert.equal(overallVerdict([]), 'INCOMPLETE')
})

test('reads both spellings of a rehearsal image set', () => {
  /*
   * cross-version writes `imageId` (one per side); ai-rehearsal writes
   * `imageIds` (a list). Reading only one spelling reported the other family
   * as "a side recorded no images" — a reader that assumed a shape, reported
   * as a broken rehearsal.
   */
  const singular = rehearsalImages({
    baseline: { imageId: 'sha256:aa' },
    candidate: { imageId: 'sha256:bb' },
  })

  assert.deepEqual(singular, { baseline: ['sha256:aa'], candidate: ['sha256:bb'] })

  const plural = rehearsalImages({
    baseline: { imageIds: ['sha256:aa', 'sha256:cc'] },
    candidate: { imageIds: ['sha256:bb', 'sha256:dd'] },
  })

  assert.deepEqual(plural, { baseline: ['sha256:aa', 'sha256:cc'], candidate: ['sha256:bb', 'sha256:dd'] })
})

test('refuses a rehearsal whose candidate is its baseline', () => {
  /*
   * The prohibition by name: one image twice is not a cross-version test. It
   * can pass every step and prove nothing about upgrading.
   */
  const verdict = isRealCrossVersion({
    baseline: { imageId: 'sha256:same' },
    candidate: { imageId: 'sha256:same' },
    upgrade: { matched: true, createdUnderCandidateId: 'candidate-1' },
  })

  assert.equal(verdict.real, false)
  assert.match(verdict.reason, /compared with itself/)
})

test('refuses different images that never moved data', () => {
  /*
   * The subtler fake, and the reason checking image IDs alone is not enough:
   * two genuinely different builds, every step green, and no row written under
   * one version and read under the other. That is a restart.
   */
  const verdict = isRealCrossVersion({
    baseline: { imageId: 'sha256:aa' },
    candidate: { imageId: 'sha256:bb' },
    upgrade: { matched: false },
  })

  assert.equal(verdict.real, false)
  assert.match(verdict.reason, /restart, not an upgrade/)
})

test('accepts the admin rehearsal when a row crossed the boundary', () => {
  const verdict = isRealCrossVersion({
    baseline: { imageId: 'sha256:aa' },
    candidate: { imageId: 'sha256:bb' },
    upgrade: { matched: true, createdUnderCandidateId: 'candidate-1' },
  })

  assert.equal(verdict.real, true)
})

test('accepts the ai rehearsal when a conversation crossed the boundary', () => {
  const verdict = isRealCrossVersion({
    baseline: { imageIds: ['sha256:aa'], written: { conversation: 'rehearsal-a', bytes: 1386 } },
    candidate: { imageIds: ['sha256:bb'] },
  })

  assert.equal(verdict.real, true)
})

test('refuses an ai rehearsal that wrote nothing', () => {
  /*
   * `bytes: 0` is a real observation from this repository's history: a run
   * whose baseline wrote an empty conversation. It passed and it proved
   * nothing, because there was nothing to read back.
   */
  const verdict = isRealCrossVersion({
    baseline: { imageIds: ['sha256:aa'], written: { conversation: 'rehearsal-a', bytes: 0 } },
    candidate: { imageIds: ['sha256:bb'] },
  })

  assert.equal(verdict.real, false)
})

test('counts each gate report by the shape it actually emits', () => {
  /*
   * Measured shapes. One rule for all of them reported the 14-scenario browser
   * run as "14 checks, floor 42" and the 8-scenario visual run as 0 — both
   * wrong, and both wrong in the direction that reads like a missing gate.
   */
  /* admin-browser: one entry per engine and scenario */
  assert.equal(countChecks({ results: new Array(14).fill({ passed: true }) }), 14)

  /* ai-workbench p0: one entry per engine and surface, each with checks */
  assert.equal(
    countChecks({ results: [{ checks: new Array(16).fill({}) }, { checks: new Array(8).fill({}) }] }),
    24,
  )

  /* admin-visual: comparisons, one per scenario */
  assert.equal(countChecks({ comparisons: new Array(8).fill({}) }), 8)

  /* csp and host protocol: a flat list */
  assert.equal(countChecks({ checks: new Array(5).fill({}) }), 5)
})

test('counts nothing as zero rather than guessing', () => {
  assert.equal(countChecks({}), 0)
  assert.equal(countChecks(undefined), 0)
})
