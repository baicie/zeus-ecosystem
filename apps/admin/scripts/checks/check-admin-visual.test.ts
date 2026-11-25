import { describe, expect, it } from 'vitest'

import { compare } from './check-admin-visual'

/**
 * The classifier is the part that decides whether a difference is a regression,
 * a translation or an improvement — so it is tested directly, without two
 * servers and a browser.
 */
const reference = {
  text: 'Overview\nUsers\nRoles\nAudit log',
  landmarks: ['h1:Overview', 'h2:Summary', 'nav:General', 'table:Users'],
}

describe('visual comparison', () => {
  it('reports identical pages as the same', () => {
    expect(compare(reference, reference).kind).toBe('same')
  })

  it('reports a landmark the candidate lost as critical', () => {
    /*
     * This is the case the gate exists for: a page that still renders but has
     * lost its table is a regression, and it is invisible to a check that only
     * asks whether the page loaded.
     */
    const result = compare(reference, {
      text: reference.text,
      landmarks: ['h1:Overview', 'h2:Summary', 'nav:General'],
    })

    expect(result.kind).toBe('critical')
    expect(result.detail).toMatch(/table/)
  })

  it('does not report an added landmark as a regression', () => {
    /*
     * The roles page gained a capability matrix and an assign form during the
     * migration. A comparison that treats any structural change as a failure
     * would have flagged an improvement as a defect.
     */
    const result = compare(reference, {
      text: reference.text,
      landmarks: [...reference.landmarks, 'form:Add member'],
    })

    expect(result.kind).toBe('CANDIDATE_ADDED')
    expect(result.detail).toMatch(/nothing lost/)
  })

  it('names a translated page rather than calling it a redesign', () => {
    /*
     * The reference image renders Chinese regardless of `navigator.languages`;
     * the current build negotiates and renders English. Same landmarks, almost
     * no shared strings — that is a language difference, and reporting it as
     * "major" buried the question the gate exists to answer.
     */
    const result = compare(reference, {
      text: '概览\n用户\n角色\n审计日志',
      landmarks: reference.landmarks,
    })

    expect(result.kind).toBe('STRUCTURE_MATCHES_TRANSLATED')
    expect(result.detail).toMatch(/different interface language/)
  })

  it('reports a content change on the same structure as major', () => {
    const result = compare(reference, {
      text: 'Overview\nUsers\nRoles\nAudit history',
      landmarks: reference.landmarks,
    })

    expect(result.kind).toBe('major')
    expect(result.detail).toMatch(/Audit log/)
  })

  it('reports a changed landmark order as critical', () => {
    const result = compare(reference, {
      text: reference.text,
      landmarks: ['h1:Overview', 'nav:General', 'h2:Summary', 'table:Users'],
    })

    expect(result.kind).toBe('critical')
    expect(result.detail).toMatch(/shape changed/)
  })

  it('handles an empty page without dividing by zero', () => {
    const empty = { text: '', landmarks: [] }

    expect(compare(empty, empty).kind).toBe('same')
  })
})
