// SPDX-License-Identifier: GPL-3.0-or-later
// St and Cairo pieces the capture overlay and the recording bar are built from: toolbar glyphs, buttons and the
// patches the overlay paints in.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {opBounds, snapRect} from './model.js';

// Space between the region and its toolbar, clear of the 12 px grab zone of the corner handles.
export const TOOLBAR_GAP = 12;
// Toolbar glyphs are drawn at this size; paintIcon's 20 px grid is scaled up to it.
export const TOOL_ICON_SIZE = 22;
// How far below a toolbar glyph its shortcut label reaches, in pixels.
const KEY_HINT_DROP = 9;

// A vertical St.BoxLayout. GNOME 48 deprecated `vertical` for the `orientation` that earlier versions lack.
export function verticalBox(params) {
    const direction = 'orientation' in St.BoxLayout.prototype
        ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
    return new St.BoxLayout({...params, ...direction});
}

// 20x20 monochrome glyphs for the toolbar, drawn with Cairo so no icon theme is required.
const ICON_COLORS = {
    select: '#f2f5fb', arrow: '#ff6b6b', rectangle: '#6ab0ff', ellipse: '#78d391', brush: '#c77dff',
    blur: '#8fd3ff', redact: '#f2f5fb', text: '#f2f5fb', undo: '#c9ced8', redo: '#c9ced8', copy: '#6ab0ff',
    save: '#78d391', folder: '#ffca3a', cancel: '#ff6b6b', confirm: '#78d391', grip: '#8b93a1', record: '#ff4d4d',
    'mode-image': '#f2f5fb', 'mode-gif': '#f2f5fb', 'mode-video': '#f2f5fb', 'demo-cursor': '#ffd600',
    stop: '#ff4d4d',
};

/* eslint-disable max-statements-per-line -- each line of a glyph below is one stroke or shape */
export function paintIcon(cr, id) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(ICON_COLORS[id].slice(i, i + 2), 16) / 255);
    cr.setSourceRGB(r, g, b);
    cr.setLineWidth(1.8);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    switch (id) {
    case 'select':
        cr.moveTo(5, 3); cr.lineTo(5, 16); cr.lineTo(8.5, 12.5); cr.lineTo(12, 18); cr.lineTo(14, 17);
        cr.lineTo(10.5, 11.5); cr.lineTo(15, 11); cr.closePath(); cr.fill();
        break;
    case 'arrow':
        cr.moveTo(4, 16); cr.lineTo(16, 4); cr.moveTo(8.5, 4); cr.lineTo(16, 4); cr.lineTo(16, 11.5); cr.stroke();
        break;
    case 'rectangle':
        cr.rectangle(3.5, 5, 13, 10); cr.stroke();
        break;
    case 'ellipse':
        cr.arc(10, 10, 6.5, 0, 2 * Math.PI); cr.stroke();
        break;
    case 'brush':
        cr.setLineWidth(2.2);
        cr.moveTo(3, 14); cr.curveTo(6, 4, 9, 4, 10, 10); cr.curveTo(11, 16, 15, 16, 17, 6); cr.stroke();
        break;
    case 'blur':
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                cr.setSourceRGBA(r, g, b, 1 - (i + j) * 0.2);
                cr.arc(5 + j * 5, 5 + i * 5, 2.1, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        break;
    case 'redact':
        cr.rectangle(3, 5, 14, 10); cr.fill();
        break;
    case 'text':
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(18); cr.moveTo(4.5, 16); cr.showText('T');
        break;
    case 'undo': case 'redo':
        if (id === 'redo') {
            cr.translate(20, 0); cr.scale(-1, 1);
        }
        cr.arc(10.5, 11.5, 5.5, Math.PI * 1.1, Math.PI * 2.1); cr.stroke();
        cr.moveTo(2.5, 6.5); cr.lineTo(5, 10.5); cr.lineTo(8.5, 8); cr.stroke();
        break;
    case 'copy':
        cr.rectangle(7, 7, 9, 9); cr.stroke(); cr.moveTo(4, 12); cr.lineTo(4, 4); cr.lineTo(12, 4); cr.stroke();
        break;
    case 'save':
        cr.moveTo(10, 3); cr.lineTo(10, 12); cr.moveTo(6, 8.5); cr.lineTo(10, 12.5); cr.lineTo(14, 8.5);
        cr.moveTo(4, 16); cr.lineTo(16, 16); cr.stroke();
        break;
    case 'folder':
        cr.moveTo(3, 6); cr.lineTo(8, 6); cr.lineTo(9.5, 8); cr.lineTo(17, 8); cr.lineTo(17, 15.5);
        cr.lineTo(3, 15.5); cr.closePath(); cr.stroke();
        break;
    case 'cancel':
        cr.moveTo(5, 5); cr.lineTo(15, 15); cr.moveTo(15, 5); cr.lineTo(5, 15); cr.stroke();
        break;
    case 'record':
        cr.arc(10, 10, 6, 0, 2 * Math.PI); cr.fill();
        break;
    case 'stop':
        cr.rectangle(4.5, 4.5, 11, 11); cr.fill();
        break;
    case 'demo-cursor':
        // The demo cursor's halo around a pointer arrow.
        cr.setSourceRGBA(r, g, b, 0.35);
        cr.arc(7.5, 7.5, 6.5, 0, 2 * Math.PI); cr.fill();
        cr.setSourceRGB(r, g, b);
        cr.arc(7.5, 7.5, 6.5, 0, 2 * Math.PI); cr.stroke();
        cr.setSourceRGB(0.95, 0.96, 0.98);
        cr.moveTo(7.5, 7.5); cr.lineTo(7.5, 18.5); cr.lineTo(10.3, 15.6); cr.lineTo(12.6, 19.5);
        cr.lineTo(14.3, 18.6); cr.lineTo(12.1, 14.8); cr.lineTo(16, 14.4); cr.closePath(); cr.fill();
        break;
    case 'mode-image':
        // A camera: body, lens and the bump of the viewfinder.
        cr.rectangle(2.5, 6, 15, 10); cr.stroke();
        cr.arc(10, 11, 3, 0, 2 * Math.PI); cr.stroke();
        cr.moveTo(7, 6); cr.lineTo(8, 3.5); cr.lineTo(12, 3.5); cr.lineTo(13, 6); cr.stroke();
        break;
    case 'mode-gif':
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(8.5); cr.moveTo(1.5, 13.5); cr.showText('GIF');
        break;
    case 'mode-video':
        // A video camera: body and the lens hood on its right.
        cr.rectangle(2, 6, 11, 9); cr.stroke();
        cr.moveTo(13, 9); cr.lineTo(18, 6); cr.lineTo(18, 15); cr.lineTo(13, 12); cr.closePath(); cr.stroke();
        break;
    case 'confirm':
        cr.setLineWidth(2.4); cr.moveTo(4, 10.5); cr.lineTo(8.5, 15); cr.lineTo(16.5, 5.5); cr.stroke();
        break;
    case 'grip':
        // Two columns of dots in a 10x20 area, the usual "drag me" mark.
        for (const x of [3, 7]) {
            for (const y of [6, 10, 14]) {
                cr.arc(x, y, 1.3, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        break;
    }
}
/* eslint-enable max-statements-per-line */

export function measureText(text, size, weight = Cairo.FontWeight.BOLD) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
    const cr = new Cairo.Context(surface);
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, weight);
    cr.setFontSize(size);
    const extents = cr.textExtents(text);
    cr.$dispose();
    surface.finish();
    return extents.xAdvance ?? extents.width;
}

// Stage area an annotation's paint can reach, including stroke width, arrowheads and its edit handles.
export function paintBounds(operation) {
    const bounds = operation.kind === 'text' && operation.textWidth === undefined
        ? {...opBounds(operation), width: measureText(operation.text, operation.size ?? 24)} : opBounds(operation);
    const width = operation.width ?? 3;
    const margin = width + 8 + (operation.kind === 'arrow' ? 12 + width * 1.5 : 0);
    return {
        x: bounds.x - margin, y: bounds.y - margin,
        width: bounds.width + 2 * margin, height: bounds.height + 2 * margin,
    };
}

// At the common fractional scales (125%, 150%, 175%) every 4 logical pixels are whole device pixels, so patches on
// this grid are drawn 1:1 instead of being resampled and blurred.
export const PATCH_GRID = 4;

// A button showing a paintIcon glyph. size: the glyph's width and height in pixels; paintIcon draws on a 20 px
// grid, scaled to fit. key: a shortcut label such as 'Ctrl+Z' shown across the glyph's bottom edge, or null.
export function glyphButton(icon, primary = false, size = TOOL_ICON_SIZE, key = null) {
    const button = new St.Button({
        reactive: true, can_focus: true,
        style_class: `capit-button${primary ? ' capit-primary' : ''}`,
    });
    const glyph = new St.DrawingArea({width: size, height: size});
    glyph.connect('repaint', () => {
        const cr = glyph.get_context();
        cr.scale(size / 20, size / 20);
        paintIcon(cr, icon);
        cr.$dispose();
    });
    if (!key) {
        button.set_child(glyph);
        return button;
    }
    // A bin stacks the label on the glyph. The bin is KEY_HINT_DROP taller than the glyph, so the label covers only
    // the glyph's bottom edge and longer labels such as 'Enter' leave the icon readable; a label wider than the
    // glyph widens the button a little.
    const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), height: size + KEY_HINT_DROP});
    glyph.set_x_align(Clutter.ActorAlign.CENTER);
    glyph.set_y_align(Clutter.ActorAlign.START);
    stack.add_child(glyph);
    button.keyHint = new St.Label({
        text: key, style_class: 'capit-key-hint', x_expand: true, y_expand: true,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
    });
    stack.add_child(button.keyHint);
    button.set_child(stack);
    return button;
}

/**
 * A Cairo layer covering one rectangle of the stage; `paint(cr)` draws in stage coordinates. Repainting a
 * St.DrawingArea re-rasterizes and re-uploads its whole surface, so the overlay keeps each one no larger than
 * what it shows.
 */
export class Patch {
    constructor(parent, paint) {
        this.rect = null;
        this.key = null;
        this.area = new St.DrawingArea({visible: false});
        this.area.connect('repaint', () => {
            const cr = this.area.get_context();
            if (this.rect) {
                cr.translate(-this.rect.x, -this.rect.y);
                paint(cr);
            }
            cr.$dispose();
        });
        parent.add_child(this.area);
    }

    // Covers rect, or hides for null/empty. Repaints only when the area or `key` (a summary of the content) changes.
    show(rect, key) {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            this.rect = null;
            this.area.hide();
            return;
        }
        const snapped = snapRect(rect, PATCH_GRID);
        const same = this.rect && ['x', 'y', 'width', 'height'].every(side => snapped[side] === this.rect[side]);
        if (same && key === this.key)
            return;
        this.rect = snapped;
        this.key = key;
        this.area.set_position(snapped.x, snapped.y);
        this.area.set_size(snapped.width, snapped.height);
        this.area.show();
        this.area.queue_repaint();
    }
}
