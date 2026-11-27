# Notes for extensions.gnome.org review

These notes answer the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
for the packaged extension, rule by rule. They describe the code as it is; update
them when it changes.

## What the package contains

`make package` builds the zip from `extension/`. It holds the JavaScript modules,
`stylesheet.css`, the top-bar icon `icons/capit-symbolic.svg`, `metadata.json`,
the settings schema and `LICENSE`. It does not
hold `testing.js`, the control interface of the headless test harness, which
`capit.js` imports only when Shell runs with `CAPIT_TEST_MODE=1`, an
environment variable only the harness sets; nor tests, build scripts or
translations.

| Module | Runs in | Purpose |
| --- | --- | --- |
| `extension.js` | Shell | Entry point; imports `capit.js` on enable |
| `capit.js` | Shell | Panel menu, shortcuts, D-Bus API, capture and recording lifecycle |
| `overlay.js`, `widgets.js` | Shell | Capture overlay, its input, toolbars and export |
| `detection.js` | Shell | Starts and talks to the element-detection worker |
| `recording.js`, `recordingbar.js`, `cursor.js` | Shell | Recording through GNOME's screencast service, its bar and demo cursor |
| `model.js`, `paint.js`, `timing.js` | Shell | Pure geometry and undo state, annotation drawing, optional timing log |
| `prefs.js`, `doctor.js` | Preferences | GTK 4 / libadwaita preferences, and the dependency status they show |
| `renderer.js`, `detector.js`, `visual.js`, `regions.js`, `accessibility.js`, `encoder.js`, `worker.js` | `gjs -m` worker processes | PNG export, element detection, accessibility lookup, encoding |

## General guidelines

- **Initialization.** `extension.js` defines no constructor and does nothing at
  import. `enable()` imports `capit.js` and creates the `CapIt` object, which
  creates every widget, signal connection, keybinding, D-Bus export and
  setting; `disable()` undoes each of them.
- **Module scope.** Modules call `Gio._promisify` on Shell and Gio prototypes
  when they load, as GNOME Shell's own modules do. Three primitives live at
  module scope on purpose and survive disable: `timing.js` numbers timing log
  lines and logs the machine description once per session, and `recording.js`
  remembers which lossless GStreamer encoder worked, so later recordings skip
  missing ones.
- **Development loader.** When the installed extension is a symlink to a source
  checkout, `enable()` imports a fresh copy of the extension's own modules from
  a temporary directory and deletes the copy, because Shell caches modules for
  the session. An extension installed from the zip is a directory, never a
  symlink, and takes the plain `import('./capit.js')` path. The loader touches
  only CapIt's own files and never another extension or the extension system.

## Rules

- **Destroy all objects; disconnect signals; remove main loop sources.**
  `CapIt.disable()` removes both keybindings, destroys the recording bar, the
  recording, the overlay and the panel indicator, disconnects
  `monitors-changed` and unexports the D-Bus object. The overlay disconnects its
  idle later, stops its worker processes and destroys its actor tree, which
  carries every signal it connected on its own actors. A recording removes its
  one-second tick, its time limit and its screencast `Error` subscription when
  it ends; the demo cursor removes its polling and repaint timeouts. Two
  one-shot `after-paint` handlers in `capit.js` disconnect themselves on the
  next frame. No code calls `run_dispose()`.
- **Deprecated modules.** None: no `ByteArray`, `Lang` or `Mainloop`.
- **GTK in Shell, Shell libraries in preferences.** Shell-side modules import
  no `Gtk`, `Gdk` or `Adw`; `prefs.js` imports no `Clutter`, `Meta`, `St` or
  `Shell`; it imports `Gst` only to look elements up in the GStreamer registry
  for the status it shows. `GdkPixbuf` (PNG decoding in `detector.js`) and `Atspi`
  (`accessibility.js`) are used only inside `gjs -m` worker processes.
- **Readable code.** Plain ES modules, no build step, minifier or transpiler.
  `make lint` runs ESLint with GNOME Shell's rules.
- **Logging.** Twelve calls in all. Errors: a failed capture, export or
  recording, and a load error of a development checkout. Warnings: element
  detection or the accessibility lookup stopping, after which smart boxes fall
  back to whole windows. `timing.js` logs stage timings only while the
  *Log stage timings* setting, off by default, is on.
- **Scripts and binaries.** The zip contains no binaries and no non-JavaScript
  scripts. Work that would stall Shell's compositor thread runs in worker
  processes started with `Gio.Subprocess` as `gjs -m <module>` from the
  extension directory: PNG encoding and annotation rendering, pixel-based
  element detection, AT-SPI queries that can block on an unresponsive
  application, and video encoding. Each reads one JSON request or a line
  protocol on stdin and answers on stdout. The overlay and the recording stop
  their workers when they close or are cancelled, and `disable()` closes both.
  The only programs started besides `gjs` are the system's `ffmpeg`, an
  optional dependency the user installs, run by `encoder.js` for GIF and MP4
  encoding, and `setpriv` from util-linux, which gives FFmpeg a parent-death
  signal so it stops if the encoder is killed mid-encode.
- **Clipboard.** Declared in the description. CapIt writes a capture to the
  clipboard only when the user copies it, and never reads the clipboard. Its
  default shortcuts (Super+Shift+S, Super+Shift+G) open the capture and
  recording overlays; none acts on clipboard data.
- **Privileged subprocesses.** None.
- **metadata.json.** `uuid` uses the maintainer's GitHub Pages domain; no `version`
  or `session-modes` key. `shell-version` lists 45 to 50, each
  passing the headless test suite on its Ubuntu release (see
  `docs/test-results/`). `url` must point at the public repository before
  submission.
- **GSettings.** Schema `org.gnome.shell.extensions.capit` at
  `/org/gnome/shell/extensions/capit/`, in
  `schemas/org.gnome.shell.extensions.capit.gschema.xml`, which the zip
  includes.
- **Telemetry and network.** None; CapIt makes no network connections.
- **Licensing.** GPL-3.0-or-later, `LICENSE` in the zip, an SPDX line in every
  file. The FFmpeg arguments follow values ShareX documents; no code is copied
  from it or from another extension.

## Authorship

The guidelines reject code the submitter cannot explain. Before submission the
maintainer reads every file in the package.

_To be written by the maintainer, in their own words: how AI tools were used in
developing CapIt._
