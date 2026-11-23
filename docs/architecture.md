# Repository boundary

`zeus` is the framework producer. `zeus-ui` is the UI component producer, consuming published Core packages. `zeus-ecosystem` is the external application consumer of both published package families.

```text
zeus (@zeus-js/*) ──> zeus-ui (@zeus-web/*)
         └──────────────────┘
                    ↓
           zeus-ecosystem
```

Arrows indicate published package consumption (producer -> consumer).

- Framework-only examples stay in `zeus`.
- Component gallery/docs and component-level tests stay in `zeus-ui`.
- Full applications, Router/Query integration demos, application E2E and application deployment move here once approved.
- Cross-repository release and pairing checks remain **explicit contracts**, not workspace source dependencies.

The original full audit and migration plan are maintained in `baicie/zeus/docs/audit/phase0..phase3`.
