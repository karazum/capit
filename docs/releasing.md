# Releasing

A release is a `vX.Y.Z` tag. Pushing one runs
[`release.yml`](../.github/workflows/release.yml). It builds the extension zip,
plus a `.deb` for Ubuntu 24.04 and one for 26.04, with `scripts/build-deb`. It
writes `SHA256SUMS` and attests the files' build provenance. Then, after the
`release` environment's reviewer approves, it creates a draft GitHub Release and
uploads the signed source packages to the PPA. Publishing the draft, and
uploading the zip to extensions.gnome.org, stay manual.

## Cutting a release

1. Put the version in `extension/metadata.json` as `version-name`, and in a new
   top entry of `debian/changelog` as `X.Y.Z-1`, for example with
   `dch -v X.Y.Z-1`. The entry's distribution does not matter: `build-deb` sets
   each Ubuntu release's own.
2. In `CHANGELOG.md`, rename the `## [Unreleased]` section to
   `## [X.Y.Z] - YYYY-MM-DD`, start a new empty `## [Unreleased]` above it, and
   update the links at the end of the file. That section becomes the release
   notes, and the release stops without it.
3. Merge, then tag the merge and push the tag:
   `git tag -s vX.Y.Z && git push origin vX.Y.Z`.
4. Approve the `release` environment's deployment in the workflow run, check
   the draft release's files against `SHA256SUMS`, and publish it.
5. Check the PPA's page on Launchpad. A finished `dput` means only that the
   files arrived: Launchpad accepts or rejects them afterwards, by email to
   the key's owner, and then builds each one.

A packaging fix is released as a new `X.Y.Z` too, not as `X.Y.Z-2`. A later
build makes the orig tarball again, and a newer `git` or zlib can compress it
to different bytes. The PPA would then reject the upload, as it already holds
that version's orig tarball.

The workflow stops when the tag, `metadata.json` and `debian/changelog` name
different versions. Only tags of the form `vX.Y.Z` start it. Pull requests that
change the packaging, and manual runs, build and check everything without
publishing.

## What the release environment holds

Create the `release` environment, with a required reviewer and deployments
limited to `v*` tags, before pushing the first tag. A job that names an
environment that does not exist creates it without any protection, and would
then publish without waiting for approval.

| Name | Kind | What it is |
| --- | --- | --- |
| `PPA_SIGNING_KEY` | Secret | The ASCII-armoured signing subkey of the key registered with Launchpad, exported with `gpg --armor --export-secret-subkeys SUBKEYID!` |
| `PPA_SIGNING_PASSPHRASE` | Secret | That subkey's passphrase, if it has one |
| `PPA` | Variable | The PPA to upload to; `ppa:karazum-capit/stable` when unset |

Without `PPA_SIGNING_KEY`, the release is still drafted, and the PPA upload is
skipped with a warning. `scripts/upload-ppa --simulate` signs and checks the
uploads without sending them.

Launchpad builds each upload for the Ubuntu release its changelog names. Both
uploads carry the same orig tarball, which Launchpad accepts only when the bytes
are identical, so both must come from the same `build-deb` run.

Attestations need a public repository on GitHub's Free, Pro and Team plans, so
the workflow skips them while the repository is private. Check one with
`gh attestation verify FILE --repo OWNER/REPO`.
