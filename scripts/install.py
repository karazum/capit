#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Install the local CapIt extension into this user's extensions directory."""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import tempfile


def remove(path):
    # Unlink symlinks rather than following them, so replacing a dev link never touches the checkout.
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def replace(destination, staging, uuid):
    """Move staging (a copied directory or a symlink) into place, restoring the previous entry on failure."""
    if destination.is_dir() and not destination.is_symlink():
        installed = json.loads((destination / 'metadata.json').read_text())
        if installed.get('uuid') != uuid:
            raise RuntimeError('Refusing to replace a different extension')
    if not (destination.exists() or destination.is_symlink()):
        staging.rename(destination)
        return
    backup = destination.with_name('.capit-previous')
    remove(backup)
    destination.rename(backup)
    try:
        staging.rename(destination)
    except Exception:
        backup.rename(destination)
        raise
    remove(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, help='Override the extensions directory (for isolated testing)')
    parser.add_argument('--link', action='store_true', help='Symlink the installed extension to this checkout instead of copying it')
    options = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'extension'
    metadata = json.loads((source / 'metadata.json').read_text())
    base = options.destination or Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'gnome-shell/extensions'
    base.mkdir(parents=True, exist_ok=True)
    destination = base / metadata['uuid']
    if options.link:
        subprocess.run(['glib-compile-schemas', '--strict', str(source / 'schemas')], check=True)
        staging = base / '.capit-link'
        remove(staging)
        staging.symlink_to(source, target_is_directory=True)
    else:
        staging = Path(tempfile.mkdtemp(prefix='.capit-install-', dir=base))
    try:
        if not options.link:
            shutil.copytree(source, staging, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            subprocess.run(['glib-compile-schemas', '--strict', str(staging / 'schemas')], check=True)
        replace(destination, staging, metadata['uuid'])
    finally:
        remove(staging)
    if options.link:
        print(f'Linked {destination} -> {source}')
        print('renderer.js, detector.js, visual.js, regions.js and accessibility.js changes apply on the next capture,')
        print('encoder.js changes on the next recording, and worker.js changes on both.')
        print('Other changes apply after `make reload`, which closes an open capture.')
        print('extension.js, prefs.js and schema changes need a logout/login, or test them in a nested shell:')
        print('  dbus-run-session -- gnome-shell --nested --wayland')
    else:
        print(f'Installed {destination}')
        print('Enable with: gnome-extensions enable ' + metadata['uuid'])
        print('GNOME Wayland may need a logout/login to discover a newly installed extension.')


if __name__ == '__main__':
    main()
