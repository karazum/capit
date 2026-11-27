# SPDX-License-Identifier: GPL-3.0-or-later
import io
import json
import os
from pathlib import Path
import time
import cairo
import gi
gi.require_version('Gdk','4.0')
gi.require_version('Gtk','4.0')
from gi.repository import Gdk, Gtk, Gio, GLib

# The window must expose an accessibility tree for the accessibility element finder to read.
os.environ.pop('GTK_A11Y',None)
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'
runtime=Path(os.environ['XDG_RUNTIME_DIR'])
output=runtime/'output'

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
    current=status()
    log('step',{'request':value,'status':current})
    return current

def inspect():
    return json.loads(call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps({'type':'inspect'}),)))[0])

def center(actor):
    return [actor['position'][0]+actor['size'][0]/2,actor['position'][1]+actor['size'][1]/2]

def capture():
    call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
    for attempt in range(60):
        current=status()
        if current['active'] or (not current['acquiring'] and current['lastResult'] and current['lastResult'].get('error')): break
        pause(.1)
    log('capture',current)
    assert current['active'],current
    return current

def click(x,y):
    step({'type':'pointer','x':x,'y':y})
    step({'type':'pointer','x':x,'y':y,'button':'press'})
    return step({'type':'pointer','x':x,'y':y,'button':'release'})

def panels_settled():
    for attempt in range(100):
        current=status()
        if current['panels']!='pending': break
        pause(.1)
    log('panels',current['panels'])
    assert current['panels']=='ready',current
    return current

def drag():
    step({'type':'pointer','x':1100,'y':250})
    step({'type':'pointer','x':1100,'y':250,'button':'press'})
    step({'type':'pointer','x':1500,'y':500})
    current=step({'type':'pointer','x':1500,'y':500,'button':'release'})
    assert current['selection']=={'x':1100,'y':250,'width':400,'height':250},current

def completed():
    for attempt in range(100):
        current=status()
        if not current['active'] or current['phase']=='recovery': break
        pause(.1)
    log('finished',current)
    return current

def read_stream(stream,done):
    """Reads `stream` to its end without blocking, then calls done(payload=bytes) or done(error=str). On X11, GTK
    fills a clipboard stream from selection events, which a blocking read would keep the main loop from handling."""
    payload=bytearray()
    def chunk(source,request):
        try:
            data=source.read_bytes_finish(request).get_data()
        except Exception as error:
            done(error=str(error))
            return
        if not data:
            done(payload=bytes(payload))
            return
        payload.extend(data)
        source.read_bytes_async(1048576,GLib.PRIORITY_DEFAULT,None,chunk)
    stream.read_bytes_async(1048576,GLib.PRIORITY_DEFAULT,None,chunk)

def read_text_clipboard(mime):
    click(400,300)
    pause(.3)
    clipboard=Gdk.Display.get_default().get_clipboard()
    result={}
    def ready(clipboard,request):
        try:
            stream,chosen=clipboard.read_finish(request)
            read_stream(stream,lambda payload=None,error=None:result.update(error=error) if error else result.update(mime=chosen,payload=payload.decode()))
        except Exception as error:
            result.update(error=str(error))
    clipboard.read_async([mime],GLib.PRIORITY_DEFAULT,None,ready)
    for attempt in range(50):
        if result: break
        pause(.1)
    assert result.get('mime')==mime,result
    return result['payload']

def read_clipboard():
    click(400,300)
    pause(.3)
    clipboard=Gdk.Display.get_default().get_clipboard()
    result={}
    def ready(clipboard,request):
        try:
            stream,mime=clipboard.read_finish(request)
            read_stream(stream,lambda payload=None,error=None:result.update(error=error) if error else result.update(mime=mime,payload=payload))
        except Exception as error:
            result.update(error=str(error))
    clipboard.read_async(['image/png'],GLib.PRIORITY_DEFAULT,None,ready)
    for attempt in range(50):
        if result: break
        pause(.1)
    assert 'payload' in result,result
    surface=cairo.ImageSurface.create_from_png(io.BytesIO(result['payload']))
    pixel=bytes(surface.get_data()[30*surface.get_stride()+30*4:30*surface.get_stride()+30*4+4])
    log('clipboard-native-read',{'mime':result['mime'],'bytes':len(result['payload']),'size':[surface.get_width(),surface.get_height()],'redaction_sample_bgra':list(pixel)})
    assert [surface.get_width(),surface.get_height()]==[400,250]
    # The redaction, in the default colour #ff595e, as BGRA.
    assert list(pixel)==[0x5e,0x59,0xff,255],list(pixel)
    return result['payload']

for attempt in range(60):
    try:
        info=call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','GetExtensionInfo',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')[0]
        if info: break
    except GLib.Error: pass
    pause(.1)
log('enabled',call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','EnableExtension',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions'))
pause(1)
info=call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','GetExtensionInfo',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')[0]
log('extension-info',{'state':info.get('state'),'enabled':info.get('enabled'),'error':info.get('error')})
assert info.get('state')==1 and not info.get('error'),info
Gtk.init()
window=Gtk.Window(title='CapIt isolated synthetic integration window')
window.set_child(Gtk.Label(label='Synthetic integration source — private headless session'))
window.fullscreen_on_monitor(Gdk.Display.get_default().get_monitors().get_item(0))
window.present()

def refullscreen():
    # GNOME 45 keeps drawing a fullscreen window at its old offset after its content is replaced, while reporting
    # it at the monitor's corner, and on X11 a fullscreen request made before the window is mapped can be lost.
    # Leaving and entering fullscreen again draws it in place.
    monitor=Gdk.Display.get_default().get_monitors().get_item(0)
    for attempt in range(5):
        window.unfullscreen()
        pause(.5)
        window.fullscreen_on_monitor(monitor)
        pause(1)
        surface,geometry=window.get_surface(),monitor.get_geometry()
        if window.is_fullscreen() and [surface.get_width(),surface.get_height()]==[geometry.width,geometry.height]:
            return
    raise AssertionError('the test window did not go fullscreen')
pause(1)
refullscreen()
click(400,300)
# The PNG checks below read image data, so the clipboard gets content; file mode is checked separately.
step({'type':'settings','directory':str(output),'clipboardContent':'content'})

# Real Meta window-frame smart click and native Escape.
assert capture()['candidates']>=1
panels_settled()
current=click(400,300)
assert current['selection']=={'x':0,'y':0,'width':1280,'height':720},current
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','native smart-window click and Escape')

# A detected panel is the smart box under the pointer; scrolling up widens it back to the whole window.
style=Gtk.CssProvider()
style.load_from_string('.capit-sidebar { background-color: #303030; }')
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),style,Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
plain=window.get_child()
sidebar=Gtk.Box(css_classes=['capit-sidebar'])
sidebar.set_size_request(300,-1)
layout=Gtk.Box()
window.set_child(None)
layout.append(sidebar)
layout.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL))
layout.append(plain)
plain.set_hexpand(True)
window.set_child(layout)
pause(1)
refullscreen()
capture()
panels_settled()
current=click(100,300)
selection=current['selection']
assert selection['x']==0 and selection['y']==0 and selection['height']==720 and abs(selection['width']-300)<=3,current
step({'type':'key','key':'Escape'})
capture()
panels_settled()
step({'type':'pointer','x':100,'y':300})
step({'type':'pointer','x':100,'y':300,'scroll':'up'})
current=click(100,300)
assert current['selection']=={'x':0,'y':0,'width':1280,'height':720},current
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','detected panel click and scroll out to the window')

# The accessibility tree: the application reports the element under the pointer, here the sidebar box.
step({'type':'settings','elementDetection':'accessibility'})
capture()
assert panels_settled()['elementDetection']=='accessibility'
step({'type':'pointer','x':100,'y':300})
pause(1)
current=click(100,300)
assert current['selection']=={'x':0,'y':0,'width':300,'height':720},current
assert not step({'type':'key','key':'Escape'})['active']
step({'type':'settings','elementDetection':'none'})
capture()
assert status()['panels']=='off'
current=click(100,300)
assert current['selection']=={'x':0,'y':0,'width':1280,'height':720},current
assert not step({'type':'key','key':'Escape'})['active']
step({'type':'settings','elementDetection':'visual'})
log('PASS','accessibility-tree element and detection off')
layout.remove(plain)
window.set_child(plain)
pause(1)
refullscreen()

# Native drag spans the virtual output boundary; first Enter commits text only.
capture()
drag()
ui=inspect()
click(*center(ui['buttons']['redact']))
ui=inspect()
log('toolbar-after-click',ui)
assert ui['tool']=='redact',ui
step({'type':'pointer','x':1120,'y':270})
step({'type':'pointer','x':1120,'y':270,'button':'press'})
step({'type':'pointer','x':1170,'y':320})
assert step({'type':'pointer','x':1170,'y':320,'button':'release'})['annotations']==1
log('PASS','native toolbar Redact button and native annotation drag')
assert step({'type':'text','x':1200,'y':350,'text':'Synthetic alpha'})['textEntry']
current=step({'type':'key','key':'Return'})
assert current['active'] and not current['textEntry'] and current['annotations']==2,current
step({'type':'key','key':'Return'})
current=completed()
assert not current['active'] and current['lastResult']['copy']=='success' and current['lastResult']['save']=='success',current
saved=Path(current['lastResult']['savedPath'])
assert saved.is_relative_to(output) and saved.is_file(),saved
payload=read_clipboard()
assert saved.read_bytes()==payload
log('PASS','cross-output native drag, text Enter, default copy+save, byte-identical native clipboard PNG, opaque redaction')

# Explicit copy-only and save-only paths.
capture();drag()
step({'type':'annotate','operation':{'kind':'redact','x1':1120,'y1':270,'x2':1170,'y2':320}})
step({'type':'finish','outputs':['copy']})
current=completed()
assert not current['active'] and current['lastResult']['copy']=='success' and current['lastResult']['save']=='none',current
read_clipboard()
log('PASS','copy-only native PNG')

# Quick capture copies and saves as soon as a smart box is clicked or a drag ends, without the annotation step.
step({'type':'settings','quickCapture':True})
capture()
panels_settled()
click(400,300)
current=completed()
assert not current['active'] and current['lastResult']['copy']=='success' and current['lastResult']['save']=='success',current
assert Path(current['lastResult']['savedPath']).is_file(),current
capture()
step({'type':'pointer','x':1100,'y':250})
step({'type':'pointer','x':1100,'y':250,'button':'press'})
step({'type':'pointer','x':1500,'y':500})
step({'type':'pointer','x':1500,'y':500,'button':'release'})
current=completed()
assert not current['active'] and current['lastResult']['save']=='success',current
# The toolbar stays hidden while the export runs, and shows when saving fails so the capture can be retried.
invalid_quick=output/'not-a-directory-quick'
invalid_quick.write_text('x')
step({'type':'settings','directory':str(invalid_quick)})
capture()
click(400,300)
current=completed()
assert current['active'] and current['phase']=='recovery' and current['lastResult']['save']=='failed',current
ui=inspect()
assert ui['toolbar']['size'][0]>0 and ui['toolbarVisible'] and ui['modesVisible'],ui
step({'type':'settings','directory':str(output)})
step({'type':'key','key':'Return'})
current=completed()
assert not current['active'] and current['lastResult']['save']=='success',current
invalid_quick.unlink()
step({'type':'settings','quickCapture':False})
log('PASS','quick capture finishes on a smart-box click and on a drag, and offers a retry when saving fails')

# The clipboard setting applies to copy and save: as a file (the default), the clipboard names the saved PNG, or a
# copy kept in the cache when saving failed. Copy only always copies the image itself.
step({'type':'settings','clipboardContent':'file'})
capture();drag()
step({'type':'finish','outputs':['copy','save']})
current=completed()
saved=Path(current['lastResult']['savedPath'])
assert current['lastResult']['copied']=='file',current
assert read_text_clipboard('text/uri-list').strip()==saved.as_uri()
capture();drag()
# read_clipboard checks for this redaction in the pasted PNG.
step({'type':'annotate','operation':{'kind':'redact','x1':1120,'y1':270,'x2':1170,'y2':320}})
step({'type':'finish','outputs':['copy']})
current=completed()
assert current['lastResult']['copied']=='content' and current['lastResult']['savedPath'] is None,current
read_clipboard()
step({'type':'settings','clipboardContent':'content'})
log('PASS','copy and save follows the clipboard setting; copy only copies the image')

# Each toolbar button with a shortcut shows it, unless the setting turns the labels off.
capture();drag()
hints=inspect()['keyHints']
log('key-hints',hints)
assert hints==['V','A','R','C','P','B','X','T','Ctrl+Z','Ctrl+Y','Ctrl+C','Ctrl+S','Esc','Enter'],hints
step({'type':'key','key':'Escape'})
step({'type':'settings','keyHints':False})
capture();drag()
assert inspect()['keyHints']==[]
step({'type':'key','key':'Escape'})
step({'type':'settings','keyHints':True})
log('PASS','shortcut labels on toolbar buttons, and none when turned off')
capture();drag()
step({'type':'finish','outputs':['save']})
current=completed()
assert not current['active'] and current['lastResult']['copy']=='none' and current['lastResult']['save']=='success',current
log('PASS','save-only PNG')

# A real filesystem failure must retain modal/document and retry only missing save.
invalid=runtime/'not-a-directory'
invalid.write_text('synthetic blocker')
step({'type':'settings','directory':str(invalid)})
capture();drag()
step({'type':'finish','outputs':['copy','save']})
current=completed()
assert current['active'] and current['phase']=='recovery' and current['lastResult']['copy']=='success' and current['lastResult']['save']=='failed',current
revision=current['revision']
step({'type':'settings','directory':str(output)})
step({'type':'key','key':'Return'})
current=completed()
assert not current['active'] and current['lastResult']['copy']=='success' and current['lastResult']['save']=='success' and current['lastResult']['revision']==revision,current
log('PASS','partial failure retains capture and native Enter retries save successfully')

# The grip drags the whole toolbar; it stays where dropped and its buttons work there. The region is on the
# 1280x720 output, the only one wide enough to leave the toolbar room to move sideways.
capture()
step({'type':'pointer','x':440,'y':150})
step({'type':'pointer','x':440,'y':150,'button':'press'})
step({'type':'pointer','x':840,'y':400})
current=step({'type':'pointer','x':840,'y':400,'button':'release'})
region={'x':440,'y':150,'width':400,'height':250}
assert current['selection']==region,current
docked=inspect()
# Unmoved, it floats 12 px under the region, centred on it.
assert docked['toolbar']['position'][1]==150+250+12,docked['toolbar']
assert abs(center(docked['toolbar'])[0]-640)<=1,docked['toolbar']
x,y=center(docked['handle'])
step({'type':'pointer','x':x,'y':y})
step({'type':'pointer','x':x,'y':y,'button':'press'})
step({'type':'pointer','x':x-20,'y':y-300})
current=step({'type':'pointer','x':x-20,'y':y-300,'button':'release'})
assert current['selection']==region and current['annotations']==0,current
moved=inspect()
log('toolbar-dragged',{'docked':docked['toolbar'],'moved':moved['toolbar']})
assert abs(moved['toolbar']['position'][0]-(docked['toolbar']['position'][0]-20))<=1,moved
assert abs(moved['toolbar']['position'][1]-(docked['toolbar']['position'][1]-300))<=1,moved
step({'type':'annotate','operation':{'kind':'redact','x1':460,'y1':170,'x2':510,'y2':220}})
assert inspect()['toolbar']['position']==moved['toolbar']['position']
click(*center(moved['buttons']['rectangle']))
assert inspect()['tool']=='rectangle'
# Dragged onto the 1024x768 output, the bar moves there with the pointer and is kept wholly inside it, or at its
# left edge when wider than it.
x,y=center(moved['handle'])
step({'type':'pointer','x':x,'y':y})
step({'type':'pointer','x':x,'y':y,'button':'press'})
step({'type':'pointer','x':1700,'y':y})
step({'type':'pointer','x':1700,'y':y,'button':'release'})
crossed=inspect()['toolbar']
log('toolbar-crossed',crossed)
assert crossed['position'][0]==1280 or 1280<crossed['position'][0]<=1280+1024-crossed['size'][0],crossed
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','toolbar drag by its grip, kept after redraw, buttons usable at the new spot, crosses outputs')

# A region reaching the bottom of its output puts the toolbar above it, clear of the size label.
capture()
step({'type':'pointer','x':1400,'y':560})
step({'type':'pointer','x':1400,'y':560,'button':'press'})
step({'type':'pointer','x':1700,'y':760})
current=step({'type':'pointer','x':1700,'y':760,'button':'release'})
above=inspect()['toolbar']
log('toolbar-above',{'selection':current['selection'],'toolbar':above})
assert above['position'][1]+above['size'][1]==current['selection']['y']-34,above
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','toolbar sits under the region, or above it when the bottom has no room')

# An arrow drawn from outside the region shows there too, under the same dim as the backdrop.
capture();drag()
points=[(1000,400),(1000,380),(1200,400)]
before={}
for x,y in points[:2]:
    step({'type':'pick','x':x,'y':y})
def picks(count):
    deadline=time.time()+5
    found=[]
    while len(found)<count and time.time()<deadline:
        found+=json.loads(call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',
                               GLib.Variant('(s)',(json.dumps({'type':'picks'}),)))[0])['picks']
        time.sleep(0.05)
    assert len(found)==count,found
    return {(item['x'],item['y']):item['rgb'] for item in found}
before=picks(2)
step({'type':'annotate','operation':{'kind':'arrow','x1':900,'y1':400,'x2':1300,'y2':400,'color':'#ff0000','width':4}})
time.sleep(0.3)
for x,y in points:
    step({'type':'pick','x':x,'y':y})
after=picks(3)
log('arrow-outside-region',{'before':{str(k):v for k,v in before.items()},'after':{str(k):v for k,v in after.items()}})
assert after[(1200,400)]==[255,0,0],after
assert after[(1000,380)]==before[(1000,380)],after
# Dimmed red: the mask's rgba(5, 10, 20, 0.55) over pure red.
assert abs(after[(1000,400)][0]-round(255*0.45+5*0.55))<=3 and after[(1000,400)][1]<=10,after
assert after[(1000,400)]!=before[(1000,400)],after
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','annotations outside the region show dimmed')

# The blur previews on the frozen image while editing, close to what the PNG renderer exports.
capture()
step({'type':'select','rect':{'x':200,'y':200,'width':900,'height':400}})
# A grid over the window's centred label, whose glyph edges are what a blur visibly softens.
grid=[(x,y) for x in range(470,820,12) for y in range(352,372,6)]
def pick_all(points):
    for x,y in points:
        call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',
             GLib.Variant('(s)',(json.dumps({'type':'pick','x':x,'y':y}),)))
    return picks(len(points))
sharp=pick_all(grid)
step({'type':'annotate','operation':{'kind':'blur','x1':440,'y1':320,'x2':840,'y2':400}})
time.sleep(0.3)
blurred=pick_all(grid)
step({'type':'finish','outputs':['save']})
# lastResult still holds the previous capture's result until this one closes the overlay.
current=completed()
assert not current['active'],current
exported=cairo.ImageSurface.create_from_png(current['lastResult']['savedPath'])
def exported_rgb(x,y):
    offset=(y-200)*exported.get_stride()+(x-200)*4
    blue,green,red=bytes(exported.get_data()[offset:offset+3])
    return [red,green,blue]
changed=[point for point in grid if sharp[point]!=blurred[point]]
error=max(abs(a-b) for point in grid for a,b in zip(blurred[point],exported_rgb(*point)))
log('blur-preview',{'points':len(grid),'changed':len(changed),'distinct-sharp':len({tuple(v) for v in sharp.values()}),'max-error':error})
assert len(changed)>=len(grid)//4,changed
assert error<=24,error
log('PASS','blur previews on the frozen image like the export')

# P picks the brush; a pointer drag paints a smooth stroke, shown live and in the exported PNG.
capture();drag()
assert 'brush' in inspect()['buttons']
step({'type':'key','key':'p'})
stroke=[(1150,300),(1200,350),(1250,300),(1300,350)]
step({'type':'pointer','x':stroke[0][0],'y':stroke[0][1]})
step({'type':'pointer','x':stroke[0][0],'y':stroke[0][1],'button':'press'})
for x,y in stroke[1:]:
    step({'type':'pointer','x':x,'y':y})
current=step({'type':'pointer','x':stroke[-1][0],'y':stroke[-1][1],'button':'release'})
assert current['annotations']==1 and inspect()['tool']=='brush',current
# The stroke passes exactly through the midpoint between the second and third samples.
on=(1225,325)
call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps({'type':'pick','x':on[0],'y':on[1]}),)))
live=picks(1)[on]
step({'type':'finish','outputs':['save']})
# lastResult still holds the previous capture's result until this one closes the overlay.
current=completed()
assert not current['active'],current
exported=cairo.ImageSurface.create_from_png(current['lastResult']['savedPath'])
offset=(on[1]-250)*exported.get_stride()+(on[0]-1100)*4
blue,green,red=bytes(exported.get_data()[offset:offset+3])
log('brush-stroke',{'live':live,'export':[red,green,blue]})
assert live==[255,89,94] and [red,green,blue]==[255,89,94],(live,[red,green,blue])
log('PASS','brush tool paints a freehand stroke live and in the export')

# The toolbar offers no highlight tool, and its undo and redo buttons step back and forth through annotations.
capture();drag()
ui=inspect()
assert 'highlight' not in ui['buttons'] and 'undo' in ui['buttons'] and 'redo' in ui['buttons'],ui['buttons']
step({'type':'annotate','operation':{'kind':'rectangle','x1':1150,'y1':300,'x2':1250,'y2':400}})
step({'type':'annotate','operation':{'kind':'arrow','x1':1150,'y1':300,'x2':1250,'y2':400}})
assert click(*center(ui['buttons']['undo']))['annotations']==1
assert click(*center(ui['buttons']['undo']))['annotations']==0
assert click(*center(ui['buttons']['redo']))['annotations']==1
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','toolbar undo and redo buttons')

# A colour picked right after drawing recolours that annotation in one undo step; the next one is drawn in it.
capture();drag()
step({'type':'key','key':'r'})
for x1,y1,x2,y2 in [(1150,300,1250,400),(1160,310,1240,390)]:
    step({'type':'pointer','x':x1,'y':y1})
    step({'type':'pointer','x':x1,'y':y1,'button':'press'})
    step({'type':'pointer','x':x2,'y':y2})
    step({'type':'pointer','x':x2,'y':y2,'button':'release'})
    if x1==1150:
        ui=inspect()
        assert ui['active']==0 and ui['operations'][0]['color']=='#ff595e',ui['operations']
        click(*center(ui['colors']['#75bbff']))
        ui=inspect()
        assert ui['annotations']==1 and ui['operations'][0]['color']=='#75bbff',ui['operations']
        step({'type':'undo'})
        assert inspect()['operations'][0]['color']=='#ff595e'
        step({'type':'redo'})
ui=inspect()
assert [op['color'] for op in ui['operations']]==['#75bbff','#75bbff'],ui['operations']
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','a picked colour recolours the active annotation')

# With the select tool, a click inside the selected region copies and saves like Enter. A click that only
# deselects an annotation, or ends a drag of the region, keeps the capture open. The cursor shows which: a
# crosshair to pick or draw, a hand where a click finishes.
capture()
assert inspect()['cursor']=='crosshair',inspect()['cursor']
drag()
step({'type':'key','key':'r'})
step({'type':'pointer','x':1150,'y':300})
assert inspect()['cursor']=='crosshair',inspect()['cursor']
step({'type':'pointer','x':1150,'y':300,'button':'press'})
step({'type':'pointer','x':1250,'y':400})
step({'type':'pointer','x':1250,'y':400,'button':'release'})
step({'type':'key','key':'v'})
assert inspect()['active']==0
step({'type':'pointer','x':1400,'y':450})
assert inspect()['cursor']=='default',inspect()['cursor']
current=click(1400,450)
assert current['active'] and inspect()['active'] is None,current
step({'type':'pointer','x':700,'y':600})
assert inspect()['cursor']=='crosshair',inspect()['cursor']
step({'type':'pointer','x':1200,'y':350})
assert inspect()['cursor']=='move',inspect()['cursor']
step({'type':'pointer','x':1400,'y':450})
assert inspect()['cursor']=='confirm',inspect()['cursor']
step({'type':'pointer','x':1400,'y':450,'button':'press'})
step({'type':'pointer','x':1420,'y':460})
current=step({'type':'pointer','x':1420,'y':460,'button':'release'})
assert current['active'] and current['selection']=={'x':1120,'y':260,'width':400,'height':250},current
revision=current['revision']
click(1400,450)
current=completed()
assert not current['active'] and current['lastResult']['copy']=='success' and current['lastResult']['save']=='success' and current['lastResult']['revision']==revision,current
log('PASS','a click inside the selected region finishes like Enter')

# With the timing log on, a capture and its export log each stage once; with it off, nothing is logged.
shell_log=Path(os.environ['XDG_CACHE_HOME'])/'shell.log'
def timing_lines():
    return [line.split('[CapIt timing] ',1)[1] for line in shell_log.read_text(errors='replace').splitlines()
            if '[CapIt timing] ' in line]
assert not timing_lines(),timing_lines()
step({'type':'settings','timingLog':True})
capture();drag()
pause(1)
step({'type':'key','key':'Return'})
assert not completed()['active']
step({'type':'settings','timingLog':False})
lines=timing_lines()
log('timing-lines',lines)
assert lines[0].startswith('machine · GNOME Shell '),lines
for name,stage in [('capture','window list'),('capture','snapshot'),('capture','overlay built'),
                   ('capture','first frame shown'),('capture','detection start'),('export','crop'),
                   ('export','render'),('export','copy'),('export','finished')]:
    assert any(line.startswith(name+' ') and f' · {stage}:' in line for line in lines),(name,stage,lines)
capture();drag()
assert not step({'type':'key','key':'Escape'})['active']
assert len(timing_lines())==len(lines),timing_lines()[len(lines):]
log('PASS','the timing log records capture and export stages only while it is on')

# Mid-drag, tool keys, Delete, undo and Enter are ignored and Escape abandons only the drag.
capture();drag()
step({'type':'key','key':'r'})
step({'type':'pointer','x':1150,'y':300})
step({'type':'pointer','x':1150,'y':300,'button':'press'})
step({'type':'pointer','x':1250,'y':400})
for key in ['p','Delete','Return']:
    step({'type':'key','key':key})
current=step({'type':'pointer','x':1250,'y':400,'button':'release'})
assert current['active'] and current['annotations']==1 and inspect()['tool']=='rectangle',current
step({'type':'pointer','x':1200,'y':300})
step({'type':'pointer','x':1200,'y':300,'button':'press'})
step({'type':'pointer','x':1300,'y':350})
step({'type':'key','key':'Delete'})
current=step({'type':'key','key':'Escape'})
assert current['active'] and current['annotations']==1,current
current=step({'type':'pointer','x':1300,'y':350,'button':'release'})
assert current['active'] and current['annotations']==1,current
current=step({'type':'finish','outputs':['copy']})
for attempt in range(50):
    if not current['active']: break
    pause(.1); current=status()
assert current['lastResult']['copy']=='success',current
log('PASS','keys during a drag cannot corrupt annotations')

# C picks the circle tool; a drag draws an ellipse in its box, which stays active. The wheel then changes its line
# width, and a run of wheel steps undoes as one.
capture();drag()
step({'type':'key','key':'c'})
assert inspect()['tool']=='ellipse'
step({'type':'pointer','x':1150,'y':280})
step({'type':'pointer','x':1150,'y':280,'button':'press'})
step({'type':'pointer','x':1350,'y':450})
step({'type':'pointer','x':1350,'y':450,'button':'release'})
found=inspect()
assert found['operations']==[{'kind':'ellipse','width':4,'color':'#ff595e','x1':1150,'y1':280,'x2':1350,'y2':450}],found['operations']
assert found['active']==0,found
for direction in ['up','up','up','down']:
    step({'type':'pointer','x':1250,'y':365,'scroll':direction})
assert inspect()['operations'][0]['width']==6,inspect()['operations']
step({'type':'undo'})
found=inspect()
assert found['operations'][0]['width']==4 and found['active'] is None,found
# With nothing active, the wheel leaves the annotations alone.
step({'type':'pointer','x':1250,'y':365,'scroll':'up'})
assert inspect()['operations'][0]['width']==4
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','circle tool draws an ellipse; the wheel changes the active annotation width as one undo step')

# Escape dismisses pending text before it dismisses the capture.
capture();drag()
step({'type':'text','x':1200,'y':350,'text':'discard me'})
current=step({'type':'key','key':'Escape'})
assert current['active'] and not current['textEntry'] and current['annotations']==0,current
assert not step({'type':'key','key':'Escape'})['active']
log('PASS','text Escape then capture Escape')
window.destroy()
pause(.2)
call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','DisableExtension',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')
pause(.2)
info=call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions','GetExtensionInfo',GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')[0]
assert not info.get('enabled') and not info.get('error'),info
log('PASS','native extension disable lifecycle')
log('ALL_PASS','Isolated GNOME extension core integration scenarios')
