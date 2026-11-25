import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  decodeIntegritySha512,
  expectedSignerIdentityFor,
  signerWorkflowFor,
  expectedRepository,
  judgePackage,
  readLockedPackages,
  summarise,
  verifyOnePackage,
} from '../release/verify-provenance.mjs'

const lock = `lockfileVersion: '9.0'

importers:
  .: {}

packages:

  '@zeus-js/zeus@0.2.0-rc.5':
    resolution: {integrity: sha512-AAAA}

  '@zeus-js/vite-plugin@0.0.5':
    resolution: {integrity: sha512-BBBB}

  '@zeus-js/vite-plugin@0.0.5(vite@8.3.8)(esbuild@0.28.2)':
    resolution: {}
`

test('reads the version, not the peer suffix', () => {
  /*
   * pnpm writes `@zeus-js/vite-plugin@0.0.5(vite@8.3.8)` for a package whose
   * resolved peers differ. Taking `lastIndexOf('@')` found one inside a peer
   * and produced a package name that was half of the real one, so 31 packages
   * were reported as having no integrity when the lockfile had it.
   */
  const packages = readLockedPackages(lock)

  assert.deepEqual(
    packages.map(entry => `${entry.name}@${entry.version}`).sort(),
    ['@zeus-js/vite-plugin@0.0.5', '@zeus-js/zeus@0.2.0-rc.5'],
  )
})

test('keeps the entry that carries the integrity', () => {
  /*
   * The suffixed key and the plain key are separate entries, and only the plain
   * one has `resolution.integrity`. First-wins dropped the real one.
   */
  const plugin = readLockedPackages(lock).find(entry => entry.name === '@zeus-js/vite-plugin')

  assert.equal(plugin?.integrity, 'sha512-BBBB')
})

test('the signer identity is pinned to a workflow, per package', () => {
  /*
   * `expectedSignerIdentity` lives in the TypeScript module and is covered by
   * `provenance-signer.spec.ts`, which vitest can import. What is asserted here
   * is the data it reads, because this file must run under plain `node --test`
   * alongside the rest of the suite.
   *
   * The distinction matters: keying the expectation by repository alone
   * rejected every independently published package, and keying it by a single
   * hardcoded name rejected every core package. Both were real signatures from
   * real publishes, reported as provenance failures.
   */
  assert.match(
    expectedSignerIdentityFor('baicie/zeus', 'refs/tags/v0.2.0-rc.5', '@zeus-js/zeus'),
    /workflows\/release\.yml/,
  )
  assert.match(
    expectedSignerIdentityFor('baicie/zeus', 'refs/tags/vite-plugin@0.0.5', '@zeus-js/vite-plugin'),
    /workflows\/devtools-release\.yml/,
  )
  assert.match(
    expectedSignerIdentityFor('baicie/zeus-ui', 'refs/tags/v0.1.0-beta.35', '@zeus-web/button'),
    /workflows\/publish\.yml/,
  )
  assert.equal(signerWorkflowFor('unknown-package'), 'publish.yml')
})

test('each package family has its own source repository', () => {
  assert.equal(expectedRepository('@zeus-js/zeus'), 'baicie/zeus')
  assert.equal(expectedRepository('@zeus-web/button'), 'baicie/zeus-ui')
  assert.equal(expectedRepository('something-else'), null)
})

test('a network failure is neither a pass nor a failure', async () => {
  /*
   * The distinction the whole report rests on. A timeout reported as VERIFIED
   * claims a check nobody performed; reported as INVALID it blames the artifact
   * for the connection.
   */
  const result = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '0.0.0', integrity: 'sha512-AAAA' },
    {},
    {
      fetch: async () => { throw new Error('ECONNREFUSED') },
      attestation: {
        attestationUrl: (name, version) => `https://registry.test/${name}@${version}`,
        findSlsaBundle: body => body?.attestations?.[0]?.bundle,
        verifyAttestation: async () => ({ ok: true, attestation: {} }),
      },
    },
  )

  assert.equal(result.verdict, 'NETWORK_ERROR')
  assert.match(result.reason, /ECONNREFUSED/)
})

test('a 404 is MISSING, an unsigned answer is MISSING, a bad signature is INVALID', async () => {
  const notFound = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '0.0.0', integrity: 'sha512-AAAA' },
    {},
    {
      fetch: async () => ({ status: 404, ok: false }),
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: body => body?.attestations?.[0]?.bundle,
        verifyAttestation: async () => ({ ok: true, attestation: {} }),
      },
    },
  )

  assert.equal(notFound.verdict, 'MISSING')

  const empty = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '0.0.0', integrity: 'sha512-AAAA' },
    {},
    {
      fetch: async () => ({ status: 200, ok: true, json: async () => ({ attestations: [] }) }),
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: body => body?.attestations?.[0]?.bundle,
        verifyAttestation: async () => ({ ok: true, attestation: {} }),
      },
    },
  )

  assert.equal(empty.verdict, 'MISSING')

  const forged = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '0.0.0', integrity: 'sha512-AAAA' },
    {},
    {
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }],
        }),
      }),
      verify: async () => ({ ok: false, failure: { detail: 'Sigstore did not verify the signature' } }),
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: body => body?.attestations?.[0]?.bundle,
        verifyAttestation: async () => ({ ok: true, attestation: {} }),
      },
    },
  )

  assert.equal(forged.verdict, 'INVALID')
})

test('a package with no lockfile integrity cannot be bound to bytes', async () => {
  const result = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '1.0.0', integrity: null },
    {},
    {
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: () => undefined,
        verifyAttestation: async () => ({ ok: true, attestation: {} }),
      },
    },
  )

  assert.equal(result.verdict, 'INVALID')
  assert.match(result.reason, /pins no integrity/)
})

test('an attestation naming the wrong repository is INVALID', () => {
  const result = judgePackage(
    { name: '@zeus-js/zeus', version: '1.0.0', integrity: 'sha512-AAAA' },
    { repository: 'basbie/zeus', commit: 'abc', subjectDigest: 'x' },
    {},
  )

  assert.equal(result.verdict, 'INVALID')
  assert.match(result.reason, /basbie\/zeus/)
})

test('an attestation naming a different commit than the build claims is INVALID', () => {
  const result = judgePackage(
    { name: '@zeus-js/zeus', version: '1.0.0', integrity: 'sha512-AAAA' },
    { repository: 'baicie/zeus', commit: 'a'.repeat(40), subjectDigest: 'x' },
    { coreCommit: 'b'.repeat(40) },
  )

  assert.equal(result.verdict, 'INVALID')
  assert.match(result.reason, /build-info claims/)
})

test('an independent package is not compared against the core commit', () => {
  /*
   * vite-plugin is on its own tag line. Comparing its commit to the core's
   * would report a mismatch that is not one.
   */
  const result = judgePackage(
    { name: '@zeus-js/vite-plugin', version: '0.0.6', integrity: 'sha512-AAAA' },
    { repository: 'baicie/zeus', commit: 'a'.repeat(40), subjectDigest: 'x' },
    { coreCommit: 'b'.repeat(40) },
  )

  assert.equal(result.verdict, 'VERIFIED')
})

test('a partial network failure makes the product INCOMPLETE, not PASS', () => {
  const report = summarise('admin', [
    { name: 'a', version: '1', verdict: 'VERIFIED' },
    { name: 'b', version: '1', verdict: 'NETWORK_ERROR' },
  ])

  assert.equal(report.verdict, 'INCOMPLETE')
})

test('one invalid package fails the product even if every other one verified', () => {
  const report = summarise('admin', [
    { name: 'a', version: '1', verdict: 'VERIFIED' },
    { name: 'b', version: '1', verdict: 'INVALID' },
    { name: 'c', version: '1', verdict: 'NETWORK_ERROR' },
  ])

  assert.equal(report.verdict, 'FAIL')
})

test('an empty package list is INCOMPLETE, never PASS', () => {
  /* A report with nothing in it must not read as a clean bill of health. */
  assert.equal(summarise('admin', []).verdict, 'INCOMPLETE')
})

test('decodes the lockfile integrity the verifier wants', () => {
  assert.equal(decodeIntegritySha512('sha512-AAAA'), 'AAAA')
  assert.equal(decodeIntegritySha512('sha1-AAAA'), undefined)
})

test('the CLI path refuses a build that names a commit the attestation does not', async () => {
  /*
   * The defect this pins: `verifyOnePackage` accepted `claims` in its
   * signature and never read it. `judgePackage` did the comparison, and only
   * the tests called it — so editing a build-info's `coreCommit` to a forged
   * value still produced VERIFIED for every package and exit 0, while the
   * module's own documentation promised INVALID.
   *
   * A parameter that is accepted and ignored is worse than one that is
   * missing: the signature says the check exists.
   */
  const result = await verifyOnePackage(
    { name: '@zeus-js/zeus', version: '1.0.0', integrity: 'sha512-AAAA' },
    { coreCommit: 'f'.repeat(40) },
    {
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }],
        }),
      }),
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: () => ({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }),
        verifyAttestation: async () => ({
          ok: true,
          attestation: {
            repository: 'baicie/zeus',
            /* What the registry actually signed — a different commit. */
            commit: 'a'.repeat(40),
            subjectDigest: 'sha512-x',
            signerIdentity: 'id',
            tlogEntries: 1,
          },
        }),
      },
    },
  )

  assert.equal(result.verdict, 'INVALID')
  assert.match(result.reason, /build-info claims/)
})

test('an independent package is not compared against the core commit', async () => {
  /*
   * `vite-plugin` and `devtools-consumer` publish on their own version lines
   * from their own tags. Comparing their commit to the core build's would
   * report a mismatch that is not one, which is the failure the independent
   * list exists to prevent.
   */
  const result = await verifyOnePackage(
    { name: '@zeus-js/vite-plugin', version: '0.0.6', integrity: 'sha512-AAAA' },
    { coreCommit: 'f'.repeat(40) },
    {
      fetch: async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }],
        }),
      }),
      attestation: {
        attestationUrl: () => 'https://registry.test/x',
        findSlsaBundle: () => ({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }),
        verifyAttestation: async () => ({
          ok: true,
          attestation: {
            repository: 'baicie/zeus',
            commit: 'b'.repeat(40),
            subjectDigest: 'sha512-x',
            signerIdentity: 'id',
            tlogEntries: 1,
          },
        }),
      },
    },
  )

  assert.equal(result.verdict, 'VERIFIED')
})
