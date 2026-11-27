// SPDX-License-Identifier: GPL-3.0-or-later
// The capture overlay: the frozen screen, smart boxes, the region, annotations, toolbars and the export.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Document, rectBetween, clampRect, contains, pixelRect, opBounds, opHandles, opHandleAt, opHit, moveOp,
    resizeOp, unionRect, intersectRect, outlineBands, mostOverlapping, fitInside, boxesAt, besideRect,
    sideOfRect, brushOp, opEdgeHit, squareCorner, clearOf, largeRegions, regionOutline, regionAtOutline,
} from './model.js';
import {clipboardDirectory, clipboardKind, copyCapture, outputDirectory} from './recording.js';
import {Timing} from './timing.js';
import {paintOperation} from './paint.js';
import {ElementDetection} from './detection.js';
import {
    glyphButton, measureText, paintBounds, paintIcon, Patch, PATCH_GRID, TOOL_ICON_SIZE, TOOLBAR_GAP,
    verticalBox,
} from './widgets.js';

Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Shell.BlurEffect radius for the live blur preview, matched by eye and pixel samples to the renderer's blur.
const BLUR_RADIUS = 10;
// The size label drawn just above the region's top-left corner, including its 2 px margin.
const LABEL_HEIGHT = 22;
// The overlay's modes, in the order of their buttons: what Enter makes of the selected region.
const MODES = [['image', 'Screenshot'], ['gif', 'Record a GIF'], ['video', 'Record a video']];
// The mode buttons' glyphs are drawn at this size instead of the toolbar's, to be easy to hit.
const MODE_ICON_SIZE = 36;
const MODE_MESSAGES = {
    image: 'Move or resize the region, annotate, then click it or press Enter',
    gif: 'Move or resize the area, then click it or press Enter to start recording a GIF',
    video: 'Move or resize the area, then click it or press Enter to start recording a video',
};
const TOOLS = [['select', 'Select / move region', 'V'], ['arrow', 'Arrow', 'A'], ['rectangle', 'Rectangle', 'R'],
    ['ellipse', 'Circle, round while Shift is held', 'C'], ['brush', 'Brush (freehand)', 'P'], ['blur', 'Blur', 'B'], ['redact', 'Redact (solid colour)', 'X'],
    ['text', 'Text', 'T']];
const COLORS = ['#ff595e', '#ffca3a', '#78d391', '#75bbff', '#c77dff', '#ffffff', '#000000'];
const WIDTHS = [2, 4, 8];
// Annotation kinds drawn in their colour; blur ignores it.
const COLORED_KINDS = ['arrow', 'rectangle', 'ellipse', 'brush', 'redact', 'text'];
const TOOL_KEYS = new Map([[Clutter.KEY_v, 'select'], [Clutter.KEY_a, 'arrow'], [Clutter.KEY_r, 'rectangle'],
    [Clutter.KEY_c, 'ellipse'],
    [Clutter.KEY_p, 'brush'], [Clutter.KEY_b, 'blur'], [Clutter.KEY_x, 'redact'], [Clutter.KEY_t, 'text']]);
const WIDTH_TOOLS = ['arrow', 'rectangle', 'ellipse', 'brush'];
// Cursors the overlay shows, each with its names in Clutter.CursorType (GNOME 50) or Meta.Cursor (GNOME 48 and 49),
// then the older Meta.Cursor name (GNOME 45 to 47).
const CURSORS = {
    default: ['DEFAULT'],
    crosshair: ['CROSSHAIR'],
    confirm: ['POINTER', 'POINTING_HAND'],
    pointer: ['POINTER', 'POINTING_HAND'],
    move: ['MOVE', 'MOVE_OR_RESIZE_WINDOW'],
};
// Line widths the mouse wheel can give an annotation, within what renderer.js accepts.
const MIN_LINE_WIDTH = 1;
const MAX_LINE_WIDTH = 32;
// Outline colours of the large regions, one per nesting level, as [red, green, blue] from 0 to 1.
const REGION_COLORS = [[1, 0.79, 0.23], [0.46, 0.73, 1], [0.78, 0.49, 1], [0.47, 0.83, 0.57]];
// Pixels each nesting level's outline and tab stand inside the one around it, so that regions sharing an edge
// still show one outline each.
const REGION_INSET = 5;
const REGION_LINE = 3;
// Pixels from the middle of a region's outline within which the pointer is on it.
const REGION_REACH = 4;
// Opacity of a region's outline until it is the one a click picks.
const REGION_DIM = 0.2;
// Pixels the pointer may come within the hint before it moves to the opposite corner.
const HINT_MARGIN = 40;

export class CaptureOverlay {
    // owners: per candidate, {pid, title, client: [x, y, width, height]}, which the accessibility finder needs to
    // find the window's application and map its coordinates. mode: 'image' to annotate and export a screenshot, or
    // 'gif' or 'video' to pick the area of a recording, which offers no annotation tools; the mode buttons beside
    // the region switch between them. timing: the capture's Timing, continued by element detection.
    constructor(extension, content, scale, candidates, owners, mode = 'image', timing = null) {
        this.extension = extension;
        this.timing = timing ?? new Timing(extension.settings, 'capture');
        // A key added to the schema reaches a running shell only once it reloads the schemas, so it is looked up first.
        this.showRegions = extension.settings.settings_schema.has_key('show-large-regions') &&
            extension.settings.get_boolean('show-large-regions');
        // A screenshot is copied and saved as soon as its region is picked, skipping adjustment and annotation.
        this.quickCapture = extension.settings.settings_schema.has_key('quick-capture') &&
            extension.settings.get_boolean('quick-capture');
        // True while such an export runs, which keeps the toolbar and mode buttons hidden unless it fails.
        this.quickExport = false;
        this.mode = mode;
        this.content = content;
        this.scale = scale;
        this.candidates = candidates;
        this.document = new Document({x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        this.tool = 'select';
        this.color = '#ff595e';
        this.hover = null;
        this.elements = new ElementDetection(this, owners);
        // True once scrolling picked a box wider than the innermost one; it sticks while the pointer stays inside.
        this.widened = false;
        this.scrollDelta = 0;
        // Whether Shift was held at the last pointer event; it makes a circle being drawn round.
        this.shift = false;
        // The annotation index and document revision of the last wheel width change, for merging the next into it.
        this.wheelEdit = null;
        this.activeIndex = null;
        this.draft = null;
        this.gesture = null;
        this.preview = null;
        this.busy = false;
        this.closed = false;
        this.phase = 'selecting';
        this.outputs = {revision: -1, copy: 'none', save: 'none', savedPath: null};
        this.workdir = GLib.build_filenamev([GLib.get_user_runtime_dir(), `capit-${GLib.uuid_string_random()}`]);
        GLib.mkdir_with_parents(this.workdir, 0o700);
        this.actor = new St.Widget({
            reactive: true, can_focus: true,
            width: global.stage.width, height: global.stage.height,
        });
        this.background = new Clutter.Actor({
            content, width: global.stage.width,
            height: global.stage.height, content_gravity: Clutter.ContentGravity.RESIZE_FILL,
        });
        this.actor.add_child(this.background);
        // One GPU-blurred view of the frozen image per blur annotation, between the image and the dim mask.
        this.blurs = [];
        // Only the flat dimming spans the stage, as plain rectangles the GPU draws around the region. A stage-sized
        // Cairo canvas repainted on every pointer move stalls the compositor on large or fractionally scaled desks.
        this.mask = [0, 1, 2, 3].map(() => {
            const piece = new St.Widget({style_class: 'capit-mask'});
            this.actor.add_child(piece);
            return piece;
        });
        // The large regions of the window under the pointer, offered whole by a tab each until a region is chosen.
        this.regions = [];
        this.regionsKey = null;
        this.regionLayer = new Patch(this.actor, cr => this._paintRegions(cr));
        this.annotationLayer = new Patch(this.actor, cr => this._paintAnnotations(cr));
        this.liveLayer = new Patch(this.actor, cr => this._paintLive(cr));
        this.chrome = [0, 1, 2, 3].map(() => new Patch(this.actor, cr => this._paintChrome(cr)));
        this.regionTabs = new St.Widget();
        this.actor.add_child(this.regionTabs);
        this.width = 4;
        // Stage position the user dragged the toolbar to, or null while it stays docked.
        this.toolbarPosition = null;
        // The cursor shown, one of CURSORS' names; where the pointer last was; whether it is over the toolbars.
        this.cursor = null;
        const [pointerX, pointerY] = global.get_pointer();
        this.cursorPoint = {x: pointerX, y: pointerY};
        // Where smart boxes and large regions are shown, from the start: a capture opened by a shortcut gets no
        // motion event until the pointer moves, and detection that finishes before then must still show them.
        this.pointer = {...this.cursorPoint};
        this.overChrome = false;
        this.toolbar = verticalBox({reactive: true, style_class: 'capit-toolbar'});
        const bar = new St.BoxLayout({style_class: 'capit-row'});
        // Not a button: a press on it starts a toolbar drag and never reaches St.
        this.handle = new St.Bin({reactive: true, track_hover: true, style_class: 'capit-handle'});
        const grip = new St.DrawingArea({width: TOOL_ICON_SIZE / 2, height: TOOL_ICON_SIZE});
        grip.connect('repaint', () => {
            const cr = grip.get_context();
            cr.scale(TOOL_ICON_SIZE / 20, TOOL_ICON_SIZE / 20);
            paintIcon(cr, 'grip');
            cr.$dispose();
        });
        this.handle.set_child(grip);
        this.handle.connect('notify::hover', () => this._updateCursor());
        this._hintOnHover(this.handle, 'Drag to move the toolbar');
        bar.add_child(this.handle);
        this.toolButtons = new Map();
        this.colorButtons = new Map();
        this.widthButtons = new Map();
        this.historyButtons = new Map();
        // Both sets of controls exist from the start; the mode shows one of them.
        this.imageControls = new St.BoxLayout({style_class: 'capit-row'});
        for (const [id, label, key] of TOOLS) {
            const button = this._iconButton(id, `${label} (${key})`, () => this._setTool(id), false, TOOL_ICON_SIZE,
                key);
            this.toolButtons.set(id, button);
            this.imageControls.add_child(button);
        }
        this._addImageButtons(this.imageControls);
        this.recordControls = new St.BoxLayout({style_class: 'capit-row'});
        this.demoCursorButton = this._iconButton('demo-cursor', 'Highlight the pointer and clicks in the recording (D)',
            () => this._toggleDemoCursor(), false, TOOL_ICON_SIZE, 'D');
        this.recordControls.add_child(this.demoCursorButton);
        this._showDemoCursorSetting();
        this.recordControls.add_child(this._separator());
        this.recordControls.add_child(this._iconButton('cancel', 'Cancel (Esc)', () => this.close(), false,
            TOOL_ICON_SIZE, 'Esc'));
        this.recordControls.add_child(this._iconButton('record', 'Start recording (Enter)', () => this._record(), true,
            TOOL_ICON_SIZE, 'Enter'));
        bar.add_child(this.imageControls);
        bar.add_child(this.recordControls);
        this.toolbar.add_child(bar);
        this.folderEntry = new St.Entry({
            style_class: 'capit-folder-entry', can_focus: true,
            hint_text: 'Full output path, or blank for Pictures/CapIt; Enter applies',
        });
        this.folderEntry.hide();
        this.toolbar.add_child(this.folderEntry);
        this.idleMessage = MODE_MESSAGES[mode];
        // The hint a hovered toolbar button shows in the status line, and the status it covers.
        this.hinting = null;
        this.beforeHint = null;
        this.status = new St.Label({style_class: 'capit-status', text: this.idleMessage});
        this.toolbar.add_child(this.status);
        this.actor.add_child(this.toolbar);
        this.toolbar.hide();
        this.modes = verticalBox({reactive: true, style_class: 'capit-modes'});
        this.modeButtons = new Map(MODES.map(([id, label]) => {
            const button = this._iconButton(`mode-${id}`, label, () => this._setMode(id), false, MODE_ICON_SIZE);
            this.modes.add_child(button);
            return [id, button];
        }));
        // One recording at a time: during a recording this overlay can only take screenshots.
        if (extension.recording) {
            for (const id of ['gif', 'video']) {
                this.modeButtons.get(id).reactive = false;
                this.modeButtons.get(id).opacity = 90;
            }
        }
        this.actor.add_child(this.modes);
        this.modes.hide();
        this.hint = verticalBox({style_class: 'capit-hint'});
        this.hint.add_child(new St.Label({
            text: 'Click a panel · a tab picks its large region · scroll to widen or narrow · drag a region · ' +
                'Escape cancels',
        }));
        // How far element detection is, until its boxes are all in: a line of text over a bar that fills up.
        this.progress = verticalBox({style_class: 'capit-progress', visible: false});
        this.progressLabel = new St.Label({style_class: 'capit-progress-label'});
        this.progressTrack = new St.Widget({style_class: 'capit-progress-track', x_expand: true});
        this.progressFill = new St.Widget({style_class: 'capit-progress-fill', width: 0});
        this.progressTrack.add_child(this.progressFill);
        this.progressTrack.connect('notify::width', () => this._fillProgress(false));
        this.progress.add_child(this.progressLabel);
        this.progress.add_child(this.progressTrack);
        this.hint.add_child(this.progress);
        this.progressFraction = 0;
        this.actor.add_child(this.hint);
        this.entry = new St.Entry({style_class: 'capit-entry', hint_text: 'Type, then Enter', can_focus: true});
        this.entry.hide();
        this.actor.add_child(this.entry);
        this.actor.connect('captured-event', (_actor, event) => this._event(event));
        Main.uiGroup.add_child(this.actor);
        // Measured for its corner, which needs its style, so only once it is on the stage.
        this._placeHint('top-left');
        this.grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.ALL});
        // GNOME 50's Clutter.Grab no longer reports which devices it holds, and Shell's own modals stopped checking.
        if (this.grab.get_seat_state && this.grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(this.grab);
            this.grab = null;
            this.close();
            throw new Error('CapIt could not acquire keyboard and pointer input');
        }
        global.stage.set_key_focus(this.actor);
        this._setTool('select');
        this._setColor(this.color);
        this._setWidth(this.width);
        this._setMode(mode);
        this._updateCursor();
        // After the first frame, so reading back window pixels does not hold up the overlay appearing.
        this.detectLater = global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            this.detectLater = 0;
            this.elements.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The annotation and export controls of a screenshot, after the tool buttons.
    _addImageButtons(bar) {
        bar.add_child(this._separator());
        for (const color of COLORS) {
            // Centred, so a row made taller by shortcut labels does not stretch the round swatch.
            const swatch = new St.Button({
                reactive: true, can_focus: true, style_class: 'capit-swatch',
                style: `background-color: ${color};`, y_align: Clutter.ActorAlign.CENTER,
            });
            swatch.connect('clicked', () => {
                if (!this.busy)
                    this._setColor(color);
            });
            this._hintOnHover(swatch, `Color ${color}`);
            this.colorButtons.set(color, swatch);
            bar.add_child(swatch);
        }
        bar.add_child(this._separator());
        for (const width of WIDTHS) {
            const dot = new St.Button({
                reactive: true, can_focus: true, style_class: 'capit-width',
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Scaled with the glyphs, so the dots keep their proportion to the toolbar.
            const size = Math.round((width + 2) * TOOL_ICON_SIZE / 20);
            const glyph = new St.Widget({
                style_class: 'capit-width-dot',
                style: `width: ${size}px; height: ${size}px; border-radius: ${size}px;`,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            });
            dot.set_child(glyph);
            dot.connect('clicked', () => {
                if (!this.busy)
                    this._setWidth(width);
            });
            this._hintOnHover(dot, `Line thickness ${width}px`);
            this.widthButtons.set(width, dot);
            bar.add_child(dot);
        }
        bar.add_child(this._separator());
        this.historyButtons.set('undo', this._iconButton('undo', 'Undo (Ctrl+Z)', () => this._undo(false), false,
            TOOL_ICON_SIZE, 'Ctrl+Z'));
        // Ctrl+Y also redoes, and fits on the button where Ctrl+Shift+Z would not.
        this.historyButtons.set('redo', this._iconButton('redo', 'Redo (Ctrl+Shift+Z or Ctrl+Y)',
            () => this._undo(true), false, TOOL_ICON_SIZE, 'Ctrl+Y'));
        this.historyButtons.forEach(button => bar.add_child(button));
        bar.add_child(this._separator());
        bar.add_child(this._iconButton('copy', 'Copy only (Ctrl+C)', () => this.finish(['copy']), false,
            TOOL_ICON_SIZE, 'Ctrl+C'));
        bar.add_child(this._iconButton('save', 'Save only (Ctrl+S)', () => this.finish(['save']), false,
            TOOL_ICON_SIZE, 'Ctrl+S'));
        bar.add_child(this._iconButton('folder', 'Output folder…', () => {
            this.folderEntry.set_text(this.extension.settings.get_string('output-directory'));
            this.folderEntry.show();
            this._placeToolbar();
            global.stage.set_key_focus(this.folderEntry.clutter_text);
        }));
        bar.add_child(this._iconButton('cancel', 'Cancel (Esc)', () => this.close(), false, TOOL_ICON_SIZE, 'Esc'));
        bar.add_child(this._iconButton('confirm', 'Copy + save (Enter)', () => this.finish(['copy', 'save']), true,
            TOOL_ICON_SIZE, 'Enter'));
    }

    // key: the action's shortcut, such as 'Ctrl+C', shown on the button while the show-key-hints setting is on.
    _iconButton(icon, hint, action, primary = false, size = TOOL_ICON_SIZE, key = null) {
        const button = glyphButton(icon, primary, size,
            this.extension.settings.get_boolean('show-key-hints') ? key : null);
        button.connect('clicked', () => {
            if (!this.busy)
                action();
        });
        this._hintOnHover(button, hint);
        return button;
    }

    _separator() {
        return new St.Widget({style_class: 'capit-separator', y_expand: true});
    }

    // Stands in for tooltips, which a modal overlay cannot show: the hint appears in the status line.
    // Leaving the button restores what the status said before, such as an export error. The pointer can enter the
    // next button before it leaves the last, so the text from before the first hint is the one kept.
    _hintOnHover(button, hint) {
        button.connect('notify::hover', () => {
            if (button.hover) {
                if (this.hinting === null)
                    this.beforeHint = this.status.text;
                this.hinting = hint;
                this.status.set_text(hint);
            } else if (this.hinting === hint) {
                this.hinting = null;
                // Status set meanwhile, for example by a finished export, is newer than the text from before.
                if (this.status.text === hint)
                    this.status.set_text(this.beforeHint);
            }
        });
    }

    _setColor(color) {
        this.color = color;
        for (const [id, swatch] of this.colorButtons) {
            if (id === color)
                swatch.add_style_pseudo_class('checked');
            else
                swatch.remove_style_pseudo_class('checked');
        }
        // Picking a colour also recolours the annotation just drawn or selected, as one undo step.
        const active = this.mode === 'image' ? this.document.annotations[this.activeIndex] : null;
        if (active && COLORED_KINDS.includes(active.kind) && active.color !== color) {
            this.document.replace(this.activeIndex, {...active, color});
            this._update();
        }
        global.stage.set_key_focus(this.actor);
    }

    _setWidth(width) {
        this.width = width;
        for (const [id, button] of this.widthButtons) {
            if (id === width)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        global.stage.set_key_focus(this.actor);
    }

    _setTool(tool) {
        this._commitText();
        this.tool = tool;
        for (const [id, button] of this.toolButtons) {
            if (id === tool)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        const widths = WIDTH_TOOLS.includes(tool);
        for (const button of this.widthButtons.values()) {
            button.reactive = widths;
            button.opacity = widths ? 255 : 90;
        }
        global.stage.set_key_focus(this.actor);
        this._redraw();
    }

    // Switches between a screenshot and the two kinds of recording. The annotations stay in the document and show
    // again on returning to a screenshot; a recording shows the live screen, so they are hidden meanwhile.
    _setMode(mode) {
        this._commitText();
        this.mode = mode;
        for (const [id, button] of this.modeButtons) {
            if (id === mode)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        const image = mode === 'image';
        this.imageControls.visible = image;
        this.recordControls.visible = !image;
        if (!image) {
            this._setTool('select');
            this.activeIndex = null;
            this.entry.hide();
            this.folderEntry.hide();
        }
        this.idleMessage = MODE_MESSAGES[mode];
        if (this.hinting === null)
            this.status.set_text(this.idleMessage);
        global.stage.set_key_focus(this.actor);
        this._update();
    }

    _toggleDemoCursor() {
        const settings = this.extension.settings;
        settings.set_boolean('recording-demo-cursor', !settings.get_boolean('recording-demo-cursor'));
        this._showDemoCursorSetting();
        global.stage.set_key_focus(this.actor);
    }

    _showDemoCursorSetting() {
        if (this.extension.settings.get_boolean('recording-demo-cursor'))
            this.demoCursorButton.add_style_pseudo_class('checked');
        else
            this.demoCursorButton.remove_style_pseudo_class('checked');
    }

    _undo(redo) {
        this._commitText();
        if (redo)
            this.document.redo();
        else
            this.document.undo();
        this.activeIndex = null;
        this._update();
    }

    _update() {
        if (this.closed)
            return;
        const rect = this.document.selection;
        if (this.activeIndex !== null && !this.document.annotations[this.activeIndex])
            this.activeIndex = null;
        this.phase = rect ? 'editing' : 'selecting';
        this.toolbar.visible = rect !== null && !this.quickExport;
        this.modes.visible = rect !== null && !this.quickExport;
        this.hint.visible = rect === null;
        if (rect && this.messageRevision !== this.document.revision) {
            this.messageRevision = this.document.revision;
            this.status.set_text(this.idleMessage);
        }
        if (rect) {
            this._placeToolbar();
            this._placeModes();
        } else {
            this.elements.resume();
        }
        this._redraw();
    }

    // Floats under the region, or over it when the region reaches the bottom of its monitor, so it never covers
    // the region being edited. A region filling its monitor's height leaves it docked flat against the top edge.
    // Once dragged by its handle it stays where it was dropped, kept whole on `monitor`, or else on the monitor
    // it mostly covers.
    _placeToolbar(monitor = null) {
        // Measured in its floating style, whose top border and padding add to the height of the docked one.
        this.toolbar.add_style_class_name('capit-floating');
        const [, width] = this.toolbar.get_preferred_width(-1);
        const [, height] = this.toolbar.get_preferred_height(width);
        const monitors = Main.layoutManager.monitors;
        if (this.toolbarPosition) {
            const rect = {...this.toolbarPosition, width, height};
            const fitted = fitInside(rect, monitor ?? mostOverlapping(monitors, rect));
            this.toolbarPosition = {x: Math.round(fitted.x), y: Math.round(fitted.y)};
            this._moveToolbar(this.toolbarPosition.x, this.toolbarPosition.y, width, height);
            return;
        }
        const selection = this.document.selection;
        const region = mostOverlapping(monitors, selection);
        // Clear of the corner resize handles below, and of the size label as well above.
        const beside = besideRect(selection, {width, height}, region, TOOLBAR_GAP, TOOLBAR_GAP + LABEL_HEIGHT);
        if (beside) {
            this._moveToolbar(Math.round(beside.x), Math.round(beside.y), width, height);
        } else {
            this.toolbar.remove_style_class_name('capit-floating');
            this._moveToolbar(Math.round(region.x + (region.width - width) / 2), region.y, width, height);
        }
    }

    // Keeps the toolbar's rectangle, which the mode buttons stay clear of, as it is only allocated on the next frame.
    _moveToolbar(x, y, width, height) {
        this.toolbar.set_position(x, y);
        this.toolbarRect = {x, y, width, height};
    }

    // The mode buttons stand left of the region, or right of it when the left has no room on the region's monitor,
    // or just inside its left edge when the region fills the monitor.
    _placeModes() {
        const [, width] = this.modes.get_preferred_width(-1);
        const [, height] = this.modes.get_preferred_height(width);
        const selection = this.document.selection;
        const monitor = mostOverlapping(Main.layoutManager.monitors, selection);
        const side = sideOfRect(selection, {width, height}, monitor, TOOLBAR_GAP);
        // Beside a region shorter than themselves, they would reach down over the toolbar under it.
        const {x, y} = clearOf({...side, width, height}, this.toolbarRect, monitor, TOOLBAR_GAP);
        this.modes.set_position(Math.round(x), Math.round(y));
    }

    // Puts the hint in the top-left or bottom-right corner of the primary monitor.
    _placeHint(corner) {
        this.hintCorner = corner;
        const monitor = Main.layoutManager.primaryMonitor;
        const [, width] = this.hint.get_preferred_width(-1);
        const [, height] = this.hint.get_preferred_height(width);
        this.hint.set_position(corner === 'top-left' ? monitor.x + 30 : monitor.x + monitor.width - width - 30,
            corner === 'top-left' ? monitor.y + 30 : monitor.y + monitor.height - height - 30);
    }

    /**
     * Shows how far element detection is under the hint, or hides it once detection is over. progress: {fraction
     * of the work done from 0 to 1, screens answered, screens in all}, e.g. {fraction: 0.4, done: 1, total: 3}; or
     * null.
     */
    showProgress(progress) {
        if (this.closed)
            return;
        this.progress.visible = progress !== null;
        if (progress) {
            this.progressLabel.set_text(progress.total > 1
                ? `Finding boxes… ${progress.done} of ${progress.total} screens` : 'Finding boxes…');
            this.progressFraction = progress.fraction;
            this._fillProgress(true);
        }
        // The hint changes size, and in the bottom-right corner its position depends on that.
        this._placeHint(this.hintCorner);
    }

    // Sizes the progress bar's fill to the fraction done, gliding there unless the bar itself just changed width.
    _fillProgress(animate) {
        const width = Math.round(this.progressTrack.width * this.progressFraction);
        this.progressFill.remove_all_transitions();
        if (animate)
            this.progressFill.ease({width, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.progressFill.set_width(width);
    }

    // Moves the hint to the opposite corner when the pointer comes near, so it never covers what is being picked.
    _avoidHint(point) {
        const [, width] = this.hint.get_preferred_width(-1);
        const [, height] = this.hint.get_preferred_height(width);
        if (point.x >= this.hint.x - HINT_MARGIN && point.x <= this.hint.x + width + HINT_MARGIN &&
            point.y >= this.hint.y - HINT_MARGIN && point.y <= this.hint.y + height + HINT_MARGIN)
            this._placeHint(this.hintCorner === 'top-left' ? 'bottom-right' : 'top-left');
    }

    // The cursor shows what a press does: the move cursor over the toolbar's handle and through a toolbar drag, and
    // otherwise what _cursorAt says. It stays as it was through any other drag.
    _updateCursor() {
        let cursor = 'default';
        if (this.closed)
            cursor = 'default';
        else if (this.handle.hover || this.gesture?.kind === 'toolbar')
            cursor = 'move';
        else if (this.gesture)
            cursor = this.cursor ?? 'crosshair';
        else if (!this.overChrome)
            cursor = this._cursorAt(this.cursorPoint);
        if (cursor === this.cursor)
            return;
        this.cursor = cursor;
        // GNOME 50 has no display-wide cursor: an actor sets its own, here the overlay, which holds the grab.
        // Mutter aborts on a cursor value it does not know, so each name falls back to the older spelling.
        const types = Clutter.CursorType ?? Meta.Cursor;
        const value = CURSORS[cursor].map(name => types[name]).find(type => type !== undefined);
        if (Clutter.CursorType)
            this.actor.set_cursor_type(value);
        else
            global.display.set_cursor(value);
    }

    /**
     * The cursor for a press at point, following _press: 'pointer' on a large region's outline, which a click picks,
     * 'crosshair' where it picks a box, starts a region or draws, 'confirm' where a click finishes the screenshot or
     * starts the recording, 'move' over an annotation it would move, and 'default' where it resizes the region from a
     * corner or deselects an annotation.
     * @param {?{x: number, y: number}} point stage coordinates
     * @returns {string}
     */
    _cursorAt(point) {
        const rect = this.document.selection;
        if (!rect || !point)
            return point && this._outlinedRegion(point) ? 'pointer' : 'crosshair';
        if (this.mode === 'image') {
            if (this.tool !== 'select')
                return 'crosshair';
            const active = this.document.annotations[this.activeIndex];
            if (active && (opHandleAt(active, point) || opHit(active, point)))
                return 'move';
            if (this.document.annotations.some(operation => opHit(operation, point)))
                return 'move';
            if (this.activeIndex !== null)
                return 'default';
        }
        const corners = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height],
            [rect.x + rect.width, rect.y + rect.height]];
        if (corners.some(([x, y]) => Math.abs(point.x - x) < 12 && Math.abs(point.y - y) < 12))
            return 'default';
        return contains(rect, point) ? 'confirm' : 'crosshair';
    }

    _region() {
        return this.preview?.selection ?? this.document.selection;
    }

    _redraw() {
        if (this.closed)
            return;
        const rect = this._region();
        // Before a region exists, the hovered window shows undimmed so the user sees what a click would capture.
        // Frame rects can reach past the stage edge, which would push the mask pieces to negative sizes.
        const stage = {x: 0, y: 0, width: this.actor.width, height: this.actor.height};
        this._layoutMask(rect ?? intersectRect(this.hover, stage));
        this._layoutRegions();
        this._layoutChrome(rect);
        this._layoutAnnotations(this.mode === 'image' ? rect : null);
        this._updateCursor();
    }

    _layoutMask(rect) {
        const {width, height} = this.actor;
        const pieces = rect ? [
            [0, 0, width, rect.y],
            [0, rect.y + rect.height, width, height - rect.y - rect.height],
            [0, rect.y, rect.x, rect.height],
            [rect.x + rect.width, rect.y, width - rect.x - rect.width, rect.height],
        ] : [[0, 0, width, height]];
        this.mask.forEach((piece, index) => {
            const [x, y, w, h] = pieces[index] ?? [0, 0, 0, 0];
            piece.set_position(x, y);
            piece.set_size(Math.max(0, w), Math.max(0, h));
        });
    }

    _layoutChrome(rect) {
        const outline = rect ?? this.hover;
        if (!outline) {
            this.chrome.forEach(patch => patch.show(null));
            return;
        }
        let label = null;
        if (rect) {
            const text = `X: ${Math.round(rect.x)} Y: ${Math.round(rect.y)} W: ${Math.round(rect.width)} H: ${Math.round(rect.height)}`;
            label = {
                text, x: rect.x, y: rect.y >= LABEL_HEIGHT ? rect.y - LABEL_HEIGHT : rect.y,
                height: LABEL_HEIGHT - 2, width: measureText(text, 12, Cairo.FontWeight.NORMAL) + 12,
            };
        }
        const handles = Boolean(rect) && this.tool === 'select' && this.activeIndex === null;
        this.chromeState = {outline, label, handles};
        const key = JSON.stringify(this.chromeState);
        outlineBands(outline, 6, PATCH_GRID, label).forEach((band, index) => this.chrome[index].show(band, key));
    }

    /**
     * Outlines the large regions of the window under the pointer in dashes, a colour per nesting level, each with a
     * tab inside its top-left corner that selects it whole: a region its own content tiles completely has no spot
     * left where a click picks it. Shown only until a region is chosen.
     */
    _layoutRegions() {
        const point = this.pointer;
        const window = this.showRegions && !this.document.selection && !this.gesture && point
            ? this.candidates.find(candidate => contains(candidate, point)) : null;
        if (!window) {
            this.regionLayer.show(null);
            this.regionTabs.hide();
            return;
        }
        const regions = largeRegions(window, this.elements.panels.get(window) ?? []);
        const key = JSON.stringify([window, regions]);
        const stage = {x: 0, y: 0, width: this.actor.width, height: this.actor.height};
        if (key !== this.regionsKey) {
            this.regionsKey = key;
            this.regions = regions;
            // Tabs being destroyed report losing the pointer, which must not move the hover meanwhile.
            this.rebuildingTabs = true;
            this.regionTabs.destroy_all_children();
            this.rebuildingTabs = false;
            const placed = [];
            for (const {rect, depth} of regions) {
                const [red, green, blue] = REGION_COLORS[depth % REGION_COLORS.length];
                const tab = new St.Button({
                    reactive: true, style_class: 'capit-region-tab',
                    style: `background-color: rgba(${red * 255}, ${green * 255}, ${blue * 255}, 0.9);`,
                    label: `${Math.round(rect.width)} × ${Math.round(rect.height)}`,
                });
                // Measured once on the stage, where it has its style.
                this.regionTabs.add_child(tab);
                const [, width] = tab.get_preferred_width(-1);
                const [, height] = tab.get_preferred_height(width);
                const inset = (depth + 1) * REGION_INSET;
                const spot = {x: rect.x + inset, y: rect.y + inset, width, height};
                // Nested regions often share a corner; their tabs then line up side by side.
                for (let other; (other = placed.find(box => intersectRect(box, spot)));)
                    spot.x = other.x + other.width + REGION_INSET;
                placed.push(spot);
                tab.set_position(Math.round(spot.x), Math.round(spot.y));
                tab.connect('notify::hover', () => {
                    if (!this.rebuildingTabs && !this.closed && !this.document.selection)
                        this._setHover(tab.hover ? rect : this.pointer && this._boxAt(this.pointer));
                });
                tab.connect('clicked', () => {
                    this.hover = null;
                    this.widened = false;
                    this.document.select(rect);
                    this._update();
                    this._quickCapture();
                });
            }
        }
        // The region a click picks has its outline drawn brighter, so the layer repaints when that changes.
        this.regionLayer.show(regions.length ? intersectRect(window, stage) : null,
            JSON.stringify([key, regions.findIndex(({rect}) => rect === this.hover)]));
        this.regionTabs.show();
    }

    _layoutAnnotations(rect) {
        this._layoutBlurs(rect);
        if (!rect) {
            this.annotationLayer.show(null);
            this.liveLayer.show(null);
            return;
        }
        // The annotation being dragged is drawn on the live layer, so the rest stay put while it moves.
        const draftIndex = this.draft?.index ?? -1;
        const committed = this.document.annotations.filter((_, index) => index !== draftIndex)
            .map(paintBounds).reduce(unionRect, null);
        // The region is part of each key because it is the clip: patches snap outward, so a 1-3 px move of the
        // region edge can leave the patch area unchanged while what it shows changes.
        // Annotations reach past the region, dimmed there, so the layers cover them on the whole stage.
        const stage = {x: 0, y: 0, width: this.actor.width, height: this.actor.height};
        this.annotationLayer.show(intersectRect(committed, stage),
            JSON.stringify([this.document.revision, draftIndex, rect]));
        const live = [this.draft?.operation, this.preview?.operation].filter(Boolean);
        const active = this._activeOperation();
        this.liveLayer.show(intersectRect(unionRect(live.map(paintBounds).reduce(unionRect, null),
            active ? paintBounds(active) : null), stage), JSON.stringify([live, active, rect]));
    }

    // Previews blur annotations with Shell's blur over a clipped copy of the frozen image, since Cairo cannot read
    // its pixels; the PNG renderer computes the exported blur itself.
    _layoutBlurs(rect) {
        const draftIndex = this.draft?.index ?? -1;
        const operations = rect ? [...this.document.annotations.filter((_, index) => index !== draftIndex),
            this.draft?.operation, this.preview?.operation].filter(operation => operation?.kind === 'blur') : [];
        const stage = {x: 0, y: 0, width: this.actor.width, height: this.actor.height};
        while (this.blurs.length < operations.length) {
            // Clipped to its allocation, the frame's offscreen blur samples only pixels inside the box, as the
            // renderer does.
            const frame = new Clutter.Actor({clip_to_allocation: true});
            frame.add_child(new Clutter.Actor({
                content: this.content, width: stage.width, height: stage.height,
                content_gravity: Clutter.ContentGravity.RESIZE_FILL,
            }));
            // GNOME 46 replaced the effect's sigma with a radius twice as large.
            const strength = 'radius' in Shell.BlurEffect.prototype ? {radius: BLUR_RADIUS} : {sigma: BLUR_RADIUS / 2};
            frame.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, ...strength}));
            this.actor.insert_child_above(frame, this.background);
            this.blurs.push(frame);
        }
        this.blurs.forEach((frame, index) => {
            const operation = operations[index];
            const box = operation && intersectRect(rectBetween({x: operation.x1, y: operation.y1},
                {x: operation.x2, y: operation.y2}), stage);
            if (!box) {
                frame.hide();
                return;
            }
            frame.set_position(box.x, box.y);
            frame.set_size(box.width, box.height);
            frame.get_first_child().set_position(-box.x, -box.y);
            frame.show();
        });
    }

    _activeOperation() {
        if (this.activeIndex === null)
            return null;
        return this.draft?.index === this.activeIndex ? this.draft.operation : this.document.annotations[this.activeIndex] ?? null;
    }

    // Paints `operations` as they are inside the region and under the mask's dim outside it, which shows what the
    // crop will drop rather than hiding it.
    _paintCropped(cr, operations) {
        const rect = this._region();
        if (!rect || operations.length === 0)
            return;
        cr.save();
        cr.rectangle(rect.x, rect.y, rect.width, rect.height);
        cr.clip();
        operations.forEach(operation => paintOperation(cr, operation));
        cr.restore();
        cr.save();
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.rectangle(0, 0, this.actor.width, this.actor.height);
        cr.rectangle(rect.x, rect.y, rect.width, rect.height);
        cr.clip();
        // The dim goes on top of the annotation's own pixels only (ATOP), so over the already dimmed backdrop it
        // matches what the mask would show had the annotation been part of the image.
        cr.pushGroup();
        operations.forEach(operation => paintOperation(cr, operation));
        const dim = this.mask[0].get_theme_node().get_background_color();
        cr.setOperator(Cairo.Operator.ATOP);
        cr.setSourceRGBA(dim.red / 255, dim.green / 255, dim.blue / 255, dim.alpha / 255);
        cr.paint();
        cr.popGroupToSource();
        cr.paint();
        cr.restore();
    }

    _paintAnnotations(cr) {
        this._paintCropped(cr, this.document.annotations.filter((_, index) => index !== this.draft?.index));
    }

    _paintLive(cr) {
        if (!this._region())
            return;
        this._paintCropped(cr, [this.draft?.operation, this.preview?.operation].filter(Boolean));
        this._paintActive(cr);
    }

    _paintChrome(cr) {
        const {outline, label, handles} = this.chromeState;
        cr.setLineWidth(1);
        cr.setSourceRGB(0, 0, 0);
        cr.rectangle(outline.x + 0.5, outline.y + 0.5, outline.width, outline.height);
        cr.stroke();
        cr.setSourceRGB(1, 1, 1);
        cr.setDash([5, 4], 0);
        cr.rectangle(outline.x + 0.5, outline.y + 0.5, outline.width, outline.height);
        cr.stroke();
        cr.setDash([], 0);
        if (label) {
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
            cr.setFontSize(12);
            cr.setSourceRGBA(0.1, 0.1, 0.1, 0.9);
            cr.rectangle(label.x, label.y, label.width, label.height);
            cr.fill();
            cr.setSourceRGB(1, 1, 1);
            cr.moveTo(label.x + 6, label.y + 14);
            cr.showText(label.text);
        }
        if (handles) {
            cr.setSourceRGB(0.45, 0.74, 1);
            for (const x of [outline.x, outline.x + outline.width]) {
                for (const y of [outline.y, outline.y + outline.height]) {
                    cr.rectangle(x - 4, y - 4, 8, 8);
                    cr.fill();
                }
            }
        }
    }

    _paintRegions(cr) {
        cr.setLineWidth(REGION_LINE);
        cr.setDash([10, 6], 0);
        for (const region of this.regions) {
            const [red, green, blue] = REGION_COLORS[region.depth % REGION_COLORS.length];
            const outline = regionOutline(region, REGION_INSET);
            cr.setSourceRGBA(red, green, blue, region.rect === this.hover ? 1 : REGION_DIM);
            cr.rectangle(outline.x, outline.y, outline.width, outline.height);
            cr.stroke();
        }
    }

    // Handles are drawn outside the region clip so a partly clipped element can still be grabbed.
    _paintActive(cr) {
        const operation = this._activeOperation();
        if (!operation)
            return;
        const b = opBounds(operation);
        cr.save();
        if (operation.kind !== 'arrow') {
            cr.setSourceRGBA(0.45, 0.74, 1, 0.9);
            cr.setLineWidth(1);
            cr.setDash([4, 3], 0);
            cr.rectangle(b.x - 2.5, b.y - 2.5, b.width + 5, b.height + 5);
            cr.stroke();
            cr.setDash([], 0);
        }
        for (const [, x, y] of opHandles(operation)) {
            cr.rectangle(x - 4, y - 4, 8, 8);
            cr.setSourceRGB(1, 1, 1);
            cr.fillPreserve();
            cr.setSourceRGB(0.2, 0.45, 0.8);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
        cr.restore();
    }

    _event(event) {
        if (this.closed)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._key(event);
        if (this.busy)
            return Clutter.EVENT_STOP;
        if (![Clutter.EventType.MOTION, Clutter.EventType.BUTTON_PRESS, Clutter.EventType.BUTTON_RELEASE,
            Clutter.EventType.SCROLL].includes(type))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const source = event.get_source() ?? global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        const point = {x, y};
        if (type === Clutter.EventType.SCROLL) {
            if (this.gesture)
                return Clutter.EVENT_PROPAGATE;
            if (this.document.selection) {
                const active = this.mode === 'image' ? this.document.annotations[this.activeIndex] : null;
                if (!active || !WIDTH_TOOLS.includes(active.kind))
                    return Clutter.EVENT_PROPAGATE;
                this._scrollWidth(event, active);
                return Clutter.EVENT_STOP;
            }
            this._scroll(event, point);
            return Clutter.EVENT_STOP;
        }
        this.shift = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        if (!this.gesture && type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1 &&
            source && this.handle.contains(source)) {
            this.gesture = {kind: 'toolbar', start: point, original: {x: this.toolbar.x, y: this.toolbar.y}};
            this._updateCursor();
            return Clutter.EVENT_STOP;
        }
        this.cursorPoint = point;
        this.overChrome = !this.gesture && Boolean(source) &&
            [this.toolbar, this.modes, this.entry, this.regionTabs].some(actor => actor.contains(source));
        this._updateCursor();
        if (this.overChrome)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            if (this.gesture) {
                this._motion(point);
            } else if (!this.document.selection) {
                this.pointer = point;
                this._avoidHint(point);
                this._setHover(this._boxAt(point));
                // Hover only redraws when the box changes; entering another window can keep it null throughout.
                this._layoutRegions();
                this.elements.queryElements();
            }
        } else if (event.get_button() === 1) {
            if (type === Clutter.EventType.BUTTON_PRESS)
                this._press(point);
            else
                this._release(point);
        }
        return Clutter.EVENT_STOP;
    }

    _press(point) {
        this._commitText();
        const rect = this.document.selection;
        let deselected = false;
        // A recording mode hides the annotations, so presses only move and resize the area.
        if (rect && this.mode === 'image') {
            const active = this.document.annotations[this.activeIndex];
            let target = null;
            if (active) {
                const handle = opHandleAt(active, point);
                if (handle)
                    target = {kind: 'op-resize', handle, index: this.activeIndex};
                // A drawing tool grabs the box just drawn only by its outline, so a drag inside it draws anew.
                else if (['select', 'text'].includes(this.tool) ? opHit(active, point) : opEdgeHit(active, point))
                    target = {kind: 'op-move', index: this.activeIndex};
            }
            if (!target && this.tool === 'select') {
                const index = this.document.annotations.findLastIndex(operation => opHit(operation, point));
                if (index >= 0)
                    target = {kind: 'op-move', index};
            }
            if (target) {
                this.activeIndex = target.index;
                this.gesture = {...target, start: point, original: this.document.annotations[target.index]};
                this._redraw();
                return;
            }
            if (this.tool === 'select') {
                deselected = this.activeIndex !== null;
                this.activeIndex = null;
            } else if (this.tool === 'text') {
                // Like the other drawing tools, text may be placed anywhere without touching the region.
                this.activeIndex = null;
                this.textPoint = point;
                this.entry.set_position(Math.min(point.x, global.stage.width - 350), Math.min(point.y, global.stage.height - 55));
                this.entry.set_text('');
                this.entry.show();
                global.stage.set_key_focus(this.entry.clutter_text);
                this._redraw();
                return;
            } else {
                // Drawing may start anywhere; the PNG export clips to the region, and painting dims what lies outside it.
                this.activeIndex = null;
                this.gesture = {
                    kind: 'annotation', tool: this.tool, start: point,
                    points: this.tool === 'brush' ? [[point.x, point.y]] : null,
                };
                this._redraw();
                return;
            }
        }
        let handle = null;
        if (rect) {
            for (const [id, x, y] of [['nw', rect.x, rect.y], ['ne', rect.x + rect.width, rect.y],
                ['sw', rect.x, rect.y + rect.height], ['se', rect.x + rect.width, rect.y + rect.height]]) {
                if (Math.abs(point.x - x) < 12 && Math.abs(point.y - y) < 12)
                    handle = id;
            }
        }
        let kind = 'create';
        if (handle)
            kind = 'resize';
        else if (rect && contains(rect, point))
            kind = 'move';
        this.gesture = {
            kind, handle, deselected, start: point, original: rect ? {...rect} : null,
            candidate: kind === 'create' ? this._boxAt(point) : null,
        };
    }

    _motion(point) {
        const gesture = this.gesture;
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        const rect = gesture.original;
        if (gesture.kind === 'toolbar') {
            // A click on the handle without a real drag leaves a docked toolbar docked.
            if (!this.toolbarPosition && Math.hypot(dx, dy) < 2)
                return;
            this.toolbarPosition = {x: Math.round(rect.x + dx), y: Math.round(rect.y + dy)};
            // Kept on the pointer's monitor, so the bar crosses to a neighbouring one together with the grip,
            // rather than jumping ahead of it once half of the bar has crossed.
            this._placeToolbar(mostOverlapping(Main.layoutManager.monitors, {...point, width: 1, height: 1}));
            return;
        }
        if (gesture.kind === 'op-move') {
            this.draft = {index: gesture.index, operation: moveOp(gesture.original, dx, dy)};
        } else if (gesture.kind === 'op-resize') {
            this.draft = {index: gesture.index, operation: resizeOp(gesture.original, gesture.handle, point)};
        } else if (gesture.kind === 'annotation' && gesture.points) {
            // Samples closer than a pixel add nothing to the stroke but length to the saved annotation.
            const [lastX, lastY] = gesture.points[gesture.points.length - 1];
            if (Math.hypot(point.x - lastX, point.y - lastY) >= 1)
                gesture.points.push([point.x, point.y]);
            this.preview = {operation: brushOp(gesture.points.slice(), this.color, this.width)};
        } else if (gesture.kind === 'annotation') {
            const corner = gesture.tool === 'ellipse' && this.shift ? squareCorner(gesture.start, point) : point;
            this.preview = {
                operation: {
                    kind: gesture.tool, x1: gesture.start.x, y1: gesture.start.y,
                    x2: corner.x, y2: corner.y, color: this.color, width: this.width,
                },
            };
        } else if (gesture.kind === 'create') {
            this.preview = {selection: clampRect(rectBetween(gesture.start, point), this.document.bounds)};
        } else if (gesture.kind === 'move') {
            const bounds = this.document.bounds;
            this.preview = {
                selection: {
                    ...rect,
                    x: Math.max(0, Math.min(rect.x + dx, bounds.width - rect.width)),
                    y: Math.max(0, Math.min(rect.y + dy, bounds.height - rect.height)),
                },
            };
        } else {
            const corner = {
                x: gesture.handle.includes('w') ? rect.x + rect.width : rect.x,
                y: gesture.handle.includes('n') ? rect.y + rect.height : rect.y,
            };
            this.preview = {selection: clampRect(rectBetween(corner, point), this.document.bounds)};
        }
        this._redraw();
    }

    _cancelGesture() {
        this.gesture = null;
        this.preview = null;
        this.draft = null;
        this._updateCursor();
        this._update();
    }

    _release(point) {
        const gesture = this.gesture;
        if (!gesture)
            return;
        this._motion(point);
        const distance = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
        if (gesture.kind === 'op-move' || gesture.kind === 'op-resize') {
            if (distance >= 2 && this.draft)
                this.document.replace(gesture.index, this.draft.operation);
        } else if (gesture.kind === 'annotation') {
            // A brush click without movement leaves a dot; the other tools need a real drag.
            if (distance >= 2 || gesture.points) {
                this.document.annotate(this.preview.operation);
                this.activeIndex = this.document.annotations.length - 1;
            }
        } else if (gesture.kind === 'create' && distance < 4 && gesture.original) {
            // A click outside the chosen region goes back to picking one by hover, unless all it did was deselect
            // an annotation.
            if (!gesture.deselected)
                this.document.deselect();
        } else if (gesture.kind === 'create' && distance < 4 && gesture.candidate) {
            this.document.select(gesture.candidate);
        } else if (gesture.kind === 'move' && distance < 2 && !gesture.deselected) {
            // Clicking the chosen region without dragging it, the second click after picking it, does what Enter
            // does: copy and save the screenshot, or start a recording. A click that only deselects an annotation
            // does not.
            this.gesture = null;
            this.preview = null;
            this._updateCursor();
            if (this.mode === 'image')
                this.finish(['copy', 'save']);
            else
                this._record();
            return;
        } else if (distance >= 2 && this.preview?.selection) {
            this.document.select(this.preview.selection);
        }
        this.gesture = null;
        this.preview = null;
        this.draft = null;
        this.hover = null;
        this.widened = false;
        if (!this.document.selection) {
            // Back to picking by hover: the box under the pointer shows without waiting for it to move.
            this.pointer = point;
            this.hover = this._boxAt(point);
        }
        this._updateCursor();
        this._update();
        // Only a newly picked region finishes: moving or resizing the region of a failed export, which keeps the
        // capture open for a retry, must not export again on release.
        if (gesture.kind === 'create')
            this._quickCapture();
    }

    // With quick capture on, copies and saves a screenshot once its region is picked. The toolbar and mode buttons
    // stay hidden, and appear only when the export fails, for a retry.
    _quickCapture() {
        if (!this.quickCapture || this.mode !== 'image' || !this.document.selection)
            return;
        this.quickExport = true;
        this._update();
        this.finish(['copy', 'save']);
    }

    // The wheel thickens or thins the active annotation's line a pixel a notch. Consecutive notches on the same
    // annotation, with no other change between them, make one undo step.
    _scrollWidth(event, operation) {
        const steps = this._scrollSteps(event);
        const width = Math.max(MIN_LINE_WIDTH, Math.min(MAX_LINE_WIDTH, Math.round(operation.width ?? 3) + steps));
        if (!steps || width === operation.width)
            return;
        const index = this.activeIndex;
        const merge = this.wheelEdit?.index === index && this.wheelEdit.revision === this.document.revision;
        this.document.replace(index, {...operation, width}, merge);
        this.wheelEdit = {index, revision: this.document.revision};
        this._update();
        if (this.hinting === null)
            this.status.set_text(`Line thickness ${width}px`);
    }

    /**
     * The smart box a click at point selects: the large region whose outline the point is on, as its tab would, or
     * else the innermost panel there, or a box scrolling widened it to.
     */
    _boxAt(point) {
        const window = this.candidates.find(candidate => contains(candidate, point));
        if (!window)
            return null;
        const outlined = this._outlinedRegion(point);
        if (outlined)
            return outlined;
        const boxes = boxesAt(window, this.elements.panels.get(window) ?? [], point);
        if (this.widened && boxes.includes(this.hover))
            return this.hover;
        this.widened = false;
        return boxes.at(-1);
    }

    // The large region whose drawn outline point is on, or null. Outlines are drawn only while no region is chosen.
    _outlinedRegion(point) {
        if (!this.showRegions)
            return null;
        const window = this.candidates.find(candidate => contains(candidate, point));
        if (!window || this.document.selection)
            return null;
        return regionAtOutline(largeRegions(window, this.elements.panels.get(window) ?? []), point, REGION_INSET,
            REGION_REACH);
    }

    _setHover(box) {
        if (box === this.hover)
            return;
        this.hover = box;
        if (!box)
            this.widened = false;
        this._redraw();
    }

    // Wheel notches in a scroll event: 1 a notch up, -1 a notch down, 0 for none.
    _scrollSteps(event) {
        // A wheel also sends emulated discrete events next to its smooth ones; counting both would double steps.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            return 1;
        if (direction === Clutter.ScrollDirection.DOWN)
            return -1;
        // A wheel's smooth events copy its notches. GNOME 46 and later flag them as emulated; GNOME 45 does not.
        if (direction !== Clutter.ScrollDirection.SMOOTH || event.get_scroll_source() === Clutter.ScrollSource.WHEEL)
            return 0;
        // A touchpad reports fractions of a wheel notch, so a flick makes a few steps rather than one per event.
        this.scrollDelta += event.get_scroll_delta()[1];
        const notches = Math.trunc(this.scrollDelta);
        this.scrollDelta -= notches;
        return -notches;
    }

    // Scrolling up steps out to the enclosing box, up to the whole window; scrolling down steps back in.
    _scroll(event, point) {
        const steps = this._scrollSteps(event);
        this.pointer = point;
        const window = this.candidates.find(candidate => contains(candidate, point));
        if (!steps || !window)
            return;
        const boxes = boxesAt(window, this.elements.panels.get(window) ?? [], point);
        const current = boxes.includes(this.hover) ? boxes.indexOf(this.hover) : boxes.length - 1;
        const next = Math.max(0, Math.min(boxes.length - 1, current - steps));
        this.widened = next < boxes.length - 1;
        this._setHover(boxes[next]);
    }

    _commitText() {
        if (!this.entry?.visible)
            return false;
        const text = this.entry.get_text().trim();
        if (text) {
            const clipped = text.slice(0, 4096);
            this.document.annotate({
                kind: 'text', x1: this.textPoint.x, y1: this.textPoint.y,
                text: clipped, color: this.color, size: 24, textWidth: measureText(clipped, 24),
            });
            this.activeIndex = this.document.annotations.length - 1;
        }
        this.entry.hide();
        this.entry.set_text('');
        global.stage.set_key_focus(this.actor);
        this._update();
        return true;
    }

    _key(event) {
        if (this.busy)
            return Clutter.EVENT_STOP;
        const key = event.get_key_symbol();
        // Mid-drag, a tool switch, delete, undo or finish would change the annotation or region the drag is about
        // to write back, so only Escape works, and it abandons the drag.
        if (this.gesture) {
            if (key === Clutter.KEY_Escape)
                this._cancelGesture();
            return Clutter.EVENT_STOP;
        }
        const control = Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
        const shift = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        if (this.folderEntry.visible) {
            if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(key)) {
                const directory = this.folderEntry.get_text().trim();
                if (directory && !GLib.path_is_absolute(directory) && !directory.startsWith('~/')) {
                    this.status.set_text('Use a full output-folder path or ~/folder.');
                    return Clutter.EVENT_STOP;
                }
                this.extension.settings.set_string('output-directory', directory);
                this.folderEntry.hide();
                global.stage.set_key_focus(this.actor);
                this.status.set_text('Output folder updated. Press Enter to finish or retry.');
                this._update();
                return Clutter.EVENT_STOP;
            }
            if (key === Clutter.KEY_Escape) {
                this.folderEntry.hide();
                global.stage.set_key_focus(this.actor);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (key === Clutter.KEY_Escape) {
            if (this.entry.visible) {
                this.entry.hide();
                global.stage.set_key_focus(this.actor);
            } else {
                this.close();
            }
            return Clutter.EVENT_STOP;
        }
        if (this.mode !== 'image') {
            if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(key))
                this._record();
            else if ([Clutter.KEY_d, Clutter.KEY_D].includes(key))
                this._toggleDemoCursor();
            return Clutter.EVENT_STOP;
        }
        if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(key)) {
            const committed = this._commitText();
            if (!committed || control)
                this.finish(['copy', 'save']);
            return Clutter.EVENT_STOP;
        }
        if (this.entry.visible)
            return Clutter.EVENT_PROPAGATE;
        if ([Clutter.KEY_Delete, Clutter.KEY_BackSpace].includes(key) && this.activeIndex !== null) {
            this.document.remove(this.activeIndex);
            this.activeIndex = null;
            this._update();
            return Clutter.EVENT_STOP;
        }
        if (control && [Clutter.KEY_z, Clutter.KEY_Z, Clutter.KEY_y, Clutter.KEY_Y].includes(key)) {
            this._undo(shift || [Clutter.KEY_y, Clutter.KEY_Y].includes(key));
            return Clutter.EVENT_STOP;
        }
        if (control && key === Clutter.KEY_c) {
            this.finish(['copy']);
            return Clutter.EVENT_STOP;
        }
        if (control && key === Clutter.KEY_s) {
            this.finish(['save']);
            return Clutter.EVENT_STOP;
        }
        const tool = TOOL_KEYS.get(key);
        if (tool)
            this._setTool(tool);
        return Clutter.EVENT_STOP;
    }

    async _worker(request) {
        const process = Gio.Subprocess.new([GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs', '-m',
            `${this.extension.path}/renderer.js`],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this.worker = process;
        const [stdout, stderr] = await process.communicate_utf8_async(JSON.stringify(request), null);
        this.worker = null;
        let response;
        try {
            response = JSON.parse(stdout);
        } catch {
            throw new Error(stderr?.trim() || 'The PNG renderer did not return a result');
        }
        if (!process.get_successful() || response.error)
            throw new Error(response.error || stderr?.trim() || 'PNG rendering failed');
        return response;
    }

    // Closes the overlay and hands the selected area to a new GIF or video recording.
    _record() {
        const area = this.document.selection;
        if (this.closed || this.busy || !area || this.mode === 'image')
            return;
        const {extension, mode} = this;
        this.close();
        extension.startRecording(area, mode);
    }

    async finish(requested) {
        if (this.closed || this.busy || !this.document.selection || this.mode !== 'image')
            return;
        this._commitText();
        this.busy = true;
        this.phase = 'exporting';
        const timing = new Timing(this.extension.settings, 'export');
        this.status.set_text('Rendering the final image…');
        const revision = this.document.revision;
        if (this.outputs.revision !== revision)
            this.outputs = {revision, copy: 'none', save: 'none', savedPath: null};
        try {
            const directory = outputDirectory(this.extension.settings);
            let response;
            if (this.artifactRevision !== revision) {
                const texture = this.content.get_texture();
                const rect = pixelRect(this.document.selection, this.scale, texture.get_width(), texture.get_height());
                const source = Gio.File.new_for_path(`${this.workdir}/source.png`);
                const stream = source.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
                try {
                    await Shell.Screenshot.composite_to_stream(texture, rect.x, rect.y, rect.width, rect.height,
                        this.scale, null, 0, 0, 1, stream);
                } finally {
                    stream.close(null);
                }
                timing.mark('crop', `${rect.width}x${rect.height} px`);
                if (this.closed)
                    return;
                response = await this._worker({
                    action: 'render', source: source.get_path(),
                    artifact: `${this.workdir}/final.png`, scale: this.scale,
                    origin: [rect.x / this.scale, rect.y / this.scale], annotations: this.document.annotations,
                    save: requested.includes('save'), directory,
                });
                timing.mark('render', `${this.document.annotations.length} annotations` +
                    `${requested.includes('save') ? ', saved' : ''}`);
                this.artifactRevision = revision;
                this.artifact = response.artifact;
                try {
                    source.delete(null);
                } catch { /* Cleanup must not invalidate completed outputs. */ }
            } else if (requested.includes('save') && this.outputs.save !== 'success') {
                response = await this._worker({action: 'save', artifact: this.artifact, save: true, directory});
                timing.mark('save');
            }
            if (this.closed)
                return;
            if (requested.includes('save') && this.outputs.save !== 'success') {
                this.outputs.save = response?.savedPath ? 'success' : 'failed';
                this.outputs.savedPath = response?.savedPath ?? null;
                if (response?.savedPath)
                    delete this.outputs.saveError;
                else
                    this.outputs.saveError = response?.saveError ?? 'Could not save the PNG';
            }
            if (requested.includes('copy') && this.outputs.copy !== 'success') {
                try {
                    const kind = clipboardKind(this.extension.settings, requested.includes('save'));
                    // A file reference must name a file that outlives this capture's temporary folder: the saved
                    // PNG, or else a copy kept for the clipboard.
                    let path = this.artifact;
                    if (kind === 'file') {
                        path = this.outputs.savedPath ?? (await this._worker({
                            action: 'clipboard',
                            artifact: this.artifact, clipboardDirectory: clipboardDirectory(),
                        })).clipboardPath;
                    }
                    if (this.closed)
                        return;
                    this.outputs.copied = await copyCapture(path, kind);
                    this.outputs.copy = 'success';
                    timing.mark('copy', this.outputs.copied);
                    delete this.outputs.copyError;
                } catch (error) {
                    this.outputs.copy = 'failed';
                    this.outputs.copyError = error.message;
                }
            }
            this.extension.lastResult = {...this.outputs};
            timing.mark('finished', requested.map(kind => `${kind} ${this.outputs[kind]}`).join(', '));
            if (requested.every(kind => this.outputs[kind] === 'success')) {
                const copied = this.outputs.copied === 'file' ? 'Copied as a file' : 'Copied to the clipboard';
                Main.notify('CapIt', this.outputs.savedPath ? `Saved ${this.outputs.savedPath}` : copied);
                this.busy = false;
                this.close();
            } else {
                this.phase = 'recovery';
                const parts = requested.map(kind => this.outputs[kind] === 'success' ? `${kind}: complete`
                    : `${kind}: ${this.outputs[`${kind}Error`] || 'failed'}`);
                this.status.set_text(`${parts.join(' · ')}. Fix the problem and press Enter to retry.`);
            }
        } catch (error) {
            if (!this.closed) {
                this.phase = 'recovery';
                this.status.set_text(`Capture retained: ${error.message}. Press Enter to retry or Escape to cancel.`);
                this.extension.lastResult = {error: error.message, ...this.outputs};
                console.error(`[CapIt] ${error.message}`);
            }
        } finally {
            this.busy = false;
            if (this.closed) {
                this._cleanFiles();
            } else if (this.quickExport) {
                // Shown directly: _update would also reset the recovery phase that the status reports.
                this.quickExport = false;
                this.toolbar.show();
                this.modes.show();
                this._placeToolbar();
                this._placeModes();
            }
        }
    }

    _cleanFiles() {
        for (const filename of ['source.png', 'final.png']) {
            try {
                Gio.File.new_for_path(`${this.workdir}/${filename}`).delete(null);
            } catch { /* Already absent. */ }
        }

        GLib.rmdir(this.workdir);
    }

    close() {
        if (this.closed || this.busy)
            return;
        this.closed = true;
        if (this.detectLater)
            global.compositor.get_laters().remove(this.detectLater);
        this.elements.stop();
        this._updateCursor();
        if (this.grab) {
            Main.popModal(this.grab);
            this.grab = null;
        }
        this.actor.destroy();
        this.content = null;
        this._cleanFiles();
        this.extension.overlay = null;
    }

    destroy() {
        if (this.worker)
            this.worker.force_exit();
        this.busy = false;
        this.close();
    }
}
