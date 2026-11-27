# SPDX-License-Identifier: GPL-3.0-or-later
"""Answers Shell's request to start the X11 session services, so Xwayland clients can run in the corpus session.

Shell starts a systemd target before it lets Mutter open its X11 display, and treats a missing systemd user
manager on the session bus as a failure. A private dbus-run-session bus has none, so this stands in for it and
reports every job as done.
"""
from gi.repository import Gio, GLib

INTERFACE = Gio.DBusNodeInfo.new_for_xml('''<node><interface name="org.freedesktop.systemd1.Manager">
  <method name="StartUnit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
  <method name="StopUnit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
  <method name="Subscribe"/>
  <signal name="JobRemoved"><arg type="u"/><arg type="o"/><arg type="s"/><arg type="s"/></signal>
</interface></node>''').interfaces[0]
jobs = 0


def handle(connection, sender, path, interface, method, parameters, invocation):
    global jobs
    if method == 'Subscribe':
        invocation.return_value(None)
        return
    jobs += 1
    job, unit = f'/org/freedesktop/systemd1/job/{jobs}', parameters.unpack()[0]
    invocation.return_value(GLib.Variant('(o)', (job,)))
    # The caller starts listening for the job's end only once it knows the job's path.
    GLib.timeout_add(200, lambda: connection.emit_signal(None, '/org/freedesktop/systemd1', INTERFACE.name,
        'JobRemoved', GLib.Variant('(uoss)', (jobs, job, unit, 'done'))) and False)


def acquired(connection, name):
    connection.register_object('/org/freedesktop/systemd1', INTERFACE, handle, None, None)


Gio.bus_own_name(Gio.BusType.SESSION, 'org.freedesktop.systemd1', Gio.BusNameOwnerFlags.NONE, acquired, None, None)
GLib.MainLoop().run()
