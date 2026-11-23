import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.2.0-rc.5'
const PACKAGES = ['@zeus-js/zeus', '@zeus-js/signal', '@zeus-js/runtime-dom']
const cwd = mkdtempSync(join(tmpdir(), 'zeus-ecosystem-core-consumer-'))
try {
  const pkg = {
    name: 'zeus-ecosystem-core-only-registry-smoke', version:'0.0.0', private:true,
    dependencies: Object.fromEntries(PACKAGES.map(name => [name, VERSION])),
  }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const install = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--ignore-scripts'], {
    cwd, encoding:'utf8', timeout:180000,
    env: {...process.env, npm_config_registry:'https://registry.npmjs.org/'},
  })
  if (install.status !== 0) throw new Error('npm install failed: ' + (install.error?.message ?? install.stderr))
  console.log('PASS: npm installed published Core packages in an isolated consumer')

  for (const name of PACKAGES) {
    const manifestPath = join(cwd, 'node_modules', ...name.split('/'), 'package.json')
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(installed.version, VERSION, name + ' is not the pinned Core release')
    console.log('PASS: ' + name + '@' + installed.version + ', at ' + realpathSync(manifestPath))
  }

  const listing = spawnSync('npm', ['ls', '@zeus-js/signal', '@zeus-js/runtime-dom', '--all', '--json'], {
    cwd, encoding:'utf8', timeout:30000,
  })
  if (listing.status !== 0) throw new Error('npm dependency tree invalid: ' + listing.stderr + '\n' + listing.stdout)
  const tree = JSON.parse(listing.stdout)
  const versions = new Map()
  function visit(deps) {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (name === '@zeus-js/signal' || name === '@zeus-js/runtime-dom') {
        if (!versions.has(name)) versions.set(name, new Set())
        versions.get(name).add(node.version)
      }
      visit(node.dependencies)
    }
  }
  visit(tree.dependencies)
  for (const name of ['@zeus-js/signal', '@zeus-js/runtime-dom']) {
    assert.deepEqual([...versions.get(name) ?? []], [VERSION], name + ' has mixed versions')
    console.log('PASS: ' + name + ' has only the expected version in npm dependency tree')
  }

  const requireFromConsumer = createRequire(join(cwd, 'smoke.cjs'))
  const signal = requireFromConsumer('@zeus-js/signal')
  assert.equal(typeof signal.createSignal, 'function')
  assert.equal(typeof signal.createEffect, 'function')
  const [read, write] = signal.createSignal(0)
  let observed = null
  const dispose = signal.createRoot(cleanup => {
    signal.createEffect(() => { observed = read() })
    return cleanup
  })
  write(1)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(observed, 1, 'published signal effect did not react to update')
  dispose()
  write(2)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(observed, 1, 'signal effect leaked after disposal')
  console.log('PASS: published signal reactivity and disposal work in an isolated Node consumer')
  console.log('Core-only smoke PASS. This does NOT validate any @zeus-web package or browser lifecycle.')
} finally {
  rmSync(cwd, { recursive:true, force:true })
}
