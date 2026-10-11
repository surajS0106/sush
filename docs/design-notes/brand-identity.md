# Brand identity (app icon and palette): Design Notes

Last updated: 2026-10-11

## What changed

### 2026-10-11
- New logo: a teal chevron with a coral pill. Its sources live in `apps/desktop/src-tauri/icons/source/`: `light.png` and `dark.png` are full-bleed artwork for each appearance, and `mark-raw.png` is the transparent mark.
- `icons/source/make-icons.py` regenerates every icon from those sources:
  - It clips the artwork to a superellipse (n = 5), an 824px tile inset 100px on a 1024 canvas (Apple's macOS grid), and adds a soft drop shadow. That tile becomes `icon.icns` and `icon.png`.
  - It cleans the transparent mark: it labels connected alpha regions, keeps the large ones, and pads the result to a square. The cleaned mark becomes `icon.ico`, the Linux PNGs and the `Square*Logo` files.
  - Both steps run `bun tauri icon` to produce the platform formats.
- `icons/AppIcon.icon/` is an Icon Composer bundle: one image layer whose `dark` appearance is specialised to `dark.png`.
- `icons/build-mac-icon.sh` compiles that bundle into `Assets.car` with `xcrun actool`.
- `tauri.macos-icon.conf.json` and `Info.icon.plist` ship the compiled file and set `CFBundleIconName`.
- `.github/workflows/release.yml` runs the script on macOS runners and passes the extra config through a new `extra_config` matrix field.
- `Assets.car` is gitignored.
- Palette in `apps/desktop/src/index.css`:
  - Neutrals carry a low-chroma teal tint (hue 190 to 215).
  - Dark mode uses a deep teal-black.
  - Charts use teal tints and shades plus coral.
- Accents:
  - New default accent `sush` (logo teal).
  - `red` is retuned to the logo coral and labelled "Coral".
  - `teal` becomes a deeper shade, labelled "Deep teal".
  - Orange stays available.
- `apps/desktop/src-tauri/src/dock_icon.rs` (macOS only) sets the Dock icon from the system appearance:
  - It applies the icon at startup (`window.theme()`) and on every `WindowEvent::ThemeChanged`, through `NSApplication.setApplicationIconImage`.
  - The light and dark Dock tiles (`icons/dock-light.png` and `icons/dock-dark.png`) come from `make-icons.py` and are embedded with `include_bytes!`.
  - It does nothing on macOS 26+ when the bundle declares `CFBundleIconName`, because the system already switches the icon from `Assets.car`.
  - It adds macOS-only dependencies on `objc2`, `objc2-app-kit` and `objc2-foundation` (minimal features).
- `apps/desktop/src/lib/appearance.ts` runs a one-time migration. Stored preferences without `palette: 2` that hold `orange` move to `sush`.
- `components/login-screen.tsx` shows `sush-mark-light.png` or `sush-mark-dark.png` according to the theme. The sidebar profile button (`components/app-sidebar.tsx`) uses the transparent mark (`sush-mark.png`, regenerated from `source/mark.png`), which sits directly on the sidebar without a tile. `favicon.png` is also regenerated from the mark.

## Why

**Rounded icon shape.** The previous icon was a full-bleed square with a black background, so the Dock showed hard corners next to every other app. Baking Apple's grid (shape, inset and shadow) into the icns fixes this on every macOS version, without depending on the system to mask the icon.

**Light and dark icons.** macOS 26 is the first macOS that switches app icons with the system appearance, and it only reads them from a compiled asset catalog. Tauri 2.12 cannot produce that catalog, and `actool` needs full Xcode. The compile therefore runs in CI, where the runners have Xcode, and is wired in through an extra config so local builds keep working without Xcode. The trade-off: local builds and macOS versions before 26 show only the light icon.

**Dock icon at runtime.** `tauri dev`, local builds and macOS versions before 26 only carry the light `icon.icns`, so on a dark-mode Mac the Dock showed a white tile. Setting the Dock image at runtime covers those cases. The trade-off: it only affects the Dock while the app is running; Finder and Launchpad keep the bundle icon.

**Windows and Linux.** Win32 `.ico` files cannot follow the system theme; only MSIX packages can, and Tauri does not build those. Windows and Linux get the transparent mark, which reads on both light and dark taskbars.

**Palette.** The UI should look like the logo, not only carry its accent colour. That is why the neutrals take a faint version of the brand hue.
- The destructive red and the amber status dots are left untouched, because they carry meaning and should not read as brand colour.
- The accent migration exists because the store persists merged defaults: every existing install had `orange` saved, so changing the default alone would have reached nobody.

## What makes it stand out

- **One command rebuilds every asset.** `make-icons.py` regenerates all icons and in-app marks from three source images. The common alternative, hand-exporting each size from a design tool, drifts over time.
- **macOS 26 light and dark icons without leaving Tauri's bundler.** The compiled `Assets.car` is shipped through `bundle.macOS.files`, and `CFBundleIconFile` remains in Info.plist as the fallback for older systems.
- **Dark-mode Dock icon in every build.** The Dock icon follows the system appearance in dev builds and on older macOS, and the runtime swap stops whenever the system's own switching is available.
- **Speckles removed automatically.** The connected-component cleanup removes the stray edge pixels in the supplied transparent PNG, so they never reach the 16px `.ico` frames.
- **The new palette reaches existing users.** The versioned `palette` field migrates only users who still hold the old default, and leaves any explicit non-orange choice alone.
- **The in-app mark follows the theme.** It uses the same light and dark artwork as the OS icon, swapped by Tailwind `dark:` variants, with no JavaScript.
