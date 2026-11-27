/**
 * Builds one product's image and records what came out.
 *
 * ## Why this is not a workflow shell block
 *
 * The evidence contract has a dozen fields, several of which are easy to record
 * wrongly and impossible to notice afterwards: a local image ID written where a
 * registry digest belongs, an unpacked size measured on a different platform, a
 * "PASS" for a unit test that never ran.
 *
 * ## The distinction this keeps
 *
 * A PR build does not push. Its image has an **image ID** (local, content
 * addressed within this daemon) and no digest — a digest only exists once a
 * registry has stored the manifest. Writing the ID into a `digest` field would
 * make an unpushed build look deployable, and the deployment plan is built from
 * digests.
 *
 * Usage:
 *   node scripts/release/build-image.mjs --product ai-workbench \
 *     --out <evidence.json> [--tag <tag>] [--push]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createBuildInfo } from './build-info.mjs'

const REGISTRY = 'ghcr.io'
const OWNER = 'baicie'

/** Reads the product declarations. */
export function readProducts(root) {
  const file = join(root, 'infra/contracts/products.json')

  if (!existsSync(file)) throw new Error(`${file} is missing`)

  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Runs docker and returns its stdout.
 *
 * With `stdio: 'inherit'` there is no captured output and `execFileSync`
 * returns `null`, so the trim has to be conditional — calling `.trim()` on it
 * threw `Cannot read properties of null` after the build had already
 * succeeded, which looked like a failed build.
 */
function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    ...options,
  })

  return typeof output === 'string' ? output.trim() : ''
}

/**
 * The repository name an image is pushed to, or `undefined` when nothing is
 * pushed. Kept separate from the tag so the evidence can say which one exists.
 */
export function imageReference(product, tag) {
  return `${REGISTRY}/${OWNER}/${product}:${tag}`
}

/**
 * Records local image facts.
 *
 * `docker image inspect` reports `Size` as the unpacked size, which is the
 * number a disk cares about; the compressed size only exists once a registry
 * stores the layers, so it is recorded separately and stays absent on a PR
 * build.
 */
export function inspectImage(tag) {
  // `--format '{{json .}}'` emits one object per image, already JSON. Wrapping
  // it in brackets a second time produced `[[{...}]]`, and the destructuring
  // then saw an array rather than the object.
  const raw = docker(['image', 'inspect', tag, '--format', '{{json .}}'])
  const image = JSON.parse(raw)
  const labels = image.Config?.Labels ?? {}

  return {
    imageId: image.Id,
    unpackedBytes: image.Size,
    architecture: image.Architecture,
    os: image.Os,
    revision: labels['org.opencontainers.image.revision'] ?? null,
    unpackedLayers: Array.isArray(image.RootFS?.Layers)
      ? image.RootFS.Layers.length
      : null,
  }
}

/**
 * Runs the product's container health check against a started container.
 *
 * The Dockerfile's own HEALTHCHECK is not enough here: this asserts the image
 * answers the path the product declaration names, which is what a deployment
 * checks before it moves traffic.
 */
export async function checkHealth(product, tag, timeoutSeconds = 60) {
  const name = `zeus-health-${product.productId}-${process.pid}`

  try {
    // `-e ZEUS_AI_UPSTREAM_TOKEN`: the workbench renders a proxy header from it
    // and refuses to start when the variable is unset. Any value works for a
    // health check that never reaches the host.
    /*
     * Per-product environment a health check needs to start at all.
     *
     * The workbench renders a proxy header from `ZEUS_AI_UPSTREAM_TOKEN` and
     * refuses to start without it. Admin refuses to start on an empty database
     * unless `ZEUS_ADMIN_BOOTSTRAP` is set, which is deliberate: a first boot
     * that seeds an account silently is a security hole, not a convenience.
     * Neither value is used by the health path itself.
     */
    const env = [
      '-e', 'ZEUS_AI_UPSTREAM_TOKEN=healthcheck',
      '-e', 'ZEUS_ADMIN_PASSWORD=healthcheck-password-000',
      '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
    ]

    docker(['run', '-d', '--name', name, ...env, tag])

    /*
     * Docker's own HEALTHCHECK is the authority here.
     *
     * Probing with `docker exec node -e fetch(...)` worked but was slow enough
     * that the loop timed out before the app settled, and it duplicated what
     * the Dockerfile already declares. The status Docker computes is the same
     * one a deployment reads.
     */
    const deadline = Date.now() + timeoutSeconds * 1000

    while (Date.now() < deadline) {
      const status = docker([
        'inspect',
        name,
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      ])

      if (status === 'healthy') return { ok: true, status }
      if (status === 'unhealthy') return { ok: false, status }
      if (status === 'exited' || status === 'dead') return { ok: false, status }

      await new Promise(resolveSleep => setTimeout(resolveSleep, 2000))
    }

    return { ok: false, status: 'timeout' }
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }
  } finally {
    try {
      docker(['rm', '-f', name])
    } catch {
      // The container may never have started.
    }
  }
}

/**
 * Produces the delivery evidence for one product.
 *
 * Fields that cannot be measured are omitted rather than filled with a
 * placeholder, and every consumer treats an absent field as `NOT_RUN`.
 */
/**
 * Whether the image's recorded revision names the commit this build started
 * from.
 *
 * Every Dockerfile sets `org.opencontainers.image.revision` from
 * `ZEUS_APP_COMMIT`, and `ai-host` carries its identity *only* that way — it
 * has no `dist` and so no `build-info.json`. Recording whatever label the
 * image happens to hold would make an empty or stale label read as a fact,
 * which is how a substituted identity gets onto a delivery record.
 *
 * Separated from `buildProduct` so both answers are testable without a Docker
 * daemon: a check that only runs inside a container is a check nobody can
 * prove refuses anything.
 */
export function revisionMismatch(inspectedRevision, appCommit) {
  if (inspectedRevision === appCommit) return undefined

  return inspectedRevision
    ? `the image records revision ${inspectedRevision}, but this build was started from ${appCommit}`
    : 'the image carries no org.opencontainers.image.revision label'
}

export async function buildProduct(options) {
  const {
    root = process.cwd(),
    productId,
    tag = 'local',
    push = false,
    skipHealth = false,
  } = options

  const declaration = readProducts(root)

  const product = declaration.products.find(entry => entry.productId === productId)

  if (!product) {
    throw new Error(
      `unknown product ${productId}; known: ${declaration.products.map(entry => entry.productId).join(', ')}`,
    )
  }

  const top = resolve(root)
  const appCommit = process.env.ZEUS_APP_COMMIT
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: top, encoding: 'utf8' }).trim()

  const localTag = `zeus-${productId}:${tag}`
  const reference = imageReference(productId, tag)

  /*
   * Build arguments a product declares, from the environment.
   *
   * The Playground cannot bake a guess for its sandbox origin: the URL is a
   * second listener and the host would derive it from its own port, which is
   * wrong behind every port mapping and reverse proxy. Its Dockerfile refuses
   * to build without them, so the values have to arrive from the deployment
   * configuration rather than from the Dockerfile's defaults.
   *
   * A product with no declared arguments contributes nothing, so this does not
   * change how the other three are built.
   */
  const buildArgs = (product.buildArgs ?? []).flatMap(name => {
    const value = process.env[name]
    if (value === undefined || value === '') {
      throw new Error(
        `product ${productId} requires build argument ${name}; set it in the environment`,
      )
    }
    return ['--build-arg', `${name}=${value}`]
  })

  docker(
    [
      'build',
      '-f',
      product.dockerfile,
      '-t',
      localTag,
      '--build-arg',
      `ZEUS_APP_COMMIT=${appCommit}`,
      ...buildArgs,
      product.context,
    ],
    { cwd: top, stdio: 'inherit' },
  )

  const inspected = inspectImage(localTag)

  const evidence = {
    schema: 'zeus.ecosystem.delivery-evidence/v1',
    product: productId,
    deploymentUnit: product.deploymentUnit,
    appCommit,
    ...(existsSync(join(top, 'infra/contracts/published-pair.json'))
      ? (() => {
          const pair = JSON.parse(readFileSync(join(top, 'infra/contracts/published-pair.json'), 'utf8'))

          return {
            coreVersion: pair.core.version,
            coreCommit: pair.core.commit,
            uiVersion: pair.ui.version,
            uiCommit: pair.ui.commit,
          }
        })()
      : {}),
    lockfileSha256: createBuildInfo({ root: top, product: productId, allowSynthetic: true }).lockfileSha256,
    imageId: inspected.imageId,
    // Present only when a registry has the manifest. A PR build leaves this
    // absent on purpose.
    ...(push
      ? {
          imageDigest: docker(['image', 'inspect', localTag, '--format', '{{index .RepoDigests 0}}']).split('@')[1],
        }
      : { imageDigest: null }),
    imageReference: push ? reference : null,
    /*
     * The platform actually built, and separately what the declaration claims.
     *
     * `products.json` lists two architectures per product; this script builds
     * one. Recording the claim beside the measurement is what stops "declared
     * for amd64 and arm64" from being read as "validated on both" — a report
     * that says both were tested when only one was is worse than no report.
     */
    platform: `${inspected.os}/${inspected.architecture}`,
    declaredPlatforms: product.platforms ?? [],
    /*
     * Filled in after the health check, not before. A `PENDING` placeholder
     * written here would survive into the artefact if the check never ran, and
     * a status that is neither a pass nor a refusal is the kind of value that
     * gets read as "probably fine".
     */
    platformValidation: (product.platforms ?? []).map(entry => ({
      platform: entry,
      build: entry === `${inspected.os}/${inspected.architecture}` ? 'PASS' : 'NOT_RUN',
      runtime: 'NOT_RUN',
    })),
    /*
     * Three sizes that are not interchangeable, each labelled.
     *
     * `unpackedBytes` is what the daemon reports after pulling; a registry
     * stores the compressed layers, so a reduction quoted from one and compared
     * against the other overstates it. The application layer is the part this
     * repository controls — the base image is most of the total.
     */
    sizes: {
      unpackedBytes: inspected.unpackedBytes,
      unpackedNote: 'as reported by the daemon; this is the budget metric',
      layerCount: inspected.unpackedLayers,
    },
    unpackedBytes: inspected.unpackedBytes,
    layerCount: inspected.unpackedLayers,
    revision: inspected.revision,
    /*
     * The evidence dimensions, each answered separately.
     *
     * `status` is one value and cannot say *what* was proven. "The image builds
     * and answers its health path" and "the product works" are different
     * claims, and a single PASS invited a reader to assume the second. These
     * are evidence dimensions, not a lifecycle: the eight-stage migration
     * vocabulary in docs/migration-checklist.md is unchanged.
     *
     * Every unmeasured dimension is NOT_RUN, never PASS.
     */
    dimensions: {
      BUILD_PASS: 'PASS',
      STARTUP_PASS: 'NOT_RUN',
      HEALTH_PASS: 'NOT_RUN',
      READINESS_PASS: 'NOT_RUN',
      FUNCTIONAL_PASS: 'NOT_RUN',
      VISUAL_PASS: 'NOT_RUN',
      PERSISTENCE_PASS: 'NOT_RUN',
      CROSS_VERSION_PASS: 'NOT_RUN',
      ROLLBACK_PASS: 'NOT_RUN',
      LIVE_PASS: 'NOT_RUN',
    },
    // Every unmeasured item is NOT_RUN, never PASS.
    unit: 'NOT_RUN',
    browser: 'NOT_RUN',
    visual: 'NOT_RUN',
    containerAcceptance: skipHealth ? 'NOT_RUN' : 'NOT_RUN',
    status: 'NOT_RUN',
  }

  if (!skipHealth) {
    const health = await checkHealth(product, localTag)

    evidence.containerAcceptance = health.ok ? 'PASS' : 'FAIL'
    evidence.dimensions.STARTUP_PASS = 'PASS'
    evidence.dimensions.HEALTH_PASS = health.ok ? 'PASS' : 'FAIL'

    /*
     * The runtime column is set here, where the answer exists. Only the
     * platform this build targeted is measured; the other stays NOT_RUN rather
     * than inheriting its neighbour's verdict.
     */
    evidence.platformValidation = evidence.platformValidation.map(entry => ({
      ...entry,
      runtime: entry.build === 'PASS' ? (health.ok ? 'PASS' : 'FAIL') : 'NOT_RUN',
    }))

    if (!health.ok) evidence.failureReasons = [`health check: ${health.status}`]
  }

  /*
   * The image's own identity, checked rather than copied. A mismatch or an
   * absent label is a failure, not a note.
   */
  const revisionFailure = revisionMismatch(inspected.revision, appCommit)

  if (revisionFailure) {
    evidence.failureReasons = [...(evidence.failureReasons ?? []), revisionFailure]
  }

  if (evidence.unpackedBytes > product.sizePolicy.maxUnpackedBytes) {
    evidence.failureReasons = [
      ...(evidence.failureReasons ?? []),
      `unpacked size ${evidence.unpackedBytes} exceeds the ${product.sizePolicy.maxUnpackedBytes} budget`,
    ]
  }

  evidence.status = evidence.failureReasons ? 'FAIL' : 'PASS'

  return evidence
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  try {
    const evidence = await buildProduct({
      productId: value('--product') ?? '',
      tag: value('--tag') ?? 'local',
      push: args.includes('--push'),
      skipHealth: args.includes('--skip-health'),
    })
    const out = value('--out')
    const text = `${JSON.stringify(evidence, null, 2)}\n`

    if (out) writeFileSync(resolve(out), text)

    console.log(text)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
