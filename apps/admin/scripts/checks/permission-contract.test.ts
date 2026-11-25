import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { canEnterRoute, capabilitiesFor } from '../../src/permissions'

/**
 * The front-end capability model must agree with what the server enforces.
 *
 * The client can hide a control; it cannot grant or deny anything. So the two
 * directions that matter are:
 *
 *   - every route the client refuses, the server also refuses to serve
 *   - every capability the client offers, the server does not reject
 *
 * Read from the server's source rather than from a second hand-written list: a
 * table copied by hand is the thing that drifts, and this is the check whose
 * whole job is to notice when it has.
 */
const serverSource = fs.readFileSync(
  path.join(import.meta.dirname, '../../server/api.ts'),
  'utf8',
)

/** Endpoints whose handler calls `requireRole(user, 'admin')`. */
function adminEndpoints(): Set<string> {
  const endpoints = new Set<string>()
  const lines = serverSource.split('\n')
  let current: string | null = null

  for (const line of lines) {
    const match = /url\.pathname === '(\/api\/[a-z/]*)'/.exec(line)

    if (match) current = match[1] ?? null

    if (/requireRole\(user, 'admin'\)/.test(line) && current) {
      endpoints.add(current)
    }
  }

  return endpoints
}

/** Endpoints that call `requireRole(user, 'viewer')` — readable by anyone signed in. */
function viewerEndpoints(): Set<string> {
  const endpoints = new Set<string>()
  const lines = serverSource.split('\n')
  let current: string | null = null

  for (const line of lines) {
    const match = /url\.pathname === '(\/api\/[a-z/]*)'/.exec(line)

    if (match) current = match[1] ?? null

    if (/requireRole\(user, 'viewer'\)/.test(line) && current) {
      endpoints.add(current)
    }
  }

  return endpoints
}

describe('the client and the server agree about administrators', () => {
  it('every admin-only route corresponds to an admin-only endpoint', () => {
    /*
     * `reports` is the known exception and is asserted separately: it reads no
     * endpoint of its own, so there is nothing on this side to match.
     */
    const adminOnlyRoutes: Record<string, string> = {
      upload: '/api/uploads',
      roles: '/api/users',
      audit: '/api/audit',
    }

    const enforced = adminEndpoints()

    for (const [route, endpoint] of Object.entries(adminOnlyRoutes)) {
      expect(canEnterRoute('viewer', route), `${route} should be administrator-only`).toBe(false)
      expect(enforced.has(endpoint), `${endpoint} should require an administrator`).toBe(true)
    }
  })

  it('settings is not an admin-only route, and its read is not admin-only either', () => {
    /*
     * The page holds two kinds of thing, and treating the page as one was the
     * original defect: a viewer could open it, press Save, and get a 403.
     */
    expect(canEnterRoute('viewer', 'settings')).toBe(true)
    expect(viewerEndpoints().has('/api/settings')).toBe(true)
  })

  it('the workspace name is an administrator capability', () => {
    expect(capabilitiesFor('viewer').manageWorkspace).toBe(false)
    expect(capabilitiesFor('admin').manageWorkspace).toBe(true)
    expect(adminEndpoints().has('/api/settings')).toBe(true)
  })

  it('personal preferences are never an administrator capability', () => {
    /*
     * Language and theme are stored per account and written straight to
     * `localStorage`; they must not appear on an admin-guarded endpoint, or a
     * reader would need an administrator to change their own theme.
     */
    expect(capabilitiesFor('viewer').manageOwnPreferences).toBe(true)

    const settingsHandler = serverSource.slice(
      serverSource.indexOf("url.pathname === '/api/settings'"),
      serverSource.indexOf("url.pathname === '/api/settings'") + 2000,
    )

    expect(settingsHandler).not.toMatch(/locale.*requireRole\(user, 'admin'\)/)
  })
})
