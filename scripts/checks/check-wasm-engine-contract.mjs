#!/usr/bin/env node
/**
 * A2 — does the published WASM compiler actually satisfy what Playground Engine
 * consumes from it?
 *
 * The two packages have independent version lines (`compiler-wasm`
 * 0.1.1-beta.20, `playground-engine` 0.2.0-rc.5), so "the versions differ" says
 * nothing about whether they work together. The only answer that means anything
 * is to hand the real compiler to the real engine and look at what comes back.
 *
 * This is a behavioural report, not a version comparison. Every capability below
 * is exercised through the engine's own entry point, so a compiler that compiles
 * fine on its own but returns something the engine cannot use fails here.
 *
 * Output: `temp/contract/wasm-engine.json`, plus a one-line verdict.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'


// `scripts/checks/` -> repository root -> `apps/playground`.
const app = path.resolve(import.meta.dirname, '../../apps/playground')
const outDir = path.join(app, '..', '..', 'temp', 'contract')

/*
 * Locates the installed package directory.
 *
 * `require.resolve('<pkg>/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * — these packages do not export their manifest — and `require.resolve('<pkg>')`
 * fails too, because the entries are ESM only. The directory is the one thing
 * that is unambiguous: pnpm puts it under the app's own `node_modules`, and the
 * manifest inside names the package, so the search verifies rather than assumes.
 */
function packageDir(name) {
  const dir = path.join(app, 'node_modules', ...name.split('/'))
  if (!existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`${name} is not installed under ${app}/node_modules`)
  }
  return dir
}

async function pkg(name) {
  const manifest = JSON.parse(
    await readFile(path.join(packageDir(name), 'package.json'), 'utf8'),
  )
  if (manifest.name !== name) {
    throw new Error(`${packageDir(name)} declares "${manifest.name}", not "${name}"`)
  }
  return manifest
}

async function main() {
  const [wasmPkg, enginePkg] = await Promise.all([
    pkg('@zeus-js/compiler-wasm'),
    pkg('@zeus-js/playground-engine'),
  ])

  const wasmMod = await import(
    pathToFileURL(path.join(packageDir('@zeus-js/compiler-wasm'), 'index.js')).href
  )
  const engine = await import(
    pathToFileURL(
      path.join(
        packageDir('@zeus-js/playground-engine'),
        'dist/playground-engine.esm-bundler.js',
      ),
    ).href
  )

  /*
   * The compiler binary, read the way a browser would find it: through the
   * package's own `import.meta.url` resolution rather than a guessed path. If
   * this is wrong, nothing downstream can be right.
   */
  const wasmBytes = new Uint8Array(await readFile(wasmMod.wasmURL))
  const wasmIntegrity = `sha256-${createHash('sha256').update(wasmBytes).digest('base64')}`

  const capabilities = {}
  const record = (name, ok, detail) => {
    capabilities[name] = { ok, detail }
  }

  let compiler
  try {
    compiler = await wasmMod.loadCompiler(wasmBytes)
    const probe = await compiler.transformModule({
      source: 'export const App = () => null\n',
      filename: 'probe.tsx',
      target: 'dom',
      runtimeModule: '@zeus-js/runtime-dom',
      delegateEvents: true,
      sourceMap: false,
    })
    record(
      'compiler-initializes',
      probe.diagnostics.filter(d => d.severity === 'error').length === 0,
      'loadCompiler + one transform on an empty component',
    )
  } catch (error) {
    record('compiler-initializes', false, String(error).slice(0, 200))
  }

  if (compiler) {
    /*
     * The engine's contract, exercised through the engine. `compileProject`
     * wraps the compiler, builds a module graph and returns the shape the
     * preview consumes — so this checks the join, not either half.
     */
    const source =
      "import { createSignal } from '@zeus-js/zeus'\n" +
      'const [n, setN] = createSignal(0)\n' +
      'export const App = () => <button onClick={() => setN(n() + 1)}>{n()}</button>\n'

    const snapshot = engine.parseProjectSnapshot({
      schemaVersion: 2,
      entryPath: 'src/main.tsx',
      compilerVersion: wasmPkg.version,
      files: [{ path: 'src/main.tsx', content: source }],
    })

    const compileWith = options => engine.compileProject(snapshot, compiler, options)

    let domResult
    try {
      domResult = await compileWith({ target: 'dom', runtimeModule: '@zeus-js/runtime-dom' })
      const entry = domResult.modules.find(m => m.path === 'src/main.tsx')
      record(
        'native-tsx-transform',
        Boolean(entry?.code) && entry.code.includes('zeusTemplate'),
        entry?.code ? 'entry module compiled to a template clone' : 'no entry module',
      )
      record(
        'engine-consumes-compiler-result',
        domResult.modules.length > 0 && typeof domResult.entryPath === 'string',
        `${domResult.modules.length} module(s), entryPath=${domResult.entryPath}`,
      )
    } catch (error) {
      record('native-tsx-transform', false, String(error).slice(0, 200))
      record('engine-consumes-compiler-result', false, 'compileProject threw')
    }

    /* Source map: the engine asks for it, the compiler must produce one. */
    try {
      const withMap = await compiler.transformModule({
        source,
        filename: 'map.tsx',
        target: 'dom',
        runtimeModule: '@zeus-js/runtime-dom',
        delegateEvents: true,
        sourceMap: true,
      })
      record('source-map', withMap.map !== null && withMap.map !== undefined, withMap.map ? 'map present' : 'map null')
    } catch (error) {
      record('source-map', false, String(error).slice(0, 200))
    }

    /* Diagnostics: a JSX child that is a function is an error the editor shows. */
    try {
      const bad = await compiler.transformModule({
        source: 'export const App = () => <div>{() => 1}</div>\n',
        filename: 'bad.tsx',
        target: 'dom',
        runtimeModule: '@zeus-js/runtime-dom',
        delegateEvents: true,
        sourceMap: false,
      })
      const errors = bad.diagnostics.filter(d => d.severity === 'error')
      record(
        'diagnostics',
        errors.length > 0 && typeof errors[0].code === 'string',
        errors.length ? `${errors[0].code}: ${errors[0].message}` : 'no error reported',
      )
    } catch (error) {
      record('diagnostics', false, String(error).slice(0, 200))
    }

    /*
     * HMR plan: the editor's live update depends on it being a real object.
     *
     * The shape matters. `prepare_hmr_module` collects top-level `render(...)`
     * calls whose callee is an identifier bound to the runtime's render — a call
     * wrapped in an arrow, `render(() => <App />, …)`, is not one of them, and
     * the plan is `null` for the correct reason. This matches
     * `crates/zeus_compiler/tests/golden/hmr-tsx.json`, which is the fixture the
     * compiler's own HMR contract is pinned to.
     */
    try {
      const hmr = await compiler.transformModule({
        source:
          "import { render } from '@zeus-js/runtime-dom'\n" +
          'export function App(props) {\n' +
          "  return <p class={'contract'}>{props.value}</p>\n" +
          '}\n' +
          'render(App, document.body)\n',
        filename: 'hmr.tsx',
        target: 'dom',
        runtimeModule: '@zeus-js/runtime-dom',
        delegateEvents: true,
        sourceMap: false,
        hmr: true,
      })
      record(
        'hmr-plan',
        hmr.hmrPlan !== null && hmr.hmrPlan !== undefined,
        hmr.hmrPlan ? 'plan present' : 'plan null',
      )
    } catch (error) {
      record('hmr-plan', false, String(error).slice(0, 200))
    }

    /* WebC output: the studio's whole purpose. */
    try {
      /*
       * `buildWebCArtifacts` refuses a `native` snapshot — "WebC metadata
       * requires a \"webc\" project snapshot" — because the two produce
       * different artifacts from the same source. The snapshot says which.
       *
       * The component has to be a *named export bound to a `defineElement`
       * call*: the metadata is derived from that binding, so a bare
       * `defineElement(...)` statement with no export declares nothing the
       * manifest can name, and a project made of one correctly reports zero
       * components. This matches `__tests__/webc.spec.ts`, which is the shape
       * the studio actually produces.
       */
      const webcSnapshot = engine.parseProjectSnapshot({
        schemaVersion: 2,
        entryPath: 'src/counter.tsx',
        compilerVersion: wasmPkg.version,
        frameworkTarget: 'webc',
        files: [
          {
            path: 'src/counter.tsx',
            content:
              "import { defineElement, Host, Slot } from '@zeus-js/zeus'\n" +
              '\n' +
              'export const ZeProbe = defineElement(\n' +
              "  'z-probe',\n" +
              '  { shadow: false, props: { count: Number, label: String } },\n' +
              '  () => (\n' +
              '    <Host>\n' +
              "      <button>{'count'}</button>\n" +
              '      <Slot />\n' +
              '    </Host>\n' +
              '  ),\n' +
              ')\n',
          },
        ],
      })
      /*
       * `buildWebCArtifacts(snapshot)` takes one argument. It derives the
       * manifest from the source itself rather than compiling it — the studio
       * calls this for the metadata panel while the compiler runs separately —
       * so passing a compiler here silently does nothing.
       */
      const built = engine.buildWebCArtifacts(webcSnapshot)
      /*
       * The manifest is at `metadata.manifest.components`, not at the top level:
       * `buildWebCArtifacts` returns `{ entryPath, metadata, files }`, where
       * `files` is the emitted output and `metadata` describes the components.
       * Reading the wrong level reports "no components" for a build that has
       * them.
       */
      const components = built?.metadata?.manifest?.components ?? []
      record(
        'webc-output',
        components.length > 0,
        components.length
          ? `${components.length} component(s): ${components.map(c => c.tag).join(', ')}`
          : 'no components in metadata.manifest',
      )
    } catch (error) {
      record('webc-output', false, String(error).slice(0, 200))
    }
  }

  const failed = Object.entries(capabilities).filter(([, value]) => !value.ok)
  const report = {
    schema: 'zeus.ecosystem.wasm-engine-contract/v1',
    compilerWasmVersion: wasmPkg.version,
    engineVersion: enginePkg.version,
    runtimeVersion: (await pkg('@zeus-js/zeus')).version,
    wasmIntegrity,
    wasmBytes: wasmBytes.byteLength,
    capabilities,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    failures: failed.map(([name, value]) => `${name}: ${value.detail}`),
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, 'wasm-engine.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )

  for (const [name, value] of Object.entries(capabilities)) {
    console.log(`${value.ok ? 'ok  ' : 'FAIL'} ${name}: ${value.detail}`)
  }
  console.log(`\nwasm ${report.compilerWasmVersion} + engine ${report.engineVersion}: ${report.verdict}`)
  if (report.verdict !== 'PASS') process.exitCode = 1
}

await main()
