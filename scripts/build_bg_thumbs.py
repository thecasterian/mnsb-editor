#!/usr/bin/env python3
"""Bake background/still thumbnails for the scene editor's background picker.

The source art is 4096x2048 and 5-10 MB per file, far too heavy to preview on
hover, so the picker previews these instead.

The crop mirrors scene.js:renderBackground, which cover-fits the art with
max(CANVAS_W/iw, CANVAS_H/ih) and center-crops to 2560x1440. Source art is 2:1
but the stage is 16:9, so ~10% of image height never reaches the screen. A
thumbnail cropped any other way would promise framing the stage won't deliver;
that correspondence is this script's one invariant. If renderBackground ever
changes its fit, change STAGE_ASPECT / cover_crop_box with it.
"""

import json
import sys
from pathlib import Path

from PIL import Image

STAGE_ASPECT = 2560 / 1440


def cover_crop_box(iw, ih, aspect=STAGE_ASPECT):
    """Largest centered `aspect`-ratio box inside an iw x ih image.

    Returns a PIL crop box: (left, top, right, bottom).
    """
    if iw / ih > aspect:
        nw, nh = round(ih * aspect), ih      # too wide: trim the sides
    else:
        nw, nh = iw, round(iw / aspect)      # too tall: trim top and bottom
    left = (iw - nw) // 2
    top = (ih - nh) // 2
    return (left, top, left + nw, top + nh)


THUMB_W = 480
THUMB_H = 270
QUALITY = 80

# meta.json's `utility` list (Grid_001, SolidColor, Transparent, ...) is skipped
# on purpose: the picker omits those author/debug helpers too, so a thumbnail
# for them would never be shown.
DIRS = ("main", "stills")


def make_thumb(src, dst):
    """Write one stage-framed WebP thumbnail of `src` to `dst`."""
    with Image.open(src) as im:
        im = im.convert("RGB")
        im = im.crop(cover_crop_box(*im.size))
        im = im.resize((THUMB_W, THUMB_H), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "WEBP", quality=QUALITY)


def build(root):
    """Bake every main/stills thumbnail under `root`. Returns a stats dict.

    Incremental: a thumbnail at least as new as its source is left alone, so a
    rerun after extracting one new background costs one decode, not 230.
    """
    root = Path(root)
    meta = json.loads((root / "meta.json").read_text())
    thumbs_root = root / "thumbs"
    stats = {"written": 0, "skipped": 0, "pruned": 0, "missing": 0}
    wanted = set()

    for d in DIRS:
        for entry in meta.get(d, []):
            src = root / d / entry["file"]
            dst = thumbs_root / d / (Path(entry["file"]).stem + ".webp")
            wanted.add(dst)
            if not src.exists():
                stats["missing"] += 1
                continue
            if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
                stats["skipped"] += 1
                continue
            make_thumb(src, dst)
            stats["written"] += 1

    for d in DIRS:
        d_path = thumbs_root / d
        if not d_path.is_dir():
            continue
        for f in d_path.glob("*.webp"):
            if f not in wanted:
                f.unlink()
                stats["pruned"] += 1

    return stats


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path("scene/backgrounds")
    if not (root / "meta.json").exists():
        print(f"error: no meta.json under {root} — run build_backgrounds_meta.py first",
              file=sys.stderr)
        return 1
    stats = build(root)
    print(f"thumbs: {stats['written']} written, {stats['skipped']} up-to-date, "
          f"{stats['pruned']} pruned, {stats['missing']} sources missing")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
