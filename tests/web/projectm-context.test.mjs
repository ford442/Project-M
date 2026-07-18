import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectMContext } from '../../html/projectm-context.js';

test('ProjectMContext requires a canvas', () => {
    assert.throws(() => new ProjectMContext({}), /canvas/);
});

test('ProjectMContext stores canvas references', () => {
    const canvas = { tagName: 'CANVAS', parentElement: null };
    const context = new ProjectMContext({ canvas });
    assert.equal(context.canvas, canvas);
    assert.equal(context.ready, false);
});
