// The deploy-time generators and the production header check
// (scripts/generate_wasm_builds_manifest.mjs, scripts/generate_songs_manifest.mjs,
// scripts/check_production_headers.mjs): the parts that decide what the
// manifests say and what counts as a correct response.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { buildEntry, extractGlueApi } from '../../scripts/generate_wasm_builds_manifest.mjs';
import {
    describeTrack,
    id3v2Length,
    parseFlacHead,
    parseWavHead,
    renderListingHtml,
} from '../../scripts/generate_songs_manifest.mjs';
import { decodeBody } from '../../scripts/check_production_headers.mjs';
import { parseSongDirectoryListing } from '../../html/projectm-song-loader.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/flac');
const WASM_MAGIC = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

/** Glue in the shape Emscripten emits: minified wasm export names, readable Module keys. */
function glue(version, exportsList) {
    const lines = exportsList.map((name, i) => `var _${name}=Module["_${name}"]=wasmExports["a${i}"];`);
    return Buffer.from(`var createModule=(()=>{});${lines.join('')}var f="projectm-v.${version}-thread.wasm";`);
}

test('extractGlueApi reads the readable export names and drops runtime internals', () => {
    const api = extractGlueApi(glue('039', ['set_rhythm_events', 'init', 'emscripten_stack_get_end', 'stackSave', 'dynCall_vi']).toString());
    assert.deepEqual(api, ['init', 'set_rhythm_events']);
});

test('buildEntry records hashes, sizes and the API of a UTF-8 glue/wasm pair', () => {
    const entry = buildEntry('039', glue('039', ['init', 'get_rhythm_bpm']), WASM_MAGIC);
    assert.equal(entry.glue, 'pm/projectm-v.039-thread.js');
    assert.equal(entry.wasm, 'pm/projectm-v.039-thread.wasm');
    assert.match(entry.sha256.glue, /^[0-9a-f]{64}$/);
    assert.equal(entry.bytes.wasm, WASM_MAGIC.length);
    assert.deepEqual(entry.api, ['get_rhythm_bpm', 'init']);
});

test('buildEntry refuses UTF-16 glue, a non-wasm binary, and a glue still pointing at the smoke tag', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('var x;', 'utf16le')]);
    assert.throws(() => buildEntry('033', utf16, WASM_MAGIC), /UTF-16/);
    assert.throws(() => buildEntry('039', glue('039', []), Buffer.from('<html>')), /magic/);
    assert.throws(() => buildEntry('039', glue('030', []), WASM_MAGIC), /does not reference projectm-v\.039-thread\.wasm/);
});

test('parseFlacHead reads STREAMINFO from a real FLAC, and after an ID3v2 prefix', () => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, 'streaminfo-coded-24bit.flac')));
    const plain = parseFlacHead(bytes);
    assert.equal(plain?.sampleRate, 44100);
    assert.equal(plain?.channels, 2);
    assert.equal(plain?.bitsPerSample, 24);
    assert.ok(plain?.duration > 0.2 && plain.duration < 0.3);
    assert.equal(plain?.id3, false);

    const tag = new Uint8Array(10 + 300);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 2, 0x2c]); // syncsafe 300
    const prefixed = new Uint8Array(tag.length + bytes.length);
    prefixed.set(tag);
    prefixed.set(bytes, tag.length);
    assert.equal(id3v2Length(prefixed), 310);
    const withId3 = parseFlacHead(prefixed);
    assert.equal(withId3?.bitsPerSample, 24);
    assert.equal(withId3?.id3, true);

    const sixteen = parseFlacHead(new Uint8Array(readFileSync(join(fixtures, 'streaminfo-coded-16bit.flac'))));
    assert.equal(sixteen?.bitsPerSample, 16);
    assert.equal(parseFlacHead(new TextEncoder().encode('<html>404</html>')), null);
});

test('parseFlacHead takes TITLE and ARTIST from the Vorbis comment block', () => {
    const streaminfo = readFileSync(join(fixtures, 'streaminfo-coded-16bit.flac')).subarray(4, 4 + 4 + 34);
    const comments = ['TITLE=Claws of the Angel', 'ARTIST=Noah Cohn'].map((c) => Buffer.from(c));
    const vendor = Buffer.from('test');
    const body = Buffer.concat([
        Buffer.from(Uint32Array.of(vendor.length).buffer), vendor,
        Buffer.from(Uint32Array.of(comments.length).buffer),
        ...comments.flatMap((c) => [Buffer.from(Uint32Array.of(c.length).buffer), c]),
    ]);
    const header = Buffer.from([0x84, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]);
    const streaminfoNotLast = Buffer.from(streaminfo);
    streaminfoNotLast[0] &= 0x7f;
    const file = Buffer.concat([Buffer.from('fLaC'), streaminfoNotLast, header, body]);
    const meta = parseFlacHead(new Uint8Array(file));
    assert.equal(meta?.title, 'Claws of the Angel');
    assert.equal(meta?.artist, 'Noah Cohn');
});

test('parseWavHead reads PCM WAV format and duration', () => {
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36 + 176400, 4);
    wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(44100, 24);
    wav.writeUInt32LE(176400, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(176400, 40);
    assert.deepEqual(parseWavHead(new Uint8Array(wav)), { channels: 2, sampleRate: 44100, bitsPerSample: 16, duration: 1 });
});

test('describeTrack percent-encodes the url and falls back to the file name as title', () => {
    const track = describeTrack('Brother & Sisters.mp3', 123, new Uint8Array(0));
    assert.equal(track.url, 'Brother%20%26%20Sisters.mp3');
    assert.equal(track.title, 'Brother & Sisters');
    assert.equal(track.format, 'mp3');
    assert.equal(track.duration, null);
});

test('the generated index.html parses like the Apache listing the WASM glue scrapes', () => {
    const tracks = ['Claws of the Angel.flac', 'Brother & Sisters.flac', '<odd>.flac'].map((file) => describeTrack(file, 1, new Uint8Array(0)));
    const html = renderListingHtml('/songs', tracks);
    assert.match(html, /<pre>[\s\S]*<\/pre>/, 'the glue reads the first <pre>');
    assert.doesNotMatch(html, /<odd>/, 'names are escaped');
    const urls = parseSongDirectoryListing(html.slice(html.indexOf('<pre>')), 'https://projectm.1ink.us/songs/');
    assert.deepEqual(urls, [
        'https://projectm.1ink.us/songs/Claws%20of%20the%20Angel.flac',
        'https://projectm.1ink.us/songs/Brother%20%26%20Sisters.flac',
        'https://projectm.1ink.us/songs/%3Codd%3E.flac',
    ]);
});

test('decodeBody removes one br or gzip layer and reports what it removed', () => {
    const text = Buffer.from('var createModule;');
    const res = (encoding, raw) => ({ headers: encoding ? { 'content-encoding': encoding } : {}, raw });
    assert.deepEqual(decodeBody(res('br', brotliCompressSync(text))), { body: text, encodings: ['br'] });
    assert.deepEqual(decodeBody(res('gzip', gzipSync(text))), { body: text, encodings: ['gzip'] });
    assert.deepEqual(decodeBody(res('', text)), { body: text, encodings: [] });
    const twice = decodeBody(res('gzip, br', brotliCompressSync(gzipSync(text))));
    assert.deepEqual(twice.encodings, ['gzip', 'br'], 'two layers are decoded and reported (the check fails on length > 1)');
    assert.throws(() => decodeBody(res('gzip', text)), 'a body that does not decode throws');
});
