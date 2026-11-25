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

describe('the readiness signal does not name a language', () => {
  /*
   * The defect this pins: `ready` waited on headings by English name, and the
   * reference build renders Chinese. Six scenarios timed out, captured anyway,
   * and were reported as unusable — the gate refused the comparison for a
   * reason that was its own.
   *
   * The assertion is on the source of the scenario table, because the failure
   * is a string in a wait call rather than anything a pure function returns.
   * It is a lint with a reason attached: a future scenario that waits on
   * `/foo/i` reintroduces exactly this bug, and it will be invisible until
   * someone runs the gate against a build in another language.
   */
  it('does not wait on English heading text', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('./check-admin-visual.ts', import.meta.url), 'utf8'),
    )

    /* Comments explain the bug and necessarily mention the old pattern. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')

    const textWaits = [...code.matchAll(/getByRole\('heading',\s*\{\s*name:\s*\/[^/]+\/i\s*\}/g)]

    expect(
      textWaits.map(match => match[0]),
      'a readiness wait that matches English heading text cannot be satisfied by a build in another language',
    ).toEqual([])
  })

  it('does not wait on the interface language anywhere in the gate', async () => {
    /*
     * The login helper is the one legitimate place: it must accept either
     * language because the reference renders Chinese and the candidate does
     * not. Everywhere else, a `/email|邮箱/i` style alternation means the
     * harness is guessing at the product's language rather than sidestepping
     * the question.
     */
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('./check-admin-visual.ts', import.meta.url), 'utf8'),
    )

    const signIn = source.slice(source.indexOf('async function signIn'), source.indexOf('async function signIn') + 800)
    const outside = source.replace(signIn, '')

    expect(outside).not.toMatch(/邮箱|密码|登录/)
  })
})
