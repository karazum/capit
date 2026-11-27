# GNOME 45 to 50, headless, 2026-11-26

The headless harness ran on each GNOME Shell from 45 to 50, one Ubuntu release
each, through `tests/gnome-integration/container.sh`. Every run used the same
checkout, with `shell-version` listing 45 to 50. The host run is GNOME 46 on
Ubuntu 24.04, outside a container.

| Ubuntu | GNOME Shell | GJS | Default | `--recording` | `--prefs` | `--reload` | GJS unit tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 23.10 | 45.2 | 1.78 | 24/24 | 10/10 | pass | 4/4 | 58/58 |
| 24.04 (container) | 46.0 | 1.80 | 24/24 | 10/10 | pass | 4/4 | 58/58 |
| 24.04 (host) | 46.0 | 1.80 | 24/24 | 10/10 | | | 58/58 |
| 24.10 | 47.0 | 1.82 | 24/24 | 10/10 | pass | 4/4 | 58/58 |
| 25.04 | 48.0 | 1.82 | 24/24 | 10/10 | pass | 4/4 | 58/58 |
| 25.10 | 49.0 | 1.86 | 24/24 | 10/10 | pass | 4/4 | 58/58 |
| 26.04 | 50.1 | 1.88 | 24/24 | 10/10 | pass | 4/4 | 58/58 |

These are synthetic sessions: virtual outputs at scale 1, software rendering,
a GTK test window, and no physical input devices. They show that the extension
loads and its flows work on each version; they do not replace a real login on
each release.

## What each version needed

**GNOME 50.** Shell would not load an extension listing only 46. Once listed:

- `Clutter.Grab` no longer reports which devices it holds, so the overlay's
  check that it got keyboard and pointer threw. Shell's own modals dropped the
  same check.
- `Meta.Cursor` and `global.display.set_cursor` are gone; actors set
  `Clutter.CursorType` themselves.
- `Meta.is_wayland_compositor` is gone with X11 sessions. The timing log
  called it, and its failure left every later capture refused, since
  `capture()` had already marked itself busy.
- `DataInputStream.read_line_finish_utf8` returns bytes, so parsing the
  detector's lines called `Uint8Array.toString()`.
- The area screencast drops a change that comes less than a frame after the
  last recorded one and never records it later. The demo cursor's halo was
  missing when the pointer stopped right after moving. The halo now repaints
  once a frame after its last change.

**GNOME 48.** `Meta.Cursor.MOVE_OR_RESIZE_WINDOW` was renamed `MOVE`. Passing
the missing value made Mutter abort, taking the whole session down, when the
pointer reached the toolbar grip.

**GNOME 45.** GLib 2.78 has no `GioUnix` typelib, and `GLib.chmod` and
`GLib.fsync` are not introspectable, so none of the `gjs -m` workers started.
`Shell.BlurEffect` takes `sigma` rather than `radius`. GTK 4.12 answers no
AT-SPI hit test, so the accessibility mode now searches the tree by extents
when an application does not answer. Mutter 45 does not flag a wheel's smooth
events as emulated, so every wheel notch counted twice.

**GNOME 47 and 49** needed nothing beyond the fixes above.

## Harness changes

- GNOME 50 removed `--sm-disable`, so the runner passes it only when Shell
  lists it.
- GNOME 50 needs a system bus to start. A container has none, so an empty one
  stands in. The host runs had been using the host's own system bus.
- In a container without a UTF-8 locale, Shell logged the timing log's `·` as
  `?`.
- Mutter 45 headless kept drawing the fullscreen test window at its old offset
  after the probe replaced its content, while reporting it at the corner. The
  probe now leaves fullscreen and enters it again after each swap.
- FFmpeg 6 decodes no frame from a short GIF with `-sseof`, so the recording
  probe decodes every frame and keeps the last. It also ends a 15-to-30 fps
  conversion one frame early, which the encoder test now allows.

## Warnings

A later run printed Shell's whole log for the default suite and recording on
each version. Only GNOME 46 prints a JS warning, once per session: GJS 1.80
reports that `Gio.UnixInputStream` and `Gio.UnixOutputStream` moved to
`GioUnix` when it wraps a subprocess's pipes. Shell loads Gio before GioUnix,
so the pipes resolve to the old names whatever an extension imports; GJS 1.82
no longer warns. Nothing on GNOME 48 to 50 reports the toolbars' use of St's
`vertical`, but they now use `orientation` there anyway.
