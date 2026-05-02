#!/usr/bin/env python3
"""Extract a single full-frame image from a Texture2D+Sprite-only AssetBundle.

These bundles ship one Texture2D plus one Sprite that covers the whole
texture (rect = full texture size, pivot = center). There is no GameObject /
Transform tree (so `extract_bundle.py` does not apply) and no Naninovel
DicedSpriteAtlas MonoBehaviour (so `extract_diced_atlas.py` does not apply).

Use for backgrounds and stills (Background_NNN_MMM, Still_NNN_MMM, …).

Output:
  out_dir/{m_Name}.png   — full-resolution PNG of the texture, named after
                           the asset's `m_Name` (zero-padded, sorts naturally).

Re-running on an existing PNG is a no-op (the file is preserved as-is).

Usage: python3 scripts/extract_background.py <bundle> <out_dir>
"""
from __future__ import annotations

import sys
from pathlib import Path

import UnityPy


def extract(bundle_path: str, out_dir: str) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    env = UnityPy.load(bundle_path)

    textures = [obj for obj in env.objects if obj.type.name == "Texture2D"]
    if len(textures) != 1:
        raise SystemExit(
            f"{bundle_path}: expected exactly 1 Texture2D, found {len(textures)}"
        )

    tex = textures[0].read()
    name = tex.m_Name
    if not name:
        raise SystemExit(f"{bundle_path}: Texture2D has empty m_Name")

    dest = out / f"{name}.png"
    if dest.exists():
        print(f"# skip (exists): {dest}")
        return dest

    img = tex.image  # PIL Image in correct orientation
    img.save(dest)
    print(f"# wrote {dest}  ({img.size[0]}x{img.size[1]})")
    return dest


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
