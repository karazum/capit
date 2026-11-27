// SPDX-License-Identifier: GPL-3.0-or-later
// Reading the request and saving files, shared by the `gjs -m` workers that answer one JSON request each.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// GLib 2.80 (GNOME 46) moved the Unix streams from Gio into GioUnix, and warns when the old names are used. GNOME 45
// ships GLib 2.78, which has no GioUnix.
let Unix;
try {
    Unix = (await import('gi://GioUnix')).default;
} catch {
    Unix = {InputStream: Gio.UnixInputStream, OutputStream: Gio.UnixOutputStream};
}

/** A stream reading this process's stdin. @returns {Gio.InputStream} */
export function stdin() {
    return new Unix.InputStream({fd: 0, close_fd: false});
}

/** A stream writing this process's stdout. @returns {Gio.OutputStream} */
export function stdout() {
    return new Unix.OutputStream({fd: 1, close_fd: false});
}

/** Makes the file at `path` readable and writable by its owner only. */
export function restrict(path) {
    // GLib.chmod is only introspectable from GLib 2.80 on.
    Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
}

/**
 * Reads stdin to its end and parses it as JSON, refusing more than `limit` bytes.
 * @param {number} limit for example 5_000_000
 * @returns {object} the request
 */
export function readRequest(limit) {
    const input = stdin();
    const chunks = [];
    let size = 0;
    for (;;) {
        const chunk = input.read_bytes(65536, null).toArray();
        if (chunk.length === 0)
            break;
        size += chunk.length;
        if (size > limit)
            throw new Error('The request is too large');
        chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Copies `artifact` into `directory` as CapIt_<timestamp><extension>, for example '.png', and returns its path.
 * A name already taken gets a numbered suffix and is never overwritten, even by another CapIt process saving in
 * the same second. The copy is written whole to a hidden file first and renamed onto a name reserved by creating
 * it empty, so the final name shows either nothing, that empty file for an instant, or the complete capture.
 */
export function publish(artifact, directory, extension) {
    const folder = directory.startsWith('~') ? GLib.get_home_dir() + directory.slice(1) : directory;
    if (!GLib.path_is_absolute(folder))
        throw new Error('The output folder must be an absolute path');
    if (GLib.mkdir_with_parents(folder, 0o700) !== 0)
        throw new Error(`Could not create ${folder}`);
    const hidden = Gio.File.new_for_path(GLib.build_filenamev([folder, `.capit-${GLib.uuid_string_random()}`]));
    try {
        const stream = hidden.create(Gio.FileCreateFlags.PRIVATE, null);
        try {
            // Recordings can be large, so the copy streams instead of reading the whole file at once.
            stream.splice(Gio.File.new_for_path(artifact).read(null), Gio.OutputStreamSpliceFlags.CLOSE_SOURCE, null);
            // On disk before the rename, so a crash cannot leave a final name pointing at a truncated file. GLib.fsync
            // is only introspectable from GLib 2.80 on; before that the rename alone still never shows a partial file.
            if (GLib.fsync && GLib.fsync(stream.get_fd()) !== 0)
                throw new Error(`Could not write ${hidden.get_path()}`);
        } finally {
            stream.close(null);
        }
        const timestamp = GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S');
        for (let index = 0; index < 10000; index++) {
            const path = GLib.build_filenamev([folder, `CapIt_${timestamp}${index ? `_${index}` : ''}${extension}`]);
            try {
                Gio.File.new_for_path(path).create(Gio.FileCreateFlags.PRIVATE, null).close(null);
            } catch (error) {
                if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    continue;
                throw error;
            }
            hidden.move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
            return path;
        }
        throw new Error('Could not allocate a unique capture filename');
    } finally {
        try {
            hidden.delete(null);
        } catch { /* Already renamed into place, or never created. */ }
    }
}

/**
 * Copies a capture that goes on the clipboard as a file, but is not saved, into `directory` and returns the copy.
 * The clipboard names the file, so it must outlive the capture's temporary folder. Only the newest such file is
 * kept: a newer copy replaces the clipboard anyway.
 * @param {string} path for example '/home/user/.cache/capit/recording-…/recording.gif'
 * @param {string} directory for example '/home/user/.cache/capit/clipboard'
 * @returns {string} the copy's path, with the extension of `path`
 */
export function clipboardCopy(path, directory) {
    const folder = Gio.File.new_for_path(directory);
    if (GLib.file_test(directory, GLib.FileTest.IS_DIR)) {
        const children = folder.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            if (info.get_name().startsWith('CapIt_'))
                folder.get_child(info.get_name()).delete(null);
        }
    }
    const dot = path.lastIndexOf('.');
    return publish(path, directory, dot > path.lastIndexOf('/') ? path.slice(dot) : '');
}
