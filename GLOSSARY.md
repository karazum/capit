# CapIt

Language for discussing CapIt's capture and sharing workflows.

## Language

**Capture workflow**:
The sequence from triggering a screen capture through selecting content,
optionally annotating or redacting it, and copying or saving the result.
_Avoid_: Capture pipeline (when discussing the user's workflow)

**Capture overlay**:
The view of the frozen desktop in which the user selects a region and annotates
it before copying or saving the result.
_Avoid_: Editor window (when referring to this in-place interaction)

**Smart box**:
A suggested capture rectangle corresponding to the window or UI element under
the pointer, selectable with a click.
_Avoid_: Edge snapping (a different interaction when dragging a selection)

**Manual region**:
A capture rectangle drawn by dragging, independently of any smart box.

**Capture mode**:
What Enter makes of the selected region: a screenshot, a GIF or a video,
switched with the buttons beside the region.

**Recording**:
A GIF or video of a selected screen area, delivered to the clipboard, the output
folder, or both.
_Avoid_: Screencast (GNOME's service that captures the frames)
