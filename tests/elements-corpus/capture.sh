#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

# Records the element-detection corpus: real applications in a fresh headless GNOME session,
# each window's pixels exactly as Shell streams them to the detector, and its AT-SPI tree.
# Usage: capture.sh OUTPUT_DIR [SCALE [CASE...]]     (SCALE 1 or a fractional scale such as 1.25)
# CORPUS_EXTRA adds applications: a JSON list of [name, colour scheme, command, runs under Xwayland, clicks].
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -- "$here/../.." && pwd)
out=$(mkdir -p "$1" && cd -- "$1" && pwd)
export CORPUS_SCALE=${2:-1} CORPUS_OUT="$out" CORPUS_DIR="$here" CORPUS_CASES="${*:3}"
scratch=$(mktemp -d /tmp/capit-headless.XXXXXX)
cleanup() {
  /usr/bin/python3 "$here/../gnome-integration/cleanup-owned.py" "$scratch/runtime"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
installed="$scratch/data/gnome-shell/extensions/capit@karazum.github.io"
mkdir -p "$scratch/runtime" "$scratch/config/glib-2.0/settings" "$scratch/cache" "$scratch/state" \
  "$scratch/data/gnome-shell/extensions" "$scratch/home"
chmod 700 "$scratch/runtime"
cp -r "$repo_root/extension" "$installed"
glib-compile-schemas "$installed/schemas"
# The detector is replaced by a recorder, so the corpus holds the bytes a detector would have been sent.
cat >"$installed/detector.js" <<'RECORDER'
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
const sink = Gio.File.new_for_path(GLib.build_filenamev([GLib.getenv('XDG_RUNTIME_DIR'), 'stream.bin']))
    .replace(null, false, Gio.FileCreateFlags.NONE, null);
sink.splice(new GioUnix.InputStream({fd: 0, close_fd: false}), Gio.OutputStreamSpliceFlags.CLOSE_TARGET, null);
RECORDER
# A home directory of made-up files keeps the user's own names and files out of the captures.
home="$scratch/home"
mkdir -p "$home"/{Documents/Reports,Downloads,Music,Pictures,Videos,Projects/capit}
for name in budget-2026.ods meeting-notes.md roadmap.txt invoice-0042.pdf; do echo "sample $name" >"$home/Documents/$name"; done
for name in a.txt b.txt c.md; do echo sample >"$home/Projects/capit/$name"; done
cp "$repo_root/extension/visual.js" "$home/Projects/capit/detector.js"
cp "$repo_root/README.md" "$home/Projects/capit/README.md"
printf '%s\n' '[org/gnome/mutter]' "experimental-features=['scale-monitor-framebuffer']" \
  >"$scratch/config/glib-2.0/settings/keyfile"
export HOME="$home" XDG_RUNTIME_DIR="$scratch/runtime" XDG_CONFIG_HOME="$scratch/config"
export XDG_CACHE_HOME="$scratch/cache" XDG_STATE_HOME="$scratch/state" XDG_DATA_HOME="$scratch/data"
export GSETTINGS_BACKEND=keyfile GDK_BACKEND=wayland GNOME_SHELL_SESSION_MODE=user GIO_USE_VFS=local
export WAYLAND_DISPLAY=capit-corpus CAPIT_TEST_MODE=1
unset DISPLAY SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS GTK_A11Y NO_AT_BRIDGE XAUTHORITY
# GNOME 50 dropped the session-manager option along with its X11 session.
CORPUS_SHELL_OPTIONS=
if gnome-shell --help-all 2>/dev/null | grep -q -- --sm-disable; then CORPUS_SHELL_OPTIONS=--sm-disable; fi
export CORPUS_SHELL_OPTIONS
set +e
timeout --kill-after=3 900 dbus-run-session -- bash -eu 2>"$out/services-$CORPUS_SCALE.log" <<'SESSION'
ls /tmp/.X11-unix 2>/dev/null | sort >"$XDG_CACHE_HOME/x-before"
/usr/bin/python3 "$CORPUS_DIR/fake-systemd.py" &
systemd_pid=$!
gnome-shell --headless --wayland $CORPUS_SHELL_OPTIONS --wayland-display="$WAYLAND_DISPLAY" \
  --virtual-monitor=1920x1200 >"$CORPUS_OUT/shell-$CORPUS_SCALE.log" 2>&1 &
shell_pid=$!
trap 'kill "$shell_pid" "$systemd_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 80); do
  if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then break; fi
  if ! kill -0 "$shell_pid" 2>/dev/null; then exit 1; fi
  sleep 0.1
done
sleep 1
# Mutter listens on a new X display for clients that need Xwayland; they are how a window that the compositor
# upscales, with soft borders, gets into the corpus.
x_display=$(ls /tmp/.X11-unix | sort | comm -13 "$XDG_CACHE_HOME/x-before" - | head -1)
export CORPUS_X_DISPLAY=${x_display:+:${x_display#X}}
export CORPUS_XAUTHORITY=$(ls "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
/usr/bin/python3 "$CORPUS_DIR/capture.py" $CORPUS_CASES
SESSION
status=$?
set -e
exit "$status"
