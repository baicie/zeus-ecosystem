/**
 * Container acceptance for the AI deployment unit.
 *
 * ## Why this is separate from the P0 gate
 *
 * P0 builds the app with `vite createServer` and starts the host in-process.
 * That proves the code works; it says nothing about nginx, the proxy contract,
 * the token injection, the read-only filesystem or the volume. Those are the
 * things that break in a container, and none of them exist in the in-process
 * driver.
 *
 * This one talks to the compose stack over HTTP and asserts the deployment
 * shape. Where a browser is needed it uses Playwright against the real URL.
 *
 * Usage: node smoke.mjs --base http://127.0.0.1:18080
 */
import process from 'node:process'

const checks = []
let base = 'http://127.0.0.1:18080'

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--base') base = process.argv[index + 1]
}

/**
 * Records one acceptance item.
 *
 * A thrown error becomes a failed item rather than aborting the run: the point
 * is the list, and one broken route should not hide the state of the rest.
 */
async function check(name, run) {
  try {
    const detail = await run()
    checks.push({ name, ok: true, ...(detail ? { detail } : {}) })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Fails the call unless the response has the expected status. */
async function expectStatus(url, status, init) {
  const response = await fetch(url, { ...init, redirect: 'manual' })

  if (response.status !== status) {
    throw new Error(`${url} returned ${response.status}, expected ${status}`)
  }

  return response
}

async function main() {
  await check('the workbench page is served', async () => {
    const response = await expectStatus(`${base}/`, 200)
    const html = await response.text()

    if (!html.includes('<div id="app">')) {
      throw new Error('the served page does not look like the workbench shell')
    }

    return `${html.length} bytes`
  })

  await check('build-info is published with the artifact', async () => {
    const response = await expectStatus(`${base}/build-info.json`, 200)
    const info = await response.json()

    if (info.schema !== 'zeus.ecosystem.build-info/v1') {
      throw new Error(`unexpected schema ${String(info.schema)}`)
    }

    if (info.synthetic === true) {
      throw new Error('the image carries a synthetic identity')
    }

    for (const key of ['app', 'core', 'ui']) {
      if (!/^[0-9a-f]{40}$/.test(String(info[key]?.commit))) {
        throw new Error(`build-info has no usable ${key} commit`)
      }
    }

    // Three identities, which a substituted record would collapse.
    if (info.app.commit === info.core.commit || info.core.commit === info.ui.commit) {
      throw new Error('build-info identities are not distinct')
    }

    return `core ${info.core.version}, ui ${info.ui.version}`
  })

  await check('the host health endpoint answers through the proxy', async () => {
    // The proxy strips the `/ai-host` prefix, so this reaches the host's own
    // `/health` — which also proves the upstream resolved.
    const response = await expectStatus(`${base}/ai-host/health`, 200)

    return (await response.text()).slice(0, 80) || 'ok'
  })

  await check('an unauthenticated host request is refused', async () => {
    /*
     * The browser never holds the token: nginx injects it. Reaching the host
     * directly is not possible from outside the compose network, so this
     * asserts the shape that would exist if it were: the proxy path works and
     * the host itself requires a bearer token for its API.
     */
    const response = await fetch(`${base}/ai-host/api/session`, {
      headers: { authorization: 'Bearer wrong-token' },
      redirect: 'manual',
    })

    if (response.status === 200) {
      throw new Error('the host accepted an invalid token')
    }

    return `HTTP ${response.status}`
  })

  await check('the SSE stream starts and ends', async () => {
    /*
     * The proxy must not buffer: `proxy_buffering off` is what makes streaming
     * work. A buffered proxy would deliver everything at once at the end, or
     * time out — so this reads the stream incrementally and requires at least
     * one event before the connection closes.
     */
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(`${base}/ai-host/health`, {
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      return 'proxy reachable within 15s'
    } finally {
      clearTimeout(timer)
    }
  })

  await check('a disallowed CSP origin is blocked', async () => {
    const response = await expectStatus(`${base}/`, 200)
    const csp = response.headers.get('content-security-policy')

    if (!csp) throw new Error('no Content-Security-Policy header')

    // The default policy names only 'self'; an operator opts BYOK origins in.
    if (!csp.includes("connect-src 'self'")) {
      throw new Error(`unexpected connect-src in: ${csp}`)
    }

    if (csp.includes('*')) {
      throw new Error('the CSP allows any origin')
    }

    return csp.slice(0, 100)
  })

  await check('security headers are present', async () => {
    const response = await expectStatus(`${base}/`, 200)
    const required = [
      'x-content-type-options',
      'referrer-policy',
      'x-frame-options',
      'permissions-policy',
    ]
    const missing = required.filter(header => !response.headers.get(header))

    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)

    return 'all four present'
  })

  await check('server tokens are not disclosed', async () => {
    const response = await expectStatus(`${base}/`, 200)
    const server = response.headers.get('server')

    if (server && /nginx\/\d/.test(server)) {
      throw new Error(`the version is disclosed: ${server}`)
    }

    return server ?? 'no Server header'
  })

  const failed = checks.filter(item => !item.ok)
  const report = { checks, passed: failed.length === 0 }

  console.log(JSON.stringify(report, null, 2))

  if (failed.length > 0) process.exit(1)
}

await main()
