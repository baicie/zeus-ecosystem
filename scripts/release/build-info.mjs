/**
 * Produces the build identity every product carries.
 *
 * ## The mistake this replaces
 *
 * The P0 gate used the repository HEAD for `--ui-commit` when no environment
 * variable was set. That was right while the app lived inside zeus-ui, where
 * HEAD *was* the UI source. In this repository HEAD is the ecosystem commit,
 * so the recording named a commit that never built the UI — and nothing
 * complained, because all three values are 40-character hex strings.
 *
 * Three identities are therefore kept apart and never substituted for one
 * another:
 *
 *   app   the ecosystem commit that built this artifact
 *   core  the Core commit the published packages came from
 *   ui    the UI commit the published packages came from
 *
 * ## Fail closed
 *
 * A production build with no verified upstream identity is an error. The
 * synthetic fallback exists for local and CI test runs and is written into the
 * artifact as `test-only`, so it cannot be mistaken for release evidence.
 *
 * Usage:
 *   node scripts/release/build-info.mjs --product ai-workbench \
 *     --out <file> [--allow-synthetic]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONTRACT = 'infra/contracts/published-pair.json'
const FULL_SHA = /^[0-9a-f]{40}$/

/** Where each product's dist lands, relative to the repository root. */
export const PRODUCTS = {
  'ai-workbench': { dist: 'apps/ai-workbench/dist', staticArtifact: true },
  'ai-host': { dist: 'apps/ai-host/dist', staticArtifact: false },
  admin: { dist: 'apps/admin/dist', staticArtifact: true },
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/** SHA-256 of the lockfile, which is what pins the dependency graph. */
export function lockfileSha256(root) {
  const file = join(root, 'pnpm-lock.yaml')

  if (!existsSync(file)) return undefined

  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Reads the recorded release identity.
 *
 * Returns `undefined` rather than throwing so the caller decides whether a
 * missing contract is fatal — it is for a release build, and is not for a
 * test run.
 */
export function readContract(root) {
  const file = join(root, CONTRACT)

  if (!existsSync(file)) return undefined

  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Builds the identity record.
 *
 * `synthetic` marks every field whose value did not come from a verified
 * upstream. A record with `synthetic: true` is test-only by construction.
 */
export function createBuildInfo(options) {
  const {
    root = process.cwd(),
    product,
    /*
     * `null` means "explicitly no contract"; only an absent key falls back to
     * reading one. Treating `undefined` as "read it anyway" made it impossible
     * to test the fail-closed path without deleting a real file.
     */
    contract = readContract(root),
    allowSynthetic = false,
    now = () => new Date().toISOString(),
  } = options

  if (!PRODUCTS[product]) {
    throw new Error(`unknown product ${product}; known: ${Object.keys(PRODUCTS).join(', ')}`)
  }

  const errors = []
  const appCommit = git(root, ['rev-parse', 'HEAD'])

  if (!FULL_SHA.test(appCommit)) errors.push('the app commit is not a full SHA')

  let core
  let ui

  if (contract?.core && contract?.ui) {
    core = { version: contract.core.version, commit: contract.core.commit, tag: contract.core.tag }
    ui = { version: contract.ui.version, commit: contract.ui.commit, tag: contract.ui.tag }

    if (!FULL_SHA.test(core.commit)) errors.push('the contract records no usable Core commit')
    if (!FULL_SHA.test(ui.commit)) errors.push('the contract records no usable UI commit')
  } else {
    errors.push(`${CONTRACT} is missing or unreadable`)
  }

  /*
   * Three distinct values. If two of them are equal, something has been
   * substituted, and a release artifact must not silently carry that.
   */
  if (core && core.commit === appCommit) {
    errors.push('the Core commit equals the app commit — an identity was substituted')
  }

  if (ui && ui.commit === appCommit) {
    errors.push('the UI commit equals the app commit — an identity was substituted')
  }

  if (errors.length > 0 && !allowSynthetic) {
    throw new Error(
      [
        'build identity is not verifiable, refusing to produce a release artifact:',
        ...errors.map(error => `  ${error}`),
        '  Pass --allow-synthetic for a local or test build; the record is then marked test-only.',
      ].join('\n'),
    )
  }

  return {
    schema: 'zeus.ecosystem.build-info/v1',
    product,
    app: { repository: 'baicie/zeus-ecosystem', commit: appCommit },
    core: core ?? { version: 'unknown', commit: appCommit, tag: 'synthetic' },
    ui: ui ?? { version: 'unknown', commit: appCommit, tag: 'synthetic' },
    lockfileSha256: lockfileSha256(root) ?? 'unknown',
    builtAt: now(),
    // Present only when the record is not release evidence.
    ...(errors.length > 0 ? { synthetic: true, syntheticReasons: errors } : {}),
    toolchain: { node: process.version },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const product = value('--product')
  const out = value('--out')

  try {
    const info = createBuildInfo({
      product: product ?? '',
      allowSynthetic: args.includes('--allow-synthetic'),
    })
    const text = `${JSON.stringify(info, null, 2)}\n`

    if (out) writeFileSync(resolve(out), text)

    console.log(text)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
