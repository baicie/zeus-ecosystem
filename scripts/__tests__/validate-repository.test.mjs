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
