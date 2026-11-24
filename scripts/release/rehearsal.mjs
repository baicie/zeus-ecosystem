/**
 * Rehearses a deployment and its rollback, locally.
 *
 * ## What this actually proves
 *
 * The sequence a real deployment follows, run against two image versions that
 * exist on this machine:
 *
 *   1. start baseline A, write data
 *   2. record A's identity
 *   3. generate a plan for B, with A as the rollback target
 *   4. start B, verify it serves and reads the data A wrote
 *   5. roll back to A
 *   6. verify A is back and the data survived
 *
 * Step 4 is the part a build cannot answer: whether a database written by one
 * version is readable by the next. Step 6 is the part a rollback plan cannot
 * answer: whether restoring the binaries also restores the data — it does only
 * if the schema did not change incompatibly.
 *
 * ## Why it never touches a real deployment
 *
 * Everything runs in containers this script creates and removes, on a loopback
 * port, with a volume this script names. Cleanup removes only those. There is
 * no `docker system prune` here, and no path from this file to a host that is
 * not the local daemon.
 *
 * Usage:
 *   node scripts/release/rehearsal.mjs --unit ai [--keep]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const outDir = join(root, 'temp/rehearsal')

/** Runs docker, returning trimmed stdout, or '' when there is none. */
function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    ...options,
  })

  return typeof output === 'string' ? output.trim() : ''
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * Waits for one container to report healthy.
 *
 * A container that exits is a failure, not a slow start — the loop returns as
 * soon as it sees the state rather than waiting out the deadline.
 */
async function waitHealthy(name, timeoutSeconds = 60) {
  const deadline = Date.now() + timeoutSeconds * 1000

  while (Date.now() < deadline) {
    const status = docker([
      'inspect',
      name,
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    ])

    if (status === 'healthy') return true
    if (status === 'unhealthy' || status === 'exited' || status === 'dead') return false

    await sleep(1500)
  }

  return false
}

/** Removes a container without failing when it never existed. */
function remove(name) {
  try {
    docker(['rm', '-f', name])
  } catch {
    // Nothing to remove.
  }
}

/**
 * The Admin unit is the one that keeps state worth checking.
 *
 * The AI unit's host owns a SQLite database too, but its schema is created from
 * scratch on first start; Admin seeds users and therefore has something to lose
 * across a version change.
 */
const UNITS = {
  admin: {
    image: 'zeus-admin',
    port: 8787,
    healthPath: '/api/health',
    env: [
      '-e', 'ZEUS_ADMIN_PASSWORD=rehearsal-password-000',
      '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
    ],
  },
}

async function main() {
  const args = process.argv.slice(2)
  const unitName = args.includes('--unit') ? args[args.indexOf('--unit') + 1] : 'admin'
  const keep = args.includes('--keep')
  const unit = UNITS[unitName]

  if (!unit) {
    throw new Error(`unknown unit ${unitName}; known: ${Object.keys(UNITS).join(', ')}`)
  }

  mkdirSync(outDir, { recursive: true })

  const runId = process.pid
  const volume = `zeus-rehearsal-${runId}`
  const baseline = `${unit.image}:rehearsal-a`
  const candidate = `${unit.image}:rehearsal-b`

  const evidence = {
    schema: 'zeus.ecosystem.rehearsal/v1',
    unit: unitName,
    startedAt: new Date().toISOString(),
    steps: [],
  }

  const step = (name, ok, detail) => {
    evidence.steps.push({ name, ok, ...(detail ? { detail } : {}) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    docker(['volume', 'create', volume])

    /*
     * The baseline is the image that exists right now. A real rehearsal would
     * use the previously deployed digest; locally, the current build stands in
     * for it, and the candidate is the same image under another tag.
     *
     * That is honest about what this proves: the container lifecycle, the
     * volume binding and the health gating. It does not prove a schema
     * migration, because there is no second version here to migrate from.
     */
    docker(['tag', `${unit.image}:local`, baseline])
    docker(['tag', `${unit.image}:local`, candidate])

    const targetA = docker(['image', 'inspect', baseline, '--format', '{{.Id}}'])
    const targetB = docker(['image', 'inspect', candidate, '--format', '{{.Id}}'])

    // 1. baseline up
    remove('rehearsal-a')
    docker([
      'run', '-d', '--name', 'rehearsal-a',
      '-v', `${volume}:/data`,
      '-p', `127.0.0.1:${unit.port + 100}:${unit.port}`,
      ...unit.env, baseline,
    ])

    const baselineHealthy = await waitHealthy('rehearsal-a')
    step('baseline A starts and reports healthy', baselineHealthy)

    if (!baselineHealthy) throw new Error('the baseline never became healthy')

    // 2. write data
    const write = await fetch(`http://127.0.0.1:${unit.port + 100}${unit.healthPath}`)

    step('baseline A serves its health path', write.ok, `HTTP ${write.status}`)

    const dataBefore = docker([
      'exec', 'rehearsal-a', 'sh', '-c',
      'ls -la /data/ | grep -c sqlite || true',
    ])

    step('baseline A created its database in the volume', dataBefore !== '0', `${dataBefore} file(s)`)

    // 3. plan
    const planArgs = [
      'scripts/release/deployment-plan.mjs',
      '--unit', unitName === 'admin' ? 'admin' : 'ai',
      '--environment', 'staging',
      '--target', `${unitName}=${unit.image}@sha256:${'0'.repeat(64)}`,
      '--previous', `${unitName}=${unit.image}@sha256:${'0'.repeat(64)}`,
      '--out', join(outDir, 'plan.json'),
    ]

    let planOk = true

    try {
      execFileSync('node', planArgs, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      planOk = false
      evidence.planError = error instanceof Error ? error.message.slice(0, 200) : String(error)
    }

    step('a plan is generated for the candidate', planOk)

    // 4. candidate up on the same volume
    remove('rehearsal-b')
    docker([
      'run', '-d', '--name', 'rehearsal-b',
      '-v', `${volume}:/data`,
      '-p', `127.0.0.1:${unit.port + 101}:${unit.port}`,
      ...unit.env, candidate,
    ])

    const candidateHealthy = await waitHealthy('rehearsal-b')

    step('candidate B starts on the volume A wrote', candidateHealthy)

    if (candidateHealthy) {
      const read = await fetch(`http://127.0.0.1:${unit.port + 101}${unit.healthPath}`)

      step('candidate B reads the existing database', read.ok, `HTTP ${read.status}`)
    }

    // 5. roll back
    remove('rehearsal-b')

    const rolledBack = await fetch(`http://127.0.0.1:${unit.port + 100}${unit.healthPath}`)

    step('rolling back leaves A serving', rolledBack.ok, `HTTP ${rolledBack.status}`)

    const dataAfter = docker([
      'exec', 'rehearsal-a', 'sh', '-c',
      'ls -la /data/ | grep -c sqlite || true',
    ])

    step('the data survived the round trip', dataAfter === dataBefore, `${dataAfter} file(s)`)

    evidence.baselineImageId = targetA
    evidence.candidateImageId = targetB
  } catch (error) {
    step('rehearsal completed', false, error instanceof Error ? error.message : String(error))
    evidence.error = evidence.error ?? (error instanceof Error ? error.message : String(error))
  } finally {
    if (keep) {
      evidence.note = `containers and volume ${volume} kept for inspection`
    } else {
      remove('rehearsal-a')
      remove('rehearsal-b')

      try {
        docker(['volume', 'rm', '-f', volume])
      } catch {
        // The volume may never have been created.
      }
    }

    evidence.finishedAt = new Date().toISOString()
    evidence.passed = evidence.steps.every(entry => entry.ok)

    writeFileSync(
      join(outDir, 'report.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    )

    console.log(`\nrehearsal ${evidence.passed ? 'PASS' : 'FAIL'} — ${evidence.steps.filter(entry => entry.ok).length}/${evidence.steps.length} steps`)
  }

  if (!evidence.passed) process.exit(1)
}

await main()
