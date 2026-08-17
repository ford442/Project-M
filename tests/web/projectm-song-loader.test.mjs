// Run with: node --test tests/web/projectm-song-loader.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BROWSER_DECODE_EXTENSIONS,
    MOD_EXTENSIONS,
    classifySongUrl,
    installSongLoaderInterceptor,
    isWorkletCatalogSong,
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

    fetchCalled = false;
    const sngFlac = new globalThis.BroadcastChannel('sng');
    sngFlac.postMessage({ data: 'https://example.com/demo.flac' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posts.length, 0, 'flac should play via worklet, not ./flac/ sng');
    assert.equal(fetchCalled, true);
    assert.equal(decodeCalls.length, 2);

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

test('routeSongUrl decodes flac via worklet fetch path', async () => {
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
    globalThis.openWeeksFlacDecoder = () => {
        throw new Error('should not open ./flac/ when native decode works');
    };
    globalThis.BroadcastChannel = FakeBroadcastChannel;
    globalThis.projectMAudioContext_Global_Cpp = {
        state: 'running',
        decodeAudioData() {
            return Promise.resolve({
                duration: 1,
                sampleRate: 44100,
                numberOfChannels: 2,
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
    delete globalThis.projectMSongLoadState;
    installSongLoaderInterceptor();

    let fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        return {
            ok: true,
            async arrayBuffer() {
                return new ArrayBuffer(64);
            },
        };
    };
    try {
        const result = await routeSongUrl('https://example.com/x.flac');
        assert.equal(result, 'handled');
        assert.equal(fetchCalled, true);
        assert.equal(posts.length, 0);
    } finally {
        globalThis.fetch = previousFetch;
        delete globalThis.openWeeksFlacDecoder;
        delete globalThis.__projectMSongLoaderInstalled;
        delete globalThis.projectMAudioContext_Global_Cpp;
        delete globalThis.projectMWorkletNode_Global_Cpp;
        delete globalThis.projectMSongLoadState;
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

test('Start/Change Song catalog excludes tracker modules', () => {
    assert.equal(isWorkletCatalogSong('https://x/a.flac'), true);
    assert.equal(isWorkletCatalogSong('https://x/a.mp3'), true);
    assert.equal(isWorkletCatalogSong('https://x/a.xm'), false);
    assert.equal(isWorkletCatalogSong('https://x/a.mod'), false);
});
