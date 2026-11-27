# CapIt

## Live testing

The user tests changes in their real GNOME session through the installed extension, which `make link` points at this checkout's `extension/` folder. After any change under `extension/`, finish by running `make reload`. It runs `make link`, which is idempotent: it recompiles the schemas and restores the link if `make install` replaced it with a copy. Then it disables and enables the extension, which closes a capture the user has open.

GNOME Shell 46 on Wayland caches extension modules for the whole session, so `extension.js` is only a stub. On each enable of a symlinked install it imports `capit.js`, and everything that imports, from a fresh copy. When you hand a change over, tell the user what makes it live:

- `renderer.js`, `accessibility.js`: the next capture, and `encoder.js` the next recording, since the extension spawns them fresh from its directory each time. `worker.js`, which every one of these workers and `detector.js` import, applies to the next capture and recording. `paint.js` is imported by both `renderer.js` and `capit.js`, so it needs `make reload` for the preview and the next export for the PNG.
- `capit.js`, `overlay.js`, `detection.js`, `widgets.js`, `recordingbar.js`, `model.js`, `recording.js`, `cursor.js`, `timing.js`, `paint.js`, `testing.js`, `stylesheet.css`: `make reload`.
- `detector.js`, `visual.js`, `regions.js`: the next capture, as `detector.js` is spawned fresh and imports the other two.
- `doctor.js`: the next `capit doctor`; in the preferences window, like `prefs.js`, which imports it.
- `extension.js`, `prefs.js`, schemas: logout/login. A nested shell, `dbus-run-session -- gnome-shell --nested --wayland`, loads the working tree fresh without logging out.

A load error in a linked checkout shows up as a "CapIt" error notification rather than as the extension's error state, so the next `make reload` can recover.
