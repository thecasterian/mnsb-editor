#!/usr/bin/env python3
"""Render the 4 courtroom-stage geometries (no textures) from a runtime-faithful camera.

Geometry (matches Court.prefab / Court_Final.prefab — see docs/court_geometry.md):
  1. Floor       — single quad, 61 × 61 m at y = 0
  2. Walls       — full cylindrical drum, radius 30 m, height 15 m, y in [-3.3, 11.7]
  3. Step        — central capped cylindrical podium, 24 m radius × 2 m tall, y in [-1, +1]
  4. Stand quads — N camera-facing lectern quads on the 14.8 m ring at y = 2.4 m

Plus character placement markers (N filled circles at the runtime ring: radius 16, y = 5).
The target stand's marker is rendered in a distinct colour.

Camera matches the Naninovel runtime (System_Subroutine + .ModifyCamera-* presets):
  yaw_deg  = (target_idx + composition) * 360 / N
  pos      = (-D*sin(yaw), H, -D*cos(yaw))
  forward  = (sin(yaw), 0, cos(yaw))      # pitch=0, horizontal look
  fov_v    = 30 deg                        # vertical
  output   = 2560 x 1440

Renderer: pure numpy + PIL software rasteriser.
  - perspective projection -> NDC -> pixel space
  - z-buffered raster with perspective-correct depth + UV interpolation
  - per-face shading model faithful to Court_Final.prefab + Boot.unity:
    one straight-down spot light + hemisphere ambient (sky/equator/ground), both
    keyed on the world-up component of the face normal. Backdrop wall opts out
    of shading because its highlights/shadows are baked into the painted texture.
"""

import argparse
import math
import re
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


# --- Runtime camera library (from naninovel-scripts_assets-naninovelscripts-system.bundle) ---
ZOOM_LEVELS = {1: (10.0, 5.2), 2: (11.0, 5.3), 3: (12.0, 5.5), 4: (13.0, 5.6)}
COMPOSITIONS = {"center": 0.0, "left": +0.1, "right": -0.1}
ROLL_PRESETS = {"none": 0.0, "right": +5.0, "left": -5.0}     # standard System_Subroutine values

# Physical Camera params from CameraContainer.prefab (the Camera component
# that's actually rendered in-game; legacy `field of view: 30` is ignored
# because m_projectionMatrixMode: 1 = Physical mode is on).
SENSOR_W_MM     = 36.0       # m_SensorSize.x — full-frame 35mm sensor
SENSOR_H_MM     = 24.0       # m_SensorSize.y
FOCAL_LENGTH_MM = 68.05538   # m_FocalLength
# m_GateFitMode: 2 = Fill. m_FOVAxisMode: 0 = Vertical.

WIDTH, HEIGHT = 2560, 1440
NEAR, FAR = 0.5, 200.0


def physical_camera_vfov_deg(width_px=WIDTH, height_px=HEIGHT):
    """Effective vertical FOV (degrees) under Unity's Physical Camera + Fill gate
    fit, matching the in-game CameraContainer setup.

    Sensor's natural vFOV = 2·atan(sensor.h / (2·focal)) = 20°.
    With Fill mode and a screen aspect WIDER than the gate (our 16:9 vs 3:2),
    the gate is enlarged to match screen width and the vertical extent is
    cropped — effective vertical sensor extent = sensor.h · (gate_aspect /
    screen_aspect), giving a SMALLER vFOV than the sensor alone.

    Result for 2560×1440: ≈ 16.93°.

    NOTE: NOT actually used. Kept for reference. The runtime overrides Physical
    Camera mode by writing `Camera.fieldOfView = 30` directly, so the legacy
    field-of-view value wins. Verified against in-game screenshot of
    Act01_Chapter01_Trial00. See `FOV_DEG_VERTICAL` below."""
    sensor_aspect = SENSOR_W_MM / SENSOR_H_MM
    screen_aspect = width_px / height_px
    if screen_aspect > sensor_aspect:
        # Wider screen than gate → fill width, crop height
        effective_h_mm = SENSOR_H_MM * (sensor_aspect / screen_aspect)
    else:
        # Taller screen than gate → fill height, crop width (vFOV unchanged)
        effective_h_mm = SENSOR_H_MM
    return 2.0 * math.degrees(math.atan(effective_h_mm / 2.0 / FOCAL_LENGTH_MM))


# Legacy `field of view: 30` value from CameraContainer.prefab. The prefab
# sets `m_projectionMatrixMode: 1` (Physical Camera mode), but the runtime
# overrides this — Camera.fieldOfView is set to 30 imperatively, switching
# the camera back into legacy mode. Verified against in-game screenshot of
# Act01_Chapter01_Trial00 (Meruru↔Ema midpoint shot at D=4, H=5).
FOV_DEG_VERTICAL = 30.0

# Per-trial character -> stand index. The two reference trials used by
# `--look-character` to resolve a character name into the right idx.
# Court (13 stands)      : Act01_Chapter01_TrialInit (the first court trial of the game)
# Court_Final (14 stands): Act02_Chapter06_TrialInit (only trial that loads CourtFinal)
CHAR_IDX_COURT = {
    "ema": 0, "hiro": -1, "meruru": 12, "hanna": 1, "sherry": 2, "anan": 11,
    "leia": 3, "coco": 5, "miria": 6, "margo": 9, "noah": -1, "nanoka": 10,
    "alisa": 4, "yuki": -1, "warden": -1, "jailer": -1,
}
CHAR_IDX_COURT_FINAL = {
    "ema": 0, "hanna": 1, "sherry": 2, "leia": 3, "alisa": 4, "coco": 5,
    "miria": 6, "noah": 7, "hiro": 8, "margo": 9, "nanoka": 10, "anan": 11,
    "meruru": 12, "yuki": 13, "warden": -1, "jailer": -1,
}

# --- Geometry constants (from Court / Court_Final prefab) ---
WALL_RADIUS = 30.0
WALL_HEIGHT = 15.0
WALL_Y_CENTER = 4.2
FLOOR_HALF = 30.5
STEP_HALF = 24.0
STEP_Y0, STEP_Y1 = -1.0, +1.0
STAND_RADIUS = 14.8
STAND_Y = 2.4
STAND_W, STAND_H = 3.4, 2.8

# --- Character placement (from System_Subroutine.BeginTrial) ---
CHAR_RADIUS = 16.0           # characterDistance
CHAR_Y = 5.0                 # stageOffsetY (=0) + 5

# --- Render colours ---
BG_COLOR = (18, 18, 22)

# Solid colours used when --backdrop / per-mesh texture is disabled.
COLOR_FLOOR = (110, 60, 60)      # dark red carpet
COLOR_WALLS = (155, 145, 130)    # warm grey
COLOR_STEP  = (90, 65, 55)       # dark brown
COLOR_STAND = (165, 95, 55)      # mahogany lectern

# Material tints (multiplied into the per-pixel texture sample). These match the
# `_BaseColor` values in each .mat file (rgba 0..1, scaled to 0..255).
TINT_FLOOR = (106, 41, 41)       # Court_Floor.mat  rgba(0.415, 0.159, 0.159, 1)
TINT_WALLS = (255, 255, 255)     # Court_Wall*.mat  rgba(1, 1, 1, 1)
TINT_STEP  = ( 55, 34, 32)       # Court_Step.mat   rgba(0.217, 0.134, 0.124, 1)
TINT_STAND = (255, 255, 255)     # Court_Stand.mat  rgba(1, 1, 1, 1)

COLOR_MARKER = (235, 90, 90)
COLOR_MARKER_TARGET = (255, 215, 70)
COLOR_MARKER_OUTLINE = (255, 255, 255)

# --- Lighting (faithful to Court_Final.prefab + Boot.unity) ---
# Single SpotLight under Court(_Final)/Lighting/SpotLight, computed PER-PIXEL
# in world space:
#   pos = (0, 30, 0)               world position (above courtroom centre)
#   dir = (0, -1, 0)               pointing straight DOWN (rot = R_x(90°))
#   color = (1, 1, 1, 1)           white (runtime override (1.0, 0.4, 0.2) when fire)
#   range = 90 m, outer cone = 140°, inner cone = 90°
#   intensity = 2000 lumens (URP physical units)
#
# Each lit pixel computes:
#   L_vec = LIGHT_POS - pixel_world_pos
#   d     = ||L_vec||                                (distance to light)
#   L     = L_vec / d                                (unit vector toward light)
#   Lambert     = max(0, N · L)
#   cone_factor = smoothstep(cos(outer/2), cos(inner/2), -L · light_dir) = smoothstep(...,L.y)
#                                                    (since light_dir = -Y, dot(-L,light_dir) = L.y)
#   distance_atten = 1 / (1 + (d / FALLOFF_K)²)      (single-knob; tunes how fast it falls)
#                  · smoothstep(range, 0.8·range, d) (smooth cutoff at range)
#   direct_rgb  = Lambert · cone · atten · LIGHT_RGB · DIRECT_GAIN
LIGHT_POS_WORLD  = np.array([0.0, 30.0, 0.0], dtype=np.float32)
LIGHT_DIR_WORLD  = np.array([0.0, -1.0, 0.0], dtype=np.float32)    # cone axis
LIGHT_RGB        = np.array([1.000, 1.000, 1.000], dtype=np.float32)
LIGHT_RGB_FIRE   = np.array([1.000, 0.400, 0.200], dtype=np.float32)  # _fireLightColor
LIGHT_RANGE_M    = 90.0
LIGHT_OUTER_COS  = math.cos(math.radians(140.0 / 2.0))             # ≈ 0.342  (full angle 140°)
LIGHT_INNER_COS  = math.cos(math.radians( 90.0 / 2.0))             # ≈ 0.707  (full angle 90°)
LIGHT_FALLOFF_K  = 30.0      # tunable; distance at which atten = 1/2 → matches the
                              # ~30 m floor-centre distance, so floor centre ≈ "half lit"
DIRECT_GAIN      = 4.0       # tunable scalar (Unity 2000 lm doesn't translate directly)

# Top-facing direct-light damp: scales `DIRECT_GAIN` down on faces with
# normals pointing up (floor, step top), without affecting side-facing
# surfaces (wall, lecterns). Effective gain per face is
#   gain · (1 − TOP_FACING_DIRECT_DAMP · max(0, N.y))
# So at TOP_FACING_DIRECT_DAMP = 0.6 the floor's direct contribution is 0.4×
# while the wall's stays at 1.0× — selective dimming of top-facing surfaces.
# Non-physical but matches in-game appearance, where floor + step look much
# darker than the wall despite getting more "direct" Lambert in a literal
# physical model. Likely Unity's URP applies some form of shadowing /
# baked occlusion on the floor that we don't have visibility into.
TOP_FACING_DIRECT_DAMP = 0.6

# Hemisphere ambient — Boot.unity:
#   m_AmbientMode = 0 (Skybox SH, but m_SkyboxMaterial = null).
#   m_AmbientSkyColor / Equator / Ground = listed below.
#   m_AmbientIntensity = 1.0.
# Computed per-face from |N.y|; doesn't depend on world position.
#
# SKY_RGB tuned DOWN from the prefab's (1, 1, 1) to (0.4, 0.4, 0.4): the
# courtroom is enclosed (no sky), so a full-white indirect contribution from
# above doesn't match the in-game look. Lowering the sky term selectively
# darkens top-facing surfaces (floor, step top) without affecting the wall
# (which is side-facing, dominated by the equator term ≈ 0.13).
SKY_RGB          = np.array([0.400, 0.400, 0.400], dtype=np.float32)
EQUATOR_RGB      = np.array([0.114, 0.125, 0.133], dtype=np.float32)
GROUND_RGB       = np.array([0.047, 0.043, 0.035], dtype=np.float32)
AMBIENT_GAIN     = 1.0       # m_AmbientIntensity

# Exposure floor: the prefab's equator/ground colors are very dim (~0.05–0.13),
# so a side-facing surface (lectern, step rim) would be crushed to near-black
# without any direct contribution. The exposure floor sits between ambient
# and the texture albedo as a constant additive term so even fully-shadowed
# surfaces stay at ≥ exposure × albedo. Tunable via --exposure.
DEFAULT_EXPOSURE = 0.4


# --- Camera math ---

def camera_axes_from_euler(yaw_deg, pitch_deg=0.0, roll_deg=0.0):
    """Forward / right / up unit vectors in world space for a Unity-style camera
    rotated by Euler (pitch_deg about X, yaw_deg about Y, roll_deg about Z).

    Convention: forward starts at +Z; rotation order applied is R_y · R_x · R_z
    (Unity Quaternion.Euler convention)."""
    sy, cy = math.sin(math.radians(yaw_deg)),   math.cos(math.radians(yaw_deg))
    sp, cp = math.sin(math.radians(pitch_deg)), math.cos(math.radians(pitch_deg))
    sr, cr = math.sin(math.radians(roll_deg)),  math.cos(math.radians(roll_deg))
    # forward = R_y · R_x · (0,0,1)   (roll doesn't change Z axis)
    forward = np.array([cp * sy, -sp, cp * cy])
    # up      = R_y · R_x · R_z · (0,1,0)
    up = np.array([sy * sp * cr - cy * sr,  cp * cr,  cy * sp * cr + sy * sr])
    # right   = up × forward (left-handed)
    right = np.cross(up, forward)
    # Normalise (should already be unit, but guard against drift)
    forward /= np.linalg.norm(forward)
    up      /= np.linalg.norm(up)
    right   /= np.linalg.norm(right)
    return forward, right, up


def camera_pose(yaw_multiplier, count, zoom, pitch_deg=0.0, roll_deg=0.0,
                distance=None, height=None):
    """Camera position + Euler rotation (Unity convention) for one named preset.

    yaw_multiplier is the dimensionless `(charIdx + composition_shift)` term
    feeding the in-game `cameraYaw` formula. For named-preset shots it equals
    `target_idx + COMPOSITIONS[composition]`; for direct camera commands it can
    be any float (e.g. 12.5 for "between Meruru and Ema" in Court).

    distance / height: when given, override the `ZOOM_LEVELS[zoom]` lookup. Lets
    the renderer match direct camera commands that use values outside the named
    preset library (e.g. D=4, H=5 in Act01_Chapter01_Trial00).

    yaw   = yaw_multiplier · 360° / N       where N = courtStandCount
    pos   = (+D · sin yaw, H, +D · cos yaw)   # camera INSIDE the lectern ring,
                                              # on the SAME side as the look target
    pitch = `pitch_deg` (rotation about world X; default 0 for the standard library)
    roll  = `roll_deg`  (rotation about world Z; ±5° for the cinematic rolled labels)

    Sign convention note: I originally used `-D · sin yaw / -D · cos yaw` (camera
    on the OPPOSITE side of origin from the look-target — looking back across the
    courtroom). Verified against in-game screenshot of Act01_Chapter01_Trial00's
    Meruru↔Ema midpoint shot: the actual game places the camera on the SAME side
    as the look target — inside the lectern ring, near the action. The previous
    `-D` formula put characters ~3× too far from the camera."""
    preset_d, preset_h = ZOOM_LEVELS[zoom]
    if distance is None:
        distance = preset_d
    if height is None:
        height = preset_h
    yaw_deg = yaw_multiplier * 360.0 / count
    yaw = math.radians(yaw_deg)
    pos = np.array([distance * math.sin(yaw), height, distance * math.cos(yaw)])
    forward, right, up = camera_axes_from_euler(yaw_deg, pitch_deg, roll_deg)
    return pos, forward, right, up, yaw_deg, distance, height


def view_matrix(pos, forward, right, up):
    """Left-handed view: world -> eye (camera at origin, +Z forward).
    Caller supplies the camera's three orthonormal axes (computed elsewhere)."""
    M = np.eye(4)
    M[0, :3] = right;   M[0, 3] = -np.dot(right, pos)
    M[1, :3] = up;      M[1, 3] = -np.dot(up, pos)
    M[2, :3] = forward; M[2, 3] = -np.dot(forward, pos)
    return M


def proj_matrix(fov_deg, aspect, near, far):
    """Left-handed perspective: eye -> clip (NDC.z in [0, 1] after divide)."""
    f = 1.0 / math.tan(math.radians(fov_deg) / 2.0)
    M = np.zeros((4, 4))
    M[0, 0] = f / aspect
    M[1, 1] = f
    M[2, 2] = far / (far - near)
    M[2, 3] = -near * far / (far - near)
    M[3, 2] = 1.0
    return M


def world_to_eye(verts, view):
    """World N x 3 -> eye N x 3 (drop the homogeneous w; view matrix already keeps w=1)."""
    n = verts.shape[0]
    homog = np.hstack([verts, np.ones((n, 1))])
    return (view @ homog.T).T[:, :3]


def eye_to_screen(eye_pts, proj, width, height):
    """Eye N x 3 -> pixel N x 2 (with eye_z N for depth sort).

    Caller MUST guarantee every input point has eye_z >= near (otherwise the
    perspective divide blows up). Use clip_triangle_near() upstream."""
    n = eye_pts.shape[0]
    homog = np.hstack([eye_pts, np.ones((n, 1))])
    clip = (proj @ homog.T).T
    w = clip[:, 3]
    ndc = clip / w[:, None]
    px = (ndc[:, 0] + 1.0) * width / 2.0
    py = (1.0 - ndc[:, 1]) * height / 2.0
    return np.column_stack([px, py]), eye_pts[:, 2]


def intersect_near(va, vb, near):
    """Linear-interpolate the segment va->vb to find the eye-space point at z = near.
    Symmetric in (va, vb) -- order doesn't change the resulting 3D point."""
    t = (near - va[2]) / (vb[2] - va[2])
    return va + t * (vb - va)


def _interp_uvs_to_subtri(va, vb, vc, tri_uvs, sub_eye):
    """For each vertex in sub_eye (3 eye-space points lying in the original
    triangle's plane), recover its UV by barycentric interpolation of the
    original triangle (va, vb, vc) with vertex UVs `tri_uvs` (3-tuple of (u, v)).
    Used after near-plane clipping creates new vertices on the original edges."""
    v0 = vb - va
    v1 = vc - va
    d00 = float(np.dot(v0, v0))
    d01 = float(np.dot(v0, v1))
    d11 = float(np.dot(v1, v1))
    denom = d00 * d11 - d01 * d01
    if abs(denom) < 1e-12:
        return None
    inv_denom = 1.0 / denom

    ua, va_uv = tri_uvs[0]
    ub, vb_uv = tri_uvs[1]
    uc, vc_uv = tri_uvs[2]
    out = []
    for p in sub_eye:
        v2 = p - va
        d20 = float(np.dot(v2, v0))
        d21 = float(np.dot(v2, v1))
        beta  = (d11 * d20 - d01 * d21) * inv_denom
        gamma = (d00 * d21 - d01 * d20) * inv_denom
        alpha = 1.0 - beta - gamma
        u = alpha * ua + beta * ub + gamma * uc
        v = alpha * va_uv + beta * vb_uv + gamma * vc_uv
        out.append((u, v))
    return out


def _interp_world_to_subtri(va, vb, vc, tri_world, sub_eye):
    """Same barycentric trick as `_interp_uvs_to_subtri`, but interpolates world
    positions (3-vectors) instead of UVs. Used to recover sub-triangle world-
    space vertex positions after near-plane clipping creates new vertices on
    the original edges. Both eye and world spaces are linearly related via the
    view matrix, so eye-space barycentric weights also yield correct world
    positions."""
    v0 = vb - va
    v1 = vc - va
    d00 = float(np.dot(v0, v0))
    d01 = float(np.dot(v0, v1))
    d11 = float(np.dot(v1, v1))
    denom = d00 * d11 - d01 * d01
    if abs(denom) < 1e-12:
        return None
    inv_denom = 1.0 / denom
    wa, wb, wc = tri_world
    out = []
    for p in sub_eye:
        v2 = p - va
        d20 = float(np.dot(v2, v0))
        d21 = float(np.dot(v2, v1))
        beta  = (d11 * d20 - d01 * d21) * inv_denom
        gamma = (d00 * d21 - d01 * d20) * inv_denom
        alpha = 1.0 - beta - gamma
        out.append((alpha * wa + beta * wb + gamma * wc).astype(np.float32))
    return out


def clip_triangle_near(v0, v1, v2, near):
    """Clip a triangle (eye-space, 3D vertices) against the near plane z >= near.

    Returns a list of 0, 1, or 2 sub-triangles, each as a 3-tuple of eye-space
    vertices, with the original winding preserved. The clipped vertices live
    on the line z = near."""
    in0 = v0[2] >= near
    in1 = v1[2] >= near
    in2 = v2[2] >= near
    n_in = int(in0) + int(in1) + int(in2)

    if n_in == 3:
        return [(v0, v1, v2)]
    if n_in == 0:
        return []

    if n_in == 1:
        # One in front, two behind. Cut off both edges leaving the front vertex.
        if in0:
            return [(v0, intersect_near(v0, v1, near), intersect_near(v2, v0, near))]
        if in1:
            return [(intersect_near(v0, v1, near), v1, intersect_near(v1, v2, near))]
        # in2
        return [(intersect_near(v1, v2, near), v2, intersect_near(v2, v0, near))]

    # n_in == 2: one behind, two in front. Polygon on the front side is a quad
    # of the two front vertices + two intersection points; split into 2 triangles.
    if not in0:
        # v0 behind; quad is (i01, v1, v2, i20)
        i01 = intersect_near(v0, v1, near)
        i20 = intersect_near(v2, v0, near)
        return [(i01, v1, v2), (i01, v2, i20)]
    if not in1:
        # v1 behind; quad is (v0, i01, i12, v2)
        i01 = intersect_near(v0, v1, near)
        i12 = intersect_near(v1, v2, near)
        return [(v0, i01, i12), (v0, i12, v2)]
    # not in2; quad is (v0, v1, i12, i20)
    i12 = intersect_near(v1, v2, near)
    i20 = intersect_near(v2, v0, near)
    return [(v0, v1, i12), (v0, i12, i20)]


# --- Geometry builders ---

def floor_mesh():
    """Floor: a single quad. UVs (0..s, 0..s) with s = m_Scale.x of Court_Floor.mat
    (= 2) so the carpet texture tiles 2× across the 61×61 m floor, matching the
    in-engine setup. The prefab uses Unity's built-in Quad (fileID 10210),
    rotated 90° about X so it lies flat in the XZ plane, then scaled (61, 61, 1).
    Quad's local UVs are (0,0) at (-0.5, -0.5, 0) → world (-s, 0, -s).

    V is flipped (1 - v) to match my rasteriser's V=0-at-image-top convention
    while preserving Unity's V=0-at-image-bottom for the texture itself —
    same correction the wall mesh applies."""
    s = FLOOR_HALF
    scale = 2.0
    verts = np.array([(-s, 0, -s), (+s, 0, -s), (+s, 0, +s), (-s, 0, +s)], dtype=float)
    # Local Quad UVs (Unity convention) → ×scale (Court_Floor.mat) → V-flip.
    uvs = np.array([(0, 0), (scale, 0), (scale, scale), (0, scale)], dtype=float)
    uvs[:, 1] = scale - uvs[:, 1]                                # V-flip about scale, not 1
    tris = np.array([(0, 1, 2), (0, 2, 3)], dtype=int)
    return verts, tris, uvs


def _quat_to_matrix(qx, qy, qz, qw):
    """Standard Unity quaternion (x, y, z, w) -> 3x3 rotation matrix.
    Auto-normalises in case the input is approximate."""
    norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    qx, qy, qz, qw = qx / norm, qy / norm, qz / norm, qw / norm
    return np.array([
        [1 - 2 * (qy * qy + qz * qz),  2 * (qx * qy - qz * qw),      2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw),      1 - 2 * (qx * qx + qz * qz),  2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw),      2 * (qy * qz + qx * qw),      1 - 2 * (qx * qx + qy * qy)],
    ])


def _build_wall_half_local(segments=32):
    """One half-cylinder in mesh-local coords, matching `default.asset`.

    Occupies angles [180°, 360°] in the unit circle (mesh z <= 0). UVs follow
    the prefab convention exactly:
      U goes 1.0 (at angle 180°) -> 0.0 (at angle 360°), with the small ~0.005
        padding both ends carry in the asset.
      V goes 0.0001 (at mesh top, y=+0.5) -> 0.987 (at mesh bottom, y=-0.5).
    Per-vertex (no sharing across angular seams), so material U scale/offset
    can wrap freely without distortion."""
    # Real values from the asset (cf. earlier `_typelessdata` decode).
    V_TOP, V_BOT = 0.0001, 0.987
    U_AT_180,  U_AT_360 = 0.998, 0.005

    n_pts = segments + 1
    verts, uvs = [], []
    for i in range(n_pts):
        ang_deg = 180.0 + (180.0 / segments) * i
        ang = math.radians(ang_deg)
        x, z = math.cos(ang), math.sin(ang)
        u = U_AT_180 + (U_AT_360 - U_AT_180) * (i / segments)
        verts.append((x, -0.5, z))           # bottom vertex (mesh y = -0.5)
        verts.append((x, +0.5, z))           # top vertex   (mesh y = +0.5)
        uvs.append((u, V_BOT))
        uvs.append((u, V_TOP))

    tris = []
    for i in range(segments):
        bl, tl = 2 * i, 2 * i + 1
        br, tr = 2 * (i + 1), 2 * (i + 1) + 1
        tris.append((bl, tl, tr))
        tris.append((bl, tr, br))

    return np.array(verts, dtype=float), np.array(tris, dtype=int), np.array(uvs, dtype=float)


# Wall transforms, straight from the prefab. Both walls share pos and scale;
# only the rotation quaternion differs. Quaternions are the exact values from
# Court.prefab / Court_Final.prefab (the two prefabs use identical wall transforms).
_WALL_POS = np.array([0.0, 4.2, 0.0])
_WALL_SCL = np.array([30.0, 15.0, 30.0])
_WALL_ROT_1 = _quat_to_matrix(-0.06540306, 0.0,        0.99785894, 0.0)   # Wall_1 (180° about ~Z)
_WALL_ROT_2 = _quat_to_matrix( 0.99785894, 0.0,        0.06540325, 0.0)   # Wall_2 (180° about ~X)

# Material UV (m_Scale.x, m_Offset.x). m_Scale.y / m_Offset.y are 1/0 for every
# wall material so V is left untouched. Sources (cf. docs/court_geometry.md):
#   Court      -> Court_Wall.mat (Wall_1)      + Court_Wall@Flip.mat (Wall_2)
#   Court_Final -> Court_Wall@7.mat on both walls
_WALL_MATERIAL_UV = {
    "court":       {"wall_1": (6.544, -0.0377), "wall_2": (6.544, +0.4623)},
    "court_final": {"wall_1": (7.048, +0.25),   "wall_2": (7.048, +0.25)},
}


def wall_meshes_for_prefab(prefab):
    """Build the two wall mesh dicts (Wall_1 + Wall_2) for the given prefab,
    matching the prefab's transforms + per-wall material UV scale/offset."""
    if prefab not in _WALL_MATERIAL_UV:
        raise ValueError(f"Unknown prefab: {prefab}")
    mats = _WALL_MATERIAL_UV[prefab]

    local_v, local_t, local_uv = _build_wall_half_local()

    def make_wall(rot, scale_u, offset_u):
        # World transform: world_v = R · (S · v_local) + T
        scaled = local_v * _WALL_SCL                                  # element-wise scale
        rotated = scaled @ rot.T
        world_v = rotated + _WALL_POS
        new_uv = local_uv.copy()
        new_uv[:, 0] = new_uv[:, 0] * scale_u + offset_u              # material U scale/offset
        # Flip V so this matches my sampling convention (ty = v * tex_h with row 0 = top
        # of image). Unity uses V=0 at image bottom; my rasteriser uses V=0 at image top,
        # so to reproduce Unity's appearance I invert at the import boundary.
        new_uv[:, 1] = 1.0 - new_uv[:, 1]
        return {
            "verts": world_v, "tris": local_t, "uvs": new_uv,
            "color": COLOR_WALLS, "tint": TINT_WALLS,
        }

    return [
        make_wall(_WALL_ROT_1, *mats["wall_1"]),
        make_wall(_WALL_ROT_2, *mats["wall_2"]),
    ]


_STEP_ASSET_PATH = ("/home/jeongu/CourtExportV2/ExportedProject/"
                    "Assets/Mesh/default_0.asset")


def step_mesh():
    """Load the step's capped-cylinder mesh directly from `default_0.asset` and
    apply the prefab transform (scale 24, 1, 24) and the Court_Step.mat
    material UV scale (8, 8) with a V-flip at the import boundary.

    The asset has a non-trivial CUSTOM UV unwrap that I previously tried to
    reconstruct procedurally — but the actual layout splits the cylinder side
    into TWO sub-strips (one mapping to V≈[0.417, 0.832] of the texture, the
    other to V≈[0, 0.415]) plus separate top-cap and bottom-cap discs. Quads
    along the cylinder rim alternate between the two strips. A single-strip
    procedural reconstruction can't reproduce this; loading the asset's
    vertex UVs verbatim guarantees pixel-faithful sampling of the brick atlas.

    Mesh size: 194 verts, 128 tris (64 side quads × 2 + 32 top fan + 32 bottom
    fan). World coords after scale: radius 24, height 2 (y ∈ [-1, +1])."""
    text = open(_STEP_ASSET_PATH).read()
    n_verts = int(re.search(r'm_VertexCount: (\d+)', text).group(1))
    td_hex  = re.search(r'_typelessdata: ([0-9a-f]+)', text).group(1)
    idx_hex = re.search(r'm_IndexBuffer: ([0-9a-f]+)', text).group(1)
    data    = bytes.fromhex(td_hex)
    idx     = bytes.fromhex(idx_hex)

    # Channel layout (per the asset's m_Channels): stride 48 bytes.
    # Position@0 (float3), Normal@12 (float3), Tangent@24 (float4), UV@40 (float2).
    stride = 48
    if n_verts * stride != len(data):
        raise RuntimeError(f"step asset stride mismatch: got {len(data)} bytes for "
                           f"{n_verts} verts at stride {stride}")
    local_verts, local_uvs = [], []
    for i in range(n_verts):
        b = i * stride
        px, py, pz = struct.unpack_from('<fff', data, b)
        u, v = struct.unpack_from('<ff', data, b + 40)
        local_verts.append((px, py, pz))
        local_uvs.append((u, v))

    indices = struct.unpack(f'<{len(idx) // 2}H', idx)
    tris = [(indices[t], indices[t + 1], indices[t + 2])
            for t in range(0, len(indices), 3)]

    # Apply prefab scale (STEP_HALF = 24 world radius; vertical scale 1).
    # m_LocalRotation is identity per the prefab.
    world_verts = [(p[0] * STEP_HALF, p[1], p[2] * STEP_HALF) for p in local_verts]

    # Apply Court_Step.mat material UV (Scale 8, Offset 0) and V-flip
    # (my rasteriser uses V=0-at-image-top; Unity uses V=0-at-image-bottom).
    scale_u, scale_v = 8.0, 8.0
    world_uvs = [(uv[0] * scale_u, (1.0 - uv[1]) * scale_v) for uv in local_uvs]

    return (np.array(world_verts, dtype=float),
            np.array(tris, dtype=int),
            np.array(world_uvs, dtype=float))


def stand_quads_mesh(n):
    """N camera-facing lectern quads. UVs map the full Court_Stand.png to each
    quad once (m_Scale = 1, m_Offset = 0). V flipped so V=0 is the top of the
    quad (= top row of the texture, which is the lectern cap), V=1 is the bottom
    (= lectern base). This matches the wall mesh's V convention."""
    verts_list, tris_list, uvs_list = [], [], []
    quad_uvs = [(0, 1), (1, 1), (1, 0), (0, 0)]            # bl, br, tr, tl
    for k in range(n):
        th = 2 * math.pi * k / n
        sint, cost = math.sin(th), math.cos(th)
        center = np.array([STAND_RADIUS * sint, STAND_Y, STAND_RADIUS * cost])
        tangent = np.array([cost, 0.0, -sint])
        up = np.array([0.0, 1.0, 0.0])
        bl = center - (STAND_W / 2) * tangent - (STAND_H / 2) * up
        br = center + (STAND_W / 2) * tangent - (STAND_H / 2) * up
        tr = center + (STAND_W / 2) * tangent + (STAND_H / 2) * up
        tl = center - (STAND_W / 2) * tangent + (STAND_H / 2) * up
        i0 = len(verts_list)
        verts_list.extend([bl, br, tr, tl])
        uvs_list.extend(quad_uvs)
        tris_list.append((i0, i0 + 1, i0 + 2))
        tris_list.append((i0, i0 + 2, i0 + 3))
    return np.array(verts_list), np.array(tris_list), np.array(uvs_list, dtype=float)


def char_marker_positions(n):
    pts = []
    for k in range(n):
        th = 2 * math.pi * k / n
        pts.append((CHAR_RADIUS * math.sin(th), CHAR_Y, CHAR_RADIUS * math.cos(th)))
    return np.array(pts)


# --- Shading ---

_LIGHT_UNLIT = np.array([1.0, 1.0, 1.0], dtype=np.float32)


def face_normal_world(world_verts):
    """Return a unit world-space normal for a triangle (3 world positions).

    Treats every face as double-sided (re-orients the normal toward the world
    up axis): floor / step caps are wound such that the cross product points
    DOWN, but visually they're seen from above, so we want a normal pointing
    up. For sideways faces (cylindrical wall, lectern), the |ny| component is
    near zero and the orientation flip would not change the lit appearance —
    we keep the geometric normal as-is. For top/bottom-facing faces we flip
    the normal toward +Y."""
    a, b, c = world_verts
    n = np.cross(b - a, c - a)
    n_len = np.linalg.norm(n)
    if n_len < 1e-9:
        return np.array([0.0, 1.0, 0.0], dtype=np.float32)
    n = (n / n_len).astype(np.float32)
    if n[1] < -0.5:                # strongly down-facing (winding flipped)
        n = -n                     # re-orient toward up
    return n


def hemisphere_ambient(face_normal):
    """Hemisphere ambient (constant per face): RGB triplet from |N.y|.

    Top-facing surfaces get sky color; side-facing surfaces get equator color.
    Bottom-hemisphere ground color is unused (no face is meant to be seen from
    below in this scene)."""
    ny = abs(float(face_normal[1]))
    return ((EQUATOR_RGB + (SKY_RGB - EQUATOR_RGB) * ny) * AMBIENT_GAIN).astype(np.float32)


def _smoothstep(edge_lo, edge_hi, x):
    """Standard smoothstep — t = clamp((x-lo)/(hi-lo), 0, 1); return t² · (3 - 2t).
    Vectorised over numpy arrays."""
    t = np.clip((x - edge_lo) / (edge_hi - edge_lo), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def compute_pixel_lighting(world_pos_xyz, face_normal, light_rgb, exposure):
    """Per-pixel lighting RGB multiplier given pixel-wise world positions and a
    constant face normal. Returns a (H, W, 3) float32 array.

    world_pos_xyz: tuple of three (H, W) arrays — interpolated world (X, Y, Z)
                   coordinates per pixel.
    face_normal:   unit world-space normal (3,) — constant across the face.
    light_rgb:     spot light color (3,), e.g. white or fire orange.
    exposure:      scalar exposure floor added to every channel.

    Combines:
      - Hemisphere ambient (|N.y|-keyed, constant per face);
      - Spot light direct contribution (Lambert × cone × distance attenuation);
      - Constant exposure floor."""
    wx, wy, wz = world_pos_xyz
    # Vector from each pixel toward the light
    dx = LIGHT_POS_WORLD[0] - wx
    dy = LIGHT_POS_WORLD[1] - wy
    dz = LIGHT_POS_WORLD[2] - wz
    d  = np.sqrt(dx*dx + dy*dy + dz*dz)
    inv_d = 1.0 / np.maximum(d, 1e-6)
    Lx, Ly, Lz = dx * inv_d, dy * inv_d, dz * inv_d

    # Lambert (face normal vs light direction). Negative values are
    # surfaces facing away from the light → no direct contribution.
    NdotL = np.clip(face_normal[0] * Lx + face_normal[1] * Ly + face_normal[2] * Lz, 0.0, None)

    # Cone factor. light_dir = (0, -1, 0); a pixel is inside the cone when
    # the angle between (-L) (= surface→light reversed = light direction
    # applied to surface) and light_dir is small. dot(-L, (0,-1,0)) = L.y,
    # so cone_dot = L.y. We use full smoothstep between cos(outer/2) and
    # cos(inner/2) so penumbra blends smoothly at the cone boundary.
    cone = _smoothstep(LIGHT_OUTER_COS, LIGHT_INNER_COS, Ly)

    # Distance attenuation: 1/(1 + (d/k)²) with smooth cutoff at range.
    atten = 1.0 / (1.0 + (d / LIGHT_FALLOFF_K) ** 2)
    range_atten = 1.0 - _smoothstep(0.8 * LIGHT_RANGE_M, LIGHT_RANGE_M, d)
    atten = atten * range_atten

    # Top-facing damp: per-face scalar that reduces the effective `DIRECT_GAIN`
    # on faces whose normals point up. Constant across the face since
    # face_normal is constant. Floor (N.y=1) → factor (1 − DAMP); side-facing
    # surfaces (wall, lectern) → factor 1.0.
    top_face_factor = max(0.0, 1.0 - TOP_FACING_DIRECT_DAMP * max(0.0, float(face_normal[1])))

    # Direct contribution (per pixel scalar)
    direct_scalar = (NdotL * cone * atten * DIRECT_GAIN * top_face_factor).astype(np.float32)

    # Compose RGB lighting: ambient (per-face constant) + direct (per-pixel) · light_rgb
    ambient = hemisphere_ambient(face_normal)             # shape (3,)
    direct_rgb = direct_scalar[..., None] * light_rgb[None, None, :]  # shape (H, W, 3)
    return (direct_rgb + ambient[None, None, :] + exposure).astype(np.float32)


# --- Render loop ---

def rasterize_triangle_z(color_buf, z_buf, p0, p1, p2, z0, z1, z2,
                         base_color, light_rgb=_LIGHT_UNLIT, uvs=None, texture=None,
                         tint=(255, 255, 255), world_verts=None, face_normal=None,
                         spot_rgb=None, exposure=0.0, normal_map=None,
                         groove_strength=0.0):
    """Per-pixel z-buffered rasterisation of one screen-space triangle.

    color_buf:    H x W x 3 uint8 (modified in place)
    z_buf:        H x W   float32 (modified in place; smaller = closer)
    p0..p2:       (x_pixel, y_pixel) screen coords
    z0..z2:       eye-space z at each vertex (for per-pixel depth interp)
    base_color:   (R, G, B) flat colour, used when texture is None
    light_rgb:    per-face RGB multiplier (shape (3,) float32). Used when world_verts
                  is None (the "tier 0" / unlit path). Pass _LIGHT_UNLIT (= [1,1,1])
                  for meshes that should bypass shading entirely.
    uvs:          optional 3-tuple of (u, v) at each vertex (for textured tris)
    texture:      optional H x W x 3 uint8 array (sampled nearest, U/V wrap)
    tint:         (R, G, B) 0..255 multiplier on the texture sample (matches
                  Unity material `_BaseColor`); ignored when texture is None
    world_verts:  optional 3-tuple of (X, Y, Z) world-space positions per vertex —
                  enables per-pixel position-based lighting (Tier 3). When given,
                  the rasteriser interpolates world position perspective-correctly
                  per pixel and computes the spot light contribution against
                  face_normal at each pixel.
    face_normal:  unit world-space face normal (3,) — required when world_verts
                  is set; ignored otherwise.
    spot_rgb:     spot light colour (3,) for the per-pixel lighting; required
                  when world_verts is set.
    exposure:     scalar exposure floor for the per-pixel lighting model.
    normal_map:   optional H × W × 3 (or 4) uint8 array — a tangent-space normal
                  map sampled at the same UVs as the diffuse texture. Used to
                  apply a fake-AO darkening derived from how far each pixel's
                  tangent-space normal deviates from straight-up: flat brick
                  faces (TS-normal ≈ +Z, R/G ≈ 128) → no darkening; groove
                  edges (TS-normal tilted, R/G away from 128) → darker.
                  Cheap approximation for grouted-brick / tile textures without
                  full tangent-space normal-map evaluation.
    groove_strength: 0..1. 0 disables the darkening; 1 fully blacks out the
                     deepest grooves. Typical 0.4–0.6 for moderate effect."""
    H, W = z_buf.shape
    x0, y0 = p0; x1, y1 = p1; x2, y2 = p2

    area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(area) < 1e-9:
        return
    inv_area = 1.0 / area

    min_x = max(0, int(math.floor(min(x0, x1, x2))))
    max_x = min(W - 1, int(math.ceil(max(x0, x1, x2))))
    min_y = max(0, int(math.floor(min(y0, y1, y2))))
    max_y = min(H - 1, int(math.ceil(max(y0, y1, y2))))
    if min_x > max_x or min_y > max_y:
        return

    yy, xx = np.mgrid[min_y:max_y + 1, min_x:max_x + 1].astype(np.float32)
    px = xx + 0.5
    py = yy + 0.5

    w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv_area
    w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv_area
    w2 = 1.0 - w0 - w1

    inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
    if not inside.any():
        return

    # Perspective-correct depth + UV interpolation. Both use the same trick:
    # 1/z is linearly interpolatable in screen space (unlike z itself), and any
    # quantity divided by z (e.g. u/z, v/z) interpolates linearly too. We
    # recover the geometrically-correct value at each pixel by dividing by the
    # interpolated 1/z. Without this, large triangles (the floor especially)
    # produce wrong depths -- visible as a straight cutoff at the wall-floor
    # boundary where the true intersection is the elliptical floor circle.
    inv_z0, inv_z1, inv_z2 = 1.0 / z0, 1.0 / z1, 1.0 / z2
    inv_z_pix = w0 * inv_z0 + w1 * inv_z1 + w2 * inv_z2
    z_pix = 1.0 / inv_z_pix                                     # perspective-correct depth

    z_slice = z_buf[min_y:max_y + 1, min_x:max_x + 1]
    write = inside & (z_pix < z_slice)
    if not write.any():
        return

    # Per-pixel lighting (Tier 3): interpolate world (X, Y, Z) perspective-
    # correctly and compute the spot light contribution at each pixel.
    # Same trick as the UV interpolation: world_pos / z is linear in screen
    # space; recover world_pos by dividing by interpolated 1/z. Result is a
    # (bbox_h, bbox_w, 3) float32 RGB multiplier, replacing the constant
    # `light_rgb` 3-vec for this triangle.
    if world_verts is not None and face_normal is not None and spot_rgb is not None:
        wv0, wv1, wv2 = world_verts
        wx_pix = (w0 * wv0[0] * inv_z0 + w1 * wv1[0] * inv_z1 + w2 * wv2[0] * inv_z2) / inv_z_pix
        wy_pix = (w0 * wv0[1] * inv_z0 + w1 * wv1[1] * inv_z1 + w2 * wv2[1] * inv_z2) / inv_z_pix
        wz_pix = (w0 * wv0[2] * inv_z0 + w1 * wv1[2] * inv_z1 + w2 * wv2[2] * inv_z2) / inv_z_pix
        pixel_lighting = compute_pixel_lighting((wx_pix, wy_pix, wz_pix),
                                                face_normal, spot_rgb, exposure)
        # Pixel-local replacement for `light_rgb`. Used directly below in
        # `tex_rgb * tint_arr * pixel_lighting`.
        effective_light = pixel_lighting                    # shape (H, W, 3)
    else:
        effective_light = None

    if texture is not None and uvs is not None:
        u0_w, u1_w, u2_w = uvs[0][0] * inv_z0, uvs[1][0] * inv_z1, uvs[2][0] * inv_z2
        v0_w, v1_w, v2_w = uvs[0][1] * inv_z0, uvs[1][1] * inv_z1, uvs[2][1] * inv_z2
        u_pix = (w0 * u0_w + w1 * u1_w + w2 * u2_w) / inv_z_pix
        v_pix = (w0 * v0_w + w1 * v1_w + w2 * v2_w) / inv_z_pix

        u_pix = u_pix - np.floor(u_pix)                         # repeat-wrap
        v_pix = v_pix - np.floor(v_pix)
        tex_h, tex_w = texture.shape[:2]
        tx = (u_pix * tex_w).astype(np.int32) % tex_w
        ty = (v_pix * tex_h).astype(np.int32) % tex_h
        tex_sample = texture[ty, tx]                            # bbox_h x bbox_w x (3 or 4)
        has_alpha = tex_sample.shape[-1] == 4

        tex_rgb = tex_sample[..., :3].astype(np.float32)
        tint_arr = np.array(tint, dtype=np.float32) / 255.0     # Unity _BaseColor multiplier
        # If per-pixel lighting was computed, use it; otherwise fall back to the
        # constant per-face `light_rgb`. Both broadcast cleanly over (..., 3).
        light_factor = effective_light if effective_light is not None else light_rgb

        # Optional fake-AO from a tangent-space normal map. Sampled at the
        # same UVs as the diffuse texture. For each pixel, compute how far
        # the tangent-space normal deviates from straight-up (R/G channels);
        # use that magnitude to multiply the lighting by a darkening factor.
        # Cheap approximation — doesn't actually compute tangent-space lighting,
        # but visually adds darker grooves to brick / tile textures.
        if normal_map is not None and groove_strength > 0:
            nm_h, nm_w = normal_map.shape[:2]
            nx_tex = (u_pix * nm_w).astype(np.int32) % nm_w
            ny_tex = (v_pix * nm_h).astype(np.int32) % nm_h
            nm_sample = normal_map[ny_tex, nx_tex, :2].astype(np.float32)  # R, G channels
            tangent_xy = nm_sample / 255.0 * 2.0 - 1.0                      # → [-1, +1]
            groove_factor = np.sqrt(tangent_xy[..., 0] ** 2 + tangent_xy[..., 1] ** 2)
            # groove_factor ∈ [0, 1]: 0 = flat brick face, ~1 = groove edge.
            darkening = (1.0 - groove_strength * groove_factor)[..., None]   # shape (H, W, 1)
            light_factor = light_factor * darkening                          # broadcasts

        shaded = (tex_rgb * tint_arr * light_factor).clip(0, 255)

        if has_alpha:
            # Alpha test + blend. Discard fully-transparent texels (don't touch
            # color or z); blend partially-transparent ones with whatever's
            # already in the colour buffer (typically the wall behind). Only
            # update the z-buffer where the texel is mostly opaque -- so AA-edge
            # texels don't block subsequent draws sitting behind them.
            alpha = tex_sample[..., 3].astype(np.float32) / 255.0
            visible = inside & (z_pix < z_slice) & (alpha > 0)
            if not visible.any():
                return
            color_slice = color_buf[min_y:max_y + 1, min_x:max_x + 1]
            existing = color_slice.astype(np.float32)
            a3 = alpha[..., None]
            blended = (shaded * a3 + existing * (1.0 - a3)).clip(0, 255).astype(np.uint8)
            color_slice[visible] = blended[visible]
            z_write = visible & (alpha > 0.5)
            z_slice[z_write] = z_pix[z_write]
        else:
            z_slice[write] = z_pix[write]
            color_buf[min_y:max_y + 1, min_x:max_x + 1][write] = shaded.astype(np.uint8)[write]
    else:
        # Flat-color path: if per-pixel lighting is available, multiply per pixel;
        # otherwise use the constant `light_rgb` across the face.
        base_arr = np.array(base_color, dtype=np.float32)
        if effective_light is not None:
            flat_shaded = (base_arr[None, None, :] * effective_light).clip(0, 255).astype(np.uint8)
            z_slice[write] = z_pix[write]
            color_buf[min_y:max_y + 1, min_x:max_x + 1][write] = flat_shaded[write]
        else:
            flat = tuple(int(max(0, min(255, base_color[i] * float(light_rgb[i])))) for i in range(3))
            z_slice[write] = z_pix[write]
            color_buf[min_y:max_y + 1, min_x:max_x + 1][write] = flat


def render(view, proj, meshes, markers, target_idx,
           light_rgb=LIGHT_RGB, exposure=DEFAULT_EXPOSURE,
           width=WIDTH, height=HEIGHT):
    """Render the scene. `meshes` is a list of dicts with keys:
        verts: N x 3 world coords
        tris:  M x 3 vertex indices
        color: (R, G, B) flat colour (used directly when texture is None,
                                      multiplied with the texture sample otherwise)
        uvs:   (optional) N x 2 texture coords (one per vertex)
        texture: (optional) H x W x 3 uint8 image to sample
        unlit: (optional) bool — skip the shading model and pass the texture/colour
               through with a (1,1,1) multiplier. Use for the painted backdrop wall
               (its lighting is baked into the texture)."""
    color_buf = np.full((height, width, 3), BG_COLOR, dtype=np.uint8)
    z_buf = np.full((height, width), np.inf, dtype=np.float32)

    for mesh in meshes:
        verts = mesh["verts"]
        tris = mesh["tris"]
        base_color = mesh["color"]
        uvs = mesh.get("uvs")
        texture = mesh.get("texture")
        tint = mesh.get("tint", (255, 255, 255))
        unlit = mesh.get("unlit", False)
        normal_map = mesh.get("normal_map")
        groove_strength = mesh.get("groove_strength", 0.0)

        eye = world_to_eye(verts, view)
        flip_normals = mesh.get("flip_normals", False)
        for tri in tris:
            i, j, k = tri
            # Face normal computed once in world space; same orientation across
            # all sub-triangles produced by near-plane clipping. `flip_normals`
            # is set on cylindrical-wall meshes whose triangles are wound such
            # that the geometric normal points outward (away from the cylinder
            # axis). The camera and light both sit INSIDE the cylinder, so
            # the visible/lit face is the inner side — flip the normal to
            # match.
            n_face = face_normal_world((verts[i], verts[j], verts[k]))
            if flip_normals:
                n_face = -n_face
            tri_world = (np.asarray(verts[i], dtype=np.float32),
                         np.asarray(verts[j], dtype=np.float32),
                         np.asarray(verts[k], dtype=np.float32))
            tri_uvs = (uvs[i], uvs[j], uvs[k]) if uvs is not None else None
            sub_tris = clip_triangle_near(eye[i], eye[j], eye[k], NEAR)
            for sub in sub_tris:
                sub_eye = np.array(sub)
                pix, depths = eye_to_screen(sub_eye, proj, width, height)
                if tri_uvs is not None:
                    sub_uvs = _interp_uvs_to_subtri(eye[i], eye[j], eye[k], tri_uvs, sub_eye)
                else:
                    sub_uvs = None
                # Sub-triangle world positions (== originals when no clipping happened).
                if unlit:
                    sub_world = None
                    spot_for_call = None
                else:
                    sub_world_list = _interp_world_to_subtri(
                        eye[i], eye[j], eye[k], tri_world, sub_eye)
                    sub_world = (sub_world_list[0], sub_world_list[1], sub_world_list[2]) \
                        if sub_world_list is not None else None
                    spot_for_call = light_rgb
                rasterize_triangle_z(
                    color_buf, z_buf,
                    (pix[0, 0], pix[0, 1]),
                    (pix[1, 0], pix[1, 1]),
                    (pix[2, 0], pix[2, 1]),
                    float(depths[0]), float(depths[1]), float(depths[2]),
                    base_color, light_rgb=_LIGHT_UNLIT,
                    uvs=sub_uvs, texture=texture, tint=tint,
                    world_verts=sub_world,
                    face_normal=n_face if not unlit else None,
                    spot_rgb=spot_for_call,
                    exposure=exposure,
                    normal_map=normal_map,
                    groove_strength=groove_strength,
                )

    img = Image.fromarray(color_buf, "RGB")
    draw = ImageDraw.Draw(img)

    # Markers: always-on-top debug overlays (no z-test by design)
    if markers is not None and len(markers) > 0:
        eye = world_to_eye(markers, view)
        in_front = eye[:, 2] >= NEAR
        if in_front.any():
            visible_eye = eye[in_front]
            pix, _ = eye_to_screen(visible_eye, proj, width, height)
            visible_idx = np.where(in_front)[0]
            for n_idx, idx in enumerate(visible_idx):
                color = COLOR_MARKER_TARGET if int(idx) == target_idx else COLOR_MARKER
                px, py = pix[n_idx]
                r = 14 if color is COLOR_MARKER_TARGET else 11
                draw.ellipse([(px - r, py - r), (px + r, py + r)],
                             fill=color, outline=COLOR_MARKER_OUTLINE, width=2)
                draw.text((px + r + 3, py - 8), str(int(idx)), fill=COLOR_MARKER_OUTLINE)

    return img


# --- CLI ---

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--prefab", choices=["court", "court_final"], default="court",
                   help="court (13 stands, used by 11/12 trials) or court_final (14 stands, finale only)")
    p.add_argument("--target-idx", type=int, default=None,
                   help="which stand the camera looks at (0..N-1). Overrides --look-character.")
    p.add_argument("--look-character", default=None,
                   help="character name (Ema, Hiro, Sherry, …) to look at. Resolved against the "
                        "reference trial (Act01_Chapter01 for court, Act02_Chapter06 for court_final). "
                        "Skips characters with idx=-1 in that trial. Falls back to --target-idx if absent.")
    p.add_argument("--zoom", type=int, choices=[1, 2, 3, 4], default=3,
                   help="zoom preset Lvl1..Lvl4 (D, H) in (10,5.2)/(11,5.3)/(12,5.5)/(13,5.6)")
    p.add_argument("--composition", choices=["center", "left", "right"], default="center",
                   help="horizontal composition shift (left/right by +-0.1/N * 360 deg)")
    p.add_argument("--roll", choices=["none", "left", "right"], default="none",
                   help="cinematic roll: none=0°, right=+5°, left=-5° (matches System_Subroutine "
                        ".ModifyCamera-*-Right / .ModifyCamera-*-Left labels)")
    p.add_argument("--roll-deg", type=float, default=None,
                   help="arbitrary roll (Z-rotation) in degrees. Overrides --roll if set. Use "
                        "for direct camera commands with non-standard roll values (e.g. -2° / -4° "
                        "seen in Act01_Chapter01_Trial00).")
    p.add_argument("--pitch-deg", type=float, default=0.0,
                   help="camera pitch (X-rotation) in degrees. Standard library uses 0; some "
                        "direct camera commands and SplitScreen labels use ±1°…±3°.")
    p.add_argument("--yaw-multiplier", type=float, default=None,
                   help="raw yaw multiplier N in `yaw = N / courtStandCount * 360`. Overrides "
                        "--target-idx + --composition for the camera position/rotation. Use to "
                        "dial in fractional/inter-stand angles (e.g. 12.5 in Court for the "
                        "Meruru↔Ema midpoint shot, which is one of the trial scripts' direct "
                        "camera commands). --target-idx still controls which stand gets the "
                        "highlighted (yellow) character marker, if any.")
    p.add_argument("--distance", type=float, default=None,
                   help="override the orbital ring radius D (in metres). Bypasses the --zoom "
                        "preset lookup. Use to reproduce direct camera commands whose D is "
                        "outside the preset library (e.g. D=4 in Act01_Chapter01_Trial00).")
    p.add_argument("--height", type=float, default=None,
                   help="override the camera height H (in metres). Bypasses the --zoom preset "
                        "lookup. Use alongside --distance for direct camera commands.")
    p.add_argument("--out", default=None, help="output PNG path")
    p.add_argument("--no-textures", action="store_true",
                   help="disable all textures and render with flat colours instead")
    p.add_argument("--no-step", action="store_true",
                   help="omit the central podium (step). Useful for inspecting the wall-floor "
                        "intersection (cylinder ∩ y=0 circle), which the step otherwise occludes "
                        "across most of the visible floor area.")
    p.add_argument("--no-lighting", action="store_true",
                   help="disable the prefab's lighting model entirely (textures pass through "
                        "1:1). Equivalent to the original `brightness=1` behaviour.")
    p.add_argument("--fire-light", action="store_true",
                   help="use the FireVFX runtime light colour (1.0, 0.4, 0.2) instead of the "
                        "prefab default white. Mimics scenes with the brazier lit.")
    p.add_argument("--exposure", type=float, default=DEFAULT_EXPOSURE,
                   help=f"constant added to the per-face lighting term to keep side-facing "
                        f"surfaces from crushing to black under the prefab's dim equator/ground "
                        f"colors. Default {DEFAULT_EXPOSURE}; raise to brighten, drop to 0 for "
                        f"a strict prefab match.")
    args = p.parse_args()

    n = 13 if args.prefab == "court" else 14
    char_map = CHAR_IDX_COURT if args.prefab == "court" else CHAR_IDX_COURT_FINAL

    # Resolve target index for marker highlighting. With --yaw-multiplier set,
    # --target-idx / --look-character are optional (no marker is highlighted
    # if neither is provided); without it, exactly one must yield a valid idx.
    if args.look_character is not None:
        key = args.look_character.lower()
        if key not in char_map:
            p.error(f"--look-character {args.look_character!r} not recognised; valid: "
                    + ", ".join(sorted(char_map)))
        target_idx = char_map[key]
        if target_idx < 0:
            p.error(f"character {args.look_character!r} is absent (idx=-1) in the reference trial "
                    f"for {args.prefab}")
    elif args.target_idx is not None:
        target_idx = args.target_idx
    elif args.yaw_multiplier is not None:
        target_idx = -1                                       # no marker highlight
    else:
        target_idx = 0
    if target_idx >= 0 and not (0 <= target_idx < n):
        p.error(f"target idx {target_idx} out of range for {args.prefab} ({n} stands; valid 0..{n-1})")

    # Yaw multiplier feeding the in-game `yaw = N / courtStandCount * 360` formula.
    # Override > named-preset combo of (target_idx + composition).
    if args.yaw_multiplier is not None:
        yaw_multiplier = args.yaw_multiplier
    else:
        yaw_multiplier = target_idx + COMPOSITIONS[args.composition]

    roll_deg = args.roll_deg if args.roll_deg is not None else ROLL_PRESETS[args.roll]
    pos, forward, right, up, yaw_deg, dist, hgt = camera_pose(
        yaw_multiplier, n, args.zoom,
        pitch_deg=args.pitch_deg, roll_deg=roll_deg,
        distance=args.distance, height=args.height,
    )
    view = view_matrix(pos, forward, right, up)
    proj = proj_matrix(FOV_DEG_VERTICAL, WIDTH / HEIGHT, NEAR, FAR)

    # All textures live in scene/court/ (extracted by extract_scene_court.py).
    # Loaded once here and passed by reference into the meshes; the rasteriser
    # samples them per pixel.
    COURT_TEX = Path(__file__).resolve().parent.parent / "scene" / "court"
    if not args.no_textures:
        backdrop_tex = np.array(Image.open(COURT_TEX / "Background_014_001.png").convert("RGB"))
        floor_tex    = np.array(Image.open(COURT_TEX / "Carpet 4 BaseMap.png").convert("RGB"))
        step_tex     = np.array(Image.open(COURT_TEX / "Bricks 2 BaseMap.png").convert("RGB"))
        # Tangent-space normal map for the step's brick texture (per
        # Court_Step.mat's _BumpMap field). Used by the rasteriser as a
        # fake-AO darkening modulator — see `groove_strength` parameter.
        step_normal  = np.array(Image.open(COURT_TEX / "Bricks 2 Normal.png").convert("RGB"))
        # Lectern is RGBA: ~5% fully-transparent + ~2% AA-edge pixels carry
        # garbage RGB outside the silhouette. Keep alpha so the rasteriser can
        # discard / blend them properly against whatever's behind (the wall).
        stand_tex    = np.array(Image.open(COURT_TEX / "Court_Stand.png").convert("RGBA"))
    else:
        backdrop_tex = floor_tex = step_tex = step_normal = stand_tex = None

    floor_v, floor_t, floor_uv = floor_mesh()
    step_v,  step_t,  step_uv  = step_mesh()
    stand_v, stand_t, stand_uv = stand_quads_mesh(n)
    wall_meshes = wall_meshes_for_prefab(args.prefab)
    for wm in wall_meshes:
        wm["texture"] = backdrop_tex                              # both walls share Background_014_001
        # Tier 3 lighting: the wall participates in the per-pixel spot light
        # computation. Distance attenuation produces the in-game's top-bright /
        # bottom-dim vertical gradient (wall top ~35 m from the light, wall
        # bottom ~45 m → 1.6× brightness ratio). The painted texture provides
        # the diffuse albedo; lighting is layered on top per pixel.
        # The cylindrical wall mesh has triangles wound such that the cross-
        # product normal points OUTWARD from the cylinder axis. The lit/visible
        # side is the inner side (camera + light both inside the cylinder), so
        # flip the normal at lighting time.
        wm["flip_normals"] = True

    meshes = [
        {"verts": floor_v, "tris": floor_t, "color": COLOR_FLOOR,
         "uvs": floor_uv,  "texture": floor_tex,    "tint": TINT_FLOOR},
        *wall_meshes,
        {"verts": stand_v, "tris": stand_t, "color": COLOR_STAND,
         "uvs": stand_uv,  "texture": stand_tex,    "tint": TINT_STAND},
    ]
    if not args.no_step:
        meshes.insert(-1, {                                       # step renders behind stands
            "verts": step_v, "tris": step_t, "color": COLOR_STEP,
            "uvs": step_uv,  "texture": step_tex, "tint": TINT_STEP,
            # Apply the bump map's tangent-space deviation as fake-AO darkening
            # so the brick grooves come out visibly darker — matches the in-game
            # appearance even without full tangent-space normal-map evaluation.
            "normal_map": step_normal,
            "groove_strength": 0.5,
        })
    markers = char_marker_positions(n)

    if args.no_lighting:
        light_rgb_used = _LIGHT_UNLIT
        exposure_used = 1.0
        # Tag every mesh as unlit so the rasteriser skips face_lighting().
        for m in meshes:
            m["unlit"] = True
    else:
        light_rgb_used = LIGHT_RGB_FIRE if args.fire_light else LIGHT_RGB
        exposure_used = args.exposure

    img = render(view, proj, meshes, markers, target_idx,
                 light_rgb=light_rgb_used, exposure=exposure_used)

    if args.out is None:
        if args.yaw_multiplier is not None:
            yaw_tag = f"_yaw{args.yaw_multiplier:g}"
            comp_tag = ""                                      # composition is unused under override
        else:
            yaw_tag = (f"_{args.look_character}" if args.look_character
                       else f"_idx{target_idx}")
            comp_tag = f"_{args.composition}"
        if args.distance is not None or args.height is not None:
            geom_tag = f"_D{dist:g}H{hgt:g}"
        else:
            geom_tag = f"_zoom{args.zoom}"
        roll_tag = f"_roll-{args.roll}" if args.roll != "none" else ""
        pitch_tag = f"_pitch{args.pitch_deg:+g}" if args.pitch_deg != 0.0 else ""
        light_tag = ("_unlit" if args.no_lighting
                     else "_fire" if args.fire_light
                     else "")
        out = (f"RenderedCourt/court_3d_{args.prefab}{yaw_tag}{geom_tag}"
               f"{comp_tag}{roll_tag}{pitch_tag}{light_tag}.png")
    else:
        out = args.out
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    img.save(out)

    print()
    print(f"=== Rendered {out} ===")
    print(f"  Prefab:           {args.prefab} ({n} stands)")
    if target_idx >= 0:
        char_label = f" ({args.look_character})" if args.look_character else ""
        print(f"  Target idx:       {target_idx}{char_label} (highlighted yellow)")
    else:
        print(f"  Target idx:       (none — no stand highlighted)")
    if args.distance is not None or args.height is not None:
        print(f"  Geometry:         override (D = {dist} m, H = {hgt} m; --zoom Lvl{args.zoom} ignored)")
    else:
        print(f"  Zoom:             Lvl{args.zoom}  (D = {dist} m, H = {hgt} m)")
    if args.yaw_multiplier is not None:
        print(f"  Yaw multiplier:   {args.yaw_multiplier:g}  "
              f"(override; yaw = {args.yaw_multiplier:g}/{n} * 360 = {yaw_deg:.4f}°)")
    else:
        print(f"  Composition:      {args.composition}  (yaw shift = {COMPOSITIONS[args.composition]:+}/N * 360 deg)")
    print(f"  Roll:             {args.roll}  ({roll_deg:+g}°)")
    print(f"  Pitch:            {args.pitch_deg:+g}°")
    print()
    print(f"  Camera position:  ({pos[0]:+.4f}, {pos[1]:+.4f}, {pos[2]:+.4f}) m  (Unity world coords, Y up)")
    print(f"  Camera yaw:       {yaw_deg:+.4f}°")
    print(f"  Camera forward:   ({forward[0]:+.4f}, {forward[1]:+.4f}, {forward[2]:+.4f})")
    print(f"  Camera up:        ({up[0]:+.4f}, {up[1]:+.4f}, {up[2]:+.4f})")
    print(f"  Vertical FOV:     {FOV_DEG_VERTICAL}°  (aspect {WIDTH}/{HEIGHT} = {WIDTH/HEIGHT:.4f})")
    if args.no_lighting:
        print(f"  Lighting:         off (textures pass through 1:1)")
    else:
        light_label = "fire (1.0, 0.4, 0.2)" if args.fire_light else "default white"
        print(f"  Lighting:         on  (per-pixel spot at {tuple(LIGHT_POS_WORLD)}, "
              f"color={light_label}, range={LIGHT_RANGE_M}m)")
        print(f"                    cone {math.degrees(math.acos(LIGHT_OUTER_COS))*2:g}° outer "
              f"/ {math.degrees(math.acos(LIGHT_INNER_COS))*2:g}° inner, "
              f"falloff_k={LIGHT_FALLOFF_K}m, gain={DIRECT_GAIN}, exposure={args.exposure:g}")


if __name__ == "__main__":
    main()
