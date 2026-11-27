# Contributing to CapIt

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report
security problems privately, as [SECURITY.md](SECURITY.md) describes, not in an
issue.

Start with the [README](README.md), the [roadmap](docs/roadmap.md) and the
[architecture](docs/architecture.md). Run `npm ci` once for ESLint, then
`make check lint test`. Use `make install` to install the extension for your
user, or `make link` to point the installed extension at your checkout while
developing. With the link in place since your last login, `make reload` makes
edits live without logging out; `extension.js`, `prefs.js` and schema changes
still need a new login.

For implementation changes, link the issue and describe the user-visible
behavior, scope, validation, and any compatibility limitations. Add a line for
user-visible changes to the `Unreleased` section of the
[changelog](CHANGELOG.md). Keep unverified
compatibility claims explicit. Do not mark an untested desktop or monitor
configuration as supported.

Bug and test reports should include the output of `capit doctor`, the
distribution, and the monitor layout and scaling. Follow the
[manual test template](docs/compatibility.md#manual-test-record-template).
Do not attach private screenshots, credentials, or unredacted diagnostic secrets.

Include meaningful checks for workflow ordering,
coordinate/rendering correctness, and failure behavior. UI and portal changes
also need real Wayland-session validation; unit tests cannot verify desktop
permission dialogs or clipboard ownership.

## Tests and packages

Node 22 runs the pure JavaScript model tests. GJS tests in `tests/gjs/` exercise
actual PNG pixels, redaction, coordinate mapping, save failures, and concurrent
filename collisions, and compare the export with reference PNGs. They also check
element detection against reference windows and, when FFmpeg is installed, encode
real GIFs and MP4s. The GNOME integration harness exercises the installed Shell
extension in a private headless session; it does not capture the user's desktop.
The harness, the element corpus tools and `scripts/install.py` are Python 3 with
GObject introspection and Cairo; nothing the extension runs is.

`scripts/build-deb` builds the Debian package for Ubuntu 24.04 and 26.04 in
Docker, one `.deb` per release, each requiring that release's GNOME Shell, and
checks it with lintian. It packages the committed tree, with `debian/` taken as
it is in the working tree. Install one with
`sudo apt install ./dist/deb/24.04/gnome-shell-extension-capit_*_all.deb`.
[Releasing](docs/releasing.md) describes the tags and the release workflow.

## AI-assisted contributions

CapIt is developed with an AI coding assistant, Claude Code, directed and
reviewed by the maintainer. [`CLAUDE.md`](CLAUDE.md) holds the instructions it
works from, and commits it helped write name it in a `Co-Authored-By:` line.
Contributions made with AI tools are welcome on the same terms:

- **You are the author.** Read and understand every line you submit, and be
  ready to explain why it is there. Your `Signed-off-by:` line certifies the
  change as yours, whichever tool produced it.
- **Say what you used.** Name the tool and what it did in the pull request, or
  add a `Co-Authored-By:` line.
- **Check it against the real thing.** Make sure every API you call exists in
  the GNOME Shell and GJS versions CapIt supports, and try the change in a real
  session. extensions.gnome.org's reviewers read every release, and they
  reject made-up APIs, unneeded code, an inconsistent style, and comments
  written as prompts for an assistant.
- **Keep it small.** Change only what the issue needs, in the style of the code
  around it.
- **Write issues and replies yourself.** A bug report has to describe something
  you saw on your own desktop.

A pull request that looks generated and unreviewed, being large, unexplained,
or broken in ways its author can't explain, is closed without a detailed
review.

## License and sign-off

CapIt is licensed under `GPL-3.0-or-later`, and contributions are accepted under
the same license. New source files start with the line
`SPDX-License-Identifier: GPL-3.0-or-later`, in that file type's comment syntax.

Each commit must carry a `Signed-off-by:` line, added by `git commit -s`. It
certifies the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or otherwise have the right to submit it under the
project's license.
