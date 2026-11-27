# Element detection corpus

Synthetic fixtures alone have misled detector work before, so the detectors in
`extension/visual.js` and `extension/regions.js` are judged on real windows.

```sh
out=/tmp/capit-corpus
bash tests/elements-corpus/capture.sh "$out" 1
bash tests/elements-corpus/capture.sh "$out" 1.25
/usr/bin/python3 tests/elements-corpus/score.py "$out" --overlays
```

`capture.sh` starts a private headless GNOME Shell with the extension installed
and opens one application at a time: Files, Text Editor, Settings, Calculator,
Terminal, LibreOffice Calc, Image Viewer, and Microsoft Edge showing `ide.html`
(a dark editor layout) and `article.html` (a light content site), both natively
on Wayland and under Xwayland. The Xwayland window is the one the compositor
upscales at a fractional scale, which gives the soft borders of Electron
editors. Applications run with a made-up home directory, so no personal files
appear. For each window it keeps:

- `NAME-SCALE.stream`: the bands Shell sent to the detector, byte for byte.
- `NAME-SCALE.json`: the window and client rectangles, and the application's
  accessible elements with their window-relative rectangles.

`CORPUS_EXTRA` adds applications of your own, for example an Electron editor:

```sh
CORPUS_EXTRA='[["editor-xwayland", "prefer-dark", ["/path/to/editor", "--ozone-platform=x11"], true]]' \
  bash tests/elements-corpus/capture.sh "$out" 1.25 editor-xwayland
```

`score.py` replays every stream through `extension/detector.js` in each detection
mode and prints one row per capture and mode. `truth.py` holds what is expected, curated by eye:
must-find panels, hover points with the panel each should outline, and clean
zones (running text, pictures) no box may cut through. Accessible rectangles
are only used to recognise boxes that are real elements, and to place the
panels of the two HTML pages; GTK reports many of them offset or oversized, so
they are not ground truth on their own. Captures without an entry in `truth.py`
are listed with their box count only.

The columns: `must` panels found; hover points that got exactly the wanted
panel (`exact`), an accepted larger one (`near`), an element inside it where
that is as good (`child`), or anything else (`wrong`); boxes cutting through
clean zones (`cut`); boxes matching neither a curated panel nor any accessible
element (`junk`, which also counts real elements the application does not
report, such as a tab drawn by a web page); and boxes thinner than 16 px
(`sliver`). The last column is the detector process's time in milliseconds,
start-up included.

Numbers do not replace looking: `--overlays` writes `NAME-SCALE.MODE.png` beside
each capture. Check them after any detector change.

Two captures are checked in under `tests/fixtures/elements` and asserted by
`tests/gjs/elements.test.js`.
