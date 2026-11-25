/**
 * Page-level permissions, proven in a browser.
 *
 * ## What the unit tests cannot answer
 *
 * `permissions.test.ts` pins the capability table to the server's
 * `requireRole` call sites, and `permission-contract.test.ts` reads both sides
 * so the two cannot drift. Both are static: they say what the code decides, not
 * what a person sees. The three claims below need a rendered page and a real
 * server:
 *
 *   1. a viewer's workspace controls are disabled, and say why
 *   2. a viewer's own language and theme still work
 *   3. the server refuses the write a disabled control would have sent
 *
 * The third is the one that matters. A disabled button is a courtesy; the
 * boundary is the 403, and a gate that only checked the button would pass a
 * product whose API was open.
 *
 * ## Why this is not folded into `check-admin-browser.ts`
 *
 * That gate answers "can a person use the product" and runs 14 scenarios in
 * three engines. This one is narrower and its assertions are about a
 * distinction — workspace settings versus personal preferences — that is easy
 * to regress and easy to fake. Keeping it separate means a failure names the
 * permission model rather than a browser scenario.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { chromium, type Browser, type Page } from '@playwright/test'

import { ADMIN, VIEWER, freePort, startAdminServer, type AdminServer } from './support/server'

const APP = path.resolve(import.meta.dirname, '../..')
const ARTIFACTS = path.join(APP, 'temp/admin-permissions')

interface Result {
  readonly check: string
  readonly passed: boolean
  readonly detail: string
}

const results: Result[] = []

function record(check: string, passed: boolean, detail: string): void {
  results.push({ check, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${check} — ${detail}`)
}

async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(account.email)
  await page.getByLabel(/password/i).fill(account.password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.getByRole('navigation').first().waitFor({ timeout: 30_000 })
}

/**
 * The three claims, as one pass over a viewer's session.
 *
 * The checks are ordered so that a failure in the first does not hide the
 * others: navigation, then the page controls, then the API.
 */
async function checkViewer(page: Page, server: AdminServer): Promise<void> {
  await signIn(page, VIEWER)
  await page.goto('/admin/settings')
  await page.getByRole('heading', { name: /settings/i }).first().waitFor({ timeout: 20_000 })

  /*
   * 1. The workspace controls are disabled.
   *
   * `isDisabled()` asks the accessibility tree, which is what a screen reader
   * and an assistive technology obey. Checking the `disabled` attribute would
   * pass for a control that is styled to look disabled and still clickable;
   * Playwright's own click refuses a disabled element for the same reason.
   */
  const workspaceName = page.locator('#workspace-name')
  const save = page.getByRole('button', { name: /save settings/i }).first()

  await workspaceName.waitFor({ timeout: 15_000 })

  const nameDisabled = await workspaceName.isDisabled()
  const saveDisabled = await save.isDisabled()

  record(
    'a viewer cannot edit the workspace name',
    nameDisabled,
    nameDisabled ? 'the input is disabled in the accessibility tree' : 'the input accepts text',
  )
  record(
    'a viewer cannot press save',
    saveDisabled,
    saveDisabled ? 'the submit button is disabled' : 'the submit button is enabled',
  )

  /*
   * The hint has to say why. A disabled control with no explanation is a
   * product that looks broken rather than one that is refusing.
   */
  const hint = await page.locator('.field-hint').first().innerText()

  record(
    'the disabled control explains itself',
    /administrator/i.test(hint),
    `hint: ${hint.slice(0, 120)}`,
  )

  /*
   * 2. Personal preferences still work.
   *
   * This is the half that a blunt fix ("hide settings from viewers") would
   * break, and it is the reason the capability table splits the page rather
   * than gating it whole.
   */
  const personalLocale = page.locator('#personal-locale')

  record(
    'a viewer may still choose their own language',
    await personalLocale.isEnabled(),
    'the personal language select is enabled',
  )

  await personalLocale.selectOption('en')

  const htmlLang = await page.locator('html').getAttribute('lang')

  record(
    'choosing a language changes the rendered document',
    htmlLang === 'en',
    `<html lang> is ${htmlLang ?? 'absent'}`,
  )

  /*
   * The workspace selects are a different thing from the personal one, and
   * disabling only the name field would leave two controls that fail on save.
   */
  const workspaceLocale = page.locator('#workspace-locale')
  const workspaceTheme = page.locator('#workspace-theme')

  record(
    'the workspace language is disabled as well, not just the name',
    await workspaceLocale.isDisabled(),
    'the workspace language select follows the same capability',
  )
  record(
    'the workspace theme is disabled',
    await workspaceTheme.isDisabled(),
    'the workspace theme select follows the same capability',
  )

  /*
   * 3. The server refuses the write the disabled control would have sent.
   *
   * Issued from the page, with the page's own cookies and CSRF token, so this
   * exercises the boundary a real client crosses — not a hand-built request
   * that skips the middleware the browser would go through.
   */
  const response = await page.evaluate(async () => {
    const cookie = document.cookie
      .split(';')
      .map(pair => pair.trim())
      .find(pair => pair.startsWith('zeus_admin_csrf='))

    const token = cookie ? decodeURIComponent(cookie.split('=')[1]) : ''

    const answer = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ workspaceName: 'a viewer tried this' }),
    })

    return { status: answer.status, body: (await answer.text()).slice(0, 160) }
  })

  record(
    'the server refuses a viewer writing the workspace',
    response.status === 403,
    `PATCH /api/settings answered ${response.status}`,
  )

  if (response.status === 403 && !/ZEUS_ADMIN_FORBIDDEN/.test(response.body)) {
    /*
     * A 403 for the wrong reason is not the check passing. A CSRF rejection is
     * also 403, and it would mean the boundary was never reached.
     */
    record(
      'the refusal is the role check, not CSRF',
      false,
      `body: ${response.body}`,
    )
  } else if (response.status === 403) {
    record('the refusal is the role check, not CSRF', true, 'body names ZEUS_ADMIN_FORBIDDEN')
  }

  /*
   * 4. The pages a viewer may not enter do not render their content.
   *
   * The router throws a 403 `Response` from a loader, and the error page is
   * what a user sees. Asserting the error page rather than the absence of the
   * page's heading is the stronger claim: it distinguishes "refused" from
   * "failed to load".
   */
  for (const [id, label] of [
    ['audit', 'audit log'],
    ['upload', 'upload'],
    ['roles', 'roles'],
  ] as const) {
    await page.goto(`/admin/${id}`)

    const error = page.getByTestId('route-error')

    await error.waitFor({ timeout: 20_000 }).catch(() => {})

    const shown = (await error.count()) > 0
    const status = shown ? await page.getByTestId('error-status').innerText() : 'no error page'

    record(
      `a viewer cannot enter the ${label} page`,
      shown && status.includes('403'),
      shown ? `the error page reports ${status}` : 'the page rendered without an error',
    )
  }

  /*
   * The navigation must not offer what the routes refuse. The first navigation
   * region is the sidebar.
   */
  const links = await page.getByRole('navigation').first().getByRole('link').allInnerTexts()
  const offered = links.filter(text => /audit|upload|roles/i.test(text))

  record(
    "a viewer's navigation does not offer the pages it refuses",
    offered.length === 0,
    offered.length === 0 ? `${links.length} links, none administrator-only` : `offered: ${offered.join(', ')}`,
  )
}

/**
 * The administrator's side of the same page.
 *
 * Without this, a product that disabled the controls for everyone would pass
 * every check above — the classic way a permission fix breaks the feature it
 * was protecting.
 */
async function checkAdminStillWorks(page: Page): Promise<void> {
  await signIn(page, ADMIN)
  await page.goto('/admin/settings')
  await page.getByRole('heading', { name: /settings/i }).first().waitFor({ timeout: 20_000 })

  const workspaceName = page.locator('#workspace-name')
  const save = page.getByRole('button', { name: /save settings/i }).first()

  await workspaceName.waitFor({ timeout: 15_000 })

  record(
    'an administrator can still edit the workspace name',
    await workspaceName.isEnabled(),
    'the input is enabled for an administrator',
  )
  record(
    'an administrator can still save',
    await save.isEnabled(),
    'the submit button is enabled for an administrator',
  )

  /*
   * And the save actually reaches the server.
   *
   * Enabling a control that silently does nothing is the other half of the
   * same failure, and the page's own "Settings saved" message is not proof: it
   * is rendered by the same code that would fail to send the request. The
   * assertion therefore reads the value back from the API, in the page, with
   * the page's own session.
   */
  const wanted = 'Zeus Admin (permission check)'

  await workspaceName.fill(wanted)
  await save.click()

  const status = page.getByTestId('settings-status')

  await status.waitFor({ timeout: 20_000 })

  const readBack = await page.evaluate(async () => {
    const answer = await fetch('/api/settings')
    const body = (await answer.json()) as { settings?: { workspaceName?: string } }

    return body.settings?.workspaceName ?? null
  })

  record(
    'an administrator save reaches the server',
    readBack === wanted,
    `the API returns ${JSON.stringify(readBack)}, the page said it saved ${JSON.stringify(wanted)}`,
  )

  /* Put it back, so a later run against the same database sees the default. */
  await workspaceName.fill('Zeus Admin')
  await save.click()
  await page.waitForTimeout(800)
}

async function main(): Promise<void> {
  fs.mkdirSync(ARTIFACTS, { recursive: true })

  if (!process.env.ZEUS_ADMIN_SKIP_BUILD) {
    const { execFileSync } = await import('node:child_process')

    execFileSync('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], { cwd: APP, stdio: 'inherit' })
  }

  const server = await startAdminServer({
    adminDir: APP,
    port: await freePort(4900),
    staticDir: path.join(APP, 'dist'),
  })

  let browser: Browser | undefined

  try {
    browser = await chromium.launch()

    const viewerContext = await browser.newContext({
      baseURL: server.origin,
      viewport: { width: 1440, height: 900 },
      /* The assertions are on English labels, so the language is pinned. */
      locale: 'en-US',
      timezoneId: 'UTC',
    })
    const viewerPage = await viewerContext.newPage()

    try {
      await checkViewer(viewerPage, server)
    } finally {
      await viewerPage.screenshot({ path: path.join(ARTIFACTS, 'viewer-settings.png'), fullPage: true }).catch(() => {})
      await viewerContext.close()
    }

    const adminContext = await browser.newContext({
      baseURL: server.origin,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
    })
    const adminPage = await adminContext.newPage()

    try {
      await checkAdminStillWorks(adminPage)
    } finally {
      await adminPage.screenshot({ path: path.join(ARTIFACTS, 'admin-settings.png'), fullPage: true }).catch(() => {})
      await adminContext.close()
    }
  } finally {
    await browser?.close()
    await server.stop()
  }

  const passed = results.filter(entry => entry.passed).length
  const report = {
    schema: 'zeus.ecosystem.admin-permissions/v1',
    startedAt: new Date().toISOString(),
    engine: 'chromium',
    results,
    passed: results.length > 0 && results.every(entry => entry.passed),
  }

  fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n${passed}/${results.length} permission checks`)
  console.log(`report: ${path.join(ARTIFACTS, 'report.json')}`)

  /*
   * An empty result set is a failure, not a pass — the same defect that made an
   * unavailable engine produce a green gate.
   */
  if (results.length === 0) {
    console.error('no permission check ran')
    process.exit(1)
  }

  if (!report.passed) process.exit(1)
}

await main()
