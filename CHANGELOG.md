# Changelog

All notable changes to CapIt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). A release's section becomes its
release notes on GitHub; [releasing](docs/releasing.md) has the procedure.

## [Unreleased]

The first public release, a beta for GNOME 45 to 50 on Wayland and Xorg.

### Added

- Screenshots of a frozen desktop across all monitors, from a shortcut
  (Super+Shift+S) or the panel menu.
- Smart boxes: hover a whole window, or a panel, line, word or picture inside
  it, and scroll up to widen the box. Elements are found in the image itself,
  from the applications' accessibility tree, or not at all, as Preferences
  choose. Or drag a region across displays.
- A selection that can be moved and resized before it is used, or used as soon
  as it is picked with **Capture without annotating**.
- Annotation in place: arrows, rectangles, circles, brush strokes, blur, solid
  redaction and text, with undo, redo and a colour palette.
- Copy and save with Enter, or copy only (Ctrl+C) or save only (Ctrl+S). A
  failed copy or save keeps the capture open to try again.
- GIF and MP4 recording of a selected area (Super+Shift+G), with a stop bar,
  a time limit for GIFs and an optional demo cursor that highlights the pointer
  and its clicks.
- A choice of what goes on the clipboard: a reference to the saved file, which
  chat applications and browsers paste as an attachment, or the image or video
  itself.
- `capit doctor`, which reports what recording needs and whether this computer
  has it, also shown in Preferences.
- Packages for Ubuntu 24.04 and 26.04 from `ppa:karazum-capit/stable`.

[Unreleased]: https://github.com/karazum/capit/commits/main
