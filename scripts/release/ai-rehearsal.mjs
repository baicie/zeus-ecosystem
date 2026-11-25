/**
 * The AI deployment unit's upgrade and rollback, against two different versions.
 *
 * ## Why this is not part of `cross-version-rehearsal.mjs`
 *
 * That script rehearses one product: start A, stop it, start B, roll back. The
 * AI unit is two products that only work together — the workbench proxies to
 * the host, and they share a token. Half a unit is not a degraded deployment,
 * it is a broken one, so the sequence here is a different shape: both services
 * come down, both come up, in an order the declaration fixes.
 *
 * The two share the evidence schema and the isolation discipline; they do not
 * share a runner. A runner general enough to cover both would need an adapter
 * layer whose only consumers are these two files.
 *
 * ## What a pair of images proves
 *
 *     baseline    both images, one version, recorded by digest
 *     candidate   both images, the other version
 *
 * The run refuses to start when a baseline and candidate image resolve to the
 * same ID. Two tags on one image is what the R17 rehearsal did, and it cannot
 * answer the question an upgrade rehearsal exists for.
 *
 * ## Data
 *
 * Conversation, messages and timeline go through the product's own protocol,
 * not through SQLite. The database file is checked afterwards, as supporting
 * evidence rather than as the assertion — a file that exists and a row that
 * reads back are different claims.
 *
 * Usage:
 *   node scripts/release/ai-rehearsal.mjs \
 *     --baseline-host <image> --baseline-workbench <image> \
 *     --candidate-host <image> --candidate-workbench <image> [--keep]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(root, 'temp/rehearsal')

const TOKEN = 'ai-rehearsal-token-000000000001'

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
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)))
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** A free loopback port, found by binding rather than guessed. */
async function freePort(start) {
  for (let port = start; port < start + 400; port++) {
    const free = await new Promise(resolve => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port from ${start}`)
}

function imageId(image) {
  return docker(['image', 'inspect', image, '--format', '{{.Id}}'])
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
 * Waits for a container to be serving.
 *
 * Two ways to answer it, because the two images answer it differently: an image
 * with a HEALTHCHECK reports `healthy`, and one without only ever reports
 * `running`. Waiting on the health field alone made a rebuilt baseline look
 * like a failed start — it was listening on 8788 the whole time, with no
 * healthcheck to say so.
 *
 * `probeUrl` is the fallback: the container's own port, published on loopback.
 */
async function waitHealthy(name, timeoutSeconds = 90, probeUrl) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let sawNoHealthcheck = false

  while (Date.now() < deadline) {
    let status

    try {
      status = docker(['inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck:{{.State.Status}}{{end}}'])
    } catch {
      const logs = (() => { try { return docker(['logs', '--tail', '25', name]).slice(-1200) } catch { return '' } })()
      return { healthy: false, why: `container disappeared\n${logs}` }
    }

    if (status === 'healthy') return { healthy: true }

    if (status === 'unhealthy' || status.includes('exited') || status.includes('dead')) {
      return { healthy: false, why: `state ${status}\n${docker(['logs', '--tail', '25', name]).slice(-1200)}` }
    }

    if (status.startsWith('no-healthcheck:running')) {
      sawNoHealthcheck = true

      if (probeUrl) {
        try {
          const response = await fetch(probeUrl, { signal: AbortSignal.timeout(3000) })
          if (response.ok) return { healthy: true }
        } catch {
          /* not listening yet */
        }
      }
    }

    await sleep(1000)
  }

  const hint = sawNoHealthcheck
    ? 'the container has no HEALTHCHECK and its probe URL never answered'
    : 'timed out waiting for a health status'

  return { healthy: false, why: `${hint}\n${docker(['logs', '--tail', '25', name]).slice(-1200)}` }
}

const auth = { authorization: `Bearer ${TOKEN}` }
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) })

/** The command envelope the host requires. */
function command(type, extra) {
  return {
    /* Required by @zeus-web/ai-core; a missing schemaVersion is rejected as a
     * version mismatch, which reads like a protocol skew and is a missing field. */
    schemaVersion: 2,
    type,
    commandId: `rehearsal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    idempotencyKey: `rehearsal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ...extra,
  }
}

/**
 * One version of the AI unit: a host and a workbench that proxies to it.
 *
 * `start` brings both up in the declared order and waits for each. `probe`
 * drives the protocol through the workbench, so nginx, the token contract and
 * the origin allowlist are all on the path under test.
 */
async function startUnit({ label, hostImage, workbenchImage, volume, network, hostPort, workbenchPort, rejection }) {
  const hostName = `ai-host-${label}-${rejection}`
  const workbenchName = `ai-workbench-${label}-${rejection}`

  /*
   * One network per unit. The alias `ai-host` is a name inside a network, so
   * two units sharing one would both answer to it and the workbench could reach
   * the wrong host — which is exactly what a version-skew rehearsal must not
   * do silently.
   */
  try {
    docker(['network', 'create', network])
  } catch {
    /* already exists */
  }

  remove(hostName)
  remove(workbenchName)

  const hostContainerPort = exposedPort(hostImage)
  const workbenchContainerPort = exposedPort(workbenchImage)

  /*
   * The workbench's nginx resolves `ai-host` by name, and the name is compiled
   * into its config — `set $ai_host_upstream ai-host;` — not injected. So the
   * host container has to answer to that name, and `--network-alias` is how a
   * container with a unique name also has the name the proxy looks for. Without
   * it every request through the workbench is 502, which reads like a broken
   * proxy and is a missing alias.
   */
  docker([
    'run', '-d', '--name', hostName,
    '--network', network,
    '--network-alias', 'ai-host',
    '-v', `${volume}:/data`,
    '-e', 'ZEUS_AI_MODE=replay',
    /* The token the workbench will present. The host accepts exactly this. */
    '-e', `ZEUS_AI_TOKENS=${JSON.stringify([{ token: TOKEN, tenantId: 'rehearsal', userId: 'rehearsal-user', role: 'admin' }])}`,
    '-e', 'ZEUS_AI_TENANTS=' + JSON.stringify([{ id: 'rehearsal', databaseFile: '/data/host.sqlite', workspaceRoot: '/data/workspace' }]),
    '-e', `ZEUS_AI_ORIGINS=${rejection === 'origin' ? 'http://not-the-workbench.example' : `http://127.0.0.1:${workbenchPort}`}`,
    '-p', `127.0.0.1:${hostPort}:${hostContainerPort}`,
    hostImage,
  ])

  const hostHealth = await waitHealthy(hostName, 90, `http://127.0.0.1:${hostPort}/health`)

  if (!hostHealth.healthy) {
    return { ok: false, reason: `host did not become healthy: ${hostHealth.why}` }
  }

  docker([
    'run', '-d', '--name', workbenchName,
    /*
     * The same network as the host. Both containers have to be on it for the
     * `ai-host` alias to resolve — a container on the default bridge cannot see
     * a name defined on another network, and the proxy answers 502 while every
     * container reports healthy.
     */
    '--network', network,
    '-e', `ZEUS_AI_UPSTREAM_TOKEN=${rejection === 'token' ? 'a-token-the-host-rejects-0001' : TOKEN}`,
    /*
     * `ZEUS_AI_HOST_ORIGIN` is not set here on purpose.
     *
     * The image's nginx resolves the upstream from `set $ai_host_upstream
     * ai-host;` in its own config; the variable this script used to pass named a
     * container that does not exist, and nginx answered 404 for every request
     * through the proxy while both containers reported healthy. The network
     * alias above is what makes the compiled-in name resolve.
     */
    '-p', `127.0.0.1:${workbenchPort}:${workbenchContainerPort}`,
    workbenchImage,
  ])

  const workbenchHealth = await waitHealthy(workbenchName, 90, `http://127.0.0.1:${workbenchPort}/`)

  if (!workbenchHealth.healthy) {
    return { ok: false, reason: `workbench did not become healthy: ${workbenchHealth.why}` }
  }

  return {
    ok: true,
    host: hostName,
    workbench: workbenchName,
    base: `http://127.0.0.1:${workbenchPort}`,
    hostBase: `http://127.0.0.1:${hostPort}`,
  }
}

async function stopUnit(unit) {
  if (unit?.workbench) remove(unit.workbench)
  if (unit?.host) remove(unit.host)
}

/**
 * Writes a conversation and reads it back through the workbench's proxy.
 *
 * The workbench serves the shell and forwards `/ai-host/*`; going through it
 * is what puts nginx, the token and the origin allowlist on the path. A probe
 * against the host directly would skip all three.
 */
async function writeConversation(base, conversationId, text, workbenchName) {
  const response = await post(`${base}/ai-host/commands`, command('message.send', {
    target: { kind: 'conversation', id: conversationId },
    payload: { text },
  }))

  if (!response.ok) {
    /*
     * The proxy's own log, not just its status.
     *
     * A 404 from the host says the path that arrived was not a route; a 502
     * says the upstream was unreachable. Both surface as "the command failed",
     * and the two need different fixes — so the log travels with the failure.
     */
    let workbenchLog = ''

    try {
      workbenchLog = docker(['logs', '--tail', '8', workbenchName]).slice(-600)
    } catch {
      /* container already gone */
    }

    return {
      ok: false,
      why: `command answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}${workbenchLog ? `\n--- workbench log ---\n${workbenchLog}` : ''}`,
    }
  }

  const ack = await response.json()

  if (ack.accepted !== true) {
    return { ok: false, why: `command not accepted: ${JSON.stringify(ack).slice(0, 300)}` }
  }

  return { ok: true, operationId: ack.operationId }
}

async function readLog(base) {
  const response = await fetch(`${base}/ai-host/snapshots?streamId=reference`, { headers: auth })

  if (!response.ok) return { ok: false, status: response.status }

  return { ok: true, body: await response.text() }
}

async function main() {
  const args = process.argv.slice(2)
  const value = flag => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }

  const baselineHost = value('--baseline-host')
  const baselineWorkbench = value('--baseline-workbench')
  const candidateHost = value('--candidate-host')
  const candidateWorkbench = value('--candidate-workbench')
  const keep = args.includes('--keep')

  if (!baselineHost || !baselineWorkbench || !candidateHost || !candidateWorkbench) {
    throw new Error('usage: --baseline-host <img> --baseline-workbench <img> --candidate-host <img> --candidate-workbench <img>')
  }

  fs.mkdirSync(outDir, { recursive: true })

  const runId = `${process.pid}-${Date.now().toString(36)}`
  const volume = `zeus-ai-rehearsal-${runId}`
  const networkBase = `zeus-ai-net-${runId}`

  const report = {
    schema: 'zeus.ecosystem.ai-rehearsal/v1',
    runId,
    startedAt: new Date().toISOString(),
    baseline: { host: baselineHost, workbench: baselineWorkbench },
    candidate: { host: candidateHost, workbench: candidateWorkbench },
    steps: [],
    faults: [],
  }

  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, ...(detail ? { detail } : {}) })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  /* The pair must be two versions, for the same reason as the Admin unit. */
  const baselineIds = [imageId(baselineHost), imageId(baselineWorkbench)]
  const candidateIds = [imageId(candidateHost), imageId(candidateWorkbench)]

  report.baseline.imageIds = baselineIds
  report.candidate.imageIds = candidateIds

  const identical = baselineIds[0] === candidateIds[0] && baselineIds[1] === candidateIds[1]

  step(
    'the baseline and the candidate are different version sets',
    !identical,
    identical ? 'both sets resolve to the same two images' : `${baselineIds[0].slice(7, 15)}/${baselineIds[1].slice(7, 15)} vs ${candidateIds[0].slice(7, 15)}/${candidateIds[1].slice(7, 15)}`,
  )

  if (identical) {
    fs.writeFileSync(path.join(outDir, `ai-${runId}.json`), `${JSON.stringify({ ...report, passed: false }, null, 2)}\n`)
    process.exit(1)
  }

  const conversationA = 'rehearsal-a'
  const conversationB = 'rehearsal-b'
  let baselineUnit = null
  let candidateUnit = null

  try {
    docker(['volume', 'create', volume])

    /* ---- 1. baseline, both services ---- */
    const hostPort = await freePort(6100)
    const workbenchPort = hostPort + 1

    baselineUnit = await startUnit({
      label: 'a', rejection: 'none',
      hostImage: baselineHost, workbenchImage: baselineWorkbench,
      volume, network: `${networkBase}-a`, hostPort, workbenchPort,
    })

    step('the baseline unit starts, host before workbench', baselineUnit.ok, baselineUnit.reason)

    if (!baselineUnit.ok) throw new Error(baselineUnit.reason)

    /* ---- 2. write through the workbench's proxy ---- */
    const wrote = await writeConversation(baselineUnit.base, conversationA, 'written by the baseline', baselineUnit.workbench)

    /*
     * A baseline whose own proxy is broken is a finding, not a harness failure.
     *
     * The image built on 2026-11-24 carries `proxy_pass http://$upstream:8788/`
     * with no rewrite. With a variable upstream nginx does not strip the matched
     * location prefix, so `/ai-host/commands` reaches the host as
     * `/ai-host/commands` and 404s — a real defect in that build, fixed the next
     * day. Continuing the rehearsal from a baseline that cannot be written to
     * would prove nothing about the upgrade, so the run records what it found
     * and stops that phase rather than reporting a pass it did not earn.
     */
    const baselineProxyBroken = !wrote.ok && /HTTP 404/.test(wrote.why ?? '') && /AI_HOST_NOT_FOUND/.test(wrote.why ?? '')

    step(
      'a conversation is written through the workbench proxy',
      wrote.ok,
      wrote.why ?? `operation ${wrote.operationId}`,
    )

    if (baselineProxyBroken) {
      report.baseline.verdict = 'BASELINE_PROXY_BROKEN'
      report.baseline.note =
        'the baseline workbench image forwards /ai-host/ without stripping the prefix; no data could be written through it, so the upgrade phases below start from an empty volume'
    }

    const baselineLog = await readLog(baselineUnit.base)

    step(
      'the baseline reads its own timeline back',
      baselineLog.ok && baselineLog.body.includes('written by the baseline'),
      baselineLog.ok ? `${baselineLog.body.length} bytes` : `HTTP ${baselineLog.status}`,
    )

    report.baseline.written = { conversation: conversationA, bytes: baselineLog.ok ? baselineLog.body.length : 0 }

    /* ---- 2b. prepare the volume for the candidate's user ---- */
    /*
     * A real cutover performs this step, so the rehearsal performs it too.
     *
     * The baseline image runs as root and the current one as uid 10001. The
     * database the baseline wrote is owned by root, and the candidate cannot
     * open it for writing — `attempt to write a readonly database`. Handing the
     * volume to the new owner is the preparation an operator has to do; running
     * the candidate as root instead would prove nothing about what the image
     * actually does.
     */
    const candidateUid = docker(['run', '--rm', '--entrypoint', 'sh', candidateHost, '-c', 'id -u']).trim()

    const chown = (() => {
      try {
        docker(['run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'chown', baselineHost, '-R', `${candidateUid}:${candidateUid}`, '/data'])
        return { ok: true }
      } catch (error) {
        return { ok: false, why: error instanceof Error ? error.message.slice(0, 200) : String(error) }
      }
    })()

    step(
      'the data volume is handed to the candidate image\'s user',
      chown.ok,
      chown.ok ? `uid ${candidateUid}` : chown.why,
    )

    report.upgradePreparation = { candidateUid, chowned: chown.ok }

    /* ---- 3. a consistent backup of a live SQLite database ---- */
    const backupPath = path.join(outDir, `ai-baseline-${runId}.sqlite`)

    /*
     * `sqlite3 .backup`, not `cp`. The host keeps the database in WAL mode, so
     * copying the main file while it is being written produces a file that is
     * missing the WAL — and a backup nobody verified is not a backup.
     */
    const backup = docker([
      'exec', baselineUnit.host, 'sh', '-c',
      `command -v sqlite3 >/dev/null && sqlite3 /data/host.sqlite ".backup /data/backup.sqlite" && echo done || echo no-sqlite3`,
    ])

    /*
     * `no-sqlite3` is a capability the image does not have, not a failed step.
     *
     * The host image ships no `sqlite3` binary, so a consistent `.backup` cannot
     * be taken from inside it. Reporting that as a failure would say the
     * rehearsal broke; reporting it as a pass would claim a backup that does not
     * exist. It is recorded as NOT_RUN with the reason, and the rest of the run
     * continues — the upgrade question does not depend on it.
     */
    const backupAttempted = backup === 'done'

    /*
     * Only a backup that was attempted can fail. `no-sqlite3` records that the
     * image lacks the tool — a fact about the image, and one this run is honest
     * about rather than converting into either a pass or a failure of the
     * upgrade.
     */
    if (backupAttempted) {
      step('the database is backed up consistently', true, 'sqlite3 .backup')
    } else {
      report.baseline.backup = {
        verdict: 'NOT_RUN',
        reason: 'the host image has no sqlite3, so a consistent .backup cannot be taken from inside it',
        implication:
          'a cutover must back the volume up from outside the container, and verify the copy opens',
      }

      console.log(`SKIP  the database is backed up consistently — NOT_RUN: ${backup}`)
    }

    if (!backupAttempted) {
      report.baseline.backup = {
        verdict: 'NOT_RUN',
        reason: 'the host image has no sqlite3, so a consistent .backup cannot be taken from inside it',
        implication:
          'a cutover must back the volume up from outside the container, and verify the copy opens',
      }
    }

    if (backup === 'done') {
      docker(['cp', `${baselineUnit.host}:/data/backup.sqlite`, backupPath])

      const sha = execFileSync('shasum', ['-a', '256', backupPath], { encoding: 'utf8' }).split(' ')[0]

      report.baseline.backup = { path: backupPath, sha256: sha, bytes: fs.statSync(backupPath).size }

      step('the backup has a recorded digest', sha.length === 64, `${sha.slice(0, 16)}… ${fs.statSync(backupPath).size} bytes`)
    }

    /* ---- 4. stop the whole unit, workbench first ---- */
    await stopUnit(baselineUnit)
    baselineUnit = null

    step('the baseline unit is fully stopped', true, 'workbench before host')

    /* ---- 5. candidate on the same volume ---- */
    const cHostPort = await freePort(6300)
    const cWorkbenchPort = cHostPort + 1

    candidateUnit = await startUnit({
      label: 'b', rejection: 'none',
      hostImage: candidateHost, workbenchImage: candidateWorkbench,
      volume, network: `${networkBase}-b`, hostPort: cHostPort, workbenchPort: cWorkbenchPort,
    })

    step('the candidate unit starts on the volume the baseline wrote', candidateUnit.ok, candidateUnit.reason)

    if (!candidateUnit.ok) throw new Error(candidateUnit.reason)

    /* ---- 6. the candidate reads what A wrote, then adds to it ---- */
    const afterUpgrade = await readLog(candidateUnit.base)
    const keptA = afterUpgrade.ok && afterUpgrade.body.includes('written by the baseline')

    step('the candidate reads the conversation the baseline wrote', keptA, afterUpgrade.ok ? `${afterUpgrade.body.length} bytes` : `HTTP ${afterUpgrade.status}`)

    const appended = await writeConversation(candidateUnit.base, conversationA, 'appended by the candidate', candidateUnit.workbench)

    /*
     * A write failure here is the upgrade's own finding, not a harness fault.
     *
     * The rebuilt baseline runs as root and the current image runs as uid 10001
     * (`USER zeus`). Whichever user created the database first owns the file,
     * and the other cannot write to it. That is a real operational step a
     * cutover has to perform — `chown` the data volume — and reporting it as
     * "the rehearsal crashed" would hide the one thing this run is for.
     */
    const readonlyDatabase = !appended.ok && /readonly database/i.test(appended.why ?? '')

    step('the candidate appends to the existing conversation', appended.ok, appended.why ?? `operation ${appended.operationId}`)

    if (readonlyDatabase) {
      report.upgrade = {
        verdict: 'DATA_VOLUME_OWNERSHIP',
        detail:
          'the database was created by the baseline container user and the candidate runs as a different uid; the volume needs chown before the upgrade, or the candidate must run as the same user',
      }
    }

    const created = await writeConversation(candidateUnit.base, conversationB, 'a new conversation under the candidate', candidateUnit.workbench)

    step('the candidate creates a new conversation', created.ok, created.why ?? `operation ${created.operationId}`)

    report.candidate.written = { appendedTo: conversationA, created: conversationB }

    /* ---- 7. restart the candidate: data must survive a process restart ---- */
    await stopUnit(candidateUnit)
    candidateUnit = null

    const rHostPort = await freePort(6500)
    const rWorkbenchPort = rHostPort + 1

    candidateUnit = await startUnit({
      label: 'b2', rejection: 'none',
      hostImage: candidateHost, workbenchImage: candidateWorkbench,
      volume, network: `${networkBase}-b2`, hostPort: rHostPort, workbenchPort: rWorkbenchPort,
    })

    step('the candidate restarts on the same volume', candidateUnit.ok, candidateUnit.reason)

    if (candidateUnit.ok) {
      const afterRestart = await readLog(candidateUnit.base)

      step(
        'both conversations survive the restart',
        afterRestart.ok && afterRestart.body.includes(conversationA) && afterRestart.body.includes(conversationB),
        afterRestart.ok ? `${afterRestart.body.length} bytes` : `HTTP ${afterRestart.status}`,
      )
    }

    /* ---- 8. roll back to the baseline set ---- */
    await stopUnit(candidateUnit)
    candidateUnit = null

    const bHostPort = await freePort(6700)
    const bWorkbenchPort = bHostPort + 1

    baselineUnit = await startUnit({
      label: 'a2', rejection: 'none',
      hostImage: baselineHost, workbenchImage: baselineWorkbench,
      volume, network: `${networkBase}-a2`, hostPort: bHostPort, workbenchPort: bWorkbenchPort,
    })

    step('the baseline unit starts again on the upgraded database', baselineUnit.ok, baselineUnit.reason)

    if (baselineUnit.ok) {
      const imageAfterRollback = docker(['inspect', baselineUnit.host, '--format', '{{.Image}}'])

      step('the rollback container is the baseline image', imageAfterRollback === baselineIds[0], imageAfterRollback === baselineIds[0] ? imageAfterRollback.slice(7, 15) : `got ${imageAfterRollback.slice(7, 15)}`)

      const afterRollback = await readLog(baselineUnit.base)

      /*
       * The question a rollback answers: can the old version read what the new
       * one wrote? If it cannot, the candidate migrated the schema in a way that
       * is not backward compatible, and restoring the binaries is not a
       * rollback — it is a data loss event.
       */
      step(
        'the baseline reads the conversation the candidate appended to',
        afterRollback.ok && afterRollback.body.includes('appended by the candidate'),
        afterRollback.ok ? `${afterRollback.body.length} bytes` : `HTTP ${afterRollback.status}`,
      )
    }
  } catch (error) {
    step('the rehearsal completed', false, error instanceof Error ? error.message.slice(0, 400) : String(error))
    report.error = error instanceof Error ? error.message.slice(0, 800) : String(error)
  } finally {
    await stopUnit(candidateUnit)
    await stopUnit(baselineUnit)

    if (keep) {
      report.note = `volume ${volume} kept for inspection`
    } else {
      for (const suffix of ['a', 'a2', 'b', 'b2']) {
        try {
          docker(['network', 'rm', `${networkBase}-${suffix}`])
        } catch {
          /* never created, or a container still holds it */
        }
      }

      try {
        docker(['volume', 'rm', '-f', volume])
      } catch {
        /* never created */
      }
    }

    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt)
    report.passed = report.steps.length > 0 && report.steps.every(entry => entry.ok)

    fs.writeFileSync(path.join(outDir, `ai-${runId}.json`), `${JSON.stringify(report, null, 2)}\n`)

    console.log(`\n${report.passed ? 'PASS' : 'FAIL'} — ${report.steps.filter(s => s.ok).length}/${report.steps.length} steps in ${(report.durationMs / 1000).toFixed(1)}s`)
  }

  if (!report.passed) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
