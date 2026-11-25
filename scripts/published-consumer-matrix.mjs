/**
 * Installs the published Core and UI packages from the public npm registry and
 * checks that they are usable the way a real consumer would use them.
 *
 * ## Why a separate project
 *
 * `verify-published-pair.mjs` proves the three Core packages and one UI
 * component resolve to single physical copies. That answers the duplicate-engine
 * question and nothing else. It says nothing about whether a React wrapper
 * mounts, whether a custom element renders, whether `tsc` accepts the published
 * types, or whether the AI packages import.
 *
 * This script builds a throwaway project that depends on **only published
 * versions** and then exercises each surface in turn.
 *
 * ## What it refuses to do
 *
 * Every one of these would make the result meaningless while looking green:
 *
 * - `workspace:` or `file:` dependencies pointing at the source repositories;
 * - a Vite alias or tsconfig path pointing at `../zeus-ui`;
 * - copying a local `dist/` in place of the package.
 *
 * The install runs with `npm_config_registry` pinned to the public registry so
 * a developer's mirror cannot answer for it, and `--strict-peer-dependencies`
 * so a peer conflict is an error rather than a warning.
 *
 * ## What it still cannot prove
 *
 * A headless run cannot prove the components look right. The interaction and
 * browser matrix is `scripts/published-consumer-matrix.mjs`; this file produces
 * the install + typecheck + build + import layer it builds on.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Everything the matrix imports. Versions are supplied, never ranges. */
export const CORE_DEPENDENCIES = [
  '@zeus-js/zeus',
  '@zeus-js/signal',
  '@zeus-js/runtime-dom',
  '@zeus-js/web-c-runtime',
  '@zeus-js/web-c',
]

/*
 * Packages on their own version line. `@zeus-js/vite-plugin` releases as
 * 0.0.x; asking for it at the Core version fails with
 * ERR_PNPM_NO_MATCHING_VERSION, which is what happened on the first run of
 * this matrix. Everything here is pinned explicitly and checked against its
 * own expectation, not the Core version.
 */
export const INDEPENDENT_VERSIONS = {
  '@zeus-js/vite-plugin': '0.0.6',
  '@zeus-js/devtools-consumer': '0.1.1-beta.15',
}

/**
 * Re-reads the independent versions from the contract.
 *
 * The constant above was `0.0.5` long after the plugin moved to `0.0.6`, and
 * its test asserted `0.0.5` — so `check:matrix` stayed green while installing
 * a version the repository no longer uses. A test that asserts a constant
 * equals the same constant proves the constant did not change, not that it is
 * right.
 *
 * `published-pair.json` records the independent line and its version, and
 * `check-published-fixtures.mjs` already reads it there. This is the same
 * question, so it gets the same answer, and a drift between the two is what
 * `checkIndependentVersions` below reports.
 */
export function readIndependentVersions(root) {
  const file = join(root, 'infra/contracts/published-pair.json')

  if (!existsSync(file)) return undefined

  try {
    return JSON.parse(readFileSync(file, 'utf8')).independent
  } catch {
    return undefined
  }
}

/**
 * Compares the constant against the contract.
 *
 * Returns the disagreements rather than picking a winner: the caller is a
 * check, and a check that silently prefers one source cannot report that the
 * two disagree.
 */
export function checkIndependentVersions(root) {
  const contract = readIndependentVersions(root)

  if (!contract) return ['infra/contracts/published-pair.json is missing or unreadable']

  const errors = []

  for (const [name, version] of Object.entries(INDEPENDENT_VERSIONS)) {
    if (contract[name] === undefined) {
      errors.push(`${name} is listed here but not in the contract's independent map`)
      continue
    }

    if (contract[name] !== version) {
      errors.push(`${name} is ${version} here and ${contract[name]} in the contract`)
    }
  }

  for (const name of Object.keys(contract)) {
    if (INDEPENDENT_VERSIONS[name] === undefined) {
      errors.push(`${name} is in the contract's independent map but not here`)
    }
  }

  return errors
}

export const UI_DEPENDENCIES = [
  '@zeus-web/button',
  '@zeus-web/dialog',
  '@zeus-web/input',
  '@zeus-web/form-field',
  '@zeus-web/data-grid',
  '@zeus-web/themes',
  '@zeus-web/icons',
  '@zeus-web/registry',
  '@zeus-web/cli',
  '@zeus-web/zeus-compat',
]

export const WRAPPER_DEPENDENCIES = [
  '@zeus-web/react',
  '@zeus-web/vue',
]

export const AI_DEPENDENCIES = [
  // The six packages that were published for the first time in beta.35, plus
  // the two they are consumed through.
  '@zeus-web/ai-core',
  '@zeus-web/ai-adapters',
  '@zeus-web/ai-primitives',
  '@zeus-web/ai-react',
  '@zeus-web/ai-vue',
  '@zeus-web/ai-wc',
  '@zeus-web/ai',
  '@zeus-web/chat',
]

const REGISTRY = 'https://registry.npmjs.org/'

export function parseOptions(args) {
  /** @type {Record<string, string>} */
  const values = {}

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] ?? ''
    const value = args[index + 1]

    if (!['--core', '--ui', '--manager', '--out'].includes(key) || !value) {
      throw new Error(
        'Usage: --core <exact> --ui <exact> --manager npm|pnpm [--out <path>]',
      )
    }

    values[key.slice(2)] = value
  }

  const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

  if (!exact.test(values.core ?? '')) throw new Error('--core must be an exact version')
  if (!exact.test(values.ui ?? '')) throw new Error('--ui must be an exact version')
  if (!['npm', 'pnpm'].includes(values.manager ?? '')) {
    throw new Error('--manager must be npm or pnpm')
  }

  return {
    core: values.core,
    ui: values.ui,
    manager: values.manager,
    ...(values.out ? { out: values.out } : {}),
  }
}

function run(command, args, cwd, timeout = 240_000) {
  const child = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      npm_config_registry: REGISTRY,
      // A consumer test must never reach a local source checkout through a
      // workspace protocol or a link.
      npm_config_link_workspace_packages: 'false',
      CI: '1',
    },
  })

  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim()

  return {
    ok: child.status === 0,
    detail: output.slice(-2000),
  }
}

/**
 * Writes the consumer project.
 *
 * Deliberately plain: a `package.json` with exact versions, a `tsconfig` with
 * no `paths`, and source files that import only by package name. If a result
 * here depended on a path alias, it would not be evidence about the published
 * packages.
 */
function writeProject(directory, options) {
  const dependencies = Object.fromEntries([
    ...CORE_DEPENDENCIES.map(name => [name, options.core]),
    ...Object.entries(INDEPENDENT_VERSIONS),
    ...UI_DEPENDENCIES.map(name => [name, options.ui]),
    ...WRAPPER_DEPENDENCIES.map(name => [name, options.ui]),
    ...AI_DEPENDENCIES.map(name => [name, options.ui]),
  ])

  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'zeus-published-consumer',
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies,
        /*
         * Not arbitrary. The published @zeus-js packages declare
         * `peer vite ^8.2.1` and `peer vue 3.5.38`; installing older ones makes
         * `--strict-peer-dependencies` fail the install, which is the correct
         * behaviour and exactly what the first run of this matrix reported.
         */
        devDependencies: {
          typescript: '5.9.3',
          vite: '8.3.8',
          react: '19.2.0',
          'react-dom': '19.2.0',
          // The wrappers ship .d.ts that import React's types. Without these
          // the typecheck fails inside @zeus-web/*/dist/react, which looks like
          // a defect in the published package but is a missing dev dependency
          // on the consumer side.
          '@types/react': '19.2.0',
          '@types/react-dom': '19.2.0',
          vue: '3.5.38',
        },
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          strict: true,
          target: 'ES2022',
          skipLibCheck: false,
          // No `paths`, no `baseUrl`: nothing may resolve outside node_modules.
          jsx: 'preserve',
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  )

  /*
   * Vite needs an entry. There is no app here — the point is that a production
   * build over the published packages succeeds, so the HTML imports the same
   * modules the other steps do.
   */
  writeFileSync(
    join(directory, 'index.html'),
    [
      '<!doctype html>',
      '<html><body>',
      '<script type="module" src="/src/core.ts"></script>',
      '<script type="module" src="/src/components.ts"></script>',
      '<script type="module" src="/src/ai.ts"></script>',
      '</body></html>',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(directory, 'src', 'core.ts'),
    [
      "import { createSignal } from '@zeus-js/signal'",
      "import { createEffect } from '@zeus-js/signal'",
      '',
      'const [count, setCount] = createSignal(0)',
      'const seen: number[] = []',
      'createEffect(() => { seen.push(count()) })',
      'setCount(1)',
      '',
      'if (seen.at(-1) !== 1) {',
      "  throw new Error('signal did not propagate to its effect')",
      '}',
      '',
      "export { count, setCount, seen }",
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(directory, 'src', 'components.ts'),
    [
      "import '@zeus-web/button'",
      "import '@zeus-web/dialog'",
      "import '@zeus-web/input'",
      "import '@zeus-web/form-field'",
      "import '@zeus-web/data-grid'",
      "import '@zeus-web/themes'",
      "import '@zeus-web/icons'",
      '',
      '/*',
      ' * Importing a custom element package must register its element. Referencing',
      ' * the tags here keeps the import from being tree-shaken away and fails at',
      ' * typecheck if the module does not exist.',
      ' */',
      'const tags = [',
      "  'zeus-button',",
      "  'zeus-dialog',",
      "  'zeus-input',",
      "  'zeus-form-field',",
      "  'zeus-data-grid',",
      '] as const',
      '',
      'export { tags }',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(directory, 'src', 'wrappers.tsx'),
    [
      "import { createElement } from 'react'",
      "import * as ReactWrapper from '@zeus-web/react'",
      "import * as VueWrapper from '@zeus-web/vue'",
      '',
      '/* Both wrappers must expose something mountable; importing them at all',
      ' * proves the published entry points and their types exist. */',
      'const reactSurface = Object.keys(ReactWrapper).length',
      'const vueSurface = Object.keys(VueWrapper).length',
      '',
      'if (reactSurface === 0) throw new Error("@zeus-web/react exposes no exports")',
      'if (vueSurface === 0) throw new Error("@zeus-web/vue exposes no exports")',
      '',
      "export const probe = createElement('div', null)",
      'export { reactSurface, vueSurface }',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(directory, 'src', 'ai.ts'),
    [
      "import * as aiCore from '@zeus-web/ai-core'",
      "import * as aiAdapters from '@zeus-web/ai-adapters'",
      "import * as aiPrimitives from '@zeus-web/ai-primitives'",
      "import '@zeus-web/ai-wc'",
      "import '@zeus-web/ai'",
      "import '@zeus-web/chat'",
      '',
      'const surfaces = {',
      '  aiCore: Object.keys(aiCore).length,',
      '  aiAdapters: Object.keys(aiAdapters).length,',
      '  aiPrimitives: Object.keys(aiPrimitives).length,',
      '}',
      '',
      'for (const [name, count] of Object.entries(surfaces)) {',
      '  if (count === 0) throw new Error(`${name} exposes no exports`)',
      '}',
      '',
      'export { surfaces }',
      '',
    ].join('\n'),
  )

  // The CLI is a published package too; invoking it is the only way to know
  // its bin entry actually exists in the tarball.
  writeFileSync(
    join(directory, 'src', 'cli-probe.mjs'),
    [
      "import { spawnSync } from 'node:child_process'",
      '',
      "const result = spawnSync('npx', ['--no-install', '@zeus-web/cli', '--help'], {",
      "  encoding: 'utf8',",
      '  env: { ...process.env, npm_config_registry: ' + JSON.stringify(REGISTRY) + ' },',
      '})',
      '',
      'if (result.status !== 0) {',
      "  console.error(result.stdout, result.stderr)",
      "  throw new Error('@zeus-web/cli --help failed with ' + result.status)",
      '}',
      '',
    ].join('\n'),
  )
}

/** Reads the installed version of every dependency that resolved. */
function collectVersions(directory) {
  /** @type {Record<string, string>} */
  const versions = {}
  const names = [
    ...CORE_DEPENDENCIES,
    ...UI_DEPENDENCIES,
    ...WRAPPER_DEPENDENCIES,
    ...AI_DEPENDENCIES,
  ]

  for (const name of names) {
    const manifest = join(directory, 'node_modules', ...name.split('/'), 'package.json')

    if (!existsSync(manifest)) continue

    try {
      versions[name] = JSON.parse(readFileSync(manifest, 'utf8')).version
    } catch {
      // A malformed manifest is itself a finding, but it will surface through
      // the step that imports the package. Recording nothing here keeps the
      // evidence honest about what was actually readable.
    }
  }

  return versions
}

export function runMatrix(options) {
  const directory = mkdtempSync(join(tmpdir(), 'zeus-ecosystem-matrix-'))
  /** @type {Array<{name: string, ok: boolean, detail: string}>} */
  const steps = []
  /** @type {string[]} */
  const errors = []

  const evidence = {
    schema: 'zeus.ecosystem.published-consumer-matrix/v1',
    core: options.core,
    ui: options.ui,
    manager: options.manager,
    registry: REGISTRY,
    attemptedAt: new Date().toISOString(),
    result: 'fail',
    steps,
    versions: {},
    errors,
    node: process.version,
    note: 'Installs only published versions. Browser interaction and visual acceptance are a separate gate.',
  }

  try {
    writeFileSync(join(directory, '.npmrc'), `registry=${REGISTRY}\n`)
    // `src/` has to exist before writeProject drops files into it.
    spawnSync('mkdir', ['-p', join(directory, 'src')])
    writeProject(directory, options)

    const installArgs
      = options.manager === 'npm'
        ? ['install', '--strict-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts']
        : ['install', '--strict-peer-dependencies', '--ignore-scripts']

    const install = run(options.manager, installArgs, directory, 600_000)

    steps.push({ name: 'install published packages', ...install })

    if (!install.ok) {
      errors.push(`${options.manager} install failed`)
      // Without node_modules the rest would report a chain of knock-on
      // failures that say nothing new.
      return finish(evidence, options, directory)
    }

    evidence.versions = collectVersions(directory)

    const typecheck = run(
      'npx',
      ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
      directory,
      300_000,
    )

    steps.push({ name: 'typecheck published types', ...typecheck })
    if (!typecheck.ok) errors.push('tsc rejected the published types')

    const coreImport = run(
      'node',
      ['--input-type=module', '-e', "await import('@zeus-js/zeus'); await import('@zeus-js/signal'); await import('@zeus-js/runtime-dom')"],
      directory,
      120_000,
    )

    steps.push({ name: 'import Core at runtime', ...coreImport })
    if (!coreImport.ok) errors.push('Core packages did not import')

    const webcImport = run(
      'node',
      ['--input-type=module', '-e', "await import('@zeus-web/zeus-compat')"],
      directory,
      120_000,
    )

    steps.push({ name: 'import the compat layer at runtime', ...webcImport })
    if (!webcImport.ok) errors.push('@zeus-web/zeus-compat did not import')

    const build = run(
      'npx',
      ['--no-install', 'vite', 'build', '--logLevel', 'warn'],
      directory,
      300_000,
    )

    steps.push({ name: 'production build', ...build })
    if (!build.ok) errors.push('production build failed')

    const cli = run('node', ['src/cli-probe.mjs'], directory, 180_000)

    steps.push({ name: 'invoke the published CLI', ...cli })
    if (!cli.ok) errors.push('@zeus-web/cli did not run from its published bin')

    for (const [name, version] of Object.entries(evidence.versions)) {
      const independent = INDEPENDENT_VERSIONS[name]
      const expected = independent ?? (name.startsWith('@zeus-js/') ? options.core : options.ui)

      if (version !== expected) {
        errors.push(`${name} installed ${version}, expected ${expected}`)
      }
    }

    const missing = [
      ...CORE_DEPENDENCIES,
      ...UI_DEPENDENCIES,
      ...WRAPPER_DEPENDENCIES,
      ...AI_DEPENDENCIES,
    ].filter(name => evidence.versions[name] === undefined)

    if (missing.length > 0) {
      errors.push(`not installed: ${missing.join(', ')}`)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return finish(evidence, options, directory)
}

function finish(evidence, options, directory) {
  evidence.result = evidence.errors.length === 0 ? 'pass' : 'fail'

  if (options.keep) {
    evidence.note += ` Kept at ${directory}.`
  } else {
    rmSync(directory, { recursive: true, force: true })
  }

  if (options.out) {
    writeFileSync(resolve(options.out), `${JSON.stringify(evidence, null, 2)}\n`)
  }

  return evidence
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    /*
     * Fail before installing anything if the pinned versions disagree with the
     * contract.
     *
     * The alternative — installing a stale version and reporting the result as
     * the matrix — is what happened when this constant said `0.0.5` for a day
     * after the plugin moved to `0.0.6`.
     */
    const drift = checkIndependentVersions(process.cwd())

    if (drift.length > 0) {
      for (const error of drift) console.error(`error: ${error}`)
      process.exit(1)
    }

    const evidence = runMatrix(parseOptions(process.argv.slice(2)))

    for (const step of evidence.steps) {
      console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}`)
      if (!step.ok) console.log(step.detail)
    }

    for (const error of evidence.errors) console.error(`error: ${error}`)

    console.log(
      `${evidence.result === 'pass' ? 'matrix PASS' : 'matrix FAIL'}: ${evidence.core} + ${evidence.ui} via ${evidence.manager} (node ${evidence.node})`,
    )
    process.exit(evidence.result === 'pass' ? 0 : 1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
