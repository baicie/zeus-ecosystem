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

test('an unreadable tree is UNKNOWN, not a clean one', async () => {
  /*
   * The defect this pins: `LEGACY_PATHS.flatMap(n => findReferences(...) ?? [])`
   * coalesced "git could not read the tree" into "git found nothing", so the
   * UNKNOWN branch below it was unreachable. Pointing `--zeus` at a directory
   * that is not a checkout reported MET — the opposite of what the module's own
   * header promises: "an unread tree is not a clean tree".
   */
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { cleanupPreflight } = await import('../release/cleanup-preflight.mjs')

  const notACheckout = mkdtempSync(join(tmpdir(), 'zeus-not-a-repo-'))

  try {
    const result = cleanupPreflight(process.cwd(), { zeus: notACheckout })
    const entry = result.prerequisites.find(item => item.id === 'build-config-clean')

    assert.equal(entry.status, 'UNKNOWN')
    assert.match(entry.detail, /could not be read/)
  } finally {
    rmSync(notACheckout, { recursive: true, force: true })
  }
})

test('the AI trees are looked for in zeus-ui, not zeus', async () => {
  /*
   * The manifest placed `examples/ai-workbench` in `zeus`, where it has never
   * existed — `zeus` has no such path in any commit, and `zeus-ui` has thirty
   * tracked files under it. A scanner reading only `zeus` reported the AI side
   * clean by never looking at it.
   */
  const { LEGACY_TREES } = await import('../release/cleanup-preflight.mjs')

  assert.deepEqual(LEGACY_TREES.zeus, ['examples/admin'])
  assert.deepEqual(LEGACY_TREES['zeus-ui'], ['examples/ai-workbench', 'examples/ai-host'])
})

test('a workflow that deploys the legacy tree blocks its deletion', async () => {
  /*
   * The manifest's two-file rule is right for `zeus`. `zeus-ui` is a different
   * shape: a workflow there builds and deploys the AI trees to production, and
   * deleting them breaks it. A rule that only looked at package.json would
   * call the tree clean.
   */
  const { blocksDeletion } = await import('../release/cleanup-preflight.mjs')

  assert.equal(blocksDeletion('.github/workflows/ai-workbench-image.yml'), true)
  assert.equal(blocksDeletion('tsconfig.json'), true)
  assert.equal(blocksDeletion('scripts/checks/ai/check-ai-workbench-p0.ts'), true)

  /* Host-deployment scripts are the manifest's audit column, not blockers. */
  assert.equal(blocksDeletion('scripts/release/deployment-stage1.ts'), false)
  assert.equal(blocksDeletion('docs/release/ai-workbench-deployment.md'), false)
})

test('without --zeus-ui the AI half is UNKNOWN, not clean', async () => {
  /*
   * Reporting MET because the repository that does not contain the tree is
   * clean is the same defect as an unread tree reported clean.
   */
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { cleanupPreflight } = await import('../release/cleanup-preflight.mjs')

  const notACheckout = mkdtempSync(join(tmpdir(), 'zeus-partial-'))

  try {
    const entry = cleanupPreflight(process.cwd(), { zeus: notACheckout })
      .prerequisites.find(item => item.id === 'build-config-clean')

    assert.equal(entry.status, 'UNKNOWN')
    assert.match(entry.detail, /could not be read/)
  } finally {
    rmSync(notACheckout, { recursive: true, force: true })
  }
})
