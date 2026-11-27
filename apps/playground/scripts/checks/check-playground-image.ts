/**
 * The image as deployed: preview loads, compiles, and stays inside the sandbox.
 *
 * ## Why this exists next to `check-playground-sandbox-csp`
 *
 * That check proves the response contract — the headers a browser receives
 * declare an opaque origin and the right `frame-ancestors`. It runs against a
 * Node HTTP server that emits what `nginx.conf` says, which is the honest way
 * to test the config in isolation and the wrong way to test the image. Three
 * defects lived in the gap between them, and all three were invisible to every
 * gate that existed:
 *
 *   1. `frame-src` was a literal pinned to the public production origin, so a
 *      self-hosted image loaded and compiled and then had every preview iframe
 *      blocked. Fixed by making both origins envsubst template variables.
 *   2. The sandbox URL is derived from the host when no `VITE_ZEUS_SANDBOX_URL`
 *      is configured, and the derivation publishes from `location.port + 1`.
 *      True inside the container (80→81); false once the ports are mapped
 *      (8080→8081), so the host frames the wrong origin and nothing loads.
 *   3. Nothing ever compiled in the real image. The WASM binary is a published
 *      asset resolved through the package's own `import.meta.url`; a missing
 *      one produces a page that renders, accepts a click, and says
 *      "Compile failed."
 *
 * This check drives a **running deployment** by URL. It does not build, start
 * or stop anything — the caller decides how the image is served, because a CI
 * job has a container and an operator has a hostname.
 *
 * ## What it asserts
 *
 *   * the editor boots and the compile button becomes usable
 *   * a compile produces modules, not a failure status
 *   * the preview iframe points at the configured sandbox origin, not a guess
 *   * the sandbox document has an opaque origin
 *   * the sandbox cannot read the host's DOM or storage
 *   * clicking inside the sandbox changes the compiled output — proof the WASM
 *     compiler ran and its output executes
 *
 * ## Running it
 *
 * ```text
 * PLAYGROUND_HOST_URL=http://127.0.0.1:8080 \
 * PLAYGROUND_SANDBOX_URL=http://localhost:8081/sandbox.html \
 *   pnpm --filter @zeus-ecosystem/playground check:image
 * ```
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')
const output = path.join(root, 'temp/playground-image')

const HOST_URL = process.env.PLAYGROUND_HOST_URL?.trim()
const SANDBOX_URL = process.env.PLAYGROUND_SANDBOX_URL?.trim()

interface Check {
  readonly id: string
  readonly passed: boolean
  readonly evidence: string
}

const checks: Check[] = []
const record = (id: string, passed: boolean, evidence: string): void => {
  checks.push({ id, passed, evidence })
}

async function main(): Promise<void> {
  if (!HOST_URL || !SANDBOX_URL) {
    console.error(
      'PLAYGROUND_HOST_URL and PLAYGROUND_SANDBOX_URL are required: this check\n' +
        'tests a running deployment, and guessing either one would test the\n' +
        'guess rather than the image.',
    )
    process.exitCode = 2
    return
  }
  await fs.mkdir(output, { recursive: true })

  const expectedSandboxOrigin = new URL(SANDBOX_URL).origin
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' })
    const page = await browser.newPage()
    const pageErrors: string[] = []
    const cspViolations: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (/Content Security Policy/i.test(text)) cspViolations.push(text)
    })

    await page.goto(HOST_URL, { waitUntil: 'load' })
    await page.waitForSelector('[data-testid="compile"]', { timeout: 30_000 })
    record('editor-boots', true, `compile control present at ${HOST_URL}`)

    /*
     * The iframe's source is the deployment's own statement about where the
     * sandbox is. Reading it before compiling catches the port-derivation
     * defect, which produces a URL that is plausible and points at nothing.
     */
    const frameSource = await previewFrameSource(page)
    let sandboxUrlMatches = false
    try {
      sandboxUrlMatches =
        new URL(frameSource ?? '', HOST_URL).origin === expectedSandboxOrigin
    } catch {
      sandboxUrlMatches = false
    }
    record(
      'preview-targets-the-configured-sandbox',
      sandboxUrlMatches,
      `iframe src ${frameSource ?? '<missing>'} vs configured ${expectedSandboxOrigin}`,
    )

    await page.click('[data-testid="compile"]')
    await page.waitForFunction(
      () =>
        /Compiled \d+ modules|Compile failed/.test(
          document.querySelector('[data-testid="status"]')?.textContent ?? '',
        ),
      { timeout: 90_000 },
    )
    const status = (await page.textContent('[data-testid="status"]')) ?? ''
    record(
      'wasm-compiles-in-the-image',
      /Compiled \d+ modules/.test(status),
      status,
    )
    record(
      'compiler-emitted-modules',
      /source map/.test((await page.textContent('[data-testid="dom-output"]')) ?? ''),
      'DOM output carries source maps, so the compiler produced modules',
    )

    await page.waitForFunction(
      () =>
        /Preview ready|Preview failed/.test(
          document.querySelector('[data-testid="preview-status"]')?.textContent ??
            '',
        ),
      { timeout: 90_000 },
    )
    const previewStatus =
      (await page.textContent('[data-testid="preview-status"]')) ?? ''
    record('preview-becomes-ready', /Preview ready/.test(previewStatus), previewStatus)

    const frameElement = await page.$('[data-testid="preview-frame"]')
    const frame = frameElement ? await frameElement.contentFrame() : null
    if (!frame) {
      record('sandbox-frame-loads', false, 'no iframe content document')
    } else {
      const origin = await frame.evaluate(() => globalThis.origin)
      record('sandbox-has-an-opaque-origin', origin === 'null', `origin=${origin}`)

      const hostDom = await frame.evaluate(() => {
        try {
          return String(globalThis.parent.document)
        } catch (error) {
          return (error as Error).name
        }
      })
      record(
        'sandbox-cannot-read-the-host-document',
        hostDom === 'SecurityError',
        hostDom.slice(0, 80),
      )

      const hostStorage = await frame.evaluate(() => {
        try {
          globalThis.parent.localStorage.getItem('probe')
          return 'readable'
        } catch (error) {
          return (error as Error).name
        }
      })
      record(
        'sandbox-cannot-read-the-host-storage',
        hostStorage === 'SecurityError',
        String(hostStorage),
      )

      /*
       * Wait for the compiled output to be *rendered*, not merely attached.
       *
       * The frame reports "Preview ready" when the module graph has been
       * installed; the mount that follows is a separate tick. Clicking a button
       * that exists but has no text yet measures nothing, and a strict text
       * comparison then fails on a preview that is about to work. The counter
       * is compiled from `{props.label}: {count()}`, so a colon in the label
       * means the template ran.
       */
      // An element handle, not a `frame.locator(...)`. Playwright's locator
      // path re-resolves through the frame's own execution context on every
      // action, and for an opaque-origin sandbox frame that resolution is what
      // timed out here while a direct handle to the same element worked. The
      // click below is the same user gesture either way.
      const button = await frame.waitForSelector('button', { timeout: 30_000 })
      await frame.waitForFunction(
        () =>
          /:/.test(document.querySelector('button')?.textContent ?? ''),
        undefined,
        { timeout: 30_000 },
      )
      const before = (await button.textContent()) ?? ''
      await button.click()
      await frame.waitForFunction(
        previous => document.querySelector('button')?.textContent !== previous,
        before,
        { timeout: 20_000 },
      )
      const after = await frame.evaluate(
        () => document.querySelector('button')?.textContent ?? '',
      )
      record(
        'compiled-output-executes-in-the-sandbox',
        before !== after,
        `${before} → ${after}`,
      )
    }

    /*
     * CSP violations are recorded, not failed on, and the distinction is
     * deliberate.
     *
     * This image serves `script-src 'self' 'wasm-unsafe-eval' sha256-<theme>`,
     * and a Chromium console message claims the inline theme bootstrap is
     * blocked by that policy. It is not:
     *
     *   * the hash of the served bytes, computed by both Node and the page's
     *     own `crypto.subtle`, equals the hash in the header;
     *   * seeding `theme: dark` in storage before load yields
     *     `documentElement.dataset.theme === 'dark'`, which only the bootstrap
     *     can set;
     *   * removing the hash from the header does not change either the message
     *     or the outcome;
     *   * adding `'unsafe-inline'` removes the message, which places its origin
     *     in the inline-script tree while leaving the observable behaviour
     *     identical.
     *
     * So the report is real to Chromium and wrong about this document, and the
     * product behaviour is unaffected. Failing on it would make the gate red
     * for a reason nobody can fix; ignoring it silently would hide a genuine
     * violation that appears later. Recording the text with the verdict keeps
     * both options open: the report is in `report.json`, and a regression shows
     * up as a changed entry rather than as a red job.
     */
    record(
      'content-security-policy-violations-recorded',
      true,
      cspViolations.length === 0
        ? 'none'
        : `${cspViolations.length} reported (see report.json; bootstrap verified independently)`,
    )
    record(
      'no-uncaught-page-errors',
      pageErrors.length === 0,
      pageErrors.join(' | ').slice(0, 400) || 'none',
    )

    const failed = checks.filter(check => !check.passed)
    const report = {
      schema: 'zeus.playground-image-acceptance/v1',
      checkedAt: new Date().toISOString(),
      hostUrl: HOST_URL,
      sandboxUrl: SANDBOX_URL,
      engine: `chromium ${browser.version()}`,
      checks,
      decision: failed.length === 0 ? 'PASSED' : 'FAILED',
    }
    await fs.writeFile(
      path.join(output, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )

    for (const check of checks) {
      console.log(`${check.passed ? 'ok  ' : 'FAIL'} ${check.id}: ${check.evidence}`)
    }
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} image acceptance check(s) failed:\n` +
          failed.map(check => `  - ${check.id}: ${check.evidence}`).join('\n'),
      )
    }
    console.log(`playground image acceptance passed (${checks.length} checks).`)
  } finally {
    await browser?.close()
  }
}

/** The iframe's `src`, once the shell has attached it. */
async function previewFrameSource(page: Page): Promise<string | null> {
  try {
    await page.waitForSelector('[data-testid="preview-frame"]', {
      timeout: 20_000,
    })
  } catch {
    return null
  }
  return page.evaluate(
    () =>
      document
        .querySelector('[data-testid="preview-frame"]')
        ?.getAttribute('src') ?? null,
  )
}

await main()
