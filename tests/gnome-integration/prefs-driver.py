# SPDX-License-Identifier: GPL-3.0-or-later
"""Request preferences only after the directly launched private service owns its name."""
import json
import os
from pathlib import Path
import time
from gi.repository import Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
for attempt in range(100):
    owned=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',
        GLib.Variant('(s)',('org.gnome.Shell.Extensions',)),None,Gio.DBusCallFlags.NO_AUTO_START,1000,None).unpack()[0]
    if owned: break
    time.sleep(.1)
assert owned,'Direct native preferences service never acquired its private bus name'
bus.call_sync('org.gnome.Shell.Extensions','/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','OpenExtensionPrefs',
    GLib.Variant('(ssa{sv})',('capit@karazum.github.io','',{})),None,Gio.DBusCallFlags.NO_AUTO_START,10000,None)
result_path=Path(os.environ['XDG_CACHE_HOME'])/'prefs-result.json'
for attempt in range(100):
    if result_path.exists(): break
    time.sleep(.1)
assert result_path.exists(),'Native preferences load produced no successful window callback; inspect prefs.log'
result=json.loads(result_path.read_text())
print(json.dumps(result),flush=True)
assert result.get('event')=='PREFS_ALL_PASS',result
