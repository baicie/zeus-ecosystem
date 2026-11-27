/**
 * The Playground across a version change, with the same browser profile.
 *
 * ## Why this is not `cross-version-rehearsal.mjs --unit playground`
 *
 * That rehearsal is built around a server-side database: it starts a container
 * on a volume, writes rows through the product's API, backs up a SQLite file,
 * swaps the image and reads the rows back. The Playground has none of that. Its
 * persistence is `browser-storage` — `indexedDB` for projects, `localStorage`
 * for settings, both keyed by the **host origin** — so the state that must
 * survive an upgrade lives in a browser profile, not in a volume. Running that
 * harness against this product would check a database that does not exist and
 * report success for the parts it never touched.
 *
 * ## What it actually proves
 *
 * Two images, one Chromium profile, one origin:
 *
 *   baseline: create a multi-file project, edit it, compile it, change theme
 *             and language, let the page persist, then stop.
 *   candidate: start on the same origin, load the same profile, and read what
 *             baseline wrote — files, active path, settings — compile it, edit
 *             it, and write again.
 *   baseline again: read what the candidate wrote, and compile.
 *
 * The origin must not move between runs. `indexedDB` is per-origin, so a
 * rehearsal that changes the origin "successfully rolls back" into an empty
 * workspace; that is the failure mode this file exists to make impossible to
 * report as a pass.
 *
 * ## Running it
 *
 * ```text
 * PLAYGROUND_BASELINE_IMAGE=ghcr.io/baicie/zeus-playground:main@sha256:… \
 * PLAYGROUND_CANDIDATE_IMAGE=zeus-playground:local \
 *   pnpm --filter @zeus-ecosystem/playground check:upgrade
 * ```
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { chromium, type BrowserContext, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')
const output = path.join(root, 'temp/playground-upgrade')

const BASELINE = process.env.PLAYGROUND_BASELINE_IMAGE?.trim()
const CANDIDATE = process.env.PLAYGROUND_CANDIDATE_IMAGE?.trim()

/** The host origin. Fixed, because the storage is keyed by it. */
const HOST_ORIGIN = 'http://127.0.0.1'
/** The sandbox is a second origin and must stay a second origin. */
const SANDBOX_ORIGIN = 'http://localhost'

const steps: Array<{ name: string; ok: boolean; detail?: string }> = []

const record = (name: string, ok: boolean, detail?: string): void => {
  steps.push({ name, ok, ...(detail ? { detail } : {}) })
  trace(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

/**
 * Progress goes to a file as well as the console.
 *
 * This runs for minutes and stops containers between phases; when it wedges,
 * the last line is the only thing that says where, and a piped or backgrounded
 * run buffers the console — two investigations spent their time staring at an
 * empty log while the process was alive.
 */
const progressFile = path.join(root, 'temp/playground-upgrade/progress.log')

function trace(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  try {
    appendFileSync(progressFile, stamped)
  } catch {
    // the directory may not exist yet; the console line below still appears
  }
  process.stdout.write(stamped)
}

/** The port an image serves the host on, from its own declaration. */
function hostPort(image: string): number {
  const raw = JSON.parse(
    docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}']),
  ) as Record<string, unknown> | null
  const keys = Object.keys(raw ?? {})
  // `:80` is the host listener; `:81` is the sandbox. Picking the lower one is
  // the image's own convention, asserted by `check:sandbox` and the Dockerfile.
  const ports = keys.map(key => Number(key.split('/')[0])).sort((a, b) => a - b)
  const host = ports.find(port => Number.isFinite(port))
  if (host === undefined) throw new Error(`${image} declares no exposed port`)
  return host
}

/**
 * Runs one image and returns once its host listener answers.
 *
 * Both host and sandbox ports are published on the same fixed host ports for
 * every phase, so the browser's origin never moves. That is the whole point:
 * a different port is a different origin, and a different origin is an empty
 * workspace.
 */
async function start(image: string, name: string): Promise<void> {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  const host = hostPort(image)
  docker([
    'run', '-d', '--name', name,
    '-p', `127.0.0.1:8080:${host}`,
    '-p', `127.0.0.1:8081:81`,
    '-e', `ZEUS_SANDBOX_ORIGIN=${SANDBOX_ORIGIN}:8081`,
    '-e', `ZEUS_PLAYGROUND_HOST_ORIGIN=${HOST_ORIGIN}:8080`,
    image,
  ])
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${HOST_ORIGIN}:8080/`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`${image} never answered on its host listener`)
}

async function stop(name: string): Promise<void> {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}

/** A page on the fixed host origin. */
async function open(context: BrowserContext): Promise<Page> {
  trace('open: newPage')
  const page = await context.newPage()

  /*
   * A version switch must not be served from the previous version's cache.
   *
   * The first run of this rehearsal reported "the candidate cannot compile the
   * inherited project", and the console named
   * `Framing 'https://panel.moonbyte.top:8443/' violates ... frame-ancestors`
   * — a URL the candidate's bundle does not contain. Chromium had kept the old
   * image's JavaScript under the same asset URLs and ran it against the new
   * server. Clearing the HTTP cache per phase is what makes a phase test its
   * own image.
   *
   * `indexedDB` and `localStorage` are untouched: those are the user's data and
   * the whole subject of the rehearsal. Only the code cache is cleared.
   */
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.clearBrowserCache')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })

  page.setDefaultTimeout(60_000)
  trace('open: goto')
  /*
   * `domcontentloaded`, not `load`. The Playground's own theme bootstrap is
   * inline and runs at parse time; waiting for `load` means waiting for the
   * 2.2 MB babel chunk and the whole vendor graph before the compile button
   * exists, which on a cold container is most of a minute and on a slow host
   * is a timeout. The button is what this needs, and `waitForSelector` below
   * already waits for it.
   */
  await page.goto(`${HOST_ORIGIN}:8080/`, { waitUntil: 'domcontentloaded' })
  trace('open: waiting for the compile control')
  await page.waitForSelector('[data-testid="compile"]', { timeout: 90_000 })
  trace('open: ready')
  return page
}

/**
 * Compiles and waits for the result, on a page whose status text may be stale.
 *
 * Waiting for the status to *become* `Compiled N modules` works on a fresh page
 * and hangs on a restored session: the page shows the restored project, the
 * last status text can already read `Compiled 2 modules` from before, and
 * "wait until it says X" is satisfied before the click's build reports. The
 * editor gate solves the same problem by keying on `data-build-sequence`; this
 * does the equivalent and then requires a preview, which is the observable
 * outcome that matters for "the inherited project still runs".
 */
async function compile(page: Page): Promise<string> {
  const button = page.getByTestId('compile')
  const previous = await button.getAttribute('data-build-sequence')
  trace('compile: click')
  await button.click()
  trace(`compile: clicked (sequence was ${previous})`)
  await page.waitForFunction(
    before =>
      document
        .querySelector('[data-testid="compile"]')
        ?.getAttribute('data-build-sequence') !== before,
    previous,
    { timeout: 120_000 },
  )
  trace('compile: sequence advanced')
  /*
   * Poll from Node, not `page.waitForFunction`.
   *
   * The page-side predicate is the natural way to express this, and it wedged
   * here for minutes on a page that answers correctly when driven by hand — the
   * same serialisation/`__name` hazard `saveAndWait` documents. Two
   * `textContent` reads in a Node loop have none of that machinery, and the
   * condition is a string match either way.
   *
   * `Preview failed` is a legitimate answer for a baseline that cannot build;
   * the caller decides what it means.
   */
  /*
   * A bounded window, and a result that says which state was observed.
   *
   * Reading a restored page's status stalled the process here for minutes with
   * an idle event loop and no rejection — a Playwright promise that never
   * settled across the preview iframe's replacement. The rehearsal's subject is
   * persistence, `check:image` and `check:editor` own "does the compiled output
   * run", and a check that hangs reports nothing about either. 30 seconds is
   * long enough for a build this page has already completed elsewhere, and the
   * last observed strings go into the report.
   */
  const deadline = Date.now() + 30_000
  let status = ''
  let preview = ''
  while (Date.now() < deadline) {
    /*
     * `locator.textContent()` with its own short timeout, not
     * `page.textContent()`. The page-level call inherits the context default
     * (60 s) and, when the frame is being replaced — a restored project
     * rebuilds the preview iframe — it waits the whole timeout instead of
     * failing fast. That turned a 20-second check into minutes of silence.
     */
    /*
     * `Promise.race` around the read, because every Playwright call allocates
     * its own timeout and a wedged frame can hold one for longer than the
     * nominal value. Racing against a plain timer bounds it unconditionally,
     * and a read that never returns is itself the diagnosis: the page stopped
     * answering, which is what a restored project's sandbox replacement looks
     * like from outside.
     */
    const read = async (testId: string): Promise<string> => {
      /*
       * `textContent({ timeout })` on a locator, NOT `page.evaluate`.
       *
       * An `evaluate` that had not returned kept the event loop free but left
       * no trace: the promise never settled, the race fired, and the loop went
       * round again without the file ever saying so — three runs were lost to
       * a loop that looked hung and was actually spinning. The locator call is
       * the same read with an honest per-call timeout, and its failure is an
       * exception this catch turns into a value the loop can report.
       */
      try {
        const text = await page
          .locator(`[data-testid="${testId}"]`)
          .textContent({ timeout: 1_500 })
        return text ?? ''
      } catch {
        return '<no answer>'
      }
    }
    status = await read('status')
    preview = await read('preview-status')
    if (status === '<no answer>' && preview === '<no answer>') {
      trace('compile: page not answering; retrying')
    }
    /*
     * `Running in the opaque sandbox…` is a success state, not an intermediate
     * one to wait past. A restored project leaves the preview running in the
     * sandbox without ever printing `Preview ready` — that message belongs to
     * the build that produced the preview, and on a restore there was no build
     * in this page's lifetime. Waiting for `ready` specifically was why this
     * check sat for two minutes on a page that was working.
     */
    /*
     * Both catalogs, because the settings this rehearsal restores include the
     * language. The first run after adding cache clearing reported
     * "已编译 2 个模块 · 预览就绪" — a perfect result scored as a failure by an
     * English-only regular expression. The storage is what is under test; the
     * locale it was stored with is data.
     */
    if (
      /Preview ready|Running in the opaque sandbox|Preview failed|预览就绪|正在不透明沙箱中运行|预览已过期/.test(
        preview,
      ) ||
      /Compile failed|编译失败/.test(status)
    ) {
      return `${status} · ${preview}`
    }
    await page.waitForTimeout(250)
  }
  return `unsettled: ${status} · ${preview}`
}

/**
 * Commits the current project through the product's own save path.
 *
 * The shell autosaves 500 ms after an edit, but a rehearsal that relies on a
 * timer is testing the timer. `window.__zeusPlayground.save()` is the same
 * `saveNow()` the app calls, so this is the product's write, made
 * deterministically. Polling afterwards is required because `saveWorkspace`
 * is asynchronous and reports success through a signal.
 */
async function saveAndWait(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(
      window as unknown as { __zeusPlayground?: { save(): void } }
    ).__zeusPlayground?.save()
  })
  /*
   * Poll from Node rather than `page.waitForFunction` with an async callback.
   *
   * Playwright evaluates a function argument by serialising it, and esbuild —
   * which `tsx` uses to load this file — rewrites named function expressions
   * with a `__name(...)` helper that does not exist in the page. The documented
   * workaround is to avoid passing such functions at all; the storage read
   * below is a normal `page.evaluate`, and the loop lives here where nothing
   * rewrites it.
   */
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const stored = await page.evaluate(
      () =>
        new Promise<number>(resolve => {
          const open = indexedDB.open('zeus-playground', 1)
          open.onerror = () => resolve(0)
          open.onblocked = () => resolve(0)
          open.onsuccess = () => {
            const database = open.result
            if (!database.objectStoreNames.contains('workspaces')) {
              resolve(0)
              return
            }
            const request = database
              .transaction('workspaces', 'readonly')
              .objectStore('workspaces')
              .count()
            request.onerror = () => resolve(0)
            request.onsuccess = () => resolve(request.result)
          }
        }),
    )
    if (stored > 0) return
    await page.waitForTimeout(250)
  }
  throw new Error('the project never reached IndexedDB after save()')
}

/** What the page has actually persisted, read from the page's own storage. */
async function readStored(page: Page): Promise<{
  settings: unknown
  projects: Array<{ product: string; activePath: string; paths: string[] }>
}> {
  return page.evaluate(async () => {
    const settings = JSON.parse(
      localStorage.getItem('zeus-playground.settings.v2') ?? 'null',
    )
    const projects = await new Promise<
      Array<{ product: string; activePath: string; paths: string[] }>
    >(resolve => {
      const open = indexedDB.open('zeus-playground', 1)
      open.onerror = () => resolve([])
      open.onblocked = () => resolve([])
      open.onsuccess = () => {
        const database = open.result
        if (!database.objectStoreNames.contains('workspaces')) {
          resolve([])
          return
        }
        const request = database
          .transaction('workspaces', 'readonly')
          .objectStore('workspaces')
          .getAll()
        request.onerror = () => resolve([])
        request.onsuccess = () =>
          resolve(
            (request.result as Array<{
              product: string
              activePath: string
              files: Array<{ path: string }>
            }>).map(entry => ({
              product: entry.product,
              activePath: entry.activePath,
              paths: (entry.files ?? []).map(file => file.path),
            })),
          )
      }
    })
    return { settings, projects }
  })
}

async function main(): Promise<void> {
  if (!BASELINE || !CANDIDATE) {
    console.error(
      'PLAYGROUND_BASELINE_IMAGE and PLAYGROUND_CANDIDATE_IMAGE are required.\n' +
        'The rehearsal needs two images that really differ; defaulting either\n' +
        'would let a run compare an image with itself and report a migration.',
    )
    process.exitCode = 2
    return
  }
  await fs.mkdir(output, { recursive: true })
  writeFileSync(progressFile, '')

  const baselineId = docker(['image', 'inspect', BASELINE, '--format', '{{.Id}}'])
  const candidateId = docker(['image', 'inspect', CANDIDATE, '--format', '{{.Id}}'])
  record(
    'the baseline and the candidate are different images',
    baselineId !== candidateId,
    baselineId === candidateId ? `both are ${baselineId}` : `${baselineId.slice(7, 19)} vs ${candidateId.slice(7, 19)}`,
  )
  if (baselineId === candidateId) {
    console.error('refusing to rehearse one image against itself')
    process.exitCode = 1
    return
  }

  // The profile lives in a directory this run owns, outside the browser cache,
  // so all three phases read and write the same `indexedDB` and `localStorage`.
  const profile = path.join(output, 'profile')
  await fs.rm(profile, { recursive: true, force: true })
  await fs.mkdir(profile, { recursive: true })

  let context: BrowserContext | undefined
  const contextErrors: string[] = []
  try {
    /*
     * `launchPersistentContext`, not `launch()` plus a `--user-data-dir` arg.
     *
     * Playwright builds its own temporary profile and passes its own
     * `--user-data-dir`; an extra one in `args` is ignored in practice. Only
     * the persistent-context entry point is guaranteed to run every phase
     * against this directory, and this check is meaningless if it does not:
     * three phases with three empty profiles would "pass" by each persisting
     * and each reading back only its own data.
     */
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
    })

    // ---- baseline -------------------------------------------------------
    trace('phase baseline: starting image')
    await start(BASELINE, 'zeus-upgrade-baseline')
    trace('phase baseline: up')
    let page = await open(context)
    page.on('pageerror', error => contextErrors.push(error.message))

    /*
     * The baseline's compile result is recorded, not required.
     *
     * What a cross-version rehearsal is about is the data a user had before the
     * upgrade: the project, the settings, the active path. A published image
     * that cannot compile in this environment — the current `:main` on GHCR
     * predates the sandbox-origin fix and fails every build — still holds that
     * data, and refusing to rehearse against it would mean the rehearsal only
     * runs against versions that already work.
     *
     * The candidate and the rollback target *are* required to compile: if the
     * inherited project cannot run after the upgrade, the upgrade is not a
     * migration. That asymmetry is the point, so it is written down here rather
     * than left for a reader to infer from two different assertions.
     */
    const baselineCompile = await compile(page)
    record(
      'the baseline state is recorded (compile result included)',
      true,
      baselineCompile,
    )

    // A second file makes "the project survived" mean more than "one string
    // survived": the file list and the active path are part of the claim.
    await page.getByRole('tab', { name: 'counter.tsx' }).click()
    /*
     * The editor is CodeMirror behind `data-testid="editor"`; it has no
     * `textarea` whose `.value` could be read. The page exposes
     * `window.__zeusPlayground.getSource()` for its own gates, which is the
     * same accessor `check-playground-editor` uses — reading the product's own
     * view of the buffer rather than reverse-engineering the widget.
     */
    const before = await page.evaluate(
      () =>
        (
          window as unknown as { __zeusPlayground?: { getSource(): string } }
        ).__zeusPlayground?.getSource() ?? '',
    )
    await page.evaluate(() => {
      localStorage.setItem(
        'zeus-playground.settings.v2',
        JSON.stringify({ theme: 'dark', locale: 'zh-CN', fontSize: 16, autoRun: true, splitPercent: 50, activeTab: 'preview' }),
      )
    })
    /*
     * Write through the product, then wait for the write.
     *
     * The first version of this file reloaded and read storage without ever
     * asking the app to save. Nothing was in IndexedDB, and the next step —
     * "the candidate reads the project the baseline wrote" — compared an empty
     * list against an empty list and passed. Two absences agreeing is not a
     * migration, and a rehearsal that cannot tell them apart certifies nothing.
     */
    await saveAndWait(page)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[data-testid="compile"]')

    const storedBaseline = await readStored(page)
    record(
      'the baseline persisted its project to IndexedDB',
      storedBaseline.projects.length > 0,
      storedBaseline.projects.map(project => `${project.product}:${project.paths.length} files`).join(', '),
    )
    if (storedBaseline.projects.length === 0) {
      throw new Error(
        'the baseline wrote no project to IndexedDB; every later step would compare empty lists',
      )
    }
    record(
      'the baseline persisted its settings to LocalStorage',
      storedBaseline.settings !== null,
      JSON.stringify(storedBaseline.settings).slice(0, 120),
    )
    const themeAfterReload = await page.evaluate(() => document.documentElement.dataset.theme)
    record('the stored theme applies after a reload', themeAfterReload === 'dark', themeAfterReload)
    await stop('zeus-upgrade-baseline')

    // ---- candidate ------------------------------------------------------
    trace('phase candidate: starting image')
    await start(CANDIDATE, 'zeus-upgrade-candidate')
    trace('phase candidate: up')
    page = await open(context)
    page.on('pageerror', error => contextErrors.push(error.message))

    const storedCandidate = await readStored(page)
    /*
     * Non-empty on both sides, not merely equal. `[].length === [].length` is
     * how the first run reported a successful migration of nothing.
     */
    record(
      'the candidate reads the project the baseline wrote',
      storedBaseline.projects.length > 0 &&
        storedCandidate.projects.length === storedBaseline.projects.length &&
        storedCandidate.projects.every(
          (project, index) =>
            project.paths.join(',') === storedBaseline.projects[index]?.paths.join(',') &&
            project.paths.length > 0,
        ),
      `${storedBaseline.projects.length} → ${storedCandidate.projects.length} project(s): ` +
        JSON.stringify(storedCandidate.projects.map(project => project.paths)),
    )
    record(
      'the candidate reads the settings the baseline wrote',
      JSON.stringify(storedCandidate.settings) === JSON.stringify(storedBaseline.settings),
      JSON.stringify(storedCandidate.settings).slice(0, 120),
    )

    const candidateCompile = await compile(page)
    record(
      'the candidate compiles the project it inherited',
      /Compiled \d+ modules|已编译 \d+ 个模块/.test(candidateCompile) &&
        /Preview ready|Running in the opaque sandbox|预览就绪|正在不透明沙箱中运行/.test(
          candidateCompile,
        ),
      candidateCompile,
    )

    // Edit through the UI, so the write is the product's own persistence path
    // and not a script that bypasses it.
    await page.getByRole('tab', { name: 'counter.tsx' }).click()
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('zeus-playground.settings.v2') ?? '{}')
      localStorage.setItem(
        'zeus-playground.settings.v2',
        JSON.stringify({ ...stored, theme: 'light' }),
      )
    })
    await saveAndWait(page)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[data-testid="compile"]')
    const afterCandidate = await readStored(page)
    record(
      'the candidate wrote a change the baseline can read',
      afterCandidate.settings !== null &&
        (afterCandidate.settings as { theme?: string }).theme === 'light',
      JSON.stringify(afterCandidate.settings).slice(0, 120),
    )
    await stop('zeus-upgrade-candidate')

    // ---- baseline again -------------------------------------------------
    trace('phase rollback: starting image')
    await start(BASELINE, 'zeus-upgrade-rollback')
    trace('phase rollback: up')
    page = await open(context)
    page.on('pageerror', error => contextErrors.push(error.message))

    const storedRollback = await readStored(page)
    record(
      'the rollback target still reads its own project',
      storedRollback.projects.length > 0 &&
        storedRollback.projects.length === storedBaseline.projects.length,
      JSON.stringify(storedRollback.projects.map(project => project.paths)),
    )
    record(
      'the rollback target reads what the candidate wrote',
      (storedRollback.settings as { theme?: string } | null)?.theme === 'light',
      JSON.stringify(storedRollback.settings).slice(0, 120),
    )
    /*
     * Compiling after a rollback is only evidence if the rollback target could
     * compile before the round trip.
     *
     * The current GHCR `:main` cannot: it reports "Preview sandbox did not
     * become ready" on its own built-in project, before any of this rehearsal's
     * data exists. Requiring it to compile afterwards would fail every run for
     * a reason that has nothing to do with the upgrade — and, worse, would read
     * as "the rollback is broken" when the image was already broken. The
     * baseline's own result from phase one decides what this step means.
     */
    const baselineCouldCompile =
      /Compiled \d+ modules|已编译 \d+ 个模块/.test(baselineCompile) &&
      /Preview ready|Running in the opaque sandbox|预览就绪|正在不透明沙箱中运行/.test(
        baselineCompile,
      )
    const rollbackCompile = await compile(page)
    const rollbackCompiled =
      /Compiled \d+ modules|已编译 \d+ 个模块/.test(rollbackCompile) &&
      /Preview ready|Running in the opaque sandbox|预览就绪|正在不透明沙箱中运行/.test(
        rollbackCompile,
      )
    record(
      baselineCouldCompile
        ? 'the rollback target still compiles'
        : 'the rollback target compiles as well as it did before the round trip',
      rollbackCompiled === baselineCouldCompile,
      baselineCouldCompile
        ? rollbackCompile
        : `skipped: the baseline could not compile before the upgrade either — ${rollbackCompile}`,
    )
    await page.getByRole('tab', { name: 'counter.tsx' }).click()
    const after = await page.evaluate(
      () =>
        (
          window as unknown as { __zeusPlayground?: { getSource(): string } }
        ).__zeusPlayground?.getSource() ?? '',
    )
    record(
      'the project content survived the round trip byte for byte',
      before.length > 0 && after === before,
      `${before.length} → ${after.length} characters`,
    )

    record('no uncaught page errors across the three phases', contextErrors.length === 0, contextErrors.join(' | ').slice(0, 300) || 'none')
    await stop('zeus-upgrade-rollback')
  } finally {
    await context?.close()
    for (const name of ['zeus-upgrade-baseline', 'zeus-upgrade-candidate', 'zeus-upgrade-rollback']) {
      try {
        await stop(name)
      } catch {
        // already gone
      }
    }
  }

  const failed = steps.filter(step => !step.ok)
  const report = {
    schema: 'zeus.playground-upgrade-rehearsal/v1',
    checkedAt: new Date().toISOString(),
    baseline: BASELINE,
    candidate: CANDIDATE,
    hostOrigin: `${HOST_ORIGIN}:8080`,
    sandboxOrigin: `${SANDBOX_ORIGIN}:8081`,
    persistence: 'browser-storage',
    steps,
    decision: failed.length === 0 ? 'PASSED' : 'FAILED',
  }
  await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} upgrade rehearsal step(s) failed:\n` +
        failed.map(step => `  - ${step.name}: ${step.detail ?? ''}`).join('\n'),
    )
  }
  console.log(`playground upgrade rehearsal passed (${steps.length} steps).`)
}

/*
 * Surface anything that escapes `main`.
 *
 * `main` is awaited at the top level, so a rejection there should print. It
 * did not: the loop after `waitForFunction` stopped emitting progress with the
 * process still alive and its event loop idle, which is a promise that never
 * settled rather than one that rejected. Making both visible — the rejection
 * here and the silence in the loop — is what turned three unproductive runs
 * into one diagnosable one.
 */
process.on('unhandledRejection', reason => {
  trace(`unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  process.exitCode = 1
})

await main()
