#!/usr/bin/env node
/**
 * Generate songs/index.json (and a static songs/index.html) for a song folder,
 * replacing the Apache auto-index the hosts used to scrape.
 *
 * index.json: { schema: 1, generatedAt, tracks: [{ title, artist, url, file,
 *   format, duration, sampleRate, channels, bitsPerSample, bytes, id3 }] }
 *   `url` is relative to the folder (percent-encoded file name). FLAC metadata
 *   comes from STREAMINFO and the Vorbis comment block (TITLE / ARTIST), after
 *   an ID3v2 prefix if there is one; WAV from its fmt/data chunks; other
 *   formats get size and title only.
 *
 * index.html: the same list as `<pre><a href>` lines, shaped like the Apache
 *   listing, because every deployed WASM build's glue (WasmJsBindings.cpp
 *   scanSongDirectory) parses exactly that and cannot be changed after the
 *   fact. With it in place html/.htaccess turns auto-indexing off for the song
 *   folders, so only the files listed here are discoverable.
 *
 * Sources (any combination; a file found locally is read from disk):
 *   --dir <folder>        local files (what deploy.py uploads from songs/)
 *   --listing <url>       a live listing (Apache auto-index, or a previously
 *                         generated index.html); names only
 *   --names <json>        a JSON array of file names, or deploy.py's
 *                         {"songs/<file>": bytes} size map; names only
 *   --base-url <url>      the folder's public URL, for --names (and --listing,
 *                         by default the listing URL): each remote-only file's
 *                         first 64 KiB is read there with a Range request
 *
 * Usage:
 *   node scripts/generate_songs_manifest.mjs --dir songs [--out songs/index.json]
 *   node scripts/generate_songs_manifest.mjs --listing https://projectm.1ink.us/songs/ --out songs/index.json
 *   node scripts/generate_songs_manifest.mjs --dir songs --names sizes.json \
 *       --base-url https://projectm.1ink.us/songs/ --out build/songs/index.json   # deploy.py
 */

import { readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SONGS_MANIFEST_SCHEMA = 1;
const AUDIO_EXTENSIONS = new Set(['.flac', '.wav', '.mp3', '.ogg', '.opus', '.m4a', '.mod', '.xm', '.s3m', '.it']);
const HEAD_BYTES = 64 * 1024;

/** Size of an ID3v2 tag at the start of `bytes` (0 when there is none). */
export function id3v2Length(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
    const footer = (bytes[5] & 0x10) ? 10 : 0;
    return 10 + footer + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
}

/**
 * FLAC metadata from the head of a file: STREAMINFO plus TITLE / ARTIST from
 * the Vorbis comment block when it lies within `bytes`.
 * @param {Uint8Array} bytes
 */
export function parseFlacHead(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const skip = id3v2Length(buf);
    if (buf.toString('latin1', skip, skip + 4) !== 'fLaC') return null;
    let pos = skip + 4;
    const out = { id3: skip > 0 };
    for (;;) {
        if (pos + 4 > buf.length) break;
        const header = buf[pos];
        const type = header & 0x7f;
        const length = buf.readUIntBE(pos + 1, 3);
        const body = pos + 4;
        if (type === 0 && body + 34 <= buf.length) {
            const packed = buf.readBigUInt64BE(body + 10);
            out.sampleRate = Number(packed >> 44n);
            out.channels = Number((packed >> 41n) & 7n) + 1;
            out.bitsPerSample = Number((packed >> 36n) & 31n) + 1;
            const total = Number(packed & ((1n << 36n) - 1n));
            out.duration = total && out.sampleRate ? Math.round((total / out.sampleRate) * 1000) / 1000 : null;
        } else if (type === 4 && body + length <= buf.length) {
            let p = body;
            const vendorLength = buf.readUInt32LE(p);
            p += 4 + vendorLength;
            const count = buf.readUInt32LE(p);
            p += 4;
            for (let i = 0; i < count && p + 4 <= body + length; i++) {
                const commentLength = buf.readUInt32LE(p);
                const comment = buf.toString('utf8', p + 4, p + 4 + commentLength);
                p += 4 + commentLength;
                const eq = comment.indexOf('=');
                const key = comment.slice(0, eq).toUpperCase();
                if (key === 'TITLE' && !out.title) out.title = comment.slice(eq + 1);
                if (key === 'ARTIST' && !out.artist) out.artist = comment.slice(eq + 1);
            }
        }
        if (header & 0x80) break;
        pos = body + length;
    }
    return 'sampleRate' in out ? out : null;
}

/** PCM WAV metadata from the head of a file (fmt + data chunk sizes). */
export function parseWavHead(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
    let pos = 12;
    const out = {};
    while (pos + 8 <= buf.length) {
        const id = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ' && pos + 24 <= buf.length) {
            out.channels = buf.readUInt16LE(pos + 10);
            out.sampleRate = buf.readUInt32LE(pos + 12);
            out.byteRate = buf.readUInt32LE(pos + 16);
            out.bitsPerSample = buf.readUInt16LE(pos + 22);
        } else if (id === 'data') {
            if (out.byteRate) out.duration = Math.round((size / out.byteRate) * 1000) / 1000;
            break;
        }
        pos += 8 + size + (size & 1);
    }
    delete out.byteRate;
    return out.sampleRate ? out : null;
}

/**
 * One manifest entry.
 * @param {string} file File name inside the folder.
 * @param {number} bytes File size.
 * @param {Uint8Array} head First bytes of the file.
 */
export function describeTrack(file, bytes, head) {
    const ext = extname(file).toLowerCase();
    const meta = ext === '.flac' ? parseFlacHead(head) : ext === '.wav' ? parseWavHead(head) : null;
    return {
        title: meta?.title || basename(file, extname(file)),
        artist: meta?.artist || null,
        url: encodeURIComponent(file),
        file,
        format: ext.slice(1),
        duration: meta?.duration ?? null,
        sampleRate: meta?.sampleRate ?? null,
        channels: meta?.channels ?? null,
        bitsPerSample: meta?.bitsPerSample ?? null,
        bytes,
        ...(meta?.id3 ? { id3: true } : {}),
    };
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Static listing in the shape the WASM glue's scanner parses (`<pre>` of `<a href>`). */
export function renderListingHtml(title, tracks) {
    const lines = tracks.map((t) => `<a href="${escapeHtml(t.url)}">${escapeHtml(t.file)}</a>`);
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="robots" content="noindex"></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>Generated by scripts/generate_songs_manifest.mjs; machine-readable list: <a href="index.json">index.json</a></p>
<pre>
${lines.join('\n')}
</pre>
</body>
</html>
`;
}

const isAudio = (file) => AUDIO_EXTENSIONS.has(extname(file).toLowerCase());
const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

function readLocal(dir, file) {
    const path = join(dir, file);
    const { size } = statSync(path);
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    try {
        readSync(fd, head, 0, head.length, 0);
    } finally {
        closeSync(fd);
    }
    return describeTrack(file, size, head);
}

async function readRemote(baseUrl, file) {
    const head = await fetch(baseUrl + encodeURIComponent(file), { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
    if (head.status !== 206 && head.status !== 200) {
        console.warn(`  skipped ${file}: HTTP ${head.status}`);
        return null;
    }
    const range = head.headers.get('content-range');
    const size = range ? Number(range.split('/')[1]) : Number(head.headers.get('content-length'));
    const bytes = new Uint8Array(await head.arrayBuffer()).subarray(0, HEAD_BYTES);
    return describeTrack(file, size, bytes);
}

/** Audio file names linked from a listing page (auto-index or generated index.html). */
async function namesFromListing(listingUrl) {
    const response = await fetch(withSlash(listingUrl));
    if (!response.ok) throw new Error(`${listingUrl}: HTTP ${response.status}`);
    const names = [];
    for (const match of (await response.text()).matchAll(/<a\s+[^>]*href="([^"]+)"/gi)) {
        const href = match[1].replace(/&amp;/g, '&');
        if (href.startsWith('?') || href.startsWith('/') || href.includes('://') || href.endsWith('/')) continue;
        names.push(decodeURIComponent(href));
    }
    return names.filter(isAudio);
}

/** Names from a JSON array, or from deploy.py's {"<folder>/<file>": bytes} map. */
function namesFromJson(path) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const keys = Array.isArray(json) ? json : Object.keys(json);
    return keys.map((key) => String(key).split('/').pop()).filter(isAudio);
}

async function main() {
    const argv = process.argv.slice(2);
    let dir = null;
    let listing = null;
    let namesFile = null;
    let baseUrl = null;
    let out = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir') dir = resolve(argv[++i]);
        else if (argv[i] === '--listing') listing = argv[++i];
        else if (argv[i] === '--names') namesFile = resolve(argv[++i]);
        else if (argv[i] === '--base-url') baseUrl = withSlash(argv[++i]);
        else if (argv[i] === '--out') out = resolve(argv[++i]);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    if (!dir && !listing && !namesFile) throw new Error('pass --dir <folder>, --listing <url> and/or --names <json>');
    if (namesFile && !baseUrl) throw new Error('--names needs --base-url (where remote-only files are read)');
    baseUrl ??= listing ? withSlash(listing) : null;
    out ??= join(dir || '.', 'index.json');

    const local = new Set(dir ? readdirSync(dir).filter(isAudio) : []);
    const remote = new Set([
        ...(listing ? await namesFromListing(listing) : []),
        ...(namesFile ? namesFromJson(namesFile) : []),
    ]);
    const tracks = [];
    for (const file of [...new Set([...local, ...remote])].sort((a, b) => a.localeCompare(b))) {
        const track = local.has(file) ? readLocal(dir, file) : await readRemote(baseUrl, file);
        if (track) tracks.push(track);
    }
    const manifest = { schema: SONGS_MANIFEST_SCHEMA, generatedAt: new Date().toISOString(), tracks };
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    const folder = basename(dir || new URL(baseUrl).pathname.replace(/\/$/, ''));
    writeFileSync(join(dirname(out), 'index.html'), renderListingHtml(`/${folder}`, tracks));
    const flac = tracks.filter((t) => t.format === 'flac');
    console.log(`wrote ${out} and index.html: ${tracks.length} tracks (${flac.length} FLAC, `
        + `${flac.filter((t) => t.bitsPerSample === 24).length} 24-bit, ${flac.filter((t) => t.id3).length} with ID3v2)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`ERROR: ${error.message}`);
        process.exit(1);
    });
}
