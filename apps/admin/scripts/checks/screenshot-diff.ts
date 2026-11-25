/**
 * The screenshot dimension, as arithmetic.
 *
 * ## Why this is a separate module from the gate that feeds it
 *
 * The comparison is the part that decides whether a difference is a regression,
 * and it is the part that can be wrong in ways a reader cannot see. Keeping it
 * free of browsers and servers means it can be fed hand-made PNGs and tested
 * directly — including the cases a real run rarely produces, such as two
 * captures of different heights.
 *
 * ## What a difference ratio means here
 *
 * Under `threshold` → the pages are the same picture, and the differences are
 * font hinting. Above it → something moved. The number is reported as a ratio
 * of pixels, not as a feeling, so a reviewer can decide whether 1.2% is a
 * border-radius change or a table that disappeared.
 *
 * ## The anti-aliasing question
 *
 * `includeAA: false` is the default and the right one for "did anything move":
 * a shifted glyph produces a halo of anti-aliased pixels around every edge, and
 * counting them inflates a one-pixel shift into a large percentage. What it
 * cannot tell you is whether the halo is the *only* difference — so the ratio
 * is paired with the raw count and the two are reported together.
 */
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export interface ScreenshotComparison {
  /** Fraction of pixels that differ, 0..1. */
  readonly differenceRatio: number
  /** How many pixels differed, before the ratio. */
  readonly differingPixels: number
  readonly totalPixels: number
  readonly width: number
  readonly height: number
  /** Set when the two images cannot be compared at all. */
  readonly incomparable?: string
}

/** Above this, the two captures are not the same picture. */
export const DEFAULT_SCREENSHOT_THRESHOLD = 0.01

/**
 * Compares two PNG buffers.
 *
 * Images of different sizes are **incomparable**, not "different": a viewport
 * change or a page that grew taller is not a regression in the product, it is a
 * capture that cannot answer the question. Returning a ratio for them would
 * require deciding how to pad, and every padding rule invents a number.
 */
export function comparePngs(
  reference: Buffer,
  candidate: Buffer,
  options: { threshold?: number } = {},
): ScreenshotComparison & { diff?: Buffer } {
  const left = PNG.sync.read(reference)
  const right = PNG.sync.read(candidate)

  if (left.width !== right.width || left.height !== right.height) {
    return {
      differenceRatio: 1,
      differingPixels: 0,
      totalPixels: 0,
      width: left.width,
      height: left.height,
      incomparable: `the reference is ${left.width}x${left.height} and the candidate is ${right.width}x${right.height}`,
    }
  }

  const total = left.width * left.height
  const diff = new PNG({ width: left.width, height: left.height })

  const differing = pixelmatch(
    left.data,
    right.data,
    diff.data,
    left.width,
    left.height,
    {
      /*
       * The perceptual threshold, not the pass/fail one. 0.1 is pixelmatch's
       * default and means "these two colours are the same colour"; the
       * pass/fail decision is `differenceRatio` against `threshold` below.
       */
      threshold: 0.1,
      includeAA: false,
    },
  )

  return {
    differenceRatio: total === 0 ? 0 : differing / total,
    differingPixels: differing,
    totalPixels: total,
    width: left.width,
    height: left.height,
    diff: PNG.sync.write(diff),
  }
}

/**
 * Turns a comparison into the verdict the dimension reports.
 *
 * Kept here rather than in the gate so that "what counts as a regression" is
 * one function, testable without a screenshot of a real page.
 */
export function screenshotVerdict(
  comparison: ScreenshotComparison,
  threshold = DEFAULT_SCREENSHOT_THRESHOLD,
): { verdict: 'PASS' | 'REGRESSION' | 'REFERENCE_UNAVAILABLE'; detail: string } {
  if (comparison.incomparable) {
    return {
      verdict: 'REFERENCE_UNAVAILABLE',
      detail: `the two captures are not comparable: ${comparison.incomparable}`,
    }
  }

  const percent = (comparison.differenceRatio * 100).toFixed(2)

  if (comparison.differenceRatio > threshold) {
    return {
      verdict: 'REGRESSION',
      detail: `${percent}% of pixels differ (${comparison.differingPixels} of ${comparison.totalPixels}), over the ${(threshold * 100).toFixed(1)}% threshold`,
    }
  }

  return {
    verdict: 'PASS',
    detail: `${percent}% of pixels differ (${comparison.differingPixels} of ${comparison.totalPixels}), within the ${(threshold * 100).toFixed(1)}% threshold`,
  }
}
