#!/usr/bin/env python3
"""Extract the Adv-scene editor's UI assets from AssetBundles into ``scene/adv/``.

The scene editor (scene.js) renders a resting Adv-mode dialog frame composed
of four prefabs — NormalPrinter, AutoToggle, ControlPanel, WitchBookButtonUI —
with static filters (``dropLayers`` / ``keepGroupPrefix``) that keep only the
leaves visible at rest. This script walks those prefabs straight out of the
source AssetBundles, applies the resting-frame filters offline, saves the
referenced sprite PNGs with flat basenames, and emits a single consolidated
``scene/adv/meta.json`` so the editor can fetch one file instead of four.

Reuses the bundle walker from ``_ui_walker.py``.

Output layout::

    scene/adv/
      meta.json
      <sprite>.png   # 9 unique basenames, deduplicated across atlases

``meta.json`` schema::

    {
      "canvas_size": [W, H],
      "prefabs": [
        {
          "name":         "NormalPrinter",
          "toggle":       null,                    # null = always-on
          "items_toggle": { "<group_prefix>": "<runtime_flag_name>" },
          "layers":       [{ ..., "file": "<basename>.png" }, ...],
          "texts":        [{ ... }, ...],
          "containers":   [{ ... }, ...]           # optional, when present
        },
        { "name": "AutoToggle",        "toggle": "showAutoToggle", ... },
        { "name": "ControlPanel",      "toggle": "showMenuButton", ... },
        { "name": "WitchBookButtonUI", "toggle": "showBookButton", ... }
      ]
    }

The ``toggle`` / ``items_toggle`` keys hold runtime-flag names that scene.js
maps to its live ``show*`` state. Renaming a flag in scene.js without
updating this script (or vice versa) will break rendering — scene.js
asserts every key resolves at load time.

Re-runnable: rewrites ``meta.json`` + the sprite PNGs in place, and prunes
any stale PNGs left from a previous run.

Usage::

    python3 scripts/extract_scene_adv.py <out_root> <bundle> [<bundle> ...]

Bundles auto-classify (any with ``SpriteAtlas`` → sprite source; rest →
prefab sources). Three bundles cover the four target prefabs::

    python3 scripts/extract_scene_adv.py scene/adv \\
      <…>/general-sprites_assets_all.bundle \\
      <…>/naninovel-textprinters_assets_all.bundle \\
      <…>/naninovel-ui_assets_all.bundle
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import UnityPy

# Reuse the prefab walker + sprite reconstruction from the sibling module.
sys.path.insert(0, str(Path(__file__).parent))
import _ui_walker as W  # noqa: E402

# Per-prefab static filters. Mirrors scene.js's ADV_SCENE_PREFABS exactly.
PREFABS: list[dict] = [
    {
        "name": "NormalPrinter",
        "drop_layers": {"Icon_Arrow_Double"},
        "toggle": None,
        "items_toggle": {"Wrapper/AuthorPanel": "showAuthorPlate"},
    },
    {
        "name": "AutoToggle",
        "keep_group_prefix": "Wrapper/AutoToggle/Off",
        "toggle": "showAutoToggle",
    },
    {
        "name": "ControlPanel",
        "keep_group_prefix": "Wrapper/OpenButton",
        "toggle": "showMenuButton",
    },
    {
        "name": "WitchBookButtonUI",
        "toggle": "showBookButton",
    },
]


def _keep(item: dict, cfg: dict) -> bool:
    if item.get("name") in cfg.get("drop_layers", set()):
        return False
    prefix = cfg.get("keep_group_prefix")
    if prefix and not (item.get("group") or "").startswith(prefix):
        return False
    return True


def _filter_layers(layers: list[dict], cfg: dict) -> list[dict]:
    out: list[dict] = []
    for layer in layers:
        if not _keep(layer, cfg):
            continue
        size = layer.get("size", [0, 0])
        if size[0] <= 0 or size[1] <= 0:
            continue
        out.append(layer)
    return out


def _filter_texts(texts: list[dict], cfg: dict) -> list[dict]:
    return [t for t in texts if _keep(t, cfg)]


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
    missing = [cfg["name"] for cfg in PREFABS if cfg["name"] not in found_by_name]
    if missing:
        raise SystemExit(
            f"missing prefabs in supplied bundles: {', '.join(missing)}"
        )

    pid_by_atlas_file: dict[tuple[str, str], int] = {
        (m["atlas"], m["file"]): pid for pid, m in sprites_used.items()
    }

    canvas_size: list[int] | None = None
    prefab_records: list[dict] = []
    needed_pids: dict[str, int] = {}     # basename -> path_id

    for cfg in PREFABS:
        name = cfg["name"]
        data = found_by_name[name]

        if canvas_size is None:
            canvas_size = data["canvas_size"]
        elif data["canvas_size"] != canvas_size:
            raise SystemExit(
                f"{name}: canvas_size {data['canvas_size']} disagrees with "
                f"first prefab's {canvas_size}"
            )

        layers = _filter_layers(data.get("layers", []), cfg)
        texts = _filter_texts(data.get("texts", []), cfg)

        rewritten_layers: list[dict] = []
        for layer in layers:
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
            rewritten = dict(layer)
            rewritten["file"] = basename
            rewritten_layers.append(rewritten)

        record: dict = {
            "name": name,
            "toggle": cfg.get("toggle"),
        }
        if cfg.get("items_toggle"):
            record["items_toggle"] = dict(cfg["items_toggle"])
        record["layers"] = rewritten_layers
        if texts:
            record["texts"] = texts
        if data.get("containers"):
            record["containers"] = data["containers"]
        prefab_records.append(record)

    # Save sprite PNGs flat. Sorted order = deterministic re-runs.
    for basename in sorted(needed_pids):
        pid = needed_pids[basename]
        sp_obj = sprites_used[pid]["sprite_obj"]
        W.padded_sprite_image(sp_obj.read()).save(out_root / basename)

    keep = set(needed_pids) | {"meta.json"}
    for png in out_root.glob("*.png"):
        if png.name not in keep:
            png.unlink()

    return {"canvas_size": canvas_size, "prefabs": prefab_records}


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
    n_sprites = sum(1 for _ in out_root.glob("*.png"))
    print(
        f"# wrote {out_meta}  "
        f"({n_prefabs} prefabs, {n_layers} layers, {n_texts} texts, "
        f"{n_containers} containers, {n_sprites} sprites)"
    )
