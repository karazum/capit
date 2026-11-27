// SPDX-License-Identifier: GPL-3.0-or-later
// Smart boxes inside windows, found for the capture overlay by a worker process: detector.js reading each window's
// pixels, or accessibility.js asking the application under the pointer.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {contains, encloses, intersectRect, pixelRect} from './model.js';

// GLib 2.80 (GNOME 46) moved the Unix helpers from GLib into GLibUnix, and warns when the old names are used. GNOME 45
// ships GLib 2.78, which has no GLibUnix.
let setNonBlocking;
try {
    setNonBlocking = (await import('gi://GLibUnix')).default.set_fd_nonblocking;
} catch {
    setNonBlocking = GLib.unix_set_fd_nonblocking;
}

Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

const READBACK_PIXELS = 1_500_000;

/**
 * Writes all of `bytes`, a GLib.Bytes, to a non-blocking stream. Unlike write_all_async with a JS array, each write
 * holds its own reference to the data: a write that waits for room in the pipe outlives the call, and the array
 * could be freed under it, which reached the detector as a corrupt PNG.
 */
async function writeAll(stream, bytes) {
    const size = bytes.get_size();
    for (let offset = 0; offset < size;) {
        const rest = offset ? bytes.new_from_bytes(offset, size - offset) : bytes;
        offset += await stream.write_bytes_async(rest, GLib.PRIORITY_DEFAULT, null);
    }
}

// The element-detection modes that detector.js serves from each window's pixels, and the detector mode each runs:
// the setting's visual mode finds regions, which include the panels between dividers that the detector's own visual
// mode finds.
const IMAGE_DETECTION = new Map([['visual', 'regions']]);

export class ElementDetection {
    // overlay: the CaptureOverlay whose windows are searched; owners: per window candidate, {pid, title, client:
    // [x, y, width, height]}, which the accessibility finder needs to find the window's application.
    constructor(overlay, owners) {
        this.overlay = overlay;
        this.owners = owners;
        // Detected panels of each window candidate, as smaller smart boxes inside it.
        this.panels = new Map();
        // How panels are found: 'none', 'visual' (the frozen image) or 'accessibility' (the application's tree).
        this.detectionMode = overlay.extension.settings.get_string('element-detection');
        // 'pending' until the detector is through every window (visual) or answering (accessibility), then 'ready',
        // 'unavailable' or 'failed'; 'off' in mode 'none'.
        this.detection = this.detectionMode === 'none' ? 'off' : 'pending';
        this.detector = null;
        this.detectorWrites = Promise.resolve();
        this.querying = false;
        this.queryId = 0;
        this.asked = null;
        this.readbacks = [];
        // Detection's progress for the overlay to show, in logical pixels of the screens being read: each screen
        // counts once as its bands are sent and once more when its boxes arrive. area: per candidate index.
        this.progress = {done: 0, total: 0, screens: 0, answered: 0, area: new Map()};
        // Resolves the paused panel read-back once no region is chosen any more.
        this.resumeDetection = null;
    }

    // Starts the detector for the configured mode, once the overlay has been shown.
    start() {
        if (IMAGE_DETECTION.has(this.detectionMode))
            this._detectPanels();
        else if (this.detectionMode === 'accessibility')
            this._startAccessibility();
    }

    // Lets a paused detector finish and stops the running one, as the overlay closes.
    stop() {
        this.resume();
        this.detector?.force_exit();
        this.detector = null;
    }

    resume() {
        const resume = this.resumeDetection;
        this.resumeDetection = null;
        resume?.();
    }

    // Streams the pixels of each candidate, a monitor in the image modes, to the panel detector, and records the
    // panels found. Until a candidate's panels arrive, or when detection is unavailable, its only smart box is itself.
    async _detectPanels() {
        const stage = {x: 0, y: 0, width: this.overlay.actor.width, height: this.overlay.actor.height};
        const windows = [];
        this.overlay.candidates.forEach((window, index) => {
            const visible = intersectRect(window, stage);
            // Skips windows hidden entirely behind a single one above them, such as those under a maximized window.
            if (visible && visible.width >= 64 && visible.height >= 64 &&
                !this.overlay.candidates.slice(0, index).some(above => encloses(above, visible)))
                windows.push([index, visible]);
        });
        for (const [index, visible] of windows.slice(0, 12))
            this.progress.area.set(index, visible.width * visible.height);
        this.progress.total = 2 * [...this.progress.area.values()].reduce((sum, area) => sum + area, 0);
        this.progress.screens = this.progress.area.size;
        this._reportProgress();
        let reading = null;
        let input = null;
        this.overlay.timing.mark('detection start', `${this.detectionMode}, ${Math.min(windows.length, 12)} windows`);
        try {
            const process = Gio.Subprocess.new([GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs', '-m',
                `${this.overlay.extension.path}/detector.js`, '--mode', IMAGE_DETECTION.get(this.detectionMode)],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this.detector = process;
            this.overlay.timing.mark('detector started');
            // On GNOME 46, GJS warns once that these pipes' classes moved to GioUnix. Shell loads Gio before GioUnix,
            // so the pipes resolve to Gio's old names whatever an extension imports; GJS 1.82 stopped warning.
            reading = this._readPanels(process);
            input = process.get_stdin_pipe();
            // A pipe is blocking by default, and a write the detector is too busy to take then blocks Shell's thread
            // however it is called: GLib's asynchronous write writes once the pipe has any room, and write() waits until
            // the whole band fits. Held up by the detector working on the window before, that froze frames for ~300 ms.
            setNonBlocking(input.get_fd(), true);
            const texture = this.overlay.content.get_texture();
            for (const [index, visible] of windows.slice(0, 12)) {
                // While a region is chosen no smart boxes show, so reading pixels back waits until an undo clears it.
                while (this.overlay.document.selection && !this.overlay.closed) {
                    await new Promise(resolve => {
                        this.resumeDetection = resolve;
                    });
                }
                if (this.overlay.closed || this.detection !== 'pending')
                    break;
                const rect = pixelRect(visible, this.overlay.scale, texture.get_width(), texture.get_height());
                // Shell reads pixels back from the GPU on its main thread: an IDE-sized window in one piece held up
                // frames for ~75 ms at 1.25x. Bands of READBACK_PIXELS stay within a frame, and frames paint between them.
                const rows = Math.max(1, Math.floor(READBACK_PIXELS / rect.width));
                const parts = Math.ceil(rect.height / rows);
                // Microseconds spent reading pixels back on Shell's thread, waiting for the PNG encode, and writing.
                const spent = {readback: 0, encode: 0, write: 0};
                for (let part = 0; part < parts; part++) {
                    const y = rect.y + part * rows;
                    const height = Math.min(rows, rect.y + rect.height - y);
                    const png = Gio.MemoryOutputStream.new_resizable();
                    const started = GLib.get_monotonic_time();
                    const encoded = Shell.Screenshot.composite_to_stream(texture, rect.x, y, rect.width, height,
                        this.overlay.scale, null, 0, 0, 1, png);
                    const readBack = GLib.get_monotonic_time();
                    this.readbacks.push([rect.width, height, (readBack - started) / 1000]);
                    await encoded;
                    const encodedAt = GLib.get_monotonic_time();
                    spent.readback += readBack - started;
                    spent.encode += encodedAt - readBack;
                    png.close(null);
                    if (this.overlay.closed || this.detection !== 'pending')
                        return;
                    const bytes = png.steal_as_bytes();
                    const header = {
                        index, origin: [rect.x, rect.y], scale: this.overlay.scale, part, parts,
                        length: bytes.get_size(),
                    };
                    await writeAll(input, new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(header)}\n`)));
                    await writeAll(input, bytes);
                    spent.write += GLib.get_monotonic_time() - encodedAt;
                    this.progress.done += this.progress.area.get(index) * height / rect.height;
                    this._reportProgress();
                }
                this.overlay.timing.mark(`window ${index} sent`, `${rect.width}x${rect.height} px in ${parts} bands · ${
                    Object.entries(spent).map(([name, time]) => `${name} ${(time / 1000).toFixed(1)} ms`).join(', ')}`);
            }
        } catch (error) {
            // A detector that exited early closes its input, and why it exited arrives on its output instead.
            if (!this.overlay.closed && this.detection === 'pending')
                console.warn(`[CapIt] Panel detection stopped: ${error.message}`);
            if (!reading && !this.overlay.closed) {
                this.detection = 'failed';
                this.overlay.showProgress(null);
            }
        } finally {
            // Without end of input the detector would wait for another frame, and detection would stay pending.
            try {
                input?.close(null);
            } catch { /* Already closed by an exited detector. */ }
        }
        await reading;
    }

    async _readPanels(process) {
        const lines = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), close_base_stream: true});
        try {
            for (;;) {
                const [line] = await lines.read_line_async(GLib.PRIORITY_DEFAULT, null);
                if (line === null || this.overlay.closed)
                    break;
                // GLib 2.80 gives the line as a string; newer versions as bytes.
                const result = JSON.parse(typeof line === 'string' ? line : new TextDecoder().decode(line));
                if (result.unavailable || result.error) {
                    this.detection = result.unavailable ? 'unavailable' : 'failed';
                    console.warn(`[CapIt] Panel detection ${this.detection}: ${result.unavailable ?? result.error}`);
                    break;
                }
                if (result.ready) {
                    this.detection = 'ready';
                    this.overlay.timing.mark('accessibility ready');
                } else if ('id' in result) {
                    // Hover answers add to what earlier ones found: each is only the chain of boxes around one point.
                    this._addPanels(result.index, result.elements, true);
                    this.querying = false;
                    this.overlay.timing.mark(`hover answer ${result.id}`, `${result.elements?.length ?? 0} boxes`);
                } else {
                    this._addPanels(result.index, result.elements);
                    this.progress.done += this.progress.area.get(result.index) ?? 0;
                    this.progress.answered++;
                    this._reportProgress();
                    this.overlay.timing.mark(`window ${result.index} detected`, `${result.elements?.length ?? 0} boxes`);
                }
                this.queryElements();
            }
        } catch (error) {
            if (!this.overlay.closed) {
                this.detection = 'failed';
                console.warn(`[CapIt] Panel detection failed: ${error.message}`);
            }
        }
        // An image detector is done once it has answered for every window; the accessibility finder is answering
        // as long as it runs, so its output ending before it was ready means it failed.
        if (this.detection === 'pending')
            this.detection = IMAGE_DETECTION.has(this.detectionMode) ? 'ready' : 'failed';
        this.overlay.timing.mark('detection finished', this.detection);
        this.overlay.showProgress(null);
        if (this.detector === process)
            this.detector = null;
    }

    // rects: [[x, y, width, height], ...] in stage logical coordinates.
    _addPanels(index, rects, merge = false) {
        const window = this.overlay.candidates[index];
        const visible = window && intersectRect(window, {x: 0, y: 0, width: this.overlay.actor.width, height: this.overlay.actor.height});
        if (!visible || !Array.isArray(rects))
            return;
        const key = rect => [rect.x, rect.y, rect.width, rect.height].map(value => value.toFixed(1)).join();
        // Existing objects are kept, as hover compares boxes by identity.
        const boxes = new Map(merge ? (this.panels.get(window) ?? []).map(box => [key(box), box]) : []);
        for (const [x, y, width, height] of rects) {
            const box = intersectRect({x, y, width, height}, visible);
            // A box covering the whole window repeats the window's own box, an extra scroll step that changes nothing.
            if (box && !encloses(box, visible) && !boxes.has(key(box)))
                boxes.set(key(box), box);
        }
        this.panels.set(window, [...boxes.values()]);
        if (this.overlay.pointer && !this.overlay.gesture && !this.overlay.document.selection)
            this.overlay._setHover(this.overlay._boxAt(this.overlay.pointer));
        this.overlay._layoutRegions();
    }

    // Passes how far image detection is to the overlay; nothing while there are no screens to read.
    _reportProgress() {
        const {done, total, screens, answered} = this.progress;
        if (total)
            this.overlay.showProgress({fraction: Math.min(1, done / total), done: answered, total: screens});
    }

    // Starts the accessibility finder, which is then asked about each new pointer position.
    _startAccessibility() {
        try {
            const process = Gio.Subprocess.new([GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs', '-m',
                `${this.overlay.extension.path}/accessibility.js`],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this.detector = process;
            this.overlay.timing.mark('accessibility finder started', `${this.owners.length} windows`);
            this._writeDetector({windows: this.owners.map((owner, index) => ({index, ...owner}))});
            this._readPanels(process);
        } catch (error) {
            this.detection = 'failed';
            console.warn(`[CapIt] Accessibility element finder failed: ${error.message}`);
        }
    }

    _writeDetector(message) {
        const input = this.detector?.get_stdin_pipe();
        if (!input)
            return;
        const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
        // Chained, since a stream refuses a write while another is still pending.
        this.detectorWrites = this.detectorWrites
            .then(() => input.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null))
            .catch(error => {
                if (!this.overlay.closed)
                    console.warn(`[CapIt] Accessibility element finder stopped: ${error.message}`);
            });
    }

    // Asks the accessibility finder about the latest pointer position. One question at a time: a slow application
    // then delays answers rather than piling up questions about positions the pointer has already left.
    queryElements() {
        const point = this.overlay.pointer;
        if (this.detectionMode !== 'accessibility' || this.detection !== 'ready' || this.querying || !point ||
            this.overlay.document.selection || (this.asked?.x === point.x && this.asked?.y === point.y))
            return;
        const index = this.overlay.candidates.findIndex(candidate => contains(candidate, point));
        if (index < 0)
            return;
        this.asked = point;
        this.querying = true;
        this.overlay.timing.mark(`hover question ${this.queryId + 1}`);
        this._writeDetector({id: ++this.queryId, index, x: point.x, y: point.y});
    }
}
