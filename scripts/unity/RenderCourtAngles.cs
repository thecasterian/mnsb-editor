// Unity Editor script: renders the Court prefab from N camera positions and
// dumps each as a 2560×1440 PNG. Runs inside the AssetRipper-extracted Unity
// project (Tools → "Render Court Angles" menu).
//
// Camera model
// ------------
// The Court_Final prefab has no Camera component — the Naninovel runtime
// constructs one from a parametric (Distance, Height, Rotation, Index) tuple
// driven by `ModifyPerspectiveStageCamera` calls in the trial scripts. Camera
// placement is therefore orbital around the stage center:
//
//   yaw    = standIndex / courtStandCount(=13) * 360°
//   pos    = stageCenter + Q.Euler(0, yaw, 0) * Vector3(0, 0, -Distance)
//                        + Vector3.up * Height
//   lookAt = stageCenter + Vector3.up * LOOKAT_HEIGHT
//   rot   *= Q.Euler(tiltX, 0, rollZ)        // additive script offsets
//
// PRESETS below are picked from the runtime camera subroutine library
// (System_Subroutine.naninovel L338-446) — canonical in-game camera positions
// for the editor's trial-backdrop set, not guesses. Each entry produces one
// PNG named Background_014_<outputIndex>.png; the list is kept in sync with
// scene.js TRIAL_BG_PATHS so the editor's variant dropdown matches what's on
// disk. Output lands in <project root>/RenderedCourt/.
//
// Place this file under: <UnityProject>/Assets/Editor/RenderCourtAngles.cs

using UnityEngine;
using UnityEditor;
using System.IO;
using System.Linq;

public static class RenderCourtAngles
{
    const int WIDTH  = 2560;
    const int HEIGHT = 1440;

    // Output written to <project root>/RenderedCourt/ — one level above
    // Assets/, so the PNGs don't pollute the asset database.
    static readonly string OUT_DIR =
        Path.Combine(Directory.GetParent(Application.dataPath).FullName, "RenderedCourt");

    // The prefab is named "Court_Final" in general-prefabs_assets_all.bundle
    // (also a "Court" prefab — Court_Final is the assembled scene). AssetRipper
    // sometimes renames or namespaces, so we try a list of likely names + fall
    // back to a substring scan. Add to this list if AssetRipper produced
    // something exotic (e.g. "Court_Final 1", "Court (Variant)", etc.).
    static readonly string[] PREFAB_NAME_CANDIDATES = { "Court_Final", "Court" };

    // Stage geometry. courtStandCount comes straight from
    // Act01_Chapter01_TrialInit ("courtStandCount = 13"). LOOKAT_HEIGHT and FOV
    // aren't in the script (the runtime PerspectiveStage hardcodes them); these
    // are first-pass guesses — tune after looking at the first render batch.
    const int   COURT_STAND_COUNT = 13;
    const float LOOKAT_HEIGHT     = 4.2f;   // meters above floor — matches wall
                                            // center (Wall_1, Wall_2 are at
                                            // world Y=4.2 with 15 m height,
                                            // spanning Y=-3.3 to Y=11.7). Aiming
                                            // at the wall vertical center keeps
                                            // the backdrop in frame rather than
                                            // the floor.
    const float FOV               = 30f;    // degrees — matches the Camera object
                                            // shipped in general-prefabs (PathID
                                            // -7515334820944150817 on
                                            // CameraContainer/Camera, fov=30,
                                            // near=0.3, far=50). Court_Final
                                            // doesn't include this camera —
                                            // it's in the sibling Court prefab.

    // The 10 backdrop presets the editor consumes. Each is a (yawTarget,
    // composition delta, roll, distance, height) tuple drawn from the runtime
    // camera vocabulary in System_Subroutine.naninovel (L338-446) — the
    // GosubToModifyPerspectiveStageCamera subroutine library that handles
    // 16,544 of 16,757 in-game trial camera moves.
    //
    //   Composition    ∈ Center | Right | Left  → comp delta 0 | +0.1 | -0.1
    //   ZoomLevel      ∈ 2 | 3 | 4 | None       → (Distance, Height) preset
    //   RollDirection  ∈ None | Right | Left    → camera roll 0 | -4° | +4°
    //   yawTarget                                → which standIdx the camera
    //                                              looks at (0..12 around the
    //                                              13-stand ring)
    //
    // Output filenames Background_014_NNN.png are consumed by scene.js's
    // TRIAL_BG_PATHS Set; keep this list in sync with that Set when adding
    // or removing presets. Render() iterates PRESETS in order — each entry
    // becomes one PNG named after preset.outputIndex.
    struct Preset
    {
        public int    outputIndex;      // produces Background_014_<NNN>.png
        public string label;            // diagnostic / log only
        public float  yawTarget;        // standIdx (0..12) — camera looks at this stand
        public float  compositionDelta; // small horizontal nudge: 0 / +0.1 / -0.1
        public float  rollZ;
        public float  distance;
        public float  height;
    }
    static readonly Preset[] PRESETS = new[]
    {
        // 4 zoom levels at primary view (head-on at stand 0)
        new Preset { outputIndex = 2,  label = "Center_Z2_stand0",  yawTarget = 0f, compositionDelta =  0.0f, rollZ =  0f, distance = 10f, height = 5.2f },
        new Preset { outputIndex = 3,  label = "Center_Z3_stand0",  yawTarget = 0f, compositionDelta =  0.0f, rollZ =  0f, distance = 11f, height = 5.3f },
        new Preset { outputIndex = 4,  label = "Center_Z4_stand0",  yawTarget = 0f, compositionDelta =  0.0f, rollZ =  0f, distance = 12f, height = 5.5f },
        new Preset { outputIndex = 5,  label = "Center_Z0_stand0",  yawTarget = 0f, compositionDelta =  0.0f, rollZ =  0f, distance = 13f, height = 5.6f },
        // Composition variants at stand 0 (Right / Left small offsets)
        new Preset { outputIndex = 6,  label = "Right_Z3_stand0",   yawTarget = 0f, compositionDelta = +0.1f, rollZ =  0f, distance = 12f, height = 5.5f },
        new Preset { outputIndex = 7,  label = "Left_Z3_stand0",    yawTarget = 0f, compositionDelta = -0.1f, rollZ =  0f, distance = 12f, height = 5.5f },
        // Yaw rotations around the ring at default zoom
        new Preset { outputIndex = 8,  label = "Center_Z0_stand3",  yawTarget = 3f, compositionDelta =  0.0f, rollZ =  0f, distance = 13f, height = 5.6f },
        new Preset { outputIndex = 9,  label = "Center_Z0_stand6",  yawTarget = 6f, compositionDelta =  0.0f, rollZ =  0f, distance = 13f, height = 5.6f },
        new Preset { outputIndex = 10, label = "Center_Z0_stand9",  yawTarget = 9f, compositionDelta =  0.0f, rollZ =  0f, distance = 13f, height = 5.6f },
        // Cinematic roll variant
        new Preset { outputIndex = 11, label = "Right_Z3rR_stand0", yawTarget = 0f, compositionDelta = +0.1f, rollZ = -4f, distance = 12f, height = 5.5f },
    };

    // Diagnostic helper — dump every prefab whose filename contains "Court" so
    // you can see what AssetRipper actually produced. Useful when the render
    // command can't find an exact match.
    [MenuItem("Tools/List Court Prefabs")]
    public static void ListCourtPrefabs()
    {
        var guids = AssetDatabase.FindAssets("Court t:Prefab");
        if (guids.Length == 0)
        {
            Debug.LogWarning("[RenderCourtAngles] No prefab with 'Court' in its name found anywhere under Assets/.");
            return;
        }
        Debug.Log($"[RenderCourtAngles] Found {guids.Length} prefab(s) matching 'Court':");
        foreach (var g in guids)
        {
            var path = AssetDatabase.GUIDToAssetPath(g);
            var name = Path.GetFileNameWithoutExtension(path);
            Debug.Log($"  '{name}'   at {path}");
        }
    }

    // Broader scan — ANY asset (prefab, scene, model, mesh, material…) with
    // "Court" or "Stand" or "FireContainer" anywhere in its filename. Use this
    // when the prefab list comes back empty: it'll tell you whether the bundle
    // got extracted at all and, if so, what asset types it became.
    [MenuItem("Tools/List Court Assets (any type)")]
    public static void ListCourtAssetsAnyType()
    {
        // Names we know the Court 3D rig contains (from inspect_bundle output).
        string[] needles = { "Court", "Stand_1", "Stand_2", "FireContainer", "Court_Floor", "Court_Wall", "Bricks 2", "Carpet 4" };
        var seen = new System.Collections.Generic.HashSet<string>();
        int total = 0;
        foreach (var needle in needles)
        {
            var guids = AssetDatabase.FindAssets(needle);
            foreach (var g in guids)
            {
                var path = AssetDatabase.GUIDToAssetPath(g);
                if (!seen.Add(path)) continue;
                var asset = AssetDatabase.LoadMainAssetAtPath(path);
                var typeName = asset != null ? asset.GetType().Name : "?";
                Debug.Log($"  [{typeName}] {path}");
                total++;
            }
        }
        if (total == 0)
        {
            Debug.LogError("[RenderCourtAngles] No Court/Stand/FireContainer assets at all under Assets/. " +
                           "general-prefabs_assets_all.bundle may not have been exported. Re-run AssetRipper " +
                           "on that bundle, or check the export folder for 'Court_Final.prefab' via OS file search.");
        }
        else
        {
            Debug.Log($"[RenderCourtAngles] Total: {total} matching asset(s).");
        }
    }

    // Asset-type census — shows what AssetRipper actually produced under
    // Assets/, broken down by Unity type. If you see 0 GameObject / 0 Prefab,
    // AssetRipper didn't successfully export the Court rig.
    [MenuItem("Tools/Asset Type Census")]
    public static void AssetTypeCensus()
    {
        var counts = new System.Collections.Generic.Dictionary<string, int>();
        foreach (var g in AssetDatabase.FindAssets(""))
        {
            var path = AssetDatabase.GUIDToAssetPath(g);
            if (string.IsNullOrEmpty(path) || path.StartsWith("Packages/")) continue;
            var asset = AssetDatabase.LoadMainAssetAtPath(path);
            var t = asset != null ? asset.GetType().Name : "?";
            counts[t] = counts.TryGetValue(t, out var n) ? n + 1 : 1;
        }
        var sorted = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, int>>(counts);
        sorted.Sort((a, b) => b.Value.CompareTo(a.Value));
        Debug.Log($"[RenderCourtAngles] Asset census ({sorted.Count} types):");
        foreach (var kv in sorted) Debug.Log($"  {kv.Value,5}  {kv.Key}");
    }

    // Dumps the full Court_Final prefab hierarchy + every component on each
    // node. Use to diagnose missing-component issues after AssetRipper export
    // (e.g., the Camera GameObject has no Camera component attached).
    [MenuItem("Tools/Dump Prefab Tree")]
    public static void DumpPrefabTree()
    {
        GameObject prefab = null;
        foreach (var candidate in PREFAB_NAME_CANDIDATES)
        {
            foreach (var g in AssetDatabase.FindAssets($"{candidate} t:Prefab"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (Path.GetFileNameWithoutExtension(p) == candidate)
                {
                    prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    Debug.Log($"[DumpPrefabTree] Dumping {p}:");
                    break;
                }
            }
            if (prefab != null) break;
        }
        if (prefab == null) { Debug.LogError("Court prefab not found."); return; }
        DumpRecursive(prefab.transform, 0);
    }

    static void DumpRecursive(Transform t, int depth)
    {
        var indent = new string(' ', depth * 2);
        var compNames = string.Join(", ",
            t.GetComponents<Component>().Select(c => c == null ? "<null>" : c.GetType().Name));
        Debug.Log($"{indent}{t.name}  [{compNames}]");
        foreach (Transform child in t) DumpRecursive(child, depth + 1);
    }

    // For each Renderer in Court_Final, list its material(s), the shader those
    // materials use, and every texture property + currently-bound texture.
    // Use this when meshes render flat / pink / untextured: the dump shows
    // whether (a) materials are missing entirely, (b) shaders failed to
    // compile, or (c) materials exist but texture refs are unbound.
    [MenuItem("Tools/Dump Court Materials")]
    public static void DumpCourtMaterials()
    {
        GameObject prefab = null;
        foreach (var candidate in PREFAB_NAME_CANDIDATES)
        {
            foreach (var g in AssetDatabase.FindAssets($"{candidate} t:Prefab"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (Path.GetFileNameWithoutExtension(p) == candidate)
                { prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p); break; }
            }
            if (prefab != null) break;
        }
        if (prefab == null) { Debug.LogError("Court prefab not found."); return; }

        // Inspect on a temporary instance so we read what would actually render.
        var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
        try
        {
            int rendererCount = 0;
            foreach (var r in inst.GetComponentsInChildren<Renderer>(true))
            {
                rendererCount++;
                Debug.Log($"[Mat] {r.transform.GetHierarchyPath()}  ({r.GetType().Name}, {r.sharedMaterials.Length} materials)");
                for (int i = 0; i < r.sharedMaterials.Length; i++)
                {
                    var m = r.sharedMaterials[i];
                    if (m == null) { Debug.LogWarning($"[Mat]   slot {i}: <NULL MATERIAL>"); continue; }
                    var shaderName = m.shader != null ? m.shader.name : "<no shader>";
                    Debug.Log($"[Mat]   slot {i}: '{m.name}'  shader='{shaderName}'");
                    if (m.shader != null)
                    {
                        int propCount = m.shader.GetPropertyCount();
                        for (int p = 0; p < propCount; p++)
                        {
                            if (m.shader.GetPropertyType(p) != UnityEngine.Rendering.ShaderPropertyType.Texture) continue;
                            var prop = m.shader.GetPropertyName(p);
                            var tex = m.GetTexture(prop);
                            var bound = tex != null ? $"{tex.GetType().Name} '{tex.name}'" : "(none)";
                            Debug.Log($"[Mat]     {prop} -> {bound}");
                        }
                    }
                }
            }
            Debug.Log($"[Mat] Total renderers: {rendererCount}");

            // Also list all Court_* materials and Bricks/Carpet textures present
            // in the project, so we can see whether assets exist that *could* be
            // bound (vs. missing entirely).
            Debug.Log("[Mat] === Available Court_* materials in project:");
            foreach (var g in AssetDatabase.FindAssets("Court t:Material"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                Debug.Log($"[Mat]   {p}");
            }
            Debug.Log("[Mat] === Available Bricks/Carpet textures in project:");
            foreach (var name in new[] { "Bricks 2", "Carpet 4" })
                foreach (var g in AssetDatabase.FindAssets($"\"{name}\" t:Texture"))
                {
                    var p = AssetDatabase.GUIDToAssetPath(g);
                    Debug.Log($"[Mat]   {p}");
                }
        }
        finally
        {
            Object.DestroyImmediate(inst);
        }
    }

    // Binds Court_Wall* and Court_Stand materials to the *correct* textures
    // (Background_014_001 on the walls; Court_Stand on the stands). These live
    // in general-sprites_assets_all.bundle, which AssetRipper couldn't resolve
    // when only general-prefabs was staged — so the .mat files in the project
    // have orphaned texture refs. Pre-extract the two PNGs into
    // Assets/Texture/, then run this to wire them up.
    //
    //   python3 -c "import UnityPy; env = UnityPy.load('<path-to-general-sprites>'); \
    //               [d.image.save(f'<project>/Assets/Texture/{d.m_Name}.png') \
    //                for o in env.objects if o.type.name == 'Texture2D' \
    //                for d in [o.read()] if d.m_Name in ('Background_014_001','Court_Stand')]"
    //
    // Supersedes the prior (destructive) "Rebind Court Materials" command,
    // which bound the walls to Bricks 2 — that was wrong: the walls carry the
    // stained-glass / wood / marble art via the Background_014_001 wall
    // texture projected in UV space.
    [MenuItem("Tools/Bind Court Wall Textures")]
    public static void BindCourtWallTextures()
    {
        Texture2D wallTex  = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Texture/Background_014_001.png");
        Texture2D standTex = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Texture/Court_Stand.png");
        if (wallTex == null || standTex == null)
        {
            Debug.LogError("[Bind] Missing Assets/Texture/Background_014_001.png or Court_Stand.png. " +
                           "Extract them from general-sprites_assets_all.bundle first.");
            return;
        }

        // (material name → texture to bind on _BaseMap + _MainTex)
        var bindings = new (string mat, Texture2D tex)[]
        {
            ("Court_Wall",      wallTex),
            ("Court_Wall@7",    wallTex),
            ("Court_Wall@Flip", wallTex),
            ("Court_Stand",     standTex),
        };
        int totalRebound = 0;
        foreach (var (matName, tex) in bindings)
        {
            var path = $"Assets/Material/{matName}.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null) { Debug.LogWarning($"[Bind] {path} not in project."); continue; }
            int rebound = 0;
            foreach (var prop in new[] { "_BaseMap", "_MainTex" })
            {
                if (!mat.HasProperty(prop)) continue;
                mat.SetTexture(prop, tex);
                rebound++;
            }
            EditorUtility.SetDirty(mat);
            Debug.Log($"[Bind] {path}: bound {rebound} prop(s) to '{tex.name}'");
            totalRebound += rebound;
        }
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        Debug.Log($"[Bind] Done. {totalRebound} texture binding(s) restored.");
    }

    // Dumps the world positions of every Wall_*, Stand_*, Plane, Step,
    // FireContainer_* under the Court prefab — and the camera anchor if any.
    // Use this to figure out the real stage layout: where are the walls, where
    // is the stand ring, which direction is "stage front" (the side with the
    // backdrop)? Without this, the orbital camera math is guessing.
    [MenuItem("Tools/Dump Court Geometry")]
    public static void DumpCourtGeometry()
    {
        GameObject prefab = null;
        foreach (var candidate in PREFAB_NAME_CANDIDATES)
        {
            foreach (var g in AssetDatabase.FindAssets($"{candidate} t:Prefab"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (Path.GetFileNameWithoutExtension(p) == candidate)
                { prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p); break; }
            }
            if (prefab != null) break;
        }
        if (prefab == null) { Debug.LogError("Court prefab not found."); return; }
        var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
        try
        {
            string[] prefixes = { "Wall_", "Stand_", "Plane", "Step", "FireContainer_", "Camera", "CameraContainer" };
            // group by prefix for readability
            foreach (var prefix in prefixes)
            {
                var matches = inst.GetComponentsInChildren<Transform>(true)
                                  .Where(t => t.name.StartsWith(prefix.TrimEnd('_')) ||
                                              (prefix.EndsWith("_") && t.name.StartsWith(prefix)))
                                  .OrderBy(t => t.name)
                                  .ToArray();
                if (matches.Length == 0) continue;
                Debug.Log($"=== {prefix}* ({matches.Length}) ===");
                foreach (var t in matches)
                {
                    var r = t.GetComponent<Renderer>();
                    string size = r != null ? $" bounds={r.bounds.size}" : "";
                    Debug.Log($"  {t.name,-20}  pos={t.position}  rot={t.eulerAngles}{size}");
                }
            }
            // also dump prefab-root bounds for reference
            var renderers = inst.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length > 0)
            {
                var b = renderers[0].bounds;
                foreach (var r in renderers) b.Encapsulate(r.bounds);
                Debug.Log($"=== Total bounds: center={b.center} size={b.size} ===");
            }
            // and Stand centroid for comparison
            var stands = inst.GetComponentsInChildren<Transform>(true)
                             .Where(t => t.name.StartsWith("Stand_") &&
                                         int.TryParse(t.name.Substring(6), out _))
                             .ToArray();
            if (stands.Length > 0)
            {
                Vector3 c = Vector3.zero;
                foreach (var s in stands) c += s.position;
                c /= stands.Length;
                Debug.Log($"=== Stand_NN centroid ({stands.Length} stands): {c} ===");
            }
        }
        finally { Object.DestroyImmediate(inst); }
    }

    [MenuItem("Tools/Render Court Angles")]
    public static void Render()
    {
        // 1. Locate the Court prefab. Try the candidate list first (exact
        //    filename match), then fall back to any 'Court'-named prefab
        //    if there's exactly one. Otherwise abort with a diagnostic.
        GameObject prefab = null;
        string prefabPath = null;
        foreach (var candidate in PREFAB_NAME_CANDIDATES)
        {
            foreach (var g in AssetDatabase.FindAssets($"{candidate} t:Prefab"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (Path.GetFileNameWithoutExtension(p) == candidate)
                {
                    prefabPath = p;
                    prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                    break;
                }
            }
            if (prefab != null) break;
        }
        if (prefab == null)
        {
            // Fallback: any single Court* prefab
            var anyGuids = AssetDatabase.FindAssets("Court t:Prefab");
            if (anyGuids.Length == 1)
            {
                prefabPath = AssetDatabase.GUIDToAssetPath(anyGuids[0]);
                prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            }
            else
            {
                Debug.LogError("[RenderCourtAngles] Couldn't find a Court prefab. " +
                               "Run Tools → 'List Court Prefabs' to see what's available, then add the " +
                               "right name to PREFAB_NAME_CANDIDATES at the top of this script.");
                if (anyGuids.Length > 1)
                {
                    Debug.LogError($"[RenderCourtAngles] {anyGuids.Length} ambiguous matches:");
                    foreach (var g in anyGuids)
                        Debug.LogError($"  {AssetDatabase.GUIDToAssetPath(g)}");
                }
                return;
            }
        }
        Debug.Log($"[RenderCourtAngles] Using prefab: {prefabPath}");

        // 2. Instantiate into the active scene so HDRP/URP renderer can pick
        //    it up. We delete the instance after rendering.
        var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
        if (instance == null)
        {
            Debug.LogError($"[RenderCourtAngles] Failed to instantiate prefab at {prefabPath}.");
            return;
        }

        try
        {
            // 3. Compute stage_center. The Court prefab's geometry tells us:
            //    - All Stand_NN are at world (0,0,0) (they're rotation-only
            //      markers; characters stand at a per-Stand local offset).
            //    - The Plane (floor) is at world Y=0.
            //    - Walls (Wall_1, Wall_2) are at world (0, 4.2, 0), each 15m
            //      tall — they extend from Y=-3.3 to Y=11.7.
            //    Therefore the stage origin is just (0, 0, 0). We don't use
            //    bbox.min.y as the floor — the wall mesh dips below Y=0 and
            //    would drag the floor anchor to Y=-3.3, putting the camera
            //    nearly on the floor.
            var renderers = instance.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0)
            {
                Debug.LogError("[RenderCourtAngles] No Renderers in prefab — can't compute stage center.");
                return;
            }
            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);

            var stageCenter = new Vector3(0f, 0f, 0f);
            Debug.Log($"[RenderCourtAngles] Stage center: {stageCenter} (hardcoded prefab origin; Plane Y=0)");
            Debug.Log($"[RenderCourtAngles] Bounds (informational): center={bounds.center} size={bounds.size}");

            // 4. Build (or reuse) a single Camera we'll re-position per preset.
            //    The Court_Final prefab has no Camera of its own — runtime
            //    constructs one — so we synthesize ours fresh.
            var camGo = new GameObject("__SynthesizedCamera");
            camGo.transform.SetParent(instance.transform, false);
            var cam = camGo.AddComponent<Camera>();
            cam.fieldOfView = FOV;
            cam.enabled = true;

            // 5. RenderTexture sized to the canvas. ARGB32 keeps alpha intact
            //    (Unity discards alpha by default when rendering to screen,
            //    but we need it for the PNG export).
            var rt = new RenderTexture(WIDTH, HEIGHT, 24, RenderTextureFormat.ARGB32);
            rt.antiAliasing = 8;
            cam.targetTexture = rt;

            Directory.CreateDirectory(OUT_DIR);

            foreach (var preset in PRESETS)
            {
                // standIdx = yawTarget + composition delta. Each integer step
                // around the 13-stand ring = 360/13 ≈ 27.7°.
                float standIdx = preset.yawTarget + preset.compositionDelta;
                float yawDeg = standIdx / COURT_STAND_COUNT * 360f;

                // Orbital placement: stage_center → out by Distance along the
                // yaw direction, then up by Height. Aim at LOOKAT_HEIGHT
                // above stage_center, then layer roll on top (tilt is 0 for
                // every single-screen subroutine).
                Vector3 orbit = Quaternion.Euler(0, yawDeg, 0) * new Vector3(0, 0, -preset.distance);
                cam.transform.position = stageCenter + orbit + Vector3.up * preset.height;
                cam.transform.LookAt(stageCenter + Vector3.up * LOOKAT_HEIGHT);
                cam.transform.rotation = cam.transform.rotation * Quaternion.Euler(0, 0, preset.rollZ);

                string name = $"Background_014_{preset.outputIndex:D3}";
                Debug.Log($"[RenderCourtAngles] {name} ({preset.label}): " +
                          $"yaw={yawDeg:F1}° dist={preset.distance} height={preset.height} roll={preset.rollZ} → pos={cam.transform.position}");

                cam.Render();
                var prevActive = RenderTexture.active;
                RenderTexture.active = rt;
                var tex = new Texture2D(WIDTH, HEIGHT, TextureFormat.ARGB32, false, false);
                tex.ReadPixels(new Rect(0, 0, WIDTH, HEIGHT), 0, 0);
                tex.Apply();
                RenderTexture.active = prevActive;

                var path = Path.Combine(OUT_DIR, $"{name}.png");
                File.WriteAllBytes(path, tex.EncodeToPNG());
                Debug.Log($"[RenderCourtAngles] Wrote {path}");
                Object.DestroyImmediate(tex);
            }

            cam.targetTexture = null;
            Object.DestroyImmediate(rt);
        }
        finally
        {
            Object.DestroyImmediate(instance);
        }

        EditorUtility.RevealInFinder(OUT_DIR);
        Debug.Log($"[RenderCourtAngles] Done. Output at: {OUT_DIR}");
    }
}

// Helper to log a transform's hierarchy path for diagnostics.
internal static class TransformPathExt
{
    public static string GetHierarchyPath(this Transform t)
    {
        var path = t.name;
        while (t.parent != null) { t = t.parent; path = t.name + "/" + path; }
        return path;
    }
}
