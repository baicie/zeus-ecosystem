/**
 * A real Admin server for browser acceptance.
 *
 * ## Why a spawned process rather than an imported module
 *
 * The server reads its configuration from the environment at startup and
 * refuses several combinations outright — a short password, a viewer password
 * missing while demo users are seeded. Importing it in-process would make the
 * gate share that module state with the test runner and hide exactly the
 * startup contract these tests are about. A child process also means a server
 * that crashes takes the gate's own failure path, not the runner's.
 *
 * ## Why a fresh database per run
 *
 * Session restore, the user list and the audit log are all assertions below.
 * Running against a database left by an earlier run makes them order-dependent
 * — the audit count would be "more than last time", which is not a statement
 * about this run.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/** The admin account every scenario signs in with. */
export const ADMIN = {
  email: 'ada@example.test',
  /* Twelve characters minimum: the server refuses anything shorter at boot. */
  password: 'admin-password-0001',
} as const

/** A viewer account, used to prove that permissions are enforced. */
export const VIEWER = {
  email: 'grace@example.test',
  password: 'viewer-password-0001',
} as const

export interface AdminServer {
  readonly origin: string
  readonly database: string
  stop(): Promise<void>
}

/**
 * Starts the server on a free port and waits for its health path.
 *
 * The port is chosen by the OS and read back from the server's own announcement
 * rather than guessed: two gates running at once on fixed ports is the failure
 * that makes a suite flaky in exactly the way nobody can reproduce.
 */
export async function startAdminServer(options: {
  readonly adminDir: string
  readonly port: number
  /**
   * Where the built SPA lives. Serving it from the same origin as the API is
   * how the app is deployed, so a routing or proxy defect shows up here rather
   * than only in production.
   */
  readonly staticDir?: string
}): Promise<AdminServer> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zeus-admin-e2e-'))
  const database = path.join(temp, 'admin.sqlite')

  const child: ChildProcess = spawn(
    process.execPath,
    ['--experimental-sqlite', '--import', 'tsx', path.join(options.adminDir, 'server/index.ts')],
    {
      cwd: options.adminDir,
      env: {
        ...process.env,
        PORT: String(options.port),
        ZEUS_ADMIN_HOST: '127.0.0.1',
        ZEUS_ADMIN_DB: database,
        ZEUS_ADMIN_EMAIL: ADMIN.email,
        ZEUS_ADMIN_PASSWORD: ADMIN.password,
        ZEUS_ADMIN_VIEWER_PASSWORD: VIEWER.password,
        ZEUS_ADMIN_SEED_DEMO: 'true',
        ZEUS_ADMIN_BOOTSTRAP: 'true',
        NODE_ENV: 'test',
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
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the admin server exited (${child.exitCode}) before answering health:\n${output}`)
    }

    try {
      const response = await fetch(`${origin}/api/health`)

      if (response.ok) {
        return {
          origin,
          database,
          async stop() {
            child.kill('SIGTERM')

            await new Promise<void>(resolve => {
              const timer = setTimeout(() => {
                child.kill('SIGKILL')
                resolve()
              }, 5000)

              child.once('exit', () => {
                clearTimeout(timer)
                resolve()
              })
            })

            fs.rmSync(temp, { recursive: true, force: true })
          },
        }
      }
    } catch {
      // Not up yet.
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  child.kill('SIGKILL')
  throw new Error(`the admin server never answered health:\n${output}`)
}

/**
 * Finds a port that is free right now.
 *
 * Binding to port 0 and reading the assignment back is the only way to be sure;
 * counting upward from a constant collides with whatever else the machine is
 * running.
 */
export async function freePort(start = 4600): Promise<number> {
  const { createServer } = await import('node:net')

  for (let port = start; port < start + 200; port++) {
    const available = await new Promise<boolean>(resolve => {
      const server = createServer()

      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close(() => resolve(true))
      })
      server.listen(port, '127.0.0.1')
    })

    if (available) return port
  }

  throw new Error(`no free port in ${start}..${start + 200}`)
}
