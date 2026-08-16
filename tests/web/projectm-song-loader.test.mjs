// Run with: node --test tests/web/projectm-song-loader.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BROWSER_DECODE_EXTENSIONS,
    MOD_EXTENSIONS,
    classifySongUrl,
    installSongLoaderInterceptor,
    parseSongDirectoryListing,
    routeSongUrl,
    songExtension,
} from '../../html/projectm-song-loader.js';

test('songExtension extracts extension from URLs', () => {
    assert.equal(songExtension('https://example.com/songs/track.MP3'), '.mp3');
    assert.equal(songExtension('https://example.com/a.flac?x=1'), '.flac');
    assert.equal(songExtension('https://example.com/mod/Demo.XM'), '.xm');
});

test('classifySongUrl buckets formats', () => {
    assert.equal(classifySongUrl('https://x/song.mp3'), 'browser');
    assert.equal(classifySongUrl('https://x/song.wav'), 'browser');
    assert.equal(classifySongUrl('https://x/song.flac'), 'flac');
    assert.equal(classifySongUrl('https://x/song.xm'), 'mod');
    assert.equal(classifySongUrl('https://x/song'), 'unknown');
});

test('installSongLoaderInterceptor routes browser formats away from sng channel', async () => {
    const posts = [];
    let fetchCalled = false;

    class FakeBroadcastChannel {
        constructor(name) {
            this.name = name;
        }
        postMessage(data) {
            posts.push({ channel: this.name, data });
        }
        addEventListener() {}
        close() {}
    }

    const previousBC = globalThis.BroadcastChannel;
    const previousFetch = globalThis.fetch;
    const previousEnsure = globalThis.projectMWorkletNode_Global_Cpp;

    globalThis.BroadcastChannel = FakeBroadcastChannel;
    globalThis.projectMWorkletNode_Global_Cpp = {};
    globalThis.fetch = async () => {
        fetchCalled = true;
        return {
            ok: true,
            async arrayBuffer() {
                return new ArrayBuffer(8);
            },
        };
    };

    const decodeCalls = [];
    globalThis.projectMAudioContext_Global_Cpp = {
        state: 'running',
        decodeAudioData(buf) {
            decodeCalls.push(buf.byteLength);
            return Promise.resolve({
                duration: 1,
                sampleRate: 44100,
                numberOfChannels: 1,
                getChannelData() {
                    return new Float32Array(1024);
                },
            });
        },
    };
    globalThis.projectMWorkletNode_Global_Cpp = {
        port: { postMessage() {} },
    };

    delete globalThis.__projectMSongLoaderInstalled;
    installSongLoaderInterceptor();

    const sng = new globalThis.BroadcastChannel('sng');
    sng.postMessage({ data: 'https://example.com/demo.mp3' });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(posts.length, 0, 'mp3 should not be forwarded to FLAC decoder');
    assert.equal(fetchCalled, true);
    assert.equal(decodeCalls.length, 1);

    const sngFlac = new globalThis.BroadcastChannel('sng');
    sngFlac.postMessage({ data: 'https://example.com/demo.flac' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channel, 'sng');
    assert.equal(posts[0].data.data, 'https://example.com/demo.flac');

    globalThis.BroadcastChannel = previousBC;
    globalThis.fetch = previousFetch;
    if (previousEnsure) {
        globalThis.projectMWorkletNode_Global_Cpp = previousEnsure;
    } else {
        delete globalThis.projectMWorkletNode_Global_Cpp;
    }
    delete globalThis.__projectMSongLoaderInstalled;
    delete globalThis.projectMAudioContext_Global_Cpp;
});

test('routeSongUrl handles flac via sng passthrough without fetch', async () => {
    const previousFetch = globalThis.fetch;
    const posts = [];
    class FakeBroadcastChannel {
        constructor(name) {
            this.name = name;
        }
        postMessage(data) {
            posts.push(data);
        }
        addEventListener() {}
        close() {}
    }
    globalThis.openWeeksFlacDecoder = () => {};
    globalThis.BroadcastChannel = FakeBroadcastChannel;
    delete globalThis.__projectMSongLoaderInstalled;
    installSongLoaderInterceptor();

    let fetchCalled = false;
    globalThis.fetch = () => {
        fetchCalled = true;
        throw new Error('should not fetch flac');
    };
    try {
        const result = await routeSongUrl('https://example.com/x.flac');
        assert.equal(result, 'handled');
        assert.equal(fetchCalled, false);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].data, 'https://example.com/x.flac');
    } finally {
        globalThis.fetch = previousFetch;
        delete globalThis.openWeeksFlacDecoder;
        delete globalThis.__projectMSongLoaderInstalled;
    }
});

test('parseSongDirectoryListing extracts file links', () => {
    const html = `<html><body><pre>
<a href="../">Parent Directory</a>
<a href="track01.mp3">track01.mp3</a>
<a href="demo.xm">demo.xm</a>
</pre></body></html>`;
    const urls = parseSongDirectoryListing(html, 'https://projectm.1ink.us/mp3_songs/');
    assert.deepEqual(urls, [
        'https://projectm.1ink.us/mp3_songs/track01.mp3',
        'https://projectm.1ink.us/mp3_songs/demo.xm',
    ]);
});

test('extension sets include mp3 and mod', () => {
    assert.ok(BROWSER_DECODE_EXTENSIONS.has('.mp3'));
    assert.ok(MOD_EXTENSIONS.has('.xm'));
});
