# Rendering 3D Court angles via Unity

The trial scene's 3D source — `Court` / `Court_Final` prefab — lives in
`general-prefabs_assets_all.bundle`. The release ships a pre-rendered
2D shot of it as `Background_014_001`; this workflow lets us render
additional camera angles into matching 2D PNGs that drop into the scene
editor's Background dropdown.

## Workflow

### 1. AssetRipper extraction

Open AssetRipper and load `~/Downloads/others/general-prefabs_assets_all.bundle`.
Export as a Unity project (default settings — keep the original render
pipeline so HDRP shaders survive the round-trip).

```
~/Downloads/others/general-prefabs_assets_all.bundle
                      ↓ AssetRipper
~/CourtExport/        (a real Unity project: Assets/, ProjectSettings/, etc.)
```

### 2. Open in Unity Editor

Open Unity Hub → Add → point at `~/CourtExport`. Unity will import the
project (a few minutes the first time — it has to compile shaders).

When the project loads, find the `Court_Final` prefab in the Project
window (search `t:Prefab Court_Final`). Double-click it to verify the
courtroom looks right in the scene preview — stained glass, marble
stands, the works.

### 3. Drop in the render script

Create `Assets/Editor/` if it doesn't exist, and copy
`scripts/unity/RenderCourtAngles.cs` into it. Unity will compile it
automatically; on success a new menu item appears: **Tools → Render
Court Angles**.

### 4. First render: validation pass

Click **Tools → Render Court Angles**.

The script renders 5 PNGs into `<UnityProject>/RenderedCourt/`:
- `Background_014_001.png` — the prefab's *original* camera, untouched.
  This should be **pixel-identical** (or extremely close) to the
  `backgrounds/main/Background_014_001.png` already in this repo. If it
  matches, the round-trip works. If not, fix that first — see the
  "When the validation fails" notes below.
- `Background_014_002..005.png` — provisional offset cameras. These
  almost certainly need tuning the first time.

### 5. Tune the offset cameras

Open `RenderCourtAngles.cs` and edit the `PRESETS` array. Each entry's
`localOffset` is a vector in the *original camera's local frame*:
- `+Z` = forward (closer to whatever the camera was already looking at)
- `-Z` = back / pull out
- `+X` / `-X` = strafe right / left
- `+Y` / `-Y` = raise / lower

`eulerOffset` is added on top of the original rotation.

Re-run **Tools → Render Court Angles** after each tweak (it overwrites
the previous PNGs).

### 6. Drop the PNGs into the project

Once the angles look right, copy the four new PNGs into
`backgrounds/main/`:

```bash
cp ~/CourtExport/RenderedCourt/Background_014_002.png /path/to/manosaba_editor/backgrounds/main/
cp ~/CourtExport/RenderedCourt/Background_014_003.png /path/to/manosaba_editor/backgrounds/main/
cp ~/CourtExport/RenderedCourt/Background_014_004.png /path/to/manosaba_editor/backgrounds/main/
cp ~/CourtExport/RenderedCourt/Background_014_005.png /path/to/manosaba_editor/backgrounds/main/
```

(Skip `_001` — the existing one is already correct.)

Then refresh the meta:

```bash
python3 scripts/build_backgrounds_meta.py
```

The dropdown picks up the new entries automatically. The Court_Stand
overlay will need its trial-bg-set widened — see scene.js (one-line
change once we know the new filenames).

## When the validation fails

If `Background_014_001.png` from the script doesn't match the existing one:

- **Bundle has no Camera component**: AssetRipper sometimes loses Camera
  serialized fields. Check `Court_Final` in Unity — the `Camera`
  child GameObject should have a `Camera` component. If missing, add it
  manually and tune position/rotation/FOV until the rendered shot
  matches the reference.
- **Wrong render pipeline**: the project should be HDRP. If Unity
  imported it as Built-in or URP, materials will look wrong. AssetRipper
  has a "preserve render pipeline" option.
- **Lights missing**: the prefab has 2 Lights including the SpotLight.
  If the scene is dark, lights weren't deserialized — recreate from the
  prefab serialized data.
- **Tonemapping**: HDRP's default tonemapper is ACES, which heavily
  affects color. Look for a Volume profile in the project; the in-game
  shot was rendered with whatever Volume settings ship in the bundle.

## Why we don't render at runtime

The editor is a 2D Canvas-based tool. Embedding a WebGL renderer
(Three.js + glTF) just for the trial scene would roughly double the
codebase and still wouldn't perfectly match Unity's HDRP output. Pre-
rendering via Unity gives pixel-identical fidelity at the cost of
fixed angles — which is the right trade for a screenshot-authoring tool.
