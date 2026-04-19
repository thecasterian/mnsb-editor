#!/usr/bin/env python3
"""Align a hi-res extracted sprite to its reference layer.

Usage:
    python align_layer.py <reference.png> <hires.png> <output.png> [--canvas WxH]

Steps:
    1. Compute scale from content bbox (alpha > 128) of both images
    2. Upscale reference content by that scale
    3. matchTemplate to find initial position
    4. Coarse-to-fine position tuning to maximize IoU

If --canvas is not given, it is computed from the reference canvas size * scale.
"""

import argparse
import sys
import numpy as np
import cv2
from PIL import Image
Image.MAX_IMAGE_PIXELS = None


def content_bbox(img, threshold=0):
    """Return (x1, y1, x2, y2) of non-transparent content."""
    alpha = img[:, :, 3]
    ys, xs = np.where(alpha > threshold)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def compute_scale(ref_img, hires_img, threshold=128):
    """Compute uniform scale from content bbox."""
    rb = content_bbox(ref_img, threshold=threshold)
    hb = content_bbox(hires_img, threshold=threshold)
    if rb is None or hb is None:
        return None
    ref_w, ref_h = rb[2] - rb[0], rb[3] - rb[1]
    hi_w, hi_h = hb[2] - hb[0], hb[3] - hb[1]
    sw = hi_w / ref_w
    sh = hi_h / ref_h
    return (sw + sh) / 2


def find_position(ref_alpha_scaled, content_alpha, ref_x_scaled, ref_y_scaled):
    """Use matchTemplate to find initial position of content within scaled reference."""
    rh, rw = ref_alpha_scaled.shape
    ch, cw = content_alpha.shape

    if cw <= rw and ch <= rh:
        result = cv2.matchTemplate(ref_alpha_scaled, content_alpha, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        return score, ref_x_scaled + loc[0], ref_y_scaled + loc[1]
    elif rw <= cw and rh <= ch:
        result = cv2.matchTemplate(content_alpha, ref_alpha_scaled, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        return score, ref_x_scaled - loc[0], ref_y_scaled - loc[1]
    else:
        pw = max(rw, cw) + 10
        ph = max(rh, ch) + 10
        padded = np.zeros((ph, pw), dtype=np.float32)
        padded[:rh, :rw] = ref_alpha_scaled
        result = cv2.matchTemplate(padded, content_alpha, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(result)
        return score, ref_x_scaled + loc[0], ref_y_scaled + loc[1]


def fine_tune(content_alpha_mask, ref_canvas_mask, base_x, base_y, canvas_w, canvas_h):
    """Coarse-to-fine position search to minimize mismatch."""
    ch, cw = content_alpha_mask.shape

    def eval_pos(px, py):
        ec = np.zeros((canvas_h, canvas_w), dtype=np.uint8)
        sy, sx = max(0, -py), max(0, -px)
        dy, dx = max(0, py), max(0, px)
        h2 = min(ch - sy, canvas_h - dy)
        w2 = min(cw - sx, canvas_w - dx)
        if h2 > 0 and w2 > 0:
            ec[dy:dy + h2, dx:dx + w2] = content_alpha_mask[sy:sy + h2, sx:sx + w2]
        return (ref_canvas_mask != ec).sum()

    best_dx, best_dy = 0, 0
    best_m = eval_pos(base_x, base_y)

    # Coarse: step 5, range +-50
    for ddx in range(-50, 51, 5):
        for ddy in range(-50, 51, 5):
            m = eval_pos(base_x + ddx, base_y + ddy)
            if m < best_m:
                best_m = m
                best_dx, best_dy = ddx, ddy

    # Fine: step 1, range +-5 around coarse
    cdx, cdy = best_dx, best_dy
    for ddx in range(cdx - 5, cdx + 6):
        for ddy in range(cdy - 5, cdy + 6):
            m = eval_pos(base_x + ddx, base_y + ddy)
            if m < best_m:
                best_m = m
                best_dx, best_dy = ddx, ddy

    return best_dx, best_dy, best_m


def align_layer(ref_path, hires_path, output_path, canvas_size=None, mask_threshold=0):
    ref_img = np.array(Image.open(ref_path))
    hires_img = np.array(Image.open(hires_path))

    # Step 1: Compute scale
    scale = compute_scale(ref_img, hires_img)
    if scale is None:
        # Retry with mask_threshold (for low-alpha sprites like blush)
        scale = compute_scale(ref_img, hires_img, threshold=mask_threshold)
    if scale is None:
        print("ERROR: empty content in reference or hi-res image", file=sys.stderr)
        return False

    ref_canvas_h, ref_canvas_w = ref_img.shape[:2]

    if canvas_size:
        canvas_w, canvas_h = canvas_size
    else:
        canvas_w = round(ref_canvas_w * scale)
        # Ensure canvas is tall enough for content
        hb = content_bbox(hires_img)
        rb = content_bbox(ref_img)
        place_y = round(rb[1] * scale)
        hi_h = hb[3] - hb[1]
        canvas_h = max(round(ref_canvas_h * scale), place_y + hi_h)

    # Step 2: Upscale reference content by scale
    rb = content_bbox(ref_img)
    ref_crop = ref_img[rb[1]:rb[3], rb[0]:rb[2]]
    rw, rh = ref_crop.shape[1], ref_crop.shape[0]
    nw, nh = round(rw * scale), round(rh * scale)
    ref_scaled_alpha = cv2.resize(ref_crop[:, :, 3].astype(np.float32), (nw, nh))
    if mask_threshold > 0:
        ref_scaled_alpha = (ref_scaled_alpha > mask_threshold).astype(np.float32) * 255
    ref_x_scaled = round(rb[0] * scale)
    ref_y_scaled = round(rb[1] * scale)

    # Hi-res content
    hb = content_bbox(hires_img)
    content = hires_img[hb[1]:hb[3], hb[0]:hb[2]]
    ch, cw = content.shape[:2]
    content_alpha = content[:, :, 3].astype(np.float32)
    if mask_threshold > 0:
        content_alpha = (content_alpha > mask_threshold).astype(np.float32) * 255

    # Step 3: matchTemplate for initial position
    score, place_x, place_y = find_position(
        ref_scaled_alpha, content_alpha, ref_x_scaled, ref_y_scaled)
    print(f"  Scale: {scale:.4f}")
    print(f"  Canvas: {canvas_w}x{canvas_h}")
    print(f"  Template score: {score:.4f}")
    print(f"  Initial position: ({place_x}, {place_y})")

    # Build reference canvas mask for fine-tuning
    ref_up = np.array(Image.fromarray(ref_img).resize((canvas_w, canvas_h), Image.NEAREST))
    ref_canvas_mask = (ref_up[:, :, 3] > mask_threshold).astype(np.uint8)
    content_alpha_mask = (content[:, :, 3] > mask_threshold).astype(np.uint8)

    # Step 4: Fine-tune position
    best_dx, best_dy, best_m = fine_tune(
        content_alpha_mask, ref_canvas_mask, place_x, place_y, canvas_w, canvas_h)

    final_x = place_x + best_dx
    final_y = place_y + best_dy
    print(f"  Fine-tune: ({best_dx:+d}, {best_dy:+d})")
    print(f"  Final position: ({final_x}, {final_y})")

    # Place content (unmodified) on canvas
    out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
    sy, sx = max(0, -final_y), max(0, -final_x)
    dy, dx = max(0, final_y), max(0, final_x)
    h2 = min(ch - sy, canvas_h - dy)
    w2 = min(cw - sx, canvas_w - dx)
    if h2 > 0 and w2 > 0:
        out[dy:dy + h2, dx:dx + w2] = content[sy:sy + h2, sx:sx + w2]
    Image.fromarray(out).save(output_path)

    # Report IoU
    em = out[:, :, 3] > mask_threshold
    rm = ref_canvas_mask > 0
    both = (rm & em).sum()
    ro = (rm & ~em).sum()
    eo = (~rm & em).sum()
    total = both + ro + eo
    iou = both / total if total > 0 else 0
    print(f"  IoU: {iou:.4f}")

    if iou < 0.99:
        print(f"  WARNING: IoU {iou:.4f} < 0.99 — shape difference too large for pixel-perfect alignment")

    return True


def main():
    parser = argparse.ArgumentParser(description="Align hi-res sprite to reference layer")
    parser.add_argument("reference", help="Reference layer PNG (full canvas with transparency)")
    parser.add_argument("hires", help="Hi-res extracted sprite PNG")
    parser.add_argument("output", help="Output PNG (hi-res placed on correct canvas)")
    parser.add_argument("--canvas", help="Canvas size WxH (default: auto from scale)", default=None)
    parser.add_argument("--threshold", help="Alpha threshold for mask comparison (default: 0)", type=int, default=0)
    args = parser.parse_args()

    canvas_size = None
    if args.canvas:
        w, h = args.canvas.split("x")
        canvas_size = (int(w), int(h))

    print(f"Aligning {args.hires} -> {args.output}")
    align_layer(args.reference, args.hires, args.output, canvas_size, args.threshold)


if __name__ == "__main__":
    main()
