// SPDX-License-Identifier: GPL-3.0-or-later
// Annotation drawing shared by the overlay's live preview and renderer.js's exported PNG, so the two match. It
// imports only Cairo, as renderer.js runs in a plain `gjs` process outside GNOME Shell.
import Cairo from 'cairo';

// Device pixels averaged into one by an exported blur; the overlay's live blur radius is matched to it by eye.
const BLUR_BLOCK = 12;

// Smooths a brush stroke with curves through the midpoints between pointer samples, so a fast stroke reads as a
// curve instead of a polyline. A single sample is a zero-length line that the round cap draws as a dot.
function traceBrush(cr, points) {
    let [x, y] = points[0];
    cr.moveTo(x, y);
    for (let index = 1; index < points.length - 1; index++) {
        const [qx, qy] = points[index];
        const [ex, ey] = [(qx + points[index + 1][0]) / 2, (qy + points[index + 1][1]) / 2];
        // Cairo has only cubic curves; this is the quadratic one with control point (qx, qy).
        cr.curveTo(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey);
        [x, y] = [ex, ey];
    }
    const [lx, ly] = points[points.length - 1];
    cr.lineTo(lx, ly);
}

// Traces the ellipse inscribed in the box between two corners. A box with no width or height has no ellipse to
// scale a circle into, so it becomes the line along its one side.
function traceEllipse(cr, x1, y1, x2, y2) {
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    if (rx === 0 || ry === 0) {
        cr.moveTo(x1, y1);
        cr.lineTo(x2, y2);
        return;
    }
    // Scaled only while tracing, so the stroke keeps an even width all round.
    cr.save();
    cr.translate((x1 + x2) / 2, (y1 + y2) / 2);
    cr.scale(rx, ry);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.closePath();
    cr.restore();
}

/**
 * Draws one annotation on `cr`, in stage logical coordinates. `exported` is null for the overlay's preview, where
 * a blur is a GPU effect under the drawing and shows only as a faint outline, and a redaction is filled as drawn,
 * in its colour.
 * For the exported PNG it is {original}, the untouched capture as a Cairo surface: a blur then averages that
 * capture's pixels, and a redaction covers every device pixel it touches.
 */
export function paintOperation(cr, operation, exported = null) {
    const {kind, x1, y1, x2, y2, color = '#ff595e', width = 3} = operation;
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    cr.save();
    cr.setSourceRGB(...rgb);
    cr.setLineWidth(width);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    if (kind === 'text') {
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(operation.size ?? 24);
        cr.moveTo(x1, y1 + (operation.size ?? 24));
        cr.showText(operation.text);
    } else if (kind === 'brush') {
        traceBrush(cr, operation.points);
        cr.stroke();
    } else if (kind === 'ellipse') {
        traceEllipse(cr, x1, y1, x2, y2);
        cr.stroke();
    } else if (kind === 'arrow') {
        cr.moveTo(x1, y1);
        cr.lineTo(x2, y2);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = 12 + width * 1.5;
        for (const offset of [-0.45, 0.45]) {
            cr.moveTo(x2, y2);
            cr.lineTo(x2 - head * Math.cos(angle + offset), y2 - head * Math.sin(angle + offset));
        }
        cr.stroke();
    } else if (kind === 'blur' && exported) {
        blurRegion(cr, exported.original, Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
    } else if (kind === 'redact' && exported) {
        // Every output pixel the box touches is covered whole: an antialiased fractional edge would blend the
        // original sensitive pixels into the redaction.
        const [left, top] = cr.userToDevice(Math.min(x1, x2), Math.min(y1, y2));
        const [right, bottom] = cr.userToDevice(Math.max(x1, x2), Math.max(y1, y2));
        cr.identityMatrix();
        cr.rectangle(Math.floor(left), Math.floor(top), Math.ceil(right) - Math.floor(left),
            Math.ceil(bottom) - Math.floor(top));
        cr.fill();
    } else {
        cr.rectangle(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        if (kind === 'blur') {
            // The blur itself is a GPU effect under this layer; a faint edge still shows a box over flat colour.
            cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.setLineWidth(1);
            cr.stroke();
        } else if (kind === 'redact') {
            cr.fill();
        } else {
            cr.stroke();
        }
    }
    cr.restore();
}

// Replaces the box between (x1, y1) and (x2, y2), in user coordinates, with a heavily averaged copy of the same
// box of `original`. The box is shrunk to about one pixel per BLUR_BLOCK device pixels and scaled back up
// smoothly, so the original detail cannot be recovered.
function blurRegion(cr, original, x1, y1, x2, y2) {
    const target = cr.getTarget();
    let [left, top] = cr.userToDevice(x1, y1);
    let [right, bottom] = cr.userToDevice(x2, y2);
    left = Math.max(0, Math.floor(left));
    top = Math.max(0, Math.floor(top));
    right = Math.min(target.getWidth(), Math.ceil(right));
    bottom = Math.min(target.getHeight(), Math.ceil(bottom));
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1)
        return;
    const region = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const copy = new Cairo.Context(region);
    copy.setSourceSurface(original, -left, -top);
    copy.paint();
    copy.$dispose();
    const small = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.max(1, Math.floor(width / BLUR_BLOCK)),
        Math.max(1, Math.floor(height / BLUR_BLOCK)));
    const shrink = new Cairo.Context(small);
    shrink.scale(small.getWidth() / width, small.getHeight() / height);
    shrink.setSourceSurface(region, 0, 0);
    shrink.getSource().setFilter(Cairo.Filter.GOOD);
    shrink.paint();
    shrink.$dispose();
    cr.identityMatrix();
    cr.rectangle(left, top, width, height);
    cr.clip();
    cr.translate(left, top);
    cr.scale(width / small.getWidth(), height / small.getHeight());
    cr.setSourceSurface(small, 0, 0);
    cr.getSource().setFilter(Cairo.Filter.BILINEAR);
    cr.getSource().setExtend(Cairo.Extend.PAD);
    cr.setOperator(Cairo.Operator.SOURCE);
    cr.paint();
}
