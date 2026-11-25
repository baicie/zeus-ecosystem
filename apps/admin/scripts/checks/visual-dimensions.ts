/**
 * The four questions a visual acceptance asks, kept apart.
 *
 * ## Why they were one before
 *
 * The gate compared landmark structure and text overlap together and produced a
 * single verdict. That is enough to notice that something changed and not
 * enough to say what kind of change it was: a page that renders the same
 * structure with different words, a page that lost its table, and a page whose
 * layout shifted by two pixels are three different incidents with three
 * different responses.
 *
 *   Functional   can the scenario still be completed
 *   Structural   does the page still have its landmarks, in the same order
 *   Screenshot   do the pixels still match, within a threshold
 *   Design       is the difference intended — a person's answer, never a script's
 *
 * ## What this module is not
 *
 * It does not run anything. It takes what a run produced and says which of the
 * four questions each result answers, so the report cannot present one as
 * another. `Design` is always `REVIEW_REQUIRED` unless a human wrote otherwise
 * into the baseline.
 */

export type FunctionalParity = 'PASS' | 'FAIL' | 'NOT_RUN'

export interface StructuralParity {
  readonly verdict: 'PASS' | 'REGRESSION' | 'CANDIDATE_ADDED' | 'NOT_RUN'
  readonly detail: string
}

export interface ScreenshotRegression {
  readonly verdict: 'PASS' | 'REGRESSION' | 'REFERENCE_UNAVAILABLE' | 'NOT_RUN'
  /** Fraction of differing pixels, when a comparison ran. */
  readonly differenceRatio?: number
  readonly threshold?: number
  readonly detail: string
}

export interface DesignReview {
  readonly verdict: 'APPROVED' | 'REVIEW_REQUIRED' | 'CHANGES_REQUESTED'
  /** Who approved it. Absent until a person does. */
  readonly reviewer?: string
  readonly detail: string
}

export interface VisualEvidence {
  readonly scenario: string
  readonly functional: FunctionalParity
  readonly structural: StructuralParity
  readonly screenshot: ScreenshotRegression
  readonly design: DesignReview
}

/**
 * Reads the design verdict recorded with the baseline.
 *
 * A baseline that has not been reviewed says `REVIEW_REQUIRED` — the honest
 * state, and the one that keeps a screenshot run from being reported as a
 * design sign-off it never had.
 */
export function designVerdictFrom(approvalStatus: string | undefined): DesignReview {
  if (approvalStatus === 'APPROVED') {
    return { verdict: 'APPROVED', detail: 'the baseline records an approval' }
  }

  if (approvalStatus === 'UNAVAILABLE') {
    return { verdict: 'REVIEW_REQUIRED', detail: 'no reference is available to review against' }
  }

  return {
    verdict: 'REVIEW_REQUIRED',
    detail: 'no reviewer has recorded an opinion on this scenario',
  }
}

/**
 * The scenario's overall status, from the four dimensions.
 *
 * A regression in any of the first three fails the scenario regardless of the
 * others, and an unreviewed design asks for a review rather than failing —
 * otherwise every run would be red until someone signed off, and a signature
 * that is forced is not a review.
 */
export function overallStatus(evidence: VisualEvidence): 'PASS' | 'REGRESSION' | 'REVIEW_REQUIRED' | 'INCOMPLETE' {
  if (evidence.functional === 'FAIL') return 'REGRESSION'
  if (evidence.structural.verdict === 'REGRESSION') return 'REGRESSION'
  if (evidence.screenshot.verdict === 'REGRESSION') return 'REGRESSION'

  if (evidence.functional === 'NOT_RUN') return 'INCOMPLETE'
  if (evidence.structural.verdict === 'NOT_RUN') return 'INCOMPLETE'
  if (evidence.screenshot.verdict === 'NOT_RUN') return 'INCOMPLETE'

  if (evidence.design.verdict === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED'

  return 'PASS'
}
