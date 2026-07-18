import assert from 'node:assert/strict';
import test from 'node:test';
import { OBSERVED_ATTRIBUTES } from '../../html/projectm-element-attributes.js';

test('project-m-visualizer exposes expected attributes', () => {
    assert.ok(OBSERVED_ATTRIBUTES.includes('preset-url'));
    assert.ok(OBSERVED_ATTRIBUTES.includes('audio-source'));
    assert.ok(OBSERVED_ATTRIBUTES.includes('external-pcm-origins'));
    assert.ok(OBSERVED_ATTRIBUTES.includes('transparent'));
    assert.ok(OBSERVED_ATTRIBUTES.includes('target-fps'));
    assert.ok(OBSERVED_ATTRIBUTES.includes('mesh-quality'));
});

test('OBSERVED_ATTRIBUTES is a non-empty attribute list', () => {
    assert.ok(OBSERVED_ATTRIBUTES.length >= 8);
});
