import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createPlan,
  parseImageAssignment,
  readProducts,
  validatePlan,
} from '../release/deployment-plan.mjs'

const root = process.cwd()
const digest = n => `ghcr.io/baicie/x@sha256:${String(n).repeat(64)}`

function input(overrides = {}) {
  return {
    deploymentUnit: 'ai',
    environment: 'staging',
    targets: [
      { product: 'ai-workbench', image: digest(1) },
      { product: 'ai-host', image: digest(2) },
    ],
    previous: [
      { product: 'ai-workbench', image: digest(3) },
      { product: 'ai-host', image: digest(4) },
    ],
    ...overrides,
  }
}

test('a tag is not a rollback target', () => {
  // A tag can be moved; a digest cannot. Planning a rollback to `:latest` would
  // restore whatever that tag points at later, not what was running before.
  assert.throws(() => parseImageAssignment('ai-host=ghcr.io/baicie/ai-host:latest'), /digest-pinned/)
  assert.throws(() => parseImageAssignment('ai-host=sha256:abc'), /digest-pinned/)
  assert.deepEqual(parseImageAssignment(`ai-host=${digest(2)}`), {
    product: 'ai-host',
    image: digest(2),
  })
})

test('a complete plan is accepted', () => {
  assert.deepEqual(validatePlan(root, input()).errors, [])
})

test('a partial unit is refused', () => {
  /*
   * The workbench proxies to its host. Deploying one without the other leaves
   * a version skew, which is the failure the unit declaration exists for.
   */
  const { errors } = validatePlan(root, input({
    targets: [{ product: 'ai-workbench', image: digest(1) }],
  }))

  assert.match(errors.join('\n'), /ai-host has no target image/)
})

test('a plan with no rollback target is refused', () => {
  const { errors } = validatePlan(root, input({ previous: [] }))

  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /no previous image/)
})

test('a service outside the unit is refused', () => {
  const { errors } = validatePlan(root, input({
    targets: [
      { product: 'ai-workbench', image: digest(1) },
      { product: 'ai-host', image: digest(2) },
      { product: 'admin', image: digest(5) },
    ],
    previous: [
      { product: 'ai-workbench', image: digest(3) },
      { product: 'ai-host', image: digest(4) },
      { product: 'admin', image: digest(6) },
    ],
  }))

  assert.match(errors.join('\n'), /admin is not part of unit "ai"/)
})

test('an unknown product is refused', () => {
  const { errors } = validatePlan(root, input({
    targets: [{ product: 'nope', image: digest(1) }],
  }))

  assert.match(errors.join('\n'), /is not a declared product/)
})

test('production is not planned by this script', () => {
  // The prohibition is in code, not in a comment: there is no path from here
  // to a production change.
  const { errors } = validatePlan(root, input({ environment: 'production' }))

  assert.match(errors.join('\n'), /production plans are not generated/)
})

test('the plan orders services by the declaration, not by argument order', () => {
  const plan = createPlan(root, input({
    // Reversed on purpose: the host must come up before the proxy.
    targets: [
      { product: 'ai-workbench', image: digest(1) },
      { product: 'ai-host', image: digest(2) },
    ],
  }))

  assert.deepEqual(plan.services.map(service => service.product), ['ai-host', 'ai-workbench'])
})

test('the plan is marked unapplied and carries a rollback', () => {
  const plan = createPlan(root, input())

  assert.equal(plan.applied, false)
  assert.equal(plan.rollback.strategy, 'restore-previous-image-set')
  assert.match(plan.rollback.note, /not the database/)
  assert.equal(plan.schema, 'zeus.ecosystem.deployment-plan/v1')
})

test('data compatibility defaults to unverified', () => {
  // A rollback restores binaries. Claiming data compatibility without evidence
  // would be the assumption this field exists to prevent.
  assert.equal(createPlan(root, input()).dataCompatibility, 'unverified')
})

test('the product declarations cover every deployment unit', () => {
  const declaration = readProducts(root)

  for (const [name, unit] of Object.entries(declaration.deploymentUnits)) {
    for (const product of unit.products) {
      assert.ok(
        declaration.products.some(entry => entry.productId === product),
        `${name} names ${product}, which is not declared`,
      )
    }
  }
})
