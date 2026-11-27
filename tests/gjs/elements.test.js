// SPDX-License-Identifier: GPL-3.0-or-later
// What both detection modes must find in the reference windows, independent of the exact boxes in detection.json.
// The visual mode finds panels only. The regions mode, which the extension's visual setting runs, also offers each
// line of text as a row and its words and icons as items, smallest first, so a hover offers the line and scrolling
// widens it to the panel. The synthetic windows in tests/fixtures/synthetic are 1200x760 logical pixels, drawn at 1x and upscaled with
// bilinear filtering at fractional scales, as Mutter does for an Xwayland window.
import {detectRegions, MIN_ITEM} from '../../extension/regions.js';
import {detect, intensity, MIN_ELEMENT} from '../../extension/visual.js';
import {assert, loadImage, repoPath, test} from './harness.js';

const WIDTH = 1200;
const HEIGHT = 760;
// The dark IDE: title bar, sidebar, tab strip, editor with a current-line band at y 300–320, status bar.
const TITLE = [0, 0, WIDTH, 38];
const SIDEBAR = [0, 38, 260, HEIGHT - 38];
const TABS = [261, 38, WIDTH - 261, 34];
const EDITOR = [261, 73, WIDTH - 261, HEIGHT - 73 - 24];
const STATUS = [261, HEIGHT - 24, WIDTH - 261, 24];
// The dark settings window: a sidebar with a separator that stops short of its edges and a selected row, and a
// rounded card of two rows.
const PANE = [0, 0, 260, HEIGHT];
const ROW = [8, 340, 244, 44];
const CARD = [400, 180, 500, 140];

const MODES = {visual: detect, regions: detectRegions};

// Boxes the `mode` detector finds in tests/fixtures/`name`, in logical pixels of the window.
function found(mode, name, scale) {
    const image = loadImage(repoPath(`tests/fixtures/${name}`));
    const values = intensity(image.pixels, image.width, image.height, image.rowstride, image.channels);
    return MODES[mode](values, image.width, image.height, scale, [0, 0]);
}

// Whether a box in `boxes` has every value within `tolerance` of `expected`.
function near(boxes, expected, tolerance = 3) {
    return boxes.some(box => box && box.every((value, axis) => Math.abs(value - expected[axis]) <= tolerance));
}

// Whether a box in `boxes` outlines `expected`: every edge within 3 px, or nearly the same area.
function outlined(boxes, expected) {
    return boxes.some(box => {
        if (!box)
            return false;
        const width = Math.min(box[0] + box[2], expected[0] + expected[2]) - Math.max(box[0], expected[0]);
        const height = Math.min(box[1] + box[3], expected[1] + expected[3]) - Math.max(box[1], expected[1]);
        const overlap = Math.max(width, 0) * Math.max(height, 0);
        return near([box], expected) || overlap >= 0.9 * (box[2] * box[3] + expected[2] * expected[3] - overlap);
    });
}

// The boxes around x, y in the order a hover offers them: the smallest first, then wider ones as scrolling widens it.
function around(boxes, x, y) {
    return boxes.filter(([left, top, width, height]) => left <= x && x < left + width && top <= y && y < top + height)
        .sort((a, b) => a[2] * a[3] - b[2] * b[3]);
}

// The box a hover at x, y offers: the smallest one around the point, or null.
function smallest(boxes, x, y) {
    return around(boxes, x, y)[0] ?? null;
}

// Whether `box` lies within `outer`, give or take 3 px.
function within(box, outer) {
    return Boolean(box) && box[0] >= outer[0] - 3 && box[1] >= outer[1] - 3 &&
        box[0] + box[2] <= outer[0] + outer[2] + 3 && box[1] + box[3] <= outer[1] + outer[3] + 3;
}

// Whether `box` is a row of `panel`: across the panel's width and no taller than a line, `tallest`.
function rowOf(box, panel, tallest = 44) {
    return within(box, panel) && Math.abs(box[0] - panel[0]) <= 3 && Math.abs(box[2] - panel[2]) <= 4 &&
        box[3] <= tallest;
}

const text = value => JSON.stringify(value);

for (const mode of Object.keys(MODES)) {
    test(`${mode}: the IDE's panels are found at scales 1, 1.25 and 2`, () => {
        for (const [name, scale] of [['ide-1.png', 1], ['ide-1.25.png', 1.25], ['ide-2.png', 2]]) {
            const boxes = found(mode, `synthetic/${name}`, scale);
            for (const [label, rect] of [['sidebar', SIDEBAR], ['title bar', TITLE], ['tab strip', TABS],
                ['status bar', STATUS]])
                assert.ok(near(boxes, rect), `${name}: ${label} ${text(rect)} missing from ${text(boxes)}`);
            // The current-line band is a highlight, not a divider: the editor stays one panel.
            assert.ok(near(boxes, EDITOR, 4), `${name}: editor missing from ${text(boxes)}`);
            // Panels are at least an element across both ways; a word or icon is at least an item along one.
            const large = ([, , width, height]) => mode === 'visual'
                ? Math.min(width, height) >= MIN_ELEMENT - 1 : Math.max(width, height) >= MIN_ITEM - 1;
            assert.ok(boxes.every(large), `${name}: too small: ${text(boxes.filter(box => !large(box)))}`);
        }
    });

    test(`${mode}: a photo does not shatter into elements`, () => {
        const boxes = found(mode, 'synthetic/ide-photo-1.25.png', 1.25);
        // The photo at [700, 400, 400, 240] is one flat colour, with editor text running up to its left side.
        const inside = boxes.filter(([x, y, width, height]) => x >= 695 && y >= 395 && x + width <= 1105 &&
            y + height <= 645);
        assert.ok(inside.length <= 1, text(inside));
        assert.ok(near(boxes, SIDEBAR), text(boxes));
    });
}

test('visual: a plain window of text has no elements', () => {
    assert.deepEqual(found('visual', 'synthetic/plain-1.png', 1), []);
});

test('regions: a plain window of text offers its lines and words, and no panels', () => {
    const boxes = found('regions', 'synthetic/plain-1.png', 1);
    const [width] = [loadImage(repoPath('tests/fixtures/synthetic/plain-1.png')).width];
    assert.ok(boxes.some(box => box[2] === width), `no row across the window: ${text(boxes)}`);
    // Nothing takes in more than about a line.
    assert.ok(boxes.every(([, , , height]) => height <= 30), text(boxes));
});

test('regions: a photo is one element', () => {
    const boxes = found('regions', 'synthetic/ide-photo-1.25.png', 1.25);
    assert.ok(near(boxes, [700, 400, 400, 240]), text(boxes));
});

test("regions: hovering the editor's current line offers the line, and widens to the editor", () => {
    for (const [name, scale] of [['ide-1.png', 1], ['ide-1.25.png', 1.25], ['ide-2.png', 2]]) {
        const boxes = found('regions', `synthetic/${name}`, scale);
        // The current-line band runs from y 300 to 320. Upscaled, its blurred lower edge touches the tops of the
        // next line's letters, which then join it: a known limit, so there the row may take in that line too.
        const line = smallest(boxes, 700, 310);
        assert.ok(rowOf(line, EDITOR, scale === 1 ? 30 : 42) && line[1] <= 300 && line[1] + line[3] >= 319,
            `${name}: ${text(line)}`);
        assert.ok(near(around(boxes, 700, 310), EDITOR, 4), `${name}: ${text(around(boxes, 700, 310))}`);
    }
});

test('regions: cards and rows inside panels, crisp and upscaled', () => {
    for (const [name, scale] of [['settings-1.png', 1], ['settings-1.25.png', 1.25]]) {
        const boxes = found('regions', `synthetic/${name}`, scale);
        for (const [label, rect] of [['sidebar', PANE], ['card', CARD], ['selected row', ROW]])
            assert.ok(near(boxes, rect), `${name}: ${label} ${text(rect)} missing from ${text(boxes)}`);
        // A hover in the sidebar offers the row under it, and widens to the whole sidebar: the separator stops
        // short of the sidebar's edges, so it is not a border between two panels.
        for (const y of [100, 600]) {
            assert.ok(rowOf(smallest(boxes, 130, y), PANE), `${name}: ${text(smallest(boxes, 130, y))}`);
            assert.ok(near(around(boxes, 130, y), PANE), `${name}: ${text(around(boxes, 130, y))}`);
        }
        assert.ok(near([smallest(boxes, 130, 360)], ROW), `${name}: ${text(boxes)}`);
        // A row of the card, or the card itself, but nothing that takes in the page around it.
        const [x, y, width] = smallest(boxes, 600, 250);
        assert.ok(x >= CARD[0] - 3 && y >= CARD[1] - 3 && width <= CARD[2] + 6, `${name}: ${text(boxes)}`);
        assert.ok(near([smallest(boxes, 600, 600)], [260, 0, WIDTH - 260, HEIGHT]), `${name}: ${text(boxes)}`);
    }
});

// Panels of a captured window by label, and hover points with the label of the panel each must offer: first the
// panel or a row or item inside it, and the panel itself as scrolling widens the box.
function checkCapture(name, panels, hovers) {
    const boxes = found('regions', `elements/${name}`, 1.25);
    for (const [label, rect] of Object.entries(panels))
        assert.ok(outlined(boxes, rect), `${label} ${text(rect)} missing from ${text(boxes)}`);
    for (const [x, y, label] of hovers) {
        const offered = around(boxes, x, y);
        assert.ok(within(offered[0], panels[label]) || outlined([offered[0]], panels[label]),
            `${label}: ${text(offered[0])} at ${x},${y} reaches outside it`);
        assert.ok(outlined(offered, panels[label]), `${label} not offered at ${x},${y}: ${text(offered)}`);
    }
}

test('regions: a dark editor upscaled by the compositor', () => {
    checkCapture('ide-xwayland-1.25.png', {
        'title bar': [0, 37, 1536, 30], 'activity bar': [0, 67, 48, 839], 'sidebar': [48, 67, 260, 839],
        'tab strip': [308, 67, 1228, 35], 'editor': [308, 124, 868, 582], 'preview': [1176, 124, 360, 582],
        'terminal': [308, 706, 1228, 200], 'status bar': [0, 906, 1536, 22], 'card': [1197, 376, 319, 62],
        'photo': [1197, 204, 300, 160],
    }, [
        // In the sidebar's empty part, on the editor's current line and its selected text, and in the photo.
        [178, 740, 'sidebar'], [900, 380, 'editor'], [630, 380, 'editor'], [800, 600, 'editor'],
        [1350, 280, 'photo'], [1350, 600, 'preview'], [1000, 820, 'terminal'], [768, 917, 'status bar'],
    ]);
});

test('regions: a captured settings window', () => {
    checkCapture('settings-dark-1.25.png', {
        'sidebar': [0, 0, 245, 640], 'content': [245, 0, 735, 640], 'first card': [333, 124, 559, 109],
        'second card': [333, 329, 559, 109], 'third card': [333, 516, 559, 109], 'selected row': [5, 356, 235, 44],
    }, [
        // Beside the sidebar's rows and between its separators, on the selected row, and on the page behind the cards.
        [242, 300, 'sidebar'], [120, 60, 'sidebar'], [120, 378, 'selected row'], [290, 300, 'content'],
        [400, 78, 'content'],
    ]);
});

test('regions: a page with another window over its side keeps its photo', () => {
    // A dark page with a photo on it, and a window lying over the page's right side across half its height.
    const [width, height] = [800, 600];
    const values = new Uint8Array(width * height).fill(90);
    const fill = ([x, y, w, h], value) => {
        for (let row = y; row < y + h; row++)
            values.fill(value, row * width + x, row * width + x + w);
    };
    fill([20, 20, 600, 500], 30);
    for (let row = 150; row < 400; row++) {
        for (let column = 200; column < 400; column++)
            values[row * width + column] = (row + column) % 2 ? 100 : 180;
    }
    fill([560, 120, 220, 260], 150);
    const boxes = detectRegions(values, width, height, 1, [0, 0]);
    assert.ok(near(boxes, [200, 150, 200, 250]), `photo missing from ${text(boxes)}`);
    assert.ok(near(boxes, [20, 20, 540, 500]), `page missing from ${text(boxes)}`);
    assert.ok(near(boxes, [560, 120, 220, 260]), `window missing from ${text(boxes)}`);
});
