import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  checkManifest,
  checkTsconfig,
  checkViteConfig,
  listFixtures,
  zeusSpecifiers,
} from '../check-published-fixtures.mjs'

test('accepts an exact published version', () => {
  assert.deepEqual(
    checkManifest('f', { dependencies: { '@zeus-web/button': '0.1.0-beta.35' } }),
    [],
  )
})

test('rejects the workspace protocol', () => {
  // A fixture that resolves through pnpm's workspace link is not evidence
  // about what was published.
  const errors = checkManifest('f', {
    dependencies: { '@zeus-web/button': 'workspace:*' },
  })

  assert.equal(errors.length, 1)
  assert.match(errors[0], /workspace:/)
})

test('rejects a local path', () => {
  for (const spec of ['file:../../../zeus', 'link:../../zeus-ui']) {
    const errors = checkManifest('f', { dependencies: { '@zeus-js/zeus': spec } })

    assert.equal(errors.length, 1, spec)
    assert.match(errors[0], /local path/)
  }
})

test('rejects a range, because a fixture must not drift', () => {
  for (const spec of ['^0.1.0-beta.35', '~0.1.0-beta.35', 'latest', '>=0.1.0']) {
    const errors = checkManifest('f', { dependencies: { '@zeus-web/button': spec } })

    assert.equal(errors.length, 1, spec)
    assert.match(errors[0], /range/)
  }
})

test('rejects an independent package pinned to the Core version', () => {
  /*
   * The first matrix run asked for @zeus-js/vite-plugin@0.2.0-rc.5 and got
   * ERR_PNPM_NO_MATCHING_VERSION: that package releases on its own 0.0.x line.
   */
  const errors = checkManifest('f', {
    dependencies: { '@zeus-js/vite-plugin': '0.2.0-rc.5' },
  })

  assert.equal(errors.length, 1)

  /*
   * The expected version is read from the contract, not typed here. It was
   * `0.0.5` in this assertion, and the plugin moving to `0.0.6` failed a test
   * whose subject — "the error names the right line" — had not changed.
   */
  const { independent } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../infra/contracts/published-pair.json'), 'utf8'),
  )

  assert.match(errors[0], new RegExp(independent['@zeus-js/vite-plugin'].replace(/\./g, '\\.')))
})

test('checks every dependency field, not only dependencies', () => {
  const errors = checkManifest('f', {
    peerDependencies: { '@zeus-web/dialog': 'workspace:*' },
    devDependencies: { '@zeus-js/zeus': '^0.2.0-rc.5' },
  })

  assert.equal(errors.length, 2)
})

test('ignores non-Zeus packages', () => {
  assert.deepEqual(
    zeusSpecifiers({ dependencies: { react: '^19.0.0', vite: '8.3.8' } }),
    [],
  )
})

test('rejects a tsconfig path that escapes node_modules', () => {
  const errors = checkTsconfig('f', {
    compilerOptions: { paths: { '@zeus-js/zeus': ['../../zeus/packages/core/zeus'] } },
  })

  assert.equal(errors.length, 1)
  assert.match(errors[0], /not a published package/)
})

test('rejects skipLibCheck, because published types are the thing under test', () => {
  const errors = checkTsconfig('f', { compilerOptions: { skipLibCheck: true } })

  assert.equal(errors.length, 1)
  assert.match(errors[0], /skipLibCheck/)
})

test('rejects a Vite alias pointing at Zeus source', () => {
  assert.match(
    checkViteConfig('f', "export default { resolve: { alias: { '@zeus-js/zeus': '../zeus' } } }")[0],
    /Zeus alias/,
  )
  assert.equal(checkViteConfig('f', 'export default {}').length, 0)
})

test('all committed fixtures pass', () => {
  // The guard must hold on the real tree, not only on synthetic inputs.
  const fixtures = listFixtures(process.cwd())

  assert.ok(fixtures.length > 0, 'expected fixtures to exist')

  for (const fixture of fixtures) {
    const manifest = JSON.parse(
      readFileSync(`${fixture.directory}/package.json`, 'utf8'),
    )

    assert.deepEqual(checkManifest(fixture.name, manifest), [], fixture.name)
  }
})
