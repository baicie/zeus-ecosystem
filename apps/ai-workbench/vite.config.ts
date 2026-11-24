import process from 'node:process'

import { defineConfig } from 'vite'

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

export default defineConfig({
  plugins: [],
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
