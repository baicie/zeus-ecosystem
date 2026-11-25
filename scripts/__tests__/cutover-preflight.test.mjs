import assert from 'node:assert/strict'
import { test } from 'node:test'

import { overallPreflight, prerequisite } from '../release/cutover-preflight.mjs'

test('an empty prerequisite list is not READY', () => {
  /*
   * The same defect this repository has produced twice: `[].every(...)` is
   * true, so a check that ran nothing reports success. A preflight with no
   * prerequisites has read nothing.
   */
  assert.equal(overallPreflight([]), 'INCOMPLETE')
})

test('requires every prerequisite MET, not merely none UNMET', () => {
  /*
   * This is the distinction the whole script exists for. A cutover whose
   * backup requirement nobody could answer is a cutover without a rollback,
   * and "nobody said it was missing" is not the same as "it is there".
   */
  assert.equal(
    overallPreflight([
      prerequisite('a', 'MET', ''),
      prerequisite('b', 'UNKNOWN', ''),
    ]),
    'INCOMPLETE',
  )
})

test('an UNMET prerequisite outranks UNKNOWN', () => {
  /*
   * Different actions: UNMET means change something here, UNKNOWN means find
   * out from somewhere else. Reporting the second when the first is true sends
   * the reader looking in the wrong place.
   */
  assert.equal(
    overallPreflight([
      prerequisite('a', 'UNKNOWN', ''),
      prerequisite('b', 'UNMET', ''),
    ]),
    'NOT_READY',
  )
})

test('is READY only when everything is MET', () => {
  assert.equal(
    overallPreflight([
      prerequisite('a', 'MET', ''),
      prerequisite('b', 'MET', ''),
    ]),
    'READY',
  )
})

test('a prerequisite carries an id, a status and a reason', () => {
  const record = prerequisite('images-with-digests', 'UNMET', '0/1 image(s) have a digest', ['admin'])

  assert.equal(record.id, 'images-with-digests')
  assert.equal(record.status, 'UNMET')
  assert.match(record.detail, /digest/)
  assert.deepEqual(record.evidence, ['admin'])
})

test('omits evidence when there is none rather than writing undefined', () => {
  /*
   * `{ evidence: undefined }` survives into JSON as an absent key but into a
   * `deepEqual` as a present one, and the two disagreeing is how a test passes
   * locally and a consumer of the document sees a key it did not expect.
   */
  assert.equal('evidence' in prerequisite('a', 'MET', ''), false)
})
