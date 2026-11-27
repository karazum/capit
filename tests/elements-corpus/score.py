#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Scores the element detectors against the corpus recorded by capture.sh.

Usage: score.py CORPUS_DIR [--overlays] [MODE...]     (modes default to visual and regions)

Per capture and mode it prints: how many must-find panels were found, how the hover points fared
(exact: the smallest box under the point is the wanted panel; near: an accepted larger panel;
child: an element inside the wanted panel, where that is as good; wrong: anything else), boxes
cutting through or sitting inside clean zones, junk boxes that match neither a curated panel nor
any accessible element, slivers, and the time of the detector process, start-up included. With --overlays it also writes
NAME.MODE.png beside each capture, to look at.
"""
import json
from pathlib import Path
import subprocess
import sys
import time

import cairo

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here))
import corpus
from truth import TRUTH

DETECTOR = here.parents[1] / 'extension/detector.js'

TOLERANCE = 3
SLIVER = 16
COLOURS = [(1, .2, .6), (.2, 1, .4), (1, .8, 0), (.3, .7, 1)]


def iou(a, b):
    width = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    height = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    if width <= 0 or height <= 0:
        return 0.0
    return width * height / (a[2] * a[3] + b[2] * b[3] - width * height)


def matches(found, wanted):
    """Whether found outlines wanted: every edge within TOLERANCE, or nearly the same area."""
    edges = (found[0] - wanted[0], found[1] - wanted[1], found[0] + found[2] - wanted[0] - wanted[2],
             found[1] + found[3] - wanted[1] - wanted[3])
    return all(abs(edge) <= TOLERANCE for edge in edges) or iou(found, wanted) >= 0.9


def inside(inner, outer):
    return (inner[0] >= outer[0] - TOLERANCE and inner[1] >= outer[1] - TOLERANCE and
            inner[0] + inner[2] <= outer[0] + outer[2] + TOLERANCE and
            inner[1] + inner[3] <= outer[1] + outer[3] + TOLERANCE)


def straddles(found):
    """How many pairs of boxes overlap without one being inside the other, so do not nest."""
    count = 0
    for index, a in enumerate(found):
        for b in found[index + 1:]:
            width = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
            height = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
            if width > TOLERANCE and height > TOLERANCE and not inside(a, b) and not inside(b, a):
                count += 1
    return count


def resolve(truth, accessible):
    """Curated rectangles by name, with accessible-element names looked up. @return [Hash{String => Array}]"""
    named = {}
    for name, value in {**truth['must'], **truth['optional']}.items():
        if isinstance(value, str):
            named[name] = next((element['rect'] for element in accessible if element['name'] == value), None)
        elif isinstance(value, tuple) and value[0] == 'union':
            parts = [named[part] for part in value[1:]]
            left, top = min(part[0] for part in parts), min(part[1] for part in parts)
            named[name] = [left, top, max(part[0] + part[2] for part in parts) - left,
                           max(part[1] + part[3] for part in parts) - top]
        elif isinstance(value, tuple) and value[0] == 'offset':
            base = named[value[1]]
            named[name] = [base[0] + value[2][0], base[1] + value[2][1], value[2][2], value[2][3]]
        else:
            named[name] = value
    return named


def zones(truth, named):
    for zone in truth['clean']:
        if zone[0] == 'rect':
            yield zone[1]
        else:
            base, (left, top, right, bottom) = named[zone[1]], zone[2]
            yield [base[0] + left, base[1] + top, base[2] - left - right, base[3] - top - bottom]


def score(found, truth, accessible, size):
    named = resolve(truth, accessible)
    result = {'boxes': len(found), 'must': len(truth['must']), 'missed': []}
    for name in truth['must']:
        if not any(matches(box, named[name]) for box in found):
            result['missed'].append(name)
    hover = {'exact': 0, 'near': 0, 'child': 0, 'wrong': 0}
    result['wrong'] = []
    for point in truth['points']:
        x, y = point['at']
        if 'in' in point:
            base = named[point['in']]
            x, y = base[0] + x * base[2], base[1] + y * base[3]
        around = [box for box in found if box[0] <= x < box[0] + box[2] and box[1] <= y < box[1] + box[3]]
        picked = min(around, key=lambda box: box[2] * box[3], default=[0, 0, *size])
        wanted = [named[name] for name in point['expect']]
        if matches(picked, wanted[0]):
            outcome = 'exact'
        elif any(matches(picked, rect) for rect in wanted[1:]):
            outcome = 'near'
        elif point.get('children') and inside(picked, wanted[0]):
            outcome = 'child'
        else:
            outcome = 'wrong'
            result['wrong'].append(f"{point['expect'][0]}@{round(x)},{round(y)}")
        hover[outcome] += 1
    result['hover'] = hover
    result['cut'] = sum(1 for zone in zones(truth, named) for box in found
                        if iou(box, zone) > 0 and not inside(zone, box))
    known = list(named.values()) + [element['rect'] for element in accessible
                                    if element['rect'][2] >= 12 and element['rect'][3] >= 12]
    result['junk'] = sum(1 for box in found if not any(iou(box, rect) >= 0.5 for rect in known))
    result['slivers'] = sum(1 for box in found if min(box[2], box[3]) < SLIVER)
    return result


def overlay(surface, scale, found, path):
    copy = cairo.ImageSurface(cairo.FORMAT_ARGB32, surface.get_width(), surface.get_height())
    context = cairo.Context(copy)
    context.set_source_surface(surface)
    context.paint()
    context.scale(scale, scale)
    context.set_line_width(2 / scale)
    for index, (x, y, width, height) in enumerate(sorted(found, key=lambda box: -box[2] * box[3])):
        context.set_source_rgba(*COLOURS[index % len(COLOURS)], 0.9)
        context.rectangle(x + 1 / scale, y + 1 / scale, width - 2 / scale, height - 2 / scale)
        context.stroke()
    copy.write_to_png(str(path))


def detect(stream, mode):
    """Boxes detector.js finds in the first window of a recorded stream, relative to the window, and its run time.

    The recorded bands go through byte for byte; only their origin is moved to the window's corner, so the boxes
    come back in the window's logical pixels rather than the stage's.
    @return [Array(Array<Array<Float>>, Float)] boxes [x, y, width, height] and milliseconds
    """
    payload = b''.join(json.dumps({**header, 'origin': [0, 0]}).encode() + b'\n' + png
                       for header, png in corpus.frames(stream) if header['index'] == 0)
    started = time.perf_counter()
    done = subprocess.run(['gjs', '-m', str(DETECTOR), '--mode', mode], input=payload, capture_output=True, check=True)
    elapsed = (time.perf_counter() - started) * 1000
    answer = json.loads(done.stdout.splitlines()[0])
    if 'elements' not in answer:
        raise RuntimeError(f'{stream.name}: {answer}')
    return answer['elements'], elapsed


def main(arguments):
    overlays = '--overlays' in arguments
    arguments = [argument for argument in arguments if argument != '--overlays']
    directory = Path(arguments[0])
    modes = arguments[1:] or ['visual', 'regions']
    totals = {mode: {'must': 0, 'found': 0, 'exact': 0, 'near': 0, 'child': 0, 'wrong': 0, 'cut': 0, 'junk': 0,
                     'slivers': 0, 'ms': 0.0} for mode in modes}
    print(f"{'capture':24}{'mode':9}{'boxes':>6}{'must':>7}{'exact':>6}{'near':>5}{'child':>6}{'wrong':>6}"
          f"{'cut':>4}{'junk':>5}{'sliver':>7}{'ms':>6}")
    for stream in sorted(directory.glob('*.stream')):
        description = json.loads(stream.with_suffix('.json').read_text())
        truth = TRUTH.get(description['name'])
        surface, header = corpus.image(stream)
        scale = description['scale']
        accessible = corpus.accessible(description, header)
        size = [surface.get_width() / scale, surface.get_height() / scale]
        for mode in modes:
            found, elapsed = detect(stream, mode)
            if overlays:
                overlay(surface, scale, found, stream.with_suffix(f'.{mode}.png'))
            if not truth:
                slivers = sum(1 for box in found if min(box[2], box[3]) < SLIVER)
                print(f"{stream.stem:24}{mode:9}{len(found):>6}{'-':>7}{'':>32}{slivers:>7}{elapsed:>6.0f}"
                      f"{'  not nested: ' + str(straddles(found)) if straddles(found) else ''}")
                continue
            result = score(found, truth, accessible, size)
            hover = result['hover']
            print(f"{stream.stem:24}{mode:9}{result['boxes']:>6}{result['must'] - len(result['missed']):>4}/{result['must']:<2}"
                  f"{hover['exact']:>6}{hover['near']:>5}{hover['child']:>6}{hover['wrong']:>6}{result['cut']:>4}"
                  f"{result['junk']:>5}{result['slivers']:>7}{elapsed:>6.0f}"
                  f"{'  not nested: ' + str(straddles(found)) if straddles(found) else ''}"
                  f"  {'missed: ' + ', '.join(result['missed']) if result['missed'] else ''}"
                  f"{'  wrong: ' + ', '.join(result['wrong']) if result['wrong'] else ''}")
            total = totals[mode]
            total['must'] += result['must']
            total['found'] += result['must'] - len(result['missed'])
            for key in ('exact', 'near', 'child', 'wrong'):
                total[key] += hover[key]
            for key in ('cut', 'junk', 'slivers'):
                total[key] += result[key]
            total['ms'] += elapsed
    for mode, total in totals.items():
        print(f"{'TOTAL':24}{mode:9}{'':>6}{total['found']:>4}/{total['must']:<2}{total['exact']:>6}{total['near']:>5}"
              f"{total['child']:>6}{total['wrong']:>6}{total['cut']:>4}{total['junk']:>5}{total['slivers']:>7}{total['ms']:>6.0f}")


if __name__ == '__main__':
    main(sys.argv[1:])
