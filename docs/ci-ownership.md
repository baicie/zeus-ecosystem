# CI ownership across the three repositories

Which repository runs which check, and why. Written down because the same
question has been answered three different ways during the migration, and each
answer added a workflow none of the others knew about.

The rule underneath: a check lives where the thing it tests lives. A framework
regression belongs to `zeus`, a component defect to `zeus-ui`, a product
behaviour to `zeus-ecosystem`.

## `baicie/zeus` — the framework

| Workflow | Answers |
| --- | --- |
| `ci.yml` | Does the framework typecheck, unit-test, build and pass its own browser fixtures? Does the package contract hold? Do the release gates still exist? |
| `compiler-native.yml` | Does the Rust compiler build on every platform, and do the native binaries load? |
| `component-host-rc.yml` | Is a release candidate internally consistent — version, pairing, artifacts? |
| `component-host-bench.yml` | Did a performance change move the component host? |
| `devtools-release.yml` | Publish the independently versioned packages (`vite-plugin`, `devtools-consumer`, `create-zeus`). |
| `release.yml`, `release-canary.yml` | The fixed release group, and its canary channel. |
| `docs.yml` | The documentation site builds. |
| `playground-image.yml`, `playground-pages.yml` | The Playground image and its published demo. |
| `host-deployment-prepare.yml`, `host-deployment-stage2.yml` | Host provisioning. |
| `repair-dist-tags.yml`, `repair-native-latest.yml` | Manual repair entry points. |

Nothing here tests a product. `check:admin` is the last exception and is
documented as such below.

## `baicie/zeus-ui` — the components

| Workflow | Answers |
| --- | --- |
| `ci.yml` | Do the components typecheck, unit-test and build? |
| component browser gates | Does each component behave in three engines — `check-dialog-interaction` covers focus trapping, Escape and ARIA. |

## `baicie/zeus-ecosystem` — the products

| Workflow | Answers |
| --- | --- |
| `published-consumer.yml` | Can a third party install the published pair and use it? |
| `ai-apps.yml` | Do the AI apps typecheck, unit-test, build, and pass their browser gates? Does Admin? Does the host serve its protocol after a restart? |
| `app-images.yml` | Does each image build, start, answer health, stay within budget, and record its evidence? |
| `ci.yml` | Do the repository's own policies hold, and is the deployment plan contract intact? |

## The one exception, and why it is still there

`check:admin` in `zeus` drives `examples/admin` in three engines. It is a
product test in the framework repository, which the rule above says should not
exist.

It stays because it is the only browser coverage of that application, and the
application has not been deleted. Splitting it is the work that precedes the
deletion, not the deletion itself:

- **41 assertions on `gallery-*`** duplicate `zeus-ui`'s
  `check-dialog-interaction`, which covers focus trapping, Escape and ARIA and
  requires every engine. The Core copy adds nothing.
- **26 assertions on product pages** are covered by
  `zeus-ecosystem`'s `check-admin-browser` — sign-in, user list, search, detail
  navigation, session restore, error page — with assertions on real effects
  rather than on rendered markup.
- **The remainder** — the capability matrix, the audit table, the reports page —
  had no coverage anywhere. Three scenarios were added to
  `check-admin-browser` so they do now.

What is left is small enough to extract into a minimal fixture, and that is the
next step. Deleting `check:admin` before the extraction would remove the only
coverage those pages have.

## What does not belong in any of them

- A product assertion in `zeus` or `zeus-ui`.
- A framework regression test in `zeus-ecosystem` — that repository consumes
  published packages and cannot see the framework's internals.
- A workflow that exists to run one script the `ci.yml` of the same repository
  already runs.
