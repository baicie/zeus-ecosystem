# Published-consumer fixtures

Real consumer projects that install **only published packages** and exercise
them in a browser.

They exist because "the symlink resolves" is not evidence. A published tarball
can have missing files, wrong `exports`, broken `.d.ts`, or a runtime that
needs a peer the consumer does not have — none of which a local build would
reveal.

## The rule

Every Zeus dependency is an exact published version, installed from
`registry.npmjs.org`:

| scope | version line |
| --- | --- |
| `@zeus-js/*` | `0.2.0-rc.5` |
| `@zeus-web/*` | `0.1.0-beta.35` |
| `@zeus-js/vite-plugin` | `0.0.5` — its own line, not the Core version |

Forbidden, and checked by `pnpm check:published-fixtures`:

- `workspace:`, `file:`, `link:` specifiers;
- a `paths` entry in `tsconfig.json` (it must be `{}`);
- a Vite `resolve.alias` pointing at Zeus source;
- any range instead of an exact version;
- `skipLibCheck: true` — the published `.d.ts` files are part of what is
  being verified, so they must not be skipped.

The install pins the registry in `.npmrc` so a developer's mirror cannot answer
for it. That is not theoretical: `registry.npmmirror.com` did not have
`@zeus-js/output-wc@0.2.0-rc.5` while the public registry did, and the first
install failed with `ERR_PNPM_NO_MATCHING_VERSION` because of it.

## Fixtures

| fixture | what it proves |
| --- | --- |
| `native/` | signals, effects, memo, cleanup, conditional rendering, mount/unmount/remount, and a component defined through the published `defineElement` |
| `web-components/` | `zw-button`, `zw-input`, `zw-dialog`, `zw-form-field`, `zw-data-grid` mounted and driven: clicks, typing, keyboard, dialog open/close/reopen, grid rows set and cleared |
| `react/` | `@zeus-web/react` wrappers mounted with `createRoot` under `StrictMode`, props updated, press event, unmount |
| `vue/` | `@zeus-web/vue` wrappers mounted with `createApp`, reactive props, `press` emit, `update:value`, unmount |
| `ai/` | `@zeus-web/ai-core`'s own `createMockHost` and `createS1ChatScenario` driven through `createAiSession`: streamed events, subscription, disposal. No network, no paid model |

## Why the fixtures use the packages' own shapes

Several props are not what a first guess would write, and the typecheck caught
each one:

- `defineElement(tagName, options, setup)` — `setup` is the **third** argument,
  not a field of `options`.
- React `Button` has no `id` and no `onClick`; its event is `onPress` with a
  `CustomEvent` detail.
- React `Input` has no `onInput`; it is `onValueChange`.
- Vue `Button` emits `press`, and `Input` emits `value-change` plus
  `update:value`.
- `ai-core`'s `SnapshotScope` is `{ kind, id }`, its `subscribe` is
  `(selector, listener)`, and a domain event carries `entity.id`, not
  `entityId`.

Writing the familiar shape and letting `tsc` reject it is the point: the
fixture tests the wrapper's contract, not React's or Vue's.

## Running

```bash
pnpm check:published-fixtures        # no network, no install
pnpm --filter @zeus-ecosystem/fixture-native build
pnpm test:e2e:published              # needs Playwright browsers
```

## Browser matrix

`playwright.config.ts` defines one project per fixture per browser, so
Chromium, Firefox and WebKit each run against each fixture. Traces, video and
screenshots are retained on failure, and browser console errors are asserted
to be empty — a warning inside a published package has to be visible, not
swallowed.

The browser job runs in CI. Locally it needs `npx playwright install`, which
downloads three engines.
