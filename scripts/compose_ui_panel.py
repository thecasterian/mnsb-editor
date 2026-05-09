#!/usr/bin/env python3
"""Reference compositor: render a panel + a list of widget instances.

Inputs:
  panel_name           — e.g. "TrialChoicePanel_Hiro"
  widget_names         — list of e.g. ["ChoiceButton_Trial_MagicMargo", ...]
  background (optional) — a scene/backgrounds/main/*.png path
  out_path             — where to save the composite

Pipeline:
  1. (optional) cover-fit background onto a 2560x1440 canvas.
  2. Render panel's static layers (TrialChoiceBase, ChoicePortrait_*, ...).
  3. For each `containers[i]` with a `placement`, walk widget_names through
     the placement formula to compute each widget's PIL top-left on the panel
     canvas. The widget's intrinsic frame size comes from its own canvas_size.
  4. For each widget, render its layers onto the panel canvas, translated by
     the placement-determined offset.

Linear-space alpha compositing throughout (Unity Linear color space convention).
"""
from __future__ import annotations
import json, os, re, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

UI_ROOT = Path("ui")
CANVAS_W, CANVAS_H = 2560, 1440


# --- linear-space alpha compositing ---------------------------------------

def srgb_to_linear(x):
    a = 0.055
    return np.where(x <= 0.04045, x / 12.92, ((x + a) / (1 + a)) ** 2.4)

def linear_to_srgb(x):
    a = 0.055
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, (1 + a) * (x ** (1 / 2.4)) - a)

def load_linear(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    return a

def save_srgb(arr: np.ndarray, path: Path) -> None:
    out = arr.copy()
    out[..., :3] = linear_to_srgb(out[..., :3])
    out = np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out, mode="RGBA").save(path)

def composite(dst: np.ndarray, src: np.ndarray, xy: tuple[int, int]) -> None:
    """Linear-space alpha-composite src onto dst at PIL (x, y), with clipping."""
    dx, dy = xy
    sh, sw = src.shape[:2]
    dh, dw = dst.shape[:2]
    x0, y0 = max(0, dx), max(0, dy)
    x1, y1 = min(dw, dx + sw), min(dh, dy + sh)
    if x1 <= x0 or y1 <= y0:
        return
    s = src[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    d = dst[y0:y1, x0:x1]
    sa = s[..., 3:4]
    d[..., :3] = s[..., :3] * sa + d[..., :3] * (1 - sa)
    d[..., 3:4] = sa + d[..., 3:4] * (1 - sa)


def fit_cover(arr: np.ndarray, target_w: int, target_h: int) -> np.ndarray:
    rgb  = linear_to_srgb(arr[..., :3])
    rgba = np.clip(np.dstack([rgb, arr[..., 3:4]]) * 255 + 0.5, 0, 255).astype(np.uint8)
    img = Image.fromarray(rgba, mode="RGBA")
    iw, ih = img.size
    s = max(target_w / iw, target_h / ih)
    img = img.resize((int(round(iw * s)), int(round(ih * s))), Image.LANCZOS)
    nw, nh = img.size
    left, top = (nw - target_w) // 2, (nh - target_h) // 2
    img = img.crop((left, top, left + target_w, top + target_h))
    a = np.asarray(img, dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    return a


# --- prefab + layer rendering ---------------------------------------------

_SPRITE_CACHE: dict[str, np.ndarray] = {}
_RESIZE_CACHE: dict[tuple[str, int, int], np.ndarray] = {}

def load_sprite(rel_path: str) -> np.ndarray:
    if rel_path not in _SPRITE_CACHE:
        _SPRITE_CACHE[rel_path] = load_linear(UI_ROOT / rel_path)
    return _SPRITE_CACHE[rel_path]


def sprite_at_size(rel_path: str, target_w: int, target_h: int) -> np.ndarray:
    """Return the sprite stretched to (target_w, target_h). Unity's Image
    component with m_Type=Simple stretches the sprite to fill its rect; our
    layer's `size` is the resolved RectTransform rect size on canvas. Sprites
    are usually authored smaller than their UI rect (e.g. ChoicePortrait_Hiro
    is 791x1440 but renders into a 1090x1440 rect)."""
    base = load_sprite(rel_path)
    bh, bw = base.shape[:2]
    if bw == target_w and bh == target_h:
        return base
    key = (rel_path, target_w, target_h)
    if key in _RESIZE_CACHE:
        return _RESIZE_CACHE[key]
    # Roundtrip through sRGB bytes so PIL's LANCZOS does the resample.
    # Gamma-aware resize would be pure-linear, but the visual delta on
    # near-uniform UI sprites is negligible and not the bug we're fixing.
    rgb  = linear_to_srgb(base[..., :3])
    rgba = np.clip(np.dstack([rgb, base[..., 3:4]]) * 255 + 0.5, 0, 255).astype(np.uint8)
    img  = Image.fromarray(rgba, mode="RGBA").resize((target_w, target_h), Image.LANCZOS)
    a = np.asarray(img, dtype=np.float32) / 255.0
    a[..., :3] = srgb_to_linear(a[..., :3])
    _RESIZE_CACHE[key] = a
    return a


def _render_one_layer(layer: dict, canvas: np.ndarray,
                      offset_xy: tuple[int, int]) -> None:
    tw, th = layer["size"]
    if tw <= 0 or th <= 0:
        return
    sprite = sprite_at_size(layer["file"], tw, th)
    color = layer.get("color")
    if color and color != [1, 1, 1, 1]:
        sprite = sprite.copy()
        sprite[..., :3] *= np.array(color[:3], dtype=np.float32)
        sprite[..., 3]  *= color[3]
    x = offset_xy[0] + layer["pos"][0]
    y = offset_xy[1] + layer["pos"][1]
    composite(canvas, sprite, (x, y))


# --- text rendering -------------------------------------------------------
#
# Game fonts (per build):
#   Korean build  → Noto Serif KR.
#   Japanese build → Tsukushi Mincho (commercial Fontworks; rarely installed).
# Both locales use serif/Mincho-style faces, consistent with the game's tone.
#
# We don't have the actual TMP font asset, so the compositor substitutes from
# system Noto CJK collections (both serif):
#   ko → Noto Serif CJK KR (TTC face 1 in NotoSerifCJK-{Weight}.ttc) — same family the game ships.
#   ja → Noto Serif CJK JP (TTC face 0 in NotoSerifCJK-{Weight}.ttc) — closest open Mincho stand-in for Tsukushi Mincho.
# DejaVu Sans is the final fallback when Noto CJK isn't installed.
#
# Override locale via env var: `MANOSABA_LOCALE=ja python3 ...`. Glyph metrics
# may still differ slightly from the in-game font (especially Japanese, where
# Tsukushi vs Noto Serif have different widths), but positions of the rect
# anchor point are exact.

LOCALE = os.environ.get("MANOSABA_LOCALE", "ko").lower()

_FONT_CACHE: dict[tuple[int, bool, bool, str], ImageFont.FreeTypeFont] = {}

# Per-locale candidate fonts: list of (path, ttc_face_index | None) per
# (bold, italic) combo. Italic keys exist only for the DejaVu fallback —
# Noto CJK has no italic face, so italic-on-CJK degrades to regular CJK.
_FONT_CANDIDATES: dict[str, dict[tuple[bool, bool], list[tuple[str, int | None]]]] = {
    "ko": {
        (False, False): [
            ("/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc", 1),
            ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 1),
        ],
        (True, False): [
            ("/usr/share/fonts/noto-cjk/NotoSerifCJK-Bold.ttc", 1),
            ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", 1),
        ],
    },
    "ja": {
        (False, False): [
            ("/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc", 0),
            ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 0),
        ],
        (True, False): [
            ("/usr/share/fonts/noto-cjk/NotoSerifCJK-Bold.ttc", 0),
            ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", 0),
        ],
    },
}

_FONT_FALLBACKS: dict[tuple[bool, bool], list[tuple[str, int | None]]] = {
    (False, False): [("/usr/share/fonts/TTF/DejaVuSans.ttf",            None),
                     ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", None)],
    (True,  False): [("/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",            None),
                     ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", None)],
    (False, True ): [("/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf",            None),
                     ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", None)],
    (True,  True ): [("/usr/share/fonts/TTF/DejaVuSans-BoldOblique.ttf",            None),
                     ("/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf", None)],
}


def _try_load(path: str, idx: int | None, size: int) -> ImageFont.FreeTypeFont | None:
    if not os.path.exists(path):
        return None
    try:
        return ImageFont.truetype(path, size, index=idx) if idx is not None \
               else ImageFont.truetype(path, size)
    except Exception:
        return None


# (path, ttc_index_or_None) -> sTypoAscender / unitsPerEm, used to scale the
# typographic ascender to any font size for TMP-style "Capline" alignment.
# PIL's `font.getmetrics()` returns `hhea.ascender` (≈ `usWinAscent` for Noto
# CJK), which includes line-leading reserved for Latin diacritics — ~30 px
# too tall at size 136 for CJK glyphs. `OS/2.sTypoAscender` is the design-time
# ascender used by TMP for cap-line alignment; it sits between PIL's ascent
# and the visible glyph bbox top.
_FONT_TYPOASC_PER_EM: dict[tuple[str, int | None], float] = {}


def _typo_ascender_per_em(path: str | None, idx: int | None) -> float:
    """Return `OS/2.sTypoAscender / unitsPerEm` for the font, or a reasonable
    default if the file can't be read. Cached per (path, ttc_index)."""
    if path is None:
        return 0.85
    key = (path, idx)
    if key in _FONT_TYPOASC_PER_EM:
        return _FONT_TYPOASC_PER_EM[key]
    ratio = 0.85
    try:
        if path.lower().endswith(".ttc"):
            from fontTools.ttLib import TTCollection
            ft = TTCollection(path).fonts[idx or 0]
        else:
            from fontTools.ttLib import TTFont
            ft = TTFont(path, fontNumber=idx or 0)
        ratio = ft["OS/2"].sTypoAscender / ft["head"].unitsPerEm
    except Exception:
        pass
    _FONT_TYPOASC_PER_EM[key] = ratio
    return ratio


def get_font(size: int, bold: bool = False, italic: bool = False,
             locale: str | None = None) -> ImageFont.FreeTypeFont:
    """Resolve a font for (locale, bold, italic) at `size` px. Loads each
    candidate in priority order; CJK fonts are TTCs with locale-specific
    faces. Falls back to regular weight if the bold variant is missing, then
    to DejaVu Sans, then to PIL's bundled bitmap font as a last resort."""
    if locale is None:
        locale = LOCALE
    key = (size, bold, italic, locale)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]

    # Try requested style with locale-specific candidates, then degrade:
    # (bold, italic) -> (bold, False) -> (False, False), then DejaVu fallbacks.
    style_chain: list[tuple[bool, bool]] = []
    if italic:
        style_chain.append((bold, italic))
    style_chain.append((bold, False))
    if bold:
        style_chain.append((False, False))

    locale_table = _FONT_CANDIDATES.get(locale, {})
    for style in style_chain:
        for path, idx in locale_table.get(style, []):
            f = _try_load(path, idx, size)
            if f is not None:
                _FONT_CACHE[key] = f
                return f
    for style in style_chain:
        for path, idx in _FONT_FALLBACKS.get(style, []):
            f = _try_load(path, idx, size)
            if f is not None:
                _FONT_CACHE[key] = f
                return f
    _FONT_CACHE[key] = ImageFont.load_default()
    return _FONT_CACHE[key]


# TMP horizontal alignment -> (PIL anchor x-char, intra-rect x-fraction, multiline align).
_H_ANCHOR = {
    "Left":      ("l", 0.0, "left"),
    "Center":    ("m", 0.5, "center"),
    "Right":     ("r", 1.0, "right"),
    "Justified": ("l", 0.0, "left"),
    "Flush":     ("l", 0.0, "left"),
    "Geometry":  ("m", 0.5, "center"),
}
# TMP vertical alignment -> (PIL anchor y-char, intra-rect y-fraction).
# 'a' = ascender top, 'm' = middle, 's' = baseline, 'd' = descender bottom.
# Capline has no exact PIL equivalent; ascender top is the closest visual match.
_V_ANCHOR = {
    "Top":      ("a", 0.0),
    "Middle":   ("m", 0.5),
    "Bottom":   ("d", 1.0),
    "Baseline": ("s", 1.0),
    "Geometry": ("m", 0.5),
    "Capline":  ("a", 0.0),
}


# --- TMP rich-text rendering (for AuthorLabel) ----------------------------

# Author rich-text from the AuthorData ManagedTextRecord uses these tags:
#   <color=#RRGGBBAA> ... </color>
#   <color=%COLOR%>   ... </color>     (placeholder; caller substitutes)
#   <size=N>          ... </size>      (pixel-absolute)
#   <voffset=N>       ... </voffset>   (pixel-absolute; positive=up)
#   <space=N>                          (one-shot horizontal advance)
#   <cspace=N>        ... </cspace>    (character spacing)
# All four "open" tags use stack semantics — `</tag>` pops to whatever was
# below, not back to the base value. That's how the prefabs achieve "first
# kanji in character color, the rest fall back to default white".

_TAG_RE = re.compile(r"<(/?)(color|size|voffset|space|cspace)(?:=([^>]+))?>")


def _parse_color_token(s: str) -> tuple[float, float, float, float] | None:
    """Parse `#RRGGBB` or `#RRGGBBAA`. Returns RGBA in [0, 1] or None."""
    if not s.startswith("#"):
        return None
    h = s[1:]
    if len(h) == 6:
        h += "FF"
    if len(h) != 8:
        return None
    try:
        return tuple(int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4, 6))  # type: ignore
    except ValueError:
        return None


def _tokenize_rich(text: str) -> list:
    """Split TMP rich-text into [(kind, value)] tokens. kind is 'open_<tag>',
    'close_<tag>', 'space', or 'glyph' (single Unicode code point)."""
    out = []
    i = 0
    for m in _TAG_RE.finditer(text):
        # Emit literal glyphs between tags.
        for ch in text[i:m.start()]:
            out.append(("glyph", ch))
        slash, name, val = m.groups()
        if slash:
            out.append((f"close_{name}", None))
        elif name == "space":
            out.append(("space", float(val) if val else 0.0))
        else:
            out.append((f"open_{name}", val))
        i = m.end()
    for ch in text[i:]:
        out.append(("glyph", ch))
    return out


def _render_tagged_text(text_rec: dict, canvas: np.ndarray,
                        offset_xy: tuple[int, int],
                        tagged: str, base_color_hex: str | None,
                        locale_for_font: str | None = None) -> None:
    """Render a TMP rich-text string for an AuthorLabel-like text leaf.
    Honours <color>/<size>/<voffset>/<space>/<cspace> with stack semantics.
    The caller pre-resolves `%COLOR%` (substituted with the per-character
    `nameColor_hex`) before calling.

    Layout: glyphs flow left-to-right from the rect's left edge; cursor x
    advances by glyph width + cspace; <space=N> adds N pixels (signed).
    Vertical anchor follows the text's `v_align` (Top / Middle / Capline /
    etc.), measured against the rect height of the *base* font size.
    """
    pos = text_rec["pos"]
    sz  = text_rec["size"]
    margin = text_rec.get("margin", [0, 0, 0, 0])
    base_size = max(1, int(round(text_rec["font_size"])))
    base_color = text_rec.get("color", [1.0, 1.0, 1.0, 1.0])
    style = text_rec.get("font_style", "Normal")
    weight = int(text_rec.get("font_weight", 400))
    bold = ("Bold" in style) or weight >= 600

    # Substitute %COLOR% before tokenizing.
    if "%COLOR%" in tagged:
        if base_color_hex is None:
            base_color_hex = "#FFFFFF"
        tagged = tagged.replace("%COLOR%", base_color_hex)

    rx = offset_xy[0] + pos[0] + margin[0]
    ry = offset_xy[1] + pos[1] + margin[1]
    rw = max(0, sz[0] - margin[0] - margin[2])
    rh = max(0, sz[1] - margin[1] - margin[3])

    tokens = _tokenize_rich(tagged)

    # Stacks for each scoped tag. Base values sit at the bottom and are never
    # popped (closing more tags than were opened is a no-op).
    color_stack:   list[tuple[float, float, float, float]] = [tuple(base_color)]
    size_stack:    list[int]   = [base_size]
    voffset_stack: list[float] = [0.0]
    cspace_stack:  list[float] = [0.0]

    # Pass 1: walk tokens to build a glyph list and measure x-extent +
    # actual cap-top / descent extents. Each glyph's *visible* bbox above the
    # baseline is queried via font.getbbox(ch, anchor='ls') — this is what TMP
    # uses for Capline-style alignment (vs PIL's `font.getmetrics()` ascent,
    # which includes empty space reserved for Latin diacritics that CJK
    # glyphs don't use). For Noto Serif CJK at size 136 the typographic
    # ascent is 157 but the actual `桜` cap sits 115 px above baseline — the
    # 42 px gap is exactly the "shifted down" effect we'd see otherwise.
    glyphs: list[dict] = []
    cursor_x = 0.0
    cap_top  = 0    # max actual glyph-top above baseline (positive px)
    glyph_bot = 0   # max actual glyph-bottom below baseline (positive px)
    typo_asc = 0    # max typographic ascent (for non-Capline alignments)
    typo_desc = 0   # max typographic descent
    for kind, val in tokens:
        if kind == "open_color":
            c = _parse_color_token(val) if val else None
            color_stack.append(c if c is not None else color_stack[-1])
        elif kind == "close_color":
            if len(color_stack) > 1: color_stack.pop()
        elif kind == "open_size":
            try:
                size_stack.append(max(1, int(round(float(val)))))
            except (TypeError, ValueError):
                size_stack.append(size_stack[-1])
        elif kind == "close_size":
            if len(size_stack) > 1: size_stack.pop()
        elif kind == "open_voffset":
            try:
                voffset_stack.append(float(val))
            except (TypeError, ValueError):
                voffset_stack.append(voffset_stack[-1])
        elif kind == "close_voffset":
            if len(voffset_stack) > 1: voffset_stack.pop()
        elif kind == "open_cspace":
            try:
                cspace_stack.append(float(val))
            except (TypeError, ValueError):
                cspace_stack.append(cspace_stack[-1])
        elif kind == "close_cspace":
            if len(cspace_stack) > 1: cspace_stack.pop()
        elif kind == "space":
            cursor_x += float(val)
        elif kind == "glyph":
            sz_now      = size_stack[-1]
            color_now   = color_stack[-1]
            voff_now    = voffset_stack[-1]
            cspace_now  = cspace_stack[-1]
            font = get_font(sz_now, bold=bold, italic=False, locale=locale_for_font)
            asc, desc = font.getmetrics()
            # Per-glyph visible bbox above/below baseline (anchor 'ls').
            try:
                gbbox = font.getbbox(val, anchor="ls")
                g_top_above = -gbbox[1]
                g_bot_below = gbbox[3]
            except (TypeError, ValueError):
                g_top_above, g_bot_below = asc, desc
            # Capline alignment reference. TMP positions the TMP_FontAsset's
            # `m_FaceInfo.capLine` at the rect top, but that asset is generated
            # at import time and isn't shipped in any AssetBundle we have. The
            # value sits between two metrics PIL/fontTools *can* see:
            #   sTypoAscender  ≈ 120 px (Noto Serif CJK at size 136) — too tight,
            #                    visible glyph extends right to rect.top
            #   hhea.ascender  ≈ 157 px — too loose, visible glyph drops 42 px
            #                    below rect.top because of CJK head padding
            # Empirically, mix=0.45 weighted toward sTypoAscender (so cap_top
            # ≈ 136 ≈ the font size itself for Noto Serif CJK at sz=136) puts
            # the visible cap line roughly 25 px below rect.top, matching the
            # in-game NormalPrinter author-plate render. Tune if a future game
            # build changes the TMP_FontAsset capLine setting.
            typo_per_em = _typo_ascender_per_em(
                getattr(font, "path", None), getattr(font, "index", None)
            )
            mix = 0.45
            typo_asc_px = sz_now * typo_per_em * (1 - mix) + asc * mix
            voff_up   = max(0, int(round(voff_now)))
            voff_down = max(0, int(round(-voff_now)))
            cap_top   = max(cap_top,   typo_asc_px + voff_up)
            glyph_bot = max(glyph_bot, g_bot_below + voff_down)
            typo_asc  = max(typo_asc,  asc + voff_up)
            typo_desc = max(typo_desc, desc + voff_down)
            glyph_w = font.getlength(val)
            glyphs.append({
                "ch": val, "x": cursor_x, "voff": voff_now,
                "size": sz_now, "color": color_now, "font": font,
            })
            cursor_x += glyph_w + cspace_now

    if not glyphs:
        return
    text_w = cursor_x
    visible_h = cap_top + glyph_bot

    # Place the baseline inside the rect according to TMP alignment. Capline
    # uses the actual cap-top (visible glyph top), Top/Middle/Bottom use the
    # typographic metrics so empty-space-above-glyph behaves like a normal
    # text-frame line.
    h = text_rec.get("h_align", "Left")
    v = text_rec.get("v_align", "Top")
    if h == "Center":   x_origin = rx + (rw - text_w) / 2
    elif h == "Right":  x_origin = rx + rw - text_w
    else:               x_origin = rx
    if v == "Capline":               y_baseline = ry + cap_top
    elif v == "Middle":              y_baseline = ry + rh / 2 + (typo_asc - (typo_asc + typo_desc) / 2)
    elif v in ("Bottom", "Baseline"): y_baseline = ry + rh - typo_desc
    else:                            y_baseline = ry + typo_asc  # Top / Geometry default

    # Render to a tight RGBA image, then linear-composite. The image must be
    # tall enough for the *visible* extent (cap_top + glyph_bot) plus a
    # small pad for AA edges.
    canvas_h, canvas_w = canvas.shape[:2]
    img_x0 = int(x_origin)
    img_y0 = int(y_baseline - cap_top)
    img_w  = int(text_w + 2)
    img_h  = int(visible_h + 4)
    if img_w <= 0 or img_h <= 0:
        return
    # Clip against canvas to avoid drawing entirely off-screen.
    if img_x0 + img_w <= 0 or img_y0 + img_h <= 0 or img_x0 >= canvas_w or img_y0 >= canvas_h:
        return

    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    baseline_in_img = cap_top
    for g in glyphs:
        c = g["color"]
        fill = (
            max(0, min(255, int(round(c[0] * 255)))),
            max(0, min(255, int(round(c[1] * 255)))),
            max(0, min(255, int(round(c[2] * 255)))),
            max(0, min(255, int(round(c[3] * 255)))),
        )
        gx = g["x"]
        gy = baseline_in_img - g["voff"]
        draw.text((gx, gy), g["ch"], font=g["font"], fill=fill, anchor="ls")

    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr[..., :3] = srgb_to_linear(arr[..., :3])
    composite(canvas, arr, (img_x0, img_y0))


# --- author-override config (env-driven) ----------------------------------

AUTHOR_OVERRIDE_ID = os.environ.get("MANOSABA_AUTHOR")  # e.g. "Ema"

_CHARACTER_CONFIG: dict | None = None
_CHARACTER_CONFIG_PATH = Path("characters/configuration.json")


def _character_record(char_id: str) -> dict | None:
    """Look up a character record by id from `characters/configuration.json`.
    Returns None if the file is missing or the id is unknown."""
    global _CHARACTER_CONFIG
    if _CHARACTER_CONFIG is None:
        if not _CHARACTER_CONFIG_PATH.exists():
            _CHARACTER_CONFIG = {"characters": []}
        else:
            _CHARACTER_CONFIG = json.loads(_CHARACTER_CONFIG_PATH.read_text())
    for r in _CHARACTER_CONFIG.get("characters", []):
        if r.get("id") == char_id:
            return r
    return None


def _render_one_text(text_rec: dict, canvas: np.ndarray,
                     offset_xy: tuple[int, int]) -> None:
    """Rasterize a TextMeshPro text record onto canvas in linear space.
    No word-wrapping (TMP would; PIL has no built-in word-wrap and the
    placeholder strings shipped in prefabs are short). Embedded newlines in
    the placeholder are honoured via PIL's multiline_text.

    AuthorLabel routing: when `MANOSABA_AUTHOR` env var is set and the leaf is
    an AuthorLabel-named GameObject, the placeholder text is replaced with
    `tagged_name[locale]` from `characters/configuration.json` (with `%COLOR%`
    substituted from `nameColor_hex`) and rendered via the rich-text path."""
    # AuthorLabel override: route to rich-text renderer.
    if AUTHOR_OVERRIDE_ID and text_rec.get("go") == "AuthorLabel":
        rec = _character_record(AUTHOR_OVERRIDE_ID)
        if rec is not None:
            tagged = rec.get("tagged_name", {}).get(LOCALE) or ""
            if tagged:
                _render_tagged_text(text_rec, canvas, offset_xy,
                                    tagged, rec.get("nameColor_hex"),
                                    locale_for_font=LOCALE)
                return
            # No tagged entry for this locale (e.g. en-US) — fall through to
            # plain placeholder so we still render *something*.
    s = text_rec.get("text") or ""
    if not s:
        return
    pos = text_rec["pos"]
    sz  = text_rec["size"]
    margin = text_rec.get("margin", [0, 0, 0, 0])
    color = text_rec.get("color", [1.0, 1.0, 1.0, 1.0])
    style = text_rec.get("font_style", "Normal")
    weight = int(text_rec.get("font_weight", 400))
    bold = ("Bold" in style) or weight >= 600
    italic = "Italic" in style
    font = get_font(max(1, int(round(text_rec["font_size"]))),
                    bold=bold, italic=italic)

    # Resolved rect on canvas (PIL Y-down).
    rx = offset_xy[0] + pos[0] + margin[0]
    ry = offset_xy[1] + pos[1] + margin[1]
    rw = max(0, sz[0] - margin[0] - margin[2])
    rh = max(0, sz[1] - margin[1] - margin[3])

    h = text_rec.get("h_align", "Left")
    v = text_rec.get("v_align", "Top")
    h_char, h_frac, ml_align = _H_ANCHOR.get(h, _H_ANCHOR["Left"])
    v_char, v_frac           = _V_ANCHOR.get(v, _V_ANCHOR["Top"])
    anchor = h_char + v_char

    # Anchor point in canvas coords. With rw=rh=0 (e.g. DebatePrinter labels
    # whose rect is sized at runtime), this collapses to (rx, ry) and PIL's
    # anchor handles placement around the point.
    ax = rx + rw * h_frac
    ay = ry + rh * v_frac

    # Convert sRGB color to byte tuple (PIL fills are sRGB-byte).
    fill = (
        max(0, min(255, int(round(color[0] * 255)))),
        max(0, min(255, int(round(color[1] * 255)))),
        max(0, min(255, int(round(color[2] * 255)))),
        max(0, min(255, int(round(color[3] * 255)))),
    )

    # Measure tight bbox so we don't allocate a full-canvas RGBA per glyph cluster.
    is_multi = "\n" in s
    _meas = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    if is_multi:
        bbox = _meas.multiline_textbbox((ax, ay), s, font=font, anchor=anchor,
                                        align=ml_align)
    else:
        bbox = _meas.textbbox((ax, ay), s, font=font, anchor=anchor)
    pad = 2
    canvas_h, canvas_w = canvas.shape[:2]
    bx0 = max(0, int(bbox[0]) - pad)
    by0 = max(0, int(bbox[1]) - pad)
    bx1 = min(canvas_w, int(bbox[2]) + pad)
    by1 = min(canvas_h, int(bbox[3]) + pad)
    if bx1 <= bx0 or by1 <= by0:
        return

    img = Image.new("RGBA", (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if is_multi:
        draw.multiline_text((ax - bx0, ay - by0), s, font=font, fill=fill,
                            anchor=anchor, align=ml_align)
    else:
        draw.text((ax - bx0, ay - by0), s, font=font, fill=fill, anchor=anchor)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr[..., :3] = srgb_to_linear(arr[..., :3])
    composite(canvas, arr, (bx0, by0))


# --- unified prefab renderer ----------------------------------------------

def render_prefab(prefab: dict, canvas: np.ndarray,
                  offset_xy: tuple[int, int] = (0, 0)) -> None:
    """Render prefab's layers + texts onto `canvas` at `offset_xy`, walking
    the merged sequence in shared z-order (`order` field, falling back to
    array index)."""
    layers = prefab.get("layers", [])
    texts  = prefab.get("texts", [])
    items: list[tuple[int, str, dict]] = []
    for i, l in enumerate(layers):
        items.append((int(l.get("order", i)), "layer", l))
    base = len(layers)
    for i, t in enumerate(texts):
        items.append((int(t.get("order", base + i)), "text", t))
    items.sort(key=lambda x: x[0])
    for _, kind, item in items:
        if kind == "layer":
            _render_one_layer(item, canvas, offset_xy)
        else:
            _render_one_text(item, canvas, offset_xy)


def render_prefab_layers(prefab: dict, canvas: np.ndarray,
                         offset_xy: tuple[int, int] = (0, 0)) -> None:
    """Sprite-only renderer (no text). Kept for callers that want chrome only."""
    for layer in prefab.get("layers", []):
        _render_one_layer(layer, canvas, offset_xy)


# --- layout-group placement resolution ------------------------------------

def child_position(placement: dict, child_sizes: list[tuple[int, int]],
                   k: int) -> tuple[int, int]:
    """Return PIL top-left of child k under a placement formula.

    child_sizes is the full list of (w, h) for every child being placed —
    needed because Unity's HV layout groups sum *each* child's main-axis
    size, not N copies of one size. Cross-axis (alignment) anchor uses only
    child k's own size."""
    kind = placement["kind"]
    cw, ch = child_sizes[k]

    if kind == "vertical":
        spacing = placement["spacing"]
        col_h = (sum(h for _, h in child_sizes)
                 + (len(child_sizes) - 1) * spacing
                 + placement["padding_top"]
                 + placement["padding_bottom"])
        col_top = placement["y_pivot_canvas_pil"] - col_h * placement["y_pivot_position"]
        y = (col_top + placement["padding_top"]
             + sum(child_sizes[i][1] for i in range(k))
             + k * spacing)
        anchor_x = placement["x_anchor_canvas_pil"]
        if placement["x_anchor_basis"] == "right":
            x = anchor_x - cw
        elif placement["x_anchor_basis"] == "left":
            x = anchor_x
        else:
            x = anchor_x - cw / 2
        return (int(round(x)), int(round(y)))

    if kind == "horizontal":
        spacing = placement["spacing"]
        row_w = (sum(w for w, _ in child_sizes)
                 + (len(child_sizes) - 1) * spacing
                 + placement["padding_left"]
                 + placement["padding_right"])
        row_left = placement["x_pivot_canvas_pil"] - row_w * placement["x_pivot_position"]
        x = (row_left + placement["padding_left"]
             + sum(child_sizes[i][0] for i in range(k))
             + k * spacing)
        anchor_y = placement["y_anchor_canvas_pil"]
        if placement["y_anchor_basis"] == "bottom":
            y = anchor_y - ch
        elif placement["y_anchor_basis"] == "top":
            y = anchor_y
        else:
            y = anchor_y - ch / 2
        return (int(round(x)), int(round(y)))

    if kind == "grid":
        col_count = placement["constraint_count"]
        row, col = divmod(k, col_count)
        if placement.get("start_axis") == "Vertical":
            col, row = divmod(k, col_count)
        x = placement["first_cell_canvas_pil"][0] + col * placement["step"][0]
        y = placement["first_cell_canvas_pil"][1] + row * placement["step"][1]
        return (int(round(x)), int(round(y)))

    raise ValueError(f"Unknown placement kind: {kind}")


# --- top-level compose -----------------------------------------------------

def compose_panel(panel_name: str, widget_names: list[str],
                  background_path: Path | None, out_path: Path) -> None:
    panel = json.loads((UI_ROOT / f"{panel_name}.json").read_text())
    if panel["canvas_size"] != [CANVAS_W, CANVAS_H]:
        raise ValueError(f"Expected panel canvas {CANVAS_W}x{CANVAS_H}, got {panel['canvas_size']}")

    if background_path:
        canvas = fit_cover(load_linear(background_path), CANVAS_W, CANVAS_H)
    else:
        canvas = np.zeros((CANVAS_H, CANVAS_W, 4), dtype=np.float32)
        canvas[..., 3] = 1.0  # opaque black

    # 1. Panel's static chrome (sprites + texts in shared z-order).
    print(f"# Panel '{panel['name']}': {len(panel.get('layers', []))} layers, "
          f"{len(panel.get('texts', []))} texts")
    render_prefab(panel, canvas)

    # 2. For each layout-driven container, place widget instances.
    widgets = [json.loads((UI_ROOT / f"{n}.json").read_text()) for n in widget_names]
    child_sizes = [tuple(w["canvas_size"]) for w in widgets]
    for c in panel.get("containers", []):
        placement = c.get("placement")
        if placement is None:
            continue
        print(f"# Container {c['go']}: {placement['kind']} layout, {len(widgets)} widget(s)")
        for k, (wname, widget) in enumerate(zip(widget_names, widgets)):
            xy = child_position(placement, child_sizes, k)
            print(f"  widget {k} ({wname}): {child_sizes[k][0]}x{child_sizes[k][1]} @ pil={xy}")
            render_prefab(widget, canvas, offset_xy=xy)

    save_srgb(canvas, out_path)
    print(f"\nSaved {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print('Usage: compose_panel.py <panel> "<widget1>[,widget2,...]|-" <out.png> [bg.png]')
        print('  Pass "-" or "" for the widget list to render the panel chrome only.')
        sys.exit(1)
    panel = sys.argv[1]
    widget_arg = sys.argv[2]
    widgets = [w for w in widget_arg.split(",") if w and w != "-"]
    out = Path(sys.argv[3])
    bg = Path(sys.argv[4]) if len(sys.argv) > 4 else None
    compose_panel(panel, widgets, bg, out)
