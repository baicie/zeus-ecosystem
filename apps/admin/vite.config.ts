import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'

import zeus from '@zeus-js/vite-plugin'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

import { createBuildInfo } from '../../scripts/release/build-info.mjs'

/**
 * Two builds share this config:
 *
 * - production (`pnpm build`): the app talks to `examples/admin/server` over
 *   `/api/`. Unchanged.
 * - demo (`ZEUS_ADMIN_DEMO=1 pnpm build`): the same source, built for GitHub
 *   Pages. `base` moves under the demo path, `VITE_ZEUS_ADMIN_DEMO` switches
 *   the data layer to the build-time snapshot (`src/admin-api.ts`), and a
 *   `404.html` copy of `index.html` lets a deep link survive a refresh — Pages
 *   has no rewrite rule, so without it `/users/grace` would 404 on reload.
 *
 * Nothing about the server build changes; the flag only alters this one
 * output directory.
 */
const demo = process.env.ZEUS_ADMIN_DEMO === '1'
/** The demo lives at `<pages>/admin/` inside the shared `zeus-demos` site. */
const demoBase = process.env.ZEUS_ADMIN_DEMO_BASE ?? '/zeus-demos/admin/'

/**
 * Writes the build identity next to the bundle.
 *
 * `infra/contracts/products.json` has declared
 * `admin.buildInfoPath = apps/admin/dist/build-info.json` since the table
 * gained that field, but nothing wrote the file: `verify-provenance.mjs`
 * looks for it, finds nothing, and reports `sourceCommit: null` — a null
 * field nobody reads. The two other static products already emit it from
 * their own build, so this is the same plugin, not a new mechanism.
 *
 * The demo build skips it. A GitHub Pages bundle is not a delivery artifact,
 * it has no pairing to name, and marking it synthetic would put a `test-only`
 * record inside a published site.
 */
function buildInfoPlugin(): Plugin {
  return {
    name: 'zeus-build-info',
    apply: 'build',
    generateBundle() {
      if (demo) return

      /*
       * The repository root, not the app directory: the release contract and
       * the lockfile both live there, and `createBuildInfo` resolves them
       * relative to whatever root it is given.
       */
      const root = fileURLToPath(new URL('../..', import.meta.url))

      const info = createBuildInfo({
        root,
        product: 'admin',
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
  plugins: [
    zeus(),
    buildInfoPlugin(),
    demo && {
      name: 'zeus-admin-demo-fallback',
      // `closeBundle` runs after the assets are written, so the copy sees the
      // final `index.html` rather than a partial one.
      closeBundle() {
        const dir = this.environment?.config?.build?.outDir
        if (!dir) return
        void import('node:fs/promises').then(({ copyFile }) =>
          copyFile(`${dir}/index.html`, `${dir}/404.html`).catch(() => {}),
        )
      },
    },
  ],
  base: demo ? demoBase : '/',
  define: demo
    ? { 'import.meta.env.VITE_ZEUS_ADMIN_DEMO': JSON.stringify('true') }
    : {},
  server: {
    proxy: {
      '/api/': {
        target:
          process.env.ZEUS_ADMIN_API_ORIGIN ??
          (process.env.ZEUS_ADMIN_API_PORT
            ? `http://127.0.0.1:${process.env.ZEUS_ADMIN_API_PORT}`
            : 'http://127.0.0.1:8787'),
        changeOrigin: false,
      },
    },
  },
  /*
   * No `resolve.alias`.
   *
   * The only entry pointed `@zeus-js/devtools-consumer` at
   * `packages/tooling/consumer` — another repository's source, and a private
   * package that was never published. That import is gone from `main.tsx`, and
   * every remaining Zeus import resolves to a published tarball.
   */
})
