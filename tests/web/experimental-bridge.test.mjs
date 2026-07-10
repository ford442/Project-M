// Unit tests for pure helpers in html/projectm-experimental-bridge.js.
// Run with: node --test tests/web/experimental-bridge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseExperimentalMetadata,
    wantsExperimentalDepth,
    buildDepthSpriteCode
} from '../../html/projectm-experimental-bridge.js';

test('parseExperimentalMetadata returns empty for plain milk', () => {
    const milk = 'MILKDROP_PRESET_VERSION=201\n[preset00]\nfRating=3\n';
    assert.deepEqual(parseExperimentalMetadata(milk), {});
});

test('parseExperimentalMetadata parses key=value tokens', () => {
    const milk = [
        '// Signature Series demo',
        '// pm:experimental depth=auto depth-texture=pm_depth_map shapecode=0 gltf-export=on-lock',
        'MILKDROP_PRESET_VERSION=201',
        '[preset00]'
    ].join('\n');
    const meta = parseExperimentalMetadata(milk);
    assert.equal(meta.depth, 'auto');
    assert.equal(meta['depth-texture'], 'pm_depth_map');
    assert.equal(meta.shapecode, '0');
    assert.equal(meta['gltf-export'], 'on-lock');
});

test('parseExperimentalMetadata treats bare tokens as true', () => {
    const milk = '// pm:experimental experimental depth-source=upload\nMILKDROP_PRESET_VERSION=201\n';
    const meta = parseExperimentalMetadata(milk);
    assert.equal(meta.experimental, 'true');
    assert.equal(meta['depth-source'], 'upload');
});

test('parseExperimentalMetadata ignores empty input', () => {
    assert.deepEqual(parseExperimentalMetadata(''), {});
    assert.deepEqual(parseExperimentalMetadata(null), {});
    assert.deepEqual(parseExperimentalMetadata(undefined), {});
});

test('wantsExperimentalDepth detects auto and texture directives', () => {
    assert.equal(wantsExperimentalDepth({}), false);
    assert.equal(wantsExperimentalDepth({ depth: 'auto' }), true);
    assert.equal(wantsExperimentalDepth({ 'depth-texture': 'pm_depth_map' }), true);
    assert.equal(wantsExperimentalDepth({ depth: 'true' }), true);
    assert.equal(wantsExperimentalDepth({ 'gltf-export': 'true' }), false);
});

test('buildDepthSpriteCode emits milkdrop sprite block with depth texture', () => {
    const code = buildDepthSpriteCode({ scale: 1.2, blendmode: 1 });
    assert.match(code, /\[preset01\]/);
    assert.match(code, /img='textures\/pm_depth_map\.png'/);
    assert.match(code, /scaling=1\.2/);
    assert.match(code, /blendmode=1/);
    assert.match(code, /bass_att/);
});
