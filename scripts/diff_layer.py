#!/usr/bin/env python3
"""Show red/green difference between reference and hi-res aligned layer.

Usage:
    python diff_layer.py <reference.png> <aligned.png> [--canvas WxH] [-o output.png]

Colors:
    Gray  = overlap (both reference and hi-res)
    Red   = reference only (missing in hi-res)
    Green = hi-res only (extra content)
"""

import argparse
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None


def diff_layer(ref_path, aligned_path, canvas_size=None, output_path=None, threshold=0):
    ref = np.array(Image.open(ref_path))
    aligned = np.array(Image.open(aligned_path))

    if canvas_size:
        canvas_w, canvas_h = canvas_size
    else:
        canvas_w, canvas_h = aligned.shape[1], aligned.shape[0]

    # Upscale reference to canvas size
    ref_up = np.array(Image.fromarray(ref).resize((canvas_w, canvas_h), Image.NEAREST))

    ref_mask = ref_up[:, :, 3] > threshold
    hi_mask = aligned[:, :, 3] > threshold

    # Find bounding box of union
    union = ref_mask | hi_mask
    ys, xs = np.where(union)
    if len(xs) == 0:
        print("No content in either image")
        return

    pad = 20
    x1 = max(0, int(xs.min()) - pad)
    y1 = max(0, int(ys.min()) - pad)
    x2 = min(canvas_w, int(xs.max()) + 1 + pad)
    y2 = min(canvas_h, int(ys.max()) + 1 + pad)

    ref_crop = ref_mask[y1:y2, x1:x2]
    hi_crop = hi_mask[y1:y2, x1:x2]

    both = ref_crop & hi_crop
    ref_only = ref_crop & ~hi_crop
    hi_only = ~ref_crop & hi_crop

    h, w = ref_crop.shape
    diff = np.zeros((h, w, 3), dtype=np.uint8)
    diff[both] = [128, 128, 128]
    diff[ref_only] = [255, 0, 0]
    diff[hi_only] = [0, 255, 0]

    # Scale up for visibility
    scale = max(1, min(800 // max(w, 1), 800 // max(h, 1)))
    diff_img = Image.fromarray(diff).resize((w * scale, h * scale), Image.NEAREST)

    if output_path is None:
        output_path = "/tmp/diff_layer.png"
    diff_img.save(output_path)

    total = both.sum() + ref_only.sum() + hi_only.sum()
    iou = both.sum() / total if total > 0 else 0

    print(f"Region: ({x1},{y1})-({x2},{y2})")
    print(f"Overlap (gray): {both.sum()}")
    print(f"Ref only (red): {ref_only.sum()}")
    print(f"Hi-res only (green): {hi_only.sum()}")
    print(f"IoU: {iou:.4f}")
    print(f"Saved {output_path} ({w * scale}x{h * scale}, {scale}x zoom)")


def main():
    parser = argparse.ArgumentParser(description="Show red/green difference between reference and aligned layer")
    parser.add_argument("reference", help="Reference layer PNG")
    parser.add_argument("aligned", help="Aligned hi-res layer PNG")
    parser.add_argument("--canvas", help="Canvas size WxH (default: use aligned image size)", default=None)
    parser.add_argument("-o", "--output", help="Output path (default: /tmp/diff_layer.png)", default=None)
    parser.add_argument("--threshold", help="Alpha threshold for mask comparison (default: 0)", type=int, default=0)
    args = parser.parse_args()

    canvas_size = None
    if args.canvas:
        w, h = args.canvas.split("x")
        canvas_size = (int(w), int(h))

    diff_layer(args.reference, args.aligned, canvas_size, args.output, args.threshold)


if __name__ == "__main__":
    main()
