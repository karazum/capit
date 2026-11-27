#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

# Runs run.sh inside an Ubuntu container, so another GNOME Shell version is tested without installing it:
#   bash tests/gnome-integration/container.sh 26.04 [run.sh arguments]
# The checkout is mounted read-only; run.sh copies the extension into the session's own temporary folder.
set -eu
release=${1:?usage: container.sh RELEASE [run.sh arguments]}
shift
harness_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -- "$harness_dir/../.." && pwd)
image=capit-harness:$release
docker build --quiet --build-arg RELEASE="$release" -t "$image" -f "$harness_dir/container/Containerfile" \
  "$harness_dir/container" >/dev/null
# GNOME Shell 50 fails to start without a system bus; an empty one stands in, as a container runs no systemd.
docker run --rm --init --shm-size=1g -e CAPIT_SESSION -e CAPIT_MONITORS -e CAPIT_X11_SCALE -v "$repo_root:/src:ro" "$image" bash -c '
  export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/system-bus
  dbus-daemon --session --address="$DBUS_SYSTEM_BUS_ADDRESS" --fork --nopidfile
  exec bash tests/gnome-integration/run.sh "$@"' run.sh "$@"
