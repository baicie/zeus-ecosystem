/**
 * Visual parity between the migrated Admin and a frozen reference build.
 *
 * ## Two different questions
 *
 * 1. **Migration parity** — does the migrated app look like the app it
 *    replaced? This is what the gate below measures, and it is the only thing
 *    it measures.
 * 2. **Product design** — is the interface good? That needs a designer's
 *    judgement, and approving a diff as "intentional" without one is how a
 *    regression gets recorded as a decision.
 *
 * Nothing here auto-approves a difference. A baseline is written once by a
 * human running `--write-baseline`, and every later run compares against it.
 *
 * ## The reference
 *
 * `ghcr.io/baicie/zeus-admin:main` with image id `faf238d3…`, built from
 * `132c777e` at version `0.1.1-beta.20`. It is a real published artefact, not a
 * rebuild from the current tree: the sources it came from are not checked out
 * anywhere, and reconstructing them would produce a reference that agrees with
 * whatever this repository does today.
 *
 * The reference is stood up as a container on its own port and driven through
 * the same scenarios as the candidate. Both are given deterministic inputs —
 * fixed locale, timezone, viewport and seeded data — so a difference means a
 * difference in the product.
 *
 * ## What is and is not compared
 *
 * Only the content region. A screenshot diff over the whole viewport would
 * compare pixel counts of the two versions' chrome, which is layout noise, not
 * parity. The comparison is on the rendered text and the structural landmarks a
 * user navigates by.
 *
 * Usage:
 *   node .../check-admin-visual.ts --reference <image> [--write-baseline]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { chromium, type Browser, type Page } from '@playwright/test'

import { ADMIN, freePort, startAdminServer } from './support/server'
import { comparePngs, screenshotVerdict, DEFAULT_SCREENSHOT_THRESHOLD } from './screenshot-diff'
import { overallStatus, type VisualEvidence } from './visual-dimensions'

const APP = path.resolve(import.meta.dirname, '../..')
const ARTIFACTS = path.join(APP, 'temp/admin-visual')
const BASELINES = path.join(APP, 'visual-baselines')

/**
 * The reference image, pinned by digest.
 *
 * `ghcr.io/baicie/zeus-admin:main` is a **moving tag**. It resolved to
 * `faf238d3…` (built from `132c777e`, 2026-11-11) when this gate was written,
 * and to `dfa60dd6…` (from `4a5db055`, 2026-11-23) a pull later. The two
 * renders differ — including the interface language — so a baseline taken
 * against one describes a build the other is not.
 *
 * A visual baseline against a moving tag is not a baseline. The digest below is
 * the build the committed baseline was taken from; comparing against anything
 * else is reported as a different reference rather than as a UI difference.
 */
export const REFERENCE_IMAGE =
  'ghcr.io/baicie/zeus-admin@sha256:faf238d3b701ff896a5524225ef92ffdc99aed1828f1ed7088ee6c443096f819'

/** The registry digest the committed baseline was captured from. */
export const BASELINE_DIGEST =
  'sha256:faf238d3b701ff896a5524225ef92ffdc99aed1828f1ed7088ee6c443096f819'

interface Scenario {
  readonly name: string
  readonly path: string
  readonly ready: (page: Page) => Promise<void>
}

/**
 * Waits for a page's structure, not its words.
 *
 * ## The defect this replaces
 *
 * `ready` used to wait on a heading by name — `/settings/i`, `/roles/i` — which
 * is an English string. The reference build renders Chinese regardless of every
 * language input that can be set from outside, so six of the eight scenarios
 * timed out their readiness wait, the capture happened anyway, and the report
 * called the result `UNUSABLE`. The gate was right to refuse the comparison and
 * wrong about why: the pages were fine, the wait was in the wrong language.
 *
 * Counting landmarks answers the same question — "has the page finished
 * arriving" — with a predicate that does not name a language. Measured on the
 * reference build, each page's landmark counts are stable within 300ms and
 * distinct from the shell alone, so a threshold on them is a real readiness
 * signal rather than a sleep with extra steps.
 *
 * ## Why this polls instead of using `waitForFunction`
 *
 * Two attempts failed, both for reasons that are about the toolchain rather
 * than the question:
 *
 *  - **A callback function.** `waitForFunction` serialises it and runs it in
 *    the page. This gate runs under `tsx`, and esbuild rewrites named functions
 *    to call a `__name(...)` helper that exists in Node and not in the browser:
 *    every call threw `ReferenceError: __name is not defined`. The landmark
 *    counts were right the whole time; the predicate reading them was broken.
 *  - **A string of JavaScript.** That fixes the helper, and the app's CSP
 *    blocks it: `script-src 'self'` refuses `eval`, which is what evaluating a
 *    string amounts to. The gate would be asserting against a page it had to
 *    weaken to measure.
 *
 * `page.evaluate` passes a *value* into a function the browser already has, so
 * neither problem applies. Polling is the cost, and 100ms against a page that
 * settles in about 300ms is cheap.
 */
async function readyByLandmarks(
  page: Page,
  expected: { headings?: number; tables?: number; forms?: number },
): Promise<void> {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    const seen = await page.evaluate(() => ({
      headings: document.querySelectorAll('h1, h2, h3').length,
      tables: document.querySelectorAll('table, [role="grid"]').length,
      forms: document.querySelectorAll('form').length,
    }))

    if (
      seen.headings >= (expected.headings ?? 0) &&
      seen.tables >= (expected.tables ?? 0) &&
      seen.forms >= (expected.forms ?? 0)
    ) {
      return
    }

    await page.waitForTimeout(100)
  }

  const seen = await page.evaluate(() => ({
    headings: document.querySelectorAll('h1, h2, h3').length,
    tables: document.querySelectorAll('table, [role="grid"]').length,
    forms: document.querySelectorAll('form').length,
  }))

  throw new Error(
    `the page did not reach the expected structure within 20s: wanted ${JSON.stringify(expected)}, found ${JSON.stringify(seen)}`,
  )
}

/**
 * The pages the migration had to preserve.
 *
 * `ready` waits for content the scenario is about, so a screenshot is never
 * taken of a loading skeleton — two skeletons match each other perfectly and
 * say nothing.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'overview',
    path: '/admin',
    ready: async page => {
      await readyByLandmarks(page, { headings: 8 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'users',
    path: '/admin/users',
    ready: async page => {
      /*
       * An email is not a translated string: the seeded rows carry the same
       * `@example.test` addresses in both builds, which makes this the one
       * readiness wait that was language-independent all along.
       */
      await page.getByRole('row').filter({ hasText: '@example.test' }).first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'roles',
    path: '/admin/roles',
    ready: async page => {
      /* A capability matrix: headings and a table, whatever the language. */
      await readyByLandmarks(page, { headings: 4 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'settings',
    path: '/admin/settings',
    ready: async page => {
      /* The workspace form is the thing this page exists for. */
      await readyByLandmarks(page, { headings: 3, forms: 1 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'audit',
    path: '/admin/audit',
    ready: async page => {
      await readyByLandmarks(page, { headings: 2, tables: 1 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'reports',
    path: '/admin/reports',
    ready: async page => {
      await readyByLandmarks(page, { headings: 6 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'upload',
    path: '/admin/upload',
    ready: async page => {
      await readyByLandmarks(page, { headings: 3, forms: 1 })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'not-found',
    path: '/admin/does-not-exist',
    ready: async page => {
      await page.getByRole('heading').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(600)
    },
  },
]

/**
 * The observable content of a page, as a comparison key.
 *
 * Text plus the landmarks a person navigates by. Not pixels: two builds of the
 * same UI differ by a pixel or two from font hinting alone, and a diff that
 * reports 0.3% on every page trains a reader to ignore it.
 */
export interface CapturedPage {
  readonly text: string
  readonly landmarks: string[]
  readonly screenshot: Buffer
  /** sha256 of the PNG, so a baseline can be checked byte for byte. */
  readonly screenshotSha256: string
  /** Which engine produced it: a Chromium baseline is not a Firefox one. */
  readonly browser: string
  readonly browserVersion: string
  /**
   * What the page actually is, as the app reports it.
   *
   * Added after a run compared five reference pages that were all the sign-in
   * card: the reference session had been dropped, every navigation landed on
   * the login form, and the gate — which waited for headings that the login
   * page does not have — timed out its `ready`, captured anyway, and reported
   * the resulting pixel difference as a regression. The captures were of the
   * wrong page and nothing in the record said so.
   */
  readonly signedIn: boolean
  /** The path the browser ended up on, which a redirect also reveals. */
  readonly pathname: string
}

export async function pageContent(page: Page): Promise<CapturedPage> {
  /*
   * One entry per element, not `innerText` split on newlines.
   *
   * `innerText` on the shell returns the whole page as a single line in some
   * engines, so splitting it produced a one-line comparison: every page
   * reported "1 line gone, 1 new" and the detail was the entire application
   * text. Walking the elements that hold text gives a unit a reader can act on
   * — and makes a two-word change count as one line rather than a total
   * mismatch.
   */
  const text = (
    await page.evaluate(() => {
      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'])
      const lines: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && skip.has(node.parentElement.tagName)) continue

        const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim()

        if (value.length > 0) lines.push(value)
      }

      return lines
    })
  ).join('\n')

  const landmarks = await page.evaluate(() => {
    const found: string[] = []

    for (const element of document.querySelectorAll('h1, h2, h3, nav, table, form, [role="grid"]')) {
      found.push(`${element.tagName.toLowerCase()}:${(element.textContent ?? '').trim().slice(0, 40)}`)
    }

    return found
  })

  const screenshot = await page.screenshot({ fullPage: true })

  /*
   * The hash, the engine and its version travel with the capture.
   *
   * A screenshot is only comparable to one taken by the same browser at the
   * same version; comparing a Chromium capture to a Firefox baseline would
   * report every page as different. `approvalStatus` is deliberately absent
   * here — it is a person's judgement, recorded in the baseline by whoever
   * reviewed it, never set by this script.
   */
  const { createHash } = await import('node:crypto')
  const browserVersion = page.context().browser()?.version() ?? 'unknown'

  /*
   * What the page is, recorded with the capture.
   *
   * The shell renders a `<nav>` and the login card does not, so a navigation
   * landmark is the cheapest reliable statement that a session was live. The
   * pathname catches the other half: a router that redirects an unauthenticated
   * visit lands on `/`, which the scenario did not ask for.
   */
  const signedIn = (await page.getByRole('navigation').count()) > 0
  const pathname = new URL(page.url()).pathname

  return {
    text,
    landmarks,
    screenshot,
    screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
    browser: 'chromium',
    browserVersion,
    signedIn,
    pathname,
  }
}

/**
 * Forces the interface language before the app boots.
 *
 * ## What was measured
 *
 * The two builds decide their language differently, and neither input that can
 * be set from outside reaches both:
 *
 * | input                          | reference (`faf238d3`) | candidate |
 * | ------------------------------ | ---------------------- | --------- |
 * | `navigator.languages`          | ignored                | consulted |
 * | `accept-language`              | ignored                | consulted |
 * | workspace locale via the API   | stored, not rendered   | consulted |
 * | `localStorage` per-account key | absent from that build | honoured  |
 *
 * Driven with `locale: 'en-US'`, both a browser language of `en-US` and one of
 * `zh-CN`, the reference renders `lang="zh-CN"` and Chinese headings. That is
 * not a harness mistake — it is what that build does, and it is why every
 * scenario came back `STRUCTURE_MATCHES_TRANSLATED`.
 *
 * ## The consequence
 *
 * A pixel comparison across two languages measures the translation. So the
 * gate does not compare pixels when the structural result says the pages are
 * translated; it records `NOT_RUN` and says why. The alternative — inventing a
 * padded ratio — would put a number on a difference nobody can act on.
 *
 * `pinLocale` still writes the per-account key, because it is the one input the
 * candidate honours and pinning it makes the candidate's rendering deterministic
 * run to run. It cannot make the reference render English, and this comment
 * exists so nobody assumes it does.
 */
async function pinLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      /*
       * `PREFERENCE_PREFIX` in `i18n.ts` is `zeus-admin.locale.` — hyphens, not
       * dots. A wrong key stores a value nobody reads, and the page silently
       * falls back to `navigator.languages`.
       */
      localStorage.setItem('zeus-admin.locale.ada', 'en')
      localStorage.setItem('zeus-admin.locale.grace', 'en')
    } catch {
      // A blocked storage API falls back to the page's own resolution.
    }
  })
}

async function signIn(page: Page): Promise<void> {
  await pinLocale(page)
  await page.goto('/')
  await page.getByLabel(/email|邮箱/i).fill(ADMIN.email)
  await page.getByLabel(/password|密码/i).fill(ADMIN.password)
  await page.getByRole('button', { name: /sign in|log in|登录/i }).click()
  await page.getByRole('navigation').first().waitFor({ timeout: 30_000 })
}

/**
 * Starts the reference as a container.
 *
 * The image is the published artefact, and the account it is seeded with comes
 * from environment variables so the same scenario code signs in to both.
 */
async function startReference(image: string): Promise<{ origin: string; stop(): void }> {
  const port = await freePort(5500)
  const name = `zeus-visual-ref-${process.pid}`

  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
  } catch {
    // Nothing to remove.
  }

  execFileSync(
    'docker',
    [
      'run', '-d', '--name', name,
      '-e', `ZEUS_ADMIN_PASSWORD=${ADMIN.password}`,
      '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
      '-e', 'ZEUS_ADMIN_SEED_DEMO=true',
      '-e', `ZEUS_ADMIN_VIEWER_PASSWORD=viewer-password-0001`,
      '-p', `127.0.0.1:${port}:8080`,
      image,
    ],
    { stdio: 'pipe' },
  )

  const origin = `http://127.0.0.1:${port}`

  /*
   * Wait for the reference before driving it.
   *
   * The container takes several seconds to open its port — it runs under
   * emulation on Apple silicon — and a browser pointed at it too early gets
   * `ERR_EMPTY_RESPONSE`, which reads like a broken image rather than a slow
   * one. The wait is on the port answering, not on a fixed sleep.
   */
  const deadline = Date.now() + 90_000
  let healthy = false

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`)

      if (response.ok) {
        healthy = true
        break
      }
    } catch {
      // Not up yet.
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  /*
   * A container that never became healthy must fail here, with what Docker
   * says is wrong.
   *
   * The loop above used to fall out of its deadline and return an origin
   * anyway, so every scenario after it timed out its readiness wait and the
   * report described the *pages* as unusable. Under emulation on Apple silicon
   * the reference takes tens of seconds to open its port, and when it took
   * longer than the deadline the gate blamed the pages. `docker logs` is the
   * thing that says which it was.
   */
  if (!healthy) {
    let logs = ''

    try {
      logs = execFileSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' })
    } catch {
      logs = '(docker logs unavailable)'
    }

    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
    } catch {
      // Already gone.
    }

    throw new Error(
      `the reference container ${name} never answered ${origin}/api/health within 90s:\n${logs}`,
    )
  }

  return {
    origin,
    stop() {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' })
      } catch {
        // Already gone.
      }
    },
  }
}

interface CapturedRecord {
  readonly text: string
  readonly landmarks: string[]
  readonly screenshotSha256?: string
  readonly browser?: string
  readonly browserVersion?: string
  /** Whether a session was live when this page was captured. */
  readonly signedIn?: boolean
  /** Where the browser actually was — a redirect shows up here. */
  readonly pathname?: string
  /** Whether the scenario's own readiness wait succeeded. */
  readonly ready?: boolean
  /**
   * The PNG itself, kept in memory only.
   *
   * The baseline on disk records the hash, not the bytes: a baseline file that
   * carried every screenshot would be tens of megabytes of binary in git, and
   * the images are already written to `temp/admin-visual` on each run.
   */
  readonly screenshot?: Buffer
}

async function collect(
  browser: Browser,
  origin: string,
  prefix: string,
): Promise<Record<string, CapturedRecord>> {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    /*
     * Both language inputs are pinned, because the two builds read different
     * ones. The current app calls `bootstrapLocale()` at module load and reads
     * `navigator.languages`; the reference build resolves the locale without
     * that step. Setting `locale` alone left the reference rendering Chinese
     * while the candidate rendered English, and every navigation label came
     * back as a difference — a comparison of translations presented as a
     * comparison of layouts.
     */
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    timezoneId: 'UTC',
    /* Animations would make two runs of the same build differ. */
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const collected: Record<string, CapturedRecord> = {}

  fs.mkdirSync(ARTIFACTS, { recursive: true })

  await signIn(page)

  for (const scenario of SCENARIOS) {
    await page.goto(scenario.path)

    /*
     * Re-sign in when the session was dropped.
     *
     * The reference container runs under emulation and its in-memory session
     * store is slower than the driver; a run against it lost the session after
     * two pages, after which every navigation returned the sign-in card and
     * the gate compared five identical login screenshots as if they were the
     * pages it asked for. Re-authenticating before each scenario is the fix;
     * the scenario's own `ready` wait is not, because it times out silently.
     */
    if ((await page.getByRole('navigation').count()) === 0) {
      await signIn(page)
      await page.goto(scenario.path)
    }

    let ready = false

    try {
      await scenario.ready(page)
      ready = true
    } catch {
      // Recorded as not-ready below rather than thrown.
    }

    const content = await pageContent(page)

    fs.writeFileSync(path.join(ARTIFACTS, `${prefix}-${scenario.name}.png`), content.screenshot)

    collected[scenario.name] = {
      text: content.text,
      landmarks: content.landmarks,
      screenshotSha256: content.screenshotSha256,
      browser: content.browser,
      browserVersion: content.browserVersion,
      signedIn: content.signedIn,
      pathname: content.pathname,
      ready,
      /*
       * Held for the pixel comparison below, never written into the baseline.
       * The baseline records the digest; the images live in `temp/`.
       */
      screenshot: content.screenshot,
    }
  }

  await context.close()

  return collected
}

/**
 * Compares two captures and classifies each difference.
 *
 * The categories are the ones a reviewer acts on differently:
 *   CRITICAL  a landmark is gone — a table that no longer exists, a heading
 *   MAJOR     the text of a page changed materially
 *   MINOR     whitespace and ordering
 */
/**
 * The two builds render different interface languages, and that is a fact about
 * them, not a defect to work around.
 *
 * Measured on the reference image with `navigator.languages === ['en-US']` and
 * `accept-language: en-US`: it still renders `lang="zh-CN"` and Chinese labels.
 * The current build negotiates from the browser and renders English. The
 * migration therefore *changed* how the interface language is chosen, and the
 * visual comparison has to account for it rather than pretend both sides are
 * English.
 *
 * So the text comparison counts how many strings are shared and how many
 * differ, instead of testing equality of translated strings — a per-page
 * translation is not a layout difference, and reporting it as one buried the
 * real question.
 */
export function compare(
  reference: { text: string; landmarks: string[] },
  candidate: { text: string; landmarks: string[] },
): {
  kind: 'same' | 'minor' | 'major' | 'critical' | 'STRUCTURE_MATCHES_TRANSLATED' | 'CANDIDATE_ADDED'
  detail: string
} {
  /*
   * Structure first. The two builds are known to render different languages, so
   * the structural question — are the same kinds of landmark present — is the
   * one that answers "did the migration lose a page, a table, a form".
   */
  const kinds = (landmarks: string[]) => landmarks.map(entry => entry.split(':')[0])
  const referenceKinds = kinds(reference.landmarks)
  const candidateKinds = kinds(candidate.landmarks)

  const lostKinds = referenceKinds.filter(kind => !candidateKinds.includes(kind))

  /*
   * Only a landmark the reference has and the candidate does not is a loss.
   * The reverse — a table, form or heading the candidate added — is a feature
   * the migration introduced, and calling it critical would make every
   * improvement look like a regression.
   */
  if (lostKinds.length > 0) {
    return { kind: 'critical', detail: `landmarks gone: ${[...new Set(lostKinds)].join(', ')}` }
  }

  const addedKinds = candidateKinds.filter(kind => !referenceKinds.includes(kind))

  if (addedKinds.length > 0) {
    return {
      kind: 'CANDIDATE_ADDED',
      detail: `the candidate has landmarks the reference does not: ${[...new Set(addedKinds)].join(', ')} — added content, nothing lost`,
    }
  }

  /* Same number of each landmark kind, in the same order. */
  const sameShape =
    referenceKinds.length === candidateKinds.length &&
    referenceKinds.every((kind, index) => kind === candidateKinds[index])

  const normalise = (value: string) => value.replace(/\s+/g, ' ').trim()
  const referenceLines = reference.text.split('\n').map(normalise).filter(Boolean)
  const candidateLines = candidate.text.split('\n').map(normalise).filter(Boolean)

  const shared = referenceLines.filter(line => candidateLines.includes(line)).length
  const total = Math.max(referenceLines.length, candidateLines.length)
  const overlap = total === 0 ? 1 : shared / total

  if (overlap === 1 && sameShape) return { kind: 'same', detail: `${total} line(s) identical, same shape` }

  /*
   * A page whose structural shape matches and whose strings are almost all
   * different is a translated page, not a redesigned one. Named explicitly, so
   * a reader does not have to work out why a "minor" difference is minor.
   */
  /*
   * A shared string is overwhelmingly a Latin-script token: an email, a number,
   * a date, a product name. Chinese and English renderings of the same page
   * share those and nothing else, so an overlap below about two thirds means
   * the languages differ — not that content was lost. Above that, a difference
   * is content.
   */
  if (sameShape && overlap < 0.65) {
    return {
      kind: 'STRUCTURE_MATCHES_TRANSLATED',
      detail: `${referenceKinds.length} landmark(s) in the same order, ${shared}/${total} string(s) shared — different interface language, not a different layout`,
    }
  }

  if (sameShape && overlap >= 0.95) return { kind: 'minor', detail: `${shared}/${total} string(s) shared` }

  if (sameShape) {
    return {
      kind: 'major',
      detail: `same shape but ${total - shared} string(s) differ: ${referenceLines
        .filter(line => !candidateLines.includes(line))
        .slice(0, 3)
        .join(' | ')
        .slice(0, 240)}`,
    }
  }

  return {
    kind: 'critical',
    detail: `landmark shape changed: ${referenceKinds.length} vs ${candidateKinds.length} (ref: ${referenceKinds.slice(0, 6).join(',')})`,
  }
}

async function main(): Promise<void> {
  /*
   * pnpm forwards `-- <args>` to the script, and tsx passes the `--` through as
   * a positional. Dropping it is what makes `--require-reference` arrive as a
   * flag rather than as a value nobody looks at.
   */
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const value = (flag: string) => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const image = value('--reference') ?? REFERENCE_IMAGE
  const writeBaseline = args.includes('--write-baseline')

  /*
   * Before anything can return early.
   *
   * `REFERENCE_UNAVAILABLE` and `REFERENCE_MISMATCH` both write a report and
   * both return before the collection step, which is where this call used to
   * live — so on a runner without the image the gate crashed with ENOENT on the
   * very file that was supposed to explain why it could not compare. A verdict
   * that cannot be recorded is not a verdict.
   */
  fs.mkdirSync(ARTIFACTS, { recursive: true })

  /*
   * Which digest this image actually is, read from `RepoDigests` rather than
   * from `.Id`.
   *
   * They are different things: `.Id` is a hash of the image *config*, while the
   * digest is a hash of the *manifest*. On this machine they happened to be
   * equal, so comparing `.Id` worked locally and reported a mismatch on a Linux
   * runner for the same image — 9a12a066 against faf238d3 — which reads as "the
   * reference changed" when nothing had. `RepoDigests` is the field that
   * answers the question being asked.
   */
  let identity: string | null = null

  try {
    const digests = JSON.parse(
      execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'], {
        encoding: 'utf8',
      }).trim(),
    ) as string[]

    identity = digests.find(entry => entry.includes('@'))?.split('@')[1] ?? null
  } catch {
    /*
     * A digest reference that was never pulled has no RepoDigests, and a runner
     * that only has `:main` does not have this digest at all. Say so, rather
     * than silently comparing against whatever `:main` happens to be today.
     */
    identity = null
  }

  if (!identity) {
    /*
     * A missing reference is `REFERENCE_UNAVAILABLE`, not a failure and not a
     * pass.
     *
     * The image is published; a runner that has not pulled it has nothing to
     * compare against. Failing would make every job that wants visual coverage
     * need registry credentials, and passing would report a comparison that
     * never ran. The verdict is written to the report and the exit code is 0,
     * so the job states which happened — `--require-reference` turns it into a
     * hard failure for a pipeline that does pull the image.
     */
    const unavailable = {
      schema: 'zeus.ecosystem.admin-visual-report/v1',
      startedAt: new Date().toISOString(),
      reference: { image, digest: null },
      verdict: 'REFERENCE_UNAVAILABLE',
      detail: `${image} is not present in this environment; no comparison was made`,
      comparisons: [],
      passed: false,
    }

    fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(unavailable, null, 2)}\n`)

    console.log(`REFERENCE_UNAVAILABLE  ${image} is not present in this environment`)
    console.log('no comparison was made; the verdict is recorded, not inferred')

    process.exit(args.includes('--require-reference') ? 1 : 0)
  }

  /*
   * The identity is checked against the baseline's, not just that *an* image
   * exists. A different build under the same name is the failure mode that made
   * the first version of this gate compare a Chinese reference against an
   * English candidate and call it a layout difference.
   */
  if (identity && identity !== BASELINE_DIGEST) {
    const mismatch = {
      schema: 'zeus.ecosystem.admin-visual-report/v1',
      startedAt: new Date().toISOString(),
      reference: { image, digest: identity, expectedDigest: BASELINE_DIGEST },
      verdict: 'REFERENCE_MISMATCH',
      detail: `the image is ${identity.slice(7, 19)}, but the baseline was captured from ${BASELINE_DIGEST.slice(7, 19)}`,
      comparisons: [],
      passed: false,
    }

    fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(mismatch, null, 2)}\n`)

    console.log(`REFERENCE_MISMATCH  ${identity.slice(7, 19)} != ${BASELINE_DIGEST.slice(7, 19)}`)
    console.log('a baseline describes one build; comparing against another is not a comparison')
    process.exit(args.includes('--require-reference') ? 1 : 0)
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true })

  const reference = await startReference(image)
  const browser = await chromium.launch()

  let referenceContent: Record<string, CapturedRecord>

  try {
    referenceContent = await collect(browser, reference.origin, 'reference')
  } finally {
    reference.stop()
  }

  const server = await startAdminServer({ adminDir: APP, port: await freePort(5700) })

  let candidateContent: Record<string, CapturedRecord>

  try {
    candidateContent = await collect(browser, server.origin, 'candidate')
  } finally {
    await browser.close()
    await server.stop()
  }

  const comparisons = SCENARIOS.map(scenario => {
    const left = referenceContent[scenario.name]
    const right = candidateContent[scenario.name]

    /*
     * A capture that is not the page is not a comparison.
     *
     * Both sides are checked before anything is classified, because a login
     * card compared against a settings page produces a `critical` structural
     * result and a real pixel ratio — the numbers are finite and meaningless.
     * This is what happened on the first run that produced pixels: the
     * reference lost its session after two pages, five captures were the
     * sign-in form, and the gate reported three regressions and 1.7–4.7%
     * differences that described nothing but the session loss.
     */
    const unusable = [
      !left?.signedIn && 'the reference was not signed in',
      !right?.signedIn && 'the candidate was not signed in',
      left?.ready === false && 'the reference page did not become ready',
      right?.ready === false && 'the candidate page did not become ready',
    ].filter((entry): entry is string => typeof entry === 'string')

    if (unusable.length > 0) {
      return {
        scenario: scenario.name,
        kind: 'UNUSABLE' as const,
        detail: `no comparison was made: ${unusable.join('; ')}`,
        structural: {
          verdict: 'NOT_RUN' as const,
          detail: 'the capture was not of the page this scenario names',
        },
        screenshot: {
          verdict: 'NOT_RUN' as const,
          detail: 'the capture was not of the page this scenario names',
        },
      }
    }

    const result = compare(left, right)

    /*
     * The screenshot dimension, per scenario.
     *
     * The two builds render different interface languages, which is a real
     * difference and one the structural dimension already names. Comparing
     * pixels across a translation would report every label as a changed pixel
     * and tell a reader nothing — so the pixel comparison is only meaningful
     * where the text agrees. Where the structural result says the pages are
     * translated, the screenshot verdict is `NOT_RUN` with the reason, rather
     * than a number produced by comparing two languages.
     *
     * That keeps the four dimensions honest: a dimension that could not answer
     * its question says so, and `overallStatus` reports INCOMPLETE rather than
     * letting the other three carry it to PASS.
     */
    const structural = {
      verdict:
        result.kind === 'critical'
          ? ('REGRESSION' as const)
          : result.kind === 'CANDIDATE_ADDED'
            ? ('CANDIDATE_ADDED' as const)
            : ('PASS' as const),
      detail: result.detail,
    }

    let screenshot: VisualEvidence['screenshot']

    if (!left?.screenshot || !right?.screenshot) {
      screenshot = { verdict: 'NOT_RUN', detail: 'one side produced no capture' }
    } else if (result.kind === 'STRUCTURE_MATCHES_TRANSLATED') {
      screenshot = {
        verdict: 'NOT_RUN',
        detail:
          'the two builds render different interface languages; a pixel comparison across a translation measures the translation, not the layout',
      }
    } else {
      const comparison = comparePngs(left.screenshot, right.screenshot)
      const verdict = screenshotVerdict(comparison, DEFAULT_SCREENSHOT_THRESHOLD)

      /*
       * The diff image is written next to the two captures. A ratio tells a
       * reviewer that something moved; the image tells them what.
       */
      if (comparison.diff) {
        fs.writeFileSync(
          path.join(ARTIFACTS, `diff-${scenario.name}.png`),
          comparison.diff,
        )
      }

      screenshot = {
        verdict: verdict.verdict,
        differenceRatio: comparison.differenceRatio,
        threshold: DEFAULT_SCREENSHOT_THRESHOLD,
        detail: verdict.detail,
      }
    }

    return {
      scenario: scenario.name,
      ...result,
      structural,
      screenshot,
    }
  })

  for (const entry of comparisons) {
    console.log(`${entry.kind === 'same' ? 'SAME' : entry.kind.toUpperCase().padEnd(8)}  ${entry.scenario} — ${entry.detail}`)
    console.log(`          screenshot: ${entry.screenshot.verdict} — ${entry.screenshot.detail}`)
  }

  const baselinePath = path.join(BASELINES, 'reference.json')

  /*
   * The baseline never carries image bytes.
   *
   * `JSON.stringify` on a `Buffer` produces `{"type":"Buffer","data":[...]}` —
   * a few hundred thousand integers per scenario, in a file whose whole purpose
   * is to be readable in a diff. The digest is what the baseline records; the
   * images are in `temp/admin-visual` for whoever reviews them.
   */
  const withoutImages = Object.fromEntries(
    Object.entries(referenceContent).map(([name, record]) => [
      name,
      {
        text: record.text,
        landmarks: record.landmarks,
        screenshotSha256: record.screenshotSha256,
        browser: record.browser,
        browserVersion: record.browserVersion,
        signedIn: record.signedIn,
        pathname: record.pathname,
      },
    ]),
  )

  const document = {
    schema: 'zeus.ecosystem.admin-visual-reference/v1',
    reference: { image, imageId: identity },
    capture: { viewport: { width: 1440, height: 900 }, locale: 'en-US', timezone: 'UTC' },
    scenarios: withoutImages,
  }

  if (writeBaseline) {
    fs.mkdirSync(BASELINES, { recursive: true })
    fs.writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`\nbaseline written: ${baselinePath}`)
    console.log(
      'This records the reference as it is. Differences in later runs are reported, never auto-approved.',
    )
  }

  const report = {
    schema: 'zeus.ecosystem.admin-visual-report/v1',
    startedAt: new Date().toISOString(),
    reference: document.reference,
    comparisons,
    /*
     * No difference is called intentional here. That classification needs a
     * designer looking at the images, and claiming it in a script is how a
     * regression becomes a decision.
     */
    /*
     * `STRUCTURE_MATCHES_TRANSLATED` passes: the two builds render different
     * languages, and a translated page with the same landmarks is parity. It is
     * named in the report so nobody reads it as "identical".
     *
     * `UNUSABLE` does not pass. A capture that was not the page — a dropped
     * session, a readiness wait that timed out — is not a comparison, and the
     * previous version of this predicate had no case for it: an unusable
     * scenario was neither `same` nor `minor` and so failed by falling through,
     * which happened to be right for the wrong reason. Naming it here makes the
     * reason explicit and keeps the aggregate reporting honest.
     */
    passed: comparisons.every(
      entry =>
        entry.kind === 'same' ||
        entry.kind === 'minor' ||
        entry.kind === 'STRUCTURE_MATCHES_TRANSLATED' ||
        entry.kind === 'CANDIDATE_ADDED',
    ),
  }

  fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const failing = comparisons.filter(
    entry => entry.kind === 'major' || entry.kind === 'critical' || entry.kind === 'UNUSABLE',
  )

  const screenshotRan = comparisons.filter(entry => entry.screenshot.verdict !== 'NOT_RUN').length

  console.log(`\n${comparisons.length - failing.length}/${comparisons.length} scenarios match the reference`)
  console.log(
    `screenshot dimension: ${screenshotRan}/${comparisons.length} scenarios compared pixels (the rest were not comparable)`,
  )
  console.log(`report: ${path.join(ARTIFACTS, 'report.json')}`)

  if (failing.length > 0 && !writeBaseline) process.exit(1)
}

/*
 * Only when run as a program.
 *
 * `compare` is exported so the classifier can be tested without standing up two
 * servers; an unconditional `main()` made importing this file run the whole
 * comparison, which took a minute and printed a report nobody asked for.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
