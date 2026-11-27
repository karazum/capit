# SPDX-License-Identifier: GPL-3.0-or-later
"""Time each stage of captures, exports and a GIF recording with the timing log, over two real application
screenshots shown as windows. Run with `run.sh --timing`; CAPIT_TIMING_CPUS and CAPIT_TIMING_QUOTA there limit the
whole session's CPU to stand in for a slower machine. Prints the median of each stage per scenario."""
import json
import os
import re
import shutil
import statistics
import time
from pathlib import Path
import gi
gi.require_version('Gdk','4.0')
gi.require_version('Gtk','4.0')
from gi.repository import Gdk, Gtk, Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'
fixtures=Path(os.environ['CAPIT_INTEGRATION_DIR']).parent/'fixtures'/'elements'
shell_log=Path(os.environ['XDG_CACHE_HOME'])/'shell.log'
rounds=int(os.environ.get('CAPIT_TIMING_ROUNDS','3'))

def call(path,interface,method,parameters=None,destination='org.gnome.Shell'):
    return bus.call_sync(destination,path,interface,method,parameters,None,Gio.DBusCallFlags.NONE,60000,None).unpack()

def log(label,value):
    print(json.dumps({'event':label,'value':value}),flush=True)

def pause(seconds=.2):
    until=time.monotonic()+seconds
    context=GLib.MainContext.default()
    while time.monotonic()<until:
        while context.pending(): context.iteration(False)
        time.sleep(.01)

def status():
    return json.loads(call('/io/github/karazum/CapIt','io.github.karazum.CapIt','GetStatus')[0])

def step(value):
    call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps(value),)))
    pause()
    return status()

def until(condition,label,seconds=60):
    for attempt in range(int(seconds*10)):
        current=status()
        if condition(current): return current
        pause(.1)
    raise AssertionError((label,current))

def drag(x1,y1,x2,y2):
    step({'type':'pointer','x':x1,'y':y1})
    step({'type':'pointer','x':x1,'y':y1,'button':'press'})
    step({'type':'pointer','x':x2,'y':y2})
    return step({'type':'pointer','x':x2,'y':y2,'button':'release'})

def timing_lines():
    return [line.split('[CapIt timing] ',1)[1] for line in shell_log.read_text(errors='replace').splitlines()
            if '[CapIt timing] ' in line]

LINE=re.compile(r'^(.+?) \d+ · (.+?): ([\d.]+) ms \(total ([\d.]+) ms\)')

def summarise(lines):
    """{'capture': {'snapshot': [lap ms, ...]}, ...} for the given timing lines; window numbers are folded together,
    so 'window N detected' gathers every window."""
    stages={}
    for line in lines:
        match=LINE.match(line)
        if not match: continue
        name,stage,lap,total=match.groups()
        stage=re.sub(r'\d+','N',stage)
        stages.setdefault(name,{}).setdefault(stage,[]).append((float(lap),float(total)))
    return {name:{stage:{'median_ms':round(statistics.median(lap for lap,_ in values),1),
                         'median_total_ms':round(statistics.median(total for _,total in values),1),
                         'count':len(values)} for stage,values in found.items()} for name,found in stages.items()}

for attempt in range(60):
    try:
        if call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','GetExtensionInfo',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')[0]: break
    except GLib.Error: pass
    pause(.1)
call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','EnableExtension',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')
for attempt in range(200):
    try:
        if status()['version']==1: break
    except GLib.Error: pass
    pause(.1)

# Two real application screenshots as windows, so detection has real panels to find.
Gtk.init()
windows=[]
for name in ['ide-xwayland-1.25.png','settings-dark-1.25.png']:
    window=Gtk.Window(title=f'CapIt timing source {name}')
    picture=Gtk.Picture.new_for_filename(str(fixtures/name))
    picture.set_can_shrink(False)
    window.set_child(picture)
    window.present()
    windows.append(window)
    # Mapped one after the other, so Mutter places the second beside the first rather than over it.
    pause(1.5)

output=Path(os.environ['XDG_CACHE_HOME'])/'timing-output'
output.mkdir()
step({'type':'settings','directory':str(output),'clipboardContent':'content','timingLog':True})
scenarios={}
for round_number in range(rounds):
    for mode in ['visual']:
        before=len(timing_lines())
        step({'type':'settings','elementDetection':mode})
        call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
        until(lambda s:s['active'],'overlay')
        until(lambda s:s['panels']!='pending','detection',120)
        drag(200,150,1400,900)
        for operation in [{'kind':'arrow','x1':300,'y1':300,'x2':700,'y2':500},
                          {'kind':'rectangle','x1':800,'y1':300,'x2':1100,'y2':600},
                          {'kind':'blur','x1':400,'y1':600,'x2':900,'y2':800}]:
            step({'type':'annotate','operation':{**operation,'color':'#ff595e','width':4}})
        step({'type':'key','key':'Return'})
        current=until(lambda s:not s['active'],'export',120)
        assert current['lastResult'].get('copy')=='success' and current['lastResult'].get('save')=='success',current
        scenarios.setdefault(f'screenshot, {mode} detection',[]).extend(timing_lines()[before:])
    if shutil.which('ffmpeg'):
        before=len(timing_lines())
        step({'type':'record','mode':'gif'})
        until(lambda s:s['active'],'record overlay')
        drag(300,200,900,600)
        step({'type':'key','key':'Return'})
        until(lambda s:(s['recording'] or {}).get('state')=='recording','recording started',60)
        pause(2)
        step({'type':'stop-recording'})
        until(lambda s:s['recording'] is None,'recording finished',180)
        scenarios.setdefault('GIF recording, 600x400 for 2 s',[]).extend(timing_lines()[before:])
lines=timing_lines()
log('machine',lines[0])
log('cpu-limit',{'cpus':os.environ.get('CAPIT_TIMING_CPUS'),'quota':os.environ.get('CAPIT_TIMING_QUOTA')})
for name,found in scenarios.items():
    log('scenario',{'name':name,'rounds':rounds,'stages':summarise(found)})
log('timing-lines',lines)
log('TIMING_DONE',len(lines))
