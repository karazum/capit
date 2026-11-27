// SPDX-License-Identifier: GPL-3.0-or-later
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// A small test runner for code that needs GJS, such as Cairo or GObject introspection, which node cannot load.
const registered = [];

// name: what the test checks; body: a function, possibly async, that throws when the check fails.
export function test(name, body) {
    registered.push([name, body]);
}

export const assert = {
    ok(value, message = 'expected a true value') {
        if (!value)
            throw new Error(message);
    },
    equal(actual, expected, message = '') {
        if (actual !== expected)
            throw new Error(`${message}${message ? ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    deepEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error(`${message}${message ? ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    throws(body, pattern = /./) {
        try {
            body();
        } catch (error) {
            if (!pattern.test(error.message))
                throw new Error(`threw "${error.message}", which does not match ${pattern}`);
            return;
        }
        throw new Error('expected an exception');
    },
};

// Runs every registered test in order and returns how many failed.
export async function run() {
    let failed = 0;
    for (const [name, body] of registered) {
        try {
            await body();
            print(`ok - ${name}`);
        } catch (error) {
            failed++;
            print(`not ok - ${name}\n  ${error.message}\n${error.stack?.split('\n').slice(0, 3).map(line => `  ${line}`).join('\n') ?? ''}`);
        }
    }
    print(`${registered.length - failed} passed, ${failed} failed`);
    return failed;
}

// Absolute path of a file in the repository, from a path relative to its root such as 'tests/fixtures/x.png'.
export function repoPath(relative) {
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    return GLib.build_filenamev([here, '..', '..', relative]);
}

// A new empty directory for one test's files, removed by the returned function.
export function temporaryDirectory() {
    const path = GLib.dir_make_tmp('capit-test-XXXXXX');
    const remove = file => {
        // Listed in full before deleting, as removing entries while enumerating can skip some.
        const children = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        const infos = [];
        for (let info = children.next_file(null); info; info = children.next_file(null))
            infos.push(info);
        children.close(null);
        for (const info of infos) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                remove(child);
            else
                child.delete(null);
        }
        file.delete(null);
    };
    return [path, () => remove(Gio.File.new_for_path(path))];
}

// The decoded pixels of a PNG: {width, height, rowstride, channels, pixels} with pixels a Uint8Array of RGB(A).
export function loadImage(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    return {
        width: pixbuf.get_width(), height: pixbuf.get_height(), rowstride: pixbuf.get_rowstride(),
        channels: pixbuf.get_n_channels(), pixels: pixbuf.get_pixels(),
    };
}

// [red, green, blue, alpha] of one pixel of a decoded image; alpha is 255 for images without it.
export function pixel(image, x, y) {
    const offset = y * image.rowstride + x * image.channels;
    const value = Array.from(image.pixels.subarray(offset, offset + image.channels));
    return image.channels === 4 ? value : [...value, 255];
}
