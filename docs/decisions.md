# Decisions / gates

- Repository name: `zeus-ecosystem`.
- Recommended visibility: public, matching existing public `baicie/zeus` and `baicie/zeus-ui` repositories. Do not publish credentials, environment files or production secrets.
- Main branch: `main`.
- Published package versions: to be pinned per application, after compatibility is validated.
- Core `0.2.0-rc.5` is verified in the prior audit; the next compatible UI release is pending. UI version need not equal Core version, unless maintainers choose a coordinated release policy.
- Phase 3a/3b are independent of package publication; Phase 3c full integration must not be marked passed without a compatible Core/UI pair.
- `zeus-host` runner access and GitHub Environments/secrets require separate administrator review.
- No deployment secrets or npm publishing token are needed in the bootstrap.
- Admin must not be the first production application migration.
