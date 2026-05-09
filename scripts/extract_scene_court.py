#!/usr/bin/env python3
"""Extract court 3D textures from AssetBundles into ``scene/court/``.

The court renderer (``scripts/render_court_3d.py``, originally landed in
commit 37d8b48) draws a 3D approximation of the trial scene's stage —
floor, raised step, lectern stands, and stained-glass backdrop wall — at
runtime-faithful camera angles. It loads five textures by exact Unity
name; this script extracts them straight from the game's AssetBundles so
the renderer doesn't depend on an external AssetRipper dump.

Targets:

  Background_014_001  (2048×2048, RGB)  general-sprites
                       The court's painted backdrop wall (one full triptych
                       of stained glass). **Distinct** from the 4096×2048
                       Adv-mode panorama of the same name in
                       ``naninovel-backgrounds/.../14_1.bundle`` — that's
                       the 2D scene background, not the 3D wall texture.
                       Disambiguated below by exact size.
  Court_Stand          (512×512, RGBA)  general-sprites
                       The lectern/podium overlay quad drawn on each
                       Stand_NN. Alpha-bearing — keep the RGBA.
  Bricks 2 BaseMap     (1024×1024, RGB) general-prefabs
                       Albedo for Court_Step (raised brick band around
                       the floor).
  Bricks 2 MaskMap     (1024×1024, RGB) general-prefabs
                       Court_Step mask channel (smoothness / occlusion /
                       metallic packed per-channel, per Unity's HDRP/URP
                       lit-shader convention).
  Bricks 2 Normal      (1024×1024, RGB) general-prefabs
                       Court_Step tangent-space normal. ``render_court_3d.py``
                       (commit 37d8b48) currently samples this as a fake-AO
                       modulator (groove darkening) rather than as a true
                       normal map; a more complete renderer would use it
                       for proper per-pixel lighting.
  Carpet 4 BaseMap     (2048×2048, RGB) general-prefabs
                       Albedo for Court_Floor.
  Carpet 4 MaskMap     (2048×2048, RGB) general-prefabs
                       Court_Floor mask channel.
  Carpet 4 Normal      (2048×2048, RGB) general-prefabs
                       Court_Floor tangent-space normal.

The current ``render_court_3d.py`` only samples three of the six PBR maps
(both BaseMaps + Bricks 2 Normal as a fake-AO hack); the other three —
the two MaskMaps and Carpet 4 Normal — aren't loaded yet but are
extracted here so a future, more complete renderer doesn't need to round-trip
back to the bundles.

Output: ``scene/court/<unity_texture_name>.png``. Filenames preserve the
exact Unity names, including spaces, since render_court_3d.py reads them
literally (e.g. ``"Carpet 4 BaseMap.png"``). Re-runnable; deletes any
stale PNG in ``out_root`` that isn't in the target set.

Usage::

    python3 scripts/extract_scene_court.py <out_root> <bundle> [<bundle> ...]

Both bundles required (in any order)::

    python3 scripts/extract_scene_court.py scene/court \\
      <…>/general-sprites_assets_all.bundle \\
      <…>/general-prefabs_assets_all.bundle
"""
from __future__ import annotations

import sys
from pathlib import Path

import UnityPy


# Texture name -> required (width, height) or None for any.
# The size constraint on Background_014_001 disambiguates the court wall
# (2048²) from the Adv-mode panorama (4096×2048) — both ship under the same
# m_Name in different bundles.
TARGET_TEXTURES: dict[str, tuple[int, int] | None] = {
    "Background_014_001": (2048, 2048),
    "Court_Stand":        None,
    "Bricks 2 BaseMap":   None,
    "Bricks 2 MaskMap":   None,
    "Bricks 2 Normal":    None,
    "Carpet 4 BaseMap":   None,
    "Carpet 4 MaskMap":   None,
    "Carpet 4 Normal":    None,
}


def build(out_root: Path, bundle_paths: list[Path]) -> dict[str, Path]:
    """Walk each bundle's Texture2D objects, save matches to out_root.
    Returns {texture_name: output_path}."""
    out_root.mkdir(parents=True, exist_ok=True)

    saved: dict[str, Path] = {}
    for bp in bundle_paths:
        env = UnityPy.load(str(bp))
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                d = obj.read()
            except Exception:
                continue
            name = d.m_Name
            if name not in TARGET_TEXTURES or name in saved:
                continue
            constraint = TARGET_TEXTURES[name]
            if constraint is not None and (d.m_Width, d.m_Height) != constraint:
                # Wrong variant (e.g. Adv panorama vs court wall) — keep looking.
                continue
            out_path = out_root / f"{name}.png"
            d.image.save(out_path)
            saved[name] = out_path

    missing = [n for n in TARGET_TEXTURES if n not in saved]
    if missing:
        raise SystemExit(
            f"missing textures: {', '.join(missing)} "
            f"(check bundle inputs)"
        )

    # Drop any stale PNG from earlier runs that isn't in the new set.
    keep = {p.name for p in saved.values()}
    for png in out_root.glob("*.png"):
        if png.name not in keep:
            png.unlink()

    return saved


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    out_root = Path(args[0])
    bundle_paths = [Path(p) for p in args[1:]]

    saved = build(out_root, bundle_paths)
    print(f"# wrote {len(saved)} textures to {out_root}/")
    for name, path in sorted(saved.items()):
        print(f"  {name:25}  -> {path.name}")
