/**
 * Runs a TypeScript entry point with the flags it needs, portably.
 *
 * ## Why this exists
 *
 * `node:sqlite` became available without a flag partway through the Node 24
 * line. The repository supports `^22.18.0 || >=24.11.0`, so on 22.x and early
 * 24.x the module exists but throws `ERR_UNKNOWN_BUILTIN_MODULE` unless
 * `--experimental-sqlite` is passed, and on later 24.x the flag is unnecessary
 * (and would warn about an unknown option on versions that dropped it).
 *
 * Writing `NODE_OPTIONS=--experimental-sqlite tsx ...` in package.json is
 * POSIX shell syntax: it does not run under cmd.exe, and it applies the flag
 * even where it is not needed. This launcher checks the running Node, adds the
 * flag only when the module is genuinely unavailable, and then spawns tsx.
 *
 * Usage:
 *   node scripts/run-with-sqlite.mjs <entry.ts> [args...]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

/** True when `node:sqlite` is reachable from this process without a flag. */
export function sqliteAvailable() {
  try {
    require('node:sqlite')

    return true
  } catch {
    return false
  }
}

/** The extra Node arguments a child needs to load `node:sqlite`. */
export function requiredNodeOptions(available = sqliteAvailable()) {
  return available ? [] : ['--experimental-sqlite']
}

const argv = process.argv.slice(2)

/*
 * `--cwd <dir>` lets a caller run another app's test command from its own
 * directory without each app needing its own copy of this launcher.
 */
const cwdIndex = argv.indexOf('--cwd')
const runCwd = cwdIndex === -1 ? process.cwd() : path.resolve(process.cwd(), argv[cwdIndex + 1])
const [entry, ...rest] = cwdIndex === -1
  ? argv
  : [...argv.slice(0, cwdIndex), ...argv.slice(cwdIndex + 2)]

/*
 * Only act when executed, not when imported for its two helpers. Without this
 * guard, a test that imports `sqliteAvailable` runs the launcher's own body.
 */
const invokedDirectly
  = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly && entry === undefined) {
  console.error('usage: node scripts/run-with-sqlite.mjs <entry.ts> [args...]')
  process.exit(2)
}

if (invokedDirectly) {
/*
 * tsx is resolved rather than assumed: this runs from the app directory, and
 * `process.execPath` keeps the same Node binary the launcher already probed.
 * `require.resolve('tsx/cli')` is the loader path that works on every platform,
 * including Windows where there is no `npx` shell shim.
 */
/*
 * A `.ts` entry needs the tsx loader; anything else is a normal Node program
 * and running it through tsx would change how it resolves modules. `vitest`'s
 * own entry point is `.mjs`, for instance, and must run as-is.
 */
const target = path.resolve(runCwd, entry)
const needsLoader = /\.(?:ts|tsx|mts|cts)$/.test(entry)
const launcherArgs = needsLoader ? [require.resolve('tsx/cli')] : []
const execArgs = needsLoader ? [target] : [target]

/*
 * The flag has to reach grandchild processes too.
 *
 * A plain `node --experimental-sqlite vitest` passes the flag to vitest only;
 * vitest then forks its own workers without it, and they fail with
 * `No such built-in module: node:sqlite`. `NODE_OPTIONS` is inherited by every
 * descendant, which is what a test runner needs.
 *
 * It is still decided here, by probing the module, rather than hardcoded in
 * package.json where it would be both POSIX-only and wrong on Node versions
 * that no longer accept the flag.
 */
const extra = requiredNodeOptions()
const nodeOptions = [process.env.NODE_OPTIONS, ...extra].filter(Boolean).join(' ')

const child = spawn(
  process.execPath,
  [...launcherArgs, ...execArgs, ...rest],
  {
    stdio: 'inherit',
    cwd: runCwd,
    env: extra.length === 0
      ? process.env
      : { ...process.env, NODE_OPTIONS: nodeOptions },
  },
)

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('close', (code) => {
  process.exit(code ?? 1)
})
}
