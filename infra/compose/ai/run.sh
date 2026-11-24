#!/usr/bin/env sh
# Drives the AI deployment unit for local and CI acceptance.
#
# ## Isolation
#
# Every invocation gets its own compose project name and its own volume, so a
# run cannot collide with another run or with anything the developer already
# has. Cleanup removes only what this run created; there is no `docker system
# prune` anywhere in this repository, because that would reach into the user's
# other projects.
#
# ## Tokens
#
# Generated per run from /dev/urandom and never written to a file that
# outlives the run. The workbench's upstream token and the host's accepted
# token are the same value by construction, so the proxy contract cannot drift.
#
# Usage:
#   infra/compose/ai/run.sh up          start and wait for health
#   infra/compose/ai/run.sh smoke       exercise the running stack
#   infra/compose/ai/run.sh down        stop and remove this run's resources
#   infra/compose/ai/run.sh config      validate the compose file only
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../.." && pwd)
command=${1:-up}

# A stable project name per working tree and user, so two runs on one machine
# do not fight over the same containers.
project="zeus-ai-$(id -u)"

# The workbench port is configurable so a developer can run two stacks at once.
port=${ZEUS_WORKBENCH_PORT:-18080}

compose() {
  ZEUS_APP_COMMIT=${ZEUS_APP_COMMIT:-$(git -C "$root" rev-parse HEAD)} \
  ZEUS_IMAGE_TAG=${ZEUS_IMAGE_TAG:-local} \
  ZEUS_WORKBENCH_PORT=$port \
  ZEUS_AI_TOKENS=${ZEUS_AI_TOKENS:-} \
  ZEUS_AI_UPSTREAM_TOKEN=${ZEUS_AI_UPSTREAM_TOKEN:-} \
  ZEUS_AI_ORIGINS=${ZEUS_AI_ORIGINS:-} \
  ZEUS_AI_MODE=${ZEUS_AI_MODE:-replay} \
  ZEUS_BYOK_CONNECT_SRC=${ZEUS_BYOK_CONNECT_SRC:-} \
    docker compose -p "$project" -f "$here/compose.yml" "$@"
}

# Both tokens are the same value: the workbench sends it and the host accepts
# it, and a mismatch would surface as a 401 rather than as "the stack is up".
generate_tokens() {
  secret=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
  ZEUS_AI_UPSTREAM_TOKEN=$secret
  ZEUS_AI_TOKENS="[{\"token\":\"$secret\",\"tenantId\":\"reference\",\"userId\":\"acceptance\",\"role\":\"editor\"}]"
  export ZEUS_AI_UPSTREAM_TOKEN ZEUS_AI_TOKENS
}

case "$command" in
  config)
    # Validates structure without starting anything.
    ZEUS_APP_COMMIT=deadbeef ZEUS_AI_TOKENS='[]' ZEUS_AI_UPSTREAM_TOKEN=x \
      docker compose -p "$project" -f "$here/compose.yml" config >/dev/null
    echo "compose config is valid"
    ;;

  up)
    generate_tokens
    compose up -d --build --wait
    echo "workbench: http://127.0.0.1:$port"
    ;;

  smoke)
    generate_tokens
    node "$here/smoke.mjs" --base "http://127.0.0.1:$port"
    ;;

  down)
    # `down -v` removes the volume this project created. The project name is
    # per-user and per-directory, so nothing else is affected.
    #
    # Placeholder tokens: compose interpolates every service before acting, and
    # the `:?` guards make a missing value fatal. Tearing down must not require
    # a credential that was only ever needed to start.
    ZEUS_APP_COMMIT=teardown ZEUS_AI_TOKENS='[]' ZEUS_AI_UPSTREAM_TOKEN=teardown \
      docker compose -p "$project" -f "$here/compose.yml" down -v --remove-orphans
    ;;

  *)
    echo "usage: $0 {config|up|smoke|down}" >&2
    exit 2
    ;;
esac
