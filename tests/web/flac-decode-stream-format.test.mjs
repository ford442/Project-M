// Run with: node --test tests/web/flac-decode-stream-format.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function getDecodedStreamFormat(result) {
    const info = result && (result.metaData || result.streamInfo);
    if (!info) {
        return null;
    }
    const { sampleRate, channels, bitsPerSample } = info;
    if (!sampleRate || !channels || !bitsPerSample) {
        return null;
    }
    return { sampleRate, channels, bitsPerSample };
}

test('prefers STREAMINFO metadata over frame streamInfo', () => {
    const result = {
        metaData: { sampleRate: 48000, channels: 2, bitsPerSample: 16 },
        streamInfo: { sampleRate: 44100, channels: 2, bitsPerSample: 24 }
    };
    assert.deepEqual(getDecodedStreamFormat(result), {
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 16
    });
});

test('falls back to captured frame streamInfo', () => {
    const result = {
        streamInfo: { sampleRate: 96000, channels: 1, bitsPerSample: 24 }
    };
    assert.deepEqual(getDecodedStreamFormat(result), {
        sampleRate: 96000,
        channels: 1,
        bitsPerSample: 24
    });
});

test('returns null when stream format is incomplete', () => {
    assert.equal(getDecodedStreamFormat({ metaData: { sampleRate: 44100, channels: 2 } }), null);
    assert.equal(getDecodedStreamFormat(null), null);
});

test('interleave no longer forces 24-bit in data-util bundle', () => {
    const dataUtil = readFileSync(join(root, 'html/flac-decode/example/util/data-util.js'), 'utf8');
    assert.ok(!dataUtil.includes('bitsPerSample=24;'), 'interleave must not override bitsPerSample');
});

test('decode-func captures streamInfo from write callback', () => {
    const decodeFunc = readFileSync(join(root, 'html/flac-decode/example/decode-func.js'), 'utf8');
    assert.ok(decodeFunc.includes('streamInfo='), 'write callback should record streamInfo');
    assert.ok(decodeFunc.includes('streamInfo:streamInfo'), 'decode result should expose streamInfo');
});

test('app-decode posts WAV without referencing an undefined blob', () => {
    const appDecode = readFileSync(join(root, 'html/flac-decode/example/app-decode.js'), 'utf8');
    assert.ok(appDecode.includes('exportWavFile('));
    assert.equal(
        /forceDownload\(\s*blob\s*,/.test(appDecode),
        false,
        'checked #check_download must not throw ReferenceError: blob is not defined'
    );
});
