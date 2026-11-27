// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Finds panel rectangles inside a window image, with no imports, so node can test it and a `gjs` process can run
 * it. Detection splits a window along straight dividers: row or column boundaries where nearly the whole span
 * changes colour sharply, as panel borders and background changes do, then splits each piece again. Text, icons
 * and photos change colour along only part of a line, or on many consecutive lines, and are not cut.
 *
 * Images are intensity arrays: an Int16Array of width × height values, row by row, each the sum of a pixel's red,
 * green and blue, 0-765.
 */

// Thresholds are on the sum of the three channel differences, 0-765.
const STEP_THRESHOLD = 9;
const RAMP_THRESHOLD = 15;
// Share of a boundary that must be an edge for it to count as a divider.
const SPAN_FRACTION = 0.9;
// Logical pixels. A panel is at least as tall as a status bar; a band between two dividers that is thinner than a
// toolbar is a highlight, such as an editor's current line, and does not split the panel around it.
export const MIN_ELEMENT = 16;
const MIN_BAND = 28;
const MAX_DEPTH = 6;
const MAX_ELEMENTS = 400;
// Logical pixels at each end of a divider, of which one end must be an edge, when dividers are anchored.
export const ANCHOR = 6;

// Rounds half to even (banker's rounding) rather than half up. The reference boxes in tests/fixtures/golden depend on
// thresholds derived from the scale this way, so changing the rounding changes which boxes are found.
export function roundHalfEven(value) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction !== 0.5)
        return Math.round(value);
    return floor % 2 === 0 ? floor : floor + 1;
}

// A colour channel multiplied by alpha the way Cairo does when it loads a PNG, rounding to nearest.
function premultiply(alpha, channel) {
    const product = alpha * channel + 0x80;
    return (product + (product >> 8)) >> 8;
}

/**
 * The intensity array of decoded pixels. pixels: a Uint8Array of RGB or RGBA rows, `rowstride` bytes apart, with
 * `channels` bytes per pixel, as a GdkPixbuf gives them. Captured windows are opaque; a translucent pixel counts
 * its colour multiplied by its alpha, as Cairo reads it.
 */
export function intensity(pixels, width, height, rowstride, channels) {
    const values = new Int16Array(width * height);
    for (let y = 0; y < height; y++) {
        let source = y * rowstride;
        const row = y * width;
        for (let x = 0; x < width; x++, source += channels) {
            const alpha = channels === 4 ? pixels[source + 3] : 255;
            values[row + x] = alpha === 255 ? pixels[source] + pixels[source + 1] + pixels[source + 2]
                : premultiply(alpha, pixels[source]) + premultiply(alpha, pixels[source + 1]) +
                  premultiply(alpha, pixels[source + 2]);
        }
    }
    return values;
}

/**
 * Running counts of edge pixels on each boundary between consecutive rows: entry [i * (width + 1) + x] counts the
 * edge pixels in columns 0..x-1 of the boundary between rows i and i + 1, so any span's count is a difference of
 * two entries. Returns a Uint16Array of (height - 1) × (width + 1).
 */
function edgeCounts(values, width, height, ramp) {
    const boundaries = height - 1;
    const edges = new Uint8Array(boundaries * width);
    for (let i = 0; i < boundaries; i++) {
        const above = i * width;
        const below = above + width;
        for (let x = 0; x < width; x++)
            edges[above + x] = Math.abs(values[below + x] - values[above + x]) > STEP_THRESHOLD ? 1 : 0;
    }
    // A window scaled up by the compositor smears a 1 px border over a few rows, so no two neighbouring rows differ
    // much. Comparing rows `ramp` apart on each side of the boundary still sees the full step.
    if (height > 2 * ramp) {
        for (let i = ramp - 1; i < height - ramp; i++) {
            const top = (i - ramp + 1) * width;
            const bottom = (i + ramp) * width;
            for (let x = 0; x < width; x++) {
                if (Math.abs(values[bottom + x] - values[top + x]) > RAMP_THRESHOLD)
                    edges[i * width + x] = 1;
            }
        }
    }
    const stride = width + 1;
    const counts = new Uint16Array(boundaries * stride);
    for (let i = 0; i < boundaries; i++) {
        let sum = 0;
        for (let x = 0; x < width; x++) {
            sum += edges[i * width + x];
            counts[i * stride + x + 1] = sum;
        }
    }
    return counts;
}

// Edge pixels between columns low and high of boundary `row`, from edgeCounts with rows `stride` entries apart.
function span(counts, stride, row, low, high) {
    return counts[row * stride + high] - counts[row * stride + low];
}

/**
 * Dividers spanning columns low..high-1 between rows start and end. When `anchor` is positive, a divider must
 * also be an edge along `anchor` columns at the first or the last end of the span: a panel border runs into another
 * border at one end at least, while a separator drawn inside a panel stops short of both. Those columns may start
 * up to `anchor` columns in where the divider meets a border there, one that `across`, the edge counts of the
 * boundaries between columns with rows `acrossStride` entries apart, finds above and below it. Returns the rows
 * where a new piece begins, and the share of the span covered by the strongest of those dividers, e.g.
 * [[48, 300], 0.97].
 */
function cuts(counts, stride, start, end, low, high, longest, gap, anchor, across, acrossStride) {
    if (end - start < 2)
        return [[], 0];
    const length = end - 1 - start;
    const share = new Float64Array(length);
    const found = new Uint8Array(length);
    const anchored = anchor && high - low > 2 * anchor;
    const crossings = across.length / acrossStride;
    // Whether a border crosses boundary `row` just before column `column`, on `anchor` rows to each side of it. A
    // separator's own end is an edge across a few rows only.
    const meets = (row, column) => {
        const top = Math.max(start, row + 1 - anchor);
        const bottom = Math.min(end, row + 1 + anchor);
        for (let boundary = Math.max(column - 2, 0); boundary <= Math.min(column, crossings - 1); boundary++) {
            if (span(across, acrossStride, boundary, top, bottom) >= SPAN_FRACTION * (bottom - top))
                return true;
        }
        return false;
    };
    for (let k = 0; k < length; k++) {
        const row = start + k;
        share[k] = span(counts, stride, row, low, high) / (high - low);
        found[k] = share[k] >= SPAN_FRACTION ? 1 : 0;
        if (!anchored || !found[k])
            continue;
        found[k] = 0;
        // A divider across a window may end at the window's outline a few pixels short of the image's edge, with
        // the outline and perhaps a strip of the browser's frame around a page beyond it. A separator that stops
        // short of a panel's edge has only the panel's background where it ends.
        for (let offset = 0; offset <= anchor && !found[k]; offset++) {
            const first = span(counts, stride, row, low + offset, low + offset + anchor) >= SPAN_FRACTION * anchor &&
                (!offset || meets(row, low + offset));
            const last = span(counts, stride, row, high - offset - anchor, high - offset) >= SPAN_FRACTION * anchor &&
                (!offset || meets(row, high - offset));
            found[k] = first || last ? 1 : 0;
        }
    }
    const runs = [];
    for (let k = 0; k < length;) {
        if (!found[k]) {
            k++;
            continue;
        }
        const first = k;
        while (k < length && found[k])
            k++;
        // A soft border is an edge on both of its sides with a calmer middle, so close runs are one divider.
        if (runs.length && first - runs[runs.length - 1][1] <= gap)
            runs[runs.length - 1][1] = k;
        else
            runs.push([first, k]);
    }
    // A long run of full-width edges is texture, such as a photo or a gradient, not a divider.
    const kept = runs.filter(([first, last]) => last - first <= longest);
    let strength = 0;
    for (const [first, last] of kept) {
        for (let k = first; k < last; k++)
            strength = Math.max(strength, share[k]);
    }
    return [kept.map(([first, last]) => start + Math.floor((first + last) / 2) + 1), strength];
}

/**
 * Spans between consecutive bounds, without slivers. A span thinner than `band` inside the region is a highlight,
 * so the spans on both sides of it merge with it. A span thinner than `minimum` at either end is trimmed off.
 * Returns [start, end] pairs.
 */
function pieces(bounds, minimum, band) {
    const spans = [];
    for (let index = 0; index + 1 < bounds.length; index++)
        spans.push([bounds[index], bounds[index + 1]]);
    while (spans.length && spans[0][1] - spans[0][0] < minimum)
        spans.shift();
    while (spans.length && spans[spans.length - 1][1] - spans[spans.length - 1][0] < minimum)
        spans.pop();
    const merged = [];
    spans.forEach(([low, high], index) => {
        const thin = index > 0 && index < spans.length - 1 && high - low < band;
        const last = merged[merged.length - 1];
        if (last && (thin || last[2]))
            merged[merged.length - 1] = [last[0], high, thin];
        else
            merged.push([low, high, thin]);
    });
    return merged.map(([low, high]) => [low, high]);
}

function median(values) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Panel rectangles of one intensity image, nested, in image pixels as [x0, y0, x1, y1]. */
export class Detector {
    // anchor: logical pixels for anchored dividers, 0 for none; the regions detector anchors its dividers.
    constructor(values, width, height, scale, anchor = 0) {
        this.anchor = roundHalfEven(anchor * scale);
        const ramp = Math.max(2, Math.ceil(scale * 2));
        this.longest = 3 * ramp + 4;
        this.gap = ramp + 1;
        this.minimum = Math.max(4, roundHalfEven(MIN_ELEMENT * scale));
        this.band = roundHalfEven(MIN_BAND * scale);
        this.width = width;
        this.height = height;
        this.values = values;
        this.transposed = new Int16Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++)
                this.transposed[x * height + y] = values[y * width + x];
        }
        this.rows = edgeCounts(values, width, height, ramp);
        this.columns = edgeCounts(this.transposed, height, width, ramp);
        this.found = [];
    }

    run() {
        this._split([0, 0, this.width, this.height], 0);
        return this.found;
    }

    // Pieces of region between dividers across it, and the strength of the strongest divider.
    _segment(region, horizontal) {
        const [x0, y0, x1, y1] = region;
        if (horizontal) {
            let [positions, strength] = cuts(this.rows, this.width + 1, y0, y1, x0, x1, this.longest, this.gap,
                this.anchor, this.columns, this.height + 1);
            if (this.anchor)
                positions = this._single(this.values, this.width, this.height, this.rows, positions, x0, x1);
            return [pieces([y0, ...positions, y1], this.minimum, this.band).map(([low, high]) => [x0, low, x1, high]),
                strength];
        }
        let [positions, strength] = cuts(this.columns, this.height + 1, x0, x1, y0, y1, this.longest, this.gap,
            this.anchor, this.rows, this.width + 1);
        if (this.anchor)
            positions = this._single(this.transposed, this.height, this.width, this.columns, positions, y0, y1);
        return [pieces([x0, ...positions, x1], this.minimum, this.band).map(([low, high]) => [low, y0, high, y1]),
            strength];
    }

    /**
     * Positions without the weaker of two close dividers that have only the panels' own background between them.
     * A scrollbar's trough beside a panel border is such a pair. Treated as a band between the panels, like a
     * highlight, the strip would join the panels on its two sides; here it stays with one of them instead.
     * values: rows of `rowLength` values, `rowCount` of them, matching `counts`.
     */
    _single(values, rowLength, rowCount, counts, positions, low, high) {
        const colour = row => {
            const start = Math.min(Math.max(row, 0), rowCount - 1) * rowLength;
            return median(values.subarray(start + low, start + high));
        };
        const boundaries = rowCount - 1;
        const strength = position => {
            let best = -Infinity;
            for (let row = Math.max(position - 1 - this.gap, 0); row < Math.min(position + this.gap, boundaries); row++)
                best = Math.max(best, span(counts, rowLength + 1, row, low, high));
            return best;
        };
        const kept = [];
        positions.forEach((position, index) => {
            const close = index > 0 && position - positions[index - 1] < this.band;
            // Only a pair on its own: rows of a grid are many close dividers, and stay a band each.
            const alone = (index < 2 || positions[index - 1] - positions[index - 2] >= this.band) &&
                (index + 1 === positions.length || positions[index + 1] - position >= this.band);
            if (close && alone) {
                const last = kept[kept.length - 1];
                const between = colour(Math.floor((last + position) / 2));
                const outside = [colour(last - 2 * this.gap), colour(position + 2 * this.gap)];
                if (outside.every(side => Math.abs(between - side) <= STEP_THRESHOLD)) {
                    if (strength(position) >= strength(last))
                        kept[kept.length - 1] = position;
                    return;
                }
            }
            kept.push(position);
        });
        return kept;
    }

    _split(region, depth) {
        if (depth >= MAX_DEPTH || this.found.length >= MAX_ELEMENTS)
            return;
        const options = [this._segment(region, true), this._segment(region, false)];
        const splits = options.filter(([parts]) => parts.length > 1);
        if (!splits.length) {
            const trimmed = options.find(([parts]) => parts.length === 1 &&
                parts[0].some((value, index) => value !== region[index]))?.[0][0];
            // Only borders were trimmed off: the same panel, so it is not a new element.
            if (trimmed)
                this._split(trimmed, depth);
            return;
        }
        // The divider that runs most completely across the region is split along first. A panel border spans the
        // whole region, while one that stops at a neighbouring panel only spans most of it, plus whatever text and
        // icons happen to line up with it in that neighbour.
        const [parts] = splits.reduce((best, option) => option[1] > best[1] ? option : best);
        for (const part of parts) {
            if (this.found.length >= MAX_ELEMENTS)
                return;
            this.found.push(part);
            this._split(part, depth + 1);
        }
    }
}

/**
 * Panel rectangles of one window image, in stage logical coordinates: [[x, y, width, height], ...]. scale: snapshot
 * pixels per logical pixel, e.g. 1.25; origin: the image's top-left in snapshot pixels.
 */
export function detect(values, width, height, scale, origin) {
    if (width < 3 || height < 3)
        return [];
    const round = value => Math.round(value * 100) / 100;
    return new Detector(values, width, height, scale).run().map(([x0, y0, x1, y1]) =>
        [round((origin[0] + x0) / scale), round((origin[1] + y0) / scale), round((x1 - x0) / scale),
            round((y1 - y0) / scale)]);
}
