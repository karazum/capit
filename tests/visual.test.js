// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';

import {ANCHOR, Detector, detect, intensity} from '../extension/visual.js';

// A 200x120 intensity image of flat grey 90, with dividers of grey 132 drawn by `paint(set)`.
function image(paint) {
    const values = new Int16Array(200 * 120).fill(90);
    paint((x, y, value = 132) => {
        values[y * 200 + x] = value;
    });
    return values;
}

test('intensity sums the colour channels, a translucent pixel premultiplied as Cairo does', () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 1, 2, 3, 255, 100, 100, 100, 128]);
    assert.deepEqual(Array.from(intensity(rgba, 1, 3, 4, 4)), [60, 6, 150]);
    assert.deepEqual(Array.from(intensity(new Uint8Array([100, 100, 100, 7, 8, 9]), 2, 1, 6, 3)), [300, 24]);
});

test('a column divider and a row divider split the window into panels', () => {
    const values = image(set => {
        for (let y = 0; y < 120; y++)
            set(60, y);
        for (let x = 61; x < 200; x++)
            set(x, 40);
    });
    const found = detect(values, 200, 120, 1, [0, 0]);
    assert.deepEqual(found.slice(0, 2), [[0, 0, 61, 120], [61, 0, 139, 120]]);
    assert.ok(found.some(([x, y, width]) => x === 61 && y === 41 && width === 139), JSON.stringify(found));
});

test('a divider across only part of the window is not a panel edge', () => {
    const values = image(set => {
        for (let x = 20; x < 120; x++)
            set(x, 60);
    });
    assert.deepEqual(detect(values, 200, 120, 1, [0, 0]), []);
});

test("anchored, a border running into the window's outline divides it, and a separator stopping short does not", () => {
    const values = image(set => {
        // A 2 px light outline around the window, inside a 3 px frame of another grey.
        for (let line = 0; line < 5; line++) {
            for (let x = 0; x < 200; x++) {
                set(x, line, line < 3 ? 60 : 160);
                set(x, 119 - line, line < 3 ? 60 : 160);
            }
            for (let y = line; y < 120 - line; y++) {
                set(line, y, line < 3 ? 60 : 160);
                set(199 - line, y, line < 3 ? 60 : 160);
            }
        }
        for (let x = 5; x < 195; x++)
            set(x, 40);
        for (let x = 10; x < 190; x++)
            set(x, 80);
    });
    assert.deepEqual(new Detector(values, 200, 120, 1, ANCHOR).run(), [[0, 3, 200, 41], [0, 41, 200, 118]]);
});

test('an image too small to split has no panels', () => {
    assert.deepEqual(detect(new Int16Array(4), 2, 2, 1, [0, 0]), []);
});
