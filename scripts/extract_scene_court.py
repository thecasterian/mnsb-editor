#!/usr/bin/env python3
"""Extract court 3D textures + meshes from AssetBundles into ``scene/court/``.

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

Mesh extraction:

  step_mesh.json (= default_0.asset, 194 verts / 128 tris) — the step's
  capped-cylinder mesh with custom Unity UV unwrap (alternating sub-strips
  on the side, separate cap UVs). Loaded by ``scene_court.js`` to build a
  ``BufferGeometry`` matching the prefab exactly. Without the asset's UVs,
  Three.js's procedural ``CylinderGeometry`` produces a uniform sweep that
  doesn't line up with the brick texture's authored layout.

  wall_mesh.json (= default.asset, 128 verts / 64 tris) — the wall's
  canonical half-shell. Mesh-local: radius 1, full height 1 (y ∈ [-0.5,
  +0.5]), covering the -Z hemisphere only (z ∈ [-1, 0]). Loaded by
  ``scene_court.js`` and instantiated twice with the prefab's per-wall
  rotations + per-half material UV. Carries the prefab's authored UV
  unwrap (V along height, U along arc, with the prefab's specific
  start/direction baked in), which lets the renderer drop the
  flip-and-shift gymnastics that the procedural ``CylinderGeometry``
  path needed.

  Both court meshes (the wall half-shell ``default`` and the step
  ``default_0``) are stored under the same Unity ``m_Name`` (literal
  string ``"default"``), so this script disambiguates by vertex count
  (128 for the wall, 194 for the step).

Output: ``scene/court/<unity_texture_name>.png``,
``scene/court/step_mesh.json``, and ``scene/court/wall_mesh.json``.
Texture filenames preserve the exact Unity names, including spaces,
since render_court_3d.py reads them literally (e.g. ``"Carpet 4
BaseMap.png"``). Re-runnable; deletes any stale PNG/JSON in
``out_root`` that isn't in the target set.

Usage::

    python3 scripts/extract_scene_court.py <out_root> <bundle> [<bundle> ...]

Both bundles required (in any order)::

    python3 scripts/extract_scene_court.py scene/court \\
      <…>/general-sprites_assets_all.bundle \\
      <…>/general-prefabs_assets_all.bundle
"""
from __future__ import annotations

import json
import struct
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

# Mesh spec keyed by vertex count. Both court meshes have m_Name='default'
# in the bundle, so vertex count is the stable disambiguator.
TARGET_MESHES: dict[int, dict] = {
    194: {
        "expect_tris":  128,
        "out_filename": "step_mesh.json",
        "doc_comment":  (
            "Step (central podium) mesh from default_0.asset. Mesh-local "
            "(unit cylinder, radius 1, height 2 with y in [-1, +1]); apply "
            "prefab scale (24, 1, 24) for world coords. UVs are RAW asset "
            "values in [0, 1] — Unity V=0=bottom convention. With Three.js "
            "Texture.flipY=true (default) and material.map.repeat=(8, 8), "
            "no V-flip is needed: the flipY+integer-repeat combination "
            "matches Python's (1 - asset_v) * 8 transform under wrap."
        ),
    },
    128: {
        "expect_tris":  64,
        "out_filename": "wall_mesh.json",
        "doc_comment":  (
            "Wall (canonical half-shell) mesh from default.asset. "
            "Mesh-local: radius 1, full height 1 (y in [-0.5, +0.5]), "
            "covering the -Z hemisphere only (z in [-1, 0]). Apply "
            "prefab scale (WALL_RADIUS, WALL_HEIGHT, WALL_RADIUS) and "
            "the prefab's per-wall rotation (R_y(-7.5°) · R_z(180°) for "
            "Wall_1; R_y(-7.5°) · R_x(180°) for Wall_2) to place. UVs "
            "are RAW asset values; the per-wall material m_Scale.x and "
            "m_Offset.x are then applied directly via Texture.repeat / "
            ".offset (no flip-and-shift workaround needed)."
        ),
    },
}

# Vertex stream layout for both court meshes (UnityPy reports identical
# m_Channels for ``default`` and ``default_0``). Stride = 48 bytes per vertex.
#   ch 0  position dim 3 offset  0  (float3)
#   ch 1  normal   dim 3 offset 12  (float3)
#   ch 2  tangent  dim 4 offset 24  (float4)
#   ch 4  UV0      dim 2 offset 40  (float2)
_VERTEX_STRIDE = 48
_UV0_OFFSET    = 40


def _decode_mesh(mesh) -> dict[str, object]:
    """Decode position + UV0 + index buffer from a UnityPy Mesh.

    Matches the inline decode in ``render_court_3d.py``'s ``step_mesh()``;
    centralised here so both Python and JS consumers see the same layout."""
    vd = mesh.m_VertexData
    n_verts = vd.m_VertexCount
    raw = bytes(vd.m_DataSize)
    if n_verts * _VERTEX_STRIDE != len(raw):
        raise SystemExit(
            f"Mesh {mesh.m_Name!r}: vertex stride mismatch "
            f"({n_verts} * {_VERTEX_STRIDE} != {len(raw)})"
        )

    positions: list[float] = []
    uvs:       list[float] = []
    for i in range(n_verts):
        b = i * _VERTEX_STRIDE
        px, py, pz = struct.unpack_from("<fff", raw, b)
        u, v       = struct.unpack_from("<ff",  raw, b + _UV0_OFFSET)
        positions.extend([px, py, pz])
        uvs.extend([u, v])

    idx_bytes = bytes(mesh.m_IndexBuffer)
    if mesh.m_IndexFormat == 0:                    # UInt16
        n_idx = len(idx_bytes) // 2
        indices = list(struct.unpack(f"<{n_idx}H", idx_bytes))
    else:                                          # UInt32
        n_idx = len(idx_bytes) // 4
        indices = list(struct.unpack(f"<{n_idx}I", idx_bytes))

    return {
        "vertex_count":   n_verts,
        "triangle_count": n_idx // 3,
        "positions":      positions,
        "indices":        indices,
        "uvs":            uvs,
    }


def build(out_root: Path, bundle_paths: list[Path]) -> tuple[dict, dict]:
    """Walk each bundle's Texture2D + Mesh objects, save matches to out_root.
    Returns ({texture_name: path}, {vertex_count: path})."""
    out_root.mkdir(parents=True, exist_ok=True)

    saved_textures: dict[str, Path] = {}
    saved_meshes:   dict[int, Path] = {}

    for bp in bundle_paths:
        env = UnityPy.load(str(bp))
        for obj in env.objects:
            if obj.type.name == "Texture2D":
                try:
                    d = obj.read()
                except Exception:
                    continue
                name = d.m_Name
                if name not in TARGET_TEXTURES or name in saved_textures:
                    continue
                constraint = TARGET_TEXTURES[name]
                if constraint is not None and (d.m_Width, d.m_Height) != constraint:
                    continue
                out_path = out_root / f"{name}.png"
                d.image.save(out_path)
                saved_textures[name] = out_path

            elif obj.type.name == "Mesh":
                try:
                    m = obj.read()
                except Exception:
                    continue
                vc = m.m_VertexData.m_VertexCount
                if vc not in TARGET_MESHES or vc in saved_meshes:
                    continue
                spec = TARGET_MESHES[vc]
                data = _decode_mesh(m)
                if data["triangle_count"] != spec["expect_tris"]:
                    continue
                out_path = out_root / spec["out_filename"]
                out_path.write_text(json.dumps({"_comment": spec["doc_comment"], **data}))
                saved_meshes[vc] = out_path

    missing_tex = [n for n in TARGET_TEXTURES if n not in saved_textures]
    missing_mesh = [vc for vc in TARGET_MESHES if vc not in saved_meshes]
    if missing_tex or missing_mesh:
        bits = []
        if missing_tex:
            bits.append(f"textures: {', '.join(missing_tex)}")
        if missing_mesh:
            names = [TARGET_MESHES[vc]["out_filename"] for vc in missing_mesh]
            bits.append(f"meshes: {', '.join(names)}")
        raise SystemExit(f"missing {' / '.join(bits)} (check bundle inputs)")

    # Drop any stale PNG/JSON from earlier runs that isn't in the new set.
    keep = (
        {p.name for p in saved_textures.values()}
        | {p.name for p in saved_meshes.values()}
    )
    for f in list(out_root.glob("*.png")) + list(out_root.glob("*.json")):
        if f.name not in keep:
            f.unlink()

    return saved_textures, saved_meshes


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    out_root = Path(args[0])
    bundle_paths = [Path(p) for p in args[1:]]

    saved_tex, saved_mesh = build(out_root, bundle_paths)
    print(f"# wrote {len(saved_tex)} textures + {len(saved_mesh)} meshes to {out_root}/")
    for name, path in sorted(saved_tex.items()):
        print(f"  texture  {name:25}  -> {path.name}")
    for vc, path in sorted(saved_mesh.items()):
        tris = TARGET_MESHES[vc]["expect_tris"]
        label = f"(verts={vc}, tris={tris})"
        print(f"  mesh     {label:25}  -> {path.name}")
