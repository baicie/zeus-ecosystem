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
import './style.css'

const root = document.getElementById('root')
if (!root) throw new Error('Zeus Admin root element was not found.')
const mountRoot = root

/**
 * Mounts the admin shell.
 *
 * ## What is missing, and why
 *
 * The original also loaded `@zeus-js/devtools-consumer` when running in dev
 * mode with `?devtools` in the URL. That package is `private: true` at
 * `0.1.1-beta.14` and has never been published — it is not one of the 32
 * release packages — so it cannot be installed here, and vendoring its source
 * would be exactly the reverse dependency this migration removes.
 *
 * It is a development-only panel: behind `import.meta.env.DEV` and a query
 * parameter, so it was dead code in every production build. Dropping it changes
 * no shipped behaviour. Restoring it needs a published package, which is an
 * upstream release decision, not something this repository can make.
 */
function mount(): void {
  render(() => <App />, mountRoot)
}

void mount()
