# Phase 3 decisions

- The new repository is public, like `baicie/zeus` and `baicie/zeus-ui`. Its main branch exists.
- The ecosystem is an **application-only consumer**. NPM publishing tokens and Core/UI release signing permissions are unnecessary here.
- Core and UI may follow independent SemVer lines; compatibility must be established through published dependency pins, peer constraints and working consumers, not matching package version strings.
- Core `0.2.0-rc.5` is the currently examined published release. UI `0.1.0-beta.35` has not been confirmed published or compatible, so Phase 3c UI remains blocked.
- Automated policy checks and Core-only smoke may proceed without creating/deploying apps or installing production credentials.
- `zeus-host` runner access, Actions Environments, image registries, release approvals and production credentials are explicitly deferred.
- Existing producer repository release protocol issues are addressed in the producer, not copied into this consumer repository.
