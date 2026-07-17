import json
import os

from PIL import Image

from build_bg_thumbs import THUMB_H, THUMB_W, build, cover_crop_box


def test_crop_box_of_2to1_source_takes_full_width_and_trims_height():
    # 4096x2048 is the real background shape. 16:9 of 2048px height is
    # 3641px wide, so 227px comes off each side.
    assert cover_crop_box(4096, 2048) == (227, 0, 3868, 2048)


def test_crop_box_of_exact_16by9_source_is_the_whole_image():
    assert cover_crop_box(2560, 1440) == (0, 0, 2560, 1440)


def test_crop_box_of_tall_source_trims_top_and_bottom():
    # 16:9 of 1000px width is exactly 562.5px tall, and Python's round() is
    # banker's rounding — round(562.5) is 562, not 563. So 438px gets split,
    # 219 off each end. Don't "correct" this to 218/563.
    assert cover_crop_box(1000, 1000) == (0, 219, 1000, 781)


def test_crop_box_is_always_16by9_within_a_pixel():
    for iw, ih in [(4096, 2048), (2560, 1440), (1000, 1000), (1920, 1200), (800, 3000)]:
        left, top, right, bottom = cover_crop_box(iw, ih)
        w, h = right - left, bottom - top
        assert abs(w / h - 2560 / 1440) < 0.01
        assert left >= 0 and top >= 0 and right <= iw and bottom <= ih


def _fixture_root(tmp_path, main=("Background_001_001",), stills=("Still_001_001",)):
    """A miniature scene/backgrounds tree: real PNGs, 2:1 like the real art."""
    root = tmp_path / "backgrounds"
    for d, names in (("main", main), ("stills", stills)):
        (root / d).mkdir(parents=True)
        for n in names:
            Image.new("RGB", (400, 200), (10, 20, 30)).save(root / d / f"{n}.png")
    meta = {
        "main": [{"id": "001_001", "name": n, "file": f"{n}.png", "size": [400, 200]} for n in main],
        "stills": [{"id": "001_001", "name": n, "file": f"{n}.png", "size": [400, 200]} for n in stills],
        "utility": [{"name": "Grid_001", "file": "Grid_001.png", "size": [400, 200], "from": "main"}],
    }
    (root / "meta.json").write_text(json.dumps(meta))
    return root


def test_build_writes_one_webp_per_main_and_stills_entry(tmp_path):
    root = _fixture_root(tmp_path)
    stats = build(root)
    assert (root / "thumbs" / "main" / "Background_001_001.webp").exists()
    assert (root / "thumbs" / "stills" / "Still_001_001.webp").exists()
    assert stats["written"] == 2


def test_build_skips_utility_entries(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    # Grid_001 is in meta.json's utility list; the picker omits those, so we do too.
    assert not (root / "thumbs" / "main" / "Grid_001.webp").exists()


def test_thumb_has_the_declared_size_and_stage_framing(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    with Image.open(root / "thumbs" / "main" / "Background_001_001.webp") as im:
        assert im.size == (THUMB_W, THUMB_H)
        assert im.format == "WEBP"


def test_rerun_is_a_noop_when_nothing_changed(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    stats = build(root)
    assert stats["written"] == 0
    assert stats["skipped"] == 2


def test_rerun_rebuilds_a_thumb_whose_source_is_newer(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    src = root / "main" / "Background_001_001.png"
    thumb = root / "thumbs" / "main" / "Background_001_001.webp"
    future = thumb.stat().st_mtime + 10
    os.utime(src, (future, future))
    stats = build(root)
    assert stats["written"] == 1
    assert stats["skipped"] == 1


def test_build_prunes_thumbs_whose_source_is_gone(tmp_path):
    root = _fixture_root(tmp_path)
    build(root)
    orphan = root / "thumbs" / "main" / "Background_999_999.webp"
    orphan.write_bytes(b"stale")
    stats = build(root)
    assert not orphan.exists()
    assert stats["pruned"] == 1


def test_build_reports_missing_sources_without_crashing(tmp_path):
    root = _fixture_root(tmp_path)
    (root / "main" / "Background_001_001.png").unlink()
    stats = build(root)
    assert stats["missing"] == 1
    assert stats["written"] == 1        # the still still builds
