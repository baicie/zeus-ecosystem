/**
 * AI consumption of the published packages.
 *
 * The published `@zeus-web/ai-core` ships its own deterministic host and
 * scenario fixtures — `createMockHost`, `createS1ChatScenario`,
 * `createAiSession`. This fixture uses those rather than inventing a local
 * mock, so what it exercises is the package's own contract. No network and no
 * paid model are involved; a "stream" is the scenario's event sequence
 * delivered through the published mock host.
 *
 * The spec drives: send a message, observe streamed text, stop mid-stream,
 * resume, and unmount while a stream is in flight.
 */
import {
  createAiSession,
  createMockHost,
  createS1ChatScenario,
} from '@zeus-web/ai-core'

interface AiProbe {
  streamId: string
  eventCount: number
  commandCount: number
  textByStep: string[]
  subscribeCount: number
  unsubscribeCount: number
  diagnostics: string[]
  errors: string[]
}

const probe: AiProbe = {
  streamId: '',
  eventCount: 0,
  commandCount: 0,
  textByStep: [],
  subscribeCount: 0,
  unsubscribeCount: 0,
  diagnostics: [],
  errors: [],
}

declare global {
  interface Window {
    __aiProbe: AiProbe
    __aiActions: {
      play: () => void
      stop: () => void
      dispose: () => void
    }
  }
}

window.__aiProbe = probe

window.addEventListener('error', (event) => {
  probe.errors.push(String(event.message))
})

const scenario = createS1ChatScenario()

probe.streamId = scenario.streamId
probe.eventCount = scenario.events.length

const host = createMockHost({ streamId: scenario.streamId })

const session = createAiSession({
  host,
  streamId: scenario.streamId,
  snapshotScope: { kind: 'stream', id: scenario.streamId },
  onDiagnostic: (diagnostic) => {
    probe.diagnostics.push(String(diagnostic.code ?? diagnostic))
  },
})

/*
 * Subscribing is what makes the session observe the host. The spec asserts a
 * subscription happened and that disposing releases it, because a session that
 * never unsubscribes leaks on every unmount.
 */
/*
 * `subscribe` is `<T>(selector, listener, equal?)`, not a bare callback: the
 * session is a Controller over a view, so a subscription names what it wants
 * and gets that value. Assuming the one-argument Redux shape failed the
 * typecheck.
 */
const unsubscribe = session.subscribe(
  (view) => view,
  () => {
    probe.subscribeCount += 1
  },
)

let stopConnect: (() => void) | undefined

const play = (): void => {
  stopConnect = session.connect()

  for (const event of scenario.events) {
    host.emit(event.type, event.entity.id, event.payload)
  }

  probe.commandCount = host.commands().length
}

window.__aiActions = {
  play,
  stop: () => {
    stopConnect?.()
    stopConnect = undefined
  },
  dispose: () => {
    stopConnect?.()
    unsubscribe()
    probe.unsubscribeCount += 1
    session.dispose()
    host.close()
  },
}

play()
