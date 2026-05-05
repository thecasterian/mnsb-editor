# Court camera presets — every angle, position, and FOV the trial scripts use

This file enumerates every camera configuration that appears in the witch-trial corpus, decoded from the Naninovel script bundles in `manosaba_Data/StreamingAssets/aa/StandaloneWindows64/`. For the courtroom geometry these cameras are pointed at, see [`court_geometry.md`](./court_geometry.md).

## TL;DR

- **vFOV = 30°** (the **legacy `field of view: 30`** value from `CameraContainer.prefab`). The prefab also has Physical Camera mode enabled (`m_projectionMatrixMode: 1`, focal 68.06 mm, sensor 36 × 24 mm), but the runtime overrides it — something writes `Camera.fieldOfView = 30` imperatively, switching the camera back into legacy mode. **Verified against in-game screenshot of `Act01_Chapter01_Trial00`** (Meruru↔Ema midpoint shot at D=4, H=5, yaw=346.15°). The Physical Camera math is documented below for reference but is **not** what the runtime uses.
- **Position:** orbital around the courtroom centre, **camera on the SAME side as the look-target** — `pos = (+D · sin yaw, H, +D · cos yaw)`, with `yaw = (targetCharIdx + composition) · 360° / courtStandCount`. The camera sits *inside* the lectern ring (lectern radius 14.8 m), looking *outward* at its assigned character on the lectern ring at the same angular position.
- **Rotation:** Euler `(pitch, yaw, roll)` in Unity convention. The named preset library always uses `pitch = 0`; only some direct camera commands and the SplitScreen labels use ±1°…±3°.
- **16,544 named-preset calls + 179 direct calls + 101 split-screen invocations = 16,824 camera moves** across all trial scripts.
- **Two main characters (Hiro 25.9% + Ema 22.4%) account for 48% of all camera attention.** Composition is off-centre 55% of the time. Camera rolls cinematically 12% of the time.

## Source-of-truth bundles

| Path | Contents |
|---|---|
| `naninovel-scripts_assets_naninovelscripts-system.bundle` | `System_Subroutine` — the named-preset label library and the `cameraYaw` / `cameraRoll` formulas |
| `naninovel-scripts_assets_naninovelscripts-act{NN}_chapter{NN}_trial.bundle` | `Act{NN}_Chapter{NN}_TrialInit` (per-character idx assignments) + `Trial00`..`Trial15` (the camera calls) |

Use `python3 scripts/inspect_bundle.py <path>` to inspect; the camera commands come out as `MonoBehaviour`s with class `ModifyPerspectiveStageCamera` (direct) or `GosubToModifyPerspectiveStageCamera` (preset).

## The Camera component (FOV / projection)

`CameraContainer.prefab` carries a single Unity Camera with both Physical Camera fields and a legacy `field of view` value. The serialized state appears to enable Physical mode, but the **runtime overrides this** — verified by comparing rendered output to in-game screenshots, the actual projection matches the **legacy `field of view: 30`** value at any output resolution.

```yaml
m_projectionMatrixMode: 1            # Physical Camera mode set in editor —
                                     # OVERRIDDEN AT RUNTIME (something sets
                                     # Camera.fieldOfView = 30 imperatively,
                                     # which flips Unity back to legacy mode)
m_FOVAxisMode:          0            # Vertical (would apply if Physical were active)
m_GateFitMode:          2            # Fill (would apply if Physical were active)
m_FocalLength:          68.05538     # mm  (would apply if Physical were active)
m_SensorSize: { x: 36, y: 24 }       # mm  (would apply if Physical were active)
m_LensShift:  { x: 0, y: 0 }
near clip plane:        0.3          # m
far clip plane:         50           # m
field of view:          30           # ACTIVE — vertical FOV in degrees
```

### What's actually used

```
vFOV = 30.00°
hFOV = 2 · atan( tan(vFOV/2) · (W/H) ) = 2 · atan(0.2679 · 1.778) = 50.84°    @ 16:9
```

The script renderer uses this value directly: `FOV_DEG_VERTICAL = 30.0` in `scripts/render_court_3d.py`. The same value applies at any output aspect ratio (Unity's legacy field-of-view is the vertical angle by convention; horizontal scales with aspect).

### Reference: the Physical Camera math (NOT used at runtime)

The serialized Physical fields *would* compute vFOV = 16.92° if the runtime honoured them. They don't. The math is preserved here for completeness because (a) the prefab fields are real and someone reading the project may wonder why they're set, and (b) the override mechanism (almost certainly a `Camera.fieldOfView = ...` write inside the WitchTrials view controller) isn't visible in the AssetRipper export — the controller's MonoBehaviour script GUID (`0000000deadbeef15deadf00d0000000`) is a placeholder that didn't resolve to source.

```
sensor_aspect       = 36 / 24      = 1.500
screen_aspect       = 2560 / 1440  = 1.778        (game's reference 16:9)
sensor_natural_vFOV = 2·atan(24 / (2·68.06))      = 20.00°
effective_h_mm      = 24 · (1.5 / 1.778)          = 20.25 mm   (Fill mode crops vertically)
hypothetical_vFOV   = 2 · atan(20.25 / (2·68.06)) = 16.92°     (NOT used)
```

The implementation is in `physical_camera_vfov_deg()` in `scripts/render_court_3d.py` for reference (callable but not invoked).

## Pose math

```
yaw_deg     = (targetCharIdx + composition_shift) · 360° / courtStandCount
position    = (+D · sin yaw, H, +D · cos yaw)              (orbital around origin;
                                                            camera on the SAME side
                                                            as the look-target,
                                                            INSIDE the lectern ring)
rotation    = Q.Euler(pitch, yaw, roll)                    (Unity convention)
forward_world = R_y(yaw) · R_x(pitch) · (0, 0, 1)
            = (cos pitch · sin yaw, −sin pitch, cos pitch · cos yaw)
up_world    = R_y(yaw) · R_x(pitch) · R_z(roll) · (0, 1, 0)
            = (sin yaw · sin pitch · cos roll − cos yaw · sin roll,
               cos pitch · cos roll,
               cos yaw · sin pitch · cos roll + sin yaw · sin roll)
```

The camera at radius `D` and the look-target (character at radius 16) are at the **same angular position** — both at `yaw`. The camera looks *outward* (away from origin, in the +radial direction at angle `yaw`). The look-target is `(16 − D)` metres ahead of the camera along the look ray. For Lvl1 (D=10): look-target 6 m ahead — close-up. For Lvl4 (D=13): 3 m ahead — tighter. Smaller D ⇒ wider shot; larger D ⇒ tighter close-up.

`courtStandCount` is **13 for `Court.prefab`** (Act01 ch1-5 and Act02 ch1-5 trials) and **14 for `Court_Final.prefab`** (Act02 ch6 only — the finale).

`composition_shift` is a fraction of one stand-spacing:
- `Center` →  0
- `Left`   → +0.1   (camera rotated CCW around Y → target appears on the left of frame)
- `Right`  → −0.1   (mirror)

The camera's *position* shifts on the orbital ring as `yaw` changes; the camera's *rotation* matches `yaw` so it keeps pointing radially **outward** (toward its assigned look-character on the same orbital angle). So a Left/Right composition shift moves the camera and the look direction together by `±0.1 · 360° / 13 ≈ ±2.77°`. The angular shift moves the look-character off-centre by the same arc but in the opposite frame-direction (Left composition rotates camera CCW around origin, which makes the on-axis target appear on the LEFT of the frame).

## The named-preset library (`System_Subroutine`)

`GosubToModifyPerspectiveStageCamera` resolves to one of these labels, each containing a single `ModifyPerspectiveStageCamera` command. `cameraIdx`, `cameraYaw`, `cameraRoll` are local custom variables set by the dispatcher. **In every label below, pitch = 0.**

### Single-camera labels (full-screen mode, `Index = 0`)

| Label | Distance D | Height H | Composition shift | Roll | Used by |
|---|---|---|---|---|---|
| `.ModifyCamera-Center-NoRoll-Lvl1` | 10 | 5.2 | 0      | 0   | `(default)` Comp=Center NoRoll |
| `.ModifyCamera-Center-NoRoll-Lvl2` | 11 | 5.3 | 0      | 0   | Lvl2 Center NoRoll |
| `.ModifyCamera-Center-NoRoll-Lvl3` | 12 | 5.5 | 0      | 0   | Lvl3 Center NoRoll |
| `.ModifyCamera-Center-NoRoll-Lvl4` | 13 | 5.6 | 0      | 0   | Lvl4 Center NoRoll |
| `.ModifyCamera-Left-NoRoll-Lvl1`   | 10 | 5.2 | +0.1   | 0   | `(default)` Comp=Left NoRoll |
| `.ModifyCamera-Left-NoRoll-Lvl3`   | 12 | 5.5 | +0.1   | 0   | Lvl3 Left NoRoll |
| `.ModifyCamera-Left-NoRoll-Lvl4`   | 13 | 5.6 | +0.1   | 0   | Lvl4 Left NoRoll |
| `.ModifyCamera-Left-Right-Lvl3`    | 12 | 5.5 | +0.1   | +5° | Lvl3 Left RightRoll |
| `.ModifyCamera-Left-Right-Lvl4`    | 13 | 5.6 | +0.1   | +5° | Lvl4 Left RightRoll |
| `.ModifyCamera-Right-NoRoll-Lvl1`  | 10 | 5.2 | −0.1   | 0   | `(default)` Comp=Right NoRoll |
| `.ModifyCamera-Right-NoRoll-Lvl3`  | 12 | 5.5 | −0.1   | 0   | Lvl3 Right NoRoll |
| `.ModifyCamera-Right-NoRoll-Lvl4`  | 13 | 5.6 | −0.1   | 0   | Lvl4 Right NoRoll |
| `.ModifyCamera-Right-Left-Lvl3`    | 12 | 5.5 | −0.1   | −5° | Lvl3 Right LeftRoll |
| `.ModifyCamera-Right-Left-Lvl4`    | 13 | 5.6 | −0.1   | −5° | Lvl4 Right LeftRoll |

13 unique single-camera labels. Note:
- **Lvl2** only exists for Center (3 absent labels: `Left-NoRoll-Lvl2`, `Right-NoRoll-Lvl2`, both Roll-Lvl2 variants). Used in 178 calls (1.1%).
- **Lvl1** is the `(default)` for empty `ZoomLevel` per `GosubToModifyPerspectiveStageCamera`'s C# default — 85.3% of all preset calls leave `ZoomLevel` empty.
- **Roll labels only exist for Lvl3 and Lvl4** (no rolled close-ups Lvl1 / 2). The "rolled close-up" combination would have to be a direct command.

### Split-screen labels (paired `Index 0` + `Index 1`, full-screen replaced by two side-by-side)

These dispatch to two consecutive `ModifyPerspectiveStageCamera` commands — one for each split-screen camera. Used in 101 invocations.

| Label | First cmd `(D, H, pitch, yaw shift, roll)` | Second cmd (Index 1 follow-up) |
|---|---|---|
| `.SplitScreen-Left-Right`   | `(10, 5.2, −3, +0.25, +5°)` | `rotation = (−1, …)` (no D/H change) |
| `.SplitScreen-Right-Left`   | `(10, 5.2, −3, −0.25, −5°)` | `rotation = (−1, …)` |
| `.SplitScreen-Left-Over`    | `(10, 5.2,  0, +0.25, +5°)` | `rotation = (−1, …)` |
| `.SplitScreen-Right-Over`   | `(10, 5.2,  0, −0.22, −5°)` | `rotation = (−5, …)` |
| `.SplitScreen-Right-Center` | `(10, 5.2,  0, −0.20,  0°)` | `rotation = ( 0, …)` |

These are the **only** labels that use non-zero pitch in the standard library (`-3°` or `−1°` / `−5°` on the Index-1 follow-up). The composition shifts here are **±0.25** or **±0.20 / ±0.22** — much larger than the regular `±0.1` because each split-screen camera frames a different character.

## `GosubToModifyPerspectiveStageCamera` parameters and frequencies

The most-common entry point. **16,544 calls across all trials.** Parameters and observed distributions:

### `LookCharacterId`

| Character | Calls | % | Court (idx in Act01_Chapter01) | Court_Final (idx in Act02_Chapter06) |
|---|---|---|---|---|
| Hiro | 4,287 | 25.9% | absent (−1) | 8 |
| Ema | 3,714 | 22.4% | 0 | 0 |
| Margo | 1,223 | 7.4% | 9 | 9 |
| Sherry | 1,153 | 7.0% | 2 | 2 |
| Leia | 851 | 5.1% | 3 | 3 |
| Alisa | 804 | 4.9% | 4 | 4 |
| Coco | 802 | 4.8% | 5 | 5 |
| Nanoka | 726 | 4.4% | 10 | 10 |
| Miria | 547 | 3.3% | 6 | 6 |
| Meruru | 525 | 3.2% | 12 | 12 |
| Hanna | 503 | 3.0% | 1 | 1 |
| AnAn | 469 | 2.8% | 11 | 11 |
| Yuki | 431 | 2.6% | absent (−1) | 13 |
| Noah | 341 | 2.1% | absent (−1) | 7 |
| Warden | 159 | 1.0% | absent (−1) | absent (−1) |
| Jailer | 8 | 0.05% | absent (−1) | absent (−1) |
| `Anan` (legacy spelling) | 1 | 0.006% | — | — |

The two protagonists (Hiro + Ema) get **48%** of all camera time. Hiro is always absent in `Court.prefab` trials — every Hiro shot uses `Court_Final.prefab`.

### `Composition`

| Value | Calls | % |
|---|---|---|
| `Center` | 7,403 | 44.7% |
| `Right`  | 4,885 | 29.5% |
| `Left`   | 4,256 | 25.7% |

55% of shots are off-centre. (`Right` runs slightly hotter than `Left` — possibly a subtle dramatic-framing convention.)

### `RollDirection`

| Value | Calls | % | Resolved roll |
|---|---|---|---|
| `""` (none) | 14,578 | 88.1% | 0° |
| `Right` | 1,129 | 6.8% | +5° |
| `Left` | 837 | 5.1% | −5° |

12% of shots use a cinematic roll (typically Debate-mode tension or cut-ins).

### `ZoomLevel`

| Value | Calls | % | Resolved (D, H) |
|---|---|---|---|
| `""` (default) | 14,113 | 85.3% | `(10, 5.2)` — empty defaults to Lvl1 |
| `3` | 2,132 | 12.9% | `(12, 5.5)` |
| `2` | 178 | 1.1% | `(11, 5.3)` |
| `4` | 121 | 0.7% | `(13, 5.6)` |

Lvl1 dominates because it's the default for the most common dialog shots. The explicit Lvl3 calls are heavily skewed toward the rolled cinematic variants (presets #4 and #5 below).

### `Index`

Always `0` (16,544 / 16,544). Index `1` only appears in `ModifyPerspectiveStageCamera` direct commands (via `GosubToSplitPerspectiveStageScreens`).

## Top 5 most-frequent presets

| Rank | Calls | % | Zoom | Composition | Roll | (D, H, pitch, roll) | Visible result |
|---|---|---|---|---|---|---|---|
| 1 | 7,144 | 43.2% | (default = Lvl1) | Center | none | `(10, 5.2, 0°, 0°)` | One arched-doorway panel + balustrade dominate; target lectern dead-centre |
| 2 | 3,912 | 23.6% | (default = Lvl1) | Right | none | `(10, 5.2, 0°, 0°)` | Same scene, target shifted right of frame |
| 3 | 3,057 | 18.5% | (default = Lvl1) | Left | none | `(10, 5.2, 0°, 0°)` | Mirror of #2 |
| 4 | 1,115 | 6.7% | Lvl3 | Left | Right | `(12, 5.5, 0°, +5°)` | Wider Lvl3 distance + camera tilted clockwise about its forward axis |
| 5 | 821 | 5.0% | Lvl3 | Right | Left | `(12, 5.5, 0°, −5°)` | Mirror of #4 |

Cumulatively the top 5 cover **96.9%** of all 16,544 named-preset calls.

Reproduce in our renderer:

```bash
# Preset #1 (Court, Ema, Lvl1 Center NoRoll)
python3 scripts/render_court_3d.py --look-character Ema --zoom 1 --composition center --roll none

# Preset #4 (Court_Final, Hiro, Lvl3 Left RightRoll)
python3 scripts/render_court_3d.py --prefab court_final --look-character Hiro \
                                   --zoom 3 --composition left --roll right
```

## Per-trial breakdown — worked example: Trial 1 (`Act01_Chapter01`)

To make the corpus-wide stats above concrete, here's the camera vocabulary for the **first trial of the game** (Hanna's witch trial, fought across `Act01_Chapter01_Trial00`..`Trial15`).

### Volume

| Command kind | Count | Notes |
|---|---|---|
| `GosubToModifyPerspectiveStageCamera` (named-preset) | 1,542 | 9.3% of the 16,544 corpus-wide |
| `ModifyPerspectiveStageCamera` (direct) | 18 | 10.1% of the 179 corpus-wide |
| `GosubToSplitPerspectiveStageScreens` (split-screen) | 41 | 40.6% of the 101 corpus-wide |
| **Total camera-affecting commands** | **1,601** | across 16 sub-scripts |

So this single chapter is overrepresented in split-screens (it leans on dual-character framing more than later chapters do) and underrepresented in raw call volume (the script is shorter than later trials).

### Distinct named-preset configurations: 73 unique

Every (`LookCharacterId`, `Composition`, `RollDirection`, `ZoomLevel`) tuple that appears at least once in any of the 16 sub-scripts. Total parsed presets: 1,511 (31 of the 1,542 raw `GosubToModifyPerspectiveStageCamera` calls had no `LookCharacterId`, e.g. `Index 1` follow-ups in split-screen labels — those are excluded).

Top characters by camera-attention share:

| Character | Calls | % | Notes |
|---|---|---|---|
| **Ema** | 610 | 40.4% | Protagonist's confidant — most reaction shots cut to her |
| **Leia** | 252 | 16.7% | Defendant in this chapter — second-most camera time |
| **Coco** | 120 | 7.9% | |
| **Sherry** | 119 | 7.9% | |
| **Margo** | 87 | 5.8% | |
| **Hanna** | 72 | 4.8% | |
| **Nanoka** | 72 | 4.8% | |
| **Alisa** | 66 | 4.4% | |
| **Miria** | 64 | 4.2% | |
| **Meruru** | 48 | 3.2% | |
| **Anan** | 1 | 0.1% | One-off cameo |

Hiro / Noah / Yuki are absent from the camera target set — they have `idx = -1` in `Act01_Chapter01_TrialInit` (not seated at any stand for this trial).

By **ZoomLevel** (default Lvl1 covers 84%):

| Lvl | Calls | % |
|---|---|---|
| Lvl1 | 1262 | 83.5% |
| Lvl3 | 174  | 11.5% |
| Lvl2 | 47   | 3.1% |
| Lvl4 | 28   | 1.9% |

By **Composition × RollDirection** (Center+NoRoll dominates, but Right+NoRoll is close behind):

| Composition + Roll | Calls | % |
|---|---|---|
| Center + Roll-none | 614 | 40.6% |
| Right  + Roll-none | 461 | 30.5% |
| Left   + Roll-none | 299 | 19.8% |
| Left   + Roll-Right | 72 | 4.8% |
| Right  + Roll-Left  | 65 | 4.3% |

`Trial00` itself contains **no** named-preset calls — it's the chapter's intro/setup, framed entirely by 2 direct camera commands (including the famous `(12.5 / courtStandCount * 360)` Meruru↔Ema midpoint shot — see ["Direct camera commands"](#direct-camera-commands-179-calls--special-case-shots) below) plus 1 split-screen invocation. The named-preset library kicks in from `Trial01` onward, where the dialogue gameplay starts.

### Reproducing all 73 angles

The full enumeration is rendered to `RenderedCourt/trial1/` with one PNG per unique configuration, sorted by call frequency. Filenames encode the full preset:

```
01_Ema_Lvl1_Center_roll-none_x547.png      ← most-used: 36% of all chapter calls
02_Leia_Lvl1_Right_roll-none_x174.png      ← Leia witness-stand framing
…
73_Hanna_Lvl3_Right_roll-none_x1.png       ← rarest one-off
```

Regenerate:

```bash
# After re-extracting the bundle into /tmp/manosaba_raw/cab-*.bin (see scripts/inspect_bundle.py),
# the dedupe + render loop is:
python3 << 'PY'
import subprocess, json
configs = json.load(open('/tmp/trial1_unique_configs.json'))
for i, ((char, comp, roll, zoom), count) in enumerate(configs, 1):
    fname = f"RenderedCourt/trial1/{i:02d}_{char}_Lvl{zoom}_{comp}_roll-{roll}_x{count}.png"
    subprocess.run(["python3", "scripts/render_court_3d.py",
                    "--prefab", "court", "--look-character", char,
                    "--zoom", zoom, "--composition", comp.lower(),
                    "--roll", roll.lower(), "--out", fname], check=True)
PY
```

### Distribution shape

The 73 unique angles cluster into five buckets:

| Bucket | Unique configs | Total calls | Pattern |
|---|---:|---:|---|
| Lvl1 + no-roll (Center / Left / Right) | 25 | 1,262 | Standard talking-head close-ups, the bread-and-butter shots |
| Lvl3 + cinematic roll (`Left·RollRight` or `Right·RollLeft`) | 18 | 123 | Dramatic emphasis — accusations, interruptions, magic-cast moments |
| Lvl3 + no-roll | 15 | 51 | Wider framing without the cinematic tilt |
| Lvl4 (any) | 14 | 28 | Widest preset, sparingly used |
| Lvl2 (any — only Ema·Center) | 1 | 47 | Anomaly: a "between Lvl1 and Lvl3" intermediate shot used exclusively for Ema |

`Center` composition on non-Ema characters is rare (4 configs total: `Hanna`, `Leia`, `Coco`, `Meruru` — each ×1 or ×2). Non-protagonists almost always frame Left or Right.

This shape extrapolates: later trials follow the same skew with the lead character (whoever's giving the testimony / running the prosecution) replacing Ema as the Lvl1-Center default, and the chapter's "defendant" replacing Leia in the Right-NoRoll witness-frame role.

### Direct camera commands in Trial 1: all 16 enumerated

Trial 1 contains 16 `ModifyPerspectiveStageCamera` (direct) commands, all in the bundle's `Trial00` (12 calls) and `Trial14` (4 calls) sub-scripts. The other 14 sub-scripts use only the named-preset library — direct commands appear at the bookends of the chapter (intro and finale flourish).

Each row decodes one command's binary parameter block. **Bold** entries are the Index = 0 leg of a split-screen pair; the row immediately below it (Idx 1) is the partner camera. Yaw values starting with `(...)` are runtime expressions; numeric yaws are static.

| # | Sub-script | Index | D | H | Pitch | Yaw | Roll | Duration | Easing | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Trial14 | 1 | 12 | 5.6 | 0° | `(−0.03/N)·360 = −0.83°` | 0° | — | — | Snap-to position |
| 2 | Trial14 | 1 | — | — | 0° | `(0.03/N)·360 = +0.83°` | 0° | 0.6 s | OutQuad | Rotate-only follow-up to #1 |
| 3 | **Trial14** | **0** | **12** | **5.6** | 0° | `(2.98/N)·360 = +82.52°` | 0° | — | — | Snap-to position |
| 4 | Trial14 | 0 | — | — | 0° | `(2.92/N)·360 = +80.86°` | 0° | 0.6 s | OutQuad | Rotate-only follow-up to #3 |
| 5 | Trial00 | 0 | 7 | 5 | 0° | (rotation unset) | 0° | — | — | **D=7** below all preset Lvls; geometry-only |
| 6 | Trial00 | 1 | 4 | 3 | **−2°** | `(2.2/N)·360 = +60.92°` | **−2°** | — | — | **Only direct cmd in Trial 1 with non-standard pitch + roll combination** |
| 7 | Trial00 | 1 | (kept) | 4 | −1° | `(5.8/N)·360 = +160.62°` | 0° | — | — | D unset → delta-modify; pitch −1° |
| 8 | **Trial00** | **0** | **12** | **5.6** | 0° | `(2.98/N)·360 = +82.52°` | 0° | — | — | Same yaw expr as #3, different sub-script |
| 9 | Trial00 | 0 | — | — | 0° | `(2.92/N)·360 = +80.86°` | 0° | 0.6 s | OutQuad | Mirror of #4 |
| 10 | Trial00 | 1 | 12 | 5.6 | 0° | `(2.02/N)·360 = +55.94°` | 0° | — | — | Snap-to position |
| 11 | Trial00 | 1 | — | — | 0° | `(2.08/N)·360 = +57.60°` | 0° | 0.6 s | OutQuad | Rotate-only follow-up to #10 |
| 12 | Trial00 | 0 | 10 | 5 | +1° | `1·N/360 = 0°` (Ema) | 0° | — | — | Lvl1-like, static rotation `(1, 0, 0)` |
| 13 | Trial00 | 0 | 12 | 5.5 | 0° | (rotation unset) | 0° | 4 s | OutSine | Geometry-only dolly to D=12, H=5.5 over 4s |
| 14 | **Trial00** | **0** | **4** | **5** | **+2°** | `(12.5/N)·360 = +346.15°` | 0° | **8 s** | **InOutSine** | **The Meruru↔Ema midpoint shot — verified against in-game screenshot** |
| 15 | Trial00 | 1 | 12 | 5.5 | +1° | `1, 0, 0 = (Ema-direction)` | 0° | — | — | Returns perspective stage to dead-on Ema |
| 16 | Trial00 | 1 | 11 | 5.2 | 0° | (rotation unset) | 0° | 2 s | OutSine | Distance-only modify to D=11 over 2s |

The Pitch/Roll caveats from the corpus-wide section apply here too: pitch values are 0°, ±1°, ±2°; rolls are 0° or ±2°. **Trial 1 is the entire source of the `−2°` pitch and `−2°` roll values in the corpus** — both come from cmd #6 (which is also the only single command in 179 corpus-wide direct commands to combine non-zero pitch *and* non-zero roll).

### Reproducing the 16 direct commands

All 16 are rendered to `RenderedCourt/trial1_direct/`. For commands where Distance or Height is unset (a "delta-modify" that keeps the previous frame's value), the renderer fills with the **Lvl1 baseline** (`D=10, H=5.2`) — this isn't strictly faithful to the runtime sequence (where the previous command's value would persist) but produces a usable standalone snapshot for each.

Two new flags were added to `scripts/render_court_3d.py` to support the non-preset values:

| Flag | Purpose |
|---|---|
| `--yaw-multiplier FLOAT` | Sets the raw `N` in `yaw = N/courtStandCount × 360` directly. Use for any non-named-preset yaw (e.g. `12.5` for cmd #14). |
| `--distance FLOAT`, `--height FLOAT` | Bypass the `--zoom` preset table when the script uses non-standard values (e.g. cmd #5's `D=7`, cmd #14's `D=4`, cmd #16's `D=11`). |
| `--roll-deg FLOAT` | Sets an arbitrary roll angle (overrides `--roll {none,left,right}`). Required for cmd #6's `−2°` roll. |
| `--pitch-deg FLOAT` | Already existed; covers all pitch values seen in Trial 1. |

Reproduce cmd #14 (the Meruru↔Ema midpoint shot, 8s `InOutSine` final pose):

```bash
python3 scripts/render_court_3d.py --prefab court \
    --yaw-multiplier 12.5 \
    --pitch-deg 2 \
    --distance 4 --height 5 \
    --target-idx 0 \
    --out RenderedCourt/trial1_direct/14_Trial00_Idx0_D4_H5_P+2_Y+346.15_R+0_InOutSine.png
```

Reproduce cmd #6 (the rare `−2°` pitch + `−2°` roll low-angle close-up):

```bash
yaw_mult=$(python3 -c "print(60.92 / 360 * 13)")    # invert the eval
python3 scripts/render_court_3d.py --prefab court \
    --yaw-multiplier "$yaw_mult" \
    --pitch-deg -2 --roll-deg -2 \
    --distance 4 --height 3 \
    --out RenderedCourt/trial1_direct/06_Trial00_Idx1_D4_H3_P-2_Y+60.92_R-2.png
```

### What's *not* rendered

- **Split-screen invocations** (41 in Trial 1) — these spawn two cameras side-by-side via `.SplitScreen-*` labels we haven't decoded. The renderer only handles single-camera output.
- **Index-1 partner cameras** rendered standalone above show only the right-hand half of a pair when run in-game; their left-hand partner (Idx 0) renders separately.
- **Mid-transition frames** for the easing-driven commands (#2, #4, #9, #11, #13, #14, #16) — the `Duration` + `Ease` fields specify *how* the camera animates between poses, but our render is a single still at the target pose. Animating these would require interpolating from the previous command's pose using the `Duration` and easing curve.

## Direct camera commands (179 calls — special-case shots)

Bypass the preset library and write `(Index, Distance, Height, Rotation)` explicitly. Below: the complete enumeration of every distinct value seen on each parameter axis.

### `Index` — 2 distinct values

| Value | Calls | Meaning |
|---|---|---|
| `0` | 90 | full-screen camera (or first of a split-screen pair) |
| `1` | 89 | second camera in a split-screen pair |

Roughly half the direct calls are the second camera in a split-screen setup — most of the 101 `GosubToSplitPerspectiveStageScreens` invocations dispatch to a label that itself fires *two* direct camera commands.

### `Distance` (D) — 8 distinct values

| Value (m) | Calls |
|---|---|
| `""` (empty — keep previous) | 79 |
| `12` | 68 |
| `4` | 11 |
| `7` | 10 |
| `10` | 7 |
| `13` | 2 |
| `11` | 1 |
| `14` | 1 |

### `Height` (H) — 10 distinct values

| Value (m) | Calls |
|---|---|
| `""` (empty — keep previous) | 70 |
| `5.6` | 66 |
| `5` | 13 |
| `4` | 10 |
| `3` | 9 |
| `5.2` | 4 |
| `5.5` | 3 |
| `4.6` | 2 |
| `4.5` | 1 |
| `6` | 1 |

The "empty" entries on D and H aren't bugs — Naninovel's `ModifyPerspectiveStageCamera` treats unspecified parameters as "leave the camera's previous value alone", letting a script tweak only one axis at a time.

### `Pitch` — 5 distinct values (X-axis rotation in `Rotation` tuple)

| Value (°) | Calls |
|---|---|
| `0` | 144 |
| `−1` | 9 |
| `−2` | 9 |
| `+1` | 2 |
| `+2` | 1 |

20% of direct calls use non-zero pitch — the standard preset library never does (excluding SplitScreen, which uses `−3°` and `−1°`).

### `Roll` — 3 distinct values (Z-axis rotation)

| Value (°) | Calls |
|---|---|
| `0` | 146 |
| `−2` | 9 |
| `−4` | 1 |

Direct commands' rolls are **smaller in magnitude** than the standard library's `±5°` (and asymmetric — only negative values appear). The library's `±5°` exists for cinematic punch; the direct commands' `−2°` / `−4°` are subtler shot-specific tilts.

### Yaw multipliers `N` in `(N / courtStandCount * 360)` — 68 distinct expressions

The yaw expression in the `Rotation` tuple is always one of three shapes. Counts in parentheses are how many calls use that shape:

**a) Integer multiplier** = exact stand index (45 calls):
   `0` (×7), `2` (×3), `3` (×2), `4` (×2), `5` (×2), `6` (×3), `7` (×2), `8` (×21), `9` (×2),
   `10` (×4), `11` (×2), `12` (×2), `13` (×2), `−2` (×1), `1` (×1)

**b) Fractional multiplier** = stand index nudged by some composition (89 calls):
   `0.03` (×1), `−0.03` (×1), `0.1` (×5), `−0.1` (×2), `0.7` (×2), `0.9` (×2),
   `1.9` (×4), `1.95` (×1), `2.02` (×1), `2.08` (×1), `2.2` (×1),
   `2.85` (×1), `2.9` (×1), `2.92` (×2), `2.98` (×2), `3.1` (×1), `3.9` (×2),
   `4.2` (×1), `4.8` (×1), `4.9` (×1), `5.1` (×1), `5.2` (×2), `5.8` (×1), `5.9` (×2),
   `6.1` (×1), `6.9` (×2), `7.7` (×4), `7.9` (×4), `8.1` (×17), `8.9` (×2),
   `9.9` (×2), `10.9` (×2), `11.9` (×2), `12.2` (×1), `12.5` (×1),
   `13.2` (×3), `−1.2` (×1)

**c) Variable/expression yaw** = computed from a per-character idx (24 calls):
   - `{ (cocoIdx / courtStandCount * 360) }` (×3) — Coco at her current idx
   - `{ ((cocoIdx + 0.1) / courtStandCount * 360) }` (×3) — Coco + Left composition
   - `{ (emaIdx / courtStandCount * 360) }` (×2)
   - `{ ((emaIdx − 0.1) / courtStandCount * 360) }` (×2) — Ema + Right composition
   - `{ (hannaIdx / courtStandCount * 360) }` (×2)
   - `{ ((hannaIdx − 0.1) / courtStandCount * 360) }` (×1)
   - `{ (sherryIdx / courtStandCount * 360) }` (×2)
   - `{ ((sherryIdx + 0.1) / courtStandCount * 360) }` (×1)
   - `{ ((sherryIdx − 0.1) / courtStandCount * 360) }` (×1)
   - `{ ((nanokaIdx − 0.1) / courtStandCount * 360) }` (×1)
   - `{(emaIdx − 0.1) / 13 * 360}` (×1) — hardcodes `13` instead of `courtStandCount` (caught only because Court has 13 stands)
   - `{(miriaIdx − 0.1) / 13 * 360}` (×1) — same hardcoding
   - `{(sherryIdx − 0.1) / 13 * 360}` (×1)
   - `{(leiaIdx − 0.1) / 13 * 360}` (×1)
   - `{acameraYaw}` (×4) — likely a typo for `cameraYaw`; the leading `a` makes it an undefined variable and would resolve to 0
   - `{cameraYaw}` literal (×2 — implicit, where the `Rotation` field is just `,{cameraYaw}` with no formula expansion)

The "hardcoded 13" expressions break for `Court_Final.prefab` (where `courtStandCount = 14`) — those calls would put the camera at the wrong angle in the finale. Inspecting the calling scripts: those 4 calls all live in `Act01_Chapter*` files, so the hardcoding never fires in practice (Court has 13 stands).

### `LookAt` and `Time` fields

**`LookAt`**: never set in any of the 179 direct calls (always empty). The runtime's `PerspectiveStage` view component constructs the camera's look-at internally from the rotation tuple, not from this field.

**`Time`**: 1 distinct value — empty in all 179 direct calls. The runtime treats this as "use the actor's default transition duration"; explicit `Time` overrides only appear in the SplitScreen labels (which write a quick follow-up rotation with a longer transition for the cinematic flourish).

## SplitScreen invocations (101 calls — paired full-screens)

`GosubToSplitPerspectiveStageScreens` invokes one of the `.SplitScreen-*` labels and produces **two cameras** (Index 0 and Index 1) framed for separate characters. Distribution of label suffixes wasn't extracted in this pass; the labels themselves are listed above.

The visible result on screen is two side-by-side or vertically-stacked viewports, one per camera. Our renderer doesn't yet support split-screen output — implementing it would require running the rasteriser twice into different sub-rects of the output image.

## Pitch and Roll caveats

- **Roll on rolled labels**: `+5°` / `−5°` exactly. These are the only roll values in the named library.
- **Pitch in named library**: `0°` for non-SplitScreen labels; `−3°`, `0°`, or `−1°` / `−5°` (Index-1 follow-up) for SplitScreen.
- **Roll/pitch in direct commands**: `±1°…±2°` for pitch (sometimes), `−2°` or `−4°` for roll. These are author-chosen for specific dramatic shots.

## Summary table: what to set for "in-game faithful" output

| Element | Value | Source |
|---|---|---|
| Vertical FOV | **30°** | Legacy `field of view` in `CameraContainer.prefab` (runtime overrides Physical mode) |
| Horizontal FOV | 50.84° | `2 · atan(tan(15°) · 16/9)` |
| Output aspect | 16:9 | Game's reference resolution |
| Near / Far plane | 0.3 m / 50 m | `CameraContainer.prefab` |
| Camera position | `(+D · sin yaw, H, +D · cos yaw)` | `System_Subroutine` (camera INSIDE lectern ring, on same side as look-target) |
| Yaw | `(charIdx + comp) · 360° / N` | `cameraYaw` formula |
| Pitch | 0° (in 99%+ of cases) | named library |
| Roll | 0°, ±5°, or ±2°/−4° | preset / direct |
| `D, H` | `Lvl1 (10, 5.2)`, `Lvl2 (11, 5.3)`, `Lvl3 (12, 5.5)`, `Lvl4 (13, 5.6)` | `System_Subroutine` |
| Default Lvl | Lvl1 (when `ZoomLevel` empty) | inferred from preset frequency |

The renderer (`scripts/render_court_3d.py`) implements all of this except split-screen and animation `Time`. Use `--look-character`, `--zoom`, `--composition`, `--roll`, `--pitch-deg` to select any of the in-game configurations.
