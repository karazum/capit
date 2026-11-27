// SPDX-License-Identifier: GPL-3.0-or-later

// Source-image coordinates are stage logical coordinates. No Shell/DOM imports.
export function rectBetween(a, b) {
    return {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
    };
}

export function clampRect(rect, bounds) {
    const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - 1));
    const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - 1));
    return {
        x, y, width: Math.max(1, Math.min(rect.x + rect.width, bounds.x + bounds.width) - x),
        height: Math.max(1, Math.min(rect.y + rect.height, bounds.y + bounds.height) - y),
    };
}

export function contains(rect, point) {
    return point.x >= rect.x && point.y >= rect.y &&
        point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function encloses(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

// Smart boxes under point, from the whole window inward: the window, then each detected panel containing point,
// largest first. Panels come from splitting the window recursively, so the ones around a point nest.
export function boxesAt(window, panels, point) {
    const area = rect => rect.width * rect.height;
    return [window, ...panels.filter(panel => contains(panel, point)).sort((a, b) => area(b) - area(a))];
}

export function pixelRect(rect, scale, width, height) {
    const x = Math.max(0, Math.floor(rect.x * scale));
    const y = Math.max(0, Math.floor(rect.y * scale));
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * scale));
    const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scale));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y)};
}

// Smallest rectangle covering both; either may be null.
export function unionRect(a, b) {
    if (!a || !b)
        return a ?? b ?? null;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

// Overlap of two rectangles, or null when either is null or they do not overlap.
export function intersectRect(a, b) {
    if (!a || !b)
        return null;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    return width > 0 && height > 0 ? {x, y, width, height} : null;
}

// The area (e.g. a monitor) sharing the most surface with rect; the first one when none overlap it.
export function mostOverlapping(areas, rect) {
    const overlap = area => {
        const shared = intersectRect(area, rect);
        return shared ? shared.width * shared.height : 0;
    };
    return areas.reduce((best, area) => overlap(area) > overlap(best) ? area : best, areas[0]);
}

// Slides rect, keeping its size, until it lies inside bounds; one larger than bounds keeps its top-left inside.
export function fitInside(rect, bounds) {
    return {
        ...rect, x: Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - rect.width)),
        y: Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - rect.height)),
    };
}

/**
 * Top-left for a box of `size` beside `rect` inside `bounds`: `below` under it when that fits, else `above` over
 * it, centred on rect and slid sideways to stay whole; null when neither side has room.
 * besideRect({x: 100, y: 100, width: 400, height: 200}, {width: 300, height: 40}, monitor, 12, 12)
 *   => {x: 150, y: 312}
 */
export function besideRect(rect, size, bounds, below, above) {
    const x = Math.max(bounds.x, Math.min(rect.x + (rect.width - size.width) / 2,
        bounds.x + bounds.width - size.width));
    const under = rect.y + rect.height + below;
    if (under + size.height <= bounds.y + bounds.height)
        return {x, y: under};
    const over = rect.y - above - size.height;
    return over >= bounds.y ? {x, y: over} : null;
}

/**
 * `rect` moved the least distance straight up, down, left or right to stand `gap` clear of `obstacle` and inside
 * `bounds`; `rect` itself when it is already clear, or when no such move fits.
 * clearOf({x: 40, y: 150, width: 50, height: 130}, {x: 0, y: 260, width: 600, height: 50}, monitor, 12)
 *   => {x: 40, y: 118, width: 50, height: 130}
 */
export function clearOf(rect, obstacle, bounds, gap) {
    if (!obstacle || rect.x >= obstacle.x + obstacle.width + gap || obstacle.x >= rect.x + rect.width + gap ||
        rect.y >= obstacle.y + obstacle.height + gap || obstacle.y >= rect.y + rect.height + gap)
        return rect;
    const moves = [
        {...rect, y: obstacle.y - gap - rect.height}, {...rect, y: obstacle.y + obstacle.height + gap},
        {...rect, x: obstacle.x - gap - rect.width}, {...rect, x: obstacle.x + obstacle.width + gap},
    ].filter(moved => encloses(bounds, moved));
    const distance = moved => Math.abs(moved.x - rect.x) + Math.abs(moved.y - rect.y);
    return moves.sort((a, b) => distance(a) - distance(b))[0] ?? rect;
}

/**
 * The large panels of a window, largest first, each with how many of the others enclose it: the regions offered
 * whole before a click picks the innermost box. A panel counts when it is at least `minimum` in size and `share` of
 * the window's area; one covering the whole window repeats the window and does not.
 * largeRegions({x: 0, y: 0, width: 1000, height: 800}, [{x: 0, y: 40, width: 260, height: 760}, ...])
 *   => [{rect: {x: 0, y: 40, width: 260, height: 760}, depth: 0}, ...]
 */
export function largeRegions(window, panels, minimum = {width: 160, height: 120}, share = 0.03, limit = 12) {
    const area = rect => rect.width * rect.height;
    const large = panels.filter(panel => panel.width >= minimum.width && panel.height >= minimum.height &&
        area(panel) >= share * area(window) && !encloses(panel, window))
        .sort((a, b) => area(b) - area(a)).slice(0, limit);
    return large.map((rect, index) => ({rect, depth: large.slice(0, index).filter(other => encloses(other, rect)).length}));
}

/**
 * The rectangle a large region's outline is drawn on: `inset` pixels further inside the region for each level of
 * nesting, plus one, so that regions sharing an edge still show an outline each.
 * regionOutline({rect: {x: 0, y: 40, width: 260, height: 760}, depth: 1}, 4) => {x: 5, y: 45, width: 250, height: 750}
 */
export function regionOutline({rect, depth}, inset) {
    const offset = depth * inset + 1;
    return {x: rect.x + offset, y: rect.y + offset, width: rect.width - 2 * offset, height: rect.height - 2 * offset};
}

/**
 * The region, of those largeRegions gives, whose drawn outline passes within `reach` pixels of point, or null. Where
 * the outlines of nested regions run close together, the nearest one is under the pointer.
 * @returns {?{x: number, y: number, width: number, height: number}} the region's rect
 */
export function regionAtOutline(regions, point, inset, reach) {
    let best = null;
    let bestDistance = Infinity;
    for (const region of regions) {
        const outline = regionOutline(region, inset);
        const dx = Math.max(outline.x - point.x, 0, point.x - outline.x - outline.width);
        const dy = Math.max(outline.y - point.y, 0, point.y - outline.y - outline.height);
        const distance = dx || dy ? Math.hypot(dx, dy)
            : Math.min(point.x - outline.x, outline.x + outline.width - point.x, point.y - outline.y,
                outline.y + outline.height - point.y);
        if (distance <= reach && distance < bestDistance) {
            best = region.rect;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * Top-left for a box of `size` at the side of `rect`, vertically centred on it and kept inside `bounds`: left of it
 * when that fits, else right of it, else just inside its left edge, for a region filling its monitor.
 * sideOfRect({x: 100, y: 100, width: 400, height: 200}, {width: 40, height: 120}, monitor, 12)
 *   => {x: 48, y: 140}
 */
export function sideOfRect(rect, size, bounds, gap) {
    const y = Math.max(bounds.y, Math.min(rect.y + (rect.height - size.height) / 2,
        bounds.y + bounds.height - size.height));
    const left = rect.x - gap - size.width;
    if (left >= bounds.x)
        return {x: left, y};
    const right = rect.x + rect.width + gap;
    if (right + size.width <= bounds.x + bounds.width)
        return {x: right, y};
    return {x: Math.max(bounds.x, rect.x) + gap, y};
}

/**
 * Top-left for a box of `size` wholly outside `rect` and inside `bounds`: below it, else above, else right of it,
 * else left of it, `gap` away; null when no side has room.
 * outsideRect({x: 100, y: 100, width: 400, height: 300}, {width: 200, height: 40}, monitor, 12)
 *   => {x: 200, y: 412}
 */
export function outsideRect(rect, size, bounds, gap) {
    const beside = besideRect(rect, size, bounds, gap, gap);
    if (beside)
        return beside;
    const y = Math.max(bounds.y, Math.min(rect.y + (rect.height - size.height) / 2,
        bounds.y + bounds.height - size.height));
    if (y + size.height > bounds.y + bounds.height)
        return null;
    const right = rect.x + rect.width + gap;
    if (right + size.width <= bounds.x + bounds.width)
        return {x: right, y};
    const left = rect.x - gap - size.width;
    return left >= bounds.x ? {x: left, y} : null;
}

// Grows a rectangle outward so every edge lands on a multiple of grid.
export function snapRect(rect, grid) {
    const x = Math.floor(rect.x / grid) * grid;
    const y = Math.floor(rect.y / grid) * grid;
    return {
        x, y, width: Math.ceil((rect.x + rect.width) / grid) * grid - x,
        height: Math.ceil((rect.y + rect.height) / grid) * grid - y,
    };
}

/**
 * Splits the area around an outline into strips, so drawing the outline never repaints the region inside it.
 * The strips reach `margin` either side of each edge, also cover an optional label box, never overlap (a
 * translucent label would otherwise be blended twice), and have edges on multiples of `grid`.
 * @returns {Array<{x, y, width, height}>} [top, bottom, left, right]; an unneeded strip has no area.
 */
export function outlineBands(outline, margin, grid, label = null) {
    const down = value => Math.floor(value / grid) * grid;
    const up = value => Math.ceil(value / grid) * grid;
    const left = down(outline.x - margin);
    const right = up(outline.x + outline.width + margin);
    const top = down(Math.min(outline.y - margin, label?.y ?? Infinity));
    const topEnd = up(Math.max(outline.y + margin, label ? label.y + label.height : -Infinity));
    const topRight = up(Math.max(outline.x + outline.width + margin, label ? label.x + label.width : -Infinity));
    const bottom = up(outline.y + outline.height + margin);
    const bottomStart = Math.max(topEnd, down(outline.y + outline.height - margin));
    const innerLeft = up(outline.x + margin);
    const innerRight = Math.max(innerLeft, down(outline.x + outline.width - margin));
    return [
        {x: left, y: top, width: topRight - left, height: topEnd - top},
        {x: left, y: bottomStart, width: right - left, height: bottom - bottomStart},
        {x: left, y: topEnd, width: innerLeft - left, height: bottomStart - topEnd},
        {x: innerRight, y: topEnd, width: right - innerRight, height: bottomStart - topEnd},
    ];
}

const TEXT_SIZE = 24;

// Bounding box of an annotation. Text carries its measured width because measuring needs a drawing context.
export function opBounds(op) {
    if (op.kind === 'text')
        return {x: op.x1, y: op.y1, width: op.textWidth ?? 0, height: (op.size ?? TEXT_SIZE) * 1.25};
    return rectBetween({x: op.x1, y: op.y1}, {x: op.x2, y: op.y2});
}

// Draggable resize points: the two endpoints of an arrow, the corners of a box, the far corner of text.
export function opHandles(op) {
    if (op.kind === 'arrow')
        return [['p1', op.x1, op.y1], ['p2', op.x2, op.y2]];
    const b = opBounds(op);
    if (op.kind === 'text')
        return [['se', b.x + b.width, b.y + b.height]];
    return [['nw', b.x, b.y], ['ne', b.x + b.width, b.y], ['sw', b.x, b.y + b.height], ['se', b.x + b.width, b.y + b.height]];
}

export function opHandleAt(op, point, radius = 10) {
    const hit = opHandles(op).find(([, x, y]) => Math.abs(point.x - x) <= radius && Math.abs(point.y - y) <= radius);
    return hit ? hit[0] : null;
}

function segmentDistance(point, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / length));
    return Math.hypot(point.x - (x1 + t * dx), point.y - (y1 + t * dy));
}

// Approximate distance from point to the outline of the ellipse inscribed in box b, measured along the line from
// its centre: exact on a circle, close enough on an ellipse for picking it up by its edge.
function ellipseEdgeDistance(b, point) {
    const rx = b.width / 2;
    const ry = b.height / 2;
    const dx = point.x - (b.x + rx);
    const dy = point.y - (b.y + ry);
    const reach = Math.hypot(dx, dy);
    if (rx === 0 || ry === 0)
        return segmentDistance(point, b.x, b.y, b.x + b.width, b.y + b.height);
    const scaled = Math.hypot(dx / rx, dy / ry);
    return scaled === 0 ? Math.min(rx, ry) : reach * Math.abs(1 - 1 / scaled);
}

function insideEllipse(b, point) {
    const rx = b.width / 2;
    const ry = b.height / 2;
    return rx > 0 && ry > 0 && Math.hypot((point.x - b.x - rx) / rx, (point.y - b.y - ry) / ry) <= 1;
}

// Boxes hit anywhere inside, ellipses inside or near their outline, arrows near the line, brush strokes near the
// stroke itself.
export function opHit(op, point, tolerance = 8) {
    if (op.kind === 'ellipse') {
        const b = opBounds(op);
        return insideEllipse(b, point) || ellipseEdgeDistance(b, point) <= tolerance;
    }
    if (op.kind === 'arrow')
        return segmentDistance(point, op.x1, op.y1, op.x2, op.y2) <= tolerance;
    if (op.kind === 'brush') {
        const reach = tolerance + (op.width ?? 3) / 2;
        const points = op.points;
        return points.some((current, index) => {
            const next = points[Math.min(index + 1, points.length - 1)];
            return segmentDistance(point, current[0], current[1], next[0], next[1]) <= reach;
        });
    }
    return contains(opBounds(op), point);
}

// Like opHit, but a box counts only near its outline, not anywhere inside it; lines and text hit as in opHit.
export function opEdgeHit(op, point, tolerance = 8) {
    if (op.kind === 'arrow' || op.kind === 'brush' || op.kind === 'text')
        return opHit(op, point, tolerance);
    const b = opBounds(op);
    if (op.kind === 'ellipse')
        return ellipseEdgeDistance(b, point) <= tolerance;
    const outer = {x: b.x - tolerance, y: b.y - tolerance, width: b.width + 2 * tolerance, height: b.height + 2 * tolerance};
    const inner = {x: b.x + tolerance, y: b.y + tolerance, width: b.width - 2 * tolerance, height: b.height - 2 * tolerance};
    return contains(outer, point) && !(inner.width > 0 && inner.height > 0 && contains(inner, point));
}

/**
 * A freehand brush stroke through `points`; x1/y1/x2/y2 hold its bounding box, which moving and resizing
 * work on like any box.
 * brushOp([[10, 20], [30, 5]], '#ff595e', 4) => {kind: 'brush', points, x1: 10, y1: 5, x2: 30, y2: 20, ...}
 */
export function brushOp(points, color, width) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return {
        kind: 'brush', points, x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs),
        y2: Math.max(...ys), color, width,
    };
}

/**
 * The far corner of a box dragged from `start` to `point`, made square on the longer side, so an ellipse drawn in
 * it is a circle. The corner stays on the pointer's side of `start`.
 * squareCorner({x: 10, y: 10}, {x: 40, y: 0}) => {x: 40, y: -20}
 */
export function squareCorner(start, point) {
    const side = Math.max(Math.abs(point.x - start.x), Math.abs(point.y - start.y));
    return {x: start.x + (point.x < start.x ? -side : side), y: start.y + (point.y < start.y ? -side : side)};
}

export function moveOp(op, dx, dy) {
    const moved = {...op, x1: op.x1 + dx, y1: op.y1 + dy};
    if (op.kind === 'brush')
        moved.points = op.points.map(([x, y]) => [x + dx, y + dy]);
    if (op.kind !== 'text') {
        moved.x2 = op.x2 + dx;
        moved.y2 = op.y2 + dy;
    }
    return moved;
}

export function resizeOp(op, handle, point) {
    if (op.kind === 'text') {
        const size = Math.max(8, Math.min(400, (op.size ?? TEXT_SIZE) * Math.max(0.2, (point.x - op.x1) / (op.textWidth || 1))));
        return {...op, size, textWidth: (op.textWidth ?? 0) * size / (op.size ?? TEXT_SIZE)};
    }
    if (op.kind === 'arrow')
        return handle === 'p1' ? {...op, x1: point.x, y1: point.y} : {...op, x2: point.x, y2: point.y};
    const b = opBounds(op);
    const corner = {x: handle.includes('w') ? b.x + b.width : b.x, y: handle.includes('n') ? b.y + b.height : b.y};
    if (op.kind === 'brush') {
        // The stroke stretches with its box, mirrored when dragged past the opposite corner. A flat side (a
        // straight horizontal or vertical stroke) has nothing to stretch, so it keeps its place on that axis.
        const map = (value, from, to, start, end) => to === from ? value
            : start + (value - from) * (end - start) / (to - from);
        const [fromX, toX] = handle.includes('w') ? [b.x + b.width, b.x] : [b.x, b.x + b.width];
        const [fromY, toY] = handle.includes('n') ? [b.y + b.height, b.y] : [b.y, b.y + b.height];
        return {
            ...op, ...brushOp(op.points.map(([x, y]) => [map(x, fromX, toX, corner.x, point.x),
                map(y, fromY, toY, corner.y, point.y)]), op.color, op.width),
        };
    }
    return {...op, x1: corner.x, y1: corner.y, x2: point.x, y2: point.y};
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export class Document {
    constructor(bounds) {
        this.bounds = {...bounds};
        this.selection = null;
        this.annotations = [];
        this.revision = 0;
        this._undo = [];
        this._redo = [];
    }

    _snapshot() {
        return clone({selection: this.selection, annotations: this.annotations});
    }

    _change() {
        this._undo.push(this._snapshot());
        this._redo = [];
        this.revision++;
    }

    select(rect) {
        this._change();
        this.selection = clampRect(rect, this.bounds);
    }

    // Clears the chosen region, as one undoable change. Its annotations stay, and show again with the next region.
    deselect() {
        if (!this.selection)
            return;
        this._change();
        this.selection = null;
    }

    annotate(operation) {
        if (!this.selection)
            throw new Error('Choose a region first');
        this._change();
        this.annotations.push(clone(operation));
    }

    // merge: fold this change into the previous one, so a single undo reverts both; for a run of small steps
    // such as wheel notches. The caller decides that the previous change was the same kind of step.
    replace(index, operation, merge = false) {
        if (!this.annotations[index])
            throw new Error('No such annotation');
        if (merge && this._undo.length) {
            this._redo = [];
            this.revision++;
        } else {
            this._change();
        }
        this.annotations[index] = clone(operation);
    }

    remove(index) {
        if (!this.annotations[index])
            throw new Error('No such annotation');
        this._change();
        this.annotations.splice(index, 1);
    }

    undo() {
        if (!this._undo.length)
            return false;
        this._redo.push(this._snapshot());
        Object.assign(this, this._undo.pop());
        this.revision++;
        return true;
    }

    redo() {
        if (!this._redo.length)
            return false;
        this._undo.push(this._snapshot());
        Object.assign(this, this._redo.pop());
        this.revision++;
        return true;
    }
}
