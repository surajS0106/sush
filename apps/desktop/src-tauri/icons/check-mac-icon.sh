#!/usr/bin/env sh
# Assets.car (the macOS 26 light/dark icon) can only be compiled by Xcode's actool, which runs on
# GitHub (mac-icon.yml), so after an icon change the committed Assets.car lags behind AppIcon.icon until
# that workflow has run and been pulled. A DMG built in between ships the old icon in Finder, Launchpad
# and the Dock (it once shipped a light-only icon that ignored dark mode). build-mac-icon.sh records which
# AppIcon.icon it compiled in Assets.car.stamp; every bundle that includes Assets.car
# (tauri.macos-icon.conf.json's beforeBundleCommand) runs this script and stops on a mismatch.
#
#   check-mac-icon.sh          fail unless Assets.car matches AppIcon.icon
#   check-mac-icon.sh --stamp  record the current AppIcon.icon (build-mac-icon.sh only)
set -eu
cd "$(dirname "$0")"

hash() {
  (cd AppIcon.icon && find . -type f ! -name .DS_Store | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1
}

if [ "${1:-}" = "--stamp" ]; then
  hash > Assets.car.stamp
  exit 0
fi

if [ -f Assets.car ] && [ -f Assets.car.stamp ] && [ "$(cat Assets.car.stamp)" = "$(hash)" ]; then
  exit 0
fi

cat >&2 <<'EOF'
error: icons/Assets.car is missing or was compiled from a different icons/AppIcon.icon,
so this build would ship the old macOS app icon.

Push the icon change; the "Mac icon" workflow recompiles Assets.car on GitHub and commits it.
Then pull and build again:

  git push                       # on main this starts it; elsewhere: gh workflow run mac-icon.yml --ref <branch>
  gh run watch $(gh run list --workflow mac-icon.yml -L1 --json databaseId -q '.[0].databaseId')
  git pull

Don't install Xcode for this, and don't edit Assets.car.stamp by hand.
EOF
exit 1
