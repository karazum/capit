// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CapIt PNG worker, run as `gjs -m renderer.js` so drawing and PNG encoding stay off GNOME Shell's thread. One JSON
 * request arrives on stdin and one JSON answer leaves on stdout; no desktop access is needed. Requests:
 * - {action: 'render', source, artifact, scale, origin: [x, y], annotations: [...], save, directory}: draws the
 *   annotations, in stage logical coordinates, over the PNG at `source`, a crop whose top-left is `origin`, and
 *   writes `artifact`. Answers {artifact, width, height}, plus {savedPath} or {saveError} when `save` is set.
 * - {action: 'save', artifact, save: true, directory}: saves an artifact rendered earlier.
 * - {action: 'clipboard', artifact, clipboardDirectory}: answers {clipboardPath}, a copy that outlives the capture.
 * A failure answers {error} and exits with status 1.
 */
import Cairo from 'cairo';
import GLib from 'gi://GLib';
import System from 'system';

import {paintOperation} from './paint.js';
import {clipboardCopy, publish, readRequest, restrict} from './worker.js';

const KINDS = ['arrow', 'rectangle', 'ellipse', 'brush', 'blur', 'redact', 'text'];
const MAX_BRUSH_POINTS = 100_000;
const MAX_REQUEST_BYTES = 5_000_000;
const MAX_PIXELS = 180_000_000;

function number(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`Invalid ${name}`);
    return value;
}

// Throws unless `operation` is an annotation renderer.js can draw, so a malformed request fails before any file is
// written.
function validate(operation) {
    if (typeof operation !== 'object' || operation === null || !KINDS.includes(operation.kind))
        throw new Error('Unknown annotation tool');
    if (!/^#[0-9a-fA-F]{6}$/.test(operation.color ?? '#ff595e'))
        throw new Error('Invalid annotation color');
    const width = number(operation.width ?? 3, 'width');
    if (width < 0.5 || width > 64)
        throw new Error('Invalid annotation width');
    if (operation.kind === 'brush') {
        const {points} = operation;
        if (!Array.isArray(points) || points.length < 1 || points.length > MAX_BRUSH_POINTS ||
            !points.every(point => Array.isArray(point) && point.length === 2))
            throw new Error('Invalid brush stroke');
        points.forEach(([x, y]) => [number(x, 'points'), number(y, 'points')]);
        return;
    }
    number(operation.x1, 'x1');
    number(operation.y1, 'y1');
    if (operation.kind === 'text') {
        if (typeof operation.text !== 'string' || operation.text.length > 4096)
            throw new Error('Invalid annotation text');
        const size = number(operation.size ?? 24, 'size');
        if (size < 4 || size > 1000)
            throw new Error('Invalid annotation text size');
        return;
    }
    number(operation.x2, 'x2');
    number(operation.y2, 'y2');
}

function render(request) {
    const scale = number(request.scale, 'scale');
    if (scale <= 0 || scale > 8)
        throw new Error('Invalid snapshot scale');
    const origin = request.origin ?? [];
    if (!Array.isArray(origin) || origin.length !== 2)
        throw new Error('Invalid crop origin');
    const [x, y] = origin.map(value => number(value, 'origin'));
    const annotations = request.annotations ?? [];
    if (!Array.isArray(annotations) || annotations.length > 10000)
        throw new Error('Invalid annotation list');
    annotations.forEach(validate);
    const image = Cairo.ImageSurface.createFromPNG(request.source);
    if (image.getWidth() * image.getHeight() > MAX_PIXELS)
        throw new Error('Capture exceeds the supported image size');
    // Blurs read the untouched capture: a copy taken before anything is drawn.
    const original = new Cairo.ImageSurface(Cairo.Format.ARGB32, image.getWidth(), image.getHeight());
    const copy = new Cairo.Context(original);
    copy.setSourceSurface(image, 0, 0);
    copy.paint();
    copy.$dispose();
    const cr = new Cairo.Context(image);
    cr.scale(scale, scale);
    cr.translate(-x, -y);
    // The editor previews every blur on the captured screen with the other annotations drawn over it, so blurs go
    // first; a blur over an arrow or text leaves it sharp, as previewed.
    const blurs = annotations.filter(operation => operation.kind === 'blur');
    for (const operation of [...blurs, ...annotations.filter(other => other.kind !== 'blur')])
        paintOperation(cr, operation, {original});
    cr.$dispose();
    image.writeToPNG(request.artifact);
    restrict(request.artifact);
    return {artifact: request.artifact, width: image.getWidth(), height: image.getHeight()};
}

export function execute(request) {
    let result;
    if (request.action === 'render')
        result = render(request);
    else if (request.action === 'save')
        result = {artifact: request.artifact};
    else if (request.action === 'clipboard')
        return {clipboardPath: clipboardCopy(request.artifact, request.clipboardDirectory)};
    else
        throw new Error('Unknown render action');
    if (request.save) {
        try {
            result.savedPath = publish(result.artifact, request.directory, '.png');
        } catch (error) {
            result.saveError = error.message;
        }
    }
    return result;
}

// Run as a program, not when the tests import this module.
if (System.programPath === GLib.filename_from_uri(import.meta.url)[0]) {
    try {
        print(JSON.stringify(execute(readRequest(MAX_REQUEST_BYTES))));
    } catch (error) {
        print(JSON.stringify({error: error.message}));
        System.exit(1);
    }
}
