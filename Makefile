# SPDX-License-Identifier: GPL-3.0-or-later
.PHONY: install link reload test check lint package install-system
UUID = capit@karazum.github.io
# The modules gnome-extensions pack does not pick up by itself, which is all but extension.js and prefs.js.
# testing.js stays out: only the test harness loads it.
MODULES = capit.js overlay.js detection.js widgets.js recordingbar.js model.js recording.js cursor.js timing.js \
	paint.js renderer.js visual.js detector.js regions.js encoder.js worker.js accessibility.js doctor.js

install:
	/usr/bin/python3 scripts/install.py

link:
	/usr/bin/python3 scripts/install.py --link

# Linked checkouts load fresh code on each enable, so this makes edits live without logging out.
reload: link
	gnome-extensions disable $(UUID)
	gnome-extensions enable $(UUID)

test:
	node --test tests/model.test.js tests/visual.test.js tests/regions.test.js
	gjs -m tests/gjs/run.js

# ESLint with GNOME Shell's rules, installed by `npm ci`.
lint:
	npx --no-install eslint extension tests

check:
	node --check extension/extension.js
	node --check extension/capit.js
	node --check extension/overlay.js
	node --check extension/detection.js
	node --check extension/widgets.js
	node --check extension/model.js
	node --check extension/recordingbar.js
	node --check extension/prefs.js
	node --check extension/doctor.js
	node --check extension/recording.js
	node --check extension/cursor.js
	node --check extension/timing.js
	node --check extension/paint.js
	node --check extension/renderer.js
	node --check extension/visual.js
	node --check extension/detector.js
	node --check extension/regions.js
	node --check extension/accessibility.js
	node --check extension/encoder.js
	node --check extension/worker.js
	node --check extension/testing.js
	glib-compile-schemas --strict --dry-run extension/schemas
	/usr/bin/python3 -m py_compile scripts/install.py

package:
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist $(addprefix --extra-source=,$(MODULES)) --extra-source=icons --extra-source=../LICENSE extension

# The system-wide copy a distribution package ships: the files of `make package`, the schema where GLib's packaging
# trigger compiles it, and the CLI. The licence goes in the package's own copyright file instead.
install-system:
	install -d $(DESTDIR)/usr/share/gnome-shell/extensions/$(UUID)
	install -m 644 -t $(DESTDIR)/usr/share/gnome-shell/extensions/$(UUID) \
		$(addprefix extension/,extension.js prefs.js metadata.json stylesheet.css $(MODULES))
	install -D -m 644 -t $(DESTDIR)/usr/share/gnome-shell/extensions/$(UUID)/icons extension/icons/capit-symbolic.svg
	install -D -m 644 -t $(DESTDIR)/usr/share/glib-2.0/schemas extension/schemas/org.gnome.shell.extensions.capit.gschema.xml
	install -D -m 755 scripts/capit $(DESTDIR)/usr/bin/capit
