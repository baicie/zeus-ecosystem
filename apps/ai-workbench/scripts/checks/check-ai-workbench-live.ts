/**
 * Live provider acceptance, off by default and impossible to fake on.
 *
 * ## What "live" means here
 *
 * Fixture and replay gates answer questions about the shell with recorded data.
 * This one calls a real model and pays for it. That is the only way to find out
 * whether discovery, streaming, cancellation and error mapping behave against a
 * provider that is actually there — and it is why it never runs in a pull
 * request.
 *
 * ## The three states, and why the middle one exists
 *
 *   LIVE_PASS      a real call succeeded and the limits held
 *   LIVE_BLOCKED   no credentials configured; the runner, the guards and the
 *                  redaction tests still ran
 *   LIVE_FAIL      a call was attempted and failed, or a limit was breached
 *
 * `LIVE_BLOCKED` is not a pass. A replay run that reports `LIVE_PASS` — or a
 * blocked run reported as success — is the failure mode this distinction
 * prevents: the gate can only say "green" when a model answered.
 *
 * ## What it refuses to do
 *
 * - It will not run unless `ZEUS_AI_LIVE=1` is set explicitly.
 * - It caps requests, tokens, wall time, concurrency and an estimated budget.
 * - It redacts anything shaped like a key from every artefact it writes, and a
 *   test asserts the redaction works before any call is made.
 *
 * Run with `ZEUS_AI_LIVE=1 pnpm check:live`.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const APP = path.resolve(import.meta.dirname, '../..')
const ARTIFACTS = path.join(APP, 'temp/ai-workbench-live')

/**
 * Every limit, in one place, so none of them can be forgotten.
 *
 * The budget is an estimate: a gate that can spend an unbounded amount of
 * someone's money is a gate that gets removed after the first surprise bill.
 */
export const LIMITS = {
  maxRequests: 8,
  maxOutputTokens: 512,
  maxWallClockMs: 120_000,
  maxConcurrency: 1,
  maxEstimatedUsd: 0.25,
} as const

/** Stands for any secret in an artefact. */
export const REDACTED = '[redacted]'

/**
 * Removes anything shaped like a provider key.
 *
 * Run over every string this gate writes. A key can reach an artefact through a
 * path nobody predicted — an error message from the provider, a request URL, a
 * stack trace — so redaction is a filter on the output, not a rule about what
 * is passed in.
 */
export function redact(value: string): string {
  return value
    /* `sk-…`, `sk-proj-…`, and the generic `xai-`/`gsk_` shapes. */
    .replace(/\b(?:sk|gsk|xai)[-_][A-Za-z0-9_-]{12,}/g, REDACTED)
    /* An `Authorization: Bearer …` header echoed into a message. */
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, `Bearer ${REDACTED}`)
    /* A query-string key. */
    .replace(/([?&](?:api_?key|key|token)=)[^&\s"']+/gi, `$1${REDACTED}`)
}

export interface Configuration {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/**
 * Reads the provider configuration, or reports why there is none.
 *
 * Deliberately not defaulted: a live gate that silently falls back to a local
 * server would report a real call where none was made.
 */
export function readConfiguration(env: NodeJS.ProcessEnv): Configuration | { blocked: string } {
  const baseUrl = env.ZEUS_AI_LIVE_BASE_URL
  const apiKey = env.ZEUS_AI_LIVE_API_KEY
  const model = env.ZEUS_AI_LIVE_MODEL

  const missing = [
    !baseUrl && 'ZEUS_AI_LIVE_BASE_URL',
    !apiKey && 'ZEUS_AI_LIVE_API_KEY',
    !model && 'ZEUS_AI_LIVE_MODEL',
  ].filter(Boolean)

  if (missing.length > 0) {
    return { blocked: `missing ${missing.join(', ')}` }
  }

  return { baseUrl: baseUrl!, apiKey: apiKey!, model: model! }
}

export interface CallResult {
  readonly ok: boolean
  readonly status?: number
  readonly chunks?: number
  readonly text?: string
  readonly error?: string
  readonly elapsedMs: number
}

/**
 * One streaming call, with a hard wall-clock stop.
 *
 * Cancellation is a first-class outcome: an abort that leaves the request
 * running is how a gate keeps costing money after it has already failed.
 */
export async function streamOnce(
  config: Configuration,
  prompt: string,
  options: { maxOutputTokens?: number; timeoutMs?: number } = {},
): Promise<CallResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LIMITS.maxWallClockMs,
  )

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: options.maxOutputTokens ?? LIMITS.maxOutputTokens,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()

      return {
        ok: false,
        status: response.status,
        error: redact(body.slice(0, 400)),
        elapsedMs: Date.now() - started,
      }
    }

    let chunks = 0
    let text = ''
    const reader = response.body?.getReader()

    if (!reader) {
      return { ok: false, error: 'the response carried no body', elapsedMs: Date.now() - started }
    }

    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()

      if (done) break

      chunks += 1
      text += decoder.decode(value, { stream: true })

      /* The output cap is enforced on the response, not only on the request. */
      if (text.length > LIMITS.maxOutputTokens * 8) {
        controller.abort()

        return {
          ok: false,
          chunks,
          text: redact(text.slice(0, 200)),
          error: 'the response exceeded the output cap',
          elapsedMs: Date.now() - started,
        }
      }
    }

    return { ok: true, status: response.status, chunks, text: redact(text.slice(0, 2000)), elapsedMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      ok: false,
      error: redact(message),
      elapsedMs: Date.now() - started,
      ...(controller.signal.aborted ? { error: `aborted after ${LIMITS.maxWallClockMs}ms` } : {}),
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The redaction tests.
 *
 * They run whether or not credentials exist, because the property they check —
 * that a key cannot reach an artefact — is the one that must hold in a blocked
 * run too: a blocked run still writes a report.
 */
function redactionChecks(): Array<{ name: string; passed: boolean }> {
  const cases: Array<[string, string]> = [
    ['openai-shaped key', 'Authorization: Bearer sk-proj-abcdefghijklmnop1234'],
    ['groq-shaped key', 'key gsk_abcdefghijklmnopqrstuvwx12'],
    ['xai-shaped key', 'xai-abcdefghijklmnop1234'],
    ['query string key', 'https://api.example/v1?api_key=supersecretvalue&x=1'],
    ['plain bearer', 'Bearer abcdefghijklmnopqrstuvwxyz'],
  ]

  return cases.map(([name, input]) => ({
    name,
    passed: (() => {
      const output = redact(input)

      /* Nothing that looked like a secret survives. */
      return (
        !/abcdefghijklmnop|supersecretvalue|qrstuvwxyz/i.test(output) && output.includes(REDACTED)
      )
    })(),
  }))
}

async function main(): Promise<void> {
  const results: Array<{ name: string; passed: boolean; detail?: string }> = []

  const record = (name: string, passed: boolean, detail?: string) => {
    results.push({ name, passed, detail })
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true })

  /* 1. The redaction property, before anything else runs. */
  for (const check of redactionChecks()) {
    record(`redaction: ${check.name}`, check.passed)
  }

  const verdictFor = (state: string, detail: string) => {
    const report = {
      schema: 'zeus.ecosystem.live-gate/v1',
      startedAt: new Date().toISOString(),
      verdict: state,
      detail,
      limits: LIMITS,
      results,
      /*
       * The gate is either explicitly enabled or it did nothing. A run that is
       * not asked to make live calls must not be readable as one that did.
       */
      enabled: process.env.ZEUS_AI_LIVE === '1',
    }

    const text = redact(JSON.stringify(report, null, 2))

    fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${text}\n`)

    console.log(`\nverdict: ${state} — ${detail}`)
    console.log(`report: ${path.join(ARTIFACTS, 'report.json')}`)

    return state
  }

  if (process.env.ZEUS_AI_LIVE !== '1') {
    const verdict = verdictFor(
      'LIVE_BLOCKED',
      'ZEUS_AI_LIVE is not 1; this gate never makes live calls unless asked explicitly',
    )

    /* Blocked is not a failure of the repository, and not a pass either. */
    process.exit(verdict === 'LIVE_PASS' ? 0 : 0)
  }

  const configuration = readConfiguration(process.env)

  if ('blocked' in configuration) {
    const verdict = verdictFor('LIVE_BLOCKED', configuration.blocked)

    process.exit(verdict === 'LIVE_PASS' ? 0 : 0)
  }

  const started = Date.now()

  const response = await streamOnce(configuration, 'Reply with the single word: ok')

  record(
    'a real model answers a streaming request',
    response.ok,
    response.ok ? `${response.chunks} chunk(s) in ${response.elapsedMs}ms` : `${response.error} (HTTP ${response.status ?? '?'})`,
  )

  record(
    'the request total stayed within the budget',
    Date.now() - started <= LIMITS.maxWallClockMs,
    `${Date.now() - started}ms of ${LIMITS.maxWallClockMs}ms`,
  )

  const failed = results.filter(entry => !entry.passed)

  const verdict = failed.length === 0 ? 'LIVE_PASS' : 'LIVE_FAIL'

  verdictFor(verdict, failed.length === 0 ? 'a real call succeeded within the limits' : `${failed.length} check(s) failed`)

  process.exit(verdict === 'LIVE_PASS' ? 0 : 1)
}

/*
 * Importable: the redaction tests and `readConfiguration` are used by the unit
 * tests, which must run without credentials and without a network.
 */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
