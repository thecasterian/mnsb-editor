#!/usr/bin/env python3
"""Determine canvas size from a hi-res Body extraction and its reference.

Usage:
    python canvas_size.py <reference_body.png> <hires_body.png>

Computes scale from content bbox (alpha > 128) and prints the canvas size.
"""

import sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <reference_body.png> <hires_body.png>")
        sys.exit(1)

    ref = np.array(Image.open(sys.argv[1]))
    raw = np.array(Image.open(sys.argv[2]))

    ref_h, ref_w = ref.shape[:2]

    ra = ref[:, :, 3]
    ea = raw[:, :, 3]

    for label, thresh in [("alpha>128", 128), ("alpha>0", 0)]:
        rys, rxs = np.where(ra > thresh)
        eys, exs = np.where(ea > thresh)
        if len(rxs) == 0 or len(exs) == 0:
            print(f"{label}: empty content, skipping")
            continue
        rw = int(rxs.max()) - int(rxs.min()) + 1
        rh = int(rys.max()) - int(rys.min()) + 1
        ew = int(exs.max()) - int(exs.min()) + 1
        eh = int(eys.max()) - int(eys.min()) + 1
        sw = ew / rw
        sh = eh / rh
        avg = (sw + sh) / 2
        diff = abs(sw - sh) / avg * 100
        print(f"{label}:")
        print(f"  Ref content:    {rw}x{rh}")
        print(f"  Hi-res content: {ew}x{eh}")
        print(f"  Scale W={sw:.4f}  H={sh:.4f}  avg={avg:.4f}  diff={diff:.1f}%")
        print(f"  Canvas: {round(ref_w * avg)}x{round(ref_h * avg)}")
        if diff > 5:
            print(f"  WARNING: axes differ by {diff:.1f}% — extraction may include extra content")
        print()


if __name__ == "__main__":
    main()
