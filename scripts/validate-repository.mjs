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

/*
 * Product registry consistency.
 *
 * `products.json` carries both a product list and a deployment-unit list, and
 * the two reference each other. Nothing checked that they agreed, so a product
 * could be declared without a unit to deploy it in — which is exactly what
 * happened when the Playground was registered: the product appeared in the
 * image matrix and in the release candidate's count, and `deploymentUnits` had
 * no entry for it. The structure check passed.
 *
 * Every rule below is one direction of that cross-reference, plus the port and
 * identity rules that a deployment needs to be meaningful.
 */
function validateProducts(root, errors) {
  const path = join(root, 'infra/contracts/products.json')
  if (!existsSync(path)) return

  const declaration = readJson(path, errors)
  if (!declaration) return

  const products = Array.isArray(declaration.products) ? declaration.products : null
  const units = declaration.deploymentUnits

  if (!products) {
    errors.push('products.json: products must be an array')
    return
  }
  if (!units || typeof units !== 'object' || Array.isArray(units)) {
    errors.push('products.json: deploymentUnits must be an object')
    return
  }

  /*
   * Built before the loop: `seen` accumulates as products are visited, so a
   * forward reference — `ai-workbench` pointing at `ai-host`, which is declared
   * later — would be reported as missing.
   */
  const allIds = new Set(products.map(product => product?.productId).filter(Boolean))

  /* productId is unique, and every product carries the unit it deploys in. */
  const seen = new Set()
  for (const product of products) {
    const id = product?.productId
    if (typeof id !== 'string' || !id) {
      errors.push('products.json: a product has no productId')
      continue
    }
    if (seen.has(id)) errors.push(`products.json: duplicate productId ${id}`)
    seen.add(id)

    if (typeof product.deploymentUnit !== 'string' || !product.deploymentUnit) {
      errors.push(`${id}: no deploymentUnit`)
      continue
    }

    const unit = units[product.deploymentUnit]
    if (!unit) {
      errors.push(`${id}: deploymentUnit "${product.deploymentUnit}" is not declared`)
      continue
    }
    if (!Array.isArray(unit.products) || !unit.products.includes(id)) {
      errors.push(`${id}: unit "${product.deploymentUnit}" does not list this product`)
    }

    for (const field of ['runtimePort', 'sandboxPort']) {
      const value = product[field]
      if (value === undefined) {
        if (field === 'sandboxPort') continue
        errors.push(`${id}: no ${field}`)
        continue
      }
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        errors.push(`${id}: ${field} ${JSON.stringify(value)} is not a valid port`)
      }
    }

    /*
     * A product that serves two origins serves them from two ports. Equal ports
     * would put the untrusted sandbox on the trusted host's origin, which is the
     * one arrangement the whole sandbox model exists to prevent.
     */
    /*
     * Every product has to say how it keeps state, because the acceptance a
     * product needs depends on it: a server database needs a backup-and-restore
     * step in a rollback, browser storage is per-origin and survives an image
     * swap but not an origin change, and `none` means neither applies.
     *
     * `ai-workbench` is the case that made this field necessary to think about:
     * its conversation data lives in AI Host while its preferences live in
     * LocalStorage. It declares `browser-storage` with a `serverStateIn` pointer
     * rather than pretending to be one thing.
     */
    const PERSISTENCE_KINDS = ['none', 'server-database', 'browser-storage']
    const persistence = product.persistence

    if (!persistence || typeof persistence !== 'object') {
      errors.push(`${id}: no persistence declaration`)
    } else if (!PERSISTENCE_KINDS.includes(persistence.kind)) {
      errors.push(
        `${id}: persistence.kind ${JSON.stringify(persistence.kind)} is not one of ${PERSISTENCE_KINDS.join(', ')}`,
      )
    } else if (persistence.kind === 'browser-storage' && persistence.serverStateIn) {
      if (!allIds.has(persistence.serverStateIn)) {
        errors.push(`${id}: persistence.serverStateIn names "${persistence.serverStateIn}", which is not a declared product`)
      }
    }

    if (
      Number.isInteger(product.sandboxPort) &&
      product.sandboxPort === product.runtimePort
    ) {
      errors.push(
        `${id}: runtimePort and sandboxPort are both ${product.runtimePort}; the sandbox would share the host origin`,
      )
    }
  }

  /* Every unit lists real products, exactly once, in an order that matches. */
  for (const [name, unit] of Object.entries(units)) {
    const listed = Array.isArray(unit.products) ? unit.products : null
    const order = Array.isArray(unit.order) ? unit.order : null

    if (!listed) {
      errors.push(`unit ${name}: products must be an array`)
      continue
    }
    if (!order) {
      errors.push(`unit ${name}: order must be an array`)
      continue
    }
    if (listed.length === 0) {
      errors.push(`unit ${name}: lists no products`)
    }

    let membershipBroken = false

    for (const id of listed) {
      if (!seen.has(id)) {
        errors.push(`unit ${name}: lists "${id}", which is not a declared product`)
        membershipBroken = true
        continue
      }
      const product = products.find(entry => entry.productId === id)
      if (product && product.deploymentUnit !== name) {
        errors.push(`unit ${name}: lists "${id}", but that product deploys in "${product.deploymentUnit}"`)
        membershipBroken = true
      }
    }

    /*
     * `order` and `products` disagreeing is reported below, but not when the
     * membership is already broken — then the disagreement is a second symptom
     * of the same edit, and the message about `order` hides the real one.
     */
    if (membershipBroken) continue

    if (new Set(order).size !== order.length) {
      errors.push(`unit ${name}: order repeats a product`)
    }
    if (order.length !== listed.length) {
      errors.push(`unit ${name}: order has ${order.length} entries, products has ${listed.length}`)
    }
    for (const id of orderedOnly(order, listed)) {
      errors.push(`unit ${name}: order names "${id}" which products does not`)
    }
    for (const id of orderedOnly(listed, order)) {
      errors.push(`unit ${name}: products names "${id}" which order does not`)
    }
  }
}

/** Items in `left` that `right` does not contain. */
function orderedOnly(left, right) {
  return left.filter(item => !right.includes(item))
}

export function validateRepository(root = DEFAULT_ROOT) {
  const errors = []
  for (const path of REQUIRED) {
    if (!existsSync(join(root, path))) errors.push('Missing ' + path)
  }

  validateProducts(root, errors)

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
