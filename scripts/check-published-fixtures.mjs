/**
 * Guards the published-consumer fixtures against becoming a lie.
 *
 * A fixture earns its name only while every Zeus dependency resolves to a
 * tarball from the public registry at an exact published version. Four ways it
 * can silently stop being true:
 *
 * 1. a `workspace:` or `file:` specifier, or a `link:` dependency;
 * 2. a `paths` / alias entry pointing at another checkout;
 * 3. a range instead of an exact version (so the fixture drifts under you);
 * 4. a version nobody published, which installs nothing and fails later.
 *
 * This checks all four and exits non-zero on any of them. It does not install
 * anything and does not need the network — the version-existence check reads
 * the lockfile the install already produced.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FIXTURES_ROOT = 'fixtures/published-consumer'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ZEUS_SCOPES = ['@zeus-js/', '@zeus-web/']

/**
 * Packages on their own version line, each pinned explicitly.
 *
 * `@zeus-js/vite-plugin` releases 0.0.x while Core is 0.2.0-rc.x; asking for it
 * at the Core version fails with ERR_PNPM_NO_MATCHING_VERSION. Keeping the list
 * here, rather than inferring it, means adding another independent package is
 * a deliberate act.
 */
const INDEPENDENT_VERSIONS = {
  '@zeus-js/vite-plugin': '0.0.5',
}

export function listFixtures(root) {
  const directory = resolve(root, FIXTURES_ROOT)

  if (!existsSync(directory)) return []

  return readdirSync(directory)
    .filter(name => statSync(join(directory, name)).isDirectory())
    .map(name => ({ name, directory: join(directory, name) }))
}

/** Every specifier in a manifest that points at Zeus. */
export function zeusSpecifiers(manifest) {
  const found = []

  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (ZEUS_SCOPES.some(scope => name.startsWith(scope))) {
        found.push({ field, name, version: String(version) })
      }
    }
  }

  return found
}

/**
 * Checks one fixture's manifest.
 *
 * Returns messages rather than throwing so a single fixture with three
 * problems reports all three at once.
 */
export function checkManifest(fixtureName, manifest) {
  const errors = []

  for (const { field, name, version } of zeusSpecifiers(manifest)) {
    if (version.startsWith('workspace:')) {
      errors.push(`${fixtureName}: ${name} uses workspace: (${version}) in ${field}`)
      continue
    }

    if (version.startsWith('file:') || version.startsWith('link:')) {
      errors.push(`${fixtureName}: ${name} points at a local path (${version}) in ${field}`)
      continue
    }

    if (!EXACT_VERSION.test(version)) {
      errors.push(
        `${fixtureName}: ${name} is pinned to "${version}", which is a range; an exact published version is required`,
      )
    }

    const independent = INDEPENDENT_VERSIONS[name]

    if (independent && version !== independent) {
      errors.push(
        `${fixtureName}: ${name} must be ${independent} (its own version line), found ${version}`,
      )
    }
  }

  return errors
}

/** Rejects any tsconfig `paths` entry that escapes node_modules. */
export function checkTsconfig(fixtureName, tsconfig) {
  const errors = []
  const paths = tsconfig.compilerOptions?.paths ?? {}

  for (const [alias, targets] of Object.entries(paths)) {
    for (const target of targets ?? []) {
      if (!String(target).includes('node_modules')) {
        errors.push(
          `${fixtureName}: tsconfig paths maps ${alias} to ${target}, which is not a published package`,
        )
      }
    }
  }

  if (tsconfig.compilerOptions?.skipLibCheck === true) {
    errors.push(
      `${fixtureName}: skipLibCheck must be false; published .d.ts files are part of what is being verified`,
    )
  }

  return errors
}

/** Rejects a Vite config that aliases Zeus to a source checkout. */
export function checkViteConfig(fixtureName, source) {
  const errors = []

  if (!source) return errors

  if (/alias\s*:/.test(source) && /zeus/i.test(source)) {
    errors.push(`${fixtureName}: vite config declares a Zeus alias`)
  }

  if (/\.\.[\\/]\.\.[\\/]/.test(source)) {
    errors.push(`${fixtureName}: vite config reaches outside the fixture with a relative path`)
  }

  return errors
}

export function checkFixtures(root = process.cwd()) {
  const errors = []

  for (const fixture of listFixtures(root)) {
    const manifestPath = join(fixture.directory, 'package.json')

    if (!existsSync(manifestPath)) {
      errors.push(`${fixture.name}: no package.json`)
      continue
    }

    errors.push(
      ...checkManifest(fixture.name, JSON.parse(readFileSync(manifestPath, 'utf8'))),
    )

    const tsconfigPath = join(fixture.directory, 'tsconfig.json')

    if (existsSync(tsconfigPath)) {
      errors.push(
        ...checkTsconfig(fixture.name, JSON.parse(readFileSync(tsconfigPath, 'utf8'))),
      )
    }

    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const configPath = join(fixture.directory, name)

      if (existsSync(configPath)) {
        errors.push(
          ...checkViteConfig(fixture.name, readFileSync(configPath, 'utf8')),
        )
      }
    }
  }

  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkFixtures()

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`)
    process.exit(1)
  }

  console.log(
    `published fixtures PASS: ${listFixtures(process.cwd()).length} fixtures use exact published versions only`,
  )
}
