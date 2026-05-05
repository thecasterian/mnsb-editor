# Court.prefab and Court_Final.prefab — geometry and texture

The 3D courtroom stages used by the witch-trial perspective shots. Both live in the game's source export at:

- `CourtExportV2/ExportedProject/Assets/#WitchTrials/Prefabs/General/PerspectiveStage/Court.prefab` (~31.5k lines)
- `CourtExportV2/ExportedProject/Assets/#WitchTrials/Prefabs/General/PerspectiveStage/Court_Final.prefab` (~31.7k lines, 142 lines longer)

They are nearly identical assemblies of 3 source meshes + 4–5 materials, with a rotational-symmetry trick that fans those few assets out into 30+ visible scene elements. The walls are a pre-rendered courtroom panorama (`Background_014_001.png`) painted onto a half-cylinder mesh, dressed up at runtime with PBR brick detail maps. Read that one fact and the rest of this doc is mostly arithmetic.

The two prefabs differ in exactly two ways:

| | `Court.prefab` (the standard variant) | `Court_Final.prefab` (the finale variant) |
|---|---|---|
| Lectern stands | **13** (`Stand_1`..`Stand_13`) | **14** (`Stand_1`..`Stand_14`) |
| Stand spacing | 360° / 13 ≈ 27.69° | 360° / 14 = 25.71° |
| Wall_1 material | `Court_Wall.mat`     (texture `m_Scale.x = 6.544`, `m_Offset.x = −0.0377`) | `Court_Wall@7.mat` (`m_Scale.x = 7.048`, `m_Offset.x = +0.25`) |
| Wall_2 material | `Court_Wall@Flip.mat` (`m_Scale.x = 6.544`, `m_Offset.x = +0.4623` — exactly +0.5 vs Wall_1, so the texture seams at the half-cylinder boundary) | `Court_Wall@7.mat` (same material as Wall_1) |
| Where the runtime loads it | 11 of 12 trials (Act01 ch1-5, Act02 ch1-5) — `stageName = "Court"`, `courtStandCount = 13` | 1 trial only (`Act02_Chapter06_TrialInit` — the climactic finale, full main cast on stage) — `stageName = "CourtFinal"`, `courtStandCount = 14` |

Everything else is byte-identical: same wall mesh (half-cylinder shell), same Step / Plane / Lighting transforms and materials, same 12 FireContainer placeholders at 30° intervals, same Stand quad mesh (Unity built-in Quad with the same `Court_Stand.mat` lectern texture, child position `(0, 2.4, 14.8)`, scale `(3.4, 2.8, 1)`).

The detailed walkthrough below uses **Court_Final** as the worked example (because it carries one extra stand); the next section calls out the per-prefab deltas for **Court**. Wherever the doc says "the prefab", read it as "both prefabs except where noted".

## Hierarchy

```
Court_Final                              identity
├── Lighting                             identity
│   └── SpotLight                        pos (0, 30, 0)            no mesh; light-only at 30 m above origin
└── Buildings                            identity
    ├── Wall_1                           pos (0, 4.2, 0)  scl (30, 15, 30)  rot 180° about ~Z (axis (-0.07, 0, 1))
    ├── Wall_2                           pos (0, 4.2, 0)  scl (30, 15, 30)  rot 180° about ~X (axis (1, 0, 0.07))
    ├── Step                             pos (0, 0, 0)    scl (24,  1, 24)  identity rot
    ├── Plane                            pos (0, 0, 0)    scl (61, 61,  1)  rot 90° about X (lays flat as floor)
    ├── Stands                           identity
    │   └── Stand_1 … Stand_14           rot k · 360°/14 ≈ 25.71° about Y, k = 0..13
    │       └── Quad                     local pos (0, 2.4, 14.8)  scl (3.4, 2.8, 1)
    └── FireVfx                          identity
        └── FireContainer_1 … _12        rot k · 30° about Y, k = 1..12
            └── Quad                     local pos (0, 0, 25.0)    no mesh in this prefab — see "Nested FireContainer" below
```

All transforms above are **local** to the parent shown. World transform = product down the chain.

## Geometry

| Asset | Verts / tris | Local AABB (center, extent) | Role | Instances |
|---|---|---|---|---|
| `Mesh/default.asset` | 128 v / 64 t | center `(0, 0, -0.5)`, extent `(1, 0.5, 0.5)` → AABB hugging −Z | Half-cylinder shell (curved side wall, no caps). See "Wall mesh shape" below. Two copies rotated 180° interlock into a closed cylindrical drum. | 2 (`Wall_1`, `Wall_2`) |
| `Mesh/default_0.asset` | 194 v / 128 t | center `(0, 0, 0)`, extent `(1, 1, 1)` → unit AABB enclosing a unit-radius capped cylinder | Central cylindrical podium / step. The AABB *suggests* a 2×2×2 box, but the actual mesh is a capped cylinder (see "Step mesh shape" below) — radius 1, height 2 (y ∈ [−1, +1]), 32 segments around the rim. | 1 (`Step`) |
| Unity built-in Quad (`fileID 10210`, `guid 0000…00e0…000`) | 4 v / 2 t | unit square in XY | Floor (1×) **and** all 14 character billboards (1× each). | 15 |
| (no mesh in this prefab) | — | — | Each `FireContainer_*` is a transform-only placeholder; flame geometry comes from `FireContainer.prefab` instantiated elsewhere. | 12 placeholders |

Vertex/index buffers for the two custom meshes are stored inline as Unity YAML in `Assets/Mesh/` (~16 KB and ~23 KB). They expose only standard `m_SubMeshes` + `m_VertexData` / `m_IndexBuffer` blocks — no skinning, no blend shapes.

### Stands — the rotation trick

The `Stands` parent is at the origin with identity transform. Each of its 14 children (`Stand_N`, with name suffix matching the rotation index) is rotated `k · 360° / 14 ≈ 25.71°` about Y from its parent. Each `Stand_N` has a single child `Quad` offset to local `(0, 2.4, 14.8)` and scaled `(3.4, 2.8, 1)`. Composing parent rotation × child offset puts the same Quad mesh on a circle of radius 14.8 m around Y, hovering 2.4 m above the floor, with each panel sized 3.4 × 2.8 m. **One Quad mesh, 14 transforms, 14 visible character-portrait billboards.**

`FireVfx` does the same trick at 30° intervals on a slightly larger radius (25.0 m). 12 transforms; the leaf Quad in this prefab carries no MeshFilter/Renderer — see below.

### Wall mesh shape (`default.asset`)

The wall mesh is a **half-cylinder side-wall** — just the curved skin, no top or bottom caps. Decoded directly from the YAML vertex buffer (channels: position@0, normal@12, tangent@24, uv@40; stride 48; 128 vertices total):

| metric | value (mesh-local) |
|---|---|
| Cylinder axis | Y |
| Radius | **1.0** (best-fit circle in XZ has center `(0, 0)`, residual ≈ 0) |
| Height | **1.0** (only two distinct Y levels: `−0.5` and `+0.5`, each carrying a 33-vertex ring) |
| Arc | **180°**, sampled in **32 segments × 5.625°** (angles 180°…360° relative to the XZ origin) |
| Caps | None (192 indices = 64 triangles = 32 quads × 2, just the curved skin) |

The vertex count of 128 is `33 unique XZ positions × 2 Y levels × ≈2× duplication for normal/UV seam handling`. The bounding-box-asymmetry in z (extent 0.5 with center at z = −0.5) reflects the half-cylinder occupying the negative-z hemisphere only.

### Wall rotations and full cylinder reconstruction

Both walls share `pos (0, 4.2, 0)` and `scl (30, 15, 30)`. With the half-cylinder mesh, scale × position gives:

| metric | world-space value |
|---|---|
| Cylinder radius | `1.0 × 30 = ` **30 m** |
| Cylinder height | `1.0 × 15 = ` **15 m** |
| Vertical span | `y ∈ [−3.3, +11.7] m` (bottom 3.3 m is below the y = 0 floor plane and hidden) |
| Facet chord on the arc | `2 × 30 × sin(5.625° / 2) ≈ 2.94 m` per quad |

The 180° rotations differ in axis:

- `Wall_1`: axis ≈ `(-0.07, 0, 1)` — mostly Z, with a ~3.75° X tilt. 180° about Z flips X and Y; the half-cylinder stays on the negative-z hemisphere, with a small forward lean from the X-component of the axis.
- `Wall_2`: axis ≈ `(1, 0, 0.07)` — mostly X, with a ~3.75° Z tilt. 180° about X flips Y and Z; the half-cylinder swings to the positive-z hemisphere.

Combined: `Wall_1` covers `z' ≈ [−0.99, +0.13]` of the unit drum, `Wall_2` covers `z' ≈ [−0.13, +0.99]`, with a ~13% overlap near `z = 0`. Net coverage is a **complete 360° cylindrical drum** of radius 30 m and height 15 m centred on the courtroom origin, with the bottom 3.3 m sunk below the floor — exactly the "drum-shaped panorama booth" you'd expect a perspective stage to use to wrap the painted backdrop around the camera.

### Step mesh shape (`default_0.asset`)

The step is a **capped cylinder**, *not* a box, despite the unit-cube AABB. Decoded directly from the YAML vertex buffer (channels: position@0, normal@12, tangent@24, uv@40; stride 48; 194 vertices total):

| metric | value (mesh-local) |
|---|---|
| Cylinder axis | Y |
| Radius | **1.0** (best-fit circle in XZ has center `(0, 0)`, residual ≈ 0 across all 32 rim points per Y level) |
| Height | **2.0** (two distinct Y levels: `−1.0` and `+1.0`) |
| Rim tessellation | **32 segments × 11.25°** around the perimeter |
| Caps | top **and** bottom cap as triangle fans from a single centre vertex per Y level (`(0, ±1, 0)`) |

Vertex tally: `33 unique XZ positions per Y level × 2 Y levels = 66 unique vertices`, with normal/UV duplication at the cap rim bringing it to 194 in the asset (each rim vertex appears once for the side surface and once for the cap fan, with different normals — radial outward for the side, ±Y for the cap). 128 triangles split as `32 quads × 2 = 64 side tris + 32 + 32 = 64 cap tris`.

After the prefab transform `pos (0, 0, 0)`, `scl (24, 1, 24)`, identity rot:

| metric | world-space value |
|---|---|
| Cylinder radius | `1.0 × 24 = ` **24 m** (concentric with the wall at radius 30) |
| Cylinder height | `1.0 × 2 = ` **2 m** (y ∈ [−1, +1]; bottom cap is hidden under the floor at y = 0) |
| Side facet chord | `2 × 24 × sin(11.25° / 2) ≈ 4.71 m` per quad |
| Footprint | circular disc of 24 m radius in the XZ plane (≈ 1810 m² area) |

This was a documentation error in earlier revisions, which described the step as "a 2×2×2 box". The unit-cube AABB enclosed the capped cylinder, not a literal box. The high vertex count (194 vs a cube's 24) is the tip-off; decoding the actual buffer confirms the 32-rim-segment cylindrical structure.

### Floor

The floor is the Unity built-in Quad mesh, scaled `(61, 61, 1)` and rotated 90° about X so the original XY square lies in the XZ plane. Result: a 61 × 61 m horizontal plane at y = 0. **The cylindrical step (radius 24) is concentric with the wall (radius 30)** and the floor extends past both as a square; what's visible from inside the wall is a 6 m wide carpet ring between the step's outer rim and the wall's foot circle.

### Nested FireContainer (out of scope)

The 12 `FireContainer_*` GameObjects each have a `Quad` child that, **in this prefab file**, has no MeshFilter and no MeshRenderer. The actual flame asset lives in the sibling file `FireContainer.prefab` and is referenced via PrefabInstance — the visible flames are a `ParticleSystem` + `ParticleSystemRenderer` pair (no mesh; billboard-rendered with the Vefects URP fire shader). For Court_Final's purposes, treat the 12 FireContainers as 12 transform-only spawn points on a 25 m radius ring.

## Materials and textures

All four materials use Unity's **URP Lit** shader (`Shader/Universal Render Pipeline_Lit.shader`, `guid 7bd246fda363d0343a11e180a973c626`) with the standard slots `_BaseMap`, `_BumpMap`, `_MetallicGlossMap`, `_OcclusionMap`. `_MainTex` is serialized alongside `_BaseMap` for legacy compatibility and always carries the same texture as `_BaseMap`.

| Material | Used by | `_BaseMap` (= `_MainTex`) | `_BumpMap` | `_MetallicGlossMap` / `_OcclusionMap` | `_BaseColor` (tint) | `_Smoothness` |
|---|---|---|---|---|---|---|
| `Material/Court_Wall@7.mat` | `Wall_1`, `Wall_2` | `Texture/Background_014_001.png` (2048 × 2048, RGBA) | `Texture2D/Bricks 2 Normal.png` | `Bricks 2 MaskMap.png` | `rgba(1, 1, 1, 1)` (white) | 0.5 |
| `Material/Court_Floor.mat` | `Plane` | `Texture2D/Carpet 4 BaseMap.png` | `Carpet 4 Normal.png` | `Carpet 4 MaskMap.png` | `rgba(0.415, 0.159, 0.159, 1)` ≈ `#6A2828` (dark red) | 1.0 |
| `Material/Court_Step.mat` | `Step` | `Texture2D/Bricks 2 BaseMap.png` | `Bricks 2 Normal.png` | `Bricks 2 MaskMap.png` | `rgba(0.217, 0.134, 0.124, 1)` ≈ `#372220` (dark brown) | 0.6 |
| `Material/Court_Stand.mat` | All 14 Stand quads | `Texture/Court_Stand.png` (512 × 512, RGBA) | `Bricks 2 Normal.png` | `Bricks 2 MaskMap.png` | `rgba(1, 1, 1, 1)` (white) | 0.5 |

Other URP defaults across all four materials: `_Metallic = 0`, `_Glossiness = 0` (legacy slot, unused; URP reads `_Smoothness` instead), `_BumpScale = 1` (0.5 on Court_Wall@7), `_OcclusionStrength = 1`, `_Cutoff = 0.5`, `_EmissionColor = (0, 0, 0, 1)` (no emission), `_SpecColor = (0.2, 0.2, 0.2, 1)` (legacy specular slot, unused by URP Lit).

### The painted-backdrop trick

`Court_Wall@7.mat`'s `_BaseMap` is `Background_014_001.png` — i.e. one of the 2D story backgrounds in the same family the editor already indexes under `backgrounds/main/`. The "3D courtroom" walls are a **pre-rendered courtroom panorama painted onto a half-shell mesh**, then dressed up at runtime with the Bricks 2 normal/mask maps for PBR detail. This is why the prefab gets away with so few unique meshes: the geometry is just enough to give characters world positions (Stands), dynamic accents (FireContainers + SpotLight), and a couple of physical surfaces for shadow catching (Floor, Step). The visual identity is carried by a single 2048 × 2048 background image.

## `Court.prefab` — the 13-stand variant

Court.prefab is the standard variant used by every trial except the finale. Its hierarchy, mesh inventory, transforms, and most of its materials are identical to Court_Final.prefab. The only differences:

### Stands

13 instead of 14, spaced at exactly `360° / 13 ≈ 27.692°` (Court_Final spaces 14 at `360° / 14 = 25.714°`). Each `Stand_N` carries the same Quad child at local `(0, 2.4, 14.8)` with scale `(3.4, 2.8, 1)` and the same `Court_Stand.mat` lectern texture. World centres on a 14.8 m radius ring at y = 2.4 m:

| Stand | k | yaw θ | world centre `(x, y, z)` m |
|---|---|---|---|
| Stand_1  |  0 |   0.000° | `( +0.000, 2.4, +14.800)` |
| Stand_2  |  1 |  27.692° | `( +6.878, 2.4, +13.105)` |
| Stand_3  |  2 |  55.385° | `(+12.180, 2.4,  +8.407)` |
| Stand_4  |  3 |  83.077° | `(+14.692, 2.4,  +1.784)` |
| Stand_5  |  4 | 110.769° | `(+13.838, 2.4,  −5.248)` |
| Stand_6  |  5 | 138.462° | `( +9.814, 2.4, −11.078)` |
| Stand_7  |  6 | 166.154° | `( +3.542, 2.4, −14.370)` |
| Stand_8  |  7 | 193.846° | `( −3.542, 2.4, −14.370)` |
| Stand_9  |  8 | 221.538° | `( −9.814, 2.4, −11.078)` |
| Stand_10 |  9 | 249.231° | `(−13.838, 2.4,  −5.248)` |
| Stand_11 | 10 | 276.923° | `(−14.692, 2.4,  +1.784)` |
| Stand_12 | 11 | 304.615° | `(−12.180, 2.4,  +8.407)` |
| Stand_13 | 12 | 332.308° | `( −6.878, 2.4, +13.105)` |

When loaded (`stageName = "Court"`), the runtime sets `courtStandCount = 13` so the character-placement formula `idx · 360° / courtStandCount` lands on these same 13 angles, with characters at radius 16 m, y = 5 m, radially behind their corresponding lectern (1.2 m gap).

### Wall materials — two halves with seam-matched UVs

Court_Final uses **one material** (`Court_Wall@7.mat`) on both walls. Court uses **two distinct materials** so the panorama tiles seamlessly across the half-cylinder boundary:

| Wall | Material | Texture | `m_Scale.x` | `m_Offset.x` |
|---|---|---|---|---|
| Court `Wall_1` | `Court_Wall.mat`      | `Background_014_001.png` | 6.544 | −0.0377 |
| Court `Wall_2` | `Court_Wall@Flip.mat` | `Background_014_001.png` | 6.544 | +0.4623 |
| Court_Final `Wall_1` and `Wall_2` | `Court_Wall@7.mat` | `Background_014_001.png` | 7.048 | +0.25 |

Both Court materials sample the same `Background_014_001.png` (same `_BumpMap`, `_MetallicGlossMap`, etc. — identical PBR setup) but offset by exactly `+0.5` from each other on the U axis. The half-cylinder mesh's UV sweep multiplied by `m_Scale.x = 6.544` gives 6.544 horizontal tile repeats per half-shell; the `+0.5` shift on Wall_2 lines its tiling phase up with Wall_1 across the seam, so the brick-and-panorama texture appears continuous around the full 360° drum despite each half coming from a separately-tinted material slot.

Court_Final reuses one material with `m_Scale.x = 7.048` (slightly higher repeat rate) and `m_Offset.x = +0.25` (centred), which works because the symmetric two-wall setup with identical UV settings naturally produces a continuous tile when the wall halves are mirror-rotated. The denser tiling (7.048 vs 6.544) is presumably an aesthetic tweak for the climactic-finale variant.

All three wall material variants point to the same `Background_014_001.png` panorama and the same Bricks-2 PBR maps; the only substantive deltas are `m_Scale.x` and `m_Offset.x` on the `_BaseMap` / `_MainTex` slots.

### Everything else — identical to Court_Final

The two prefabs share these byte-identical pieces (modulo the stand count and the wall material assignments above):

| element | shared transform / setup |
|---|---|
| `Lighting/SpotLight` | `pos (0, 30, 0)`, identity scale, `rot 90° about X` (Light points down) |
| `Buildings/Wall_1` | `pos (0, 4.2, 0)`, `scl (30, 15, 30)`, `rot 180° about ~Z` (axis `(−0.07, 0, 1)`) — same half-cylinder mesh `default.asset`, world radius 30 m × world height 15 m |
| `Buildings/Wall_2` | `pos (0, 4.2, 0)`, `scl (30, 15, 30)`, `rot 180° about ~X` (axis `(1, 0, 0.07)`) — complementary half-cylinder, completes the full 360° drum |
| `Buildings/Step` | `pos (0, 0, 0)`, `scl (24, 1, 24)`, identity rot — `default_0.asset` mesh, `Court_Step.mat`, **24 m radius capped cylinder**, 2 m tall (y ∈ [−1, +1]) |
| `Buildings/Plane` | `pos (0, 0, 0)`, `scl (61, 61, 1)`, `rot 90° about X` — Unity built-in Quad as floor, `Court_Floor.mat`, 61 × 61 m |
| `Buildings/Stands/Stand_N/Quad` | `pos (0, 2.4, 14.8)`, `scl (3.4, 2.8, 1)`, identity rot — Unity built-in Quad with `Court_Stand.mat` lectern texture |
| `Buildings/FireVfx/FireContainer_N/Quad` | identity child Quad placeholder at `pos (0, 0, 25.0)` — flame geometry comes from sibling `FireContainer.prefab` |
| `Buildings/FireVfx` | 12 FireContainer placeholders rotated `k · 30°` about Y for `k = 1..12` |

Because everything except stands and walls is shared, the **30 m radius / 15 m tall cylindrical drum**, the **24 m radius / 2 m tall cylindrical podium**, the **61 × 61 m floor**, and the **12 fire-spawn ring at radius 25 m** all read the same in both prefabs. See "Wall mesh shape", "Wall rotations and full cylinder reconstruction", and "Step mesh shape" above for the geometric details — they apply unchanged to Court.prefab.

## Character placement

Where the prefab fits in the bigger picture: the game ships **two perspective-stage prefabs** in this directory — the smaller `Court.prefab` (13 stands) used by 11 of 12 trials, and `Court_Final.prefab` (14 stands) used by exactly **one** trial — `Act02_Chapter06_TrialInit`, the final climactic trial of Act 2. The per-trial init script sets `stageName` (resource name → prefab to load) and `courtStandCount` (how many character slots to use) to match:

| Prefab | Stand count | Stand spacing | `stageName` | `courtStandCount` | Used by |
|---|---|---|---|---|---|
| `Court.prefab` | 13 | 360° / 13 ≈ 27.69° | `"Court"` | 13 | Act01 ch1-5, Act02 ch1-5 trials (11 scripts) |
| `Court_Final.prefab` | **14** | **360° / 14 ≈ 25.71°** | `"CourtFinal"` | **14** | `Act02_Chapter06_TrialInit` only — the finale, full cast on stage |

So in the only context Court_Final.prefab is loaded, the runtime sets `courtStandCount = 14` and the character-placement formula spaces 14 character slots at exactly the same `360° / 14` angular grid as the prefab's stands. **Lectern and character are angularly aligned at every index** — the prefab stand count and the runtime slot count always match.

The actual character placement lives in `manosaba_Data/StreamingAssets/aa/StandaloneWindows64/naninovel-scripts_assets_naninovelscripts-system.bundle`, in `System_Subroutine.BeginTrial`. The lectern ring and the character ring share angular spacing but differ in radius and Y:

| dimension | lectern (`Stand_N` → child Quad) | character actor | gap |
|---|---|---|---|
| Angular position | `(N − 1) · 360° / courtStandCount` | `<name>Idx · 360° / courtStandCount` | **0 — perfectly aligned** at every index |
| Radius from courtroom origin | 14.8 m (Quad's local pos `(0, 2.4, 14.8)`) | 16.0 m (`characterDistance = 16`) | **1.2 m** — character sits radially behind the lectern in front of it |
| Y (vertical) | quad centre 2.4 m (extends y ∈ [1.0, 3.8] m after scale) | actor pivot at `stageOffsetY + 5 = 5 m` | character pivot 1.2 m above lectern top |
| Visible scale | 3.4 × 2.8 m quad (fixed) | actor sprite × `characterScale = 0.25` | — |

So at any index the camera (orbiting at radius D ≈ 10–13 m *inside* the ring) sees the lectern in the foreground at 14.8 m and the character directly behind it at 16 m — radially aligned, character partially occluded from below by the podium. That's the "standing behind a witness stand" framing.

There is **no** separate `CharacterStand` GameObject anywhere in `CourtExportV2` (or in the steam install's prefabs) — the character is positioned by setting its actor transform directly via `ModifyCharacterExtended`, not by parenting to a prefab node.

There is **no** `CharacterStand` GameObject anywhere in `CourtExportV2` — the character is positioned by setting its actor transform directly via `ModifyCharacterExtended`, not by parenting to a prefab node.

### What actually drives placement (decoded from `System_Subroutine.BeginTrial`)

Inside the system bundle, `System_Subroutine` is a Naninovel script holding the global subroutine library. The `.BeginTrial` label (line 47) runs every time a trial scene starts. Its character-placement section repeats the same five-line pattern for each of 16 named characters — `ema, hiro, meruru, hanna, sherry, anan, leia, coco, miria, margo, noah, nanoka, alisa, yuki, warden, jailer`:

```
@set characterPositionY       = stageOffsetY + 5    ; common Y for all characters
@set hiddenCharacterPositionY = characterPositionY - 100   ; sink off-screen marker
@set characterScale           = 0.25                ; actor scale on perspective stage
@set characterDistance        = 16                  ; placement-ring radius (m)

; (per character — guarded by `@if <name>Idx >= 0`)
@set <name>PositionX = Sin(<name>Idx * g_pi * 2 / {courtStandCount}) * characterDistance + stageOffsetX
@set <name>PositionZ = Cos(<name>Idx * g_pi * 2 / {courtStandCount}) * characterDistance + stageOffsetZ
@set <name>RotationY = 360 / {courtStandCount} * <name>Idx
@char <name> position:{<name>PositionX},{characterPositionY},{<name>PositionZ} rotation:,{<name>RotationY}
```

With the predefined `g_pi = 3.1416`, `courtStandCount = 13` (from `Resources/naninovel/configuration/CustomVariablesConfiguration.asset`), and `stageOffset(X,Y,Z)` defaulting to `0` (Naninovel auto-zeroes undefined custom variables), this resolves to:

```
position = ( 16 · sin(idx · 2π/13),   5,   16 · cos(idx · 2π/13) )
rotation = ( _,                       360°/13 · idx,              _ )      // only Y is set; X/Z inherit
```

`<name>Idx = -1` skips the character entirely (the `@if` guard prevents the position formulas and `@char` command from running). Characters not slotted in a scene stay at whatever position their actor was last given (typically the off-screen `hiddenCharacterPositionY`).

The character actor has its `RotationY` set to its own `idx · 360°/courtStandCount`. With Naninovel's character actor convention (the sprite's "front" faces local `−Z` so it's visible when the camera is on its `−Z` side), this rotates the visible-face direction to point inward toward the courtroom origin where the camera orbits — i.e. each character faces the camera at its matching `cameraIdx`.

### Per-scene assignments (worked example: `Act02_Chapter06_TrialInit` — the only Court_Final user)

`naninovel-scripts_assets_naninovelscripts-act02_chapter06_trial.bundle` is the only trial bundle whose `*_TrialInit` loads `CourtFinal`. The init script slots **all 14 character indices**, then `gosub`s to `System_Subroutine.BeginTrial`:

```
@set stageName       = "CourtFinal"      ; ← loads Court_Final.prefab
@set courtStandCount = 14                ; ← matches its 14 stands

@set emaIdx     = 0
@set hannaIdx   = 1
@set sherryIdx  = 2
@set leiaIdx    = 3
@set alisaIdx   = 4
@set cocoIdx    = 5
@set miriaIdx   = 6
@set noahIdx    = 7
@set hiroIdx    = 8
@set margoIdx   = 9
@set nanokaIdx  = 10
@set ananIdx    = 11
@set meruruIdx  = 12
@set yukiIdx    = 13
@set wardenIdx  = -1                    ; absent
@set jailerIdx  = -1                    ; absent

@gosub System/System_Subroutine.BeginTrial
```

This is the only trial in the game where every character slot (0..13) is occupied — 14 characters arranged around the full ring, one per lectern. Other trial-inits (`Act01_Chapter01_TrialInit`, `Act01_Chapter02_TrialInit`, …) load `Court` (the 13-stand variant), set `courtStandCount = 13`, and assign indices in `0..12` for the characters that are present, with absent characters set to `-1`.

For the 14 character-slot world positions in Court_Final's case (radius 16, `stageOffset = 0`, `characterPositionY = 5`):

| idx | character | yaw | world position `(x, y, z)` m |
|---|---|---|---|
|  0 | Ema     |   0.00° | `( +0.000, 5, +16.000)` |
|  1 | Hanna   |  25.71° | `( +6.943, 5, +14.418)` |
|  2 | Sherry  |  51.43° | `(+12.510, 5,  +9.976)` |
|  3 | Leia    |  77.14° | `(+15.598, 5,  +3.561)` |
|  4 | Alisa   | 102.86° | `(+15.598, 5,  −3.561)` |
|  5 | Coco    | 128.57° | `(+12.510, 5,  −9.976)` |
|  6 | Miria   | 154.29° | `( +6.943, 5, −14.418)` |
|  7 | Noah    | 180.00° | `( +0.000, 5, −16.000)` |
|  8 | Hiro    | 205.71° | `( −6.943, 5, −14.418)` |
|  9 | Margo   | 231.43° | `(−12.510, 5,  −9.976)` |
| 10 | Nanoka  | 257.14° | `(−15.598, 5,  −3.561)` |
| 11 | Anan    | 282.86° | `(−15.598, 5,  +3.561)` |
| 12 | Meruru  | 308.57° | `(−12.510, 5,  +9.976)` |
| 13 | Yuki    | 334.29° | `( −6.943, 5, +14.418)` |

Each character sits radially behind the matching `Stand_N` (lectern at radius 14.8 m, character at radius 16 m, both at the same `(N − 1) · 25.71°` angle).

### Camera convention

Two layers determine what the camera sees: a **Camera component** in `CameraContainer.prefab` that owns the projection (FOV, near/far), and the per-trial Naninovel script logic that owns the pose (position + rotation). For the full preset table, statistics across all 16,544 named-preset calls in trial scripts, and the camera math, see [`docs/court_camera_angles.md`](./court_camera_angles.md). Quick orientation here:

**Projection (from `CameraContainer.prefab`'s Camera component):** the prefab serializes both Physical Camera fields (`m_projectionMatrixMode: 1`, focal 68.06 mm, sensor 36 × 24 mm, Fill gate fit) AND a legacy `field of view: 30`. The runtime **uses the legacy value** — something inside the WitchTrials view controller writes `Camera.fieldOfView = 30` imperatively, which switches Unity back into legacy mode and discards the Physical params. Verified by comparing rendered output to in-game screenshots; see [`docs/court_camera_angles.md`](./court_camera_angles.md) for the full discovery write-up.

```
vFOV = 30.00°         (legacy field of view; what the runtime actually applies)
hFOV = 50.84°         (= 2·atan(tan(15°) · 16/9), at 16:9 aspect)
```

The Physical Camera fields *would* compute vFOV ≈ 16.92° if honoured — the inferred override is the only reason that math doesn't apply. See the camera-angles doc for the full Physical-mode derivation kept for reference.

**Pose (from `System_Subroutine.BeginTrial`'s camera command):**

```
@modifyPerspectiveStageCamera index:{cameraIdx} distance:<D> height:<H> rotation:<pitch>,{cameraYaw},{cameraRoll}
```

- `cameraYaw = (targetCharIdx + composition) · 360° / courtStandCount`
- `cameraRoll`: 0° default, ±5° for the cinematic "roll" labels
- `pitch`: 0° in the standard preset library, ±1°…±3° in some direct calls and SplitScreen labels
- `(D, H)`: 4 zoom levels, see preset doc for the table
- **Camera position formula**: `pos = (+D · sin yaw, H, +D · cos yaw)` — camera sits *inside* the lectern ring (lectern radius 14.8 m) at radius D, on the **same** angular position as its look-target. The look character sits at radius 16, so it's `(16 − D)` metres ahead of the camera along the optical axis. For Lvl1 (D=10): 6 m ahead — close-up. For Lvl4 (D=13): 3 m ahead — tighter close-up.

The named preset library exposes these as enum-ish parameters via `GosubToModifyPerspectiveStageCamera`:

| Parameter | Values | Notes |
|---|---|---|
| `LookCharacterId` | character name (`Hiro`, `Ema`, …) | resolved to `<name>Idx` from the trial-init script |
| `Composition` | `Center` / `Left` / `Right` | yaw shift `0` / `+0.1` / `−0.1` divided by `courtStandCount`, then × 360° |
| `RollDirection` | `""` / `Left` / `Right` | 0° / −5° / +5° camera roll |
| `ZoomLevel` | `""` / `1` / `2` / `3` / `4` | (D, H) preset; empty defaults to Lvl1 |
| `Index` | always `0` for full-screen, `1` for split-screen second camera | |

The 12 main label permutations in `System_Subroutine` cover every Composition × Roll × Lvl combination that's actually used; SplitScreen uses 5 additional labels. See [`docs/court_camera_angles.md`](./court_camera_angles.md) for the per-label `(D, H, pitch, roll)` and the usage histogram across the trial corpus.

### Summary: prefab vs runtime

| concept | source | role |
|---|---|---|
| 14 lectern Quads (`Stand_1`..`Stand_14`) | `Court_Final.prefab` (the 14-stand variant) | visible scenery; spaced at `360° / 14 = 25.71°` |
| 14 character-slot positions | `System_Subroutine.BeginTrial` formula with `courtStandCount = 14` | invisible anchors radially aligned with the lecterns at radius 16 m, y = 5 m |
| 16 character `<name>Idx` variables | `Act02_Chapter06_TrialInit` | which slot each character occupies — full cast (14 slots), Warden + Jailer absent |
| Camera pose | `System_Subroutine.ModifyCamera-*` labels | orbital camera at `(+D·sin yaw, H, +D·cos yaw)` — inside lectern ring, same angular side as look-target; `cameraYaw = targetCharIdx · 360° / courtStandCount` |

Treat lectern and character as a foreground/background pair at the same angular position: the lectern (radius 14.8 m, y = 2.4 m) is what the camera sees in front; the character (radius 16 m, y = 5 m) is just behind it.

## Lighting

`Lighting/SpotLight` carries Unity's Light component at world position `(0, 30, 0)` (30 m above the courtroom centre). The component fields aren't itemised here — read them with `sed -n` from the prefab if you need intensity/range/colour. There are no other lights.

## Suggested traversal for re-rendering

If you want to project Court_Final into the editor's 2D pipeline (e.g. as a stage backdrop for character placement), the minimum you need to walk:

1. `Buildings/Plane` — floor disc at y = 0, 61 × 61 m, dark red carpet tint.
2. `Buildings/Wall_1` and `Wall_2` — two half-cylinder shells forming a 30 m radius × 15 m tall drum (`y ∈ [−3.3, +11.7] m`); the visible texture is `Background_014_001.png`. For most 2D uses you can skip the meshes entirely and composite that background image directly.
3. `Buildings/Step` — central cylindrical podium at world y ∈ [−1, +1] m (lower half hidden by floor), **24 m radius** disc (concentric with the wall at 30 m). Top face at y = +1 m is what character lecterns sit on; the side rim is visible as a curved cylindrical band where the carpet-floor ring meets the podium.
4. `Buildings/Stands/Stand_N/Quad` — courtroom-lectern quads on a 14.8 m radius ring at y = 2.4 m, each 3.4 × 2.8 m, textured with `Court_Stand.png`. **13 stands at 27.69° spacing** in `Court.prefab`; **14 stands at 25.71° spacing** in `Court_Final.prefab`. Pure scenery — *not* character anchors. Character actors are placed on a co-axial ring at radius 16 m, y = 5 m, with the same angular grid as the prefab's stands (`courtStandCount` is set per scene to match). See "Character placement" above for the formula and per-scene assignments.
5. `Buildings/FireVfx/FireContainer_N/Quad` — 12 spawn points on a 25 m radius ring at y = 0, 30° apart. Geometry/particles live in the sibling `FireContainer.prefab` (out of scope here).
6. `Lighting/SpotLight` — single overhead light at `(0, 30, 0)`.
