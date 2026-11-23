# Approved application migration checklist (not authorization)

## AI Workbench / AI Host (first)

- Confirm upstream source and known-good commit, including tests, build, Docker context and workflow references.
- Resolve exact registry-published Core and UI versions; install without `workspace:` or `file:` escape hatches.
- Capture npm and pnpm dependency trees, physical realpaths and active bundled runtime instances.
- Keep existing production workflow running until new CI, E2E, image provenance, digest and public build-info checks pass.
- Do not copy live secrets, deploy SSH keys, environment variables or private customer data.
- Pass SSE, upload, cancel, idempotency, auth, CSP and model error-path tests before cutover.
- Keep existing source and a reversible workflow while verifying the new deployment.
- Require explicit approval before any network/production deployment.

## Admin (last)

- Preserve Router/Query/i18n/DevTools framework assertion ownership.
- Split component gallery into the UI ownership domain only where justified.
- Remove vendor patch only after published UI package behavior is proven in Chromium, Firefox and WebKit.
- Back up SQLite, rehearsal-test rollback, compare image digests and online acceptance before decommissioning old workflows.

## Evidence format

Each migration PR must link source commit, destination commit, exact upstream versions, check matrix, failed/skipped tests, immutable image digests (when built), fallback version and rollback plan.
