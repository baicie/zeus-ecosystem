import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'

import {
  DEFAULT_SCREENSHOT_THRESHOLD,
  comparePngs,
  screenshotVerdict,
} from './screenshot-diff'

/**
 * Hand-made PNGs, because the cases that matter are the ones a real run rarely
 * produces: an identical pair, a one-block change, and two captures whose sizes
 * do not agree.
 */
function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Buffer {
  const image = new PNG({ width, height })

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      const [r, g, b] = paint(x, y)

      image.data[index] = r
      image.data[index + 1] = g
      image.data[index + 2] = b
      image.data[index + 3] = 255
    }
  }

  return PNG.sync.write(image)
}

const white = png(20, 20, () => [255, 255, 255])

describe('comparing two captures', () => {
  it('reports identical images as no difference at all', () => {
    const result = comparePngs(white, white)

    expect(result.differenceRatio).toBe(0)
    expect(result.differingPixels).toBe(0)
    expect(result.totalPixels).toBe(400)
  })

  it('counts a changed region against the whole image', () => {
    /*
     * A 5x5 block of 20x20 is 25 of 400 pixels — 6.25%. Stated as a number
     * rather than as "changed", so a reviewer can tell a moved badge from a
     * missing table.
     */
    const changed = png(20, 20, (x, y) =>
      x < 5 && y < 5 ? [0, 0, 0] : [255, 255, 255],
    )
    const result = comparePngs(white, changed)

    expect(result.differingPixels).toBe(25)
    expect(result.differenceRatio).toBeCloseTo(0.0625, 4)
  })

  it('refuses to compare captures of different sizes instead of inventing a ratio', () => {
    /*
     * This is the failure mode that would otherwise be reported as a total
     * mismatch: a page that grew taller is not a regression, and padding one
     * image to the other's size would produce a number that describes the
     * padding.
     */
    const taller = png(20, 24, () => [255, 255, 255])
    const result = comparePngs(white, taller)

    expect(result.incomparable).toMatch(/20x20.*20x24/)
    expect(screenshotVerdict(result).verdict).toBe('REFERENCE_UNAVAILABLE')
  })

  it('reports no difference when the images differ only below the perceptual threshold', () => {
    /*
     * One step off in each channel is what a re-encode produces. Counting it
     * would make every run red for a reason nobody can act on.
     */
    const almost = png(20, 20, () => [254, 254, 254])

    expect(comparePngs(white, almost).differenceRatio).toBe(0)
  })
})

describe('the verdict', () => {
  it('passes an exact match', () => {
    const verdict = screenshotVerdict(comparePngs(white, white))

    expect(verdict.verdict).toBe('PASS')
    expect(verdict.detail).toMatch(/within the 1\.0% threshold/)
  })

  it('fails a difference over the threshold, and says by how much', () => {
    const changed = png(20, 20, (x, y) => (y < 10 ? [0, 0, 0] : [255, 255, 255]))
    const verdict = screenshotVerdict(comparePngs(white, changed))

    expect(verdict.verdict).toBe('REGRESSION')
    expect(verdict.detail).toMatch(/50\.00%/)
  })

  it('takes the threshold as an argument rather than baking it in', () => {
    /*
     * A page with a live clock or an animation offset needs a wider threshold
     * than a static one, and the difference between "this page tolerates 3%"
     * and "the gate is loose" is whether the number is written down per page.
     */
    const changed = png(20, 20, (x, y) => (x < 2 && y < 2 ? [0, 0, 0] : [255, 255, 255]))
    const comparison = comparePngs(white, changed)

    expect(screenshotVerdict(comparison, 0.001).verdict).toBe('REGRESSION')
    expect(screenshotVerdict(comparison, 0.05).verdict).toBe('PASS')
  })

  it('defaults to one percent', () => {
    expect(DEFAULT_SCREENSHOT_THRESHOLD).toBe(0.01)
  })
})
