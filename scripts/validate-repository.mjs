import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED = [
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  '.github/workflows/ci.yml',
  'docs/architecture.md',
  'docs/dependency-policy.md',
  'docs/compatibility-matrix.json',
  'docs/demo-catalog.md',
]
const STATUSES = new Set(['blocked', 'candidate', 'validated', 'unsupported', 'unknown'])
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push('Invalid JSON ' + path + ': ' + error.message)
    return null
  }
}

function manifestsUnder(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage', '.next', '.vite', 'temp'].includes(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...manifestsUnder(p))
    else if (entry.isFile() && entry.name === 'package.json') found.push(p)
  }
  return found
}

export function validateRepository(root = DEFAULT_ROOT) {
  const errors = []
  for (const path of REQUIRED) {
    if (!existsSync(join(root, path))) errors.push('Missing ' + path)
  }

  const matrixPath = join(root, 'docs/compatibility-matrix.json')
  if (existsSync(matrixPath)) {
    const matrix = readJson(matrixPath, errors)
    if (matrix) {
      if (matrix.schema !== 'zeus.ecosystem.compatibility/v1' || !Array.isArray(matrix.entries)) {
        errors.push('Compatibility matrix must contain schema and entries[]')
      } else {
        if (!matrix.entries.length) errors.push('Compatibility matrix must not be empty')
        for (const [i, item] of matrix.entries.entries()) {
          const prefix = 'matrix.entries[' + i + ']'
          if (!item || typeof item !== 'object') { errors.push(prefix + ' must be an object'); continue }
          if (!STATUSES.has(item.status)) errors.push(prefix + ': invalid status')
          if (typeof item.core !== 'string' || !EXACT.test(item.core)) errors.push(prefix + ': invalid Core version')
          if (item.ui !== null && (typeof item.ui !== 'string' || !EXACT.test(item.ui))) errors.push(prefix + ': invalid UI version')
          if (!Array.isArray(item.evidence)) errors.push(prefix + ': evidence must be an array')
          if (item.status === 'validated' && (!item.ui || !Array.isArray(item.evidence) || !item.evidence.length)) {
            errors.push(prefix + ': validated pairing requires a UI version and nonempty evidence')
          }
          if (item.status === 'blocked' && (!item.reason || typeof item.reason !== 'string')) {
            errors.push(prefix + ': blocked pairing needs a reason')
          }
        }
      }
    }
  }

  const manifestPaths = [join(root, 'package.json'), ...manifestsUnder(join(root, 'apps')), ...manifestsUnder(join(root, 'packages'))]
  const allPackageNames = new Set()
  const parsed = []
  for (const path of manifestPaths) {
    if (!existsSync(path)) continue
    const pkg = readJson(path, errors)
    if (!pkg) continue
    parsed.push({path, pkg})
    if (typeof pkg.name !== 'string' || !pkg.name) errors.push(relative(root, path) + ': missing package name')
    else if (allPackageNames.has(pkg.name)) errors.push('Duplicate workspace package name: ' + pkg.name)
    else allPackageNames.add(pkg.name)
  }

  for (const {path, pkg} of parsed) {
    const label = relative(root, path)
    for (const field of DEP_FIELDS) {
      const deps = pkg[field] ?? {}
      if (typeof deps !== 'object' || Array.isArray(deps)) { errors.push(label + ': ' + field + ' must be an object'); continue }
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string') { errors.push(label + ': ' + name + ' needs a string version'); continue }
        if (spec.startsWith('workspace:') && !allPackageNames.has(name)) {
          errors.push(label + ': cross-repository workspace link to ' + name)
        }
        if (name.startsWith('@zeus-js/') || name.startsWith('@zeus-web/')) {
          if (!EXACT.test(spec)) {
            errors.push(label + ': published producer ' + name + ' must use an exact registry version, got ' + spec)
          }
        }
      }
    }
  }
  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT
  const errors = validateRepository(root)
  if (errors.length) {
    for (const error of errors) console.error('FAIL: ' + error)
    process.exitCode = 1
  } else {
    console.log('PASS: skeleton, compatibility evidence and dependency boundaries')
  }
}
