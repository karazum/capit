# SPDX-License-Identifier: GPL-3.0-or-later
"""Drives the corpus session started by capture.sh: one application at a time, captured through CapIt."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
UUID = 'capit@karazum.github.io'
out = Path(os.environ['CORPUS_OUT'])
here = Path(os.environ['CORPUS_DIR'])
home = Path(os.environ['HOME'])
runtime = Path(os.environ['XDG_RUNTIME_DIR'])
scale = float(os.environ.get('CORPUS_SCALE', '1'))
EDGE = ['microsoft-edge', '--no-first-run', '--force-renderer-accessibility', '--password-store=basic',
        '--disable-sync', '--window-size=1400,900']
IDE, ARTICLE = f'--app=file://{here}/ide.html', f'--app=file://{here}/article.html'
X11 = {'DISPLAY': os.environ.get('CORPUS_X_DISPLAY', ''), 'XAUTHORITY': os.environ.get('CORPUS_XAUTHORITY', '')}
PHOTO = next(iter(sorted(str(path) for path in Path('/usr/share/backgrounds').glob('*.jpg'))), '')
# name, colour scheme, command, extra environment
CASES = [
    ('files-dark', 'prefer-dark', ['nautilus', '--new-window', str(home / 'Documents')], {}),
    ('files-light', 'default', ['nautilus', '--new-window', str(home / 'Documents')], {}),
    ('editor-dark', 'prefer-dark', ['gnome-text-editor', '--standalone', str(home / 'Projects/capit/detector.js')], {}),
    ('editor-light', 'default', ['gnome-text-editor', '--standalone', str(home / 'Projects/capit/README.md')], {}),
    ('settings-dark', 'prefer-dark', ['gnome-control-center', 'keyboard'], {}),
    ('settings-light', 'default', ['gnome-control-center', 'mouse'], {}),
    ('calculator-light', 'default', ['gnome-calculator'], {}),
    ('terminal-dark', 'prefer-dark', ['gnome-terminal', '--wait', '--', 'bash', '-c', f'ls -la /usr/share; cat {here}/truth.py | head -30; sleep 600'], {}),
    ('spreadsheet-light', 'default', ['libreoffice', '--calc', '--norestore', '--nologo'], {}),
    ('photo-dark', 'prefer-dark', ['eog', PHOTO], {}),
    ('ide-wayland', 'prefer-dark', [*EDGE, IDE, '--ozone-platform=wayland', f'--user-data-dir={home}/edge-wayland'], {}),
    ('ide-xwayland', 'prefer-dark', [*EDGE, IDE, '--ozone-platform=x11', f'--user-data-dir={home}/edge-x11'], X11),
    ('article-wayland', 'default', [*EDGE, ARTICLE, '--ozone-platform=wayland', f'--user-data-dir={home}/edge-wayland'], {}),
    ('article-xwayland', 'default', [*EDGE, ARTICLE, '--ozone-platform=x11', f'--user-data-dir={home}/edge-x11'], X11),
]
# More applications, as a JSON list of [name, colour scheme, command, runs under Xwayland, clicks]. The clicks,
# [[x, y], ...] in stage coordinates, are made before the capture, to get past a first-run screen.
CLICKS = {}
for name, scheme, command, x11, *clicks in json.loads(os.environ.get('CORPUS_EXTRA') or '[]'):
    CASES.append((name, scheme, command, X11 if x11 else {}))
    CLICKS[name] = clicks[0] if clicks else []


def call(path, interface, method, parameters=None, destination='org.gnome.Shell'):
    return bus.call_sync(destination, path, interface, method, parameters, None, Gio.DBusCallFlags.NONE, 30000, None).unpack()


def step(value):
    return json.loads(call('/io/github/karazum/CapIt/Test', 'io.github.karazum.CapIt.Test', 'Step',
                           GLib.Variant('(s)', (json.dumps(value),)))[0])


def status():
    return json.loads(call('/io/github/karazum/CapIt', 'io.github.karazum.CapIt', 'GetStatus')[0])


def apply_scale(value):
    def display(method, params=None):
        return call('/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method, params,
                    destination='org.gnome.Mutter.DisplayConfig')
    serial, monitors, _, _ = display('GetCurrentState')
    connector = monitors[0][0][0]
    mode = next(mode for mode in monitors[0][1] if mode[6].get('is-current'))
    if value not in mode[5]:
        raise SystemExit(f'output does not advertise scale {value}: {mode[5]}')
    display('ApplyMonitorsConfig', GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
            (serial, 1, [(0, 0, value, 0, True, [(connector, mode[0], {})])], {'layout-mode': GLib.Variant('u', 1)})))


def tree(frame):
    """Every showing element under frame. @return [Array<Hash>] role, name, depth and window-relative rect"""
    found = []

    def walk(node, depth):
        if node is None or depth > 60 or len(found) > 6000:
            return
        try:
            states = node.get_state_set()
            if not (states.contains(Atspi.StateType.SHOWING) and states.contains(Atspi.StateType.VISIBLE)):
                return
            extents = node.get_extents(Atspi.CoordType.WINDOW)
            found.append({'role': node.get_role_name(), 'name': (node.get_name() or '')[:60], 'depth': depth,
                          'rect': [extents.x, extents.y, extents.width, extents.height]})
            for index in range(min(node.get_child_count(), 400)):
                walk(node.get_child_at_index(index), depth + 1)
        except GLib.Error:
            pass

    walk(frame, 0)
    return found


def frames(known):
    desktop = Atspi.get_desktop(0)
    found = []
    for index in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(index)
            if app is None or app.get_name() in ('gnome-shell', 'mutter-x11-frames') or app.get_name() in known:
                continue
            found += [app.get_child_at_index(child) for child in range(app.get_child_count())]
        except GLib.Error:
            continue
    return [frame for frame in found if frame is not None]


def record(name, scheme, command, environment):
    subprocess.run(['gsettings', 'set', 'org.gnome.desktop.interface', 'color-scheme', scheme], check=True)
    time.sleep(.5)
    process = subprocess.Popen(command, env={**os.environ, **environment}, stdout=subprocess.DEVNULL,
                               stderr=open(out / f'{name}-{scale}.log', 'w'), start_new_session=True)
    try:
        window = None
        for attempt in range(150):
            time.sleep(.2)
            window = next((frame for frame in frames(()) if frame.get_extents(Atspi.CoordType.WINDOW).width > 200), None)
            if window:
                break
        # Lets the window finish its first layout, thumbnails and font loading.
        time.sleep(5)
        for x, y in CLICKS.get(name, []):
            for action in ({}, {'button': 'press'}, {'button': 'release'}):
                step({'type': 'pointer', 'x': x, 'y': y, **action})
                time.sleep(.3)
            time.sleep(2)
        elements = tree(window) if window else []
        (runtime / 'stream.bin').unlink(missing_ok=True)
        call('/io/github/karazum/CapIt', 'io.github.karazum.CapIt', 'Capture')
        for attempt in range(150):
            current = status()
            if current['active'] and current['panels'] != 'pending':
                break
            time.sleep(.1)
        inspected = step({'type': 'inspect'})
        step({'type': 'cancel'})
        time.sleep(.5)
        if not (runtime / 'stream.bin').exists() or not inspected.get('windows'):
            print(f'{name}: no window captured ({len(elements)} accessible elements)', flush=True)
            return
        shutil.move(runtime / 'stream.bin', out / f'{name}-{scale}.stream')
        (out / f'{name}-{scale}.json').write_text(json.dumps({'name': name, 'scale': inspected['scale'],
            'windows': inspected['windows'], 'owners': inspected['owners'], 'elements': elements}))
        print(f'{name}: {len(inspected["windows"])} windows, {len(elements)} accessible elements', flush=True)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for attempt in range(40):
            time.sleep(.25)
            remaining = frames(())
            if not remaining:
                break
            if attempt == 8:
                # A window served by another process than the one started, as a terminal's is.
                for frame in remaining:
                    try:
                        os.kill(frame.get_process_id(), signal.SIGTERM)
                    except (GLib.Error, ProcessLookupError):
                        pass


for attempt in range(60):
    try:
        if call('/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'GetExtensionInfo',
                GLib.Variant('(s)', (UUID,)), destination='org.gnome.Shell.Extensions')[0]:
            break
    except GLib.Error:
        pass
    time.sleep(.1)
call('/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'EnableExtension', GLib.Variant('(s)', (UUID,)),
     destination='org.gnome.Shell.Extensions')
time.sleep(1)
if scale != 1:
    apply_scale(scale)
    time.sleep(1)
# A fresh session opens in the overview, where windows are drawn as thumbnails.
bus.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.freedesktop.DBus.Properties', 'Set',
              GLib.Variant('(ssv)', ('org.gnome.Shell', 'OverviewActive', GLib.Variant('b', False))), None,
              Gio.DBusCallFlags.NONE, 30000, None)
time.sleep(1)
Atspi.init()
Atspi.set_timeout(2000, 5000)
wanted = sys.argv[1:]
for case in CASES:
    if wanted and case[0] not in wanted:
        continue
    try:
        record(*case)
    except Exception as error:
        print(f'{case[0]}: failed: {error}', flush=True)
