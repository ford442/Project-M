# Grok Agent Workspace

This directory contains files and templates to help collaborate with Grok (and other AIs like kimi-cli) on the Project-M codebase.

## Purpose
- Keep structured plans, diffs, and checklists in the repo
- Make it easy to hand tasks to AI coding assistants
- Maintain consistency across large changes (like the dual-pipeline transition system)

## Recommended Workflow
1. Grok creates/updates a task file or prompt
2. You (or kimi-cli) apply the changes
3. Grok reviews or prepares the next step

## Files in this directory
- `plan_template.md` — Template for new feature plans
- `diff_template.md` — Template for clean unified diffs
- `code_review_checklist.md` — Checklist for reviewing AI-generated code
- `kimi_prompt_short.md` — Short copy-paste prompts for quick tasks

## Agent onboarding docs

`claude.md` (repo root) now has a "Which doc should I read first?" table pointing to
`AGENTS.md`, `html/README.md`, and `docs/kimi_preset_authoring_plan.md` depending on the
task. Start there if you're unsure which doc applies.

## Kimi preset authoring pipeline

For batch `.milk` preset creation/upgrades with kimi-cli, follow
[`docs/kimi_preset_authoring_plan.md`](../docs/kimi_preset_authoring_plan.md) — the
canonical Kimi runbook. It documents `scripts/kimi_validate_preset.sh` (parse/transpile
validation, exits non-zero on failure) and `scripts/kimi_upgrade_preset.sh` (generates
an upgrade prompt with the pitfall checklist baked in), plus example create/upgrade/fix
invocations.

---

**Last updated:** 2026-06-12 (by Claude)