# GNOME on Xorg, headless, 2026-11-26

The headless harness now runs GNOME Shell as an X11 compositor:
`CAPIT_SESSION=x11` with any mode of `tests/gnome-integration/run.sh`, through
`container.sh` for each Ubuntu release. The X server is Xorg with the dummy
video driver, two outputs side by side (1280×720 and 1024×768), laid out through
Mutter's display settings as a user would. GNOME 49 and 50 have no X11 session,
so the X11 runs cover 45 to 48.

| Ubuntu | GNOME Shell | Default | `--recording` | `--x11-scale` (200%) |
| --- | --- | --- | --- | --- |
| 23.10 | 45.2 | 24/24 | 11/11 | 4/4 |
| 24.04 | 46.0 | 24/24 | 11/11 | 4/4 |
| 24.10 | 47.0 | 24/24 | 11/11 | 4/4 |
| 25.04 | 48.0 | 24/24 | 11/11 | 4/4 |

`--prefs` and `--reload` also pass on X11 on 24.04.

The default suite is the same one the Wayland runs pass: smart boxes, both
detectors and the accessibility tree, every tool, export, save, copy as a file
and as content, read back by a GTK client on X11, and recovery after a failed
save. Recording passes its usual checks plus one only X11 needs, below.

This is a synthetic session on a dummy driver: no GPU, no real input devices, no
display manager. It shows that the extension works on Mutter's X11 backend. It
does not replace a real Xorg login, and pasting into real applications is still
to be checked in one.

## Recording on X11

GNOME's screencast service records areas on X11 too, through the same Mutter
screen cast and PipeWire, so no `x11grab` fallback is needed.

On X11, Mutter stops compositing a fullscreen window after about a hundred
frames that repaint all of it, which saves a copy per frame for games and video.
GNOME's screencast then repeats the last frame of that window that was
composited. A 9-second recording of a fullscreen window changing colour every
50 ms had 1 distinct frame in its last 3 seconds. A recording now keeps every
window composited while it runs, on X11 only, and the same recording has 72.
`--recording` on X11 checks this with a 9-second recording. The hold ends with
the recording however it ends, including a start GNOME's recorder refuses.

## Scaling

- **100%:** the default suite above.
- **200%:** `--x11-scale` uses outputs of 2560×1440 and 2048×1536 at scale 2,
  with the GTK test window drawn at 200% too (`GDK_SCALE=2`, standing in for
  the desktop's XSETTINGS). X11 has no logical pixels, so the stage is in
  device pixels and Shell reports a capture scale of 1. Both detectors and the
  accessibility tree find the window's 300 px sidebar at 600 device pixels, and
  scrolling out reaches the whole 2560×1440 window. An 800×500 region exports
  as an 800×500 PNG with a redaction where it was drawn, and the toolbar is
  drawn at twice the size on the region's monitor.

  Known gap: sizes CapIt sets in stage pixels stay in device pixels on X11.
  Annotation line widths, text size, handles and gaps such as the 12 px between
  the region and the toolbar therefore look half as large at 200% on Xorg as
  they do at 200% on Wayland, where the stage is in logical pixels.
- **125%:** not tested. Ubuntu's `x11-randr-fractional-scaling` feature is
  present in 24.04's Mutter and offers 1.2488. It draws the interface at 200%
  and has RandR scale the screen down, a CRTC transform the dummy driver does
  not support. Mutter refused two adjacent outputs at 1.2488 and reported one
  output at scale 2. A real Xorg login has to check it.

## Harness changes

- The X server runs on the first free display from `:50`, so a run on the host
  leaves the desktop's own alone.
- `DISPLAY` is set before the session bus starts, so services D-Bus activates,
  such as the preferences service, can open it.
- Mutter starts each dummy output at the driver's largest mode, so
  `x11-layout.py` applies the requested layout through
  `org.gnome.Mutter.DisplayConfig` once Shell is up. It waits for that
  interface, which can appear after Shell's own bus name.
- Shell opens the overview at startup. On X11 a window started without a launch
  timestamp does not take focus, so the overview stays open; `x11-layout.py`
  closes it through Shell's `OverviewActive` property.
- A fullscreen request made before the window is mapped can be lost on X11, so
  the probes request it again once the window is up, until it covers the
  monitor. GTK on X11 may then keep drawing at the window's old size until an
  input event reaches it (at 200% its surface stayed 550×16), so the probes
  click the window once.
- GTK fills a clipboard stream on X11 from selection events, so the probes now
  read clipboard streams asynchronously; a blocking read waited forever.
