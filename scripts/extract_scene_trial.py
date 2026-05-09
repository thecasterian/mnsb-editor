#!/usr/bin/env python3
"""Extract trial UI assets from AssetBundles into ``scene/trial/``.

Trial scenes in the game are composed of three layers (back to front):

  1. A panel chrome prefab — ``TrialChoicePanel@Hiro`` or ``TrialChoicePanel@Ema``
     — providing the backdrop and witness/lawyer portrait anchored right.
  2. N runtime-instantiated ``ChoiceButton_Trial@<variant>`` widgets, arranged
     by the panel's ``Content`` ``VerticalLayoutGroup``. The 12 variants cover
     magic accusations (Coco/Ema/Margo/Leia/AnAn/Nanoka), debate shouts
     (Objection/Perjury/Question), and meta options (Approval/Cancel/bare).
  3. ``DebateUI`` overlay — clock + fast-forward button chrome shown during
     debate phases.

This script walks all 15 prefabs straight out of the source AssetBundles
and emits a single consolidated ``scene/trial/meta.json``. Each prefab
record includes its layers, texts, and containers; the trial choice
handler in scene.js needs the panel's ``Content`` container's ``placement``
to position widgets at runtime.

**Localized variants**: many trial sprites have rendered text baked in
(Magic_Purple, Objection, Doubt, etc.) and ship as ``<base>@<locale>``
sibling sprites in the atlas. The walker emits each layer with the
prefab's hard-coded reference (typically ``@Ja``); this script then
discovers all sibling locale variants in the same atlas and adds a
``locale_variants`` map to the layer record. scene.js renders by
``layer.locale_variants?.[currentLocale] ?? layer.file``. Locales are
discovered from the atlas (no hard-coded list) — currently @Ja and
@ZhHans ship.

**User-added locales**: after the bundle-driven pass, the script also
scans ``out_root`` for ``<safe_base>_<locale>.png`` files matching any
layer's sprite base, and folds those into ``locale_variants`` too. This
lets you drop hand-translated sprites into ``scene/trial/`` (e.g. Korean
``Agreement_Ko.png``) and have them picked up on the next run; bundle
entries win on collision. Such files are also protected from the
stale-PNG cleanup pass.

Output layout::

    scene/trial/
      meta.json
      <sprite>.png   # canonical + every locale variant of every used sprite

Usage::

    python3 scripts/extract_scene_trial.py <out_root> <bundle> [<bundle> ...]

Bundles auto-classify (any with ``SpriteAtlas`` → sprite source; rest →
prefab sources). Four bundles cover all 15 target prefabs::

    python3 scripts/extract_scene_trial.py scene/trial \\
      <…>/general-sprites_assets_all.bundle \\
      <…>/naninovel-choicehandlers_assets_all.bundle \\
      <…>/general-choicebuttons_assets_all.bundle \\
      <…>/naninovel-ui_assets_all.bundle
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import UnityPy

sys.path.insert(0, str(Path(__file__).parent))
import _ui_walker as W  # noqa: E402

# Prefab names exactly as they appear in the bundles (the @-suffix marks
# variants of a base widget). 2 chrome panels + 12 button widgets + 1 overlay.
TARGET_PREFABS: set[str] = {
    "TrialChoicePanel@Hiro",
    "TrialChoicePanel@Ema",
    "ChoiceButton_Trial",            # base/default (no @-suffix variant)
    "ChoiceButton_Trial@Approval",
    "ChoiceButton_Trial@Cancel",
    "ChoiceButton_Trial@MagicAnAn",
    "ChoiceButton_Trial@MagicCoco",
    "ChoiceButton_Trial@MagicEma",
    "ChoiceButton_Trial@MagicLeia",
    "ChoiceButton_Trial@MagicMargo",
    "ChoiceButton_Trial@MagicNanoka",
    "ChoiceButton_Trial@Objection",
    "ChoiceButton_Trial@Perjury",
    "ChoiceButton_Trial@Question",
    "DebateUI",
}


def _classify_bundles(paths: list[Path]) \
        -> tuple[list[tuple[Path, object]], list[tuple[Path, object]]]:
    sprite_envs: list[tuple[Path, object]] = []
    prefab_envs: list[tuple[Path, object]] = []
    for bp in paths:
        env = UnityPy.load(str(bp))
        if any(o.type.name == "SpriteAtlas" for o in env.objects):
            sprite_envs.append((bp, env))
        else:
            prefab_envs.append((bp, env))
    return sprite_envs, prefab_envs


def _build_locale_index(atlas_of_sprite: dict[int, str],
                        sprite_obj_by_pid: dict[int, object],
                        target_atlases: set[str]) \
        -> dict[tuple[str, str], dict[str, int]]:
    """Group sprites in the target atlases by ``(atlas, base_name)``, where
    ``sprite_name == "<base>@<locale>"`` (split on the *last* ``@``). Returns
    only groups with ≥2 distinct locale entries — i.e. genuine localized
    variants, not just one-off names that happen to contain ``@``.

    Bundle-driven: discovers locale tags from the sprite names, no hard-coded
    list. Currently the trial atlas ships @Ja and @ZhHans.
    """
    groups: dict[tuple[str, str], dict[str, int]] = {}
    for pid, atlas in atlas_of_sprite.items():
        if atlas not in target_atlases:
            continue
        obj = sprite_obj_by_pid.get(pid)
        if obj is None:
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        sname = tree.get("m_Name", "") or ""
        if "@" not in sname:
            continue
        base, locale = sname.rsplit("@", 1)
        if not base or not locale:
            continue
        groups.setdefault((atlas, base), {})[locale] = pid
    return {key: locs for key, locs in groups.items() if len(locs) >= 2}


def _augment_user_locales(prefab_records: list[dict],
                          out_root: Path) -> set[str]:
    """Fold user-added ``<safe_base>_<locale>.png`` files in ``out_root`` into
    each layer's ``locale_variants`` map (only on layers that already have a
    bundle-derived map, so we don't speculatively assign locale tokens to
    sprites that aren't actually localized). Bundle entries win on collision.

    Returns the set of filenames that should be preserved from the cleanup
    pass — i.e. user-authored siblings whose locale wasn't already in the
    bundle map.
    """
    sibling_index: dict[str, dict[str, str]] = {}
    for fname in (p.name for p in out_root.glob("*.png")):
        stem = fname[:-4]
        if "_" not in stem:
            continue
        # Filenames are ``<safe_base>_<locale>.png`` where the locale token
        # has no underscores (Ja, Ko, ZhHans, ZhHant, EnUS, …). rsplit on
        # the last ``_`` correctly splits e.g. ``Magic_Purple_ZhHans``.
        safe_base, locale = stem.rsplit("_", 1)
        sibling_index.setdefault(safe_base, {})[locale] = fname

    preserved: set[str] = set()
    for prefab in prefab_records:
        for layer in prefab["layers"]:
            if "locale_variants" not in layer:
                continue
            sname = layer["name"]
            if "@" not in sname:
                continue
            base, _ = sname.rsplit("@", 1)
            safe_base = W.safe_filename(base)
            siblings = sibling_index.get(safe_base, {})
            bundle_locales = set(layer["locale_variants"])
            added = {loc: fname for loc, fname in siblings.items()
                     if loc not in bundle_locales}
            if added:
                merged = {**layer["locale_variants"], **added}
                layer["locale_variants"] = dict(sorted(merged.items()))
                preserved.update(added.values())
    return preserved


def _register_sprite(pid: int, atlas: str,
                     sprite_obj_by_pid: dict[int, object],
                     sprites_used: dict[int, dict]) -> str:
    """Add a sprite to ``sprites_used`` (if not already present) and return
    its flat basename. Used for locale variants the walker didn't naturally
    visit (because no prefab in the input set referenced them directly).

    Skips ``size`` / ``pivot`` (walker fields the trial output never reads).
    """
    if pid not in sprites_used:
        obj = sprite_obj_by_pid[pid]
        sp = obj.read()
        sprites_used[pid] = {
            "atlas":      atlas,
            "name":       sp.m_Name,
            "file":       f"{W.safe_filename(sp.m_Name)}.png",
            "sprite_obj": obj,
        }
    return sprites_used[pid]["file"]


def build(out_root: Path, bundle_paths: list[Path]) -> dict:
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
        a, s = W.build_sprite_index(env)
        atlas_of_sprite.update(a)
        sprite_obj_by_pid.update(s)

    all_prefabs: list[dict] = []
    sprites_used: dict[int, dict] = {}
    for bp, env in prefab_envs:
        prefabs = W.walk_prefab_bundle(
            env, bp.name, sprite_obj_by_pid, atlas_of_sprite,
            W.DEFAULT_CANVAS, sprites_used,
        )
        all_prefabs.extend(prefabs)

    found_by_name: dict[str, dict] = {p["name"]: p for p in all_prefabs}
    missing = sorted(TARGET_PREFABS - set(found_by_name))
    if missing:
        raise SystemExit(
            f"missing prefabs in supplied bundles: {', '.join(missing)}"
        )

    # (atlas, basename) -> sprite path_id, so we can flatten "<atlas>/x.png"
    # to "x.png" while still detecting cross-atlas basename collisions.
    pid_by_atlas_file: dict[tuple[str, str], int] = {
        (m["atlas"], m["file"]): pid for pid, m in sprites_used.items()
    }

    # Build the locale index over the atlases the trial prefabs actually use,
    # so we don't typetree-read sprites in unrelated atlases.
    target_atlases: set[str] = set()
    for name in TARGET_PREFABS:
        for layer in found_by_name[name].get("layers", []):
            target_atlases.add(layer["atlas"])
    locale_index = _build_locale_index(
        atlas_of_sprite, sprite_obj_by_pid, target_atlases,
    )

    prefab_records: list[dict] = []
    needed_pids: dict[str, int] = {}     # basename -> path_id

    for name in sorted(TARGET_PREFABS):
        data = found_by_name[name]

        rewritten_layers: list[dict] = []
        for layer in data.get("layers", []):
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

            # Discover locale siblings of this layer's sprite. The canonical
            # locale is included in the resulting map for self-contained
            # consumer lookup (`layer.locale_variants[locale] ?? layer.file`).
            locale_files: dict[str, str] | None = None
            sname_full = layer["name"]
            if "@" in sname_full:
                sname_base, _ = sname_full.rsplit("@", 1)
                variants = locale_index.get((layer["atlas"], sname_base))
                if variants:
                    locale_files = {}
                    for loc in sorted(variants):
                        var_pid = variants[loc]
                        var_basename = _register_sprite(
                            var_pid, layer["atlas"],
                            sprite_obj_by_pid, sprites_used,
                        )
                        existing = needed_pids.get(var_basename)
                        if existing is not None and existing != var_pid:
                            raise SystemExit(
                                f"basename collision: {var_basename} maps to "
                                f"two sprite path_ids ({existing}, {var_pid}); "
                                f"flat layout assumes unique names"
                            )
                        needed_pids[var_basename] = var_pid
                        locale_files[loc] = var_basename

            # Rebuild the layer dict so ``locale_variants`` lands right after
            # ``file`` (insertion order = JSON output order).
            rewritten: dict = {
                "name": layer["name"],
                "file": basename,
            }
            if locale_files is not None:
                rewritten["locale_variants"] = locale_files
            for k in ("go", "atlas", "group", "order", "pos", "size",
                      "color", "material"):
                if k in layer:
                    rewritten[k] = layer[k]
            rewritten_layers.append(rewritten)

        record: dict = {
            "name":        name,
            "canvas_size": data["canvas_size"],
        }
        if "root_intrinsic_size" in data:
            record["root_intrinsic_size"] = data["root_intrinsic_size"]
        record["layers"] = rewritten_layers
        if data.get("texts"):
            record["texts"] = data["texts"]
        if data.get("containers"):
            record["containers"] = data["containers"]
        prefab_records.append(record)

    # Save sprite PNGs flat. Sorted order = deterministic re-runs.
    for basename in sorted(needed_pids):
        pid = needed_pids[basename]
        sp_obj = sprites_used[pid]["sprite_obj"]
        W.padded_sprite_image(sp_obj.read()).save(out_root / basename)

    # Fold any user-added locale siblings (e.g. hand-translated _Ko.png
    # files) into the layer records and protect them from cleanup.
    preserve_user_files = _augment_user_locales(prefab_records, out_root)

    keep = set(needed_pids) | preserve_user_files | {"meta.json"}
    for png in out_root.glob("*.png"):
        if png.name not in keep:
            png.unlink()

    # Top-level canvas_size = the rendering canvas (2560×1440), independent of
    # whether individual prefabs are screens or widgets.
    return {"canvas_size": list(W.DEFAULT_CANVAS), "prefabs": prefab_records}


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
    n_containers = sum(len(p.get("containers", [])) for p in meta["prefabs"])
    n_localized = sum(
        1 for p in meta["prefabs"] for layer in p["layers"]
        if "locale_variants" in layer
    )
    locales = sorted({
        loc for p in meta["prefabs"] for layer in p["layers"]
        for loc in layer.get("locale_variants", {})
    })
    n_sprites = sum(1 for _ in out_root.glob("*.png"))
    print(
        f"# wrote {out_meta}  "
        f"({n_prefabs} prefabs, {n_layers} layers ({n_localized} localized), "
        f"{n_texts} texts, {n_containers} containers, {n_sprites} sprites; "
        f"locales: {', '.join(locales) if locales else 'none'})"
    )
