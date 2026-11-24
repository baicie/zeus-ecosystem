import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

import { createBuildInfo } from '../../scripts/release/build-info.mjs'

/**
 * Two builds share this config:
 *
 * - production: the shell talks to the reference Host over `/ai-host/`.
 * - demo (`ZEUS_AI_DEMO=1`, for GitHub Pages): the same source, served under
 *   `<pages>/ai/`, replaying a recording of the real Host instead of calling
 *   one. `demo-host.ts` holds the adapter; the flag only swaps the host and
 *   moves the asset base.
 */
const demo = process.env.ZEUS_AI_DEMO === '1'
const demoBase = process.env.ZEUS_AI_DEMO_BASE ?? '/zeus-demos/ai/'

/**
 * Writes the build identity next to the bundle.
 *
 * Emitted as a separate asset rather than injected into the JS: the identity
 * has to be readable by a deployment check without executing the app, and a
 * constant baked into a chunk cannot be read that way.
 *
 * `createBuildInfo` fails closed when the upstream identity cannot be
 * verified. `ZEUS_ALLOW_SYNTHETIC_IDENTITY=1` is for local runs, and the
 * resulting record is marked `synthetic` so it cannot pass as release
 * evidence.
 */
function buildInfoPlugin(): Plugin {
  return {
    name: 'zeus-build-info',
    apply: 'build',
    generateBundle() {
      /*
       * The repository root, not the app directory: the release contract and
       * the lockfile both live there, and `createBuildInfo` resolves them
       * relative to whatever root it is given. Passing the app directory made
       * a present contract look missing.
       */
      const root = resolve(fileURLToPath(import.meta.url), '../../..')

      const info = createBuildInfo({
        root,
        product: 'ai-workbench',
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

export default defineConfig({
  plugins: [buildInfoPlugin()],
  base: demo ? demoBase : '/',
  define: {
    __ZEUS_AI_HOST__: JSON.stringify(process.env.ZEUS_AI_HOST_ORIGIN ?? ''),
    __ZEUS_AI_DEMO__: JSON.stringify(demo),
    __ZEUS_AI_DEMO_BASE__: JSON.stringify(demo ? demoBase : '/'),
  },
  /*
   * No `resolve.alias`.
   *
   * This app used to alias every @zeus-web/ai-* package at the sibling
   * zeus-ui source tree (packages/NAME/src/index.ts), which only resolves
   * inside that repository. After the move those paths point at nothing —
   * the build failed with UNLOADABLE_DEPENDENCY for all four packages — and an
   * alias back into another repository is exactly the reverse dependency this
   * migration is meant to remove.
   *
   * Every Zeus import now resolves to a published tarball through node_modules.
   */
  server: {
    host: '127.0.0.1',
    port: 5191,
    proxy: {
      '/ai-host/': {
        target: process.env.ZEUS_AI_HOST_ORIGIN ?? 'http://127.0.0.1:8788',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/ai-host/, ''),
        // Local parity with the production nginx ingress: inject the Host
        // credential server-side instead of exposing it to browser JS.
        headers: process.env.ZEUS_AI_UPSTREAM_TOKEN
          ? {
              Authorization: `Bearer ${process.env.ZEUS_AI_UPSTREAM_TOKEN}`,
            }
          : {},
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4191 },
})
