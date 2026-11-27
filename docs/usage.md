# Using CapIt

This covers everything after [installing](../README.md#install) CapIt: the
controls, how smart boxes find elements, recording, the clipboard, the command
line and the timing log.

## Taking a screenshot

Press **Super+Shift+S**, or choose **Capture region** from the cap in the top
bar. The desktop freezes on every monitor. Hover a window, or a panel inside it,
and click the box CapIt offers, or drag a rectangle. Annotate the region, then
press Enter to copy and save it. If copying or saving fails, the capture stays
open so you can try again, and whatever already succeeded is kept.

**Preferences**, in the same menu or from `capit preferences`, change the
shortcuts and the output folder. The default folder is `CapIt` in the desktop's
Pictures directory.

## Capture controls

| Action | Control |
| --- | --- |
| Smart window or panel selection | Hover, click |
| Wider / narrower smart box | Scroll up / down while hovering |
| Manual selection | Drag a rectangle |
| Move / resize selected region | Select tool, drag inside / drag a corner |
| Select tool | V |
| Arrow / rectangle / circle / brush / blur / redact / text | A / R / C / P / B / X / T |
| Round circle instead of an ellipse | Hold Shift while drawing |
| Thicker / thinner line of the active arrow, rectangle, circle or stroke | Scroll up / down |
| Place text | Text tool, click in the selected region, type |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z, or the curved-arrow toolbar buttons |
| Copy and save | Enter, or click inside the selected region with the select tool; at once on picking a region with **Capture without annotating** |
| Copy only / save only | Ctrl+C / Ctrl+S |
| Finish while entering text | Ctrl+Enter |
| Cancel | Escape (first dismisses a pending text/folder entry) |

Each toolbar button with a shortcut shows it in a small label, so the keys are
easy to learn. **Show shortcuts on toolbar buttons** in Preferences turns the
labels off.

Click **Folder…** in the overlay to change an unwritable save destination without
discarding the capture. Apply the folder with Enter, then finish/retry. Clipboard
data is owned by GNOME Shell and survives overlay closure.

## Elements inside windows

Preferences choose how smart boxes find elements inside a window. The setting is
read when a capture opens:

- **Visual** (default): looks for straight borders, background changes and areas
  of flat background in the frozen image, and what stands out from them. Works
  for every application. It finds sidebars, toolbars and editor panes, panels
  that no border runs all the way across, and cards, tabs, text fields, buttons
  and pictures inside panels. Each line of text or icons is a row across its
  panel, and each word, label and icon on it a box of its own. A hover offers
  the smallest box under the pointer, such as a line, and scrolling up widens it
  to the panel. A sidebar stays one panel across its separators and selected
  row, and a picture stays whole. Runs in GJS, with nothing extra to install.
- **Accessibility tree**: asks the application what is under the pointer, down to
  single buttons and labels. GTK and Qt applications answer. Chromium and
  Electron applications (browsers, VS Code, Slack, and the like) answer only when
  started with `--force-renderer-accessibility`; otherwise their windows offer
  whole-window boxes only. Turning on GNOME's screen reader setting does not
  change that, so CapIt does not touch it.
- **None**: whole windows only.

**Outline large regions** (off by default) also draws the large panels found in
the window under the pointer in coloured dashes, each with a tab showing its
size that selects it whole.

To switch without opening Preferences:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/capit@karazum.github.io/schemas \
  set org.gnome.shell.extensions.capit element-detection accessibility  # or visual, none
```

The Ubuntu packages install the schema system-wide, so there the `--schemadir`
option is not needed.

## Screenshot, GIF and video modes

Three buttons beside a selected region switch what Enter makes of it: a
screenshot, a GIF or a video. They stand left of the region, right of it when
the left edge of the monitor is too close, and just inside it when the region
fills the monitor. Annotation tools belong to screenshots; a recording mode
hides them and any annotations until you switch back.

In GIF and video mode, the pointer button in the toolbar (or **D**) turns on the
demo cursor: a yellow halo around the pointer and a ripple for each click, drawn
into the recording. It stays on for later recordings until you turn it off, here
or in Preferences.

Press **Super+Shift+G** to open the overlay in the recording mode you used last
(GIF at first), or choose **Record GIF** or **Record video** from the panel menu.
Pick an area with the same smart boxes and drag as a screenshot, then click the
area again or press Enter. A red frame marks the area while it records, and the
panel shows the elapsed time. Where the area's monitor has room, a small bar
beside the area shows the time, a **Stop** button and the demo cursor toggle, so
you can turn the highlight on and off mid-recording. Press Stop, Super+Shift+G,
or choose **Stop recording** in the panel menu to make the file. **Cancel recording** discards it. GIF recordings stop on
their own after 60 seconds by default; videos have no limit.

The file is saved in the output folder and copied to the clipboard; see
[Clipboard](#clipboard). Preferences can switch to copy-only or save-only.

- **GIF:** 15 frames per second, one palette built from the whole recording
  (`palettegen=stats_mode=full`), and Sierra Lite dithering
  (`paletteuse=dither=sierra2_4a`). Preferences change the frame rate, palette
  mode, dithering, Bayer scale and time limit.
- **Video:** MP4 with H.264 at 30 frames per second, `-preset ultrafast -crf 28
  -pix_fmt yuv420p -movflags +faststart`, without sound. An odd width or height
  loses its last pixel column or row, since `yuv420p` needs even sizes.
  Preferences change the frame rate, quality (CRF), encoding speed and time limit.

Recording needs `ffmpeg`. GNOME's screencast service records the area
losslessly first, and FFmpeg encodes the GIF or video after you stop. The
lossless recording uses x264 from `gstreamer1.0-plugins-ugly` when it is
installed, and otherwise PNG frames, which take much more temporary disk space.

```sh
sudo apt install ffmpeg gstreamer1.0-plugins-ugly
```

## Clipboard

**Copy only** (Ctrl+C, or a recording set to copy only) always puts the image or
video itself on the clipboard. For **copy and save** (Enter, or a recording set
to both), **Copy and save puts on the clipboard** in Preferences decides, for
screenshots and recordings alike:

- **File** (default): a reference to the saved PNG, GIF or MP4. Chat apps,
  browsers and Files paste it as an attachment, and a GIF keeps its animation.
  If saving fails, a copy is kept in `~/.cache/capit/clipboard`, where only the
  newest stays.
- **Content**: the PNG, GIF or MP4 data itself, for image editors and pages that
  paste image data. Captures over 100 MB are copied as a file instead, since
  GNOME Shell holds clipboard data in its own memory.

Only GTK test clients have read these so far, not real chat apps or browsers.

## Command line

The Ubuntu packages install a `capit` command; in a source checkout it is
`./scripts/capit`.

```sh
capit capture       # open a capture, for a shortcut of your own
capit status        # what CapIt is doing
capit preferences   # open Preferences
capit doctor        # GNOME, the session, and what recording still needs
capit timings       # the timing log, see below
```

`capit doctor` prints the CapIt and GNOME Shell versions, the session type,
whether the extension is installed and enabled, and each program and GStreamer
element CapIt uses, with the package to install for any that is missing. Attach
its output to bug reports. The preferences window shows the same status, and
greys out the recording settings when recording cannot work.

## Timing log

When CapIt feels slow, **Preferences → Diagnostics → Log stage timings** writes
how long each stage of a capture, export and recording takes to the system
journal. The first line describes the machine: GNOME version, session type, CPU,
memory and monitors. Read the lines with `capit timings`, or with
`journalctl --user -b -g 'CapIt timing'`:

```text
capture 3 · snapshot: 41.2 ms (total 57.9 ms) · scale 1.25
capture 3 · window 0 detected: 51.9 ms (total 93.8 ms) · 12 boxes
export 4 · render: 54.0 ms (total 67.3 ms) · 2 annotations, saved
```
