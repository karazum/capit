// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {commands, encode, execute, options, paletteuse, videoCommand, videoOptions} from '../../extension/encoder.js';
import {assert, repoPath, temporaryDirectory, test} from './harness.js';

const FFMPEG = GLib.find_program_in_path('ffmpeg');
const DEFAULTS = {dither: 'sierra2_4a', bayerScale: 2, statsMode: 'full'};

// Runs `argv` to its end and returns its stdout, throwing with its stderr when it fails.
function check(argv, input = null) {
    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
        (input === null ? 0 : Gio.SubprocessFlags.STDIN_PIPE);
    const process = Gio.Subprocess.new(argv, flags);
    const [, stdout, stderr] = process.communicate_utf8(input, null);
    if (!process.get_successful())
        throw new Error(`${argv[0]} failed: ${stderr}`);
    return stdout;
}

function list(directory) {
    const children = Gio.File.new_for_path(directory)
        .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    const names = [];
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(GLib.build_filenamev([directory, info.get_name()]));
    return names;
}

function bytes(path) {
    return GLib.file_get_contents(path)[1];
}

function sameBytes(first, second) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
}

test('the defaults build one palette for the whole recording and use Sierra Lite, in two passes', () => {
    assert.deepEqual(options({}), DEFAULTS);
    const [first, second] = commands('ffmpeg', 'in.mkv', 'palette.png', 'out.gif', DEFAULTS);
    assert.equal(first[first.indexOf('-vf') + 1], 'palettegen=stats_mode=full');
    assert.equal(first.at(-1), 'palette.png');
    assert.equal(second[second.indexOf('-lavfi') + 1], '[0:v][1:v]paletteuse=dither=sierra2_4a');
    assert.equal(second[second.indexOf('palette.png') - 1], '-i');
    assert.equal(second.at(-1), 'out.gif');
});

test('the Bayer scale applies only to Bayer dithering', () => {
    assert.equal(paletteuse({...DEFAULTS, dither: 'bayer', bayerScale: 4}), 'paletteuse=dither=bayer:bayer_scale=4');
    assert.equal(paletteuse({...DEFAULTS, bayerScale: 4}), 'paletteuse=dither=sierra2_4a');
});

test('per-frame palettes run in one pass and switch palettes', () => {
    const [command, ...rest] = commands('ffmpeg', 'in.mkv', 'palette.png', 'out.gif', {...DEFAULTS, statsMode: 'single'});
    assert.equal(rest.length, 0);
    const graph = command[command.indexOf('-lavfi') + 1];
    assert.ok(graph.includes('palettegen=stats_mode=single'), graph);
    assert.ok(graph.endsWith('paletteuse=dither=sierra2_4a:new=1'), graph);
    assert.ok(!command.includes('palette.png'));
});

test('invalid GIF options are rejected', () => {
    for (const request of [{dither: 'random'}, {statsMode: 'all'}, {bayerScale: 6}, {bayerScale: true},
        {bayerScale: 1.5}, {bayerScale: '2'}])
        assert.throws(() => options(request), /Invalid/);
});

test('a video uses the default libx264 arguments on an even size', () => {
    const settings = videoOptions({});
    assert.deepEqual(settings, {fps: 30, crf: 28, preset: 'ultrafast'});
    const command = videoCommand('ffmpeg', 'in.mkv', 'out.mp4', settings);
    assert.ok(command.join(' ').includes(
        '-c:v libx264 -r 30 -preset ultrafast -crf 28 -pix_fmt yuv420p -movflags +faststart'), command.join(' '));
    assert.equal(command[command.indexOf('-vf') + 1], 'crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
});

test('invalid video options and kinds are rejected', () => {
    for (const request of [{preset: 'ludicrous'}, {crf: 52}, {fps: 0}])
        assert.throws(() => videoOptions(request), /Invalid/);
    assert.throws(() => encode({kind: 'webm', source: 'in.mkv', workdir: '/nonexistent'}, 'ffmpeg'),
        /Invalid recording kind/);
});

test('missing FFmpeg is reported', () => {
    assert.throws(() => encode({source: 'in.mkv', workdir: '/nonexistent'}, null), /install the ffmpeg package/);
});

// Runs `body` with a lossless stand-in for a screen recording: 15 moving test-pattern frames, at an odd size, as a
// fractional-scale area can produce, which the video encode must even out.
function withRecording(body) {
    return () => {
        if (!FFMPEG) {
            print('# skipped: ffmpeg is not installed');
            return;
        }
        const [root, cleanup] = temporaryDirectory();
        try {
            const workdir = `${root}/work`;
            GLib.mkdir_with_parents(workdir, 0o700);
            const source = `${root}/recording.mkv`;
            check([FFMPEG, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=97x65:rate=15', '-t', '1',
                '-c:v', 'ffv1', source]);
            body({root, source, workdir, request: values => ({source, workdir, ...values})});
        } finally {
            cleanup();
        }
    };
}

// The MD5 of each decoded frame of a video or GIF.
function frames(path) {
    return check([FFMPEG, '-v', 'error', '-i', path, '-f', 'framemd5', '-']).split('\n')
        .filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

test('two passes produce the frames of the equivalent single command', withRecording(({root, source, request}) => {
    const result = execute(request());
    const single = `${root}/single.gif`;
    check([FFMPEG, '-v', 'error', '-i', source, '-lavfi',
        'palettegen=stats_mode=full[palette],[0:v][palette]paletteuse=dither=sierra2_4a', '-y', single]);
    assert.equal(new TextDecoder().decode(bytes(result.output).slice(0, 6)), 'GIF89a');
    assert.equal(result.bytes, bytes(result.output).length);
    assert.equal(frames(result.output).length, 15);
    assert.deepEqual(frames(result.output), frames(single));
}));

test('a saved GIF is published with a GIF name and is also what is copied', withRecording(({root, request}) => {
    const result = execute(request({
        save: true, directory: `${root}/out`, copy: true,
        clipboardDirectory: `${root}/clipboard`,
    }));
    assert.ok(/\/out\/CapIt_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.gif$/.test(result.savedPath), result.savedPath);
    assert.ok(sameBytes(bytes(result.savedPath), bytes(result.output)));
    // The clipboard shares the saved file, so no second copy is kept.
    assert.ok(!('clipboardPath' in result));
    assert.ok(!GLib.file_test(`${root}/clipboard`, GLib.FileTest.EXISTS));
}));

test('copy only keeps just the newest GIF for the clipboard', withRecording(({root, workdir, request}) => {
    const clipboard = `${root}/clipboard`;
    execute(request({copy: true, clipboardDirectory: clipboard}));
    Gio.File.new_for_path(`${workdir}/recording.gif`).delete(null);
    const second = execute(request({copy: true, clipboardDirectory: clipboard})).clipboardPath;
    assert.deepEqual(list(clipboard), [second]);
}));

test('a failed save still offers the GIF for the clipboard', withRecording(({root, request}) => {
    const folder = `${root}/not-a-folder`;
    GLib.file_set_contents(folder, 'existing file');
    const result = execute(request({
        save: true, directory: folder, copy: true,
        clipboardDirectory: `${root}/clipboard`,
    }));
    assert.ok(result.saveError, JSON.stringify(result));
    assert.ok(GLib.file_test(result.clipboardPath, GLib.FileTest.IS_REGULAR));
}));

test('a video is an even-sized yuv420p MP4', withRecording(({root, request}) => {
    const result = execute(request({kind: 'video', save: true, directory: `${root}/out`}));
    assert.ok(result.savedPath.endsWith('.mp4'), result.savedPath);
    const probe = JSON.parse(check(['ffprobe', '-v', 'error', '-count_frames', '-show_entries',
        'stream=codec_name,pix_fmt,width,height,nb_read_frames', '-of', 'json', result.savedPath]));
    const [stream] = probe.streams;
    assert.deepEqual([stream.codec_name, stream.pix_fmt, stream.width, stream.height], ['h264', 'yuv420p', 96, 64]);
    // One second at 30 fps from a 15 fps source. FFmpeg 6 ends it a frame early, FFmpeg 7 and later do not.
    assert.ok(Math.abs(Number(stream.nb_read_frames) - 30) <= 1, stream.nb_read_frames);
}));

test('copy only replaces a GIF with a newer video', withRecording(({root, request}) => {
    const clipboard = `${root}/clipboard`;
    execute(request({copy: true, clipboardDirectory: clipboard}));
    const video = execute(request({kind: 'video', copy: true, clipboardDirectory: clipboard}));
    assert.deepEqual(list(clipboard), [video.clipboardPath]);
}));

test('an FFmpeg failure names the problem', withRecording(({source, request}) => {
    GLib.file_set_contents(source, 'not a video');
    assert.throws(() => execute(request()), /FFmpeg failed: .+/);
}));

test('the worker answers on stdout and fails with an error and status 1', withRecording(({request}) => {
    const worker = [GLib.find_program_in_path('gjs'), '-m', repoPath('extension/encoder.js')];
    const answer = JSON.parse(check(worker, JSON.stringify(request({kind: 'video'}))));
    assert.ok(answer.output.endsWith('recording.mp4') && answer.bytes > 0, JSON.stringify(answer));
    const process = Gio.Subprocess.new(worker, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    const [, stdout] = process.communicate_utf8(JSON.stringify(request({kind: 'webm'})), null);
    assert.deepEqual(JSON.parse(stdout), {error: 'Invalid recording kind'});
    assert.equal(process.get_exit_status(), 1);
}));

// Process IDs whose command line mentions `text`, only those running `program` when it is given.
function processesMentioning(text, program = null) {
    const pids = [];
    for (const path of list('/proc')) {
        const pid = path.slice('/proc/'.length);
        if (!/^\d+$/.test(pid))
            continue;
        try {
            const argv = new TextDecoder().decode(GLib.file_get_contents(`${path}/cmdline`)[1]).split('\0');
            if (argv.some(argument => argument.includes(text)) && (!program || argv[0].endsWith(program)))
                pids.push(Number(pid));
        } catch { /* Exited while listing. */ }
    }
    return pids;
}

function waitFor(condition, what) {
    for (let waited = 0; waited < 10_000; waited += 20) {
        if (condition())
            return;
        GLib.usleep(20_000);
    }
    throw new Error(`timed out waiting for ${what}`);
}

test('FFmpeg dies with a worker that is killed mid-encode', () => {
    if (!FFMPEG) {
        print('# skipped: ffmpeg is not installed');
        return;
    }
    const [root, cleanup] = temporaryDirectory();
    // A named pipe nobody writes to: FFmpeg blocks opening it, so the encode lasts until it is killed.
    const source = `${root}/never-written.mkv`;
    check(['mkfifo', source]);
    try {
        const worker = Gio.Subprocess.new([GLib.find_program_in_path('gjs'), '-m', repoPath('extension/encoder.js')],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE);
        const stdin = worker.get_stdin_pipe();
        stdin.write_all(new TextEncoder().encode(JSON.stringify({source, workdir: root})), null);
        stdin.close(null);
        // setpriv's own command line names the pipe too. Once the process is FFmpeg, its death signal is set.
        waitFor(() => processesMentioning(source, '/ffmpeg').length > 0, 'FFmpeg to start');
        worker.force_exit();
        worker.wait(null);
        waitFor(() => processesMentioning(source).length === 0, 'FFmpeg to exit with its worker');
    } finally {
        for (const pid of processesMentioning(source))
            GLib.spawn_command_line_sync(`kill -KILL ${pid}`);
        cleanup();
    }
});
