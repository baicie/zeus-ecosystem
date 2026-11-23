# Security

This repository holds public integration examples, not production credentials.

- Never commit authentication tokens, private keys, passphrases, deployment environment files, or customer data.
- Store deployment credentials in GitHub Environments with least-privilege permissions, only after an explicitly approved migration.
- Dependency versions and CI action revisions must be pinned; production deployment requires a separately approved workflow.
- To report a vulnerability privately, use GitHub's private vulnerability reporting feature if enabled, or contact the repository owner through a private channel. Do not publish exploit details in an issue.
