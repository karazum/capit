// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';

import {detectRegions, label} from '../extension/regions.js';

test('areas are labelled in raster order of their first pixel', () => {
    const mask = Uint8Array.from([1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0]);
    const [labels, count] = label(mask, 4, 4);
    assert.equal(count, 3);
    assert.deepEqual(Array.from(labels), [1, 0, 2, 2, 1, 0, 0, 2, 0, 2, 2, 2, 3, 0, 0, 0]);
    // The right-hand area starts first and takes in the left one through the bottom row.
    const [joined] = label(Uint8Array.from([0, 0, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
    assert.deepEqual(Array.from(joined), [0, 0, 1, 1, 0, 1, 1, 1, 1]);
});

test('diagonal neighbours join only when eight neighbours count', () => {
    const mask = Uint8Array.from([1, 0, 0, 1]);
    assert.equal(label(mask, 2, 2)[1], 2);
    assert.equal(label(mask, 2, 2, true)[1], 1);
});

test('a flat card on a flat background is found, in logical coordinates', () => {
    const values = new Int16Array(200 * 150).fill(100);
    for (let y = 40; y < 110; y++) {
        for (let x = 50; x < 170; x++)
            values[y * 200 + x] = 160;
    }
    const found = detectRegions(values, 200, 150, 1, [20, 10]);
    assert.ok(found.some(([x, y, width, height]) => x === 70 && y === 50 && width === 120 && height === 70),
        JSON.stringify(found));
});
