# SPDX-License-Identifier: GPL-3.0-or-later
"""Stop only processes carrying this run's unique scratch runtime directory."""
import os
from pathlib import Path
import signal
import sys
import time

runtime = sys.argv[1]
if not runtime.startswith("/tmp/capit-headless.") or not runtime.endswith("/runtime"):
    raise SystemExit("Refusing unexpected runtime path")
protected = {os.getpid(), os.getppid()}
needle = ("XDG_RUNTIME_DIR=" + runtime).encode()
owned = []
for entry in Path("/proc").iterdir():
    if not entry.name.isdigit() or int(entry.name) in protected:
        continue
    try:
        if entry.stat().st_uid == os.getuid() and needle in (entry / "environ").read_bytes().split(b"\0"):
            owned.append(int(entry.name))
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
for sig in (signal.SIGTERM, signal.SIGKILL):
    for pid in owned:
        try:
            # Recheck identity immediately before killing, guarding PID reuse.
            if needle in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
                os.kill(pid, sig)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            pass
    if sig == signal.SIGTERM:
        time.sleep(0.2)
print(f"Cleaned {len(owned)} remaining scratch-runtime processes")
