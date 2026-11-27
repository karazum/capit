// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DemoCursor} from './cursor.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'load_bytes_async');

/**
 * Keeps every window composited, or lets Mutter stop compositing fullscreen ones again. On X11 Mutter stops
 * compositing a fullscreen window, and GNOME's screencast then repeats the last frame of it that was composited.
 * GNOME 48 moved the calls from Meta to the compositor.
 * @param {boolean} hold
 */
function holdComposited(hold) {
    const {compositor, display} = global;
    if (compositor.disable_unredirect && hold)
        compositor.disable_unredirect();
    else if (compositor.disable_unredirect)
        compositor.enable_unredirect();
    else if (hold)
        Meta.disable_unredirect_for_display(display);
    else
        Meta.enable_unredirect_for_display(display);
}

const SCREENCAST = 'org.gnome.Shell.Screencast';
const SCREENCAST_PATH = '/org/gnome/Shell/Screencast';
// GStreamer encoders for the lossless recording a GIF or video is made from, best first, with the container's
// extension.
// GNOME's screencast service runs them between `pipewiresrc ! capsfilter max-framerate=…` and a filesink, and
// replaces %T with its thread count. Quantizer 0 makes x264 lossless, and ultrafast keeps its CPU cost low while
// recording. x264enc comes from gst-plugins-ugly, which not every system has, so PNG frames follow: exact colours
// at a similar CPU cost, but about 15 times the size. A missing element fails the service's AllPipelinesFailed
// check before anything is recorded.
// The service answers ScreencastArea only once the first encoded bytes reach the file, and the screen sends frames
// only when something on it changes. x264's default frame threading holds back about 1.5 frames per CPU core
// before it writes any, which on a still screen delayed the start by seconds; zerolatency threads within each
// frame instead, at the same speed.
const INTERMEDIATES = [
    ['videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=%T ! video/x-raw,format=Y444 ! ' +
        'queue ! x264enc pass=quant quantizer=0 speed-preset=ultrafast tune=zerolatency ! queue ! matroskamux', 'mkv'],
    ['videoconvert n-threads=%T ! video/x-raw,format=RGB ! queue ! pngenc compression-level=1 ! queue ! qtmux', 'mov'],
];
// Index into INTERMEDIATES of the encoder that last started, so later recordings skip the ones that are missing.
let workingIntermediate = 0;
// Logical pixels between the recorded area and its frame, so a frame edge rounded at fractional scales stays out.
const FRAME_GAP = 2;
const FRAME_WIDTH = 3;

// Clipboard data larger than this goes on the clipboard as a file even when content is chosen: Shell keeps the
// bytes in its own memory for as long as they stay on the clipboard.
const CONTENT_LIMIT = 100 * 1024 * 1024;
const CONTENT_TYPES = {'.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4'};

// Puts the file at `path` on the clipboard as a file, like a file manager's Copy. Applications that accept pasted files, such as chat applications and browsers, get the whole animation;
// GIF image data is usually pasted as a still picture or not at all. Only one type can be offered: St.Clipboard
// takes one, and GJS cannot implement the callback-taking read function of a Mutter selection source that would
// offer the file and its data together.
function copyFile(path) {
    const uri = Gio.File.new_for_path(path).get_uri();
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list',
        new GLib.Bytes(new TextEncoder().encode(`${uri}\r\n`)));
}

// What a copy puts on the clipboard: copy-only always copies the capture's content, and copy-and-save follows the
// clipboard-content setting, 'file' or 'content'. saving: whether the same action also saves the capture.
export function clipboardKind(settings, saving) {
    return saving ? settings.get_string('clipboard-content') : 'content';
}

/**
 * Puts the capture at `path` on the clipboard as `kind` asks: 'file' for a file reference, 'content' for its PNG,
 * GIF or MP4 data. Returns what was copied; content over CONTENT_LIMIT is copied as a file instead.
 */
export async function copyCapture(path, kind) {
    const type = CONTENT_TYPES[path.slice(path.lastIndexOf('.'))];
    const file = Gio.File.new_for_path(path);
    if (kind === 'content' && type &&
        file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() <= CONTENT_LIMIT) {
        const [bytes] = await file.load_bytes_async(null);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, type, bytes);
        return 'content';
    }
    copyFile(path);
    return 'file';
}

function screencast(method, parameters, replyType) {
    return Gio.DBus.session.call(SCREENCAST, SCREENCAST_PATH, SCREENCAST, method, parameters,
        replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE, -1, null);
}

// The service's errors arrive as D-Bus errors named org.gnome.Shell.Screencast.Error.<Name>.
function screencastError(error, name) {
    if (!(error instanceof GLib.Error))
        return false;
    return Gio.DBusError.get_remote_error(error)?.endsWith(`.${name}`) || error.message.includes(name);
}

function friendlyError(error) {
    if (screencastError(error, 'AlreadyRecording'))
        return new Error('GNOME is already recording the screen; stop that recording first');
    if (screencastError(error, 'SaveToDiskDisabled'))
        return new Error('Saving recordings is disabled by the system administrator');
    if (screencastError(error, 'AllPipelinesFailed'))
        return new Error('No lossless GStreamer encoder is available; install gstreamer1.0-plugins-ugly');
    if (error instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(error);
    return error;
}

/**
 * One GIF or video recording of a screen area, from starting GNOME's screencast to the finished file on the
 * clipboard and on disk. `state` goes 'starting' → 'recording' → 'stopping' → 'encoding' → 'done'; a failure or
 * cancellation also ends in 'done'.
 *
 * The area is recorded losslessly by GNOME's screencast service, which is also what GNOME's own recorder uses, at
 * the GIF or video frame rate and with the pointer drawn in if enabled. On stop, encoder.js makes the GIF from one
 * palette for the whole recording, or the MP4 with x264. Stopping, cancelling and destroying all remove the
 * recording's files, except that a recording that could not be encoded is kept and its path reported.
 */
export class Recording {
    // kind: 'gif' or 'video'; rect: logical stage pixels {x, y, width, height}; settings: the extension's
    // Gio.Settings; path: the extension directory, for encoder.js; timing: the Timing that stopping and encoding
    // continue; onChange: called after every state change and once a second while recording.
    constructor({kind, rect, settings, path, timing, onChange}) {
        this.timing = timing;
        this.kind = kind;
        // Settings of this kind of recording are named gif-… or video-….
        this.prefix = kind === 'gif' ? 'gif' : 'video';
        this.rect = {x: Math.floor(rect.x), y: Math.floor(rect.y)};
        this.rect.width = Math.ceil(rect.x + rect.width) - this.rect.x;
        this.rect.height = Math.ceil(rect.y + rect.height) - this.rect.y;
        this.settings = settings;
        this.path = path;
        this.onChange = onChange;
        this.state = 'starting';
        this.started = null;
        this.source = null;
        this.worker = null;
        this.frame = [];
        this.demoCursor = null;
        this.composited = false;
        this.tick = 0;
        this.limit = 0;
        this.errorSignal = 0;
        this.workdir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'capit', `recording-${GLib.uuid_string_random()}`]);
    }

    // Seconds recorded so far.
    get elapsed() {
        return this.started === null ? 0 : Math.floor((GLib.get_monotonic_time() - this.started) / 1_000_000);
    }

    _setState(state) {
        this.state = state;
        this.onChange();
    }

    async start() {
        if (!GLib.find_program_in_path('ffmpeg'))
            throw new Error('Recording needs FFmpeg; install the ffmpeg package');
        GLib.mkdir_with_parents(this.workdir, 0o700);
        // Wayland screencasts already capture fullscreen windows; GNOME 50 has no X11 session and no such check.
        if (Meta.is_wayland_compositor?.() === false) {
            holdComposited(true);
            this.composited = true;
        }
        // Shown before the screencast starts, so the first frames already have it.
        if (this.settings.get_boolean('recording-demo-cursor'))
            this.demoCursor = new DemoCursor(this.settings.get_int(`${this.prefix}-fps`));
        const options = {
            framerate: GLib.Variant.new_int32(this.settings.get_int(`${this.prefix}-fps`)),
            'draw-cursor': GLib.Variant.new_boolean(this.settings.get_boolean('recording-show-cursor')),
        };
        this.errorSignal = Gio.DBus.session.signal_subscribe(SCREENCAST, SCREENCAST, 'Error', SCREENCAST_PATH, null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _signal, parameters) => {
                const [, message] = parameters.deepUnpack();
                if (['recording', 'stopping'].includes(this.state))
                    this._fail(new Error(`GNOME's screen recorder stopped: ${message}`), true);
            });
        const {x, y, width, height} = this.rect;
        let retried = false;
        for (let index = workingIntermediate; ; index++) {
            const [pipeline, extension] = INTERMEDIATES[index];
            try {
                const reply = await screencast('ScreencastArea', new GLib.Variant('(iiiisa{sv})',
                    [x, y, width, height, `${this.workdir}/capture`, {...options, pipeline: GLib.Variant.new_string(pipeline)}]),
                '(bs)');
                [, this.source] = reply.deepUnpack();
                this.container = extension;
                workingIntermediate = index;
                break;
            } catch (error) {
                if (this.state === 'starting' && screencastError(error, 'AllPipelinesFailed') &&
                    index < INTERMEDIATES.length - 1)
                    continue;
                // The service quits two seconds after its last recording. A call that reaches it as it exits gets
                // no reply; asking again starts a new instance.
                if (this.state === 'starting' && !retried && error instanceof GLib.Error &&
                    error.matches(Gio.DBusError, Gio.DBusError.NO_REPLY)) {
                    retried = true;
                    index--;
                    continue;
                }
                this._cleanup();
                // A cancelled start has nothing left to report.
                if (this.state !== 'starting')
                    return;
                this._setState('done');
                throw friendlyError(error);
            }
        }
        // Cancelled or disabled while GNOME was still starting the recording.
        if (this.state !== 'starting') {
            screencast('StopScreencast', null, '(b)').catch(() => {}).finally(() => this._cleanup());
            return;
        }
        this.started = GLib.get_monotonic_time();
        this._showFrame();
        this.tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this.onChange();
            return GLib.SOURCE_CONTINUE;
        });
        const limit = this.settings.get_int(`${this.prefix}-max-duration`);
        if (limit > 0) {
            this.limit = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, limit, () => {
                this.limit = 0;
                this.stop();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._setState('recording');
    }

    // Turns the demo cursor on or off, for this recording if it is running and for later ones.
    setDemoCursor(on) {
        this.settings.set_boolean('recording-demo-cursor', on);
        if (this.state !== 'recording')
            return;
        if (on && !this.demoCursor) {
            this.demoCursor = new DemoCursor(this.settings.get_int(`${this.prefix}-fps`));
        } else if (!on && this.demoCursor) {
            this.demoCursor.destroy();
            this.demoCursor = null;
        }
    }

    // A red frame just outside the recorded area, so it is never part of the recording.
    _showFrame() {
        const {x, y, width, height} = this.rect;
        const outer = FRAME_GAP + FRAME_WIDTH;
        const pieces = [
            [x - outer, y - outer, width + 2 * outer, FRAME_WIDTH],
            [x - outer, y + height + FRAME_GAP, width + 2 * outer, FRAME_WIDTH],
            [x - outer, y - FRAME_GAP, FRAME_WIDTH, height + 2 * FRAME_GAP],
            [x + width + FRAME_GAP, y - FRAME_GAP, FRAME_WIDTH, height + 2 * FRAME_GAP],
        ];
        for (const [left, top, w, h] of pieces) {
            const piece = new St.Widget({
                style_class: 'capit-recording-frame', reactive: false,
                x: left, y: top, width: w, height: h,
            });
            Main.uiGroup.add_child(piece);
            this.frame.push(piece);
        }
    }

    _releaseComposited() {
        if (this.composited) {
            holdComposited(false);
            this.composited = false;
        }
    }

    _hideFrame() {
        this._releaseComposited();
        this.frame.forEach(piece => piece.destroy());
        this.frame = [];
        this.demoCursor?.destroy();
        this.demoCursor = null;
        for (const id of [this.tick, this.limit]) {
            if (id)
                GLib.source_remove(id);
        }
        this.tick = this.limit = 0;
    }

    // Ends the recording and makes the GIF or video. Stopping while GNOME is still starting the recording
    // cancels it.
    async stop() {
        if (this.state === 'starting') {
            this.cancel();
            return;
        }
        if (this.state !== 'recording')
            return;
        this._hideFrame();
        this._setState('stopping');
        this.timing.mark('recorded', `${this.elapsed} s`);
        let keep = false;
        try {
            await screencast('StopScreencast', null, '(b)');
            this.timing.mark('screencast stopped');
            if (this.state !== 'stopping')
                return;
            // The service names the file after a pipeline extension it has none of for a custom pipeline.
            const source = `${this.workdir}/recording.${this.container}`;
            Gio.File.new_for_path(this.source).move(Gio.File.new_for_path(source), Gio.FileCopyFlags.NONE, null, null);
            this.source = source;
            this._setState('encoding');
            keep = true;
            const output = this.settings.get_string('recording-output');
            const copy = output !== 'save';
            const encoding = this.kind === 'gif' ? {
                dither: this.settings.get_string('gif-dither'),
                bayerScale: this.settings.get_int('gif-bayer-scale'),
                statsMode: this.settings.get_string('gif-stats-mode'),
            } : {
                fps: this.settings.get_int('video-fps'),
                crf: this.settings.get_int('video-crf'),
                preset: this.settings.get_string('video-preset'),
            };
            const response = await this._encode({
                kind: this.kind, source, workdir: this.workdir, ...encoding,
                save: output !== 'copy', directory: outputDirectory(this.settings),
                copy, clipboardDirectory: clipboardDirectory(),
            });
            keep = false;
            this.timing.mark('encoded', `${(response.bytes / 1_048_576).toFixed(1)} MB`);
            if (this.state !== 'encoding')
                return;
            const messages = [];
            if (response.savedPath)
                messages.push(`Saved ${response.savedPath}`);
            else if (response.saveError)
                messages.push(`Not saved: ${response.saveError}`);
            // A lasting file even when content is copied: content too large to copy falls back to the file.
            const shared = response.savedPath ?? response.clipboardPath;
            if (copy && shared) {
                try {
                    const copied = await copyCapture(shared, clipboardKind(this.settings, output === 'both'));
                    this.timing.mark('copied', copied);
                    if (this.state !== 'encoding')
                        return;
                    messages.push(copied === 'file' ? 'Copied as a file' : 'Copied to the clipboard');
                } catch (error) {
                    messages.push(`Not copied: ${error.message}`);
                }
            } else if (copy) {
                messages.push(`Not copied: ${response.copyError ?? 'no file to copy'}`);
            }
            this.result = {...response, messages};
            const size = `${(response.bytes / 1_048_576).toFixed(1)} MB ${this.kind === 'gif' ? 'GIF' : 'video'}`;
            if (messages.some(message => message.startsWith('Not ')))
                Main.notifyError('CapIt recording', `${size}. ${messages.join('. ')}`);
            else
                Main.notify('CapIt recording', `${size}. ${messages.join('. ')}`);
        } catch (error) {
            this._fail(friendlyError(error), false, keep);
            keep = this.kept;
            return;
        } finally {
            this.worker = null;
            if (!keep)
                this._cleanup();
        }
        this._setState('done');
    }

    async _encode(request) {
        const process = Gio.Subprocess.new([GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs', '-m',
            `${this.path}/encoder.js`],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this.worker = process;
        const [stdout, stderr] = await process.communicate_utf8_async(JSON.stringify(request), null);
        let response;
        try {
            response = JSON.parse(stdout);
        } catch {
            throw new Error(stderr?.trim() || 'The recording encoder did not return a result');
        }
        if (!process.get_successful() || response.error)
            throw new Error(response.error || stderr?.trim() || 'Encoding the recording failed');
        return response;
    }

    // Reports a failed recording. A recording that was stopped but could not be encoded keeps its lossless file.
    _fail(error, stopScreencast, keepSource = false) {
        if (this.state === 'done')
            return;
        this._hideFrame();
        this._unsubscribe();
        if (stopScreencast)
            screencast('StopScreencast', null, '(b)').catch(() => {});
        this.kept = keepSource && GLib.file_test(this.source ?? '', GLib.FileTest.EXISTS);
        this.result = {error: error.message, kept: this.kept ? this.source : null};
        console.error(`[CapIt] Recording failed: ${error.message}`);
        Main.notifyError('CapIt recording failed',
            this.kept ? `${error.message}. The recording is kept at ${this.source}` : error.message);
        if (!this.kept)
            this._cleanup();
        this._setState('done');
    }

    // Abandons the recording without making a file.
    cancel() {
        if (this.state === 'done')
            return;
        const recording = ['recording', 'stopping'].includes(this.state);
        this._hideFrame();
        this.worker?.force_exit();
        this.worker = null;
        this.result = {cancelled: true};
        if (recording)
            screencast('StopScreencast', null, '(b)').catch(() => {}).finally(() => this._cleanup());
        else if (this.state !== 'starting')
            this._cleanup();
        this._setState('done');
    }

    destroy() {
        this.onChange = () => {};
        this.cancel();
    }

    _unsubscribe() {
        if (this.errorSignal) {
            Gio.DBus.session.signal_unsubscribe(this.errorSignal);
            this.errorSignal = 0;
        }
    }

    _cleanup() {
        // A start GNOME's recorder refused ends here without hiding a frame.
        this._releaseComposited();
        this._unsubscribe();
        this.demoCursor?.destroy();
        this.demoCursor = null;
        const directory = Gio.File.new_for_path(this.workdir);
        try {
            for (const info of directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null))
                directory.get_child(info.get_name()).delete(null);
            directory.delete(null);
        } catch { /* Never created, or already removed. */ }
    }
}

// Where a capture copied as a file but not saved is kept, for example /home/user/.cache/capit/clipboard.
export function clipboardDirectory() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'capit', 'clipboard']);
}

// The folder captures and recordings are saved in, for example /home/user/Pictures/CapIt.
export function outputDirectory(settings) {
    return settings.get_string('output-directory') ||
        GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
            GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']), 'CapIt']);
}
