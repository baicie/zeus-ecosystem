# Reference applications

| App | Source | Destination | Status | Evidence |
| --- | --- | --- | --- | --- |
| AI Workbench | `zeus-ui/examples/ai-workbench` | `apps/ai-workbench` | IMAGE_VALIDATED | 48 container checks across 3 engines; 25.9 MB image, healthy |
| AI Host | `zeus-ui/examples/ai-host` | `apps/ai-host` | IMAGE_VALIDATED | single-file bundle; 27/27 unit tests; healthy |
| Admin | `zeus/examples/admin` | `apps/admin` | DEPLOYMENT_REHEARSED | 26/26 server tests; 80.4 MB image; 8/8 rehearsal steps |
| Playground | `zeus/examples/playground-editor` | `apps/playground` | SOURCE_MIGRATED | builds from published packages; no CI run, image or deployment yet |

Status vocabulary and what each stage requires:
[migration-checklist.md](migration-checklist.md).

The original directories are retained in their repositories. Removing them is
Phase 7 work and needs every app at `PRODUCTION_ACCEPTED` first.

**Playground** — the editor. CodeMirror over a WASM build of the Rust compiler,
a split preview, a sandboxed runtime for user code, project persistence and
share links. It is the only app that runs untrusted code, so its delivery has a
second origin: the preview is served from `:81` with
`Content-Security-Policy: sandbox allow-scripts`, which is what gives the iframe
its opaque origin. Deploying both on one origin loses that silently.

It was previously recorded here as "retain in zeus". That decision was
superseded: the core repository keeps the framework, the compiler and the
Playground Engine, and complete applications live here. Its move needed
`@zeus-js/compiler-wasm` to be published first, because it had been private
specifically so it could ship inside this app's own build.

## What each app is

**AI Workbench** — the conversation shell. Two modes (host-owned and BYOK),
a CSP boundary that an operator opts origins into, and a replay surface for the
published demo.

**AI Host** — the reference service behind the workbench. SSE streaming,
commands with idempotency, approvals, and SQLite persistence. It is a reference
implementation, not an LLM gateway: it never calls a model.

**Admin** — the product shell. Router, query, i18n, user management, forms and
a data grid, over the published component library.
