// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {mostOverlapping, outsideRect} from './model.js';
import {glyphButton, TOOLBAR_GAP} from './widgets.js';

// Controls for a running recording: the demo cursor toggle, the elapsed time and Stop. It stands outside the
// recorded area on the area's monitor, so it is never part of the recording; where no side has room it is not
// shown, and the panel menu and the recording shortcut still stop the recording. Shell chrome, so it takes clicks
// over application windows.
export class RecordingBar {
    constructor(recording) {
        this.recording = recording;
        this.actor = new St.BoxLayout({
            style_class: 'capit-toolbar capit-floating capit-recording-bar',
            reactive: true,
        });
        this.demoCursor = glyphButton('demo-cursor');
        this.demoCursor.connect('clicked', () => {
            recording.setDemoCursor(!recording.demoCursor);
            this.update();
        });
        this.time = new St.Label({style_class: 'capit-recording-time', y_align: Clutter.ActorAlign.CENTER});
        this.stop = glyphButton('stop', true);
        this.stop.connect('clicked', () => recording.stop());
        for (const child of [this.demoCursor, this.time, this.stop])
            this.actor.add_child(child);
        this.update();
        Main.layoutManager.addTopChrome(this.actor);
        const [, width] = this.actor.get_preferred_width(-1);
        const [, height] = this.actor.get_preferred_height(width);
        const monitor = mostOverlapping(Main.layoutManager.monitors, recording.rect);
        // Clear of the red frame around the area as well.
        const place = outsideRect(recording.rect, {width, height}, monitor, TOOLBAR_GAP);
        if (place)
            this.actor.set_position(Math.round(place.x), Math.round(place.y));
        else
            this.actor.hide();
    }

    update() {
        const elapsed = this.recording.elapsed;
        this.time.text = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
        if (this.recording.demoCursor)
            this.demoCursor.add_style_pseudo_class('checked');
        else
            this.demoCursor.remove_style_pseudo_class('checked');
    }

    // Stage position and size, or null while hidden for lack of room.
    get geometry() {
        if (!this.actor.visible)
            return null;
        const geometry = actor => ({position: actor.get_transformed_position(), size: actor.get_transformed_size()});
        return {...geometry(this.actor), demoCursor: geometry(this.demoCursor), stop: geometry(this.stop)};
    }

    destroy() {
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}
