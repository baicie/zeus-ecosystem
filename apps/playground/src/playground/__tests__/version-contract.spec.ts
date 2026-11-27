import { describe, expect, it } from 'vitest'

import {
  compilerIdentity,
  exportOptionsFrom,
  parseVersionContract,
  readVersionContract,
  REQUIRED_CONTRACT_PACKAGES,
  type InjectedVersionContract,
} from '../version-contract'

/*
 * Read through Vite rather than `node:fs`.
 *
 * The application's tsconfig carries `vite/client` types and not `@types/node`
 * — its runtime is the browser, and adding Node types to it for a test's sake
 * would be the wrong direction. `import.meta.glob` with `eager` is the
 * supported way to read a file here, and it also pins the text into the test
 * bundle, so the assertions below compare against what the build actually saw.
 */
const manifest = JSON.parse(
  Object.values(
    import.meta.glob<string>('../../../package.json', {
      eager: true,
      query: '?raw',
      import: 'default',
    }),
  )[0] ?? '{}',
) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = (name: string): string =>
  manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? ''

/** The object `vite.config.ts` injects, from the same manifest. */
function injected(overrides: Partial<Record<string, unknown>> = {}): InjectedVersionContract {
  return {
    compiler: declared('@zeus-js/compiler-wasm'),
    engine: declared('@zeus-js/playground-engine'),
    zeus: {
      '@zeus-js/zeus': declared('@zeus-js/zeus'),
      '@zeus-js/signal': declared('@zeus-js/signal'),
      '@zeus-js/runtime-dom': declared('@zeus-js/runtime-dom'),
      '@zeus-js/runtime-ssr': declared('@zeus-js/runtime-ssr'),
      '@zeus-js/i18n': declared('@zeus-js/i18n'),
      '@zeus-js/query': declared('@zeus-js/query'),
      '@zeus-js/router': declared('@zeus-js/router'),
    },
    toolchain: {
      vitePlugin: declared('@zeus-js/vite-plugin'),
      vite: declared('vite'),
      typescript: declared('typescript'),
    },
    ...overrides,
  }
}

describe('the version contract', () => {
  it('names the compiler with its own version line, not the runtime one', () => {
    const contract = readVersionContract()

    // The defect this contract exists to prevent: the two lines are genuinely
    // different packages on different release trains. Asserting only that the
    // compiler version is *present* would pass with the runtime version copied
    // into it, which is exactly what shipped.
    expect(contract.compiler.packageName).toBe('@zeus-js/compiler-wasm')
    expect(contract.compiler.version).toBe(declared('@zeus-js/compiler-wasm'))
    expect(contract.zeus['@zeus-js/zeus']).toBe(declared('@zeus-js/zeus'))
    expect(contract.compiler.version).not.toBe(contract.zeus['@zeus-js/zeus'])
  })

  it('reports query and router at their own declared versions', () => {
    const contract = readVersionContract()

    expect(contract.zeus['@zeus-js/query']).toBe(declared('@zeus-js/query'))
    expect(contract.zeus['@zeus-js/router']).toBe(declared('@zeus-js/router'))
    // A contract that returned the runtime version for all three would satisfy
    // a "not empty" assertion and reproduce the original defect.
    expect(contract.zeus['@zeus-js/query']).toBeTruthy()
    expect(contract.zeus['@zeus-js/router']).toBeTruthy()
  })

  it('keeps the compiler identity distinct from the runtime identity', () => {
    const contract = readVersionContract()

    const identity = compilerIdentity(contract)
    expect(identity).toBe(
      `wasm:@zeus-js/compiler-wasm@${contract.compiler.version}`,
    )
    // The old string was `wasm:0.2.0-rc.5`: a runtime version wearing the
    // compiler's label. Whatever the values become, the identity must not be
    // produced by reading the runtime line.
    expect(identity).not.toBe(`wasm:${contract.zeus['@zeus-js/zeus']}`)
  })

  it('pins the exported project to the declared toolchain', () => {
    const contract = readVersionContract()
    const options = exportOptionsFrom(contract, 'zeus-native-lab-export')

    expect(options).toEqual({
      packageName: 'zeus-native-lab-export',
      zeusVersion: contract.zeus['@zeus-js/zeus'],
      vitePluginVersion: contract.toolchain.vitePlugin,
      viteVersion: contract.toolchain.vite,
      typescriptVersion: contract.toolchain.typescript,
    })
    // The engine's own fallback is `0.1.1-beta.20`. An export that omitted
    // `zeusVersion` would silently take it, so its presence is the assertion.
    expect(options.zeusVersion).toBeTruthy()
  })

  describe('fails closed', () => {
    it('throws when no contract was injected', () => {
      expect(() => parseVersionContract(undefined)).toThrow(
        /was not injected at build time/,
      )
    })

    it('throws when the compiler is missing', () => {
      expect(() => parseVersionContract(injected({ compiler: '' }))).toThrow(
        /@zeus-js\/compiler-wasm/,
      )
    })

    it('throws when a runtime package is missing', () => {
      const contract = injected()
      expect(() =>
        parseVersionContract({
          ...contract,
          zeus: { ...contract.zeus, '@zeus-js/query': '' },
        }),
      ).toThrow(/@zeus-js\/query/)
    })

    it('throws when the toolchain is missing', () => {
      const contract = injected()
      expect(() =>
        parseVersionContract({
          ...contract,
          toolchain: { ...contract.toolchain, typescript: '' },
        }),
      ).toThrow(/typescript/)
    })

    it('lists every package it requires', () => {
      // The requirement list is the fail-closed surface; an entry dropped from
      // it turns a missing package into a silently absent version.
      expect([...REQUIRED_CONTRACT_PACKAGES]).toEqual(
        expect.arrayContaining([
          '@zeus-js/compiler-wasm',
          '@zeus-js/playground-engine',
          '@zeus-js/zeus',
          '@zeus-js/query',
          '@zeus-js/router',
          '@zeus-js/vite-plugin',
        ]),
      )
    })
  })

  describe('the negative test the R20 spec asks for', () => {
    it('fails when the compiler version is replaced by the runtime version', () => {
      // Written as a test of the test: if this passed, the assertions above
      // would be vacuous. It reproduces the shipped defect exactly — the
      // compiler field carrying the runtime package's version.
      const contract = injected()
      const defective = parseVersionContract({
        ...contract,
        compiler: contract.zeus?.['@zeus-js/zeus'],
      })

      expect(defective.compiler.version).toBe(
        readVersionContract().zeus['@zeus-js/zeus'],
      )
      expect(compilerIdentity(defective)).not.toBe(
        compilerIdentity(readVersionContract()),
      )
      expect(defective.compiler.version).not.toBe(
        declared('@zeus-js/compiler-wasm'),
      )
    })
  })
})
