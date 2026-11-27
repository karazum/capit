# Product

## Goal

CapIt brings the capture workflow ShareX users know to GNOME:

> Shortcut → select → annotate → copy or save.

It is for developers, support staff, technical writers, and anyone who
repeatedly shares annotated screenshots or short recordings. It aims to win on a
fast workflow and dependable desktop integration, not on the number of
features.

CapIt is an independent application inspired by ShareX's workflows. It uses no
ShareX code, assets, configuration or uploaders.

## Principles

- A capture needs few decisions once the user has set up their preferences.
- Everything works locally, with no account or network service.
- The shortcut goes straight to region selection. A desktop capture picker
  followed by cropping is not an equivalent flow.
- When a capability is unavailable, say why and offer an alternative. Manual
  selection always works when smart boxes do not.
- Annotations are applied before export; an edited capture is never shared as
  its unedited original.
- No tray icon or resident companion application. CPU-heavy rendering,
  detection and encoding run outside Shell's UI thread.

## Capture behavior

- Capture freezes the screen when it starts; selection and annotation work on
  that still image, in one overlay across all monitors.
- Smart boxes highlight the window or the element under the pointer for click
  selection. Whole windows are always offered; smaller elements depend on the
  detection mode and the application.
- After a smart box is clicked or a rectangle dragged, the region stays movable
  and resizable while the annotation toolbar appears. Selecting does not finish
  the capture, unless **Capture without annotating** is on in Preferences: then
  picking a screenshot's region copies and saves it at once.
- Enter, or a click inside the region with the select tool, copies the final
  image and saves a PNG. Copy-only and Save-only are separate actions. Escape
  before export cancels without any output.
- While text is being entered, Enter commits it and leaves the capture open; a
  second Enter finishes. Ctrl+Enter commits and finishes together.
- If copying or saving fails, the frozen image and edits are kept for retry and
  the output that succeeded is kept. Retrying an unchanged capture runs only
  the failed output. Cancelling then does not undo the completed output.

## Workflows

| Workflow | User experience | Status |
| --- | --- | --- |
| Quick capture | Trigger capture, select content, copy and save the PNG | Implemented |
| Annotated capture | Capture, annotate, copy and/or save the final image | Implemented |
| Record GIF or video | Select an area, switch mode, record, stop, copy and/or save a GIF or MP4 | Implemented |
| Review a recent capture | Open history, view or edit, export a new revision | Planned |
| Share a capture or clip | Upload, copy the returned URL | Planned |
| Extract text | Capture or open an image, run local OCR, copy the text | Later |

Saving and copying are independent outputs; a failed output never erases one
that succeeded.

## Out of scope for now

- Upload destinations, custom HTTP uploaders and copy-link actions.
- A capture-history browser.
- Audio, hardware encoding, and recording whole windows or monitors.
- OCR, scrolling capture, image stitching, automatic capture and pin-to-screen.
- ShareX configuration import, plugins and user scripts.
- Desktops other than GNOME, Windows and macOS.

## Release criteria

- A shortcut immediately enters region selection, from which the user can
  select, annotate, save, and paste a PNG into another application.
- Save and clipboard outputs use the same exported pixels.
- Whole-window smart boxes work on every supported GNOME version; manual
  selection is available wherever smaller elements are not.
- Multiple monitors with different scales, and selections crossing them, work.
  Fractional and mixed scales, rotated outputs and monitors left of or above the
  primary are covered by tests or recorded checks.
- Closing the overlay keeps the clipboard contents, with and without a
  clipboard manager.
- A failed export keeps the edits and allows retry without capturing again.
- Every supported GNOME version and session type has a recorded test result.
