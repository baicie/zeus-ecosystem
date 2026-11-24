/**
 * Native Zeus consumption, against published packages only.
 *
 * Every import resolves through `node_modules` to a tarball from
 * registry.npmjs.org. No alias, no workspace link, no local build.
 *
 * The browser spec drives this page and asserts on what it renders, so the
 * evidence is "the DOM changed", not "the import succeeded".
 *
 * Types here come from the published `.d.ts` — `defineElement` is
 * `(tagName, options, setup)`, with `setup` in the third position. That
 * signature was read from `runtime-dom.d.ts` in the installed tarball rather
 * than assumed; `skipLibCheck: false` makes a mistake fail the typecheck.
 */
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
} from '@zeus-js/signal'
import { defineElement } from '@zeus-js/runtime-dom'

// `/wc/auto` registers the elements; the package root only exports them.
import '@zeus-web/themes'
import '@zeus-web/button/wc/auto'
import '@zeus-web/input/wc/auto'
import '@zeus-web/dialog/wc/auto'
import '@zeus-web/data-grid/wc/auto'

interface Probe {
  effectRuns: number[]
  cleanups: number
  props: string[]
  events: string[]
  conditional: string[]
  mounted: number
  unmounted: number
}

const probe: Probe = {
  effectRuns: [],
  cleanups: 0,
  props: [],
  events: [],
  conditional: [],
  mounted: 0,
  unmounted: 0,
}

declare global {
  interface Window {
    __zeusProbe: Probe
    __zeusActions: {
      bump: () => void
      setIdle: () => void
      flip: () => void
      remount: () => void
      teardown: () => void
    }
  }
}

window.__zeusProbe = probe

/* Signals, memo, effect, cleanup, with no DOM involved. */
const [count, setCount] = createSignal(0)
const doubled = createMemo(() => count() * 2)

const disposeRoot = createRoot((dispose) => {
  createEffect(() => {
    probe.effectRuns.push(count())
  })

  onCleanup(() => {
    probe.cleanups += 1
  })

  return dispose
})

/*
 * A component defined through the published runtime, in the published
 * three-argument form.
 */
defineElement(
  'published-probe',
  { props: { label: { type: String, attribute: 'label' } } },
  (props) => {
    probe.mounted += 1
    probe.props.push(String(props.label ?? ''))

    const host = document.createElement('span')
    host.textContent = `probe:${props.label ?? ''}`

    return host
  },
)

const app = document.querySelector<HTMLElement>('#app')!

const output = document.createElement('output')
output.id = 'signal-output'
app.append(output)

createEffect(() => {
  output.textContent = `${count()}/${doubled()}`
})

const probeElement = document.createElement('published-probe')
probeElement.id = 'probe'
probeElement.setAttribute('label', 'first')
app.append(probeElement)

/* A region shown and hidden by a signal. */
const conditionalHost = document.createElement('div')
conditionalHost.id = 'conditional'
app.append(conditionalHost)

const [visible, setVisible] = createSignal(true)

createEffect(() => {
  conditionalHost.replaceChildren()

  if (visible()) {
    const marker = document.createElement('span')
    marker.id = 'conditional-marker'
    marker.textContent = 'shown'
    conditionalHost.append(marker)
    probe.conditional.push('shown')
  } else {
    probe.conditional.push('hidden')
  }
})

/* A real click that updates a signal. */
const increment = document.createElement('button')
increment.id = 'increment'
increment.textContent = 'increment'
increment.addEventListener('click', () => {
  probe.events.push('click')
  setCount(count() + 1)
})
app.append(increment)

/* Mount, unmount and remount, to show the scope is released then recreated. */
const remountHost = document.createElement('div')
remountHost.id = 'remount'
app.append(remountHost)

let remountDispose: (() => void) | undefined

const mountRemountable = (): void => {
  remountDispose = createRoot((dispose) => {
    const badge = document.createElement('span')
    badge.className = 'remountable'
    badge.textContent = 'mounted'
    remountHost.append(badge)

    onCleanup(() => {
      badge.remove()
      probe.cleanups += 1
    })

    return dispose
  })
}

mountRemountable()

window.__zeusActions = {
  bump: () => setCount(count() + 1),
  setIdle: () => setCount(0),
  flip: () => setVisible(!visible()),
  remount: () => {
    remountDispose?.()
    mountRemountable()
  },
  teardown: () => {
    remountDispose?.()
    disposeRoot()
  },
}
