# SPDX-License-Identifier: GPL-3.0-or-later
# CapIt on an X11 session at 200%. X11 has no logical pixels: the stage is in device pixels and Shell draws its own
# interface twice as large. The capture, the smart box and the export stay in device pixels, and the toolbar grows.
# The test window is drawn at 200% too, as GTK applications are on a HiDPI desktop.
import io
import json
import os
from pathlib import Path
import time
import cairo

# A desktop session tells GTK its scale through XSETTINGS, which this one does not run; GTK reads this when it loads.
os.environ['GDK_SCALE']='2'
# The window must expose an accessibility tree for the accessibility element finder to read.
os.environ.pop('GTK_A11Y',None)
import gi
gi.require_version('Gdk','4.0')
gi.require_version('Gtk','4.0')
from gi.repository import Gdk, Gtk, Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'
output=Path(os.environ['XDG_RUNTIME_DIR'])/'output'

def call(path,interface,method,parameters=None,destination='org.gnome.Shell'):
    return bus.call_sync(destination,path,interface,method,parameters,None,Gio.DBusCallFlags.NONE,10000,None).unpack()

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

def inspect():
    return json.loads(call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',
                           GLib.Variant('(s)',(json.dumps({'type':'inspect'}),)))[0])

def click(x,y):
    step({'type':'pointer','x':x,'y':y})
    step({'type':'pointer','x':x,'y':y,'button':'press'})
    return step({'type':'pointer','x':x,'y':y,'button':'release'})

def until(condition,label,seconds=15):
    for attempt in range(int(seconds*10)):
        current=status()
        if condition(current): return current
        pause(.1)
    raise AssertionError(f'timed out waiting for {label}: {current}')

serial,monitors,logical,properties=call('/org/gnome/Mutter/DisplayConfig','org.gnome.Mutter.DisplayConfig',
                                        'GetCurrentState',destination='org.gnome.Mutter.DisplayConfig')
log('logical-monitors',[[x,y,scale] for x,y,scale,*_ in logical])
assert [scale for _,_,scale,*_ in logical]==[2.0,2.0],logical

call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','EnableExtension',GLib.Variant('(s)',(uuid,)),
     destination='org.gnome.Shell.Extensions')
for attempt in range(100):
    try:
        if status()['version']==1: break
    except GLib.Error: pass
    pause(.1)

Gtk.init()
window=Gtk.Window(title='CapIt X11 scale source')
style=Gtk.CssProvider()
style.load_from_string('.capit-sidebar { background-color: #303030; }')
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),style,Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
sidebar=Gtk.Box(css_classes=['capit-sidebar'])
sidebar.set_size_request(300,-1)
layout=Gtk.Box()
layout.append(sidebar)
layout.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL))
content=Gtk.Label(label='Synthetic integration source at 200%')
content.set_hexpand(True)
layout.append(content)
window.set_child(layout)
window.present()
# On X11 a fullscreen request made before the window is mapped can be lost.
pause(1)
monitor=Gdk.Display.get_default().get_monitors().get_item(0)
window.fullscreen_on_monitor(monitor)
pause(1.5)
# At 200% GTK keeps drawing at its old size, here 550x16, until an input event reaches it.
click(400,300)
pause(.5)
surface,geometry=window.get_surface(),monitor.get_geometry()
assert [surface.get_width(),surface.get_height()]==[geometry.width,geometry.height],(surface.get_width(),geometry.width)
step({'type':'settings','directory':str(output)})

log('gtk-scale',window.get_surface().get_scale_factor())
assert window.get_surface().get_scale_factor()==2

def panels_settled():
    return until(lambda s:s['panels']!='pending','detection',60)

def sidebar(selection):
    return selection['x']==0 and selection['y']==0 and selection['height']==1440 and abs(selection['width']-600)<=6

# The 300 px sidebar is 600 device pixels wide; scrolling out from it reaches the whole window.
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
current=until(lambda s:s['active'],'overlay')
assert current['scale']==1,current
assert panels_settled()['panels']=='ready'
step({'type':'pointer','x':200,'y':700})
selection=click(200,700)['selection']
assert sidebar(selection),selection
step({'type':'key','key':'Escape'})
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
until(lambda s:s['active'],'overlay')
assert panels_settled()['panels']=='ready'
step({'type':'pointer','x':200,'y':700})
step({'type':'pointer','x':200,'y':700,'scroll':'up'})
current=click(200,700)
assert current['selection']=={'x':0,'y':0,'width':2560,'height':1440},current
step({'type':'key','key':'Escape'})
log('PASS','a smart click selects the sidebar, and scrolling out the whole window, in device pixels')

# Visual detection and the accessibility tree find the same sidebar.
for mode in ['visual','accessibility']:
    step({'type':'settings','elementDetection':mode})
    call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
    until(lambda s:s['active'],'overlay')
    assert panels_settled()['panels']=='ready'
    step({'type':'pointer','x':200,'y':700})
    pause(1)
    selection=click(200,700)['selection']
    log(f'sidebar-{mode}',selection)
    assert sidebar(selection),selection
    step({'type':'key','key':'Escape'})
step({'type':'settings','elementDetection':'visual'})
log('PASS','visual detection and the accessibility tree find the same sidebar')

call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
until(lambda s:s['active'],'overlay')
region={'x':200,'y':100,'width':800,'height':500}
step({'type':'select','rect':region})
toolbar=inspect()['toolbar']
log('toolbar',toolbar)
(left,top),(width,height)=toolbar['position'],toolbar['size']
# Twice the 59 px it is at 100%, and on the region's monitor.
assert height>=100 and left>=0 and top>=0 and left+width<=2560 and top+height<=1440,toolbar
log('PASS','the toolbar is drawn at twice the size and stays on the monitor')

step({'type':'annotate','operation':{'kind':'redact','x1':300,'y1':200,'x2':400,'y2':300,'color':'#75bbff'}})
step({'type':'finish','outputs':['save']})
current=until(lambda s:not s['active'],'export')
saved=Path(current['lastResult']['savedPath'])
image=cairo.ImageSurface.create_from_png(str(saved))
def pixel(x,y):
    offset=y*image.get_stride()+x*4
    return list(bytes(image.get_data()[offset:offset+3]))
log('export',{'size':[image.get_width(),image.get_height()],'redacted':pixel(150,150),'outside':pixel(50,50)})
assert [image.get_width(),image.get_height()]==[800,500]
# Bytes are blue, green, red.
assert pixel(150,150)==[0xff,0xbb,0x75] and pixel(50,50)!=[0xff,0xbb,0x75],(pixel(150,150),pixel(50,50))
log('PASS','the export is the region in device pixels, with a redaction where it was drawn')
