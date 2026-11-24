/**
 * Checks that the recorded release identity still matches reality.
 *
 * ## Why this file exists rather than a comment
 *
 * `infra/contracts/published-pair.json` names the Core and UI commits that the
 * apps are built against. A hand-written record drifts: someone bumps a
 * dependency, the manifest moves, and the contract keeps naming a commit that
 * no longer corresponds to anything. The recorded identity is only worth
 * something if something checks it.
 *
 * ## What "matches" means here
 *
 * Three separate facts, which the task explicitly keeps apart:
 *
 * 1. **Upstream identity** — the tag resolves to the recorded commit. Checked
 *    against GitHub, and annotated tags are peeled: `v0.2.0-rc.5` is annotated
 *    and its ref points at a tag object, not a commit, so a naive read of
 *    `ref.object.sha` yields a SHA that never built anything.
 * 2. **Consumer pinning** — every app manifest and the fixtures ask for exactly
 *    the recorded versions.
 * 3. **Compatibility** — the matrix says validated for this pair.
 *
 * ## What it is not
 *
 * This is *not* an upstream release pairing attestation. It records what a
 * consumer measured. The Core RC/stable attestation lives in the Core
 * repository's tagged tree, and beta compatibility does not substitute for it.
 *
 * Usage:
 *   node scripts/checks/check-published-pair-contract.mjs [--offline]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONTRACT = 'infra/contracts/published-pair.json'
const MATRIX = 'docs/compatibility-matrix.json'
const FULL_SHA = /^[0-9a-f]{40}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Every manifest in the repository that pins a Zeus dependency. */
const DEPENDENT_MANIFESTS = [
  'apps/ai-workbench/package.json',
  'apps/ai-host/package.json',
  'fixtures/published-consumer/native/package.json',
  'fixtures/published-consumer/web-components/package.json',
  'fixtures/published-consumer/react/package.json',
  'fixtures/published-consumer/vue/package.json',
  'fixtures/published-consumer/ai/package.json',
]

export function readJson(root, file) {
  const path = join(root, file)

  if (!existsSync(path)) return undefined

  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The structural contract, with no network.
 *
 * Kept separate from the online check so a CI run without a token can still
 * catch the common drift — a bump in one manifest that nobody recorded.
 */
export function checkContractStructure(root) {
  const errors = []
  const contract = readJson(root, CONTRACT)

  if (!contract) return [`${CONTRACT} is missing or is not valid JSON`]

  if (contract.schema !== 'zeus.ecosystem.published-pair/v1') {
    errors.push(`${CONTRACT}: unexpected schema ${String(contract.schema)}`)
  }

  for (const side of ['core', 'ui']) {
    const entry = contract[side]

    if (!entry) {
      errors.push(`${CONTRACT}: no ${side} section`)
      continue
    }

    if (!EXACT_VERSION.test(String(entry.version))) {
      errors.push(`${CONTRACT}: ${side}.version is not an exact version`)
    }

    /*
     * A tag object is a SHA too. Requiring the commit to be present and the
     * annotated flag to agree with whether a tag object was recorded stops the
     * two from being confused, which is the mistake peeling exists to prevent.
     */
    if (!FULL_SHA.test(String(entry.commit))) {
      errors.push(`${CONTRACT}: ${side}.commit is not a 40-character SHA`)
    }

    if (entry.annotated === true && !FULL_SHA.test(String(entry.tagObject))) {
      errors.push(`${CONTRACT}: ${side} is annotated but records no tag object`)
    }

    if (entry.annotated === false && entry.tagObject !== null) {
      errors.push(`${CONTRACT}: ${side} is lightweight but records a tag object`)
    }

    if (entry.commit === entry.tagObject) {
      errors.push(
        `${CONTRACT}: ${side}.commit equals its tag object — the tag was not peeled`,
      )
    }
  }

  const independent = contract.independent ?? {}

  /*
   * Every manifest must ask for exactly what the contract records. A range or
   * a different version is the drift this check exists for.
   */
  for (const file of DEPENDENT_MANIFESTS) {
    const manifest = readJson(root, file)

    if (!manifest) {
      errors.push(`${file} is missing or is not valid JSON`)
      continue
    }

    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        const expected = name.startsWith('@zeus-js/')
          ? (independent[name] ?? contract.core?.version)
          : name.startsWith('@zeus-web/')
            ? contract.ui?.version
            : undefined

        if (expected === undefined) continue

        if (String(version) !== expected) {
          errors.push(
            `${file}: ${name} is ${version}, the contract records ${expected}`,
          )
        }
      }
    }
  }

  const matrix = readJson(root, MATRIX)
  const entry = matrix?.entries?.find(
    row =>
      row.core === contract.core?.version && row.ui === contract.ui?.version,
  )

  if (!entry) {
    errors.push(`${MATRIX}: no entry for this pair`)
  } else if (entry.status !== contract.compatibility?.status) {
    errors.push(
      `${MATRIX}: status is ${entry.status}, the contract records ${contract.compatibility?.status}`,
    )
  }

  return errors
}

/**
 * Confirms the tags still resolve to the recorded commits.
 *
 * Annotated tags are peeled with a second request, because the ref names the
 * tag object. Without that, a moved tag would silently pass.
 */
export async function checkTagIdentity(contract, fetchImpl = fetch) {
  const errors = []
  const headers = {
    accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  }

  for (const side of ['core', 'ui']) {
    const entry = contract[side]
    const url = `https://api.github.com/repos/${entry.repository}/git/ref/tags/${entry.tag}`

    try {
      const response = await fetchImpl(url, { headers })

      if (!response.ok) {
        errors.push(`${side}: ${entry.tag} could not be read (HTTP ${response.status})`)
        continue
      }

      const ref = await response.json()
      let commit = ref.object?.sha

      if (ref.object?.type === 'tag') {
        const tagResponse = await fetchImpl(
          `https://api.github.com/repos/${entry.repository}/git/tags/${commit}`,
          { headers },
        )

        if (!tagResponse.ok) {
          errors.push(`${side}: the tag object for ${entry.tag} could not be peeled`)
          continue
        }

        commit = (await tagResponse.json()).object?.sha
      }

      if (commit !== entry.commit) {
        errors.push(
          `${side}: ${entry.tag} resolves to ${String(commit)}, the contract records ${entry.commit}`,
        )
      }
    } catch (error) {
      errors.push(`${side}: ${entry.tag} could not be reached — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.cwd())
  const offline = process.argv.includes('--offline')
  const errors = checkContractStructure(root)
  const contract = readJson(root, CONTRACT)

  if (!offline && contract && errors.length === 0) {
    errors.push(...(await checkTagIdentity(contract)))
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`)
    process.exit(1)
  }

  console.log(
    `published pair contract holds: ${contract.core.version} + ${contract.ui.version}${offline ? ' (structure only)' : ', tags verified'}`,
  )
}
