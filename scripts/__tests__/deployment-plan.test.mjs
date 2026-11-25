import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createPlan,
  parseImageAssignment,
  PLAN_STAGES,
  PLANNED_ENVIRONMENTS,
  readProducts,
  resolveChangeKind,
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

  /*
   * The refusal names the environments that *are* plannable, so the caller
   * learns what to pass rather than only what not to. The prohibition is
   * unchanged; only the wording is more useful.
   */
  assert.match(errors.join('\n'), /not a plannable environment/)
  assert.match(errors.join('\n'), /separate authorization/)
  assert.deepEqual(PLANNED_ENVIRONMENTS, ['staging', 'preview', 'local'])
  assert.ok(!PLANNED_ENVIRONMENTS.includes('production'))
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

/*
 * The checks below exist because each one is a way to produce a plan that looks
 * complete and means something other than what the operator intended.
 */

test('a product named twice is refused rather than silently deduplicated', () => {
  /*
   * `--target ai-host=A --target ai-host=B` used to be absorbed by a Map, and
   * `createPlan` then looked the product up with `find` on the raw array — so
   * the plan could carry a different image than the one validation saw.
   */
  const { errors } = validatePlan(root, input({
    targets: [
      { product: 'ai-workbench', image: digest(1) },
      { product: 'ai-host', image: digest(2) },
      { product: 'ai-host', image: digest(7) },
    ],
  }))

  assert.match(errors.join('\n'), /ai-host appears more than once as a --target/)
})

test('duplicates in previous are refused too', () => {
  const { errors } = validatePlan(root, input({
    previous: [
      { product: 'ai-workbench', image: digest(3) },
      { product: 'ai-host', image: digest(4) },
      { product: 'ai-workbench', image: digest(8) },
    ],
  }))

  assert.match(errors.join('\n'), /ai-workbench appears more than once as a --previous/)
})

test('an all-zero digest is refused as a placeholder', () => {
  /*
   * The rehearsal used to plan against sixty-four zeroes, which records that no
   * image was ever pushed. A digest that cannot exist should not validate.
   */
  assert.throws(
    () => parseImageAssignment(`ai-host=ghcr.io/baicie/ai-host@sha256:${'0'.repeat(64)}`),
    /placeholder/,
  )
})

test('a bare digest without a repository is refused', () => {
  // A digest names content. Two different repositories can hold the same
  // manifest, and a plan that omits the repository does not say which to pull.
  assert.throws(() => parseImageAssignment(`ai-host=sha256:${'a'.repeat(64)}`), /bare digest/)
})

test('an unknown environment is refused', () => {
  const { errors } = validatePlan(root, input({ environment: 'staging ' }))

  assert.match(errors.join('\n'), /not a plannable environment/)
})

test('dataCompatibility may not claim compatibility without evidence', () => {
  /*
   * A rollback restores binaries. Claiming the database survives without
   * evidence is the assumption the field exists to prevent.
   */
  const { errors } = validatePlan(root, input({ dataCompatibility: 'compatible' }))

  assert.match(errors.join('\n'), /needs evidence/)
})

test('a claim of compatibility is accepted when evidence is attached', () => {
  const { errors } = validatePlan(
    root,
    input({ dataCompatibility: 'compatible', evidence: ['rehearsal/report.json'] }),
  )

  assert.deepEqual(errors, [])
})

test('target equal to previous is classified, not silently treated as an upgrade', () => {
  /*
   * A restart is a legitimate operation and an upgrade is not, and a rehearsal
   * of one proves nothing about the other. The plan now says which it is.
   */
  const same = digest(1)
  const plan = createPlan(
    root,
    input({
      targets: [
        { product: 'ai-workbench', image: same },
        { product: 'ai-host', image: digest(2) },
      ],
      previous: [
        { product: 'ai-workbench', image: same },
        { product: 'ai-host', image: digest(4) },
      ],
    }),
  )

  assert.equal(plan.changeKind, 'partial-upgrade')
  assert.deepEqual(plan.rollback.restores, ['ai-host'])
})

test('a plan where nothing changes is a no-op', () => {
  const same = digest(1)
  const everything = [
    { product: 'ai-workbench', image: same },
    { product: 'ai-host', image: same },
  ]

  assert.equal(
    resolveChangeKind(['ai-workbench', 'ai-host'], new Map(everything.map(e => [e.product, e.image])), new Map(everything.map(e => [e.product, e.image]))),
    'no-op',
  )
})

test('an incomplete unit is not classified as a change', () => {
  const { changeKind } = validatePlan(
    root,
    input({ targets: [{ product: 'ai-workbench', image: digest(1) }] }),
  )

  assert.equal(changeKind, 'incomplete')
})

test('the plan records how far it got, and never further', () => {
  /*
   * "A plan exists" and "the image exists" were the same output before. The
   * stages are what keep a well-formed document from reading as a verified one.
   */
  const plan = createPlan(root, input())

  assert.deepEqual(Object.keys(plan.stages), PLAN_STAGES)
  assert.equal(plan.stages['plan-created'], true)
  assert.equal(plan.stages['premises-verified'], true)
  assert.equal(plan.stages['digest-verified'], false)
  assert.equal(plan.stages.rehearsed, false)
  assert.equal(plan.stages.applied, false)
  assert.equal(plan.stages['production-accepted'], false)
})

test('every service in the plan comes from the same view validation checked', () => {
  const plan = createPlan(root, input())

  assert.equal(plan.services.length, 2)

  for (const service of plan.services) {
    assert.match(service.targetImage, /@sha256:[0-9a-f]{64}$/)
    assert.match(service.previousImage, /@sha256:[0-9a-f]{64}$/)
    assert.notEqual(service.targetImage, service.previousImage)
  }
})
