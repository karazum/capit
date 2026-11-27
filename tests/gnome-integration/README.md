# Native GNOME integration

Run from the repository root:

```sh
bash tests/gnome-integration/run.sh
bash tests/gnome-integration/run.sh --scales
bash tests/gnome-integration/run.sh --prefs
bash tests/gnome-integration/run.sh --perf
bash tests/gnome-integration/run.sh --reload
bash tests/gnome-integration/run.sh --recording
bash tests/gnome-integration/run.sh --timing
```

`CAPIT_SESSION=x11` runs any mode in an X11 session instead: GNOME Shell as the
X11 compositor of a headless Xorg using the dummy video driver, with the same
two outputs laid out through Mutter's display settings. `--x11-scale` runs a
short probe on X11 at 200%, on outputs twice the size. It needs GNOME 45 to 48,
since 49 dropped X11, and the `xserver-xorg-core`, `xserver-xorg-video-dummy`
and `x11-xserver-utils` packages, which the container image installs:

```sh
CAPIT_SESSION=x11 bash tests/gnome-integration/container.sh 24.04 --recording
bash tests/gnome-integration/container.sh 24.04 --x11-scale
```

The X server runs on the first free display from `:50`, so a run on the host
does not touch the desktop's own. Shell opens the overview at startup, and on
X11 it stays open over a test window that did not take focus, so
`x11-layout.py` closes it. GTK on X11 may not draw a window at its fullscreen
size before an input event reaches it, so the probes click the test window once. Fractional scaling on X11 uses Ubuntu's RandR
transforms, which the dummy driver cannot show, so 125% is not tested here.

`container.sh` runs the same harness on another Ubuntu release, and so another
GNOME Shell, inside a container, with the checkout mounted read-only:

```sh
bash tests/gnome-integration/container.sh 26.04            # GNOME 50
bash tests/gnome-integration/container.sh 23.10 --recording # GNOME 45
```

Ubuntu 23.10, 24.04, 24.10, 25.04, 25.10 and 26.04 bring GNOME 45 to 50. It
needs Docker; the first run of a release builds its image from
`container/Containerfile`, and releases past their end of life install from
`old-releases.ubuntu.com`. A container has no system bus, which GNOME 50 needs
to start, so an empty one stands in. `--perf` and `--timing` measure the host's
GPU and are not meant for a container.

`.github/workflows/integration.yml` runs the same containers on GitHub's hosted
runners, for pull requests and pushes to `main`. On Wayland it runs 24.04 and
26.04, with the default suite, `--recording`, `--prefs` and `--reload`. On X11 it
runs 24.04, with the default suite, `--recording` and `--x11-scale`.

`--timing` runs `timing-probe.py`, which turns on the timing log and reports the
median time of each capture, export and recording stage over real application
screenshots. `CAPIT_TIMING_CPUS` and `CAPIT_TIMING_QUOTA` run the whole session
under a CPU limit, through `systemd-run --user`, to stand in for a slower
machine. `tests/golden/benchmark.py` times the detector process alone, the
same way, on the reference images.

Requires GNOME Shell 45 to 50, Python GI Gtk4/Gdk/Gio, Python Cairo,
`glib-compile-schemas`, `dbus-run-session`, `timeout`, and `rg`. It installs
nothing and uses no host display or session bus. The runner copies the current
extension into a private temporary XDG data directory, compiles its schemas,
and starts a separate headless Wayland compositor with two virtual outputs.
Settings use an in-memory backend. All captured content is that private
session's synthetic GTK window and Shell stage. PNGs are written inside its
temporary runtime directory and removed afterward. The user's Pictures folder
and clipboard are not used.

`probe.py` enables the extension through native D-Bus, calls the public Capture
API, injects native Clutter pointer/key events through an interface exposed
only by `CAPIT_TEST_MODE=1` (`extension/testing.js`, left out of the package), clicks real St tool buttons, and reads image/png
from a focused GTK client's native clipboard. It asserts smart-window click,
cross-output drag, toolbar dragging by its grip, opaque redaction, text
Enter/Escape, copy/save behavior, partial failure recovery, and extension
disable. Some annotation/text/config
setup uses the explicit test interface; this is not a manual UX acceptance test.

`--scales` prints the virtual outputs' advertised scales. Only when 1.25 is
advertised does it attempt a temporary configuration on the **private**
compositor; this alone does not validate capture geometry at that scale. On
GNOME 46 the virtual outputs advertise scale 1 only.

Runs exit on failed assertions or time out after 90 seconds, or 120 for `--recording`. Shell diagnostics
are printed separately even when assertions pass; a passing assertion suite
does not mean every native service log is warning-free. Cleanup stops only
processes carrying the run's unique temporary runtime directory.

`--prefs` directly launches GNOME's native Extensions preferences service in the
private session. A harness wrapper observes the actual mapped window and
exercises the extension's real EntryRow apply callbacks for output folder and
shortcut validation. It does not synthesize physical typing or clicks on those
rows, and in-memory GSettings cannot establish cross-process persistence. Native
preferences markup/critical errors fail this mode.

`--recording` also starts a private PipeWire and WirePlumber for GNOME's
screencast service, and needs FFmpeg and GStreamer's x264enc or pngenc. It picks
an area in a record overlay, records a window whose colour keeps changing, and
stops. It then checks the saved GIF's size and frame count and reads the
clipboard's `text/uri-list`. It checks where the mode buttons stand beside, after
and inside a region, clicks them, and records a video, checking the MP4's codec,
pixel format and size. It also turns on the demo cursor and checks that its
halo is in the recorded GIF. It starts a recording by clicking the chosen area,
uses the recording bar's demo cursor and Stop buttons, and checks that a
full-monitor area gets no bar. It also cancels a recording, makes a copy-only GIF,
and disables the extension mid-recording. Each time it checks that no
intermediate files are left.

`--perf` checks that the capture overlay keeps up with the pointer on a large
mixed-DPI desk: a 5120x2160 output at scale 1.25 beside two 2560x1440 outputs,
rendered on the real GPU instead of software GL, since it measures compositor
cost. Pointer motion is injected at about 100 events/s, first with no overlay
and then while hovering windows, dragging out a region and drawing a rectangle of
up to about 700x450. An annotation being drawn repaints its whole bounding box,
so a monitor-sized one is also measured and printed, but not asserted.
It fails when the overlay keeps up with under 80% of the pointer-only event rate
or any primary-output frame takes over 50 ms. Frame times come from a
stage-paint log exposed only by `CAPIT_TEST_MODE=1`.
`CAPIT_PERF_MONITORS` (gnome-shell `--virtual-monitor=` arguments) and
`CAPIT_PERF_SCALE` (the primary output's scale, `1` for none) override the desk.
The harness's virtual outputs cannot reproduce every real-desk cost (physical
KMS outputs, other extensions), so a pass bounds the overlay's own drawing cost
rather than guaranteeing a smooth real session.

`--reload` installs the extension the way `make link` does, as a symlink to a
checkout, here a private copy. It edits `capit.js` and the `model.js` it
imports, toggles the extension over D-Bus like `make reload`, and asserts both
edits are live and the temporary module copy is gone. It then breaks
`capit.js` and asserts the extension stays enabled, so that fixing it and
reloading again recovers without a new login. That deliberate break is logged,
so a passing run still prints one `[CapIt] SyntaxError` diagnostic.
