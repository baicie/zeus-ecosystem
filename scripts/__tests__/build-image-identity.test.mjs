/**
 * The one product whose identity lives in an image label rather than a file.
 *
 * `ai-host` ships no `dist`, so `build-info.json` cannot exist for it, and
 * `products.json` declares `buildInfoPath: null` on purpose. Its only identity
 * is `org.opencontainers.image.revision`, set from `ZEUS_APP_COMMIT` in the
 * Dockerfile. Until this predicate existed, `build-image.mjs` copied whatever
 * that label held into the delivery evidence and never compared it to the
 * commit it had just built — an image built from a stale context, or one whose
 * label never got set, produced a record that read as a fact.
 *
 * These assert both directions, because a check that only accepts can be
 * replaced by a constant `undefined` and still pass.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  readProducts,
  revisionMismatch,
  staticTarget,
} from '../release/build-image.mjs'

const COMMIT = 'a'.repeat(40)

test('an image labelled with the commit that built it passes', () => {
  assert.equal(revisionMismatch(COMMIT, COMMIT), undefined)
})

test('an image labelled with another commit fails, and names both', () => {
  const other = 'b'.repeat(40)
  const failure = revisionMismatch(other, COMMIT)

  assert.ok(failure, 'a different revision must not pass')
  assert.match(failure, new RegExp(other))
  assert.match(failure, new RegExp(COMMIT))
})

test('an image with no label at all fails rather than reading as unknown', () => {
  const failure = revisionMismatch(null, COMMIT)

  assert.ok(failure, 'an absent label must not pass')
  assert.match(failure, /no org\.opencontainers\.image\.revision label/)
})

test('an empty label is treated as absent, not as a match', () => {
  assert.ok(revisionMismatch('', COMMIT), 'an empty string is not a revision')
})

test('a short or truncated revision does not pass by prefix', () => {
  assert.ok(revisionMismatch(COMMIT.slice(0, 8), COMMIT), 'a prefix is not the commit')
})

/* --------------------------- where identity lands --------------------------- */

/**
 * The three static products do not share an image layout: `admin` serves
 * `/app/dist`, the two nginx images serve `/usr/share/nginx/html`. The first
 * version of `readImageBuildInfo` hardcoded `/app/dist`, which would have
 * reported two correct images as broken — a check that fails on success is as
 * useless as one that passes on failure.
 */
const byId = () =>
  Object.fromEntries(readProducts(process.cwd()).products.map(p => [p.productId, p]))

test('each static product resolves to the path its Dockerfile copies into', () => {
  const products = byId()

  assert.equal(staticTarget(products['ai-workbench']), '/usr/share/nginx/html')
  assert.equal(staticTarget(products.admin), '/app/dist')
  assert.equal(staticTarget(products.playground), '/usr/share/nginx/html')
})

test('a product with no dist has no static target', () => {
  assert.equal(staticTarget(byId()['ai-host']), undefined)
})
