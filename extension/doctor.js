// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What CapIt needs from the system, and whether this computer has it, for the preferences window and
 * `capit doctor`. Run as `gjs -m doctor.js` it prints one line per program and GStreamer element, then whether
 * recording works.
 */
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import System from 'system';

// Programs CapIt starts, with the package that provides each on Ubuntu.
const PROGRAMS = [
    {name: 'gjs', package: 'gjs', purpose: 'export, element detection and encoding'},
    {name: 'ffmpeg', package: 'ffmpeg', purpose: 'GIF and MP4 encoding'},
    {name: 'setpriv', package: 'util-linux', purpose: 'stopping FFmpeg when an encode is cancelled'},
];

// GStreamer elements GNOME's screencast service runs for CapIt's lossless recording.
const ELEMENTS = [
    {name: 'pipewiresrc', package: 'gstreamer1.0-pipewire', purpose: 'the screen stream'},
    {name: 'videoconvert', package: 'gstreamer1.0-plugins-base', purpose: 'converting the stream'},
    {name: 'x264enc', package: 'gstreamer1.0-plugins-ugly', purpose: 'the compact lossless recording'},
    {name: 'matroskamux', package: 'gstreamer1.0-plugins-good', purpose: 'the compact lossless recording'},
    {name: 'pngenc', package: 'gstreamer1.0-plugins-good', purpose: 'the PNG-frame recording used without x264'},
    {name: 'qtmux', package: 'gstreamer1.0-plugins-good', purpose: 'the PNG-frame recording used without x264'},
];

function findElement(name) {
    if (!Gst.is_initialized())
        Gst.init(null);
    return Gst.ElementFactory.find(name)?.get_plugin()?.get_filename() ?? null;
}

/**
 * Looks up every program and GStreamer element CapIt uses. The lookups can be replaced for tests.
 * @param {{findProgram: function(string): ?string, findElement: function(string): ?string}} lookups
 * @returns {{checks: Array<{kind: string, name: string, package: string, purpose: string, found: ?string}>,
 *     recording: {ready: boolean, reason: ?string, note: ?string}}} found is the program or plugin path, or null;
 *     reason says why recording cannot work, note what it lacks that it can do without
 */
export function checkDependencies({findProgram = GLib.find_program_in_path, findElement: element = findElement} = {}) {
    const checks = [
        ...PROGRAMS.map(program => ({kind: 'program', ...program, found: findProgram(program.name)})),
        ...ELEMENTS.map(item => ({kind: 'element', ...item, found: element(item.name)})),
    ];
    const has = name => Boolean(checks.find(check => check.name === name).found);
    const missing = names => [...new Set(names.filter(name => !has(name))
        .map(name => checks.find(check => check.name === name).package))];
    let reason = null;
    const needed = missing(['gjs', 'ffmpeg', 'pipewiresrc', 'videoconvert']);
    if (needed.length)
        reason = `Recording needs ${needed.join(', ')}`;
    else if (!(has('x264enc') && has('matroskamux')) && !(has('pngenc') && has('qtmux')))
        reason = `Recording needs ${missing(['pngenc', 'qtmux', 'matroskamux']).join(', ')}`;
    let note = null;
    if (!reason && !has('x264enc'))
        note = 'Without gstreamer1.0-plugins-ugly, recordings are made from PNG frames and take much more disk space';
    else if (!reason && !has('setpriv'))
        note = 'Without setpriv, a cancelled encode lets FFmpeg finish in the background';
    return {checks, recording: {ready: !reason, reason, note}};
}

// Run as a program, not when the preferences or the tests import this module.
if (System.programPath === GLib.filename_from_uri(import.meta.url)[0]) {
    // The version of this copy, which a bug report needs and which `gnome-extensions info` doesn't show: its
    // Version is the number extensions.gnome.org gives each upload.
    try {
        const metadata = GLib.build_filenamev([GLib.path_get_dirname(System.programPath), 'metadata.json']);
        const {'version-name': version} = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(metadata)[1]));
        print(`CapIt version: ${version ?? 'unknown'}`);
    } catch {
        print('CapIt version: unknown, metadata.json is unreadable');
    }
    const {checks, recording} = checkDependencies();
    for (const check of checks) {
        const where = check.found ?? `missing, install ${check.package}`;
        print(`${check.name}: ${where} (${check.purpose})`);
    }
    print(`Recording: ${recording.ready ? 'available' : `unavailable. ${recording.reason}`}`);
    if (recording.note)
        print(`Note: ${recording.note}`);
}
