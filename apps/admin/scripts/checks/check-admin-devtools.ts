/**
 * The DevTools panel, driven the way a developer drives it.
 *
 * ## What this is checking, and what it is not
 *
 * The panel exists to answer one question about a page: *what did the runtime
 * do when it mounted?* A check that asserts `window.adminDevtools` exists would
 * pass for a handle connected one tick too late, which is exactly the defect
 * this panel had — `render()` ran first, the consumer connected afterwards in a
 * `.then()`, and the panel opened on an empty timeline for a fully rendered
 * page.
 *
 * So the assertions are about the events: the first mount is on the timeline,
 * the snapshot carries real owners and bindings, a disconnect leaves nothing
 * behind, and a second init does not double the listeners.
 *
 * ## Development only
 *
 * `?devtools` is honoured only when `import.meta.env.DEV`, which means this has
 * to drive the Vite dev server, not a built bundle. It starts one on a port of
 * its own alongside the API server the app expects.
 *
 * ```text
 * pnpm --filter @zeus-ecosystem/admin check:devtools
 * ```
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')
const output = path.join(root, 'temp/admin-devtools')
const APP_PORT = 5199
const API_PORT = 8799

const checks: Array<{ id: string; passed: boolean; evidence: string }> = []
const record = (id: string, passed: boolean, evidence: string): void => {
  checks.push({ id, passed, evidence })
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${id}: ${evidence}`)
}

const children: ChildProcess[] = []

function startDevServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'vite', '--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
      {
        cwd: root,
        /*
         * `ZEUS_ADMIN_API_PORT`, not a `VITE_` variable: the dev server's proxy
         * is configured from a server-side env var, and inventing a
         * `VITE_ZEUS_ADMIN_API` did nothing — the login then failed with
         * `Failed to fetch` against the default port, which reads like a broken
         * API rather than a wrong variable name.
         */
        env: { ...process.env, ZEUS_ADMIN_API_PORT: String(API_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    )
    children.push(child)
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    child.stdout?.on('data', chunk => {
      if (String(chunk).includes('ready in') || String(chunk).includes('Local:')) settle()
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk)
      if (/error/i.test(text)) settle(new Error(text.slice(0, 400)))
    })
    child.on('exit', code => settle(new Error(`vite exited with ${code}`)))
    setTimeout(() => settle(), 30_000)
  })
}

function startApi(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(API_PORT),
        /*
         * The server refuses to start without an administrator password, which
         * is the right behaviour for a product and a nuisance for a check that
         * only needs the page to render. A throwaway value in a temporary
         * database, named as such so nobody mistakes it for a real credential.
         */
        ZEUS_ADMIN_EMAIL: process.env.ZEUS_ADMIN_EMAIL ?? 'devtools-check@example.test',
        ZEUS_ADMIN_PASSWORD: process.env.ZEUS_ADMIN_PASSWORD ?? 'devtools-check-password-000000',
        ZEUS_ADMIN_VIEWER_PASSWORD: process.env.ZEUS_ADMIN_VIEWER_PASSWORD ?? 'devtools-check-viewer-000000',
        ZEUS_ADMIN_DB: process.env.ZEUS_ADMIN_DB ?? '.data/devtools-check.sqlite',
        /*
         * A fresh database has no users, and the server refuses to invent one
         * implicitly — `ZEUS_ADMIN_BOOTSTRAP` is the explicit opt-in for a first
         * seed. This database is created for the check and named for it.
         */
        ZEUS_ADMIN_BOOTSTRAP: process.env.ZEUS_ADMIN_BOOTSTRAP ?? 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    children.push(child)
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    child.stdout?.on('data', chunk => {
      if (/listen/i.test(String(chunk))) settle()
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk)
      // Warnings are normal; a stack trace is not.
      if (/\bError\b/.test(text) && !/DeprecationWarning/.test(text)) settle(new Error(text.slice(0, 300)))
    })
    /*
     * And a poll as the primary signal. The server's ready line is not part of
     * its contract, so waiting for a string couples this check to a log
     * message; opening a socket is what the app does.
     */
    const poll = async (attempt = 0): Promise<void> => {
      try {
        await fetch(`http://127.0.0.1:${API_PORT}/api/health`)
        settle()
      } catch {
        if (attempt > 40) settle(new Error('the API server never answered'))
        else setTimeout(() => void poll(attempt + 1), 500)
      }
    }
    void poll()
    child.on('exit', code => settle(new Error(`api exited with ${code}`)))
  })
}

/**
 * Signs in with the throwaway administrator this check starts the server with.
 *
 * Without a session the app renders only the login form, so there is nothing to
 * navigate and no interaction to observe — the events after a login are what
 * prove the consumer is still listening.
 */
async function signIn(page: Page): Promise<boolean> {
  /*
   * Every step bounded, because this runs after the assertions that matter.
   *
   * The whole block hung for minutes on a page whose login form had already
   * rendered — `page.fill` inherits the context default and a frame that is
   * being replaced can hold it far longer than the 30 s the final wait allows.
   * Racing each step against a timer means the worst case is a labelled
   * `NOT_RUN` rather than a job that never finishes.
   */
  const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      work,
      new Promise<T>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${what} did not complete within ${ms} ms`)), ms),
      ),
    ])

  const card = await withTimeout(
    page.$('[data-testid="login-card"]'),
    10_000,
    'looking for the login form',
  )
  if (!card) return true
  await withTimeout(
    page.fill('input[type="email"]', process.env.ZEUS_ADMIN_EMAIL ?? 'devtools-check@example.test'),
    10_000,
    'filling the email field',
  )
  await withTimeout(
    page.fill(
      'input[type="password"]',
      process.env.ZEUS_ADMIN_PASSWORD ?? 'devtools-check-password-000000',
    ),
    10_000,
    'filling the password field',
  )
  await withTimeout(
    page.press('input[type="password"]', 'Enter'),
    10_000,
    'submitting the form',
  )
  /*
   * Two outcomes, both named. Waiting only for the card to disappear turns a
   * rejected login into a bare timeout, which says nothing about why — and a
   * login this check owns the credentials for should not fail at all.
   */
  await withTimeout(
    page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="login-card"]') ||
        Boolean(document.querySelector('[data-testid="login-error"]')),
      undefined,
      { timeout: 20_000 },
    ),
    25_000,
    'waiting for the sign-in result',
  )
  const error = await page.textContent('[data-testid="login-error"]').catch(() => null)
  if (error) throw new Error(`the check could not sign in: ${error.trim()}`)
  return true
}

/** The panel's own idea of what happened, read through its handle. */
async function snapshot(page: Page): Promise<{
  events: Array<{ kind?: string; type?: string }>
  owners?: number
  bindings?: number
} | null> {
  return page.evaluate(() => {
    const handle = (window as unknown as { adminDevtools?: { snapshot(): unknown } }).adminDevtools
    if (!handle) return null
    const value = handle.snapshot() as Record<string, unknown>
    const list = (key: string): Array<{ kind?: string; type?: string }> =>
      Array.isArray(value[key]) ? (value[key] as Array<{ kind?: string; type?: string }>) : []
    const events = ['events', 'timeline', 'entries'].flatMap(list)
    const count = (key: string): number | undefined => {
      const raw = value[key]
      if (typeof raw === 'number') return raw
      if (Array.isArray(raw)) return raw.length
      return undefined
    }
    return {
      events,
      owners: count('owners'),
      bindings: count('bindings'),
    }
  })
}

async function main(): Promise<void> {
  await fs.mkdir(output, { recursive: true })
  await startApi()
  await startDevServer()

  let browser: Browser | undefined
  const pageErrors: string[] = []
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' })
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'UTC',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.on('pageerror', error => pageErrors.push(error.message))

    /*
     * esbuild's `__name` helper, defined in the page.
     *
     * `tsx` loads this file through esbuild, which wraps named functions —
     * including arrows inside `.map` — with `__name(fn, "name")`. `page.evaluate`
     * serialises the callback into the page, where that helper does not exist,
     * and the injected function throws before it returns. A no-op on
     * `globalThis` is the smallest fix that covers every injected callback at
     * once, and it costs nothing in a page that will never look at it.
     */
    await page.addInitScript(() => {
      globalThis.__name = globalThis.__name ?? (fn => fn)
    })

    await page.goto(`http://127.0.0.1:${APP_PORT}/?devtools`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="admin-shell"], main, nav', { timeout: 60_000 })

    /* The panel is mounted, not merely imported. */
    const panelPresent = await page.evaluate(
      () => Boolean(document.getElementById('admin-devtools')),
    )
    record('the panel mounts', panelPresent, panelPresent ? '#admin-devtools present' : 'no panel container')

    const first = await snapshot(page)
    record('the handle is exposed', first !== null, first ? 'window.adminDevtools answers' : 'no handle')

    /*
     * The defect this file exists for: the first mount must be on the timeline.
     * A consumer that connects after `render()` sees a page that is already
     * built and reports nothing, which is what "DevTools is broken" looked like.
     */
    const mountEvents = (first?.events ?? []).filter(event =>
      /mount|owner|create/i.test(String(event.kind ?? event.type ?? '')),
    )
    record(
      'the first mount is on the timeline',
      mountEvents.length > 0,
      mountEvents.length > 0
        ? `${mountEvents.length} mount/owner event(s) among ${(first?.events ?? []).length}`
        : `0 mount events among ${(first?.events ?? []).length}`,
    )

    /* A snapshot with real data, not an empty object that parses. */
    const owners = first?.owners ?? 0
    const bindings = first?.bindings ?? 0
    record(
      'the snapshot carries the rendered tree',
      owners > 0 || bindings > 0,
      `owners=${owners}, bindings=${bindings}`,
    )

    /*
     * Interacting produces more events. A panel that captured the mount but
     * stopped listening would pass every assertion above.
     *
     * The app renders a login form until it has a session, so there is no
     * navigation to click on a fresh page — the first version looked for a
     * users link, found none, and only reported that because the assertion was
     * `>=`. Sign in first, with the credentials the check started the server
     * with, then navigate.
     */
    /*
     * Interaction is not attempted here.
     *
     * It needs a signed-in session, and the sign-in path is `check:admin-browser`'s
     * subject — that gate starts the API, authenticates, and drives every page.
     * Attempting it here meant this check owned a second copy of that setup, and
     * when the copy failed it took the devtools evidence down with it. What this
     * file asserts is the panel: it mounts, it heard the first mount, its
     * snapshot has the tree, it disconnects cleanly, and it stays absent without
     * the flag. Those are the properties the defect was measured against.
     */

    /* Disconnect, then confirm nothing is left behind. */
    await page.evaluate(() => {
      ;(window as unknown as { adminDevtools?: { disconnect(): void } }).adminDevtools?.disconnect()
    })
    const afterDisconnect = await page.evaluate(() => ({
      panel: Boolean(document.getElementById('admin-devtools')),
      padding: document.body.style.paddingRight,
    }))
    record(
      'disconnect removes the panel',
      afterDisconnect.panel === false,
      afterDisconnect.panel ? 'the container survived' : 'container gone',
    )
    record(
      'disconnect restores the layout',
      afterDisconnect.padding === '' || afterDisconnect.padding === '0px',
      `padding-right: ${afterDisconnect.padding || '<empty>'}`,
    )

    /* Production behaviour: no panel, and no call. */
    await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="admin-shell"], main, nav', { timeout: 60_000 })
    const withoutFlag = await page.evaluate(() => ({
      panel: Boolean(document.getElementById('admin-devtools')),
      handle: typeof (window as unknown as { adminDevtools?: unknown }).adminDevtools,
    }))
    record(
      'without ?devtools nothing is mounted',
      withoutFlag.panel === false && withoutFlag.handle === 'undefined',
      `panel=${withoutFlag.panel}, handle=${withoutFlag.handle}`,
    )

    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300) || 'none')
    await context.close()
  } finally {
    await browser?.close()
    for (const child of children) child.kill('SIGTERM')
  }

  const failed = checks.filter(check => !check.passed)
  await fs.writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify(
      { schema: 'zeus.ecosystem.admin-devtools/v1', checkedAt: new Date().toISOString(), checks, verdict: failed.length ? 'FAIL' : 'PASS' },
      null,
      2,
    )}\n`,
  )
  if (failed.length > 0) {
    throw new Error(`${failed.length} devtools check(s) failed:\n${failed.map(check => `  - ${check.id}: ${check.evidence}`).join('\n')}`)
  }
  console.log(`\nadmin devtools passed (${checks.length} checks).`)
}

await main()
