import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

import {
  checkContractStructure,
  checkTagIdentity,
  readJson,
} from '../checks/check-published-pair-contract.mjs'
import {
  createBuildInfo,
  lockfileSha256,
  PRODUCTS,
  readContract,
} from '../release/build-info.mjs'


import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway repository containing only the contract.
 *
 * `checkContractStructure` reads fixed relative paths, so a modified contract
 * needs its own tree rather than a mutated copy of the real file.
 */
function writeFixtureContract(contract) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'zeus-contract-'))
  mkdirSync(join(fixtureRoot, 'infra/contracts'), { recursive: true })
  writeFileSync(
    join(fixtureRoot, 'infra/contracts/published-pair.json'),
    JSON.stringify(contract),
  )

  return fixtureRoot
}

function cleanup(fixtureRoot) {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

const root = process.cwd()

test('the committed contract is internally consistent', () => {
  /*
   * This is the check that keeps the contract from drifting away from the
   * manifests. It runs offline, so a PR that bumps one app's dependency
   * without recording it fails without needing a token.
   */
  assert.deepEqual(checkContractStructure(root), [])
})

test('the contract keeps the tag object and the commit apart', () => {
  const contract = readJson(root, 'infra/contracts/published-pair.json')

  // `v0.2.0-rc.5` is annotated: its ref points at a tag object, and the commit
  // is the peeled object. Confusing the two records a SHA that built nothing.
  assert.equal(contract.core.annotated, true)
  assert.match(contract.core.tagObject, /^[0-9a-f]{40}$/)
  assert.notEqual(contract.core.tagObject, contract.core.commit)

  // `v0.1.0-beta.35` is lightweight, so it resolves straight to a commit.
  assert.equal(contract.ui.annotated, false)
  assert.equal(contract.ui.tagObject, null)
})

test('rejects a contract whose annotated tag was never peeled', () => {
  /*
   * The structural check catches this without any network: an annotated entry
   * whose commit equals its tag object means the ref was read without peeling,
   * and the recorded SHA built nothing.
   */
  const contract = JSON.parse(JSON.stringify(readJson(root, 'infra/contracts/published-pair.json')))
  contract.core.commit = contract.core.tagObject

  const file = writeFixtureContract(contract)

  try {
    assert.match(checkContractStructure(file).join('\n'), /was not peeled/)
  } finally {
    cleanup(file)
  }
})

test('rejects a moved tag', async () => {
  const contract = JSON.parse(JSON.stringify(readJson(root, 'infra/contracts/published-pair.json')))
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ object: { sha: 'f'.repeat(40), type: 'commit' } }),
  })

  const errors = await checkTagIdentity(contract, fakeFetch)

  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /resolves to f{40}/)
})

test('peels an annotated tag by asking for the tag object', async () => {
  const contract = JSON.parse(JSON.stringify(readJson(root, 'infra/contracts/published-pair.json')))
  const seen = []
  const fakeFetch = async (url) => {
    seen.push(url)

    if (url.includes('/git/tags/')) {
      return {
        ok: true,
        json: async () => ({
          object: {
            sha: url.includes('zeus-ui') ? contract.ui.commit : contract.core.commit,
          },
        }),
      }
    }

    const isUi = url.includes('zeus-ui')

    return {
      ok: true,
      json: async () => ({
        object: isUi
          ? { sha: contract.ui.commit, type: 'commit' }
          : { sha: contract.core.tagObject, type: 'tag' },
      }),
    }
  }

  assert.deepEqual(await checkTagIdentity(contract, fakeFetch), [])
  // The Core tag needed a second request; the UI tag did not.
  assert.equal(seen.filter(url => url.includes('/git/tags/')).length, 1)
})

test('build-info keeps the three identities distinct', () => {
  const info = createBuildInfo({ product: 'ai-workbench' })
  const appCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

  assert.equal(info.schema, 'zeus.ecosystem.build-info/v1')
  assert.equal(info.app.commit, appCommit)
  assert.notEqual(info.core.commit, info.app.commit)
  assert.notEqual(info.ui.commit, info.app.commit)
  assert.notEqual(info.core.commit, info.ui.commit)
  assert.equal(info.synthetic, undefined)
})

test('build-info records the lockfile digest', () => {
  const info = createBuildInfo({ product: 'ai-workbench' })

  assert.match(info.lockfileSha256, /^[0-9a-f]{64}$/)
  assert.equal(info.lockfileSha256, lockfileSha256(root))
})

test('build-info fails closed without a contract', () => {
  assert.throws(
    () => createBuildInfo({ product: 'ai-workbench', contract: null }),
    /refusing to produce a release artifact/,
  )
})

test('a synthetic record is marked, and visibly substituted', () => {
  /*
   * The fallback exists for local runs. What makes it safe is that it cannot be
   * mistaken for release evidence: it is flagged, and all three identities
   * collapse to the same value, which no real pair ever does.
   */
  const info = createBuildInfo({ product: 'ai-workbench', contract: null, allowSynthetic: true })

  assert.equal(info.synthetic, true)
  assert.ok(info.syntheticReasons.length > 0)
  assert.equal(info.core.commit, info.app.commit)
  assert.equal(info.ui.commit, info.app.commit)
})

test('rejects an unknown product', () => {
  assert.throws(() => createBuildInfo({ product: 'nope' }), /unknown product/)
})
  /*
   * Compares against the contract rather than a literal list. The literal went
   * stale when `playground` was registered, and the same staleness in
   * `build-info.mjs` is what failed that image build at its evidence step.
   */
  test('knows exactly the products the contract declares', () => {
    const declaration = JSON.parse(
      readFileSync(join(root, 'infra/contracts/products.json'), 'utf8'),
    )
    const declared = declaration.products
      .map(product => product.productId)
      .sort()

    assert.deepEqual(Object.keys(PRODUCTS).sort(), declared)
    assert.ok(
      declared.length >= 4,
      `expected at least four products, found ${declared.length}`,
    )
  })

test('the recorded contract matches what is installed', () => {
  const contract = readContract(root)
  const manifest = readJson(root, 'apps/ai-workbench/package.json')

  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (name.startsWith('@zeus-web/')) assert.equal(version, contract.ui.version, name)
    if (name.startsWith('@zeus-js/')) {
      assert.equal(version, contract.independent[name] ?? contract.core.version, name)
    }
  }
})
