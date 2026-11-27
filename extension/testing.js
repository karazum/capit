// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only control of CapIt for the headless integration harness, exported as io.github.karazum.CapIt.Test when
 * Shell runs with CAPIT_TEST_MODE=1. It drives the overlay, injects pointer and key events through virtual devices,
 * reads the stage's colours and counts its frames. The packaged extension leaves this file out.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const IFACE = `<node><interface name="io.github.karazum.CapIt.Test">
  <method name="Step"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
</interface></node>`;

export class TestControl {
    // capit: the CapIt instance from capit.js; path: the D-Bus object path to export at.
    constructor(capit, path) {
        this.capit = capit;
        this.exported = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Step: value => JSON.stringify(this.step(JSON.parse(value))),
        });
        this.exported.export(Gio.DBus.session, path);
        this.frames = [];
        this.frameSignal = global.stage.connect('after-paint', (_stage, view) =>
            this.frames.push([GLib.get_monotonic_time(), view.get_framebuffer().get_width()]));
    }

    step(action) {
        const capit = this.capit;
        const overlay = capit.overlay;
        if (!overlay && !['pointer', 'key', 'settings', 'frames', 'record', 'stop-recording',
            'cancel-recording'].includes(action.type))
            throw new Error('No active capture');
        if (action.type === 'inspect') {
            const geometry = actor => ({position: actor.get_transformed_position(), size: actor.get_transformed_size()});
            return {
                ...capit._status(), tool: overlay.tool, readbacks: overlay.elements.readbacks,
                // The element corpus maps AT-SPI positions with these: they are relative to a window's client
                // rectangle, which only Shell knows.
                windows: overlay.candidates, owners: overlay.elements.owners,
                toolbar: geometry(overlay.toolbar), handle: geometry(overlay.handle),
                toolbarVisible: overlay.toolbar.visible, modesVisible: overlay.modes.visible,
                buttons: Object.fromEntries([...overlay.toolButtons, ...overlay.historyButtons]
                    .map(([id, actor]) => [id, geometry(actor)])),
                colors: Object.fromEntries([...overlay.colorButtons].map(([id, actor]) => [id, geometry(actor)])),
                modes: Object.fromEntries([...overlay.modeButtons].map(([id, actor]) => [id, geometry(actor)])),
                // Shortcut labels on the visible toolbar buttons, in toolbar order.
                keyHints: (function labels(actor) {
                    return actor.get_children().flatMap(child => child.has_style_class_name?.('capit-key-hint') &&
                        child.is_mapped() ? [child.text] : labels(child));
                })(overlay.toolbar),
                operations: overlay.document.annotations.map(({kind, width, color, x1, y1, x2, y2}) =>
                    ({kind, width, color, x1, y1, x2, y2})),
                active: overlay.activeIndex, cursor: overlay.cursor,
                demoCursor: {
                    ...geometry(overlay.demoCursorButton), visible: overlay.demoCursorButton.is_mapped(),
                    on: capit.settings.get_boolean('recording-demo-cursor'),
                },
            };
        } else if (action.type === 'select') {
            overlay.document.select(action.rect);
            overlay._update();
        } else if (action.type === 'annotate') {
            overlay.document.annotate(action.operation);
            overlay._update();
        } else if (action.type === 'undo' || action.type === 'redo') {
            overlay._undo(action.type === 'redo');
        } else if (action.type === 'finish') {
            overlay.finish(action.outputs ?? ['copy', 'save']);
        } else if (action.type === 'start-recording') {
            overlay._record();
        } else if (action.type === 'record') {
            capit.capture(action.mode ?? 'gif');
        } else if (action.type === 'stop-recording') {
            capit.recording?.stop();
        } else if (action.type === 'cancel-recording') {
            capit.recording?.cancel();
        } else if (action.type === 'cancel') {
            overlay.close();
        } else if (action.type === 'key') {
            this.keyboard ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const symbol = Clutter[`KEY_${action.key}`];
            if (symbol === undefined)
                throw new Error('Unknown test key');
            this.keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
            this.keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
        } else if (action.type === 'pointer') {
            this.pointer ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            this.pointer.notify_absolute_motion(GLib.get_monotonic_time(), action.x, action.y);
            if (action.button) {
                this.pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
                    action.button === 'press' ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
            }
            if (action.scroll) {
                this.pointer.notify_discrete_scroll(GLib.get_monotonic_time(),
                    action.scroll === 'up' ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN,
                    Clutter.ScrollSource.WHEEL);
            }
        } else if (action.type === 'text') {
            overlay._setTool('text');
            overlay._press({x: action.x, y: action.y});
            overlay.entry.set_text(action.text);
        } else if (action.type === 'settings') {
            if (action.directory !== undefined)
                capit.settings.set_string('output-directory', action.directory);
            if (action.elementDetection !== undefined)
                capit.settings.set_string('element-detection', action.elementDetection);
            if (action.recordingOutput !== undefined)
                capit.settings.set_string('recording-output', action.recordingOutput);
            if (action.clipboardContent !== undefined)
                capit.settings.set_string('clipboard-content', action.clipboardContent);
            if (action.keyHints !== undefined)
                capit.settings.set_boolean('show-key-hints', action.keyHints);
            if (action.quickCapture !== undefined)
                capit.settings.set_boolean('quick-capture', action.quickCapture);
            if (action.timingLog !== undefined)
                capit.settings.set_boolean('timing-log', action.timingLog);
        } else if (action.type === 'pick') {
            // The composited stage colour at x, y, read back asynchronously; 'picks' collects the answers.
            this.picks ??= [];
            const shooter = new Shell.Screenshot();
            shooter.pick_color(action.x, action.y, (_shooter, result) => {
                const [, color] = shooter.pick_color_finish(result);
                this.picks.push({x: action.x, y: action.y, rgb: [color.red, color.green, color.blue]});
            });
        } else if (action.type === 'picks') {
            const picks = this.picks ?? [];
            this.picks = [];
            return {...capit._status(), picks};
        } else if (action.type === 'frames') {
            // Stage paints since the previous call, as [monotonic µs, view framebuffer width], for frame-rate checks.
            const frames = this.frames;
            this.frames = [];
            return {...capit._status(), frames};
        } else {
            throw new Error('Unknown test action');
        }
        return capit._status();
    }

    destroy() {
        this.exported.unexport();
        global.stage.disconnect(this.frameSignal);
        this.keyboard = null;
        this.pointer = null;
    }
}
