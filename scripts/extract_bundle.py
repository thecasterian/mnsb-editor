#!/usr/bin/env python3
"""Extract sprites and layer metadata from a Unity AssetBundle.

Produces the bbox+pos schema used by the renderer in index.html:
  out_dir/{name}.png      — bbox-cropped sprite from the atlas
  out_dir/layers.json     — { canvas_size, layers: [{name, group, order, pos, empty}] }

Canvas-size policy: auto-grow (option C). The canvas is sized to fit the bbox
of every leaf sprite's footprint. Y is flipped from Unity (Y-up) to PIL (Y-down).

If out_dir/layers.json already exists, per-layer curation fields
(`requires`, `excludes_groups`, `requires_groups`, `auto_enable`, and any user
override of `empty`) are preserved by merging on layer name.

Usage: python3 scripts/extract_bundle.py <bundle> <out_dir>
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import UnityPy

# Layers whose name embeds an arm pose (Effect_Back_ArmR07, ArmL01_Softlight,
# Option_ArmL11, …) depend on that arm being active. Auto-derive the requires
# field from the embedded arm token so they disappear when the arm switches.
_ARM_REQUIRES_PATTERN = re.compile(r"(Arm[LR]\d+|Arms\d+)")

# Curation fields preserved from an existing layers.json across re-extraction.
# `group` is preserved because the bundle hierarchy doesn't always match the
# UI grouping a human chose (e.g. ClippingMask_* are direct children of
# Angle01 in the bundle, but live under Angle01/ClippingMask in the panel).
PRESERVED_LAYER_FIELDS = (
    "group",
    "requires",
    "excludes_groups",
    "requires_groups",
    "auto_enable",
)


@dataclass
class Leaf:
    name: str           # layer name (= sprite name = GameObject name)
    group: str          # bundle hierarchy path minus root, e.g. "Angle01/ArmR"
    order: int          # SpriteRenderer.sortingOrder
    sprite_pathid: int
    # World footprint in pixels (Unity Y-up, accumulated transforms × PTU)
    left: float
    right: float
    top_y_up: float     # highest Y of sprite (Y-up)
    bottom_y_up: float  # lowest  Y of sprite (Y-up)
    width: int          # sprite rect width  (pixels)
    height: int         # sprite rect height (pixels)
    render: dict        # {"blend": str, "stencil": None | {"role","ref"[,"cutoff"]}}


# Naninovel shader name (`Naninovel Extender/<Blend>`) -> renderer-side blend tag.
# Default→source-over to match Canvas2D / your existing clipping.json convention;
# the rest are kept lowercase, hyphen-free, matching shader file names.
_BLEND_FROM_SHADER = {
    "default": "source-over",
    "multiply": "multiply",
    "overlay": "overlay",
    "softlight": "softlight",
}


def _read_material_floats(mat) -> dict:
    sp = getattr(mat, "m_SavedProperties", None)
    if not sp:
        return {}
    out = {}
    for entry in (getattr(sp, "m_Floats", None) or []):
        if isinstance(entry, tuple) and len(entry) == 2:
            k, v = entry
        else:
            k = getattr(entry, "first", None)
            v = getattr(entry, "second", None)
        if k is None:
            continue
        out[str(k)] = v
    return out


def _parse_render(shader_name: str, mat_floats: dict) -> dict:
    """Map (shader name, material stencil props) -> render descriptor.

    Stencil semantics (from Unity's CompareFunction / StencilOp enums):
      _StencilComp=8 (Always) and _StencilOp=2 (Replace) → writes _StencilRef
      _StencilComp=4 (Equal)  and _StencilOp=0 (Keep)    → reads  _StencilRef
      _StencilComp=8/Op=0 (default), _StencilRef=0       → no stencil interaction
    """
    base = shader_name.split("/")[-1].strip().lower()
    blend = _BLEND_FROM_SHADER.get(base, base)
    comp = int(mat_floats.get("_StencilComp", 8))
    op = int(mat_floats.get("_StencilOp", 0))
    ref = int(mat_floats.get("_StencilRef", 0))
    cutoff = float(mat_floats.get("_Cutoff", 0.0))

    stencil = None
    if op == 2 and ref > 0:
        s = {"role": "write", "ref": ref}
        if cutoff > 0:
            s["cutoff"] = round(cutoff, 4)
        stencil = s
    elif comp == 4 and ref > 0:
        stencil = {"role": "read", "ref": ref}

    return {"blend": blend, "stencil": stencil}


def _read(env):
    """Resolve every object once; return per-type dicts keyed by path_id."""
    by_pathid: dict[int, object] = {}
    by_type: dict[str, list] = defaultdict(list)
    for obj in env.objects:
        d = obj.read()
        by_pathid[obj.path_id] = d
        by_type[obj.type.name].append((obj.path_id, d))
    return by_pathid, by_type


def _pptr(p) -> int:
    return getattr(p, "path_id", 0) or 0


def extract(bundle_path: str, out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    env = UnityPy.load(bundle_path)
    by_pathid, by_type = _read(env)

    # --- Index GameObjects, Transforms, SpriteRenderers, Sprites -----------
    go_name: dict[int, str] = {pid: d.m_Name for pid, d in by_type.get("GameObject", [])}

    # transforms[id] = {pos, parent_id, children_ids, go_id}
    transforms: dict[int, dict] = {}
    for pid, d in by_type.get("Transform", []) + by_type.get("RectTransform", []):
        transforms[pid] = {
            "pos": (d.m_LocalPosition.x, d.m_LocalPosition.y, d.m_LocalPosition.z),
            "parent": _pptr(d.m_Father),
            "children": [_pptr(c) for c in (d.m_Children or [])],
            "go": _pptr(d.m_GameObject),
        }

    # GameObject id -> Transform id (each GO has exactly one Transform)
    go_to_xform: dict[int, int] = {}
    for tid, td in transforms.items():
        if td["go"]:
            go_to_xform[td["go"]] = tid

    # GameObject id -> SpriteRenderer (if any)
    sr_by_go: dict[int, object] = {}
    for pid, d in by_type.get("SpriteRenderer", []):
        go_id = _pptr(d.m_GameObject)
        if go_id:
            sr_by_go[go_id] = d

    # Sprite by path_id (we resolve via SR.m_Sprite PPtr)
    sprite_by_pid: dict[int, object] = {pid: d for pid, d in by_type.get("Sprite", [])}

    # Shader name + Material lookup tables (for render descriptor)
    shader_name_by_pid: dict[int, str] = {}
    for pid, d in by_type.get("Shader", []):
        pf = getattr(d, "m_ParsedForm", None)
        shader_name_by_pid[pid] = (getattr(pf, "m_Name", None) or "?") if pf else "?"
    material_by_pid: dict[int, object] = {pid: d for pid, d in by_type.get("Material", [])}

    # --- Find the root transform ------------------------------------------
    roots = [tid for tid, td in transforms.items() if td["parent"] == 0]
    if len(roots) != 1:
        raise SystemExit(f"Expected 1 root Transform, got {len(roots)}: {roots}")
    root_id = roots[0]
    root_name = go_name.get(transforms[root_id]["go"], "Root")

    # --- Walk hierarchy: world position + group path per transform --------
    # world_pos is in Unity world units (Y-up); group path excludes the root.
    world: dict[int, tuple[float, float]] = {}
    group_path: dict[int, str] = {}

    def walk(tid: int, parent_world: tuple[float, float], parent_path: list[str]) -> None:
        td = transforms[tid]
        wx = parent_world[0] + td["pos"][0]
        wy = parent_world[1] + td["pos"][1]
        world[tid] = (wx, wy)
        name = go_name.get(td["go"], "?")
        # group is the path of all parents under root, joined; excludes the leaf itself
        group_path[tid] = "/".join(parent_path) if parent_path else ""
        next_path = parent_path + [name] if name != root_name else [name]
        # Re-derive next path: we always exclude the root from group strings,
        # so the first level under root starts with its own name (e.g. "Angle01").
        if tid == root_id:
            next_path_for_kids: list[str] = []
        else:
            next_path_for_kids = parent_path + [name]
        for c in td["children"]:
            walk(c, (wx, wy), next_path_for_kids)

    walk(root_id, (0.0, 0.0), [])

    # --- Collect leaves (transforms with a SpriteRenderer + Sprite) -------
    leaves: list[Leaf] = []
    for tid, td in transforms.items():
        sr = sr_by_go.get(td["go"])
        if not sr:
            continue
        sp_id = _pptr(sr.m_Sprite)
        sp = sprite_by_pid.get(sp_id)
        if not sp:
            continue
        rect = sp.m_Rect
        pivot = sp.m_Pivot
        ptu = sp.m_PixelsToUnits  # pixels per Unity unit (typically 100)
        w = float(rect.width)
        h = float(rect.height)
        wx, wy = world[tid]
        # Sprite center in pixels (Unity Y-up)
        cx_px = wx * ptu
        cy_px = wy * ptu
        left   = cx_px - w * pivot.x
        right  = cx_px + w * (1.0 - pivot.x)
        top    = cy_px + h * (1.0 - pivot.y)  # higher Y in Unity Y-up
        bottom = cy_px - h * pivot.y
        # Resolve material -> shader -> render descriptor
        render = {"blend": "source-over", "stencil": None}
        mats = getattr(sr, "m_Materials", None) or []
        if mats:
            mat = material_by_pid.get(_pptr(mats[0]))
            if mat:
                shader_name = shader_name_by_pid.get(_pptr(mat.m_Shader), "?")
                render = _parse_render(shader_name, _read_material_floats(mat))

        # SpriteRenderer-level tint (per-instance color override). Unity's
        # sprite shader multiplies fragment_color = texture · m_Color, then
        # runs alpha test against _Cutoff. Mirror that order in the renderer.
        sr_color = getattr(sr, "m_Color", None)
        if sr_color is not None:
            r = round(getattr(sr_color, "r", 1.0), 4)
            g = round(getattr(sr_color, "g", 1.0), 4)
            b = round(getattr(sr_color, "b", 1.0), 4)
            a = round(getattr(sr_color, "a", 1.0), 4)
            if (r, g, b, a) != (1.0, 1.0, 1.0, 1.0):
                render["tint"] = [r, g, b, a]

        leaves.append(Leaf(
            name=go_name.get(td["go"], "?"),
            group=group_path[tid],
            order=int(getattr(sr, "m_SortingOrder", 0)),
            sprite_pathid=sp_id,
            left=left, right=right, top_y_up=top, bottom_y_up=bottom,
            width=int(w), height=int(h),
            render=render,
        ))

    if not leaves:
        raise SystemExit("No sprite leaves found in bundle.")

    # --- Auto-grow canvas (option C): bbox of all leaf footprints ---------
    g_left   = min(L.left   for L in leaves)
    g_right  = max(L.right  for L in leaves)
    g_top    = max(L.top_y_up    for L in leaves)
    g_bottom = min(L.bottom_y_up for L in leaves)
    canvas_w = int(math.ceil(g_right - g_left))
    canvas_h = int(math.ceil(g_top - g_bottom))

    # --- Save sprite PNGs (bbox-cropped from atlas) -----------------------
    for L in leaves:
        if L.width == 0 or L.height == 0:
            continue  # zero-sized placeholder slot in the prefab; layer marked empty
        sp = sprite_by_pid[L.sprite_pathid]
        # UnityPy resolves Sprite.image to the cropped, oriented sprite.
        img = sp.image
        img.save(out / f"{L.name}.png")

    # --- Compose layer entries --------------------------------------------
    layer_entries: list[dict] = []
    for L in leaves:
        # PIL pixel coords: top-left of sprite on canvas, Y-flipped
        pos_x = int(round(L.left - g_left))
        pos_y = int(round(g_top - L.top_y_up))
        entry = {
            "name": L.name,
            "group": L.group,
            "order": L.order,
            "empty": L.width == 0 or L.height == 0,
            "pos": [pos_x, pos_y],
            "render": L.render,
        }
        # Auto-derive arm-pose requirement from name (e.g. ArmL01_Softlight →
        # requires ArmL01); skip self-reference (ArmL01 itself).
        m = _ARM_REQUIRES_PATTERN.search(L.name)
        if m and m.group(1) != L.name:
            entry["requires"] = m.group(1)
        layer_entries.append(entry)
    # Sort by order descending — matches existing layers.json convention.
    layer_entries.sort(key=lambda e: -e["order"])

    # --- Merge with existing layers.json (preserve curation fields) -------
    layers_json_path = out / "layers.json"
    existing_by_name: dict[str, dict] = {}
    if layers_json_path.exists():
        prev = json.loads(layers_json_path.read_text())
        for e in prev.get("layers", []):
            existing_by_name[e["name"]] = e

    for e in layer_entries:
        prev = existing_by_name.get(e["name"])
        if not prev:
            continue
        for k in PRESERVED_LAYER_FIELDS:
            if k in prev:
                e[k] = prev[k]
        # `empty` is bundle-driven: a sprite exists (and is rendered) unless
        # the bundle ships a zero-sized placeholder. We don't preserve a
        # user-set `empty: true` because it was historically used to hide
        # layers we hadn't yet extracted hi-res versions of — the bundle
        # supersedes that workaround.

    out_data = {
        "canvas_size": [canvas_w, canvas_h],
        "layers": layer_entries,
    }
    layers_json_path.write_text(json.dumps(out_data, indent=2, ensure_ascii=False))

    # --- Report -----------------------------------------------------------
    print(f"# Extracted {len(leaves)} sprites from {bundle_path}")
    print(f"  root: {root_name}")
    print(f"  canvas_size: [{canvas_w}, {canvas_h}]")
    print(f"  out_dir: {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
