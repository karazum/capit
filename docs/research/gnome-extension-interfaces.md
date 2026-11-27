# GNOME 46 extension integration notes

2026-10-15. Checked against the upstream `46.0` tags of GNOME Shell and Mutter,
linked below. These are Shell-specific interfaces; later GNOME versions changed
some of them, as the [GNOME 45 to 50 results](../test-results/2026-11-26-gnome-45-50-headless.md)
record.

## Snapshot, crop and PNG

GNOME's selector uses the following GJS shape. GI async wrappers may already be
installed by Shell's screenshot module; avoid repeatedly wrapping the same method.
[Shell 46 screenshot JS](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/screenshot.js)

```js
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');
const shooter = new Shell.Screenshot();
const [content, scale, cursorContent, cursorPoint, cursorScale] =
    await shooter.screenshot_stage_to_content();
const texture = content.get_texture();
```

The captured desktop and cursor are separate. Capture before showing the overlay.
Selection coordinates start in stage logical units; multiply x/y/w/h by `scale`
for texture pixels. Cursor position likewise becomes `cursorPoint.x * scale`,
`cursorPoint.y * scale`; pass the returned `cursorScale` unchanged. Cursor point
already accounts for the hotspot. Null cursor content is valid.
[C implementation and comments](https://github.com/GNOME/gnome-shell/blob/46.0/src/shell-screenshot.c)

```js
const stream = Gio.MemoryOutputStream.new_resizable();
const pixbuf = await Shell.Screenshot.composite_to_stream(
    texture, xPx, yPx, widthPx, heightPx, scale,
    cursorTextureOrNull, cursorXPx, cursorYPx, cursorScale,
    stream);
stream.close(null);
const bytes = stream.steal_as_bytes();
```

`composite_to_stream` crops the existing `Cogl.Texture` to a subtexture, optionally
composites the cursor, and writes PNG; it returns a `GdkPixbuf.Pixbuf`. Width or
height `-1` selects the entire texture and resets origin. Crop arguments are
integers: clamp to texture bounds and define rounding at scaled edges. Keep the
texture referenced until encoding completes. The underlying implementation reads
texture data before asynchronous PNG saving, so large images can still affect
Shell responsiveness. This is a reason to keep annotation/recording work out of
Shell's UI thread.
[C signatures](https://github.com/GNOME/gnome-shell/blob/46.0/src/shell-screenshot.h)

Direct methods take output streams, **not filenames**:

```js
await shooter.screenshot_area(x, y, width, height, stream);
await shooter.screenshot(includeCursor, stream);
```

Their finishes expose a boolean and captured area through GI; callers here should
prefer frozen-content cropping so capture does not include a subsequently shown
overlay. Do not recapture the live desktop on selection completion. Only one
stream screenshot operation at a time is accepted per shooter.

## Frozen actor allocation

Bind a screenshot actor/container to `global.stage` with
`Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL})`,
then `actor.set_content(content)`. The built-in selector follows this pattern.
An explicit `content_gravity: Clutter.ContentGravity.RESIZE_FILL` scales content
to the actor allocation; it exists in Mutter 46. Clear content on teardown to
release screenshot textures.
[Mutter 46 enum](https://github.com/GNOME/mutter/blob/46.0/clutter/clutter/clutter-enums.h)

## Modal input and events

```js
const grab = Main.pushModal(actor, {actionMode: Shell.ActionMode.POPUP});
if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
    Main.popModal(grab);
    // Abort opening the selector.
}
// On successful close, exactly once:
Main.popModal(grab);
```

`pushModal` returns a `Clutter.Grab`, not a boolean. It sets focus and maintains
Shell modal/action state. `popModal` expects that grab. Actor destruction also
automatically pops a registered modal grab, so pop explicitly before destroying
and never pop the same grab twice.
[Shell modal implementation](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/main.js)

The built-in helper connects `actor.connect('captured-event', (actor, event) => …)`
after a successful modal grab. Use `event.type()`, `event.get_key_symbol()`,
`event.get_coords()` → `[x, y]`, `event.get_button()`, and `event.get_state()`.
Relevant enums are `Clutter.EventType.KEY_PRESS`, `BUTTON_PRESS`, `BUTTON_RELEASE`,
`MOTION`; return `Clutter.EVENT_STOP` for handled events and
`Clutter.EVENT_PROPAGATE` otherwise. Escape is `Clutter.KEY_Escape`.
[GrabHelper source](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/grabHelper.js)

Disconnect owned signal handlers, restore cursor, release the grab, destroy actors,
and null screenshot references on cancel, errors, disable, monitor changes, and
session transitions. Async capture completion needs a generation/cancellation
guard so it cannot recreate UI after disable. No cancellable argument is exposed
by `screenshot_stage_to_content`; cancellation can discard its eventual result.

## Window smart boxes

Snapshot visible frame rectangles in stacking order, limited to the active
workspace. `showing_on_its_workspace()` alone also matches windows that would be
visible if another workspace were current; pair it with
`located_on_workspace(global.workspace_manager.get_active_workspace())`.
The latter includes sticky windows. See the primary
[workspace visibility](https://mutter.gnome.org/meta/method.Window.showing_on_its_workspace.html)
and [workspace membership](https://mutter.gnome.org/meta/method.Window.located_on_workspace.html)
API references. Runtime compatibility is checked in the native GNOME 46 suite;
dedicated workspace-transition acceptance remains a later lifecycle test.

## Clipboard

```js
St.Clipboard.get_default().set_content(
    St.ClipboardType.CLIPBOARD, 'image/png', bytes);
```

`bytes` is `GLib.Bytes`; PNG clipboard publishing needs no external helper.
[St clipboard header](https://github.com/GNOME/gnome-shell/blob/46.0/src/st/st-clipboard.h)
An external editor's final annotated PNG can use the same mechanism if returned
to the extension; save/copy failure reporting and asynchronous completion still
need an explicit application contract.
