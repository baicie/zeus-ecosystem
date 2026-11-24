/**
 * Runs the P0 interactive scenario against a running compose stack.
 *
 * ## Why a second driver
 *
 * `check-ai-workbench-p0.ts` starts Vite in-process and boots the Host in the
 * same Node process. That proves the code works; it does not prove the
 * deployment works. Everything between the browser and the app — nginx, the
 * `/ai-host/` proxy, the token injection, the read-only filesystem, the volume
 * — is absent from that driver, and those are the parts that break in a
 * container.
 *
 * The assertions are the same function, not a copy: `runInteractive` takes a
 * URL and a browser, so this only supplies a different URL. Two copies of the
 * same checks would drift, and the copy that ran less often would be the one
 * that drifted silently.
 *
 * ## The one difference
 *
 * In-process, the page carries the bearer token itself. Behind the proxy nginx
 * injects it and the browser never sees a credential — which is the point of
 * the proxy — so this driver runs without the header.
 *
 * Usage:
 *   node scripts/run-with-sqlite.mjs scripts/checks/check-ai-workbench-container.ts \
 *     --base http://127.0.0.1:18080
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { runInteractive } from './check-ai-workbench-p0'
import { ALL_ENGINES } from './support/browsers'

const root = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(root, 'temp/ai-workbench-container')

let base = 'http://127.0.0.1:18080'

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--base') base = process.argv[index + 1]
}

/**
 * Fails before launching anything when the stack is not answering.
 *
 * A browser launched against a dead URL reports a navigation timeout fifteen
 * seconds later, which reads like a slow page rather than like a stack that was
 * never up. One request here names the real problem.
 */
async function requireStack(): Promise<void> {
  const response = await fetch(`${base}/`, { redirect: 'manual' }).catch((error: unknown) => {
    throw new Error(
      `the stack at ${base} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  })

  if (!response.ok) throw new Error(`the stack at ${base} returned ${response.status}`)
}

async function main(): Promise<void> {
  await requireStack()

  mkdirSync(outDir, { recursive: true })

  const results: Array<{
    browser: string
    surface: string
    status: 'passed' | 'failed'
    checks: Array<{ name: string; ok: boolean; detail?: string }>
  }> = []

  for (const engine of ALL_ENGINES) {
    const checks = await runInteractive(engine, `${base}/`, { authorize: false })

    results.push({
      browser: engine,
      surface: 'container',
      status: checks.every(check => check.ok) ? 'passed' : 'failed',
      checks,
    })
  }

  const passed = results.every(result => result.status === 'passed')

  writeFileSync(
    path.join(outDir, 'report.json'),
    `${JSON.stringify({ results, passed }, null, 2)}\n`,
  )

  console.log(JSON.stringify({ results, passed }, null, 2))

  if (!passed) throw new Error('the container P0 gate failed')
}

await main()
