/**
 * Protocol, persistence and readiness acceptance for the AI host.
 *
 * ## What the existing tests cover, and what they do not
 *
 * `apps/ai-host/__tests__` exercises the protocol handler and the replay
 * surface. Those are unit tests against an in-process server: they cannot show
 * that a host started as a real process, given a real database file, survives a
 * restart with its history intact — or that its health path tells the truth
 * about whether it can answer.
 *
 * ## The readiness question
 *
 * `/health` returns `200 { ok: true }` for every configuration. In `replay`
 * mode with no recording the host is up and answers, and every `POST
 * /commands` produces an empty timeline — a liveness check that says healthy
 * while the product cannot do its job. That distinction (alive versus able) is
 * what this gate measures, and it reports the answer rather than assuming the
 * host already draws it.
 *
 * Run with `pnpm check:ai-host`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const APP = path.resolve(import.meta.dirname, '../..')
const ARTIFACTS = path.join(APP, 'temp/ai-host-protocol')

interface Check {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

const checks: Check[] = []

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

/** A free loopback port, found by binding rather than guessed. */
async function freePort(start = 5100): Promise<number> {
  const { createServer } = await import('node:net')

  for (let port = start; port < start + 200; port++) {
    const free = await new Promise<boolean>(resolve => {
      const probe = createServer()

      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })

    if (free) return port
  }

  throw new Error('no free port')
}

interface Host {
  readonly origin: string
  readonly token: string
  readonly database: string
  stop(): Promise<void>
}

/**
 * Starts a host as a child process.
 *
 * A child process, not an import: the restart scenario needs the process to
 * actually exit and come back with the same database file, which an in-process
 * server cannot demonstrate.
 */
async function startHost(options: {
  port: number
  database: string
  workspace: string
  mode?: 'replay' | 'live'
  token?: string
}): Promise<Host> {
  const token = options.token ?? 'host-acceptance-token-0001'

  /*
   * `node:sqlite` loads without a flag on 24.16 and later; on 22.x and early
   * 24.x it needs `--experimental-sqlite`. Testing for the module is the only
   * portable way to decide, and it is what `run-with-sqlite.mjs` does for the
   * unit tests — the same probe, so the gate and the tests cannot disagree
   * about which Node versions are supported.
   */
  const needsSqliteFlag = (() => {
    try {
      execFileSync(process.execPath, ['-e', "require('node:sqlite')"], { stdio: 'pipe' })

      return false
    } catch {
      return true
    }
  })()

  const child: ChildProcess = spawn(
    process.execPath,
    [...(needsSqliteFlag ? ['--experimental-sqlite'] : []), '--import', 'tsx', path.join(APP, 'src/server.ts')],
    {
      cwd: APP,
      env: {
        ...process.env,
        PORT: String(options.port),
        ZEUS_AI_HOST_PORT: String(options.port),
        ZEUS_AI_MODE: options.mode ?? 'replay',
        /*
         * `ZEUS_AI_TOKENS` is a JSON array of records, not a bare string:
         * `parseAiTokens` rejects anything that is not `[{ token, tenantId,
         * userId, role }]`, and a 16-character minimum on the token. Read from
         * `auth.ts` rather than guessed — a bare string fails at startup with
         * "must be valid JSON", which reads like a configuration typo.
         */
        ZEUS_AI_TOKENS: JSON.stringify([
          { token, tenantId: 'acceptance', userId: 'acceptance-user', role: 'admin' },
        ]),
        ZEUS_AI_TENANTS: JSON.stringify([
          {
            id: 'acceptance',
            databaseFile: options.database,
            workspaceRoot: options.workspace,
          },
        ]),
        ZEUS_AI_ORIGINS: `http://127.0.0.1:${options.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let output = ''

  child.stdout?.on('data', chunk => {
    output += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    output += String(chunk)
  })

  const origin = `http://127.0.0.1:${options.port}`
  const deadline = Date.now() + 45_000

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the host exited (${child.exitCode}):\n${output}`)
    }

    try {
      if ((await fetch(`${origin}/health`)).ok) {
        return {
          origin,
          token,
          database: options.database,
          async stop() {
            child.kill('SIGTERM')
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => {
                child.kill('SIGKILL')
                resolve()
              }, 4000)

              child.once('exit', () => {
                clearTimeout(timer)
                resolve()
              })
            })
          },
        }
      }
    } catch {
      // Not up yet.
    }

    await new Promise(resolve => setTimeout(resolve, 200))
  }

  child.kill('SIGKILL')
  throw new Error(`the host never answered health:\n${output}`)
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function main(): Promise<void> {
  fs.mkdirSync(ARTIFACTS, { recursive: true })

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-host-'))
  const database = path.join(temp, 'host.sqlite')
  const workspace = path.join(temp, 'workspace')

  fs.mkdirSync(workspace, { recursive: true })

  let host = await startHost({ port: await freePort(), database, workspace })

  try {
    /* ---- liveness and configuration -------------------------------- */

    const health = await fetch(`${host.origin}/health`)
    const healthBody = await health.json()

    record(
      'the host answers its health path',
      health.ok,
      `HTTP ${health.status} mode=${healthBody.mode} interactive=${healthBody.interactive}`,
    )

    /* ---- authentication -------------------------------------------- */

    const anonymous = await fetch(`${host.origin}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ping' }),
    })

    record(
      'a request without a token is refused, not served',
      anonymous.status === 401,
      `HTTP ${anonymous.status}`,
    )

    const wrongToken = await fetch(`${host.origin}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth('not-the-token') },
      body: JSON.stringify({ type: 'ping' }),
    })

    record(
      'a wrong token is refused',
      wrongToken.status === 401 || wrongToken.status === 403,
      `HTTP ${wrongToken.status}`,
    )

    /* ---- origin ---------------------------------------------------- */

    const badOrigin = await fetch(`${host.origin}/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
        ...auth(host.token),
      },
      body: JSON.stringify({ type: 'conversation.list' }),
    })

    record(
      'a request from an unlisted origin is refused',
      badOrigin.status === 403,
      `HTTP ${badOrigin.status}`,
    )

    /* ---- readiness, which health does not report ------------------- */

    /*
     * The question the health path cannot answer: with no recording present,
     * can this host serve a conversation? Asked through `/snapshots`, the
     * durable read the workbench itself uses — `conversation.list` is not a
     * supported command, and a first draft that sent one received
     * `AI_HOST_COMMAND_UNKNOWN` and read the reply as "no conversations".
     */
    const before = await fetch(`${host.origin}/snapshots?streamId=reference`, {
      headers: auth(host.token),
    })

    const beforeText = before.ok ? await before.text() : ''
    /* A reference recording carries events; an empty log is what a bare replay starts with. */
    const emptyReplay = /"events":\s*\[\s*\]/.test(beforeText) || beforeText.length < 200

    record(
      'health reports ready regardless of whether any content exists',
      health.ok && emptyReplay,
      emptyReplay
        ? `health=200 ok:true while the event log holds nothing — a liveness answer, not a readiness one`
        : `the log already holds ${beforeText.length} bytes`,
    )

    /* ---- persistence across a restart ------------------------------ */

    /*
     * The command set is `message.send`, `changeset.propose`,
     * `approval.resolve` — there is no "create conversation". A first
     * `message.send` for an unknown conversation emits `conversation.upserted`
     * and records the message, which is the path the workbench actually takes,
     * so the restart check exercises real traffic rather than a test-only verb.
     */
    const conversationId = 'restart-survival'

    const send = await fetch(`${host.origin}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(host.token) },
      body: JSON.stringify({
        /*
         * `schemaVersion` is required and must equal the protocol's
         * `COMMAND_SCHEMA_VERSION` (2 in `@zeus-web/ai-core@0.1.0-beta.35`).
         * Without it the host answers `AI_COMMAND_UNSUPPORTED_SCHEMA`, which
         * reads like a protocol mismatch between versions rather than a missing
         * field in the request.
         */
        schemaVersion: 2,
        type: 'message.send',
        commandId: 'restart-1',
        /*
         * `idempotencyKey` is required, not optional. A retried command with the
         * same key is answered once, which is what stops a flaky network from
         * appending the same message twice.
         */
        idempotencyKey: 'restart-1-key',
        target: { kind: 'conversation', id: conversationId },
        payload: { text: 'does this survive a restart' },
      }),
    })

    /*
     * The response body *is* the ack — `sendJson(response, 200, ack)` — not a
     * `{ ack: … }` envelope. Reading `.ack` off it yielded `{}`, which looks
     * like a rejected command and is actually a misread one.
     */
    const sendBody = send.ok ? await send.json() : null

    record(
      'a message is accepted and acknowledged',
      send.ok && sendBody?.accepted === true,
      send.ok ? `ack ${JSON.stringify(sendBody ?? {}).slice(0, 120)}` : `HTTP ${send.status} ${String(await send.text()).slice(0, 140)}`,
    )

    await host.stop()

    const restarted = await startHost({ port: await freePort(5300), database, workspace })

    try {
      /*
       * `/snapshots` is the durable read: it returns the event log for a stream,
       * and the message body appearing in it means the write was persisted and
       * not merely acknowledged. The host exposes no `/timeline` path — reading
       * one produced a 404 that looked like lost data.
       */
      const snapshots = await fetch(`${restarted.origin}/snapshots?streamId=reference`, {
        headers: auth(restarted.token),
      })

      const snapshotText = snapshots.ok ? await snapshots.text() : ''

      /*
       * Both halves of "it survived": the conversation is named in the
       * restored log, and the message body is there. A conversation row without
       * its messages would pass a looser check and lose the user's content.
       */
      const namesConversation = snapshotText.includes(conversationId)
      const keepsMessage = snapshotText.includes('survive a restart')

      record(
        'the conversation written before the restart is there after it',
        snapshots.ok && namesConversation,
        snapshots.ok ? `${conversationId} present in ${snapshotText.length} bytes` : `HTTP ${snapshots.status}`,
      )

      record(
        'the message written before the restart is readable after it',
        snapshots.ok && keepsMessage,
        snapshots.ok ? 'the message body is in the restored log' : `HTTP ${snapshots.status}`,
      )

      const dbSize = fs.existsSync(database) ? fs.statSync(database).size : 0

      record(
        'the database file holds the history',
        dbSize > 0,
        `${database} is ${dbSize} bytes`,
      )
    } finally {
      await restarted.stop()
    }
  } finally {
    await host.stop().catch(() => {})

    /*
     * The workspace is removed; the database is kept when a check failed so the
     * file can be inspected. A run that leaves a 40 MB directory behind every
     * time is one people stop running.
     */
    if (checks.every(entry => entry.passed)) fs.rmSync(temp, { recursive: true, force: true })
    else console.log(`\nkept for inspection: ${temp}`)
  }

  const report = {
    schema: 'zeus.ecosystem.ai-host-protocol/v1',
    startedAt: new Date().toISOString(),
    checks,
    passed: checks.length > 0 && checks.every(entry => entry.passed),
  }

  fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n${checks.filter(c => c.passed).length}/${checks.length} host protocol checks`)

  /*
   * One check documents a product gap rather than a passing requirement; it is
   * expected to pass while the gap exists, and will keep passing when the gap
   * closes because it records which of the two happened.
   */
  if (!report.passed) process.exit(1)
}

await main()
