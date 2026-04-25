#!/usr/bin/env python3
"""Shift a placed sprite's content on its canvas by (dx, dy) pixels.

Usage:
    python shift_layer.py <sprite.png> <dx> <dy> [-o output.png]

Positive dx moves right; positive dy moves down.
The canvas size is preserved. If content would move off-canvas it is clipped.
Overwrites the input file if -o is not given.
"""

import argparse
import sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def shift_sprite(img: np.ndarray, dx: int, dy: int) -> np.ndarray:
    h, w = img.shape[:2]
    out = np.zeros_like(img)

    src_y0 = max(0, -dy)
    src_y1 = min(h, h - dy)
    src_x0 = max(0, -dx)
    src_x1 = min(w, w - dx)
    if src_y0 >= src_y1 or src_x0 >= src_x1:
        return out  # fully off-canvas

    dst_y0 = src_y0 + dy
    dst_y1 = src_y1 + dy
    dst_x0 = src_x0 + dx
    dst_x1 = src_x1 + dx

    out[dst_y0:dst_y1, dst_x0:dst_x1] = img[src_y0:src_y1, src_x0:src_x1]
    return out


def content_bbox(img: np.ndarray):
    alpha = img[:, :, 3]
    ys, xs = np.where(alpha > 0)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def main():
    parser = argparse.ArgumentParser(description="Shift sprite content on canvas.")
    parser.add_argument("sprite", help="PNG to shift")
    parser.add_argument("dx", type=int, help="Horizontal offset in pixels (+ right)")
    parser.add_argument("dy", type=int, help="Vertical offset in pixels (+ down)")
    parser.add_argument("-o", "--output", help="Output path (default: overwrite input)")
    args = parser.parse_args()

    img = np.array(Image.open(args.sprite).convert("RGBA"))
    before = content_bbox(img)
    shifted = shift_sprite(img, args.dx, args.dy)
    after = content_bbox(shifted)

    out_path = args.output or args.sprite
    Image.fromarray(shifted).save(out_path)

    print(f"Canvas: {img.shape[1]}x{img.shape[0]}")
    print(f"Shift: dx={args.dx}, dy={args.dy}")
    if before is not None:
        print(f"Content bbox: {before[:2]} -> {after[:2] if after else 'off-canvas'}")
    print(f"Saved to {out_path}")


if __name__ == "__main__":
    main()
