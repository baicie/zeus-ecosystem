/**
 * The single source of truth for "which Zeus packages does this application
 * claim to be built from".
 *
 * ## Why this exists
 *
 * The Playground reports package identity in three places — the project
 * snapshot, the exported project's `package.json`, and build metadata — and
 * before this module each one had its own answer. The snapshot labelled the
 * compiler with the *runtime* version (`wasm:0.2.0-rc.5` when the compiler was
 * `0.1.1-beta.20`), `query` and `router` were reported as the runtime version,
 * and both were literal strings carried over from the core repository. The
 * exported project therefore pinned a version line this application had left
 * behind, and its own `tsc` failed on APIs those versions do not export.
 *
 * ## What it reads
 *
 * `package.json` at build time, through Vite `define`. Manifests are the only
 * declared-for-this-application fact; nothing here is inferred, defaulted, or
 * copied into a second constant. `lockfile` and installed-tree versions are
 * checked separately, by `playground-version-contract.spec.ts`, because a
 * manifest range and the version actually installed are different claims and
 * conflating them is how the last defect hid.
 *
 * ## Fail closed
 *
 * `readVersionContract` throws when a required package is missing. A report
 * that says `compiler: unknown` is not evidence; a build that cannot name its
 * own compiler should not produce an artifact that claims to.
 */

export interface PlaygroundVersionContract {
  readonly schemaVersion: 1
  /** The browser compiler this application loads. Its own version line. */
  readonly compiler: PackageIdentity
  /** The engine that turns a snapshot into modules and an archive. */
  readonly engine: PackageIdentity
  /** Every other `@zeus-js/*` runtime package the app and its exports use. */
  readonly zeus: Readonly<Record<string, string>>
  /** External toolchain versions the exported project will pin. */
  readonly toolchain: {
    readonly vitePlugin: string
    readonly vite: string
    readonly typescript: string
  }
}

export interface PackageIdentity {
  readonly packageName: string
  readonly version: string
}

/** Packages without which the application cannot name its own identity. */
export const REQUIRED_CONTRACT_PACKAGES = [
  '@zeus-js/compiler-wasm',
  '@zeus-js/playground-engine',
  '@zeus-js/zeus',
  '@zeus-js/query',
  '@zeus-js/router',
  '@zeus-js/vite-plugin',
] as const

/** The raw shape Vite injects. Every field is optional: `define` may be absent. */
export interface InjectedVersionContract {
  readonly compiler?: string
  readonly engine?: string
  readonly zeus?: Readonly<Record<string, string>>
  readonly toolchain?: {
    readonly vitePlugin?: string
    readonly vite?: string
    readonly typescript?: string
  }
}

declare const __ZEUS_VERSION_CONTRACT__: InjectedVersionContract | undefined

/**
 * Resolves the contract from the injected object.
 *
 * Throws rather than returning partial data: every consumer here uses the
 * result to *state* an identity, and a partial identity is indistinguishable
 * from a wrong one once it is inside an exported `package.json`.
 */
export function readVersionContract(): PlaygroundVersionContract {
  return parseVersionContract(
    typeof __ZEUS_VERSION_CONTRACT__ === 'undefined'
      ? undefined
      : __ZEUS_VERSION_CONTRACT__,
  )
}

/**
 * The resolution itself, as a pure function.
 *
 * Split from `readVersionContract` for one reason: the injected global is
 * always present under the Vite/Vitest config, so a test that called
 * `readVersionContract(undefined)` would exercise the *injected* contract and
 * the fail-closed path would never run — a passing test proving nothing. That
 * is the shape of the defect this module exists to prevent, so the parse is
 * reachable on its own.
 */
export function parseVersionContract(
  injected: InjectedVersionContract | undefined,
): PlaygroundVersionContract {
  if (!injected) {
    throw new Error(
      'the Playground version contract was not injected at build time; ' +
        'vite.config.ts defines __ZEUS_VERSION_CONTRACT__ from package.json ' +
        'and a build without it cannot report which compiler it used',
    )
  }
  const missing: string[] = []
  const require = (name: string, value: string | undefined): string => {
    if (!value) missing.push(name)
    return value ?? ''
  }

  const compiler = require('@zeus-js/compiler-wasm', injected.compiler)
  const engine = require('@zeus-js/playground-engine', injected.engine)
  const vitePlugin = require('@zeus-js/vite-plugin', injected.toolchain?.vitePlugin)
  const vite = require('vite', injected.toolchain?.vite)
  const typescript = require('typescript', injected.toolchain?.typescript)
  for (const name of REQUIRED_CONTRACT_PACKAGES) {
    if (name === '@zeus-js/compiler-wasm' || name === '@zeus-js/playground-engine') {
      continue
    }
    if (name === '@zeus-js/vite-plugin') continue
    require(name, injected.zeus?.[name])
  }
  if (missing.length > 0) {
    throw new Error(
      `the Playground version contract is missing ${missing.join(', ')}; ` +
        'package.json must declare every package the application reports as its identity',
    )
  }

  return {
    schemaVersion: 1,
    compiler: { packageName: '@zeus-js/compiler-wasm', version: compiler },
    engine: { packageName: '@zeus-js/playground-engine', version: engine },
    zeus: { ...injected.zeus },
    toolchain: { vitePlugin, vite, typescript },
  }
}

/**
 * The `exportProject` options an exported project must pin.
 *
 * Only the two fields the engine's own signature asks for are derived here;
 * the rest come from `toolchain`. Keeping this next to the contract is what
 * stops the export and the snapshot from disagreeing again.
 */
export function exportOptionsFrom(
  contract: PlaygroundVersionContract,
  packageName: string,
): {
  packageName: string
  zeusVersion: string
  vitePluginVersion: string
  viteVersion: string
  typescriptVersion: string
} {
  return {
    packageName,
    zeusVersion: contract.zeus['@zeus-js/zeus'] ?? '',
    vitePluginVersion: contract.toolchain.vitePlugin,
    viteVersion: contract.toolchain.vite,
    typescriptVersion: contract.toolchain.typescript,
  }
}

/**
 * Identifies the compiler in snapshot and report fields.
 *
 * The version line and the package are both part of it because they move
 * independently: the compiler publishes on its own tag, so "the same version
 * as the runtime" is not a fact this application may assume.
 */
export function compilerIdentity(contract: PlaygroundVersionContract): string {
  return `wasm:${contract.compiler.packageName}@${contract.compiler.version}`
}
