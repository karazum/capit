// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CapIt accessibility-tree element finder, run as `gjs -m accessibility.js`. Asks applications what is under the
 * pointer.
 *
 * Shell writes JSON lines on stdin. The first lists the capture's windows:
 * {"windows": [{"index": 0, "pid": 4242, "title": "Files", "client": [x, y, width, height]}, ...]} in stage
 * logical coordinates. Each later line is a hover query, {"id": 7, "index": 0, "x": 512.5, "y": 300}, answered by
 * {"id": 7, "index": 0, "elements": [[x, y, width, height], ...]}: the element under the point and each of its
 * ancestors, deduplicated, in stage logical coordinates. The first output line is {"ready": true}, or
 * {"unavailable": "..."} when AT-SPI cannot be used.
 *
 * Applications only answer when they expose an accessibility tree. GTK and Qt do; Chromium and Electron apps only
 * when started with --force-renderer-accessibility. Their windows then come back with no elements, which leaves
 * whole-window boxes.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {roundHalfEven} from './visual.js';
import {stdin, stdout} from './worker.js';

const MIN_ELEMENT = 8;
const MAX_DEPTH = 64;
// Children searched by their extents when an application does not answer hit tests; long lists stop here.
const MAX_SCANNED_CHILDREN = 256;

const round2 = value => Math.round(value * 100) / 100;

// The value of `read()`, or `fallback` when the application behind it fails to answer.
function attempt(read, fallback = null) {
    try {
        return read();
    } catch {
        return fallback;
    }
}

// The child of `node` whose extents hold the window point x, y, searched last first since later children are drawn
// on top, or null.
function childAt(node, x, y, atspi) {
    const count = Math.min(attempt(() => node.get_child_count(), 0), MAX_SCANNED_CHILDREN);
    for (let index = count - 1; index >= 0; index--) {
        const child = attempt(() => node.get_child_at_index(index));
        const extents = child && attempt(() => child.get_extents(atspi.CoordType.WINDOW));
        if (extents && extents.x <= x && x < extents.x + extents.width &&
            extents.y <= y && y < extents.y + extents.height)
            return child;
    }
    return null;
}

/** One captured window, matched lazily to its accessible frame. atspi: the Atspi library, or a stand-in. */
export class Window {
    constructor(description, atspi) {
        this.atspi = atspi;
        this.pid = description.pid || 0;
        this.title = description.title || '';
        this.client = description.client.map(Number);
        this.frame = null;
        this.ratio = 1;
        this.resolved = false;
    }

    // Finds the frame for this window and how its coordinates scale to logical pixels.
    resolve() {
        this.resolved = true;
        const {atspi} = this;
        const frames = [];
        const desktop = atspi.get_desktop(0);
        for (let index = 0; index < desktop.get_child_count(); index++) {
            const app = attempt(() => desktop.get_child_at_index(index));
            if (!app || attempt(() => app.get_process_id()) !== this.pid)
                continue;
            const count = attempt(() => app.get_child_count(), 0);
            for (let child = 0; child < count; child++) {
                const frame = attempt(() => app.get_child_at_index(child));
                if (frame)
                    frames.push(frame);
            }
        }
        if (!frames.length)
            return;
        const [width, height] = [this.client[2], this.client[3]];
        // The title is the best evidence; the same aspect as the client area, at any scale, is the second best.
        const score = frame => attempt(() => {
            const extents = frame.get_extents(atspi.CoordType.WINDOW);
            const ratio = width ? extents.width / width : 1;
            const shaped = Math.abs(extents.height - height * ratio) <= 4 * ratio;
            return ((frame.get_name() ?? '') === this.title ? 2 : 0) + (shaped ? 1 : 0);
        }, 0);
        let best = frames[0];
        let bestScore = score(best);
        for (const frame of frames.slice(1)) {
            const value = score(frame);
            if (value > bestScore)
                [best, bestScore] = [frame, value];
        }
        // With several windows and none matching, any pick would draw another window's elements on this one.
        if (frames.length > 1 && !bestScore)
            return;
        this.frame = best;
        const extents = best.get_extents(atspi.CoordType.WINDOW);
        // X11 apps under fractional scaling can report device pixels rather than logical ones.
        const ratio = width && extents.width > 0 ? extents.width / width : 1;
        this.ratio = Math.abs(ratio - 1) < 0.02 ? 1 : ratio;
    }

    // Boxes around the stage point x, y, innermost first, as [[x, y, width, height], ...].
    elements(x, y) {
        if (!this.resolved)
            this.resolve();
        if (!this.frame)
            return [];
        const {atspi} = this;
        const localX = roundHalfEven((x - this.client[0]) * this.ratio);
        const localY = roundHalfEven((y - this.client[1]) * this.ratio);
        let node = this.frame;
        // GTK answers with the deepest element at once; a toolkit that answers with the direct child is descended.
        // GTK before 4.14 answers no hit test at all, so its tree is searched by the children's extents instead.
        for (let depth = 0; depth < MAX_DEPTH; depth++) {
            const child = node.get_accessible_at_point(localX, localY, atspi.CoordType.WINDOW) ??
                childAt(node, localX, localY, atspi);
            if (!child || child === node)
                break;
            node = child;
        }
        const found = [];
        const seen = new Set();
        for (let depth = 0; depth < MAX_DEPTH && node && node !== this.frame; depth++) {
            const current = node;
            const extents = attempt(() => current.get_extents(atspi.CoordType.WINDOW));
            if (extents && extents.width >= MIN_ELEMENT * this.ratio && extents.height >= MIN_ELEMENT * this.ratio) {
                const box = [round2(this.client[0] + extents.x / this.ratio), round2(this.client[1] + extents.y / this.ratio),
                    round2(extents.width / this.ratio), round2(extents.height / this.ratio)];
                if (!seen.has(box.join())) {
                    seen.add(box.join());
                    found.push(box);
                }
            }
            node = node.get_parent();
        }
        return found;
    }
}

/**
 * Answers each line of `lines`, an iterable of request strings, through `send(message)`. atspi: the Atspi library,
 * a stand-in, or null when it could not be loaded, with `missing` saying why.
 */
export function serve(lines, send, atspi, missing = '') {
    if (!atspi) {
        send({unavailable: `AT-SPI is not available: ${missing}`});
        return;
    }
    // A hung application must not stall every later hover; it just gets no boxes.
    atspi.set_timeout(500, 2000);
    let windows = new Map();
    send({ready: true});
    for (const line of lines) {
        const request = JSON.parse(line);
        if ('windows' in request) {
            windows = new Map(request.windows.map(item => [item.index, new Window(item, atspi)]));
            continue;
        }
        const window = windows.get(request.index);
        const elements = window ? attempt(() => window.elements(Number(request.x), Number(request.y)), []) : [];
        send({id: request.id, index: request.index, elements});
    }
}

// The lines of stdin, one at a time, as they arrive.
function* stdinLines() {
    const input = new Gio.DataInputStream({base_stream: stdin()});
    for (;;) {
        const [line] = input.read_line_utf8(null);
        if (line === null)
            return;
        yield line;
    }
}

// Run as a program, not when the tests import this module.
if (System.programPath === GLib.filename_from_uri(import.meta.url)[0]) {
    const output = stdout();
    const send = message => {
        output.write_all(new TextEncoder().encode(`${JSON.stringify(message)}\n`), null);
        output.flush(null);
    };
    let atspi = null;
    let missing = '';
    try {
        atspi = (await import('gi://Atspi?version=2.0')).default;
        atspi.init();
    } catch (error) {
        missing = error.message;
    }
    try {
        serve(stdinLines(), send, atspi, missing);
    } catch (error) {
        send({error: error.message});
        System.exit(1);
    }
}
