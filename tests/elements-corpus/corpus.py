# SPDX-License-Identifier: GPL-3.0-or-later
"""Reads what capture.sh recorded: a window's pixels as streamed to the detector, and its accessible elements."""
import io
import json
from pathlib import Path

import cairo

# Roles whose rectangles are panel-like. Other roles are labels, buttons and wrappers.
PANEL_ROLES = {'panel', 'filler', 'list', 'list box', 'tree', 'tree table', 'table', 'scroll pane', 'tool bar',
               'header bar', 'title bar', 'text', 'document web', 'document text', 'page tab list', 'grouping',
               'section', 'landmark', 'status bar', 'viewport', 'split pane', 'page tab', 'list item', 'entry',
               'tab', 'navigation', 'content info', 'banner', 'region', 'group', 'push button', 'toggle button'}


def frames(stream):
    """Bands of a recorded stream. @return [Array(Hash, bytes)] header and PNG bytes"""
    data = Path(stream).read_bytes()
    position = 0
    while position < len(data):
        end = data.index(b'\n', position)
        header = json.loads(data[position:end])
        yield header, data[end + 1:end + 1 + header['length']]
        position = end + 1 + header['length']


def image(stream, index=0):
    """One window of a recorded stream, stitched. @return [Array(cairo.ImageSurface, Hash)] pixels and band header"""
    bands = [(header, cairo.ImageSurface.create_from_png(io.BytesIO(png))) for header, png in frames(stream)
             if header['index'] == index]
    header = bands[0][0]
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, bands[0][1].get_width(), sum(band.get_height() for _, band in bands))
    context = cairo.Context(surface)
    top = 0
    for _, band in bands:
        context.set_source_surface(band, 0, top)
        context.paint()
        top += band.get_height()
    return surface, header


def accessible(description, header, index=0):
    """Accessible elements as rectangles in logical pixels relative to the window image.

    @return [Array<Hash>] role, name, depth, rect [x, y, width, height]
    """
    client = description['owners'][index]['client']
    frame = description['windows'][index]
    scale = description['scale']
    elements = description['elements']
    if not elements:
        return []
    # GTK 4 positions elements relative to the visible frame, leaving out its shadow; Chromium positions them
    # relative to the client rectangle. Whichever rectangle has the accessible frame's shape is the reference.
    # X11 applications under fractional scaling report device pixels; the frame's width shows which unit it is.
    width, height = elements[0]['rect'][2:]
    reference = min(([frame['x'], frame['y'], frame['width'], frame['height']], client),
                    key=lambda rect: abs(width / rect[2] - height / rect[3]))
    ratio = width / reference[2]
    ratio = 1.0 if abs(ratio - 1) < 0.02 else ratio
    client = reference
    left, top = header['origin'][0] / scale, header['origin'][1] / scale
    # Chromium on Wayland at a fractional scale reports its window in logical pixels and the page in device pixels.
    page = next((element for element in elements if element['role'] == 'document web'), None)
    zoom = scale if page and page['rect'][2] > width * 1.02 else 1
    found = []
    for element in elements[1:]:
        inner = zoom if page and element['depth'] >= page['depth'] else 1
        x, y, width, height = (value / ratio / inner for value in element['rect'])
        found.append({**element, 'rect': [client[0] + x - left, client[1] + y - top, width, height]})
    return found
