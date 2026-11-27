// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    Document, pixelRect, rectBetween, clampRect, moveOp, resizeOp, opHit, opHandleAt, unionRect, intersectRect,
    snapRect, outlineBands, mostOverlapping, fitInside, encloses, boxesAt, besideRect, sideOfRect, outsideRect, brushOp, opEdgeHit,
    squareCorner, clearOf, largeRegions, regionAtOutline,
} from '../extension/model.js';

test('a selection crossing 125% and 100% displays stays in one logical coordinate space', () => {
    const rect = rectBetween({x: 4900, y: 2300}, {x: 2850, y: 1050});
    assert.deepEqual(rect, {x: 2850, y: 1050, width: 2050, height: 1250});
    const pixels = pixelRect(rect, 2, 13312, 6336);
    assert.deepEqual(pixels, {x: 5700, y: 2100, width: 4100, height: 2500});
});

test('fractional crop rounding includes the selected pixels without exceeding the texture', () => {
    assert.deepEqual(pixelRect({x: 1.1, y: 2.2, width: 10.4, height: 20.4}, 1.25, 100, 100),
        {x: 1, y: 2, width: 14, height: 27});
    assert.deepEqual(pixelRect({x: 79, y: 79, width: 1, height: 1}, 1.25, 100, 100),
        {x: 98, y: 98, width: 2, height: 2});
});

test('moving the crop never moves a redaction away from its source pixels', () => {
    const doc = new Document({x: 0, y: 0, width: 6656, height: 3168});
    doc.select({x: 100, y: 50, width: 500, height: 400});
    const operation = {kind: 'redact', x1: 120, y1: 80, x2: 180, y2: 100};
    doc.annotate(operation);
    operation.x1 = 999; // Caller mutation must not alter the document.
    doc.select({x: 110, y: 60, width: 500, height: 400});
    assert.equal(doc.annotations[0].x1, 120);
    assert.equal(doc.annotations[0].y1, 80);
    assert.equal(doc.selection.x, 110);
    assert.equal(doc.undo(), true);
    assert.equal(doc.selection.x, 100);
    assert.equal(doc.annotations[0].x1, 120);
    assert.equal(doc.redo(), true);
    assert.equal(doc.selection.x, 110);
});

test('undo/redo revisions cannot reuse an exported artifact identity', () => {
    const doc = new Document({x: 0, y: 0, width: 100, height: 100});
    doc.select({x: 5, y: 5, width: 50, height: 50});
    doc.annotate({kind: 'rectangle', x1: 10, y1: 10, x2: 20, y2: 20});
    const revision = doc.revision;
    doc.undo();
    assert.ok(doc.revision > revision);
    assert.equal(doc.annotations.length, 0);
    doc.redo();
    assert.ok(doc.revision > revision + 1);
    assert.equal(doc.annotations.length, 1);
    doc.undo();
    doc.annotate({kind: 'text', x1: 15, y1: 15, text: 'New revision'});
    assert.equal(doc.redo(), false);
    assert.equal(doc.annotations[0].kind, 'text');
});

test('resizing beyond the stage clamps the output instead of requesting invalid texture pixels', () => {
    assert.deepEqual(clampRect({x: 6500, y: 3000, width: 400, height: 600},
        {x: 0, y: 0, width: 6656, height: 3168}),
    {x: 6500, y: 3000, width: 156, height: 168});
});

test('smart windows partly outside the stage select only their visible source area', () => {
    assert.deepEqual(clampRect({x: -50, y: -20, width: 200, height: 100},
        {x: 0, y: 0, width: 1920, height: 1080}),
    {x: 0, y: 0, width: 150, height: 80});
});

test('smart boxes under the pointer run from the window inward to the smallest panel', () => {
    const window = {x: 0, y: 0, width: 1200, height: 800};
    const body = {x: 0, y: 40, width: 1200, height: 760};
    const sidebar = {x: 0, y: 40, width: 260, height: 760};
    const item = {x: 0, y: 80, width: 260, height: 30};
    const editor = {x: 261, y: 40, width: 939, height: 760};
    // Detection order is not size order; nothing outside the pointer is offered.
    const boxes = boxesAt(window, [item, editor, body, sidebar], {x: 100, y: 90});
    assert.deepEqual(boxes, [window, body, sidebar, item]);
    assert.equal(boxes[2], sidebar, 'boxes keep the panel objects, so hover changes compare by identity');
    assert.deepEqual(boxesAt(window, [], {x: 5, y: 5}), [window]);
});

test('a window inside one stacked above it is hidden', () => {
    assert.equal(encloses({x: 0, y: 0, width: 1920, height: 1080}, {x: 100, y: 100, width: 800, height: 600}), true);
    assert.equal(encloses({x: 0, y: 0, width: 1920, height: 1080}, {x: 1500, y: 100, width: 800, height: 600}), false);
});

test('a drawn element can be moved and resized, each as one undoable change', () => {
    const doc = new Document({x: 0, y: 0, width: 500, height: 500});
    doc.select({x: 100, y: 100, width: 200, height: 200});
    doc.annotate({kind: 'rectangle', x1: 150, y1: 150, x2: 200, y2: 180});
    const moved = moveOp(doc.annotations[0], 10, -5);
    doc.replace(0, moved);
    assert.deepEqual([moved.x1, moved.y1, moved.x2, moved.y2], [160, 145, 210, 175]);
    const resized = resizeOp(doc.annotations[0], 'se', {x: 260, y: 200});
    doc.replace(0, resized);
    assert.deepEqual([resized.x1, resized.y1, resized.x2, resized.y2], [160, 145, 260, 200]);
    doc.undo();
    assert.equal(doc.annotations[0].x2, 210);
});

test('resizing from a flipped rectangle keeps the opposite corner fixed', () => {
    const op = {kind: 'rectangle', x1: 200, y1: 180, x2: 150, y2: 150};
    const resized = resizeOp(op, 'nw', {x: 120, y: 100});
    assert.deepEqual([resized.x1, resized.y1, resized.x2, resized.y2], [200, 180, 120, 100]);
});

test('arrows hit on the line and expose endpoint handles; text scales from its corner', () => {
    const arrow = {kind: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0};
    assert.equal(opHit(arrow, {x: 50, y: 5}), true);
    assert.equal(opHit(arrow, {x: 50, y: 20}), false);
    assert.equal(opHandleAt(arrow, {x: 98, y: 2}), 'p2');
    const text = {kind: 'text', x1: 10, y1: 10, text: 'hi', size: 24, textWidth: 40};
    const bigger = resizeOp(text, 'se', {x: 90, y: 0});
    assert.equal(bigger.size, 48);
    assert.equal(bigger.textWidth, 80);
});

test('overlay patches cover only the union or overlap they are asked for', () => {
    assert.deepEqual(unionRect({x: 10, y: 10, width: 10, height: 10}, {x: 30, y: 0, width: 5, height: 5}),
        {x: 10, y: 0, width: 25, height: 20});
    assert.deepEqual(unionRect(null, {x: 1, y: 2, width: 3, height: 4}), {x: 1, y: 2, width: 3, height: 4});
    assert.equal(unionRect(null, null), null);
    assert.deepEqual(intersectRect({x: 0, y: 0, width: 100, height: 100}, {x: 90, y: -10, width: 50, height: 30}),
        {x: 90, y: 0, width: 10, height: 20});
    assert.equal(intersectRect({x: 0, y: 0, width: 10, height: 10}, {x: 10, y: 0, width: 5, height: 5}), null);
    assert.equal(intersectRect(null, {x: 0, y: 0, width: 1, height: 1}), null);
});

test('snapping grows a patch outward onto whole device pixels at 125%', () => {
    const snapped = snapRect({x: 13.5, y: -3, width: 10, height: 7}, 4);
    assert.deepEqual(snapped, {x: 12, y: -4, width: 12, height: 8});
    for (const value of Object.values(snapped))
        assert.equal(Number.isInteger(value * 1.25), true);
});

function inside(rect, point) {
    return rect.width > 0 && rect.height > 0 && point.x >= rect.x && point.x < rect.x + rect.width &&
        point.y >= rect.y && point.y < rect.y + rect.height;
}

test('outline strips cover the dashed edge, handles and label without overlapping or filling the region', () => {
    const cases = [
        [{x: 300, y: 200, width: 4096, height: 1728}, {x: 300, y: 178, width: 230, height: 20}],
        [{x: 5, y: 3, width: 40, height: 9}, {x: 5, y: 3, width: 230, height: 20}],
        [{x: 1000, y: 1000, width: 2, height: 2}, null],
    ];
    for (const [outline, label] of cases) {
        const bands = outlineBands(outline, 6, 4, label);
        for (const band of bands) {
            for (const value of Object.values(band))
                assert.ok(value % 4 === 0, `${JSON.stringify(band)} is off the device-pixel grid`);
        }
        const covered = point => bands.filter(band => inside(band, point)).length;
        const right = outline.x + outline.width;
        const bottom = outline.y + outline.height;
        for (let t = 0; t <= 1; t += 1 / 64) {
            for (const offset of [-5.5, 0, 5.5]) {
                const x = outline.x + t * outline.width;
                const y = outline.y + t * outline.height;
                for (const point of [{x, y: outline.y + offset}, {x, y: bottom + offset},
                    {x: outline.x + offset, y}, {x: right + offset, y}])
                    assert.equal(covered(point), 1, `${JSON.stringify(point)} of ${JSON.stringify(outline)}`);
            }
        }
        if (label) {
            for (const point of [{x: label.x, y: label.y}, {x: label.x + label.width - 0.5, y: label.y + label.height - 0.5}])
                assert.equal(covered(point), 1, `label corner ${JSON.stringify(point)}`);
        }
    }
    const big = {x: 300, y: 200, width: 4096, height: 1728};
    const area = outlineBands(big, 6, 4, {x: 300, y: 178, width: 230, height: 20})
        .reduce((sum, band) => sum + Math.max(0, band.width) * Math.max(0, band.height), 0);
    assert.ok(area < big.width * big.height * 0.05, `strips repaint ${area} px of a ${big.width * big.height} px region`);
});

test('a dragged toolbar belongs to the monitor it mostly covers and is slid back whole onto it', () => {
    const left = {x: 0, y: 0, width: 1280, height: 720};
    const right = {x: 1280, y: 0, width: 1024, height: 768};
    assert.equal(mostOverlapping([left, right], {x: 1100, y: 250, width: 400, height: 250}), right);
    assert.equal(mostOverlapping([left, right], {x: 1000, y: 600, width: 400, height: 60}), left);
    assert.equal(mostOverlapping([left, right], {x: 5000, y: 5000, width: 10, height: 10}), left);
    const bar = {x: 1900, y: 740, width: 700, height: 60};
    assert.deepEqual(fitInside(bar, right), {x: 1604, y: 708, width: 700, height: 60});
    assert.deepEqual(fitInside({...bar, x: -40, y: -10}, left), {x: 0, y: 0, width: 700, height: 60});
    assert.deepEqual(fitInside({...bar, x: 1300, y: 100}, right), {...bar, x: 1300, y: 100});
    assert.deepEqual(fitInside({x: 50, y: 50, width: 2000, height: 60}, left), {x: 0, y: 50, width: 2000, height: 60});
});

test('the toolbar sits under the region, over it when the bottom has no room, and nowhere when neither has', () => {
    const monitor = {x: 1280, y: 0, width: 1024, height: 768};
    const size = {width: 300, height: 40};
    assert.deepEqual(besideRect({x: 1500, y: 100, width: 400, height: 200}, size, monitor, 12, 34), {x: 1550, y: 312});
    assert.deepEqual(besideRect({x: 1500, y: 400, width: 400, height: 340}, size, monitor, 12, 34), {x: 1550, y: 326});
    // A region at the monitor's right edge keeps the whole bar on the monitor.
    assert.deepEqual(besideRect({x: 2200, y: 100, width: 104, height: 50}, size, monitor, 12, 34), {x: 2004, y: 162});
    assert.equal(besideRect({x: 1300, y: 20, width: 900, height: 740}, size, monitor, 12, 34), null);
});

test('a brush stroke is hit near its line, moves whole and stretches with its box', () => {
    const stroke = brushOp([[10, 10], [30, 30], [50, 10]], '#ff595e', 4);
    assert.deepEqual([stroke.x1, stroke.y1, stroke.x2, stroke.y2], [10, 10, 50, 30]);
    assert.ok(opHit(stroke, {x: 20, y: 22}));
    assert.ok(!opHit(stroke, {x: 30, y: 12}));
    assert.deepEqual(moveOp(stroke, 5, -5).points, [[15, 5], [35, 25], [55, 5]]);
    const wider = resizeOp(stroke, 'se', {x: 90, y: 50});
    assert.deepEqual(wider.points, [[10, 10], [50, 50], [90, 10]]);
    assert.deepEqual([wider.x1, wider.y1, wider.x2, wider.y2], [10, 10, 90, 50]);
    // Past the opposite corner the stroke mirrors; a straight stroke keeps its place on the flat axis.
    assert.deepEqual(resizeOp(stroke, 'se', {x: 0, y: 10}).points, [[10, 10], [5, 10], [0, 10]]);
    const flat = brushOp([[10, 20], [40, 20]], '#ff595e', 4);
    assert.deepEqual(resizeOp(flat, 'se', {x: 70, y: 60}).points, [[10, 20], [70, 20]]);
});

test('a drawing tool grabs a box by its outline only, so drags inside it draw', () => {
    const box = {kind: 'rectangle', x1: 100, y1: 100, x2: 300, y2: 200};
    assert.ok(opEdgeHit(box, {x: 104, y: 150}));
    assert.ok(opEdgeHit(box, {x: 200, y: 205}));
    assert.ok(!opEdgeHit(box, {x: 200, y: 150}));
    assert.ok(!opEdgeHit(box, {x: 320, y: 150}));
    // A box too small to have an inside is grabbed anywhere on it.
    assert.ok(opEdgeHit({kind: 'blur', x1: 0, y1: 0, x2: 10, y2: 10}, {x: 5, y: 5}));
});

test('mode buttons sit left of the region, else right of it, else inside it', () => {
    const monitor = {x: 0, y: 0, width: 1920, height: 1080};
    const size = {width: 40, height: 120};
    assert.deepEqual(sideOfRect({x: 100, y: 100, width: 400, height: 200}, size, monitor, 12), {x: 48, y: 140});
    assert.deepEqual(sideOfRect({x: 20, y: 100, width: 400, height: 200}, size, monitor, 12), {x: 432, y: 140});
    assert.deepEqual(sideOfRect(monitor, size, monitor, 12), {x: 12, y: 480});
    // A short region near the bottom keeps the buttons on the monitor.
    assert.deepEqual(sideOfRect({x: 300, y: 1050, width: 100, height: 30}, size, monitor, 12), {x: 248, y: 960});
    // On a second monitor, the left side is measured from that monitor's edge.
    const second = {x: 1920, y: 0, width: 1280, height: 1024};
    assert.deepEqual(sideOfRect({x: 1940, y: 0, width: 1260, height: 1024}, size, second, 12), {x: 1952, y: 452});
});

test('the recording bar goes below, above, right or left of the recorded area, or nowhere', () => {
    const monitor = {x: 0, y: 0, width: 1280, height: 720};
    const size = {width: 200, height: 40};
    assert.deepEqual(outsideRect({x: 100, y: 100, width: 400, height: 300}, size, monitor, 12), {x: 200, y: 412});
    assert.deepEqual(outsideRect({x: 100, y: 400, width: 400, height: 320}, size, monitor, 12), {x: 200, y: 348});
    assert.deepEqual(outsideRect({x: 0, y: 0, width: 900, height: 720}, size, monitor, 12), {x: 912, y: 340});
    assert.deepEqual(outsideRect({x: 300, y: 0, width: 980, height: 720}, size, monitor, 12), {x: 88, y: 340});
    assert.equal(outsideRect(monitor, size, monitor, 12), null);
});

test('a circle is hit inside or near its outline, and a drawing tool grabs it by the outline only', () => {
    const circle = {kind: 'ellipse', x1: 100, y1: 100, x2: 300, y2: 200};
    assert.ok(opHit(circle, {x: 200, y: 150}));
    assert.ok(opHit(circle, {x: 305, y: 150}));
    // The corners of its box are outside the ellipse.
    assert.ok(!opHit(circle, {x: 104, y: 104}));
    assert.ok(!opEdgeHit(circle, {x: 104, y: 104}));
    assert.ok(opEdgeHit(circle, {x: 200, y: 103}));
    assert.ok(opEdgeHit(circle, {x: 96, y: 150}));
    assert.ok(!opEdgeHit(circle, {x: 200, y: 150}));
    // A flat one is a line.
    assert.ok(opEdgeHit({kind: 'ellipse', x1: 0, y1: 50, x2: 100, y2: 50}, {x: 50, y: 54}));
});

test('Shift squares the box a circle is drawn in, toward the pointer', () => {
    assert.deepEqual(squareCorner({x: 10, y: 10}, {x: 40, y: 0}), {x: 40, y: -20});
    assert.deepEqual(squareCorner({x: 10, y: 10}, {x: 0, y: 50}), {x: -30, y: 50});
    assert.deepEqual(squareCorner({x: 10, y: 10}, {x: 10, y: 10}), {x: 10, y: 10});
});

test('a merged replace joins the previous change, so one undo reverts a run of steps', () => {
    const doc = new Document({x: 0, y: 0, width: 400, height: 400});
    doc.select({x: 0, y: 0, width: 400, height: 400});
    doc.annotate({kind: 'rectangle', x1: 10, y1: 10, x2: 20, y2: 20, width: 4});
    doc.replace(0, {...doc.annotations[0], width: 5});
    doc.replace(0, {...doc.annotations[0], width: 6}, true);
    doc.replace(0, {...doc.annotations[0], width: 7}, true);
    assert.equal(doc.annotations[0].width, 7);
    doc.undo();
    assert.equal(doc.annotations[0].width, 4);
    doc.redo();
    assert.equal(doc.annotations[0].width, 7);
});

test('a box overlapping an obstacle moves the shortest way clear of it, staying on its monitor', () => {
    const monitor = {x: 0, y: 0, width: 1920, height: 1080};
    const toolbar = {x: 0, y: 260, width: 600, height: 50};
    assert.deepEqual(clearOf({x: 40, y: 150, width: 50, height: 130}, toolbar, monitor, 12),
        {x: 40, y: 118, width: 50, height: 130});
    const apart = {x: 40, y: 50, width: 50, height: 130};
    assert.equal(clearOf(apart, toolbar, monitor, 12), apart);
    // No room above the obstacle, so the box goes below it.
    assert.deepEqual(clearOf({x: 40, y: 10, width: 50, height: 130}, {x: 0, y: 100, width: 600, height: 50},
        monitor, 12), {x: 40, y: 162, width: 50, height: 130});
});

test('large regions skip small panels and the whole window, and count what encloses each', () => {
    const window = {x: 0, y: 0, width: 1000, height: 800};
    const sidebar = {x: 0, y: 40, width: 260, height: 760};
    const tree = {x: 0, y: 80, width: 260, height: 500};
    const row = {x: 0, y: 100, width: 260, height: 30};
    const editor = {x: 260, y: 40, width: 740, height: 760};
    assert.deepEqual(largeRegions(window, [row, tree, window, editor, sidebar]),
        [{rect: editor, depth: 0}, {rect: sidebar, depth: 0}, {rect: tree, depth: 1}]);
});

test("a point on a large region's drawn outline picks that region, the nearest where nested outlines run close", () => {
    const sidebar = {x: 0, y: 40, width: 260, height: 760};
    const tree = {x: 0, y: 80, width: 260, height: 500};
    const regions = [{rect: sidebar, depth: 0}, {rect: tree, depth: 1}];
    // The sidebar's outline runs at x 1 and the tree's, a level deeper, at x 5.
    assert.equal(regionAtOutline(regions, {x: 1, y: 300}, 4, 4), sidebar);
    assert.equal(regionAtOutline(regions, {x: 6, y: 300}, 4, 4), tree);
    assert.equal(regionAtOutline(regions, {x: 130, y: 85}, 4, 4), tree);
    assert.equal(regionAtOutline(regions, {x: 130, y: 300}, 4, 4), null);
    assert.equal(regionAtOutline(regions, {x: 130, y: 600}, 4, 4), null);
});

test('deselecting clears the region as one undoable change, keeping its annotations', () => {
    const doc = new Document({x: 0, y: 0, width: 500, height: 500});
    const region = {x: 10, y: 10, width: 100, height: 80};
    doc.select(region);
    doc.annotate({kind: 'rectangle', x1: 20, y1: 20, x2: 60, y2: 60, color: 'red', width: 3});
    doc.deselect();
    assert.equal(doc.selection, null);
    assert.equal(doc.annotations.length, 1);
    const revision = doc.revision;
    doc.deselect();
    assert.equal(doc.revision, revision);
    assert.equal(doc.undo(), true);
    assert.deepEqual(doc.selection, region);
});
