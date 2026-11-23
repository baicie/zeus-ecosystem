import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const matrix = JSON.parse(readFileSync(join(root, 'docs/compatibility-matrix.json'), 'utf8'))
const core = matrix.entries.find(item => item.core && item.status === 'blocked')?.core ?? '0.2.0-rc.5'
const names = ['@zeus-js/zeus', '@zeus-js/signal', '@zeus-js/runtime-dom']
let failed = false
for (const name of names) {
  const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(core)
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) {
    console.error('FAIL: ' + name + '@' + core + ' registry status ' + response.status)
    failed = true
    continue
  }
  const pkg = await response.json()
  assert.equal(pkg.version, core, name + ' returned a different registry version')
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith('@zeus-js/') && dep !== '@zeus-js/vite-plugin' && version !== core) {
      console.error('FAIL: ' + name + ' depends on ' + dep + '@' + version + ', expected ' + core)
      failed = true
    }
  }
  console.log('PASS: ' + name + '@' + core + ' is published with aligned Core dependencies')
}
if (failed) process.exitCode = 1
else console.log('This is Core-only registry evidence, not an approved UI pairing.')
