#!/usr/bin/env bash
# Compile AppIcon.icon (light + dark artwork) into icons/Assets.car, which
# macOS 26 reads through CFBundleIconName to swap the icon with the system
# appearance. Needs full Xcode (actool), so it runs on GitHub's macOS runners:
# mac-icon.yml commits the result whenever AppIcon.icon changes, and release.yml
# rebuilds it. Local builds bundle the committed file via tauri.macos-icon.conf.json, and
# Assets.car.stamp records which AppIcon.icon it came from (check-mac-icon.sh).
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
# actool silently drops an appearance it can't use (it did when icon.json set both image-name and
# image-name-specializations), leaving a catalog that shows the light icon in dark mode. Fail instead.
for look in light dark; do
  if ! assetutil --info Assets.car | grep -q "\"AppIcon_Assets\\\\/$look\""; then
    echo "error: Assets.car has no $look artwork; check image-name-specializations in AppIcon.icon/icon.json" >&2
    exit 1
  fi
done
./check-mac-icon.sh --stamp
echo "Wrote $(pwd)/Assets.car"
