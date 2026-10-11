#!/usr/bin/env bash
# Compile AppIcon.icon (light + dark artwork) into icons/Assets.car, which
# macOS 26 reads through CFBundleIconName to swap the icon with the system
# appearance. Needs full Xcode (actool); release.yml runs it on the macOS
# runners and bundles the result with tauri.macos-icon.conf.json.
set -euo pipefail
cd "$(dirname "$0")"
partial="$(mktemp -d)/partial.plist"
xcrun actool AppIcon.icon \
  --compile . \
  --app-icon AppIcon \
  --platform macosx \
  --target-device mac \
  --minimum-deployment-target 11.0 \
  --enable-on-demand-resources NO \
  --output-partial-info-plist "$partial" \
  --output-format human-readable-text \
  --notices --warnings --errors
test -f Assets.car
echo "Wrote $(pwd)/Assets.car"
