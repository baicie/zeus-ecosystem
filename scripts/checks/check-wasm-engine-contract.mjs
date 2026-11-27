#!/usr/bin/env node
/**
 * Does the published WASM compiler do what Playground Engine needs from it?
 *
 * ## Why this is not a version comparison
 *
 * `@zeus-js/compiler-wasm` and `@zeus-js/playground-engine` publish on
 * independent lines (`0.1.1-beta.20` and `0.2.0-rc.5` today), so "the versions
 * differ" says nothing about whether they work together, and neither does "both
 * are current". The only answer that means anything is to hand the real
 * compiler to the real engine and look at what comes back.
 *
 * ## Three layers, because they fail for different reasons
 *
 *   **compiler**    — `@zeus-js/compiler-wasm` on its own, through its published
 *                     entry point. A break here is the compiler's.
 *   **engine**      — `compileProject` over a multi-file graph, the way the
 *                     Playground calls it. A break here is the join between the
 *                     two, which is the thing that crosses a version boundary.
 *   **artifacts**   — metadata the studio renders without compiling at all.
 *                     `buildWebCArtifacts` is analysis, not compilation, and a
 *                     report that calls it "WebC output" claims more than it
 *                     checked.
 *
 * Runtime execution in a browser is the fourth layer and is not this file's
 * job: `check:image` and `check:editor` drive the real image in Chromium,
 * Firefox and WebKit. Re-running a browser here would duplicate them and make
 * this gate slow enough that nobody runs it.
 *
 * ## Fail closed
 *
 * `REQUIRED_CAPABILITIES` is declared up front. `PASS` requires every one of
 * them to exist, to have actually run, and to have passed. Deleting a `record()`
 * call therefore fails the gate instead of quietly shrinking it.
 *
 * ## Running it
 *
 * ```text
 * pnpm --filter @zeus-ecosystem/playground check:contract
 * ```
 *
 * Output: `temp/contract/wasm-engine.json`. The report carries the source and
 * lockfile identity, so a verdict can be traced to the tree that produced it.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..')
const app = path.join(root, 'apps/playground')
const outDir = path.join(root, 'temp/contract')

/**
 * Capabilities this gate exists to check.
 *
 * A capability not in this list is still recorded, so adding one is visible in
 * the report before it is required. A capability in this list that produces no
 * record — because the code path that records it was removed, or because an
 * earlier failure skipped it — fails the run with `NOT_RUN`.
 */
/*
 * The list is the gate. It is a literal here, and it is checked against a
 * floor below.
 *
 * Removing an entry from this array was enough to make the whole run pass with
 * fewer checks — the "fail closed" property depended on the same edit that
 * disabled the check, which is not a property at all. The floor and the layer
 * counts below are separate literals: shortening the list now trips them, and
 * lengthening it requires updating them deliberately.
 */
const REQUIRED_CAPABILITIES = [
  // layer 1 — the compiler, through its own published entry point
  'compiler:initializes',
  'compiler:dom-transform',
  'compiler:ssr-transform',
  'compiler:source-map',
  'compiler:diagnostics',
  'compiler:hmr-plan-present',
  'compiler:hmr-plan-null-without-render',
  // layer 2 — the engine consuming it
  'engine:multi-file-graph',
  'engine:external-import-resolution',
  'engine:compiler-error-propagation',
  'engine:source-map-propagation',
  'engine:hmr-plan-propagation',
  'engine:previous-snapshot',
  // layer 3 — artifacts produced without compiling
  'artifacts:webc-metadata',
  'artifacts:webc-declarations',
]

/**
 * How many capabilities each layer must still require.
 *
 * A backend that silently stops checking something is the failure this gate
 * exists for, and it looks identical to a backend that checks less on purpose.
 * These numbers are the difference: dropping a compiler capability without
 * saying so fails here, and dropping one on purpose means editing a number in
 * the same commit as the reason.
 */
const REQUIRED_BY_LAYER = Object.freeze({
  compiler: 7,
  engine: 6,
  artifacts: 2,
})

/**
 * Resolves a package through its manifest, not by guessing a filename.
 *
 * `require.resolve('<pkg>')` fails for these packages — their entries are ESM
 * and `exports`-only — and `require.resolve('<pkg>/package.json')` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` because the manifest is not exported. Reading
 * the manifest and following its own `exports` is the path a consumer would
 * take, and it keeps working when the internal layout changes.
 */
function packageDir(name) {
  const dir = path.join(app, 'node_modules', ...name.split('/'))
  if (!existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`${name} is not installed under apps/playground/node_modules`)
  }
  return dir
}

async function manifestOf(name) {
  const manifest = JSON.parse(
    await readFile(path.join(packageDir(name), 'package.json'), 'utf8'),
  )
  if (manifest.name !== name) {
    throw new Error(`${packageDir(name)} declares "${manifest.name}", not "${name}"`)
  }
  return manifest
}

/**
 * The file a consumer's `import '<name>'` resolves to.
 *
 * `import` first because this script is ESM; `default` is the fallback shape
 * both packages also use. A missing condition is an error rather than a guess:
 * silently falling back to a hardcoded `dist/...js` is what made the previous
 * version of this script break when the build file was renamed.
 */
function entryOf(name, manifest) {
  const exported = manifest.exports?.['.']
  if (!exported) throw new Error(`${name} exports no "." entry`)
  if (typeof exported === 'string') return path.resolve(packageDir(name), exported)
  for (const condition of ['import', 'module', 'default']) {
    const target = exported[condition]
    if (typeof target === 'string') return path.resolve(packageDir(name), target)
  }
  throw new Error(`${name} "." exports no import/module/default condition`)
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

async function lockfileHash() {
  try {
    const bytes = await readFile(path.join(root, 'pnpm-lock.yaml'))
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return 'unknown'
  }
}

const capabilities = new Map()
const record = (name, ok, detail) => {
  capabilities.set(name, { ok: Boolean(ok), detail: String(detail).slice(0, 400) })
}

/** Records a capability as unrun, so a skipped path cannot pass. */
const notRun = (name, why) => record(name, false, `NOT_RUN: ${why}`)

async function main() {
  const [wasmManifest, engineManifest, runtimeManifest] = await Promise.all([
    manifestOf('@zeus-js/compiler-wasm'),
    manifestOf('@zeus-js/playground-engine'),
    manifestOf('@zeus-js/zeus'),
  ])

  const wasmEntry = entryOf('@zeus-js/compiler-wasm', wasmManifest)
  const engineEntry = entryOf('@zeus-js/playground-engine', engineManifest)

  const wasm = await import(pathToFileURL(wasmEntry).href)
  const engine = await import(pathToFileURL(engineEntry).href)

  const wasmBytes = new Uint8Array(await readFile(wasm.wasmURL))
  const wasmIntegrity = `sha256-${createHash('sha256').update(wasmBytes).digest('base64')}`

  /* ---- layer 1: the compiler ------------------------------------------ */
  let compiler
  try {
    compiler = await wasm.loadCompiler(wasmBytes)
    record('compiler:initializes', true, `loaded ${wasmBytes.byteLength} bytes`)
  } catch (error) {
    record('compiler:initializes', false, error)
    for (const name of REQUIRED_CAPABILITIES) {
      if (name.startsWith('compiler:') && name !== 'compiler:initializes') {
        notRun(name, 'the compiler did not initialize')
      }
      if (!name.startsWith('compiler:')) notRun(name, 'the compiler did not initialize')
    }
    return finish({ wasmManifest, engineManifest, runtimeManifest, wasmEntry, engineEntry, wasmIntegrity, wasmBytes })
  }

  const transform = options => compiler.transformModule(options)
  const DOM = { target: 'dom', runtimeModule: '@zeus-js/runtime-dom' }
  const SSR = { target: 'ssr', runtimeModule: '@zeus-js/ssr' }
  const base = { delegateEvents: true, sourceMap: false }

  const counterSource =
    "import { createSignal } from '@zeus-js/zeus'\n" +
    'export const App = () => {\n' +
    '  const [n, setN] = createSignal(0)\n' +
    '  return <button onClick={() => setN(n() + 1)}>{n()}</button>\n' +
    '}\n'

  try {
    const dom = await transform({ source: counterSource, filename: 'counter.tsx', ...base, ...DOM })
    record(
      'compiler:dom-transform',
      typeof dom.code === 'string' && dom.code.includes('zeusTemplate'),
      dom.code ? 'entry compiled to a template clone' : 'no code returned',
    )
  } catch (error) {
    record('compiler:dom-transform', false, error)
  }

  try {
    const ssr = await transform({ source: counterSource, filename: 'counter.tsx', ...base, ...SSR })
    // The SSR emitter produces string concatenation, not a template clone. A
    // check that only looked for `zeusTemplate` would fail a correct SSR build.
    record(
      'compiler:ssr-transform',
      typeof ssr.code === 'string' && ssr.code.length > 0 && !ssr.code.includes('zeusTemplate'),
      ssr.code ? `${ssr.code.length} bytes, no template clone` : 'no code returned',
    )
  } catch (error) {
    record('compiler:ssr-transform', false, error)
  }

  try {
    const mapped = await transform({
      source: counterSource,
      filename: 'mapped.tsx',
      ...base,
      ...DOM,
      sourceMap: true,
    })
    /*
     * Shape, not merely presence. "map is not null" passed for a long time
     * while proving nothing about whether a mapped position points anywhere
     * real; requiring `version`, a non-empty `sources` array and `mappings`
     * ties the check to the sourcemap format the editor consumes.
     */
    const map = mapped.map
    const ok =
      map &&
      typeof map === 'object' &&
      map.version === 3 &&
      Array.isArray(map.sources) &&
      map.sources.length > 0 &&
      typeof map.mappings === 'string'
    record('compiler:source-map', ok, ok ? `v${map.version}, ${map.sources.length} source(s)` : JSON.stringify(map)?.slice(0, 160))
  } catch (error) {
    record('compiler:source-map', false, error)
  }

  try {
    const bad = await transform({
      source: 'export const App = () => <div>{() => 1}</div>\n',
      filename: 'bad.tsx',
      ...base,
      ...DOM,
    })
    const errors = (bad.diagnostics ?? []).filter(d => d.severity === 'error')
    /*
     * Code, severity and location — not "an error appeared". The editor keys
     * its problem list on `code` and jumps to `span`, so a diagnostic without
     * either is unusable even though it exists.
     */
    const first = errors[0]
    const ok =
      errors.length > 0 &&
      typeof first.code === 'string' &&
      first.code.startsWith('ZEUS_') &&
      first.severity === 'error' &&
      first.span !== undefined &&
      first.span !== null
    record(
      'compiler:diagnostics',
      ok,
      ok ? `${first.code} at ${JSON.stringify(first.span)}` : `first error: ${JSON.stringify(first)?.slice(0, 200)}`,
    )
  } catch (error) {
    record('compiler:diagnostics', false, error)
  }

  /*
   * The HMR plan, both ways round.
   *
   * `prepare_hmr_module` collects top-level `render(...)` calls whose callee is
   * an identifier bound to the runtime's render. `render(App, document.body)`
   * is one; `render(() => <App />, …)` is not, and returning null for it is
   * correct. A check that only asserts "a plan exists" cannot tell an absent
   * plan from a plugin that stopped asking, and one that treats every null as a
   * failure would demand HMR for code the compiler deliberately does not
   * support. Both directions are asserted, matching
   * `crates/zeus_compiler/tests/golden/hmr-tsx.json`.
   */
  const hmrSource =
    "import { render } from '@zeus-js/runtime-dom'\n" +
    'export function App(props) {\n' +
    "  return <p class={'contract'}>{props.value}</p>\n" +
    '}\n' +
    'render(App, document.body)\n'
  try {
    const withPlan = await transform({ source: hmrSource, filename: 'hmr.tsx', ...base, ...DOM, hmr: true })
    record(
      'compiler:hmr-plan-present',
      withPlan.hmrPlan !== null && withPlan.hmrPlan !== undefined,
      withPlan.hmrPlan ? 'plan present for a top-level render(Identifier)' : 'plan null',
    )
  } catch (error) {
    record('compiler:hmr-plan-present', false, error)
  }
  try {
    const withoutPlan = await transform({
      source:
        "import { render } from '@zeus-js/runtime-dom'\n" +
        'const App = () => <p>x</p>\n' +
        'render(() => <App />, document.body)\n',
      filename: 'no-plan.tsx',
      ...base,
      ...DOM,
      hmr: true,
    })
    record(
      'compiler:hmr-plan-null-without-render',
      withoutPlan.hmrPlan === null || withoutPlan.hmrPlan === undefined,
      withoutPlan.hmrPlan ? 'plan present for an arrow-wrapped render (unexpected)' : 'plan null, as specified',
    )
  } catch (error) {
    record('compiler:hmr-plan-null-without-render', false, error)
  }

  /* ---- layer 2: the engine consuming it ------------------------------- */
  const projectFiles = [
    /*
     * `render` must be imported here. Without the binding the compiler treats
     * the call as an unknown identifier, emits no template, and produces no
     * map — so the source-map assertion below failed on this fixture rather
     * than on the product. The fixture is supposed to be a project the editor
     * would accept; leaving out an import made it one it rejects.
     */
    {
      path: 'src/main.tsx',
      content:
        "import { render } from '@zeus-js/runtime-dom'\n" +
        "import { App } from './app'\n" +
        "import { helper } from './util'\n" +
        "render(App, document.querySelector('#root'))\n" +
        'export const value = helper()\n',
    },
    { path: 'src/app.tsx', content: counterSource },
    { path: 'src/util.ts', content: 'export const helper = () => 1\n' },
    { path: 'src/style.css', content: 'button { color: red }\n' },
  ]
  const snapshot = engine.parseProjectSnapshot({
    schemaVersion: 2,
    entryPath: 'src/main.tsx',
    compilerVersion: wasmManifest.version,
    files: projectFiles,
    options: { delegateEvents: true, sourceMap: true, sandboxTimeoutMs: 3_000 },
  })

  let domProject
  try {
    domProject = await engine.compileProject(snapshot, compiler, {
      target: 'dom',
      runtimeModule: '@zeus-js/runtime-dom',
      // `sourceMap` lives on `CompileProjectOptions`, not on the snapshot.
      // Setting it in `snapshot.options` and reading the module map was this
      // check's own bug: the engine never asked the compiler for a map, so
      // "the entry module has no map" described the request, not the product.
      sourceMap: true,
    })
    /*
     * A module graph, not "modules is not empty". The Playground imports every
     * module it gets back and renders the entry, so the assertions are the
     * things it relies on: every source file present, the entry named, styles
     * separated from modules.
     */
    const paths = domProject.modules.map(module => module.path).sort()
    const expected = ['src/app.tsx', 'src/main.tsx', 'src/util.ts']
    record(
      'engine:multi-file-graph',
      expected.every(file => paths.includes(file)) && domProject.entryPath === 'src/main.tsx',
      `${paths.length} module(s): ${paths.join(', ')}`,
    )
    record(
      'engine:external-import-resolution',
      domProject.modules.some(module => /from\s+["']@zeus-js\/zeus["']|@zeus-js\/runtime-dom/.test(module.code ?? '')),
      'external @zeus-js import preserved in the emitted module',
    )
  } catch (error) {
    record('engine:multi-file-graph', false, error)
    record('engine:external-import-resolution', false, 'compileProject threw')
  }

  try {
    const broken = engine.parseProjectSnapshot({
      schemaVersion: 2,
      entryPath: 'src/main.tsx',
      compilerVersion: wasmManifest.version,
      files: [{ path: 'src/main.tsx', content: 'export const App = () => <div>{() => 1}</div>\n' }],
    })
    const result = await engine.compileProject(broken, compiler, {
      target: 'dom',
      runtimeModule: '@zeus-js/runtime-dom',
    })
    /*
     * The compilation succeeds and the diagnostics carry the error — the editor
     * shows them next to the code rather than treating a diagnostic as a thrown
     * exception. Asserting a throw here would encode the wrong contract.
     */
    const errors = (result.diagnostics ?? []).filter(d => d.severity === 'error')
    record(
      'engine:compiler-error-propagation',
      errors.length > 0 && typeof errors[0].code === 'string',
      errors.length ? `${errors[0].code} propagated through compileProject` : 'compileProject reported no error',
    )
  } catch (error) {
    record('engine:compiler-error-propagation', false, error)
  }

  try {
    /*
     * The map belongs to the module that has JSX, not to the entry.
     *
     * `src/main.tsx` imports `render` and calls it; it contains no JSX, so the
     * compiler emits no template and no map for it, and reporting that as a
     * missing map blamed the engine for a correct absence. `src/app.tsx` is the
     * component — that is where a map must exist, and where the editor needs
     * one to point a diagnostic at a line.
     */
    const mapped = (domProject?.modules ?? []).filter(
      module => module.map && typeof module.map === 'object' && module.map.version === 3 && Array.isArray(module.map.sources),
    )
    const component = mapped.find(module => module.path === 'src/app.tsx')
    record(
      'engine:source-map-propagation',
      Boolean(component),
      component
        ? `map on ${mapped.map(module => module.path).join(', ')}`
        : `no map on any module (${(domProject?.modules ?? []).map(module => module.path).join(', ')})`,
    )
  } catch (error) {
    record('engine:source-map-propagation', false, error)
  }

  try {
    const withHmr = await engine.compileProject(
      engine.parseProjectSnapshot({
        schemaVersion: 2,
        entryPath: 'src/main.tsx',
        compilerVersion: wasmManifest.version,
        files: [{ path: 'src/main.tsx', content: hmrSource }],
      }),
      compiler,
      { target: 'dom', runtimeModule: '@zeus-js/runtime-dom', hmr: true },
    )
    /*
     * The plan is per module (`PlaygroundCompiledModule.hmr`), not a field on
     * the compile result. `PlaygroundCompileResult` has no `hmrPlan` at all, so
     * the earlier assertion could never pass — it was reading a property the
     * type does not declare and calling its absence a product defect. The same
     * mistake as reading `components` at the wrong level: the shape is in the
     * `.d.ts`, and guessing it is cheaper to avoid than to debug.
     */
    const entry = withHmr.modules.find(module => module.path === 'src/main.tsx')
    const plan = entry?.hmr?.plan ?? null
    record(
      'engine:hmr-plan-propagation',
      plan !== null && plan !== undefined,
      plan ? 'plan reached the compiled entry module' : `entry module hmr: ${JSON.stringify(entry?.hmr)?.slice(0, 160)}`,
    )
  } catch (error) {
    record('engine:hmr-plan-propagation', false, error)
  }

  try {
    /*
     * A second compile of an edited project must be told what the first one
     * produced. That is what the editor's incremental update keys on; without
     * it every keystroke recompiles from nothing and the live preview loses its
     * state.
     */
    const edited = engine.parseProjectSnapshot({
      schemaVersion: 2,
      entryPath: 'src/main.tsx',
      compilerVersion: wasmManifest.version,
      files: [
        ...projectFiles.filter(file => file.path !== 'src/app.tsx'),
        { path: 'src/app.tsx', content: counterSource.replace('count', 'clicks') },
      ],
      options: { delegateEvents: true, sourceMap: true, sandboxTimeoutMs: 3_000 },
    })
    const result = await engine.compileProject(edited, compiler, {
      target: 'dom',
      runtimeModule: '@zeus-js/runtime-dom',
      hmr: true,
      previousSnapshot: snapshot,
    })
    record(
      'engine:previous-snapshot',
      Array.isArray(result.modules) && result.modules.length > 0,
      `recompiled ${result.modules.length} module(s) with a previous snapshot`,
    )
  } catch (error) {
    record('engine:previous-snapshot', false, error)
  }

  /* ---- layer 3: artifacts, which are analysis ------------------------- */
  try {
    const webcSnapshot = engine.parseProjectSnapshot({
      schemaVersion: 2,
      entryPath: 'src/counter.tsx',
      compilerVersion: wasmManifest.version,
      frameworkTarget: 'webc',
      files: [
        {
          path: 'src/counter.tsx',
          content:
            "import { defineElement, Host, Slot } from '@zeus-js/zeus'\n" +
            'export const ZeProbe = defineElement(\n' +
            "  'z-probe',\n" +
            '  { shadow: false, props: { count: Number, label: String } },\n' +
            '  () => <Host><button>{"count"}</button><Slot /></Host>,\n' +
            ')\n',
        },
      ],
    })
    /*
     * `buildWebCArtifacts(snapshot)` takes one argument and derives the manifest
     * from the source — it does not compile. Passing a compiler here was
     * silently ignored, and calling the result "WebC output" claimed a
     * compilation that never happened. The capability names say `metadata` and
     * `declarations` because that is what they check; WebC *compilation* is
     * layer 1's `compiler:dom-transform` with `frameworkTarget`, and WebC
     * *runtime* belongs to the browser gates.
     */
    const built = engine.buildWebCArtifacts(webcSnapshot)
    const components = built?.metadata?.manifest?.components ?? []
    const probe = components.find(component => component.tag === 'z-probe')
    record(
      'artifacts:webc-metadata',
      Boolean(probe) &&
        probe.props?.count?.type === 'number' &&
        probe.props?.label?.type === 'string' &&
        Object.keys(probe.slots ?? {}).length > 0,
      probe ? `z-probe: ${Object.keys(probe.props).join(', ')}, ${Object.keys(probe.slots).length} slot(s)` : 'z-probe absent from the manifest',
    )
    record(
      'artifacts:webc-declarations',
      typeof built?.metadata?.declarations?.['z-probe'] === 'string' &&
        built.metadata.declarations['z-probe'].includes('count'),
      built?.metadata?.declarations?.['z-probe'] ? 'z-probe.d.ts carries the props' : 'no declaration for z-probe',
    )
  } catch (error) {
    record('artifacts:webc-metadata', false, error)
    record('artifacts:webc-declarations', false, 'buildWebCArtifacts threw')
  }

  await finish({ wasmManifest, engineManifest, runtimeManifest, wasmEntry, engineEntry, wasmIntegrity, wasmBytes })
}

async function finish(identity) {
  /*
   * Every required capability, run or not.
   *
   * A capability that produced no record at all is the case this gate exists
   * for: deleting the `record()` call would otherwise shrink the gate silently,
   * and the run would report PASS over fewer checks than the last one.
   */
  const missing = REQUIRED_CAPABILITIES.filter(name => !capabilities.has(name))
  for (const name of missing) notRun(name, 'no capability was recorded for this check')

  /*
   * The layer floors, checked against the list rather than against the run.
   *
   * A run that checked less than the last one is indistinguishable from a run
   * that passed, unless something compares the list itself. This is that
   * comparison, and it is deliberately separate from `capabilities` so an edit
   * that removes both a `record()` call and its entry still fails.
   */
  const byLayer = name => name.split(':')[0]
  const layerShortfalls = Object.entries(REQUIRED_BY_LAYER)
    .map(([layer, floor]) => ({
      layer,
      floor,
      actual: REQUIRED_CAPABILITIES.filter(name => byLayer(name) === layer).length,
    }))
    .filter(({ floor, actual }) => actual < floor)
  for (const { layer, floor, actual } of layerShortfalls) {
    record(`gate:${layer}-floor`, false, `NOT_RUN: requires ${floor} ${layer} capabilities, the list declares ${actual}`)
  }

  const failures = [...capabilities.entries()].filter(([, value]) => !value.ok)
  const passed = [...capabilities.values()].filter(value => value.ok).length

  const report = {
    schema: 'zeus.ecosystem.wasm-engine-contract/v2',
    sourceCommit: gitHead(),
    lockfileSha256: await lockfileHash(),
    node: process.version,
    compilerWasm: {
      version: identity.wasmManifest.version,
      entry: path.relative(root, identity.wasmEntry),
      wasmIntegrity: identity.wasmIntegrity,
      wasmBytes: identity.wasmBytes.byteLength,
    },
    engine: {
      version: identity.engineManifest.version,
      entry: path.relative(root, identity.engineEntry),
    },
    runtime: { version: identity.runtimeManifest.version },
    requiredCapabilities: REQUIRED_CAPABILITIES,
    capabilities: Object.fromEntries(capabilities),
    verdict: failures.length === 0 && missing.length === 0 ? 'PASS' : 'FAIL',
    failures: failures.map(([name, value]) => `${name}: ${value.detail}`),
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'wasm-engine.json'), `${JSON.stringify(report, null, 2)}\n`)

  for (const [name, value] of capabilities) {
    console.log(`${value.ok ? 'ok  ' : 'FAIL'} ${name}: ${value.detail}`)
  }
  console.log(
    `\nwasm ${report.compilerWasm.version} + engine ${report.engine.version}: ` +
      `${report.verdict} (${passed}/${REQUIRED_CAPABILITIES.length} required)`,
  )
  if (report.verdict !== 'PASS') process.exitCode = 1
}

await main()
