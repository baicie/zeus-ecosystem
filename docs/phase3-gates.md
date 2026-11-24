# Phase 3 completion gates

| Gate | Requirement | State | Evidence |
| --- | --- | --- | --- |
| G3a | Repository, main, pinned read-only CI, working test suite | PASS | `ci.yml` |
| G3b | Dependency policy, evidence matrix, app catalog, permissions review | PASS | this repository |
| G3c-core | Published Core registry install and signal lifecycle | PASS | `core-smoke.yml`, Node 22/24 |
| G3c-pair-install | Published Core + UI strict-peer install, npm/pnpm, lockfiles, realpath | PASS | `published-pair-preflight.yml` |
| G3c-pair-browser | The pair works in a real browser, three engines | PASS | `published-consumer.yml`: 90 checks, 5 fixtures x 3 engines |

Phase 3c is complete. The browser half is what closed it: the install gates
proved the tree resolves, and the fixture matrix proved the components run.

## What G3c-pair-browser covers

Five fixtures, each installing only published packages:

| Fixture | Proves |
| --- | --- |
| `native` | signals, effects, memo, cleanup, conditional rendering, mount/unmount |
| `web-components` | button, input, dialog, form field, data grid — mounted and driven |
| `react` | `createRoot` under StrictMode, props, press event, unmount |
| `vue` | `createApp`, reactive props, emits, unmount |
| `ai` | the AI packages' own mock host and S1 scenario |

The `web-components` fixture is the one that found a real defect: importing
`@zeus-web/button` exports the class without registering it, and only
`/wc/auto` calls `customElements.define`. Every `zw-*` tag was an unupgraded
`HTMLElement` — it rendered and did nothing, and every typecheck passed.

## Phase 4

Application migration is tracked in [migration-checklist.md](migration-checklist.md)
rather than here, because it has per-app stages that a single gate row would
hide.
