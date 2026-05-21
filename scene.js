// Bump on every deploy to invalidate stale browser caches of JSON/PNG assets.
// Also bump the matching ?v= on styles.css and scene.js in scene.html.
const BUILD_VERSION = '20260519f';
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
//   scene/adv/         — UI sprites + meta.json baked by extract_scene_adv.py.
//                         meta.json is one consolidated layout file with the
//                         four prefabs (NormalPrinter / AutoToggle /
//                         ControlPanel / WitchBookButtonUI), pre-filtered to
//                         only leaves visible at rest. Each layer's `file`
//                         resolves to `${SCENE_ADV_ROOT}/<basename>.png`.
//   scene/backgrounds/ — main/, stills/, and meta.json (the bg picker index).
//   scene/authors.json — slim author metadata (id, nameColor_hex,
//                         tagged_name) baked from characters/configuration.json
//                         by build_scene_authors.py.
const SCENE_ROOT       = 'scene';
const SCENE_ADV_ROOT   = `${SCENE_ROOT}/adv`;
const SCENE_BG_ROOT    = `${SCENE_ROOT}/backgrounds`;
// Trial-only HUD prefabs (currently just DebateUI: clock + fast-skip button).
// Lives in its own sub-root because the trial bundle and the adv bundle are
// extracted by different scripts and ship disjoint sprite sets.
const SCENE_TRIAL_ROOT = `${SCENE_ROOT}/trial`;

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
const LOCALES = new Set(['ko', 'ja', 'zh-Hans']);
const SCENE_TYPES = new Set(['adv', 'trial']);
let sceneType = 'adv';              // one of SCENE_TYPES — drives field visibility + render dispatch
let locale = 'ko';                  // one of LOCALES
let messageText = '';
let authorId = '';                  // resolved to the first available entry on init
let bgPath = null;                  // null = solid black

// Trial scene state. The renderer (scene_court.js) is loaded lazily on first
// trial render — Adv-only sessions never pay the Three.js download cost.
//
// Camera state is held as the *direct* values (yaw multiplier / distance /
// height / pitch / roll). The Look character / Composition / Zoom dropdowns
// are snap-to-preset shortcuts — picking one writes the corresponding direct
// values onto the sliders and number inputs. Any subsequent slider drag or
// number input edit moves the camera away from the preset (the dropdowns
// don't auto-update to reflect that, by design — they remain whatever the
// user last clicked). `trialLookStandIdx` is the integer stand index the
// camera looks at (or null = no look target).
const TRIAL_PREFABS = new Set(['court', 'court_final']);
// Mirrors of scene_court.js's ZOOM_LEVELS / COMPOSITIONS. Duplicated so the
// template-snap helpers don't need to await the lazy court module import on
// dropdown change. Keep in sync if scene_court.js's tables ever shift.
const TRIAL_ZOOM_LEVELS = {
  1: { D: 10, H: 5.2 },
  2: { D: 11, H: 5.3 },
  3: { D: 12, H: 5.5 },
  4: { D: 13, H: 5.6 },
};
const TRIAL_COMPOSITIONS = { center: 0, left: +0.1, right: -0.1 };

let trialPrefab      = 'court';

// --- Stand slots (snapshot placements for the 3D court) ---
//
// One array per prefab, length == stand count (13 for "court", 14 for
// "court_final"). Each cell holds a snapshot slug (string) or null (empty).
// The same `snapshots` Map is the source of truth for the blob & metadata;
// stand slots only persist *which slug goes on which stand*. Lazy-initialised
// to all-nulls on first access so the adv-only path doesn't allocate them.
//
// Stand slots are independent across prefabs by design — switching between
// "13 stands" and "14 stands" reveals each prefab's own assignment untouched,
// so the user can prep both layouts in parallel.
let trialStandSlots = { court: null, court_final: null };
// Which stand row is currently "active" in the UI. Empty stands become active
// when clicked; clicking a library snapshot then drops it into the active
// stand (or selects a non-empty stand for the placement inspector). null when
// no stand is selected — initial state, and the state after the user removes
// a placement or switches prefabs.
let trialSelectedStand = null;
// Camera look-target stand index, or null = "no look target" (off-preset
// after a non-preset slider drag). Resolved into a yaw via the formula
// `yawMult = standIdx + composition` in applyYawMultFromTemplate. Replaces
// the older `trialLookChar` (character-id-keyed) lookup — stand indices are
// directly meaningful to the camera math, so dropping the character-id
// indirection lets the look-pill row track whatever the user actually placed
// on each stand, not a fixed canonical roster.
let trialLookStandIdx = 0;

let trialComposition = 'center';     // template; 'center' | 'left' | 'right'
let trialZoom        = 1;            // template; 1..4
// Direct camera params — these are what get sent to setCamera each render.
// Defaults match the snap-from-templates above (ema=0, comp=0, zoom 1 = D=10
// H=5.2), so a fresh page initialised from defaults produces identical output
// to the previous "templates only" implementation. Roll + pitch have no
// templates — they're slider-only.
let trialYawMult  = 0;
let trialDistance = 10;
let trialHeight   = 5.2;
let trialRollDeg  = 0;               // free numeric, no preset shortcut
let trialPitchDeg = 0;
// Advanced mode gates the direct-camera controls: the yaw multiplier /
// distance / height sliders under the Look character / Zoom groups, and
// the standalone Roll and Pitch groups below them.
let trialAdvancedMode = false;

// Trial scenes carry one of two "subtypes" inside the courtroom:
//   adv    — the same NormalPrinter/AutoToggle/ControlPanel/WitchBookButtonUI
//            overlay set used by Adv scenes (matches Naninovel's BeginAdv /
//            EndAdv blocks inside BeginTrial).
//   debate — the cross-examination overlay set (DebateUI, ChoiceButtons,
//            ChoiceEvidence, etc. — matches BeginDebate / EndDebate). Not
//            yet implemented; the renderer falls through to the bare 3D
//            court for this subtype.
const TRIAL_SUBTYPES = new Set(['adv', 'debate']);
let trialSubtype = 'adv';

let sceneMeta = null;               // scene/adv/meta.json: { canvas_size, prefabs: [...] }
let trialMeta = null;               // scene/trial/meta.json: trial-only HUD prefabs (DebateUI etc.)
// TMP TrialsClockFont sprite atlas (digits 0-9 + colon) for the debate
// timer. Each entry: { tag, file, rect:[W,H], metrics:{width,height,
// horizontalBearingX, horizontalBearingY, horizontalAdvance}, scale }.
// `byTag` is a derived Map for O(1) lookup per character at render time.
let trialDigitsMeta  = null;
let trialDigitsByTag = null;
let charsConfig = null;
let bgMeta = null;
let renderSeq = 0;

// Per-overlay enable flags. Names match the strings used in scene/adv/meta.json's
// `toggle` / `items_toggle` fields — see TOGGLE_FLAGS below. NormalPrinter has
// `toggle: null` (the dialog frame is the scene's anchor; toggling it off would
// leave just background + buttons floating, which isn't useful).
//
// Two parallel sets of state, one per sceneType. Adv- and trial-with-adv-overlays
// renders share the same overlay machinery (selectPrefabItems + the prefab loop
// in renderScene), so the toggle *names* are the same — TOGGLE_FLAGS routes
// each name through a sceneType-aware getter that picks the right backing var.
// Lets the user e.g. hide the witch book in trial-adv without affecting the
// pure Adv preview.
let showAutoToggle = true;          // gates the AutoToggle prefab (adv)
let showMenuButton = true;          // gates the ControlPanel prefab (adv)
let showBookButton = true;          // gates the WitchBookButtonUI prefab (adv)
// Toggles NamePlateBase sprite + AuthorLabel text together (both live under
// NormalPrinter's `Wrapper/AuthorPanel` subtree). One switch covers both
// because rendering the plate without text — or text without a plate — would
// look broken; the user thinks of the plate as a single unit.
let showAuthorPlate = true;
// Mirror set for trial-with-adv-overlays.
let trialShowAutoToggle = true;
let trialShowMenuButton = true;
let trialShowBookButton = true;
let trialShowAuthorPlate = true;
// Debate-subtype book-button flag, independent of trialShowBookButton so the
// user can keep the button on in trial-adv while hiding it in trial-debate
// (and vice versa). Routed by TOGGLE_FLAGS.showBookButton on trialSubtype.
let trialDebateShowBookButton = true;
// Debate-only HUD toggles (DebateUI prefab from scene/trial/meta.json).
//   trialDebateShowClock         → ClockBase (sidebar switch)
//   trialDebateShowFastButton    → FastButtonBase + FastIcon visibility
//                                  (sidebar switch)
//   trialDebateFastIconActive    → FastIcon color state, click-toggled in
//                                  the preview:
//                                    true  (active)   → yellow [1.0, 0.941, 0.502, 1]
//                                    false (inactive) → white  [1.0, 1.0, 1.0, 0.753]
// The two colors come straight from the prefab: the yellow is FastIcon's
// own `m_Color`; the white-with-alpha lives on a second MonoBehaviour
// attached to the same GameObject (an `IgnoreCasterColor`-style component)
// the game's runtime swaps in when auto-skip is off.
let trialDebateShowClock      = true;
let trialDebateShowFastButton = true;
// Default inactive (white-faded) — matches the game's idle state when
// auto-skip isn't engaged. User clicks the button in the preview to switch
// to the yellow "active" tint.
let trialDebateFastIconActive = false;
const FAST_ICON_INACTIVE_COLOR = [1.0, 1.0, 1.0, 0.7529411911964417];
// Timer text displayed inside the ClockBase plate. In-game this is a TMP
// sprite-tag countdown rendered via the TrialsClockFont digit atlas. We
// don't simulate the countdown — every render re-rolls a fresh random
// "MM:SS:SSS" string so the editor's debate preview reads as a live timer
// without the user having to type anything (or stare at a frozen value).
function randomTimerText() {
  const mm  = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const ss  = String(Math.floor(Math.random() *  60)).padStart(2, '0');
  const sss = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${mm}:${ss}:${sss}`;
}
// Trial-side AuthorLabel + MessageLabel content. Separate from the adv-side
// `authorId` / `messageText` so a user can pose a trial line ("Objection!")
// without overwriting the adv preview's dialog, and vice versa.
// Default trialAuthorId mirrors the adv default (DEFAULT_AUTHOR — see
// populateAuthorSelects); resolved properly once charsConfig loads.
let trialAuthorId    = '';
let trialMessageText = '';

// Debate-subtype state. trialDebateText is the testimony body (use '<br>' for
// line breaks, matching Naninovel's @printDebate convention); X/Y are the
// script's ScenePosition (percent of canvas, top-left origin), with defaults
// matching the most common in-game value (pos:70,50 — right side, middle).
let trialDebateText = '';
let trialDebatePosX = 70;
let trialDebatePosY = 50;

// Trial choice UI overlay (debate subtype). In-game the cross-examination's
// objection press-points open the Trial choice screen — a witness portrait
// panel plus N runtime-instantiated ChoiceButton_Trial widgets. In the editor
// this is driven by a toggle instead of a click.
//   trialDebateShowChoiceUI — master on/off for the overlay.
//   trialChoicePortrait     — which TrialChoicePanel@<x> chrome ('Hiro'|'Ema').
//   trialChoiceButtons      — ordered list of { variant, label }; `variant` is
//     the suffix of a ChoiceButton_Trial@<variant> prefab ('' = plain, no tag).
//     Cancel is NOT in this list — it's appended implicitly as the column tail.
//   trialChoiceCancelLabel  — label text for the always-present Cancel button.
// See docs/trial_ui_compositing.md for the panel + layout-group geometry.
let trialDebateShowChoiceUI = false;
let trialChoicePortrait     = 'Hiro';
let trialChoiceButtons      = defaultTrialChoiceButtons();   // see definition
let trialChoiceCancelLabel  = 'Cancel';

// Resolve the "active" author / message based on sceneType, so the shared
// text-rendering path in renderTextLeaf doesn't need to know about subtypes.
// (Adv scenes always read the adv-side state; trial scenes always read the
// trial-side state, regardless of subtype — debate renders no overlays
// today, so the value is unused there but kept consistent for future use.)
function activeAuthorId()    { return sceneType === 'trial' ? trialAuthorId    : authorId; }
function activeMessageText() { return sceneType === 'trial' ? trialMessageText : messageText; }

// String → live-state lookup. The bake script writes these names into
// meta.json; this table is the single point of resolution at render time.
// Adding a new toggle = add an entry here AND in PREFABS in extract_scene_adv.py.
const TOGGLE_FLAGS = {
  showAutoToggle:  () => (sceneType === 'trial' ? trialShowAutoToggle : showAutoToggle),
  showMenuButton:  () => (sceneType === 'trial' ? trialShowMenuButton : showMenuButton),
  // showBookButton has three live backings: adv scene (showBookButton),
  // trial-adv (trialShowBookButton), trial-debate (trialDebateShowBookButton).
  // Splitting by subtype lets a user hide the book in debate without losing
  // their adv-side overlay state.
  showBookButton:  () => {
    if (sceneType !== 'trial') return showBookButton;
    return trialSubtype === 'debate' ? trialDebateShowBookButton : trialShowBookButton;
  },
  showAuthorPlate: () => (sceneType === 'trial' ? trialShowAuthorPlate : showAuthorPlate),
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
// character id → [pivot_x, pivot_y] (Vector2 from Naninovel CharacterMetadata).
// Populated from scene/authors.json. Used by the trial 3D renderer to position
// each character's display quad on the world Y axis — pivot.y is the load-
// bearing field. See scene_court.js's buildCharacterBillboard for the formula
// `planeCenterY = characterPositionY + (0.5 − pivot.y) · canvasSize.y · @charScale.y`.
let characterPivots = new Map();
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

// --- ScenePosition (Naninovel) ↔ placement (canvas pixels) ---
//
// Placements store top-left pixel coords; the inspector exposes them as
// Naninovel ScenePosition %, anchored at the actor's transform.position
// (== Naninovel ScenePos semantics). The preview canvas is CANVAS_W ×
// CANVAS_H = the game's ReferenceResolution (2560×1440), so % maps 1:1 to
// pixels — but actor.position is OFFSET from the rig/sprite centre that
// snap.pivotY represents:
//
//   actor.position lands at CharacterMetadata.Pivot OF THE BOUNDS, where
//   "bounds" is the 15×30 m RenderCanvas for layered actors (much bigger
//   than the visible rig) or the sprite m_Rect for diced actors.
//
// For Ema (layered, pivot.y=0.695), actor.position sits 5.85 m above the
// rig centre — so ScenePosY=50 (= actor at canvas centre) means the rig
// centre is 585 px BELOW canvas centre, NOT at it. Without the offset,
// the editor would render Ema with her head off the canvas top.
//
// Diced actors use snap.width/height × intrinsic × scale as the bounds
// approximation. The cropped snap is slightly smaller than the atlas
// m_Rect Naninovel uses (~85% for Yuki), so the offset is mildly under-
// estimated; in practice this is a few % of canvas height — well below
// what a user notices.
//
// Old snapshots without pivotX/pivotY default to the snap centre. Snaps
// from a character not in characterPivots (missing authors.json entry)
// default pivot to (0.5, 0.5) → zero offset.
const LAYERED_RENDER_CANVAS_W_PX = 1500;   // 15 m × PPU 100
const LAYERED_RENDER_CANVAS_H_PX = 3000;   // 30 m × PPU 100

function snapPivotPx(snap) {
  if (!snap) return [0, 0];
  const px = Number.isFinite(snap.pivotX) ? snap.pivotX : snap.width  / 2;
  const py = Number.isFinite(snap.pivotY) ? snap.pivotY : snap.height / 2;
  return [px, py];
}
function actorBoundsPx(snap, placementScale) {
  if (!snap) return [0, 0];
  if (snap.charType === 'diced') {
    const s = intrinsicScaleFor(snap) * placementScale;
    return [snap.width * s, snap.height * s];
  }
  return [LAYERED_RENDER_CANVAS_W_PX * placementScale,
          LAYERED_RENDER_CANVAS_H_PX * placementScale];
}
function pivotOffsetCanvasPx(snap, placementScale) {
  if (!snap) return [0, 0];
  const pivot = characterPivots.get(snap.character) || [0.5, 0.5];
  const [bw, bh] = actorBoundsPx(snap, placementScale);
  // pivot.y > 0.5 ⇒ actor above rig centre in world Y-up ⇒ SMALLER canvas y
  // (Y-down). Same logic for x: pivot.x > 0.5 ⇒ actor right of rig centre.
  return [-(pivot[0] - 0.5) * bw, -(pivot[1] - 0.5) * bh];
}
function placementToSceneX(placement, snap) {
  if (!snap) return 50;
  const s = intrinsicScaleFor(snap) * placement.scale;
  const [px] = snapPivotPx(snap);
  const [ox] = pivotOffsetCanvasPx(snap, placement.scale);
  return ((placement.x + px * s + ox) / CANVAS_W) * 100;
}
function placementToSceneY(placement, snap) {
  if (!snap) return 50;
  const s = intrinsicScaleFor(snap) * placement.scale;
  const [, py] = snapPivotPx(snap);
  const [, oy] = pivotOffsetCanvasPx(snap, placement.scale);
  return ((CANVAS_H - (placement.y + py * s + oy)) / CANVAS_H) * 100;
}
function sceneXToPlacementX(sceneX, placement, snap) {
  if (!snap) return placement.x;
  const s = intrinsicScaleFor(snap) * placement.scale;
  const [px] = snapPivotPx(snap);
  const [ox] = pivotOffsetCanvasPx(snap, placement.scale);
  return Math.round((sceneX / 100) * CANVAS_W - px * s - ox);
}
function sceneYToPlacementY(sceneY, placement, snap) {
  if (!snap) return placement.y;
  const s = intrinsicScaleFor(snap) * placement.scale;
  const [, py] = snapPivotPx(snap);
  const [, oy] = pivotOffsetCanvasPx(snap, placement.scale);
  return Math.round(CANVAS_H * (1 - sceneY / 100) - py * s - oy);
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
      sceneType,
      locale,
      bgPath,
      authorId,
      messageText,
      // Trial state — saved unconditionally so a user can flip back from Adv
      // to Trial and find their previous camera setup intact. Templates
      // (lookChar, composition, zoom) and direct values (yawMult, distance,
      // height) are both saved so the dropdowns restore to whatever the user
      // last clicked, while the actual rendered camera stays at whatever
      // they last dragged the sliders to.
      trialPrefab,
      // Per-prefab stand-slot arrays. Null prefab entries (lazy-uninitialised)
      // are saved as null and restored as such on load; the lazy-seed path
      // populates them on first access.
      trialStandSlots,
      trialSubtype,
      trialAuthorId,
      trialMessageText,
      // Debate-subtype state (text + ScenePosition X/Y).
      trialDebateText,
      trialDebatePosX,
      trialDebatePosY,
      // Trial choice screen overlay (debate subtype).
      trialDebateShowChoiceUI,
      trialChoicePortrait,
      trialChoiceButtons,
      trialChoiceCancelLabel,
      // trialLookStandIdx replaces the older trialLookChar (character-id-keyed)
      // — see the state declaration for why. Saved as an integer or null.
      trialLookStandIdx,
      trialComposition,
      trialZoom,
      trialYawMult,
      trialDistance,
      trialHeight,
      trialRollDeg,
      trialPitchDeg,
      trialAdvancedMode,
      // Trial-side overlay toggles (only consumed when trialSubtype === 'adv';
      // saved unconditionally so a user can flip subtype and find their
      // previous toggle state intact).
      trialShowAutoToggle,
      trialShowMenuButton,
      trialShowBookButton,
      trialShowAuthorPlate,
      trialDebateShowBookButton,
      trialDebateShowClock,
      trialDebateShowFastButton,
      trialDebateFastIconActive,
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

  if (SCENE_TYPES.has(data.sceneType) && data.sceneType !== sceneType) {
    sceneType = data.sceneType;
    document.getElementById('sceneTypeSelect').value = sceneType;
    if (sceneType === 'trial') {
      // Fire-and-forget: populates the look-character dropdown once the
      // module loads. The dropdown sits in a hidden field until the user
      // picks a value, so a brief empty-state during the import is fine.
      ensureTrialUIInit();
    }
  }
  // Restore advanced-mode flag before the visibility apply so the gated
  // slider rows render hidden vs visible correctly on load.
  if (typeof data.trialAdvancedMode === 'boolean') {
    trialAdvancedMode = data.trialAdvancedMode;
    document.getElementById('trialAdvancedToggle').classList.toggle('active', trialAdvancedMode);
  }
  // Restore trial subtype before the visibility apply so subtype-gated rows
  // (the trial-side overlay toggle group) end up correctly hidden/shown.
  if (TRIAL_SUBTYPES.has(data.trialSubtype)) {
    trialSubtype = data.trialSubtype;
    refreshTrialSubtypeActive();
  }
  // Restore trial-side overlay toggles. Each writes its module-level flag and
  // syncs the corresponding checkbox; doesn't touch the adv-side toggles.
  const trialToggleRestores = [
    ['trialShowAutoToggle',       'toggleTrialAutoToggle',      (v) => { trialShowAutoToggle       = v; }],
    ['trialShowMenuButton',       'toggleTrialMenuButton',      (v) => { trialShowMenuButton       = v; }],
    ['trialShowBookButton',       'toggleTrialBookButton',      (v) => { trialShowBookButton       = v; }],
    ['trialShowAuthorPlate',       'toggleTrialAuthorPlate',      (v) => { trialShowAuthorPlate       = v; }],
    ['trialDebateShowBookButton',  'toggleTrialDebateBookButton',  (v) => { trialDebateShowBookButton  = v; }],
    ['trialDebateShowClock',       'toggleTrialDebateClock',       (v) => { trialDebateShowClock       = v; }],
    ['trialDebateShowFastButton',  'toggleTrialDebateFastButton',  (v) => { trialDebateShowFastButton  = v; }],
  ];
  // FastIcon active/inactive: click-toggled in the preview, no checkbox.
  // Migration from the intermediate tri-state `trialDebateFastIconState`
  // ('active'|'inactive'|'hidden'): map the show-flag from !=='hidden' and
  // active from ==='active'. Old boolean `trialDebateShowFastButton` is
  // handled via the regular trialToggleRestores loop above.
  if (typeof data.trialDebateFastIconActive === 'boolean') {
    trialDebateFastIconActive = data.trialDebateFastIconActive;
  } else if (typeof data.trialDebateFastIconState === 'string') {
    trialDebateShowFastButton = data.trialDebateFastIconState !== 'hidden';
    trialDebateFastIconActive = data.trialDebateFastIconState === 'active';
    const el = document.getElementById('toggleTrialDebateFastButton');
    if (el) el.checked = trialDebateShowFastButton;
  }
  for (const [field, elId, set] of trialToggleRestores) {
    if (typeof data[field] === 'boolean') {
      set(data[field]);
      const el = document.getElementById(elId);
      if (el) el.checked = data[field];
    }
  }
  applySidebarVisibility();

  // Trial state — apply individually to dropdowns/inputs, but skip the
  // look-character dropdown if it's not populated yet (the value is held in
  // the module-level `trialLookStandIdx` and will be picked up by the next
  // populate or render).
  if (TRIAL_PREFABS.has(data.trialPrefab)) {
    trialPrefab = data.trialPrefab;
    document.getElementById('trialPrefab').value = trialPrefab;
  }
  // Stand-slot maps: validated per-prefab. Each entry must be an array of
  // length N whose elements are either null or a string slug that still
  // exists in `snapshots` (orphans get nulled out). On any structural
  // failure for a given prefab we leave that map as null so the lazy-seed
  // path runs on first access.
  if (data.trialStandSlots && typeof data.trialStandSlots === 'object') {
    for (const prefab of TRIAL_PREFABS) {
      const raw = data.trialStandSlots[prefab];
      if (raw === null) continue;
      if (!Array.isArray(raw)) continue;
      const n = trialStandCount(prefab);
      if (raw.length !== n) continue;
      const cleaned = new Array(n).fill(null);
      let ok = true;
      for (let i = 0; i < n; i++) {
        const v = raw[i];
        if (v === null) { cleaned[i] = null; continue; }
        if (typeof v !== 'string') { ok = false; break; }
        // Snapshot library may not be loaded yet here — keep the slug as
        // long as it's a string; reloadSnapshots later nulls out anything
        // that doesn't resolve.
        cleaned[i] = v;
      }
      if (ok) trialStandSlots[prefab] = cleaned;
    }
  }
  if (Number.isInteger(data.trialLookStandIdx) && data.trialLookStandIdx >= 0) {
    trialLookStandIdx = data.trialLookStandIdx;
    refreshTrialLookCharActive();
  } else if (data.trialLookStandIdx === null) {
    trialLookStandIdx = null;
    refreshTrialLookCharActive();
  }
  // trialZoom is *derived* from (trialDistance, trialHeight) — restoring
  // the saved value here is just a hint; the authoritative recompute below
  // (after distance/height are restored) will overwrite it. Handles null /
  // the legacy 1..4 forms equivalently.
  if (data.trialZoom === null
      || (Number.isInteger(data.trialZoom) && data.trialZoom >= 1 && data.trialZoom <= 4)) {
    trialZoom = data.trialZoom;
    refreshTrialZoomActive();
  }
  // Accept '' as the "no preset selected" sentinel set by setTrialYawMult,
  // alongside the three real preset names. Without this, a saved '' falls
  // through and the in-memory default 'center' wins — which would re-mark
  // the Center pill active after a reload even though yaw is non-preset.
  if (data.trialComposition === ''
      || ['center', 'left', 'right'].includes(data.trialComposition)) {
    trialComposition = data.trialComposition;
    refreshTrialCompositionActive();
  }
  // Roll: numeric trialRollDeg supersedes the old preset string. If a stale
  // saved record only has the string form (`trialRoll`), translate it
  // to the equivalent numeric value (none=0, right=+5, left=-5) using the
  // same mapping the renderer's old preset table used.
  if (Number.isFinite(data.trialRollDeg)) {
    trialRollDeg = data.trialRollDeg;
  } else if (typeof data.trialRoll === 'string') {
    trialRollDeg = ({ none: 0, right: +5, left: -5 })[data.trialRoll] ?? 0;
  }
  syncRollUI();
  if (Number.isFinite(data.trialPitchDeg)) {
    trialPitchDeg = data.trialPitchDeg;
  }
  syncPitchUI();
  // Direct camera values — restore last so a saved override survives even if
  // the dropdowns above also restore (the slider/number show whatever the
  // user last set, regardless of which template the dropdowns are currently
  // pointing at). Fall back to the template-derived value when the saved
  // record predates this slider feature (no trialYawMult/etc. fields).
  if (Number.isFinite(data.trialYawMult)) {
    trialYawMult = data.trialYawMult;
  } else {
    const compShift = TRIAL_COMPOSITIONS[trialComposition] ?? 0;
    trialYawMult = trialTargetIdx() + compShift;
  }
  syncYawMultUI();
  if (Number.isFinite(data.trialDistance)) {
    trialDistance = data.trialDistance;
  } else {
    trialDistance = (TRIAL_ZOOM_LEVELS[trialZoom] || TRIAL_ZOOM_LEVELS[1]).D;
  }
  syncDistanceUI();
  if (Number.isFinite(data.trialHeight)) {
    trialHeight = data.trialHeight;
  } else {
    trialHeight = (TRIAL_ZOOM_LEVELS[trialZoom] || TRIAL_ZOOM_LEVELS[1]).H;
  }
  syncHeightUI();
  // Authoritative recompute of the zoom pill state from the now-restored
  // (D, H) pair. Overrides whatever the saved trialZoom hint said — saves
  // can be inconsistent (e.g. a stale value persisted before a slider
  // edit), so the pill state should always reflect what the camera actually
  // is now.
  syncZoomPillFromDH();

  if (LOCALES.has(data.locale)) {
    const changed = data.locale !== locale;
    locale = data.locale;
    for (const b of document.querySelectorAll('#localeSelector .preset-btn')) {
      b.classList.toggle('active', b.dataset.locale === locale);
    }
    if (changed) populateAuthorSelect();
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

  // Trial-side author / message. Same shape as the adv-side handling above:
  // option-membership check for the dropdown, active-element guard for the
  // textarea so cross-tab sync doesn't clobber in-progress typing.
  if (typeof data.trialAuthorId === 'string') {
    const tSel = document.getElementById('trialAuthorSelect');
    if (tSel && [...tSel.options].some(o => o.value === data.trialAuthorId)) {
      trialAuthorId = data.trialAuthorId;
      tSel.value = trialAuthorId;
    }
  }
  const trialMsgEl = document.getElementById('trialMessageInput');
  if (typeof data.trialMessageText === 'string' && document.activeElement !== trialMsgEl) {
    trialMessageText = data.trialMessageText;
    if (trialMsgEl) trialMsgEl.value = trialMessageText;
  }

  // Debate text/X/Y — same active-element guard for the textarea so cross-tab
  // sync doesn't clobber in-progress typing.
  const debateTextEl = document.getElementById('trialDebateInput');
  if (typeof data.trialDebateText === 'string' && document.activeElement !== debateTextEl) {
    trialDebateText = data.trialDebateText;
    if (debateTextEl) debateTextEl.value = trialDebateText;
  }
  if (Number.isFinite(data.trialDebatePosX)) {
    trialDebatePosX = data.trialDebatePosX;
    syncDebatePosUI('x');
  }
  if (Number.isFinite(data.trialDebatePosY)) {
    trialDebatePosY = data.trialDebatePosY;
    syncDebatePosUI('y');
  }
  // Trial choice screen overlay. The button list is sanitized — unknown
  // variants fall back to plain, non-string labels to empty — so a stale or
  // hand-edited record can't break the renderer.
  if (typeof data.trialDebateShowChoiceUI === 'boolean') {
    trialDebateShowChoiceUI = data.trialDebateShowChoiceUI;
    const el = document.getElementById('toggleTrialChoiceUI');
    if (el) el.checked = trialDebateShowChoiceUI;
  }
  if (TRIAL_CHOICE_PORTRAITS.includes(data.trialChoicePortrait)) {
    trialChoicePortrait = data.trialChoicePortrait;
    refreshTrialChoicePortraitActive();
  }
  if (typeof data.trialChoiceCancelLabel === 'string') {
    trialChoiceCancelLabel = data.trialChoiceCancelLabel;
  }
  if (Array.isArray(data.trialChoiceButtons)) {
    // Drop any persisted Cancel rows — Cancel is now implicit, not a list
    // entry — then sanitize unknown variants to plain and clamp to the budget.
    trialChoiceButtons = data.trialChoiceButtons
      .filter(b => b && typeof b === 'object' && b.variant !== 'Cancel')
      .slice(0, TRIAL_CHOICE_MAX_USER)
      .map(b => ({
        variant: TRIAL_CHOICE_VARIANTS.some(v => v.key === b.variant) ? b.variant : '',
        label:   typeof b.label === 'string' ? b.label : '',
      }));
  }
  renderTrialChoiceList();

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
  const [charRes, bgRes, sceneRes, trialRes, digitsRes] = await Promise.all([
    fetch(assetUrl(`${SCENE_ROOT}/authors.json`)),
    fetch(assetUrl(`${SCENE_BG_ROOT}/meta.json`)),
    fetch(assetUrl(`${SCENE_ADV_ROOT}/meta.json`)),
    fetch(assetUrl(`${SCENE_TRIAL_ROOT}/meta.json`)),
    fetch(assetUrl(`${SCENE_TRIAL_ROOT}/digits/meta.json`)),
  ]);
  charsConfig      = await charRes.json();
  bgMeta           = await bgRes.json();
  sceneMeta        = await sceneRes.json();
  trialMeta        = await trialRes.json();
  trialDigitsMeta  = await digitsRes.json();
  trialDigitsByTag = new Map((trialDigitsMeta.sprites || []).map(s => [s.tag, s]));

  intrinsicScales = new Map();
  characterPivots = new Map();
  for (const c of (charsConfig.characters || [])) {
    const s = Number(c.intrinsic_scale);
    intrinsicScales.set(c.id, Number.isFinite(s) && s > 0 ? s : 1);
    // Per-character pivot from Naninovel's CharacterMetadata (Vector2 in
    // resources.assets). Used by the trial-scene 3D renderer to plant each
    // character's display quad at the correct world y — pivot.y in [0..1]
    // controls how much of the quad sits below the actor's transform.position
    // (= world y=5 in trial scenes), and per-character values vary from 0.52
    // (Warden) to 0.75 (Leia), translating to ~1 m of vertical spread on stage.
    if (Array.isArray(c.pivot) && c.pivot.length === 2) {
      const px = Number(c.pivot[0]);
      const py = Number(c.pivot[1]);
      if (Number.isFinite(px) && Number.isFinite(py)) {
        characterPivots.set(c.id, [px, py]);
      }
    }
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

// Per-layer α multipliers, applied at composite time. Each entry boosts a
// layer's alpha to compensate for blending against our 3D court being brighter
// than the game's actual court — same darkening shape in linear space, but
// landing closer to the in-game look. The boost factor for each layer is
// chosen so the layer's *peak* α saturates to 1.0; the gradient and AA edges
// scale proportionally (and clamp at 1).
//
//   - NamePlateBase    — peak α≈87% (221/255), boosted to 255/221.
//     Translucent main fill, designed to sit softly over NormalPrinter_Screen
//     with the dialog frame bleeding through. The secondary 61% inner-ring
//     peak only rises to ~70% so it stays soft.
//   - NormalPrinter_Screen — peak α≈75% (192/255), boosted to 255/192.
//     Pure-black vertical gradient (transparent at top → ~75% opaque at
//     bottom). RGB is already 0, so α is the only lever — boosting saturates
//     the dialog-band base to a true black while preserving the soft top
//     fade. Other layers pass through untouched.
const LAYER_ALPHA_BOOST = {
  NamePlateBase:        255 / 221,
  NormalPrinter_Screen: 255 / 192,
};

// Render the trial debate timer using TMP TrialsClockFont sprite glyphs.
//
// The text leaf in scene/trial/meta.json carries TMP `<sprite name="X">`
// tags ("03:53:645" via digit sprites + colon); we translate each character
// of the user's free-text input to the corresponding atlas glyph and lay
// them out using the glyph metrics (bearing, advance), mirroring what TMP
// would do at runtime. Characters not present in the atlas are skipped —
// safe enough since the only meaningful glyphs here are 0-9 and ":".
//
// Coordinate convention (matches `m_HorizontalBearingY` semantics):
//   scale       = fontSize × m_Scale / PRIMARY_FONT_POINT_SIZE
//   render_w/h  = m_Width / m_Height × scale
//   bearing_x   = m_HorizontalBearingX × scale
//   bearing_y   = m_HorizontalBearingY × scale  (px above baseline)
//   advance     = m_HorizontalAdvance × scale
//   draw_x_tl   = pen_x + bearing_x
//   draw_y_tl   = baseline_y − bearing_y         (PIL Y-down)
//   pen_x      += advance
//
// The primary font asset's FaceInfo anchors both the sprite glyph size and
// the line's vertical position. These use *different* metric fields:
//
//   • Sprite glyph SIZE  → `font_size / ascentLine`   (visual cap-match)
//     Empirically tuned: atlas rect (64) was 40% oversized; pointSize (90)
//     was 25% undersized; ascentLine (79.2) lands at the in-game size.
//
//   • Line BASELINE (v_align=Top) → ry + ascentLine × (font_size / pointSize)
//     TMP's line-metric formula: line top sits at ry, baseline at
//     ry + line_ascent. `line_ascent` uses `font_size / pointSize` as
//     elementScale (not the cap-match factor) — that's TMP's nominal scale
//     for everything-else-but-the-visible-glyph (bounds, line height,
//     baseline offset). Using the glyph's own `bearingY × glyph_scale` for
//     the baseline misaligns when those two scales diverge, as they do
//     here.
//
// Primary font for the trial label is TsukushiMincho (pointSize=90,
// ascentLine=79.2). Stays the anchor across locales — Korean/Chinese
// builds attach fallback fonts for non-Japanese glyphs but keep TMP's
// metric reference.
const TIMER_PRIMARY_FONT_POINT_SIZE = 90;
const TIMER_PRIMARY_FONT_ASCENT_PX  = 79.2;
async function renderTimerSprites(labelRec, dst, text) {
  if (!text || !trialDigitsMeta || !trialDigitsByTag) return;
  const [rx, ry] = labelRec.pos;
  const [rw]     = labelRec.size;
  const fontSize = labelRec.font_size || 52;
  const glyphs   = [];
  for (const ch of [...text]) {
    const sp = trialDigitsByTag.get(ch);
    if (sp) glyphs.push(sp);
  }
  if (glyphs.length === 0) return;
  const scaleFor = (g) => fontSize * (g.scale || 1) / TIMER_PRIMARY_FONT_ASCENT_PX;
  const totalAdvance = glyphs.reduce((acc, g) => acc + g.metrics.horizontalAdvance * scaleFor(g), 0);
  const blockX = rx + (rw - totalAdvance) / 2;
  // Baseline uses the *line-metric* scale (font_size / pointSize), not the
  // glyph's own bearing — see the constants block for why these diverge.
  const lineAscentPx = TIMER_PRIMARY_FONT_ASCENT_PX * fontSize / TIMER_PRIMARY_FONT_POINT_SIZE;
  const baselineY = ry + lineAscentPx;

  let penX = blockX;
  for (const g of glyphs) {
    const s     = scaleFor(g);
    const w     = Math.max(1, Math.round(g.metrics.width  * s));
    const h     = Math.max(1, Math.round(g.metrics.height * s));
    const dx    = Math.round(penX + g.metrics.horizontalBearingX * s);
    const dy    = Math.round(baselineY - g.metrics.horizontalBearingY * s);
    const sprite = await spriteAtSize(`${SCENE_TRIAL_ROOT}/digits/${g.file}`, w, h);
    compositeLinear(dst, sprite, w, h, dx, dy);
    penX += g.metrics.horizontalAdvance * s;
  }
}

async function renderLayer(layer, dst, root = SCENE_ADV_ROOT) {
  const [tw, th] = layer.size;
  if (tw <= 0 || th <= 0) return;
  let sprite = await spriteAtSize(`${root}/${layer.file}`, tw, th);
  const boostA = LAYER_ALPHA_BOOST[layer.name] || 1;
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
//
// Chinese: the game ships only one Chinese font — Source Han Serif SC
// (general-fonts-sourcehanserifsc_assets_all.bundle). Noto Serif SC is the
// same typeface (Adobe + Google jointly developed Source Han Serif; Google
// rebrands it as Noto Serif), so we use it as the primary.
const FONT_FAMILY = {
  ko:        '"Noto Serif KR", "Noto Serif JP", "Noto Serif CJK KR", "Noto Serif CJK JP", serif',
  ja:        '"Noto Serif JP", "Noto Serif KR", "Noto Serif CJK JP", "Noto Serif CJK KR", serif',
  'zh-Hans': '"Noto Serif SC", "Noto Serif CJK SC", "Noto Serif JP", serif',
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
  for (const fam of ['Noto Serif KR', 'Noto Serif JP', 'Noto Serif SC']) {
    for (const sz of [48, 136]) {
      // 500 covers the +100 bump from the default 400 prefab weight; 700
      // covers the debate-text 600 bump (Bold); 800 covers the bump from
      // the rare 700 case. All must also appear in the Google Fonts <link>
      // in scene.html, otherwise the browser substitutes faux-bold and
      // metrics drift.
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

// Stand-in for TMP's per-material underlay (drop shadow / halo). Two distinct
// looks per leaf, both via Canvas2D's `shadowColor` / `shadowBlur` /
// `shadowOffset*` API rather than the full SDF-shader pipeline (see
// docs/text_shadows.md):
//
//   - MessageLabel → Shadow1-style: soft black halo, centered (no offset),
//     blur ≈ 6/48 of font size, stacked across N passes to deepen.
//   - AuthorLabel → Shadow2/6-style: hard, asymmetric drop. No blur, no
//     X offset, ~1-2 px downward Y offset. Visible only as a thin black
//     hairline on the bottom edge of each glyph stroke.
//
// Each glyph carries its own halo/offset extent rather than inheriting the
// leaf's largest size — important for rich-text where sz=73 sub-glyphs and
// sz=136 main glyphs coexist in AuthorLabel.
const TEXT_SHADOW_COLOR = 'rgba(0, 0, 0, 1)';
// MessageLabel: em-relative blur — TMP's `_UnderlaySoftness` is a normalized
// 0..1 input scaled by the glyph em, not absolute pixels.
const TEXT_SHADOW_BLUR_RATIO_MESSAGE = 6 / 48;
// AuthorLabel: zero blur (hard edge) + downward Y offset. 1.5/136 lands at
// 1.5 px at sz=136 main glyphs and ~0.8 px at sz=73 ruby glyphs — both in
// the "1-2 pixel only on down side" range the in-game capture shows.
const TEXT_SHADOW_BLUR_RATIO_AUTHOR     = 0;
const TEXT_SHADOW_OFFSET_Y_RATIO_AUTHOR = 1.5 / 136;
const AUTHOR_SHADOW_ENABLED = true;
// Canvas2D's shadowBlur spreads the source alpha across the blur radius, so
// peak halo opacity ends up much lower than the source color's alpha. Stacking
// N passes with the shadow enabled multiplies halo density (each pass adds
// another shadow layer) without widening the spread. This trick only helps
// halos — hard-edged offset shadows (AuthorLabel) paint the same silhouette
// at the same place every pass, so 1 pass is enough.
const TEXT_SHADOW_PASSES_MESSAGE = 3;
const TEXT_SHADOW_PASSES_AUTHOR  = 1;

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
  const rawLines = s.split('\n');

  // Tag-aware path: when the input contains `<color>`, `<b>`, or `<ruby>`,
  // hand off to buildColoredLines to walk the text into per-glyph arrays
  // plus per-line ruby runs. Pure plain text skips this and takes the
  // original fast path. Other TMP tags (size/voffset/space/cspace) are
  // silently consumed by the tokenizer — DebatePrinter / NormalPrinter
  // source content never carries those in the message body.
  const hasTags = /<\/?(color|b|ruby)\b/i.test(s);
  let plain, lineGlyphs, lineWidths, lineRuby;
  if (hasTags) {
    ({ plain, lineGlyphs, lineWidths, lineRuby } =
      buildColoredLines(rawLines, color, weight, fontSize, italic));
  } else {
    plain = rawLines;
    lineGlyphs = null;
    lineRuby = null;
    lineWidths = rawLines.map(l => _MEAS_CTX.measureText(l).width);
  }

  const lines = plain;  // alias: downstream uses `lines` for measurement.
  const m0 = _MEAS_CTX.measureText(lines[0] || ' ');
  const fbAsc  = m0.fontBoundingBoxAscent  ?? fontSize * 0.85;
  const fbDesc = m0.fontBoundingBoxDescent ?? fontSize * 0.20;
  const lineHeight = fbAsc + fbDesc;
  const blockH = lines.length * lineHeight;
  const widths = lineWidths;
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

  // MessageLabel: soft halo (Shadow1-style). AuthorLabel: hard asymmetric
  // drop (Shadow2/6-style), 1-2 px down only. Per-leaf ratio + passes.
  // Symmetric pad sized to fit whichever footprint extension is largest
  // (halo radius for MessageLabel, downward offset for AuthorLabel).
  const isAuthor   = rec.go === 'AuthorLabel';
  const useShadow  = rec.go === 'MessageLabel'
    || (AUTHOR_SHADOW_ENABLED && isAuthor);
  const blurRatio  = isAuthor ? TEXT_SHADOW_BLUR_RATIO_AUTHOR
                              : TEXT_SHADOW_BLUR_RATIO_MESSAGE;
  const shadowBlur    = fontSize * blurRatio;
  const shadowOffsetY = isAuthor ? fontSize * TEXT_SHADOW_OFFSET_Y_RATIO_AUTHOR : 0;
  let bx;
  if (textAlign === 'center')     bx = ax - maxW / 2;
  else if (textAlign === 'right') bx = ax - maxW;
  else                            bx = ax;
  const pad = useShadow
    ? Math.max(4, Math.ceil(shadowBlur * 2 + shadowOffsetY))
    : 4;
  // First-line ruby reaches above the body's normal top — reserve extra
  // top so the reading isn't clipped (subsequent lines' ruby overlaps
  // the line above; in-game addRubyLineHeight=false behaviour).
  // First-line obj glyphs are 1.25× as tall, partially offset by the
  // -0.075em downward voff. Reserve enough above to fit them, plus a
  // matching tail at the bottom for last-line obj glyphs.
  const firstLineHasRuby = lineRuby && lineRuby[0] && lineRuby[0].length > 0;
  const firstLineHasObj  = lineGlyphs && lineGlyphs[0]  && lineGlyphs[0].some(g => g.obj);
  const lastLineHasObj   = lineGlyphs && lineGlyphs[lineGlyphs.length - 1] &&
                           lineGlyphs[lineGlyphs.length - 1].some(g => g.obj);
  // Obj glyph above baseline = 1.25 × fbAsc; the downward voff shifts
  // it back down. Net extra above = (OBJ_SIZE_SCALE - 1) × fbAsc -
  // OBJ_VOFFSET_EM_DOWN × fontSize. Clamped to ≥ 0.
  const objExtraTop = firstLineHasObj
    ? Math.max(0, Math.ceil((OBJ_SIZE_SCALE - 1) * fbAsc - OBJ_VOFFSET_EM_DOWN * fontSize))
    : 0;
  const objExtraBot = lastLineHasObj
    ? Math.max(0, Math.ceil((OBJ_SIZE_SCALE - 1) * fbDesc + OBJ_VOFFSET_EM_DOWN * fontSize))
    : 0;
  const rubyExtraTop = firstLineHasRuby
    ? Math.max(0, Math.ceil(fontSize * RUBY_BBOX_TOP_RATIO))
    : 0;
  const extraTop = rubyExtraTop + objExtraTop;
  const extraBot = objExtraBot;
  const bbox = {
    x: Math.floor(bx - pad),
    y: Math.floor(firstBaseline - fbAsc - pad - extraTop),
    w: Math.ceil(maxW + pad * 2),
    h: Math.ceil(blockH + pad * 2 + extraTop + extraBot),
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
    ctx.shadowOffsetY = shadowOffsetY;
  }
  const passes = !useShadow ? 1
    : isAuthor ? TEXT_SHADOW_PASSES_AUTHOR
              : TEXT_SHADOW_PASSES_MESSAGE;
  if (!lineGlyphs) {
    // Fast path: no tags. Line-based shadow + base-color pass, exactly
    // as before — a single uniform-weight halo per line.
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], ax - bbox.x, firstBaseline - bbox.y + i * lineHeight);
      }
    }
  } else {
    // Tag-aware path: render every glyph individually at its declared
    // weight + size + color, with Canvas2D shadow enabled throughout so
    // each glyph carries its own halo. Multiple passes still deepen the
    // halo the same way the line-based path does. Drawing the shadow +
    // color in ONE per-glyph pass (rather than line-based shadow + bold
    // overpaint) is the only way to get a visibly thicker bold glyph or
    // a visibly larger obj glyph — otherwise the line-based shadow
    // would draw the area at base weight/size first and the overpaint
    // could land identical pixels in the glyph interior.
    ctx.textAlign = 'left';
    const objFs    = Math.round(fontSize * OBJ_SIZE_SCALE);
    const fStr00   = fStr;                                       // base, normal
    const fStr01   = fontString(fontSize, 700, italic);          // base, bold
    const fStr10   = fontString(objFs,    weight, italic);       // obj, normal
    const fStr11   = fontString(objFs,    700, italic);          // obj, bold
    const pickFont = (obj, bold) =>
      obj ? (bold ? fStr11 : fStr10) : (bold ? fStr01 : fStr00);
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < lineGlyphs.length; i++) {
        const lineW = lineWidths[i];
        let lineStartX;
        if (textAlign === 'center')      lineStartX = ax - lineW / 2;
        else if (textAlign === 'right')  lineStartX = ax - lineW;
        else                             lineStartX = ax;
        const baseY = firstBaseline + i * lineHeight - bbox.y;
        for (const g of lineGlyphs[i]) {
          ctx.font      = pickFont(g.obj, g.bold);
          ctx.fillStyle = fillStyle(g.color);
          ctx.fillText(g.ch, lineStartX + g.x - bbox.x, baseY + g.voff);
        }
      }
    }

    // Ruby (furigana) pass: small reading text centered above each
    // <ruby>…</ruby> body span. Drawn last so its halo composites on
    // top of body content. Shadow stays enabled with size-scaled blur
    // so the smaller reading gets a proportionally smaller halo.
    const rubySize = Math.max(1, Math.round(fontSize * RUBY_SIZE_SCALE));
    const rubyFStrNormal = fontString(rubySize, weight, italic);
    const rubyFStrBold   = fontString(rubySize, 700,    italic);
    const rubyVOffsetPx  = fontSize * RUBY_VOFFSET_EM;
    if (useShadow) {
      ctx.shadowBlur    = rubySize * blurRatio;
      ctx.shadowOffsetY = isAuthor ? rubySize * TEXT_SHADOW_OFFSET_Y_RATIO_AUTHOR : 0;
    }
    for (let i = 0; i < lineRuby.length; i++) {
      const runs = lineRuby[i];
      if (!runs.length) continue;
      const lineW = lineWidths[i];
      let lineStartX;
      if (textAlign === 'center')      lineStartX = ax - lineW / 2;
      else if (textAlign === 'right')  lineStartX = ax - lineW;
      else                             lineStartX = ax;
      const baseY = firstBaseline + i * lineHeight - bbox.y - rubyVOffsetPx;
      for (const r of runs) {
        ctx.font = r.bold ? rubyFStrBold : rubyFStrNormal;
        ctx.fillStyle = fillStyle(r.color);
        const rw = ctx.measureText(r.reading).width;
        const bodyCenterX = lineStartX + (r.bodyStartX + r.bodyEndX) / 2 - bbox.x;
        for (let pass = 0; pass < passes; pass++) {
          ctx.fillText(r.reading, bodyCenterX - rw / 2, baseY);
        }
      }
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

// `b` and `ruby` join the alternation for the message/testimony renderers
// (renderPlainText, renderDebateText). `b` is value-less; `ruby="reading"`
// carries the furigana in a quoted attribute — consumers strip the quotes
// when reading val. The non-greedy `[^>]*` (was `[^>]+`) lets `<ruby>`
// without a value tokenize cleanly (no-op then; would only happen in
// malformed input). AuthorLabel rich-text (renderRichText) still ignores
// `open_b` / `open_ruby` tokens — those tags don't appear in tagged_name.
const TAG_RE = /<(\/?)(color|size|voffset|space|cspace|b|ruby|obj)(?:=([^>]*))?>/g;

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

// Ruby (furigana) constants. Both NormalPrinter.MessageLabel and
// DebatePrinter.MessageLabel_1..8 declare identical TMP-side ruby settings
// in their source MonoBehaviour: rubyVerticalOffset="0.875em",
// rubySizeScale=0.4, addRubyLineHeight=false. Editor preview honours those
// values literally: reading text is 40% of body size, its baseline sits
// 0.875 × bodySize above the body baseline (positive = up), and the
// surrounding line height is NOT inflated to accommodate ruby — exactly
// matching the in-game look where ruby on line N overlaps with line N-1's
// descender region.
const RUBY_SIZE_SCALE      = 0.4;
const RUBY_VOFFSET_EM      = 0.875;

// Press-point (objection) constants. In the source scripts a press-point is
// wrapped with `<link="Objection_XX">…</link>`; the DebatePrinter's
// MessageLabel.linkTemplate rewrites it to `<style="Objection">…</style>`, and
// the DebatePrinterStyleSheet (general-fonts-common bundle) expands the
// Objection style to:
//   <voffset=-0.075em><size=1.25em><#ff92b4>…</color></size></voffset>
// In the editor we use a shorter custom tag `<obj>…</obj>` for the same effect.
// The renderer applies all three sub-effects regardless of any attribute value.
// #FF92B4 = 255/146/180; expressed via hex/255 so it lines up with the matching
// swatch hex in scene.html and stays grep-able.
const OBJ_COLOR           = [0xff / 255, 0x92 / 255, 0xb4 / 255, 1.0];
const OBJ_SIZE_SCALE      = 1.25;
// TMP `<voffset>` convention: positive = up (above baseline). The Objection
// style uses -0.075em, i.e. baseline shifts down by 0.075em. We store the
// downward pixel offset directly in glyph records (positive = down on canvas).
const OBJ_VOFFSET_EM_DOWN = 0.075;
// Conservative extra-top reservation for the bbox when the first line has
// ruby: ruby baseline + ruby ascent - body ascent. Computed as a fraction
// of body fontSize using rough fbAsc/fbDesc ratios (≈0.85 / 0.20 for Noto
// Serif CJK at body sizes 48 / 96). Slightly over-reserves to avoid
// clipping the small reading text at the canvas top.
const RUBY_BBOX_TOP_RATIO  = RUBY_VOFFSET_EM + RUBY_SIZE_SCALE * 0.85 - 0.85;

// Walk `rawLines` through tokenizeRich, building per-line per-glyph
// arrays + per-line ruby runs. Color, bold, and ruby state are tracked
// with stacks/single-slot — closing more tags than were opened is a no-op
// (matches TMP). Other rich-text tags (size/voffset/space/cspace) are
// silently consumed; that's the same trade-off the message renderers
// have always had since DebatePrinter / NormalPrinter source content
// never carries those in the message body.
//
// Returns:
//   plain[i]      — tag-stripped body text for line i (used by the
//                   shadow silhouette pass; excludes ruby readings)
//   lineGlyphs[i] — array of { ch, x, color, bold } for line i's body
//   lineWidths[i] — cursorX after consuming the last glyph (line width
//                   in body coords; ruby reading width doesn't count)
//   lineRuby[i]   — array of { reading, bodyStartX, bodyEndX, color,
//                   bold } for line i (one per <ruby>…</ruby> span)
function buildColoredLines(rawLines, baseColor, baseWeight, fontSize, italic) {
  const plain = [];
  const lineGlyphs = [];
  const lineWidths = [];
  const lineRuby = [];
  // Four font-string variants cover the {base/obj} × {normal/bold} cube,
  // which is the full set we need: <obj> is the only thing that changes
  // size, and the bold stack only flips weight. measureText needs to see
  // the same font that fillText will, so we pick from the same table.
  const objFs    = Math.round(fontSize * OBJ_SIZE_SCALE);
  const fStr00   = fontString(fontSize, baseWeight, italic);
  const fStr01   = fontString(fontSize, 700,        italic);
  const fStr10   = fontString(objFs,    baseWeight, italic);
  const fStr11   = fontString(objFs,    700,        italic);
  const objVoff  = fontSize * OBJ_VOFFSET_EM_DOWN;
  const pickFont = (obj, bold) =>
    obj ? (bold ? fStr11 : fStr10) : (bold ? fStr01 : fStr00);
  for (const line of rawLines) {
    const colorStack = [baseColor];
    const boldStack  = [false];
    let objDepth = 0;
    const glyphs = [];
    const rubyRuns = [];
    let plainStr = '';
    let cursorX = 0;
    let rubyReading = null;
    let rubyStartX = 0;
    for (const tok of tokenizeRich(line)) {
      switch (tok.kind) {
        case 'open_color': {
          const c = parseColorToken(tok.val);
          colorStack.push(c || colorStack[colorStack.length - 1]);
          break;
        }
        case 'close_color':
          if (colorStack.length > 1) colorStack.pop();
          break;
        case 'open_b':  boldStack.push(true); break;
        case 'close_b': if (boldStack.length > 1) boldStack.pop(); break;
        case 'open_obj': {
          // Apply DebatePrinterStyleSheet's "Objection" style internally:
          // push pink color, mark obj active (1.25× size + downward voff).
          // Nested objs are flattened: the size scale and voffset apply
          // once regardless of depth.
          objDepth++;
          colorStack.push(OBJ_COLOR);
          break;
        }
        case 'close_obj': {
          if (objDepth > 0) {
            objDepth--;
            if (colorStack.length > 1) colorStack.pop();
          }
          break;
        }
        case 'open_ruby': {
          // val arrives as `"こけ"` with quotes; strip them. Unquoted
          // values (rare) pass through unchanged.
          const v = tok.val || '';
          rubyReading = v.replace(/^"(.*)"$/, '$1');
          rubyStartX = cursorX;
          break;
        }
        case 'close_ruby': {
          if (rubyReading !== null && cursorX > rubyStartX) {
            rubyRuns.push({
              reading: rubyReading,
              bodyStartX: rubyStartX,
              bodyEndX: cursorX,
              color: colorStack[colorStack.length - 1],
              bold:  boldStack[boldStack.length - 1],
            });
          }
          rubyReading = null;
          break;
        }
        case 'glyph': {
          const bold = boldStack[boldStack.length - 1];
          const obj  = objDepth > 0;
          _MEAS_CTX.font = pickFont(obj, bold);
          const w = _MEAS_CTX.measureText(tok.val).width;
          glyphs.push({
            ch:    tok.val,
            x:     cursorX,
            color: colorStack[colorStack.length - 1],
            bold,
            obj,
            voff:  obj ? objVoff : 0,   // positive = down on canvas
          });
          plainStr += tok.val;
          cursorX += w;
          break;
        }
        // open_size / open_voffset / open_cspace / close_*  and `space`
        // are silently consumed — message-body renderers don't currently
        // honour them. (renderRichText handles them on its own path.)
      }
    }
    plain.push(plainStr);
    lineGlyphs.push(glyphs);
    lineWidths.push(cursorX);
    lineRuby.push(rubyRuns);
  }
  return { plain, lineGlyphs, lineWidths, lineRuby };
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

  // AuthorLabel-equivalent rich-text (the only caller today): hard asymmetric
  // drop shadow, no blur, ~1-2 px downward offset per glyph (em-relative so
  // sz=73 ruby glyphs get ~1 px and sz=136 main glyphs get ~1.5 px). Pad grows
  // symmetrically to cover the largest offset in the leaf. Single pass —
  // stacking hard-edged offsets at the same position has no visual effect.
  const useShadow = AUTHOR_SHADOW_ENABLED && rec.go === 'AuthorLabel';
  let maxOffsetY = 0;
  if (useShadow) {
    for (const g of glyphs) {
      const dy = g.size * TEXT_SHADOW_OFFSET_Y_RATIO_AUTHOR;
      if (dy > maxOffsetY) maxOffsetY = dy;
    }
  }
  const pad = useShadow ? Math.max(4, Math.ceil(maxOffsetY)) : 4;
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
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetX = 0;
  }
  const baselineInImg = capTop + pad;
  const passes = useShadow ? TEXT_SHADOW_PASSES_AUTHOR : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (const g of glyphs) {
      ctx.font = g.fontStr;
      ctx.fillStyle = fillStyle(g.color);
      if (useShadow) ctx.shadowOffsetY = g.size * TEXT_SHADOW_OFFSET_Y_RATIO_AUTHOR;
      ctx.fillText(g.ch, g.x + pad, baselineInImg - g.voff);
    }
  }

  const lin = imageDataToLinear(ctx.getImageData(0, 0, imgW, imgH));
  compositeLinear(dst, lin, imgW, imgH,
                  Math.floor(xOrigin) - pad, Math.floor(yBaseline - capTop) - pad);
}

// --- Top-level scene render ---

async function renderTextLeaf(rec, dst) {
  const author  = activeAuthorId();
  const message = activeMessageText();
  // AuthorLabel routing: when an author is selected and the active locale ships
  // a non-empty tagged_name, render via the rich-text path. Otherwise fall
  // through to the plain placeholder so we still draw *something*.
  if (rec.go === 'AuthorLabel' && author) {
    const charRec = (charsConfig.characters || []).find(c => c.id === author);
    const tagged = charRec && (charRec.tagged_name || {})[locale];
    if (tagged) {
      renderRichText(rec, dst, tagged, charRec.nameColor_hex);
      return;
    }
  }
  if (rec.go === 'AuthorLabel') {
    renderPlainText(rec, dst, 'Author');
  } else if (rec.go === 'MessageLabel') {
    renderPlainText(rec, dst, message);
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
// applied at bake time by extract_scene_adv.py; this only handles per-render
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

// --- Trial scene render (delegates to scene_court.js / Three.js) ---
//
// scene_court.js is imported lazily so users who only ever touch the Adv
// editor never pay the Three.js + court-module download cost. The same
// CourtRenderer + offscreen canvas is reused across renders; we don't want
// to churn WebGL contexts on every preview update.
let _courtModule         = null;
let _courtRenderer       = null;
let _courtCanvas         = null;
// Promise singleton — concurrent calls during the initial load (e.g. when
// scheduleRender from loadPlacements collides with init's explicit
// drawPreview) used to each construct their own CourtRenderer + WebGLRenderer
// and overwrite _courtCanvas, leaving the first renderer rendering to an
// orphaned canvas while the second's content was the only thing read by the
// blit. Sharing one promise means one renderer, one canvas, no race.
let _courtRendererPromise = null;

async function getCourtModule() {
  if (_courtModule) return _courtModule;
  _courtModule = await import(`./scene_court.js?v=${BUILD_VERSION}`);
  return _courtModule;
}

function getCourtRenderer() {
  if (_courtRendererPromise) return _courtRendererPromise;
  _courtRendererPromise = (async () => {
    try {
      const mod = await getCourtModule();
      _courtCanvas = document.createElement('canvas');
      _courtCanvas.width  = CANVAS_W;
      _courtCanvas.height = CANVAS_H;
      _courtRenderer = new mod.CourtRenderer(_courtCanvas, { prefab: trialPrefab });
      await _courtRenderer.load(BUILD_VERSION);
      return _courtRenderer;
    } catch (e) {
      // Don't cache the rejection — a transient network failure on the
      // first load shouldn't permanently break trial mode for the session.
      // Clear the partial state so the next caller can retry from scratch.
      _courtRendererPromise = null;
      _courtCanvas          = null;
      _courtRenderer        = null;
      throw e;
    }
  })();
  return _courtRendererPromise;
}

// Stand-count for a prefab. The court prefab has 13 stands, court_final 14.
// Used as the bound for every "is this stand index valid?" check and as the
// length of the slot array. Pure function — safe to call before any module
// loads.
function trialStandCount(prefab) {
  return prefab === 'court_final' ? 14 : 13;
}

// Live slot array for the active prefab. Lazy-seeded to an N-long array of
// nulls on first access so an adv-only session doesn't allocate them. All
// mutations go through this — there are no other writers — so the saved
// config, the slot UI, and the look-pill row always agree on the same array.
function currentStandSlots() {
  if (!trialStandSlots[trialPrefab]) {
    trialStandSlots[trialPrefab] = Array(trialStandCount(trialPrefab)).fill(null);
  }
  return trialStandSlots[trialPrefab];
}

// Camera look-target stand index. Returns 0 if `trialLookStandIdx` is null
// (no look target, e.g. after a non-preset slider drag) so the camera still
// has a sane angular reference to compute yaw from. The pill row will be
// painted inactive in that state — the user has explicit feedback that no
// preset is matched.
function trialTargetIdx() {
  return typeof trialLookStandIdx === 'number' ? trialLookStandIdx : 0;
}

async function renderTrialScene() {
  const r = await getCourtRenderer();
  if (r.prefab !== trialPrefab) r.setPrefab(trialPrefab);
  // Resolve the stand slot map → character billboard records the renderer
  // expects. Snapshots whose image isn't decoded yet are awaited in parallel
  // so the first render of a fresh slot map still produces all billboards
  // in a single pass (no half-empty intermediate frame).
  const slots = currentStandSlots();
  const charPromises = [];
  for (let i = 0; i < slots.length; i++) {
    const slug = slots[i];
    if (!slug) continue;
    const snap = snapshots.get(slug);
    if (!snap) continue;
    charPromises.push((async () => ({
      idx:            i,
      image:          await loadSnapshotImage(snap),
      snapWidth:      snap.width,
      snapHeight:     snap.height,
      intrinsicScale: intrinsicScaleFor(snap),
      // pivotX/pivotY undefined → renderer falls back to snapshot centre.
      // Old snapshots written before pivot tracking land in this branch.
      pivotX:         snap.pivotX,
      pivotY:         snap.pivotY,
      // Naninovel CharacterMetadata.Pivot — per-character (px, py) in [0..1].
      // Drives the world Y of the displayed quad on the perspective stage.
      // Undefined → renderer uses CHARACTER_POSITION_Y as-is (legacy path).
      actorPivot:     characterPivots.get(snap.character),
    }))());
  }
  const chars = await Promise.all(charPromises);
  r.setCharacters(chars);
  // Pass direct values — yawMultiplier / distance / height override the
  // setCamera derivations from targetIdx / zoom / composition. Dropdowns
  // (Look character / Composition / Zoom) feed these via snap-to-preset
  // helpers; we never re-derive at render time.
  r.setCamera({
    yawMultiplier: trialYawMult,
    distance:      trialDistance,
    height:        trialHeight,
    rollDeg:       trialRollDeg,
    pitchDeg:      trialPitchDeg,
  });
  r.render();

  // Re-blit the WebGL framebuffer through a 2D canvas with `scaleX(-1)` to
  // produce the LH-coordinate (Unity / Python) mirror. The same trick the
  // standalone test page uses for its export. Doing it here means the canvas
  // we composite onto is a plain 2D canvas — no CSS transform tricks needed
  // at display, and toDataURL on the final output exports the displayed
  // image directly.
  const mirror = document.createElement('canvas');
  mirror.width  = CANVAS_W;
  mirror.height = CANVAS_H;
  const mctx = mirror.getContext('2d');
  mctx.translate(CANVAS_W, 0);
  mctx.scale(-1, 1);
  mctx.drawImage(_courtCanvas, 0, 0);

  // 'adv' subtype: composite the same NormalPrinter/AutoToggle/ControlPanel/
  // WitchBookButtonUI overlays the Adv scene uses, on top of the courtroom
  // render. The trial 3D output is the new "background" for the existing
  // overlay loop in renderScene — read it back into a linear Float32Array
  // (sRGB-decoded via imageDataToLinear) so renderLayer/renderTextLeaf can
  // alpha-composite in the same linear space they always do.
  //
  // TOGGLE_FLAGS routes each adv-side toggle name through a sceneType-aware
  // getter, so the prefab loop transparently reads from the trialShow* state
  // when sceneType === 'trial' without any prefab-data changes.
  //
  // 'debate' subtype: the tilted testimony text on top of bare 3D, the
  // WitchBookButtonUI + DebateUI HUD overlays, and — when enabled — the
  // trial choice screen (renderTrialChoiceUI). See renderDebateText for the
  // ScenePosition → canvas mapping.
  if (trialSubtype !== 'adv' && trialSubtype !== 'debate') return mirror;

  await ensureFontsLoaded();
  const dst = imageDataToLinear(mctx.getImageData(0, 0, CANVAS_W, CANVAS_H));

  if (trialSubtype === 'adv') {
    for (const prefab of sceneMeta.prefabs) {
      if (prefab.toggle && !isFlagOn(prefab.toggle)) continue;
      for (const [, kind, item] of selectPrefabItems(prefab)) {
        if (kind === 'layer') await renderLayer(item, dst);
        else                  await renderTextLeaf(item, dst);
      }
    }
  } else {
    // Debate subtype: tilted testimony text + the WitchBookButtonUI overlay
    // (from scene/adv) + the DebateUI HUD layers (from scene/trial). The
    // book button is the only adv-overlay element that makes sense in debate
    // (no dialog frame, so no Author/AutoToggle/Menu); the DebateUI HUD
    // adds the clock plate and the fast-skip button. Both ride on the same
    // prefab pipeline as the trial-adv path; per-layer gating for the
    // DebateUI prefab is hardcoded here rather than via items_toggle because
    // ClockBase and FastButtonBase share the "Wrapper" group, so a
    // prefix-based gate can't separate them.
    await renderDebateText(dst);
    for (const prefab of sceneMeta.prefabs) {
      if (prefab.name !== 'WitchBookButtonUI') continue;
      if (prefab.toggle && !isFlagOn(prefab.toggle)) continue;
      for (const [, kind, item] of selectPrefabItems(prefab)) {
        if (kind === 'layer') await renderLayer(item, dst);
        else                  await renderTextLeaf(item, dst);
      }
    }
    const debateUI = trialMeta?.prefabs?.find(p => p.name === 'DebateUI');
    if (debateUI) {
      // Merge layers + texts in shared `order` so the timer Label (order=1)
      // composites between ClockBase (0) and FastButtonBase (2). The label
      // record's text is a TMP sprite-tag countdown ("03:53:645" via digit
      // sprites); we override it with the user's free-text input rendered
      // through the standard plain-text path, since the digit sprite atlas
      // isn't extracted.
      const layers = debateUI.layers || [];
      const texts  = debateUI.texts  || [];
      const items  = [];
      layers.forEach((l, i) => items.push([l.order ?? i,                'layer', l]));
      texts .forEach((t, i) => items.push([t.order ?? layers.length + i, 'text',  t]));
      items.sort((a, b) => a[0] - b[0]);
      for (const [, kind, item] of items) {
        if (kind === 'layer') {
          if (item.name === 'ClockBase'      && !trialDebateShowClock)      continue;
          if (item.name === 'FastButtonBase' && !trialDebateShowFastButton) continue;
          if (item.name === 'FastIcon') {
            if (!trialDebateShowFastButton) continue;
            if (!trialDebateFastIconActive) {
              // Spread to a shallow copy so the meta record's `color` field
              // stays the activated yellow on the next render.
              await renderLayer({ ...item, color: FAST_ICON_INACTIVE_COLOR }, dst, SCENE_TRIAL_ROOT);
              continue;
            }
          }
          await renderLayer(item, dst, SCENE_TRIAL_ROOT);
        } else {
          if (item.go === 'Label' && !trialDebateShowClock) continue;
          // Label is a TMP sprite-tag countdown rendered via the
          // TrialsClockFont digit atlas. We re-roll a fresh MM:SS:SSS
          // string per render so the editor preview reads as a live timer
          // without the user having to maintain a value.
          await renderTimerSprites(item, dst, randomTimerText());
        }
      }
    }
    // Trial choice screen — drawn last so its full-canvas TrialChoiceBase
    // backdrop covers the testimony + HUD beneath, matching the in-game
    // behaviour where an objection press-point swaps to the choice screen.
    if (trialDebateShowChoiceUI) await renderTrialChoiceUI(dst);
  }

  const out = document.createElement('canvas');
  out.width  = CANVAS_W;
  out.height = CANVAS_H;
  out.getContext('2d').putImageData(linearToImageData(dst, CANVAS_W, CANVAS_H), 0, 0);
  return out;
}

// Render the debate-subtype testimony text on top of the 3D courtroom.
// Numbers ported straight from the DebatePrinter prefab in
// naninovel-textprinters_assets_all.bundle: font_size 96, Left/Middle align,
// 20-px top/bottom margin, no wrap, overflow allowed.
//
// ScenePosition → canvas mapping (empirical, validated against two in-game
// screenshots at pos:70,50):
//   • (X%, Y%) is the centre of the printer rect, top-left origin.
//   • Effective rect width 1024 px (matches measured text-left at x=1280
//     when X=70 → rect_centre_x=1792 → rect_left=1280).
//   • size_y is the canvas height so v_align:'Middle' centres the block on
//     rect_centre_y regardless of line count (renderPlainText's middle-align
//     formula puts the block in the centre of the rect).
const DEBATE_RECT_W = 1024;
// Outline_Shadow material constants, ported from TsukushiMincho@Outline_Shadow
// (the m_sharedMaterial on DebatePrinter.MessageLabel_1..8). TMP's normalised
// shader inputs don't translate to pixel sizes directly (depends on
// _GradientScale of the SDF atlas, ~9 in stock fonts); empirical values below
// match the visible outline/shadow extent in the in-game screenshots at
// font_size=96.
//   _OutlineWidth   0.20    → ~3 px black stroke around each glyph
//   _UnderlayOffset (+1, -1)→ 4 px down-right shadow on screen (Unity Y-up)
//   _UnderlaySoftness 0.5   → 4 px blur on the shadow
//   _UnderlayColor  rgba(0,0,0,0.5) → 50%-opacity black underlay
const DEBATE_OUTLINE_PX     = 4;
const DEBATE_SHADOW_OFFSET  = 7;
const DEBATE_SHADOW_BLUR_PX = 7;
const DEBATE_SHADOW_ALPHA   = 1.0;

async function renderDebateText(dst) {
  if (!trialDebateText) return;
  const text = trialDebateText.replace(/<br\s*\/?>/gi, '\n');
  if (!text) return;
  const cx = (trialDebatePosX / 100) * CANVAS_W;
  const cy = (trialDebatePosY / 100) * CANVAS_H;
  const fontSize = 96;
  // DebatePrinter declares font_weight=400, but the in-game render reads as
  // visibly heavier than the standard text leaves — the Tsukushi Mincho face
  // plus the Outline_Shadow material together push the perceived stroke
  // weight up. Pass 600 here (bumped to 700 / Bold by fontString) to land
  // closer to that in-game look without changing the shared TMP bump policy.
  const fStr = fontString(fontSize, 600, false);
  _MEAS_CTX.font = fStr;

  // Tokenize through the shared TMP rich-text walker. Each line yields:
  //   plain[i]      — tag-stripped body text (used by the shadow silhouette
  //                   pass; ruby readings drawn separately below)
  //   lineGlyphs[i] — body glyphs { ch, x, color, bold }
  //   lineWidths[i] — line width in body coords
  //   lineRuby[i]   — ruby runs { reading, bodyStartX, bodyEndX, color, bold }
  // baseWeight 600 matches the existing visible-stroke calibration (see
  // comment above the fStr definition).
  const rawLines = text.split('\n');
  const { plain, lineGlyphs, lineWidths, lineRuby } =
    buildColoredLines(rawLines, [1, 1, 1, 1], 600, fontSize, false);
  const lines = plain;

  const m0   = _MEAS_CTX.measureText(plain[0] || ' ');
  const fbA  = m0.fontBoundingBoxAscent  ?? fontSize * 0.85;
  const fbD  = m0.fontBoundingBoxDescent ?? fontSize * 0.20;
  const lh   = fbA + fbD;
  const blkH = lines.length * lh;
  const maxW = Math.max(0, ...lineWidths);
  // Layout: pivot rect width 1024, Left h_align (text left = rect left),
  // Middle v_align (block vertically centred on cy).
  const ax            = cx - DEBATE_RECT_W / 2;
  const firstBaseline = cy - blkH / 2 + fbA;
  // Pad bbox for outline + shadow extent. Shadow offset extends to one side,
  // blur to both — symmetric pad sized to whichever is larger.
  const pad = Math.max(DEBATE_OUTLINE_PX + 2,
                       DEBATE_SHADOW_BLUR_PX + DEBATE_SHADOW_OFFSET + 2);
  // Same bbox-extension logic as renderPlainText: ruby on the first
  // line lifts the top by RUBY_BBOX_TOP_RATIO × fontSize; obj glyphs
  // on the first / last lines need extra room above / below for the
  // 1.25× height (offset partially by the +0.075em downward voff).
  const firstLineHasRuby = lineRuby[0] && lineRuby[0].length > 0;
  const firstLineHasObj  = lineGlyphs[0] && lineGlyphs[0].some(g => g.obj);
  const lastLineHasObj   = lineGlyphs[lineGlyphs.length - 1] &&
                           lineGlyphs[lineGlyphs.length - 1].some(g => g.obj);
  const rubyExtraTop = firstLineHasRuby
    ? Math.max(0, Math.ceil(fontSize * RUBY_BBOX_TOP_RATIO))
    : 0;
  const objExtraTop = firstLineHasObj
    ? Math.max(0, Math.ceil((OBJ_SIZE_SCALE - 1) * fbA - OBJ_VOFFSET_EM_DOWN * fontSize))
    : 0;
  const objExtraBot = lastLineHasObj
    ? Math.max(0, Math.ceil((OBJ_SIZE_SCALE - 1) * fbD + OBJ_VOFFSET_EM_DOWN * fontSize))
    : 0;
  const extraTop = rubyExtraTop + objExtraTop;
  const extraBot = objExtraBot;
  const bbox = {
    x: Math.floor(ax - pad),
    y: Math.floor(firstBaseline - fbA - pad - extraTop),
    w: Math.ceil(maxW + pad * 2),
    h: Math.ceil(blkH + pad * 2 + extraTop + extraBot),
  };
  if (bbox.w <= 0 || bbox.h <= 0) return;

  // Per-line ruby constants. Reading text is RUBY_SIZE_SCALE × body size,
  // baseline-offset RUBY_VOFFSET_EM × bodySize above the body baseline.
  // Outline and shadow params scale with size so the ratios stay the same.
  const rubySize           = Math.max(1, Math.round(fontSize * RUBY_SIZE_SCALE));
  const rubyFStrNormal     = fontString(rubySize, 600, false);
  const rubyFStrBold       = fontString(rubySize, 700, false);
  const rubyVOffsetPx      = fontSize * RUBY_VOFFSET_EM;
  const rubyOutlinePx      = Math.max(1, Math.round(DEBATE_OUTLINE_PX * RUBY_SIZE_SCALE));
  const rubyShadowOffsetPx = DEBATE_SHADOW_OFFSET * RUBY_SIZE_SCALE;

  // Shadow canvas: tag-stripped text in semi-transparent black, then re-
  // blitted through a CSS blur filter to soften the edges. Drawn first so
  // the outlined glyph composites on top of it. Color spans don't affect
  // the shadow — it's a single black silhouette per line, matching the
  // game's Outline_Shadow material (the underlay is a per-leaf shader prop,
  // not per-span).
  const shadowRaw = document.createElement('canvas');
  shadowRaw.width = bbox.w; shadowRaw.height = bbox.h;
  const sctx = shadowRaw.getContext('2d');
  sctx.font = fStr;
  sctx.textAlign = 'left';
  sctx.textBaseline = 'alphabetic';
  sctx.fillStyle = `rgba(0, 0, 0, ${DEBATE_SHADOW_ALPHA})`;
  // Per-glyph silhouette pass with bold + obj-aware font/voff, so the
  // halo footprint matches the visible strokes. Drawing the silhouette
  // as one line-based fillText at base weight/size would leave the
  // bold or obj-enlarged strokes un-haloed where they extend past the
  // base glyph.
  const debateObjFs    = Math.round(fontSize * OBJ_SIZE_SCALE);
  const debateFStr00   = fStr;                                  // base, normal
  const debateFStr01   = fontString(fontSize,    700, false);   // base, bold
  const debateFStr10   = fontString(debateObjFs, 600, false);   // obj,  normal
  const debateFStr11   = fontString(debateObjFs, 700, false);   // obj,  bold
  const debatePickFont = (obj, bold) =>
    obj ? (bold ? debateFStr11 : debateFStr10) : (bold ? debateFStr01 : debateFStr00);
  for (let i = 0; i < lineGlyphs.length; i++) {
    const baseY = firstBaseline - bbox.y + i * lh;
    for (const g of lineGlyphs[i]) {
      sctx.font = debatePickFont(g.obj, g.bold);
      sctx.fillText(g.ch, ax - bbox.x + g.x, baseY + g.voff);
    }
  }
  // Ruby reading silhouettes — drawn here so they're blurred together
  // with the body silhouette in the same pass below. Centered above
  // their body span; positioned in pre-blur coords.
  for (let i = 0; i < lineRuby.length; i++) {
    const runs = lineRuby[i];
    if (!runs.length) continue;
    const baseY = firstBaseline - bbox.y + i * lh - rubyVOffsetPx;
    for (const r of runs) {
      sctx.font = r.bold ? rubyFStrBold : rubyFStrNormal;
      const rw = sctx.measureText(r.reading).width;
      const cx0 = ax - bbox.x + (r.bodyStartX + r.bodyEndX) / 2;
      sctx.fillText(r.reading, cx0 - rw / 2, baseY);
    }
  }
  let shadowCanvas = shadowRaw;
  if (DEBATE_SHADOW_BLUR_PX > 0) {
    const blurred = document.createElement('canvas');
    blurred.width = bbox.w; blurred.height = bbox.h;
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${DEBATE_SHADOW_BLUR_PX / 2}px)`;
    bctx.drawImage(shadowRaw, 0, 0);
    shadowCanvas = blurred;
  }

  // Main canvas: per-glyph stroke (black) underneath, per-glyph fill (span
  // color) on top. The round line-join + miterLimit keep sharp kanji corners
  // from spiking past the outline width; matches TMP's stock outline shader
  // behaviour. Stroking per-glyph rather than per-line means glyphs that
  // touch (rare in Japanese, possible in Latin punctuation) get an isolated
  // outline — invisible at 96 px Tsukushi Mincho but worth noting. Bold-
  // aware: each glyph swaps between the base 600-weight font and a 700-
  // weight bold variant depending on its `<b>` state.
  const mainCanvas = document.createElement('canvas');
  mainCanvas.width = bbox.w; mainCanvas.height = bbox.h;
  const mctx2 = mainCanvas.getContext('2d');
  mctx2.font = fStr;
  mctx2.textAlign = 'left';
  mctx2.textBaseline = 'alphabetic';
  mctx2.lineWidth = DEBATE_OUTLINE_PX * 2;   // strokeText centres stroke on glyph edge
  mctx2.lineJoin  = 'round';
  mctx2.miterLimit = 2;
  mctx2.strokeStyle = 'rgba(0, 0, 0, 1)';
  // Reuse the same 4-string font table from the shadow pass — same
  // base/obj × normal/bold cube.
  const x0 = ax - bbox.x;
  for (let i = 0; i < lineGlyphs.length; i++) {
    const y = firstBaseline - bbox.y + i * lh;
    for (const g of lineGlyphs[i]) {
      mctx2.font = debatePickFont(g.obj, g.bold);
      mctx2.strokeText(g.ch, x0 + g.x, y + g.voff);
    }
    for (const g of lineGlyphs[i]) {
      mctx2.font = debatePickFont(g.obj, g.bold);
      mctx2.fillStyle = fillStyle(g.color);
      mctx2.fillText(g.ch, x0 + g.x, y + g.voff);
    }
  }
  // Ruby (furigana) reading pass — small text centered above each body
  // span. Stroke + fill, mirroring the body pass. Outline width and font
  // weight scale with size so the visual ratio matches the body.
  mctx2.lineWidth = rubyOutlinePx * 2;
  for (let i = 0; i < lineRuby.length; i++) {
    const runs = lineRuby[i];
    if (!runs.length) continue;
    const y = firstBaseline - bbox.y + i * lh - rubyVOffsetPx;
    for (const r of runs) {
      mctx2.font = r.bold ? rubyFStrBold : rubyFStrNormal;
      const rw = mctx2.measureText(r.reading).width;
      const rx0 = x0 + (r.bodyStartX + r.bodyEndX) / 2 - rw / 2;
      mctx2.strokeText(r.reading, rx0, y);
      mctx2.fillStyle = fillStyle(r.color);
      mctx2.fillText(r.reading, rx0, y);
    }
  }

  // Composite shadow (offset) onto dst first, then outlined fill on top. Both
  // rotate around the text pivot (cx, cy) to follow the camera roll — the in-
  // game DebatePrinter sits in the camera's screen-space UI layer, so it tilts
  // with rollDeg rather than staying screen-upright. Canvas2D's rotate(θ) is
  // CW-positive under Y-down, which matches the direction the text tilts on
  // screen for positive rollDeg, so the angle is used as-is.
  //
  // Each canvas is drawn at its unrotated dest position inside a rotated 2D
  // context, which makes the shadow's +SHADOW_OFFSET vector rotate with the
  // text — mirroring TMP's _UnderlayOffset, which lives in the SDF atlas's
  // local (glyph) frame.
  const angleRad = trialRollDeg * Math.PI / 180;
  blitRotatedCanvas(dst, shadowCanvas,
                    bbox.x + DEBATE_SHADOW_OFFSET, bbox.y + DEBATE_SHADOW_OFFSET,
                    cx, cy, angleRad);
  blitRotatedCanvas(dst, mainCanvas, bbox.x, bbox.y, cx, cy, angleRad);
}

// --- Trial choice screen overlay (debate subtype) ---------------------------
//
// The Trial choice screen is panel chrome (TrialChoicePanel@<portrait>: a
// full-canvas backdrop + a right-anchored witness portrait) plus a vertical
// column of ChoiceButton_Trial widgets. See docs/trial_ui_compositing.md.

// Choice-button variants: dropdown key → human label. The key is the suffix of
// the `ChoiceButton_Trial@<key>` prefab in scene/trial/meta.json; '' is the
// plain prefab `ChoiceButton_Trial` (balloon only, no tag badge). `Cancel` is
// intentionally absent — every trial choice column ends with a Cancel button,
// so it's appended implicitly by the renderer rather than picked by the user.
const TRIAL_CHOICE_VARIANTS = [
  { key: '',            label: 'Plain'          },
  { key: 'Objection',   label: 'Objection'      },
  { key: 'Perjury',     label: 'Perjury'        },
  { key: 'Question',    label: 'Question'       },
  { key: 'Approval',    label: 'Approval'       },
  { key: 'MagicEma',    label: 'Magic — Ema'    },
  { key: 'MagicCoco',   label: 'Magic — Coco'   },
  { key: 'MagicAnAn',   label: 'Magic — AnAn'   },
  { key: 'MagicLeia',   label: 'Magic — Leia'   },
  { key: 'MagicMargo',  label: 'Magic — Margo'  },
  { key: 'MagicNanoka', label: 'Magic — Nanoka' },
];
const TRIAL_CHOICE_PORTRAITS = ['Hiro', 'Ema'];
// Doc's choice budget is N≤4 total (4 tight); the implicit Cancel takes one
// slot, so the user can add at most 3 of their own.
const TRIAL_CHOICE_MAX_USER = 3;

function trialChoicePrefabName(variant) {
  return variant ? `ChoiceButton_Trial@${variant}` : 'ChoiceButton_Trial';
}

// Tag-badge sprites ship one PNG per locale (`Objection_Ja.png` /
// `Objection_Ko.png` / `Objection_ZhHans.png`). The meta records the `_Ja`
// variant; swap the suffix to the active locale. Balloon sprites have no
// `_Ja` suffix, so they pass through untouched.
const TRIAL_CHOICE_LOCALE_SUFFIX = { ko: 'Ko', ja: 'Ja', 'zh-Hans': 'ZhHans' };
function localizedTrialChoiceFile(file) {
  const suf = TRIAL_CHOICE_LOCALE_SUFFIX[locale] || 'Ja';
  return file.replace(/_Ja\.png$/, `_${suf}.png`);
}

// VerticalLayoutGroup constants for TrialChoicePanel/Wrapper/Content, lifted
// from the `placement` block in docs/trial_ui_compositing.md.
const TRIAL_CHOICE_SPACING      = 80;     // gap between buttons (px)
const TRIAL_CHOICE_X_ANCHOR_PIL = 2005;   // shared right edge (x_anchor_basis)
const TRIAL_CHOICE_Y_PIVOT_PIL  = 787;    // column-centre pivot, PIL Y-down
const TRIAL_CHOICE_Y_PIVOT_POS  = 0.5;    // 0 = pivot at column top, 1 = bottom

// Compute per-button top-left canvas positions for a vertical column of trial
// choice buttons, following TrialChoicePanel/Wrapper/Content's
// VerticalLayoutGroup (MiddleRight alignment, spacing 80, centred on a pivot).
//
// The layout is MIXED-HEIGHT and MIXED-WIDTH aware — Cancel is 767×229 while
// the other buttons are 1099×318. Because alignment is MiddleRight, every
// button's RIGHT edge sits at TRIAL_CHOICE_X_ANCHOR_PIL, so a narrower button
// lands further right. A naive N*h / fixed-x formula mis-stacks any column
// containing a Cancel button.
//
// Formula from docs/trial_ui_compositing.md ("Choice button placement");
// padding_top / padding_bottom are both 0. The N=3 worked example
// ([318,318,229] tall, [1099,1099,767] wide) yields tops [275, 673, 1071]
// and lefts [906, 906, 1238].
//
// @param sizes  Array of [w, h] per button, in column order (top → bottom).
// @returns      Array of [leftX, topY] — PIL top-left on the 2560×1440 canvas.
function computeTrialChoiceLayout(sizes) {
  const n = sizes.length;
  if (!n) return [];
  const totalH = sizes.reduce((sum, [, h]) => sum + h, 0)
               + (n - 1) * TRIAL_CHOICE_SPACING;
  const columnTopY = TRIAL_CHOICE_Y_PIVOT_PIL - totalH * TRIAL_CHOICE_Y_PIVOT_POS;
  const places = [];
  let y = columnTopY;
  for (const [w, h] of sizes) {
    places.push([
      Math.round(TRIAL_CHOICE_X_ANCHOR_PIL - w),   // MiddleRight: right edge fixed
      Math.round(y),
    ]);
    y += h + TRIAL_CHOICE_SPACING;
  }
  return places;
}

// Render the trial choice screen onto the linear-space canvas buffer `dst`.
async function renderTrialChoiceUI(dst) {
  // 1. Panel chrome — backdrop + the chosen witness portrait.
  const panel = trialMeta?.prefabs?.find(
    p => p.name === `TrialChoicePanel@${trialChoicePortrait}`);
  if (panel) {
    for (const layer of panel.layers || []) {
      await renderLayer(layer, dst, SCENE_TRIAL_ROOT);
    }
  }
  // 2. Choice buttons — resolve each configured row to its prefab; silently
  //    drop rows whose variant has no matching prefab. The Cancel button is
  //    appended unconditionally as the column tail: every trial choice column
  //    ends with one in-game, and its short 229-px sprite is what lets a
  //    4-button column fit, so the user never adds it manually.
  const resolved = [];
  for (const cfg of trialChoiceButtons) {
    const prefab = trialMeta?.prefabs?.find(
      p => p.name === trialChoicePrefabName(cfg.variant));
    if (prefab) resolved.push({ cfg, prefab });
  }
  const cancelPrefab = trialMeta?.prefabs?.find(
    p => p.name === 'ChoiceButton_Trial@Cancel');
  if (cancelPrefab) {
    resolved.push({ cfg: { variant: 'Cancel', label: trialChoiceCancelLabel },
                    prefab: cancelPrefab });
  }
  if (!resolved.length) return;
  const sizes  = resolved.map(({ prefab }) =>
    prefab.root_intrinsic_size || prefab.canvas_size);
  const places = computeTrialChoiceLayout(sizes);
  if (!places) return;   // placement formula not implemented yet
  for (let i = 0; i < resolved.length; i++) {
    const { cfg, prefab } = resolved[i];
    const [ox, oy] = places[i];
    // Button layers (balloon, then optional tag badge), offset into the panel.
    for (const layer of prefab.layers || []) {
      await renderLayer(
        { ...layer,
          file: localizedTrialChoiceFile(layer.file),
          pos:  [layer.pos[0] + ox, layer.pos[1] + oy] },
        dst, SCENE_TRIAL_ROOT);
    }
    // Label text — the user's per-button string via the plain-text path.
    for (const txt of prefab.texts || []) {
      if (txt.go !== 'Label') continue;
      renderPlainText(
        { ...txt, pos: [txt.pos[0] + ox, txt.pos[1] + oy] },
        dst, cfg.label || '');
    }
  }
}

// A representative starting choice set: a magic accusation + a question. The
// Cancel tail is implicit (see renderTrialChoiceUI), so it isn't seeded here.
// Returns a fresh array each call so callers can mutate it freely.
function defaultTrialChoiceButtons() {
  return [
    { variant: 'MagicMargo', label: 'Magic accusation' },
    { variant: 'Question',   label: 'Question'         },
  ];
}

// Mark the active portrait button in the Hiro/Ema picker.
function refreshTrialChoicePortraitActive() {
  for (const b of document.querySelectorAll('#trialChoicePortraitPresets .layer-btn')) {
    b.classList.toggle('active', b.dataset.portrait === trialChoicePortrait);
  }
}

// (Re)build the editable choice-button list DOM from trialChoiceButtons. Called
// on init, after add/remove, and after loadSceneConfig swaps the array.
function renderTrialChoiceList() {
  const list = document.getElementById('trialChoiceButtonList');
  if (!list) return;
  list.replaceChildren();
  trialChoiceButtons.forEach((cfg, idx) => {
    const row = document.createElement('div');
    row.className = 'trial-choice-row';

    const sel = document.createElement('select');
    sel.className = 'trial-choice-variant';
    for (const v of TRIAL_CHOICE_VARIANTS) {
      const opt = document.createElement('option');
      opt.value       = v.key;
      opt.textContent = v.label;
      if (v.key === cfg.variant) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => {
      trialChoiceButtons[idx].variant = sel.value;
      scheduleRender();
      scheduleSceneConfigSave();
    };

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'trial-choice-label';
    input.placeholder = 'Label';
    input.value       = cfg.label || '';
    input.oninput = () => {
      trialChoiceButtons[idx].label = input.value;
      scheduleRender();
      scheduleSceneConfigSave();
    };

    const rm = document.createElement('button');
    rm.type        = 'button';
    rm.className   = 'trial-choice-remove';
    rm.textContent = '×';
    rm.title       = 'Remove choice';
    rm.onclick = () => {
      trialChoiceButtons.splice(idx, 1);
      renderTrialChoiceList();
      scheduleRender();
      scheduleSceneConfigSave();
    };

    row.append(sel, input, rm);
    list.appendChild(row);
  });

  // Implicit Cancel tail — a locked row the user can't reorder or remove,
  // shown so the always-present Cancel button is visible in the editor. Only
  // its label is editable; the variant is fixed and there is no remove button.
  const cancelRow = document.createElement('div');
  cancelRow.className = 'trial-choice-row';

  const cancelTag = document.createElement('div');
  cancelTag.className   = 'trial-choice-variant trial-choice-fixed';
  cancelTag.textContent = 'Cancel';

  const cancelInput = document.createElement('input');
  cancelInput.type        = 'text';
  cancelInput.className   = 'trial-choice-label';
  cancelInput.placeholder = 'Cancel label';
  cancelInput.value       = trialChoiceCancelLabel;
  cancelInput.oninput = () => {
    trialChoiceCancelLabel = cancelInput.value;
    scheduleRender();
    scheduleSceneConfigSave();
  };

  // Empty spacer keeps the 3-column grid aligned with the rows above.
  const spacer = document.createElement('span');

  cancelRow.append(cancelTag, cancelInput, spacer);
  list.appendChild(cancelRow);

  const addBtn = document.getElementById('trialChoiceAddBtn');
  if (addBtn) addBtn.disabled = trialChoiceButtons.length >= TRIAL_CHOICE_MAX_USER;
}

// Wire the trial choice UI controls: the show toggle, the Hiro/Ema portrait
// picker, and the add-choice button, then build the initial list.
function initTrialChoiceUI() {
  const toggle = document.getElementById('toggleTrialChoiceUI');
  toggle.checked  = trialDebateShowChoiceUI;
  toggle.onchange = (e) => {
    trialDebateShowChoiceUI = e.target.checked;
    scheduleRender();
    scheduleSceneConfigSave();
  };

  for (const b of document.querySelectorAll('#trialChoicePortraitPresets .layer-btn')) {
    b.addEventListener('click', () => {
      const p = b.dataset.portrait;
      if (!TRIAL_CHOICE_PORTRAITS.includes(p) || trialChoicePortrait === p) return;
      trialChoicePortrait = p;
      refreshTrialChoicePortraitActive();
      scheduleRender();
      scheduleSceneConfigSave();
    });
  }

  const addBtn = document.getElementById('trialChoiceAddBtn');
  addBtn.onclick = () => {
    if (trialChoiceButtons.length >= TRIAL_CHOICE_MAX_USER) return;
    trialChoiceButtons.push({ variant: '', label: '' });
    renderTrialChoiceList();
    scheduleRender();
    scheduleSceneConfigSave();
  };

  refreshTrialChoicePortraitActive();
  renderTrialChoiceList();
}

// Composite `srcCanvas` onto `dst` (linear-space full-canvas buffer) after
// rotating by `angleRad` around the pivot point (pivotX, pivotY) in canvas
// coords. (dstX, dstY) is where the source's top-left would land in the
// unrotated frame; the rotation is applied around the pivot afterwards.
//
// Allocates a tmp Canvas2D sized to the rotated source's bounding box, so cost
// stays proportional to the text plate, not the full 2560×1440 canvas.
function blitRotatedCanvas(dst, srcCanvas, dstX, dstY, pivotX, pivotY, angleRad) {
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  let minX, minY, maxX, maxY;
  if (angleRad === 0) {
    minX = dstX; minY = dstY; maxX = dstX + srcW; maxY = dstY + srcH;
  } else {
    const c = Math.cos(angleRad), s = Math.sin(angleRad);
    const corners = [
      [dstX,        dstY       ],
      [dstX + srcW, dstY       ],
      [dstX,        dstY + srcH],
      [dstX + srcW, dstY + srcH],
    ];
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const [x, y] of corners) {
      const dx = x - pivotX, dy = y - pivotY;
      const rx = pivotX + dx * c - dy * s;
      const ry = pivotY + dx * s + dy * c;
      if (rx < minX) minX = rx;
      if (ry < minY) minY = ry;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
    }
    minX = Math.floor(minX) - 1;       // 1-px safety margin for resampling AA
    minY = Math.floor(minY) - 1;
    maxX = Math.ceil(maxX)  + 1;
    maxY = Math.ceil(maxY)  + 1;
  }
  const tmpW = maxX - minX;
  const tmpH = maxY - minY;
  if (tmpW <= 0 || tmpH <= 0) return;
  const tmp = document.createElement('canvas');
  tmp.width  = tmpW;
  tmp.height = tmpH;
  const tctx = tmp.getContext('2d');
  // Transform stack: shift origin so the pivot lands at (pivotX-minX, pivotY
  // -minY) in tmp coords, then rotate around that origin, then undo the pivot
  // shift so drawImage(srcCanvas, dstX, dstY) maps as if drawing on the full
  // canvas before rotation.
  tctx.translate(pivotX - minX, pivotY - minY);
  tctx.rotate(angleRad);
  tctx.translate(-pivotX, -pivotY);
  tctx.drawImage(srcCanvas, dstX, dstY);
  const lin = imageDataToLinear(tctx.getImageData(0, 0, tmpW, tmpH));
  compositeLinear(dst, lin, tmpW, tmpH, minX, minY);
}

// Snap `trialLookStandIdx` to a stand that has a snapshot in the current
// prefab. Pure state mutation — does not touch the DOM. The `null` sentinel
// (set by setTrialYawMult after a non-preset slider drag) is preserved so
// the "no look target" state survives prefab switches and reloads.
//
// Called from populateTrialLookCharSelect (so a re-paint always lands on a
// real pill). Picks the lowest-index filled stand as the snap target — this
// is "Stand 0" when populated, otherwise the next-lowest non-null.
function ensureTrialLookCharValidForPrefab() {
  if (trialLookStandIdx === null) return;
  const slots = currentStandSlots();
  if (typeof trialLookStandIdx === 'number'
      && trialLookStandIdx >= 0
      && trialLookStandIdx < slots.length
      && slots[trialLookStandIdx] !== null) {
    return;
  }
  // Lowest-index filled stand wins. If everything is empty, fall back to
  // null — the look pill row will be empty and composition pills disabled.
  let pick = null;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== null) { pick = i; break; }
  }
  trialLookStandIdx = pick;
}

// Populate the look-character preset row from the current prefab's stand
// slots. One pill per filled stand (slug !== null), sorted by index so the
// row reads "Stand 0, Stand 1, ..." left-to-right matching clockwise stand
// order around the court. Pill label is "Stand <i>: <snap.name>" so the
// user can tell at a glance which snapshot is the look target. Clicking a
// pill snaps yaw mult to that stand's angular position via
// applyYawMultFromTemplate (one-way snap — subsequent slider drags are not
// tracked back into the pill).
async function populateTrialLookCharSelect() {
  await getCourtModule();
  // Snap before painting so the active class lands on a real pill. Mutates
  // trialLookStandIdx; safe to run again at any later call site.
  ensureTrialLookCharValidForPrefab();
  const slots = currentStandSlots();
  const wrap = document.getElementById('trialLookCharPresets');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 0; i < slots.length; i++) {
    const slug = slots[i];
    if (!slug) continue;
    const snap = snapshots.get(slug);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-btn';
    btn.dataset.look = String(i);
    btn.textContent  = `Stand ${i}` + (snap ? `: ${snap.name || snap.slug}` : '');
    btn.addEventListener('click', () => {
      trialLookStandIdx = i;
      applyYawMultFromTemplate();
      scheduleRender();
      scheduleSceneConfigSave();
    });
    wrap.appendChild(btn);
  }
  // The stand rows in the new "Stands" group highlight the active stand;
  // keep them in step on every look-char repaint so the two views never
  // disagree about which stand is selected for the camera.
  populateTrialStandsUI();
  refreshTrialLookCharActive();
}

function refreshTrialLookCharActive() {
  const wrap = document.getElementById('trialLookCharPresets');
  if (!wrap) return;
  for (const b of wrap.querySelectorAll('.layer-btn')) {
    b.classList.toggle('active', Number(b.dataset.look) === trialLookStandIdx);
  }
  // Composition pills depend on having a look target — see
  // refreshTrialCompositionActive. Pairing the call here means every
  // look-target update keeps composition in step automatically.
  refreshTrialCompositionActive();
}

// Paint the per-stand row UI (the new "Stands" group at the top of the
// trial-mode groups stack). One row per stand; each shows either a thumbnail
// + snapshot name when a slug is assigned, or a dim "empty" placeholder.
// Clicking a row makes that stand "active" — see selectTrialStand.
//
// Re-rendered from scratch on every slot change so the active highlight, the
// thumbnail visibility, and the row content always reflect the live state.
// Cheap — 13–14 rows, no images decoded (the <img>.src is just the snapshot's
// existing blobUrl).
function populateTrialStandsUI() {
  const wrap = document.getElementById('trialStandsList');
  if (!wrap) return;
  const slots = currentStandSlots();
  wrap.innerHTML = '';
  for (let i = 0; i < slots.length; i++) {
    const slug = slots[i];
    const snap = slug ? snapshots.get(slug) : null;
    const row = document.createElement('div');
    row.className = 'stand-slot'
      + (slug ? '' : ' stand-slot-empty')
      + (trialSelectedStand === i ? ' active' : '');
    row.dataset.standIdx = String(i);
    if (snap) {
      row.innerHTML = `
        <span class="stand-slot-idx">Stand ${i}</span>
        <img class="stand-slot-thumb" alt="">
        <span class="stand-slot-name"></span>
        <button class="stand-slot-remove" type="button" aria-label="Remove" title="Remove">&times;</button>
      `;
      const img = row.querySelector('.stand-slot-thumb');
      if (snap.blobUrl) img.src = snap.blobUrl;
      row.querySelector('.stand-slot-name').textContent = snap.name || snap.slug;
      // Per-row remove. Clearing a stand also selects it so the next
      // library click lands at the just-emptied spot — keeps the flow
      // moving in the common "swap this character out" case.
      row.querySelector('.stand-slot-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        trialSelectedStand = i;
        clearActiveStand();
      });
    } else {
      row.innerHTML = `
        <span class="stand-slot-idx">Stand ${i}</span>
        <span class="stand-slot-placeholder">—</span>
      `;
    }
    row.addEventListener('click', () => selectTrialStand(i));
    wrap.appendChild(row);
  }
}

// Make stand `i` active. Empty stands become a snapshot-drop target (next
// library click lands there); filled stands highlight in the library too
// (via the "On stand X" annotation in refreshSnapshotList). Idempotent —
// clicking the same stand twice keeps it active (per the option-A UX
// decision).
function selectTrialStand(i) {
  trialSelectedStand = i;
  populateTrialStandsUI();
  refreshSnapshotList();      // update "On stand X" annotations + selection
}

// Drop the slug currently in stand `dst` into stand `src`, and put whatever
// was at `src` (possibly null) into `dst`. Swap is the universal move op:
// the inspector's "Stand" select uses it directly, and the snapshot-library
// click handler reduces to "swap with whichever stand previously held this
// slug (if any) and the active stand". Side-effects: repaints all panels.
function swapTrialStands(src, dst) {
  if (src === dst) return;
  const slots = currentStandSlots();
  const tmp = slots[src];
  slots[src] = slots[dst];
  slots[dst] = tmp;
}

// Place `slug` at the active stand. If the slug is already on a different
// stand, swap so the user doesn't end up with two stands referencing the
// same slug (the renderer would draw the same character twice). If the
// active stand was already filled, the displaced slug returns to wherever
// the new one came from (i.e. an actual swap) — feels natural and avoids
// the "where did my old character go?" surprise.
function assignSnapshotToActiveStand(slug) {
  if (trialSelectedStand === null) return false;
  const slots = currentStandSlots();
  const i = trialSelectedStand;
  const existing = slots.indexOf(slug);
  if (existing === i) return false;     // already there, nothing to do
  if (existing >= 0) {
    swapTrialStands(existing, i);
  } else {
    slots[i] = slug;
  }
  // Repaint everything that depends on the slot map.
  populateTrialLookCharSelect();        // refreshes look pills + slot rows
  refreshSnapshotList();
  applyYawMultFromTemplate();
  scheduleRender();
  scheduleSceneConfigSave();
  return true;
}

// Clear the active stand (set its slot to null). If the active stand was
// the look-camera target, snap to the next-lowest filled stand. UI state
// stays consistent — trialSelectedStand keeps pointing at the now-empty
// stand, ready to receive a fresh snapshot pick.
function clearActiveStand() {
  if (trialSelectedStand === null) return;
  const slots = currentStandSlots();
  if (slots[trialSelectedStand] === null) return;
  slots[trialSelectedStand] = null;
  populateTrialLookCharSelect();
  refreshSnapshotList();
  applyYawMultFromTemplate();
  scheduleRender();
  scheduleSceneConfigSave();
}

function refreshTrialCompositionActive() {
  // Composition is a delta to the looked-at stand's angular position
  // (compShift in {0, +0.1, -0.1}). Without a look stand there's no base to
  // shift from, so disable the pills entirely. When disabled, no pill is
  // marked active — the user can't pick a composition until they pick a
  // stand first.
  const disabled = trialLookStandIdx === null;
  for (const b of document.querySelectorAll('#trialCompositionPresets .layer-btn')) {
    b.classList.toggle('active', !disabled && b.dataset.comp === trialComposition);
    b.disabled = disabled;
  }
}

function refreshTrialZoomActive() {
  for (const b of document.querySelectorAll('#trialZoomPresets .layer-btn')) {
    b.classList.toggle('active', Number(b.dataset.zoom) === trialZoom);
  }
}

function refreshTrialSubtypeActive() {
  for (const b of document.querySelectorAll('#trialSubtypePresets .layer-btn')) {
    b.classList.toggle('active', b.dataset.subtype === trialSubtype);
  }
}

// Find the (stand idx, composition) preset combo that produces yaw `v`, or
// null if `v` doesn't match any. Each yaw value is uniquely produced by at
// most one (idx, comp) pair: the three composition shifts (0, +0.1, -0.1)
// are distinct and all stand indices are distinct. Tolerance handles float
// error from 0.1 (e.g. 1 + 0.1 ≠ exactly 1.1 in IEEE 754).
//
// Only stands with a snapshot assigned are considered — an empty stand has
// nothing to "look at", so its angular position isn't a meaningful preset.
function findYawMultPreset(v) {
  const slots = currentStandSlots();
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === null) continue;
    for (const [comp, shift] of Object.entries(TRIAL_COMPOSITIONS)) {
      if (Math.abs(v - (i + shift)) < 1e-6) return { standIdx: i, composition: comp };
    }
  }
  return null;
}

// Setter for trialYawMult that also keeps the look-char + composition pills
// in sync with the slider:
//   - on a preset value (idx + {0, ±0.1}) → mark matching pills active.
//   - on a non-preset value             → deselect both rows entirely.
// All paths that change yaw (slider, number input, click-to-snap from
// templates) route through this setter so pill state reconciles uniformly.
function setTrialYawMult(v) {
  trialYawMult = v;
  const preset = findYawMultPreset(v);
  trialLookStandIdx = preset ? preset.standIdx    : null;
  trialComposition  = preset ? preset.composition : '';
  refreshTrialLookCharActive();
  refreshTrialCompositionActive();
}

// Find the zoom preset (1..4) whose (D, H) matches the given pair, or null
// if none does. Each ZOOM_LEVELS entry is unique on (D, H), so at most one
// match. Tolerance handles slider-step float noise.
function findDistanceHeightZoomPreset(d, h) {
  for (const [zoomStr, def] of Object.entries(TRIAL_ZOOM_LEVELS)) {
    if (Math.abs(d - def.D) < 1e-6 && Math.abs(h - def.H) < 1e-6) {
      return Number(zoomStr);
    }
  }
  return null;
}

// Setters for trialDistance and trialHeight that also keep the zoom pill in
// sync — all paths that change D/H (slider, number input, click-to-snap from
// the Zoom template) route through these setters so pill reconciliation is
// uniform:
//   - drag/snap onto a preset (D, H) → matching pill activates.
//   - drag off-preset                → all zoom pills deselect.
function syncZoomPillFromDH() {
  const z = findDistanceHeightZoomPreset(trialDistance, trialHeight);
  trialZoom = z;     // null = no preset; refreshTrialZoomActive matches none.
  refreshTrialZoomActive();
}
function setTrialDistance(v) { trialDistance = v; syncZoomPillFromDH(); }
function setTrialHeight(v)   { trialHeight   = v; syncZoomPillFromDH(); }

// One-time trial UI population. Called when sceneType becomes 'trial' (either
// on user click or saved-state restore). Populating earlier than necessary
// would force the scene_court.js module download even for Adv-only users.
let _trialUIInitPromise = null;
function ensureTrialUIInit() {
  if (!_trialUIInitPromise) _trialUIInitPromise = populateTrialLookCharSelect();
  return _trialUIInitPromise;
}

// Slider <-> number sync. Each direct camera param has both a range and a
// number input that show the same value; updating one keeps the other
// honest, and a programmatic change (snap-to-template) updates both.
function syncTrialPairUI(rangeId, numId, value, decimals = 2) {
  const range = document.getElementById(rangeId);
  const num   = document.getElementById(numId);
  if (range) range.value = String(value);
  // Use a fixed-decimal string for the number input so spinner clicks land
  // on the configured step (e.g. 0.01 vs 0.1), and the displayed string is
  // stable across saves/restores.
  if (num)   num.value   = Number(value).toFixed(decimals);
}
function syncYawMultUI()  { syncTrialPairUI('trialYawMultRange',  'trialYawMultNum',  trialYawMult,  2); }
function syncDistanceUI() { syncTrialPairUI('trialDistanceRange', 'trialDistanceNum', trialDistance, 1); }
function syncHeightUI()   { syncTrialPairUI('trialHeightRange',   'trialHeightNum',   trialHeight,   2); }
function syncRollUI() {
  syncTrialPairUI('trialRollRange', 'trialRollNum', trialRollDeg, 1);
  refreshTrialRollActive();
}
function syncPitchUI() {
  syncTrialPairUI('trialPitchRange', 'trialPitchNum', trialPitchDeg, 1);
  refreshTrialRollActive();
}
// Highlight whichever Left/Center/Right camera-tilt preset (roll = −4 / 0 /
// +4, with pitch = 0) matches the current camera state. Off-preset values on
// either axis — including a non-zero pitch dragged in Advanced mode — leave
// every pill inactive, mirroring how the Look/Composition/Zoom pills go off
// when their advanced sliders diverge.
function refreshTrialRollActive() {
  const wrap = document.getElementById('trialRollPresets');
  if (!wrap) return;
  const pitchAtPreset = Math.abs(trialPitchDeg) < 1e-6;
  for (const b of wrap.querySelectorAll('.layer-btn')) {
    const rollMatch = Math.abs(Number(b.dataset.roll) - trialRollDeg) < 1e-6;
    b.classList.toggle('active', rollMatch && pitchAtPreset);
  }
}
// Debate ScenePosition X/Y pair — integer percent, no decimals.
function syncDebatePosUI(axis) {
  if (axis === 'x') syncTrialPairUI('trialDebatePosXRange', 'trialDebatePosXNum', trialDebatePosX, 0);
  else              syncTrialPairUI('trialDebatePosYRange', 'trialDebatePosYNum', trialDebatePosY, 0);
}

// Snap helpers — called from Look character / Composition / Zoom onclick to
// reset the direct camera params to whatever the template implies. Routed
// through the setTrial* setters so pill state reconciles via the same
// findYawMultPreset / findDistanceHeightZoomPreset path that the slider /
// number inputs use; the snap value is by construction a preset, so the
// matching pill ends up active. Subsequent slider/number edits then pull
// away from the template freely.
function applyYawMultFromTemplate() {
  const compShift = TRIAL_COMPOSITIONS[trialComposition] ?? 0;
  setTrialYawMult(trialTargetIdx() + compShift);
  syncYawMultUI();
}
function applyZoomFromTemplate() {
  const def = TRIAL_ZOOM_LEVELS[trialZoom];
  if (!def) return;
  setTrialDistance(def.D);
  setTrialHeight(def.H);
  syncDistanceUI();
  syncHeightUI();
}

// Toggle each section in the sidebar along three axes:
//   - data-scene-type: must match the active sceneType (adv vs trial).
//   - data-trial-advanced: trial-only controls shown only when advanced
//     mode is on. Covers both the sub-rows under Look/Zoom (yaw mult /
//     distance / height sliders) and the standalone Roll and Pitch groups.
//   - data-trial-subtype: trial-only rows that further depend on which
//     subtype (adv vs debate) is active — e.g. the overlay toggle group
//     only makes sense for the 'adv' subtype.
// Each element's visibility is recomputed from scratch every call: an
// element is visible iff ALL gates it carries are satisfied. The previous
// "layered passes" implementation got a row stuck hidden the moment any
// pass set el.hidden=true, because the next call's guard (`if (!el.hidden)`)
// then refused to consider it for un-hiding — so toggling Advanced on after
// switching scene types couldn't reveal the data-trial-advanced rows.
function applySidebarVisibility() {
  const gated = document.querySelectorAll(
    '[data-scene-type], [data-trial-advanced], [data-trial-subtype]',
  );
  for (const el of gated) {
    let visible = true;
    if (el.dataset.sceneType && el.dataset.sceneType !== sceneType) {
      visible = false;
    }
    if (el.hasAttribute('data-trial-advanced') && !trialAdvancedMode) {
      visible = false;
    }
    if (el.dataset.trialSubtype && el.dataset.trialSubtype !== trialSubtype) {
      visible = false;
    }
    el.hidden = !visible;
  }
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

// Populate one author <select> from charsConfig + AUTHOR_ORDER, filtered to
// entries that ship a non-empty tagged_name for the active locale. The
// currentId / setCurrentId pair handles reading and writing the state var
// the caller owns — same logic is reused for adv (`authorId`) and trial
// (`trialAuthorId`).
function populateOneAuthorSelect(selectId, currentId, setCurrentId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
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
  if (currentId && optValues.includes(currentId)) {
    sel.value = currentId;
  } else if (optValues.includes(DEFAULT_AUTHOR)) {
    setCurrentId(DEFAULT_AUTHOR);
    sel.value = DEFAULT_AUTHOR;
  } else if (optValues.length > 0) {
    setCurrentId(optValues[0]);
    sel.value = optValues[0];
  } else {
    setCurrentId('');
  }
}

// Repopulate both author selects (adv + trial-adv-subtype) from charsConfig.
// Safe to call before the trial select exists in the DOM — populateOneAuthorSelect
// short-circuits on a missing element.
function populateAuthorSelect() {
  populateOneAuthorSelect('authorSelect',      authorId,      (v) => { authorId      = v; });
  populateOneAuthorSelect('trialAuthorSelect', trialAuthorId, (v) => { trialAuthorId = v; });
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
// placement.scale=1.0 and Naninovel ScenePosition (X=50, Y=50) — i.e. the
// actor's transform.position is anchored at the canvas centre, matching
// the game's default actor state (Vector3.zero world position → centre of
// the scene rect). The actual snap pixels are offset from canvas centre by
// the per-character pivot delta from rig centre (5.85 m × PPU for layered
// Ema, etc.), so the visible character lands where the game would render
// it on first appearance.
function defaultPlacementFor(snap) {
  const stub = { slug: snap.slug, x: 0, y: 0, scale: 1.0 };
  return {
    slug:  snap.slug,
    x:     sceneXToPlacementX(50, stub, snap),
    y:     sceneYToPlacementY(50, stub, snap),
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

  // In trial mode, the "placed" annotation comes from trialStandSlots
  // (which stand holds this slug, if any), and clicking a row routes to
  // assignSnapshotToActiveStand rather than addOrSelectPlacement. The
  // snapshot library element is shared between modes — same DOM, mode-
  // aware behaviour.
  const trialMode = sceneType === 'trial';
  const trialSlots = trialMode ? currentStandSlots() : null;
  for (const snap of filtered) {
    const trialStandFor = trialMode ? trialSlots.indexOf(snap.slug) : -1;
    const placed   = trialMode ? (trialStandFor >= 0) : !!placementBySlug(snap.slug);
    const selected = trialMode
      ? (trialStandFor >= 0 && trialStandFor === trialSelectedStand)
      : (placed && selectedSlug === snap.slug);
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
    // In trial mode the "time" line doubles as the stand assignment readout
    // when placed, so the user can see at a glance which stand has this
    // snapshot without scrolling the Stands group.
    const timeEl = row.querySelector('.snapshot-time');
    if (trialMode && trialStandFor >= 0) {
      timeEl.textContent = `On stand ${trialStandFor}`;
    } else {
      timeEl.textContent = relativeTime(snap.createdAt);
    }
    const onActivate = () => {
      if (trialMode) assignSnapshotToActiveStand(snap.slug);
      else           addOrSelectPlacement(snap.slug);
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.snapshot-delete')) return;
      if (e.target.closest('.snapshot-rename')) return;
      onActivate();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
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
  const xNumEl    = document.getElementById('inspectorXValue');
  const yEl       = document.getElementById('inspectorY');
  const yNumEl    = document.getElementById('inspectorYValue');
  const scaleEl   = document.getElementById('inspectorScale');
  const scaleNumEl= document.getElementById('inspectorScaleValue');
  const nameEl    = document.getElementById('inspectorName');
  const toFrontEl = document.getElementById('placementToFront');
  const toBackEl  = document.getElementById('placementToBack');
  const removeEl  = document.getElementById('placementRemove');

  const inputs = [xEl, xNumEl, yEl, yNumEl, scaleEl, scaleNumEl];

  if (!placement) {
    nameEl.textContent = '(no selection)';
    xEl.value = xNumEl.value = 50;
    yEl.value = yNumEl.value = 50;
    scaleEl.value    = 1;
    scaleNumEl.value = '1.00';
    for (const el of inputs) el.disabled = true;
    toFrontEl.disabled = toBackEl.disabled = removeEl.disabled = true;
    return;
  }

  for (const el of inputs) el.disabled = false;
  removeEl.disabled = false;
  const snap = snapshots.get(placement.slug);
  nameEl.textContent = snap ? snap.name : placement.slug;
  const sx = Math.round(placementToSceneX(placement, snap));
  const sy = Math.round(placementToSceneY(placement, snap));
  // Skip the input the user is actively editing: reassigning .value (and,
  // for scale, reformatting via toFixed) resets the caret and swallows
  // mid-entry keystrokes. The focused element keeps its own live value;
  // its onchange clamps/reconciles on commit (Enter / blur).
  const setVal = (el, v) => { if (el !== document.activeElement) el.value = v; };
  setVal(xEl, sx);  setVal(xNumEl, sx);
  setVal(yEl, sy);  setVal(yNumEl, sy);
  setVal(scaleEl,    placement.scale);
  setVal(scaleNumEl, placement.scale.toFixed(2));
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
  // Apply the same orphan drop to the trial stand slots. Each prefab has its
  // own slot array; for any slug in a slot that no longer exists in
  // snapshots, set that slot to null. Skip prefab maps that were never
  // initialised (still null sentinels).
  for (const prefab of TRIAL_PREFABS) {
    const slots = trialStandSlots[prefab];
    if (!slots) continue;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] !== null && !snapshots.has(slots[i])) slots[i] = null;
    }
  }
  refreshSnapshotList();
  refreshInspector();
  populateTrialStandsUI();
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
  // Adv-only — trial mode's 3D court doesn't have per-character placements
  // (path A, the next step, will introduce them as billboards on the
  // lectern positions, but those won't be DOM overlays). Clear any leftover
  // overlays from a prior Adv session so they don't paint over the trial
  // canvas.
  if (sceneType === 'trial') {
    for (const el of previewContainer.querySelectorAll('.placement-overlay')) el.remove();
    return;
  }
  const displayRatio = canvas.clientHeight / CANVAS_H;
  if (!Number.isFinite(displayRatio) || displayRatio <= 0) return;
  // `.preview-container` is flex-centered on the scene editor, so the canvas
  // no longer sits at the container's top-left when the container is taller
  // or wider than the canvas. Add the canvas's offset so overlays track the
  // canvas's actual on-screen position instead of the container's origin.
  const offsetX = canvas.offsetLeft;
  const offsetY = canvas.offsetTop;

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
    el.style.left   = `${offsetX + p.x * displayRatio}px`;
    el.style.top    = `${offsetY + p.y * displayRatio}px`;
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
    // Toggle .is-selected inline instead of running the full overlay refresh.
    // The refresh re-appends every overlay (including this captured one), and
    // appendChild on a captured element implicitly releases pointer capture
    // in some browsers — which makes the drag get stuck the moment the cursor
    // crosses a higher-z-order overlay (events retarget by hit-test instead
    // of staying with the captured element).
    for (const o of document.querySelectorAll('.placement-overlay')) {
      o.classList.toggle('is-selected', o.dataset.slug === selectedSlug);
    }
    const placement = placementBySlug(selectedSlug);
    if (!placement) return;
    const canvas = document.getElementById('previewContainer').querySelector('canvas');
    const displayRatio = canvas ? canvas.clientHeight / CANVAS_H : 1;
    // Canvas offset within `.preview-container` — non-zero because the
    // container flex-centers the canvas. Capture once at drag start so the
    // live overlay position math below stays consistent with what
    // refreshPlacementOverlays would render.
    const offsetX = canvas ? canvas.offsetLeft : 0;
    const offsetY = canvas ? canvas.offsetTop  : 0;
    drag = {
      pointerId:    e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPlaceX:  placement.x,
      startPlaceY:  placement.y,
      displayRatio,
      offsetX,
      offsetY,
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
    // Update the dragged overlay's position directly. Avoid the full overlay
    // refresh (which would appendChild this captured element on every move
    // and can implicitly release pointer capture — see selectAndStartDrag).
    el.style.left = `${drag.offsetX + placement.x * drag.displayRatio}px`;
    el.style.top  = `${drag.offsetY + placement.y * drag.displayRatio}px`;
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
    canvas = sceneType === 'trial' ? await renderTrialScene() : await renderScene();
  } catch (e) {
    console.error('Render failed:', e);
    return;
  }
  // Discard if a newer render started while we were compositing.
  if (seq !== renderSeq) return;
  // Canvas display size is governed entirely by the `body.scene-editor
  // .preview-container canvas` rule (fits the available preview area while
  // preserving the 2560×1440 aspect). No inline width/height — letting CSS
  // win means the canvas reflows automatically on viewport resize.
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
  const canvas = sceneType === 'trial' ? await renderTrialScene() : await renderScene();
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  if (sceneType === 'trial') {
    // After a non-preset slider drag, trialLookStandIdx / trialComposition
    // can be null/'' and trialZoom can be null — substitute 'custom' so the
    // filename doesn't produce empty fragments or the literal 'null'.
    const lookFrag = (trialLookStandIdx !== null && trialLookStandIdx !== undefined)
      ? `stand${trialLookStandIdx}` : 'custom';
    const compFrag = trialComposition || 'custom';
    const zoomFrag = trialZoom != null ? trialZoom : 'custom';
    // For the 'adv' subtype, include the trial-side author in the filename
    // (matches scene_adv_<locale>_<author>_…), so a user exporting multiple
    // trial-with-adv-overlay shots of different speakers doesn't get
    // identically-named files. Debate subtype has no author concept yet, so
    // we skip the author fragment there.
    const authorFrag = trialSubtype === 'adv' ? `_${trialAuthorId || 'noauthor'}` : '';
    a.download = `scene_trial_${trialSubtype}${authorFrag}_${trialPrefab}_${lookFrag}_zoom${zoomFrag}_${compFrag}_${Date.now()}.png`;
  } else {
    const author = authorId || 'noauthor';   // 'noauthor' only fires if charsConfig had no entries for the active locale
    a.download = `scene_adv_${locale}_${author}_${Date.now()}.png`;
  }
  a.click();
  const btn = document.getElementById('exportBtn');
  const orig = btn.textContent;
  btn.textContent = 'Exported!';
  btn.classList.add('exported');
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('exported'); }, 1200);
}

// --- Modals ---

// Generic text-input modal. Resolves to the user-entered string (untrimmed —
// caller decides), or `null` on Cancel / Esc / click-outside. `title` swaps
// the heading; `initial` pre-fills the input (auto-selected on open so the
// user can overtype immediately); `sublabel` (optional) shows a single line
// between the title and the input — used by the rename flow to display the
// current snapshot name. Enter commits; Esc / overlay click cancels.
function showPromptModal(title, initial = '', sublabel = '') {
  return new Promise((resolve) => {
    const overlay     = document.getElementById('renameOverlay');
    const input       = document.getElementById('renameInput');
    const confirmBtn  = document.getElementById('renameConfirm');
    const cancelBtn   = document.getElementById('renameCancel');
    const titleEl     = document.getElementById('renameTitle');
    const subEl       = document.getElementById('renameCurrent');
    const titlePrev   = titleEl.textContent;
    titleEl.textContent = title;
    subEl.textContent   = sublabel;
    subEl.hidden        = !sublabel;
    input.value         = initial;
    overlay.classList.add('active');
    // Defer focus to next frame so the modal's display:flex transition
    // doesn't suppress the autofocus + select.
    requestAnimationFrame(() => { input.focus(); input.select(); });
    function close(result) {
      overlay.classList.remove('active');
      // Restore defaults so the next caller sees clean state.
      titleEl.textContent = titlePrev;
      subEl.hidden = false;
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

// Snapshot-rename specialization: pre-fills with the current name and
// surfaces it on the sublabel line so the user can compare against the
// in-flight value. Returns the new (untrimmed) name or `null` on cancel.
function showRenameModal(currentName) {
  return showPromptModal('Rename snapshot', currentName, `Current: ${currentName}`);
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
  // Seed debate inputs from defaults (loadSceneConfig will overwrite if a
  // saved record exists). The slider+number pairs go through syncDebatePosUI
  // so both halves of each pair show identical values.
  document.getElementById('trialDebateInput').value = trialDebateText;
  syncDebatePosUI('x');
  syncDebatePosUI('y');
  // Initial sidebar visibility: defaults to sceneType='adv', so Adv fields
  // visible and Trial fields hidden until either the user picks 'Trial' from
  // the dropdown or loadSceneConfig restores a saved 'trial' state.
  applySidebarVisibility();

  document.getElementById('sceneTypeSelect').onchange = async (e) => {
    if (!SCENE_TYPES.has(e.target.value)) return;
    sceneType = e.target.value;
    applySidebarVisibility();
    if (sceneType === 'trial') await ensureTrialUIInit();
    // Snapshot library is shared across modes — repaint so trial vs adv
    // annotations ("On stand X" vs the relative-time line) and click
    // routing reflect the new mode.
    refreshSnapshotList();
    scheduleRender();
    scheduleSceneConfigSave();
  };
  // Group headers fold each trial section open/closed (mirrors the
  // character editor's #groups). All trial groups default expanded;
  // collapse state lives in the DOM only and isn't persisted across reloads.
  for (const header of document.querySelectorAll('#groups .group-header')) {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('collapsed');
    });
  }
  // Advanced toggle gates the direct-camera controls: the yaw mult /
  // distance / height sub-rows under Look character / Zoom, plus the
  // standalone Roll and Pitch groups. No scheduleRender — visibility
  // doesn't change the camera, just what the user can see in the panel.
  document.getElementById('trialAdvancedToggle').onclick = (e) => {
    trialAdvancedMode = !trialAdvancedMode;
    e.currentTarget.classList.toggle('active', trialAdvancedMode);
    applySidebarVisibility();
    scheduleSceneConfigSave();
  };
  document.getElementById('trialPrefab').onchange = async (e) => {
    if (!TRIAL_PREFABS.has(e.target.value)) return;
    trialPrefab = e.target.value;
    // Different prefab → different stand-slot array (independent per
    // prefab). Clear the active selection since indices > new prefab's N
    // would be out of range. populateTrialLookCharSelect repaints the look
    // pill row + the Stands group via its callees.
    trialSelectedStand = null;
    await populateTrialLookCharSelect();
    refreshSnapshotList();      // "On stand X" annotations are per-prefab
    // The look-target → yaw mapping is prefab-independent (just standIdx +
    // composition), but the look target itself may have flipped to a
    // different stand or to null. Re-snap so yaw lands on the new target.
    applyYawMultFromTemplate();
    scheduleRender();
    scheduleSceneConfigSave();
  };
  // Composition: 3 static preset buttons. Look-character buttons are wired
  // inside populateTrialLookCharSelect (per-button click handler at create
  // time, since the buttons don't exist until the lazy court module loads).
  for (const b of document.querySelectorAll('#trialCompositionPresets .layer-btn')) {
    b.addEventListener('click', () => {
      trialComposition = b.dataset.comp;
      // applyYawMultFromTemplate → setTrialYawMult reconciles the pills.
      applyYawMultFromTemplate();
      scheduleRender();
      scheduleSceneConfigSave();
    });
  }
  // Zoom: 4 static preset buttons (Lvl 1..4). Snaps distance + height to
  // the corresponding ZOOM_LEVELS preset when clicked, mirroring how
  // Composition snaps yaw multiplier.
  for (const b of document.querySelectorAll('#trialZoomPresets .layer-btn')) {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.zoom);
      if (!Number.isInteger(v) || v < 1 || v > 4) return;
      trialZoom = v;
      // applyZoomFromTemplate → setTrialDistance / setTrialHeight →
      // syncZoomPillFromDH reconciles the pill (resolves to v).
      applyZoomFromTemplate();
      scheduleRender();
      scheduleSceneConfigSave();
    });
  }

  // Subtype: 2 static preset buttons (Adv / Debate). Picks which overlay
  // set composites on top of the courtroom render. Also toggles the
  // visibility of subtype-gated rows (currently just the trial overlay
  // toggle group).
  for (const b of document.querySelectorAll('#trialSubtypePresets .layer-btn')) {
    b.addEventListener('click', () => {
      if (!TRIAL_SUBTYPES.has(b.dataset.subtype)) return;
      if (trialSubtype === b.dataset.subtype) return;
      trialSubtype = b.dataset.subtype;
      refreshTrialSubtypeActive();
      applySidebarVisibility();
      scheduleRender();
      scheduleSceneConfigSave();
    });
  }

  // Trial-side overlay toggles. Each writes its module-level flag and
  // re-renders. Only consumed when trialSubtype === 'adv' (the prefab loop
  // in renderTrialScene routes through TOGGLE_FLAGS, which routes the four
  // toggle names through sceneType-aware getters).
  const trialOverlayBindings = [
    ['toggleTrialAuthorPlate',      (v) => { trialShowAuthorPlate       = v; }],
    ['toggleTrialAutoToggle',       (v) => { trialShowAutoToggle        = v; }],
    ['toggleTrialMenuButton',       (v) => { trialShowMenuButton        = v; }],
    ['toggleTrialBookButton',       (v) => { trialShowBookButton        = v; }],
    ['toggleTrialDebateBookButton', (v) => { trialDebateShowBookButton  = v; }],
    ['toggleTrialDebateClock',      (v) => { trialDebateShowClock       = v; }],
    ['toggleTrialDebateFastButton', (v) => { trialDebateShowFastButton  = v; }],
  ];
  for (const [id, set] of trialOverlayBindings) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.onchange = (e) => {
      set(e.target.checked);
      scheduleRender();
      scheduleSceneConfigSave();
    };
  }

  // Trial choice screen overlay: show toggle + portrait picker + button list.
  initTrialChoiceUI();

  // Direct sliders + number inputs. Each pair shares the same underlying
  // state var (trialYawMult / trialDistance / trialHeight); updating one
  // input mirrors to the other so the displayed values never diverge.
  // Slider drags use a tighter scheduleRender delay than number-input typing
  // because pointer-drag generates an `input` event per pixel and we want
  // the preview to feel live; typing into a number input fires per
  // keystroke, where coalescing more aggressively is fine.
  function bindTrialSliderPair(rangeId, numId, decimals, setter, dragDelay = 60, typeDelay = 120) {
    const range = document.getElementById(rangeId);
    const num   = document.getElementById(numId);
    range.oninput = (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      setter(v);
      num.value = Number(v).toFixed(decimals);
      scheduleRender(dragDelay);
      scheduleSceneConfigSave();
    };
    num.oninput = (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      setter(v);
      range.value = String(v);
      scheduleRender(typeDelay);
      scheduleSceneConfigSave();
    };
  }
  // Each setter also handles its corresponding pill row's deselect/snap-on-
  // preset logic. setTrialYawMult covers look-char + composition pills;
  // setTrialDistance / setTrialHeight cover the zoom pill row.
  bindTrialSliderPair('trialYawMultRange',  'trialYawMultNum',  2, setTrialYawMult);
  bindTrialSliderPair('trialDistanceRange', 'trialDistanceNum', 1, setTrialDistance);
  bindTrialSliderPair('trialHeightRange',   'trialHeightNum',   2, setTrialHeight);
  // Roll and Pitch share the Tilt group's preset pill row, so both setters
  // refresh the pill highlight after mutating their axis. Without this, the
  // pills would stay marked active after a slider drag moves either axis off
  // its preset value — the bindTrialSliderPair pipeline only calls the setter
  // (not syncRollUI / syncPitchUI), so the refresh has to happen inside the
  // setter itself, just like setTrialYawMult/Distance/Height do for their
  // pills.
  bindTrialSliderPair('trialRollRange',     'trialRollNum',     1, (v) => { trialRollDeg  = v; refreshTrialRollActive(); });
  bindTrialSliderPair('trialPitchRange',    'trialPitchNum',    1, (v) => { trialPitchDeg = v; refreshTrialRollActive(); });
  // Debate ScenePosition X/Y. Integer percent (decimals=0); shares the same
  // drag/type delay defaults as the camera sliders.
  bindTrialSliderPair('trialDebatePosXRange', 'trialDebatePosXNum', 0, (v) => { trialDebatePosX = v; });
  bindTrialSliderPair('trialDebatePosYRange', 'trialDebatePosYNum', 0, (v) => { trialDebatePosY = v; });
  // Camera Tilt preset pills (Left/Center/Right → roll −4/0/+4, pitch 0).
  // Click snaps both axes' slider+number pairs to the preset, refreshes the
  // active pill (via syncRollUI), and re-renders. The pitch reset matters
  // because refreshTrialRollActive only marks a pill active when pitch is at
  // its preset value too — without zeroing pitch here a stale advanced-mode
  // pitch drag would leave every pill inactive after a click.
  for (const b of document.querySelectorAll('#trialRollPresets .layer-btn')) {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.roll);
      if (!Number.isFinite(v)) return;
      trialRollDeg  = v;
      trialPitchDeg = 0;
      syncRollUI();    // refreshes the active pill (sees the cleared pitch)
      syncPitchUI();   // re-syncs the pitch slider/num to 0
      scheduleRender();
      scheduleSceneConfigSave();
    });
  }
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

  // Trial-side Author + Message — same shape as the adv handlers above, just
  // bound to the trial state vars. Visible only when trialSubtype === 'adv'.
  document.getElementById('trialAuthorSelect').onchange = (e) => {
    trialAuthorId = e.target.value;
    scheduleRender();
    scheduleSceneConfigSave();
  };
  const trialMessageInput = document.getElementById('trialMessageInput');
  trialMessageInput.oninput = (e) => {
    trialMessageText = e.target.value;
    scheduleRender(400);
    scheduleSceneConfigSave();
  };
  trialMessageInput.onchange = () => scheduleRender();

  // Debate testimony textarea. Same coalesced-render shape as the message
  // textareas above. Visible only when trialSubtype === 'debate'.
  const trialDebateInput = document.getElementById('trialDebateInput');
  trialDebateInput.oninput = (e) => {
    trialDebateText = e.target.value;
    scheduleRender(400);
    scheduleSceneConfigSave();
  };
  trialDebateInput.onchange = () => scheduleRender();

  // Color swatches under each text input. Clicking a swatch wraps the
  // textarea's current selection with `<color=#xxxxxx>...</color>` using
  // that swatch's hex. With no selection, an empty tag pair is inserted
  // at the caret. Focus stays in the textarea and the selection is left
  // covering the wrapped substring (or sitting between the empty pair)
  // so the user can keep typing without re-clicking. The renderer for
  // each leaf (MessageLabel via renderPlainText, debate testimony via
  // renderDebateText) parses the same `<color>` tag with stack semantics.
  //
  // The four hex codes surfaced are debate/trial-relevant colors found
  // in the deployed game bundles:
  //   #9c8eff — AnAn's accent (34 uses in act01_chapter02 trial scripts)
  //   #6B85D0 — Yuki's accent (4 uses in act02_chapter06 trial scripts)
  //   #ff0000 — "help me" scream scene (advbad chapter01, 84 uses)
  //   #FF92B4 — testimony press-point color from the DebatePrinter TMP
  //              style sheet ("Objection" style — runtime expansion of
  //              `<link>`-marked press-points; we only mirror the color,
  //              not the +0.25em size or -0.075em voffset)
  // The three textareas share one wrap helper.
  function bindColorSwatches(textarea, applyValue) {
    const row = textarea.parentElement.querySelector('.color-wrap-row');
    if (!row) return;
    // Shared wrap helper: surrounds [selStart, selEnd) with open/close,
    // updates the state setter, and restores selection to cover the
    // wrapped substring so chained clicks (e.g. <color> then <b>) keep
    // operating on the same span. With no selection, an empty tag pair
    // is inserted at the caret and the cursor sits between them.
    function wrapWith(open, close, selStart, selEnd) {
      const v = textarea.value;
      const s = selStart ?? textarea.selectionStart ?? v.length;
      const e = selEnd   ?? textarea.selectionEnd   ?? v.length;
      const before = v.slice(0, s);
      const inside = v.slice(s, e);
      const after  = v.slice(e);
      const next   = before + open + inside + close + after;
      textarea.value = next;
      applyValue(next);
      const innerStart = before.length + open.length;
      const innerEnd   = innerStart + inside.length;
      textarea.focus();
      textarea.setSelectionRange(innerStart, innerEnd);
      scheduleRender();
      scheduleSceneConfigSave();
    }
    for (const sw of row.querySelectorAll('.color-swatch')) {
      sw.onclick = () => {
        const hex = (sw.dataset.hex || '#ffffff').toLowerCase();
        wrapWith(`<color=${hex}>`, `</color>`);
      };
    }
    const boldBtn = row.querySelector('[data-tag="b"]');
    if (boldBtn) {
      boldBtn.onclick = () => wrapWith('<b>', '</b>');
    }
    const objBtn = row.querySelector('[data-tag="obj"]');
    if (objBtn) {
      // `<obj>` is our editor's shorthand for the in-game Objection style
      // (color + 1.25× size + downward voff). The source-script form is
      // `<link="Objection_XX">…</link>` — different tag, identical effect.
      objBtn.onclick = () => wrapWith('<obj>', '</obj>');
    }
    const rubyBtn = row.querySelector('[data-tag="ruby"]');
    if (rubyBtn) {
      rubyBtn.onclick = async () => {
        // Capture the selection before opening the modal, because the
        // modal's input will steal focus and clear textarea.selection*.
        const s = textarea.selectionStart ?? 0;
        const e = textarea.selectionEnd   ?? 0;
        if (e === s) {
          // No body selected — ruby needs a kanji span to attach to.
          // Surface a hint via the existing modal infra rather than
          // silently doing nothing.
          await showModal('Select the kanji body first, then click Ruby.');
          return;
        }
        const reading = await showPromptModal('Ruby reading (furigana)');
        if (reading === null) return;
        const trimmed = reading.trim();
        if (!trimmed) return;
        // Quotes in the reading would terminate the attribute early —
        // strip them so a paste like `"こけ"` still produces a valid tag.
        const clean = trimmed.replace(/"/g, '');
        wrapWith(`<ruby="${clean}">`, '</ruby>', s, e);
      };
    }
  }
  bindColorSwatches(messageInput,      (v) => { messageText      = v; });
  bindColorSwatches(trialMessageInput, (v) => { trialMessageText = v; });
  bindColorSwatches(trialDebateInput,  (v) => { trialDebateText  = v; });

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
    if (sceneType === 'trial') {
      // Trial reset: locale + dropdowns (templates) + direct camera values
      // + roll + pitch. Locale doesn't affect the current trial preview,
      // but resetting it keeps trial and adv reset behaviour symmetric (so
      // reset-from-trial-then-flip-to-adv behaves the same as reset-from-
      // adv) and gives any future locale-dependent trial UI (stand
      // placards, character labels) a sane starting point.
      setLocale('ko');
      trialPrefab       = 'court';
      // Drop both stand-slot maps — lazy-seed will populate them as empty
      // arrays on next access. The user can re-place snapshots from a clean
      // slate, matching the "Reset all customizations" intent.
      trialStandSlots   = { court: null, court_final: null };
      trialSelectedStand = null;
      trialLookStandIdx = null;
      trialComposition  = 'center';
      trialZoom         = 1;
      trialRollDeg      = 0;
      trialPitchDeg     = 0;
      trialAdvancedMode = false;
      document.getElementById('trialAdvancedToggle').classList.remove('active');
      // Subtype back to 'adv' (the default and the only fully-implemented
      // variant). Trial overlay toggles back to all-on.
      trialSubtype = 'adv';
      refreshTrialSubtypeActive();
      trialShowAuthorPlate = trialShowAutoToggle = trialShowMenuButton = trialShowBookButton = true;
      trialDebateShowBookButton = trialDebateShowClock = trialDebateShowFastButton = true;
      trialDebateFastIconActive = false;
      for (const id of [
        'toggleTrialAuthorPlate', 'toggleTrialAutoToggle', 'toggleTrialMenuButton',
        'toggleTrialBookButton',
        'toggleTrialDebateBookButton', 'toggleTrialDebateClock', 'toggleTrialDebateFastButton',
      ]) {
        const el = document.getElementById(id);
        if (el) el.checked = true;
      }
      // Trial author + message reset. Empty trialMessageText (matches adv
      // reset). Drop trialAuthorId so populateAuthorSelect re-resolves to
      // DEFAULT_AUTHOR for the active locale, same pattern as the adv side.
      trialMessageText = '';
      trialAuthorId    = '';
      populateAuthorSelect();   // repopulates both selects; the trial one
                                // ends up on DEFAULT_AUTHOR for active locale
      document.getElementById('trialMessageInput').value = '';
      // Debate state back to defaults (empty text, pos:70,50). Timer text
      // is re-rolled randomly every render, so no state to reset here.
      trialDebateText = '';
      trialDebatePosX = 70;
      trialDebatePosY = 50;
      document.getElementById('trialDebateInput').value = '';
      syncDebatePosUI('x');
      syncDebatePosUI('y');
      // Trial choice screen back to defaults: overlay off, Hiro portrait,
      // the seeded sample set, and the default Cancel label.
      trialDebateShowChoiceUI = false;
      trialChoicePortrait     = 'Hiro';
      trialChoiceButtons      = defaultTrialChoiceButtons();
      trialChoiceCancelLabel  = 'Cancel';
      document.getElementById('toggleTrialChoiceUI').checked = false;
      refreshTrialChoicePortraitActive();
      renderTrialChoiceList();
      // All trial groups default expanded — clear any user-toggled .collapsed.
      for (const g of document.querySelectorAll('#groups .group')) {
        g.classList.remove('collapsed');
      }
      applySidebarVisibility();
      document.getElementById('trialPrefab').value      = trialPrefab;
      await populateTrialLookCharSelect();   // also refreshes look-char active class
      refreshTrialCompositionActive();
      refreshTrialZoomActive();
      // Direct camera values reset to whatever the templates imply at
      // defaults — applyZoomFromTemplate uses TRIAL_ZOOM_LEVELS[1] = (10, 5.2),
      // applyYawMultFromTemplate uses idx 0 (ema) + comp 0 = 0. Roll/pitch
      // have no template, just sync the slider+number pairs to 0.
      applyYawMultFromTemplate();
      applyZoomFromTemplate();
      syncRollUI();
      syncPitchUI();
      scheduleRender();
      scheduleSceneConfigSave();
      return;
    }
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

  // Canvas display size is viewport-relative (CSS `max-width/height: 100%`
  // on `body.scene-editor .preview-container canvas`), so the displayRatio
  // and the canvas's offset within the container both change when the
  // viewport resizes. Refresh overlays so they keep tracking the canvas.
  // No-op for trial — refreshPlacementOverlays early-returns there.
  window.addEventListener('resize', refreshPlacementOverlays);

  // Debate FastButton click → toggle FastIcon active ↔ inactive. Hit-tests
  // the FastButtonBase rect in canvas coords. Sidebar's "Fast button"
  // switch handles hidden vs visible (so when hidden, the button isn't
  // there to click — we early-return on !trialDebateShowFastButton).
  // Bound to the *container* because the canvas element is swapped on
  // every render — per-canvas listeners would leak.
  document.getElementById('previewContainer').addEventListener('click', (e) => {
    if (sceneType !== 'trial' || trialSubtype !== 'debate') return;
    if (!trialDebateShowFastButton) return;
    const canvas = e.currentTarget.querySelector('canvas');
    if (!canvas || !trialMeta) return;
    const debateUI = trialMeta.prefabs?.find(p => p.name === 'DebateUI');
    const base     = debateUI?.layers?.find(l => l.name === 'FastButtonBase');
    if (!base) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    if (cx < base.pos[0] || cx >= base.pos[0] + base.size[0]) return;
    if (cy < base.pos[1] || cy >= base.pos[1] + base.size[1]) return;
    trialDebateFastIconActive = !trialDebateFastIconActive;
    scheduleRender();
    scheduleSceneConfigSave();
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
  const inspectorX     = document.getElementById('inspectorX');
  const inspectorXNum  = document.getElementById('inspectorXValue');
  const inspectorY     = document.getElementById('inspectorY');
  const inspectorYNum  = document.getElementById('inspectorYValue');
  const inspectorScale = document.getElementById('inspectorScale');
  // X/Y inputs are ScenePosition % (Naninovel-anchored at snapshot pivot);
  // sceneXToPlacementX / sceneYToPlacementY reproject to pixel placement.x/y.
  // The slider + number stay mirrored so dragging one repaints the other.
  function applyScenePosX(v) {
    withSelected(p => {
      const snap = snapshots.get(p.slug);
      p.x = sceneXToPlacementX(v, p, snap);
    }, { render: false });
  }
  function applyScenePosY(v) {
    withSelected(p => {
      const snap = snapshots.get(p.slug);
      p.y = sceneYToPlacementY(v, p, snap);
    }, { render: false });
  }
  inspectorX.oninput = (e) => {
    const v = Number(e.target.value) || 0;
    inspectorXNum.value = v;
    applyScenePosX(v);
  };
  inspectorX.onchange = () => scheduleRender();
  inspectorXNum.oninput = (e) => {
    const v = Number(e.target.value) || 0;
    inspectorX.value = v;
    applyScenePosX(v);
  };
  inspectorXNum.onchange = (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    e.target.value = v;
    inspectorX.value = v;
    applyScenePosX(v);
    scheduleRender();
  };
  inspectorY.oninput = (e) => {
    const v = Number(e.target.value) || 0;
    inspectorYNum.value = v;
    applyScenePosY(v);
  };
  inspectorY.onchange = () => scheduleRender();
  inspectorYNum.oninput = (e) => {
    const v = Number(e.target.value) || 0;
    inspectorY.value = v;
    applyScenePosY(v);
  };
  inspectorYNum.onchange = (e) => {
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
    e.target.value = v;
    inspectorY.value = v;
    applyScenePosY(v);
    scheduleRender();
  };
  const inspectorScaleNum = document.getElementById('inspectorScaleValue');
  // Naninovel scales an actor around its pivot: the rendered mesh is built
  // with the pivot at the transform's local origin (TransitionalSpriteBuilder
  // .ApplyPivot), and `@char scale` sets transform.localScale, which Unity
  // applies around that origin. Placements store the sprite's top-left, so a
  // naive `p.scale = v` would instead grow the sprite from its corner and
  // drift the pivot. Capture the ScenePosition % before the change and
  // reproject p.x/p.y after, keeping the pivot (= ScenePos) pinned.
  function applyScale(v) {
    withSelected(p => {
      const snap = snapshots.get(p.slug);
      const sx = placementToSceneX(p, snap);
      const sy = placementToSceneY(p, snap);
      p.scale = v;
      p.x = sceneXToPlacementX(sx, p, snap);
      p.y = sceneYToPlacementY(sy, p, snap);
    }, { render: false });
  }
  // Slider drag → number input mirrors. Render is deferred until pointer-up
  // (onchange) so the scale slider stays fluid during continuous drags.
  inspectorScale.oninput = (e) => {
    const v = clampScale(Number(e.target.value));
    inspectorScaleNum.value = v.toFixed(2);
    applyScale(v);
  };
  inspectorScale.onchange = () => scheduleRender();
  // Number input direct entry. `oninput` updates the slider live as the user
  // types (so dragging-from-the-spinner feels parallel to the slider drag);
  // `onchange` clamps and snaps the displayed string on commit (Enter / blur)
  // and triggers the actual scene render.
  inspectorScaleNum.oninput = (e) => {
    const v = clampScale(Number(e.target.value));
    inspectorScale.value = v;
    applyScale(v);
  };
  inspectorScaleNum.onchange = (e) => {
    const v = clampScale(Number(e.target.value));
    e.target.value = v.toFixed(2);
    inspectorScale.value = v;
    applyScale(v);
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

  // Cancel any pending scheduleRender timer fired during load* setup
  // (loadPlacements calls scheduleRender if any saved placements exist; that
  // would race with the explicit drawPreview below and, on the trial path,
  // duplicate the CourtRenderer construction).
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
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
