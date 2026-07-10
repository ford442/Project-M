#!/usr/bin/env node
// ================================================
// audit_presets.mjs
//
// GPU-free *static reliability audit* for Milkdrop (.milk) presets.
//
// This complements scripts/test_presets.sh / kimi_validate_preset.sh, which build the
// C++ PresetCompat harness and check that a preset *parses* and that its warp/comp
// shaders *transpile* HLSL -> GLSL. That harness needs CMake/vcpkg and cannot catch
// runtime hazards (division by zero, NaN sources) or reason about per-frame/per-pixel
// cost. This script needs only Node, so it runs anywhere (CI, WASM box, laptop) and
// focuses on the things the transpile test can't see:
//
//   * Structural integrity     - preset section header, MILKDROP_PRESET_VERSION.
//   * Reliability hazards       - literal division by zero, unbalanced () {} []
//                                 in equations and in warp/comp shader bodies,
//                                 literal NaN sources (sqrt/log of a negative/zero).
//   * Performance tiering       - per-pixel / per-frame equation counts, shader size,
//                                 tex2D sample count -> light | medium | heavy tier.
//   * Metadata                  - description (leading // comments), author hint,
//                                 audio-reactivity signal, warp/comp PSVERSION.
//
// Findings are graded: `error` (should block), `warn` (should review), `info`.
// Only `error` findings make the process exit non-zero, so the auditor is safe to
// wire into CI as a gate for the curated corpora while staying advisory for the
// large community bulk corpus.
//
// Usage:
//   node scripts/audit_presets.mjs [dir ...] [--json <path>] [--md <path>] [--quiet]
//                                  [--fail-on <error|warn|none>]
//
// Defaults to auditing custom_milk_fixed/ and presets/tests/ (the curated corpora).
// Pass weeks_presets/ explicitly to include the large community corpus.
//
// Examples:
//   node scripts/audit_presets.mjs
//   node scripts/audit_presets.mjs custom_milk_fixed weeks_presets presets/tests \
//        --json docs/preset_audit_report.json --md docs/PRESET_AUDIT.md
// ================================================

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- argument parsing -------------------------------------------------------
function parseArgs(argv) {
  const opts = { dirs: [], json: null, md: null, quiet: false, failOn: 'error' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--md') opts.md = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else opts.dirs.push(a);
  }
  if (opts.dirs.length === 0) opts.dirs = ['custom_milk_fixed', 'weeks_presets'];
  return opts;
}

function listMilk(dir) {
  const abs = resolve(PROJECT_ROOT, dir);
  let entries;
  try { entries = readdirSync(abs); }
  catch { console.error(`warning: cannot read directory '${dir}', skipping`); return []; }
  return entries
    .filter((f) => f.toLowerCase().endsWith('.milk'))
    .map((f) => join(abs, f))
    .filter((f) => { try { return statSync(f).isFile(); } catch { return false; } })
    .sort();
}

// ---- parsing helpers --------------------------------------------------------
// Strip a trailing `// ...` line comment.
function stripLineComment(s) {
  const idx = s.indexOf('//');
  return idx >= 0 ? s.slice(0, idx) : s;
}

// Remove /* ... */ block comments (may span lines) then // line comments. Block
// comments are common in community shader bodies and frequently contain stray
// brackets/emoticons (e.g. `Danke ;)`), so they must be stripped before balancing.
function stripComments(code) {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.split('\n').map(stripLineComment).join('\n');
}

function delimiterBalance(code) {
  // Returns net imbalance for () {} [] ignoring comments. 0 == balanced.
  const counts = { '(': 0, ')': 0, '{': 0, '}': 0, '[': 0, ']': 0 };
  for (const ch of stripComments(code)) if (ch in counts) counts[ch]++;
  return {
    paren: counts['('] - counts[')'],
    brace: counts['{'] - counts['}'],
    bracket: counts['['] - counts[']'],
  };
}

const AUDIO_VARS = /\b(bass|mid|treb|bass_att|mid_att|treb_att|vol|vol_att)\b/;
// Literal division by zero: `/0` not followed by a digit or dot (so `/0.5`, `/05` ok).
const DIV_ZERO = /\/\s*0(?![.0-9])/;
// Literal NaN sources: sqrt()/log() of a negative or (for log) zero literal.
const SQRT_NEG = /\bsqrt\s*\(\s*-\s*[0-9.]/;
const LOG_NONPOS = /\blog\s*\(\s*(-\s*[0-9.]|0\s*\))/;

// Milkdrop presets store multi-line constructs in two ways that both concatenate:
//   * Equations: per_frame_1..N (and per_frame_init_*, per_pixel_*) are joined in
//     index order into one code blob — a single statement may span several lines
//     (e.g. a `sqr( ... )` call broken across per_frame_190..192).
//   * Shaders: the fork's custom presets use a backtick-delimited *block*
//     (`warp_1=` + raw lines + closing backtick), while classic community presets
//     use one `warp_N=` key per physical shader line, each prefixed with a backtick.
// In every case correctness lives in the *concatenation*, so we group first and only
// then check delimiter balance / hazards — checking a single physical line is
// meaningless and produces avalanches of false positives.
function parsePreset(text) {
  const lines = text.split(/\r?\n/);
  const model = {
    header: false,
    version: null,
    psWarp: null,
    psComp: null,
    leadingComments: [],
    eqGroups: { per_frame_init: [], per_frame: [], per_pixel: [] }, // { index, value, line }
    shaderPieces: { warp: [], comp: [] },                            // { index, value, line }
    hasWarp: false,
    hasComp: false,
  };

  let inBlock = null; // { target, startLine } — fork backtick-block mode
  let seenNonComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (inBlock) {
      if (raw.includes('`')) {
        model.shaderPieces[inBlock.target].push({ index: inBlock.nextIndex++, value: raw.slice(0, raw.indexOf('`')), line: lineNo });
        inBlock = null;
      } else {
        model.shaderPieces[inBlock.target].push({ index: inBlock.nextIndex++, value: raw, line: lineNo });
      }
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed === '') continue;

    if (!seenNonComment && trimmed.startsWith('//')) {
      model.leadingComments.push(trimmed.replace(/^\/+\s?/, ''));
      continue;
    }

    if (/^\[preset\d+\]/i.test(trimmed)) { model.header = true; seenNonComment = true; continue; }

    const eq = trimmed.indexOf('=');
    if (eq < 0) { seenNonComment = true; continue; }
    seenNonComment = true;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);

    if (/^MILKDROP_PRESET_VERSION$/i.test(key)) { model.version = value.trim(); continue; }
    if (/^PSVERSION_WARP$/i.test(key)) { model.psWarp = value.trim(); continue; }
    if (/^PSVERSION_COMP$/i.test(key)) { model.psComp = value.trim(); continue; }

    const shaderMatch = key.match(/^(warp|comp)_(\d+)$/i);
    if (shaderMatch) {
      const target = shaderMatch[1].toLowerCase();
      if (target === 'warp') model.hasWarp = true; else model.hasComp = true;
      const idx = Number(shaderMatch[2]);
      const startsBacktick = value.trimStart().startsWith('`');
      const afterTick = startsBacktick ? value.trimStart().slice(1) : value;
      // Fork block mode: opener is a lone backtick (or backtick + text) and the *next*
      // physical line is raw shader, not another warp_/comp_ key. Detect by peeking.
      const next = (lines[i + 1] || '').trim();
      const nextIsKey = /^(warp|comp)_\d+\s*=/i.test(next) || next === '';
      if (startsBacktick && !afterTick.includes('`') && !nextIsKey) {
        if (afterTick) model.shaderPieces[target].push({ index: idx * 1000, value: afterTick, line: lineNo });
        inBlock = { target, startLine: lineNo, nextIndex: idx * 1000 + 1 };
      } else {
        // Classic per-line shader (strip a single trailing backtick too, if present).
        let piece = afterTick;
        if (piece.endsWith('`')) piece = piece.slice(0, -1);
        model.shaderPieces[target].push({ index: idx, value: piece, line: lineNo });
      }
      continue;
    }

    const eqMatch = key.match(/^(per_frame_init|per_frame|per_pixel)_(\d+)$/i);
    if (eqMatch) {
      model.eqGroups[eqMatch[1].toLowerCase()].push({ index: Number(eqMatch[2]), value, line: lineNo });
    }
  }

  if (inBlock) model.unterminatedBlock = inBlock;
  return model;
}

// ---- auditing ---------------------------------------------------------------
function auditPreset(absPath) {
  return auditText(readFileSync(absPath, 'utf8'), relative(PROJECT_ROOT, absPath));
}

function auditText(text, rel) {
  const model = parsePreset(text);
  const findings = [];
  const add = (severity, code, message, line) => findings.push({ severity, code, message, line });

  // -- structural --
  if (!model.header) add('error', 'no-preset-header', 'missing [presetNN] section header');
  if (!model.version) add('error', 'no-version', 'missing MILKDROP_PRESET_VERSION');
  if (!model.hasWarp && !model.hasComp) add('warn', 'no-shader', 'no warp_ or comp_ shader block found');
  if (model.unterminatedBlock) add('error', 'unterminated-shader', `${model.unterminatedBlock.target} shader block is not closed with a backtick`, model.unterminatedBlock.startLine);

  // Per-line hazard scan (safe on individual lines regardless of continuation).
  const scanLineHazards = (pieces, label) => {
    for (const p of pieces) {
      const code = stripLineComment(p.value);
      if (DIV_ZERO.test(code)) add('error', 'div-by-zero', `literal division by zero in ${label}`, p.line);
      if (SQRT_NEG.test(code)) add('warn', 'nan-source', `sqrt() of a negative literal in ${label}`, p.line);
      if (LOG_NONPOS.test(code)) add('warn', 'nan-source', `log() of a non-positive literal in ${label}`, p.line);
    }
  };
  // Balance must be evaluated over the whole concatenated group, never per line.
  // Join raw first so multi-line /* ... */ block comments are stripped correctly.
  const groupBalance = (pieces) => delimiterBalance(pieces.map((p) => p.value).join('\n'));

  // -- equations --
  const g = model.eqGroups;
  const perFrameInit = g.per_frame_init.length, perFrame = g.per_frame.length, perPixel = g.per_pixel.length;
  const allEqText = [...g.per_frame_init, ...g.per_frame, ...g.per_pixel].map((e) => e.value).join(' ');
  const reactive = AUDIO_VARS.test(allEqText);
  for (const [kind, pieces] of Object.entries(g)) {
    if (pieces.length === 0) continue;
    scanLineHazards(pieces, kind);
    const bal = groupBalance(pieces);
    if (bal.paren !== 0) add('error', 'unbalanced-parens', `unbalanced parentheses across ${kind}_* block (net ${bal.paren > 0 ? '+' : ''}${bal.paren})`, pieces[0].line);
  }

  // -- shader bodies --
  let shaderLines = 0, tex2d = 0;
  for (const [target, pieces] of Object.entries(model.shaderPieces)) {
    if (pieces.length === 0) continue;
    shaderLines += pieces.length;
    const joined = pieces.map((p) => p.value).join('\n');
    tex2d += (joined.match(/\btex2D\b/g) || []).length;
    scanLineHazards(pieces, `${target} shader`);
    const bal = groupBalance(pieces);
    if (bal.paren !== 0) add('error', 'unbalanced-parens', `unbalanced parentheses across ${target}_* shader (net ${bal.paren > 0 ? '+' : ''}${bal.paren})`, pieces[0].line);
    if (bal.brace !== 0) add('error', 'unbalanced-braces', `unbalanced braces across ${target}_* shader (net ${bal.brace > 0 ? '+' : ''}${bal.brace})`, pieces[0].line);
  }

  // -- performance tier heuristic --
  // per-pixel eqs run per mesh vertex every frame; shader body + tex2D run per fragment.
  const cost = perPixel * 3 + tex2d * 2 + Math.ceil(shaderLines / 10) + Math.ceil(perFrame / 5);
  const tier = cost >= 30 ? 'heavy' : cost >= 12 ? 'medium' : 'light';

  const warpShaderLines = (model.shaderPieces.warp || []).length;
  const compShaderLines = (model.shaderPieces.comp || []).length;
  if (perPixel >= 2 && warpShaderLines === 0 && tier !== 'light') {
    add('warn', 'per-pixel-to-gpu',
      'heavy per_pixel equations without a custom warp shader_body — move zoom/warp math into warp_*/shader_body for GPU per-fragment evaluation',
      g.per_pixel[0]?.line || 1);
  }
  if (perPixel >= 4 && tex2d < 2 && compShaderLines <= 1) {
    add('info', 'composite-shader-opportunity',
      'consider composite shader_body for per-pixel color/feedback effects instead of CPU per_pixel equations',
      g.per_pixel[0]?.line || 1);
  }

  // -- metadata --
  const author = /grok/i.test(rel) ? 'grok'
    : /kimi/i.test(rel) ? 'kimi'
    : /gemini/i.test(rel) ? 'gemini'
    : /copilot|gpt/i.test(rel) ? 'copilot-gpt'
    : /granite/i.test(rel) ? 'granite'
    : null;

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});

  return {
    path: rel,
    name: basename(rel),
    ok: (counts.error || 0) === 0,
    version: model.version,
    psWarp: model.psWarp,
    psComp: model.psComp,
    description: model.leadingComments.slice(0, 4).join(' ').slice(0, 240) || null,
    author,
    reactive,
    tier,
    metrics: { perFrameInit, perFrame, perPixel, shaderLines, tex2d, cost },
    findings,
    counts,
  };
}

// ---- self-test --------------------------------------------------------------
// Guards the parser/checks against regressions. The whole tool's value depends on
// grouping continued equations and per-line shaders correctly before balancing, so
// these cases lock in the exact bugs found while building it.
function selfTest() {
  let failed = 0;
  const codesOf = (text) => auditText(text, 'selftest.milk').findings.map((f) => f.code);
  const has = (text, code) => codesOf(text).includes(code);
  const check = (name, cond) => { if (!cond) { failed++; console.error(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };

  const HDR = 'MILKDROP_PRESET_VERSION=200\n[preset00]\n';
  const SHADER = 'warp_1=`\nret = tex2D(sampler_main, uv).xyz;\n`\n';

  check('clean preset has no findings',
    codesOf(HDR + SHADER + 'per_frame_1=q1=bass;\n').length === 0);
  check('missing version -> error', has('[preset00]\n' + SHADER, 'no-version'));
  check('missing header -> error', has('MILKDROP_PRESET_VERSION=200\n' + SHADER, 'no-preset-header'));
  check('no shader -> warn', has(HDR + 'per_frame_1=x=1;\n', 'no-shader'));
  // Continued equation across per_frame_* lines is balanced overall (must NOT flag).
  check('continued equation is balanced',
    !has(HDR + SHADER + 'per_frame_1=x=sqr( a +\nper_frame_2=b );\n', 'unbalanced-parens'));
  // Genuinely unbalanced equation group -> flag.
  check('unbalanced equation -> error',
    has(HDR + SHADER + 'per_frame_1=x=(a+b;\n', 'unbalanced-parens'));
  // Classic per-line shader with a block comment containing a stray ) must NOT flag.
  check('block comment stray paren ignored',
    !has(HDR + 'comp_1=`ret = uv.xyy; /* Danke ;) */\ncomp_2=`ret.x = 0.0;\n', 'unbalanced-parens'));
  // Unbalanced classic per-line shader -> flag.
  check('unbalanced classic shader -> error',
    has(HDR + 'comp_1=`ret = float3( uv.x,\ncomp_2=`uv.y, 0.0;\n', 'unbalanced-parens'));
  check('literal div-by-zero -> error',
    has(HDR + SHADER + 'per_frame_1=x=1/0;\n', 'div-by-zero'));
  check('div by 0.5 is fine',
    !has(HDR + SHADER + 'per_frame_1=x=1/0.5;\n', 'div-by-zero'));
  check('unterminated fork block -> error',
    has(HDR + 'warp_1=`\nret = uv.xyy;\n', 'unterminated-shader'));

  console.log(failed === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- reporting --------------------------------------------------------------
const SEV_ORDER = { error: 0, warn: 1, info: 2 };

function main() {
  if (process.argv.includes('--selftest')) return selfTest();
  const opts = parseArgs(process.argv.slice(2));
  const corpora = [];
  let totals = { presets: 0, ok: 0, error: 0, warn: 0, info: 0 };

  for (const dir of opts.dirs) {
    const files = listMilk(dir);
    const results = files.map(auditPreset);
    const summary = { total: results.length, ok: 0, error: 0, warn: 0, info: 0, tiers: { light: 0, medium: 0, heavy: 0 }, reactive: 0 };
    for (const r of results) {
      if (r.ok) summary.ok++;
      summary.error += r.counts.error || 0;
      summary.warn += r.counts.warn || 0;
      summary.info += r.counts.info || 0;
      summary.tiers[r.tier]++;
      if (r.reactive) summary.reactive++;
    }
    corpora.push({ dir, summary, results });
    totals.presets += summary.total;
    totals.ok += summary.ok;
    totals.error += summary.error;
    totals.warn += summary.warn;
    totals.info += summary.info;
  }

  const report = { generatedAt: new Date().toISOString(), root: '.', totals, corpora };

  if (!opts.quiet) {
    for (const c of corpora) {
      console.log(`\n${c.dir}  —  ${c.summary.ok}/${c.summary.total} clean, ` +
        `${c.summary.error} errors, ${c.summary.warn} warnings ` +
        `(tiers: ${c.summary.tiers.light}L/${c.summary.tiers.medium}M/${c.summary.tiers.heavy}H, ${c.summary.reactive} audio-reactive)`);
      for (const r of c.results) {
        if ((r.counts.error || 0) === 0 && (r.counts.warn || 0) === 0) continue;
        console.log(`  ${r.ok ? 'WARN' : 'FAIL'}  ${r.name}`);
        for (const f of [...r.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])) {
          console.log(`        [${f.severity}] ${f.code}: ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
        }
      }
    }
    console.log(`\nTOTAL: ${totals.ok}/${totals.presets} clean, ${totals.error} errors, ${totals.warn} warnings`);
  }

  if (opts.json) {
    const p = resolve(PROJECT_ROOT, opts.json);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(report, null, 2) + '\n');
    if (!opts.quiet) console.log(`\nwrote JSON report -> ${relative(PROJECT_ROOT, p)}`);
  }
  if (opts.md) {
    const p = resolve(PROJECT_ROOT, opts.md);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, renderMarkdown(report));
    if (!opts.quiet) console.log(`wrote Markdown report -> ${relative(PROJECT_ROOT, p)}`);
  }

  const gate = opts.failOn;
  if (gate === 'none') process.exit(0);
  if (gate === 'warn') process.exit(totals.error + totals.warn > 0 ? 1 : 0);
  process.exit(totals.error > 0 ? 1 : 0);
}

function renderMarkdown(report) {
  const L = [];
  L.push('# Preset Static Audit');
  L.push('');
  L.push('> Generated by `scripts/audit_presets.mjs` — a GPU-free static reliability audit.');
  L.push('> Regenerate with `node scripts/audit_presets.mjs custom_milk_fixed weeks_presets --json docs/preset_audit_report.json --md docs/PRESET_AUDIT.md`.');
  L.push('');
  L.push(`Last run: \`${report.generatedAt}\``);
  L.push('');
  L.push(`**Totals:** ${report.totals.ok}/${report.totals.presets} clean · ` +
    `${report.totals.error} errors · ${report.totals.warn} warnings`);
  L.push('');
  L.push('## Corpora');
  L.push('');
  L.push('| Corpus | Clean | Errors | Warnings | Light / Medium / Heavy | Audio-reactive |');
  L.push('|--------|-------|--------|----------|------------------------|----------------|');
  for (const c of report.corpora) {
    const s = c.summary;
    L.push(`| \`${c.dir}\` | ${s.ok}/${s.total} | ${s.error} | ${s.warn} | ${s.tiers.light} / ${s.tiers.medium} / ${s.tiers.heavy} | ${s.reactive} |`);
  }
  L.push('');
  for (const c of report.corpora) {
    const flagged = c.results.filter((r) => (r.counts.error || 0) + (r.counts.warn || 0) > 0);
    if (flagged.length === 0) continue;
    L.push(`## Findings — \`${c.dir}\``);
    L.push('');
    for (const r of flagged) {
      L.push(`### ${r.ok ? '⚠️' : '❌'} \`${r.name}\`  _(${r.tier})_`);
      for (const f of [...r.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])) {
        L.push(`- **${f.severity}** \`${f.code}\`: ${f.message}${f.line ? ` (line ${f.line})` : ''}`);
      }
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

main();
