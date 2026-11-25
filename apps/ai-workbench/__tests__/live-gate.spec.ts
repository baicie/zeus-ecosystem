import { describe, expect, it } from 'vitest'

import {
  LIMITS,
  readConfiguration,
  redact,
  REDACTED,
  streamOnce,
} from '../scripts/checks/check-ai-workbench-live'

describe('redaction', () => {
  it('removes every shape of key this repository has seen', () => {
    /*
     * A key reaches an artefact through paths nobody predicts — an error body
     * from the provider, a URL, a stack trace. The filter runs over the output
     * for that reason, and these are the shapes it has to catch.
     */
    const cases = [
      'Authorization: Bearer sk-proj-abcdefghijklmnop1234',
      'key gsk_abcdefghijklmnopqrstuvwx12',
      'xai-abcdefghijklmnop1234',
      'https://api.example/v1?api_key=supersecretvalue&x=1',
      'Bearer abcdefghijklmnopqrstuvwxyz',
    ]

    for (const input of cases) {
      const output = redact(input)

      expect(output, input).toContain(REDACTED)
      expect(output, input).not.toMatch(/abcdefghijklmnop|supersecretvalue|qrstuvwxyz/i)
    }
  })

  it('leaves ordinary text alone', () => {
    // A redactor that mangles prose is one that gets switched off.
    expect(redact('the model replied with ok')).toBe('the model replied with ok')
    expect(redact('12 records, 3 errors')).toBe('12 records, 3 errors')
  })

  it('is idempotent', () => {
    const once = redact('Bearer abcdefghijklmnopqrstuvwxyz')

    expect(redact(once)).toBe(once)
  })
})

describe('configuration', () => {
  it('reports every missing variable, not just the first', () => {
    const result = readConfiguration({})

    expect('blocked' in result).toBe(true)
    expect('blocked' in result && result.blocked).toMatch(/ZEUS_AI_LIVE_BASE_URL/)
    expect('blocked' in result && result.blocked).toMatch(/ZEUS_AI_LIVE_API_KEY/)
    expect('blocked' in result && result.blocked).toMatch(/ZEUS_AI_LIVE_MODEL/)
  })

  it('reads a complete environment', () => {
    const result = readConfiguration({
      ZEUS_AI_LIVE_BASE_URL: 'https://api.example/v1',
      ZEUS_AI_LIVE_API_KEY: 'sk-test',
      ZEUS_AI_LIVE_MODEL: 'a-model',
    })

    expect(result).toEqual({
      baseUrl: 'https://api.example/v1',
      apiKey: 'sk-test',
      model: 'a-model',
    })
  })

  it('does not fall back to a default endpoint', () => {
    /*
     * A live gate that defaults to a local server would report a real call
     * where none was made — the exact confusion the three verdicts exist to
     * prevent.
     */
    const result = readConfiguration({ ZEUS_AI_LIVE_API_KEY: 'sk-test' })

    expect('blocked' in result).toBe(true)
  })
})

describe('limits', () => {
  it('caps every dimension a live call can spend', () => {
    expect(LIMITS.maxRequests).toBeLessThanOrEqual(10)
    expect(LIMITS.maxOutputTokens).toBeLessThanOrEqual(1024)
    expect(LIMITS.maxWallClockMs).toBeLessThanOrEqual(180_000)
    expect(LIMITS.maxConcurrency).toBe(1)
    expect(LIMITS.maxEstimatedUsd).toBeLessThanOrEqual(1)
  })
})

describe('a failed call is reported as a failure', () => {
  it('reports a transport failure without throwing', async () => {
    /*
     * The provider being unreachable must produce LIVE_FAIL, not an unhandled
     * rejection that leaves the gate with no verdict at all.
     */
    const result = await streamOnce(
      { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test', model: 'm' },
      'hello',
      { timeoutMs: 2000 },
    )

    expect(result.ok).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
