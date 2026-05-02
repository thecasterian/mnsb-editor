#!/usr/bin/env python3
"""Extract UI prefab layouts to atlas-keyed folders + per-prefab layout files.

Two outputs in one tree, sharing PNGs (deduplicated by atlas):

  out_dir/
    <AtlasName>/
      <sprite_name>.png        # one PNG per unique sprite, no duplication
      ...
      layers.json              # sprite-centric: each sprite + its usages
    <PrefabName>.json          # prefab-centric: drop-in layer list for compositing
    meta.json                  # index { atlases: [...], prefabs: [...] }

Per-prefab `<PrefabName>.json` schema (mirrors characters/{Character}/layers.json
with `file` extended to a relative path):

  {
    "canvas_size": [2560, 1440],
    "name":   "NormalPrinter",
    "source": "<bundle filename>",
    "layers": [
      {
        "name":  "<sprite name>",         // canonical Unity name
        "file":  "<atlas>/<safe>.png",    // path relative to out_dir
        "go":    "<GameObject name>",
        "atlas": "<atlas>",
        "group": "<ancestor path>",
        "order": <int>,                   // depth-first visit; 0 = back
        "pos":   [x, y],                  // top-left on canvas (PIL Y-down)
        "size":  [w, h]                   // RectTransform-resolved size on canvas
      },
      ...
    ]
  }

Per-atlas `<AtlasName>/layers.json` schema (sprite-centric, with usages list):

  {
    "atlas": "<AtlasName>",
    "canvas_size": [2560, 1440],
    "sprites": [
      {
        "name":  "<sprite name>",
        "file":  "<safe>.png",            // basename (within this atlas dir)
        "size":  [w, h],                  // intrinsic sprite size
        "pivot": [px, py],                // intrinsic sprite pivot (0..1)
        "usages": [
          { "prefab": "<PrefabName>", "go": "<GO name>", "group": "<...>",
            "order": <int>, "pos": [x, y], "rect_size": [w, h] },
          ...
        ]
      },
      ...
    ]
  }

Subtree gating: any GameObject with a CanvasGroup whose `m_Alpha == 0` causes
its entire descendant subtree to be skipped (NormalPrinter's Stream template,
etc.).

Root-rect convention: prefab roots' RectTransform fields are stubs because at
runtime they're parented under a Canvas that forces canvas-size. The walker
treats the root's effective rect as the canvas regardless of serialized values.

Empty prefabs (templates with no Image-bearing leaves — `DebatePrinter`,
`AdvChoicePanel`, `ClickThroughPanel`, etc.) are skipped: their static prefab
carries no positions; their content is filled at runtime.

Usage:
  python3 scripts/extract_ui_layers.py <out_dir> <bundle> [<bundle> ...]

Bundles auto-classify: any bundle containing SpriteAtlas objects is a sprite
source; the rest are prefab bundles. Pass `general-sprites_assets_all.bundle`
plus one or more UI prefab bundles in any order.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import UnityPy
from PIL import Image as PILImage

DEFAULT_CANVAS = (2560, 1440)
UNPACKED_BUCKET = "__unpacked__"

# Unity enum mappings (short forms — see UnityEngine.UI source for full names).
TEXT_ANCHOR = {
    0: "UpperLeft",  1: "UpperCenter",  2: "UpperRight",
    3: "MiddleLeft", 4: "MiddleCenter", 5: "MiddleRight",
    6: "LowerLeft",  7: "LowerCenter",  8: "LowerRight",
}
FIT_MODE        = {0: "Unconstrained", 1: "MinSize", 2: "PreferredSize"}
GRID_CONSTRAINT = {0: "Flexible", 1: "FixedColumnCount", 2: "FixedRowCount"}
GRID_CORNER     = {0: "UpperLeft", 1: "UpperRight", 2: "LowerLeft", 3: "LowerRight"}
GRID_AXIS       = {0: "Horizontal", 1: "Vertical"}


# --- helpers ---------------------------------------------------------------

def _xy(v) -> list[float]:
    if v is None:
        return [0.0, 0.0]
    if hasattr(v, "X"):
        return [float(v.X), float(v.Y)]
    if hasattr(v, "x"):
        return [float(v.x), float(v.y)]
    return [float(v[0]), float(v[1])]


def _rgba(v) -> list[float]:
    if v is None:
        return [1.0, 1.0, 1.0, 1.0]
    if isinstance(v, dict):
        return [float(v.get("r", 1)), float(v.get("g", 1)),
                float(v.get("b", 1)), float(v.get("a", 1))]
    if hasattr(v, "r"):
        return [float(v.r), float(v.g), float(v.b), float(v.a)]
    return [float(v[0]), float(v[1]), float(v[2]), float(v[3])]


def _pptr(v) -> tuple[int, int]:
    if v is None:
        return (0, 0)
    if isinstance(v, dict):
        return (int(v.get("m_FileID", 0)), int(v.get("m_PathID", 0)))
    return (int(getattr(v, "file_id", 0)), int(getattr(v, "path_id", 0)))


def _safe_filename(name: str) -> str:
    return "".join(c if (c.isalnum() or c in "._-") else "_" for c in name)


def _child_rect(parent: tuple[float, float, float, float], r: dict) \
        -> tuple[float, float, float, float]:
    """Resolve a child RectTransform to (left, bottom, w, h) in the parent's
    coordinate frame (Unity Y-up). Implements Unity's offsetMin/offsetMax
    semantics, which differ from a simple "anchor-center + anchored_pos" when
    anchors stretch:

        rect_min = anchor_min_pos + anchored_pos - size_delta * pivot
        rect_max = anchor_max_pos + anchored_pos + size_delta * (1 - pivot)
        width    = (anchor_max.x - anchor_min.x) + size_delta.x
        height   = (anchor_max.y - anchor_min.y) + size_delta.y

    For non-stretching anchors (anchor_min == anchor_max), this reduces to
    "single anchor point + anchored_pos, sized by size_delta with pivot
    determining where the anchor lands inside the rect".
    """
    pl, pb, pw, ph = parent
    am, aM = r["anchor_min"], r["anchor_max"]
    ap, sd, pv = r["anchored_pos"], r["size_delta"], r["pivot"]
    anchor_min_x = pl + pw * am[0]
    anchor_max_x = pl + pw * aM[0]
    anchor_min_y = pb + ph * am[1]
    anchor_max_y = pb + ph * aM[1]
    cw = (anchor_max_x - anchor_min_x) + sd[0]
    ch = (anchor_max_y - anchor_min_y) + sd[1]
    cl = anchor_min_x + ap[0] - sd[0] * pv[0]
    cb = anchor_min_y + ap[1] - sd[1] * pv[1]
    return (cl, cb, cw, ch)


# --- layout-component readers ----------------------------------------------

def _read_layout_group(t: dict) -> dict | None:
    """Extract a LayoutGroup MonoBehaviour into a normalized dict.
    Distinguishes GridLayoutGroup (has m_CellSize) from
    HorizontalOrVerticalLayoutGroup (has m_ChildControlWidth) — the latter
    can't be split into Horizontal vs Vertical from typetree alone; that's
    done as a post-pass using the sibling ContentSizeFitter direction.
    Returns None if the typetree isn't a layout group."""
    pad = t.get("m_Padding") or {}
    padding = [
        int(pad.get("m_Left", 0)),
        int(pad.get("m_Right", 0)),
        int(pad.get("m_Top", 0)),
        int(pad.get("m_Bottom", 0)),
    ]
    align = t.get("m_ChildAlignment", 0)
    if "m_CellSize" in t:
        cell = t.get("m_CellSize") or {}
        sp   = t.get("m_Spacing") or {}
        return {
            "kind": "GridLayoutGroup",
            "padding": padding,
            "child_alignment": TEXT_ANCHOR.get(align, str(align)),
            "cell_size": [float(cell.get("x", 0)), float(cell.get("y", 0))],
            "spacing":   [float(sp.get("x", 0)),   float(sp.get("y", 0))],
            "start_corner":     GRID_CORNER.get(t.get("m_StartCorner", 0), str(t.get("m_StartCorner"))),
            "start_axis":       GRID_AXIS.get(t.get("m_StartAxis", 0),     str(t.get("m_StartAxis"))),
            "constraint":       GRID_CONSTRAINT.get(t.get("m_Constraint", 0), str(t.get("m_Constraint"))),
            "constraint_count": int(t.get("m_ConstraintCount", 0)),
        }
    if "m_ChildControlWidth" in t:
        sp = t.get("m_Spacing", 0.0)
        return {
            "kind": "HorizontalOrVerticalLayoutGroup",
            "padding": padding,
            "child_alignment": TEXT_ANCHOR.get(align, str(align)),
            "spacing": float(sp) if not isinstance(sp, dict) else 0.0,
            "child_control_width":       bool(t.get("m_ChildControlWidth", 0)),
            "child_control_height":      bool(t.get("m_ChildControlHeight", 0)),
            "child_force_expand_width":  bool(t.get("m_ChildForceExpandWidth", 0)),
            "child_force_expand_height": bool(t.get("m_ChildForceExpandHeight", 0)),
        }
    return None


def _read_size_fitter(t: dict) -> dict | None:
    if "m_HorizontalFit" not in t or "m_VerticalFit" not in t:
        return None
    return {
        "horizontal_fit": FIT_MODE.get(t.get("m_HorizontalFit", 0), str(t.get("m_HorizontalFit"))),
        "vertical_fit":   FIT_MODE.get(t.get("m_VerticalFit",   0), str(t.get("m_VerticalFit"))),
    }


def _resolve_hv_orientation(layout: dict, fitter: dict | None) -> dict:
    """Specialize HorizontalOrVerticalLayoutGroup to Horizontal/Vertical when
    the sibling ContentSizeFitter direction makes the choice unambiguous."""
    if layout.get("kind") != "HorizontalOrVerticalLayoutGroup" or not fitter:
        return layout
    h, v = fitter["horizontal_fit"], fitter["vertical_fit"]
    # Vertical stacking auto-grows height: vertical fit non-unconstrained, horizontal unconstrained.
    if v != "Unconstrained" and h == "Unconstrained":
        layout = dict(layout); layout["kind"] = "VerticalLayoutGroup"
    elif h != "Unconstrained" and v == "Unconstrained":
        layout = dict(layout); layout["kind"] = "HorizontalLayoutGroup"
    return layout


def _compute_placement(layout: dict, pos: list, size: list, pivot: list) -> dict | None:
    """Resolve a layout group's geometry into a placement formula consumers
    can plug N + child size into. All output coordinates are PIL Y-down.

    Returns None for ambiguous HorizontalOrVerticalLayoutGroup or when the
    layout kind is unrecognized.
    """
    kind = layout.get("kind")
    pad  = layout.get("padding") or [0, 0, 0, 0]   # [left, right, top, bottom]
    align = layout.get("child_alignment", "UpperLeft")
    cx, cy = pos
    sw, sh = size
    pvx, pvy_unity = pivot
    pvy_pil = 1.0 - pvy_unity  # Unity y-up pivot -> PIL y-down

    if kind == "GridLayoutGroup":
        cell = layout.get("cell_size") or [0, 0]
        sp   = layout.get("spacing")   or [0, 0]
        start_corner = layout.get("start_corner", "UpperLeft")
        # First cell origin (PIL top-left), depending on start_corner.
        first_x = cx + pad[0]
        first_y = cy + pad[2]
        if start_corner in ("UpperRight", "LowerRight"):
            first_x = cx + sw - pad[1] - cell[0]
        if start_corner in ("LowerLeft", "LowerRight"):
            first_y = cy + sh - pad[3] - cell[1]
        return {
            "kind": "grid",
            "first_cell_canvas_pil": [int(round(first_x)), int(round(first_y))],
            "cell_size": [int(round(cell[0])), int(round(cell[1]))],
            "step":      [int(round(cell[0] + sp[0])), int(round(cell[1] + sp[1]))],
            "constraint":       layout.get("constraint", "Flexible"),
            "constraint_count": layout.get("constraint_count", 0),
            "start_corner":     start_corner,
            "start_axis":       layout.get("start_axis", "Horizontal"),
        }

    if kind in ("VerticalLayoutGroup", "HorizontalLayoutGroup"):
        spacing = layout.get("spacing", 0.0)
        # Decompose ChildAlignment into (horizontal, vertical) components.
        h_align, v_align = {
            "UpperLeft":   ("left",   "top"),    "UpperCenter": ("center", "top"),
            "UpperRight":  ("right",  "top"),    "MiddleLeft":  ("left",   "center"),
            "MiddleCenter":("center", "center"), "MiddleRight": ("right",  "center"),
            "LowerLeft":   ("left",   "bottom"), "LowerCenter": ("center", "bottom"),
            "LowerRight":  ("right",  "bottom"),
        }.get(align, ("left", "top"))

        if kind == "VerticalLayoutGroup":
            # Cross-axis (x) anchor: which side children align to.
            if h_align == "left":
                x_anchor, x_basis = cx + pad[0],            "left"
            elif h_align == "right":
                x_anchor, x_basis = cx + sw - pad[1],       "right"
            else:
                x_anchor, x_basis = cx + (sw + pad[0] - pad[1]) / 2, "center"
            # Main-axis (y) pivot: rect grows around this point when
            # ContentSizeFitter expands height.
            y_pivot_canvas = cy + sh * pvy_pil
            return {
                "kind": "vertical",
                "x_anchor_canvas_pil": int(round(x_anchor)),
                "x_anchor_basis":      x_basis,
                "y_pivot_canvas_pil":  int(round(y_pivot_canvas)),
                "y_pivot_position":    pvy_pil,    # 0=column-top in PIL, 1=column-bottom
                "spacing":             spacing,
                "padding_top":         pad[2],
                "padding_bottom":      pad[3],
            }

        # HorizontalLayoutGroup
        if v_align == "top":
            y_anchor, y_basis = cy + pad[2],            "top"
        elif v_align == "bottom":
            y_anchor, y_basis = cy + sh - pad[3],       "bottom"
        else:
            y_anchor, y_basis = cy + (sh + pad[2] - pad[3]) / 2, "center"
        x_pivot_canvas = cx + sw * pvx
        return {
            "kind": "horizontal",
            "y_anchor_canvas_pil": int(round(y_anchor)),
            "y_anchor_basis":      y_basis,
            "x_pivot_canvas_pil":  int(round(x_pivot_canvas)),
            "x_pivot_position":    pvx,
            "spacing":             spacing,
            "padding_left":        pad[0],
            "padding_right":       pad[1],
        }

    return None  # ambiguous (HorizontalOrVerticalLayoutGroup) or unknown kind


# --- sprite source ---------------------------------------------------------

def _padded_sprite_image(sp):
    """Return sp.image padded back to m_Rect dimensions when the sprite was
    atlas-trimmed (textureRect smaller than m_Rect). Unity packs sprites into
    SpriteAtlas pages with transparent margins stripped; UnityPy's `sp.image`
    returns the cropped region. Image components in prefabs reference the
    sprite by its full m_Rect, so a compositor needs the padded version to
    keep the visible content at its authored position within the rect.

    Detection is via `m_RD.textureRectOffset` (offset of the cropped region
    inside m_Rect, in Unity Y-up). Most sprites pack flush (offset == 0) and
    pass through unchanged.
    """
    img = sp.image
    rect = sp.m_Rect
    full_w = int(round(rect.width))
    full_h = int(round(rect.height))
    if img.size == (full_w, full_h):
        return img
    rd = getattr(sp, "m_RD", None)
    tro = getattr(rd, "textureRectOffset", None) if rd else None
    tr  = getattr(rd, "textureRect",       None) if rd else None
    if tro is None or tr is None:
        return img
    ox = float(getattr(tro, "X", getattr(tro, "x", 0)))
    tr_y = float(getattr(tr,  "y", 0))
    tr_h = float(getattr(tr,  "height", 0))
    pad_left = int(round(ox))
    # textureRect coordinates are Unity Y-up (origin at m_Rect bottom-left).
    # PIL is Y-down; top padding = m_Rect.height − (textureRect.y + textureRect.height).
    pad_top  = int(round(rect.height - (tr_y + tr_h)))
    canvas = PILImage.new("RGBA", (full_w, full_h), (0, 0, 0, 0))
    canvas.paste(img, (pad_left, pad_top))
    return canvas


def _build_sprite_index(env) -> tuple[dict[int, str], dict[int, object]]:
    atlas_of_sprite: dict[int, str] = {}
    for obj in env.objects:
        if obj.type.name != "SpriteAtlas":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        atlas_name = tree.get("m_Name") or f"atlas_{obj.path_id}"
        for ref in tree.get("m_PackedSprites") or []:
            pid = ref.get("m_PathID") if isinstance(ref, dict) else getattr(ref, "path_id", 0)
            if pid:
                atlas_of_sprite[int(pid)] = atlas_name
    sprite_obj_by_pid = {o.path_id: o for o in env.objects if o.type.name == "Sprite"}
    return atlas_of_sprite, sprite_obj_by_pid


# --- per-prefab walker (in-memory only; no I/O) ----------------------------

def _walk_prefab_bundle(env, source_name: str,
                        sprite_obj_by_pid: dict[int, object],
                        atlas_of_sprite: dict[int, str],
                        canvas_size: tuple[int, int],
                        sprites_used: dict[int, dict]) -> list[dict]:
    """Walk every root prefab in env. Return list of prefab records:
        { "name": str, "source": str, "canvas_size": [W,H], "layers": [...] }
    Each layer has: name, file (basename), go, atlas, group, order, pos, size,
                    optional color/material.
    Side effect: records every referenced sprite into `sprites_used`
    (path_id -> {atlas, name, file, size, pivot, sprite_obj}).
    """
    canvas_w, canvas_h = canvas_size
    type_of: dict[int, str] = {o.path_id: o.type.name for o in env.objects}
    obj_by_pid: dict[int, object] = {o.path_id: o for o in env.objects}

    go_data: dict[int, dict] = {}
    for o in env.objects:
        if o.type.name != "GameObject":
            continue
        d = o.read()
        comp_ids: list[int] = []
        for c in (getattr(d, "m_Component", None) or []):
            comp = c.component if hasattr(c, "component") else c.get("component")
            cid = getattr(comp, "path_id", None) if comp else None
            if cid is None and isinstance(c, dict):
                inner = c.get("component", {})
                cid = inner.get("m_PathID") if isinstance(inner, dict) else None
            if cid:
                comp_ids.append(int(cid))
        go_data[o.path_id] = {
            "name": getattr(d, "m_Name", "?") or "?",
            "components": comp_ids,
        }

    trs: dict[int, dict] = {}
    for o in env.objects:
        if o.type.name not in ("Transform", "RectTransform"):
            continue
        d = o.read()
        father = d.m_Father
        kids = d.m_Children or []
        go = d.m_GameObject
        is_rect = o.type.name == "RectTransform"
        trs[o.path_id] = {
            "go_id":     getattr(go, "path_id", 0) if go else 0,
            "parent_id": getattr(father, "path_id", 0) if father else 0,
            "kids":      [int(getattr(k, "path_id", 0)) for k in kids],
            "is_rect":   is_rect,
            "rect": {
                "anchor_min":   _xy(getattr(d, "m_AnchorMin", None))   if is_rect else [0, 0],
                "anchor_max":   _xy(getattr(d, "m_AnchorMax", None))   if is_rect else [0, 0],
                "anchored_pos": _xy(getattr(d, "m_AnchoredPosition", None)) if is_rect else [0, 0],
                "size_delta":   _xy(getattr(d, "m_SizeDelta", None))   if is_rect else [0, 0],
                "pivot":        _xy(getattr(d, "m_Pivot", None))       if is_rect else [0, 0],
            },
        }

    image_data: dict[int, dict] = {}
    canvas_group_alpha: dict[int, float] = {}
    material_name: dict[int, str] = {}
    layout_group_data: dict[int, dict] = {}   # go_id -> layout_group dict
    size_fitter_data:  dict[int, dict] = {}   # go_id -> size_fitter dict
    for o in env.objects:
        if o.type.name == "Material":
            try:
                material_name[o.path_id] = getattr(o.read(), "m_Name", "?") or "?"
            except Exception:
                pass
    for go_id, gd in go_data.items():
        for cid in gd["components"]:
            ct = type_of.get(cid)
            if ct == "CanvasGroup":
                obj = obj_by_pid.get(cid)
                if obj:
                    try:
                        t = obj.read_typetree()
                        canvas_group_alpha[go_id] = float(t.get("m_Alpha", 1.0))
                    except Exception:
                        pass
            elif ct == "MonoBehaviour":
                obj = obj_by_pid.get(cid)
                if not obj:
                    continue
                try:
                    t = obj.read_typetree()
                except Exception:
                    continue
                if not isinstance(t, dict):
                    continue
                # Image-like (one per GO; first wins).
                if "m_Sprite" in t and "m_Color" in t and go_id not in image_data:
                    image_data[go_id] = {
                        "sprite_pptr":   _pptr(t.get("m_Sprite")),
                        "color":         _rgba(t.get("m_Color")),
                        "material_pptr": _pptr(t.get("m_Material")),
                    }
                # LayoutGroup (Grid or HV — at most one per GO in practice).
                lg = _read_layout_group(t)
                if lg and go_id not in layout_group_data:
                    layout_group_data[go_id] = lg
                # ContentSizeFitter.
                sf = _read_size_fitter(t)
                if sf and go_id not in size_fitter_data:
                    size_fitter_data[go_id] = sf

    # Specialize HV orientation using sibling ContentSizeFitter direction.
    for go_id, lg in list(layout_group_data.items()):
        layout_group_data[go_id] = _resolve_hv_orientation(lg, size_fitter_data.get(go_id))

    roots = [tid for tid, info in trs.items() if info["parent_id"] == 0 and info["is_rect"]]
    roots.sort(key=lambda tid: go_data.get(trs[tid]["go_id"], {}).get("name", ""))

    prefabs: list[dict] = []
    for root_tid in roots:
        record = _walk_one_prefab(root_tid, trs, go_data, image_data, canvas_group_alpha,
                                  sprite_obj_by_pid, atlas_of_sprite, material_name,
                                  layout_group_data, size_fitter_data,
                                  source_name, canvas_size, sprites_used)
        if record:
            prefabs.append(record)
    return prefabs


def _walk_one_prefab(root_tid, trs, go_data, image_data, canvas_group_alpha,
                     sprite_obj_by_pid, atlas_of_sprite, material_name,
                     layout_group_data, size_fitter_data,
                     source_name, canvas_size, sprites_used) -> dict | None:
    canvas_w, canvas_h = canvas_size
    root_info = trs[root_tid]
    prefab_name = go_data.get(root_info["go_id"], {}).get("name", f"root_{root_tid}")

    # Widget prefabs (root has non-zero size_delta — e.g. ChoiceButton_Trial:
    # 1099×318) get layered against their own intrinsic frame, so a panel
    # compositor can paste them at the placement-determined position. Screen
    # prefabs (root size=0 — NormalPrinter, OptionsUI, etc.) fill the canvas
    # and are layered against (canvas_w, canvas_h).
    root_sd = root_info["rect"]["size_delta"]
    is_widget = root_sd[0] > 0 or root_sd[1] > 0
    frame_w = float(root_sd[0]) if is_widget else float(canvas_w)
    frame_h = float(root_sd[1]) if is_widget else float(canvas_h)

    layers: list[dict] = []
    containers: list[dict] = []
    order_counter = [0]

    def visit(tid: int, parent_rect, group_path: list[str], is_root: bool) -> None:
        info = trs[tid]
        go_id = info["go_id"]
        gd = go_data.get(go_id, {"name": "?"})
        if canvas_group_alpha.get(go_id, 1.0) == 0:
            return
        rect = parent_rect if is_root else _child_rect(parent_rect, info["rect"])
        # Container record: any GO with a LayoutGroup or ContentSizeFitter on it
        # (regardless of whether it has an Image).
        lg = layout_group_data.get(go_id)
        sf = size_fitter_data.get(go_id)
        if lg is not None or sf is not None:
            l, b, w, h = rect
            entry: dict = {
                "go":    gd["name"],
                "group": "/".join(group_path) if not is_root else "",
                "pos":   [int(round(l)), int(round(frame_h - (b + h)))],
                "size":  [int(round(w)), int(round(h))],
                "pivot": info["rect"]["pivot"],   # Unity Y-up pivot, [x, y]
            }
            if lg is not None:
                entry["layout_group"] = lg
                placement = _compute_placement(lg, entry["pos"], entry["size"], entry["pivot"])
                if placement is not None:
                    entry["placement"] = placement
            if sf is not None:
                entry["size_fitter"] = sf
            containers.append(entry)
        img = image_data.get(go_id)
        if img and img["sprite_pptr"][1]:
            sp_pid = img["sprite_pptr"][1]
            obj = sprite_obj_by_pid.get(sp_pid)
            if obj is not None:
                try:
                    sp = obj.read()
                    sname = sp.m_Name
                    atlas = atlas_of_sprite.get(sp_pid, UNPACKED_BUCKET)
                    file_basename = f"{_safe_filename(sname)}.png"
                    # Remember this sprite globally (dedup at save time).
                    if sp_pid not in sprites_used:
                        srect = sp.m_Rect
                        spivot = _xy(sp.m_Pivot)
                        sprites_used[sp_pid] = {
                            "atlas": atlas,
                            "name":  sname,
                            "file":  file_basename,
                            "size":  [int(round(srect.width)), int(round(srect.height))],
                            "pivot": spivot,
                            "sprite_obj": obj,
                        }
                    l, b, w, h = rect
                    layer: dict = {
                        "name":  sname,
                        "file":  f"{atlas}/{file_basename}",
                        "go":    gd["name"],
                        "atlas": atlas,
                        "group": "/".join(group_path),
                        "order": order_counter[0],
                        "pos":   [int(round(l)), int(round(frame_h - (b + h)))],
                        "size":  [int(round(w)), int(round(h))],
                    }
                    if img["color"] != [1.0, 1.0, 1.0, 1.0]:
                        layer["color"] = img["color"]
                    mat_pid = img["material_pptr"][1]
                    if mat_pid:
                        layer["material"] = material_name.get(mat_pid, f"<unresolved:{mat_pid}>")
                    layers.append(layer)
                    order_counter[0] += 1
                except Exception as e:
                    print(f"  ! sprite extract failed for GO={gd['name']}: {e}",
                          file=sys.stderr)
        new_group = group_path + ([gd["name"]] if not is_root else [])
        for k in info["kids"]:
            if k in trs:
                visit(k, rect, new_group, is_root=False)

    root_rect = (0.0, 0.0, frame_w, frame_h)
    visit(root_tid, root_rect, [], is_root=True)

    # Drop only when the prefab carries no actionable static data — neither
    # Image-bearing leaves nor layout-bearing containers. Pure-runtime templates
    # (e.g. ClickThroughPanel) end up empty on both axes.
    if not layers and not containers:
        return None
    record: dict = {
        # canvas_size is the prefab's *rendering frame*: (canvas_w, canvas_h)
        # for screen prefabs, root's intrinsic size for widget prefabs.
        "canvas_size": [int(round(frame_w)), int(round(frame_h))],
        "name":   prefab_name,
        "source": source_name,
        "layers": layers,
    }
    if is_widget:
        record["root_intrinsic_size"] = [int(round(frame_w)), int(round(frame_h))]
    if containers:
        record["containers"] = containers
    return record


# --- entry point -----------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 1
    out_dir = Path(argv[1])
    bundle_paths = [Path(p) for p in argv[2:]]
    out_dir.mkdir(parents=True, exist_ok=True)

    sprite_envs: list[tuple[Path, object]] = []
    prefab_envs: list[tuple[Path, object]] = []
    for bp in bundle_paths:
        env = UnityPy.load(str(bp))
        if any(o.type.name == "SpriteAtlas" for o in env.objects):
            sprite_envs.append((bp, env))
        else:
            prefab_envs.append((bp, env))

    if not sprite_envs:
        print("ERROR: no SpriteAtlas-bearing bundle in inputs (need general-sprites).",
              file=sys.stderr)
        return 1
    if not prefab_envs:
        print("ERROR: no prefab bundle in inputs.", file=sys.stderr)
        return 1

    atlas_of_sprite: dict[int, str] = {}
    sprite_obj_by_pid: dict[int, object] = {}
    for _, env in sprite_envs:
        a, s = _build_sprite_index(env)
        atlas_of_sprite.update(a)
        sprite_obj_by_pid.update(s)

    # ---- Phase 1: walk every prefab into memory ---------------------------
    all_prefabs: list[dict] = []
    sprites_used: dict[int, dict] = {}
    for bp, env in prefab_envs:
        prefabs = _walk_prefab_bundle(env, bp.name, sprite_obj_by_pid,
                                      atlas_of_sprite, DEFAULT_CANVAS, sprites_used)
        all_prefabs.extend(prefabs)
        for p in prefabs:
            print(f"  {p['name']}  ({len(p['layers'])} layers, from {bp.name})")

    # ---- Phase 2: save deduplicated PNGs to <atlas>/ ----------------------
    saved_pngs: set[str] = set()
    for pid, meta in sprites_used.items():
        atlas_dir = out_dir / meta["atlas"]
        atlas_dir.mkdir(parents=True, exist_ok=True)
        rel = f"{meta['atlas']}/{meta['file']}"
        if rel in saved_pngs:
            continue
        png_path = atlas_dir / meta["file"]
        try:
            _padded_sprite_image(meta["sprite_obj"].read()).save(png_path)
            saved_pngs.add(rel)
        except Exception as e:
            print(f"  ! failed to save {png_path}: {e}", file=sys.stderr)

    # ---- Phase 3: write per-prefab JSON files at top level ----------------
    for p in all_prefabs:
        fname = f"{_safe_filename(p['name'])}.json"
        (out_dir / fname).write_text(json.dumps(p, indent=2, ensure_ascii=False))

    # ---- Phase 4: build per-atlas sprite-centric layers.json --------------
    # atlas -> sprite_name -> sprite record (with usages list)
    by_atlas: dict[str, dict[str, dict]] = {}
    for pid, meta in sprites_used.items():
        atlas = meta["atlas"]
        sname = meta["name"]
        by_atlas.setdefault(atlas, {})[sname] = {
            "name":   sname,
            "file":   meta["file"],
            "size":   meta["size"],
            "pivot":  meta["pivot"],
            "usages": [],
        }
    for p in all_prefabs:
        for layer in p["layers"]:
            atlas = layer["atlas"]
            rec = by_atlas.get(atlas, {}).get(layer["name"])
            if rec is None:
                continue
            usage: dict = {
                "prefab":    p["name"],
                "go":        layer["go"],
                "group":     layer["group"],
                "order":     layer["order"],
                "pos":       layer["pos"],
                "rect_size": layer["size"],
            }
            if "color" in layer:
                usage["color"] = layer["color"]
            if "material" in layer:
                usage["material"] = layer["material"]
            rec["usages"].append(usage)

    for atlas, sprites in by_atlas.items():
        atlas_dir = out_dir / atlas
        atlas_dir.mkdir(parents=True, exist_ok=True)
        atlas_layers = {
            "atlas": atlas,
            "canvas_size": list(DEFAULT_CANVAS),
            "sprites": sorted(sprites.values(), key=lambda s: s["name"]),
        }
        (atlas_dir / "layers.json").write_text(
            json.dumps(atlas_layers, indent=2, ensure_ascii=False)
        )

    # ---- Phase 5: top-level meta.json -------------------------------------
    meta = {
        "type": "ui_layout_index",
        "canvas_size": list(DEFAULT_CANVAS),
        "atlases": sorted(by_atlas.keys()),
        "prefabs": sorted(p["name"] for p in all_prefabs),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    print(f"\n# Extracted {len(all_prefabs)} prefab(s) into {out_dir}/")
    print(f"  atlases: {len(by_atlas)}  ({', '.join(sorted(by_atlas))})")
    print(f"  unique sprites: {len(saved_pngs)}")
    print(f"  per-prefab JSONs: {len(all_prefabs)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
