#!/usr/bin/env python3
"""Probe a Unity AssetBundle and report what's inside.

Goal: decide which tier of the extraction pipeline is feasible:
  - floor   : Texture2D pixels only -> dump atlases, still crop manually
  - likely  : Sprites with rect/pivot -> auto-cropped per-layer PNGs
  - best    : Sprites + GameObject/Transform tree -> also recover canvas
              placement + render order (replaces _ref/.../info.txt)

Usage: python3 scripts/inspect_bundle.py <bundle>
"""
from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

import UnityPy


def safe(obj, *names, default=None):
    """Return first existing attribute, tolerating UnityPy version drift."""
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    return default


def main(bundle_path: str) -> None:
    env = UnityPy.load(bundle_path)
    print(f"# Bundle: {bundle_path}")
    print(f"# UnityPy {UnityPy.__version__}")

    type_counts: Counter[str] = Counter()
    by_type: dict[str, list] = defaultdict(list)
    for obj in env.objects:
        t = obj.type.name
        type_counts[t] += 1
        by_type[t].append(obj)

    print("\n## Object inventory")
    for t, n in type_counts.most_common():
        print(f"  {t:24s} {n}")

    # --- Texture2D summary -------------------------------------------------
    print("\n## Texture2D")
    for obj in by_type.get("Texture2D", [])[:20]:
        d = obj.read()
        name = safe(d, "m_Name", "name", default="?")
        w = safe(d, "m_Width", "width", default="?")
        h = safe(d, "m_Height", "height", default="?")
        print(f"  {name:40s} {w}x{h}")
    if len(by_type.get("Texture2D", [])) > 20:
        print(f"  ... and {len(by_type['Texture2D']) - 20} more")

    # --- Sprite summary ----------------------------------------------------
    sprites = by_type.get("Sprite", [])
    print(f"\n## Sprite ({len(sprites)} total)")
    for obj in sprites[:10]:
        d = obj.read()
        name = safe(d, "m_Name", "name", default="?")
        rect = safe(d, "m_Rect", default=None)
        pivot = safe(d, "m_Pivot", default=None)
        ptu = safe(d, "m_PixelsToUnits", default=None)
        if rect is not None:
            rx = safe(rect, "x", default="?")
            ry = safe(rect, "y", default="?")
            rw = safe(rect, "width", default="?")
            rh = safe(rect, "height", default="?")
            rect_s = f"rect=({rx:.1f},{ry:.1f} {rw:.1f}x{rh:.1f})"
        else:
            rect_s = "rect=?"
        if pivot is not None:
            pivot_s = f"pivot=({safe(pivot,'x',default='?')},{safe(pivot,'y',default='?')})"
        else:
            pivot_s = "pivot=?"
        print(f"  {name:30s} {rect_s} {pivot_s} ptu={ptu}")

    # --- GameObject hierarchy ---------------------------------------------
    gos = by_type.get("GameObject", [])
    print(f"\n## GameObject ({len(gos)} total)")
    # Map GameObject path_id -> name + transform
    go_name: dict[int, str] = {}
    for obj in gos:
        d = obj.read()
        go_name[obj.path_id] = safe(d, "m_Name", "name", default="?")

    transforms = by_type.get("Transform", []) + by_type.get("RectTransform", [])
    print(f"## Transform/RectTransform ({len(transforms)} total)")

    if not transforms:
        print("  (no transforms — bundle has no scene hierarchy)")
        return

    # Build child -> parent + parent -> children, and collect roots
    parent_of: dict[int, int] = {}
    children_of: dict[int, list[int]] = defaultdict(list)
    transform_data: dict[int, dict] = {}
    for obj in transforms:
        d = obj.read()
        tid = obj.path_id
        father = safe(d, "m_Father", default=None)
        father_id = safe(father, "path_id", default=0) if father is not None else 0
        kids = safe(d, "m_Children", default=[]) or []
        kid_ids = [safe(k, "path_id", default=0) for k in kids]
        go_pptr = safe(d, "m_GameObject", default=None)
        go_id = safe(go_pptr, "path_id", default=0) if go_pptr is not None else 0
        is_rect = obj.type.name == "RectTransform"
        # Plain Transform uses LocalPosition; RectTransform layout lives in
        # m_AnchoredPosition / m_SizeDelta / m_AnchorMin / m_AnchorMax / m_Pivot
        # (m_LocalPosition is computed and not load-bearing for UI).
        transform_data[tid] = {
            "go_id": go_id,
            "type": obj.type.name,
            "children": kid_ids,
            "pos": safe(d, "m_LocalPosition", default=None) if not is_rect else None,
            "scale": safe(d, "m_LocalScale", default=None),
            "anchored_pos": safe(d, "m_AnchoredPosition", default=None) if is_rect else None,
            "size_delta":   safe(d, "m_SizeDelta",       default=None) if is_rect else None,
            "anchor_min":   safe(d, "m_AnchorMin",       default=None) if is_rect else None,
            "anchor_max":   safe(d, "m_AnchorMax",       default=None) if is_rect else None,
            "pivot":        safe(d, "m_Pivot",           default=None) if is_rect else None,
        }
        if father_id:
            parent_of[tid] = father_id
        for k in kid_ids:
            children_of[tid].append(k)

    roots = [tid for tid in transform_data if tid not in parent_of]
    print(f"## Roots: {len(roots)}")

    def _xy(v, fmt: str = ".1f") -> str:
        if v is None:
            return "?"
        x = safe(v, "x", "X", default=0)
        y = safe(v, "y", "Y", default=0)
        return f"({x:{fmt}},{y:{fmt}})"

    def fmt_pos(pos) -> str:
        if pos is None:
            return ""
        x = safe(pos, "x", default=0)
        y = safe(pos, "y", default=0)
        z = safe(pos, "z", default=0)
        return f"pos=({x:.1f},{y:.1f},{z:.1f})"

    def fmt_rect(td) -> str:
        # Anchors/pivot are normalized 0..1 → 2 decimals; anc/size are pixels.
        return (
            f"anc={_xy(td['anchored_pos'])} "
            f"sz={_xy(td['size_delta'])} "
            f"ax={_xy(td['anchor_min'], '.2g')}..{_xy(td['anchor_max'], '.2g')} "
            f"pv={_xy(td['pivot'], '.2g')}"
        )

    def walk(tid: int, depth: int, max_depth: int = 6, max_lines: list = [0]):
        if max_lines[0] > 80:
            return
        td = transform_data.get(tid)
        if not td:
            return
        name = go_name.get(td["go_id"], "?")
        geom = fmt_rect(td) if td["type"] == "RectTransform" else fmt_pos(td["pos"])
        print(f"  {'  '*depth}{name}  [{td['type']}] {geom}")
        max_lines[0] += 1
        if depth >= max_depth:
            if td["children"]:
                print(f"  {'  '*(depth+1)}... ({len(td['children'])} children truncated)")
            return
        for k in td["children"]:
            walk(k, depth + 1, max_depth, max_lines)

    print("\n## Hierarchy (depth<=6, first 80 nodes)")
    counter = [0]
    for r in roots[:3]:
        walk(r, 0, max_depth=6, max_lines=counter)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
