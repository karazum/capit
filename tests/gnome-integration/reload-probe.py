# SPDX-License-Identifier: GPL-3.0-or-later
import json
import os
from pathlib import Path
import time
from gi.repository import Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'
checkout=Path(os.environ['CAPIT_CHECKOUT'])
runtime=Path(os.environ['XDG_RUNTIME_DIR'])

def call(path,interface,method,parameters=None,destination='org.gnome.Shell'):
    return bus.call_sync(destination,path,interface,method,parameters,None,Gio.DBusCallFlags.NONE,10000,None).unpack()

def log(label,value):
    print(json.dumps({'event':label,'value':value}),flush=True)

def extensions(method):
    return call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions',method,GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')

def info():
    value=extensions('GetExtensionInfo')[0]
    return {'state':value.get('state'),'error':value.get('error')}

def status():
    try:
        return json.loads(call('/io/github/karazum/CapIt','io.github.karazum.CapIt','GetStatus')[0])
    except GLib.Error:
        return None

# Same toggle as `make reload`; ACTIVE is state 1.
def reload():
    extensions('DisableExtension')
    time.sleep(.5)
    extensions('EnableExtension')
    time.sleep(1)
    current={'info':info(),'status':status()}
    log('reload',current)
    return current

for attempt in range(60):
    try:
        if extensions('GetExtensionInfo')[0]: break
    except GLib.Error: pass
    time.sleep(.1)
extensions('EnableExtension')
time.sleep(1)
assert info()['state']==1 and status()['version']==1,(info(),status())
log('PASS','symlinked checkout loads')

# Both the top module and a module it imports must come back fresh: a stale model.js lacks the new export, which
# makes the edited capit.js fail to load.
model=checkout/'model.js'
model.write_text(model.read_text()+'\nexport const reloadProbe = 2;\n')
capit=checkout/'capit.js'
original=capit.read_text()
assert original.count('version: 1, active:')==1
edited="import {reloadProbe} from './model.js';\n"+original.replace('version: 1, active:','version: reloadProbe, active:')
capit.write_text(edited)
current=reload()
assert current['info']['state']==1 and current['status']['version']==2,current
assert not list(runtime.glob('capit-modules-*'))
log('PASS','disable/enable runs edited capit.js and model.js, and removes the module copy')

# The overlay, built entirely from the reloaded modules, opens and cancels.
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
for attempt in range(60):
    current=status()
    if current['active'] or (current['lastResult'] or {}).get('error'): break
    time.sleep(.1)
assert current['active'],current
call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps({'type':'cancel'}),)))
assert not status()['active']
log('PASS','a capture overlay opens from the reloaded code')

# A broken checkout must leave the extension enabled, so fixing it and reloading recovers without a login.
capit.write_text(edited+'\n}}}\n')
current=reload()
assert current['info']['state']==1 and current['status'] is None,current
capit.write_text(edited)
current=reload()
assert current['info']['state']==1 and current['status']['version']==2,current
log('PASS','a load error keeps the extension enabled and the next reload recovers')
log('ALL_PASS','Symlinked checkout reloads without a login')
