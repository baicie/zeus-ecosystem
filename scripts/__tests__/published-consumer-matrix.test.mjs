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
  assert.equal(INDEPENDENT_VERSIONS['@zeus-js/vite-plugin'], '0.0.5')
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
