import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const required = [
  'README.md', 'package.json', 'pnpm-workspace.yaml',
  'docs/architecture.md', 'docs/compatibility-matrix.json',
  'docs/demo-catalog.md', '.github/workflows/ci.yml',
]

const failures = []
for (const path of required) {
  if (!existsSync(join(root, path))) failures.push('Missing: ' + path)
}

const matrixPath = join(root, 'docs/compatibility-matrix.json')
if (existsSync(matrixPath)) {
  try {
    const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'))
    if (matrix.schema !== 'zeus.ecosystem.compatibility/v1' || !Array.isArray(matrix.entries)) {
      failures.push('Compatibility matrix must contain schema and entries[]')
    }
    for (const entry of matrix.entries ?? []) {
      if (!['validated', 'candidate', 'blocked', 'unsupported', 'unknown'].includes(entry.status)) {
        failures.push('Invalid matrix status: ' + entry.status)
      }
      if (entry.status === 'validated' && (!entry.ui || !Array.isArray(entry.evidence) || !entry.evidence.length)) {
        failures.push('Validated combinations must name UI version and evidence')
      }
    }
  } catch (error) {
    failures.push('Invalid compatibility matrix JSON: ' + error.message)
  }
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const result = []
  for (const item of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git'].includes(item)) continue
    const absolute = join(dir, item)
    if (statSync(absolute).isDirectory()) result.push(...walk(absolute))
    else if (item === 'package.json') result.push(absolute)
  }
  return result
}

for (const path of walk(join(root, 'apps'))) {
  let pkg
  try { pkg = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { failures.push('Invalid package.json: ' + path + ': ' + error.message); continue }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith('@zeus-js/') && !name.startsWith('@zeus-web/')) continue
      if (typeof spec !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(spec)) {
        failures.push('Published ' + name + ' in ' + path + ' must use an exact registry version, got ' + spec)
      }
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error('FAIL: ' + failure)
  process.exit(1)
}
console.log('PASS: repository skeleton, compatibility matrix and published package policy')
