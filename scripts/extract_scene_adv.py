#!/usr/bin/env python3
"""Extract the Adv-scene editor's UI assets from AssetBundles into ``scene/adv/``.

The scene editor (scene.js) renders a resting Adv-mode dialog frame composed
of four prefabs — NormalPrinter, AutoToggle, ControlPanel, WitchBookButtonUI —
with static filters (``dropLayers`` / ``keepGroupPrefix``) that keep only the
leaves visible at rest. This script walks those prefabs straight out of the
source AssetBundles, applies the resting-frame filters offline, saves the
referenced sprite PNGs with flat basenames, and emits a single consolidated
``scene/adv/meta.json`` so the editor can fetch one file instead of four.

Self-contained: depends only on UnityPy + Pillow. Reads the bundles directly
and never touches the broader ``ui/`` extraction tree.

Output layout::

    scene/adv/
      meta.json
      <sprite>.png   # 9 unique basenames, deduplicated across atlases

``meta.json`` schema::

    {
      "canvas_size": [W, H],
      "prefabs": [
        {
          "name":         "NormalPrinter",
          "toggle":       null,                    # null = always-on
          "items_toggle": { "<group_prefix>": "<runtime_flag_name>" },
          "layers":       [{ ..., "file": "<basename>.png" }, ...],
          "texts":        [{ ... }, ...]
        },
        { "name": "AutoToggle",        "toggle": "showAutoToggle", ... },
        { "name": "ControlPanel",      "toggle": "showMenuButton", ... },
        { "name": "WitchBookButtonUI", "toggle": "showBookButton", ... }
      ]
    }

The ``toggle`` / ``items_toggle`` keys hold runtime-flag names that scene.js
maps to its live ``show*`` state. Renaming a flag in scene.js without
updating this script (or vice versa) will break rendering — scene.js
asserts every key resolves at load time.

Re-runnable: rewrites ``meta.json`` + the sprite PNGs in place, and prunes
any stale PNGs left from a previous run.

Usage::

    python3 scripts/extract_scene_adv.py <out_root> <bundle> [<bundle> ...]

Bundles auto-classify (any bundle containing ``SpriteAtlas`` becomes a
sprite source; the rest are prefab sources). For the four target prefabs
you need three bundles, in any order::

    python3 scripts/extract_scene_adv.py scene/adv \\
      <…>/general-sprites_assets_all.bundle \\
      <…>/naninovel-textprinters_assets_all.bundle \\
      <…>/naninovel-ui_assets_all.bundle
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import UnityPy
from PIL import Image as PILImage


DEFAULT_CANVAS = (2560, 1440)
UNPACKED_BUCKET = "__unpacked__"

# TextMeshPro enum mappings (TMP_Text source).
TMP_H_ALIGN = {1: "Left", 2: "Center", 4: "Right", 8: "Justified",
               16: "Flush", 32: "Geometry"}
TMP_V_ALIGN = {256: "Top", 512: "Middle", 1024: "Bottom",
               2048: "Baseline", 4096: "Geometry", 8192: "Capline"}
TMP_WRAP    = {0: "NoWrap", 1: "Normal",
               2: "PreserveWhitespace", 3: "PreserveWhitespaceNoWrap"}
TMP_OVERFLOW = {0: "Overflow", 1: "Ellipsis", 2: "Masking", 3: "Truncate",
                4: "ScrollRect", 5: "Page", 6: "Linked"}
# FontStyles is a bitmask flag enum.
TMP_FONT_STYLE_FLAGS = [
    (1,   "Bold"),       (2,   "Italic"),    (4,   "Underline"),
    (8,   "LowerCase"),  (16,  "UpperCase"), (32,  "SmallCaps"),
    (64,  "Strikethrough"), (128, "Superscript"), (256, "Subscript"),
    (512, "Highlight"),
]


# Per-prefab static filters. Mirrors scene.js's ADV_SCENE_PREFABS exactly.
# Re-creating them here (rather than reading from scene.js) keeps the bake
# step language-pure; the two sources stay tiny enough to keep in sync.
PREFABS: list[dict] = [
    {
        "name": "NormalPrinter",
        "drop_layers": {"Icon_Arrow_Double"},
        "toggle": None,
        "items_toggle": {"Wrapper/AuthorPanel": "showAuthorPlate"},
    },
    {
        "name": "AutoToggle",
        "keep_group_prefix": "Wrapper/AutoToggle/Off",
        "toggle": "showAutoToggle",
    },
    {
        "name": "ControlPanel",
        "keep_group_prefix": "Wrapper/OpenButton",
        "toggle": "showMenuButton",
    },
    {
        "name": "WitchBookButtonUI",
        "toggle": "showBookButton",
    },
]


# --- typetree helpers ------------------------------------------------------

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


def _decode_font_style(v: int) -> str:
    """TMP FontStyles is a bitmask. 0 = Normal; otherwise '|'-joined flag names."""
    if not v:
        return "Normal"
    parts = [name for bit, name in TMP_FONT_STYLE_FLAGS if v & bit]
    return "|".join(parts) if parts else f"Unknown({v})"


def _read_text(t: dict) -> dict:
    """Extract a TextMeshProUGUI MonoBehaviour into a normalized dict.
    Decodes TMP enums to short strings; omits default-valued optional fields
    (color when white, spacing when zero, auto_size when disabled, ruby when
    absent) so the JSON stays compact for the common case."""
    margin = t.get("m_margin") or {}
    margin_lt = [
        float(margin.get("x", 0)),
        float(margin.get("y", 0)),
        float(margin.get("z", 0)),
        float(margin.get("w", 0)),
    ]
    color = _rgba(t.get("m_fontColor"))
    h_align = int(t.get("m_HorizontalAlignment", 0))
    v_align = int(t.get("m_VerticalAlignment",   0))
    wrap    = int(t.get("m_TextWrappingMode",    0))
    over    = int(t.get("m_overflowMode",        0))
    rec: dict = {
        "text":             t.get("m_text", "") or "",
        "font_asset_pptr":  list(_pptr(t.get("m_fontAsset"))),
        "font_size":        float(t.get("m_fontSize", 0)),
        "font_weight":      int(t.get("m_fontWeight", 400)),
        "font_style":       _decode_font_style(int(t.get("m_fontStyle", 0))),
        "h_align":          TMP_H_ALIGN.get(h_align,  str(h_align)),
        "v_align":          TMP_V_ALIGN.get(v_align,  str(v_align)),
        "margin":           margin_lt,
        "wrapping":         TMP_WRAP.get(wrap, str(wrap)),
        "overflow":         TMP_OVERFLOW.get(over, str(over)),
    }
    if color != [1.0, 1.0, 1.0, 1.0]:
        rec["color"] = color
    spacing = {
        "character": float(t.get("m_characterSpacing", 0)),
        "word":      float(t.get("m_wordSpacing",      0)),
        "line":      float(t.get("m_lineSpacing",      0)),
        "paragraph": float(t.get("m_paragraphSpacing", 0)),
    }
    if any(v != 0 for v in spacing.values()):
        rec["spacing"] = spacing
    if t.get("m_enableAutoSizing"):
        rec["auto_size"] = {
            "min": float(t.get("m_fontSizeMin", 0)),
            "max": float(t.get("m_fontSizeMax", 0)),
        }
    # Naninovel RubyTextPrinter extends TMP with these fields.
    rvo = t.get("rubyVerticalOffset")
    rss = t.get("rubySizeScale")
    rlh = t.get("addRubyLineHeight")
    if rvo is not None or rss is not None or rlh is not None:
        ruby = {}
        if rvo is not None: ruby["vertical_offset"] = rvo
        if rss is not None: ruby["size_scale"]      = float(rss)
        if rlh is not None: ruby["add_line_height"] = bool(rlh)
        if ruby:
            rec["ruby"] = ruby
    return rec


# --- sprite source ---------------------------------------------------------

def _padded_sprite_image(sp):
    """Return sp.image padded back to m_Rect dimensions when the sprite was
    atlas-trimmed (textureRect smaller than m_Rect). Unity packs sprites into
    SpriteAtlas pages with transparent margins stripped; UnityPy's `sp.image`
    returns the cropped region. Image components in prefabs reference the
    sprite by its full m_Rect, so a compositor needs the padded version to
    keep the visible content at its authored position within the rect."""
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
    """Returns (atlas_of_sprite, sprite_obj_by_pid). Walks every SpriteAtlas
    in env to learn which atlas owns each Sprite; collects all Sprite objects
    by path_id for later reading."""
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


# --- prefab walker ---------------------------------------------------------
# Trimmed for this script's needs: handles Image leaves and TMP texts only.
# CanvasGroup-alpha gating is preserved (e.g. NormalPrinter's hidden Stream
# template). LayoutGroup / ContentSizeFitter / placement resolution from the
# upstream walker are dropped because the four target prefabs render statically.

def _walk_prefab_bundle(env, source_name: str,
                        sprite_obj_by_pid: dict[int, object],
                        atlas_of_sprite: dict[int, str],
                        canvas_size: tuple[int, int],
                        sprites_used: dict[int, dict]) -> list[dict]:
    """Walk every root prefab in env. Returns prefab records:
        { "name", "source", "canvas_size", "layers": [...], "texts": [...] }
    Side effect: records every referenced sprite into ``sprites_used``
    (path_id -> {atlas, name, file, size, pivot, sprite_obj})."""
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
    text_data:  dict[int, dict] = {}
    canvas_group_alpha: dict[int, float] = {}
    material_name: dict[int, str] = {}
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
                if "m_Sprite" in t and "m_Color" in t and go_id not in image_data:
                    image_data[go_id] = {
                        "sprite_pptr":   _pptr(t.get("m_Sprite")),
                        "color":         _rgba(t.get("m_Color")),
                        "material_pptr": _pptr(t.get("m_Material")),
                    }
                if "m_text" in t and "m_fontAsset" in t and go_id not in text_data:
                    text_data[go_id] = _read_text(t)

    roots = [tid for tid, info in trs.items() if info["parent_id"] == 0 and info["is_rect"]]
    roots.sort(key=lambda tid: go_data.get(trs[tid]["go_id"], {}).get("name", ""))

    prefabs: list[dict] = []
    for root_tid in roots:
        record = _walk_one_prefab(root_tid, trs, go_data, image_data, text_data,
                                  canvas_group_alpha,
                                  sprite_obj_by_pid, atlas_of_sprite, material_name,
                                  source_name, canvas_size, sprites_used)
        if record:
            prefabs.append(record)
    return prefabs


def _walk_one_prefab(root_tid, trs, go_data, image_data, text_data, canvas_group_alpha,
                     sprite_obj_by_pid, atlas_of_sprite, material_name,
                     source_name, canvas_size, sprites_used) -> dict | None:
    canvas_w, canvas_h = canvas_size
    root_info = trs[root_tid]
    prefab_name = go_data.get(root_info["go_id"], {}).get("name", f"root_{root_tid}")

    # Screen prefabs (root size_delta = 0) fill the canvas; widget prefabs
    # (non-zero size_delta) layer against their own intrinsic frame. The
    # four target prefabs are all screen-level, but we keep the distinction
    # for robustness if the input set ever expands.
    root_sd = root_info["rect"]["size_delta"]
    is_widget = root_sd[0] > 0 or root_sd[1] > 0
    frame_w = float(root_sd[0]) if is_widget else float(canvas_w)
    frame_h = float(root_sd[1]) if is_widget else float(canvas_h)

    layers: list[dict] = []
    texts:  list[dict] = []
    order_counter = [0]

    def visit(tid: int, parent_rect, group_path: list[str], is_root: bool) -> None:
        info = trs[tid]
        go_id = info["go_id"]
        gd = go_data.get(go_id, {"name": "?"})
        if canvas_group_alpha.get(go_id, 1.0) == 0:
            return
        rect = parent_rect if is_root else _child_rect(parent_rect, info["rect"])
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
        txt = text_data.get(go_id)
        if txt is not None:
            l, b, w, h = rect
            text_record: dict = {
                "go":    gd["name"],
                "group": "/".join(group_path),
                "order": order_counter[0],
                "pos":   [int(round(l)), int(round(frame_h - (b + h)))],
                "size":  [int(round(w)), int(round(h))],
                "pivot": info["rect"]["pivot"],
                **txt,
            }
            texts.append(text_record)
            order_counter[0] += 1
        new_group = group_path + ([gd["name"]] if not is_root else [])
        for k in info["kids"]:
            if k in trs:
                visit(k, rect, new_group, is_root=False)

    root_rect = (0.0, 0.0, frame_w, frame_h)
    visit(root_tid, root_rect, [], is_root=True)

    if not layers and not texts:
        return None
    record: dict = {
        "canvas_size": [int(round(frame_w)), int(round(frame_h))],
        "name":   prefab_name,
        "source": source_name,
        "layers": layers,
    }
    if texts:
        record["texts"] = texts
    return record


# --- filtering -------------------------------------------------------------

def _keep(item: dict, cfg: dict) -> bool:
    if item.get("name") in cfg.get("drop_layers", set()):
        return False
    prefix = cfg.get("keep_group_prefix")
    if prefix and not (item.get("group") or "").startswith(prefix):
        return False
    return True


def _filter_layers(layers: list[dict], cfg: dict) -> list[dict]:
    out: list[dict] = []
    for layer in layers:
        if not _keep(layer, cfg):
            continue
        size = layer.get("size", [0, 0])
        if size[0] <= 0 or size[1] <= 0:
            continue
        out.append(layer)
    return out


def _filter_texts(texts: list[dict], cfg: dict) -> list[dict]:
    return [t for t in texts if _keep(t, cfg)]


def _classify_bundles(paths: list[Path]) \
        -> tuple[list[tuple[Path, object]], list[tuple[Path, object]]]:
    """Split bundles into (sprite-source, prefab-source) by content. Any bundle
    with at least one SpriteAtlas object is a sprite source; the rest carry
    prefabs."""
    sprite_envs: list[tuple[Path, object]] = []
    prefab_envs: list[tuple[Path, object]] = []
    for bp in paths:
        env = UnityPy.load(str(bp))
        if any(o.type.name == "SpriteAtlas" for o in env.objects):
            sprite_envs.append((bp, env))
        else:
            prefab_envs.append((bp, env))
    return sprite_envs, prefab_envs


# --- top-level build -------------------------------------------------------

def build(out_root: Path, bundle_paths: list[Path]) -> dict:
    """Walk the bundles, filter to the four target prefabs, save sprites,
    and return the consolidated meta dict (caller writes meta.json)."""
    out_root.mkdir(parents=True, exist_ok=True)

    sprite_envs, prefab_envs = _classify_bundles(bundle_paths)
    if not sprite_envs:
        raise SystemExit(
            "no SpriteAtlas-bearing bundle in inputs (need general-sprites)"
        )
    if not prefab_envs:
        raise SystemExit("no prefab bundle in inputs")

    atlas_of_sprite: dict[int, str] = {}
    sprite_obj_by_pid: dict[int, object] = {}
    for _, env in sprite_envs:
        a, s = _build_sprite_index(env)
        atlas_of_sprite.update(a)
        sprite_obj_by_pid.update(s)

    all_prefabs: list[dict] = []
    sprites_used: dict[int, dict] = {}
    for bp, env in prefab_envs:
        prefabs = _walk_prefab_bundle(
            env, bp.name, sprite_obj_by_pid, atlas_of_sprite,
            DEFAULT_CANVAS, sprites_used,
        )
        all_prefabs.extend(prefabs)

    found_by_name: dict[str, dict] = {p["name"]: p for p in all_prefabs}
    missing = [cfg["name"] for cfg in PREFABS if cfg["name"] not in found_by_name]
    if missing:
        raise SystemExit(
            f"missing prefabs in supplied bundles: {', '.join(missing)}"
        )

    # (atlas, basename) -> sprite path_id, so we can flatten "<atlas>/x.png"
    # to "x.png" while still detecting cross-atlas basename collisions.
    pid_by_atlas_file: dict[tuple[str, str], int] = {
        (m["atlas"], m["file"]): pid for pid, m in sprites_used.items()
    }

    canvas_size: list[int] | None = None
    prefab_records: list[dict] = []
    needed_pids: dict[str, int] = {}     # basename -> path_id

    for cfg in PREFABS:
        name = cfg["name"]
        data = found_by_name[name]

        if canvas_size is None:
            canvas_size = data["canvas_size"]
        elif data["canvas_size"] != canvas_size:
            raise SystemExit(
                f"{name}: canvas_size {data['canvas_size']} disagrees with "
                f"first prefab's {canvas_size}"
            )

        layers = _filter_layers(data.get("layers", []), cfg)
        texts = _filter_texts(data.get("texts", []), cfg)

        rewritten_layers: list[dict] = []
        for layer in layers:
            basename = Path(layer["file"]).name
            pid = pid_by_atlas_file.get((layer["atlas"], basename))
            if pid is None:
                raise SystemExit(
                    f"{name}: cannot resolve sprite for layer "
                    f"{layer['name']} (atlas={layer['atlas']}, file={basename})"
                )
            existing = needed_pids.get(basename)
            if existing is not None and existing != pid:
                raise SystemExit(
                    f"basename collision: {basename} maps to two sprite "
                    f"path_ids ({existing}, {pid}); flat layout assumes "
                    f"unique names"
                )
            needed_pids[basename] = pid
            rewritten = dict(layer)
            rewritten["file"] = basename
            rewritten_layers.append(rewritten)

        record: dict = {
            "name": name,
            "toggle": cfg.get("toggle"),
        }
        if cfg.get("items_toggle"):
            record["items_toggle"] = dict(cfg["items_toggle"])
        record["layers"] = rewritten_layers
        if texts:
            record["texts"] = texts
        prefab_records.append(record)

    # Save sprite PNGs flat. Sorted order = deterministic re-runs.
    for basename in sorted(needed_pids):
        pid = needed_pids[basename]
        sp_obj = sprites_used[pid]["sprite_obj"]
        _padded_sprite_image(sp_obj.read()).save(out_root / basename)

    # Drop any stale PNGs from earlier runs that aren't in the new set.
    keep = set(needed_pids) | {"meta.json"}
    for png in out_root.glob("*.png"):
        if png.name not in keep:
            png.unlink()

    return {"canvas_size": canvas_size, "prefabs": prefab_records}


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    out_root = Path(args[0])
    bundle_paths = [Path(p) for p in args[1:]]

    meta = build(out_root, bundle_paths)
    out_meta = out_root / "meta.json"
    out_meta.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

    n_prefabs = len(meta["prefabs"])
    n_layers = sum(len(p["layers"]) for p in meta["prefabs"])
    n_texts = sum(len(p.get("texts", [])) for p in meta["prefabs"])
    n_sprites = sum(1 for _ in out_root.glob("*.png"))
    print(
        f"# wrote {out_meta}  "
        f"({n_prefabs} prefabs, {n_layers} layers, {n_texts} texts, "
        f"{n_sprites} sprites)"
    )
