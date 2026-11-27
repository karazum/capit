// SPDX-License-Identifier: GPL-3.0-or-later
// Records the boxes extension/regions.js finds in each reference image as the "regions" entries of
// tests/fixtures/golden/detection.json, which detector.test.js then compares against exactly:
//   gjs -m tests/gjs/record-regions.js
// Run it only after a change to the detector whose new boxes are intended, checked by elements.test.js and the
// element corpus, since it makes the reference test pass whatever the detector finds.
import GLib from 'gi://GLib';

import {detectRegions} from '../../extension/regions.js';
import {intensity} from '../../extension/visual.js';
import {loadImage, repoPath} from './harness.js';

const path = repoPath('tests/fixtures/golden/detection.json');
const golden = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
for (const [name, entry] of Object.entries(golden)) {
    const image = loadImage(repoPath(`tests/fixtures/${name}`));
    const values = intensity(image.pixels, image.width, image.height, image.rowstride, image.channels);
    entry.regions = detectRegions(values, image.width, image.height, entry.scale, [0, 0]);
    print(`${name}: ${entry.regions.length} boxes`);
}
// One box to a line keeps the file readable and its diffs small.
const json = JSON.stringify(golden, null, 1).replace(/\[\s+(-?[\d.e]+),\s+(-?[\d.e]+),\s+(-?[\d.e]+),\s+(-?[\d.e]+)\s+\]/g,
    '[$1, $2, $3, $4]');
GLib.file_set_contents(path, `${json}\n`);
