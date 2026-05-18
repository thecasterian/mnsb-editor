"""Extract per-character scale coefficients from CharactersConfigurationExtended.

The diced character actors in this game (Yuki, Warden, Jailer*, Creature*) ship as
SpriteDicing.DicedSpriteAtlas bundles with no Transform tree, so the rest-state
size coefficient (analogous to a layered character's Angle01 child localScale)
cannot live on the actor's prefab. The game stores it instead on a sibling
ScriptableObject, `CharactersConfigurationExtended` (from
`GigaCreation.NaninovelExtender.ExtendedActors`), exposed under Naninovel's
Project Settings.

At runtime, CharacterManagerExtended builds `_baseScales: Dictionary<string, float>`
from `CharactersConfigurationExtended.Options[]` and passes the matching value to
each new `DicedSpriteCharacterExtended` constructor, where it lands in
`private readonly Nullable<float> _scaleCoefficient` (Il2Cpp offset 0x108). The
override `SetBehaviourScale(Vector3)` then applies it on top of `@char scale`, so
the actor's final `transform.localScale = userScale * _scaleCoefficient`.

Layered characters don't appear in Options[] — their coefficient is already
baked into the bundle's child Transform (`Angle01`) and surfaces via
`extract_bundle.py` → `layers.json.intrinsic_scale`.

This script byte-parses `CharactersConfigurationExtended.Options[]` directly out
of `resources.assets` (no typetree shipped for it) and overwrites the
`intrinsic_scale` field on the matching records in `scene/authors.json`,
replacing the placeholder 1.0 that diced bundles leave behind. Run it after
`extract_character_meta.py` regenerates `characters/configuration.json` (or
whatever produced `scene/authors.json`).

Serialized layout in resources.assets (little-endian throughout):

    int32  len('CharactersConfigurationExtended')    # = 31
    bytes  m_Name string                              # 31 bytes + 1 byte align pad
    int32  options_count                              # = 18 for this game
    for each option:
        int32   len(Character)
        bytes   Character string + (0..3 byte align pad to 4-byte boundary)
        float32 Scale

Usage:
    python3 scripts/extract_scale_coefficients.py <resources.assets> [<authors.json>]

    <authors.json> defaults to <repo>/scene/authors.json relative to this script.
"""

import json
import re
import struct
import sys
from pathlib import Path


M_NAME = b"CharactersConfigurationExtended"


def _read_lp_str(buf: bytes, off: int) -> tuple[str, int]:
    n = struct.unpack_from("<i", buf, off)[0]
    off += 4
    s = buf[off : off + n].decode("utf-8")
    off += n
    pad = (4 - (off % 4)) % 4
    return s, off + pad


def _find_options_block(data: bytes) -> int:
    """Return file offset where the options_count int32 begins.

    The literal 'CharactersConfigurationExtended' appears in multiple places
    (assembly-qualified type names embedded in nearby assets). Only the
    m_Name field of the actual MonoBehaviour is preceded by its int32
    length prefix `0x1F = 31`, so anchor on that pair to disambiguate.
    """
    for m in re.finditer(re.escape(M_NAME), data):
        start = m.start()
        if start < 4:
            continue
        if struct.unpack_from("<i", data, start - 4)[0] != len(M_NAME):
            continue
        return start + len(M_NAME) + 1  # +1 = single trailing null/pad
    raise RuntimeError(
        "CharactersConfigurationExtended m_Name field not found in input"
    )


def parse_options(data: bytes) -> dict[str, float]:
    off = _find_options_block(data)
    count = struct.unpack_from("<i", data, off)[0]
    off += 4
    out: dict[str, float] = {}
    for _ in range(count):
        char, off = _read_lp_str(data, off)
        scale = struct.unpack_from("<f", data, off)[0]
        off += 4
        out[char] = round(scale, 6)
    return out


def update_authors(authors_path: Path, scales: dict[str, float]) -> tuple[int, int, list[str]]:
    """Overwrite intrinsic_scale on matching ids. Returns (changed, unchanged, missing)."""
    doc = json.loads(authors_path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    changed = 0
    unchanged = 0
    for c in doc.get("characters", []):
        cid = c.get("id", "")
        if cid in scales:
            seen.add(cid)
            if c.get("intrinsic_scale") != scales[cid]:
                c["intrinsic_scale"] = scales[cid]
                changed += 1
            else:
                unchanged += 1
    authors_path.write_text(
        json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    missing = sorted(set(scales) - seen)
    return changed, unchanged, missing


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 1
    assets_path = Path(argv[1])
    authors_path = (
        Path(argv[2])
        if len(argv) > 2
        else Path(__file__).resolve().parent.parent / "scene" / "authors.json"
    )
    if not assets_path.is_file():
        print(f"error: {assets_path} is not a file", file=sys.stderr)
        return 1
    scales = parse_options(assets_path.read_bytes())
    print(f"Parsed {len(scales)} entries from {assets_path}:")
    width = max(len(c) for c in scales)
    for char, scale in scales.items():
        print(f"  {char:<{width}s}  {scale}")
    if not authors_path.is_file():
        print(f"\nnote: {authors_path} not found; skipping update", file=sys.stderr)
        return 0
    changed, unchanged, missing = update_authors(authors_path, scales)
    print(
        f"\nUpdated {authors_path}: "
        f"{changed} changed, {unchanged} already correct"
    )
    if missing:
        print(
            f"warning: {len(missing)} Options[] id(s) not found in authors.json: "
            f"{', '.join(missing)}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
