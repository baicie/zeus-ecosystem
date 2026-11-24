import { defineConfig } from 'vitest/config'

/**
 * The workbench specs build DOM nodes, so they need a document.
 *
 * In zeus-ui these ran under a `unit-jsdom` project declared in the repository
 * vitest config; this app now owns its own, since it is no longer a directory
 * inside that repository.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['__tests__/**/*.spec.ts'],
  },
})
