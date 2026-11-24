/**
 * Vue consumption of the published wrappers.
 *
 * `Button` and `Input` from `@zeus-web/button` and `@zeus-web/input` at
 * 0.1.0-beta.35, through their real `/vue` entry points.
 *
 * The emitted event is `press` — read from the published `DefineComponent`
 * type, not assumed to be Vue's usual `click`. Emits, reactive props and
 * unmount are what the spec drives.
 */
import { createApp, defineComponent, h, ref } from 'vue'

import { Button } from '@zeus-web/button/vue'
import { Input } from '@zeus-web/input/vue'

interface VueProbe {
  presses: number
  inputs: string[]
  mounted: number
  unmounted: number
  errors: string[]
}

const probe: VueProbe = {
  presses: 0,
  inputs: [],
  mounted: 0,
  unmounted: 0,
  errors: [],
}

declare global {
  interface Window {
    __vueProbe: VueProbe
    __vueActions: {
      bump: () => void
      unmount: () => void
    }
  }
}

window.__vueProbe = probe

window.addEventListener('error', (event) => {
  probe.errors.push(String(event.message))
})

const label = ref('first')
const inputValue = ref('')

const App = defineComponent({
  name: 'FixtureApp',
  setup() {
    probe.mounted += 1

    return () =>
      h('div', null, [
        h(
          Button,
          {
            onPress: () => {
              probe.presses += 1
            },
          },
          () => `button:${label.value}`,
        ),
        h('output', { id: 'vue-label' }, label.value),
        h(Input, {
          value: inputValue.value,
          'onUpdate:value': (next: string) => {
            probe.inputs.push(next)
            inputValue.value = next
          },
        }),
        h('output', { id: 'vue-value' }, inputValue.value),
      ])
  },
})

const container = document.querySelector<HTMLElement>('#app')!
const app = createApp(App)
app.mount(container)

window.__vueActions = {
  bump: () => {
    label.value = label.value === 'first' ? 'second' : 'first'
  },
  unmount: () => {
    probe.unmounted += 1
    app.unmount()
  },
}
