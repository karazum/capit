// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the GJS tests: gjs -m tests/gjs/run.js
import System from 'system';

import {run} from './harness.js';
import './renderer.test.js';
import './detector.test.js';
import './elements.test.js';
import './accessibility.test.js';
import './encoder.test.js';
import './doctor.test.js';

System.exit(await run() ? 1 : 0);
