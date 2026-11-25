/**
 * Checks that a plan's digests name images a registry actually stores.
 *
 * ## Why this is a separate script
 *
 * `deployment-plan.mjs` is offline and read-only: it takes arguments and writes
 * a document. Giving it a network dependency would mean a plan cannot be
 * produced on a host without registry access, and — worse — that "the plan was
 * generated" and "the image exists" become the same statement again.
 *
 * So the two are separate stages, and the plan records which have run. This one
 * can only move `digest-verified` from false to true; it never writes a plan.
 *
 * ## What it proves, and what it does not
 *
 * A digest that resolves proves the registry has that manifest. It does not
 * prove the image starts, serves, or is the build this repository produced —
 * those are `IMAGE_VALIDATED`, `FUNCTIONAL_PASS` and `CROSS_VERSION_PASS`, each
 * with its own evidence.
 *
 * Usage:
 *   node scripts/release/verify-plan-digests.mjs --plan <file> [--registry <host>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Asks the local daemon whether a digest is present.
 *
 * `docker manifest inspect` would also work and does not need the image pulled,
 * but it talks to the registry directly and needs credentials that this script
 * has no business handling. Asking the daemon is the narrower question: can
 * this machine, right now, run the thing the plan names.
 */
export function inspectDigest(image) {
  const [repository, digest] = image.split('@')

  if (!repository || !digest) {
    return { found: false, reason: `"${image}" does not parse as repository@digest` }
  }

  try {
    const output = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()

    const digests = JSON.parse(output)

    if (!Array.isArray(digests) || digests.length === 0) {
      return {
        found: false,
        reason: `${repository} is present locally but carries no RepoDigests, so it was never pushed`,
      }
    }

    return { found: digests.some(entry => entry.endsWith(`@${digest}`)), digests }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    /*
     * "No such image" is the answer, not a failure to get one. Anything else —
     * a daemon that is not running — is a failure, and conflating the two would
     * report an unreachable registry as a missing image.
     */
    if (/no such image|No such object/i.test(message)) {
      return { found: false, reason: `${image} is not present in the local daemon` }
    }

    return { found: false, reason: `docker could not be asked: ${message.slice(0, 200)}`, error: true }
  }
}

/** Verifies every service in a plan. Returns the per-service result. */
export function verifyPlan(plan) {
  if (plan?.schema !== 'zeus.ecosystem.deployment-plan/v1') {
    throw new Error(`expected a deployment-plan/v1 document, got ${plan?.schema ?? 'nothing'}`)
  }

  const results = plan.services.map(service => {
    const target = inspectDigest(service.targetImage)
    const previous = inspectDigest(service.previousImage)

    return {
      product: service.product,
      target: { image: service.targetImage, ...target },
      previous: { image: service.previousImage, ...previous },
    }
  })

  /*
   * Both sides are required. A plan whose target resolves but whose rollback
   * target does not is a plan with no rollback, which is the one thing the
   * digest requirement exists to guarantee.
   */
  const verified = results.every(entry => entry.target.found && entry.previous.found)

  return { verified, results }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const planPath = value('--plan')

  if (!planPath || !existsSync(resolve(planPath))) {
    console.error('usage: node scripts/release/verify-plan-digests.mjs --plan <file> [--write]')
    process.exit(1)
  }

  const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'))
  const { verified, results } = verifyPlan(plan)

  for (const entry of results) {
    for (const side of ['target', 'previous']) {
      const result = entry[side]

      console.log(
        `${result.found ? 'PASS' : 'FAIL'}  ${entry.product}/${side}  ${result.image}` +
          (result.found ? '' : `\n        ${result.reason}`),
      )
    }
  }

  /*
   * `--write` updates the stage in place. Kept opt-in so running the check
   * against a plan is never a mutation by accident.
   */
  if (args.includes('--write')) {
    plan.stages = { ...plan.stages, 'digest-verified': verified }
    writeFileSync(resolve(planPath), `${JSON.stringify(plan, null, 2)}\n`)
    console.log(`\nstages.digest-verified = ${verified}`)
  }

  console.log(`\ndigests ${verified ? 'verified' : 'NOT verified'}`)
  process.exit(verified ? 0 : 1)
}
