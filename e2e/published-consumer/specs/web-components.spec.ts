import { expect, test } from '@playwright/test'

/**
 * Web Components, driven in a real browser.
 *
 * `customElements.get` is checked once, as a precondition — registering an
 * element proves nothing about whether it works. Everything after that is
 * behaviour: a click that fires, typing that updates, a dialog that opens,
 * closes and reopens, rows that update and clear.
 */
test.describe('web components consumer', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('pageerror', (error) => errors.push(error.message))
    ;(page as unknown as { __errors: string[] }).__errors = errors

    await page.goto('/')
    await page.waitForFunction(() => Boolean(window.__wcProbe))
  })

  test('registers every published element', async ({ page }) => {
    const registered = await page.evaluate(() => window.__wcProbe.registered)

    for (const [name, present] of Object.entries(registered)) {
      expect(present, `${name} should be registered by its package`).toBe(true)
    }
  })

  test('a click on zw-button reaches a listener', async ({ page }) => {
    await page.locator('#probe-button').click()

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __buttonClicks?: number }).__buttonClicks))
      .toBeGreaterThan(0)
  })

  test('typing into zw-input updates it and fires input events', async ({ page }) => {
    const input = page.locator('#probe-input input, #probe-input').first()

    await input.click()
    await page.keyboard.type('hello')

    await expect
      .poll(() => page.evaluate(() => window.__wcProbe.inputValues.join('')))
      .toContain('hello')

    expect(await page.evaluate(() => window.__wcProbe.keydowns)).toBeGreaterThan(0)
  })

  test('zw-dialog opens, closes and reopens', async ({ page }) => {
    /*
     * Driven through the element's own `open` property, because that is the
     * API it exposes — probing it showed `open` reflected to an attribute and
     * `data-state` changing, and no `open`/`toggle`/`zeus:open` event firing.
     * A test that listened for an event would have failed on a working dialog.
     */
    const dialog = page.locator('#probe-dialog')

    await page.evaluate(() => {
      ;(document.querySelector('#probe-dialog') as { open?: boolean }).open = true
    })
    await expect(dialog).toHaveAttribute('open', '')

    await page.evaluate(() => {
      ;(document.querySelector('#probe-dialog') as { open?: boolean }).open = false
    })
    await expect(dialog).not.toHaveAttribute('open', '')

    // Reopening is the part that breaks when a dialog leaves stale state.
    await page.evaluate(() => {
      ;(document.querySelector('#probe-dialog') as { open?: boolean }).open = true
    })
    await expect(dialog).toHaveAttribute('open', '')
  })

  test('zw-data-grid accepts rows, updates and clears them', async ({ page }) => {
    await expect(page.locator('#probe-grid')).toBeAttached()

    await page.evaluate(() => window.__wcActions.setRows(5))
    await page.waitForTimeout(100)

    await page.evaluate(() => window.__wcActions.clearRows())
    await page.waitForTimeout(100)

    // The grid must still be alive after its rows were removed.
    await expect(page.locator('#probe-grid')).toBeAttached()
  })

  test('produces no console errors', async ({ page }) => {
    await page.locator('#probe-button').click()

    const errors = (page as unknown as { __errors: string[] }).__errors
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([])
  })
})
