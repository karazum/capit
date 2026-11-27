// SPDX-License-Identifier: GPL-3.0-or-later
// CapIt's Shell adapter: the panel menu, shortcuts, D-Bus API, the capture overlay's lifecycle and recordings.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CaptureOverlay} from './overlay.js';
import {Recording} from './recording.js';
import {RecordingBar} from './recordingbar.js';
import {Timing} from './timing.js';

// Control for the headless integration harness, which runs Shell with CAPIT_TEST_MODE=1. The packaged extension
// leaves testing.js out. It is imported here, while the module loads, because a development install deletes its
// module copy as soon as capit.js has loaded.
const testing = GLib.getenv('CAPIT_TEST_MODE') === '1' ? await import('./testing.js') : null;

// Shell's built-in screenshot module installs this promisified binding too.
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');

const IFACE = `<node><interface name="io.github.karazum.CapIt">
  <method name="Capture"/>
  <method name="GetStatus"><arg type="s" direction="out"/></method>
</interface></node>`;
const PATH = '/io/github/karazum/CapIt';
// Everything CapIt does while enabled: panel menu, shortcut, D-Bus API and the capture overlay. `extension` is the
// Shell's Extension object from extension.js, which owns the uuid, install path, settings and preferences.
export class CapIt {
    constructor(extension) {
        this.extension = extension;
        this.uuid = extension.uuid;
        this.path = extension.path;
    }

    enable() {
        this.enabled = true;
        this.settings = this.extension.getSettings();
        this.lastResult = null;
        this.recording = null;
        this.indicator = new PanelMenu.Button(0, 'CapIt');
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this.panelIcons = {
            idle: Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([this.path, 'icons', 'capit-symbolic.svg']))),
            recording: Gio.ThemedIcon.new('media-record-symbolic'),
        };
        this.icon = new St.Icon({gicon: this.panelIcons.idle, style_class: 'system-status-icon'});
        this.recordingLabel = new St.Label({
            style_class: 'capit-recording-label', y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this.icon);
        box.add_child(this.recordingLabel);
        this.indicator.add_child(box);
        this.menuItems = {
            capture: this.indicator.menu.addAction('Capture region', () => this.capture()),
            gif: this.indicator.menu.addAction('Record GIF', () => this.capture('gif')),
            video: this.indicator.menu.addAction('Record video', () => this.capture('video')),
            stop: this.indicator.menu.addAction('Stop recording', () => this.recording?.stop()),
            cancel: this.indicator.menu.addAction('Cancel recording', () => this.recording?.cancel()),
        };
        this.indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.indicator.menu.addAction('Preferences', () => this.extension.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this.indicator);
        this._updateIndicator();
        Main.wm.addKeybinding('capture-shortcut', this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL, () => this.capture());
        // The same shortcut starts a recording, in the mode of the last one, and stops the one running.
        Main.wm.addKeybinding('record-shortcut', this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL, () => this.recording ? this.recording.stop()
                : this.capture(this.settings.get_string('recording-mode')));
        // A recorded area is fixed in stage coordinates, which a monitor change can move, so keep what is recorded.
        this.monitorSignal = Main.layoutManager.connect('monitors-changed', () => {
            this.overlay?.destroy();
            this.recording?.stop();
        });
        this.exported = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Capture: () => {
                this.capture();
            },
            GetStatus: () => JSON.stringify(this._status()),
        });
        this.exported.export(Gio.DBus.session, PATH);
        this.testControl = testing ? new testing.TestControl(this, `${PATH}/Test`) : null;
    }

    _status() {
        return {
            version: 1, active: Boolean(this.overlay), acquiring: Boolean(this.acquiring),
            phase: this.overlay?.phase ?? 'idle', mode: this.overlay?.mode ?? null,
            selection: this.overlay?.document.selection ?? null,
            recording: this.recording ? {
                kind: this.recording.kind, state: this.recording.state, area: this.recording.rect,
                demoCursor: Boolean(this.recording.demoCursor), bar: this.recordingBar?.geometry ?? null,
                elapsed: this.recording.elapsed,
            } : null,
            revision: this.overlay?.document.revision ?? null,
            candidates: this.overlay?.candidates.length ?? 0,
            panels: this.overlay?.elements.detection ?? null,
            elementDetection: this.overlay?.elements.detectionMode ?? null,
            scale: this.overlay?.scale ?? null,
            textEntry: this.overlay?.entry.visible ?? false,
            annotations: this.overlay?.document.annotations.length ?? 0,
            lastResult: this.lastResult,
        };
    }

    // mode: 'image' for an annotated screenshot, 'gif' or 'video' to pick the area of a recording. The capture
    // shortcut still takes screenshots during a recording.
    async capture(mode = 'image') {
        if (!this.enabled || this.overlay || this.acquiring || (mode !== 'image' && this.recording))
            return;
        // Before `acquiring` is set, so a failure here cannot leave every later capture refused.
        const timing = new Timing(this.settings, mode === 'image' ? 'capture' : `${mode} area`);
        this.acquiring = true;
        const generation = this.settings;
        try {
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = global.get_window_actors().map(actor => actor.meta_window)
                .filter(window => !window.minimized && window.located_on_workspace(workspace) &&
                    window.showing_on_its_workspace());
            const stacked = global.display.sort_windows_by_stacking(windows).reverse()
                .map(window => ({window, frame: window.get_frame_rect()}))
                .filter(({frame}) => frame.width > 0 && frame.height > 0);
            // Image detection reads what is on screen, so its boxes start from each monitor rather than from window
            // frames, which reach under the windows stacked above them. Only the accessibility finder, which asks
            // each window's application, needs the windows.
            const byWindow = this.settings.get_string('element-detection') === 'accessibility';
            const candidates = byWindow
                ? stacked.map(({frame}) => ({x: frame.x, y: frame.y, width: frame.width, height: frame.height}))
                : Main.layoutManager.monitors.map(({x, y, width, height}) => ({x, y, width, height}));
            const owners = !byWindow ? [] : stacked.map(({window, frame}) => {
                const client = window.frame_rect_to_client_rect(frame);
                return {
                    pid: window.get_pid(), title: window.get_title() ?? '',
                    client: [client.x, client.y, client.width, client.height],
                };
            });
            timing.mark('window list', `${candidates.length} ${byWindow ? 'windows' : 'monitors'}`);
            const shooter = new Shell.Screenshot();
            const [content, scale] = await shooter.screenshot_stage_to_content();
            timing.mark('snapshot', `scale ${scale}`);
            if (!this.enabled || generation !== this.settings)
                return;
            this.overlay = new CaptureOverlay(this, content, scale, candidates, owners, mode, timing);
            timing.mark('overlay built');
            if (timing.enabled) {
                const id = global.stage.connect('after-paint', () => {
                    global.stage.disconnect(id);
                    timing.mark('first frame shown');
                });
            }
        } catch (error) {
            this.lastResult = {error: error.message};
            console.error(`[CapIt] ${error.stack ?? error}`);
            if (this.enabled)
                Main.notifyError('CapIt capture failed', error.message);
        } finally {
            this.acquiring = false;
        }
    }

    // area: the logical stage rectangle chosen in an overlay, which has closed by now; kind: 'gif' or 'video'.
    async startRecording(area, kind) {
        if (!this.enabled || this.recording)
            return;
        this.settings.set_string('recording-mode', kind);
        const timing = new Timing(this.settings, `${kind} recording`);
        const recording = new Recording({
            kind, rect: area, settings: this.settings, path: this.path, timing,
            onChange: () => this._recordingChanged(recording),
        });
        this.recording = recording;
        this._updateIndicator();
        try {
            // Wait for a frame painted without the overlay, so its last image cannot reach the recording.
            await new Promise(resolve => {
                const id = global.stage.connect('after-paint', () => {
                    global.stage.disconnect(id);
                    resolve();
                });
                global.stage.queue_redraw();
            });
            timing.mark('overlay gone');
            // Cancelled or disabled meanwhile.
            if (recording.state !== 'starting')
                return;
            await recording.start();
            timing.mark('recording started', `${area.width}x${area.height}`);
        } catch (error) {
            if (this.recording === recording) {
                this.recording = null;
                this._updateIndicator();
            }
            this.lastResult = {recording: {error: error.message}};
            console.error(`[CapIt] ${error.stack ?? error}`);
            if (this.enabled)
                Main.notifyError('CapIt recording failed', error.message);
        }
    }

    _recordingChanged(recording) {
        if (recording !== this.recording)
            return;
        if (recording.state === 'recording')
            this.recordingBar ??= new RecordingBar(recording);
        this.recordingBar?.update();
        if (recording.state !== 'recording') {
            this.recordingBar?.destroy();
            this.recordingBar = null;
        }
        if (recording.state === 'done') {
            this.lastResult = {recording: recording.result ?? null};
            this.recording = null;
        }
        this._updateIndicator();
    }

    // The panel icon shows a running recording with its time, and the menu offers what fits the current state.
    _updateIndicator() {
        const state = this.recording?.state ?? 'idle';
        const active = state !== 'idle';
        this.icon.gicon = active ? this.panelIcons.recording : this.panelIcons.idle;
        if (active)
            this.indicator.add_style_class_name('capit-recording');
        else
            this.indicator.remove_style_class_name('capit-recording');
        const elapsed = this.recording?.elapsed ?? 0;
        const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
        this.recordingLabel.text = {
            starting: 'Starting…', recording: time, stopping: 'Saving…',
            encoding: this.recording?.kind === 'video' ? 'Making video…' : 'Making GIF…',
        }[state] ?? '';
        this.recordingLabel.visible = active;
        this.menuItems.capture.visible = !active;
        this.menuItems.gif.visible = !active;
        this.menuItems.video.visible = !active;
        this.menuItems.stop.visible = state === 'recording';
        this.menuItems.cancel.visible = active;
    }

    disable() {
        this.enabled = false;
        Main.wm.removeKeybinding('capture-shortcut');
        Main.wm.removeKeybinding('record-shortcut');
        this.recordingBar?.destroy();
        this.recordingBar = null;
        this.recording?.destroy();
        this.recording = null;
        if (this.monitorSignal)
            Main.layoutManager.disconnect(this.monitorSignal);
        this.monitorSignal = null;
        this.overlay?.destroy();
        this.exported?.unexport();
        this.exported = null;
        this.testControl?.destroy();
        this.testControl = null;
        this.indicator?.destroy();
        this.indicator = null;
        this.settings = null;
    }
}
