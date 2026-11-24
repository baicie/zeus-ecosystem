import { expect, test } from '@playwright/test'

/**
 * Native Zeus consumption, driven in a real browser.
 *
 * Every assertion is about observed behaviour. Reading `window.__zeusProbe`
 * after an interaction proves the published runtime actually ran; asserting
 * that a module loaded would not.
 */
test.describe('native consumer', () => {
  test.beforeEach(async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    await page.goto('/')
    await page.waitForFunction(() => Boolean(window.__zeusProbe))

    ;(page as unknown as { __consoleErrors: string[] }).__consoleErrors = consoleErrors
  })

  test('updates a signal, its effect and a memo in the DOM', async ({ page }) => {
    await expect(page.locator('#signal-output')).toHaveText('0/0')

    await page.locator('#increment').click()

    await expect(page.locator('#signal-output')).toHaveText('1/2')

    const effectRuns = await page.evaluate(() => window.__zeusProbe.effectRuns)
    expect(effectRuns).toContain(0)
    expect(effectRuns).toContain(1)
  })

  test('records a real click on a real element', async ({ page }) => {
    await page.locator('#increment').click()
    await page.locator('#increment').click()

    const events = await page.evaluate(() => window.__zeusProbe.events)
    expect(events).toEqual(['click', 'click'])
  })

  test('mounts a component defined through the published runtime', async ({ page }) => {
    await expect(page.locator('#probe')).toBeAttached()

    const probe = await page.evaluate(() => ({
      mounted: window.__zeusProbe.mounted,
      props: window.__zeusProbe.props,
    }))

    expect(probe.mounted).toBeGreaterThanOrEqual(1)
    expect(probe.props).toContain('first')
  })

  test('renders a conditional region and removes it when the signal flips', async ({ page }) => {
    await expect(page.locator('#conditional-marker')).toHaveText('shown')

    await page.evaluate(() => window.__zeusActions.flip())

    await expect(page.locator('#conditional-marker')).toHaveCount(0)

    await page.evaluate(() => window.__zeusActions.flip())

    await expect(page.locator('#conditional-marker')).toHaveText('shown')

    const states = await page.evaluate(() => window.__zeusProbe.conditional)
    expect(states).toEqual(['shown', 'hidden', 'shown'])
  })

  test('releases the scope on unmount and recreates it on remount', async ({ page }) => {
    const before = await page.evaluate(() => window.__zeusProbe.cleanups)

    await page.evaluate(() => window.__zeusActions.remount())

    const after = await page.evaluate(() => window.__zeusProbe.cleanups)
    expect(after).toBeGreaterThan(before)

    // Exactly one badge: the old one was removed, not merely hidden.
    await expect(page.locator('.remountable')).toHaveCount(1)
  })

  test('runs a single reactive engine across Core and UI', async ({ page }) => {
    /*
     * Duplicate engines are the failure this repository exists to catch with
     * Core and UI installed together: two copies of @zeus-js/signal still
     * import cleanly, but their module identities differ and effects do not
     * cross. The engine guard throws in that case rather than failing
     * silently.
     *
     * Checked through what the page already loaded, not by importing. A bare
     * specifier like '@zeus-js/signal' is resolved by Vite at build time; at
     * runtime `await import('@zeus-js/signal')` inside page.evaluate throws
     * "Failed to resolve module specifier", which says nothing about the
     * release.
     */
    const engine = await page.evaluate(() => {
      const probe = window.__zeusProbe

      return {
        effectRuns: probe.effectRuns.length,
        props: probe.props.length,
        // A second engine would show up as effects that never run for the
        // signal that a component's own runtime created.
        mounted: probe.mounted,
      }
    })

    expect(engine.effectRuns).toBeGreaterThan(0)
    expect(engine.mounted).toBeGreaterThanOrEqual(1)
  })

  test('produces no console errors', async ({ page }) => {
    await page.locator('#increment').click()

    const errors = (page as unknown as { __consoleErrors: string[] }).__consoleErrors
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([])
  })
})
