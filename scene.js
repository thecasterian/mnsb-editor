// Bump on every deploy to invalidate stale browser caches of JSON/PNG assets.
// Also bump the matching ?v= on styles.css and scene.js in scene.html.
const BUILD_VERSION = '20260509i';
const assetUrl = (path) => `${path}?v=${BUILD_VERSION}`;

// IndexedDB-backed snapshot store shared with the character editor. Records:
//   { slug, name, character, variant, charType, width, height, blob, createdAt }
// In memory we add a `blobUrl` per record (object-URL over the blob) and
// reuse it for thumbnails + the placement render path; revoked on reload
// and on delete.
const { snapshotGetAll, snapshotDelete, snapshotChannel } =
  await import(`./snapshot_store.js?v=${BUILD_VERSION}`);

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

// --- Character snapshots (handed off from the character editor) ---
//
// `snapshots`  — id → snapshot record (the localStorage payload). Refreshed
//   from localStorage on init and on 'storage' events.
// `placements` — array of { slug, x, y, scale } in placement order. One
//   placement per snapshot slug (duplicates collapse to selecting the
//   existing entry, per the v1 design).
// `selectedSlug` — currently-selected placement, or null. Drives the
//   inspector and the on-canvas selection outline.
let snapshots    = new Map();
let placements   = [];
let selectedSlug = null;
// character id → intrinsic_scale (the prefab's pre-baked uniform Transform
// scale: e.g. Ema=0.6, Hanna=0.54, Hiro/Leia/Meruru/Nanoka=0.75). Built once
// from scene/authors.json's per-character entries. Diced NPCs (Warden, Yuki)
// have no prefab Transform → 1.0. Used to compose with placement.scale so
// placement.scale=1.0 means "as the game renders at script_scale=1.0".
let intrinsicScales = new Map();
// Lower-cased query for the snapshot library filter. Empty = no filter.
// Matches against name + character + variant. Updated by the search input.
let snapshotSearchQuery = '';

async function readSnapshotsFromIDB() {
  const out = new Map();
  let records;
  try {
    records = await snapshotGetAll();
  } catch (e) {
    console.error('Failed to read snapshots from IDB:', e);
    return out;
  }
  for (const rec of records) {
    if (!rec || !rec.slug || !rec.blob) continue;
    out.set(rec.slug, { ...rec, blobUrl: URL.createObjectURL(rec.blob) });
  }
  return out;
}

function placementBySlug(slug) {
  return placements.find(p => p.slug === slug) || null;
}

// On-stage size = snap.size × intrinsic_scale × placement.scale. The snapshot
// PNG is the raw bundle render (no Transform applied), so the prefab's
// per-character intrinsic scale composes with the user's placement.scale to
// match what the game would render at script_scale = placement.scale.
// Falls back to 1.0 for snapshots whose character lookup fails (diced NPCs
// without a layered layers.json, or characters missing from authors.json).
function intrinsicScaleFor(snap) {
  if (!snap) return 1;
  return intrinsicScales.get(snap.character) ?? 1;
}

// --- Placement persistence ---
//
// Snapshots live in IDB; placement geometry lives in localStorage. The two
// stores have different lifetimes and consumers: snapshots are heavy binary
// shared across tabs (cross-tab broadcast); placements are light JSON owned
// by *this* scene editor instance only — switching tabs gets you the same
// snapshot library but each tab maintains its own scene composition.

const PLACEMENTS_KEY     = 'manosaba.scene.placements';
const PLACEMENTS_VERSION = 1;

function savePlacements() {
  try {
    localStorage.setItem(PLACEMENTS_KEY, JSON.stringify({
      version:      PLACEMENTS_VERSION,
      placements,
      selectedSlug,
    }));
  } catch (e) {
    console.error('Failed to save placements:', e);
  }
}

// Coalesces the high-frequency mutations during drag (one save per ~200 ms
// idle) into a single localStorage write. Debounce trailing-edge: the last
// pointermove event of a drag fires this; the timer expires after the user
// stops moving and writes once. Tab close between writes loses at most the
// last 200 ms of motion — acceptable.
let _saveTimer = null;
function schedulePlacementsSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; savePlacements(); }, 200);
}

// Drag lock: while the user is dragging in *this* tab, ignore incoming
// `storage` events. Reloading mid-drag would clobber the in-progress geometry
// with whatever the other tab last saved. Pending reloads coalesce into a
// single deferred load on dragend.
let _dragInProgress = false;
let _pendingReload  = false;

// preserveSelection=true: keep this tab's `selectedSlug` if it still resolves
// to a placement we just loaded. Used by the cross-tab `storage` listener so
// another tab's edits don't reset what *this* user has open in the inspector.
// preserveSelection=false (init load): adopt whatever the saved state had,
// so reopening the editor restores the previous session's selection.
// --- Scene config persistence ---
//
// Locale / background / author / message / scene type — non-placement scene
// state. Stored under a separate localStorage key from placements so that a
// drag in one tab (writing the placements key every ~200 ms) doesn't echo
// into another tab and clobber its in-progress text typing or selection
// changes. Each key has its own debounce + storage listener.

const SCENE_CONFIG_KEY     = 'manosaba.scene.config';
const SCENE_CONFIG_VERSION = 1;

function saveSceneConfig() {
  try {
    localStorage.setItem(SCENE_CONFIG_KEY, JSON.stringify({
      version:   SCENE_CONFIG_VERSION,
      sceneType: 'adv',  // only 'adv' is implemented; placeholder for future
      locale,
      bgPath,
      authorId,
      messageText,
    }));
  } catch (e) {
    console.error('Failed to save scene config:', e);
  }
}

let _configSaveTimer = null;
function scheduleSceneConfigSave() {
  if (_configSaveTimer) clearTimeout(_configSaveTimer);
  _configSaveTimer = setTimeout(() => { _configSaveTimer = null; saveSceneConfig(); }, 200);
}

// Apply a saved-config record to the in-memory state and corresponding DOM
// controls. `render=true` (the default) schedules a re-render; init passes
// false because it does its own initial render after this returns.
function loadSceneConfig({ render = true } = {}) {
  let data;
  try {
    const raw = localStorage.getItem(SCENE_CONFIG_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse saved scene config:', e);
    return;
  }
  if (!data || data.version !== SCENE_CONFIG_VERSION) return;

  if (data.locale === 'ko' || data.locale === 'ja') {
    if (data.locale !== locale) {
      locale = data.locale;
      for (const b of document.querySelectorAll('#localeSelector .preset-btn')) {
        b.classList.toggle('active', b.dataset.locale === locale);
      }
      populateAuthorSelect();
    }
  }

  if (typeof data.bgPath === 'string' || data.bgPath === null) {
    bgPath = data.bgPath || null;
    document.getElementById('bgSelect').value = bgPath || '';
  }

  if (typeof data.authorId === 'string') {
    const sel = document.getElementById('authorSelect');
    if ([...sel.options].some(o => o.value === data.authorId)) {
      authorId = data.authorId;
      sel.value = authorId;
    }
  }

  // Skip the messageText sync when the user is actively typing in the
  // textarea — otherwise a save fired by another tab (for an unrelated
  // change) would reset the in-progress typing on every keystroke window.
  const msgEl = document.getElementById('messageInput');
  if (typeof data.messageText === 'string' && document.activeElement !== msgEl) {
    messageText = data.messageText;
    msgEl.value = messageText;
  }

  if (render) scheduleRender();
}

function loadPlacements({ preserveSelection = false } = {}) {
  let data;
  try {
    const raw = localStorage.getItem(PLACEMENTS_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse saved placements:', e);
    return;
  }
  if (!data || data.version !== PLACEMENTS_VERSION) return;
  // Drop orphans whose snapshot no longer exists in IDB. `snapshots` must be
  // populated before this runs — the init flow calls reloadSnapshots() first.
  placements = Array.isArray(data.placements)
    ? data.placements.filter(p => p && snapshots.has(p.slug))
    : [];
  const savedSel = (data.selectedSlug && snapshots.has(data.selectedSlug))
    ? data.selectedSlug : null;
  if (preserveSelection
      && selectedSlug
      && placements.some(p => p.slug === selectedSlug)) {
    // keep this tab's selection
  } else {
    selectedSlug = savedSel;
  }
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  if (placements.length > 0) scheduleRender();
}

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

  intrinsicScales = new Map();
  for (const c of (charsConfig.characters || [])) {
    const s = Number(c.intrinsic_scale);
    intrinsicScales.set(c.id, Number.isFinite(s) && s > 0 ? s : 1);
  }

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

// --- Placement sprites (character snapshots from localStorage) ---
//
// Snapshots come in as PNG data URLs. Cache them by slug so HTMLImageElement
// is reused across renders. The linear-space resampled buffer is keyed by
// (slug, width, height) — placement scale changes invalidate that dimension
// key naturally, so dragging the scale slider doesn't accumulate stale
// buffers for the same slug indefinitely (only per-step variants).

const _snapshotImageCache    = new Map();   // slug -> Promise<HTMLImageElement>
const _placementSpriteCache  = new Map();   // `${slug}@${w}x${h}` -> Float32Array

function loadSnapshotImage(snap) {
  let p = _snapshotImageCache.get(snap.slug);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode snapshot ' + snap.slug));
    img.src = snap.blobUrl;  // object-URL over the IDB-stored Blob
  });
  _snapshotImageCache.set(snap.slug, p);
  return p;
}

async function placementSprite(snap, w, h) {
  const key = `${snap.slug}@${w}x${h}`;
  let lin = _placementSpriteCache.get(key);
  if (lin) return lin;
  const img = await loadSnapshotImage(snap);
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  lin = imageDataToLinear(ctx.getImageData(0, 0, w, h));
  _placementSpriteCache.set(key, lin);
  return lin;
}

function dropSnapshotCache(slug) {
  _snapshotImageCache.delete(slug);
  for (const key of _placementSpriteCache.keys()) {
    if (key.startsWith(slug + '@')) _placementSpriteCache.delete(key);
  }
}

async function renderPlacement(placement, dst) {
  const snap = snapshots.get(placement.slug);
  if (!snap) return;
  const s = intrinsicScaleFor(snap) * placement.scale;
  const w = Math.max(1, Math.round(snap.width  * s));
  const h = Math.max(1, Math.round(snap.height * s));
  const sprite = await placementSprite(snap, w, h);
  compositeLinear(dst, sprite, w, h,
                  Math.round(placement.x), Math.round(placement.y));
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

  // Placements sit behind the dialog frame, in array order (later = on top).
  for (const p of placements) await renderPlacement(p, dst);

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

// --- Snapshot library + placements ---

function relativeTime(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const dt = (Date.now() - t) / 1000;
  if (dt < 60)         return 'just now';
  if (dt < 3600)       return `${Math.floor(dt / 60)} min ago`;
  if (dt < 86400)      return `${Math.floor(dt / 3600)} hr ago`;
  if (dt < 86400 * 30) return `${Math.floor(dt / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// Default position/scale for a freshly-placed snapshot. Always lands at
// placement.scale=1.0 (i.e. "as the game would render at script_scale=1.0",
// since intrinsic_scale composes in at render time), horizontally centered
// at on-stage width, with the sprite's top edge at 20% of the canvas height
// — matches the game's typical VN framing where the head sits in the upper
// quarter and the body fills the rest.
function defaultPlacementFor(snap) {
  const intrinsic = intrinsicScaleFor(snap);
  const rw = snap.width * intrinsic;
  return {
    slug:  snap.slug,
    x:     Math.round((CANVAS_W - rw) / 2),
    y:     Math.round(CANVAS_H * 0.2),
    scale: 1.0,
  };
}

// Add a placement for `slug` (or select the existing one — per the v1 rule
// that disallows the same snapshot being placed twice). Returns true if a new
// placement was added, false if an existing one was selected.
function addOrSelectPlacement(slug) {
  const snap = snapshots.get(slug);
  if (!snap) return false;
  let placement = placementBySlug(slug);
  let added = false;
  if (!placement) {
    placement = defaultPlacementFor(snap);
    placements.push(placement);
    added = true;
  }
  selectedSlug = slug;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return added;
}

function removePlacement(slug) {
  const before = placements.length;
  placements = placements.filter(p => p.slug !== slug);
  if (selectedSlug === slug) selectedSlug = null;
  if (placements.length !== before) {
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
  }
}

// Z-order. Render iterates `placements` in array order — last is topmost.
// "Bring to front" moves the target to the end of the array; "send to back"
// moves it to the start.
function bringPlacementToFront(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i < 0 || i === placements.length - 1) return false;
  const [target] = placements.splice(i, 1);
  placements.push(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return true;
}

function sendPlacementToBack(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i <= 0) return false;
  const [target] = placements.splice(i, 1);
  placements.unshift(target);
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  return true;
}

function placementZPosition(slug) {
  const i = placements.findIndex(p => p.slug === slug);
  if (i < 0) return { canFront: false, canBack: false };
  return { canFront: i < placements.length - 1, canBack: i > 0 };
}

async function deleteSnapshot(slug) {
  const snap = snapshots.get(slug);
  if (!snap) return;
  if (!await showModal(`Delete snapshot "${snap.name}"?`)) return;
  try {
    await snapshotDelete(slug);
  } catch (e) {
    console.error('Failed to delete snapshot:', e);
    return;
  }
  if (snap.blobUrl) URL.revokeObjectURL(snap.blobUrl);
  snapshots.delete(slug);
  dropSnapshotCache(slug);
  removePlacement(slug);  // also drops any placement using it
  refreshSnapshotList();
  snapshotChannel.postMessage({ type: 'deleted', slug });
}

// Rename only changes the IDB record's `name` field. Slug is the join key
// for placements + cross-tab messages, so renaming never invalidates either.
// In-memory record gets the new name to keep the UI in sync without a full
// reload; we still broadcast 'updated' so other tabs reload through their
// listener path (which also updates *their* in-memory caches).
async function renameSnapshot(slug) {
  const snap = snapshots.get(slug);
  if (!snap) return;
  const newName = await showRenameModal(snap.name);
  if (newName === null) return;            // cancelled
  const trimmed = newName.trim();
  if (!trimmed || trimmed === snap.name) return;
  // Build a clean record (without the in-memory-only blobUrl field) for IDB.
  const record = {
    slug:      snap.slug,
    name:      trimmed,
    character: snap.character,
    variant:   snap.variant,
    charType:  snap.charType,
    width:     snap.width,
    height:    snap.height,
    blob:      snap.blob,
    createdAt: snap.createdAt,
  };
  try {
    await snapshotPut(record);
  } catch (e) {
    console.error('Failed to rename snapshot:', e);
    await showModal('Failed to rename snapshot. See console for details.');
    return;
  }
  snap.name = trimmed;
  refreshSnapshotList();
  snapshotChannel.postMessage({ type: 'updated', slug });
}

// Bulk-delete every snapshot whose slug is not currently placed in this
// tab's scene. "Unused" is a per-tab concept: another tab might still have
// a placement for the same slug, but we only see this tab's view of
// placements. After the deletes, post a single bulk-changed message so peers
// reload once instead of N times.
async function deleteUnusedSnapshots() {
  const placedSlugs = new Set(placements.map(p => p.slug));
  const unused = [...snapshots.values()].filter(s => !placedSlugs.has(s.slug));
  if (unused.length === 0) {
    await showModal('No unused snapshots to delete.');
    return;
  }
  if (!await showModal(`Delete ${unused.length} unused snapshot${unused.length === 1 ? '' : 's'}?`)) return;
  for (const snap of unused) {
    try {
      await snapshotDelete(snap.slug);
    } catch (e) {
      console.error('Failed to delete snapshot:', e);
      continue;
    }
    if (snap.blobUrl) URL.revokeObjectURL(snap.blobUrl);
    snapshots.delete(snap.slug);
    dropSnapshotCache(snap.slug);
  }
  refreshSnapshotList();
  snapshotChannel.postMessage({ type: 'bulk-changed' });
}

// Wipes the entire library — both IDB and any placements that referenced
// those snapshots. The placements wipe is unavoidable: every placement's
// slug becomes orphaned, so a partial delete-then-leave-stragglers state
// would be inconsistent.
async function deleteAllSnapshots() {
  const all = [...snapshots.values()];
  if (all.length === 0) {
    await showModal('Library is already empty.');
    return;
  }
  const msg = `Delete all ${all.length} snapshot${all.length === 1 ? '' : 's'}? `
            + (placements.length > 0 ? `This will also clear ${placements.length} placement${placements.length === 1 ? '' : 's'}.` : '');
  if (!await showModal(msg)) return;
  for (const snap of all) {
    try {
      await snapshotDelete(snap.slug);
    } catch (e) {
      console.error('Failed to delete snapshot:', e);
      continue;
    }
    if (snap.blobUrl) URL.revokeObjectURL(snap.blobUrl);
    dropSnapshotCache(snap.slug);
  }
  snapshots.clear();
  placements = [];
  selectedSlug = null;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  scheduleRender();
  schedulePlacementsSave();
  snapshotChannel.postMessage({ type: 'bulk-changed' });
}

function snapshotMatches(snap, query) {
  if (!query) return true;
  return `${snap.name} ${snap.character} ${snap.variant}`
    .toLowerCase()
    .includes(query);
}

function refreshSnapshotList() {
  const list = document.getElementById('snapshotList');
  const hint = document.getElementById('snapshotHint');
  list.innerHTML = '';
  const sorted = [...snapshots.values()]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (sorted.length === 0) {
    hint.textContent = 'Empty';
    const empty = document.createElement('div');
    empty.className = 'snapshot-empty';
    empty.innerHTML = `
      <p>No snapshots yet.</p>
      <a class="snapshot-empty-link" href="index.html">Open character editor →</a>
    `;
    list.appendChild(empty);
    return;
  }

  const filtered = sorted.filter(s => snapshotMatches(s, snapshotSearchQuery));
  hint.textContent = snapshotSearchQuery
    ? `${filtered.length}/${sorted.length}`
    : `${sorted.length} snapshot${sorted.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'snapshot-empty';
    empty.innerHTML = `<p>No matches.</p>`;
    list.appendChild(empty);
    return;
  }

  for (const snap of filtered) {
    const placed = !!placementBySlug(snap.slug);
    const selected = placed && selectedSlug === snap.slug;
    const row = document.createElement('div');
    row.className = 'snapshot-item'
      + (placed ? ' is-placed' : '')
      + (selected ? ' is-selected' : '');
    row.dataset.slug = snap.slug;
    row.tabIndex = 0;
    row.innerHTML = `
      <img class="snapshot-thumb" alt="">
      <div class="snapshot-meta">
        <div class="snapshot-name"></div>
        <div class="snapshot-time"></div>
      </div>
      <button class="snapshot-rename" type="button">Rename</button>
      <button class="snapshot-delete" type="button" aria-label="Delete" title="Delete">&times;</button>
    `;
    row.querySelector('.snapshot-thumb').src = snap.blobUrl;
    row.querySelector('.snapshot-name').textContent = snap.name || snap.slug;
    row.querySelector('.snapshot-time').textContent = relativeTime(snap.createdAt);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.snapshot-delete')) return;
      if (e.target.closest('.snapshot-rename')) return;
      addOrSelectPlacement(snap.slug);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        addOrSelectPlacement(snap.slug);
      }
    });
    row.querySelector('.snapshot-rename').addEventListener('click', (e) => {
      e.stopPropagation();
      renameSnapshot(snap.slug);
    });
    row.querySelector('.snapshot-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSnapshot(snap.slug);
    });
    list.appendChild(row);
  }
}

// Inspector is always visible. When no placement is selected, controls show
// neutral defaults (X=0, Y=0, scale=1) and are disabled — useful as a quiet
// reminder of the inspector's existence and the value layout. When a slug
// no longer resolves (snapshot deleted in another tab), we fall through to
// the same "no selection" state.
// Clamp a number to the slider's [SCALE_MIN, SCALE_MAX] band. Used in two
// places: when the user types a value into the number input, and when a
// tick-rail button is clicked. Out-of-band values would still render correctly
// but would push the slider thumb to its rail end and detach the two controls'
// displayed values, so we clamp at the input boundary.
const SCALE_MIN = 0.5;
const SCALE_MAX = 3.0;
function clampScale(v) {
  if (!Number.isFinite(v)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
}

function refreshInspector() {
  const placement = selectedSlug ? placementBySlug(selectedSlug) : null;
  const xEl       = document.getElementById('inspectorX');
  const yEl       = document.getElementById('inspectorY');
  const scaleEl   = document.getElementById('inspectorScale');
  const scaleNumEl= document.getElementById('inspectorScaleValue');
  const nameEl    = document.getElementById('inspectorName');
  const toFrontEl = document.getElementById('placementToFront');
  const toBackEl  = document.getElementById('placementToBack');
  const removeEl  = document.getElementById('placementRemove');

  if (!placement) {
    nameEl.textContent     = '(no selection)';
    xEl.value              = 0;
    yEl.value              = 0;
    scaleEl.value          = 1;
    scaleNumEl.value       = '1.00';
    xEl.disabled = yEl.disabled = scaleEl.disabled = scaleNumEl.disabled = true;
    toFrontEl.disabled = toBackEl.disabled = removeEl.disabled = true;
    return;
  }

  xEl.disabled = yEl.disabled = scaleEl.disabled = scaleNumEl.disabled = false;
  removeEl.disabled = false;
  const snap = snapshots.get(placement.slug);
  nameEl.textContent  = snap ? snap.name : placement.slug;
  xEl.value           = placement.x;
  yEl.value           = placement.y;
  scaleEl.value       = placement.scale;
  scaleNumEl.value    = placement.scale.toFixed(2);
  const z = placementZPosition(placement.slug);
  toFrontEl.disabled = !z.canFront;
  toBackEl.disabled  = !z.canBack;
}

async function reloadSnapshots() {
  // Revoke old object URLs and clear image caches before the swap. Cached
  // HTMLImageElements that already finished decoding stay valid for their
  // lifetime even after revoke — but the next load through the cache must
  // not reuse a stale entry that points at the now-revoked URL.
  for (const snap of snapshots.values()) {
    if (snap.blobUrl) URL.revokeObjectURL(snap.blobUrl);
  }
  _snapshotImageCache.clear();
  _placementSpriteCache.clear();

  snapshots = await readSnapshotsFromIDB();
  // Drop placements pointing at slugs that no longer exist (deleted in another
  // tab). Keep the rest — the user shouldn't lose scene state because of an
  // unrelated character-editor action.
  const before = placements.length;
  const beforeSelected = selectedSlug;
  placements = placements.filter(p => snapshots.has(p.slug));
  if (selectedSlug && !snapshots.has(selectedSlug)) selectedSlug = null;
  refreshSnapshotList();
  refreshInspector();
  refreshPlacementOverlays();
  if (placements.length !== before) scheduleRender();
  else if (snapshots.size > 0)      scheduleRender();  // freshly-loaded blob URLs need a re-decode
  if (placements.length !== before || selectedSlug !== beforeSelected) {
    schedulePlacementsSave();
  }
}

// On-canvas overlay layer. One absolutely-positioned div per placement,
// sized to match the rendered sprite rect in display coordinates. Selection
// outline + click/drag handles live here; the actual character pixels are
// inside the canvas below. Overlays survive canvas swaps in drawPreview, so
// pointer capture during a drag is preserved across re-renders.
function refreshPlacementOverlays() {
  const previewContainer = document.getElementById('previewContainer');
  const canvas = previewContainer && previewContainer.querySelector('canvas');
  if (!canvas) return;
  const displayRatio = canvas.clientHeight / CANVAS_H;
  if (!Number.isFinite(displayRatio) || displayRatio <= 0) return;

  const old = new Map();
  for (const el of previewContainer.querySelectorAll('.placement-overlay')) {
    old.set(el.dataset.slug, el);
  }
  // Render z-order: array order — last is topmost. Mirror in DOM stacking so
  // selection outlines stack the same way as the rasterized canvas.
  for (const p of placements) {
    const snap = snapshots.get(p.slug);
    if (!snap) continue;
    let el = old.get(p.slug);
    if (!el) {
      el = document.createElement('div');
      el.className = 'placement-overlay';
      el.dataset.slug = p.slug;
      attachPlacementOverlayHandlers(el);
      previewContainer.appendChild(el);
    } else {
      old.delete(p.slug);
      // Move to end so DOM stacking matches render order (last = topmost).
      previewContainer.appendChild(el);
    }
    const s = intrinsicScaleFor(snap) * p.scale;
    const w = snap.width  * s * displayRatio;
    const h = snap.height * s * displayRatio;
    el.style.left   = `${p.x * displayRatio}px`;
    el.style.top    = `${p.y * displayRatio}px`;
    el.style.width  = `${w}px`;
    el.style.height = `${h}px`;
    el.classList.toggle('is-selected', p.slug === selectedSlug);
  }
  for (const el of old.values()) el.remove();
}

// Attach pointer handlers once per overlay element. Drag uses pointer capture
// so events keep arriving at this overlay even if the cursor leaves the rect
// or a canvas re-render replaces the canvas DOM node beneath it.
function attachPlacementOverlayHandlers(el) {
  let drag = null;

  function selectAndStartDrag(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    selectedSlug = el.dataset.slug;
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    const placement = placementBySlug(selectedSlug);
    if (!placement) return;
    const canvas = document.getElementById('previewContainer').querySelector('canvas');
    const displayRatio = canvas ? canvas.clientHeight / CANVAS_H : 1;
    drag = {
      pointerId:    e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPlaceX:  placement.x,
      startPlaceY:  placement.y,
      displayRatio,
    };
    _dragInProgress = true;
  }

  el.addEventListener('pointerdown', selectAndStartDrag);
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const placement = placementBySlug(selectedSlug);
    if (!placement) return;
    const dx = (e.clientX - drag.startClientX) / drag.displayRatio;
    const dy = (e.clientY - drag.startClientY) / drag.displayRatio;
    placement.x = Math.round(drag.startPlaceX + dx);
    placement.y = Math.round(drag.startPlaceY + dy);
    refreshInspector();
    refreshPlacementOverlays();
    schedulePlacementsSave();
    // No scheduleRender during drag — canvas re-renders take ~100 ms and
    // produce visible lag. The CSS overlay tracks the cursor live; the
    // rasterized character snaps to the new spot on dragend.
  });
  function endDrag(e) {
    const wasDragging = drag && e.pointerId === drag.pointerId;
    if (wasDragging) drag = null;
    _dragInProgress = false;
    if (_pendingReload) {
      _pendingReload = false;
      // Apply whatever cross-tab updates piled up while we were dragging.
      // Our own last save will broadcast outward via storage events too, so
      // both tabs converge a moment later.
      loadPlacements({ preserveSelection: true });
    }
    if (wasDragging) scheduleRender();  // commit the moved character to pixels
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

// --- Preview pipeline (debounced render) ---

let renderTimer = null;
// `delay` is configurable so high-frequency text inputs can use a longer
// settle window than discrete clicks. The render path is ~150–300 ms (a 14 M
// linear-space float roundtrip dominates), so coalescing successive
// keystrokes into a single render after the user pauses is a real win over
// rendering every 30 ms during a typing burst.
function scheduleRender(delay = 30) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    drawPreview();
  }, delay);
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
  // Swap the canvas in place rather than replaceChildren so placement overlay
  // divs (and any captured pointer for an in-flight drag) survive the render.
  const previewContainer = document.getElementById('previewContainer');
  const oldCanvas = previewContainer.querySelector('canvas');
  if (oldCanvas) {
    previewContainer.replaceChild(canvas, oldCanvas);
  } else {
    const loadingMsg = document.getElementById('loadingMsg');
    if (loadingMsg) loadingMsg.remove();
    previewContainer.insertBefore(canvas, previewContainer.firstChild);
  }
  refreshPlacementOverlays();
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

// --- Modals ---

// Resolves to the user-entered string (trimmed by caller), or `null` on
// Cancel / Esc / click-outside. Pre-fills the input with `currentName` and
// auto-selects so user can immediately type a replacement. Enter commits.
function showRenameModal(currentName) {
  return new Promise((resolve) => {
    const overlay     = document.getElementById('renameOverlay');
    const input       = document.getElementById('renameInput');
    const confirmBtn  = document.getElementById('renameConfirm');
    const cancelBtn   = document.getElementById('renameCancel');
    document.getElementById('renameCurrent').textContent = `Current: ${currentName}`;
    input.value = currentName;
    overlay.classList.add('active');
    // Defer focus to next frame so the modal's display:flex transition
    // doesn't suppress the autofocus + select.
    requestAnimationFrame(() => { input.focus(); input.select(); });
    function close(result) {
      overlay.classList.remove('active');
      confirmBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
      input.onkeydown = null;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    confirmBtn.onclick = () => close(input.value);
    cancelBtn.onclick  = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
    };
    document.addEventListener('keydown', onKey);
  });
}

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
    scheduleSceneConfigSave();
  };
  document.getElementById('authorSelect').onchange = (e) => {
    authorId = e.target.value;
    scheduleRender();
    scheduleSceneConfigSave();
  };
  const messageInput = document.getElementById('messageInput');
  messageInput.oninput = (e) => {
    messageText = e.target.value;
    // Render only after a typing pause; mid-burst keystrokes coalesce.
    scheduleRender(400);
    scheduleSceneConfigSave();
  };
  // Blur (and Enter for single-line inputs, but textarea is multi-line) flushes
  // the pending render at the default short delay so the canvas commits as
  // soon as the user moves focus away.
  messageInput.onchange = () => scheduleRender();
  for (const b of document.querySelectorAll('#localeSelector .preset-btn')) {
    b.addEventListener('click', () => {
      setLocale(b.dataset.locale);
      scheduleSceneConfigSave();
    });
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
    // Reset clears placements but never deletes snapshots — those persist
    // across sessions and may be expensive to recreate. Clearing the snapshot
    // library belongs in each row's delete button.
    placements = [];
    selectedSlug = null;
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    scheduleRender();
    schedulePlacementsSave();
    scheduleSceneConfigSave();
  };
  document.getElementById('exportBtn').onclick = exportPng;

  // Snapshot library controls: search filter + bulk delete buttons.
  const snapshotSearch = document.getElementById('snapshotSearch');
  snapshotSearch.oninput = (e) => {
    snapshotSearchQuery = e.target.value.trim().toLowerCase();
    refreshSnapshotList();
  };
  document.getElementById('deleteUnusedBtn').onclick = deleteUnusedSnapshots;
  document.getElementById('deleteAllBtn').onclick    = deleteAllSnapshots;
  // Closing the Manage accordion clears any active search query — otherwise
  // the list would stay silently filtered with no visible reason once the
  // search input is hidden inside the collapsed accordion.
  document.getElementById('snapshotManage').addEventListener('toggle', (e) => {
    if (!e.target.open && snapshotSearchQuery) {
      snapshotSearchQuery = '';
      snapshotSearch.value = '';
      refreshSnapshotList();
    }
  });

  // Snapshot library: initial scan + listen for cross-tab updates. The
  // BroadcastChannel does not deliver back to the sender, so the writer page
  // (currently always the character editor) doesn't double-handle its own
  // writes — we only get messages originating in another tab.
  await reloadSnapshots();
  // Restore placements after the snapshot Map is populated so loadPlacements
  // can filter out orphaned slugs against live IDB state.
  loadPlacements();
  // Restore non-placement scene state (locale / bg / author / message / scene
  // type) — render=false because the init's await drawPreview() below will
  // produce the first render anyway, and we want a single render not two.
  loadSceneConfig({ render: false });
  snapshotChannel.addEventListener('message', () => { reloadSnapshots(); });
  // Cross-tab sync. The `storage` event fires in *other* same-origin tabs
  // when localStorage changes here — sender doesn't see its own write, so no
  // echo loop. Placement reloads defer while a local drag is active to avoid
  // clobbering in-flight motion; config reloads fire immediately (rare,
  // discrete events).
  window.addEventListener('storage', (e) => {
    if (e.key === PLACEMENTS_KEY) {
      if (_dragInProgress) { _pendingReload = true; return; }
      loadPlacements({ preserveSelection: true });
    } else if (e.key === SCENE_CONFIG_KEY) {
      loadSceneConfig();
    }
  });

  // Inspector controls. Each writes to the selected placement, refreshes the
  // overlay (selection outline tracks geometry live), and saves. Whether we
  // re-render the canvas depends on the input: continuous controls (X/Y
  // typing or arrow-hold, scale slider drag) defer rendering until commit
  // (input blur / slider release) because each render takes ~100 ms.
  function withSelected(fn, { render = true } = {}) {
    const p = selectedSlug ? placementBySlug(selectedSlug) : null;
    if (!p) return;
    fn(p);
    refreshPlacementOverlays();
    refreshInspector();
    if (render) scheduleRender();
    schedulePlacementsSave();
  }
  const inspectorX = document.getElementById('inspectorX');
  const inspectorY = document.getElementById('inspectorY');
  const inspectorScale = document.getElementById('inspectorScale');
  inspectorX.oninput  = (e) => withSelected(p => { p.x = Number(e.target.value) || 0; }, { render: false });
  inspectorY.oninput  = (e) => withSelected(p => { p.y = Number(e.target.value) || 0; }, { render: false });
  inspectorX.onchange = () => scheduleRender();
  inspectorY.onchange = () => scheduleRender();
  const inspectorScaleNum = document.getElementById('inspectorScaleValue');
  // Slider drag → number input mirrors. Render is deferred until pointer-up
  // (onchange) so the scale slider stays fluid during continuous drags.
  inspectorScale.oninput = (e) => {
    const v = clampScale(Number(e.target.value));
    inspectorScaleNum.value = v.toFixed(2);
    withSelected(p => { p.scale = v; }, { render: false });
  };
  inspectorScale.onchange = () => scheduleRender();
  // Number input direct entry. `oninput` updates the slider live as the user
  // types (so dragging-from-the-spinner feels parallel to the slider drag);
  // `onchange` clamps and snaps the displayed string on commit (Enter / blur)
  // and triggers the actual scene render.
  inspectorScaleNum.oninput = (e) => {
    const v = clampScale(Number(e.target.value));
    inspectorScale.value = v;
    withSelected(p => { p.scale = v; }, { render: false });
  };
  inspectorScaleNum.onchange = (e) => {
    const v = clampScale(Number(e.target.value));
    e.target.value = v.toFixed(2);
    inspectorScale.value = v;
    withSelected(p => { p.scale = v; }, { render: false });
    scheduleRender();
  };
  document.getElementById('placementRemove').onclick = () => {
    if (selectedSlug) removePlacement(selectedSlug);
  };
  document.getElementById('placementToFront').onclick = () => {
    if (selectedSlug && bringPlacementToFront(selectedSlug)) refreshInspector();
  };
  document.getElementById('placementToBack').onclick = () => {
    if (selectedSlug && sendPlacementToBack(selectedSlug)) refreshInspector();
  };

  await drawPreview();
})();

// --- Background-click deselect ---
// Any pointerdown reaching previewArea is by definition outside a placement
// overlay (overlay handlers stopPropagation), so use it to clear selection.
document.getElementById('previewArea').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (selectedSlug !== null) {
    selectedSlug = null;
    refreshSnapshotList();
    refreshInspector();
    refreshPlacementOverlays();
    schedulePlacementsSave();
  }
});

// --- Drawer (mobile bottom sheet) ---
document.getElementById('drawerToggle').onclick   = () => document.body.classList.add('drawer-open');
document.getElementById('drawerBackdrop').onclick = () => document.body.classList.remove('drawer-open');
document.getElementById('drawerClose').onclick    = () => document.body.classList.remove('drawer-open');
