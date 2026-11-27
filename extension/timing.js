// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// Numbers successive timings, so lines from overlapping captures and recordings can be told apart.
let sequence = 0;
let machineLogged = false;

const milliseconds = microseconds => `${(microseconds / 1000).toFixed(1)} ms`;

/**
 * How long each stage of one capture, export or recording takes, written to the journal while the timing-log
 * setting is on and skipped otherwise. A line reads, for example,
 * `[CapIt timing] capture 3 · snapshot: 41.2 ms (total 57.9 ms) · 2 monitors`.
 * `journalctl --user -b -g 'CapIt timing'` or `scripts/capit timings` lists them.
 */
export class Timing {
    // settings: the extension's Gio.Settings; name: what is timed, such as 'capture' or 'export'.
    constructor(settings, name) {
        this.enabled = settings.get_boolean('timing-log');
        this.name = `${name} ${++sequence}`;
        this.started = this.last = GLib.get_monotonic_time();
        if (this.enabled && !machineLogged) {
            machineLogged = true;
            console.log(`[CapIt timing] machine · ${describeMachine()}`);
        }
    }

    // stage: what just finished, such as 'snapshot'; detail: extra context such as an image size, or ''.
    mark(stage, detail = '') {
        if (!this.enabled)
            return;
        const now = GLib.get_monotonic_time();
        console.log(`[CapIt timing] ${this.name} · ${stage}: ${milliseconds(now - this.last)} ` +
            `(total ${milliseconds(now - this.started)})${detail ? ` · ${detail}` : ''}`);
        this.last = now;
    }
}

// What a slow timing depends on: e.g. 'GNOME Shell 46.0 · Wayland · Intel(R) Core(TM) i3-6100U · 4 threads ·
// 7.7 GB · 1920x1080@1.25'.
function describeMachine() {
    const read = path => {
        try {
            return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        } catch {
            return '';
        }
    };
    const cpu = read('/proc/cpuinfo').match(/^model name\s*:\s*(.+)$/m)?.[1] ?? 'unknown CPU';
    const memory = Number(read('/proc/meminfo').match(/^MemTotal:\s*(\d+)/m)?.[1] ?? 0);
    const monitors = Main.layoutManager.monitors
        .map(monitor => `${monitor.width}x${monitor.height}@${monitor.geometry_scale}`).join(', ');
    // GNOME 50 dropped X11 sessions, and with them this check.
    const wayland = Meta.is_wayland_compositor?.() ?? true;
    return [`GNOME Shell ${Config.PACKAGE_VERSION}`, wayland ? 'Wayland' : 'Xorg', cpu,
        `${GLib.get_num_processors()} threads`, `${(memory / 1_048_576).toFixed(1)} GB`, monitors].join(' · ');
}
