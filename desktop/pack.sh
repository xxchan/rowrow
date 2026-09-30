#!/bin/bash
# desktop/pack.sh <rowrow.app> <version> <out dir> — what a release carries for the Mac
# (docs/desktop.md, "Releases"): a zip (what the app downloads to update itself; ditto keeps
# the frameworks' symlinks and the signature intact) and a disk image to install from.
set -euo pipefail

app=${1:?usage: desktop/pack.sh <rowrow.app> <version> <out dir>}
version=${2:?}
out=${3:?}
mkdir -p "$out"
zip="$out/rowrow-$version-mac-arm64.zip"
dmg="$out/rowrow-$version-mac-arm64.dmg"
rm -f "$zip" "$dmg"

ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/rowrow.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname "rowrow $version" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
echo "pack.sh: $zip and $dmg"
