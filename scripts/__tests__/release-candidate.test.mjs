import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  countChecks,
  isRealCrossVersion,
  isRealPlaygroundCrossVersion,
  newestPassingForUnit,
  overallVerdict,
  rehearsalFamily,
  rehearsalImages,
  rehearsalUnit,
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

test('finds per-product provenance reports, not only one aggregate file', async () => {
  /*
   * The defect this pins: the reader looked for `temp/provenance-report.json`,
   * which nothing writes by default, so the dimension reported INCOMPLETE for
   * every product while three passing reports sat beside it. A reader that
   * names a path no writer writes is a reader that always says "no evidence".
   *
   * The verifier takes `--out`, so its files arrive as
   * `temp/provenance-<product>.json`; the reader has to accept that shape.
   */
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { buildCandidate } = await import('../release/release-candidate.mjs')

  const root = mkdtempSync(join(tmpdir(), 'zeus-candidate-'))

  try {
    mkdirSync(join(root, 'temp'), { recursive: true })

    for (const product of ['admin', 'ai-workbench', 'ai-host']) {
      writeFileSync(
        join(root, 'temp', `provenance-${product}.json`),
        JSON.stringify({
          schema: 'zeus.ecosystem.provenance-report/v1',
          productId: product,
          verdict: 'PASS',
          packages: new Array(56).fill({ verdict: 'VERIFIED' }),
        }),
      )
    }

    /* The candidate needs a commit; git is not available in a temp dir. */
    const candidate = buildCandidate(root, { commit: 'f'.repeat(40) })
    const provenance = candidate.dimensions.find(entry => entry.name === 'provenance')

    assert.equal(provenance.verdict, 'PASS')
    assert.match(provenance.detail, /168 package\(s\) across 3 product report\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/*
 * Evidence belongs to one deployment unit, and the schema is what says which.
 *
 * The aggregator used to pick `newestPassing` across every report in `temp/`,
 * so the newest passing rehearsal of *any* product could be offered as another
 * product's cross-version evidence. Both reports say "cross-version rehearsal"
 * and both say `passed: true`; only the schema distinguishes them. These tests
 * pin that, and pin the persistence claim each family is allowed to make.
 */
test('a rehearsal is attributed to the unit its schema names', () => {
  assert.equal(rehearsalUnit({ schema: 'zeus.ecosystem.cross-version-rehearsal/v1', unit: 'admin' }), 'admin')
  assert.equal(rehearsalUnit({ schema: 'zeus.ecosystem.ai-rehearsal/v1', unit: 'ai' }), 'ai')
  assert.equal(rehearsalUnit({ schema: 'zeus.playground-upgrade-rehearsal/v1' }), 'playground')
  assert.equal(rehearsalUnit({ schema: 'zeus.ecosystem.visual-diff/v1' }), undefined)
})

test('a Playground report is never offered as Admin evidence', () => {
  const playground = {
    schema: 'zeus.playground-upgrade-rehearsal/v1',
    passed: true,
    startedAt: '2026-11-27T09:00:00.000Z',
    baseline: { imageId: 'sha256:aaa' },
    candidate: { imageId: 'sha256:bbb' },
    steps: [],
  }

  // The newest passing report overall is the Playground's. Selecting for Admin
  // must ignore it rather than return it because nothing better exists.
  assert.equal(newestPassingForUnit([playground], 'admin'), undefined)
  assert.equal(newestPassingForUnit([playground], 'playground'), playground)
})

test('browser storage read across the boundary is a real rehearsal', () => {
  const report = {
    schema: 'zeus.playground-upgrade-rehearsal/v1',
    baseline: { imageId: 'sha256:aaa' },
    candidate: { imageId: 'sha256:bbb' },
    steps: [
      { name: 'the baseline persisted its project to IndexedDB', ok: true, detail: 'native-lab:3 files' },
      {
        name: 'the candidate reads the project the baseline wrote',
        ok: true,
        detail: '1 → 1 project(s): [["src/main.tsx"]]',
      },
      { name: 'the project content survived the round trip byte for byte', ok: true, detail: '699 → 699' },
    ],
  }

  const verdict = isRealPlaygroundCrossVersion(report)
  assert.equal(verdict.real, true)
  assert.match(verdict.reason, /browser storage/)
})

test('two empty lists agreeing is not a migration', () => {
  /*
   * The first version of the Playground rehearsal reloaded and read storage
   * without ever asking the app to save. Nothing was in IndexedDB, the next
   * step compared an empty list against an empty list, and it passed. `ok` is
   * the rehearsal's own opinion; the baseline having written something is what
   * makes the comparison mean anything.
   */
  const report = {
    schema: 'zeus.playground-upgrade-rehearsal/v1',
    baseline: { imageId: 'sha256:aaa' },
    candidate: { imageId: 'sha256:bbb' },
    steps: [
      { name: 'the baseline persisted its project to IndexedDB', ok: false, detail: '' },
      { name: 'the candidate reads the project the baseline wrote', ok: true, detail: '0 → 0 project(s)' },
      { name: 'the project content survived the round trip byte for byte', ok: true, detail: '0 → 0' },
    ],
  }

  const verdict = isRealPlaygroundCrossVersion(report)
  assert.equal(verdict.real, false)
  assert.match(verdict.reason, /never persisted/)
})

test('one image twice is refused by every family', () => {
  const report = {
    schema: 'zeus.playground-upgrade-rehearsal/v1',
    baseline: { imageId: 'sha256:same' },
    candidate: { imageId: 'sha256:same' },
    steps: [],
  }
  assert.equal(isRealPlaygroundCrossVersion(report).real, false)
  assert.match(isRealPlaygroundCrossVersion(report).reason, /one build compared with itself/)
})

test('the admin family is unchanged by the new one', () => {
  // The refactor routed `isRealCrossVersion` through a family check; a
  // Playground-shaped report must not silently fall through to the admin rules.
  assert.equal(rehearsalFamily({ schema: 'zeus.ecosystem.cross-version-rehearsal/v1' }), 'admin')
  assert.equal(rehearsalFamily({ schema: 'zeus.playground-upgrade-rehearsal/v1' }), 'playground')
  assert.equal(rehearsalImages({ baseline: { imageId: 'a' }, candidate: { imageId: 'b' } }).candidate[0], 'b')
})

/*
 * A unit with no evidence is INCOMPLETE by name, not absent.
 *
 * `cross-version` used to be two hardcoded names. Once a third unit existed,
 * the dimension could not say it was missing — it simply did not mention it,
 * and the aggregate read as though every unit had been considered.
 */
test('a unit with no passing rehearsal keeps the dimension INCOMPLETE', () => {
  const units = ['admin', 'ai', 'playground']
  const reports = [
    {
      schema: 'zeus.ecosystem.cross-version-rehearsal/v1',
      unit: 'admin',
      passed: true,
      baseline: { imageId: 'sha256:a1' },
      candidate: { imageId: 'sha256:a2' },
      upgrade: { matched: true, createdUnderCandidateId: 'row-1' },
    },
  ]

  const verdicts = units.map(unit => {
    const passing = newestPassingForUnit(reports, unit)
    return { unit, real: passing ? isRealCrossVersion(passing) : { real: false, reason: 'no passing rehearsal for this unit' } }
  })

  assert.equal(verdicts[0].real.real, true)
  assert.equal(verdicts[1].real.real, false)
  assert.equal(verdicts[2].real.real, false)
  assert.match(verdicts[2].real.reason, /no passing rehearsal/)
  // The dimension is the conjunction: one missing unit is enough.
  assert.equal(verdicts.every(verdict => verdict.real.real), false)
})

test('a unit with several products matches evidence against any of its kinds', () => {
  /*
   * The AI unit declares `browser-storage` (workbench preferences) and
   * `server-database` (host conversations). Reading only the first product made
   * a conversation-crossing rehearsal fail a check that said "ai declares
   * browser-storage" — a true statement about the wrong product.
   */
  const kinds = ['browser-storage', 'server-database']
  const evidenceMatches = (kind, reason) => {
    if (kind === 'server-database') return /row|conversation|written|read across/i.test(reason)
    if (kind === 'browser-storage') return /browser storage|read across/i.test(reason)
    return false
  }
  const reason = '2 baseline image(s) against 2 candidate image(s), with data read across the boundary'

  assert.equal(kinds.some(kind => evidenceMatches(kind, reason)), true)
  // And a claim neither product supports still fails.
  assert.equal(kinds.some(kind => evidenceMatches(kind, 'the images differ')), false)
})
