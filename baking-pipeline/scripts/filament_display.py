import math
from pathlib import Path

import bpy
import numpy as np


def matrix(values):
    return np.array(values, dtype=np.float64).reshape(3, 3).T


XYZ_TO_SRGB = matrix((3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252))
REC2020_TO_XYZ = matrix((0.6369530, 0.1446169, 0.1688558, 0.2626983, 0.6780088, 0.0592929, 0.0, 0.0280731, 1.0608272))
AP1_TO_XYZ = matrix((0.6624541811, 0.1340042065, 0.1561876870, 0.2722287168, 0.6740817658, 0.0536895174, -0.0055746495, 0.0040607335, 1.0103391003))
XYZ_TO_AP1 = matrix((1.6410233797, -0.3248032942, -0.2364246952, -0.6636628587, 1.6153315917, 0.0167563477, 0.0117218943, -0.0082844420, 0.9883948585))
AP1_TO_AP0 = matrix((0.6954522414, 0.1406786965, 0.1638690622, 0.0447945634, 0.8596711185, 0.0955343182, -0.0055258826, 0.0040252103, 1.0015006723))
AP0_TO_AP1 = matrix((1.4514393161, -0.2365107469, -0.2149285693, -0.0765537734, 1.1762296998, -0.0996759264, 0.0083161484, -0.0060324498, 0.9977163014))
REC2020_TO_SRGB = XYZ_TO_SRGB @ REC2020_TO_XYZ
SRGB_TO_REC2020 = np.linalg.inv(REC2020_TO_SRGB)
REC2020_TO_AP0 = AP1_TO_AP0 @ XYZ_TO_AP1 @ REC2020_TO_XYZ
AP1_TO_REC2020 = np.linalg.inv(XYZ_TO_AP1 @ REC2020_TO_XYZ)
LUMINANCE_AP1 = np.array((0.272229, 0.674082, 0.0536895))


def multiply(rgb, transform):
    return rgb @ transform.T


def apply_display_transform(rgb, config):
    exposure = filament_exposure(config)["linearExposureFactor"]
    rec2020 = multiply(rgb * exposure, SRGB_TO_REC2020)
    mode = config["render"].get("previewToneMapper", "FILMIC")
    if mode == "FILMIC":
        x = np.maximum(rec2020, 0.0)
        mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
    elif mode == "ACES":
        mapped = aces_operator(rec2020)
    else:
        raise ValueError(f"Unsupported preview tone mapper: {mode}")
    return np.clip(multiply(mapped, REC2020_TO_SRGB), 0.0, 1.0)


def save_display_rgb(rgb, png_path, scene):
    png_path = Path(png_path).resolve()
    output = bpy.data.images.new(f"DISPLAY_ONLY_{png_path.stem}", width=rgb.shape[1], height=rgb.shape[0], alpha=True, float_buffer=True)
    output.colorspace_settings.name = "Linear Rec.709"
    output.pixels.foreach_set(rgb.astype(np.float32).ravel())
    output.update()
    output.use_view_as_render = True
    output.file_format = "PNG"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    output.save_render(str(png_path), scene=scene)
    bpy.data.images.remove(output)


def filament_exposure(config):
    render = config["render"]
    aperture = float(render["aperture"])
    shutter = float(render["shutterSpeedSeconds"])
    sensitivity = float(render["sensitivityIso"])
    ev100 = math.log2(aperture * aperture / shutter * 100.0 / sensitivity)
    factor = 1.0 / (1.2 * 2.0 ** ev100)
    mode = config["render"].get("previewToneMapper", "FILMIC")
    if mode == "FILMIC":
        tone_mapper = "Filament 1.68.2 FilmicToneMapper from SceneView createView(); deprecated View.setToneMapping(ACES) is a no-op"
        working_space = "Blender linear sRGB -> physical exposure -> linear Rec.2020 -> Narkowicz Filmic per channel -> linear sRGB -> Standard sRGB OETF"
        not_claimed = "Analytic operator only: the default 32^3 RGB10_A2 LogC LUT, its quantization/interpolation, dithering, FXAA and driver HDR quantization are not reproduced; gamutMapping and luminanceScaling are false. No display transform is written into lightmap masters."
    elif mode == "ACES":
        tone_mapper = "Filament 1.68.2 ACESToneMapper, brightness=1.0 (legacy diagnostic only, not the SceneView A0 operator)"
        working_space = "Blender linear sRGB -> physical exposure -> linear Rec.2020 -> ACES operator -> linear sRGB -> Standard sRGB OETF"
        not_claimed = "Filament color-grading LUT quantization, dithering and FXAA are not reproduced; no exposure or tone mapping is written into lightmap masters."
    else:
        raise ValueError(f"Unsupported preview tone mapper: {mode}")
    return {
        "aperture": aperture,
        "shutterSpeedSeconds": shutter,
        "sensitivityIso": sensitivity,
        "ev100": ev100,
        "linearExposureFactor": factor,
        "blenderEquivalentExposureStops": math.log2(factor),
        "toneMapper": tone_mapper,
        "operatorSource": render["filamentToneMapperSource"],
        "workingSpace": working_space,
        "notClaimedEquivalent": not_claimed,
        "rejectedGamutExperiment": "The attempted adaptive-L0 gamut implementation produced saturated red highlight patches; it was removed from the final preview path. See diagnostics/pre-gamut-previews and diagnostics/rejected-gamut-matrix.",
    }


def aces_operator(rec2020):
    ap0 = multiply(np.maximum(rec2020, 0.0), REC2020_TO_AP0)
    minimum = np.min(ap0, axis=-1)
    maximum = np.max(ap0, axis=-1)
    saturation = (np.maximum(maximum, 1e-5) - np.maximum(minimum, 1e-5)) / np.maximum(maximum, 1e-2)
    r, g, b = ap0[..., 0], ap0[..., 1], ap0[..., 2]
    chroma = np.sqrt(np.maximum(b * (b - g) + g * (g - r) + r * (r - b), 0.0))
    yc = (r + g + b + 1.75 * chroma) / 3.0
    x = (saturation - 0.4) / 0.2
    t = np.maximum(1.0 - np.abs(x / 2.0), 0.0)
    shaped = (1.0 + np.sign(x) * (1.0 - t * t)) / 2.0
    gain = 0.05 * shaped
    glow = np.where(yc <= 2.0 / 3.0 * 0.08, gain, np.where(yc >= 0.16, 0.0, gain * (0.08 / np.maximum(yc, 1e-12) - 0.5)))
    ap0 = ap0 * (1.0 + glow[..., None])
    r, g, b = ap0[..., 0], ap0[..., 1], ap0[..., 2]
    hue = np.degrees(np.arctan2(np.sqrt(3.0) * (g - b), 2.0 * r - g - b)) % 360.0
    centered = (hue + 180.0) % 360.0 - 180.0
    weight = np.clip(1.0 - np.abs(2.0 * centered / 135.0), 0.0, 1.0)
    weight = weight * weight * (3.0 - 2.0 * weight)
    weight = weight * weight
    ap0[..., 0] += weight * saturation * (0.03 - ap0[..., 0]) * (1.0 - 0.82)
    ap1 = np.clip(multiply(ap0, AP0_TO_AP1), 0.0, 65504.0)
    luminance = np.sum(ap1 * LUMINANCE_AP1, axis=-1, keepdims=True)
    ap1 = luminance + 0.96 * (ap1 - luminance)
    rgb_post = (ap1 * (2.785085 * ap1 + 0.107772)) / (ap1 * (2.936045 * ap1 + 0.887122) + 0.806889)
    xyz = multiply(rgb_post, AP1_TO_XYZ)
    denominator = np.maximum(np.sum(xyz, axis=-1), 1e-5)
    x = xyz[..., 0] / denominator
    y = xyz[..., 1] / denominator
    luminance = np.clip(xyz[..., 1], 0.0, 65504.0) ** 0.9811
    scale = luminance / np.maximum(y, 1e-5)
    xyz = np.stack((x * scale, luminance, (1.0 - x - y) * scale), axis=-1)
    linear_cv = multiply(xyz, XYZ_TO_AP1)
    luminance = np.sum(linear_cv * LUMINANCE_AP1, axis=-1, keepdims=True)
    linear_cv = luminance + 0.93 * (linear_cv - luminance)
    return multiply(linear_cv, AP1_TO_REC2020)


def display_metadata(config):
    return filament_exposure(config)


def save_scene_linear_preview(scene, linear_path, png_path, config):
    linear_path = Path(linear_path).resolve()
    png_path = Path(png_path).resolve()
    linear_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    old_view = (scene.view_settings.view_transform, scene.view_settings.look, scene.view_settings.exposure, scene.view_settings.gamma)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.render.image_settings.exr_codec = "ZIP"
    scene.render.filepath = str(linear_path)
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(str(linear_path), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    rgb = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4)
    rgb[..., :3] = apply_display_transform(rgb[..., :3], config)
    save_display_rgb(rgb, png_path, scene)
    bpy.data.images.remove(image)
    scene.view_settings.view_transform, scene.view_settings.look, scene.view_settings.exposure, scene.view_settings.gamma = old_view
