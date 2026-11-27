// SPDX-License-Identifier: GPL-3.0-or-later
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {execute} from '../../extension/renderer.js';
import {publish} from '../../extension/worker.js';
import {assert, loadImage, pixel, repoPath, temporaryDirectory, test} from './harness.js';

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

// A 80x60 source PNG painted by `paint(cr)`, white when none is given, in a new temporary folder.
function setUp(paint = null) {
    const [root, cleanup] = temporaryDirectory();
    const source = `${root}/source.png`;
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 80, 60);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    paint?.(cr);
    cr.$dispose();
    surface.writeToPNG(source);
    const request = values => ({
        action: 'render', source, artifact: `${root}/final.png`, origin: [100, 50], scale: 2,
        annotations: [], save: false, ...values,
    });
    return {root, source, request, cleanup};
}

function withSetUp(body, paint = null) {
    return () => {
        const setup = setUp(paint);
        try {
            body(setup);
        } finally {
            setup.cleanup();
        }
    };
}

function rgb(value) {
    return value.slice(0, 3);
}

test('a redaction uses stage coordinates and is flattened opaque', withSetUp(({source, request}) => {
    const result = execute(request({annotations: [{kind: 'redact', x1: 110, y1: 55, x2: 120, y2: 65, color: '#000000'}]}));
    assert.deepEqual([result.width, result.height], [80, 60]);
    const image = loadImage(result.artifact);
    assert.deepEqual(pixel(image, 25, 15), BLACK);
    assert.deepEqual(pixel(image, 10, 15), WHITE);
    assert.deepEqual(pixel(loadImage(source), 25, 15), WHITE);
}));

test('a redaction is filled opaque in its colour', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        annotations: [{kind: 'redact', x1: 110, y1: 55, x2: 120, y2: 65, color: '#75bbff'}],
    })).artifact);
    assert.deepEqual(pixel(image, 25, 15), [0x75, 0xbb, 0xff, 255]);
    assert.deepEqual(pixel(image, 10, 15), BLACK);
}, cr => {
    // A dark capture, so a translucent fill would show as a darker blue.
    cr.setSourceRGB(0, 0, 0);
    cr.paint();
}));

test('a brush strokes a smooth curve through its samples and a click leaves a dot', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        annotations: [
            {kind: 'brush', points: [[105, 55], [120, 70], [135, 55]], color: '#000000', width: 2},
            {kind: 'brush', points: [[110, 76]], color: '#000000', width: 4},
        ],
    })).artifact);
    // Halfway along the first curve, which bends toward the middle sample without reaching it.
    assert.deepEqual(rgb(pixel(image, 36, 28)), [0, 0, 0]);
    assert.deepEqual(rgb(pixel(image, 40, 40)), [255, 255, 255]);
    assert.deepEqual(rgb(pixel(image, 20, 52)), [0, 0, 0]);
    assert.deepEqual(rgb(pixel(image, 5, 5)), [255, 255, 255]);
}));

test('a circle strokes the ellipse inside its box and a flat one is a line', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        annotations: [
            {kind: 'ellipse', x1: 135, y1: 75, x2: 105, y2: 55, color: '#000000', width: 2},
            {kind: 'ellipse', x1: 105, y1: 78, x2: 135, y2: 78, color: '#000000', width: 2},
        ],
    })).artifact);
    // The outline at the ends of both axes, at scale 2 around the centre (40, 30).
    for (const [x, y] of [[70, 30], [10, 30], [40, 10], [40, 50]])
        assert.deepEqual(rgb(pixel(image, x, y)), [0, 0, 0], `${x},${y}`);
    // Neither the inside nor the corners of the box are painted.
    for (const [x, y] of [[40, 30], [11, 11], [69, 49]])
        assert.deepEqual(rgb(pixel(image, x, y)), [255, 255, 255], `${x},${y}`);
    assert.deepEqual(rgb(pixel(image, 40, 56)), [0, 0, 0]);
}));

test('malformed annotations are rejected before an artifact is written', withSetUp(({root, request}) => {
    for (const points of [[], 'nope', [[1, 2, 3]], [[1, NaN]]])
        assert.throws(() => execute(request({annotations: [{kind: 'brush', points}]})), /brush|points/);
    assert.throws(() => execute(request({annotations: [{kind: 'arrow', x1: 1, y1: 2, x2: 'x', y2: 4}]})), /x2/);
    assert.throws(() => execute(request({
        annotations: [{
            kind: 'rectangle', x1: 1, y1: 2, x2: 3, y2: 4,
            color: 'red',
        }],
    })), /color/);
    assert.throws(() => execute(request({annotations: [{kind: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, width: 100}]})),
        /width/);
    assert.throws(() => execute(request({annotations: [{kind: 'stamp', x1: 1, y1: 2}]})), /tool/);
    assert.throws(() => execute(request({scale: NaN})), /scale/);
    assert.ok(!GLib.file_test(`${root}/final.png`, GLib.FileTest.EXISTS));
}));

test('an annotation outside the moved crop does not reappear at its relative position', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        origin: [200, 50],
        annotations: [{kind: 'redact', x1: 110, y1: 55, x2: 120, y2: 65}],
    })).artifact);
    assert.deepEqual(pixel(image, 25, 15), WHITE);
}));

test('fractional redaction edges cover every touched pixel without blending', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        scale: 1.25, origin: [100, 50],
        annotations: [{kind: 'redact', x1: 101, y1: 51, x2: 105, y2: 55, color: '#000000'}],
    })).artifact);
    // Device bounds are [1.25, 6.25], so pixels 1 through 6 are fully black.
    for (const [x, y] of [[1, 1], [6, 1], [1, 6], [6, 6], [3, 3]])
        assert.deepEqual(pixel(image, x, y), BLACK, `${x},${y}`);
    assert.deepEqual(pixel(image, 0, 1), WHITE);
    assert.deepEqual(pixel(image, 7, 6), WHITE);
}));

test('a blur mixes detail inside its box and leaves the outside untouched', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        scale: 1, origin: [0, 0],
        annotations: [{kind: 'blur', x1: 10, y1: 10, x2: 70, y2: 50}],
    })).artifact);
    const edge = pixel(image, 40, 30);
    assert.ok(edge[0] > 0 && edge[0] < 255 && edge[3] === 255, `edge ${edge}`);
    assert.deepEqual(pixel(image, 5, 30), BLACK);
    assert.deepEqual(pixel(image, 75, 30), WHITE);
}, cr => {
    cr.setSourceRGB(0, 0, 0);
    cr.rectangle(0, 0, 40, 60);
    cr.fill();
}));

test('a blur leaves annotations drawn before it sharp, as the editor previews', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        annotations: [
            {kind: 'redact', x1: 110, y1: 55, x2: 120, y2: 65, color: '#000000'},
            {kind: 'blur', x1: 100, y1: 50, x2: 140, y2: 80},
        ],
    })).artifact);
    assert.deepEqual(pixel(image, 25, 15), BLACK);
    assert.deepEqual(pixel(image, 21, 11), BLACK);
}));

test('text is drawn in its colour below its top-left corner', withSetUp(({request}) => {
    const image = loadImage(execute(request({
        scale: 1, origin: [0, 0],
        annotations: [{kind: 'text', x1: 4, y1: 4, text: 'MMMM', color: '#000000', size: 24}],
    })).artifact);
    let dark = 0;
    for (let y = 4; y < 32; y++) {
        for (let x = 4; x < 76; x++)
            dark += pixel(image, x, y)[0] < 100 ? 1 : 0;
    }
    assert.ok(dark > 100, `only ${dark} dark pixels`);
    assert.deepEqual(pixel(image, 40, 50), WHITE);
}));

test('a failed save keeps the rendered artifact available for a retry', withSetUp(({root, request}) => {
    const folder = `${root}/not-a-folder`;
    GLib.file_set_contents(folder, 'existing file');
    const result = execute(request({save: true, directory: folder}));
    assert.ok(result.saveError, 'no save error');
    assert.ok(GLib.file_test(result.artifact, GLib.FileTest.IS_REGULAR));
    const retry = execute({action: 'save', artifact: result.artifact, save: true, directory: `${root}/output`});
    assert.deepEqual(GLib.file_get_contents(retry.savedPath)[1], GLib.file_get_contents(result.artifact)[1]);
    assert.equal(new TextDecoder().decode(GLib.file_get_contents(folder)[1]), 'existing file');
}));

test('saves in the same second get their own names, whole and private', withSetUp(({root, request}) => {
    const {artifact} = execute(request());
    const paths = Array.from({length: 6}, () => publish(artifact, `${root}/output`, '.png'));
    assert.equal(new Set(paths).size, 6);
    const expected = GLib.file_get_contents(artifact)[1];
    for (const path of paths) {
        assert.deepEqual(GLib.file_get_contents(path)[1], expected, path);
        const mode = Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint32('unix::mode');
        assert.equal(mode & 0o777, 0o600, path);
    }
    const names = [];
    const children = Gio.File.new_for_path(`${root}/output`).enumerate_children('standard::name', 0, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    assert.equal(names.length, 6, `left behind: ${names}`);
}));

test('saves from separate processes at once never overwrite each other', withSetUp(({root, request}) => {
    const {artifact} = execute(request());
    const workers = Array.from({length: 6}, () => {
        const process = Gio.Subprocess.new(['gjs', '-m', repoPath('extension/renderer.js')],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        process.get_stdin_pipe().write_all(new TextEncoder().encode(JSON.stringify(
            {action: 'save', artifact, save: true, directory: `${root}/output`})), null);
        process.get_stdin_pipe().close(null);
        return process;
    });
    // Each has its whole request before any answer is read, so all six save at once.
    const paths = workers.map(process => {
        const [line] = new Gio.DataInputStream({base_stream: process.get_stdout_pipe()}).read_line_utf8(null);
        process.wait(null);
        return JSON.parse(line).savedPath;
    });
    assert.equal(new Set(paths).size, 6, `${paths}`);
}));

test('a clipboard copy outlives the artifact and only the newest is kept', withSetUp(({root, request}) => {
    const {artifact} = execute(request());
    const clipboard = `${root}/clipboard`;
    GLib.mkdir_with_parents(clipboard, 0o700);
    GLib.file_set_contents(`${clipboard}/CapIt_2026-01-01_00-00-00.gif`, 'older recording');
    const result = execute({action: 'clipboard', artifact, clipboardDirectory: clipboard});
    Gio.File.new_for_path(artifact).delete(null);
    const children = Gio.File.new_for_path(clipboard).enumerate_children('standard::name', 0, null);
    const names = [];
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    assert.deepEqual(names, [GLib.path_get_basename(result.clipboardPath)]);
    assert.ok(result.clipboardPath.endsWith('.png'));
}));

// Pixel by pixel against fixed reference PNGs drawn for the requests in cases.json. A deliberate change to how annotations
// are drawn replaces the affected PNGs with the new output after checking it by eye.
test('the export matches the reference PNG of every case', () => {
    const folder = repoPath('tests/fixtures/golden/renderer');
    const cases = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${folder}/cases.json`)[1]));
    const [root, cleanup] = temporaryDirectory();
    try {
        for (const [name, entry] of Object.entries(cases)) {
            const artifact = `${root}/${name}.png`;
            execute({
                action: 'render', source: `${folder}/${entry.source}`, artifact, origin: entry.origin,
                scale: entry.scale, annotations: entry.annotations,
            });
            const actual = loadImage(artifact);
            const expected = loadImage(`${folder}/${name}.png`);
            assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], name);
            let worst = 0;
            for (let y = 0; y < actual.height; y++) {
                for (let x = 0; x < actual.width; x++) {
                    const a = pixel(actual, x, y);
                    const b = pixel(expected, x, y);
                    worst = Math.max(worst, ...a.map((value, channel) => Math.abs(value - b[channel])));
                }
            }
            assert.equal(worst, 0, `${name} differs by up to ${worst}`);
        }
    } finally {
        cleanup();
    }
});
