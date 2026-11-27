# GNOME compatibility

CapIt supports GNOME only, as a GNOME Shell extension, on Wayland and on Xorg.
Support is claimed only for versions and session types with a recorded test
result in [test-results](test-results/).

## Tested environments

| Environment | Result |
| --- | --- |
| GNOME 46 on Wayland, Ubuntu 24.04, real login | Used in a real session; physical mixed-scale layouts not yet validated |
| GNOME 45 to 50 on Wayland (Ubuntu 23.10 to 26.04), headless | Every integration scenario passes on each version: loading, capture, smart boxes, export, recording, preferences, reload. [Results](test-results/2026-11-26-gnome-45-50-headless.md) |
| GNOME 45 to 48 on Xorg (Ubuntu 23.10 to 25.04), headless | Every scenario passes on two outputs, plus recording and 200% scaling. [Results](test-results/2026-11-26-gnome-xorg-headless.md) |

Not yet checked: a real login on any release but Ubuntu 24.04, a real Xorg
login, 125% scaling on Xorg, and physical mixed-scale, rotated or offset monitor
layouts. GNOME 49 and later have no Xorg session.

## Why a Shell extension

The desktop portals do not fit the workflow:

- An ordinary Wayland client cannot learn where other windows are, which
  whole-window smart boxes need. This is the deciding reason.
- After a one-time grant, GNOME's Screenshot portal can return a full-screen
  image without a dialog, but it flashes the screen, and an application would
  still have to build a fullscreen overlay across every monitor and scale
  itself.
- GNOME 46's portal backend does not offer the GlobalShortcuts portal.

The extension freezes Shell's stage, reads window frames from Mutter, takes a
modal grab for its overlay, and registers its shortcuts with Shell's window
manager. The [GNOME interface notes](research/gnome-extension-interfaces.md)
list the Shell APIs used.

## Shortcuts

Super+Shift+S captures and Super+Shift+G records; both are configurable in
Preferences. `capit capture` reaches the same code over the extension's D-Bus
interface, so a desktop custom shortcut works too.

## Recording

Recording does not use the ScreenCast portal. The extension calls GNOME's own
screencast service, `org.gnome.Shell.Screencast.ScreencastArea`, from inside
Shell with its own pipeline; see [architecture](architecture.md#recording). It
needs `pipewiresrc`, which GNOME's own recorder needs too, and FFmpeg.
`x264enc` from `gstreamer1.0-plugins-ugly` gives the smallest intermediate;
without it, PNG frames are used. `capit doctor` reports each of these.

## Manual test record template

Record each run in a new dated file under `docs/test-results/`. Include:

- The output of `capit doctor`, the distribution and the CapIt commit.
- Session type (Wayland or Xorg) and whether it was a real login or a headless
  or nested session.
- Monitor layout: each monitor's size, scale, rotation and position, including
  monitors left of or above the primary.
- Capture, cancellation and repeated triggers while a capture is open.
- Selection coordinates against the saved PNG's pixels, across monitors.
- Pasting into GTK, Qt and browser applications; then closing the overlay,
  restarting the application and pasting again, with and without a clipboard
  manager.
- An unwritable output folder and a filename collision: errors keep the
  capture and show no false success.
- Lock and unlock, suspend, and monitor hotplug.
- Capture and export latency, from the timing log, with the hardware.

Report diagnostics without screenshot contents or secrets.
