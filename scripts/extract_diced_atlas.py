#!/usr/bin/env python3
"""Extract sprites from a Naninovel DicedSpriteAtlas bundle.

These bundles ship a single MonoBehaviour holding an ordered list of full-frame
sprite PPtrs — they are NOT layered character rigs (no GameObject/Transform
hierarchy). Use for side-characters / NPCs (Warden, Jailer, Yuki, creatures…)
shipped as Naninovel diced atlases instead of modular SpriteRenderer trees.

Each sprite is reconstructed by UnityPy from diced quads, which produces an
image sized to the *vertex bbox* of those quads — not the full sprite rect.
Different poses have different vertex bboxes, so the raw outputs would have
mismatched sizes and offsets. We pad every reconstruction to the shared
`m_Rect` so all poses land on a common canvas and align pixel-for-pixel.

Output:
  out_dir/{sprite_name}.png   — one PNG per pose, padded to the shared
                                canvas_size; transparent outside the diced
                                footprint.
  out_dir/meta.json           — { type: "diced", name, canvas_size: [W, H],
                                  poses: [<sprite_name>, …] }
                                Poses are naturally sorted ("1","2",…,"10")
                                rather than the lexical order Unity stores.

Usage: python3 scripts/extract_diced_atlas.py <bundle> <out_dir>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from PIL import Image
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler


def _natural_key(s: str) -> tuple:
    """Sort key that treats embedded integer runs as numbers ("10" > "2")."""
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"(\d+)", s))


def _vertex_bbox_world_pixels(sp) -> tuple[float, float, float, float]:
    """Return (x_min, y_min, x_max, y_max) of the sprite's mesh vertices in
    world pixels (Y-up, same coordinate system as `m_Rect`)."""
    mesh = MeshHandler(sp.m_RD, sp.object_reader.version)
    mesh.process()
    positions = mesh.m_Vertices
    if not positions:
        raise ValueError(f"Sprite {sp.m_Name!r}: no mesh vertices")
    ptu = sp.m_PixelsToUnits
    xs = [p[0] * ptu for p in positions]
    ys = [p[1] * ptu for p in positions]
    return (min(xs), min(ys), max(xs), max(ys))


def _pad_to_rect(img: Image.Image, sp) -> Image.Image:
    """Pad `img` to the sprite's full `m_Rect`, placing the reconstructed
    bbox at its correct world-anchored offset within the rect."""
    rect = sp.m_Rect
    canvas_w = int(round(rect.width))
    canvas_h = int(round(rect.height))
    x_min, y_min, x_max, y_max = _vertex_bbox_world_pixels(sp)
    # PIL is Y-down; row 0 of the reconstructed image corresponds to world y_max
    # (UnityPy applied FLIP_TOP_BOTTOM at the end of get_image_from_sprite).
    pad_left = int(round(x_min - rect.x))
    pad_top = int(round((rect.y + rect.height) - y_max))
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.paste(img, (pad_left, pad_top))
    return canvas


def extract(bundle_path: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    env = UnityPy.load(bundle_path)

    sprite_obj_by_pid: dict[int, object] = {}
    behaviour: dict | None = None
    for obj in env.objects:
        if obj.type.name == "Sprite":
            sprite_obj_by_pid[obj.path_id] = obj
        elif obj.type.name == "MonoBehaviour":
            tree = obj.read_typetree()
            if isinstance(tree, dict) and "sprites" in tree:
                behaviour = tree

    if not behaviour:
        raise SystemExit("No DicedSpriteAtlas MonoBehaviour (with `sprites` field) found.")

    atlas_name = behaviour.get("m_Name") or out.name
    sprite_refs = behaviour["sprites"]

    poses: list[str] = []
    canvas_size: tuple[int, int] | None = None
    for ref in sprite_refs:
        pid = ref.get("m_PathID") if isinstance(ref, dict) else getattr(ref, "path_id", 0)
        obj = sprite_obj_by_pid.get(pid)
        if not obj:
            print(f"  ! missing sprite path_id={pid}", file=sys.stderr)
            continue
        sp = obj.read()
        img = sp.image  # diced atlas reconstructed to its vertex bbox
        padded = _pad_to_rect(img, sp)
        sname = sp.m_Name
        padded.save(out / f"{sname}.png")
        poses.append(sname)
        if canvas_size is None:
            rect = sp.m_Rect
            canvas_size = (int(round(rect.width)), int(round(rect.height)))

    poses.sort(key=_natural_key)

    meta = {
        "type": "diced",
        "name": atlas_name,
        "canvas_size": list(canvas_size) if canvas_size else None,
        "poses": poses,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    print(f"# Extracted {len(poses)} poses from {bundle_path}")
    print(f"  name: {atlas_name}")
    print(f"  canvas_size: {canvas_size}")
    print(f"  out_dir: {out}")
    print(f"  poses: {poses}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
