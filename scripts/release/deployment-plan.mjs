/**
 * Produces a deployment plan, and never deploys.
 *
 * ## Why a plan file rather than "build succeeded, now run ssh"
 *
 * A deployment is a decision with a rollback. Writing it down first separates
 * stages that get conflated when they happen in one script:
 *
 *   plan created          a document exists
 *   schema validated      the document has the shape this version defines
 *   premises verified     the services, the unit and the rollback target exist
 *   digest verified       a registry actually stores that manifest
 *   rehearsed             the sequence was exercised against real containers
 *   applied               the change happened
 *   production accepted   the change was accepted where users are
 *
 * This script does the first three and refuses to imply the rest. The
 * distinctions are in `stages`, so a reader cannot mistake a well-formed plan
 * for a verified one — the earlier version printed a plan that looked equally
 * final whether or not any image had ever been pushed.
 *
 * ## Why digests
 *
 * The plan names `image@sha256:…`. A tag can be moved; a digest cannot, so a
 * rollback that restores `previousImage` restores exactly the bytes that were
 * running before. A local image ID is not a substitute: it means nothing
 * outside the daemon that built it.
 *
 * ## Why no apply
 *
 * There is deliberately no code path here that can change a running service.
 *
 * Usage:
 *   node scripts/release/deployment-plan.mjs --unit ai \
 *     --environment staging \
 *     --target <product>=<ref>@sha256:<digest> [--target ...] \
 *     --previous <product>=<ref>@sha256:<digest> [--previous ...] \
 *     --out <file>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIGEST = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/
const ALL_ZERO = /@sha256:0{64}$/
const SHA256_ALONE = /^sha256:([0-9a-f]{64})$/

/** Environments a plan may name. Production is absent on purpose. */
export const PLANNED_ENVIRONMENTS = ['staging', 'preview', 'local']

/** The stages a plan can be at, in order. A plan records where it got to. */
export const PLAN_STAGES = [
  'plan-created',
  'schema-validated',
  'premises-verified',
  'digest-verified',
  'rehearsed',
  'applied',
  'production-accepted',
]

/** Reads the product declarations so a plan cannot name an unknown service. */
export function readProducts(root) {
  const file = join(root, 'infra/contracts/products.json')

  if (!existsSync(file)) throw new Error(`${file} is missing`)

  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Parses `product=ref@sha256:digest` into its parts.
 *
 * Rejects rather than repairs: every one of these is a value that would produce
 * a plan pointing at something other than what the operator meant.
 */
export function parseImageAssignment(raw) {
  const separator = raw.indexOf('=')

  if (separator === -1) {
    throw new Error(`expected product=image@sha256:digest, got "${raw}"`)
  }

  const product = raw.slice(0, separator).trim()
  const image = raw.slice(separator + 1).trim()

  if (product === '') {
    throw new Error(`"${raw}" names no product`)
  }

  if (SHA256_ALONE.test(image)) {
    throw new Error(
      `"${image}" is a bare digest; a digest names content but not the repository it came from, and excluding ` +
        'the repository would let a plan pull an unrelated image that happens to share the manifest',
    )
  }

  if (!DIGEST.test(image)) {
    throw new Error(
      `"${image}" is not digest-pinned; a tag or a local image ID cannot name a rollback target`,
    )
  }

  if (ALL_ZERO.test(image)) {
    throw new Error(
      `"${image}" is all zeros; a digest of sixty-four zeroes is a placeholder, and a plan built on one ` +
        'records that no image was ever pushed',
    )
  }

  return { product, image }
}

/**
 * Validates the premises a plan depends on.
 *
 * Every check names the reason, because the caller sees only these strings.
 */
export function validatePlan(root, input) {
  const declaration = readProducts(root)
  const errors = []

  if (!PLANNED_ENVIRONMENTS.includes(input.environment)) {
    errors.push(
      `"${input.environment}" is not a plannable environment; expected one of ${PLANNED_ENVIRONMENTS.join(', ')}` +
        (input.environment === 'production'
          ? ' — production changes need an explicit, separate authorization and this script never plans them'
          : ''),
    )
  }

  const unit = declaration.deploymentUnits[input.deploymentUnit]

  if (!unit) {
    return { errors: [`unknown deployment unit "${input.deploymentUnit}"`] }
  }

  /*
   * Duplicates are their own error, not something a Map quietly absorbs.
   * `--target ai-host=… --target ai-host=…` with two different digests is an
   * operator mistake, and picking whichever arrived last would record a plan
   * nobody chose.
   */
  errors.push(...duplicateErrors(input.targets, 'target'))
  errors.push(...duplicateErrors(input.previous, 'previous'))

  if (errors.some(error => error.includes('is not a declared')) === false) {
    // Keep collecting: a duplicate does not stop the remaining checks.
  }

  const known = new Set(declaration.products.map(product => product.productId))
  const targets = new Map(input.targets.map(entry => [entry.product, entry.image]))
  const previous = new Map(input.previous.map(entry => [entry.product, entry.image]))

  for (const entry of [...input.targets, ...input.previous]) {
    if (!known.has(entry.product)) {
      errors.push(`"${entry.product}" is not a declared product`)
    }
  }

  /*
   * A unit is all-or-nothing. Deploying half of it would leave the workbench
   * pointing at a host of a different version, which is the skew this
   * declaration exists to prevent.
   */
  for (const product of unit.products) {
    if (!targets.has(product)) errors.push(`${product} has no target image`)
    if (!previous.has(product)) {
      errors.push(`${product} has no previous image; a plan with no rollback target is not a plan`)
    }
  }

  for (const product of new Set([...targets.keys(), ...previous.keys()])) {
    if (!unit.products.includes(product)) {
      errors.push(`${product} is not part of unit "${input.deploymentUnit}"`)
    }
  }

  /*
   * The same digest for target and previous is not always wrong — a restart is
   * a legitimate operation — but it is not an upgrade, and calling it one would
   * put a rollback rehearsal's name on a no-op. Classify it instead.
   */
  const unchanged = unit.products.filter(
    product => targets.get(product) !== undefined && targets.get(product) === previous.get(product),
  )

  /*
   * Only ask "does this change anything" once every product actually has both
   * images. Before that the answer is "no-op" for the trivial reason that
   * nothing is filled in, and reporting both makes one mistake look like two.
   */
  const comparable = unit.products.every(
    product => targets.has(product) && previous.has(product),
  )
  const changeKind = comparable ? resolveChangeKind(unit.products, targets, previous) : 'incomplete'

  if (comparable && changeKind === 'no-op' && input.environment !== 'local') {
    errors.push(
      'every target equals its rollback target, so this plan cannot change anything; ' +
        'that is a restart (--allow-restart) or a mistake, not a deployment',
    )
  }

  /*
   * `dataCompatibility` is a claim about whether the previous version can read
   * what the new one writes. Without evidence it stays `unverified`, and a plan
   * that says `compatible` while carrying no evidence is refused.
   */
  if (input.dataCompatibility === 'compatible' && (input.evidence ?? []).length === 0) {
    errors.push(
      'dataCompatibility "compatible" needs evidence; without it the field must stay "unverified"',
    )
  }

  return {
    errors,
    unit,
    declaration,
    changeKind,
    unchanged,
    targets,
    previous,
  }
}

/** Reports the products named more than once in one list. */
function duplicateErrors(entries, label) {
  const seen = new Map()

  for (const entry of entries) {
    seen.set(entry.product, (seen.get(entry.product) ?? 0) + 1)
  }

  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([product]) => `${product} appears more than once as a --${label}; keep one`)
}

/**
 * Names what kind of change the plan describes.
 *
 * The distinction exists because a rehearsal of "upgrade then roll back" and a
 * rehearsal of "restart the same image" prove different things, and the earlier
 * script proved the second while being read as the first.
 */
export function resolveChangeKind(products, targets, previous) {
  const changes = products.filter(
    product =>
      targets.get(product) !== undefined &&
      previous.get(product) !== undefined &&
      targets.get(product) !== previous.get(product),
  )

  if (changes.length === 0) return 'no-op'
  if (changes.length < products.length) return 'partial-upgrade'

  return 'cross-version-upgrade'
}

/** Builds the plan document. */
export function createPlan(root, input) {
  const { errors, unit, declaration, changeKind, targets, previous } = validatePlan(root, input)

  if (errors.length > 0) {
    throw new Error(errors.map(error => `  ${error}`).join('\n'))
  }

  /*
   * Services are built from the same Maps `validatePlan` checked, not from the
   * raw argument list. The earlier version validated a deduplicated view and
   * then looked each product up with `find` on the original array, so a
   * duplicate argument could plan a different image than the one that passed.
   */
  const services = (unit.order ?? unit.products).map(product => ({
    product,
    targetImage: targets.get(product),
    previousImage: previous.get(product),
    runtimePort: declaration.products.find(entry => entry.productId === product).runtimePort,
  }))

  return {
    schema: 'zeus.ecosystem.deployment-plan/v1',
    environment: input.environment,
    deploymentUnit: input.deploymentUnit,
    changeKind,
    services,
    acceptanceEvidence: input.evidence ?? [],
    dataCompatibility: input.dataCompatibility ?? 'unverified',
    rollback: {
      strategy: 'restore-previous-image-set',
      note:
        'Restoring the previous image set restores the binaries, not the database. ' +
        'A schema change needs its own compatibility evidence.',
      /*
       * A partial upgrade cannot be rolled back by restoring the whole set:
       * that would revert the services that never changed too, which nobody
       * asked for and which may not even be available.
       */
      restores: services.filter(service => service.targetImage !== service.previousImage).map(service => service.product),
    },
    /*
     * Where this plan got to. Creating one moves it two steps and no further:
     * every later step needs something this script does not have — a registry,
     * containers, an authorised change.
     */
    stages: {
      'plan-created': true,
      'schema-validated': true,
      'premises-verified': true,
      'digest-verified': false,
      rehearsed: false,
      applied: false,
      'production-accepted': false,
    },
    // Stated in the plan so a reader cannot mistake it for a completed change.
    applied: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const all = flag =>
    args.reduce((found, arg, index) => {
      if (arg === flag) {
        const value = args[index + 1]

        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${flag} needs a value`)
        }

        found.push(value)
      }

      return found
    }, [])
  const value = flag => all(flag)[0]

  const KNOWN = new Set([
    '--unit',
    '--environment',
    '--target',
    '--previous',
    '--evidence',
    '--data-compatibility',
    '--allow-restart',
    '--out',
  ])

  try {
    for (const arg of args) {
      if (arg.startsWith('--') && !KNOWN.has(arg)) {
        throw new Error(`unknown argument "${arg}"; this script refuses rather than ignores, so a typo cannot silently change a plan`)
      }
    }

    const plan = createPlan(resolve(process.cwd()), {
      deploymentUnit: value('--unit') ?? '',
      environment: value('--environment') ?? 'staging',
      targets: all('--target').map(parseImageAssignment),
      previous: all('--previous').map(parseImageAssignment),
      evidence: all('--evidence'),
      dataCompatibility: value('--data-compatibility'),
      allowRestart: args.includes('--allow-restart'),
    })

    if (plan.changeKind === 'no-op' && !args.includes('--allow-restart')) {
      throw new Error('this plan changes nothing; pass --allow-restart if a restart is what you meant')
    }

    const out = value('--out')
    const text = `${JSON.stringify(plan, null, 2)}\n`

    if (out) writeFileSync(resolve(out), text)

    console.log(text)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
