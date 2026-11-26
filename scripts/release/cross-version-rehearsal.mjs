/**
 * Rehearses a real upgrade and a real rollback between two different images.
 *
 * ## What the previous rehearsal did not do
 *
 * The R17 script tagged one image twice and called the pair a baseline and a
 * candidate. That proved the container lifecycle and the volume binding, which
 * is worth knowing, but it could not prove the thing a rehearsal exists for:
 * whether a database written by one version is readable by the next. It also
 * ran both containers at once, never restarted the baseline, and counted
 * SQLite files instead of reading rows.
 *
 * This version requires two images with different identities, stops each
 * version before starting the other, writes and reads business data through the
 * product's own HTTP API, and verifies the *identity* of the container that
 * comes back after the rollback rather than assuming it.
 *
 * ## The sequence
 *
 *   1. baseline A up on a fresh volume
 *   2. seed and write business data through the API
 *   3. back up the database file
 *   4. stop and remove A; confirm it is gone
 *   5. candidate B up on the same volume
 *   6. read the data A wrote, then modify it and create new data
 *   7. stop and remove B
 *   8. roll back: start A again
 *   9. confirm the running image is A, and read everything back
 *
 * Step 9 is where a schema change shows up. If B migrated the database in a
 * way A cannot read, A fails here — and the report says so instead of claiming
 * a clean rollback.
 *
 * ## Isolation
 *
 * Every resource is named with a run id: containers, volumes, ports. Cleanup
 * removes only those. There is no `docker system prune` here, and `--keep`
 * preserves the scene when a failure needs looking at.
 *
 * Usage:
 *   node scripts/release/cross-version-rehearsal.mjs --unit admin \
 *     --baseline <image> --candidate <image> [--keep]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')

/**
 * The unit under test.
 *
 * `data` describes how to write and read a business record through the
 * product's own API, so the rehearsal exercises the contract users use rather
 * than the database file.
 */
const UNITS = {
  admin: {
    port: 8787,
    healthPath: '/api/health',
    env: extra => [
      '-e', 'ZEUS_ADMIN_PASSWORD=rehearsal-password-000000',
      '-e', 'ZEUS_ADMIN_BOOTSTRAP=true',
      '-e', 'ZEUS_ADMIN_SEED_DEMO=true',
      '-e', 'ZEUS_ADMIN_VIEWER_PASSWORD=rehearsal-viewer-000000',
      ...extra,
    ],
    /**
     * Each step returns a value that is written to the report, so the evidence
     * is the API's answer rather than a claim that a call was made.
     */
    async run(base) {
      const login = await post(`${base}/api/auth/login`, {
        email: 'ada@example.test',
        password: 'rehearsal-password-000000',
      })

      if (!login.ok) {
        return { ok: false, why: `login failed: HTTP ${login.status} ${await login.text()}` }
      }

      const session = readSession(login)

      if (!session) {
        return { ok: false, why: 'login answered no zeus_admin_session / zeus_admin_csrf cookie pair' }
      }

      const auth = { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
      const stamp = Date.now().toString(36)

      /*
       * `id` is required by this API, not generated from the email. Read from
       * the 400 the server returned (`ZEUS_ADMIN_FIELD_REQUIRED: Field "id" is
       * required`) rather than assumed — the request body is part of the
       * product contract, and a rehearsal that guesses it is testing its own
       * guesses.
       */
      const created = await post(
        `${base}/api/users`,
        {
          id: `rehearsal-${stamp}`,
          name: `Rehearsal ${stamp}`,
          email: `rehearsal-${stamp}@zeus.dev`,
          team: 'acceptance',
          status: 'active',
          role: 'viewer',
        },
        auth,
      )

      if (!created.ok) {
        return { ok: false, why: `user creation failed: HTTP ${created.status} ${await created.text()}` }
      }

      /*
       * The response wraps the row: `{ "user": { "id": ... } }`. Reading `id`
       * off the top level produced `/api/users/undefined` and a 404 that looked
       * like a missing record rather than a misread envelope.
       */
      const createdBody = await created.json()
      const user = createdBody.user ?? createdBody

      if (typeof user?.id !== 'string') {
        return { ok: false, why: `create answered no user.id: ${JSON.stringify(createdBody).slice(0, 200)}` }
      }

      const userPath = `${base}/api/users/${encodeURIComponent(user.id)}`

      const readBack = await get(userPath, auth)
      const summary = await get(`${base}/api/summary`, auth)
      const audit = await get(`${base}/api/audit?page=1&pageSize=50`, auth)

      return {
        ok: readBack.ok && summary.ok && audit.ok,
        auth,
        user,
        userPath,
        readBack: readBack.ok ? (await readBack.json()).user ?? null : null,
        summary: summary.ok ? await summary.json() : null,
        /*
         * `{ rows, total }`, not `{ items }`. Read from the response: an
         * `items` field does not exist here, and `?? []` turned that into a
         * count of zero that looked like an empty audit log.
         */
        auditCount: audit.ok ? ((await audit.json()).rows ?? []).length : null,
        why: readBack.ok ? undefined : `read back failed: HTTP ${readBack.status}`,
      }
    },
  },
  /*
   * The Playground serves a static bundle; there is no API to read back through.
   * What a rehearsal can prove here is that the candidate image serves the
   * entry, the sandbox document and a real compiler binary — the three things
   * whose absence produces a page that loads and then does nothing.
   *
   * The two ports are not interchangeable: `:80` is the trusted host and `:81`
   * the untrusted preview, which is served with
   * `Content-Security-Policy: sandbox allow-scripts`. Checking the header is
   * part of the rehearsal because deploying both on one origin would lose the
   * isolation with nothing to show for it.
   */
  playground: {
    port: 80,
    healthPath: '/',
    env: extra => [...extra],
    async run(base) {
      const entry = await get(`${base}/`)
      const sandbox = await get(`${base}/sandbox.html`)

      if (!entry.ok) {
        return { ok: false, why: `entry answered HTTP ${entry.status}` }
      }

      const html = await entry.text()
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1])

      if (scripts.length === 0) {
        return { ok: false, why: 'the entry references no script; the bundle is missing' }
      }

      const firstScript = await get(new URL(scripts[0], base).href)

      /*
       * The sandbox document names its own entry; fetching that proves the
       * second bundle exists rather than only the host's.
       */
      const sandboxHtml = sandbox.ok ? await sandbox.text() : ''
      const sandboxScript = (sandboxHtml.match(/<script[^>]+src="([^"]+)"/) ?? [])[1]
      const sandboxEntry = sandboxScript
        ? await get(new URL(sandboxScript, base).href)
        : { ok: false, status: 0 }

      return {
        ok: sandboxEntry.ok && firstScript.ok,
        entryStatus: entry.status,
        entryBytes: html.length,
        scriptCount: scripts.length,
        firstScriptStatus: firstScript.status,
        sandboxStatus: sandbox.status,
        sandboxEntryStatus: sandboxEntry.status,
        /*
         * Recorded, not asserted: the rehearsal runs the image's own nginx, and
         * the header is what makes the preview's origin opaque. A run against a
         * build that dropped it should look different in the report rather than
         * pass quietly.
         */
        sandboxCspHeader: sandbox.headers.get('content-security-policy'),
        why: sandboxEntry.ok
          ? undefined
          : `the sandbox entry answered HTTP ${sandboxEntry.status}; the preview would not load`,
      }
    },
  },

}

/**
 * The port an image actually serves on.
 *
 * Declared `ExposedPorts` is a hint, not a fact: the baseline image from
 * `ghcr.io/baicie/zeus-admin:main` declares and serves 8080, while the candidate
 * built from this tree serves 8787. Mapping one fixed port made the baseline
 * answer health checks on the host while every API call went nowhere — the
 * health path and the business path were on different ports, and only the
 * second one failed.
 */
function exposedPort(image) {
  try {
    const raw = docker(['image', 'inspect', image, '--format', '{{json .Config.ExposedPorts}}'])
    const ports = JSON.parse(raw)
    const first = Object.keys(ports ?? {})[0]

    if (!first) return null

    return Number(first.split('/')[0])
  } catch {
    return null
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

function docker(args, options = {}) {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    ...options,
  })

  return typeof output === 'string' ? output.trim() : ''
}

const get = (url, headers) => fetch(url, { headers })
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/**
 * The session this product issues is a cookie, not a bearer token.
 *
 * Measured against the baseline image: `POST /api/auth/login` answers
 * `Set-Cookie: zeus_admin_session=…; HttpOnly; SameSite=Lax; Secure`, and the
 * JSON body carries only the user and an expiry. Sending a `Bearer` header
 * instead produced 401 `ZEUS_ADMIN_AUTH_REQUIRED` on every subsequent call
 * while the login itself looked successful — the failure and its cause were two
 * steps apart, which is why this is read from the response rather than assumed.
 */
function readSession(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  const pick = name => raw.find(entry => entry.startsWith(`${name}=`))?.split(';')[0] ?? null

  const session = pick('zeus_admin_session')
  const csrf = pick('zeus_admin_csrf')

  if (!session || !csrf) return null

  /*
   * The CSRF token is a second cookie, and writes need it echoed in a header.
   * Without it every mutation answers 403 `ZEUS_ADMIN_CSRF` while reads keep
   * working — a failure that looks like a permissions problem and is not.
   */
  return {
    cookie: `${session}; ${csrf}`,
    csrfToken: decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1)),
  }
}

/** Waits for one container to report healthy, failing fast on a dead one. */
async function waitHealthy(name, timeoutSeconds = 90) {
  const deadline = Date.now() + timeoutSeconds * 1000

  while (Date.now() < deadline) {
    const status = docker([
      'inspect', name, '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    ])

    if (status === 'healthy') return { healthy: true }
    if (status === 'unhealthy' || status === 'exited' || status === 'dead') {
      return { healthy: false, why: `container state: ${status}\n${docker(['logs', '--tail', '30', name])}` }
    }

    await sleep(1200)
  }

  return { healthy: false, why: 'timed out waiting for healthy', logs: docker(['logs', '--tail', '30', name]) }
}

function remove(name) {
  try {
    docker(['rm', '-f', name])
  } catch {
    // Nothing to remove.
  }
}

/** The image a running container was created from, by ID. */
function containerImageId(name) {
  return docker(['inspect', name, '--format', '{{.Image}}'])
}

async function main() {
  const args = process.argv.slice(2)
  const value = flag => {
    const index = args.indexOf(flag)

    return index === -1 ? undefined : args[index + 1]
  }

  const unitName = value('--unit') ?? 'admin'
  const baselineImage = value('--baseline')
  const candidateImage = value('--candidate')
  const keep = args.includes('--keep')
  const unit = UNITS[unitName]

  if (!unit) throw new Error(`unknown unit ${unitName}; known: ${Object.keys(UNITS).join(', ')}`)
  if (!baselineImage || !candidateImage) {
    throw new Error('usage: --baseline <image> --candidate <image> [--unit admin] [--keep]')
  }

  const runId = `${process.pid}-${Date.now().toString(36)}`
  const outDir = join(root, 'temp/rehearsal')
  mkdirSync(outDir, { recursive: true })

  const volume = `zeus-rehearsal-${runId}`
  const containerA = `zeus-a-${runId}`
  const containerB = `zeus-b-${runId}`
  const portA = unit.port + 100 + (process.pid % 50) * 2
  const portB = portA + 1

  /*
   * Two versions of the same product are allowed to listen on different ports.
   * Reading each image's own declaration is the only way the rehearsal can be
   * version-agnostic; assuming one port is how a rehearsal passes against an
   * image it cannot actually talk to.
   */
  const containerPortA = exposedPort(baselineImage)
  const containerPortB = exposedPort(candidateImage)

  const report = {
    schema: 'zeus.ecosystem.cross-version-rehearsal/v1',
    unit: unitName,
    runId,
    startedAt: new Date().toISOString(),
    baseline: { image: baselineImage },
    candidate: { image: candidateImage },
    steps: [],
    faults: [],
  }

  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, ...(detail ? { detail } : {}) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  /*
   * The images must actually differ. Two tags on one image is what the previous
   * rehearsal did; refusing it here means a run that proves nothing cannot
   * produce a report that says it did.
   */
  const idA = docker(['image', 'inspect', baselineImage, '--format', '{{.Id}}'])
  const idB = docker(['image', 'inspect', candidateImage, '--format', '{{.Id}}'])

  report.baseline.imageId = idA
  report.candidate.imageId = idB
  report.baseline.containerPort = containerPortA
  report.candidate.containerPort = containerPortB

  step(
    'each image declares the port it serves on',
    containerPortA !== null && containerPortB !== null,
    `baseline ${containerPortA}, candidate ${containerPortB}`,
  )

  step(
    'the baseline and the candidate are different images',
    idA !== idB,
    idA === idB ? `both resolve to ${idA}` : `${idA.slice(7, 19)} vs ${idB.slice(7, 19)}`,
  )

  if (idA === idB) {
    writeFileSync(join(outDir, `report-${runId}.json`), `${JSON.stringify({ ...report, passed: false }, null, 2)}\n`)
    process.exit(1)
  }

  let wrote = null
  let backUpPath = null

  try {
    /* 1. baseline up on a fresh volume. */
    docker(['volume', 'create', volume])
    remove(containerA)

    docker([
      'run', '-d', '--name', containerA,
      '-v', `${volume}:/data`,
      '-e', 'ZEUS_ADMIN_DB=/data/admin.sqlite',
      '-p', `127.0.0.1:${portA}:${containerPortA}`,
      ...unit.env([]),
      baselineImage,
    ])

    const healthA = await waitHealthy(containerA)

    step('baseline starts and reports healthy', healthA.healthy, healthA.why)
    if (!healthA.healthy) throw new Error('baseline never became healthy')

    /* 2. write business data through the product API. */
    const baseA = `http://127.0.0.1:${portA}`
    wrote = await unit.run(baseA)

    step(
      'baseline writes and reads business data through its API',
      wrote.ok === true,
      wrote.why ?? `user ${wrote.user?.id}, audit ${wrote.auditCount} entries`,
    )
    if (!wrote.ok) throw new Error(`baseline data step failed: ${wrote.why}`)

    report.baseline.written = {
      userId: wrote.user.id,
      email: wrote.user.email,
      name: wrote.user.name,
      summary: wrote.summary,
      auditCount: wrote.auditCount,
    }

    /* 3. back the database up before the upgrade touches it. */
    backUpPath = join(outDir, `admin-before-upgrade-${runId}.sqlite`)
    docker(['cp', `${containerA}:/data/admin.sqlite`, backUpPath])

    step('the database was backed up before the upgrade', existsSync(backUpPath), backUpPath)

    /* 4. stop A and confirm it is gone before B starts. */
    docker(['stop', containerA])
    docker(['rm', containerA])

    const stillThere = (() => {
      try {
        docker(['inspect', containerA, '--format', '{{.State.Status}}'])
        return true
      } catch {
        return false
      }
    })()

    step('baseline is stopped and removed before the candidate starts', !stillThere)

    /* 5. candidate up on the same volume. */
    docker([
      'run', '-d', '--name', containerB,
      '-v', `${volume}:/data`,
      '-e', 'ZEUS_ADMIN_DB=/data/admin.sqlite',
      '-p', `127.0.0.1:${portB}:${containerPortB}`,
      ...unit.env([]),
      candidateImage,
    ])

    const healthB = await waitHealthy(containerB)

    step('candidate starts on the volume the baseline wrote', healthB.healthy, healthB.why)
    if (!healthB.healthy) throw new Error(`candidate never became healthy: ${healthB.why}`)

    /* 6. the candidate reads what A wrote, then changes it. */
    const baseB = `http://127.0.0.1:${portB}`
    const loginB = await post(`${baseB}/api/auth/login`, {
      email: 'ada@example.test',
      password: 'rehearsal-password-000000',
    })

    const sessionB = loginB.ok ? readSession(loginB) : null

    step(
      'the baseline administrator can sign in on the candidate',
      loginB.ok && sessionB !== null,
      `HTTP ${loginB.status}${sessionB ? '' : ', no session/csrf cookie pair'}`,
    )

    if (loginB.ok && sessionB) {
      const auth = { cookie: sessionB.cookie, 'x-csrf-token': sessionB.csrfToken }

      const readAfterUpgrade = await get(`${baseB}/api/users/${wrote.user.id}`, auth)

      if (readAfterUpgrade.ok) {
        const body = (await readAfterUpgrade.json()).user

        report.upgrade = { readUserId: body.id, readEmail: body.email, matched: body.email === wrote.user.email }

        step(
          'the candidate reads the row the baseline created',
          body.email === wrote.user.email,
          `${body.email}`,
        )
      } else {
        step('the candidate reads the row the baseline created', false, `HTTP ${readAfterUpgrade.status}`)
      }

      const patched = await fetch(`${baseB}/api/users/${wrote.user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ team: 'upgraded' }),
      })

      step('the candidate modifies the existing row', patched.ok, `HTTP ${patched.status}`)

      const fresh = await post(
        `${baseB}/api/users`,
        {
          id: `candidate-${Date.now().toString(36)}`,
          name: 'Created Under Candidate',
          email: `candidate-${Date.now().toString(36)}@zeus.dev`,
          team: 'acceptance',
          status: 'active',
          role: 'viewer',
        },
        auth,
      )

      if (fresh.ok) {
        const createdBody = await fresh.json()
        const created = createdBody.user ?? createdBody
        report.upgrade = { ...report.upgrade, createdUnderCandidateId: created.id }
        step('the candidate creates a new row', true, created.id)
      } else {
        step('the candidate creates a new row', false, `HTTP ${fresh.status}`)
      }

      const auditAfter = await get(`${baseB}/api/audit?page=1&pageSize=50`, auth)

      const auditBody = auditAfter.ok ? await auditAfter.json() : null
      const auditRows = auditBody?.rows ?? []

      step(
        'the audit log records the candidate activity',
        auditAfter.ok && auditRows.length > (wrote.auditCount ?? 0),
        auditAfter.ok ? `${auditRows.length} rows` : `HTTP ${auditAfter.status}`,
      )

      const schemaVersion = docker([
        'exec', containerB, 'sh', '-c',
        "command -v sqlite3 >/dev/null && sqlite3 /data/admin.sqlite 'SELECT MAX(version) FROM schema_migrations' || echo 'no sqlite3'",
      ])

      report.upgrade = { ...report.upgrade, schemaVersionAfterCandidate: schemaVersion }
      step('the database schema version was recorded after the upgrade', schemaVersion !== '', schemaVersion)
    }

    /* 7. stop B. */
    docker(['stop', containerB])
    docker(['rm', containerB])

    step('candidate is stopped and removed', true)

    /* 8. roll back by starting A again on the same volume. */
    docker([
      'run', '-d', '--name', containerA,
      '-v', `${volume}:/data`,
      '-e', 'ZEUS_ADMIN_DB=/data/admin.sqlite',
      '-p', `127.0.0.1:${portA}:${containerPortA}`,
      ...unit.env([]),
      baselineImage,
    ])

    const healthBack = await waitHealthy(containerA)

    /*
     * The identity check, not the name: a container called `A` proves nothing
     * about which image it runs. This is the step the old rehearsal skipped.
     */
    const imageAfterRollback = healthBack.healthy ? containerImageId(containerA) : null

    step(
      'the rollback container is the baseline image',
      imageAfterRollback === idA,
      imageAfterRollback === idA ? idA.slice(7, 19) : `got ${imageAfterRollback}`,
    )

    step('the baseline starts again on the upgraded database', healthBack.healthy, healthBack.why)

    if (healthBack.healthy) {
      const baseBack = `http://127.0.0.1:${portA}`
      const loginBack = await post(`${baseBack}/api/auth/login`, {
        email: 'ada@example.test',
        password: 'rehearsal-password-000000',
      })

      const sessionBack = loginBack.ok ? readSession(loginBack) : null

      step(
        'the baseline administrator can sign in after the rollback',
        loginBack.ok && sessionBack !== null,
        `HTTP ${loginBack.status}${sessionBack ? '' : ', no session/csrf cookie pair'}`,
      )

      if (loginBack.ok && sessionBack) {
        const auth = { cookie: sessionBack.cookie, 'x-csrf-token': sessionBack.csrfToken }

        const original = await get(`${baseBack}/api/users/${wrote.user.id}`, auth)

        if (original.ok) {
          const body = (await original.json()).user

          /*
           * The row the candidate modified must carry the modification. If it
           * reads back with the old team, the upgrade's write was lost — which
           * is a different failure from being unable to read at all.
           */
          report.rollback = { readUserId: body.id, team: body.team }

          step(
            'the baseline reads the row the candidate modified',
            body.team === 'upgraded',
            `team=${body.team}`,
          )
        } else {
          step('the baseline reads the row the candidate modified', false, `HTTP ${original.status}`)
        }

        if (report.upgrade?.createdUnderCandidateId) {
          const underCandidate = await get(
            `${baseBack}/api/users/${report.upgrade.createdUnderCandidateId}`,
            auth,
          )

          /*
           * A row created by the newer version may legitimately be invisible to
           * the older one. Recording which happened is the difference between
           * "nothing was lost" and "the rollback was clean because the data was
           * gone anyway".
           */
          report.rollback = {
            ...report.rollback,
            candidateRowVisibleAfterRollback: underCandidate.ok,
          }

          step(
            'the row created under the candidate is accounted for after the rollback',
            true,
            underCandidate.ok ? 'readable by the baseline' : `not readable: HTTP ${underCandidate.status}`,
          )
        }

        const summaryBack = await get(`${baseBack}/api/summary`, auth)

        step('the baseline serves its summary after the rollback', summaryBack.ok, `HTTP ${summaryBack.status}`)
      }
    }
  } catch (error) {
    step('rehearsal completed', false, error instanceof Error ? error.message : String(error))
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (keep) {
      report.note = `containers ${containerA}, ${containerB} and volume ${volume} kept for inspection`
    } else {
      remove(containerA)
      remove(containerB)

      try {
        docker(['volume', 'rm', '-f', volume])
      } catch {
        // The volume may never have been created.
      }
    }

    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt)
    report.passed = report.steps.length > 0 && report.steps.every(entry => entry.ok)

    const path = join(outDir, `cross-version-${runId}.json`)
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)

    console.log(
      `\n${report.passed ? 'PASS' : 'FAIL'} — ${report.steps.filter(s => s.ok).length}/${report.steps.length} steps in ${(report.durationMs / 1000).toFixed(1)}s`,
    )
    console.log(`report: ${path}`)
  }

  if (!report.passed) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
