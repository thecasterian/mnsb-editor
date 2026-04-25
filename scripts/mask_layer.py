#!/usr/bin/env python3
"""Carve a sprite's alpha by another sprite (used as a mask).

Usage:
    python mask_layer.py <sprite.png> <mask.png> [-o output.png]
                         [--invert] [--binary] [--threshold N] [--strength F]

The mask's alpha channel multiplies the sprite's alpha:
    sprite.alpha *= (1 - mask.alpha/255 * strength)   (with --invert, default)
    sprite.alpha *=      mask.alpha/255 * strength    (without --invert)

Flags:
    --invert       Carve OUT where the mask is opaque (default).
                   Drop --invert to keep ONLY where the mask is opaque.
    --binary       Treat the mask as binary: alpha > threshold -> 1, else 0.
    --threshold N  Alpha threshold for --binary (default: 0).
    --strength F   Multiplier for the mask's effect (default: 1.0).
    --dilate N     Grow the mask by N pixels (Chebyshev/8-connected) before
                   carving — extends the carved region.
    --erode  N     Shrink the mask by N pixels before carving — leaves an
                   N-pixel margin between the mask edge and the carve.

Sprite and mask must have the same width. If their heights differ by 1px the
mask is auto-cropped/padded to match — common when characters were processed
at slightly different reference sizes. Larger mismatches abort.

Overwrites the input file if -o is not given.
"""

import argparse
import sys
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def align_sizes(sprite: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Return mask resized to match sprite's HxW. Allow 1px height mismatch."""
    sh, sw = sprite.shape[:2]
    mh, mw = mask.shape[:2]
    if (sh, sw) == (mh, mw):
        return mask
    if sw != mw or abs(sh - mh) > 1:
        sys.exit(f"Size mismatch: sprite {sw}x{sh}, mask {mw}x{mh}")
    if mh > sh:
        return mask[:sh]
    pad = np.zeros((sh - mh, sw, 4), dtype=mask.dtype)
    return np.vstack([mask, pad])


def morph(alpha: np.ndarray, radius: int, grow: bool) -> np.ndarray:
    """Grayscale morphology with an 8-connected square kernel.

    grow=True  -> dilation  (windowed max), expands nonzero region.
    grow=False -> erosion   (windowed min), shrinks nonzero region.

    Uses windowed reductions along each axis — no SciPy dependency. For a
    radius-N kernel this takes the per-axis max/min over a (2N+1) window,
    centered on each pixel.
    """
    if radius <= 0:
        return alpha
    reduce = np.maximum if grow else np.minimum
    fill = 0 if grow else 255
    a = alpha
    for axis in (0, 1):
        n = a.shape[axis]
        out = np.full_like(a, fill)
        for k in range(-radius, radius + 1):
            src_lo, src_hi = max(0, -k), min(n, n - k)
            dst_lo, dst_hi = src_lo + k, src_hi + k
            if axis == 0:
                reduce(out[dst_lo:dst_hi], a[src_lo:src_hi], out=out[dst_lo:dst_hi])
            else:
                reduce(out[:, dst_lo:dst_hi], a[:, src_lo:src_hi], out=out[:, dst_lo:dst_hi])
        a = out
    return a


def carve(sprite: np.ndarray, mask_alpha: np.ndarray,
          invert: bool, strength: float) -> np.ndarray:
    out = sprite.copy()
    m = mask_alpha.astype(np.float32) / 255.0 * strength
    np.clip(m, 0.0, 1.0, out=m)
    factor = (1.0 - m) if invert else m
    out[..., 3] = np.clip(sprite[..., 3].astype(np.float32) * factor, 0, 255).astype(np.uint8)
    return out


def main():
    parser = argparse.ArgumentParser(description="Carve sprite alpha by a mask.")
    parser.add_argument("sprite", help="PNG to carve")
    parser.add_argument("mask", help="PNG whose alpha is the mask")
    parser.add_argument("-o", "--output", help="Output path (default: overwrite sprite)")
    parser.add_argument("--invert", action="store_true", default=True,
                        help="Carve OUT where mask is opaque (default)")
    parser.add_argument("--no-invert", dest="invert", action="store_false",
                        help="Keep ONLY where mask is opaque")
    parser.add_argument("--binary", action="store_true",
                        help="Treat mask as binary (alpha > threshold)")
    parser.add_argument("--threshold", type=int, default=0,
                        help="Alpha threshold for --binary (default: 0)")
    parser.add_argument("--strength", type=float, default=1.0,
                        help="Multiplier for the mask's effect (default: 1.0)")
    parser.add_argument("--dilate", type=int, default=0,
                        help="Grow mask by N pixels before carving (default: 0)")
    parser.add_argument("--erode", type=int, default=0,
                        help="Shrink mask by N pixels before carving (default: 0)")
    args = parser.parse_args()
    if args.dilate and args.erode:
        sys.exit("--dilate and --erode are mutually exclusive")

    sprite = np.array(Image.open(args.sprite).convert("RGBA"))
    mask = np.array(Image.open(args.mask).convert("RGBA"))
    mask = align_sizes(sprite, mask)
    mask_alpha = mask[..., 3]
    if args.binary:
        mask_alpha = np.where(mask_alpha > args.threshold, 255, 0).astype(np.uint8)
    if args.dilate > 0:
        mask_alpha = morph(mask_alpha, args.dilate, grow=True)
    elif args.erode > 0:
        mask_alpha = morph(mask_alpha, args.erode, grow=False)

    before = int((sprite[..., 3] > 0).sum())
    out = carve(sprite, mask_alpha, args.invert, args.strength)
    after = int((out[..., 3] > 0).sum())

    out_path = args.output or args.sprite
    Image.fromarray(out).save(out_path)

    print(f"Sprite: {args.sprite}  ({sprite.shape[1]}x{sprite.shape[0]})")
    print(f"Mask:   {args.mask}")
    mode = "carve OUT" if args.invert else "keep ONLY"
    binary = " (binary)" if args.binary else ""
    print(f"Mode: {mode}{binary}, strength={args.strength}")
    print(f"Opaque pixels: {before} -> {after} ({before - after} removed)")
    print(f"Saved to {out_path}")


if __name__ == "__main__":
    main()
