#!/usr/bin/env node
/**
 * Convert a TOML preset draft to a .milk file.
 *
 * Usage:
 *   node scripts/toml_to_milk.mjs presets/drafts/foo.toml
 *   node scripts/toml_to_milk.mjs presets/drafts/foo.toml -o custom_milk_fixed/foo.milk
 *
 * TOML format (minimal — not full TOML parser; line-oriented for agent drafts):
 *
 *   [meta]
 *   signature = "orbital_rave | Zephyr Orbital"
 *   tags = "rave, orbital, medium"
 *   author = "you"
 *   project = "zephyr-orbital"
 *   music = "dnb"
 *
 *   [preset]
 *   presetname = "My Preset"
 *   fDecay = 0.96
 *   zoom = 1.0
 *
 *   [per_frame]
 *   1 = "q1=time"
 *   2 = "q2=bass_att"
 *
 *   [per_pixel]
 *   1 = "zoom=1.0;"
 *
 *   [warp]
 *   '''shader_body
 *   {
 *     ret = tex2D(sampler_main, uv).xyz;
 *   }
 *   '''
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

function parseSimpleToml(text) {
    const sections = {};
    let current = '_root';
    sections[current] = {};

    const lines = text.split(/\r?\n/);
    let multilineKey = null;
    let multilineBuf = [];

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const section = line.match(/^\[([^\]]+)\]$/);
        if (section) {
            if (multilineKey) {
                sections[current][multilineKey] = multilineBuf.join('\n');
                multilineKey = null;
                multilineBuf = [];
            }
            current = section[1].trim();
            sections[current] = sections[current] || {};
            continue;
        }

        if (multilineKey) {
            if (line.trim() === "'''") {
                sections[current][multilineKey] = multilineBuf.join('\n');
                multilineKey = null;
                multilineBuf = [];
            } else {
                multilineBuf.push(line);
            }
            continue;
        }

        const triple = line.match(/^(\w+)\s*=\s*'''(.*)$/);
        if (triple) {
            multilineKey = triple[1];
            multilineBuf = triple[2] ? [triple[2]] : [];
            if (line.trim().endsWith("'''") && line.trim() !== "'''") {
                sections[current][multilineKey] = triple[2].replace(/'''$/, '');
                multilineKey = null;
                multilineBuf = [];
            }
            continue;
        }

        const kv = line.match(/^([^=]+)=\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].trim();
        let value = kv[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        sections[current][key] = value;
    }

    if (multilineKey) {
        sections[current][multilineKey] = multilineBuf.join('\n');
    }

    return sections;
}

function emitShaderLines(prefix, body) {
    const lines = String(body || '').split(/\r?\n/).filter((l) => l.length > 0);
    const out = [];
    lines.forEach((line, i) => {
        out.push(`${prefix}_${i + 1}=\`${line}`);
    });
    return out;
}

function buildMilk(sections) {
    const meta = sections.meta || {};
    const preset = sections.preset || {};
    const perFrame = sections.per_frame || {};
    const perPixel = sections.per_pixel || {};
    const warp = sections.warp || {};
    const comp = sections.comp || {};

    const header = [];
    if (meta.signature) header.push(`// Signature Series | ${meta.signature}`);
    if (meta.tags) header.push(`// tags: ${meta.tags}`);
    if (meta.author) header.push(`// author: ${meta.author}`);
    if (meta.project) header.push(`// project: ${meta.project}`);
    if (meta.music) header.push(`// music: ${meta.music}`);

    const body = [
        ...header,
        'MILKDROP_PRESET_VERSION=201',
        'PSVERSION=3',
        'PSVERSION_WARP=3',
        'PSVERSION_COMP=3',
        '[preset00]',
    ];

    const presetKeys = Object.keys(preset);
    presetKeys.sort();
    for (const key of presetKeys) {
        body.push(`${key}=${preset[key]}`);
    }

    const pfKeys = Object.keys(perFrame).sort((a, b) => Number(a) - Number(b));
    for (const k of pfKeys) {
        body.push(`per_frame_${k}=${perFrame[k]}`);
    }

    const ppKeys = Object.keys(perPixel).sort((a, b) => Number(a) - Number(b));
    for (const k of ppKeys) {
        body.push(`per_pixel_${k}=${perPixel[k]}`);
    }

    const warpBody = warp.body || warp.shader || Object.values(warp)[0] || '';
    if (warpBody) {
        body.push(...emitShaderLines('warp', warpBody));
    }

    const compBody = comp.body || comp.shader || Object.values(comp)[0] || '';
    if (compBody) {
        body.push(...emitShaderLines('comp', compBody));
    }

    return body.join('\n') + '\n';
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: node scripts/toml_to_milk.mjs <draft.toml> [-o out.milk]');
    process.exit(args.length === 0 ? 1 : 0);
}

const input = resolve(args[0]);
let output = args.includes('-o') ? resolve(args[args.indexOf('-o') + 1]) : input.replace(/\.toml$/i, '.milk');
if (output === input) output = resolve(basename(input).replace(/\.toml$/i, '.milk'));

const sections = parseSimpleToml(readFileSync(input, 'utf8'));
const milk = buildMilk(sections);
writeFileSync(output, milk);
console.log(`Wrote ${output} (${milk.length} bytes)`);
