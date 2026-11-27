// SPDX-License-Identifier: GPL-3.0-or-later
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {serve} from '../../extension/detector.js';
import {detectRegions} from '../../extension/regions.js';
import {detect, intensity} from '../../extension/visual.js';
import {assert, loadImage, repoPath, temporaryDirectory, test} from './harness.js';

// The boxes each detection mode must find in every reference image. They are fixed: a deliberate change to a
// detector's boxes updates detection.json by hand, after checking the new boxes on the image.
const golden = JSON.parse(new TextDecoder().decode(
    GLib.file_get_contents(repoPath('tests/fixtures/golden/detection.json'))[1]));

function intensityOf(name) {
    const image = loadImage(repoPath(`tests/fixtures/${name}`));
    return {values: intensity(image.pixels, image.width, image.height, image.rowstride, image.channels), ...image};
}

// Whether two lists of [x, y, width, height] boxes are the same, allowing for rounding to two decimals.
function sameBoxes(actual, expected) {
    return actual.length === expected.length && actual.every((box, index) =>
        box.every((value, axis) => Math.abs(value - expected[index][axis]) <= 0.011));
}

test('intensity matches the reference on every reference image', () => {
    for (const [name, entry] of Object.entries(golden)) {
        const {values} = intensityOf(name);
        const sum = values.reduce((total, value) => total + value, 0);
        const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
            new GLib.Bytes(new Uint8Array(values.buffer)));
        assert.deepEqual([sum, checksum], [entry.intensity.sum, entry.intensity.sha256], name);
    }
});

test('the visual detector finds the reference boxes on every reference image', () => {
    for (const [name, entry] of Object.entries(golden)) {
        const {values, width, height} = intensityOf(name);
        const found = detect(values, width, height, entry.scale, [0, 0]);
        assert.ok(sameBoxes(found, entry.visual), `${name}: ${JSON.stringify(found)} != ${JSON.stringify(entry.visual)}`);
    }
});

test('boxes are stage logical coordinates', () => {
    const {values, width, height} = intensityOf('synthetic/ide-1.25.png');
    const at = detect(values, width, height, 1.25, [500, 250]);
    const origin = golden['synthetic/ide-1.25.png'].visual;
    assert.ok(sameBoxes(at, origin.map(([x, y, w, h]) => [x + 400, y + 200, w, h])), JSON.stringify(at));
});

// One window's PNG bands as [header, bytes] pairs, cut every `rows` rows of the image at `path`.
function bands(path, index, origin, rows) {
    const whole = Cairo.ImageSurface.createFromPNG(path);
    const [root, cleanup] = temporaryDirectory();
    try {
        const parts = Math.ceil(whole.getHeight() / rows);
        return Array.from({length: parts}, (_, part) => {
            const height = Math.min(rows, whole.getHeight() - part * rows);
            const band = new Cairo.ImageSurface(Cairo.Format.ARGB32, whole.getWidth(), height);
            const cr = new Cairo.Context(band);
            cr.setSourceSurface(whole, 0, -part * rows);
            cr.paint();
            cr.$dispose();
            band.writeToPNG(`${root}/band.png`);
            const bytes = GLib.file_get_contents(`${root}/band.png`)[1];
            return [{index, origin, scale: 1, part, parts, length: bytes.length}, bytes];
        });
    } finally {
        cleanup();
    }
}

function stream(frames) {
    const chunks = frames.flatMap(([header, bytes]) => [new TextEncoder().encode(`${JSON.stringify(header)}\n`), bytes]);
    const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    return Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(all));
}

test('each window streamed answers one line, whether sent whole or in bands in any order', () => {
    const path = repoPath('tests/fixtures/synthetic/ide-1.png');
    const expected = golden['synthetic/ide-1.png'].visual;
    const lines = [];
    const banded = bands(path, 5, [0, 0], 300);
    serve(stream([...bands(path, 2, [0, 0], 10000), banded[2], banded[0], banded[1]]), line => lines.push(JSON.parse(line)));
    assert.deepEqual(lines.map(line => line.index), [2, 5]);
    assert.ok(sameBoxes(lines[0].elements, expected), JSON.stringify(lines[0].elements));
    assert.ok(sameBoxes(lines[1].elements, expected), JSON.stringify(lines[1].elements));
});

test('the detector program answers on stdout and reports a truncated stream', () => {
    const [header, bytes] = bands(repoPath('tests/fixtures/synthetic/ide-1.png'), 0, [100, 40], 10000)[0];
    const run = input => {
        const process = Gio.Subprocess.new(['gjs', '-m', repoPath('extension/detector.js')],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        const [, stdout] = process.communicate(new GLib.Bytes(input), null);
        return [process.get_exit_status(), new TextDecoder().decode(stdout.toArray()).trim().split('\n').map(JSON.parse)];
    };
    const whole = new Uint8Array([...new TextEncoder().encode(`${JSON.stringify(header)}\n`), ...bytes]);
    const [status, lines] = run(whole);
    assert.equal(status, 0);
    assert.ok(sameBoxes(lines[0].elements, golden['synthetic/ide-1.png'].visual.map(([x, y, w, h]) =>
        [x + 100, y + 40, w, h])), JSON.stringify(lines));
    const [failed, error] = run(whole.subarray(0, whole.length - 10));
    assert.equal(failed, 1);
    assert.ok(/Truncated/.test(error[0].error), JSON.stringify(error));
});

test('the regions detector finds the reference boxes on every reference image', () => {
    for (const [name, entry] of Object.entries(golden)) {
        const {values, width, height} = intensityOf(name);
        const found = detectRegions(values, width, height, entry.scale, [0, 0]);
        assert.ok(sameBoxes(found, entry.regions), `${name}: ${JSON.stringify(found)} != ${JSON.stringify(entry.regions)}`);
    }
});

test('the detector program serves the regions mode', () => {
    const [header, bytes] = bands(repoPath('tests/fixtures/synthetic/settings-1.png'), 0, [0, 0], 10000)[0];
    const process = Gio.Subprocess.new(['gjs', '-m', repoPath('extension/detector.js'), '--mode', 'regions'],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    const input = new Uint8Array([...new TextEncoder().encode(`${JSON.stringify(header)}\n`), ...bytes]);
    const [, stdout] = process.communicate(new GLib.Bytes(input), null);
    const [line] = new TextDecoder().decode(stdout.toArray()).trim().split('\n').map(JSON.parse);
    assert.ok(sameBoxes(line.elements, golden['synthetic/settings-1.png'].regions), JSON.stringify(line));
});
