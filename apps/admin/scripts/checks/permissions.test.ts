import { describe, expect, it } from 'vitest'

import { canEnterRoute, capabilitiesFor } from '../../src/permissions'

/**
 * The permission model has to agree with the server, and the server is the
 * authority. These cases pin the two properties that agreement rests on:
 * nothing a viewer cannot do is offered, and nothing a viewer can do is hidden.
 */
describe('capabilities', () => {
  it('gives an administrator every capability', () => {
    const admin = capabilitiesFor('admin')

    expect(Object.values(admin).every(Boolean)).toBe(true)
  })

  it('gives a viewer their own preferences and nothing else', () => {
    /*
     * The split that motivated the module: a viewer may change their language
     * and theme — those are stored per account — and may not change the
     * workspace name, which every member sees.
     */
    const viewer = capabilitiesFor('viewer')

    expect(viewer.manageOwnPreferences).toBe(true)
    expect(viewer.manageWorkspace).toBe(false)
    expect(viewer.manageUsers).toBe(false)
    expect(viewer.viewAudit).toBe(false)
    expect(viewer.uploadFiles).toBe(false)
    expect(viewer.manageRoles).toBe(false)
  })
})

describe('route entry', () => {
  it('lets a viewer into the pages the server allows them', () => {
    /* Settings reads `/api/settings`, which every role may read. */
    expect(canEnterRoute('viewer', 'settings')).toBe(true)
    expect(canEnterRoute('viewer', 'overview')).toBe(true)
    expect(canEnterRoute('viewer', 'users')).toBe(true)
  })

  it('refuses a viewer the pages that read an administrator endpoint', () => {
    expect(canEnterRoute('viewer', 'audit')).toBe(false)
    expect(canEnterRoute('viewer', 'upload')).toBe(false)
    expect(canEnterRoute('viewer', 'roles')).toBe(false)
  })

  it('lets an administrator into all of them', () => {
    for (const id of ['settings', 'overview', 'users', 'audit', 'upload', 'roles', 'reports']) {
      expect(canEnterRoute('admin', id), id).toBe(true)
    }
  })

  it('records that reports has no server check of its own', () => {
    /*
     * `reports` is administrator-only in the router and reads no endpoint of
     * its own — it composes the user and summary queries, both of which a
     * viewer may call. The restriction is therefore a product rule, not a
     * security boundary, and this case exists so nobody mistakes it for one.
     */
    expect(canEnterRoute('viewer', 'reports')).toBe(false)
    expect(canEnterRoute('admin', 'reports')).toBe(true)
  })
})
