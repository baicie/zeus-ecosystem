/**
 * A visual baseline for the Playground, and an honest record of where it came from.
 *
 * ## What the R20 spec asked for, and why the answer is not "restore it"
 *
 * K1 says to recover the reference from the fixed historical SHA the app had in
 * the core repository before it moved. That reference does not exist: the
 * Playground never shipped a visual baseline. A history search for files under
 * `visual-baselines` in `examples/playground-editor` returns nothing, and the
 * commit that removed the app (`a0f0ed29`) deleted no baseline file — there was
 * none to delete.
 *
 * So the choice is between saying "no baseline" forever and capturing one. This
 * captures one, from a real built image, and records it as `CANDIDATE`: nothing
 * here has been compared against anything, and calling a first capture an
 * "approved reference" is the defect the whole visual vocabulary exists to
 * prevent. A person has to look at the screenshots before it means anything.
 *
 * ## What is captured
 *
 * Both products, both themes, both languages, and a narrow viewport — the states
 * the app can actually be in, not one screenshot of the editor. Each scenario
 * records the rendered text, the structural landmarks and a PNG, so a later run
 * can compare layout without comparing translations.
 *
 * ## Running it
 *
 * ```text
 * PLAYGROUND_HOST_URL=http://127.0.0.1:8080 \
 *   pnpm --filter @zeus-ecosystem/playground check:visual --write-baseline
 * PLAYGROUND_HOST_URL=http://127.0.0.1:8080 \
 *   pnpm --filter @zeus-ecosystem/playground check:visual
 * ```
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')
const baselineFile = path.join(root, 'visual-baselines/reference.json')
const shotsDir = path.join(root, 'visual-baselines/screenshots')
const output = path.join(root, 'temp/playground-visual')

const HOST_URL = process.env.PLAYGROUND_HOST_URL?.trim()
const write = process.argv.includes('--write-baseline')

const VIEWPORT = { width: 1440, height: 900 }
const NARROW = { width: 720, height: 900 }

interface Scenario {
  readonly id: string
  readonly viewport: { width: number; height: number }
  readonly prepare: (page: Page) => Promise<void>
}

/**
 * Writes the persisted settings and reloads.
 *
 * Every scenario states its own theme and language. Leaving either to whatever
 * the previous scenario left produced a Chinese WebC capture inside a baseline
 * that declares `locale: en-US` — a screenshot that is wrong for a reason no
 * comparison would ever surface, because the baseline is the thing comparisons
 * trust.
 */
async function applySettings(
  page: Page,
  settings: { theme: 'light' | 'dark'; locale: 'en' | 'zh-CN' },
): Promise<void> {
  await page.evaluate(next => {
    const current = JSON.parse(localStorage.getItem('zeus-playground.settings.v2') ?? '{}')
    localStorage.setItem('zeus-playground.settings.v2', JSON.stringify({ ...current, ...next }))
  }, settings)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="compile"]', { timeout: 90_000 })
}

/** The scenarios, each a state a user can reach without a special build. */
const SCENARIOS: Scenario[] = [
  {
    id: 'native-editor-light-en',
    viewport: VIEWPORT,
    prepare: async page => {
      await applySettings(page, { theme: 'light', locale: 'en' })
    },
  },
  {
    id: 'native-editor-dark-en',
    viewport: VIEWPORT,
    prepare: async page => {
      await applySettings(page, { theme: 'dark', locale: 'en' })
    },
  },
  {
    id: 'native-editor-light-zh',
    viewport: VIEWPORT,
    prepare: async page => {
      await applySettings(page, { theme: 'light', locale: 'zh-CN' })
    },
  },
  {
    id: 'native-editor-narrow',
    viewport: NARROW,
    // Explicit, not inherited. Scenarios run in order on one page, so a
    // scenario that sets no language captures whatever the previous one left —
    // which is how the WebC capture below came out Chinese in a baseline that
    // declares `locale: en-US`.
    prepare: async page => {
      await applySettings(page, { theme: 'light', locale: 'en' })
    },
  },
  {
    id: 'native-preview-commands',
    viewport: VIEWPORT,
    prepare: async page => {
      await applySettings(page, { theme: 'light', locale: 'en' })
      // The output tab carries the compiled modules, which is what a reader of
      // the screenshot is usually looking for.
      const tab = page.getByRole('tab', { name: /^output$|^输出$/i }).first()
      if (await tab.count()) await tab.click()
    },
  },
  {
    id: 'webc-studio',
    viewport: VIEWPORT,
    prepare: async page => {
      await applySettings(page, { theme: 'light', locale: 'en' })
      await page.evaluate(() => {
        ;(window as unknown as { __zeusPlayground?: { selectProduct(p: string): void } })
          .__zeusPlayground?.selectProduct('webc-studio')
      })
      // The product switch re-renders the shell; waiting a fixed 500 ms raced
      // the editor chunk on a cold container.
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="editor"] .cm-editor')),
        undefined,
        { timeout: 60_000 },
      )
    },
  },
]

/**
 * The text and landmarks a comparison can use.
 *
 * Text alone would make two languages look like two layouts; landmarks alone
 * would miss a label that never rendered. Both are recorded, and the comparison
 * uses the one that fits the question it is asked.
 */
async function capture(page: Page): Promise<{ text: string; landmarks: string[] }> {
  return page.evaluate(() => {
    /*
     * Timings and counts out, before anything is compared.
     *
     * The status bar renders `Compiled 2 modules · 17.4 ms` and
     * `Preview ready · 8.2 ms`; every run produces different numbers for the
     * same build. Capturing them made a comparison report 6/6 scenarios changed
     * between two runs of the *same image*, which is noise wearing the clothes
     * of a regression. Anything measured is normalised; what is left is what a
     * screenshot can actually say.
     */
    const text = document.body.innerText
      .replace(/\s+/g, ' ')
      .replace(/\d+(?:\.\d+)?\s*ms\b/g, '<ms>')
      .replace(/\bCompiled \d+ modules?\b/g, 'Compiled <n> modules')
      .replace(/预览就绪 · <ms>/g, '预览就绪')
      .trim()
      .slice(0, 4000)
    /*
     * The same normalisation as `text`, for the same reason.
     *
     * A `[data-testid="status"]` landmark carries `Compiled 2 modules · 17.4 ms`
     * — the element that made the *text* comparison unstable also appears here,
     * and applying the rule to only one of the two produced "text same,
     * landmarks differ" for six scenarios of an unchanged build.
     */
    /*
     * An arrow, not a `function normalise(value)` declaration.
     *
     * `page.evaluate` serialises its callback and runs it in the page. esbuild
     * — which `tsx` uses to load this file — rewrites a named function
     * expression with a `__name(...)` helper that exists only in the module,
     * so the injected function throws `__name is not defined` inside the page.
     * Arrow functions get no such wrapper. The same trap is recorded for
     * `page.waitForFunction` elsewhere in this repository.
     */
    const normalise = value =>
      value
        .replace(/\s+/g, ' ')
        .replace(/\d+(?:\.\d+)?\s*ms\b/g, '<ms>')
        .replace(/\bCompiled \d+ modules?\b/g, 'Compiled <n> modules')
        .trim()
    const landmarks = [...document.querySelectorAll('h1, h2, h3, nav, form, [data-testid]')]
      .map(element => {
        const tag = element.tagName.toLowerCase()
        const testId = element.getAttribute('data-testid')
        const own = normalise(element.textContent ?? '').slice(0, 60)
        return `${tag}${testId ? `[${testId}]` : ''}:${own}`
      })
      .filter(entry => entry.length > 3)
      .slice(0, 40)
    return { text, landmarks }
  })
}

async function main(): Promise<void> {
  if (!HOST_URL) {
    console.error(
      'PLAYGROUND_HOST_URL is required. This captures a running deployment; a\n' +
        'baseline taken from a dev server would record the dev server.',
    )
    process.exitCode = 2
    return
  }
  await fs.mkdir(output, { recursive: true })
  if (write) await fs.mkdir(shotsDir, { recursive: true })

  const existing = write
    ? undefined
    : await fs
        .readFile(baselineFile, 'utf8')
        .then(text => JSON.parse(text) as { scenarios: Record<string, { text: string; landmarks: string[]; screenshot: string }> })
        .catch(() => undefined)

  let browser: Browser | undefined
  const captured: Record<string, { text: string; landmarks: string[]; screenshot: string }> = {}
  const comparisons: Array<{ id: string; status: 'MATCH' | 'CHANGED' | 'NEW' | 'MISSING'; detail: string }> = []

  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' })
    const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' })

    // One page, re-used: the settings each scenario writes must not leak, and a
    // reload between scenarios is what the app does on its own when a setting
    // changes.
    const page = await context.newPage()
    page.setDefaultTimeout(90_000)

    /*
     * esbuild's `__name` helper, defined in the page.
     *
     * `tsx` loads this file through esbuild, which wraps named functions with
     * `__name(fn, "name")`. `page.evaluate` serialises the callback into the
     * page, where that helper does not exist, and the injected function throws
     * `__name is not defined` before it returns anything. Avoiding named
     * functions is the usual advice and is not sufficient here — the helper is
     * attached to arrows inside `.map` too.
     *
     * A no-op on `globalThis` costs nothing and makes the serialised callback
     * work regardless of which function esbuild decided to wrap. The checks
     * elsewhere in this repository that avoid `page.waitForFunction` are doing
     * the same thing by hand; this states the reason once.
     */
    await page.addInitScript(() => {
      globalThis.__name = globalThis.__name ?? (fn => fn)
    })

    for (const scenario of SCENARIOS) {
      await page.setViewportSize(scenario.viewport)
      await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-testid="compile"]', { timeout: 90_000 })
      await scenario.prepare(page)
      await page.waitForSelector('[data-testid="compile"]', { timeout: 90_000 })
      /*
       * The editor chunk is lazy, and a screenshot taken before it paints
       * records a placeholder that differs from every later run for no reason.
       *
       * `data-ready` is bound to a boolean, and what a boolean attribute
       * serialises to is the framework's business — waiting for the literal
       * string `'true'` timed out on a page that had been ready for a minute.
       * CodeMirror's own DOM is the thing that actually indicates the editor
       * painted, so wait for that.
       */
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="editor"] .cm-editor')),
        undefined,
        { timeout: 60_000 },
      )
      await page.waitForTimeout(400)

      const shot = await page.screenshot({ fullPage: false })
      if (!write) {
        await fs.mkdir(output, { recursive: true })
        await fs.writeFile(path.join(output, `${scenario.id}.png`), shot)
      }
      const sha = createHash('sha256').update(shot).digest('hex')
      const record = { ...(await capture(page)), screenshot: sha }

      if (write) {
        captured[scenario.id] = record
        await fs.writeFile(path.join(shotsDir, `${scenario.id}.png`), shot)
        continue
      }

      const reference = existing?.scenarios?.[scenario.id]
      if (!reference) {
        comparisons.push({ id: scenario.id, status: 'NEW', detail: 'the baseline has no record of this scenario' })
        continue
      }
      /*
       * Two dimensions, reported separately.
       *
       * The text comparison is the one that catches a lost label; the
       * screenshot hash catches a moved element the text cannot see. They are
       * not collapsed into one verdict because a single "changed" would not say
       * which, and "which" is the whole content of a visual report.
       */
      const textSame = reference.text === record.text
      const landmarksSame = reference.landmarks.join('\n') === record.landmarks.join('\n')
      const pixelsSame = reference.screenshot === record.screenshot
      /*
       * Text and landmarks decide; the pixel hash is reported, not required.
       *
       * The status bar renders live timings into the viewport, so two runs of
       * the same image produce different pixels even after the text is
       * normalised. Letting the hash decide made the first comparison report
       * 6/6 changed on an unchanged build — an alarm nobody can act on. The hash
       * still appears in the detail line, because a pixel difference combined
       * with matching text is exactly the case a reviewer should look at.
       */
      comparisons.push({
        id: scenario.id,
        status: textSame && landmarksSame ? 'MATCH' : 'CHANGED',
        detail: [
          textSame ? 'text same' : 'text differs',
          landmarksSame ? 'landmarks same' : 'landmarks differ',
          pixelsSame ? 'pixels identical' : 'pixels differ',
        ].join(', '),
      })
    }
    await context.close()
  } finally {
    await browser?.close()
  }

  if (write) {
    /*
     * Recorded as CANDIDATE, with no reviewer.
     *
     * A first capture is a description of what the build does today, not an
     * approval of it. Nothing here has been compared against the app this one
     * replaced, because that app never had a baseline to compare against.
     */
    const baseline = {
      schema: 'zeus.ecosystem.playground-visual-reference/v1',
      applicationId: 'playground',
      reference: {
        kind: 'first-capture',
        note:
          'The Playground never shipped a visual baseline: no file of this kind exists in the core history, ' +
          'and the commit that removed the app there (a0f0ed29) deleted none. This is the first capture, ' +
          'so it can tell a later run what changed; it cannot tell anyone the design is right.',
        capturedFrom: HOST_URL,
      },
      capture: {
        viewport: VIEWPORT,
        locale: 'en-US',
        timezone: 'UTC',
        reducedMotion: 'reduce',
      },
      approvalStatus: 'CANDIDATE',
      approvalNote:
        'CANDIDATE: captured, never reviewed. A person has to look at the screenshots in screenshots/ ' +
        'before this counts as an approved reference.',
      scenarios: captured,
    }
    await fs.writeFile(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`wrote ${SCENARIOS.length} scenario(s) to ${path.relative(root, baselineFile)}`)
    console.log('approvalStatus: CANDIDATE — nobody has reviewed these screenshots')
    return
  }

  const changed = comparisons.filter(entry => entry.status === 'CHANGED' || entry.status === 'NEW')
  const report = {
    schema: 'zeus.ecosystem.playground-visual-comparison/v1',
    checkedAt: new Date().toISOString(),
    host: HOST_URL,
    comparisons,
    verdict: changed.length === 0 ? 'MATCH' : 'REVIEW_REQUIRED',
  }
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  for (const comparison of comparisons) {
    console.log(`${comparison.status.padEnd(8)} ${comparison.id}: ${comparison.detail}`)
  }
  /*
   * A difference is not a failure. Only a person can say whether a moved button
   * is a regression or a design change, so this exits zero and asks for review —
   * the same rule the Admin and AI visual gates follow.
   */
  console.log(
    changed.length === 0
      ? `\nall ${comparisons.length} scenario(s) match the baseline.`
      : `\n${changed.length} scenario(s) differ; review temp/playground-visual/report.json.`,
  )
}

await main()
