"""Regenerate every app icon from the logo sources in this folder.

    python3 apps/desktop/src-tauri/icons/source/make-icons.py

Sources: light.png / dark.png (full-bleed artwork for the light and dark
appearances) and mark-raw.png (the transparent mark). Writes:

- icons/icon.icns, icon.png: the light artwork on Apple's macOS icon grid
  (824px continuous-corner tile inset 100px in a 1024 canvas, soft shadow).
  The fallback for macOS < 26 and builds without Assets.car.
- icons/icon.ico, *.png, Square*Logo.png, StoreLogo.png: the transparent mark
  (Windows and Linux; Win32 icons can't follow the system theme).
- icons/AppIcon.icon/Assets/{light,dark}.png: full-bleed 1024 squares for the
  macOS 26 light/dark icon, compiled to Assets.car by build-mac-icon.sh.
- public/sush-mark-{light,dark}.png (tiles), public/sush-mark.png and
  public/favicon.png (transparent mark): the in-app marks.

Needs Pillow and numpy, and runs `bun tauri icon` for the platform formats.
"""

import shutil
import subprocess
import tempfile
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SOURCE = Path(__file__).resolve().parent
ICONS = SOURCE.parent
DESKTOP = ICONS.parent.parent
PUBLIC = DESKTOP / "public"

CANVAS = 1024
TILE = 824  # Apple's macOS app icon grid: 824x824 shape, 100px margin.
SUPERSAMPLE = 4


def squircle_mask(size: int, n: float = 5.0) -> Image.Image:
    """A superellipse |x|^n + |y|^n <= 1, the continuous-corner icon shape."""
    s = size * SUPERSAMPLE
    c = np.linspace(-1, 1, s)
    x, y = np.meshgrid(c, c)
    inside = (np.abs(x) ** n + np.abs(y) ** n) <= 1
    mask = Image.fromarray((inside * 255).astype(np.uint8))
    return mask.resize((size, size), Image.LANCZOS)


def mac_tile(src: Image.Image, size: int = CANVAS, shadow: bool = True) -> Image.Image:
    """The artwork clipped to the squircle on Apple's grid, with a drop shadow."""
    tile = round(size * TILE / CANVAS)
    inset = (size - tile) // 2
    art = src.convert("RGBA").resize((tile, tile), Image.LANCZOS)
    mask = squircle_mask(tile)
    art.putalpha(mask)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if shadow:
        scale = size / CANVAS
        blur, dy = 14 * scale, round(10 * scale)
        shade = Image.new("L", (size, size), 0)
        shade.paste(mask.point(lambda a: int(a * 0.3)), (inset, inset + dy))
        shade = shade.filter(ImageFilter.GaussianBlur(blur))
        black = Image.new("RGBA", (size, size), (0, 0, 0, 255))
        black.putalpha(shade)
        out = Image.alpha_composite(out, black)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(art, (inset, inset))
    return Image.alpha_composite(out, layer)


def clean_mark(src: Image.Image, margin: float = 0.06) -> Image.Image:
    """Drop stray speckles around the mark and pad it to a centred square."""
    img = src.convert("RGBA")
    alpha = np.array(img.getchannel("A"))

    # Label solid regions on a quarter-size grid; keep only the big ones.
    step = 4
    solid = alpha[::step, ::step] > 128
    h, w = solid.shape
    labels = np.zeros((h, w), np.int32)
    sizes = [0]
    for sy, sx in zip(*np.nonzero(solid)):
        if labels[sy, sx]:
            continue
        label = len(sizes)
        labels[sy, sx] = label
        count, queue = 0, deque([(sy, sx)])
        while queue:
            y, x = queue.popleft()
            count += 1
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and solid[ny, nx] and not labels[ny, nx]:
                    labels[ny, nx] = label
                    queue.append((ny, nx))
        sizes.append(count)
    keep_labels = [i for i, n in enumerate(sizes) if i and n >= 0.01 * max(sizes)]
    keep = Image.fromarray((np.isin(labels, keep_labels) * 255).astype(np.uint8))
    # Back to full size, grown a little so the anti-aliased edges survive.
    keep = keep.resize(img.size, Image.NEAREST).filter(ImageFilter.MaxFilter(2 * step + 1))
    alpha = np.minimum(alpha, np.array(keep))
    alpha[alpha < 8] = 0
    img.putalpha(Image.fromarray(alpha))

    img = img.crop(img.getbbox())
    side = round(max(img.size) / (1 - 2 * margin))
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return out.resize((CANVAS, CANVAS), Image.LANCZOS)


def tauri_icon(src: Path, names: list[str]) -> None:
    """Run `tauri icon` into a temp dir and copy back only the named files."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["bun", "tauri", "icon", str(src), "-o", tmp], cwd=DESKTOP, check=True)
        for name in names:
            shutil.copy(Path(tmp) / name, ICONS / name)


def main() -> None:
    light = Image.open(SOURCE / "light.png")
    dark = Image.open(SOURCE / "dark.png")

    with tempfile.TemporaryDirectory() as tmp:
        mark = Path(tmp) / "mark.png"
        clean_mark(Image.open(SOURCE / "mark-raw.png")).save(mark)
        shutil.copy(mark, SOURCE / "mark.png")
        tauri_icon(mark, [
            "icon.ico", "32x32.png", "64x64.png", "128x128.png", "128x128@2x.png",
            "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png",
            "Square89x89Logo.png", "Square107x107Logo.png", "Square142x142Logo.png",
            "Square150x150Logo.png", "Square284x284Logo.png", "Square310x310Logo.png",
            "StoreLogo.png",
        ])

        tile = Path(tmp) / "mac-light.png"
        mac_tile(light).save(tile)
        tauri_icon(tile, ["icon.icns", "icon.png"])

    # Swapped in at runtime by src/dock_icon.rs where Assets.car can't be used.
    mac_tile(light, 512).save(ICONS / "dock-light.png")
    mac_tile(dark, 512).save(ICONS / "dock-dark.png")

    assets = ICONS / "AppIcon.icon" / "Assets"
    assets.mkdir(parents=True, exist_ok=True)
    light.convert("RGB").resize((CANVAS, CANVAS), Image.LANCZOS).save(assets / "light.png")
    dark.convert("RGB").resize((CANVAS, CANVAS), Image.LANCZOS).save(assets / "dark.png")

    # In-app marks: the tile without the grid margin or shadow.
    for name, src in (("light", light), ("dark", dark)):
        art = src.convert("RGBA").resize((256, 256), Image.LANCZOS)
        art.putalpha(squircle_mask(256))
        art.save(PUBLIC / f"sush-mark-{name}.png")
    mark = Image.open(SOURCE / "mark.png")
    mark.resize((256, 256), Image.LANCZOS).save(PUBLIC / "sush-mark.png")
    mark.resize((64, 64), Image.LANCZOS).save(PUBLIC / "favicon.png")


if __name__ == "__main__":
    main()
