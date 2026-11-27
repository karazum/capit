// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Imports capit.js from a copy of the extension's modules in a new directory, then deletes the copy. GNOME Shell
// caches modules by URL for the whole session, so a URL it has not seen yet yields fresh instances of capit.js and
// of everything it imports relatively.
async function importFresh(path) {
    const copy = GLib.build_filenamev([GLib.get_user_runtime_dir(), `capit-modules-${GLib.uuid_string_random()}`]);
    GLib.mkdir_with_parents(copy, 0o700);
    const files = [];
    try {
        for (const info of Gio.File.new_for_path(path).enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null)) {
            const name = info.get_name();
            if (!name.endsWith('.js'))
                continue;
            const file = Gio.File.new_for_path(GLib.build_filenamev([copy, name]));
            Gio.File.new_for_path(GLib.build_filenamev([path, name])).copy(file, Gio.FileCopyFlags.NONE, null, null);
            files.push(file);
        }
        return await import(Gio.File.new_for_path(GLib.build_filenamev([copy, 'capit.js'])).get_uri());
    } finally {
        // Imported modules are compiled once and never read from disk again.
        for (const file of files)
            file.delete(null);
        GLib.rmdir(copy);
    }
}

/**
 * The module GNOME Shell loads, kept to a stub so that the rest of CapIt can be reloaded without logging out.
 *
 * GNOME Shell 46 never re-reads an extension's modules during a session, so disable/enable normally keeps running
 * the code from login. When the installed extension is a symlink to a checkout (`make link`), each enable imports a
 * fresh copy of capit.js and its modules instead. Changes to this file still need a new login.
 */
export default class CapItExtension extends Extension {
    async enable() {
        this.development = GLib.file_test(this.path, GLib.FileTest.IS_SYMLINK);
        try {
            const {CapIt} = await (this.development ? importFresh(this.path) : import('./capit.js'));
            this.capit = new CapIt(this);
            this.capit.enable();
        } catch (error) {
            this.disable();
            this._fail(error);
        }
    }

    disable() {
        const capit = this.capit;
        this.capit = null;
        try {
            capit?.disable();
        } catch (error) {
            this._fail(error);
        }
    }

    // Shell parks an extension whose enable or disable throws in an error state that only a new login clears,
    // which would defeat reloading a checkout. A development load reports the error and stays enabled instead,
    // so fixing the code and reloading again recovers.
    _fail(error) {
        if (!this.development)
            throw error;
        // A syntax error's stack holds only the importing frames; where the bad code is lives on the error itself.
        const location = error.fileName ? ` at ${GLib.path_get_basename(error.fileName)}:${error.lineNumber}` : '';
        console.error(`[CapIt] ${error}${location}\n${error.stack}`);
        Main.notifyError('CapIt', `${error}${location}`);
    }
}
