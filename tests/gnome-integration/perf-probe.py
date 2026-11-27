# SPDX-License-Identifier: GPL-3.0-or-later
"""Measure stage frame rate while the pointer moves, with and without the capture overlay."""
import json
import math
import os
import time
import gi
gi.require_version('Gdk','4.0')
gi.require_version('Gtk','4.0')
from gi.repository import Gdk, Gtk, Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'

def call(path,interface,method,parameters=None,destination='org.gnome.Shell'):
    return bus.call_sync(destination,path,interface,method,parameters,None,Gio.DBusCallFlags.NONE,30000,None).unpack()

def log(label,value):
    print(json.dumps({'event':label,'value':value}),flush=True)

def pause(seconds=.2):
    until=time.monotonic()+seconds
    context=GLib.MainContext.default()
    while time.monotonic()<until:
        while context.pending(): context.iteration(False)
        time.sleep(.01)

def step(value):
    return json.loads(call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps(value),)))[0])

def sweep(label,seconds=3,press=None,release=None,center=(1800,1000),reach=(1400,700)):
    """Move the pointer along a path that crosses the test window's edges, optionally holding the button from
    `press` until `release`, then report the primary view's frame rate and how many motion events the shell kept up with."""
    step({'type':'frames'})
    if press:
        step({'type':'pointer','x':press[0],'y':press[1]})
        step({'type':'pointer','x':press[0],'y':press[1],'button':'press'})
    start=time.monotonic()
    events=0
    while time.monotonic()-start<seconds:
        t=time.monotonic()-start
        step({'type':'pointer','x':center[0]+reach[0]*math.sin(t*2.1),'y':center[1]+reach[1]*math.sin(t*3.3)})
        events+=1
        time.sleep(.01)
    elapsed=time.monotonic()-start
    if release:
        step({'type':'pointer','x':release[0],'y':release[1],'button':'release'})
    paints=step({'type':'frames'})['frames']
    # The pointer path stays on the primary output, the only view wider than 2560 px.
    frames=[stamp for stamp,width in paints if width>2560]
    gaps=[(b-a)/1000 for a,b in zip(frames,frames[1:])]
    result={'label':label,'seconds':round(elapsed,2),'motion_events_per_s':round(events/elapsed,1),
        'fps':round(len(frames)/elapsed,1),'worst_frame_ms':round(max(gaps,default=0),1),
        'median_frame_ms':round(sorted(gaps)[len(gaps)//2],1) if gaps else None}
    log('sweep',result)
    return result

for attempt in range(60):
    try:
        info=call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','GetExtensionInfo',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')[0]
        if info: break
    except GLib.Error: pass
    pause(.1)

def apply_scale(scale):
    """Put the primary output at a fractional scale and the rest in a row to its right, like a mixed-DPI desk."""
    def display(method,params=None):
        return call('/org/gnome/Mutter/DisplayConfig','org.gnome.Mutter.DisplayConfig',method,params,destination='org.gnome.Mutter.DisplayConfig')
    serial,monitors,_,_=display('GetCurrentState')
    current=[(monitor[0][0],next(mode for mode in monitor[1] if mode[6].get('is-current'))) for monitor in monitors]
    supported=current[0][1][5]
    if scale not in supported:
        raise SystemExit(f'primary output does not advertise scale {scale}: {supported}')
    configs,x=[],0
    for index,(connector,mode) in enumerate(current):
        output_scale=scale if index==0 else 1.0
        configs.append((x,0,output_scale,0,index==0,[(connector,mode[0],{})]))
        x+=round(mode[1]/output_scale)
    display('ApplyMonitorsConfig',GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',(serial,1,configs,{'layout-mode':GLib.Variant('u',1)})))
    _,_,logical,_=display('GetCurrentState')
    log('layout',[{'x':l[0],'y':l[1],'scale':l[2]} for l in logical])

call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','EnableExtension',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')
pause(1)
if float(os.environ.get('CAPIT_PERF_SCALE','1'))!=1:
    apply_scale(float(os.environ['CAPIT_PERF_SCALE']))
    pause(1)
Gtk.init()
window=Gtk.Window(title='CapIt perf probe window')
window.set_default_size(1600,1000)
window.set_child(Gtk.Label(label='Synthetic perf source'))
window.present()
pause(1)

baseline=sweep('pointer only')
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
for attempt in range(100):
    if step({'type':'frames'})['active']: break
    pause(.1)
results=[sweep('overlay hover')]
results.append(sweep('drag out a region',press=(200,150),release=(3400,1700)))
assert step({'type':'frames'})['selection'],'the drag did not select a region'
step({'type':'key','key':'r'})
results.append(sweep('draw a rectangle',press=(500,400),release=(1100,800),center=(900,650),reach=(300,200)))
assert step({'type':'frames'})['annotations']==1,'the rectangle was not drawn'
# An in-progress annotation repaints its whole bounding box, so a monitor-sized one costs more; reported, not asserted.
large=sweep('draw a monitor-sized rectangle (not asserted)',press=(400,300),release=(3400,1600))
step({'type':'key','key':'Escape'})
slow=[r for r in results if r['motion_events_per_s']<baseline['motion_events_per_s']*.8 or r['worst_frame_ms']>50]
assert not slow,f"overlay falls behind pointer-only ({baseline['motion_events_per_s']} events/s): {slow}"
log('PASS','the overlay keeps up with the pointer')

# Panel detection reads each window's pixels back from the GPU on Shell's main thread, which a pointer sweep started
# after the overlay opens can miss. Measured directly on a window the size of a full-width IDE, read back in bands.
window.set_default_size(3900,1650)
window.unmaximize()
pause(1)
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
for attempt in range(100):
    current=step({'type':'frames'})
    if current['active'] and current['panels']!='pending': break
    pause(.1)
inspected=step({'type':'inspect'})
log('panel-readback',{'panels':current['panels'],'scale':current['scale'],'readbacks_px_ms':inspected['readbacks']})
step({'type':'key','key':'Escape'})
assert current['panels']=='ready',current
assert inspected['readbacks'] and max(ms for _,_,ms in inspected['readbacks'])<30,inspected['readbacks']
log('PASS','panel detection reads window pixels back without holding up a frame')
