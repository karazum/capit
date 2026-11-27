// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CapIt panel detector, run as `gjs -m detector.js` so the pixel work stays off GNOME Shell's thread. It reads the
 * stream Shell sends: each window arrives on stdin as horizontal bands, top to bottom. A band is a JSON
 * header line {"index": 3, "origin": [1200, 80], "scale": 1.25, "part": 0, "parts": 4, "length": 81234} followed
 * by that many bytes of PNG; `origin` is the window's top-left in snapshot pixels. Once a window's last band
 * arrives, one JSON line goes to stdout: {"index": 3, "elements": [[960, 64, 200, 820], ...]}, rectangles in stage
 * logical coordinates. A malformed stream ends with {"error": "..."}.
 *
 * `--mode regions` also finds areas of flat background, as regions.js describes; the default, `--mode visual`,
 * only splits windows along dividers.
 */
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {detectRegions} from './regions.js';
import {detect, intensity} from './visual.js';
import {stdin, stdout} from './worker.js';

const MAX_FRAME_BYTES = 400_000_000;

// Reads exactly `length` bytes, or throws when the stream ends first.
function readExactly(input, length) {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
        const chunk = input.read_bytes(Math.min(length - offset, 1 << 20), null).toArray();
        if (chunk.length === 0)
            throw new Error('Truncated frame');
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

// {values, width, height} of one PNG band.
function decode(bytes) {
    const loader = new GdkPixbuf.PixbufLoader();
    loader.write_bytes(new GLib.Bytes(bytes));
    loader.close();
    const pixbuf = loader.get_pixbuf();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    return {
        values: intensity(pixbuf.get_pixels(), width, height, pixbuf.get_rowstride(), pixbuf.get_n_channels()),
        width, height,
    };
}

/**
 * Answers every window in `input`, a Gio.InputStream, on `write(line)`. Bands of a window are put together by
 * their `part` number, so they may arrive in any order. mode: 'visual' or 'regions'.
 */
export function serve(input, write, mode = 'visual') {
    const find = mode === 'regions' ? detectRegions : detect;
    const lines = new Gio.DataInputStream({base_stream: input, close_base_stream: false});
    const windows = new Map();
    for (;;) {
        const [header] = lines.read_line_utf8(null);
        if (header === null)
            return;
        const request = JSON.parse(header);
        const length = Number(request.length);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_FRAME_BYTES)
            throw new Error('Invalid frame length');
        const bytes = readExactly(lines, length);
        const scale = Number(request.scale);
        if (!(scale > 0 && scale <= 8))
            throw new Error('Invalid snapshot scale');
        const parts = Number(request.parts ?? 1);
        if (!Number.isInteger(parts) || parts <= 0 || parts > 10000)
            throw new Error('Invalid band count');
        const received = windows.get(request.index) ?? [];
        windows.set(request.index, received);
        received[request.part ?? 0] = decode(bytes);
        if (received.filter(Boolean).length < parts)
            continue;
        windows.delete(request.index);
        const width = received[0].width;
        const height = received.reduce((sum, band) => sum + band.height, 0);
        const values = new Int16Array(width * height);
        let offset = 0;
        for (const band of received) {
            if (band.width !== width)
                throw new Error('Bands of one window differ in width');
            values.set(band.values, offset);
            offset += band.values.length;
        }
        const origin = request.origin.map(Number);
        write(JSON.stringify({index: request.index, elements: find(values, width, height, scale, origin)}));
    }
}

// Run as a program, not when the tests import this module.
if (System.programPath === GLib.filename_from_uri(import.meta.url)[0]) {
    const output = stdout();
    const write = line => {
        output.write_all(new TextEncoder().encode(`${line}\n`), null);
        output.flush(null);
    };
    const mode = System.programArgs[0] === '--mode' ? System.programArgs[1] : 'visual';
    try {
        if (!['visual', 'regions'].includes(mode))
            throw new Error(`Unknown detection mode ${mode}`);
        serve(stdin(), write, mode);
    } catch (error) {
        write(JSON.stringify({error: error.message}));
        System.exit(1);
    }
}
