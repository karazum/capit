// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HALO_SIZE = 44;
const RIPPLE_SIZE = 72;
const RIPPLE_DURATION_MS = 450;
// On Wayland, clicks on client windows never reach Shell actors or stage signals, so the pointer is polled
// instead. About 60 Hz is well below the length of any real click.
const POLL_INTERVAL_MS = 16;
const PRIMARY_BUTTON = Clutter.ModifierType.BUTTON1_MASK;
const BUTTON_MASKS = [PRIMARY_BUTTON, Clutter.ModifierType.BUTTON2_MASK, Clutter.ModifierType.BUTTON3_MASK];
const ANY_BUTTON = BUTTON_MASKS.reduce((all, mask) => all | mask, 0);

/**
 * A halo following the pointer and a ripple for each button press, drawn as Shell actors on top of the desktop.
 * GNOME's screencast paints the stage, so recordings include them. Exists only while a recording runs.
 */
export class DemoCursor {
    // fps: the recording's frame rate, for example 15.
    constructor(fps) {
        // GNOME 50's screencast drops a change that comes sooner than one frame after the last recorded frame, and
        // does not record it later. Repainting once a frame after the last change records where the halo stopped
        // and that a ripple has faded.
        this.settleDelay = Math.ceil(1000 / fps) + 20;
        this.settle = 0;
        this.halo = new St.Widget({style_class: 'capit-demo-halo', width: HALO_SIZE, height: HALO_SIZE});
        this.ripples = new Set();
        this.x = null;
        this.y = null;
        this.mods = 0;
        Main.layoutManager.uiGroup.add_child(this.halo);
        this.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        this._poll();
    }

    _poll() {
        const [x, y, mods] = global.get_pointer();
        if (x !== this.x || y !== this.y) {
            this.x = x;
            this.y = y;
            this.halo.set_position(x - HALO_SIZE / 2, y - HALO_SIZE / 2);
            // Menus and dialogs opened after the halo would otherwise cover it.
            this.halo.get_parent().set_child_above_sibling(this.halo, null);
            this._settleLater();
        }
        for (const mask of BUTTON_MASKS) {
            if ((mods & mask) && !(this.mods & mask))
                this._ripple(x, y, mask === PRIMARY_BUTTON);
        }
        if ((mods & ANY_BUTTON) !== (this.mods & ANY_BUTTON))
            this._settleLater();
        if (mods & ANY_BUTTON)
            this.halo.add_style_class_name('pressed');
        else
            this.halo.remove_style_class_name('pressed');
        this.mods = mods;
    }

    _settleLater() {
        if (this.settle)
            GLib.source_remove(this.settle);
        this.settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.settleDelay, () => {
            this.settle = 0;
            Main.layoutManager.uiGroup.queue_redraw();
            return GLib.SOURCE_REMOVE;
        });
    }

    // x, y: stage position of the press; primary: false for middle and right clicks, which ripple in another colour.
    _ripple(x, y, primary) {
        const ripple = new St.Widget({
            style_class: primary ? 'capit-demo-ripple' : 'capit-demo-ripple secondary',
            width: RIPPLE_SIZE, height: RIPPLE_SIZE, x: x - RIPPLE_SIZE / 2, y: y - RIPPLE_SIZE / 2,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), scale_x: 0.2, scale_y: 0.2,
        });
        Main.layoutManager.uiGroup.insert_child_below(ripple, this.halo);
        this.ripples.add(ripple);
        ripple.ease({
            scale_x: 1, scale_y: 1, opacity: 0, duration: RIPPLE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.ripples.delete(ripple);
                ripple.destroy();
                this._settleLater();
            },
        });
    }

    destroy() {
        GLib.source_remove(this.timeout);
        if (this.settle)
            GLib.source_remove(this.settle);
        this.ripples.forEach(ripple => ripple.destroy());
        this.ripples.clear();
        this.halo.destroy();
    }
}
