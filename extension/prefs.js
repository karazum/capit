// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {checkDependencies} from './doctor.js';

export default class CapItPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Capture', icon_name: 'camera-photo-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'CapIt',
            description: 'Select and annotate on a frozen desktop. Enter copies the capture and saves PNG.',
        });
        const folder = new Adw.EntryRow({
            title: 'Output folder (blank uses Pictures/CapIt)',
            text: settings.get_string('output-directory'), show_apply_button: true,
        });
        folder.connect('apply', () => settings.set_string('output-directory', folder.text.trim()));
        group.add(folder);
        group.add(shortcutRow(settings, 'capture-shortcut', 'Shortcut, for example <Super><Shift>s'));
        group.add(choiceRow(settings, 'clipboard-content', 'Copy and save puts on the clipboard',
            'File pastes as an attachment in chat apps, browsers and Files. Content pastes the image or video itself, as image editors expect; captures over 100 MB are copied as a file. Copy only always copies the content.',
            ['file', 'content'], ['File', 'Content']));
        const hints = new Adw.SwitchRow({
            title: 'Show shortcuts on toolbar buttons',
            subtitle: 'A small label on each button with its key, to learn them',
        });
        settings.bind('show-key-hints', hints, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hints);
        const modes = ['none', 'visual', 'accessibility'];
        const detection = new Adw.ComboRow({
            title: 'Find elements inside windows',
            subtitle: 'Visual finds panels, cards, fields, tabs and pictures in the frozen image, by their borders and backgrounds. Accessibility tree asks the application; Chromium and Electron apps answer only when started with --force-renderer-accessibility.',
            model: Gtk.StringList.new(['None (whole windows)', 'Visual', 'Accessibility tree']),
            selected: Math.max(0, modes.indexOf(settings.get_string('element-detection'))),
        });
        detection.connect('notify::selected', () => settings.set_string('element-detection', modes[detection.selected]));
        group.add(detection);
        const regions = new Adw.SwitchRow({
            title: 'Outline large regions',
            subtitle: 'Dashed, coloured outlines of the large panels found in the window under the pointer, each with a tab that selects it',
        });
        settings.bind('show-large-regions', regions, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(regions);
        const quick = new Adw.SwitchRow({
            title: 'Capture without annotating',
            subtitle: 'Clicking a smart box or a region tab, or finishing a drag, copies and saves the screenshot at once. Recordings still start with a click or Enter.',
        });
        settings.bind('quick-capture', quick, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(quick);
        const help = new Adw.ActionRow({
            title: 'Keyboard controls',
            subtitle: 'V select · A arrow · R box · P brush · B blur · X redact · T text\nCtrl+Z undo · Ctrl+Shift+Z redo · Ctrl+C copy · Ctrl+S save\nEnter commits text, then finishes · Ctrl+Enter commits and finishes · Esc cancels',
        });
        group.add(help);
        page.add(group);
        const {checks, recording} = checkDependencies();
        const recordingGroups = [recordingGroup(settings, recording), gifGroup(settings), videoGroup(settings)];
        for (const recordingSettings of recordingGroups) {
            // Settings for recordings that cannot be made are greyed out; the recording group says why.
            recordingSettings.set_sensitive(recording.ready);
            page.add(recordingSettings);
        }
        page.add(statusGroup(checks, recording));
        page.add(diagnosticsGroup(settings));
        window.add(page);
    }
}

// An entry for a keybinding key that shows an invalid accelerator as an error instead of storing it.
function shortcutRow(settings, key, title) {
    const row = new Adw.EntryRow({
        title, use_markup: false, text: settings.get_strv(key)[0] ?? '',
        show_apply_button: true,
    });
    row.connect('apply', () => {
        const text = row.text.trim();
        const [valid] = Gtk.accelerator_parse(text);
        if (text && !valid) {
            row.add_css_class('error');
            return;
        }
        row.remove_css_class('error');
        settings.set_strv(key, text ? [text] : []);
    });
    return row;
}

// A drop-down for a string key, where values[i] is stored for labels[i].
function choiceRow(settings, key, title, subtitle, values, labels) {
    const row = new Adw.ComboRow({
        title, subtitle, model: Gtk.StringList.new(labels),
        selected: Math.max(0, values.indexOf(settings.get_string(key))),
    });
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    return row;
}

function numberRow(settings, key, title, subtitle, lower, upper) {
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.set_title(title);
    row.set_subtitle(subtitle);
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// recording: from checkDependencies(), whose reason replaces the description when recording cannot work.
function recordingGroup(settings, recording) {
    const group = new Adw.PreferencesGroup({
        title: 'Recording',
        description: recording.ready
            ? 'The buttons beside a selected region switch between a screenshot, a GIF and a video. Enter starts a recording; the same shortcut or the panel menu stops it. Recording needs FFmpeg.'
            : `Unavailable. ${recording.reason}.`,
    });
    group.add(shortcutRow(settings, 'record-shortcut', 'Shortcut, for example <Super><Shift>g'));
    group.add(choiceRow(settings, 'recording-output', 'Finished recording', '', ['both', 'copy', 'save'],
        ['Copy and save', 'Copy only', 'Save only']));
    const cursor = new Adw.SwitchRow({title: 'Show the pointer'});
    settings.bind('recording-show-cursor', cursor, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(cursor);
    const demo = new Adw.SwitchRow({
        title: 'Highlight the pointer and clicks',
        subtitle: 'A halo around the pointer and a ripple for each click; also the pointer button in the recording toolbar',
    });
    settings.bind('recording-demo-cursor', demo, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(demo);
    return group;
}

function gifGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'GIF'});
    group.add(numberRow(settings, 'gif-fps', 'Frames per second',
        'Browsers slow down GIFs faster than 50 frames per second', 1, 50));
    group.add(numberRow(settings, 'gif-max-duration', 'Longest recording in seconds', '0 records until stopped',
        0, 3600));
    group.add(choiceRow(settings, 'gif-stats-mode', 'Palette',
        'Whole recording suits most captures. Changing parts favours the colours that move over a still background. Per frame gives the truest colours and the largest files.',
        ['full', 'diff', 'single'], ['Whole recording', 'Changing parts', 'Per frame']));
    const dithers = ['none', 'bayer', 'heckbert', 'floyd_steinberg', 'sierra2', 'sierra2_4a', 'sierra3', 'burkes',
        'atkinson'];
    group.add(choiceRow(settings, 'gif-dither', 'Dithering',
        'Blends colours the palette lacks. Sierra Lite is the default; None gives the smallest files and banded gradients.',
        dithers, ['None', 'Bayer (ordered)', 'Heckbert', 'Floyd–Steinberg', 'Sierra-2', 'Sierra Lite', 'Sierra-3',
            'Burkes', 'Atkinson']));
    const bayer = numberRow(settings, 'gif-bayer-scale', 'Bayer scale',
        'Only for Bayer dithering; higher values show the pattern less', 0, 5);
    const updateBayer = () => bayer.set_sensitive(settings.get_string('gif-dither') === 'bayer');
    settings.connect('changed::gif-dither', updateBayer);
    updateBayer();
    group.add(bayer);
    return group;
}

function videoGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Video',
        description: 'MP4 (H.264) without sound, which browsers and chat applications play.',
    });
    group.add(numberRow(settings, 'video-fps', 'Frames per second', '', 1, 60));
    group.add(numberRow(settings, 'video-max-duration', 'Longest recording in seconds', '0 records until stopped',
        0, 36000));
    group.add(numberRow(settings, 'video-crf', 'Quality (CRF)',
        'Lower is sharper and larger; the default is 28, x264 alone uses 23', 0, 51));
    const presets = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
    group.add(choiceRow(settings, 'video-preset', 'Encoding speed',
        'Slower makes smaller files at the same quality but takes longer after stopping. Ultrafast is the default.',
        presets, presets.map(preset => preset[0].toUpperCase() + preset.slice(1))));
    return group;
}

// What `capit doctor` reports: each program and GStreamer element CapIt uses, and whether recording works.
function statusGroup(checks, recording) {
    const group = new Adw.PreferencesGroup({
        title: 'Status',
        description: 'Programs and GStreamer elements CapIt uses. Run `capit doctor` for a report to attach to a bug.',
    });
    const row = (title, subtitle, ok) => {
        const item = new Adw.ActionRow({title, subtitle, use_markup: false});
        item.add_suffix(new Gtk.Image({icon_name: ok ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic'}));
        return item;
    };
    group.add(row('Recording', recording.ready ? recording.note ?? 'Available' : recording.reason, recording.ready));
    for (const check of checks) {
        group.add(row(check.name, check.found ? `For ${check.purpose}: ${check.found}`
            : `For ${check.purpose}. Missing; install ${check.package}`, Boolean(check.found)));
    }
    return group;
}

function diagnosticsGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Diagnostics'});
    const timing = new Adw.SwitchRow({
        title: 'Log stage timings',
        subtitle: "Writes how long each capture, export and recording stage takes to the system journal, to find what is slow on this computer. Read it with: journalctl --user -b -g 'CapIt timing'",
    });
    settings.bind('timing-log', timing, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(timing);
    return group;
}
