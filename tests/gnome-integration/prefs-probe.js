// SPDX-License-Identifier: GPL-3.0-or-later

// Harness-only instrumentation of the actual GNOME preferences service.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
const directory = `${GLib.get_user_data_dir()}/gnome-shell/extensions/capit@karazum.github.io`;
const {default: Preferences} = await import(Gio.File.new_for_path(`${directory}/prefs.js`).get_uri());
const fill = Preferences.prototype.fillPreferencesWindow;
const resultPath = `${GLib.get_user_cache_dir()}/prefs-result.json`;

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

Preferences.prototype.fillPreferencesWindow = function (window) {
    fill.call(this, window);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        try {
            const rows = [];
            const combos = [];
            const spins = [];
            const actions = [];
            const walk = widget => {
                if (widget instanceof Adw.ActionRow && !(widget instanceof Adw.EntryRow) &&
                    !(widget instanceof Adw.ComboRow) && !(widget instanceof Adw.SpinRow))
                    actions.push(widget);
                if (widget instanceof Adw.SpinRow)
                    spins.push(widget);
                if (widget instanceof Adw.EntryRow)
                    rows.push(widget);
                if (widget instanceof Adw.ComboRow)
                    combos.push(widget);
                for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
                    walk(child);
            };
            walk(window);
            check(window.get_mapped(), 'Native preferences window did not map');
            check(rows.length === 3, `Expected three EntryRows, found ${rows.length}`);
            const folder = rows.find(row => row.title.startsWith('Output folder'));
            const [shortcut, recordShortcut] = rows.filter(row => row.title.startsWith('Shortcut'));
            check(folder && shortcut && recordShortcut, 'Preferences entries not found');
            const settings = this.getSettings();
            check(folder.text === '', 'Output folder default mismatch');
            check(shortcut.text === '<Super><Shift>s', 'Shortcut default mismatch');
            folder.text = `  ${GLib.get_user_runtime_dir()}/prefs-output  `;
            folder.emit('apply');
            check(settings.get_string('output-directory') === `${GLib.get_user_runtime_dir()}/prefs-output`,
                'Folder apply did not trim/store the value');
            shortcut.text = 'definitely not a shortcut';
            shortcut.emit('apply');
            check(shortcut.has_css_class('error'), 'Invalid shortcut was not marked');
            check(settings.get_strv('capture-shortcut')[0] === '<Super><Shift>s',
                'Invalid shortcut changed settings');
            shortcut.text = '<Control><Shift>F12';
            shortcut.emit('apply');
            check(!shortcut.has_css_class('error'), 'Valid shortcut error was not cleared');
            check(settings.get_strv('capture-shortcut')[0] === '<Control><Shift>F12',
                'Valid shortcut apply did not store the value');
            shortcut.text = '';
            shortcut.emit('apply');
            check(settings.get_strv('capture-shortcut').length === 0, 'Blank shortcut did not disable binding');
            folder.text = '';
            folder.emit('apply');
            check(settings.get_string('output-directory') === '', 'Blank output folder did not restore default');
            const detection = combos.find(row => row.title.startsWith('Find elements'));
            check(detection, 'Element detection row not found');
            check(detection.selected === 1 && settings.get_string('element-detection') === 'visual',
                'Element detection default mismatch');
            detection.selected = 2;
            check(settings.get_string('element-detection') === 'accessibility', 'Choosing the last detection mode did not store it');
            detection.selected = 0;
            check(settings.get_string('element-detection') === 'none', 'Choosing None did not store it');
            const quick = actions.find(row => row.title === 'Capture without annotating');
            check(quick && !quick.active && !settings.get_boolean('quick-capture'), 'Quick capture default mismatch');
            quick.active = true;
            check(settings.get_boolean('quick-capture'), 'Turning quick capture on did not store it');
            quick.active = false;
            check(recordShortcut.text === '<Super><Shift>g', 'Recording shortcut default mismatch');
            recordShortcut.text = 'not a shortcut either';
            recordShortcut.emit('apply');
            check(recordShortcut.has_css_class('error') && settings.get_strv('record-shortcut')[0] === '<Super><Shift>g',
                'Invalid recording shortcut was stored or not marked');
            recordShortcut.text = '<Super><Alt>r';
            recordShortcut.emit('apply');
            check(settings.get_strv('record-shortcut')[0] === '<Super><Alt>r', 'Recording shortcut did not apply');
            const dither = combos.find(row => row.title === 'Dithering');
            const fps = spins.find(row => row.title === 'Frames per second');
            const bayer = spins.find(row => row.title === 'Bayer scale');
            check(dither && fps && bayer, 'GIF recording rows not found');
            check(settings.get_string('gif-dither') === 'sierra2_4a' && dither.selected === 5, 'Dithering default mismatch');
            check(fps.value === 15 && !bayer.sensitive, 'GIF frame rate default or Bayer sensitivity mismatch');
            dither.selected = 1;
            check(settings.get_string('gif-dither') === 'bayer' && bayer.sensitive, 'Choosing Bayer did not store it');
            fps.value = 25;
            check(settings.get_int('gif-fps') === 25, 'Frame rate change did not store it');
            const speed = combos.find(row => row.title === 'Encoding speed');
            const crf = spins.find(row => row.title === 'Quality (CRF)');
            check(speed && crf && speed.selected === 0 && crf.value === 28, 'Video defaults mismatch');
            speed.selected = 5;
            crf.value = 23;
            check(settings.get_string('video-preset') === 'medium' && settings.get_int('video-crf') === 23,
                'Video settings did not store');
            // The Status group lists recording and each dependency; the harness has them all, so recording works and
            // its settings stay sensitive.
            const status = actions.find(row => row.title === 'Recording');
            check(status && actions.some(row => row.title === 'ffmpeg') && actions.some(row => row.title === 'x264enc'),
                'Status rows not found');
            check(crf.sensitive && fps.sensitive, 'Recording settings greyed out although recording works');
            const result = {
                event: 'PREFS_ALL_PASS', value: {
                    nativeWindowMapped: true, page: window.visible_page.title,
                    rows: rows.map(row => row.title),
                    checks: ['defaults', 'folder trim/apply', 'invalid shortcut rejects with CSS error',
                        'valid shortcut applies and clears error', 'blank shortcut disables', 'blank folder restores default',
                        'element detection default and choices', 'quick capture switch', 'recording shortcut', 'GIF dithering and frame rate', 'video quality and speed',
                        'dependency status'],
                    scope: 'Actual native preferences window and real apply callbacks; physical typing/clicks and cross-process persistence untested',
                },
            };
            GLib.file_set_contents(resultPath, JSON.stringify(result));
        } catch (error) {
            const result = {event: 'PREFS_FAILED', error: error.stack ?? error.message};
            GLib.file_set_contents(resultPath, JSON.stringify(result));
            printerr(JSON.stringify(result));
        }
        window.close();
        return GLib.SOURCE_REMOVE;
    });
};

// Same main and service implementation used by the installed GNOME entrypoint.
const {main} = await import(`${imports.package.moduledir}/main.js`);
await main([]);
