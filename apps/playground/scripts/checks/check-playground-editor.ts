import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  chromium,
  expect,
  firefox,
  webkit,
  type Browser,
  type Page,
} from '@playwright/test'


const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const example = root
const dist = path.join(example, 'dist')
/**
 * One directory per run, never the previous run's.
 *
 * The output used to be `temp/playground-editor/` and was reused for every
 * run. A failed run left its archives behind, and the next run's report could
 * be read next to a ZIP that came from a different commit — while the export
 * verification extracts into that same tree, so an install that failed early
 * could be inspected against the previous run's files. `latest` is a pointer
 * for humans; `runId` is what the report and every artifact path carry.
 */
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const output = path.join(root, 'temp/playground-editor/runs', runId)
const latestPointer = path.join(root, 'temp/playground-editor/latest')
const engines = { chromium, firefox, webkit }
const requestedBrowsers = (
  process.env.PLAYGROUND_BROWSERS ?? 'chromium,firefox,webkit'
)
  .split(',')
  .map(name => name.trim())
  .filter(Boolean)
const selectedEngines = Object.entries(engines).filter(([name]) =>
  requestedBrowsers.includes(name),
)
if (!selectedEngines.some(([name]) => name === 'chromium')) {
  throw new Error('PLAYGROUND_BROWSERS must include chromium for export checks')
}

interface BrowserResult {
  readonly browser: string
  readonly version?: string
  readonly status: 'failed' | 'passed'
  readonly error?: string
  readonly security?: Record<string, boolean>
}

const results: BrowserResult[] = []
let downloadedArchive: string | undefined
let downloadedWebCArchive: string | undefined
const requests: Array<{ host: string; path: string }> = []

/**
 * Everything the run knows, kept current while it runs.
 *
 * `writeReport` is called from `finally`, so a browser that cannot launch, a
 * download that times out, a ZIP that will not extract, an `npm install` that
 * fails and a build error all leave the same artifact: the stages that did
 * run, the ones that did not, and the first error. The previous version wrote
 * the report only on the success path, which meant the interesting runs —
 * the failing ones — produced no evidence at all.
 */
const stages: Array<{
  id: string
  verdict: 'PASS' | 'FAIL' | 'SKIPPED'
  durationMs: number
  detail?: string
}> = []
const report: {
  schema: string
  runId: string
  sourceCommit: string
  lockfileSha256: string
  node: string
  browsers: string[]
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE'
  error?: string
  stages: typeof stages
  results: BrowserResult[]
  requests: typeof requests
  products: Record<string, 'passed' | 'failed'>
} = {
  schema: 'zeus.playground-editor-acceptance/v1',
  runId,
  sourceCommit: '',
  lockfileSha256: '',
  node: process.version,
  browsers: selectedEngines.map(([name]) => name),
  verdict: 'INCOMPLETE',
  stages,
  results,
  requests,
  products: {},
}

/** Runs one stage, records its verdict, and lets a failure propagate. */
async function stage<T>(id: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    const value = await run()
    stages.push({ id, verdict: 'PASS', durationMs: Date.now() - started })
    return value
  } catch (error) {
    stages.push({
      id,
      verdict: 'FAIL',
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message.slice(0, 2000) : String(error),
    })
    throw error
  }
}

/**
 * Writes the report, the run identity, and the `latest` pointer.
 *
 * Best effort by design: it runs from `finally`, possibly because the
 * filesystem is the thing that failed, and an exception here would replace the
 * real error with this one.
 */
async function writeReport(): Promise<void> {
  try {
    report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  } catch {
    report.sourceCommit = 'unknown'
  }
  try {
    const lockfile = await fs.readFile(path.join(root, '../../pnpm-lock.yaml'))
    const { createHash } = await import('node:crypto')
    report.lockfileSha256 = createHash('sha256').update(lockfile).digest('hex')
  } catch {
    report.lockfileSha256 = 'unknown'
  }
  if (report.verdict === 'INCOMPLETE') report.verdict = 'FAIL'
  try {
    await fs.mkdir(output, { recursive: true })
    await fs.writeFile(
      path.join(output, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    // `latest` is for a human looking for the most recent evidence. It is not
    // what the aggregator reads: `runId` inside the report is.
    await fs.rm(latestPointer, { force: true })
    await fs.symlink(path.relative(path.dirname(latestPointer), output), latestPointer)
  } catch (error) {
    console.error(
      'could not write the acceptance report:',
      error instanceof Error ? error.message : error,
    )
  }
}

async function main(): Promise<void> {
  await fs.mkdir(output, { recursive: true })
  editorServer = await createStaticServer(dist)

  try {
    let nativeLabPassed = false
    let webcStudioPassed = false
    for (const [name, engine] of selectedEngines) {
      let browser: Browser | undefined
      try {
        browser = await engine.launch({
          headless: true,
          ...(name === 'chromium' ? { channel: 'chromium' } : {}),
        })
        const pageErrors: string[] = []
        const page = await browser.newPage()
        page.setDefaultTimeout(12_000)
        page.on('pageerror', error => pageErrors.push(error.message))
        const security = await stage(`${name}:editor`, () => runEditorChecks(page))
        Object.assign(
          security,
          await stage(`${name}:sandbox-origin`, () => runSandboxOriginChecks(browser!)),
        )
        nativeLabPassed = true
        if (name === 'chromium') {
          downloadedArchive = await stage(`${name}:native-export-download`, () =>
            downloadExport(page),
          )
          const studio = await stage(`${name}:webc-studio`, () =>
            runWebCStudioChecks(page),
          )
          assert.deepEqual(studio.manifest.components[0]?.tag, 'z-counter')
          webcStudioPassed = true
          downloadedWebCArchive = await stage(`${name}:webc-export-download`, () =>
            downloadExport(page),
          )
        }
        await stage(`${name}:framework-host`, () => runFrameworkHostChecks(page))
        assert.deepEqual(pageErrors, [], `${name} page errors`)
        results.push({
          browser: name,
          version: browser.version(),
          status: 'passed',
          security,
        })
        console.log(
          `Playground editor ${name}: compile, multi-file update, preview, diagnostics, security and loop recovery passed`,
        )
      } catch (error) {
        results.push({
          browser: name,
          status: 'failed',
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        })
        console.error(`Playground editor ${name} failed:`, error)
      } finally {
        await browser?.close()
      }
    }

    assert(downloadedArchive, 'Chromium did not download the exported project.')
    assert(
      downloadedWebCArchive,
      'Chromium did not download the WebC Studio export.',
    )
    assert(
      results.every(result => result.status === 'passed'),
      'Every browser must pass the playground editor gate.',
    )

    const exportedProjectDirectory = await stage('native-export-install-and-build', () =>
      installAndBuildExport(downloadedArchive!, 'native-lab'),
    )
    const exportedSecurity = await stage('native-export-browser', () =>
      checkExportedBrowser(exportedProjectDirectory, 'chromium'),
    )
    results.push({
      browser: 'chromium-export',
      status: 'passed',
      security: exportedSecurity,
    })
    const webcProject = await stage('webc-export-install-and-build', () =>
      installAndBuildExport(downloadedWebCArchive!, 'webc-studio'),
    )
    const webcFiles = await fs.readdir(webcProject)
    assert(webcFiles.includes('custom-elements.json'))
    assert(webcFiles.includes('zeus.components.json'))

    /*
     * Metadata files existing is not a Web Component that runs.
     *
     * `zeus.components.json` is produced by the analyzer; the custom element it
     * describes comes from the compiler, and nothing so far has executed it.
     * The exported project ships an entry that defines the element and appends
     * one to `#root`, so a real browser is the only thing that can tell a
     * working export from a manifest.
     */
    const webcManifest = JSON.parse(
      await fs.readFile(path.join(webcProject, 'zeus.components.json'), 'utf8'),
    ) as {
      components: Array<{
        tag: string
        props: Record<string, { type: string }>
        slots: Record<string, unknown>
      }>
    }
    const counter = webcManifest.components.find(
      component => component.tag === 'z-counter',
    )
    assert(counter, 'the WebC export must describe its z-counter element')
    assert.equal(
      counter.props.count?.type,
      'number',
      'the analyzer must report the numeric prop the component declares',
    )
    assert.ok(
      Object.keys(counter.slots).length > 0,
      'the component declares <Slot>, so the manifest must record a slot',
    )
    assert.ok(
      webcFiles.includes('z-counter.d.ts'),
      'the WebC export must ship the type declarations the manifest promises',
    )

    const webcAcceptance = await stage('webc-export-browser', () =>
      checkExportedWebComponent(webcProject, counter.tag, 'chromium'),
    )
    results.push({
      browser: 'chromium-webc-export',
      status: 'passed',
      security: webcAcceptance,
    })

    report.products = {
      'native-lab': nativeLabPassed ? 'passed' : 'failed',
      'webc-studio': webcStudioPassed ? 'passed' : 'failed',
    }
    report.verdict = 'PASS'

    console.log(
      `Playground editor gate passed in ${selectedEngines
        .map(([name]) => name)
        .join(', ')}.`,
    )
  } finally {
    /*
     * The report is written before anything is torn down, and it is written on
     * every path. The previous version wrote it only after every assertion had
     * passed, so a run that failed left the caller with a console message and
     * nothing on disk — the runs whose evidence matters most.
     */
    await writeReport()
    const server = editorServer
    if (server) await closeServer(server)
  }
}

async function runEditorChecks(page: Page): Promise<Record<string, boolean>> {
  const host = `http://127.0.0.1:${serverPort()}`
  await page.goto(`${host}/`)
  await expect(page.getByTestId('compile')).toBeEnabled()

  await compile(page)
  await expect(page.getByTestId('status')).toContainText('Compiled 2 modules')
  await expect(page.getByTestId('dom-output')).toContainText(
    '// src/main.tsx · source map',
  )
  await expect(page.getByTestId('dom-output')).toContainText(
    '// src/counter.tsx · source map',
  )
  await expect(page.getByTestId('ssr-output')).toContainText('Count:')
  await expect(page.getByTestId('diagnostics')).toContainText('"sourceMaps"')
  await expect(page.getByTestId('preview-status')).toContainText(
    'Preview ready',
  )

  const firstFrame = page.frameLocator('[data-testid="preview-frame"]')
  await expect(firstFrame.getByTestId('query-status')).toHaveText(
    'Router + Query ready',
  )
  await expect(firstFrame.locator('button')).toHaveText('Count: 0')
  await expect(page.getByTestId('hmr-kind-src/counter.tsx')).toHaveText(
    /first-build|unchanged/,
  )
  await expect(page.getByTestId('devtools-mode')).toHaveText('runtime')
  await expect(page.getByTestId('devtools-owners')).not.toHaveText('0')
  await expect(page.getByTestId('devtools-bindings')).not.toHaveText('0')
  await expect(page.getByTestId('devtools-effects')).not.toHaveText('0')
  await expect(page.getByTestId('devtools-sources')).not.toHaveText('0')
  await expect(page.getByTestId('devtools-dom-nodes')).not.toHaveText('0')
  await expect(page.getByTestId('build-metrics')).toContainText('WASM compile')
  const firstSandboxUrl = sandboxFrame(page).url()
  const firstSandboxSession = sandboxSession(firstSandboxUrl)
  // Chromium may swallow synthetic clicks aimed at an out-of-process iframe
  // while its compositor surface is still being committed after navigation.
  // A real user can only click after the first paint, so give the sandbox one
  // frame to settle before exercising the counter button.
  await page.waitForTimeout(250)
  await firstFrame.locator('button').click()
  await expect(firstFrame.locator('button')).toHaveText('Count: 1')

  await page.getByRole('tab', { name: 'counter.tsx' }).click()
  const currentSource = await getEditorSource(page)
  await setEditorSource(page, currentSource.replace('Count:', 'Live:'))
  await compile(page)
  await expect(page.getByTestId('dom-output')).toContainText('Live:')
  await expect(page.getByTestId('ssr-output')).toContainText('Live:')
  await expect(page.getByTestId('hmr-kind-src/counter.tsx')).toContainText(
    'template-structure',
  )
  await expect(firstFrame.locator('button')).toHaveText('Live: 0')
  assert.notEqual(
    sandboxSession(sandboxFrame(page).url()),
    firstSandboxSession,
    'Each preview build must receive a fresh sandbox realm.',
  )

  await page.getByRole('tab', { name: 'main.tsx' }).click()
  await setEditorSource(page, 'export const App = () => <div>\n')
  await compile(page, false)
  await expect(page.getByTestId('diagnostics')).toContainText(
    'ZEUS_PARSE_ERROR',
  )
  await expect(page.getByTestId('preview-status')).toContainText(
    'Preview is stale',
  )

  await setEditorSource(
    page,
    `export const helper = () => 'helper'\nexport const App = () => <p>Recovered</p>\n`,
  )
  await compile(page)
  await expect(firstFrame.locator('p')).toHaveText('Recovered')

  await page.evaluate(
    ({ currentOrigin }) => {
      localStorage.setItem('zeus-secret', 'parent-storage')
      document.cookie = 'zeus-secret=parent-cookie; path=/'
      return currentOrigin
    },
    { currentOrigin: host },
  )
  const probeSource = securityProbe(host)
  await setEditorSource(page, probeSource)
  await compile(page)
  const security = JSON.parse(
    (await firstFrame.getByTestId('security-probe').textContent()) ?? '{}',
  ) as Record<string, boolean>
  assert.deepEqual(security, {
    parentDom: false,
    parentStorage: false,
    localCookies: false,
    localFetch: false,
  })
  assert.equal(
    requests.some(request => request.path === '/secret'),
    false,
    'Sandbox fetch must not reach the host server.',
  )
  const frame = page.frames().find(candidate => candidate !== page.mainFrame())
  assert(frame, 'Sandbox iframe must be present.')
  assert.equal(
    await frame.evaluate(() => globalThis.origin),
    'null',
    'Sandbox must expose an opaque JS origin.',
  )
  assert.match(frame.url(), /^http:\/\/localhost:/)
  assert.equal(
    await page.getByTestId('preview-frame').getAttribute('sandbox'),
    'allow-scripts',
  )
  await expect(page.getByTestId('preview-status')).toContainText(
    'Preview ready',
  )

  await setEditorSource(page, 'export const App = () => { while (true) {} }\n')
  await compile(page, false)
  await expect(page.getByTestId('diagnostics')).toContainText(
    'ZEUS_PLAYGROUND_LOOP_BUDGET',
  )
  await setEditorSource(
    page,
    `export const App = () => <button>Recovered</button>\n`,
  )
  await compile(page)
  await expect(firstFrame.locator('button')).toHaveText('Recovered')

  await setEditorSource(
    page,
    `import { render } from '@zeus-js/zeus'
import { QueryClientProvider, createQueryClient } from '@zeus-js/query'
import { RouterProvider, createMemoryHistory, createRouter } from '@zeus-js/router'
import { Counter } from './counter'
import './counter.css'

const queryClient = createQueryClient()
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/lab'] }),
  routes: [{ id: 'lab', path: '/lab', element: () => <Counter /> }],
})

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  ),
  document.querySelector('#root')!,
)
`,
  )
  await compile(page)
  await expect(firstFrame.locator('button')).toHaveText('Live: 0')
  return security
}

async function runWebCStudioChecks(
  page: Page,
): Promise<{ manifest: { components: Array<{ tag: string }> } }> {
  const host = `http://127.0.0.1:${serverPort()}`
  await page.goto(`${host}/webc.html`)
  await expect(page.getByTestId('compile')).toBeEnabled()
  await compile(page)
  await page.getByTestId('tab-inspector').click()
  await expect(page.getByTestId('webc-manifest')).toContainText('z-counter')
  await expect(page.getByTestId('webc-declarations')).toContainText(
    'defineCustomElement',
  )
  await expect(page.getByTestId('preview-status')).toContainText(
    'Preview ready',
  )
  const frame = page.frameLocator('[data-testid="preview-frame"]')
  await expect(frame.locator('z-counter')).toHaveCount(1)
  await page.getByTestId('preview-frameworks').click()
  await expect(frame.getByTestId('sandbox-react-host')).toContainText(
    'React: 3',
  )
  await expect(frame.getByTestId('sandbox-vue-host')).toContainText('Vue: 7')
  await sandboxFrame(page).evaluate(() => {
    const button = document.querySelector(
      '[data-testid="sandbox-react-host"] z-counter button',
    )
    if (!(button instanceof HTMLElement)) {
      throw new Error('React-hosted Custom Element button is missing.')
    }
    button.click()
  })
  await expect(frame.getByTestId('sandbox-react-host')).toContainText(
    'React: 4',
  )
  const manifest = JSON.parse(
    (await page.getByTestId('webc-manifest').textContent()) ?? '{}',
  ) as { manifest: { components: Array<{ tag: string }> } }
  return { manifest: manifest.manifest }
}

async function runFrameworkHostChecks(page: Page): Promise<void> {
  const host = `http://127.0.0.1:${serverPort()}`
  await page.goto(`${host}/host.html`)
  const react = page.getByTestId('react-host')
  const vue = page.getByTestId('vue-host')
  await expect(react).toContainText('React: 3')
  await expect(vue).toContainText('Vue: 7')
  await expect(page.locator('z-host-counter')).toHaveCount(2)
  await react.getByRole('button').click()
  await expect(react).toContainText('React: 4')
}

async function getEditorSource(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (
      window as unknown as { __zeusPlayground?: { getSource(): string } }
    ).__zeusPlayground
    return api?.getSource() ?? ''
  })
}

async function setEditorSource(page: Page, value: string): Promise<void> {
  await page.evaluate(next => {
    const api = (
      window as unknown as {
        __zeusPlayground?: { setSource(value: string): void }
      }
    ).__zeusPlayground
    api?.setSource(next)
  }, value)
}

async function compile(page: Page, expectSuccess = true): Promise<void> {
  const button = page.getByTestId('compile')
  const previousSequence = await button.getAttribute('data-build-sequence')
  await button.click()
  await page.waitForFunction(
    previous =>
      document
        .querySelector('[data-testid="compile"]')
        ?.getAttribute('data-build-sequence') !== previous,
    previousSequence,
    { timeout: 30_000 },
  )
  await expect(button).toBeEnabled()
  if (expectSuccess) {
    await expect(page.getByTestId('preview-status')).toContainText(
      'Preview ready',
      { timeout: 30_000 },
    )
  }
}

async function downloadExport(page: Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export').click()
  const download = await downloadPromise
  const archive = path.join(output, download.suggestedFilename())
  await download.saveAs(archive)
  await expect(page.getByTestId('status')).toContainText('Exported')
  return archive
}

/*
 * Exported projects install from npm, so there is nothing to override.
 *
 * In the core repository this packed workspace members into tarballs and
 * rewrote the exported project's dependencies to point at them, because the
 * export had to build without a registry. Here every `@zeus-js/*` dependency is
 * a published version, so the exported project's own `pnpm install` resolves
 * them exactly as this application's did.
 */
async function packLocalPackages(): Promise<Record<string, string>> {
  return {}
}

async function installAndBuildExport(
  archive: string,
  label: string,
): Promise<string> {
  /*
   * One directory per export.
   *
   * Both exports used `exported-project`, so the WebC install removed the
   * Native project's tree. Nothing failed, because the Native verification runs
   * first and the WebC one only looked for two JSON files — but the evidence
   * for the first product was destroyed before the report was written, and
   * `temp/` held only whichever export happened to run last.
   */
  const extraction = path.join(output, `exported-project-${label}`)
  await fs.rm(extraction, { recursive: true, force: true })
  await fs.mkdir(extraction, { recursive: true })
  if (archive.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archive, '-d', extraction])
  } else {
    await execFileAsync('tar', ['-xzf', archive, '-C', extraction])
  }
  const entries = await fs.readdir(extraction)
  const packageDirectory = entries.find(
    entry => entry.startsWith('zeus-') && entry.endsWith('-export'),
  )
  assert(packageDirectory, 'The export archive must contain one project root.')
  const directory = path.join(extraction, packageDirectory)
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    CI: 'true',
  }
  const overrides = await packLocalPackages()
  const manifestFile = path.join(directory, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as {
    pnpm?: Record<string, unknown>
  }
  manifest.pnpm = {
    ...manifest.pnpm,
    overrides: { ...(manifest.pnpm?.overrides as object), ...overrides },
  }
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  await execFileAsync(
    'pnpm',
    ['install', '--ignore-scripts', '--ignore-workspace'],
    {
      cwd: directory,
      env,
      shell: process.platform === 'win32',
      timeout: 120_000,
    },
  )
  await execFileAsync('pnpm', ['check'], {
    cwd: directory,
    env,
    shell: process.platform === 'win32',
    timeout: 60_000,
  })
  await execFileAsync('pnpm', ['build'], {
    cwd: directory,
    env,
    shell: process.platform === 'win32',
    timeout: 60_000,
  })
  return directory
}

/**
 * Loads the exported Web Component project in a real browser.
 *
 * Asserts the element is registered, that it renders its own content (the
 * compiled template, not the text the entry writes into it), that a `Slot`
 * projects light DOM, and that a prop reaches the component as a property.
 */
async function checkExportedWebComponent(
  directory: string,
  tag: string,
  browserName: keyof typeof engines,
): Promise<Record<string, boolean>> {
  const server = await createStaticServer(path.join(directory, 'dist'))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const browser = await engines[browserName].launch({
    headless: true,
    ...(browserName === 'chromium' ? { channel: 'chromium' } : {}),
  })
  try {
    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/`)

    // The entry throws if the module defines no element, so reaching this means
    // a registration happened; this asserts *which* tag is registered.
    await page.waitForFunction(
      name => Boolean(customElements.get(name)),
      tag,
      { timeout: 15_000 },
    )

    const element = page.locator(tag).first()
    await expect(element).toBeAttached()
    // The compiled template renders a <button>; the entry's own textContent is
    // a sibling text node, so a button can only come from the component.
    await expect(element.locator('button')).toBeVisible()
    await expect(element.locator('button')).toContainText(':')

    /*
     * The prop round-trips through the property, and only through it.
     *
     * An earlier version of this check set `count = 7` and expected the button
     * to read `7`. It did not, and that was the correct behaviour: the fixture
     * does `createSignal(props.count ?? 0)`, so the prop seeds the signal once
     * and later prop writes do not reach the rendered text. Asserting that they
     * did would have encoded a re-render model this framework does not have.
     *
     * What must hold is the property contract the manifest publishes: a number
     * assigned as a property reads back as that number, without going through
     * attribute string coercion. The rendered output is asserted separately,
     * from the template the compiler produced.
     */
    const projection = await page.evaluate(
      name => {
        const el = document.querySelector(name)
        if (!el) return null
        ;(el as unknown as { count: number }).count = 7
        return {
          count: (el as unknown as { count: number }).count,
          shadow: Boolean((el as unknown as { shadowRoot: unknown }).shadowRoot),
        }
      },
      tag,
    )
    assert(projection, 'the exported element must be in the document')
    assert.equal(
      projection.count,
      7,
      'a numeric prop must round-trip through the property without string coercion',
    )
    assert.equal(
      projection.shadow,
      false,
      'the manifest says shadow: false, so the element must render into the light DOM',
    )

    // The component's own counter still works, and it is the compiled output
    // doing it: a click updates the text the compiler bound.
    await element.locator('button').click()
    await expect(element.locator('button')).toContainText(': 1')

    /*
     * `<Slot>` projects light DOM that existed at upgrade time.
     *
     * The component captures the host's children on mount and re-projects them;
     * appending afterwards lands in the rendered tree, which is what this
     * asserts. It is the visible proof that the compiled `<Host>`/`<Slot>` pair
     * produced a working light-DOM element rather than a detached template.
     */
    const slotState = await page.evaluate(name => {
      const el = document.querySelector(name)
      if (!el) return null
      const marker = document.createElement('em')
      marker.id = 'projected'
      marker.textContent = 'projected'
      el.append(marker)
      return { projected: Boolean(el.querySelector('#projected')) }
    }, tag)
    assert(slotState?.projected, 'an appended child must remain in the light tree')
    await expect(page.locator(`${tag} #projected`)).toHaveText('projected')

    assert.deepEqual(pageErrors, [], 'the exported Web Component page must not throw')
    return { registration: true, render: true, prop: true, slot: true }
  } finally {
    await browser.close()
    await closeServer(server)
  }
}

async function checkExportedBrowser(
  directory: string,
  browserName: keyof typeof engines,
): Promise<Record<string, boolean>> {
  const server = await createStaticServer(path.join(directory, 'dist'))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const browser = await engines[browserName].launch({
    headless: true,
    ...(browserName === 'chromium' ? { channel: 'chromium' } : {}),
  })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await expect(page.locator('button')).toHaveText('Live: 0')
    await page.locator('button').click()
    await expect(page.locator('button')).toHaveText('Live: 1')
    return { interaction: true }
  } finally {
    await browser.close()
    await closeServer(server)
  }
}

async function runSandboxOriginChecks(
  browser: Browser,
): Promise<Record<string, boolean>> {
  const sandboxUrl = `http://localhost:${serverPort()}/sandbox.html`
  const directContext = await browser.newContext()
  const direct = await directContext.newPage()
  const directErrors: string[] = []
  direct.on('pageerror', error => directErrors.push(error.message))
  try {
    await direct.goto(`${sandboxUrl}#direct-security`, {
      waitUntil: 'load',
      timeout: 30_000,
    })
    await direct.waitForTimeout(300)
    const directOrigin = await direct.evaluate(() => globalThis.origin)
    assert.notEqual(
      directOrigin,
      'null',
      'This check must run without an HTTP sandbox CSP header so the code-level gate is exercised.',
    )
    assert(
      directErrors.some(message =>
        message.includes('requires an opaque origin'),
      ),
      'A non-opaque direct sandbox must fail closed before accepting messages.',
    )
  } finally {
    await directContext.close()
  }

  const attackerContext = await browser.newContext()
  const attacker = await attackerContext.newPage()
  try {
    await attacker.goto('about:blank')
    await attacker.setContent(`<!doctype html><html><body><script>
      window.__sandboxMessages = []
      window.__sandboxPwned = null
      window.addEventListener('message', event => {
        window.__sandboxMessages.push(event.data)
        if (event.data && event.data.zeusPwn) window.__sandboxPwned = event.data
      })
      const frame = document.createElement('iframe')
      frame.src = ${JSON.stringify(sandboxUrl)} + '#third-party'
      document.body.append(frame)
      frame.addEventListener('load', () => setTimeout(() => {
        frame.contentWindow.postMessage({
          channel: 'zeus-playground-sandbox',
          version: 1,
          kind: 'sandbox-load',
          sessionId: 'third-party',
          requestId: 'third-party-1',
          timeoutMs: 5000,
          payload: {
            entryPath: 'main.js',
            modules: [{
              path: 'main.js',
              imports: [],
              code: 'parent.postMessage({ zeusPwn: true }, "*")\\nexport default () => document.createElement("div")',
            }],
            styles: [],
            runtimeModules: [],
          },
        }, '*')
      }, 500))
    </script></body></html>`)
    await attacker.waitForTimeout(1_500)
    const result = await attacker.evaluate(() => {
      const state = window as unknown as {
        __sandboxMessages?: unknown[]
        __sandboxPwned?: unknown
      }
      return {
        messages: state.__sandboxMessages ?? [],
        pwned: state.__sandboxPwned ?? null,
      }
    })
    assert.deepEqual(
      result.messages,
      [],
      'A third-party embed without a sandbox attribute must not receive sandbox readiness or results.',
    )
    assert.equal(result.pwned, null, 'Third-party code must not execute.')
    return { directOpaqueGate: true, thirdPartyEmbedBlocked: true }
  } finally {
    await attackerContext.close()
  }
}

function securityProbe(host: string): string {
  return `const checks = {
  parentDom: false,
  parentStorage: false,
  localCookies: false,
  localFetch: false,
}
try { void parent.document.body; checks.parentDom = true } catch {}
try { void parent.localStorage.getItem('zeus-secret'); checks.parentStorage = true } catch {}
try { if (document.cookie.includes('zeus-secret')) checks.localCookies = true } catch {}
try { await fetch('${host}/secret'); checks.localFetch = true } catch {}
parent.postMessage({
  channel: 'zeus-playground-sandbox',
  version: 1,
  kind: 'sandbox-load',
  sessionId: '../bad',
}, '*')
parent.postMessage('malformed payload', '*')
export const App = () => (
  <pre data-testid="security-probe">{JSON.stringify(checks)}</pre>
)
`
}

function sandboxSession(url: string): string {
  const parsed = new URL(url)
  return (
    parsed.searchParams.get('zeus-sandbox-session') ??
    decodeURIComponent(parsed.hash.slice(1))
  )
}

function sandboxFrame(page: Page) {
  const frame = page.frames().find(candidate => candidate !== page.mainFrame())
  assert(frame, 'Sandbox iframe must be present.')
  return frame
}

let editorServer: http.Server | undefined

function serverPort(): number {
  const address = editorServer?.address()
  assert(address && typeof address !== 'string')
  return address.port
}

async function createStaticServer(directory: string): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost')
    const pathname =
      requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname
    requests.push({
      host: request.headers.host ?? '',
      path: requestUrl.pathname,
    })
    const file = path.resolve(directory, `.${pathname}`)
    if (!file.startsWith(`${directory}${path.sep}`)) {
      response.writeHead(403).end()
      return
    }
    try {
      const body = await fs.readFile(file)
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      response.setHeader('Content-Type', contentType(path.extname(file)))
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  return server
}

function contentType(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.js') return 'text/javascript; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.wasm') return 'application/wasm'
  return 'application/octet-stream'
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  )
}

/*
 * A top-level failure still exits non-zero, but the report from `finally` is
 * already on disk by then. Printing the error here rather than letting Node
 * print a stack keeps the artifact and the message in the same shape.
 */
try {
  await main()
} catch (error) {
  report.verdict = 'FAIL'
  report.error ??=
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  throw error
}
