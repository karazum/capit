// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';

import {checkDependencies} from '../../extension/doctor.js';
import {assert, repoPath, test} from './harness.js';

const ALL = ['gjs', 'ffmpeg', 'setpriv', 'pipewiresrc', 'videoconvert', 'x264enc', 'matroskamux', 'pngenc', 'qtmux'];

// checkDependencies on a computer that has every program and element but `missing`.
function check(...missing) {
    const find = name => ALL.includes(name) && !missing.includes(name) ? `/found/${name}` : null;
    return checkDependencies({findProgram: find, findElement: find});
}

test('with everything installed, recording is available with nothing to note', () => {
    const {checks, recording} = check();
    assert.deepEqual(checks.map(item => item.name), ALL);
    assert.deepEqual(recording, {ready: true, reason: null, note: null});
});

test('without FFmpeg, recording is unavailable and the reason names the package', () => {
    assert.deepEqual(check('ffmpeg').recording,
        {ready: false, reason: 'Recording needs ffmpeg', note: null});
    assert.equal(check('ffmpeg', 'pipewiresrc').recording.reason, 'Recording needs ffmpeg, gstreamer1.0-pipewire');
});

test('without x264, recording falls back to PNG frames, which is noted', () => {
    const {recording} = check('x264enc');
    assert.ok(recording.ready);
    assert.ok(/gstreamer1.0-plugins-ugly/.test(recording.note), recording.note);
});

test('without any lossless pair of elements, recording is unavailable', () => {
    const {recording} = check('x264enc', 'pngenc');
    assert.ok(!recording.ready);
    assert.equal(recording.reason, 'Recording needs gstreamer1.0-plugins-good');
});

test('without setpriv, recording works and the background encode is noted', () => {
    const {recording} = check('setpriv');
    assert.ok(recording.ready);
    assert.ok(/setpriv/.test(recording.note), recording.note);
});

test('the doctor program reports every check and recording', () => {
    const process = Gio.Subprocess.new(['gjs', '-m', repoPath('extension/doctor.js')], Gio.SubprocessFlags.STDOUT_PIPE);
    const [, stdout] = process.communicate_utf8(null, null);
    assert.ok(process.get_successful());
    const lines = stdout.trim().split('\n');
    for (const name of ALL)
        assert.ok(lines.some(line => line.startsWith(`${name}: `)), name);
    assert.ok(lines.some(line => /^Recording: (available|unavailable)/.test(line)), stdout);
});
