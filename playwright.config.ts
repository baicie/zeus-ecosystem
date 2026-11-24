/**
 * Browser acceptance for the published-consumer fixtures.
 *
 * Each project serves one fixture's production build and drives it. The
 * assertions are about behaviour — an element that opens and closes, a signal
 * that reaches the DOM, a wrapper that mounts and unmounts — not about an
 * import succeeding.
 *
 * Evidence is kept: screenshots and traces on failure, and the browser console
 * is captured so a runtime warning in a published package is visible rather
 * than silently swallowed.
 */
import { defineConfig, devices } from '@playwright/test'

const PORT_BASE = 4300

/** One project per fixture, each with its own preview server. */
export const FIXTURES = [
  { name: 'native', port: PORT_BASE + 1 },
  { name: 'web-components', port: PORT_BASE + 2 },
  { name: 'react', port: PORT_BASE + 3 },
  { name: 'vue', port: PORT_BASE + 4 },
  { name: 'ai', port: PORT_BASE + 5 },
]

export default defineConfig({
  testDir: './e2e/published-consumer/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/published-consumer.json' }],
    ['html', { outputFolder: 'reports/published-consumer-html', open: 'never' }],
  ],
  outputDir: 'reports/published-consumer-artifacts',

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: FIXTURES.flatMap(fixture =>
    ['chromium', 'firefox', 'webkit'].map(browser => ({
      name: `${fixture.name}-${browser}`,
      testMatch: `**/${fixture.name}.spec.ts`,
      use: {
        ...devices[browser],
        baseURL: `http://127.0.0.1:${fixture.port}`,
      },
    })),
  ),

  /* One preview server per fixture, serving that fixture's built output. */
  webServer: FIXTURES.map(fixture => ({
    /*
     * `--host 127.0.0.1` is required, not cosmetic.
     *
     * `vite preview` listens on `localhost`, which on macOS resolves to ::1
     * first. Playwright probes the IPv4 `url` below and waits for it forever:
     * the server is up, the probe is on the wrong address, and the failure
     * reads as "Timed out waiting 120000ms from config.webServer".
     */
    command: `npx vite preview --host 127.0.0.1 --port ${fixture.port} --strictPort`,
    cwd: `fixtures/published-consumer/${fixture.name}`,
    url: `http://127.0.0.1:${fixture.port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  })),
})
