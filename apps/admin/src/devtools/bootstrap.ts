/**
 * The development-only DevTools panel.
 *
 * ## What it is
 *
 * `@zeus-js/devtools-consumer` observes the runtime's event protocol and keeps
 * a panel-friendly graph. It is not part of the product: it runs behind
 * `import.meta.env.DEV` and an explicit `?devtools` parameter, so a production
 * build carries none of it.
 *
 * ## Why it was missing, and why it is back
 *
 * The migration could not carry it: the package was `private: true` and had
 * never been published, and installing it from source would have been exactly
 * the reverse dependency the migration exists to remove. It is published now —
 * `0.1.1-beta.15`, with the same four exports — so the panel is restored from a
 * package like everything else here.
 *
 * ## The lifecycle, and why each step is where it is
 *
 *   1. opt-in only: `import.meta.env.DEV` and `?devtools`
 *   2. dynamic import, so the module is absent from a production bundle
 *   3. panel mounted, consumer connected
 *   4. a handle exposed for a developer to drive
 *   5. HMR disposes the previous instance before the next one mounts
 *   6. navigation away tears everything down
 *
 * Step 5 is not hypothetical: `import.meta.hot` survives a module reload, so
 * without a dispose the page accumulates one consumer per edit and the timeline
 * shows every event twice, then three times.
 */

export interface AdminDevtoolsHandle {
  snapshot(): unknown
  disconnect(): void
}

/** The container's id, so a stale panel can be found and removed. */
const CONTAINER_ID = 'admin-devtools'

/** The module-scope handle, so a reload can dispose what it replaces. */
let current: AdminDevtoolsHandle | null = null

/**
 * Removes any panel and disconnects its consumer.
 *
 * Safe to call when nothing is mounted: a reload after a failed bootstrap, or a
 * dispose registered twice by a module that was itself reloaded.
 */
export function teardown(): void {
  current?.disconnect()
  current = null

  document.getElementById(CONTAINER_ID)?.remove()
}

/**
 * Mounts the panel when this is a development build and the URL asks for it.
 *
 * Returns `null` in every other case, including a failure — a DevTools panel
 * that cannot load must not stop the application from starting.
 */
export async function bootstrapDevtools(): Promise<AdminDevtoolsHandle | null> {
  if (!import.meta.env.DEV) return null
  if (!new URLSearchParams(window.location.search).has('devtools')) return null

  /* A second call replaces the first rather than stacking on it. */
  teardown()

  try {
    const { createDevtoolsConsumer, createDevtoolsPanel } = await import(
      '@zeus-js/devtools-consumer'
    )

    const consumer = createDevtoolsConsumer(window)
    consumer.connect()

    const container = document.createElement('aside')
    container.id = CONTAINER_ID
    container.style.cssText = [
      'background:#020617',
      'color:#e2e8f0',
      'height:48vh',
      'inset:auto 0 0 auto',
      'overflow:auto',
      'position:fixed',
      'width:min(390px,100vw)',
      'z-index:10000',
    ].join(';')

    document.body.append(container)

    const previousPadding = document.body.style.paddingRight
    document.body.style.paddingRight = '390px'

    const panel = createDevtoolsPanel(container, consumer)

    const handle: AdminDevtoolsHandle = {
      snapshot: () => consumer.getSnapshot(),
      disconnect() {
        consumer.disconnect()
        panel.disconnect()
        container.remove()
        document.body.style.paddingRight = previousPadding
      },
    }

    current = handle

    return handle
  } catch (error) {
    /*
     * A panel that failed to mount leaves the product alone. Logged rather than
     * thrown: the whole point of the feature is debugging, and breaking the page
     * while debugging is the worst possible failure mode.
     */
    console.warn('[admin] devtools did not start:', error)

    teardown()

    return null
  }
}
