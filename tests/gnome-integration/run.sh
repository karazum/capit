#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later

# Native integration, confined to a fresh headless GNOME session.
set -eu
harness_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -- "$harness_dir/../.." && pwd)
probe=probe.py
if [ "${1:-}" = --scales ]; then probe=scale-probe.py; fi
if [ "${1:-}" = --prefs ]; then probe=prefs-driver.py; fi
if [ "${1:-}" = --reload ]; then probe=reload-probe.py; fi
if [ "${1:-}" = --recording ]; then probe=recording-probe.py; fi
if [ "${1:-}" = --x11-scale ]; then
  # X11 at 200%, on outputs twice the size of the default ones.
  probe=x11-scale-probe.py
  export CAPIT_SESSION=x11 CAPIT_X11_SCALE=2
fi
monitors='--virtual-monitor=1280x720 --virtual-monitor=1024x768'
if [ "$probe" = x11-scale-probe.py ]; then
  monitors='--virtual-monitor=2560x1440 --virtual-monitor=2048x1536'
fi
software_gl=1
if [ "${1:-}" = --perf ]; then
  probe=perf-probe.py
  # Device-pixel size of a large three-output desk, rendered on the real GPU, where full-stage costs show.
  monitors=${CAPIT_PERF_MONITORS:-'--virtual-monitor=5120x2160 --virtual-monitor=2560x1440 --virtual-monitor=2560x1440'}
  software_gl=
  # The primary output's scale. A fractional scale is the costly case, where the overlay has stalled before.
  export CAPIT_PERF_SCALE=${CAPIT_PERF_SCALE:-1.25}
fi
# CAPIT_MONITORS overrides the outputs, for example '--virtual-monitor=2560x1440 --virtual-monitor=2048x1536'.
monitors=${CAPIT_MONITORS:-$monitors}
limit=
if [ "${1:-}" = --timing ]; then
  probe=timing-probe.py
  # One output wide enough for both application screenshots side by side, on the real GPU.
  monitors='--virtual-monitor=3440x1440'
  software_gl=
  export CAPIT_INTEGRATION_TIMEOUT=${CAPIT_INTEGRATION_TIMEOUT:-900}
  # Optional stand-in for a slower machine: the whole session runs on these CPUs at this total quota,
  # e.g. CAPIT_TIMING_CPUS=0,1 CAPIT_TIMING_QUOTA=100% for two threads' worth of time. The GPU is not limited.
  # systemd-run needs the user's own session bus, which the private session below replaces, so it is
  # reached with the original variables and the session's are set again inside the scope.
  if [ -n "${CAPIT_TIMING_CPUS:-}" ]; then
    limit="env XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}
      systemd-run --user --scope --quiet -p AllowedCPUs=$CAPIT_TIMING_CPUS -p CPUQuota=${CAPIT_TIMING_QUOTA:-100%}
      -- env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=@RUNTIME@"
  fi
fi
scratch=$(mktemp -d /tmp/capit-headless.XXXXXX)
cleanup() {
  /usr/bin/python3 "$harness_dir/cleanup-owned.py" "$scratch/runtime"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
mkdir -p "$scratch/runtime" "$scratch/config" "$scratch/cache" "$scratch/state" "$scratch/data/gnome-shell/extensions"
chmod 700 "$scratch/runtime"
if [ "$probe" = reload-probe.py ]; then
  # Installed like `make link`: a symlink to a checkout, here a private copy the probe is free to edit.
  cp -r "$repo_root/extension" "$scratch/checkout"
  glib-compile-schemas "$scratch/checkout/schemas"
  ln -s "$scratch/checkout" "$scratch/data/gnome-shell/extensions/capit@karazum.github.io"
  export CAPIT_CHECKOUT="$scratch/checkout"
else
  cp -r "$repo_root/extension" "$scratch/data/gnome-shell/extensions/capit@karazum.github.io"
  glib-compile-schemas "$scratch/data/gnome-shell/extensions/capit@karazum.github.io/schemas"
fi
export XDG_RUNTIME_DIR="$scratch/runtime" XDG_CONFIG_HOME="$scratch/config"
export XDG_CACHE_HOME="$scratch/cache" XDG_STATE_HOME="$scratch/state" XDG_DATA_HOME="$scratch/data"
export GSETTINGS_BACKEND=memory GDK_BACKEND=wayland GTK_A11Y=none NO_AT_BRIDGE=1
# CAPIT_SESSION=x11 runs Shell as an X11 compositor on a headless Xorg instead of a headless Wayland one.
export CAPIT_SESSION=${CAPIT_SESSION:-wayland}
if [ "$CAPIT_SESSION" = x11 ]; then
  export GDK_BACKEND=x11
  # A display number nothing else uses, so a host run cannot collide with the desktop's own X server.
  for number in $(seq 50 99); do
    if [ ! -e "/tmp/.X11-unix/X$number" ] && [ ! -e "/tmp/.X$number-lock" ]; then break; fi
  done
  export CAPIT_X_DISPLAY=":$number"
  # Ubuntu's /usr/bin/Xorg may hand over to a wrapper that only starts on a console.
  CAPIT_XORG=/usr/lib/xorg/Xorg
  if [ ! -x "$CAPIT_XORG" ]; then CAPIT_XORG=Xorg; fi
  export CAPIT_XORG
fi
if [ -n "$software_gl" ]; then export LIBGL_ALWAYS_SOFTWARE=1; fi
export GNOME_SHELL_SESSION_MODE=user GIO_USE_VFS=local
if [ "$probe" = perf-probe.py ]; then
  # Fractional scales are only advertised with this Mutter feature, which needs settings present at startup.
  mkdir -p "$scratch/config/glib-2.0/settings"
  printf '%s\n' '[org/gnome/mutter]' "experimental-features=['scale-monitor-framebuffer']" \
    >"$scratch/config/glib-2.0/settings/keyfile"
  export GSETTINGS_BACKEND=keyfile
fi
if [ "$probe" = recording-probe.py ]; then export CAPIT_INTEGRATION_TIMEOUT=120; fi
export CAPIT_TIMING_CPUS=${CAPIT_TIMING_CPUS:-} CAPIT_TIMING_QUOTA=${CAPIT_TIMING_QUOTA:-}
export WAYLAND_DISPLAY=capit-integration CAPIT_TEST_MODE=1
# GNOME 50 dropped the session-manager option along with its X11 session.
CAPIT_SHELL_OPTIONS=
if gnome-shell --help-all 2>/dev/null | grep -q -- --sm-disable; then CAPIT_SHELL_OPTIONS=--sm-disable; fi
export CAPIT_SHELL_OPTIONS
export CAPIT_X11_SCALE=${CAPIT_X11_SCALE:-1}
export CAPIT_INTEGRATION_DIR="$harness_dir" CAPIT_INTEGRATION_PROBE="$probe" CAPIT_INTEGRATION_MONITORS="$monitors"
unset DISPLAY SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS
# Services D-Bus starts inherit its environment, so the display is named before the session bus exists.
if [ "$CAPIT_SESSION" = x11 ]; then export DISPLAY=$CAPIT_X_DISPLAY; unset WAYLAND_DISPLAY; fi
gnome-shell --version
echo "Session: $CAPIT_SESSION"
set +e
${limit//@RUNTIME@/$scratch/runtime} timeout --kill-after=3 "${CAPIT_INTEGRATION_TIMEOUT:-90}" dbus-run-session -- bash -eu 2>"$scratch/cache/services.log" <<'SESSION'
if [ "$CAPIT_INTEGRATION_PROBE" = recording-probe.py ] || [ "$CAPIT_INTEGRATION_PROBE" = timing-probe.py ]; then
  # GNOME's screencast service streams through PipeWire, and WirePlumber links its stream to the recorder.
  pipewire >"$XDG_CACHE_HOME/pipewire.log" 2>&1 &
  wireplumber >"$XDG_CACHE_HOME/wireplumber.log" 2>&1 &
fi
if [ "$CAPIT_SESSION" = x11 ]; then
  "$CAPIT_XORG" "$CAPIT_X_DISPLAY" -config "$CAPIT_INTEGRATION_DIR/xorg-dummy.conf" -noreset -nolisten tcp \
    -logfile "$XDG_CACHE_HOME/xorg.log" >/dev/null 2>&1 &
  xorg_pid=$!
  for attempt in $(seq 1 80); do
    if [ -S "/tmp/.X11-unix/X${CAPIT_X_DISPLAY#:}" ]; then break; fi
    if ! kill -0 "$xorg_pid" 2>/dev/null; then cat "$XDG_CACHE_HOME/xorg.log" >&2; exit 1; fi
    sleep 0.1
  done
  # One dummy output per --virtual-monitor=WxH, left to right, the first primary, as Mutter places virtual monitors.
  output=0
  left=0
  for monitor in $CAPIT_INTEGRATION_MONITORS; do
    size=${monitor#--virtual-monitor=}
    size=${size%@*}
    width=${size%x*}
    height=${size#*x}
    # A plain 60 Hz modeline: the dummy driver displays nothing, so any timing it accepts will do.
    name="capit-$output-$size"
    xrandr --newmode "$name" $(((width + 160) * (height + 30) * 60 / 1000000 + 1)) \
      "$width" $((width + 48)) $((width + 80)) $((width + 160)) "$height" $((height + 3)) $((height + 8)) $((height + 30))
    xrandr --addmode "DUMMY$output" "$name"
    xrandr --output "DUMMY$output" --mode "$name" --pos "${left}x0" $([ "$output" = 0 ] && echo --primary)
    left=$((left + width))
    output=$((output + 1))
  done
  xrandr --listmonitors >&2
  gnome-shell --x11 $CAPIT_SHELL_OPTIONS >"$XDG_CACHE_HOME/shell.log" 2>&1 &
  shell_pid=$!
  trap 'kill "$shell_pid" "$xorg_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true' EXIT
  for attempt in $(seq 1 100); do
    if gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell 2>/dev/null | grep -q true; then break; fi
    if ! kill -0 "$shell_pid" 2>/dev/null; then exit 1; fi
    sleep 0.1
  done
  /usr/bin/python3 "$CAPIT_INTEGRATION_DIR/x11-layout.py"
  sleep 1
else
  gnome-shell --headless --wayland --no-x11 $CAPIT_SHELL_OPTIONS \
    --wayland-display="$WAYLAND_DISPLAY" $CAPIT_INTEGRATION_MONITORS \
    >"$XDG_CACHE_HOME/shell.log" 2>&1 &
  shell_pid=$!
  trap 'kill "$shell_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true' EXIT
  for attempt in $(seq 1 80); do
    if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then break; fi
    if ! kill -0 "$shell_pid" 2>/dev/null; then exit 1; fi
    sleep 0.1
  done
fi
if [ "$CAPIT_INTEGRATION_PROBE" = prefs-driver.py ]; then
  # GNOME's package bootstrap finds resources using the entrypoint basename.
  cp "$CAPIT_INTEGRATION_DIR/prefs-probe.js" "$XDG_CACHE_HOME/org.gnome.Shell.Extensions"
  gjs -m "$XDG_CACHE_HOME/org.gnome.Shell.Extensions" >"$XDG_CACHE_HOME/prefs.log" 2>&1 &
fi
/usr/bin/python3 "$CAPIT_INTEGRATION_DIR/$CAPIT_INTEGRATION_PROBE"
if [ "$CAPIT_INTEGRATION_PROBE" = prefs-driver.py ]; then cat "$XDG_CACHE_HOME/prefs.log"; fi
SESSION
run_status=$?
set -e
if [ "$probe" = prefs-driver.py ] && [ -f "$scratch/cache/prefs.log" ] &&
    rg -q 'CRITICAL|JS ERROR|Failed to set text' "$scratch/cache/prefs.log"; then
  run_status=1
fi
if [ "$run_status" -ne 0 ]; then
  cat "$scratch/cache/shell.log" "$scratch/cache/services.log"
  if [ -f "$scratch/cache/prefs.log" ]; then cat "$scratch/cache/prefs.log"; fi
fi
if rg -q 'JS ERROR|\[CapIt\]|CRITICAL' "$scratch/cache/shell.log"; then
  echo 'Native Shell log diagnostics:'
  rg -n -C 2 'JS ERROR|\[CapIt\]|CRITICAL' "$scratch/cache/shell.log"
fi
exit "$run_status"
