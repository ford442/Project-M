#!/usr/bin/env bash
# ================================================
# branch_protection.sh
#
# Prints (default) or applies (--apply) branch protection for `main` on ford442/Project-M: the build +
# gate jobs must be green before a commit can land on it. It does not require reviews (one maintainer),
# does not enforce on admins, and forbids force-pushes and deletion of `main`.
#
# The required checks are read from the most recent COMPLETED run of each workflow below on `main`,
# so the names are exactly the check-run names GitHub will compare (matrix legs included). A job that
# did not succeed in that run is not required (and is listed), so protection cannot be turned on in a
# way that locks every merge out. Run it when main is green:
#
#   scripts/branch_protection.sh            # dry run: prints the payload
#   scripts/branch_protection.sh --apply    # PUT it (needs repo admin on the gh token)
#
# Not required, on purpose: nightly / scheduled workflows, graphics_perf_bench (manual), preset_audit,
# graphics_harness_tests and hosting_headers (path-filtered: a skipped required check waits forever;
# see AGENTS.md "CI & Deployment"), and publish_web_package (tag-triggered).
#
# Requires: gh (authenticated), jq.
# ================================================

set -euo pipefail

REPO="${REPO:-ford442/Project-M}"
BRANCH="${BRANCH:-main}"
WORKFLOWS=(
    build_linux.yml
    build_windows.yml
    build_osx.yml
    build_emscripten.yml
    build_android.yml
    cpp_format_gate.yml
    host_layer_gate.yml
    web_host_tests.yml
    web_lint_gate.yml
)
apply=0
[[ "${1:-}" == "--apply" ]] && apply=1

contexts=()
for wf in "${WORKFLOWS[@]}"; do
    run_id="$(gh api "repos/${REPO}/actions/workflows/${wf}/runs?branch=${BRANCH}&event=push&status=completed&per_page=1" --jq '.workflow_runs[0].id // empty')"
    if [[ -z "${run_id}" ]]; then
        echo "branch_protection: no completed ${BRANCH} push run of ${wf}; not requiring it" >&2
        continue
    fi
    while IFS=$'\t' read -r name conclusion; do
        if [[ "${conclusion}" == "success" ]]; then
            contexts+=("${name}")
        else
            echo "branch_protection: ${wf}: '${name}' was ${conclusion} in run ${run_id}; not requiring it" >&2
        fi
    done < <(gh api --paginate "repos/${REPO}/actions/runs/${run_id}/jobs" --jq '.jobs[] | [.name, .conclusion] | @tsv')
done

if [[ ${#contexts[@]} -eq 0 ]]; then
    echo "branch_protection: no successful jobs found; refusing to build an empty required-check list" >&2
    exit 1
fi

payload="$(printf '%s\n' "${contexts[@]}" | sort -u | jq -R . | jq -s '{
    required_status_checks: { strict: false, contexts: . },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false
}')"

echo "${payload}"
if [[ ${apply} -eq 1 ]]; then
    echo "${payload}" | gh api --method PUT "repos/${REPO}/branches/${BRANCH}/protection" --input - >/dev/null
    echo "branch_protection: applied to ${REPO}@${BRANCH}" >&2
else
    echo "branch_protection: dry run; pass --apply to set it" >&2
fi
