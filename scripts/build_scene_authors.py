#!/usr/bin/env python3
"""Bake the slim author metadata the scene editor needs into ``scene/authors.json``.

The scene editor only reads four fields per character: ``id``,
``nameColor_hex``, ``tagged_name``, and ``intrinsic_scale``. The full
``characters/configuration.json`` also carries ``displayName_ja``,
``nameColor`` (rgba), ``asset_guid``, and ``source`` / ``locales`` metadata —
useful for the offline compositor and extractors, but dead weight in the
browser. ``intrinsic_scale`` lives in each character's ``layers.json`` (the
prefab's pre-baked uniform Transform scale, e.g. 0.6 for Ema, 0.54 for Hanna).
This script merges both sources so ``scene/`` can be a self-contained data
root.

``characters/configuration.json`` + ``characters/{id}/layers.json`` stay as
the source of truth. Re-run this script after ``extract_character_meta.py``
or any ``extract_bundle.py`` re-extraction.

Output schema::

    {
      "characters": [
        { "id": "...", "nameColor_hex": "#RRGGBB",
          "tagged_name": { "ja": "...", "ko": "...", ... },
          "intrinsic_scale": 0.6 },
        ...
      ]
    }

NPCs and characters without a layered ``layers.json`` (e.g. diced atlases like
Warden/Yuki) get ``intrinsic_scale: 1.0`` — the runtime treats absence of a
prefab Transform as identity scaling.

Usage: python3 scripts/build_scene_authors.py [<src>] [<dst>] [<chars_root>]
       (defaults: ./characters/configuration.json  ./scene/authors.json  ./characters)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Fields lifted directly from configuration.json. ``intrinsic_scale`` is
# merged in separately from each character's layers.json (see build()).
_KEEP_FIELDS = ("id", "nameColor_hex", "tagged_name")


def _read_intrinsic_scale(chars_root: Path, char_id: str) -> float:
    """Return ``intrinsic_scale`` from ``characters/{char_id}/layers.json``.

    Falls back to 1.0 when the file is absent (diced NPCs) or the field
    isn't present (older extractor output).
    """
    layers_path = chars_root / char_id / "layers.json"
    if not layers_path.is_file():
        return 1.0
    try:
        data = json.loads(layers_path.read_text())
    except (OSError, json.JSONDecodeError):
        return 1.0
    return float(data.get("intrinsic_scale", 1.0))


def build(src: Path, chars_root: Path) -> dict:
    data = json.loads(src.read_text())
    chars = []
    for rec in data.get("characters", []):
        slim = {k: rec[k] for k in _KEEP_FIELDS if k in rec}
        # Skip records missing the editor's required field. Defensive: every
        # current entry has an id, but a malformed source shouldn't propagate.
        if "id" not in slim:
            continue
        slim["intrinsic_scale"] = _read_intrinsic_scale(chars_root, slim["id"])
        chars.append(slim)
    return {"characters": chars}


if __name__ == "__main__":
    args = sys.argv[1:]
    src         = Path(args[0]) if len(args) > 0 else Path("characters/configuration.json")
    dst         = Path(args[1]) if len(args) > 1 else Path("scene/authors.json")
    chars_root  = Path(args[2]) if len(args) > 2 else Path("characters")

    if not src.is_file():
        raise SystemExit(f"{src}: not a file")
    if not chars_root.is_dir():
        raise SystemExit(f"{chars_root}: not a directory")

    meta = build(src, chars_root)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(f"# wrote {dst}  ({len(meta['characters'])} characters)")
