# SPDX-License-Identifier: GPL-3.0-or-later
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import gi
gi.require_version('Gdk','4.0')
gi.require_version('Gtk','4.0')
from gi.repository import Gdk, Gtk, Gio, GLib

bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
uuid='capit@karazum.github.io'
runtime=Path(os.environ['XDG_RUNTIME_DIR'])
cache=Path(os.environ['XDG_CACHE_HOME'])/'capit'
output=runtime/'output'
area={'x':100,'y':100,'width':400,'height':300}

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

def extensions(method):
    return call('/org/gnome/Shell/Extensions','org.gnome.Shell.Extensions',method,GLib.Variant('(s)',(uuid,)),destination='org.gnome.Shell.Extensions')

def status():
    return json.loads(call('/io/github/karazum/CapIt','io.github.karazum.CapIt','GetStatus')[0])

def step(value):
    call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps(value),)))
    pause()
    return status()

# GNOME's screencast can take well over 15 seconds to start on a busy CI runner with software GL.
RECORDING_START=30

def until(condition,label,seconds=15):
    for attempt in range(int(seconds*10)):
        current=status()
        if condition(current): return current
        pause(.1)
    raise AssertionError((label,current))

def ffprobe(path,entries):
    result=subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v','-show_entries',entries,'-of','json',str(path)],capture_output=True,text=True,check=True)
    return json.loads(result.stdout)

def inspect():
    return json.loads(call('/io/github/karazum/CapIt/Test','io.github.karazum.CapIt.Test','Step',GLib.Variant('(s)',(json.dumps({'type':'inspect'}),)))[0])

def click(x,y):
    step({'type':'pointer','x':x,'y':y})
    step({'type':'pointer','x':x,'y':y,'button':'press'})
    return step({'type':'pointer','x':x,'y':y,'button':'release'})

def center(actor):
    return [actor['position'][0]+actor['size'][0]/2,actor['position'][1]+actor['size'][1]/2]

# Picks the area in a record overlay and starts recording it, the way a drag and Enter do.
def start_recording(mode='gif'):
    step({'type':'record','mode':mode})
    current=until(lambda s:s['active'],'record overlay')
    assert current['mode']==mode,current
    step({'type':'pointer','x':area['x'],'y':area['y']})
    step({'type':'pointer','x':area['x'],'y':area['y'],'button':'press'})
    step({'type':'pointer','x':area['x']+area['width'],'y':area['y']+area['height']})
    current=step({'type':'pointer','x':area['x']+area['width'],'y':area['y']+area['height'],'button':'release'})
    assert current['selection']==area,current
    step({'type':'key','key':'Return'})
    current=until(lambda s:not s['active'] and (s['recording'] or {}).get('state')=='recording','recording started',RECORDING_START)
    assert current['recording']['area']==area and current['recording']['kind']==mode,current
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

def read_clipboard(mime):
    clipboard=Gdk.Display.get_default().get_clipboard()
    result={}
    def ready(clipboard,request):
        try:
            stream,chosen=clipboard.read_finish(request)
            read_stream(stream,lambda payload=None,error=None:result.update(error=error) if error else result.update(mime=chosen,payload=payload))
        except Exception as error:
            result.update(error=str(error))
    clipboard.read_async([mime],GLib.PRIORITY_DEFAULT,None,ready)
    for attempt in range(50):
        if result: break
        pause(.1)
    assert result.get('mime')==mime,result
    return result['payload']

# Clipboard reads need the GTK window to have keyboard focus.
def focus_window():
    window.present()
    for button in ('press','release'):
        step({'type':'pointer','x':900,'y':600,'button':button})
    pause(.3)

def recording_files():
    return sorted(path.name for path in cache.glob('recording-*'))

for attempt in range(60):
    try:
        if extensions('GetExtensionInfo')[0]: break
    except GLib.Error: pass
    pause(.1)
extensions('EnableExtension')
# The extension exports its D-Bus object a moment after enabling, later on a loaded machine.
for attempt in range(100):
    try:
        if status()['version']==1: break
    except GLib.Error: pass
    pause(.1)
assert status()['version']==1
assert shutil.which('ffmpeg'),'ffmpeg is required for GIF recording'

# A window whose colour keeps changing, so the recording has distinct frames. It is coloured with CSS because
# GTK draw functions need python3-gi-cairo, which the harness does not require.
Gtk.init()
window=Gtk.Window(title='CapIt isolated recording source')
style=Gtk.CssProvider()
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),style,Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
window.set_child(Gtk.Box(css_classes=['capit-source'],hexpand=True,vexpand=True))
window.fullscreen_on_monitor(Gdk.Display.get_default().get_monitors().get_item(0))
window.present()
if os.environ.get('CAPIT_SESSION')=='x11':
    # On X11 a fullscreen request made before the window is mapped can be lost, so it is asked again until the window
    # covers the monitor.
    pause(1)
    monitor=Gdk.Display.get_default().get_monitors().get_item(0)
    for attempt in range(5):
        window.unfullscreen()
        pause(.5)
        window.fullscreen_on_monitor(monitor)
        pause(1)
        surface,geometry=window.get_surface(),monitor.get_geometry()
        if window.is_fullscreen() and [surface.get_width(),surface.get_height()]==[geometry.width,geometry.height]:
            break
    else:
        raise AssertionError('the test window did not go fullscreen')
    # GTK on X11 may not draw the window at its fullscreen size before an input event reaches it.
    click(400,300)
hue=[0]
# Black instead of changing colour while True, so pixels of the demo cursor's halo can be told apart.
still=[False]
def tick():
    hue[0]+=1
    rgb=[0,0,0] if still[0] else [hue[0]*k%256 for k in (3,5,7)]
    style.load_from_string('.capit-source { background-color: rgb(%d,%d,%d); }'%tuple(rgb))
    return GLib.SOURCE_CONTINUE
GLib.timeout_add(50,tick)
pause(1)
step({'type':'settings','directory':str(output),'recordingOutput':'both'})

# The mode buttons stand left of the region, right of it when the left has no room, and inside it when it fills
# the monitor; clicking them switches what Enter makes.
call('/io/github/karazum/CapIt','io.github.karazum.CapIt','Capture')
current=until(lambda s:s['active'],'screenshot overlay')
assert current['mode']=='image',current
step({'type':'select','rect':area})
found=inspect()
modes=found['modes']
assert modes["image"]["size"]==[48,48],modes
assert not found['demoCursor']['visible'],found['demoCursor']
column=[modes['image']['position'][0],modes['image']['position'][0]+modes['image']['size'][0]]
log('modes-left',modes)
assert column[1]<=area['x'] and modes['image']['position'][1]<modes['video']['position'][1],modes
step({'type':'select','rect':{'x':5,'y':100,'width':400,'height':300}})
modes=inspect()['modes']
assert modes['image']['position'][0]>=405,modes
step({'type':'select','rect':{'x':0,'y':0,'width':1280,'height':720}})
modes=inspect()['modes']
assert 0<modes['image']['position'][0]<100,modes
step({'type':'select','rect':area})
current=click(*center(inspect()['modes']['video']))
assert current['mode']=='video' and current['active'],current
current=click(*center(inspect()['modes']['gif']))
assert current['mode']=='gif',current
current=click(*center(inspect()['modes']['image']))
assert current['mode']=='image',current
current=click(*center(inspect()['modes']['video']))
step({'type':'key','key':'Return'})
current=until(lambda s:not s['active'] and (s['recording'] or {}).get('state')=='recording','video recording from the mode button',RECORDING_START)
assert current['recording']['kind']=='video' and current['recording']['area']==area,current
pause(1.5)
step({'type':'stop-recording'})
current=until(lambda s:s['recording'] is None,'video finished',30)
result=current['lastResult']['recording']
log('video-result',result)
video=Path(result['savedPath'])
assert video.suffix=='.mp4',result
info=ffprobe(video,'stream=codec_name,pix_fmt,width,height,nb_read_frames')['streams'][0]
log('video',info)
assert [info['codec_name'],info['pix_fmt'],info['width'],info['height']]==['h264','yuv420p',area['width'],area['height']],info
assert int(info['nb_read_frames'])>=30,info
assert recording_files()==[],recording_files()
video.unlink()
log('PASS','mode buttons beside, after and inside the region switch modes and record an MP4')

# The demo cursor button shows in recording modes and toggles with a click or D; while on, a recording draws a
# halo around the pointer, and GNOME's screencast includes it.
still[0]=True
pause(.5)
step({'type':'record','mode':'gif'})
until(lambda s:s['active'],'record overlay for the demo cursor')
step({'type':'select','rect':area})
button=inspect()['demoCursor']
assert button['visible'] and not button['on'],button
assert inspect()['keyHints']==['D','Esc','Enter'],inspect()['keyHints']
click(*center(button))
assert inspect()['demoCursor']['on']
step({'type':'key','key':'d'})
assert not inspect()['demoCursor']['on']
step({'type':'key','key':'d'})
assert inspect()['demoCursor']['on']
step({'type':'key','key':'Return'})
current=until(lambda s:(s['recording'] or {}).get('state')=='recording','demo cursor recording',RECORDING_START)
assert current['recording']['demoCursor'],current
step({'type':'pointer','x':300,'y':250})
pause(1.5)
step({'type':'stop-recording'})
result=until(lambda s:s['recording'] is None,'demo cursor recording finished',30)['lastResult']['recording']
# The last frame, from all of them decoded: FFmpeg 6 seeks past the end of a short GIF with -sseof.
frames=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',result['savedPath'],'-pix_fmt','rgb24','-f','rawvideo','-'],capture_output=True,check=True).stdout
frame=frames[-area['width']*area['height']*3:]
def mean(x,y):
    pixels=[frame[((y+dy)*area['width']+x+dx)*3:((y+dy)*area['width']+x+dx)*3+3] for dx in range(-2,3) for dy in range(-2,3)]
    return [sum(pixel[k] for pixel in pixels)/len(pixels) for k in range(3)]
# Up and left of the pointer, inside the 44 px halo but clear of the arrow, which points down and right.
halo,background=mean(200-12,150-12),mean(330,230)
log('demo-cursor-pixels',{'halo':halo,'background':background})
assert halo[0]>25 and halo[0]>halo[2]+15 and max(background)<10,(halo,background)
Path(result['savedPath']).unlink()
step({'type':'record','mode':'gif'})
until(lambda s:s['active'],'record overlay to switch the demo cursor off')
step({'type':'select','rect':area})
step({'type':'key','key':'d'})
assert not inspect()['demoCursor']['on']
step({'type':'key','key':'Escape'})
still[0]=False
log('PASS','demo cursor toggles in recording modes and its halo is recorded')

# In a recording mode, clicking the chosen area again starts recording. A bar beside the area then toggles the
# demo cursor live and stops the recording; it takes clicks over the application window under it.
step({'type':'record','mode':'gif'})
until(lambda s:s['active'],'record overlay for click-to-start')
step({'type':'pointer','x':area['x'],'y':area['y']})
step({'type':'pointer','x':area['x'],'y':area['y'],'button':'press'})
step({'type':'pointer','x':area['x']+area['width'],'y':area['y']+area['height']})
step({'type':'pointer','x':area['x']+area['width'],'y':area['y']+area['height'],'button':'release'})
click(area['x']+200,area['y']+150)
# The bar's buttons have no position until Shell lays the bar out, which can come after the recording starts.
def placed(bar):
    return bool(bar) and all(None not in part['position'] for part in (bar,bar['demoCursor'],bar['stop']))
current=until(lambda s:(s['recording'] or {}).get('state')=='recording' and placed(s['recording']['bar']),
    'recording started by a click, with its bar laid out',RECORDING_START)
bar=current['recording']['bar']
log('recording-bar',bar)
assert bar and bar['position'][1]>=area['y']+area['height'],bar
assert not current['recording']['demoCursor'],current
click(*center(bar['demoCursor']))
assert status()['recording']['demoCursor']
click(*center(bar['demoCursor']))
assert not status()['recording']['demoCursor']
click(*center(bar['stop']))
current=until(lambda s:s['recording'] is None,'recording stopped from the bar',30)
Path(current['lastResult']['recording']['savedPath']).unlink()
log('PASS','clicking the area starts recording; the bar toggles the demo cursor and stops it')

# An area filling its monitor leaves no room for the bar, so none is shown.
step({'type':'record','mode':'gif'})
until(lambda s:s['active'],'record overlay for a full-monitor area')
step({'type':'select','rect':{'x':0,'y':0,'width':1280,'height':720}})
step({'type':'key','key':'Return'})
current=until(lambda s:(s['recording'] or {}).get('state')=='recording','full-monitor recording',RECORDING_START)
assert current['recording']['bar'] is None,current
step({'type':'cancel-recording'})
until(lambda s:s['recording'] is None,'full-monitor recording cancelled')
log('PASS','no recording bar when the area fills its monitor')

# Record, stop, then find the GIF saved and on the clipboard as a file and as image data.
started=time.monotonic()
start_recording()
pause(2)
step({'type':'stop-recording'})
recorded=time.monotonic()-started
current=until(lambda s:s['recording'] is None,'recording finished',30)
result=current['lastResult']['recording']
log('recording-result',result)
saved=Path(result['savedPath'])
assert saved.parent==output and saved.suffix=='.gif',result
data=saved.read_bytes()
assert data[:6]==b'GIF89a'
info=ffprobe(saved,'stream=width,height,nb_read_frames')['streams'][0]
duration=float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(saved)],capture_output=True,text=True,check=True).stdout)
log('gif',{**info,'duration':duration,'wall_seconds_from_start_request_to_stop':round(recorded,2)})
assert [info['width'],info['height']]==[area['width'],area['height']],info
assert int(info['nb_read_frames'])>=10,info
assert recording_files()==[],recording_files()
focus_window()
uri=read_clipboard('text/uri-list').decode()
assert uri.strip()==saved.as_uri(),uri
log('PASS','recorded area saved as GIF and copied as a file')

# As content, the clipboard holds the GIF's own bytes. The timing log is on for this one recording.
step({'type':'settings','clipboardContent':'content','timingLog':True})
start_recording()
pause(1)
step({'type':'stop-recording'})
current=until(lambda s:s['recording'] is None,'content-copy recording finished',30)
step({'type':'settings','timingLog':False})
timings=[line.split('[CapIt timing] ',1)[1] for line in
         (Path(os.environ['XDG_CACHE_HOME'])/'shell.log').read_text(errors='replace').splitlines()
         if '[CapIt timing] gif recording' in line]
log('recording-timings',timings)
for stage in ['overlay gone','recording started','recorded','screencast stopped','encoded','copied']:
    assert any(f' · {stage}:' in line for line in timings),(stage,timings)
result=current['lastResult']['recording']
assert 'Copied to the clipboard' in result['messages'],result
focus_window()
assert read_clipboard('image/gif')==Path(result['savedPath']).read_bytes()
Path(result['savedPath']).unlink()
step({'type':'settings','clipboardContent':'file'})
log('PASS','GIF copied as content')

# Cancelling keeps no file anywhere.
start_recording()
pause(.5)
step({'type':'cancel-recording'})
current=until(lambda s:s['recording'] is None,'recording cancelled')
assert current['lastResult']['recording']=={'cancelled':True},current
pause(1)
assert [path.name for path in output.iterdir()]==[saved.name]
assert recording_files()==[],recording_files()
log('PASS','cancelled recording leaves no files')

# Copy only: no new file in the output folder, and the clipboard holds the GIF itself, whatever the clipboard
# setting says. A copy kept in the cache backs a file reference if the GIF is too large to copy as content.
step({'type':'settings','recordingOutput':'copy'})
start_recording()
pause(1)
step({'type':'stop-recording'})
current=until(lambda s:s['recording'] is None,'copy-only recording finished',30)
result=current['lastResult']['recording']
assert 'savedPath' not in result and Path(result['clipboardPath']).parent==cache/'clipboard',result
assert [path.name for path in output.iterdir()]==[saved.name]
focus_window()
assert 'Copied to the clipboard' in result['messages'],result
assert read_clipboard('image/gif')==Path(result['clipboardPath']).read_bytes()
log('PASS','copy-only GIF is copied as content')

# A GIF that cannot be made keeps the lossless recording and reports where it is. The extension starts encoder.js
# afresh for each recording, so a failing stand-in in the installed copy takes effect at once.
worker=Path(os.environ['XDG_DATA_HOME'])/'gnome-shell/extensions'/uuid/'encoder.js'
original=worker.read_text()
worker.write_text("import System from 'system';\nprint(JSON.stringify({error: 'boom'}));\nSystem.exit(1);\n")
start_recording()
pause(1)
step({'type':'stop-recording'})
current=until(lambda s:s['recording'] is None,'failed encode finished',30)
worker.write_text(original)
result=current['lastResult']['recording']
log('failed-encode',result)
assert result['error']=='boom' and Path(result['kept']).is_file(),result
assert Path(result['kept']).suffix in ('.mkv','.mov'),result
shutil.rmtree(Path(result['kept']).parent)
log('PASS','a failed encode keeps the recording and reports it')

# On X11 Mutter stops compositing a fullscreen window after about a hundred full repaints, and the screencast would
# then repeat its last frame. A recording keeps it composited, so the end of a long one still changes.
if os.environ.get('CAPIT_SESSION')=='x11':
    step({'type':'settings','recordingOutput':'save'})
    start_recording('video')
    pause(9)
    step({'type':'stop-recording'})
    result=until(lambda s:s['recording'] is None,'long recording finished',60)['lastResult']['recording']
    hashes=subprocess.run(['ffmpeg','-nostdin','-v','error','-i',result['savedPath'],'-f','framemd5','-'],
                          capture_output=True,text=True,check=True).stdout
    # framemd5 rows: stream, dts, pts, duration, size, hash; pts counts frames of the 30 fps video.
    late={row.split(',')[-1].strip() for row in hashes.splitlines()
          if not row.startswith('#') and int(row.split(',')[2])>=6*30}
    log('late-frames',len(late))
    assert len(late)>10,len(late)
    Path(result['savedPath']).unlink()
    step({'type':'settings','recordingOutput':'copy'})
    log('PASS','a long recording over a fullscreen window keeps changing on X11')

# Disabling mid-recording stops GNOME's screencast and removes the recording.
start_recording()
extensions('DisableExtension')
pause(2)
assert recording_files()==[],recording_files()
extensions('EnableExtension')
pause(1)
start_recording()
step({'type':'cancel-recording'})
until(lambda s:s['recording'] is None,'recording after re-enable cancelled')
log('PASS','disable stops the recording and the screencast service accepts a new one')
# Close the test client and let GNOME's screencast session finish stopping before the session shuts down.
window.destroy()
pause(2)
