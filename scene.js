// Bump on every deploy to invalidate stale browser caches of JSON/PNG assets.
// Also bump the matching ?v= on styles.css and scene.js in scene.html.
const BUILD_VERSION = '20260506b';
const assetUrl = (path) => `${path}?v=${BUILD_VERSION}`;

const CANVAS_W = 2560;
const CANVAS_H = 1440;

// All editor assets live under scene/. Three sub-roots:
//   scene/adv/         — UI sprites + meta.json baked by build_scene_adv.py.
//                         meta.json is one consolidated layout file with the
//                         four prefabs (NormalPrinter / AutoToggle /
//                         ControlPanel / WitchBookButtonUI), pre-filtered to
//                         only leaves visible at rest. Each layer's `file`
//                         resolves to `${SCENE_ADV_ROOT}/<basename>.png`.
//   scene/backgrounds/ — main/, stills/, and meta.json (the bg picker index).
//   scene/authors.json — slim author metadata (id, nameColor_hex,
//                         tagged_name) baked from characters/configuration.json
//                         by build_scene_authors.py.
const SCENE_ROOT     = 'scene';
const SCENE_ADV_ROOT = `${SCENE_ROOT}/adv`;
const SCENE_BG_ROOT  = `${SCENE_ROOT}/backgrounds`;

// Allowlist + display order for the Author dropdown. Mirrors app.js's
// CHARACTERS array (layered main cast + Warden/Yuki) minus the Jailer*,
// Creature*, Unknown, and EmaFake entries — game-internal speakers that
// shouldn't appear as user-pickable authors. The order is explicit (rather
// than derived from characters/configuration.json's bundle order) so the
// scene editor's dropdown reads identically to the character editor's.
const AUTHOR_ORDER = [
  "Alisa", "AnAn", "Coco", "Ema", "Hanna", "Hiro",
  "Leia", "Margo", "Meruru", "Miria", "Nanoka", "Noah", "Sherry",
  "Warden", "Yuki",
];
// Initial selection on load + the fallback when populateAuthorSelect can't
// preserve the previous author across a locale flip. Matches app.js's
// DEFAULT_CHARACTER for cross-editor consistency.
const DEFAULT_AUTHOR = "Sherry";

// --- App state ---
let locale = 'ko';                  // 'ko' | 'ja'
let messageText = '';
let authorId = '';                  // resolved to the first available entry on init
let bgPath = null;                  // null = solid black
let sceneMeta = null;               // scene/adv/meta.json: { canvas_size, prefabs: [...] }
let charsConfig = null;
let bgMeta = null;
let renderSeq = 0;
// Per-overlay enable flags. Names match the strings used in scene/adv/meta.json's
// `toggle` / `items_toggle` fields — see TOGGLE_FLAGS below. NormalPrinter has
// `toggle: null` (the dialog frame is the scene's anchor; toggling it off would
// leave just background + buttons floating, which isn't useful).
let showAutoToggle = true;          // gates the AutoToggle prefab
let showMenuButton = true;          // gates the ControlPanel prefab (OpenButton group)
let showBookButton = true;          // gates the WitchBookButtonUI prefab
// Toggles NamePlateBase sprite + AuthorLabel text together (both live under
// NormalPrinter's `Wrapper/AuthorPanel` subtree). One switch covers both
// because rendering the plate without text — or text without a plate — would
// look broken; the user thinks of the plate as a single unit.
let showAuthorPlate = true;

// String → live-state lookup. The bake script writes these names into
// meta.json; this table is the single point of resolution at render time.
// Adding a new toggle = add an entry here AND in PREFABS in build_scene_adv.py.
const TOGGLE_FLAGS = {
  showAutoToggle:  () => showAutoToggle,
  showMenuButton:  () => showMenuButton,
  showBookButton:  () => showBookButton,
  showAuthorPlate: () => showAuthorPlate,
};

// --- Static data load ---

async function loadStaticData() {
  const [charRes, bgRes, sceneRes] = await Promise.all([
    fetch(assetUrl(`${SCENE_ROOT}/authors.json`)),
    fetch(assetUrl(`${SCENE_BG_ROOT}/meta.json`)),
    fetch(assetUrl(`${SCENE_ADV_ROOT}/meta.json`)),
  ]);
  charsConfig = await charRes.json();
  bgMeta      = await bgRes.json();
  sceneMeta   = await sceneRes.json();

  // Fail-loud validator: every toggle key referenced by the metadata must
  // resolve in TOGGLE_FLAGS. Catches script ↔ data drift at load time
  // instead of producing a silently-wrong render later.
  for (const p of sceneMeta.prefabs) {
    if (p.toggle && !(p.toggle in TOGGLE_FLAGS)) {
      throw new Error(`scene/adv/meta.json: unknown toggle "${p.toggle}" on prefab "${p.name}"`);
    }
    for (const flag of Object.values(p.items_toggle || {})) {
      if (!(flag in TOGGLE_FLAGS)) {
        throw new Error(`scene/adv/meta.json: unknown items_toggle "${flag}" on prefab "${p.name}"`);
      }
    }
  }
}

// --- Linear-space helpers ---
//
// Unity's UI pipeline runs in Linear color space: sRGB-tagged textures sample
// to linear, blends are linear, the framebuffer converts back to sRGB on
// present. Naïvely blending sRGB bytes (Canvas2D's source-over default) lifts
// NormalPrinter_Screen — alpha ~35% over a mid background — by ~30% darker
// than the in-game look. We do all alpha math in linear and convert once at
// the end. Standard sRGB ↔ linear curves; alpha is coverage and isn't gamma'd.

const LIN_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const A_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) A_LUT[i] = i / 255;

function linearToSrgb(c) {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function imageDataToLinear(id) {
  const px = id.data;
  const out = new Float32Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    out[i]     = LIN_LUT[px[i]];
    out[i + 1] = LIN_LUT[px[i + 1]];
    out[i + 2] = LIN_LUT[px[i + 2]];
    out[i + 3] = A_LUT  [px[i + 3]];
  }
  return out;
}

function linearToImageData(buf, w, h) {
  const out = new ImageData(w, h);
  const px = out.data;
  for (let i = 0; i < buf.length; i += 4) {
    let r = buf[i], g = buf[i + 1], b = buf[i + 2], a = buf[i + 3];
    if (r < 0) r = 0; else if (r > 1) r = 1;
    if (g < 0) g = 0; else if (g > 1) g = 1;
    if (b < 0) b = 0; else if (b > 1) b = 1;
    if (a < 0) a = 0; else if (a > 1) a = 1;
    px[i]     = (linearToSrgb(r) * 255 + 0.5) | 0;
    px[i + 1] = (linearToSrgb(g) * 255 + 0.5) | 0;
    px[i + 2] = (linearToSrgb(b) * 255 + 0.5) | 0;
    px[i + 3] = (a * 255 + 0.5) | 0;
  }
  return out;
}

// Linear-space alpha-composite src (sw×sh) onto dst (CANVAS_W×CANVAS_H) at
// (dx, dy), clipping against dst bounds. Mirrors compose_ui_panel.py:composite.
function compositeLinear(dst, src, sw, sh, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(CANVAS_W, dx + sw);
  const y1 = Math.min(CANVAS_H, dy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0;
  for (let y = y0; y < y1; y++) {
    let dRow = (y * CANVAS_W + x0) * 4;
    let sRow = ((y - dy) * sw + (x0 - dx)) * 4;
    for (let x = 0; x < w; x++, dRow += 4, sRow += 4) {
      const sa = src[sRow + 3];
      if (sa === 0) continue;
      const inv = 1 - sa;
      dst[dRow]     = src[sRow]     * sa + dst[dRow]     * inv;
      dst[dRow + 1] = src[sRow + 1] * sa + dst[dRow + 1] * inv;
      dst[dRow + 2] = src[sRow + 2] * sa + dst[dRow + 2] * inv;
      dst[dRow + 3] = sa             + dst[dRow + 3] * inv;
    }
  }
}

// --- Sprite cache ---

const _imageCache  = new Map();   // path -> Promise<HTMLImageElement>
const _spriteCache = new Map();   // `${path}@${w}x${h}` -> Float32Array

function loadSpriteImage(path) {
  let p = _imageCache.get(path);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + path));
    img.src = assetUrl(path);
  });
  _imageCache.set(path, p);
  return p;
}

// Linear-space copy of a sprite resampled to (w, h). The browser's drawImage
// resize is sRGB-byte LANCZOS-ish via the underlying resampler — same path the
// Python compositor takes (PIL.LANCZOS then linearize). Cached per (file, w, h).
async function spriteAtSize(filePath, w, h) {
  const key = `${filePath}@${w}x${h}`;
  let lin = _spriteCache.get(key);
  if (lin) return lin;
  const img = await loadSpriteImage(filePath);
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  lin = imageDataToLinear(ctx.getImageData(0, 0, w, h));
  _spriteCache.set(key, lin);
  return lin;
}

// --- Background ---

async function renderBackground(filePath, dst) {
  const img = await loadSpriteImage(filePath);
  const iw = img.width, ih = img.height;
  const s = Math.max(CANVAS_W / iw, CANVAS_H / ih);
  const nw = Math.round(iw * s);
  const nh = Math.round(ih * s);
  const tmp = document.createElement('canvas');
  tmp.width = nw; tmp.height = nh;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0, nw, nh);
  const left = Math.floor((nw - CANVAS_W) / 2);
  const top  = Math.floor((nh - CANVAS_H) / 2);
  dst.set(imageDataToLinear(ctx.getImageData(left, top, CANVAS_W, CANVAS_H)));
}

// --- Layer rendering ---

// NamePlateBase ships with a deliberately translucent main fill (peak α≈87%,
// RGB near-black) — designed to sit softly over NormalPrinter_Screen with the
// dialog frame bleeding through. In our linear-space blend, against a possibly
// brighter scene BG that reads thinner than the in-game look. Boost α by
// 255/221 so the dominant 87% peak saturates to fully opaque; the secondary
// 61% inner-ring peak only rises to ~70% (stays soft) and AA edges scale
// gently. Other layers pass through untouched.
const NAMEPLATE_ALPHA_BOOST = 255 / 221;

async function renderLayer(layer, dst) {
  const [tw, th] = layer.size;
  if (tw <= 0 || th <= 0) return;
  let sprite = await spriteAtSize(`${SCENE_ADV_ROOT}/${layer.file}`, tw, th);
  const boostA = layer.name === 'NamePlateBase' ? NAMEPLATE_ALPHA_BOOST : 1;
  const c = layer.color;
  const needsTint = c && !(c[0] === 1 && c[1] === 1 && c[2] === 1 && c[3] === 1);
  if (needsTint || boostA !== 1) {
    const out = new Float32Array(sprite);
    for (let i = 0; i < out.length; i += 4) {
      if (needsTint) {
        out[i]     *= c[0];
        out[i + 1] *= c[1];
        out[i + 2] *= c[2];
        out[i + 3] *= c[3];
      }
      if (boostA !== 1) {
        const a = out[i + 3] * boostA;
        out[i + 3] = a > 1 ? 1 : a;
      }
    }
    sprite = out;
  }
  compositeLinear(dst, sprite, tw, th,
                  Math.round(layer.pos[0]), Math.round(layer.pos[1]));
}

// --- Font handling ---
//
// Game fonts: Noto Serif KR (Korean build) / Tsukushi Mincho (Japanese build).
// Tsukushi is commercial; we substitute Noto Serif JP — same Mincho-style
// serif tone. Both load via Google Fonts. Glyph metrics may differ slightly
// from the in-game font (especially Japanese), but rect anchor points are
// exact, matching compose_ui_panel.py's substitution policy.

const FONT_FAMILY = {
  ko: '"Noto Serif KR", "Noto Serif JP", "Noto Serif CJK KR", "Noto Serif CJK JP", serif',
  ja: '"Noto Serif JP", "Noto Serif KR", "Noto Serif CJK JP", "Noto Serif CJK KR", serif',
};

// Bump the requested weight one CSS step. The game ships Tsukushi Mincho
// (Japanese) and Noto Serif KR (Korean), both with stroke weight closer to
// Medium than to open Noto Serif's Regular at the same nominal weight — so the
// 400 the prefab declares looks visibly thinner than the in-game render. +100
// brings the stand-in into the right neighbourhood without touching the 700
// branch, which was already heavy enough.
function fontString(size, weight, italic) {
  const bumped = Math.min(900, Math.max(100, (weight || 400) + 100));
  return `${italic ? 'italic ' : ''}${bumped} ${size}px ${FONT_FAMILY[locale]}`;
}

// Force the browser to download every (family, weight) we'll need before the
// first measure / fillText. Without this, the first render falls back to a
// system serif and metrics differ. Idempotent — `document.fonts.load` returns
// from cache once loaded.
async function ensureFontsLoaded() {
  if (!document.fonts) return;
  const variants = [];
  for (const fam of ['Noto Serif KR', 'Noto Serif JP']) {
    for (const sz of [48, 136]) {
      // 500 covers the +100 bump from the default 400 prefab weight; 800
      // covers the bump from the rare 700 case. Both must also appear in the
      // Google Fonts <link> in scene.html, otherwise the browser substitutes
      // faux-bold and metrics drift.
      for (const wt of [400, 500, 700, 800]) variants.push(`${wt} ${sz}px "${fam}"`);
    }
  }
  await Promise.all(variants.map(v => document.fonts.load(v).catch(() => {})));
  await document.fonts.ready;
}

// --- TMP plain-text renderer ---

const _MEAS_CTX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.getContext('2d');
})();

// Stand-in for TMP's per-material underlay (drop shadow / halo). The real
// in-game MessageLabel and AuthorLabel both use `Shadow1` — a soft black halo
// behind every glyph that lifts the text off arbitrary backgrounds. Rather
// than emulate the full SDF-shader pipeline (see docs/text_shadows.md), we
// lean on Canvas2D's built-in `shadowBlur`, which rasterizes a Gaussian
// blurred drop shadow behind any fillText call in the same pass.
// Applied to all narrative text leaves (MessageLabel + AuthorLabel); other UI
// text is unconfirmed. Neon-glow halo: centered on the glyph (no offset), soft
// black at high alpha. Visually evokes a TMP Shadow1-style underlay.
const TEXT_SHADOW_COLOR  = 'rgba(0, 0, 0, 1)';
// Em-relative blur — TMP's `_UnderlaySoftness` is a normalized 0..1 input
// scaled by the glyph em, not by an absolute pixel count. We reproduce that:
// blur in pixels = font_size * RATIO.
//
// Per-leaf ratios because each label uses a different Shadow material in-game:
//   - MessageLabel uses `Shadow1` (Softness=1.0, big soft halo) → 6/48 anchor
//     tuned against an in-game capture at 48 px CJK glyphs.
//   - AuthorLabel uses one of the tighter variants (Shadow2/6, Softness=0.05–0.10
//     in-game) — the Addressables catalog isn't shipped, so we can't pin down
//     which one. Half of MessageLabel's ratio is a starting estimate; tune
//     against an in-game capture if it still reads off.
//
// Each glyph carries its own halo extent rather than inheriting the leaf's
// largest size — important for rich-text where sz=73 sub-glyphs and sz=136
// main glyphs coexist in AuthorLabel.
const TEXT_SHADOW_BLUR_RATIO_MESSAGE = 6 / 48;
const TEXT_SHADOW_BLUR_RATIO_AUTHOR  = 3 / 48;
// AuthorLabel shadow is off by default — the in-game render uses a tighter
// Shadow variant (Shadow2/6, Softness=0.05–0.10) than what we emulate, and
// even at half the MessageLabel ratio the Canvas2D approximation reads off.
// Flip to `true` to re-enable the AuthorLabel halo with the ratio above.
const AUTHOR_SHADOW_ENABLED = false;
// Canvas2D's shadowBlur spreads the source alpha across the blur radius, so
// peak halo opacity ends up much lower than the source color's alpha. Stacking
// N fillText passes with the shadow enabled multiplies halo density (each
// pass adds another shadow layer onto the canvas) without widening the
// spread — the alternative would be a much darker color, which then bands at
// the glyph edge. Tune passes for intensity, ratio for spread.
const TEXT_SHADOW_PASSES = 3;

function fillStyle(color) {
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  return `rgba(${r}, ${g}, ${b}, ${color[3]})`;
}

function renderPlainText(rec, dst, overrideText = null) {
  const s = overrideText !== null ? overrideText : (rec.text || '');
  if (!s) return;
  const margin = rec.margin || [0, 0, 0, 0];
  const pos = rec.pos, sz = rec.size;
  const color = rec.color || [1, 1, 1, 1];
  const fontSize = Math.max(1, Math.round(rec.font_size || 24));
  const weight = rec.font_weight || 400;
  const italic = (rec.font_style || '').includes('Italic');
  const rx = pos[0] + margin[0];
  const ry = pos[1] + margin[1];
  const rw = Math.max(0, sz[0] - margin[0] - margin[2]);
  const rh = Math.max(0, sz[1] - margin[1] - margin[3]);

  const fStr = fontString(fontSize, weight, italic);
  _MEAS_CTX.font = fStr;
  const lines = s.split('\n');
  const m0 = _MEAS_CTX.measureText(lines[0] || ' ');
  const fbAsc  = m0.fontBoundingBoxAscent  ?? fontSize * 0.85;
  const fbDesc = m0.fontBoundingBoxDescent ?? fontSize * 0.20;
  const lineHeight = fbAsc + fbDesc;
  const blockH = lines.length * lineHeight;
  const widths = lines.map(l => _MEAS_CTX.measureText(l).width);
  const maxW = Math.max(0, ...widths);

  const h = rec.h_align || 'Left';
  const v = rec.v_align || 'Top';
  let textAlign, ax;
  if (h === 'Center')      { textAlign = 'center'; ax = rx + rw / 2; }
  else if (h === 'Right')  { textAlign = 'right';  ax = rx + rw; }
  else                     { textAlign = 'left';   ax = rx; }

  let firstBaseline;
  if (v === 'Middle') {
    firstBaseline = ry + (rh - blockH) / 2 + fbAsc;
  } else if (v === 'Bottom' || v === 'Baseline') {
    firstBaseline = ry + rh - blockH + fbAsc;
  } else {
    // Top / Geometry / Capline (Capline-aware path uses renderRichText)
    firstBaseline = ry + fbAsc;
  }

  // MessageLabel + AuthorLabel get a TMP-Shadow1-style halo via Canvas2D's
  // shadowBlur, sized em-relative to the leaf's font. Per-leaf ratio (see the
  // ratio constants) — AuthorLabel uses a tighter halo than MessageLabel.
  // The halo extends ~2× shadowBlur beyond the glyph footprint, so the bbox
  // grows; other leaves keep the slim 4 px AA pad.
  const useShadow = rec.go === 'MessageLabel'
    || (AUTHOR_SHADOW_ENABLED && rec.go === 'AuthorLabel');
  const blurRatio = rec.go === 'AuthorLabel'
    ? TEXT_SHADOW_BLUR_RATIO_AUTHOR
    : TEXT_SHADOW_BLUR_RATIO_MESSAGE;
  const shadowBlur = fontSize * blurRatio;
  let bx;
  if (textAlign === 'center')     bx = ax - maxW / 2;
  else if (textAlign === 'right') bx = ax - maxW;
  else                            bx = ax;
  const pad = useShadow ? Math.max(4, Math.ceil(shadowBlur * 2)) : 4;
  const bbox = {
    x: Math.floor(bx - pad),
    y: Math.floor(firstBaseline - fbAsc - pad),
    w: Math.ceil(maxW + pad * 2),
    h: Math.ceil(blockH + pad * 2),
  };
  if (bbox.w <= 0 || bbox.h <= 0) return;

  const off = document.createElement('canvas');
  off.width = bbox.w; off.height = bbox.h;
  const ctx = off.getContext('2d');
  ctx.font = fStr;
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = fillStyle(color);
  if (useShadow) {
    ctx.shadowColor   = TEXT_SHADOW_COLOR;
    ctx.shadowBlur    = shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  const passes = useShadow ? TEXT_SHADOW_PASSES : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], ax - bbox.x, firstBaseline - bbox.y + i * lineHeight);
    }
  }
  const lin = imageDataToLinear(ctx.getImageData(0, 0, bbox.w, bbox.h));
  compositeLinear(dst, lin, bbox.w, bbox.h, bbox.x, bbox.y);
}

// --- TMP rich-text renderer (AuthorLabel) ---
//
// Mirrors compose_ui_panel.py:_render_tagged_text. Honours <color>, <size>,
// <voffset>, <space>, <cspace> with stack semantics — `</tag>` pops to the
// previous value, not the base. Closing more tags than were opened is a
// no-op (matches TMP's parser). Used for the per-character AuthorLabel
// rich-text shipped in characters/configuration.json's `tagged_name`.

const TAG_RE = /<(\/?)(color|size|voffset|space|cspace)(?:=([^>]+))?>/g;

function tokenizeRich(text) {
  const out = [];
  let i = 0, m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    for (let j = i; j < m.index; j++) out.push({ kind: 'glyph', val: text[j] });
    const slash = m[1], name = m[2], val = m[3];
    if (slash)                 out.push({ kind: 'close_' + name });
    else if (name === 'space') out.push({ kind: 'space', val: parseFloat(val) || 0 });
    else                       out.push({ kind: 'open_' + name, val });
    i = m.index + m[0].length;
  }
  for (let j = i; j < text.length; j++) out.push({ kind: 'glyph', val: text[j] });
  return out;
}

function parseColorToken(s) {
  if (!s || !s.startsWith('#')) return null;
  let h = s.slice(1);
  if (h.length === 6) h += 'FF';
  if (h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = parseInt(h.slice(6, 8), 16);
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return [r / 255, g / 255, b / 255, a / 255];
}

// Capline cap-top reference. TMP positions the TMP_FontAsset's
// m_FaceInfo.capLine at the rect top, but that asset isn't shipped in any
// bundle. The Python compositor blends OS/2.sTypoAscender with hhea.ascender
// at mix=0.45 — empirically tuned against an in-game capture. For Noto Serif
// CJK at the AuthorLabel's sz=136 that blend lands at ≈ 137 px (≈ the font
// size itself). Hard-coded here as `font_size × CAPLINE_RATIO` so the
// placement axis no longer depends on per-glyph TextMetrics — only fbDesc
// (for bbox sizing) is still measured. If a future game build changes the
// TMP capLine setting, re-bisect against an in-game capture and adjust.
const CAPLINE_RATIO = 1.0;
// Constant pixel shift applied to Capline-aligned baselines (AuthorLabel et
// al.) — subtracted from yBaseline in PIL Y-down, so positive = upward. The
// ratio above is per-size; this is rect-relative, so it's the right knob for
// "move the line N pixels up regardless of glyph size". Tuned against the
// in-game capture.
const CAPLINE_NUDGE_UP = 5;

function renderRichText(rec, dst, tagged, baseColorHex) {
  const margin = rec.margin || [0, 0, 0, 0];
  const pos = rec.pos, sz = rec.size;
  const baseSize = Math.max(1, Math.round(rec.font_size || 48));
  const baseColor = rec.color || [1, 1, 1, 1];
  const weight = rec.font_weight || 400;
  const italic = (rec.font_style || '').includes('Italic');

  if (tagged.includes('%COLOR%')) {
    tagged = tagged.replaceAll('%COLOR%', baseColorHex || '#FFFFFF');
  }

  const rx = pos[0] + margin[0];
  const ry = pos[1] + margin[1];
  const rw = Math.max(0, sz[0] - margin[0] - margin[2]);
  const rh = Math.max(0, sz[1] - margin[1] - margin[3]);

  const colorStack = [baseColor];
  const sizeStack  = [baseSize];
  const voffStack  = [0];
  const cspStack   = [0];

  const glyphs = [];
  let cursorX = 0;
  let capTop = 0, glyphBot = 0, typoAsc = 0, typoDesc = 0;

  for (const tok of tokenizeRich(tagged)) {
    switch (tok.kind) {
      case 'open_color': {
        const c = parseColorToken(tok.val);
        colorStack.push(c || colorStack[colorStack.length - 1]);
        break;
      }
      case 'close_color':   if (colorStack.length > 1) colorStack.pop(); break;
      case 'open_size': {
        const v = parseFloat(tok.val);
        sizeStack.push(Number.isFinite(v) ? Math.max(1, Math.round(v)) : sizeStack[sizeStack.length - 1]);
        break;
      }
      case 'close_size':    if (sizeStack.length  > 1) sizeStack.pop();  break;
      case 'open_voffset': {
        const v = parseFloat(tok.val);
        voffStack.push(Number.isFinite(v) ? v : voffStack[voffStack.length - 1]);
        break;
      }
      case 'close_voffset': if (voffStack.length  > 1) voffStack.pop();  break;
      case 'open_cspace': {
        const v = parseFloat(tok.val);
        cspStack.push(Number.isFinite(v) ? v : cspStack[cspStack.length - 1]);
        break;
      }
      case 'close_cspace':  if (cspStack.length   > 1) cspStack.pop();   break;
      case 'space': cursorX += tok.val; break;
      case 'glyph': {
        const sz = sizeStack[sizeStack.length - 1];
        const colorNow = colorStack[colorStack.length - 1];
        const voff = voffStack[voffStack.length - 1];
        const csp  = cspStack[cspStack.length  - 1];
        const fStr = fontString(sz, weight, italic);
        _MEAS_CTX.font = fStr;
        const m = _MEAS_CTX.measureText(tok.val);
        const fbAsc  = m.fontBoundingBoxAscent    ?? sz * 0.85;
        const fbDesc = m.fontBoundingBoxDescent   ?? sz * 0.20;
        const aDesc  = m.actualBoundingBoxDescent ?? fbDesc;
        const w = m.width;
        const capLinePx = sz * CAPLINE_RATIO;
        const voffUp   = Math.max(0, Math.round(voff));
        const voffDown = Math.max(0, Math.round(-voff));
        capTop   = Math.max(capTop,   capLinePx + voffUp);
        glyphBot = Math.max(glyphBot, aDesc     + voffDown);
        typoAsc  = Math.max(typoAsc,  fbAsc     + voffUp);
        typoDesc = Math.max(typoDesc, fbDesc    + voffDown);
        glyphs.push({ ch: tok.val, x: cursorX, voff, color: colorNow, fontStr: fStr, size: sz });
        cursorX += w + csp;
        break;
      }
    }
  }

  if (glyphs.length === 0) return;
  const textW = cursorX;
  const visibleH = capTop + glyphBot;

  const h = rec.h_align || 'Left';
  const v = rec.v_align || 'Top';
  let xOrigin;
  if (h === 'Center')     xOrigin = rx + (rw - textW) / 2;
  else if (h === 'Right') xOrigin = rx + rw - textW;
  else                    xOrigin = rx;

  let yBaseline;
  if (v === 'Capline')                          yBaseline = ry + capTop - CAPLINE_NUDGE_UP;
  else if (v === 'Middle')                      yBaseline = ry + rh / 2 + (typoAsc - (typoAsc + typoDesc) / 2);
  else if (v === 'Bottom' || v === 'Baseline')  yBaseline = ry + rh - typoDesc;
  else                                          yBaseline = ry + typoAsc;

  // AuthorLabel-equivalent rich-text (the only caller today) gets a tighter
  // halo than MessageLabel — em-relative blur per glyph (so a sz=73 ruby char
  // gets a tighter halo than a sz=136 main char), pad grows to fit the largest
  // blur in the leaf, glyph loop runs TEXT_SHADOW_PASSES times to deepen the
  // halo.
  const useShadow = AUTHOR_SHADOW_ENABLED && rec.go === 'AuthorLabel';
  let maxBlur = 0;
  if (useShadow) {
    for (const g of glyphs) {
      const b = g.size * TEXT_SHADOW_BLUR_RATIO_AUTHOR;
      if (b > maxBlur) maxBlur = b;
    }
  }
  const pad = useShadow ? Math.max(4, Math.ceil(maxBlur * 2)) : 4;
  const imgW = Math.ceil(textW + pad * 2);
  const imgH = Math.ceil(visibleH + pad * 2);
  if (imgW <= 0 || imgH <= 0) return;

  const off = document.createElement('canvas');
  off.width = imgW; off.height = imgH;
  const ctx = off.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if (useShadow) {
    ctx.shadowColor   = TEXT_SHADOW_COLOR;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  const baselineInImg = capTop + pad;
  const passes = useShadow ? TEXT_SHADOW_PASSES : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (const g of glyphs) {
      ctx.font = g.fontStr;
      ctx.fillStyle = fillStyle(g.color);
      if (useShadow) ctx.shadowBlur = g.size * TEXT_SHADOW_BLUR_RATIO_AUTHOR;
      ctx.fillText(g.ch, g.x + pad, baselineInImg - g.voff);
    }
  }

  const lin = imageDataToLinear(ctx.getImageData(0, 0, imgW, imgH));
  compositeLinear(dst, lin, imgW, imgH,
                  Math.floor(xOrigin) - pad, Math.floor(yBaseline - capTop) - pad);
}

// --- Top-level scene render ---

async function renderTextLeaf(rec, dst) {
  // AuthorLabel routing: when an author is selected and the active locale ships
  // a non-empty tagged_name, render via the rich-text path. Otherwise fall
  // through to the plain placeholder so we still draw *something*.
  if (rec.go === 'AuthorLabel' && authorId) {
    const charRec = (charsConfig.characters || []).find(c => c.id === authorId);
    const tagged = charRec && (charRec.tagged_name || {})[locale];
    if (tagged) {
      renderRichText(rec, dst, tagged, charRec.nameColor_hex);
      return;
    }
  }
  if (rec.go === 'AuthorLabel') {
    renderPlainText(rec, dst, 'Author');
  } else if (rec.go === 'MessageLabel') {
    renderPlainText(rec, dst, messageText);
  } else {
    renderPlainText(rec, dst);
  }
}

// Resolve a `toggle` / `items_toggle` flag name from the metadata against
// live state. Validated at load time, so missing keys here would already
// have thrown.
function isFlagOn(flagName) {
  return TOGGLE_FLAGS[flagName]();
}

// Apply a prefab's runtime gates and merge-sort its layers + texts on shared
// `order`. Static filters (`dropLayers` / `keepGroupPrefix`) were already
// applied at bake time by build_scene_adv.py; this only handles per-render
// runtime toggles.
function selectPrefabItems(prefab) {
  const layers = prefab.layers || [];
  const texts  = prefab.texts  || [];
  const itemsToggle = prefab.items_toggle || {};
  const itemsToggleEntries = Object.entries(itemsToggle);
  const keep = (it) => {
    const group = it.group || '';
    for (const [groupPrefix, flag] of itemsToggleEntries) {
      if (group.startsWith(groupPrefix) && !isFlagOn(flag)) return false;
    }
    return true;
  };
  const items = [];
  layers.forEach((l, i) => { if (keep(l)) items.push([l.order ?? i,                'layer', l]); });
  texts .forEach((t, i) => { if (keep(t)) items.push([t.order ?? layers.length + i, 'text',  t]); });
  items.sort((a, b) => a[0] - b[0]);
  return items;
}

async function renderScene() {
  await ensureFontsLoaded();
  const dst = new Float32Array(CANVAS_W * CANVAS_H * 4);

  if (bgPath) {
    await renderBackground(bgPath, dst);
  } else {
    // Solid opaque black: rgb already 0, set alpha to 1.
    for (let i = 3; i < dst.length; i += 4) dst[i] = 1;
  }

  for (const prefab of sceneMeta.prefabs) {
    if (prefab.toggle && !isFlagOn(prefab.toggle)) continue;
    for (const [, kind, item] of selectPrefabItems(prefab)) {
      if (kind === 'layer') await renderLayer(item, dst);
      else                  await renderTextLeaf(item, dst);
    }
  }

  const out = document.createElement('canvas');
  out.width = CANVAS_W; out.height = CANVAS_H;
  out.getContext('2d').putImageData(linearToImageData(dst, CANVAS_W, CANVAS_H), 0, 0);
  return out;
}

// --- UI ---

function populateBgSelect() {
  const sel = document.getElementById('bgSelect');
  sel.innerHTML = '';

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none — black)';
  sel.appendChild(noneOpt);

  function addGroup(label, list, dir) {
    if (!list || list.length === 0) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const e of list) {
      const o = document.createElement('option');
      o.value = `${SCENE_BG_ROOT}/${dir}/${e.file}`;
      o.textContent = e.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  addGroup('Main',   bgMeta.main,   'main');
  addGroup('Stills', bgMeta.stills, 'stills');
  // bgMeta.utility (Grid_001, Grid_002, SolidColor, Transparent) is omitted —
  // those are author/debug helpers, not narrative backgrounds.

  const first = bgMeta.main && bgMeta.main[0];
  bgPath = first ? `${SCENE_BG_ROOT}/main/${first.file}` : null;
  sel.value = bgPath || '';
}

// Mirror the character editor's dropdown labels (app.js:displayName) so the
// scene editor's Author list reads the same way: "Alisa", "Alisa (Creature)",
// "Jailer (A)", etc. — the user's mental model already maps id → label there.
function authorDisplayName(id) {
  if (id.startsWith('Creature')) return `${id.slice('Creature'.length)} (Creature)`;
  const m = id.match(/^Jailer([A-Z]+)$/);
  if (m) return `Jailer (${m[1]})`;
  return id;
}

function populateAuthorSelect() {
  const sel = document.getElementById('authorSelect');
  sel.innerHTML = '';
  const byId = new Map((charsConfig.characters || []).map(c => [c.id, c]));
  for (const id of AUTHOR_ORDER) {
    const rec = byId.get(id);
    const tagged = rec && (rec.tagged_name || {})[locale];
    if (!tagged) continue;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = authorDisplayName(id);
    sel.appendChild(o);
  }
  // Preserve selection across locale flips when the entry survives; otherwise
  // fall back to DEFAULT_AUTHOR (then to the first option) so the dropdown is
  // never empty and the rendered AuthorLabel always shows a real name.
  const optValues = [...sel.options].map(o => o.value);
  if (authorId && optValues.includes(authorId)) {
    sel.value = authorId;
  } else if (optValues.includes(DEFAULT_AUTHOR)) {
    authorId = DEFAULT_AUTHOR;
    sel.value = authorId;
  } else if (optValues.length > 0) {
    authorId = optValues[0];
    sel.value = authorId;
  } else {
    authorId = '';
  }
}

function setLocale(next) {
  if (next === locale) return;
  locale = next;
  for (const b of document.querySelectorAll('#localeSelector .preset-btn')) {
    b.classList.toggle('active', b.dataset.locale === locale);
  }
  populateAuthorSelect();
  scheduleRender();
}

// --- Preview pipeline (debounced render) ---

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    drawPreview();
  }, 30);
}

async function drawPreview() {
  const seq = ++renderSeq;
  let canvas;
  try {
    canvas = await renderScene();
  } catch (e) {
    console.error('Render failed:', e);
    return;
  }
  // Discard if a newer render started while we were compositing.
  if (seq !== renderSeq) return;
  canvas.style.height = '720px';
  canvas.style.width = 'auto';
  document.getElementById('previewContainer').replaceChildren(canvas);
}

// --- Export ---

async function exportPng() {
  const canvas = await renderScene();
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  const author = authorId || 'noauthor';   // 'noauthor' only fires if charsConfig had no entries for the active locale
  a.download = `scene_adv_${locale}_${author}_${Date.now()}.png`;
  a.click();
  const btn = document.getElementById('exportBtn');
  const orig = btn.textContent;
  btn.textContent = 'Exported!';
  btn.classList.add('exported');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('exported'); }, 1200);
}

// --- Modal (themed confirm) ---

function showModal(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalMessage').textContent = message;
    overlay.classList.add('active');
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn  = document.getElementById('modalCancel');
    cancelBtn.focus();
    function close(r) {
      overlay.classList.remove('active');
      confirmBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(r);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    }
    confirmBtn.onclick = () => close(true);
    cancelBtn.onclick  = () => close(false);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    document.addEventListener('keydown', onKey);
  });
}

// --- Init ---

(async function init() {
  try {
    await loadStaticData();
  } catch (e) {
    console.error('Failed to load scene data:', e);
    const m = document.getElementById('loadingMsg');
    if (m) m.textContent = 'Failed to load scene data.';
    return;
  }

  populateBgSelect();
  populateAuthorSelect();
  document.getElementById('messageInput').value = messageText;

  document.getElementById('bgSelect').onchange = (e) => {
    bgPath = e.target.value || null;
    scheduleRender();
  };
  document.getElementById('authorSelect').onchange = (e) => {
    authorId = e.target.value;
    scheduleRender();
  };
  document.getElementById('messageInput').oninput = (e) => {
    messageText = e.target.value;
    scheduleRender();
  };
  for (const b of document.querySelectorAll('#localeSelector .preset-btn')) {
    b.addEventListener('click', () => setLocale(b.dataset.locale));
  }

  // Overlay toggles. Each writes its module-level flag and re-renders.
  const overlayBindings = [
    ['toggleAuthorPlate', (v) => { showAuthorPlate = v; }],
    ['toggleAutoToggle',  (v) => { showAutoToggle  = v; }],
    ['toggleMenuButton',  (v) => { showMenuButton  = v; }],
    ['toggleBookButton',  (v) => { showBookButton  = v; }],
  ];

  for (const [id, set] of overlayBindings) {
    document.getElementById(id).onchange = (e) => {
      set(e.target.checked);
      scheduleRender();
    };
  }

  document.getElementById('resetBtn').onclick = async () => {
    if (!await showModal('Reset all customizations to default?')) return;
    setLocale('ko');
    messageText = '';
    bgPath = bgMeta.main && bgMeta.main[0] ? `${SCENE_BG_ROOT}/main/${bgMeta.main[0].file}` : null;
    // Drop the current author so populateAuthorSelect picks the first entry
    // for the (newly-set) locale, matching the post-init default.
    authorId = '';
    populateAuthorSelect();
    showAuthorPlate = showAutoToggle = showMenuButton = showBookButton = true;
    for (const [id] of overlayBindings) document.getElementById(id).checked = true;
    document.getElementById('bgSelect').value = bgPath || '';
    document.getElementById('messageInput').value = messageText;
    scheduleRender();
  };
  document.getElementById('exportBtn').onclick = exportPng;

  await drawPreview();
})();

// --- Zoom & Pan ---

let zoomLevel = 1;
let panX = 0, panY = 0;
let isDragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
const container   = document.getElementById('previewContainer');
const previewArea = document.getElementById('previewArea');

function applyTransform() {
  container.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
}

function zoom(delta, cx, cy) {
  const oldZoom = zoomLevel;
  zoomLevel = Math.min(8, Math.max(0.25, zoomLevel * (1 + delta)));
  const ratio = zoomLevel / oldZoom;
  panX = cx - ratio * (cx - panX);
  panY = cy - ratio * (cy - panY);
  applyTransform();
}

previewArea.addEventListener('wheel', e => {
  e.preventDefault();
  const r = previewArea.getBoundingClientRect();
  zoom(e.deltaY > 0 ? -0.15 : 0.15,
       e.clientX - r.left - r.width  / 2,
       e.clientY - r.top  - r.height / 2);
}, { passive: false });

document.getElementById('zoomIn').onclick    = () => zoom( 0.3, 0, 0);
document.getElementById('zoomOut').onclick   = () => zoom(-0.3, 0, 0);
document.getElementById('zoomReset').onclick = () => { zoomLevel = 1; panX = 0; panY = 0; applyTransform(); };

const activePointers = new Map();
let pinchStartDist = 0;
let pinchStartZoom = 1;
const pointerArr  = () => [...activePointers.values()];
const pointerDist = () => { const [a, b] = pointerArr(); return Math.hypot(a.x - b.x, a.y - b.y); };
const pointerMid  = () => { const [a, b] = pointerArr(); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };

previewArea.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  previewArea.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    isDragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    panStartX  = panX;       panStartY  = panY;
    container.classList.add('dragging');
  } else if (activePointers.size === 2) {
    isDragging = false;
    container.classList.remove('dragging');
    pinchStartDist = pointerDist();
    pinchStartZoom = zoomLevel;
  }
});

previewArea.addEventListener('pointermove', e => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    if (pinchStartDist === 0) return;
    const r = previewArea.getBoundingClientRect();
    const mid = pointerMid();
    const cx = mid.x - r.left - r.width  / 2;
    const cy = mid.y - r.top  - r.height / 2;
    const oldZoom = zoomLevel;
    zoomLevel = Math.min(8, Math.max(0.25, pinchStartZoom * pointerDist() / pinchStartDist));
    const ratio = zoomLevel / oldZoom;
    panX = cx - ratio * (cx - panX);
    panY = cy - ratio * (cy - panY);
    applyTransform();
  } else if (isDragging && activePointers.size === 1) {
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  }
});

function endPointer(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);
  pinchStartDist = 0;
  if (activePointers.size === 0) {
    isDragging = false;
    container.classList.remove('dragging');
  } else if (activePointers.size === 1) {
    const r = pointerArr()[0];
    dragStartX = r.x; dragStartY = r.y;
    panStartX = panX; panStartY = panY;
    isDragging = true;
  }
}
previewArea.addEventListener('pointerup', endPointer);
previewArea.addEventListener('pointercancel', endPointer);

// --- Drawer (mobile bottom sheet) ---
document.getElementById('drawerToggle').onclick   = () => document.body.classList.add('drawer-open');
document.getElementById('drawerBackdrop').onclick = () => document.body.classList.remove('drawer-open');
document.getElementById('drawerClose').onclick    = () => document.body.classList.remove('drawer-open');
