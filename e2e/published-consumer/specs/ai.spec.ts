import { expect, test } from '@playwright/test'

/**
 * The published AI packages, driven with their own deterministic host.
 *
 * `@zeus-web/ai-core` ships `createMockHost` and `createS1ChatScenario`, so the
 * "stream" here is the package's own event sequence delivered through its own
 * mock — no network, no paid model, and the same result every run.
 *
 * What is checked is that a session consumes those events and can be disposed
 * while a stream is in flight. A session that does not release its
 * subscription leaks on every unmount, which a typecheck cannot see.
 */
test.describe('ai consumer', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    ;(page as unknown as { __errors: string[] }).__errors = errors

    await page.goto('/')
    await page.waitForFunction(() => Boolean(window.__aiProbe))
  })

  test('loads a scenario with its event stream', async ({ page }) => {
    const probe = await page.evaluate(() => ({
      streamId: window.__aiProbe.streamId,
      eventCount: window.__aiProbe.eventCount,
    }))

    expect(probe.streamId).not.toBe('')
    expect(probe.eventCount).toBeGreaterThan(0)
  })

  test('delivers the scenario events through the published mock host', async ({ page }) => {
    await page.evaluate(() => window.__aiActions.play())

    await expect
      .poll(() => page.evaluate(() => window.__aiProbe.subscribeCount))
      .toBeGreaterThan(0)
  })

  test('stops a stream mid-flight', async ({ page }) => {
    await page.evaluate(() => window.__aiActions.play())
    await page.evaluate(() => window.__aiActions.stop())

    // Stopping must not throw; the session stays usable afterwards.
    expect(await page.evaluate(() => window.__aiProbe.errors)).toEqual([])
  })

  test('releases the subscription on dispose', async ({ page }) => {
    await page.evaluate(() => window.__aiActions.play())
    await page.evaluate(() => window.__aiActions.dispose())

    expect(await page.evaluate(() => window.__aiProbe.unsubscribeCount)).toBe(1)
  })

  test('produces no console errors and no diagnostics', async ({ page }) => {
    await page.evaluate(() => window.__aiActions.play())
    await page.waitForTimeout(100)

    const probe = await page.evaluate(() => ({
      errors: window.__aiProbe.errors,
      diagnostics: window.__aiProbe.diagnostics,
    }))

    expect(probe.errors, `page errors: ${probe.errors.join('\n')}`).toEqual([])
    expect(probe.diagnostics, `diagnostics: ${probe.diagnostics.join('\n')}`).toEqual([])

    const errors = (page as unknown as { __errors: string[] }).__errors
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([])
  })
})
