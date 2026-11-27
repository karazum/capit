# Security

## Reporting a problem

Report security problems privately, through
[GitHub's vulnerability report form](https://github.com/karazum/capit/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**), not in a
public issue. Say what you saw, how to reproduce it, and paste the output of
`capit doctor`, which gives the CapIt and GNOME Shell versions.

You'll get an answer within a week. A fix goes out as a new release before the
report is made public, and the advisory credits you unless you'd rather it
didn't.

Only the latest release gets security fixes.

## What CapIt does with your screen

CapIt is meant to keep captures on your computer, and redactions irreversible.
Anything that breaks one of these promises is a security problem:

- **No network.** CapIt opens no network connections and sends nothing
  anywhere: no telemetry, no update checks and no uploads. A capture leaves the
  computer only when you paste or send the file yourself.
- **Files only where you put them.** Screenshots and recordings are saved in
  the output folder set in Preferences, readable only by you. A screenshot is
  rendered in a private folder under `$XDG_RUNTIME_DIR`, normally kept in
  memory, and deleted when the capture closes. A recording is first written
  to a folder under `~/.cache/capit` and deleted when the recording is
  finished or cancelled. If GNOME Shell crashes during a recording, that
  folder stays until you delete it. A capture copied as a file but not saved
  is kept in `~/.cache/capit/clipboard` so that it can be pasted, and replaced
  by the next one.
- **Redaction removes the pixels.** In the saved or copied PNG, a redaction
  replaces every pixel it touches, edges included, with solid colour. A PNG
  has no layers, so the original pixels are gone, not hidden under the box.
  A blur averages the area in blocks of 12 pixels, which can't be undone either,
  but guessing can sometimes match a blurred short text, such as a number,
  against blurred candidates. Use redaction for anything that must stay secret.
- **Recordings have no annotations.** A GIF or video records the area as it
  appears on screen, so close or move anything private before you record.
- **Elements are read locally.** To find the elements under the pointer,
  CapIt looks at the frozen image, or with the **Accessibility tree** setting
  asks applications for the positions of their elements. Neither leaves the
  computer or is written to disk.

Not security problems: a blur weaker than you'd like (use redaction), or content
you captured yourself and shared.
