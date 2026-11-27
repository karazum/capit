// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Finds panels in a window image as areas of flat background, with no imports beyond visual.js, so node can test
 * it and a `gjs` process can run it.
 *
 * A panel, card, field or bar is painted as one flat colour with text and icons on top, and is set apart from its
 * surroundings by a colour change or a border. So the image is split into connected areas of flat colour, with
 * every colour change acting as a wall. Each large area that is shaped like a rectangle is an element. So is each
 * rectangular island inside an area that the area's colour flows around, such as a card made of rows, a button,
 * or a photo: whatever it is made of, the background around it outlines it.
 *
 * The smaller marks on an area, its text and icons, are grouped into lines: each line is a row across the area, and
 * holds an item for each word or icon and for each label they make together.
 *
 * Rectangles found this way are combined with the pieces between a window's dividers, and kept so that those
 * around any point nest. Images are intensity arrays as in visual.js; rectangles are [x0, y0, x1, y1] in pixels.
 */
import {ANCHOR, Detector, roundHalfEven} from './visual.js';

// On the sum of the three channel differences, 0-765. Flat UI backgrounds are exactly flat, and a compositor-scaled
// 1 px border that differs by a few grey levels still changes by more than this from one pixel to the next.
const FLAT_THRESHOLD = 3;
// Logical pixels. Smaller areas are glyph interiors, icons, gaps between words, and the cells where lines cross.
const MIN_ELEMENT = 20;
// Pieces between dividers may be as thin as a status bar.
const MIN_PIECE = 16;
// A band thinner than a toolbar between two areas of the same colour is a highlight, such as an editor's current
// line, and does not split the panel around it.
const MIN_BAND = 28;
// Share of an element's side that the area must reach for the side to count as straight.
const SIDE_SUPPORT = 0.6;
// Areas smaller than a card, in logical pixels, need straighter sides: a patch of even colour in a photo is this
// small, and has ragged ones.
const SMALL_AREA = 64;
const SMALL_SIDE_SUPPORT = 0.75;
// Share of the lines of a bite out of a side that must stop at one straight edge, as another window's does.
const BITE_SUPPORT = 0.8;
// Share of a side's lines that must reach it beside the bites out of it.
const BITE_SIDE = 0.2;
// Share of an island's whole outline that must be straight; rounded corners and a notch leave about this much.
const OUTLINE_SUPPORT = 0.8;
// And of each side. The tops of a word's letters cover about half of the line they share.
const SIDE_OUTLINE = 0.75;
const MAX_ELEMENTS = 400;
// Rows and items are budgeted apart from panels, so an editor full of text cannot crowd panels out, nor panels them.
const MAX_FINE = 2000;
// Elements nested deeper than this are the insides of illustrations and custom-drawn widgets.
const MAX_DEPTH = 6;
// Logical pixels. An island this small that is not a rectangle is an icon or a glyph, and its parts are not elements.
const MAX_ICON = 96;
// What covers this share of a bar's length is the bar less one item at its end, such as a status bar beside its
// first indicator, and is no element of its own.
const REMAINDER = 0.9;
// Logical pixels. A mark on a panel that is smaller than this both ways, such as a full stop or a lone hyphen, is no
// item of its own.
export const MIN_ITEM = 6;
// Logical pixels. Marks taller than this are pictures rather than text or icons.
const MAX_ITEM_HEIGHT = 64;
// Logical pixels between marks of one item. Marks are measured with the border pixel the flat area gives up on each
// side, so the letters of a word touch and a word space or the gap after an icon is about 2.
const ITEM_GAP = 1;
// Logical pixels between the words of one label: a word space, or the gap between an icon and its text.
const PHRASE_GAP = 3;

/**
 * Labels the connected areas of set pixels in `mask`, a Uint8Array of width × height, joining the 4 or 8
 * neighbours of each pixel. Labels run from 1 in the order each area's first pixel comes in rows, top to bottom;
 * 0 marks unset pixels. Returns [labels as an Int32Array, the number of labels].
 */
export function label(mask, width, height, eight = false) {
    const labels = new Int32Array(width * height);
    // A new provisional label needs a pixel without a labelled neighbour, which at most every other pixel is.
    const parent = new Int32Array((width * height >> 1) + 2);
    let next = 1;
    const root = value => {
        while (parent[value] !== value) {
            parent[value] = parent[parent[value]];
            value = parent[value];
        }
        return value;
    };
    // Joins two provisional labels under the smaller root.
    const join = (a, b) => {
        a = root(a);
        b = root(b);
        if (a < b)
            parent[b] = a;
        else if (b < a)
            parent[a] = b;
    };
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            const index = row + x;
            if (!mask[index])
                continue;
            const left = x > 0 ? labels[index - 1] : 0;
            const up = y > 0 ? labels[index - width] : 0;
            const upLeft = eight && y > 0 && x > 0 ? labels[index - width - 1] : 0;
            const upRight = eight && y > 0 && x < width - 1 ? labels[index - width + 1] : 0;
            let smallest = left;
            if (up && (!smallest || up < smallest))
                smallest = up;
            if (upLeft && (!smallest || upLeft < smallest))
                smallest = upLeft;
            if (upRight && (!smallest || upRight < smallest))
                smallest = upRight;
            if (!smallest) {
                parent[next] = next;
                labels[index] = next++;
                continue;
            }
            labels[index] = smallest;
            if (left && left !== smallest)
                join(smallest, left);
            if (up && up !== smallest)
                join(smallest, up);
            if (upLeft && upLeft !== smallest)
                join(smallest, upLeft);
            if (upRight && upRight !== smallest)
                join(smallest, upRight);
        }
    }
    // A merged area takes the smallest provisional label it holds, which its first pixel created.
    const final = new Int32Array(next);
    let count = 0;
    for (let value = 1; value < next; value++)
        final[value] = root(value) === value ? ++count : final[root(value)];
    for (let index = 0; index < labels.length; index++)
        labels[index] = final[labels[index]];
    return [labels, count];
}

// The bounding box of each label, index label - 1, as {x0, y0, x1, y1}.
function boundingBoxes(labels, width, height, count) {
    const x0 = new Int32Array(count + 1).fill(width);
    const y0 = new Int32Array(count + 1).fill(height);
    const x1 = new Int32Array(count + 1);
    const y1 = new Int32Array(count + 1);
    for (let y = 0, index = 0; y < height; y++) {
        for (let x = 0; x < width; x++, index++) {
            const value = labels[index];
            if (!value)
                continue;
            if (x < x0[value])
                x0[value] = x;
            if (x >= x1[value])
                x1[value] = x + 1;
            if (y < y0[value])
                y0[value] = y;
            y1[value] = y + 1;
        }
    }
    return Array.from({length: count}, (_, index) =>
        ({x0: x0[index + 1], y0: y0[index + 1], x1: x1[index + 1], y1: y1[index + 1]}));
}

// Labels the connected areas of flat colour of an intensity image, as label(); 0 marks pixels that are not flat.
function flatAreas(values, width, height) {
    const wall = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x + 1 < width; x++) {
            const index = y * width + x;
            // Both pixels of a step are walls, so that a panel's flat area never includes the first pixel of its
            // border.
            if (Math.abs(values[index + 1] - values[index]) > FLAT_THRESHOLD)
                wall[index] = wall[index + 1] = 1;
        }
    }
    for (let y = 0; y + 1 < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (Math.abs(values[index + width] - values[index]) > FLAT_THRESHOLD)
                wall[index] = wall[index + width] = 1;
        }
    }
    for (let index = 0; index < wall.length; index++)
        wall[index] = wall[index] ? 0 : 1;
    return label(wall, width, height);
}

/**
 * Where a shape starts and ends along each line. `inside` is a mask of width × height; along rows (byRow) or
 * columns. Returns {first, last, present}: per line the first index, the last index + 1, and whether the line holds
 * any of the shape. A line without any has first 0 and last the line's length.
 */
function extent(inside, width, height, byRow) {
    const lines = byRow ? height : width;
    const length = byRow ? width : height;
    const first = new Int32Array(lines);
    const last = new Int32Array(lines).fill(length);
    const present = new Uint8Array(lines);
    // Index of a line's first pixel in `inside`, and the step from one pixel of a line to the next.
    const step = byRow ? 1 : width;
    for (let line = 0; line < lines; line++) {
        const start = byRow ? line * width : line;
        for (let position = 0, index = start; position < length; position++, index += step) {
            if (inside[index]) {
                first[line] = position;
                present[line] = 1;
                break;
            }
        }
        if (!present[line])
            continue;
        for (let position = length - 1, index = start + position * step; position >= 0; position--, index -= step) {
            if (inside[index]) {
                last[line] = position + 1;
                break;
            }
        }
    }
    return {first, last, present};
}

/**
 * The position most lines agree on, and the share of lines that do. Lines an element's content covers completely,
 * such as a selected row across a sidebar, hold none of the area and do not count against the side. With `bites`, a
 * run of lines between two stretches of the side that all stop short of it along one straight edge counts toward
 * the share too: there another window, or a panel, lies over the side. The side then moves in to the deepest bite's
 * edge, so that the rectangle stays off what lies over it. Returns [position, share], e.g. [12, 0.94].
 */
function straightSide(positions, present, slack, lowest, bites = false) {
    const values = [];
    for (let line = 0; line < positions.length; line++) {
        if (present[line])
            values.push(positions[line]);
    }
    if (!values.length)
        return [0, 0];
    const counts = new Int32Array(Math.max(...values) + 1);
    for (const value of values)
        counts[value]++;
    // Counts summed over a window of 2 × slack + 1 positions centred on each, ignoring positions outside the range.
    // A range shorter than the window gets one sum per window position instead, aligned on the range's middle.
    // Where several positions tie, as on a rounded corner, the outermost is the element's side.
    const size = 2 * slack + 1;
    const length = Math.max(counts.length, size);
    const offset = (Math.min(counts.length, size) - 1) >> 1;
    const sums = new Int32Array(length);
    let best = -1;
    let bestSum = -1;
    for (let index = 0; index < length; index++) {
        let sum = 0;
        const centre = index + offset;
        for (let position = centre - size + 1; position <= centre; position++) {
            if (position >= 0 && position < counts.length)
                sum += counts[position];
        }
        sums[index] = sum;
        if (lowest ? sum > bestSum : sum >= bestSum) {
            bestSum = sum;
            best = index;
        }
    }
    // A bite may take more of the side than is left of it, so the side is the outermost position enough lines
    // agree on, rather than the one most do.
    if (bites) {
        const step = lowest ? 1 : -1;
        let index = lowest ? 0 : length - 1;
        while (index >= 0 && index < length && sums[index] < BITE_SIDE * values.length)
            index += step;
        best = index;
        for (let inner = index; inner >= 0 && inner < length && Math.abs(inner - index) <= 2 * slack; inner += step) {
            if (sums[inner] > sums[best])
                best = inner;
        }
    }
    let edge = lowest ? Infinity : -Infinity;
    let near = 0;
    for (const value of values) {
        if (Math.abs(value - best) <= slack) {
            near++;
            edge = lowest ? Math.min(edge, value) : Math.max(edge, value);
        }
    }
    if (bites) {
        const [lines, deepest] = bitten(positions, present, slack, lowest, best);
        near += lines;
        if (lines)
            edge = lowest ? Math.max(edge, deepest) : Math.min(edge, deepest);
    }
    return [edge, near / values.length];
}

/**
 * How many lines lie in bites out of a side at `best`: runs of lines that stop short of it, have lines at the side
 * before and after them, and mostly stop at one position. A bite reaching a corner is left out, as an L-shaped area
 * has one and is no rectangle. Returns [lines, the position of the deepest bite's edge], e.g. [668, 2682].
 */
function bitten(positions, present, slack, lowest, best) {
    const atSide = line => Math.abs(positions[line] - best) <= slack;
    let total = 0;
    let deepest = best;
    let start = -1;
    let sideBefore = false;
    for (let line = 0; line < positions.length; line++) {
        if (!present[line])
            continue;
        if (!atSide(line)) {
            if (start < 0)
                start = line;
            continue;
        }
        if (start >= 0 && sideBefore) {
            const counts = new Map();
            let lines = 0;
            for (let inner = start; inner < line; inner++) {
                if (!present[inner])
                    continue;
                lines++;
                counts.set(positions[inner], (counts.get(positions[inner]) ?? 0) + 1);
            }
            let straight = 0;
            let edge = best;
            for (const [position] of counts) {
                let sum = 0;
                for (const [other, count] of counts) {
                    if (Math.abs(other - position) <= slack)
                        sum += count;
                }
                if (sum > straight) {
                    straight = sum;
                    edge = position;
                }
            }
            const inward = [...counts.keys()].every(position => lowest ? position > best : position < best);
            if (inward && straight >= BITE_SUPPORT * lines) {
                total += lines;
                deepest = lowest ? Math.max(deepest, edge) : Math.min(deepest, edge);
            }
        }
        start = -1;
        sideBefore = true;
    }
    return [total, deepest];
}

// A mask of the pixels of `labels` in the box between (x0, y0) and (x1, y1) that hold `value`, or, when `values`
// is given, any label in that Set.
function crop(labels, width, x0, y0, x1, y1, value, values = null) {
    const boxWidth = x1 - x0;
    const mask = new Uint8Array(boxWidth * (y1 - y0));
    for (let y = y0, target = 0; y < y1; y++) {
        for (let index = y * width + x0, end = index + boxWidth; index < end; index++, target++) {
            if (values ? values.has(labels[index]) : labels[index] === value)
                mask[target] = 1;
        }
    }
    return mask;
}

class Regions {
    // values: the intensity image, width × height; scale: image pixels per logical pixel, e.g. 1.25.
    constructor(values, width, height, scale) {
        this.values = values;
        this.width = width;
        this.height = height;
        this.scale = scale;
        this.minimum = Math.max(4, roundHalfEven(MIN_ELEMENT * scale));
        this.piece = Math.max(4, roundHalfEven(MIN_PIECE * scale));
        this.band = roundHalfEven(MIN_BAND * scale);
        this.slack = Math.max(1, Math.ceil(scale * 1.5));
        this.tiny = Math.max(3, roundHalfEven(3 * scale));
        // Two flat areas this close are separated by a border line, not by a band of something else.
        this.line = roundHalfEven(4 * scale) + 2;
        // The widest gap between the rectangles of two areas with only a ruled line between them.
        this.rule = Math.ceil(2 * scale) + 1;
        // Rectangles as [x0, y0, x1, y1, the colour of a flat area or null, kind]. Kind is 'area' for a flat area,
        // 'island' for a rectangle the area flows around, 'row' for a line of content across an area and 'item' for
        // a word, label or icon on that line.
        this.found = [];
        // Bounding boxes of islands that are icons or glyphs, as [x0, y0, x1, y1].
        this.icons = [];
    }

    /**
     * Finds the flat areas and their islands. Run before nest(). dividers: the pieces between a window's dividers, as
     * [x0, y0, x1, y1], within which an area that is no rectangle as a whole is looked at again.
     */
    collect(dividers = []) {
        const {width, height} = this;
        const [labels, count] = flatAreas(this.values, width, height);
        const boxes = boundingBoxes(labels, width, height, count);
        const large = [];
        for (let value = 1; value <= count; value++) {
            const box = boxes[value - 1];
            if (box.y1 - box.y0 >= this.minimum && box.x1 - box.x0 >= this.minimum)
                large.push(value);
        }
        // A thin area is itself a band, and is looked through to find what lies on its other side.
        const solid = new Int32Array(count + 1);
        for (const value of large) {
            const box = boxes[value - 1];
            if (Math.min(box.y1 - box.y0, box.x1 - box.x0) >= this.band)
                solid[value] = value;
        }
        const colour = new Map();
        const alone = new Map();
        const neighbours = [];
        // One mask at a time: together they could be many times the size of the image.
        for (const value of large) {
            const box = boxes[value - 1];
            const inside = crop(labels, width, box.x0, box.y0, box.x1, box.y1, value);
            const first = inside.indexOf(1);
            const boxWidth = box.x1 - box.x0;
            colour.set(value, this.values[(box.y0 + Math.floor(first / boxWidth)) * width + box.x0 + first % boxWidth]);
            if (solid[value])
                neighbours.push(...this._acrossBands(labels, solid, value, box, inside));
            alone.set(value, this._area(inside, boxWidth, box.y1 - box.y0, box.x0, box.y0, colour.get(value)));
        }
        const pieces = [...dividers].sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
        for (const members of this._join(large, boxes, colour, neighbours)) {
            let result;
            const top = Math.min(...members.map(value => boxes[value - 1].y0));
            const bottom = Math.max(...members.map(value => boxes[value - 1].y1));
            const left = Math.min(...members.map(value => boxes[value - 1].x0));
            const right = Math.max(...members.map(value => boxes[value - 1].x1));
            const group = new Set(members);
            if (members.length === 1) {
                result = alone.get(members[0]);
            } else {
                const inside = crop(labels, width, left, top, right, bottom, 0, group);
                result = this._area(inside, right - left, bottom - top, left, top, colour.get(members[0]));
            }
            if (!result[0].length) {
                result = this._withinPieces(labels, group, [left, top, right, bottom], colour.get(members[0]),
                    pieces);
            }
            this.found.push(...result[0]);
            this.icons.push(...result[1]);
        }
    }

    /**
     * The rectangles and icons of an area that is no rectangle as a whole, found in each piece between dividers that
     * it is one in. A page's background reaches around the panels it holds, such as a video player across the page,
     * and so is no rectangle; between the dividers along the player's top and bottom, each part of it is one. Pieces
     * inside one where the area was already found are skipped. group: the area's labels; box: its bounding box as
     * [x0, y0, x1, y1]; pieces: largest first. Returns [rectangles, icons] as _area() does.
     */
    _withinPieces(labels, group, box, colour, pieces) {
        const found = [];
        const icons = [];
        const used = [];
        for (const piece of pieces) {
            const [x0, y0, x1, y1] = [Math.max(piece[0], box[0]), Math.max(piece[1], box[1]),
                Math.min(piece[2], box[2]), Math.min(piece[3], box[3])];
            if (x1 - x0 < this.minimum || y1 - y0 < this.minimum ||
                used.some(other => other[0] <= piece[0] && other[1] <= piece[1] && other[2] >= piece[2] &&
                    other[3] >= piece[3]))
                continue;
            const inside = crop(labels, this.width, x0, y0, x1, y1, 0, group);
            const [rectangles, marks] = this._area(inside, x1 - x0, y1 - y0, x0, y0, colour);
            if (!rectangles.length)
                continue;
            used.push(piece);
            found.push(...rectangles);
            icons.push(...marks);
        }
        return [found, icons];
    }

    /**
     * Element rectangles in image pixels: what collect() found, with the pieces between dividers. dividers: the
     * panels found by splitting the window along dividers, as [x0, y0, x1, y1]. Returns [x0, y0, x1, y1] rectangles.
     */
    nest(dividers = []) {
        return this._nest([...this.found, ...dividers.map(box => [...box, null, 'divided'])]);
    }

    /**
     * The solid areas that lie before this one with only a thin band between them. `solid` maps each label to
     * itself for areas at least as thick as a band, and to 0 otherwise. `inside` is the area's mask within its
     * bounding box. Returns [this label, the other one, how many lines across face it, the axis the two follow
     * each other on: 0 down, 1 across].
     */
    _acrossBands(labels, solid, value, box, inside) {
        const {width} = this;
        const boxWidth = box.x1 - box.x0;
        const boxHeight = box.y1 - box.y0;
        const found = [];
        for (const axis of [0, 1]) {
            // From the area's first pixel on each line across, back to the nearest solid area before it.
            const {first, present} = extent(inside, boxWidth, boxHeight, axis === 1);
            const starts = [];
            const across = [];
            for (let line = 0; line < present.length; line++) {
                if (!present[line])
                    continue;
                starts.push((axis === 0 ? box.y0 : box.x0) + first[line] - 1);
                across.push((axis === 0 ? box.x0 : box.y0) + line);
            }
            const before = new Int32Array(starts.length);
            const distance = new Int32Array(starts.length);
            let unset = starts.length;
            for (let step = 0; step < this.band && unset; step++) {
                for (let line = 0; line < starts.length; line++) {
                    if (before[line])
                        continue;
                    const reach = Math.max(starts[line] - step, 0);
                    const seen = solid[axis === 0 ? labels[reach * width + across[line]] : labels[across[line] * width + reach]];
                    if (seen) {
                        before[line] = seen;
                        distance[line] = step;
                        unset--;
                    }
                }
            }
            const lengths = new Map();
            for (let line = 0; line < starts.length; line++) {
                if (before[line] !== value && distance[line] > this.line)
                    lengths.set(before[line], (lengths.get(before[line]) ?? 0) + 1);
            }
            for (const other of [...lengths.keys()].sort((a, b) => a - b))
                found.push([value, other, lengths.get(other), axis]);
        }
        return found;
    }

    /**
     * Groups flat areas of one colour that only a thin band separates. An editor's current-line highlight cuts the
     * editor's background in two; the two halves are one panel. Returns the labels in each group.
     */
    _join(large, boxes, colour, neighbours) {
        const parent = new Map(large.map(value => [value, value]));
        const root = value => {
            while (parent.get(value) !== value)
                value = parent.get(value);
            return value;
        };
        for (const [value, other, length, axis] of neighbours) {
            const sides = [boxes[value - 1], boxes[other - 1]].map(box => axis === 0 ? box.x1 - box.x0 : box.y1 - box.y0);
            if (Math.abs(colour.get(other) - colour.get(value)) <= FLAT_THRESHOLD && length >= 0.5 * Math.min(...sides))
                parent.set(root(other), root(value));
        }
        const groups = new Map();
        for (const value of large) {
            const key = root(value);
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(value);
        }
        return [...groups.values()];
    }

    /**
     * The rectangle most of a shape's outline lies on, ignoring bumps, notches and rounded corners. `inside` is the
     * shape's mask within its bounding box; bites: whether a bite out of a side counts toward it, see straightSide().
     * Returns [x0, y0, x1, y1, the share of the left, right, top and bottom sides that the shape reaches].
     */
    _rectangle(inside, width, height, bites = false) {
        const rows = extent(inside, width, height, true);
        const columns = extent(inside, width, height, false);
        // Bites only rescue a side too ragged without them, so that a side that is straight enough keeps its place.
        const side = (positions, present, lowest) => {
            const plain = straightSide(positions, present, this.slack, lowest);
            return bites && plain[1] < SIDE_SUPPORT ? straightSide(positions, present, this.slack, lowest, true) : plain;
        };
        const [x0, left] = side(rows.first, rows.present, true);
        const [x1, right] = side(rows.last, rows.present, false);
        const [y0, top] = side(columns.first, columns.present, true);
        const [y1, bottom] = side(columns.last, columns.present, false);
        return [x0, y0, x1, y1, [left, right, top, bottom]];
    }

    /**
     * The rectangle of one flat area and the islands inside it. Returns [rectangles as [x0, y0, x1, y1, the area's
     * colour or null for an island], bounding boxes of icon-like islands as [x0, y0, x1, y1]].
     */
    _area(inside, width, height, left, top, colour) {
        const [x0, y0, x1, y1, support] = this._rectangle(inside, width, height, true);
        const small = Math.min(x1 - x0, y1 - y0) < SMALL_AREA * this.scale;
        if (x1 - x0 < this.minimum || y1 - y0 < this.minimum ||
            Math.min(...support) < (small ? SMALL_SIDE_SUPPORT : SIDE_SUPPORT))
            return [[], []];
        // The walls on both sides of a colour step take one pixel from each area, which the rectangle gets back.
        const found = [[left + x0 - 1, top + y0 - 1, left + x1 + 1, top + y1 + 1, colour, 'area']];
        const icons = [];
        const tokens = [];
        const pictures = [];
        const inner = new Uint8Array((x1 - x0) * (y1 - y0));
        for (let y = y0; y < y1; y++)
            inner.set(inside.subarray(y * width + x0, y * width + x1), (y - y0) * (x1 - x0));
        this._islands(inner, x1 - x0, y1 - y0, left + x0, top + y0, found, icons, tokens, pictures);
        this._content(tokens, [...found.slice(1).map(box => box.slice(0, 4)), ...pictures],
            [left + x0, top + y0, left + x1, top + y1], found);
        return [found, icons];
    }

    /**
     * Adds rectangular islands, connected parts of a rectangle that its flat area does not cover, to `found`. The
     * other islands that may be text or icons go to `tokens`, and those too tall for that to `pictures`, both as
     * [x0, y0, x1, y1].
     */
    _islands(inside, width, height, left, top, found, icons, tokens, pictures) {
        const outside = new Uint8Array(inside.length);
        for (let index = 0; index < inside.length; index++)
            outside[index] = inside[index] ? 0 : 1;
        const [labels, count] = label(outside, width, height, true);
        if (!count)
            return;
        const boxes = boundingBoxes(labels, width, height, count);
        const slack = this.slack;
        for (let value = 1; value <= count; value++) {
            const box = boxes[value - 1];
            const boxWidth = box.x1 - box.x0;
            const boxHeight = box.y1 - box.y0;
            if (boxHeight < this.minimum || boxWidth < this.minimum) {
                this._token(box, width, height, left, top, tokens);
                continue;
            }
            let [x0, y0, x1, y1] = this._rectangle(crop(labels, width, box.x0, box.y0, box.x1, box.y1, value),
                boxWidth, boxHeight);
            [x0, x1, y0, y1] = [x0 + box.x0, x1 + box.x0, y0 + box.y0, y1 + box.y0];
            if ((x1 - x0 === width && y1 - y0 === height) || x1 - x0 < this.minimum || y1 - y0 < this.minimum)
                continue;
            // Text also has sides most of its lines agree on, the tops and feet of its letters, but is mostly gaps
            // along them. So the island itself must cover the rectangle's outline.
            const islandWidth = x1 - x0;
            const islandHeight = y1 - y0;
            const at = (x, y) => labels[(y0 + y) * width + x0 + x] === value;
            const band = (from, to, length, hit) => {
                const side = new Uint8Array(length);
                for (let line = 0; line < length; line++) {
                    for (let position = from; position < to; position++) {
                        if (hit(line, position)) {
                            side[line] = 1;
                            break;
                        }
                    }
                }
                return side;
            };
            // The first and last `slack` columns or rows, or all of them on an island narrower than that.
            const near = Math.min(slack, islandWidth);
            const nearRows = Math.min(slack, islandHeight);
            const sides = [
                band(0, near, islandHeight, (y, x) => at(x, y)),
                band(islandWidth - near, islandWidth, islandHeight, (y, x) => at(x, y)),
                band(0, nearRows, islandWidth, (x, y) => at(x, y)),
                band(islandHeight - nearRows, islandHeight, islandWidth, (x, y) => at(x, y)),
            ];
            const sum = side => side.reduce((total, hit) => total + hit, 0);
            const solid = sides.reduce((total, side) => total + sum(side), 0) / (2 * (islandHeight + islandWidth));
            if (solid >= OUTLINE_SUPPORT && Math.min(...sides.map(side => sum(side) / side.length)) >= SIDE_OUTLINE) {
                found.push([left + x0, top + y0, left + x1, top + y1, null, 'island']);
                continue;
            }
            if (Math.max(boxHeight, boxWidth) < MAX_ICON * this.scale)
                icons.push([left + box.x0, top + box.y0, left + box.x1, top + box.y1]);
            // A rounded or shadowed button, a large icon or a line of heading text; or, taller than any of those, a
            // picture.
            if (boxHeight > MAX_ITEM_HEIGHT * this.scale)
                pictures.push([left + box.x0, top + box.y0, left + box.x1, top + box.y1]);
            else
                this._token(box, width, height, left, top, tokens);
        }
    }

    // Adds an island's bounding box to `tokens`, unless it is a border remnant or a picture rather than a mark.
    _token(box, width, height, left, top, tokens) {
        const boxWidth = box.x1 - box.x0;
        const boxHeight = box.y1 - box.y0;
        // What fills a corner of the rectangle or runs along most of an edge is a rounded corner or the rest of a
        // border. Text may touch an edge, as the letters of an editor's current line touch its highlight.
        const [left0, top0, right0, bottom0] = [!box.x0, !box.y0, box.x1 === width, box.y1 === height];
        if ((left0 || right0) && (top0 || bottom0))
            return;
        if (((left0 || right0) && 2 * boxHeight > height) || ((top0 || bottom0) && 2 * boxWidth > width))
            return;
        // A sliver along an edge is the antialiased end of something across it, such as text running up to a
        // picture, which would otherwise make a row across the picture.
        if (((left0 || right0) && boxWidth <= this.slack) || ((top0 || bottom0) && boxHeight <= this.slack))
            return;
        if (boxHeight > MAX_ITEM_HEIGHT * this.scale)
            return;
        // A ruled line would join every row it crosses into one.
        if (Math.min(boxWidth, boxHeight) <= this.rule && Math.max(boxWidth, boxHeight) >= 4 * this.minimum)
            return;
        tokens.push([left + box.x0, top + box.y0, left + box.x1, top + box.y1]);
    }

    /**
     * Adds the rows and items of one flat area's content to `found`. Marks side by side make a line, and those a
     * small gap apart along it an item: a word, a label or an icon. A line alone at its height becomes a row across
     * the whole area, reaching halfway to the next line, as a list or tree row is drawn when it is selected.
     * tokens: the marks as [x0, y0, x1, y1]; islands: rectangles and pictures in the area, which rows stop at;
     * area: the inside of the area as [x0, y0, x1, y1].
     */
    _content(tokens, islands, area, found) {
        // Where the area's colour also occurs inside a picture or card, as black does in a dark photo, it leaks in and
        // leaves specks there that are no marks of the area's own.
        tokens = tokens.filter(token => !islands.some(island => Math.min(token[2], island[2]) > Math.max(token[0], island[0]) &&
            Math.min(token[3], island[3]) > Math.max(token[1], island[1])));
        if (!tokens.length)
            return;
        tokens.sort((a, b) => a[1] - b[1]);
        const parent = tokens.map((_, index) => index);
        const root = index => {
            while (parent[index] !== index)
                index = parent[index] = parent[parent[index]];
            return index;
        };
        for (let first = 0; first < tokens.length; first++) {
            const a = tokens[first];
            // Sorted by top, so no later token reaches up into this one's lines once one starts below them.
            for (let second = first + 1; second < tokens.length && tokens[second][1] < a[3]; second++) {
                const b = tokens[second];
                const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
                const gap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
                // Across a gap wider than twice the text height, marks are in different columns.
                const reach = 2 * Math.max(a[3] - a[1], b[3] - b[1]);
                if (overlap >= 0.5 * Math.min(a[3] - a[1], b[3] - b[1]) && gap <= reach)
                    parent[root(second)] = root(first);
            }
        }
        const groups = new Map();
        tokens.forEach((token, index) => {
            const key = root(index);
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(token);
        });
        const union = boxes => [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
            Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))];
        const lines = [...groups.values()].map(members => [union(members), members]);
        const gap = Math.max(1, roundHalfEven(ITEM_GAP * this.scale));
        const spacing = roundHalfEven(PHRASE_GAP * this.scale);
        const smallest = roundHalfEven(MIN_ITEM * this.scale);
        const blocks = [...lines.map(([box]) => box), ...islands];
        for (const [line, members] of lines) {
            members.sort((a, b) => a[0] - b[0]);
            const words = this._runs(members, gap).filter(box =>
                Math.max(box[2] - box[0], box[3] - box[1]) >= smallest);
            for (const word of words)
                found.push([...word, null, 'item']);
            // A label of several words, or an icon with its text, is one item around the words.
            for (const phrase of this._runs(words, spacing)) {
                if (!words.some(word => word.every((value, axis) => value === phrase[axis])))
                    found.push([...phrase, null, 'item']);
            }
            found.push([...this._row(line, blocks, area), null, 'row']);
        }
    }

    // Joins boxes in order along a line where at most `gap` pixels apart. Returns the joined boxes as [x0, y0, x1, y1].
    _runs(boxes, gap) {
        const runs = [];
        for (const box of boxes) {
            const last = runs.at(-1);
            if (last && box[0] - last[2] <= gap)
                runs[runs.length - 1] = [last[0], Math.min(last[1], box[1]), Math.max(last[2], box[2]), Math.max(last[3], box[3])];
            else
                runs.push([...box]);
        }
        return runs;
    }

    /**
     * The row a line of content makes: across the whole area, halfway to the lines above and below it, and no more
     * than about its own height further. A line that shares its height with other content is a cell of a grid or
     * form rather than a row, and only its own box is returned. Returns [x0, y0, x1, y1].
     */
    _row(line, blocks, area) {
        const height = line[3] - line[1];
        let above = null;
        let below = null;
        for (const block of blocks) {
            if (block === line)
                continue;
            if (Math.min(block[3], line[3]) > Math.max(block[1], line[1]))
                return line;
            if (block[3] <= line[1])
                above = Math.max(above ?? -Infinity, block[3]);
            else
                below = Math.min(below ?? Infinity, block[1]);
        }
        const reach = Math.ceil(0.6 * height);
        const up = Math.min(reach, above === null ? line[1] - area[1] : (line[1] - above) >> 1);
        const down = Math.min(reach, below === null ? area[3] - line[3] : (below - line[3]) >> 1);
        return [area[0], line[1] - up, area[2], line[3] + down];
    }

    /**
     * Keeps rectangles that nest: largest first, dropping near-duplicates and any that straddle a kept one. Rows and
     * items come after every panel, card and button, and are the ones dropped where they straddle: a line of marks
     * can run on from one column into the next, while a button's outline is the button. Each of `found` is
     * [x0, y0, x1, y1, the background of a flat area or null, kind].
     */
    _nest(found) {
        const {width, height, slack} = this;
        // Each kept rectangle: x0, y0, x1, y1, depth, index of the smallest kept rectangle around it, background.
        const kept = [[0, 0, width, height, 0, null, null]];
        const icons = this.icons.map(([x0, y0, x1, y1]) => [x0 - slack, y0 - slack, x1 + slack, y1 + slack]);
        const later = box => box[5] === 'row' || box[5] === 'item' ? 1 : 0;
        const sorted = [...found].sort((a, b) => later(a) - later(b) ||
            (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
        let coarse = 0;
        let fine = 0;
        for (const box of sorted) {
            const [x0, y0, x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(width, box[2]),
                Math.min(height, box[3])];
            const [colour, kind] = [box[4], box[5]];
            const divided = kind === 'divided';
            const content = kind === 'row' || kind === 'item';
            let smallest = content ? this.tiny : this.minimum;
            if (divided)
                smallest = this.piece;
            if (x1 - x0 < smallest || y1 - y0 < smallest || (content ? fine >= MAX_FINE : coarse >= MAX_ELEMENTS))
                continue;
            // The parts of an icon are not elements, but what covers most of it is the icon or button itself.
            if (!divided && icons.some(icon => icon[0] <= x0 && icon[1] <= y0 && icon[2] >= x1 && icon[3] >= y1 &&
                2 * (x1 - x0) * (y1 - y0) < (icon[2] - icon[0]) * (icon[3] - icon[1])))
                continue;
            let fits = true;
            let around = 0;
            for (let index = 0; index < kept.length; index++) {
                const [a0, b0, a1, b1] = kept[index];
                if (x1 <= a0 + slack || x0 >= a1 - slack || y1 <= b0 + slack || y0 >= b1 - slack)
                    continue;
                const contained = x0 >= a0 - slack && y0 >= b0 - slack && x1 <= a1 + slack && y1 <= b1 + slack;
                // A rectangle just inside another is the inner edge of the same border.
                const same = [x0, y0, x1, y1].every((value, axis) => Math.abs(value - kept[index][axis]) <= this.line);
                // A row as large as its panel is the panel's content, and does not move the panel's edges.
                if (contained && same && index && !content) {
                    // The tighter of two near-duplicates is the element; the wider one includes its border or shadow.
                    kept[index].splice(0, 4, x0, y0, x1, y1);
                    if (kept[index][6] === null)
                        kept[index][6] = colour;
                }
                if (!contained || same) {
                    fits = false;
                    break;
                }
                // Kept rectangles are in order of size, rows and items after the rest, so the last one around this is
                // the smallest.
                around = index;
            }
            if (!fits)
                continue;
            if (!content && around && this._remainder([x0, y0, x1, y1], kept[around]))
                continue;
            // Pieces between dividers group panels however deep the layout goes; only elements inside elements count.
            const depth = kept[around][4] + (divided ? 0 : 1);
            if (depth > MAX_DEPTH)
                continue;
            kept.push([x0, y0, x1, y1, depth, around, colour]);
            if (content)
                fine++;
            else
                coarse++;
        }
        const whole = kept[0].slice(0, 4);
        return [...kept.slice(1).map(box => box.slice(0, 4)), ...this._stacks(kept)]
            .filter(box => !box.every((value, axis) => Math.abs(value - whole[axis]) <= 2 * slack));
    }

    /**
     * The panels that areas of one colour make up when stacked edge to edge with only lines between. A sidebar
     * divided into sections by full-width rules has no background of its own: each section is an area, and nothing
     * but their alignment says they are one panel. Only areas inside the same rectangle are stacked, so the panel
     * nests with what was kept. Returns the panels as [x0, y0, x1, y1].
     */
    _stacks(kept) {
        const siblings = new Map();
        for (const box of kept.slice(1)) {
            if (box[6] === null)
                continue;
            if (!siblings.has(box[5]))
                siblings.set(box[5], []);
            siblings.get(box[5]).push(box);
        }
        const found = [];
        for (const [around, members] of siblings) {
            const boxes = members.map(box => [...box.slice(0, 4), box[6]]);
            const parent = boxes.map((_, index) => index);
            const root = index => {
                while (parent[index] !== index)
                    index = parent[index];
                return index;
            };
            for (const axis of [0, 1]) {
                const across = 1 - axis;
                const deep = boxes.map(box => box[axis + 2] - box[axis] >= this.band);
                for (let first = 0; first < boxes.length; first++) {
                    for (let second = 0; second < boxes.length; second++) {
                        const [a, b] = [boxes[first], boxes[second]];
                        const gap = b[axis] - a[axis + 2];
                        if (Math.abs(a[4] - b[4]) <= FLAT_THRESHOLD &&
                            Math.abs(a[across] - b[across]) <= this.slack &&
                            Math.abs(a[across + 2] - b[across + 2]) <= this.slack &&
                            gap >= -this.slack && gap <= this.rule && deep[first] && deep[second])
                            parent[root(first)] = root(second);
                    }
                }
            }
            const stacks = new Map();
            boxes.forEach((_, index) => {
                const key = root(index);
                if (!stacks.has(key))
                    stacks.set(key, []);
                stacks.get(key).push(index);
            });
            for (const stack of stacks.values()) {
                const part = stack.map(index => boxes[index]);
                const union = [Math.min(...part.map(box => box[0])), Math.min(...part.map(box => box[1])),
                    Math.max(...part.map(box => box[2])), Math.max(...part.map(box => box[3]))];
                if (stack.length < 2 ||
                    kept.some(box => union.every((value, axis) => Math.abs(value - box[axis]) <= this.line)))
                    continue;
                if (!(around && this._remainder(union, kept[around])))
                    found.push(union);
            }
        }
        return found;
    }

    // Whether box is most of the length of the bar around it.
    _remainder(box, around) {
        for (const axis of [0, 1]) {
            const length = around[axis + 2] - around[axis];
            const thickness = around[3 - axis] - around[1 - axis];
            if (length >= 3 * thickness && box[axis + 2] - box[axis] >= REMAINDER * length)
                return true;
        }
        return false;
    }
}

/**
 * Panels, cards, fields and tabs of one window image, in stage logical coordinates: [[x, y, width, height], ...].
 * scale: snapshot pixels per logical pixel, e.g. 1.25; origin: the image's top-left in snapshot pixels.
 */
export function detectRegions(values, width, height, scale, origin) {
    if (width < 3 || height < 3)
        return [];
    const finder = new Regions(values, width, height, scale);
    const dividers = new Detector(values, width, height, scale, ANCHOR).run();
    finder.collect(dividers);
    const round = value => Math.round(value * 100) / 100;
    return finder.nest(dividers).map(([x0, y0, x1, y1]) =>
        [round((origin[0] + x0) / scale), round((origin[1] + y0) / scale), round((x1 - x0) / scale),
            round((y1 - y0) / scale)]);
}
