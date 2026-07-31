/**
 * Shared preset metadata parsing for manifest / featured-pack builders.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { auditText } from './audit_presets.mjs';

const AUDIO_VARS = /\b(bass|mid|treb|bass_att|mid_att|treb_att|vol)\b/;

export function parseHeaderMetadata(source) {
    const meta = {
        tags: [],
        tier: null,
        reactivity: null,
        author: null,
        version: null,
        project: null,
        featured: false,
        music: null,
        series: null,
    };

    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('//')) {
            if (line.startsWith('[') || line.startsWith('MILKDROP_')) break;
            continue;
        }
        const text = line.replace(/^\/\/\s*/, '').trim();
        if (!text) continue;

        const tagsMatch = text.match(/^tags:\s*(.+)$/i);
        if (tagsMatch) {
            meta.tags = tagsMatch[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
            continue;
        }
        const tierMatch = text.match(/^tier:\s*(light|medium|heavy)$/i);
        if (tierMatch) { meta.tier = tierMatch[1].toLowerCase(); continue; }
        const reactMatch = text.match(/^reactivity:\s*(none|low|medium|high)$/i);
        if (reactMatch) { meta.reactivity = reactMatch[1].toLowerCase(); continue; }
        const authorMatch = text.match(/^author:\s*(.+)$/i);
        if (authorMatch) { meta.author = authorMatch[1].trim(); continue; }
        const versionMatch = text.match(/^version:\s*(\S+)/i);
        if (versionMatch) { meta.version = versionMatch[1]; continue; }
        const projectMatch = text.match(/^project:\s*(.+)$/i);
        if (projectMatch) { meta.project = projectMatch[1].trim(); continue; }
        const musicMatch = text.match(/^music:\s*(.+)$/i);
        if (musicMatch) { meta.music = musicMatch[1].trim(); continue; }
        const featuredMatch = text.match(/^featured:\s*(true|1|yes)$/i);
        if (featuredMatch) { meta.featured = true; continue; }
        const seriesMatch = text.match(/^Signature Series\s*\|\s*([^|]+)\|\s*(.+)$/i);
        if (seriesMatch) {
            meta.series = seriesMatch[1].trim();
            meta.tags.push('signature', seriesMatch[1].trim().toLowerCase().replace(/\s+/g, '-'));
            if (!meta.project) meta.project = seriesMatch[2].trim().toLowerCase().replace(/\s+/g, '-');
            continue;
        }
    }

    meta.tags = [...new Set(meta.tags)];
    return meta;
}

export function loadSidecarMeta(presetDir, file) {
    const sidecar = join(presetDir, `${file}.meta.json`);
    if (!existsSync(sidecar)) return {};
    try {
        return JSON.parse(readFileSync(sidecar, 'utf8'));
    } catch {
        return {};
    }
}

// Fallback tiering for presets that are not in the audit index (e.g. a draft that has
// not been audited yet). This used to carry its own copy of the cost model, computed
// from cruder regexes, which silently drifted from the auditor's — a preset could be
// `medium` in the manifest and `heavy` in the report. Delegate to the auditor instead
// so there is exactly one cost model in the repo.
export function estimateTierFromSource(source) {
    return auditText(source, 'inline.milk').tier;
}

export function estimateReactivity(source, auditReactive) {
    if (auditReactive === true) return 'high';
    if (auditReactive === false) return 'none';
    const eq = source.match(/^(?:per_frame|per_pixel|wave_\d+_per_frame)_\d+=/gm)?.join(' ') || '';
    if (AUDIO_VARS.test(eq)) {
        const hits = (eq.match(/\b(bass_att|mid_att|treb_att)\b/g) || []).length;
        if (hits >= 2) return 'high';
        if (hits >= 1) return 'medium';
        return 'low';
    }
    return 'none';
}

export function deriveLabel(source, file) {
    const lines = source.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('//')) {
            if (line.startsWith('[') || line.startsWith('MILKDROP_')) break;
            continue;
        }
        let text = line.replace(/^\/\/\s*/, '').trim();
        if (/^(tags|tier|reactivity|author|version|project|music|featured):/i.test(text)) continue;
        const seriesMatch = text.match(/^Signature Series\s*\|\s*[^|]+\|\s*(.+)$/i);
        if (seriesMatch) return text.length > 64 ? `${text.slice(0, 61)}…` : text;
        const letters = (text.match(/[a-z]/gi) || []).length;
        const isMetadata = /PSVERSION|MILKDROP_|docs\/|^(Target|Brief|Pattern|Date|Intent)\s*:/i.test(text);
        if (!text || /^CHANGELOG/i.test(text) || letters < 3 || isMetadata) continue;
        return text.length > 64 ? `${text.slice(0, 61)}…` : text;
    }
    return file.replace(/\.milk$/i, '');
}

export function computeQualityWeight(entry) {
    if (entry.status === 'broken') return 0;
    let w = typeof entry.weight === 'number' ? entry.weight : 5;
    if (entry.status === 'ok') w += 8;
    else if (entry.status === 'unknown') w += 2;
    if (entry.tier === 'light') w += 4;
    else if (entry.tier === 'medium') w += 2;
    else if (entry.tier === 'heavy') w -= 2;
    if (entry.reactivity === 'high') w += 2;
    if (entry.featured) w += 5;
    if (entry.tags?.includes('signature')) w += 3;
    return Math.max(1, Math.min(20, Math.round(w)));
}

export function loadAuditIndex(auditPath) {
    if (!existsSync(auditPath)) return new Map();
    const report = JSON.parse(readFileSync(auditPath, 'utf8'));
    const index = new Map();
    for (const corpus of report.corpora || []) {
        for (const r of corpus.results || []) {
            const base = r.name || r.path?.split('/').pop();
            if (base) index.set(base, r);
        }
    }
    return index;
}
