import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inspectDigest, verifyPlan } from '../release/verify-plan-digests.mjs'

const digest = n => `ghcr.io/baicie/x@sha256:${String(n).repeat(64)}`

function plan(overrides = {}) {
  return {
    schema: 'zeus.ecosystem.deployment-plan/v1',
    services: [
      { product: 'ai-host', targetImage: digest(1), previousImage: digest(2) },
      { product: 'ai-workbench', targetImage: digest(3), previousImage: digest(4) },
    ],
    ...overrides,
  }
}

test('a document that is not a plan is refused', () => {
  // Verifying something else's schema would report "digests verified" about a
  // document that has no digests at all.
  assert.throws(() => verifyPlan({ schema: 'something-else' }), /deployment-plan\/v1/)
  assert.throws(() => verifyPlan(null), /deployment-plan\/v1/)
})

test('a malformed image reference is reported, not thrown', () => {
  // One bad argument must not abort the other services' checks.
  const result = inspectDigest('not-a-digest')

  assert.equal(result.found, false)
  assert.match(result.reason, /does not parse/)
})

test('an image absent from the daemon reports why', () => {
  const result = inspectDigest(`ghcr.io/baicie/definitely-not-pushed@sha256:${'a'.repeat(64)}`)

  assert.equal(result.found, false)
  assert.ok(result.reason.length > 0)
})

test('a plan is only verified when both sides of every service resolve', () => {
  /*
   * A target that resolves with a rollback target that does not is a plan with
   * no rollback — the exact thing the digest requirement exists to prevent.
   * This asserts the shape of the verdict rather than the environment's images.
   */
  const { verified, results } = verifyPlan(plan())

  assert.equal(results.length, 2)

  for (const entry of results) {
    assert.ok(entry.target.image.endsWith(`@sha256:${'1'.repeat(64)}`) || entry.target.image.includes('@sha256:'))
    assert.equal(typeof entry.target.found, 'boolean')
    assert.equal(typeof entry.previous.found, 'boolean')
  }

  assert.equal(verified, results.every(entry => entry.target.found && entry.previous.found))
})
