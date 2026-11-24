import { expect, test } from '@playwright/test'

/**
 * Vue wrappers, mounted with `createApp`.
 *
 * The published wrappers emit `press` and `value-change` / `update:value`
 * rather than Vue's usual `click` and `input`. Those names came from the
 * published `DefineComponent` type, not from convention.
 */
test.describe('vue consumer', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    ;(page as unknown as { __errors: string[] }).__errors = errors

    await page.goto('/')
    await page.waitForFunction(() => Boolean(window.__vueProbe))
  })

  test('mounts the published Button and Input', async ({ page }) => {
    await expect(page.locator('#vue-label')).toBeAttached()

    expect(await page.evaluate(() => window.__vueProbe.mounted)).toBeGreaterThan(0)
  })

  test('updates reactive props', async ({ page }) => {
    await expect(page.locator('#vue-label')).toHaveText('first')

    await page.evaluate(() => window.__vueActions.bump())

    await expect(page.locator('#vue-label')).toHaveText('second')
  })

  test('receives the wrapper press emit', async ({ page }) => {
    await page.getByRole('button', { name: /button:/ }).first().click()

    await expect
      .poll(() => page.evaluate(() => window.__vueProbe.presses))
      .toBeGreaterThan(0)
  })

  test('keeps value and element in step through update:value', async ({ page }) => {
    const input = page.locator('input').first()

    await input.click()
    await page.keyboard.type('hey')

    await expect
      .poll(() => page.evaluate(() => window.__vueProbe.inputs.join('')))
      .toContain('hey')
  })

  test('unmounts cleanly', async ({ page }) => {
    await page.evaluate(() => window.__vueActions.unmount())

    await expect(page.locator('#vue-label')).toHaveCount(0)
    expect(await page.evaluate(() => window.__vueProbe.unmounted)).toBe(1)
  })

  test('produces no console errors', async ({ page }) => {
    await page.evaluate(() => window.__vueActions.bump())
    await page.waitForTimeout(100)

    const errors = (page as unknown as { __errors: string[] }).__errors
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([])
  })
})
