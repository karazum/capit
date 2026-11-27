// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * CapIt recording worker, run as `gjs -m encoder.js`. Turns a lossless screen recording into a GIF or an MP4 video
 * with FFmpeg. No desktop access is needed.
 *
 * One JSON request arrives on stdin: {kind: 'gif' or 'video', source, workdir, save, directory, copy,
 * clipboardDirectory}, plus {dither, bayerScale, statsMode} for a GIF or {fps, crf, preset} for a video. The answer
 * is {output, bytes}, plus {savedPath} or {saveError} when `save` is set, and {clipboardPath} or {copyError} when
 * `copy` is set and nothing was saved. A failure answers {error} and exits with status 1.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {clipboardCopy, publish, readRequest, restrict} from './worker.js';

const DITHERS = ['none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'sierra3', 'burkes',
    'atkinson'];
const STATS_MODES = ['full', 'diff', 'single'];
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const MAX_REQUEST_BYTES = 100_000;

function integer(value, name, low, high) {
    if (!Number.isInteger(value) || value < low || value > high)
        throw new Error(`Invalid ${name}`);
    return value;
}

/**
 * The validated GIF options of a request.
 * @returns {{dither: string, bayerScale: number, statsMode: string}} for example
 *     {dither: 'sierra2_4a', bayerScale: 2, statsMode: 'full'}
 */
export function options(request) {
    const dither = request.dither ?? 'sierra2_4a';
    if (!DITHERS.includes(dither))
        throw new Error('Invalid dither');
    const statsMode = request.statsMode ?? 'full';
    if (!STATS_MODES.includes(statsMode))
        throw new Error('Invalid palette statistics mode');
    return {dither, bayerScale: integer(request.bayerScale ?? 2, 'Bayer scale', 0, 5), statsMode};
}

/** The paletteuse filter for `options()`, for example 'paletteuse=dither=bayer:bayer_scale=2'. */
export function paletteuse(settings) {
    let text = `paletteuse=dither=${settings.dither}`;
    if (settings.dither === 'bayer')
        text += `:bayer_scale=${settings.bayerScale}`;
    // A palette per frame: paletteuse must switch to each new one instead of keeping the first.
    if (settings.statsMode === 'single')
        text += ':new=1';
    return text;
}

/**
 * FFmpeg runs that encode `source` into `output`, as a list of argument lists.
 *
 * The obvious single command, `palettegen=stats_mode=…[palette],[0:v][palette]paletteuse=…`, holds every decoded
 * frame in memory until the last one arrives, because a whole-recording palette is only known then. Writing the
 * palette to `palette` first and reading the recording a second time produces the same GIF in bounded memory. Per-frame palettes ('single') are available frame by frame, so that mode stays one pass.
 * @returns {string[][]}
 */
export function commands(ffmpeg, source, palette, output, settings) {
    const quiet = [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
    if (settings.statsMode === 'single') {
        const graph = `split[frames][stats];[stats]palettegen=stats_mode=single[palette];[frames][palette]${paletteuse(settings)}`;
        return [[...quiet, '-i', source, '-lavfi', graph, output]];
    }
    return [
        [...quiet, '-i', source, '-vf', `palettegen=stats_mode=${settings.statsMode}`,
            '-frames:v', '1', '-update', '1', palette],
        [...quiet, '-i', source, '-i', palette, '-lavfi', `[0:v][1:v]${paletteuse(settings)}`, output],
    ];
}

/**
 * The validated video options of a request.
 * @returns {{fps: number, crf: number, preset: string}} for example {fps: 30, crf: 28, preset: 'ultrafast'}
 */
export function videoOptions(request) {
    const preset = request.preset ?? 'ultrafast';
    if (!PRESETS.includes(preset))
        throw new Error('Invalid x264 preset');
    return {
        fps: integer(request.fps ?? 30, 'frame rate', 1, 120), crf: integer(request.crf ?? 28, 'quality', 0, 51),
        preset,
    };
}

/**
 * The FFmpeg run that encodes `source` into an MP4 at `output` with libx264. `+faststart` puts the index first, so
 * playback can start before a download ends.
 *
 * yuv420p, which browsers need, stores colour for 2x2 pixel blocks, so x264 rejects odd sizes. The encode drops the
 * last column or row, because GNOME's screencast service cannot be given an even-sized area at fractional scales.
 * @returns {string[]}
 */
export function videoCommand(ffmpeg, source, output, settings) {
    return [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', source,
        '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0', '-c:v', 'libx264', '-r', String(settings.fps),
        '-preset', settings.preset, '-crf', String(settings.crf), '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', output];
}

// Runs one FFmpeg command to its end and throws with FFmpeg's last error line when it fails.
function run(command) {
    // Shell kills this worker when a recording is cancelled mid-encode, and FFmpeg must not keep running on its own.
    // GJS cannot run code in the child between fork and exec, so setpriv sets the parent-death signal before it
    // starts FFmpeg.
    const setpriv = GLib.find_program_in_path('setpriv');
    const argv = setpriv ? [setpriv, '--pdeathsig', 'KILL', '--', ...command] : command;
    const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, , stderr] = process.communicate_utf8(null, null);
    if (!process.get_successful()) {
        const lines = (stderr ?? '').trim().split('\n').filter(line => line);
        const status = process.get_if_exited() ? process.get_exit_status() : `signal ${process.get_term_sig()}`;
        throw new Error(`FFmpeg failed: ${lines.at(-1) ?? `exit status ${status}`}`);
    }
}

/**
 * Encodes the request's recording into its workdir and returns the new file's path.
 * @param {string|null} ffmpeg the FFmpeg program, or null when it is not installed
 * @returns {string} for example '/home/user/.cache/capit/recording-…/recording.gif'
 */
export function encode(request, ffmpeg = GLib.find_program_in_path('ffmpeg')) {
    const kind = request.kind ?? 'gif';
    if (!['gif', 'video'].includes(kind))
        throw new Error('Invalid recording kind');
    if (!ffmpeg)
        throw new Error('Recording needs FFmpeg; install the ffmpeg package');
    const {source, workdir} = request;
    let output, runs;
    if (kind === 'gif') {
        output = GLib.build_filenamev([workdir, 'recording.gif']);
        runs = commands(ffmpeg, source, GLib.build_filenamev([workdir, 'palette.png']), output, options(request));
    } else {
        output = GLib.build_filenamev([workdir, 'recording.mp4']);
        runs = [videoCommand(ffmpeg, source, output, videoOptions(request))];
    }
    runs.forEach(run);
    restrict(output);
    return output;
}

export function execute(request, ffmpeg = GLib.find_program_in_path('ffmpeg')) {
    const path = encode(request, ffmpeg);
    const size = Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    const result = {output: path, bytes: size};
    const extension = path.slice(path.lastIndexOf('.'));
    if (request.save) {
        try {
            result.savedPath = publish(path, request.directory, extension);
        } catch (error) {
            result.saveError = error.message;
        }
    }
    if (request.copy && !result.savedPath) {
        try {
            result.clipboardPath = clipboardCopy(path, request.clipboardDirectory);
        } catch (error) {
            result.copyError = error.message;
        }
    }
    return result;
}

// Run as a program, not when the tests import this module.
if (System.programPath === GLib.filename_from_uri(import.meta.url)[0]) {
    try {
        print(JSON.stringify(execute(readRequest(MAX_REQUEST_BYTES))));
    } catch (error) {
        print(JSON.stringify({error: error.message}));
        System.exit(1);
    }
}
