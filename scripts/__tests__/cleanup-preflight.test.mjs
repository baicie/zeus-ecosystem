import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUILD_CONFIG_FILES,
  classifyReference,
  overallCleanup,
} from '../release/cleanup-preflight.mjs'

test('only the manifest’s two files can block Phase 7', () => {
  /*
   * The manifest states the prerequisite in an exact form:
   *
   *     grep -rn "examples/admin" package.json vitest.config.ts
   *
   * Widening it is not a stricter check, it is a different one. My first
   * version searched the whole tree and reported sixty-odd hits — the legacy
   * app's own sources, its own tests, and release scripts the manifest says to
   * audit individually — as "build configuration still references it".
   */
  assert.deepEqual(BUILD_CONFIG_FILES, ['package.json', 'vitest.config.ts'])
})

test('classifies a build-config reference as blocking', () => {
  assert.equal(classifyReference('vitest.config.ts'), 'build-config')
  assert.equal(classifyReference('package.json'), 'build-config')
})

test('does not treat the legacy app’s own files as blockers', () => {
  /*
   * `examples/admin/src/admin-api.ts` mentions `examples/admin` because it is
   * inside it. Deleting the app deletes the reference.
   */
  assert.equal(classifyReference('examples/admin/src/admin-api.ts'), 'legacy-self')
  assert.equal(classifyReference('examples/ai-workbench/vite.config.ts'), 'legacy-self')
})

test('sends release scripts to the audit list rather than judging them here', () => {
  /*
   * The manifest says these need an individual audit — some are host
   * deployment, not app. A verdict from this script would be the guess the
   * manifest was written to avoid.
   */
  assert.equal(classifyReference('scripts/release/deployment-stage1.ts'), 'need-audit')
  assert.equal(classifyReference('scripts/check/check-admin.ts'), 'need-audit')
})

test('keeps prose references, because they record a measurement', () => {
  /*
   * `nesting.rs` names a JSX depth measured in `examples/admin`. Deleting the
   * comment would lose why the nesting limit is what it is.
   */
  assert.equal(classifyReference('crates/zeus_compiler/src/support/nesting.rs'), 'prose')
  assert.equal(classifyReference('docs/architecture/packages.md'), 'prose')
})

test('an empty prerequisite list is not READY', () => {
  assert.equal(overallCleanup([]), 'INCOMPLETE')
})

test('PARTIAL blocks rather than reading as progress', () => {
  /*
   * "Some applications are accepted" is a different situation from "none are",
   * and it is still not a state in which the rollback path may be deleted.
   */
  assert.equal(
    overallCleanup([
      { id: 'production-accepted', status: 'PARTIAL', detail: '' },
      { id: 'other', status: 'MET', detail: '' },
    ]),
    'BLOCKED',
  )
})

test('an UNKNOWN prerequisite keeps the verdict incomplete', () => {
  assert.equal(
    overallCleanup([
      { id: 'a', status: 'MET', detail: '' },
      { id: 'b', status: 'UNKNOWN', detail: '' },
    ]),
    'INCOMPLETE',
  )
})

test('is READY only when everything is MET', () => {
  assert.equal(
    overallCleanup([
      { id: 'a', status: 'MET', detail: '' },
      { id: 'b', status: 'MET', detail: '' },
    ]),
    'READY',
  )
})
