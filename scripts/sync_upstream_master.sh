#!/usr/bin/env bash
# sync_upstream_master.sh — make origin/master match projectM-visualizer/projectm master.
#
# Does not touch main. master is a read-only mirror of upstream; do not commit on it.
# After the one-time rewrite that pointed origin/master at upstream, later runs
# fast-forward. Pass --force only if the histories have diverged again.
#
# Usage:
#   ./scripts/sync_upstream_master.sh          # fast-forward origin/master
#   ./scripts/sync_upstream_master.sh --force  # hard-reset origin/master to upstream
#
# Environment:
#   UPSTREAM_REPO    default: https://github.com/projectM-visualizer/projectm.git
#   UPSTREAM_BRANCH  default: master
#   MIRROR_BRANCH    default: master
#
# See docs/UPSTREAM_SYNC.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/projectM-visualizer/projectm.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
MIRROR_BRANCH="${MIRROR_BRANCH:-master}"
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

redact() {
    sed -E 's#://[^@/]+@#://#'
}

if [[ "$(git rev-parse --abbrev-ref HEAD)" == "$MIRROR_BRANCH" ]]; then
    echo "Refusing to run while checked out on ${MIRROR_BRANCH}. Switch to main (or any other branch) first." >&2
    exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
    git remote add upstream "$UPSTREAM_REPO"
    git remote set-url --push upstream DISABLE
    echo "Added read-only remote 'upstream' -> ${UPSTREAM_REPO}"
fi

echo "Fetching upstream ${UPSTREAM_BRANCH}…"
git fetch --quiet upstream "$UPSTREAM_BRANCH"
echo "Fetching origin ${MIRROR_BRANCH}…"
git fetch --quiet origin "$MIRROR_BRANCH"

NEW="$(git rev-parse "upstream/${UPSTREAM_BRANCH}")"
OLD="$(git rev-parse "origin/${MIRROR_BRANCH}")"

echo "upstream/${UPSTREAM_BRANCH}: $(git log -1 --format='%h %ci %s' "$NEW")"
echo "origin/${MIRROR_BRANCH}:     $(git log -1 --format='%h %ci %s' "$OLD")"

if [[ "$OLD" == "$NEW" ]]; then
    echo "origin/${MIRROR_BRANCH} already matches upstream. Nothing to do."
    exit 0
fi

if git show-ref --verify --quiet "refs/heads/${MIRROR_BRANCH}"; then
    git branch -f "$MIRROR_BRANCH" "$NEW"
fi

if git merge-base --is-ancestor "$OLD" "$NEW"; then
    echo "Fast-forwarding origin/${MIRROR_BRANCH} to upstream."
    git push origin "$NEW:refs/heads/${MIRROR_BRANCH}" 2>&1 | redact
elif [[ "$FORCE" -eq 1 ]]; then
    echo "Histories diverged; force-updating origin/${MIRROR_BRANCH} to match upstream."
    git push --force-with-lease="refs/heads/${MIRROR_BRANCH}:${OLD}" origin "$NEW:refs/heads/${MIRROR_BRANCH}" 2>&1 | redact
else
    echo "origin/${MIRROR_BRANCH} has diverged from upstream. Re-run with --force to reset it to a mirror, or inspect:" >&2
    echo "  git log --oneline origin/${MIRROR_BRANCH}..upstream/${UPSTREAM_BRANCH}" >&2
    echo "  git log --oneline upstream/${UPSTREAM_BRANCH}..origin/${MIRROR_BRANCH}" >&2
    exit 1
fi

git fetch --quiet origin "$MIRROR_BRANCH"
echo "origin/${MIRROR_BRANCH} is now $(git log -1 --format='%h %s' "origin/${MIRROR_BRANCH}")"
