/**
 * What the signed-in role may do, as one place to ask.
 *
 * ## Why a module rather than a check at each use
 *
 * The server is the authority — `requireRole(user, 'admin')` on the endpoints
 * that need it — and nothing here changes that. What this answers is the
 * different question a user asks: *will this button work?* A viewer who can
 * open Settings and press Save gets a 403 from the server and an error message,
 * which is a worse experience than a disabled control that says why.
 *
 * ## Why the split is per capability, not per page
 *
 * Settings holds two kinds of thing: the workspace name, which is an
 * administrator's decision, and the reader's own language and theme, which are
 * theirs. Hiding the whole page would take the second away to protect the
 * first — so the page stays and the controls that will fail are the ones that
 * are disabled.
 *
 * ## The rule that must not be broken
 *
 * Hiding a control is not access control. Every capability here has a matching
 * server check, and this module can only ever make the interface agree with it.
 */

export type AdminRole = 'admin' | 'viewer'

export interface Capabilities {
  /** Create, edit and delete users. */
  readonly manageUsers: boolean
  /** Change the workspace name. */
  readonly manageWorkspace: boolean
  /** Read the audit log. */
  readonly viewAudit: boolean
  /** Upload files. */
  readonly uploadFiles: boolean
  /** Assign roles. */
  readonly manageRoles: boolean
  /** Change one's own language and theme. Always allowed. */
  readonly manageOwnPreferences: boolean
}

/**
 * The capabilities of a role.
 *
 * Mirrors the server's `requireRole` call sites exactly; a capability added
 * here without one there would be a control that looks available and is not.
 */
export function capabilitiesFor(role: AdminRole): Capabilities {
  const admin = role === 'admin'

  return {
    manageUsers: admin,
    manageWorkspace: admin,
    viewAudit: admin,
    uploadFiles: admin,
    manageRoles: admin,
    /* Personal, and stored per account — never an administrator's decision. */
    manageOwnPreferences: true,
  }
}

/**
 * Whether a route may be entered.
 *
 * Settings is absent on purpose: its read is allowed for every role, and its
 * writes are gated per control.
 *
 * `reports` is here because the page has always required an administrator, even
 * though it reads no endpoint of its own — it composes the user and summary
 * queries. That is a front-end rule with no matching server check, which the
 * note below records rather than hides.
 */
export function canEnterRoute(role: AdminRole, id: string): boolean {
  const adminOnly = new Set(['upload', 'roles', 'audit', 'reports'])

  return adminOnly.has(id) ? role === 'admin' : true
}
