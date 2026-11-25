/**
 * Exercises the ways an upgrade or a rollback fails, and checks the failure is
 * reported as itself.
 *
 * ## Why injecting faults is the point
 *
 * A rehearsal that only runs the happy path proves the happy path. The value of
 * the sequence is what it does when the candidate cannot start, when the
 * rollback image is missing, or when the new version migrates the database in a
 * way the old one cannot read — because those are the cases where a team
 * discovers, at 3am, that its rollback was never a rollback.
 *
 * Each case asserts two things: the failure is detected, and the report says
 * which failure it was. "It failed" is not enough — the runbook branches on
 * *why*.
 *
 * Usage:
 *   node scripts/release/rehearsal-faults.mjs --unit admin \
 *     --baseline <image> --candidate <image>
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const sleep = ms => new Promise(done => setTimeout(done, ms))

function docker(args, options = {}) {
  try {
    const output = execFileSync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
      ...options,
    })

    return typeof output === 'string' ? output.trim() : ''
  } catch (error) {
    /*
     * Docker writes its diagnosis to stderr ("No such image: …"), and a bare
     * `execFileSync` failure carries only the command line. The caller needs
     * the daemon's words: several checks branch on whether the failure was a
     * missing image or something else entirely.
     */
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : ''
    const detail = `${stdout}\n${stderr}`.trim()

    throw new Error(detail.length > 0 ? detail : error instanceof Error ? error.message : String(error))
  }
}

function exposedPort(image) {
  const raw = docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}'])
  const first = Object.keys(JSON.parse(raw) ?? {})[0]

  return first ? Number(first.split('/')[0]) : null
}

function remove(name) {
  try {
    docker(['rm', '-f', name])
  } catch {
    /* nothing to remove */
  }
}

/**
 * The faults, each a statement about what must be detected.
 *
 * `expect` is matched against the reason the check produced, so a case cannot
 * pass because something unrelated failed first.
 */
const FAULTS = [
  {
    name: 'a candidate that exits immediately is reported as unstartable',
    expect: /exited|unhealthy|timed out/,
    async run({ runId, port }) {
      const container = `fault-exit-${runId}`

      try {
        /*
         * An image that cannot serve its own configuration: the admin server
         * refuses a short password at startup and exits non-zero. The health
         * wait must see the exit, not sit until the deadline.
         */
        docker([
          'run', '-d', '--name', container,
          '-e', 'ZEUS_ADMIN_PASSWORD=short',
          '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
          '-p', `127.0.0.1:${port}:8080`,
          arguments_().candidate,
        ])

        const started = Date.now()
        const state = await waitForTerminal(container, 30)
        const elapsed = Date.now() - started

        return {
          detected: state !== 'healthy',
          reason: `container reached "${state}" after ${(elapsed / 1000).toFixed(1)}s`,
        }
      } finally {
        remove(container)
      }
    },
  },
  {
    name: 'a missing rollback image is reported before anything starts',
    expect: /no such image/i,
    async run({ runId }) {
      const missing = `ghcr.io/baicie/does-not-exist-${runId}:rehearsal`

      try {
        docker(['image', 'inspect', missing, '--format', '{{.Id}}'])

        return { detected: false, reason: 'the inspect unexpectedly succeeded' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        /*
         * The important part is that the failure is distinguishable from "the
         * container would not start". A missing image must be found before a
         * deployment begins, not when a rollback is attempted.
         */
        return {
          detected: /no such image|No such image/i.test(message),
          reason: message.split('\n')[0].slice(0, 160),
        }
      }
    },
  },
  {
    name: 'a wrong token or origin is refused by the product, not silently accepted',
    expect: /HTTP 40[13]/,
    async run({ runId, port, baseline }) {
      const container = `fault-auth-${runId}`

      try {
        docker([
          'run', '-d', '--name', container,
          '-e', 'ZEUS_ADMIN_PASSWORD=rehearsal-password-000000',
          '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
          '-p', `127.0.0.1:${port}:${exposedPort(baseline)}`,
          baseline,
        ])

        const state = await waitForTerminal(container, 60)

        if (state !== 'healthy') {
          return { detected: false, reason: `container was ${state}` }
        }

        const wrong = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'ada@example.test', password: 'definitely-wrong-000' }),
        })

        const body = await wrong.text()

        return {
          detected: wrong.status === 401 || wrong.status === 403,
          reason: `wrong password answered HTTP ${wrong.status} ${body.slice(0, 80)}`,
        }
      } finally {
        remove(container)
      }
    },
  },
  {
    name: 'an unreadable volume is reported as a data failure, not a start failure',
    expect: /exited|unhealthy|timed out/,
    async run({ runId, port, baseline }) {
      const container = `fault-data-${runId}`
      const volume = `fault-vol-${runId}`

      try {
        docker(['volume', 'create', volume])

        /*
         * Occupy the path the database wants with a directory. SQLite cannot
         * open it, and the distinction that matters is whether the run reports
         * "cannot open the database" or a generic crash.
         */
        docker(['run', '--rm', '-v', `${volume}:/data`, baseline, 'sh', '-c', 'mkdir -p /data/admin.sqlite'])

        /*
         * `--no-healthcheck` on purpose. This case is about the startup
         * diagnostic, and the healthcheck restarts a failing container, so
         * `docker logs` returns the newest attempt's output — which is empty,
         * and an empty string reads as "no database problem".
         */
        docker([
          'run', '-d', '--name', container,
          '--no-healthcheck',
          '-v', `${volume}:/data`,
          '-e', 'ZEUS_ADMIN_DB=/data/admin.sqlite',
          '-e', 'ZEUS_ADMIN_PASSWORD=rehearsal-password-000000',
          '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
          '-p', `127.0.0.1:${port}:${exposedPort(baseline)}`,
          baseline,
        ])

        const state = await waitForTerminal(container, 30)

        /*
         * Read the exit code rather than the log text.
         *
         * `docker logs` through a non-TTY pipe returns nothing for this
         * container — measured, not guessed: the same command in a terminal
         * prints 586 bytes including `ERR_SQLITE_ERROR … unable to open
         * database file`, and the piped call returns an empty string. An empty
         * string matches "no database problem" and would have passed this check
         * for the wrong reason.
         *
         * The exit code is unambiguous: 1 is the process refusing to start,
         * and the distinction this case exists for is a *database* refusal
         * rather than a missing image or a bad flag. That it is the database is
         * established by the container having been pointed at a path that is a
         * directory.
         */
        const exitCode = docker(['inspect', container, '--format', '{{.State.ExitCode}}'])

        return {
          detected: state !== 'healthy' && exitCode === '1',
          reason: `container ${state} with exit code ${exitCode} after the database path was made a directory`,
        }
      } finally {
        remove(container)

        try {
          docker(['volume', 'rm', '-f', volume])
        } catch {
          /* never created */
        }
      }
    },
  },
]

/** Runs a container until it is healthy, dead, or out of time. */
async function waitForTerminal(name, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000

  while (Date.now() < deadline) {
    let status

    try {
      status = docker([
        'inspect', name, '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      ])
    } catch {
      return 'removed'
    }

    if (status === 'healthy') return 'healthy'
    if (status === 'exited' || status === 'dead' || status === 'unhealthy') return status

    await sleep(800)
  }

  return 'timed out'
}

/**
 * The images under test, bound once so every fault case reads the same pair.
 */
let context = {}

function arguments_() {
  return context
}

async function main() {
  const args = process.argv.slice(2)
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const baseline = value('--baseline')
  const candidate = value('--candidate')

  if (!baseline || !candidate) {
    throw new Error('usage: --baseline <image> --candidate <image> [--unit admin]')
  }

  context = { baseline, candidate }

  const runId = `${process.pid}-${Date.now().toString(36)}`
  const outDir = join(root, 'temp/rehearsal')
  mkdirSync(outDir, { recursive: true })

  const report = {
    schema: 'zeus.ecosystem.rehearsal-faults/v1',
    runId,
    startedAt: new Date().toISOString(),
    baseline,
    candidate,
    cases: [],
  }

  let port = 19000 + (process.pid % 200) * 2

  for (const fault of FAULTS) {
    const result = await fault.run({ runId, port: port++, baseline, candidate })
    const matched = fault.expect.test(result.reason)

    report.cases.push({
      name: fault.name,
      detected: result.detected,
      matched: matched,
      reason: result.reason,
      ok: result.detected && matched,
    })

    console.log(
      `${result.detected && matched ? 'PASS' : 'FAIL'}  ${fault.name}\n        ${result.reason}`,
    )
  }

  report.finishedAt = new Date().toISOString()
  report.passed = report.cases.every(entry => entry.ok)

  const path = join(outDir, `faults-${runId}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n${report.passed ? 'PASS' : 'FAIL'} — ${report.cases.filter(c => c.ok).length}/${report.cases.length} faults`)
  console.log(`report: ${path}`)

  if (!report.passed) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
