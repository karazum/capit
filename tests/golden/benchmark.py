#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Times the panel detector cold: a fresh process per run, from start to its answer, on window PNGs sent the way
Shell sends them. Run from the repository root:

    python3 tests/golden/benchmark.py [--mode regions] [--runs 7] [--cpus 0,1 --quota 50%]

--cpus and --quota run the detector under that CPU limit with systemd-run, to stand in for a slower machine.
Prints the median and the range on each image, in milliseconds.
"""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
IMAGES = [('tests/fixtures/elements/ide-xwayland-1.25.png', 1.25), ('tests/fixtures/elements/settings-dark-1.25.png', 1.25),
          ('tests/fixtures/synthetic/ide-1.png', 1.0)]
DETECTOR = ['gjs', '-m', str(ROOT / 'extension/detector.js'), '--mode']


def frame(path, scale):
    data = (ROOT / path).read_bytes()
    header = {'index': 0, 'origin': [0, 0], 'scale': scale, 'part': 0, 'parts': 1, 'length': len(data)}
    return json.dumps(header).encode() + b'\n' + data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['visual', 'regions'], default='visual')
    parser.add_argument('--runs', type=int, default=7)
    parser.add_argument('--cpus')
    parser.add_argument('--quota', default='100%')
    arguments = parser.parse_args()
    prefix = ['systemd-run', '--user', '--scope', '--quiet', f'-pAllowedCPUs={arguments.cpus}',
              f'-pCPUQuota={arguments.quota}', '--'] if arguments.cpus else []
    results = {}
    for path, scale in IMAGES:
        payload = frame(path, scale)
        times = []
        answers = set()
        for _ in range(arguments.runs):
            started = time.perf_counter()
            done = subprocess.run(prefix + DETECTOR + [arguments.mode], input=payload, capture_output=True, check=True)
            times.append((time.perf_counter() - started) * 1000)
            answers.add(json.dumps(json.loads(done.stdout)['elements']))
        results[path] = {'median_ms': round(statistics.median(times)), 'min_ms': round(min(times)),
                         'max_ms': round(max(times)), 'boxes': len(json.loads(answers.pop()))}
    print(json.dumps({'mode': arguments.mode, 'cpus': arguments.cpus, 'quota': arguments.quota if arguments.cpus else None,
                      'runs': arguments.runs, 'results': results}, indent=1))


if __name__ == '__main__':
    main()
