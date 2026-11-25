import { render } from '@zeus-js/zeus'

/*
 * Every Zeus UI element this app renders is registered explicitly, one import
 * per package. Two reasons, both about what the app can prove:
 *
 * - The component gallery renders the real elements, so a missing registration
 *   is a blank card rather than a styled imitation. Failing loudly at the
 *   import is better than shipping a page that silently shows nothing.
 * - One import per package keeps bundle attribution honest. A barrel that
 *   registered everything would make every page pay for the whole library.
 *
 * The list is the gallery's dependency list: `examples/admin/src/gallery.tsx`.
 */
import '@zeus-web/accordion/wc/auto'
import type {} from '@zeus-web/accordion/wc'
import '@zeus-web/alert/wc/auto'
import type {} from '@zeus-web/alert/wc'
import '@zeus-web/avatar/wc/auto'
import type {} from '@zeus-web/avatar/wc'
import '@zeus-web/badge/wc/auto'
import type {} from '@zeus-web/badge/wc'
import '@zeus-web/button/wc/auto'
import type {} from '@zeus-web/button/wc'
import '@zeus-web/checkbox/wc/auto'
import type {} from '@zeus-web/checkbox/wc'
import '@zeus-web/dropdown-menu/wc/auto'
import type {} from '@zeus-web/dropdown-menu/wc'
import '@zeus-web/label/wc/auto'
import type {} from '@zeus-web/label/wc'
import '@zeus-web/popover/wc/auto'
import type {} from '@zeus-web/popover/wc'
import '@zeus-web/progress/wc/auto'
import type {} from '@zeus-web/progress/wc'
import '@zeus-web/radio-group/wc/auto'
import type {} from '@zeus-web/radio-group/wc'
import '@zeus-web/select/wc/auto'
import type {} from '@zeus-web/select/wc'
import '@zeus-web/separator/wc/auto'
import type {} from '@zeus-web/separator/wc'
import '@zeus-web/skeleton/wc/auto'
import type {} from '@zeus-web/skeleton/wc'
import '@zeus-web/switch/wc/auto'
import type {} from '@zeus-web/switch/wc'
import '@zeus-web/tabs/wc/auto'
import type {} from '@zeus-web/tabs/wc'
import '@zeus-web/textarea/wc/auto'
import type {} from '@zeus-web/textarea/wc'
import '@zeus-web/toast/wc/auto'
import type {} from '@zeus-web/toast/wc'
import '@zeus-web/tooltip/wc/auto'
import type {} from '@zeus-web/tooltip/wc'

import '@zeus-web/data-grid/wc/auto'
import type {} from '@zeus-web/data-grid/wc'
import '@zeus-web/dialog/wc/auto'
import type {} from '@zeus-web/dialog/wc'
import '@zeus-web/input/wc/auto'
import type {} from '@zeus-web/input/wc'

import { App } from './app'
import { bootstrapDevtools, teardown } from './devtools/bootstrap'
import './style.css'

const root = document.getElementById('root')
if (!root) throw new Error('Zeus Admin root element was not found.')
const mountRoot = root

/**
 * Mounts the admin shell.
 *
 * ## DevTools
 *
 * In a development build with `?devtools` in the URL, this also mounts the
 * panel from `@zeus-js/devtools-consumer`. That package was `private: true` and
 * unpublished when Admin was migrated, so the panel could not be carried over —
 * the migration may only install published packages. It is published now, and
 * `./devtools/bootstrap` restores it.
 *
 * The bootstrap is dynamic and guarded by `import.meta.env.DEV`, so a
 * production build contains neither the module nor the call.
 */
function mount(): void {
  render(() => <App />, mountRoot)

  void bootstrapDevtools().then(handle => {
    if (!handle) return

    /* A developer driving the panel from the console, as the original did. */
    Object.assign(window, { adminDevtools: handle })
  })
}

void mount()

/*
 * HMR disposes the panel before the next module instance mounts one. Without
 * this, each edit adds a consumer to the same window and the timeline shows
 * every event once more per reload.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    teardown()
  })
}
