import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'

import { validateRepository } from '../validate-repository.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(root, path, value) {
  const dest = join(root, path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, typeof value === 'string' ? value : JSON.stringify(value))
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ecosystem-policy-'))
  roots.push(root)
  for (const path of ['README.md', 'pnpm-workspace.yaml', '.github/workflows/ci.yml',
    'docs/architecture.md', 'docs/dependency-policy.md', 'docs/demo-catalog.md']) write(root, path, '')
  write(root, 'package.json', {name: 'ecosystem', private: true})
  write(root, 'docs/compatibility-matrix.json', {
    schema: 'zeus.ecosystem.compatibility/v1',
    entries: [{core:'0.2.0-rc.5',ui:null,status:'blocked',reason:'Awaiting UI release',evidence:[]}],
  })
  return root
}
test('valid scaffold and exact published upstream dependencies pass', () => {
  const root = fixture()
  write(root, 'apps/example/package.json', {
    name: '@ecosystem/example', private: true,
    dependencies: {'@zeus-js/zeus':'0.2.0-rc.5', '@zeus-web/button':'0.1.0-beta.35'},
  })
  assert.deepEqual(validateRepository(root), [])
})
test('rejects cross-repository workspace and Git/file producer dependencies', () => {
  const root = fixture()
  write(root, 'apps/example/package.json', {
    name: 'example', dependencies: {
      '@zeus-js/zeus':'workspace:*', '@zeus-web/button':'file:../../zeus-ui',
    },
  })
  const errors = validateRepository(root).join('\n')
  assert.match(errors, /cross-repository workspace link/)
  assert.match(errors, /exact registry version/)
})
test('permits workspace refs only to packages declared in the same repository', () => {
  const root = fixture()
  write(root, 'packages/common/package.json', {name:'@ecosystem/common',private:true})
  write(root, 'apps/example/package.json', {
    name:'@ecosystem/example', private:true,
    dependencies:{'@ecosystem/common':'workspace:*'},
  })
  assert.deepEqual(validateRepository(root), [])
})
test('blocked pairing must remain blocked without real UI evidence', () => {
  const root = fixture()
  write(root, 'docs/compatibility-matrix.json', {
    schema:'zeus.ecosystem.compatibility/v1',
    entries:[{core:'0.2.0-rc.5',ui:null,status:'validated',evidence:[]}],
  })
  assert.match(validateRepository(root).join('\n'), /validated pairing requires/)
})
test('detects malformed manifests and duplicate workspace package names', () => {
  const root = fixture()
  write(root, 'apps/one/package.json', {name:'same'})
  write(root, 'apps/two/package.json', {name:'same'})
  write(root, 'apps/bad/package.json', '{broken')
  const errors=validateRepository(root).join('\n')
  assert.match(errors, /Duplicate workspace/)
  assert.match(errors, /Invalid JSON/)
})

/*
 * Product registry cross-references.
 *
 * Each case breaks exactly one relationship that `products.json` relies on, so
 * the failure names the thing that is wrong rather than a downstream symptom.
 * The Playground was registered as a product with no deployment unit and every
 * check passed, which is why these exist.
 */
function productsFixture(mutate) {
  const root = fixture()
  const declaration = {
    schema: 'zeus.ecosystem.products/v1',
    products: [
      {
        productId: 'admin',
        deploymentUnit: 'admin',
        runtimePort: 8787,
        staticArtifact: true,
        persistence: { kind: 'server-database' },
      },
      {
        productId: 'playground',
        deploymentUnit: 'playground',
        runtimePort: 80,
        sandboxPort: 81,
        staticArtifact: true,
        persistence: { kind: 'browser-storage' },
      },
    ],
    deploymentUnits: {
      admin: { products: ['admin'], order: ['admin'] },
      playground: { products: ['playground'], order: ['playground'] },
    },
  }
  mutate?.(declaration)
  write(root, 'infra/contracts/products.json', declaration)
  return root
}

test('accepts a consistent product registry', () => {
  assert.deepEqual(validateRepository(productsFixture()), [])
})

test('rejects a product whose deployment unit is not declared', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      delete declaration.deploymentUnits.playground
    }),
  )
  assert.ok(
    errors.some(error => error.includes('playground') && error.includes('not declared')),
    errors.join('\n'),
  )
})

test('rejects a unit that lists a product that does not exist', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.deploymentUnits.admin.products.push('ghost')
    }),
  )
  assert.ok(errors.some(error => error.includes('ghost')), errors.join('\n'))
})

test('rejects a unit whose order disagrees with its products', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.deploymentUnits.playground.order = []
    }),
  )
  assert.ok(
    errors.some(error => error.includes('order') && error.includes('products')),
    errors.join('\n'),
  )
})

test('rejects a repeated product in order', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.deploymentUnits.admin.order = ['admin', 'admin']
    }),
  )
  assert.ok(errors.some(error => error.includes('repeats')), errors.join('\n'))
})

test('rejects a duplicate productId', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.products.push({ ...declaration.products[0] })
    }),
  )
  assert.ok(errors.some(error => error.includes('duplicate')), errors.join('\n'))
})

test('rejects a sandbox that shares the host port', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      const playground = declaration.products.find(p => p.productId === 'playground')
      playground.sandboxPort = playground.runtimePort
    }),
  )
  assert.ok(
    errors.some(error => error.includes('share the host origin')),
    errors.join('\n'),
  )
})

test('rejects an impossible port', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.products[0].runtimePort = 70000
    }),
  )
  assert.ok(errors.some(error => error.includes('not a valid port')), errors.join('\n'))
})

test('rejects a product that does not say how it keeps state', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      delete declaration.products[0].persistence
    }),
  )
  assert.ok(errors.some(error => error.includes('persistence')), errors.join('\n'))
})

test('rejects an unknown persistence kind', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.products[0].persistence = { kind: 'filesystem' }
    }),
  )
  assert.ok(errors.some(error => error.includes('persistence.kind')), errors.join('\n'))
})

test('rejects browser storage that points at a product that does not exist', () => {
  const errors = validateRepository(
    productsFixture(declaration => {
      declaration.products[1].persistence = {
        kind: 'browser-storage',
        serverStateIn: 'ghost',
      }
    }),
  )
  assert.ok(errors.some(error => error.includes('ghost')), errors.join('\n'))
})
