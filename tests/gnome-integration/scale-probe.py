# SPDX-License-Identifier: GPL-3.0-or-later
import json
from gi.repository import Gio,GLib
b=Gio.bus_get_sync(Gio.BusType.SESSION,None)
def call(method,params=None):
    return b.call_sync('org.gnome.Mutter.DisplayConfig','/org/gnome/Mutter/DisplayConfig','org.gnome.Mutter.DisplayConfig',method,params,None,Gio.DBusCallFlags.NONE,10000,None).unpack()
serial,monitors,logical,props=call('GetCurrentState')
current=[]
for monitor in monitors:
    mode=next(m for m in monitor[1] if m[6].get('is-current'))
    current.append((monitor[0][0],mode))
print(json.dumps({'event':'private-scale-supported','value':[{'index':i,'pixels':[m[1],m[2]],'supported_scales':m[5]} for i,(_,m) in enumerate(current)]}),flush=True)
if 1.25 not in current[0][1][5]:
    print(json.dumps({'event':'fractional-gap','value':'Private GNOME virtual output does not advertise 1.25 scale; no configuration applied.'}),flush=True)
else:
    configs=[(0,0,1.25,0,True,[(current[0][0],current[0][1][0],{})]),(1024,0,1.0,0,False,[(current[1][0],current[1][1][0],{})])]
    try:
        call('ApplyMonitorsConfig',GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',(serial,1,configs,{'layout-mode':GLib.Variant('u',1)})))
        _,_,logical,props=call('GetCurrentState')
        print(json.dumps({'event':'private-fractional-applied','value':[{'x':l[0],'y':l[1],'scale':l[2],'transform':l[3]} for l in logical]}),flush=True)
    except GLib.Error as error:
        print(json.dumps({'event':'fractional-gap','value':str(error)}),flush=True)
