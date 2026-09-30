#!/bin/bash
# desktop/sign.sh <rowrow.app> <identity> — sign rowrow for Mac inside out (docs/desktop.md,
# "Signing"). <identity> is a "Developer ID Application: …" certificate in the keychain, or "-"
# to sign ad hoc (a build that runs on this Mac only, and can't update itself).
#
# Every piece of code in the bundle gets the hardened runtime and a secure timestamp, deepest
# first: the server bundle's Node and native addons, Electron's libraries, helpers and
# frameworks, then the app. Executables and apps get desktop/entitlements.plist. It runs
# only Apple's tools, so CI signs in a job that installs nothing (D-031).
set -euo pipefail

app=${1:?usage: desktop/sign.sh <rowrow.app> <identity>}
identity=${2:?usage: desktop/sign.sh <rowrow.app> <identity>}
entitlements=$(cd "$(dirname "$0")" && pwd)/entitlements.plist
timestamp=--timestamp
[ "$identity" = "-" ] && timestamp=--timestamp=none

sign() {
  codesign --force --sign "$identity" --options runtime "$timestamp" "$@"
}

count=0
# Deepest first (-depth): what a bundle contains is signed before the bundle.
while IFS= read -r -d '' path; do
  case "$path" in
    *.app | *.framework)
      if [ "${path%.app}" != "$path" ]; then sign --entitlements "$entitlements" "$path"; else sign "$path"; fi
      ;;
    *)
      kind=$(file -b "$path")
      case "$kind" in
        *Mach-O*executable*) sign --entitlements "$entitlements" "$path" ;;
        *Mach-O*) sign "$path" ;;
        *) continue ;;
      esac
      ;;
  esac
  count=$((count + 1))
done < <(find "$app/Contents" -depth \( -name '*.app' -o -name '*.framework' -o \( -type f -perm -u+x \) -o -name '*.dylib' -o -name '*.node' -o -name '*.so' \) -print0)

sign --entitlements "$entitlements" "$app"
codesign --verify --deep --strict "$app"
echo "sign.sh: signed $count pieces of code and $(basename "$app") with ${identity}"
