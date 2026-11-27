# Roadmap

CapIt is an alpha. This lists what works, what stands between it and 1.0, and
what comes after. Compatibility claims stay limited to tested GNOME versions
and session types; see [compatibility](compatibility.md).

## Implemented

- **Capture.** A shortcut or the panel menu freezes the desktop across
  monitors. Smart boxes offer whole windows and, depending on the detection
  mode, the panels and controls inside them; a drag selects any rectangle,
  across displays. The selection stays movable and resizable until finished.
- **Annotation.** Arrows, rectangles, circles, freehand strokes, blur, solid
  redaction and text, with colours, line widths, undo and redo, drawn in the
  overlay around the selection.
- **Output.** Enter copies and saves one flattened PNG; Copy-only and Save act
  alone. A failed output keeps the capture open for retry and never undoes an
  output that succeeded. Saving never overwrites an existing file.
- **Recording.** GIF and silent MP4 of a selected area through GNOME's
  screencast service and FFmpeg, with a recording bar, a time limit and a demo
  cursor that shows the pointer and its clicks.
- **Diagnostics.** `capit doctor`, the same status in Preferences, and an
  opt-in timing log.
- **Testing.** Unit and GJS tests in CI; a headless GNOME harness that drives
  the installed extension on GNOME 45 to 50 on Wayland, and 45 to 48 on Xorg.

## Before 1.0

- [ ] Real logins, not only headless sessions, on each claimed GNOME version,
  on Wayland and on Xorg.
- [ ] Fractional scaling (125%) on Xorg, and mixed-scale, rotated and offset
  monitor layouts on Wayland.
- [ ] Pasting captures and recordings into browsers, chat applications, Files,
  and Qt applications, with and without a clipboard manager.
- [ ] Lock and unlock, suspend, monitor hotplug, disable during a capture, and
  cleanup after a crash.
- [ ] Recording over fullscreen video and games, longer recordings, and the
  effect of Shell's own popups on a recording.
- [ ] Packages: an extension zip and a `.deb` per Ubuntu release on GitHub
  Releases, and a PPA.

## After 1.0

- Publishing on extensions.gnome.org.
- Uploads to a sharing service, opt-in, with credentials in the desktop
  keyring and the local file kept when an upload fails.
- A history of recent captures, to reopen, edit and export again.
- Audio in recordings; recording a whole window or monitor.
- OCR, scrolling capture and pin-to-screen.
- Debian and Fedora packages.
- Other desktops. A GNOME Shell extension cannot run there, so each needs its
  own capture and overlay integration.
