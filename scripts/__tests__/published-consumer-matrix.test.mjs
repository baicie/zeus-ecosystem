import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CORE_DEPENDENCIES,
  INDEPENDENT_VERSIONS,
  parseOptions,
} from '../published-consumer-matrix.mjs'

test('rejects a tag or range where an exact version is required', () => {
  // The matrix must install exactly what shipped. A range would let the test
  // pass against a version nobody released.
  for (const bad of ['beta', '^0.1.0-beta.35', '~0.1.0-beta.35', 'latest']) {
    assert.throws(
      () => parseOptions(['--core', '0.2.0-rc.5', '--ui', bad, '--manager', 'pnpm']),
      /exact version/,
      `should reject --ui ${bad}`,
    )
  }
})

test('accepts exact prerelease versions', () => {
  const options = parseOptions([
    '--core', '0.2.0-rc.5',
    '--ui', '0.1.0-beta.35',
    '--manager', 'pnpm',
  ])

  assert.equal(options.core, '0.2.0-rc.5')
  assert.equal(options.ui, '0.1.0-beta.35')
})

test('rejects an unknown package manager', () => {
  assert.throws(
    () => parseOptions([
      '--core', '0.2.0-rc.5',
      '--ui', '0.1.0-beta.35',
      '--manager', 'yarn',
    ]),
    /npm or pnpm/,
  )
})

test('does not assume every @zeus-js package shares the Core version', () => {
  /*
   * The first run of this matrix asked for @zeus-js/vite-plugin@0.2.0-rc.5 and
   * got ERR_PNPM_NO_MATCHING_VERSION: that package releases on its own 0.0.x
   * line. Pinning it here is what keeps the mistake from returning.
   */
  assert.equal(INDEPENDENT_VERSIONS['@zeus-js/vite-plugin'], '0.0.6')
  assert.ok(
    !CORE_DEPENDENCIES.includes('@zeus-js/vite-plugin'),
    'vite-plugin must not be installed at the Core version',
  )
})

test('covers the surfaces the matrix is meant to prove', () => {
  // A matrix that silently stopped importing a wrapper would still report
  // PASS on everything else. These names are the contract.
  for (const name of ['@zeus-js/zeus', '@zeus-js/signal', '@zeus-js/runtime-dom']) {
    assert.ok(CORE_DEPENDENCIES.includes(name), `${name} must be installed`)
  }
})

test('the pinned independent versions agree with the contract', async () => {
  /*
   * The defect this pins: `INDEPENDENT_VERSIONS` said `0.0.5` long after the
   * plugin moved to `0.0.6`, and its test asserted `0.0.5` — so `check:matrix`
   * stayed green while installing a version the repository no longer uses.
   *
   * A test that asserts a constant equals the same constant proves the
   * constant did not change. This one compares it to the contract, which is
   * the only other place the version is written down.
   */
  const { checkIndependentVersions } = await import('../published-consumer-matrix.mjs')
  const { resolve } = await import('node:path')

  const drift = checkIndependentVersions(resolve(import.meta.dirname, '../..'))

  assert.deepEqual(drift, [])
})

test('reports a contract that lists a package the constant does not', async () => {
  /*
   * Run against a temp root with an extra independent package, the check must
   * say so rather than ignore it — that is how `devtools-consumer` was found
   * missing when this check was first written.
   */
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { checkIndependentVersions } = await import('../published-consumer-matrix.mjs')

  const root = mkdtempSync(join(tmpdir(), 'zeus-matrix-'))

  try {
    mkdirSync(join(root, 'infra/contracts'), { recursive: true })
    writeFileSync(
      join(root, 'infra/contracts/published-pair.json'),
      JSON.stringify({ independent: { '@zeus-js/vite-plugin': '0.0.6', '@zeus-js/extra': '9.9.9' } }),
    )

    const drift = checkIndependentVersions(root)

    /*
     * Two disagreements, in both directions: the fake contract gained a
     * package the constant does not list, and dropped one it does. Reporting
     * only the first direction would let a package be removed from the
     * contract while the matrix kept installing and checking it.
     */
    assert.equal(drift.length, 2)
    assert.ok(drift.some(entry => /@zeus-js\/extra.*not here/.test(entry)))
    assert.ok(drift.some(entry => /devtools-consumer.*not in the contract/.test(entry)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
