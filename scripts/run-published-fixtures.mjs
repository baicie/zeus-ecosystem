/**
 * Installs, typechecks and builds every published-consumer fixture.
 *
 * ## Why a runner instead of a shell loop
 *
 * A shell loop loses which fixture failed and why, and on a red CI job that is
 * the only thing anyone wants to know. This records a structured result per
 * fixture per step, writes it as evidence, and exits non-zero if anything
 * failed.
 *
 * ## One manager at a time
 *
 * `--manager npm` makes each fixture install with npm and produce a
 * `package-lock.json`; `pnpm` produces `pnpm-lock.yaml`. The two differ in how
 * they resolve peers, and a fixture that installs under one but not the other
 * is a real finding about the published packages.
 *
 * ## Why the lockfile is deleted first
 *
 * A fixture committed with a pnpm lockfile must not silently reuse it under
 * npm. Removing the other manager's lockfile makes each run resolve from the
 * manifest, which is what a new consumer does.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURES_ROOT = 'fixtures/published-consumer'
const REGISTRY = 'https://registry.npmjs.org/'

export const FIXTURE_NAMES = ['native', 'web-components', 'react', 'vue', 'ai']

/** The install command each manager takes, with peers treated strictly. */
export function installCommand(manager) {
  return manager === 'npm'
    ? ['npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts']]
    : ['pnpm', ['install', '--strict-peer-dependencies', '--ignore-scripts']]
}

function run(command, args, cwd, timeout = 600_000) {
  const child = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, NPM_CONFIG_REGISTRY: REGISTRY },
  })

  return {
    ok: child.status === 0,
    status: child.status,
    // The tail is what carries the actual error; the head is progress noise.
    output: `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim().slice(-3000),
  }
}

/**
 * Runs one fixture and returns its result.
 *
 * Steps are recorded separately rather than stopping at the first failure:
 * a typecheck error alongside a build error is more useful than only the
 * first one, and installing successfully but failing to build is a different
 * problem from failing to install.
 */
export function runFixture(name, options = {}) {
  const directory = resolve(options.root ?? process.cwd(), FIXTURES_ROOT, name)
  const manager = options.manager ?? 'pnpm'
  const result = { fixture: name, manager, steps: [], ok: true }

  if (!existsSync(join(directory, 'package.json'))) {
    result.ok = false
    result.steps.push({ step: 'locate', ok: false, output: 'no package.json' })
    return result
  }

  /*
   * Switching managers is not just a lockfile swap.
   *
   * pnpm installs a symlinked `.pnpm/` store inside node_modules. npm reads
   * that layout as a real dependency tree and fails with a nonsense ERESOLVE
   * about typescript peer-ing typescript — the conflict is an artefact of the
   * two layouts coexisting, not of the packages. Removing node_modules is what
   * makes each run a genuine fresh install for that manager.
   */
  /*
   * Only one manager's lockfile is committed (pnpm's, to match the repository
   * itself). Asking for the other manager removes it so that run resolves from
   * the manifest, and regenerates its own — which is what a new consumer with
   * that manager actually does.
   *
   * The generated lockfile is the evidence: the workflow uploads whichever one
   * the run produced, so the resolved graph is recorded either way.
   */
  const locks = manager === 'npm'
    ? ['pnpm-lock.yaml']
    : ['package-lock.json']

  for (const lock of locks) {
    const path = join(directory, lock)

    if (existsSync(path)) rmSync(path, { force: true })
  }

  if (options.fresh !== false) {
    rmSync(join(directory, 'node_modules'), { recursive: true, force: true })
  }

  const [installBin, installArgs] = installCommand(manager)
  const install = run(installBin, installArgs, directory)

  result.steps.push({ step: 'install', ...install })

  if (!install.ok) {
    result.ok = false
    // Typecheck and build cannot say anything new without node_modules.
    return result
  }

  const typecheck = run('npx', ['--no-install', 'tsc', '--noEmit'], directory, 300_000)

  result.steps.push({ step: 'typecheck', ...typecheck })
  if (!typecheck.ok) result.ok = false

  if (options.buildOnly === false) return result

  const build = run('npx', ['--no-install', 'vite', 'build'], directory, 300_000)

  result.steps.push({ step: 'build', ...build })
  if (!build.ok) result.ok = false

  return result
}

export function runAllFixtures(options = {}) {
  const results = FIXTURE_NAMES.map(name => runFixture(name, options))

  return {
    schema: 'zeus.ecosystem.published-fixture-run/v1',
    manager: options.manager ?? 'pnpm',
    node: process.version,
    registry: REGISTRY,
    checkedAt: new Date().toISOString(),
    passed: results.every(result => result.ok),
    fixtures: results,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const value = (flag, fallback) => {
    const index = args.indexOf(flag)

    return index === -1 ? fallback : args[index + 1]
  }

  const report = runAllFixtures({
    manager: value('--manager', 'pnpm'),
    buildOnly: !args.includes('--build-only'),
  })

  const out = value('--out')

  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`)

  for (const fixture of report.fixtures) {
    const summary = fixture.steps
      .map(step => `${step.step}:${step.ok ? 'ok' : 'FAIL'}`)
      .join(' ')

    console.log(`${fixture.ok ? 'PASS' : 'FAIL'}  ${fixture.fixture.padEnd(16)} ${summary}`)

    for (const step of fixture.steps) {
      if (!step.ok) console.error(`      ${step.step}: ${step.output.split('\n').slice(-6).join('\n      ')}`)
    }
  }

  console.log(
    `${report.passed ? 'fixtures PASS' : 'fixtures FAIL'}: ${report.fixtures.length} fixtures via ${report.manager} (node ${report.node})`,
  )

  process.exit(report.passed ? 0 : 1)
}
