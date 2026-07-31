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
  const opts = { dirs: [], json: null, md: null, worklist: null, quiet: false, failOn: 'error' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--md') opts.md = argv[++i];
    else if (a === '--worklist') opts.worklist = argv[++i];
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
// HLSL that has landed in an equation block. per_frame_*/per_pixel_* are a scalar
// expression language: they have no types, no swizzles and no `ret` output. When a
// preset's visual program is written in HLSL but stored under per_pixel_*, the
// equation parser rejects it at load and the preset renders as the default/blank
// screen — it looks like an engine bug but the body is simply in the wrong section
// and belongs in comp_*/warp_*. Typed declarations are the unambiguous tell.
const HLSL_IN_EQUATIONS = /\b(float[234]?|half[234]?|int[234])\s+[A-Za-z_]\w*\s*=|\bret\s*=|\bsaturate\s*\(|\btex2D\s*\(/;
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
    hasShapes: false,
    hasWaves: false,
  };

  let inBlock = null; // { target, startLine } — fork backtick-block mode
  let seenNonComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (inBlock) {
      const closes = raw.includes('`');
      const value = closes ? raw.slice(0, raw.indexOf('`')) : raw;
      inBlock.bucket.push({ index: inBlock.nextIndex++, value, line: lineNo });
      if (closes) inBlock = null;
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

    // Shape/wave presets draw through shapecode_*/wavecode_* instead of a custom
    // warp/comp shader, so their lack of a shader body is by design, not an omission.
    if (/^shapecode_\d+_enabled$/i.test(key) && value.trim() !== '0') { model.hasShapes = true; continue; }
    if (/^wavecode_\d+_enabled$/i.test(key) && value.trim() !== '0') { model.hasWaves = true; continue; }

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
        inBlock = { target, bucket: model.shaderPieces[target], startLine: lineNo, nextIndex: idx * 1000 + 1 };
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
      const target = eqMatch[1].toLowerCase();
      const idx = Number(eqMatch[2]);
      const bucket = model.eqGroups[target];
      // Equation groups use the same two encodings as shaders: one key per physical
      // line, or a backtick-delimited block whose body lines carry no key at all.
      // Block bodies used to be dropped on the floor here, which hid whatever was
      // inside them (including HLSL bodies filed under per_pixel_*) from every check.
      const startsBacktick = value.trimStart().startsWith('`');
      const afterTick = startsBacktick ? value.trimStart().slice(1) : value;
      const next = (lines[i + 1] || '').trim();
      const nextIsKey = /^(per_frame_init|per_frame|per_pixel)_\d+\s*=/i.test(next) || next === '';
      if (startsBacktick && !afterTick.includes('`') && !nextIsKey) {
        if (afterTick) bucket.push({ index: idx * 1000, value: afterTick, line: lineNo });
        inBlock = { target, bucket, startLine: lineNo, nextIndex: idx * 1000 + 1 };
      } else {
        let piece = afterTick;
        if (piece.endsWith('`')) piece = piece.slice(0, -1);
        bucket.push({ index: idx, value: piece, line: lineNo });
      }
    }
  }

  if (inBlock) model.unterminatedBlock = inBlock;
  return model;
}

// ---- waivers ----------------------------------------------------------------
//
// Some findings are correct about the code and wrong about the intent. The three
// `milkNNN_variant.milk` presets, for example, deliberately keep their math in
// per_pixel equations: they are the MilkDrop 1.x counterparts of the GPU-ported
// `milkNNN.milk` siblings and exist precisely to exercise that path, so
// `per-pixel-to-gpu` and `no-shader` will always fire on them.
//
// Rather than let those warnings sit in the report forever (where they train the
// reader to ignore warnings) or drop the checks (where they stop protecting
// everything else), a preset can waive an advisory finding from a leading comment:
//
//   // audit-allow: per-pixel-to-gpu — legacy 1.x counterpart of milk002.milk
//
// The reason is mandatory: a waiver without one is itself reported, so this can
// document an intentional choice but cannot quietly mute a finding. Waived findings
// are carried in the JSON report so nothing disappears from the record.
const WAIVER_RE = /^audit-allow:\s*([a-z0-9-]+)\s*(.*)$/i;

function parseWaivers(leadingComments) {
  const map = new Map();
  map.malformed = [];
  for (const comment of leadingComments) {
    const match = comment.match(WAIVER_RE);
    if (!match) continue;
    const code = match[1];
    // Accept an em dash, hyphen or colon as the reason separator.
    const reason = match[2].replace(/^\s*[—\-:]\s*/, '').trim();
    if (!reason) { map.malformed.push(code); continue; }
    map.set(code, reason);
  }
  return map;
}

// ---- cost model -------------------------------------------------------------
//
// Cost is expressed in *per-vertex-equation equivalents*: 1 unit ≈ the work of one
// per_pixel equation line, which the engine evaluates once per mesh vertex per
// frame (hundreds to a few thousand evaluations). Every other term is scaled by how
// often it actually runs, because that — not how much text it occupies — is what
// costs frame time:
//
//   per_pixel line   1 unit    — per mesh vertex, per frame (the CPU-side hot loop)
//   shader line      0.2 units — per *fragment*: far more evaluations than a vertex
//                                equation, but the GPU is enormously wider, so a
//                                shader line still lands well under a per-vertex eq
//                                in wall-clock terms
//   tex2D            3 units   — per fragment and bandwidth/cache bound, the usual
//                                limiter in feedback-heavy presets
//   per_frame line   0.02 units— evaluated ONCE per frame. A few hundred scalar
//                                expressions per frame is microseconds; per_frame
//                                count should barely register.
//
// The previous model charged per_frame at 0.2 units/line — the same order as
// per-fragment shader work — which made equation *verbosity* the dominant term. In
// the audited corpora that put 103 presets in the `heavy` tier with zero per_pixel
// equations, modest shader bodies and few texture fetches: presets that are cheap on
// both CPU and GPU but wordy in per_frame. Re-weighting by evaluation frequency is a
// correction to the estimator, not a change to any preset — nothing got faster, the
// ruler got less wrong.
const COST_WEIGHTS = {
  perPixel: 1,
  shaderLine: 0.2,
  tex2d: 3,
  perFrame: 0.02,
};

// Tier cut points. `heavy` is set at roughly the top decile of estimated cost across
// the audited corpora so it stays an actionable worklist rather than a label on the
// majority; `light` means no meaningful per-fragment load.
// Across the 462 audited presets the corrected cost has p25 ≈ 20, p50 ≈ 30, p90 ≈ 60.
const TIER_MEDIUM = 20;
const TIER_HEAVY = 60;

function estimateCost({ perFrame = 0, perPixel = 0, shaderLines = 0, tex2d = 0 }) {
  const raw = perPixel * COST_WEIGHTS.perPixel
    + shaderLines * COST_WEIGHTS.shaderLine
    + tex2d * COST_WEIGHTS.tex2d
    + perFrame * COST_WEIGHTS.perFrame;
  return Math.round(raw * 10) / 10;
}

function tierForCost(cost) {
  return cost >= TIER_HEAVY ? 'heavy' : cost >= TIER_MEDIUM ? 'medium' : 'light';
}

// ---- auditing ---------------------------------------------------------------
function auditPreset(absPath) {
  return auditText(readFileSync(absPath, 'utf8'), relative(PROJECT_ROOT, absPath));
}

function auditText(text, rel) {
  const model = parsePreset(text);
  const findings = [];
  const waivers = parseWaivers(model.leadingComments);
  const waived = [];
  const add = (severity, code, message, line) => {
    // A waiver only suppresses advisory findings. `error` findings are structural
    // (missing header, unbalanced shader) and are never waivable — a preset cannot
    // opt out of being parseable.
    const waiver = waivers.get(code);
    if (waiver && severity !== 'error') {
      waived.push({ code, reason: waiver, message });
      return;
    }
    findings.push({ severity, code, message, line });
  };

  for (const bad of waivers.malformed) {
    findings.push({
      severity: 'warn',
      code: 'malformed-waiver',
      message: `\`audit-allow: ${bad}\` is missing a reason — write \`// audit-allow: <code> — <why this is intentional>\``,
      line: 1,
    });
  }

  // -- structural --
  if (!model.header) add('error', 'no-preset-header', 'missing [presetNN] section header');
  if (!model.version) add('error', 'no-version', 'missing MILKDROP_PRESET_VERSION');
  if (!model.hasWarp && !model.hasComp && !model.hasShapes && !model.hasWaves) {
    add('warn', 'no-shader', 'no warp_ or comp_ shader block found, and no shapecode_/wavecode_ drawing either');
  }
  // A preset that declares PSVERSION_WARP/COMP but ships no matching shader body is
  // inconsistent: the engine falls back to the default shader, so the declaration is
  // inert and usually means the body was lost in an edit or never written.
  // PSVERSION_*=0 is the explicit "no custom shader" declaration, not a broken one.
  const declaresShaderVersion = (v) => v != null && Number(v) > 0;
  if (declaresShaderVersion(model.psWarp) && !model.hasWarp) {
    add('warn', 'psversion-without-shader', `PSVERSION_WARP=${model.psWarp} is declared but there is no warp_* shader body — the engine will use the default warp shader`);
  }
  if (declaresShaderVersion(model.psComp) && !model.hasComp) {
    add('warn', 'psversion-without-shader', `PSVERSION_COMP=${model.psComp} is declared but there is no comp_* shader body — the engine will use the default composite shader`);
  }
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

    const hlslLine = pieces.find((p) => HLSL_IN_EQUATIONS.test(stripLineComment(p.value)));
    if (hlslLine) {
      add('error', 'hlsl-in-equations',
        `${kind}_* contains HLSL (typed declarations / ret / saturate / tex2D), which the equation parser cannot evaluate — move this body into a comp_* or warp_* shader block`,
        hlslLine.line);
    }
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
  const cost = estimateCost({ perFrame, perPixel, shaderLines, tex2d });
  const tier = tierForCost(cost);

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
    description: model.leadingComments
      .filter((c) => !WAIVER_RE.test(c))
      .slice(0, 4).join(' ').slice(0, 240) || null,
    author,
    reactive,
    tier,
    metrics: { perFrameInit, perFrame, perPixel, shaderLines, tex2d, cost },
    findings,
    waived,
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
  // PSVERSION declared with no matching shader body -> warn (milk008/009/010 case).
  check('PSVERSION_COMP without comp body -> warn',
    has('MILKDROP_PRESET_VERSION=201\nPSVERSION_COMP=3\n[preset00]\n' + SHADER, 'psversion-without-shader'));
  check('PSVERSION_WARP with a warp body is fine',
    !has('MILKDROP_PRESET_VERSION=201\nPSVERSION_WARP=3\n[preset00]\n' + SHADER, 'psversion-without-shader'));

  // -- waivers --
  const NOSHADER = HDR + 'per_frame_1=x=1;\n';
  check('waiver suppresses an advisory finding',
    !has('// audit-allow: no-shader — legacy 1.x counterpart\n' + NOSHADER, 'no-shader'));
  check('waiver without a reason is reported',
    has('// audit-allow: no-shader\n' + NOSHADER, 'malformed-waiver'));
  check('waiver without a reason does not suppress',
    has('// audit-allow: no-shader\n' + NOSHADER, 'no-shader'));
  check('waiver cannot suppress a structural error',
    has('// audit-allow: no-version — nope\n[preset00]\n' + SHADER, 'no-version'));
  check('waiver only suppresses its own code',
    has('// audit-allow: per-pixel-to-gpu — unrelated\n' + NOSHADER, 'no-shader'));
  check('waived findings are recorded',
    auditText('// audit-allow: no-shader — legacy 1.x counterpart\n' + NOSHADER, 'selftest.milk')
      .waived.some((w) => w.code === 'no-shader'));
  check('waiver text is kept out of the description',
    !(auditText('// audit-allow: no-shader — legacy 1.x counterpart\n' + NOSHADER, 'selftest.milk')
      .description || '').includes('audit-allow'));

  // -- cost model --
  // per_frame is evaluated once per frame and must not dominate the tier.
  check('wordy per_frame alone is not heavy',
    tierForCost(estimateCost({ perFrame: 216, perPixel: 0, shaderLines: 28, tex2d: 2 })) !== 'heavy');
  check('many per_pixel equations are heavy',
    tierForCost(estimateCost({ perFrame: 76, perPixel: 143, shaderLines: 62, tex2d: 3 })) === 'heavy');
  check('texture-fetch-bound preset is heavy',
    tierForCost(estimateCost({ perFrame: 38, perPixel: 21, shaderLines: 75, tex2d: 25 })) === 'heavy');
  check('a tiny preset is light',
    tierForCost(estimateCost({ perFrame: 10, perPixel: 0, shaderLines: 20, tex2d: 1 })) === 'light');
  check('per_pixel outweighs the same count of per_frame',
    estimateCost({ perPixel: 20 }) > estimateCost({ perFrame: 20 }));

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
  if (opts.worklist) {
    const p = resolve(PROJECT_ROOT, opts.worklist);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, renderWorklist(report));
    if (!opts.quiet) console.log(`wrote optimization worklist -> ${relative(PROJECT_ROOT, p)}`);
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

// Ranked optimization worklist: the `heavy` tail, ordered by estimated cost, with the
// dominant cost term named so whoever picks one up knows what to attack before opening
// the file. Written for the corpus owner — weeks_presets is vendored from the
// ford442/weeks_on_fire project, so fixes belong upstream there, not in edits here.
function renderWorklist(report) {
  const L = [];
  L.push('# Preset Optimization Worklist');
  L.push('');
  L.push('> Generated by `scripts/audit_presets.mjs --worklist docs/PRESET_WORKLIST.md`.');
  L.push('> Ranked by the static cost estimate, heaviest first. Cost is in per-vertex-equation');
  L.push('> equivalents; see the cost model comment in the script for the weights.');
  L.push('');
  L.push(`Last run: \`${report.generatedAt}\``);
  L.push('');

  for (const c of report.corpora) {
    const heavy = c.results.filter((r) => r.tier === 'heavy')
      .sort((a, b) => b.metrics.cost - a.metrics.cost);
    L.push(`## \`${c.dir}\``);
    L.push('');
    if (heavy.length === 0) {
      L.push('No presets in the `heavy` tier. 🎉');
      L.push('');
      continue;
    }
    L.push(`${heavy.length} of ${c.summary.total} presets are in the \`heavy\` tier.`);
    L.push('');
    L.push('| # | Preset | Cost | Dominant term | per_pixel | tex2D | shader lines | per_frame |');
    L.push('|---|--------|-----:|---------------|----------:|------:|-------------:|----------:|');
    heavy.forEach((r, i) => {
      const m = r.metrics;
      const terms = [
        ['per_pixel equations', m.perPixel * COST_WEIGHTS.perPixel],
        ['tex2D fetches', m.tex2d * COST_WEIGHTS.tex2d],
        ['shader body length', m.shaderLines * COST_WEIGHTS.shaderLine],
        ['per_frame equations', m.perFrame * COST_WEIGHTS.perFrame],
      ].sort((a, b) => b[1] - a[1]);
      const [name, value] = terms[0];
      const share = Math.round((value / Math.max(m.cost, 0.001)) * 100);
      L.push(`| ${i + 1} | \`${r.name}\` | ${m.cost} | ${name} (${share}%) | ${m.perPixel} | ${m.tex2d} | ${m.shaderLines} | ${m.perFrame} |`);
    });
    L.push('');
  }

  L.push('## How to read this');
  L.push('');
  L.push('- **per_pixel equations dominant** — the CPU evaluates these once per mesh vertex per');
  L.push('  frame. Moving the zoom/warp math into a `warp_*` shader body hands it to the GPU and');
  L.push('  is usually the single biggest win.');
  L.push('- **tex2D fetches dominant** — bandwidth bound. Look for repeated fetches of the same');
  L.push('  coordinate that can be hoisted into a local, or blur taps that can drop an octave.');
  L.push('- **shader body length dominant** — long per-fragment programs. Check for math that is');
  L.push('  constant across the frame and can move to `per_frame_*` (into a `q` variable).');
  L.push('- **per_frame equations dominant** — rare, and rarely worth acting on: these run once');
  L.push('  per frame. A preset that reaches `heavy` on per_frame alone is almost certainly just');
  L.push('  verbose rather than slow.');
  L.push('');
  return L.join('\n') + '\n';
}

export { auditPreset, auditText, parsePreset };

const isMain = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
