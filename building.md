Root cause

036 never made it to production. projectm.1ink.us is still on the 035 host + assets. Picking 036 cannot work there yet.

┌───────────────────────────────────┬───────────────────────────────┬─────────────────────────────────────────┐
│ Check                             │ Production (projectm.1ink.us) │ Staging (test.1ink.us/projectm.1ink.us) │
├───────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ PROJECTM_WASM_VERSION             │ 035                           │ 036                                     │
├───────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ Selectable list includes 036      │ No (stops at 035)             │ Yes                                     │
├───────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ pm/projectm-v.036-thread.wasm     │ Soft-404 (HTML)               │ OK                                      │
├───────────────────────────────────┼───────────────────────────────┼─────────────────────────────────────────┤
│ projectm-wasm-default-redirect.js │ Missing (404)                 │ OK                                      │
└───────────────────────────────────┴───────────────────────────────┴─────────────────────────────────────────┘

Why it “loads 035 again”

1. Live projectm-wasm-version.js still says PROJECTM_WASM_VERSION = '035' and does not list 036.
2. ?wasm=036 is rejected by normalizeWasmVersion() and falls back to 035.
3. Even if it did accept 036, the 036 .wasm / .js files are not on prod.
4. Live 1ink.1ink was updated today, but without the default-redirect script and without the 036 host modules — so behavior still tracks the old 035 CDN JS.

This is a prod deploy gap, not a local “can’t select 036” bug. Repo source is already on 036; staging has a full good 036 deploy.

What works right now

Use staging:

https://test.1ink.us/projectm.1ink.us/1ink.1ink  
(or ?wasm=036 — that environment is verified clean for 036)

What fixes production

Needs a full prod upload with DEPLOY_TOKEN (not set in this environment, so I could not push):

# Artifacts are already staged locally from the good test deploy (036 wasm/js + host modules).
export DEPLOY_TOKEN="…"   # from Contabo / docs/DEPLOYMENT.md

python deploy.py --target prod

scripts/verify_deploy_urls.sh https://projectm.1ink.us/ projectm-v.036-thread

That must ship at least:

• projectm-v.036-thread.{wasm,js,1ijs,3ijs} at root and under pm/
• projectm-wasm-version.js with version 036 (and 036 in the selectable list)
• projectm-wasm-default-redirect.js (DEFAULT_WASM_VERSION = '036')
• 1ink.1ink (from projectm_panel2.1ink, with the redirect script tag)

After that, hard-refresh (or clear site data if you still have localStorage['projectm-wasm-version'] = '035'). The redirect script forces ?wasm=036 so a stale localStorage pick does not stick.

───

Bottom line: Production is still serving the 035 host config and 035 binaries. Staging already has 036. Drop in DEPLOY_TOKEN (or run the prod deploy from a machine that has it) and I can run the upload + verify for you.