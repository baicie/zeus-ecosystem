# Reference applications

| App | Source | Destination | Status | Prerequisite |
| --- | --- | --- | --- | --- |
| AI Workbench | `zeus-ui/examples/ai-workbench` | `apps/ai-workbench` | NOT MIGRATED | Published compatible UI release + runtime/browser gate |
| AI Host | `zeus-ui/examples/ai-host` | `apps/ai-host` | NOT MIGRATED | Migrate with AI Workbench |
| Admin | `zeus/examples/admin` | `apps/admin` | NOT MIGRATED | Framework assertion ownership, stable production dry-run and rollback |
| Playground Editor | `zeus/examples/playground-editor` | retain in zeus | KEEP | Recorded Phase 1 decision |

Component gallery and headless examples remain within `zeus-ui`. The original directories retained in `zeus` are separate Phase 7 cleanup work and are not removed by this repository.
