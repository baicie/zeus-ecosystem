import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import zeus from '@zeus-js/vite-plugin'
import { defineConfig, type Plugin } from 'vite'

import { createBuildInfo } from '../../scripts/release/build-info.mjs'

/*
 * The application's whole package identity, read from its own manifest once.
 *
 * Two separate defects came from computing these in more than one place: the
 * compiler was labelled with the *runtime* version, and the exported project
 * pinned a version line this app no longer used because `exportProject` fell
 * back to constants inside the engine. Both were literal strings. This object
 * is the single injection point; `src/playground/version-contract.ts` is the
 * only reader, and the snapshot, the export and the build metadata all take
 * their versions from it.
 *
 * `dependencies` is listed rather than "everything `@zeus-js/*`" because the
 * contract must fail closed on a package the application forgot to declare —
 * a discovered list would silently shrink instead.
 */
function injectedVersionContract() {
  const manifest = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dependency = (name: string): string =>
    manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? ''
  const zeusPackages = [
    '@zeus-js/zeus',
    '@zeus-js/signal',
    '@zeus-js/runtime-dom',
    '@zeus-js/runtime-ssr',
    '@zeus-js/i18n',
    '@zeus-js/query',
    '@zeus-js/router',
  ]

  return {
    __ZEUS_VERSION_CONTRACT__: JSON.stringify({
      compiler: dependency('@zeus-js/compiler-wasm'),
      engine: dependency('@zeus-js/playground-engine'),
      zeus: Object.fromEntries(
        zeusPackages.map(name => [name, dependency(name)]),
      ),
      toolchain: {
        vitePlugin: dependency('@zeus-js/vite-plugin'),
        vite: dependency('vite'),
        typescript: dependency('typescript'),
      },
    }),
  }
}

/**
 * Writes the build identity next to the bundle.
 *
 * `infra/contracts/products.json` gives the Playground `buildInfoPath: null`,
 * which is why its delivery evidence said less than Admin's and the
 * workbench's: an audit could name the image but not the packages inside it.
 * The identity is the same one the other two apps emit — source commit,
 * lockfile hash, and the per-package versions the release contract pins.
 *
 * Emitted as a separate asset rather than injected into the JS: it has to be
 * readable by a deployment check without executing the app.
 */
function buildInfoPlugin(): Plugin {
  return {
    name: 'zeus-build-info',
    apply: 'build',
    generateBundle() {
      // The repository root: the release contract and the lockfile both live
      // there, and passing the app directory made a present contract look
      // missing the first time this was written for the workbench.
      const root = fileURLToPath(new URL('../..', import.meta.url))

      const info = createBuildInfo({
        root,
        product: 'playground',
        allowSynthetic: process.env.ZEUS_ALLOW_SYNTHETIC_IDENTITY === '1',
      })

      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: `${JSON.stringify(info, null, 2)}\n`,
      })
    },
  }
}

// The sandbox document may be served under a path prefix (production mounts it
// at /zeus-sandbox/). Absolute asset URLs would escape that prefix, so the
// sandbox entry rewrites them to paths relative to its own directory.
function relativeSandboxAssets() {
  return {
    name: 'zeus-relative-sandbox-assets',
    enforce: 'post' as const,
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string, context: { filename?: string }) {
        if (!context.filename?.endsWith('sandbox.html')) return html
        return html
          .replaceAll('src="/assets/', 'src="./assets/')
          .replaceAll('href="/assets/', 'href="./assets/')
      },
    },
  }
}

export default defineConfig({
  define: injectedVersionContract(),
  plugins: [zeus(), relativeSandboxAssets(), buildInfoPlugin()],
  server: {
    headers: {
      // Opaque-origin module workers and iframes request scripts with Origin: null.
      'Access-Control-Allow-Origin': '*',
    },
  },
  preview: {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        webc: fileURLToPath(new URL('./webc.html', import.meta.url)),
        host: fileURLToPath(new URL('./host.html', import.meta.url)),
        sandbox: fileURLToPath(new URL('./sandbox.html', import.meta.url)),
      },
      output: {
        /**
         * Name the two vendor chunks that would otherwise inherit a misleading
         * filename.
         *
         * Before this, Rolldown named the React + ReactDOM + Vue chunk after
         * the *first* shared module it saw and emitted
         * `runtime-dom.esm-bundler-<hash>.js`. The Playground therefore shipped
         * two files called "runtime-dom": the real Zeus runtime (84 KB) and a
         * 252 KB React/Vue bundle. Every size report and every reader of the
         * network panel had to rediscover which was which, and the WebC studio
         * preview — the only consumer of React and Vue — paid for them on the
         * sandbox path, not the main one.
         *
         * Naming them explicitly makes the network panel, the build output and
         * the size audit agree on what each file is. It changes no bytes and no
         * loading order.
         */
        manualChunks(id: string) {
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) {
            return 'vendor-react'
          }
          if (id.includes('/@vue/') || id.includes('/vue/dist/')) {
            return 'vendor-vue'
          }
          return undefined
        },
      },
    },
  },
})
