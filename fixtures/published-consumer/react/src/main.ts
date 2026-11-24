/**
 * React consumption of the published wrappers.
 *
 * `Button` and `Input` come from `@zeus-web/button` and `@zeus-web/input`,
 * both at 0.1.0-beta.35, through their real `/react` entry points. The names
 * and prop shapes were read from the published `.d.ts` in the installed
 * tarball.
 *
 * The spec mounts this with `createRoot`, mutates props through React state,
 * clicks, and unmounts under StrictMode. A wrapper that only types correctly
 * but does not mount would pass the typecheck and fail here.
 */
import { StrictMode, createElement, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { Button } from '@zeus-web/button/react'
import { Input } from '@zeus-web/input/react'

interface ReactProbe {
  clicks: number
  inputs: string[]
  mounted: number
  unmounted: number
  errors: string[]
}

const probe: ReactProbe = {
  clicks: 0,
  inputs: [],
  mounted: 0,
  unmounted: 0,
  errors: [],
}

declare global {
  interface Window {
    __reactProbe: ReactProbe
    __reactActions: {
      bump: () => void
      unmount: () => void
    }
    __reactBump?: () => void
    __reactUnmount?: () => void
  }
}

window.__reactProbe = probe

window.addEventListener('error', (event) => {
  probe.errors.push(String(event.message))
})

function App(): ReturnType<typeof createElement> {
  const [label, setLabel] = useState('first')
  const [value, setValue] = useState('')
  const mountedOnce = useRef(false)

  if (!mountedOnce.current) {
    mountedOnce.current = true
    probe.mounted += 1
  }

  // Exposed so the spec can drive prop updates without a DOM event.
  window.__reactBump = () => setLabel((current) => (current === 'first' ? 'second' : 'first'))

  return createElement(
    'div',
    null,
    /*
     * `ButtonProps` from the published `.d.ts` has no `id` and no `onClick`;
     * its event is `onPress` with a CustomEvent detail. Writing the obvious
     * React-shaped props failed the typecheck, which is the fixture doing its
     * job: the wrapper exposes its own contract, not React's.
     */
    createElement(
      Button,
      {
        onPress: () => {
          probe.clicks += 1
        },
      },
      `button:${label}`,
    ),
    createElement('output', { id: 'react-label' }, label),
    createElement(Input, {
      id: 'react-input',
      value,
      onValueChange: (event: { detail: { value: string } }) => {
        const next = event.detail.value
        probe.inputs.push(next)
        setValue(next)
      },
    }),
    createElement('output', { id: 'react-value' }, value),
  )
}

const container = document.querySelector<HTMLElement>('#app')!
const root = createRoot(container)

root.render(createElement(StrictMode, null, createElement(App)))

window.__reactActions = {
  bump: () => window.__reactBump?.(),
  unmount: () => {
    probe.unmounted += 1
    root.unmount()
  },
}
