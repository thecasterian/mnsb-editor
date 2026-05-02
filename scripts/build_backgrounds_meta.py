#!/usr/bin/env python3
"""Scan backgrounds/{main,stills}/ and emit backgrounds/meta.json.

The scene editor reads this file to populate its picker without having to
do a directory walk in the browser.

Output schema:
  {
    "main":    [{ "id": "NNN_MMM", "name": "Background_NNN_MMM",
                  "file": "Background_NNN_MMM.png", "size": [W, H] }, ...],
    "stills":  [{ "id": "NNN_MMM", "name": "Still_NNN_MMM",       ... }, ...],
    "utility": [{                  "name": "Grid_001",            ... }, ...]
  }

`utility` holds the non-numbered helpers that ship in the mainbackground
folder (Grid_001/002, SolidColor, Transparent) — kept for completeness so
the editor can offer them as primitives without mixing them into the
numbered background list.

Numeric ids sort naturally (`"001_001"` < `"010_001"`) without a custom
comparator because the components are zero-padded.

Usage: python3 scripts/build_backgrounds_meta.py [<root>]
       (default root: ./backgrounds)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image

_NUMBERED_PREFIXES = {
    "main":   "Background_",
    "stills": "Still_",
}
_ID_RE = re.compile(r"^(?:Background|Still)_(\d{3}_\d{3})$")


def _scan(dir_path: Path, prefix: str) -> tuple[list[dict], list[dict]]:
    """Return (numbered, utility) entry lists for one subdirectory."""
    numbered: list[dict] = []
    utility: list[dict] = []
    for png in sorted(dir_path.glob("*.png")):
        stem = png.stem
        with Image.open(png) as im:
            size = list(im.size)
        m = _ID_RE.match(stem)
        if m and stem.startswith(prefix):
            numbered.append({
                "id": m.group(1),
                "name": stem,
                "file": png.name,
                "size": size,
            })
        else:
            utility.append({
                "name": stem,
                "file": png.name,
                "size": size,
            })
    numbered.sort(key=lambda e: e["id"])
    utility.sort(key=lambda e: e["name"])
    return numbered, utility


def build(root: Path) -> dict:
    meta: dict = {}
    all_utility: list[dict] = []
    for kind, prefix in _NUMBERED_PREFIXES.items():
        sub = root / kind
        if not sub.is_dir():
            meta[kind] = []
            continue
        numbered, utility = _scan(sub, prefix)
        meta[kind] = numbered
        for u in utility:
            u["from"] = kind
        all_utility.extend(utility)
    all_utility.sort(key=lambda e: e["name"])
    meta["utility"] = all_utility
    return meta


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "backgrounds")
    if not root.is_dir():
        raise SystemExit(f"{root}: not a directory")
    meta = build(root)
    out = root / "meta.json"
    out.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    counts = {k: len(v) for k, v in meta.items()}
    print(f"# wrote {out}  ({counts})")
