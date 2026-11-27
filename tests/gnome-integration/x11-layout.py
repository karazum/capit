# SPDX-License-Identifier: GPL-3.0-or-later
"""Prepares the X11 session: lays out its monitors through Mutter, as a user's display settings would, and closes
the overview.

Mutter starts each dummy output at its preferred mode, the driver's largest. This applies one monitor per
--virtual-monitor=WxH in CAPIT_INTEGRATION_MONITORS, left to right, the first primary, at the scale in CAPIT_X11_SCALE
(default 1), which X11 applies to every monitor alike. With --list it only prints what Mutter offers.
"""
import json
import os
import sys
import time

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def display_config(method, parameters=None):
    return bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                         'org.gnome.Mutter.DisplayConfig', method, parameters, None, Gio.DBusCallFlags.NONE,
                         10000, None).unpack()


# Shell's bus name can appear before Mutter's display configuration does.
for attempt in range(100):
    try:
        serial, monitors, logical, properties = display_config('GetCurrentState')
        break
    except GLib.Error:
        if attempt == 99:
            raise
        time.sleep(0.1)
if '--list' in sys.argv:
    print(json.dumps({'monitors': [{'connector': spec[0], 'modes': [[mode[0], mode[1], mode[2], mode[4]]
                                                                   for mode in modes]}
                                   for spec, modes, _ in monitors],
                      'logical': [[x, y, scale, [spec[0] for spec in specs]] for x, y, scale, _, _, specs, _ in logical],
                      'properties': {key: str(value) for key, value in properties.items()}}, indent=1))
    raise SystemExit(0)
sizes = [monitor.split('=', 1)[1].split('@')[0] for monitor in os.environ['CAPIT_INTEGRATION_MONITORS'].split()]
scale = float(os.environ.get('CAPIT_X11_SCALE') or 1)
connectors = sorted((spec[0] for spec, _, _ in monitors), key=lambda name: int(name.removeprefix('DUMMY')))
layout = []
left = 0
for index, size in enumerate(sizes):
    width, height = (int(value) for value in size.split('x'))
    connector = connectors[index]
    modes = next(modes for spec, modes, _ in monitors if spec[0] == connector)
    mode = next(mode[0] for mode in modes if (mode[1], mode[2]) == (width, height))
    layout.append((left, 0, scale, 0, index == 0, [(connector, mode, {})]))
    # Physical layout, the only one X11 has: positions are in device pixels.
    left += width
# Method 1 applies the layout for this session without saving it.
display_config('ApplyMonitorsConfig', GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (serial, 1, layout, {})))
print(f'Laid out {sizes} at scale {scale}', file=sys.stderr)


def overview(value=None):
    """Whether Shell's overview is open, after closing it when `value` is False."""
    properties = ('org.gnome.Shell', '/org/gnome/Shell', 'org.freedesktop.DBus.Properties')
    if value is not None:
        bus.call_sync(*properties, 'Set', GLib.Variant('(ssv)', ('org.gnome.Shell', 'OverviewActive',
                                                                 GLib.Variant('b', value))),
                      None, Gio.DBusCallFlags.NONE, 10000, None)
    return bus.call_sync(*properties, 'Get', GLib.Variant('(ss)', ('org.gnome.Shell', 'OverviewActive')),
                         None, Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]


# Shell opens the overview at startup. On Wayland the first window to appear takes focus and closes it; on X11 a
# window started without a launch timestamp does not, so the overview would stay over the test window.
# Shell's bus name can appear before its object is exported.
for attempt in range(100):
    try:
        if not overview(False):
            break
    except GLib.Error:
        pass
    time.sleep(0.1)
else:
    raise SystemExit('The overview did not close')
