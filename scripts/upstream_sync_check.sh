#!/usr/bin/env bash
# upstream_sync_check.sh — lightweight upstream drift report for ford442/Project-M
#
# Fetches projectM-visualizer/projectm (no git remote config required) and prints:
#   - merge-base age, commits ahead on upstream / fork
#   - recent upstream commits in watched paths
#   - latest upstream release
#   - open issues/PRs (via gh, if available)
#
# Usage:
#   ./scripts/upstream_sync_check.sh              # human-readable report
#   ./scripts/upstream_sync_check.sh --markdown   # Markdown for issues/PRs
#   ./scripts/upstream_sync_check.sh --check      # exit 1 if upstream ahead > 0
#
# Environment:
#   UPSTREAM_REPO   default: https://github.com/projectM-visualizer/projectm.git
#   UPSTREAM_BRANCH default: master
#   UPSTREAM_REF    default: refs/remotes/upstream-sync/master (local only)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/projectM-visualizer/projectm.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-master}"
UPSTREAM_REF="${UPSTREAM_REF:-refs/remotes/upstream-sync/master}"
MARKDOWN=0
CHECK=0

for arg in "$@"; do
    case "$arg" in
        --markdown) MARKDOWN=1 ;;
        --check) CHECK=1 ;;
        -h|--help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

log() {
    if [[ "$MARKDOWN" -eq 1 ]]; then
        printf '%s\n' "$1"
    else
        printf '%s\n' "$1"
    fi
}

md_h1() { [[ "$MARKDOWN" -eq 1 ]] && log "# $1" || log "== $1 =="; }
md_h2() { [[ "$MARKDOWN" -eq 1 ]] && log "" && log "## $1" || log "" && log "-- $1 --"; }
md_li() { [[ "$MARKDOWN" -eq 1 ]] && log "- $1" || log "  * $1"; }

echo "Fetching upstream ($UPSTREAM_BRANCH)…" >&2
git fetch --quiet "$UPSTREAM_REPO" "$UPSTREAM_BRANCH:$UPSTREAM_REF" 2>&1 || {
    echo "Failed to fetch upstream. Check network and URL: $UPSTREAM_REPO" >&2
    exit 1
}

MERGE_BASE="$(git merge-base HEAD "$UPSTREAM_REF")"
UPSTREAM_AHEAD="$(git rev-list --count "$MERGE_BASE..$UPSTREAM_REF")"
FORK_AHEAD="$(git rev-list --count "$UPSTREAM_REF..HEAD")"
MERGE_BASE_DATE="$(git log -1 --format='%ci' "$MERGE_BASE")"
MERGE_BASE_SUBJ="$(git log -1 --format='%s' "$MERGE_BASE")"

WATCH_PATHS=(
    'src/libprojectM/Audio/'
    'src/libprojectM/MilkdropPreset/'
    'src/libprojectM/Renderer/'
    'vendor/hlslparser/'
    'vendor/projectm-eval/'
    'projectM_emscripten.cpp'
    'CMakeLists.txt'
)

md_h1 "Upstream sync report"
log ""
log "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Fork HEAD: $(git log -1 --format='%h %ci %s')"
log "Upstream: $UPSTREAM_REPO ($UPSTREAM_BRANCH @ $(git log -1 --format='%h %ci' "$UPSTREAM_REF"))"
log ""
md_h2 "Divergence"
md_li "Merge-base: \`$MERGE_BASE\` ($MERGE_BASE_DATE) — $MERGE_BASE_SUBJ"
md_li "Upstream commits since merge-base: **$UPSTREAM_AHEAD**"
md_li "Fork-only commits since merge-base: **$FORK_AHEAD**"

if [[ "$UPSTREAM_AHEAD" -gt 0 ]]; then
    md_h2 "Upstream commits to review"
    while IFS= read -r line; do
        md_li "$line"
    done < <(git log --oneline "$MERGE_BASE..$UPSTREAM_REF")
fi

md_h2 "Upstream commits in watched paths (last 20 on upstream master)"
FOUND=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  md_li "$line"
  FOUND=1
done < <(
  git log --oneline -20 "$UPSTREAM_REF" -- "${WATCH_PATHS[@]}" 2>/dev/null || true
)
[[ "$FOUND" -eq 0 ]] && md_li "(none in last 20 commits — widen window manually if needed)"

md_h2 "Latest upstream release"
if command -v gh >/dev/null 2>&1; then
    RELEASE_LINE="$(gh release list -R projectM-visualizer/projectm --limit 1 2>/dev/null | head -1 || true)"
    if [[ -n "$RELEASE_LINE" ]]; then
        md_li "$RELEASE_LINE"
    else
        md_li "(gh: no releases returned)"
    fi
else
    md_li "(install GitHub CLI \`gh\` for release/issue scan)"
fi

if command -v gh >/dev/null 2>&1; then
    md_h2 "Recent upstream issues (open, preset/render/audio/wasm keywords)"
    ISSUES="$(gh search issues --repo projectM-visualizer/projectm --state open \
        "milkdrop OR shader OR preset OR emscripten OR wasm OR audio OR beat" --limit 8 \
        --json number,title,updatedAt --jq '.[] | "#\(.number) \(.title) (updated \(.updatedAt[0:10]))"' 2>/dev/null || true)"
    if [[ -n "$ISSUES" ]]; then
        while IFS= read -r line; do md_li "$line"; done <<< "$ISSUES"
    else
        md_li "(none or search failed)"
    fi

    md_h2 "Recent upstream PRs (open)"
    PRS="$(gh search prs --repo projectM-visualizer/projectm --state open \
        "milkdrop OR shader OR preset OR emscripten OR audio" --limit 8 \
        --json number,title,updatedAt --jq '.[] | "#\(.number) \(.title) (updated \(.updatedAt[0:10]))"' 2>/dev/null || true)"
    if [[ -n "$PRS" ]]; then
        while IFS= read -r line; do md_li "$line"; done <<< "$PRS"
    else
        md_li "(none or search failed)"
    fi
fi

md_h2 "Suggested next steps"
md_li "Read [\`docs/UPSTREAM_SYNC.md\`](docs/UPSTREAM_SYNC.md) checklist"
md_li "Update backport log in that doc"
md_li "Cherry-pick or manual-port high-value commits; run \`ctest -R PresetCompat\`"
md_li "Skip GLAD/desktop-only API unless needed for native builds"

if [[ "$CHECK" -eq 1 && "$UPSTREAM_AHEAD" -gt 0 ]]; then
    echo "" >&2
    echo "CHECK FAILED: upstream is $UPSTREAM_AHEAD commit(s) ahead of merge-base." >&2
    exit 1
fi

exit 0
