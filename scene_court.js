// 3D courtroom renderer for Trial scenes. Mirrors `scripts/render_court_3d.py`
// (which renders the Court / Court_Final prefab as a still PNG) using Three.js
// in the browser. Geometry, camera math, and material parameters are ported
// directly from that script and `docs/court_geometry.md` /
// `docs/court_camera_angles.md`.
//
// Step 1-2 of the trial-scene pipeline:
//   1. Three.js dependency (loaded from CDN here, pinned).
//   2. Renderer module: textures + geometry + camera + built-in lighting.
//
// Characters and editor UI come in later steps.
import * as THREE from 'https://unpkg.com/three@0.166.0/build/three.module.js';

// All textures live under scene/court/ — extracted from the Unity bundle by
// `scripts/extract_scene_court.py`.
const COURT_TEX_DIR = 'scene/court';

// --- Runtime camera library (System_Subroutine.BeginTrial named presets) ---
export const ZOOM_LEVELS = {
  1: { D: 10, H: 5.2 },
  2: { D: 11, H: 5.3 },
  3: { D: 12, H: 5.5 },
  4: { D: 13, H: 5.6 },
};
export const COMPOSITIONS = { center: 0, left: +0.1, right: -0.1 };
export const ROLL_PRESETS = { none: 0, right: +5, left: -5 };

// Per-trial character → stand index. Reference trials:
//   court (13 stands)        : Act01_Chapter01_TrialInit
//   court_final (14 stands)  : Act02_Chapter06_TrialInit (only trial loading CourtFinal)
export const CHAR_IDX_COURT = {
  ema: 0, hiro: -1, meruru: 12, hanna: 1, sherry: 2, anan: 11,
  leia: 3, coco: 5, miria: 6, margo: 9, noah: -1, nanoka: 10,
  alisa: 4, yuki: -1, warden: -1, jailer: -1,
};
export const CHAR_IDX_COURT_FINAL = {
  ema: 0, hanna: 1, sherry: 2, leia: 3, alisa: 4, coco: 5,
  miria: 6, noah: 7, hiro: 8, margo: 9, nanoka: 10, anan: 11,
  meruru: 12, yuki: 13, warden: -1, jailer: -1,
};

// --- Geometry constants (from Court_Final.prefab) ---
const WALL_RADIUS = 30;
const WALL_HEIGHT = 15;
const WALL_Y_CENTER = 4.2;
const FLOOR_SIZE = 61;
const STEP_RADIUS = 24;
const STEP_HEIGHT = 2;
const STAND_RADIUS = 14.8;
const STAND_Y = 2.4;
const STAND_W = 3.4;
const STAND_H = 2.8;

// --- Character placement constants (System_Subroutine.BeginTrial) ---
//
// Resolved from the @char ModifyCharacterExtended commands in BeginTrial:
//   position: (16·sin(idx·2π/N), 5, 16·cos(idx·2π/N))
//   rotation: (_, 360°/N · idx, _)
//   scale:    (0.25, 0.25, 1)
// PIXELS_TO_UNITS is Unity's default SpriteRenderer m_PixelsToUnits (snapshots
// come in pixel-space; divide by 100 to get the world-meter dimensions an
// untransformed actor would render at, before characterScale multiplies in).
const CHARACTER_DISTANCE   = 16;
// Naninovel's BeginTrial sets `@char position:_,characterPositionY,_` with
// `characterPositionY = stageOffsetY + 5` → actor transform.position.y = 5.
const CHARACTER_POSITION_Y = 5;
const CHARACTER_SCALE      = 0.25;
const PIXELS_TO_UNITS      = 100;
// Naninovel's `Naninovel.RenderCanvas` MonoBehaviour on each character
// bundle's root holds Size = (15, 30), Offset = (0, 0) — uniform across all
// 13 main-cast bundles. The character is offscreen-rendered to a render
// texture, then displayed on a quad of these mesh-local dimensions. The
// quad's vertical extent (30 m mesh-local × 0.25 actor scale = 7.5 m world)
// is how the rig — which spans far more than 7.5 m in world coords once
// Angle01's intrinsic_scale is applied — fits visually on stage.
const RENDER_CANVAS_HEIGHT = 30;
// Default per-character pivot.y. Naninovel's CharacterMetadata stores a
// per-character `Pivot` (Vector2) in [0..1] coordinates over the render
// canvas. pivot.y < 0.5 anchors the actor near the canvas top (transform
// position is "lower" in the canvas); pivot.y > 0.5 anchors near the bottom.
// For the main cast pivot.y ranges 0.655..0.75 — the displayed character
// hangs DOWN from the actor transform position (world y=5). Per-character
// values are loaded from scene/authors.json via scene.js and passed in via
// setCharacters records; this default applies only when no per-character
// pivot is supplied.
const DEFAULT_ACTOR_PIVOT_Y = 0.5;

// --- Material tints (URP `_BaseColor` per .mat file, LINEAR RGB) ---
//
// Verbatim from the prefab .mat YAML files. Used as MeshStandardMaterial
// `color`, which is multiplied with the sRGB-decoded albedo before the
// BRDF — matching how Unity's URP/Lit applies `_BaseColor`.
//
// The *_DIM constants are per-surface multiplicative tuning knobs (default
// 1.0 = prefab albedo). Drop below 1 to darken a surface without changing
// the lighting; useful for balancing against the SpotLight intensity if
// any single surface reads too bright after a renderer change.
const TINT_FLOOR = [1.0,   0.142, 0.156];
const TINT_STEP  = [0.317, 0.103, 0.096];   // Court_Step.mat  — dark brown stone
const TINT_STAND = [1.0,   1.0,   1.0  ];   // Court_Stand.mat — uniform dim
const TINT_WALLS = [1.0,   1.0,   1.0  ];   // Court_Wall*.mat — no tint

// Wall material UV (m_Scale.x, m_Offset.x) per half-cylinder, matching the
// prefab's two-Wall structure. The per-half offsets are NOT interchangeable:
// each one positions the panorama image such that its stained-glass windows
// land in front of the lecterns on its hemisphere. For court the two halves
// differ by exactly +0.5 (which is what stitches the panorama continuously
// across the +X / −X seams); for court_final both halves carry the same
// 0.25 offset.
//
// Sourced from `_WALL_MATERIAL_UV` in scripts/render_court_3d.py, which in
// turn reads them straight from the .mat files. Applied directly via
// Texture.repeat / .offset on top of the prefab mesh's authored UVs — the
// previous flip-and-shift workaround for procedural CylinderGeometry's
// opposite U direction is no longer needed now that we use the prefab mesh.
const WALL_HALF_UV = {
  court: {
    wall_1: { scale: 6.544, offset: -0.0377 },
    wall_2: { scale: 6.544, offset: +0.4623 },
  },
  court_final: {
    wall_1: { scale: 7.048, offset: +0.25 },
    wall_2: { scale: 7.048, offset: +0.25 },
  },
};

// Wall uses the prefab's actual half-shell mesh (default.asset, extracted via
// scripts/extract_scene_court.py → scene/court/wall_mesh.json). Mesh-local
// is a unit half-cylinder covering z ∈ [-1, 0] (the -Z hemisphere) with
// radius 1 and full height 1 (y ∈ [-0.5, +0.5]); apply scale (WALL_RADIUS,
// WALL_HEIGHT, WALL_RADIUS) and the per-wall rotation below to place.
//
// Both prefab wall quaternions encode a 180° rotation about an axis tilted
// 3.75° from the main axis (qx = ±0.0654, qz = ±0.9979 for Wall_1 / Wall_2).
// Decomposing each rotation matrix gives R = R_y(−7.5°) · R_{z|x}(180°):
//   Wall_1: R_y(−7.5°) · R_z(180°) — keeps the canonical -Z hemisphere
//           coverage; flips x and y.
//   Wall_2: R_y(−7.5°) · R_x(180°) — sends the -Z hemisphere to +Z; flips
//           y and z.
// The −7.5° Y-tilt aligns the panorama's stained-glass windows with the
// lecterns. Composed at runtime via THREE.Quaternion (see buildWalls).
const WALL_Y_TILT_RAD = -Math.PI / 24;     // = −7.5°, matches prefab quaternion tilt

// Step uses the prefab's actual mesh asset (default_0.asset extracted via
// scripts/extract_step_mesh.py → scene/court/step_mesh.json). The brick
// texture's repeat is just `m_Scale = (8, 8)` from Court_Step.mat — applied
// directly on top of the asset's authored UVs.
const FLOOR_REPEAT  = 2;          // carpet tiles 2× across the 61 × 61 m floor

// --- Lighting ---
// Mixed pipeline: the floor and step use MeshStandardMaterial (Three.js's
// URP/Lit approximation), driven by a SpotLight + HemisphereLight added
// to the scene in CourtRenderer's constructor. The SpotLight parameters
// mirror Court(_Final).prefab's `/Court/Lighting/SpotLight` exactly.
//
// The walls and stands stay on the custom PYTHON_LIT_FS shader below —
// its empirical hemisphere ambient + flat exposure floor renders the
// panorama and lecterns more legibly than the prefab's spot-dominated
// PBR setup. ShaderMaterials ignore scene lights, so the SpotLight and
// HemisphereLight only affect the two PBR surfaces.

// --- Helpers ---

function loadTexture(url, { anisotropy = 8, flipY = true } = {}) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        // NoColorSpace: GPU samples raw sRGB byte values, matching
        // Python's PIL load + direct float multiplication. The custom
        // shader handles the sRGB round-trip on output.
        tex.colorSpace = THREE.NoColorSpace;
        tex.anisotropy = anisotropy;
        // flipY=true (Three.js default) makes the GPU sample PIL[(1-v)*H,
        // u*W]; Unity/Python sample PIL[v*H, u*W]. For the floor's PlaneGeometry
        // (rotated to lie flat) this produces a vertical mirror of the carpet
        // pattern. Disable for the carpet maps so they match the prefab. Wall
        // and step happen to be invariant: the wall mesh's raw V ranges
        // 0..0.9865 with V=0 at mesh-y=+0.5, and the prefab's R_{z|x}(180°)
        // wall rotations flip y so V=0 ends up at world-top — correct under
        // flipY=true; step's integer tiling makes V flips just shift by full
        // tiles (invisible because brick mortar is roughly horizontally
        // symmetric).
        tex.flipY = flipY;
        resolve(tex);
      },
      undefined,
      (err) => reject(new Error(`failed to load texture ${url}: ${err.message ?? err}`)),
    );
  });
}

function setRepeat(tex, repeatX, repeatY = repeatX) {
  tex.repeat.set(repeatX, repeatY);
  return tex;
}

// Inject an sRGB gamma encode at the end of a MeshStandardMaterial's
// fragment shader. We keep renderer.outputColorSpace = LinearSRGBColorSpace
// so Three.js doesn't re-encode the output, which means PBR materials
// would otherwise write linear values into a framebuffer treated as
// sRGB-encoded — too bright. The chunk replacement runs after the
// (no-op-under-Linear) <colorspace_fragment> chunk, so the encode lands
// just before gl_FragColor is presented. Simple gamma 2.2 approximation
// — matches the legacy Three.js encode path and is consistent across
// the four PBR surfaces.
function applyOutputSRGBEncode(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      '#include <colorspace_fragment>\n' +
      '  gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));',
    );
  };
  return material;
}


// ---------------------------------------------------------------------------
// Python-faithful lit material — direct port of `compute_pixel_lighting` and
// the per-pixel shading section of `rasterize_triangle_z` in
// scripts/render_court_3d.py. Reproduces the empirical lighting model
// (single spot + hemisphere ambient + flat exposure floor + top-face damp)
// that's been verified against in-game screenshots, rather than Three.js's
// PBR pipeline (which diverges on the BRDF / π divide, inverse-square decay
// shape, and color-space handling).
//
// Optional true tangent-space normal mapping (carpet + brick step):
// derivative-based TBN means no tangent attribute is needed on the geometry.
// This supersedes Python's fake-AO groove darkening — the perturbed normal
// produces genuine per-pixel lighting variation (brick edges catching the
// spot, mortar grooves darkening) rather than a uniform darken on R/G
// distance from neutral.
//
// Texture color-space: diffuse maps load with `colorSpace = NoColorSpace`
// so the GPU samples raw sRGB byte values 0-1 (no sRGB → linear decode).
// That matches Python's PIL load + direct float multiplication. The shader
// writes the result back to the framebuffer in the same sRGB-encoded space
// — Three.js's auto sRGB-encoder ISN'T applied to ShaderMaterial (only to
// built-in materials via the `<colorspace_fragment>` chunk), so the canvas
// sees the raw value and its sRGB color space attribute displays it as
// Python's PNG would.
// ---------------------------------------------------------------------------

const PYTHON_LIT_VS = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PYTHON_LIT_FS = /* glsl */ `
// Constants ported from render_court_3d.py.
const vec3  LIGHT_POS     = vec3(0.0, 30.0, 0.0);
const vec3  LIGHT_RGB     = vec3(1.0);
const vec3  SKY_RGB       = vec3(0.4);
const vec3  EQUATOR_RGB   = vec3(0.114, 0.125, 0.133);
const float DIRECT_GAIN   = 4.0;
const float AMBIENT_GAIN  = 1.3;
const float TOP_DAMP      = 0.6;
const float EXPOSURE      = 0.5;
const float FALLOFF_K     = 30.0;
const float RANGE_M       = 90.0;
const float OUTER_COS     = 0.342020143;   // cos(70°) — outer cone half-angle
const float INNER_COS     = 0.707106781;   // cos(45°) — inner cone half-angle

uniform sampler2D uMap;
uniform mat3 uMapTransform;
uniform vec3 uTint;
#ifdef USE_NORMAL_MAP
uniform sampler2D uNormalMap;
uniform float uNormalScale;
uniform float uBumpDarken;
#endif
#ifdef USE_TEXEL_CONTRAST
uniform float uContrast;
uniform float uContrastPivot;
#endif

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;

float ss(float lo, float hi, float x) {
  float t = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

#ifdef USE_NORMAL_MAP
// Derivative-based TBN ("Followup: Normal Mapping Without Precomputed
// Tangents", Schüler). Reconstructs T and B from screen-space derivatives
// of world position and UV, so we don't need a tangent attribute on the
// geometry — works on PlaneGeometry (carpet) and our hand-built step
// BufferGeometry alike. T points along du, B along dv, N is the geometric
// normal; columns of the returned matrix transform a tangent-space normal
// (R=along-T, G=along-B, B=along-N) into world space.
mat3 perturbTBN(vec3 N, vec3 worldPos, vec2 uv) {
  vec3 dp1 = dFdx(worldPos);
  vec3 dp2 = dFdy(worldPos);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
  return mat3(T * invmax, B * invmax, N);
}
#endif

void main() {
  // Apply the texture's repeat/offset (texture.matrix). ShaderMaterial does
  // NOT auto-apply this — only built-in materials do via their shader
  // chunks. Without this, the wall panorama is mapped once across the
  // half-cylinder instead of tiling 6.5×, the carpet doesn't tile 2×, etc.
  vec2 mapUv = (uMapTransform * vec3(vUv, 1.0)).xy;
  vec4 texel4 = texture2D(uMap, mapUv);
  vec3 texel = texel4.rgb;

  #ifdef USE_TEXEL_CONTRAST
  // Per-material contrast around uContrastPivot (default 0.5 = mid-gray).
  // Pulls texel values away from the pivot when uContrast > 1, toward it
  // when < 1. Applied BEFORE tint/lighting so the curve operates on the
  // raw albedo. Setting the pivot at the texture's mean luminance keeps
  // overall brightness while increasing detail separation; lower than the
  // mean darkens the texture overall, higher brightens it.
  texel = clamp((texel - uContrastPivot) * uContrast + uContrastPivot, 0.0, 1.0);
  #endif

  vec3 N = normalize(vWorldNormal);
  // Wall renders with side=BackSide (visible from inside the cylinder); the
  // geometric normal points outward, but lighting needs the inward normal.
  // gl_FrontFacing is false on the back-facing visible fragment; flip there.
  // Same trick applies for any DoubleSide material — the visible side gets
  // the camera-facing normal regardless of geometric winding.
  if (!gl_FrontFacing) N = -N;

  #ifdef USE_NORMAL_MAP
  // True tangent-space normal mapping. Replaces the geometric N with one
  // perturbed by the per-texel tangent-space normal stored in uNormalMap.
  // Sample at the same transformed UV as the diffuse map (both maps tile
  // identically — repeat/offset are kept in sync on the JS side).
  vec3 nmTangent = texture2D(uNormalMap, mapUv).xyz * 2.0 - 1.0;
  // uNormalScale dampens or strengthens the in-plane (XY) deflection
  // without re-baking the texture; Z is reconstructed afterwards so the
  // result is still a unit vector.
  nmTangent.xy *= uNormalScale;
  // Defensive Z reconstruction: if the source was DXT5nm-style (B unused,
  // Z = √(1 − X² − Y²)) UnityPy may have left B as 0 or 255. If B is
  // already correct, this re-derives the same value (no-op). Costs one
  // sqrt per fragment, buys robustness across normal-map encodings.
  nmTangent.z = sqrt(max(0.0, 1.0 - dot(nmTangent.xy, nmTangent.xy)));
  mat3 TBN = perturbTBN(N, vWorldPos, mapUv);
  N = normalize(TBN * nmTangent);
  // Cheap cavity AO: the magnitude of the in-plane deflection xy is a
  // proxy for "how tilted is this texel" — high near groove edges, low
  // on flat surfaces. Used as a multiplier on lightFactor below to
  // darken bumps without a separate AO texture.
  float bumpAO = length(nmTangent.xy);
  #endif

  // Spot light direct contribution
  vec3 dl = LIGHT_POS - vWorldPos;
  float d = length(dl);
  vec3 L = dl / max(d, 1e-6);
  float NdotL = max(0.0, dot(N, L));
  // Cone factor — spot points straight down (light_dir = -Y), so
  // cos(angle from cone axis) == L.y for the light-to-pixel ray.
  float cone = ss(OUTER_COS, INNER_COS, L.y);
  // Distance attenuation: 1/(1 + (d/k)²) with smooth cutoff at range.
  float atten = 1.0 / (1.0 + (d / FALLOFF_K) * (d / FALLOFF_K));
  atten *= 1.0 - ss(0.8 * RANGE_M, RANGE_M, d);
  // Top-facing damp: scales DIRECT_GAIN down on faces with N.y > 0.
  float topDamp = max(0.0, 1.0 - TOP_DAMP * max(0.0, N.y));
  float direct = NdotL * cone * atten * DIRECT_GAIN * topDamp;

  // Hemisphere ambient (per-face-style, but per-pixel here since N varies).
  vec3 ambient = mix(EQUATOR_RGB, SKY_RGB, abs(N.y)) * AMBIENT_GAIN;

  vec3 lightFactor = direct * LIGHT_RGB + ambient + vec3(EXPOSURE);

  #ifdef USE_NORMAL_MAP
  // Darken bumps by their tilt magnitude. Independent of light direction,
  // so it's strictly an albedo-side modulation — cavities stay dim even
  // when the light grazes them favorably.
  lightFactor *= 1.0 - uBumpDarken * bumpAO;
  #endif

  vec3 shaded = clamp(texel * uTint * lightFactor, 0.0, 1.0);

  // Output the value directly. Renderer is configured with
  // outputColorSpace = LinearSRGBColorSpace so Three.js does NOT
  // re-encode this on the framebuffer — the canvas sees the value
  // as-is and (via its sRGB color-space attribute) treats it as
  // sRGB-encoded for display. Net result: the framebuffer holds
  // Python's exact PNG byte value.
  #ifdef USE_ALPHA_TEST
  if (texel4.a < 0.1) discard;
  gl_FragColor = vec4(shaded, texel4.a);
  #else
  gl_FragColor = vec4(shaded, 1.0);
  #endif
}
`;

function createPythonLitMaterial(opts) {
  const { map, tint, normalMap = null, normalScale = 1.0, bumpDarken = 0.0,
          contrast = 1.0, contrastPivot = 0.5,
          alphaTest = false, side = THREE.FrontSide } = opts;
  const defines = {};
  if (normalMap)        defines.USE_NORMAL_MAP     = '';
  if (alphaTest)        defines.USE_ALPHA_TEST     = '';
  if (contrast !== 1.0) defines.USE_TEXEL_CONTRAST = '';

  // texture.matrix is normally regenerated each render (when matrixAutoUpdate
  // is true, the default). For ShaderMaterial we need it ready BEFORE the
  // first render, since the uniform stores a reference. Force-update once.
  map.updateMatrix();

  const uniforms = {
    uMap:           { value: map },
    uMapTransform:  { value: map.matrix },
    uTint:          { value: new THREE.Vector3(tint[0], tint[1], tint[2]) },
  };
  if (normalMap) {
    uniforms.uNormalMap   = { value: normalMap };
    uniforms.uNormalScale = { value: normalScale };
    uniforms.uBumpDarken  = { value: bumpDarken };
  }
  if (contrast !== 1.0) {
    uniforms.uContrast      = { value: contrast };
    uniforms.uContrastPivot = { value: contrastPivot };
  }

  return new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader:   PYTHON_LIT_VS,
    fragmentShader: PYTHON_LIT_FS,
    side,
    transparent: alphaTest,
    depthWrite:  true,
    // dFdx/dFdy are core in WebGL2 / GLSL ES 3.00; this enables the
    // OES_standard_derivatives extension when running on a WebGL1 context.
    extensions:  { derivatives: true },
  });
}


// --- Geometry builders ---

function buildFloor(t) {
  const geo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  geo.rotateX(-Math.PI / 2);

  // Material parameters mirror Court_Floor.mat: URP/Lit, BaseMap+BumpMap
  // tile (2,2), MetallicGlossMap supplies metal+smoothness, no
  // OcclusionMap (the prefab's _OCCLUSIONMAP keyword is NOT set even
  // though _OcclusionStrength has a default 1.0 — so URP/Lit's AO term
  // is skipped). We mirror that by NOT wiring carpetMaskMap into aoMap.
  setRepeat(t.carpetMap,     FLOOR_REPEAT);
  setRepeat(t.carpetNormal,  FLOOR_REPEAT);
  setRepeat(t.carpetMaskMap, FLOOR_REPEAT);

  t.carpetMap.colorSpace     = THREE.SRGBColorSpace;
  t.carpetNormal.colorSpace  = THREE.NoColorSpace;
  t.carpetMaskMap.colorSpace = THREE.NoColorSpace;

  const mat = new THREE.MeshStandardMaterial({
    map:           t.carpetMap,
    color:         new THREE.Color().fromArray(TINT_FLOOR),
    normalMap:     t.carpetNormal,
    normalScale:   new THREE.Vector2(1, 1),
    roughnessMap:  t.carpetMaskMap,
    roughness:     1.0,                // ×roughnessMap.g (mean ≈ 0.88 → matte)
    metalnessMap:  t.carpetMaskMap,
    metalness:     1.0,                // ×metalnessMap.b (= 0 → dielectric)
  });
  applyOutputSRGBEncode(mat);

  return new THREE.Mesh(geo, mat);
}

function buildWalls(prefab, t, wallMesh) {
  // Two instances of the prefab's canonical half-shell mesh, matching
  // Court(_Final).prefab's Wall_1 + Wall_2 setup. Each covers a 180° arc
  // with its own texture instance + per-wall UV transform; the per-half
  // offsets stitch the panorama continuously across the +X and −X seams
  // between the two walls.
  //
  // Geometry comes from scene/court/wall_mesh.json (default.asset, 128
  // verts / 64 tris). Mesh-local: radius 1, full height 1 (y ∈ [-0.5,
  // +0.5]), covering the -Z hemisphere only (z ∈ [-1, 0]). The prefab's
  // per-wall rotation maps it to the right hemisphere:
  //   Wall_1: R_y(−7.5°) · R_z(180°) — stays on -Z; flips x and y.
  //   Wall_2: R_y(−7.5°) · R_x(180°) — sends to +Z; flips y and z.
  // Composed via THREE.Quaternion below.

  const halfUV = WALL_HALF_UV[prefab];
  if (!halfUV) throw new Error(`Unknown prefab ${prefab}`);

  // Walls use the custom PYTHON_LIT_FS shader, not PBR — its empirical
  // hemisphere ambient + exposure floor lights the panorama more evenly
  // than the prefab's authored SpotLight alone. The custom shader reads
  // raw sRGB byte values (NoColorSpace), so we ensure the backdrop is
  // back on that default in case a prior PBR pass mutated it.
  t.backdropTex.colorSpace = THREE.NoColorSpace;

  // Build the BufferGeometry once; both walls share its position/UV/index
  // buffers (each Mesh has its own world transform + material).
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(wallMesh.positions);
  const uvs       = new Float32Array(wallMesh.uvs);
  const indices   = wallMesh.vertex_count > 65535
    ? new Uint32Array(wallMesh.indices)
    : new Uint16Array(wallMesh.indices);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  // R_y(−7.5°) — shared post-rotation applied to both walls.
  const qTilt = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), WALL_Y_TILT_RAD);

  const buildHalf = (name, qInner, { scale, offset }) => {
    const tex = t.backdropTex.clone();
    tex.needsUpdate = true;
    // Per-prefab m_Scale.x / m_Offset.x applied directly on top of the
    // mesh's authored UVs — no flip needed because the prefab UVs already
    // encode the panorama mapping in the correct direction.
    tex.repeat.set(scale, 1);
    tex.offset.set(offset, 0);

    // FrontSide: the prefab mesh's authored winding produces face normals
    // that point INWARD (toward the cylinder axis = toward the camera that
    // sits inside the courtroom). Front-side culling keeps exactly those
    // triangles, and `gl_FrontFacing = true` for the visible fragment so
    // the shader's `N = -N` flip stays disabled — N is already aimed at
    // the camera, ready for lighting (Python's `flip_normals: True` on
    // the wall is baked into the asset's winding, not done at runtime).
    const mat = createPythonLitMaterial({
      map:  tex,
      tint: TINT_WALLS,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    // Final rotation = R_y(−7.5°) · R_{z|x}(180°). THREE.Quaternion.multiply
    // is left-multiplication on the existing quat (q := q · q'), so to get
    // qTilt · qInner we start from a copy of qTilt and multiply by qInner.
    mesh.quaternion.copy(qTilt).multiply(qInner);
    // Mesh-local is unit radius and unit full height; scale to world dims.
    mesh.scale.set(WALL_RADIUS, WALL_HEIGHT, WALL_RADIUS);
    mesh.position.set(0, WALL_Y_CENTER, 0);
    mesh.name = name;
    return mesh;
  };

  // R_z(180°) and R_x(180°) — the per-wall "inner" rotations from the
  // prefab quaternion decomposition.
  const qWall1 = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const qWall2 = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

  const group = new THREE.Group();
  group.name = 'walls';
  group.add(buildHalf('wall_1', qWall1, halfUV.wall_1));
  group.add(buildHalf('wall_2', qWall2, halfUV.wall_2));
  return group;
}

function buildStep(t, stepMesh) {
  // Use the prefab's actual mesh data (default_0.asset, extracted via
  // scripts/extract_scene_court.py). Three.js's procedural CylinderGeometry
  // would produce a uniform UV sweep; the prefab's asset uses a non-uniform
  // unwrap (alternating sub-strips on the side, separate cap UVs) that the
  // brick texture is authored against. Without the asset's UVs, the brick
  // pattern doesn't line up the way it does in-game.
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(stepMesh.positions);
  const uvs = new Float32Array(stepMesh.uvs);
  const indices = stepMesh.vertex_count > 65535
    ? new Uint32Array(stepMesh.indices)
    : new Uint16Array(stepMesh.indices);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  // Material UV scale (Court_Step.mat m_Scale = 8, 8). All three Three.js
  // material slots (map/normalMap/maskMap) share the same Texture objects,
  // so setting repeat once propagates. Diffuse + normal + mask must tile
  // identically because the PBR shader samples each map at the same UV.
  setRepeat(t.brickMap,     8, 8);
  setRepeat(t.brickNormal,  8, 8);
  setRepeat(t.brickMaskMap, 8, 8);

  // Material parameters mirror Court_Step.mat: URP/Lit, BaseMap+BumpMap
  // tile (8,8), MetallicGlossMap supplies metal+smoothness, OcclusionMap
  // shares the same texture (and the prefab's _OCCLUSIONMAP keyword IS
  // set — unlike Court_Floor.mat where it isn't).

  // Albedo: sRGB-decode at sample time so the BRDF math happens in linear
  // space. Normal + mask carry linear data (not color), so they stay
  // NoColorSpace.
  t.brickMap.colorSpace     = THREE.SRGBColorSpace;
  t.brickNormal.colorSpace  = THREE.NoColorSpace;
  t.brickMaskMap.colorSpace = THREE.NoColorSpace;

  // MeshStandardMaterial's aoMap defaults to UV channel 1 (Unity ships a
  // separate AO unwrap on most prefabs; ours doesn't). Force the brick
  // mask map to read from UV channel 0 — the only set the step mesh
  // carries. Texture.channel was introduced in r152.
  t.brickMaskMap.channel = 0;

  const mat = new THREE.MeshStandardMaterial({
    map:           t.brickMap,
    color:         new THREE.Color().fromArray(TINT_STEP),
    normalMap:     t.brickNormal,
    normalScale:   new THREE.Vector2(2, 2),
    // The ORM-packed Bricks 2 MaskMap (R=AO, G=Roughness, B=Metallic — see
    // _repack_unity_maskmap_to_orm in extract_scene_court.py) feeds all
    // three slots; Three.js samples the right channel from each.
    aoMap:         t.brickMaskMap,
    aoMapIntensity: 1.0,
    roughnessMap:  t.brickMaskMap,
    roughness:     1.0,                // multiplied by roughnessMap.g
    metalnessMap:  t.brickMaskMap,
    metalness:     1.0,                // multiplied by metalnessMap.b (= 0 for non-metallic brick)
  });

  applyOutputSRGBEncode(mat);

  const mesh = new THREE.Mesh(geo, mat);
  // Mesh data is in mesh-local (unit cylinder, y ∈ [-1, +1]). Apply prefab
  // scale (24, 1, 24) for world coords. Position stays at origin; bottom
  // cap (y = -1) is hidden under the floor at y = 0.
  mesh.scale.set(STEP_RADIUS, 1, STEP_RADIUS);
  mesh.position.set(0, 0, 0);
  return mesh;
}

function buildStands(N, t) {
  // N quads on the 14.8 m ring at y = 2.4 m, each rotated to face outward
  // from the courtroom origin (so the textured face is visible to the camera
  // sitting inside the ring at radius D = 10..13 m).
  //
  // Court_Stand.png is RGBA — the lectern silhouette has alpha-zero corners
  // we want to discard so the wall behind shows through. `alphaTest = 0.1`
  // does this without blending (cleaner depth than transparent=true alone).
  // Stands stay on the custom PYTHON_LIT_FS shader (same as walls); the
  // empirical hemisphere ambient + exposure floor renders the lecterns more
  // legibly than the prefab's spot-dominated PBR setup.
  const group = new THREE.Group();
  group.name = `stands-${N}`;

  // Custom shader reads raw sRGB byte values, so reset to NoColorSpace in
  // case an earlier pass mutated it.
  t.standTex.colorSpace = THREE.NoColorSpace;

  const mat = createPythonLitMaterial({
    map:       t.standTex,
    tint:      TINT_STAND,
    alphaTest: true,
    side:      THREE.DoubleSide,
    // Pull bright/dark texels apart around the lectern's mean luminance
    // (~0.35 — the texture is mostly shadowed wood). Tint can't do this,
    // and pivoting at 0.5 would also darken the lectern overall.
    contrast:      1.15,
    contrastPivot: 0.35,
  });

  for (let k = 0; k < N; k++) {
    const theta = (2 * Math.PI * k) / N;
    const sint = Math.sin(theta);
    const cost = Math.cos(theta);
    const geo = new THREE.PlaneGeometry(STAND_W, STAND_H);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(STAND_RADIUS * sint, STAND_Y, STAND_RADIUS * cost);
    // PlaneGeometry's default normal is +Z. We want it pointing outward at
    // angle θ — i.e. (sin θ, 0, cos θ). Rotating about Y by θ gives that.
    mesh.rotation.y = theta;
    group.add(mesh);
  }

  return group;
}

// --- Character billboards ---
//
// Each character is a textured plane parked at its stand's world position.
// The actor is a 2D sprite in 3D space (Naninovel actor convention) — not a
// 3D model — so a flat PlaneGeometry textured with the snapshot PNG matches
// what the runtime draws.
//
// Orientation: PlaneGeometry's default +Z normal points away from origin if
// we just translate it. We want the textured face toward the courtroom
// centre (where the camera orbits), so rotate Y by θ + π. Same magnitude as
// the lectern rotation; opposite hemisphere on the face normal.
//
// Sizing: world dims = (snapshot px / PIXELS_TO_UNITS) · CHARACTER_SCALE · intrinsicScale.
// `intrinsic_scale` lives on a CHILD Transform (`Angle01`) inside the rig, not
// on the root. The script's `@char scale:0.25,0.25,1` only sets the ROOT's
// localScale — the inner Angle01 retains its pre-baked 0.6 (or per-character
// equivalent). So the effective combined scale at the leaf is 0.25 × 0.6 in
// Ema's case.
//
// Pivot: per the bundle Transform tree, Naninovel's layered-character actor
// uses the rig root's origin (Unity (0,0,0)) as the pivot, and the bundle's
// auto-grown canvas is symmetric around that point — leaves extend equally
// up and down. So the canvas-pixel pivot is at (canvas_w/2, canvas_h/2), and
// for tight-cropped snapshots the pivot lands approximately at the snapshot
// centre. Placing the plane centre at world y=5 (= characterPositionY)
// reproduces the runtime placement.

// Build a THREE.Texture from an HTMLImageElement that's already decoded.
// Cached per `image.src` so re-renders (e.g. camera-only changes) don't
// re-upload to the GPU. The cache lives on the CourtRenderer instance —
// see _charTextureCache.
function buildCharTexture(image) {
  const tex = new THREE.Texture(image);
  // NoColorSpace: GPU samples raw sRGB byte values without decoding to
  // linear. The renderer's outputColorSpace is LinearSRGBColorSpace, so
  // MeshBasic writes whatever it sampled straight to the framebuffer
  // unchanged; the canvas then displays those bytes as sRGB. Matches the
  // floor/walls/step convention (see PYTHON_LIT_FS docs above) and means
  // the character renders exactly as the composited snapshot PNG would
  // appear in a browser — no implicit gamma darkening that could read as
  // a lighting effect.
  tex.colorSpace = THREE.NoColorSpace;
  // Snapshots are large (often 2560×1440); turn on anisotropy so glancing
  // angles (camera at low pitch grazing the side characters) don't smear.
  tex.anisotropy = 8;
  // Linear sampling on both axes — the snapshot is already anti-aliased,
  // we just want clean bilinear interpolation on the GPU.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Build a single character billboard at stand `idx` of an N-stand prefab.
// `snapWidth` / `snapHeight` are pixel dims of the snapshot PNG; the world
// size is derived per the constants above. `pivotX` / `pivotY` locate the
// Naninovel rig pivot inside the snapshot (PIL Y-down pixel coordinates) —
// the plane is translated so that pixel lands at world y=CHARACTER_POSITION_Y,
// reproducing the runtime @char position anchor regardless of tight-crop
// asymmetry. Returns a Mesh ready to add to the scene.
function buildCharacterBillboard(N, idx, texture, snapWidth, snapHeight, intrinsicScale, pivotX, pivotY, actorPivot) {
  const theta = (2 * Math.PI * idx) / N;
  const wWorld = (snapWidth  / PIXELS_TO_UNITS) * CHARACTER_SCALE * intrinsicScale;
  const hWorld = (snapHeight / PIXELS_TO_UNITS) * CHARACTER_SCALE * intrinsicScale;

  // Plane centre Y: derived from Naninovel's per-character CharacterMetadata
  // pivot. The runtime displays the rig on a 30 m mesh-local render-canvas
  // quad scaled by characterScale=0.25 (= 7.5 m world height). With pivot.y
  // ∈ [0..1] over that quad, the centre lands at:
  //   planeCenterY = characterPositionY + (0.5 − pivot.y) · canvasH · scale
  //                = 5 + (0.5 − pivot.y) · 30 · 0.25
  //                = 5 + 7.5 · (0.5 − pivot.y)
  // For Ema (pivot.y = 0.695): 5 + 7.5·(−0.195) = 3.54.
  // For Hanna (pivot.y = 0.655): 3.84. Per-character variation directly
  // explains the empirically-tuned offsets — each character's foot anchor is
  // baked into its CharacterMetadata via this single number.
  const actorPivotY = (Array.isArray(actorPivot) && Number.isFinite(actorPivot[1]))
    ? actorPivot[1]
    : DEFAULT_ACTOR_PIVOT_Y;
  const actorPivotX = (Array.isArray(actorPivot) && Number.isFinite(actorPivot[0]))
    ? actorPivot[0]
    : 0.5;
  const planeCenterY = CHARACTER_POSITION_Y
    + (0.5 - actorPivotY) * RENDER_CANVAS_HEIGHT * CHARACTER_SCALE;

  // Snapshot-internal pivot offset (in mesh-local) — corrects for asymmetric
  // tight-crop within the snapshot. Defaults to snapshot centre when the
  // character editor didn't record pivotX/pivotY. PlaneGeometry's UV maps
  // PIL y=0 (top) to mesh +y/2 and PIL y=snapHeight to mesh -y/2.
  const worldPerPxY = hWorld / snapHeight;
  const pivotMeshY  = (snapHeight / 2 - pivotY) * worldPerPxY;
  const worldPerPxX = wWorld / snapWidth;
  const pivotMeshX  = (pivotX - snapWidth  / 2) * worldPerPxX;
  // The actor-pivot-derived planeCenterY accounts for the rig's overall
  // vertical anchor; the snapshot pivot then nudges by any remaining
  // tight-crop asymmetry. The horizontal actor-pivot offset (actorPivotX)
  // is applied along the stand's tangent below.
  const planeCenterY_corrected = planeCenterY - pivotMeshY;

  const geo = new THREE.PlaneGeometry(wWorld, hWorld);
  // MeshBasicMaterial: no scene lighting. The character editor's composited
  // snapshots already bake in the desired colour; applying the courtroom's
  // SpotLight + hemisphere ambient on top would tint them dark/red and the
  // dim spotlight cone would only catch a couple of characters cleanly. The
  // game itself doesn't run the actors through the perspective stage's
  // SpotLight either — they read as pre-lit silhouettes against the lit
  // backdrop, which is the effect MeshBasic reproduces.
  const mat = new THREE.MeshBasicMaterial({
    map:         texture,
    transparent: true,
    // alphaTest discards fully-transparent texels so the wall behind shows
    // through cleanly, without the order-dependent depth artefacts that
    // pure `transparent` blending would introduce when characters at
    // different stands occlude each other.
    alphaTest:   0.01,
    side:        THREE.DoubleSide,
    depthWrite:  true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  // Stand position is on the (+sin θ, +cos θ) ring at radius CHARACTER_DISTANCE.
  // Under rotation.y = θ, mesh-local +X maps to world (cos θ, 0, −sin θ). To
  // make the pivot pixel land at the stand's world position, the plane centre
  // must be shifted by −(pivotMeshX·cos θ, 0, −pivotMeshX·sin θ) from the
  // stand position (since the pivot is at mesh-local +pivotMeshX from the
  // plane centre, the plane centre is at −pivotMeshX from the pivot).
  // Horizontal actor-pivot offset: applied along the stand's tangent
  // (perpendicular to its outward radial), same axis as pivotMeshX.
  // For RenderCanvas width 15 with @char scale 0.25 → 3.75 m world,
  // (0.5 − actorPivotX) × 3.75 gives the world-space shift along tangent.
  const actorPivotMeshX = (0.5 - actorPivotX) * 15 /* RenderCanvas Size.x */ * CHARACTER_SCALE;
  const totalTangent = pivotMeshX - actorPivotMeshX;
  mesh.position.set(
    CHARACTER_DISTANCE * Math.sin(theta) - totalTangent * Math.cos(theta),
    planeCenterY_corrected,
    CHARACTER_DISTANCE * Math.cos(theta) + totalTangent * Math.sin(theta),
  );
  // Naninovel's character actor convention: the sprite's "front" faces local
  // −Z. PlaneGeometry's textured face is +Z (the front face); we want the
  // BACK of the plane (mesh local −Z) to be the visible side from the
  // courtroom-origin direction (where the camera orbits). Rotating Y by θ
  // maps local −Z to the inward radial (−sin θ, 0, −cos θ), so the
  // character "faces" the origin per Naninovel's convention.
  //
  // The plane's textured face (+Z) then points outward (away from origin).
  // With side=DoubleSide, Three.js renders both faces using the same UVs —
  // the back-face view samples the texture mirrored, which after
  // renderTrialScene's global `scale(-1, 1)` mirror (Three.js RH → Unity LH
  // convention) un-mirrors back to a correct character orientation. An
  // earlier `θ + π` rotation reversed both steps and yielded a final
  // horizontally-flipped character.
  mesh.rotation.y = theta;
  mesh.name = `char-${idx}`;
  return mesh;
}

// --- Camera ---
//
// Naninovel's camera at radius D, height H, facing radially OUTWARD at the
// look-target on the lectern ring. yaw/pitch/roll match the Python script's
// `camera_axes_from_euler` formulas (Unity convention: forward = (0,0,1) at
// rest, R_y · R_x · R_z applied). Three.js camera looks down -Z by default;
// we drive it via `camera.up` + `camera.lookAt(position + forward)`, where
// `forward` and `up` come from the explicit Euler decomposition below. That
// way the camera's local axes end up matching the runtime's despite the
// handedness difference.

function setCameraFromOpts(camera, prefab, opts) {
  const N = prefab === 'court_final' ? 14 : 13;
  const zoom = opts.zoom ?? 1;
  const zoomDef = ZOOM_LEVELS[zoom] || ZOOM_LEVELS[1];
  const D = opts.distance != null ? opts.distance : zoomDef.D;
  const H = opts.height   != null ? opts.height   : zoomDef.H;

  const compShift = COMPOSITIONS[opts.composition ?? 'center'] ?? 0;
  const rollDeg = opts.rollDeg != null
    ? opts.rollDeg
    : (ROLL_PRESETS[opts.roll ?? 'none'] ?? 0);
  const pitchDeg = opts.pitchDeg ?? 0;

  const targetIdx = opts.targetIdx ?? 0;
  const yawMult = opts.yawMultiplier != null
    ? opts.yawMultiplier
    : (targetIdx + compShift);
  const yawDeg = (yawMult * 360) / N;

  const yaw   = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const roll  = THREE.MathUtils.degToRad(rollDeg);

  const sx = Math.sin(yaw),   cx = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sr = Math.sin(roll),  cr = Math.cos(roll);

  // forward = R_y(yaw) · R_x(pitch) · (0, 0, 1)
  const fwd = new THREE.Vector3(cp * sx, -sp, cp * cx);
  // up = R_y(yaw) · R_x(pitch) · R_z(roll) · (0, 1, 0)
  const up = new THREE.Vector3(
    sx * sp * cr - cx * sr,
    cp * cr,
    cx * sp * cr + sx * sr,
  );

  camera.position.set(D * sx, H, D * cx);
  camera.up.copy(up);
  camera.lookAt(
    camera.position.x + fwd.x,
    camera.position.y + fwd.y,
    camera.position.z + fwd.z,
  );

  return { yawDeg, D, H, pitchDeg, rollDeg, N };
}

// --- Public API ---

export class CourtRenderer {
  constructor(canvas, { prefab = 'court' } = {}) {
    this._canvas = canvas;
    this._prefab = prefab;
    this._N = prefab === 'court_final' ? 14 : 13;

    // preserveDrawingBuffer: keeps the framebuffer intact between renders,
    // so consumers that read the canvas asynchronously (e.g. drawImage on a
    // 2D canvas, toBlob) always see the last rendered frame. Without this,
    // an offscreen WebGL canvas (one not attached to the DOM, as used by
    // scene.js's trial render path) can clear between render() and the
    // subsequent 2D blit, producing a blank readback. Minor perf cost (one
    // extra internal blit) but guarantees correctness for the offscreen
    // pattern.
    this._renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this._renderer.setSize(canvas.width, canvas.height, /* updateStyle= */ false);
    // LinearSRGBColorSpace = "no encode on output". Each PBR material's
    // onBeforeCompile patch (applyOutputSRGBEncode in this file) re-encodes
    // its own output to sRGB-byte space before gl_FragColor, so we don't
    // want Three.js to additionally re-encode at the framebuffer level.
    // Net result: framebuffer bytes are sRGB-encoded (what the canvas
    // expects).
    this._renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // No tone mapping: the prefab's URP setup doesn't apply tone mapping
    // to the trial scene either, and our SpotLight intensity is tuned in
    // a linear range that doesn't clip after sRGB encode for this scene.
    this._renderer.toneMapping = THREE.NoToneMapping;

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x121216);

    const aspect = canvas.width / canvas.height;
    this._camera = new THREE.PerspectiveCamera(30, aspect, 0.3, 200);

    // Scene lights driving the two PBR surfaces (floor + step). The walls
    // and stands use the custom PYTHON_LIT_FS shader, which ignores scene
    // lights — its empirical lighting model is baked into the fragment
    // shader, so these lights cost nothing there.
    //
    // SpotLight: lifted directly from Court(_Final).prefab's single
    // realtime Spot at /Court/Lighting/SpotLight. The prefab's
    // m_SpotAngle = 140° / m_InnerSpotAngle = 90° are full cone angles
    // (Unity convention); we pass the outer half-angle (70°) and a
    // penumbra fraction (1 − inner_half / outer_half = (70−45)/70) which
    // is how Three.js parameterizes the same cone. Range/intensity/decay
    // are verbatim from the prefab.
    const spot = new THREE.SpotLight(
      0xffffff,
      /* intensity (cd, prefab m_Intensity) */ 700,
      /* distance (m, prefab m_Range)       */ 90,
      /* outer half-angle (rad)             */ THREE.MathUtils.degToRad(70),
      /* penumbra fraction                  */ (70 - 45) / 70,
      /* decay (2 = physical inverse-sq)    */ 2,
    );
    spot.position.set(0, 30, 0);
    // SpotLight's default target is at (0, 0, 0) — straight down. No need
    // to add a separate target object to the scene.
    this._scene.add(spot);

    // Hemisphere ambient stands in for whatever scene-level URP ambient
    // the prefab inherits at runtime (the prefab itself ships no
    // RenderSettings asset). Colors picked empirically: SKY_RGB roughly
    // matches the panorama's bright tones, EQUATOR_RGB matches the
    // shadowed floor regions. Intensity is the single tuning knob if all
    // four surfaces feel uniformly too bright/dim.
    const SKY_RGB     = new THREE.Color(0.4,   0.4,   0.4);
    const EQUATOR_RGB = new THREE.Color(0.114, 0.125, 0.133);
    const hemi = new THREE.HemisphereLight(SKY_RGB, EQUATOR_RGB, /* intensity */ 2.0);
    this._scene.add(hemi);

    this._textures = null;
    this._sceneMeshes = null;
    this._loaded = false;
    // Character billboards: a single Group that we replace the children of
    // on every setCharacters call. Held outside _sceneMeshes so a prefab
    // switch (which rebuilds the static geometry) doesn't blow away the
    // character placements; setCharacters is the only mutator of this
    // group's contents.
    this._charactersGroup = new THREE.Group();
    this._charactersGroup.name = 'characters';
    this._scene.add(this._charactersGroup);
    // Texture cache keyed by HTMLImageElement.src (object URLs over the
    // snapshot blobs — unique per snapshot for the lifetime of the page).
    // Lets repeated renders of the same snapshot reuse the GPU upload.
    this._charTextureCache = new Map();
  }

  async load(buildVersion) {
    const v = buildVersion ? `?v=${buildVersion}` : '';
    const u = (name) => `${COURT_TEX_DIR}/${encodeURIComponent(name)}${v}`;

    const stepMeshUrl = `${COURT_TEX_DIR}/step_mesh.json${v}`;
    const wallMeshUrl = `${COURT_TEX_DIR}/wall_mesh.json${v}`;

    // All textures load with `NoColorSpace` (the loadTexture default).
    // Each builder (buildFloor / buildStep / buildWalls / buildStands)
    // overrides the colorSpace on its own diffuse maps to SRGBColorSpace
    // so the GPU decodes albedo to linear before the BRDF. Normal and
    // mask maps stay NoColorSpace since they carry linear data, not color.
    const [
      backdropTex,
      carpetMap, carpetNormal, carpetMaskMap,
      brickMap,  brickNormal,  brickMaskMap,
      standTex,
      stepMeshResp,
      wallMeshResp,
    ] = await Promise.all([
      loadTexture(u('Background_014_001.png')),
      // Carpet maps need flipY=false to match Unity's V=0=image-bottom
      // sampling — see loadTexture comment. Without this the carpet pattern
      // is vertically mirrored vs the prefab.
      loadTexture(u('Carpet 4 BaseMap.png'), { flipY: false }),
      loadTexture(u('Carpet 4 Normal.png'),  { flipY: false }),
      loadTexture(u('Carpet 4 MaskMap.png'), { flipY: false }),
      loadTexture(u('Bricks 2 BaseMap.png')),
      loadTexture(u('Bricks 2 Normal.png')),
      loadTexture(u('Bricks 2 MaskMap.png')),
      loadTexture(u('Court_Stand.png')),
      fetch(stepMeshUrl).then((r) => {
        if (!r.ok) throw new Error(`step_mesh.json fetch failed: ${r.status}`);
        return r.json();
      }),
      fetch(wallMeshUrl).then((r) => {
        if (!r.ok) throw new Error(`wall_mesh.json fetch failed: ${r.status}`);
        return r.json();
      }),
    ]);

    this._textures = {
      backdropTex,
      carpetMap, carpetNormal, carpetMaskMap,
      brickMap,  brickNormal,  brickMaskMap,
      standTex,
    };
    this._stepMesh = stepMeshResp;
    this._wallMesh = wallMeshResp;

    this._buildScene();
    this._loaded = true;
  }

  _buildScene() {
    if (this._sceneMeshes) {
      for (const m of this._sceneMeshes) {
        this._scene.remove(m);
        m.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            for (const mat of mats) mat.dispose();
          }
        });
      }
    }

    const t = this._textures;
    const floor  = buildFloor(t);
    const walls  = buildWalls(this._prefab, t, this._wallMesh);
    const step   = buildStep(t, this._stepMesh);
    const stands = buildStands(this._N, t);

    floor.name = 'floor';
    walls.name = 'walls';
    step.name  = 'step';

    this._scene.add(floor, walls, step, stands);
    this._sceneMeshes = [floor, walls, step, stands];
  }

  setPrefab(prefab) {
    if (prefab === this._prefab) return;
    if (prefab !== 'court' && prefab !== 'court_final') {
      throw new Error(`unknown prefab ${prefab}; valid: court, court_final`);
    }
    this._prefab = prefab;
    this._N = prefab === 'court_final' ? 14 : 13;
    if (this._loaded) this._buildScene();
  }

  /**
   * Set camera pose. Recognised options (all optional):
   *   targetIdx       stand index 0..N-1 (default 0)
   *   zoom            1..4 — picks (D, H) from ZOOM_LEVELS (default 1)
   *   composition     'center' | 'left' | 'right' (default 'center')
   *   roll            'none' | 'left' | 'right' (default 'none')
   *   pitchDeg        explicit pitch (default 0)
   *   rollDeg         explicit roll (overrides `roll`)
   *   distance        explicit D (overrides zoom-derived)
   *   height          explicit H (overrides zoom-derived)
   *   yawMultiplier   explicit dimensionless yaw (overrides targetIdx + composition)
   * Returns the resolved { yawDeg, D, H, pitchDeg, rollDeg, N }.
   */
  setCamera(opts = {}) {
    return setCameraFromOpts(this._camera, this._prefab, opts);
  }

  /**
   * Replace the character billboards. `chars` is an array of records:
   *   { idx, image, snapWidth, snapHeight, intrinsicScale, pivotX, pivotY }
   * where `image` is a decoded HTMLImageElement (or anything THREE.Texture
   * accepts), and idx is the stand index (0..N-1). `pivotX`/`pivotY` locate
   * the Naninovel rig pivot in the snapshot's PIL pixel coordinates;
   * defaults to the snapshot's geometric centre when omitted (the legacy
   * behaviour for snapshots written before pivot tracking landed). Records
   * with idx out of range or with no `image` are silently skipped.
   *
   * Replaces the children of the persistent _charactersGroup — geometries
   * are disposed each call (cheap to rebuild — N quads), but textures live
   * in _charTextureCache so re-renders don't re-upload to the GPU.
   */
  setCharacters(chars) {
    const grp = this._charactersGroup;
    // Dispose previous billboards' geometries + materials. Textures are NOT
    // disposed here — the cache owns them so they survive across calls.
    for (const child of grp.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    grp.clear();

    if (!Array.isArray(chars)) return;

    for (const ch of chars) {
      if (!ch || !ch.image) continue;
      const idx = ch.idx;
      if (!Number.isInteger(idx) || idx < 0 || idx >= this._N) continue;
      const w = Number(ch.snapWidth);
      const h = Number(ch.snapHeight);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      const intrinsicScale = Number.isFinite(ch.intrinsicScale) && ch.intrinsicScale > 0
        ? ch.intrinsicScale : 1.0;
      const pivotX = Number.isFinite(ch.pivotX) ? ch.pivotX : w / 2;
      const pivotY = Number.isFinite(ch.pivotY) ? ch.pivotY : h / 2;
      // Per-character actor pivot from Naninovel CharacterMetadata, looked
      // up by character id in scene.js. Undefined → DEFAULT_ACTOR_PIVOT_Y
      // (0.5) for the rare snapshot whose source character lacks metadata.
      const actorPivot = Array.isArray(ch.actorPivot) ? ch.actorPivot : null;

      const key = ch.image.src;
      let tex = this._charTextureCache.get(key);
      if (!tex) {
        tex = buildCharTexture(ch.image);
        this._charTextureCache.set(key, tex);
      }
      const mesh = buildCharacterBillboard(this._N, idx, tex, w, h, intrinsicScale, pivotX, pivotY, actorPivot);
      grp.add(mesh);
    }
  }

  render() {
    this._renderer.render(this._scene, this._camera);
  }

  resize(width, height) {
    this._renderer.setSize(width, height, false);
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
  }

  dispose() {
    if (this._sceneMeshes) {
      for (const m of this._sceneMeshes) {
        this._scene.remove(m);
        m.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            for (const mat of mats) mat.dispose();
          }
        });
      }
      this._sceneMeshes = null;
    }
    if (this._textures) {
      for (const tex of Object.values(this._textures)) tex.dispose?.();
      this._textures = null;
    }
    // Character billboards: dispose every cached texture + clear group.
    for (const child of this._charactersGroup.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this._charactersGroup.clear();
    for (const tex of this._charTextureCache.values()) tex.dispose();
    this._charTextureCache.clear();
    this._renderer.dispose();
    this._loaded = false;
  }

  get standCount()       { return this._N; }
  get prefab()           { return this._prefab; }
  get loaded()           { return this._loaded; }
  get camera()           { return this._camera; }
  get scene()            { return this._scene; }
}

export function characterToIdx(prefab, name) {
  if (!name) return -1;
  const map = prefab === 'court_final' ? CHAR_IDX_COURT_FINAL : CHAR_IDX_COURT;
  const idx = map[name.toLowerCase()];
  return typeof idx === 'number' ? idx : -1;
}
