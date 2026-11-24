import { expect, test } from '@playwright/test'

/**
 * React wrappers, mounted with `createRoot` under `StrictMode`.
 *
 * StrictMode is deliberate: it mounts, unmounts and remounts effects in
 * development, which is exactly where a wrapper that does not clean up
 * misbehaves. The published wrapper has to survive that.
 *
 * Props are updated through React state rather than by poking the element,
 * so what is tested is the wrapper's reactivity, not the custom element's.
 */
test.describe('react consumer', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    ;(page as unknown as { __errors: string[] }).__errors = errors

    await page.goto('/')
    await page.waitForFunction(() => Boolean(window.__reactProbe))
  })

  test('mounts the published Button and Input', async ({ page }) => {
    await expect(page.locator('#react-button')).toBeAttached()
    await expect(page.locator('#react-input')).toBeAttached()

    expect(await page.evaluate(() => window.__reactProbe.mounted)).toBeGreaterThan(0)
  })

  test('updates props through React state', async ({ page }) => {
    await expect(page.locator('#react-label')).toHaveText('first')

    await page.evaluate(() => window.__reactActions.bump())

    await expect(page.locator('#react-label')).toHaveText('second')
  })

  test('delivers the wrapper press event', async ({ page }) => {
    await page.locator('#react-button').click()

    await expect
      .poll(() => page.evaluate(() => window.__reactProbe.clicks))
      .toBeGreaterThan(0)
  })

  test('feeds typed input back through onValueChange', async ({ page }) => {
    const input = page.locator('#react-input input, #react-input').first()

    await input.click()
    await page.keyboard.type('hi')

    await expect
      .poll(() => page.evaluate(() => window.__reactProbe.inputs.join('')))
      .toContain('hi')
  })

  test('unmounts without leaving the tree behind', async ({ page }) => {
    await page.evaluate(() => window.__reactActions.unmount())

    await expect(page.locator('#react-button')).toHaveCount(0)
    expect(await page.evaluate(() => window.__reactProbe.unmounted)).toBe(1)
  })

  test('survives StrictMode remounting without console errors', async ({ page }) => {
    await page.evaluate(() => window.__reactActions.bump())
    await page.waitForTimeout(100)

    const errors = (page as unknown as { __errors: string[] }).__errors
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([])
  })
})
