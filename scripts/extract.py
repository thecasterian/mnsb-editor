import cv2
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None  # disable decompression bomb check
from scipy import ndimage
import os, json
from multiprocessing import Pool, cpu_count
from concurrent.futures import ThreadPoolExecutor

ref_base = "/home/jeongu/Documents/git/manosaba_editor/_ref"
sprite_dir = "/home/jeongu/Documents/git/manosaba_editor/Angle01"
out_base = "/home/jeongu/Documents/git/manosaba_editor/characters"

sprite_files = {
    "Alisa": "Alisa_Angle01.png",
    "AnAn": "AnAn_Angle01.png",
    "Coco": "Coco_Angle01.png",
    "Ema": "Ema_Angle01.png",
    "Hanna": "Hanna_Angle01.png",
    "Hiro": "002_Hiro_Angle01.png",
    "Leia": "Leia_Angle01.png",
    "Margo": "Margo_Angle01.png",
    "Meruru": "003_Meruru_Angle01.png",
    "Miria": "Miria_Angle01.png",
    "Nanoka": "012_Nanoka_Angle01.png",
    "Noah": "Noah_Angle01.png",
}

def extract_character(char):
    try:
        return _extract(char)
    except Exception as e:
        import traceback
        return f"{char}: ERROR - {e}\n{traceback.format_exc()}"

def _extract(char):
    ref_dir = f"{ref_base}/{char}"
    sprite_path = f"{sprite_dir}/{sprite_files[char]}"
    out_dir = f"{out_base}/{char}"
    os.makedirs(out_dir, exist_ok=True)

    sprite_full = np.array(Image.open(sprite_path))
    sprite_alpha = sprite_full[:, :, 3].astype(np.float32)

    with open(f"{ref_dir}/info.txt") as f:
        lines = [l.strip() for l in f if l.strip()]

    # Parse all layers and load reference images
    all_layers = []
    for line in lines:
        parts = line.split(':')
        if len(parts) != 3:
            continue
        group, name, order = parts
        path = f"{ref_dir}/{group}/{name}.png"
        if not os.path.exists(path):
            all_layers.append({'name': name, 'group': group, 'order': int(order), 'empty': True})
            continue
        ref = np.array(Image.open(path))
        ref_canvas_h, ref_canvas_w = ref.shape[:2]
        alpha = ref[:, :, 3]
        ys, xs = np.where(alpha > 0)
        if len(xs) == 0:
            all_layers.append({'name': name, 'group': group, 'order': int(order), 'empty': True, 'ref_canvas': (ref_canvas_w, ref_canvas_h)})
            continue
        rbbox = (int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1)
        rw, rh = rbbox[2]-rbbox[0], rbbox[3]-rbbox[1]
        all_layers.append({
            'name': name, 'group': group, 'order': int(order), 'empty': False,
            'ref_bbox': rbbox, 'ref_w': rw, 'ref_h': rh, 'ref_pixels': len(xs),
            'ref_canvas': (ref_canvas_w, ref_canvas_h),
        })

    # Get ref canvas size
    ref_canvas = None
    for l in all_layers:
        if 'ref_canvas' in l:
            ref_canvas = l['ref_canvas']
            break
    if ref_canvas is None:
        return f"{char}: No layers!"
    rcw, rch = ref_canvas

    # Detect scale: find largest ref layer (Body) and largest sprite region, compare bbox
    largest_ref = max([l for l in all_layers if not l.get('empty')], key=lambda l: l['ref_pixels'])

    mask = sprite_full[:, :, 3] > 0
    labeled, n = ndimage.label(mask)
    regions = []
    for i in range(1, n + 1):
        ys, xs = np.where(labeled == i)
        if len(xs) < 50:
            continue
        bbox = (int(xs.min()), int(ys.min()), int(xs.max())+1, int(ys.max())+1)
        regions.append({'id': i, 'bbox': bbox, 'w': bbox[2]-bbox[0], 'h': bbox[3]-bbox[1], 'pixels': len(xs)})

    largest_sprite = max(regions, key=lambda r: r['pixels'])

    # Scale = sprite body size / ref body size
    char_scale = ((largest_sprite['w'] / largest_ref['ref_w']) + (largest_sprite['h'] / largest_ref['ref_h'])) / 2
    canvas_w = round(rcw * char_scale)
    canvas_h = round(rch * char_scale)

    for l in all_layers:
        if not l.get('empty') and 'ref_w' in l:
            l['expected_w'] = round(l['ref_w'] * char_scale)
            l['expected_h'] = round(l['ref_h'] * char_scale)

    # Phase 1: Size-based matching with RGB + IoU verification
    matched = {}
    used_regions = set()
    for layer in sorted([l for l in all_layers if not l.get('empty')], key=lambda l: l.get('ref_pixels', 0), reverse=True):
        ew, eh = layer.get('expected_w', 0), layer.get('expected_h', 0)
        if ew == 0 or eh == 0:
            continue
        # Collect size-matched candidates
        candidates = []
        for region in regions:
            if region['id'] in used_regions:
                continue
            w_ratio = region['w'] / ew
            h_ratio = region['h'] / eh
            if not (0.8 < w_ratio < 1.2 and 0.8 < h_ratio < 1.2):
                continue
            px_ratio = region['pixels'] / (layer['ref_pixels'] * char_scale * char_scale)
            if not (0.7 < px_ratio < 1.3):
                continue
            size_score = 1.0 - (abs(w_ratio - 1) + abs(h_ratio - 1)) / 2
            candidates.append((region, size_score))
        # RGB + shape verify each candidate against the reference
        ref_path = f"{ref_dir}/{layer['group']}/{layer['name']}.png"
        ref_img = np.array(Image.open(ref_path))
        rb = layer['ref_bbox']
        ref_crop = ref_img[rb[1]:rb[3], rb[0]:rb[2]]
        rh_c, rw_c = ref_crop.shape[:2]
        ref_mask = ref_crop[:, :, 3] > 0
        best_region, best_quality = None, 999
        for region, size_score in sorted(candidates, key=lambda c: c[1], reverse=True):
            sb = region['bbox']
            sprite_region = sprite_full[sb[1]:sb[3], sb[0]:sb[2]]
            region_ds = cv2.resize(sprite_region, (rw_c, rh_c), interpolation=cv2.INTER_AREA)
            overlap = ref_mask & (region_ds[:, :, 3] > 0)
            if not overlap.any():
                continue
            diff = np.abs(region_ds[:,:,:3].astype(float) - ref_crop[:,:,:3].astype(float))[overlap].mean()
            if diff >= 30:
                continue
            # Shape verification: reject if shapes don't match
            ref_a = ref_mask.astype(float)
            ext_a = (region_ds[:, :, 3] > 0).astype(float)
            iou = (ref_a * ext_a).sum() / np.maximum(ref_a, ext_a).sum()
            if iou < 0.75:
                continue
            # Combined quality: lower is better
            quality = diff / 30 + (1 - iou)
            if quality < best_quality:
                best_quality = quality
                best_region = region
        if best_region and best_quality < 999:
            matched[layer['name']] = {'sprite_bbox': best_region['bbox'], 'ref_bbox': layer['ref_bbox'],
                                      'expected_size': (layer['expected_w'], layer['expected_h'])}
            used_regions.add(best_region['id'])

    size_matched = len(matched)

    # Phase 2: Template matching for remaining
    unmatched = [l for l in all_layers if not l.get('empty') and l['name'] not in matched]
    for layer in unmatched:
        path = f"{ref_dir}/{layer['group']}/{layer['name']}.png"
        ref = np.array(Image.open(path))
        alpha = ref[:, :, 3]
        ys, xs = np.where(alpha > 0)
        if len(xs) == 0:
            continue
        x1, y1, x2, y2 = xs.min(), ys.min(), xs.max()+1, ys.max()+1
        ref_crop = ref[y1:y2, x1:x2]
        rh, rw = ref_crop.shape[:2]
        new_w, new_h = round(rw * char_scale), round(rh * char_scale)
        if new_w < 3 or new_h < 3:
            continue
        tmpl_alpha = cv2.resize(ref_crop[:,:,3].astype(np.float32), (new_w, new_h))
        if tmpl_alpha.shape[0] > sprite_alpha.shape[0] or tmpl_alpha.shape[1] > sprite_alpha.shape[1]:
            continue
        result = cv2.matchTemplate(sprite_alpha, tmpl_alpha, cv2.TM_CCOEFF_NORMED)
        temp_result = result.copy()
        candidates = []
        for _ in range(10):
            _, max_val, _, max_loc = cv2.minMaxLoc(temp_result)
            if max_val < 0.8:
                break
            candidates.append((max_loc, max_val))
            mx, my = max_loc
            yl, yh = max(0, my-new_h//2), min(temp_result.shape[0], my+new_h//2)
            xl, xh = max(0, mx-new_w//2), min(temp_result.shape[1], mx+new_w//2)
            temp_result[yl:yh, xl:xh] = -1

        best_match, best_diff = None, 999
        for (sx, sy), aconf in candidates:
            if sy+new_h > sprite_full.shape[0] or sx+new_w > sprite_full.shape[1]:
                continue
            region = sprite_full[sy:sy+new_h, sx:sx+new_w]
            region_ds = cv2.resize(region, (rw, rh), interpolation=cv2.INTER_AREA)
            rmask = ref_crop[:, :, 3] > 0
            if not rmask.any():
                continue
            diff = np.abs(region_ds[:,:,:3].astype(float) - ref_crop[:,:,:3].astype(float))[rmask].mean()
            if diff < best_diff:
                best_diff = diff
                best_match = (int(sx), int(sy), int(sx+new_w), int(sy+new_h))

        if best_match and best_diff < 30:
            matched[layer['name']] = {'sprite_bbox': best_match, 'ref_bbox': (int(x1), int(y1), int(x2), int(y2))}

    tmpl_matched = len(matched) - size_matched

    # Phase 3: Extract (parallelized per layer)
    total_nonempty = sum(1 for l in all_layers if not l.get('empty'))

    def _tmpl_match_at_char_scale(ref_crop_alpha, rw, rh):
        """Template match at char_scale. Returns (score, loc, size) or (-1, None, None)."""
        tw, th = round(rw * char_scale), round(rh * char_scale)
        if tw < 3 or th < 3: return -1, None, None
        if th > sprite_alpha.shape[0] or tw > sprite_alpha.shape[1]: return -1, None, None
        tmpl = cv2.resize(ref_crop_alpha, (tw, th))
        res = cv2.matchTemplate(sprite_alpha, tmpl, cv2.TM_CCOEFF_NORMED)
        _, val, _, loc = cv2.minMaxLoc(res)
        return val, loc, (tw, th)

    def _extract_layer(layer):
        """Extract a single layer. Returns 'matched', 'fallback', or 'skip'."""
        name = layer['name']
        if layer.get('empty'):
            return 'skip'
        # Load reference for all paths
        ref_img = np.array(Image.open(f"{ref_dir}/{layer['group']}/{name}.png"))
        ref_alpha = ref_img[:, :, 3]
        ref_ys, ref_xs = np.where(ref_alpha > 0)
        if len(ref_xs) == 0:
            return 'fallback'
        rb = (int(ref_xs.min()), int(ref_ys.min()), int(ref_xs.max())+1, int(ref_ys.max())+1)
        if name not in matched:
            # Try template-based extraction for unmatched layers
            rw_t = rb[2] - rb[0]
            rh_t = rb[3] - rb[1]
            ref_crop_t = ref_img[rb[1]:rb[3], rb[0]:rb[2]]
            if rw_t >= 3 and rh_t >= 3:
                best_score, best_loc, best_size = _tmpl_match_at_char_scale(
                    ref_crop_t[:,:,3].astype(np.float32), rw_t, rh_t)
                if best_score > 0.7 and best_loc is not None:
                    tx, ty = best_loc
                    tw, th = best_size
                    sprite_region = sprite_full[ty:ty+th, tx:tx+tw]
                    canvas_out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
                    cx = round(rb[0] * char_scale)
                    cy = round(rb[1] * char_scale)
                    ph = min(th, canvas_h - cy)
                    pw = min(tw, canvas_w - cx)
                    if ph > 0 and pw > 0:
                        canvas_out[cy:cy+ph, cx:cx+pw] = sprite_region[:ph, :pw]
                    Image.fromarray(canvas_out).save(f"{out_dir}/{name}.png")
                    return 'matched'
            # True fallback: upscale reference crop
            ref_crop_fb = ref_img[rb[1]:rb[3], rb[0]:rb[2]]
            new_cw = round((rb[2] - rb[0]) * char_scale)
            new_ch = round((rb[3] - rb[1]) * char_scale)
            crop_up = np.array(Image.fromarray(ref_crop_fb).resize((new_cw, new_ch), Image.LANCZOS))
            canvas_fb = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
            fb_cx = round(rb[0] * char_scale)
            fb_cy = round(rb[1] * char_scale)
            fb_ph = min(new_ch, canvas_h - fb_cy)
            fb_pw = min(new_cw, canvas_w - fb_cx)
            if fb_ph > 0 and fb_pw > 0:
                canvas_fb[fb_cy:fb_cy+fb_ph, fb_cx:fb_cx+fb_pw] = crop_up[:fb_ph, :fb_pw]
            Image.fromarray(canvas_fb).save(f"{out_dir}/{name}.png")
            return 'fallback'
        m = matched[name]
        rb = m['ref_bbox']
        rw_t = rb[2] - rb[0]
        rh_t = rb[3] - rb[1]
        ref_crop_t = ref_img[rb[1]:rb[3], rb[0]:rb[2]]
        # Template match at char_scale for precise extraction
        best_score, best_loc, best_size = _tmpl_match_at_char_scale(
            ref_crop_t[:,:,3].astype(np.float32), rw_t, rh_t)
        if best_score > 0.7 and best_loc is not None:
            tx, ty = best_loc
            tw, th = best_size
            sprite_region = sprite_full[ty:ty+th, tx:tx+tw]
        else:
            sb = m['sprite_bbox']
            sprite_region = sprite_full[sb[1]:sb[3], sb[0]:sb[2]]
        canvas_w_t = round(rw_t * char_scale)
        canvas_h_t = round(rh_t * char_scale)
        canvas_out = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
        cx = round(rb[0] * char_scale)
        cy = round(rb[1] * char_scale)
        rh_a, rw_a = sprite_region.shape[:2]
        ph = min(rh_a, canvas_h - cy)
        pw = min(rw_a, canvas_w - cx)
        if ph > 0 and pw > 0:
            canvas_out[cy:cy+ph, cx:cx+pw] = sprite_region[:ph, :pw]
        Image.fromarray(canvas_out).save(f"{out_dir}/{name}.png")
        return 'matched'

    nonempty_layers = [l for l in all_layers if not l.get('empty')]
    with ThreadPoolExecutor(max_workers=min(cpu_count(), len(nonempty_layers))) as executor:
        results_ph3 = list(executor.map(_extract_layer, nonempty_layers))
    fallback_count = results_ph3.count('fallback')
    fallback_names = [l['name'] for l, r in zip(nonempty_layers, results_ph3) if r == 'fallback']

    meta = {'canvas_size': [canvas_w, canvas_h], 'scale': round(char_scale, 4), 'layers': []}
    for layer in all_layers:
        meta['layers'].append({'name': layer['name'], 'group': layer['group'], 'order': layer['order'], 'empty': layer.get('empty', False)})
    with open(f"{out_dir}/layers.json", 'w') as f:
        json.dump(meta, f, indent=2)

    summary = f"{char}: scale={char_scale:.3f} size={size_matched} tmpl={tmpl_matched} fallback={fallback_count} matched={len(matched)}/{total_nonempty} canvas={canvas_w}x{canvas_h}"
    if fallback_names:
        summary += f"\n  Fallback layers: {', '.join(fallback_names)}"
    return summary

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        chars = sys.argv[1:]
    else:
        chars = list(sprite_files.keys())
    workers = min(len(chars), cpu_count())
    print(f"Extracting {len(chars)} characters with {workers} workers...")
    with Pool(workers) as pool:
        results = pool.map(extract_character, chars)
    for r in results:
        print(r)
    print("\nAll done!")
