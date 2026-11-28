/**
 * A `expect(...)` shim for the deployment tests, on top of `node:assert`.
 *
 * ## Why a shim rather than a rewrite of the assertions
 *
 * These specs were written against vitest. The obvious port is to rewrite
 * every `expect(x).toBe(y)` into `assert.equal(x, y)` — and the first attempt
 * did that mechanically, which turned
 *
 *     expect(() => verifyLayoutDigest(file, other)).not.toThrow()
 *
 * into `assert.throws(...).not.toThrow()`: a passing assertion inverted into
 * one that cannot fail. Mechanical rewriting of assertions is how a test
 * suite keeps its shape while losing its meaning.
 *
 * So the assertion text is untouched and the vocabulary is provided instead.
 * Every matcher below maps to one `node:assert` call, and the ones that are
 * easy to get subtly wrong (negation, throws) are implemented once, here,
 * where they are visible.
 */
import assert from 'node:assert/strict'

class Expectation {
  constructor(actual, negated = false) {
    this.actual = actual
    this.negated = negated
  }

  get not() {
    return new Expectation(this.actual, !this.negated)
  }

  /* Resolves a value or the thrown error, depending on the matcher. */
  #outcome() {
    if (typeof this.actual !== 'function') {
      return { ok: true, value: this.actual }
    }
    try {
      return { ok: true, value: this.actual() }
    } catch (error) {
      return { ok: false, error }
    }
  }

  toBe(expected) {
    if (this.negated) assert.notEqual(this.actual, expected)
    else assert.equal(this.actual, expected)
  }

  /*
   * Strict, not loose.
   *
   * vitest's `toEqual` ignores `undefined`-valued keys but not the presence of
   * extra defined keys; `assert.deepEqual` is looser than that and let a
   * returned object carry an unexpected `ZEUS_ADMIN_HOST` through a test whose
   * whole point was the exact shape. `deepStrictEqual` is the closer match and
   * fails in the direction a test should fail.
   */
  toEqual(expected) {
    if (this.negated) assert.notDeepStrictEqual(this.actual, expected)
    else assert.deepStrictEqual(this.actual, expected)
  }

  toMatchObject(expected) {
    /* Subset semantics: every key in `expected` must match, extras may exist. */
    for (const [key, value] of Object.entries(expected)) {
      assert.deepStrictEqual(this.actual?.[key], value, `key ${key}`)
    }
  }

  toContain(expected) {
    const includes = this.actual?.includes?.(expected)
    if (this.negated) assert.ok(!includes, `expected ${String(this.actual)} not to contain ${String(expected)}`)
    else assert.ok(includes, `expected ${String(this.actual)} to contain ${String(expected)}`)
  }

  toHaveLength(expected) {
    const length = this.actual?.length
    if (this.negated) assert.notEqual(length, expected)
    else assert.equal(length, expected)
  }

  toBeInstanceOf(expected) {
    if (this.negated) assert.ok(!(this.actual instanceof expected))
    else assert.ok(this.actual instanceof expected)
  }

  toMatch(expected) {
    if (this.negated) assert.doesNotMatch(this.actual, expected)
    else assert.match(this.actual, expected)
  }

  /*
   * `toThrow` has to call the function itself. When the subject is not a
   * function vitest treats it as a thrown value, and a spec that passes a
   * value rather than a thunk would otherwise report "did not throw" for the
   * wrong reason.
   */
  toThrow(expected) {
    const { ok, error } = this.#outcome()
    if (this.negated) {
      assert.ok(ok, `expected not to throw, got ${String(error)}`)
      return
    }
    assert.ok(!ok, 'expected the function to throw')
    if (expected === undefined) return
    if (expected instanceof RegExp) assert.match(String(error?.message ?? error), expected)
    else if (typeof expected === 'string') {
      assert.ok(
        String(error?.message ?? error).includes(expected),
        `expected the error message to include ${JSON.stringify(expected)}, got ${JSON.stringify(String(error?.message ?? error))}`,
      )
    } else if (typeof expected === 'function') {
      assert.ok(error instanceof expected, `expected ${expected.name}, got ${error?.constructor?.name}`)
    }
  }
}

export function expect(actual) {
  return new Expectation(actual)
}
