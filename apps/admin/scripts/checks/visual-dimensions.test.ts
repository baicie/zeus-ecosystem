import { describe, expect, it } from 'vitest'

import {
  designVerdictFrom,
  overallStatus,
  type VisualEvidence,
} from './visual-dimensions'

const base: VisualEvidence = {
  scenario: 'overview',
  functional: 'PASS',
  structural: { verdict: 'PASS', detail: 'same landmarks' },
  screenshot: { verdict: 'PASS', differenceRatio: 0, threshold: 0.01, detail: 'identical' },
  design: { verdict: 'APPROVED', reviewer: 'a person', detail: 'reviewed' },
}

const with_ = (patch: Partial<VisualEvidence>): VisualEvidence => ({ ...base, ...patch })

describe('the four dimensions stay separate', () => {
  it('fails on a structural regression even when the screenshots match', () => {
    /*
     * The case that made the separation necessary: a page can lose its table
     * and still be pixel-similar to a layout that never had one.
     */
    expect(
      overallStatus(with_({ structural: { verdict: 'REGRESSION', detail: 'table gone' } })),
    ).toBe('REGRESSION')
  })

  it('fails on a screenshot regression even when the structure matches', () => {
    expect(
      overallStatus(
        with_({ screenshot: { verdict: 'REGRESSION', differenceRatio: 0.4, threshold: 0.01, detail: 'layout shifted' } }),
      ),
    ).toBe('REGRESSION')
  })

  it('fails on a functional regression even when both comparisons pass', () => {
    /*
     * A scenario that can no longer be completed is a failure whatever the
     * pixels say — a login form that renders perfectly and rejects the right
     * password would pass every comparison and fail the user.
     */
    expect(overallStatus(with_({ functional: 'FAIL' }))).toBe('REGRESSION')
  })

  it('asks for a review rather than failing when nobody has looked', () => {
    /*
     * The distinction that keeps the gate honest. An unreviewed design is not a
     * regression, and it is not a pass either — reporting it as a failure would
     * make every run red until someone signed, and a signature given to clear a
     * red build is not a review.
     */
    expect(
      overallStatus(with_({ design: { verdict: 'REVIEW_REQUIRED', detail: 'unreviewed' } })),
    ).toBe('REVIEW_REQUIRED')
  })

  it('is incomplete, never a pass, when a dimension did not run', () => {
    expect(overallStatus(with_({ functional: 'NOT_RUN' }))).toBe('INCOMPLETE')
    expect(
      overallStatus(with_({ screenshot: { verdict: 'NOT_RUN', detail: 'no browser' } })),
    ).toBe('INCOMPLETE')
  })

  it('is incomplete when the screenshot ran against nothing', () => {
    /*
     * The defect this case was written for: `REFERENCE_UNAVAILABLE` fell
     * through every guard and reached `PASS`. A comparison that had no
     * reference is the clearest possible "no basis", and it was being reported
     * as the strongest possible "no problem".
     */
    expect(
      overallStatus(
        with_({
          screenshot: {
            verdict: 'REFERENCE_UNAVAILABLE',
            detail: 'the reference image is not present',
          },
        }),
      ),
    ).toBe('INCOMPLETE')
  })

  it('passes only when all four agree', () => {
    expect(overallStatus(base)).toBe('PASS')
  })
})

describe('the design verdict comes from a person', () => {
  it('is REVIEW_REQUIRED until the baseline records an approval', () => {
    expect(designVerdictFrom(undefined).verdict).toBe('REVIEW_REQUIRED')
    expect(designVerdictFrom('CANDIDATE').verdict).toBe('REVIEW_REQUIRED')
  })

  it('records an approval only when the baseline carries one', () => {
    const approved = designVerdictFrom('APPROVED')

    expect(approved.verdict).toBe('APPROVED')
  })

  it('treats a missing reference as needing a review, not as approved', () => {
    expect(designVerdictFrom('UNAVAILABLE').verdict).toBe('REVIEW_REQUIRED')
  })

  it('never invents a reviewer', () => {
    /* The script cannot name one; only a baseline written by a person can. */
    expect(designVerdictFrom('APPROVED').reviewer).toBeUndefined()
  })
})

/*
 * Added content explains a pixel difference.
 *
 * `roles` reports `CANDIDATE_ADDED` — a table and a form the reference does not
 * have — and 1.68% pixels different. Nothing was lost; the page grew. Letting
 * the pixel threshold fire on its own reported it as `REGRESSION`, which sends
 * someone to fix a page that is doing what it was asked to.
 */
describe('candidate-added content', () => {
  const added = {
    scenario: 'roles',
    functional: 'PASS' as const,
    structural: {
      verdict: 'CANDIDATE_ADDED' as const,
      detail: 'the candidate has landmarks the reference does not: table, form',
    },
    screenshot: {
      verdict: 'REGRESSION' as const,
      differenceRatio: 0.0168,
      threshold: 0.01,
      detail: '1.68% of pixels differ',
    },
    design: { verdict: 'APPROVED' as const, reviewer: 'someone', detail: '' },
  }

  it('asks for review instead of reporting a regression', () => {
    expect(overallStatus(added)).toBe('REVIEW_REQUIRED')
  })

  it('is still not a pass when the design has not been reviewed', () => {
    expect(
      overallStatus({
        ...added,
        screenshot: { verdict: 'PASS' as const },
        design: { verdict: 'REVIEW_REQUIRED' as const, detail: 'nobody looked' },
      }),
    ).toBe('REVIEW_REQUIRED')
  })

  it('does not weaken the lost-content case', () => {
    // The branch is only for additions. A structural REGRESSION still fails,
    // and a pixel regression with matching structure still fails.
    expect(
      overallStatus({ ...added, structural: { verdict: 'REGRESSION' as const, detail: '' } }),
    ).toBe('REGRESSION')
    expect(
      overallStatus({
        ...added,
        structural: { verdict: 'PASS' as const, detail: '' },
      }),
    ).toBe('REGRESSION')
  })
})
