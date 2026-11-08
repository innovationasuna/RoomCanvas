import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
import numpy as np


SOURCES = {
    "sceneView": "https://github.com/SceneView/sceneview-android/blob/v2.3.4/sceneview/src/main/java/io/github/sceneview/SceneView.kt",
    "colorGrading": "https://github.com/google/filament/blob/v1.68.2/filament/src/details/ColorGrading.cpp",
    "colorGradingShader": "https://github.com/google/filament/blob/v1.68.2/filament/src/materials/colorGrading/colorGrading.fs",
    "colorSpace": "https://github.com/google/filament/blob/v1.68.2/filament/src/ColorSpaceUtils.h",
    "renderer": "https://github.com/google/filament/blob/v1.68.2/filament/src/details/Renderer.cpp",
    "view": "https://github.com/google/filament/blob/v1.68.2/filament/src/details/View.cpp",
    "options": "https://github.com/google/filament/blob/v1.68.2/filament/include/filament/Options.h",
    "dithering": "https://github.com/google/filament/blob/v1.68.2/shaders/src/inline_dithering.fs",
}


def srgb_oetf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * np.power(value, 1.0 / 2.4) - 0.055)


def srgb_eotf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def linear_to_logc(value):
    return 0.244161 * np.log10(5.555556 * value + 0.047996) + 0.386036


def logc_to_linear(value):
    return (np.power(10.0, (value - 0.386036) / 0.244161) - 0.047996) / 5.555556


def quantize_unsigned_float(value, mantissa_bits):
    source = np.maximum(value, 0.0).astype(np.float32)
    bits = source.view(np.uint32)
    exponent = (bits >> np.uint32(23)) & np.uint32(0xFF)
    shift = 23 - mantissa_bits
    rounding = np.uint32((1 << (shift - 1)) - 1)
    rounded = bits + rounding + ((bits >> np.uint32(shift)) & np.uint32(1))
    quantized_bits = (rounded >> np.uint32(shift)) << np.uint32(shift)
    normal = quantized_bits.view(np.float32)
    subnormal = np.rint(source.astype(np.float64) * (2.0 ** (14 + mantissa_bits))) / (2.0 ** (14 + mantissa_bits))
    result = np.where(exponent >= 127 - 14, normal, subnormal)
    overflow = exponent >= 143
    return np.where(overflow, np.inf, result).astype(np.float64)


def quantize_r11g11b10f(value):
    result = np.empty_like(value, dtype=np.float64)
    result[..., 0] = quantize_unsigned_float(value[..., 0], 6)
    result[..., 1] = quantize_unsigned_float(value[..., 1], 6)
    result[..., 2] = quantize_unsigned_float(value[..., 2], 5)
    return result


def build_filmic_lut(multiply, srgb_to_rec2020, rec2020_to_srgb):
    dimension = 32
    coordinates = np.arange(dimension, dtype=np.float64) / (dimension - 1)
    blue, green, red = np.meshgrid(coordinates, coordinates, coordinates, indexing="ij")
    logc = np.stack((red, green, blue), axis=-1)
    linear = np.maximum(logc_to_linear(logc), 0.0)
    rec2020 = multiply(linear, srgb_to_rec2020)
    mapped = (rec2020 * (2.51 * rec2020 + 0.03)) / (rec2020 * (2.43 * rec2020 + 0.59) + 0.14)
    display_linear = np.clip(multiply(mapped, rec2020_to_srgb), 0.0, 1.0)
    encoded = srgb_oetf(display_linear)
    half = encoded.astype(np.float16).astype(np.float64)
    return np.floor(half * 1023.0 + 0.5) / 1023.0


def sample_lut(lut, exposed_linear):
    original_shape = exposed_linear.shape
    encoded = linear_to_logc(exposed_linear.reshape(-1, 3))
    coordinates = np.clip(encoded * (lut.shape[0] - 1), 0.0, lut.shape[0] - 1)
    lower = np.floor(coordinates).astype(np.int32)
    upper = np.minimum(lower + 1, lut.shape[0] - 1)
    fraction = coordinates - lower
    output = np.zeros_like(coordinates)
    for blue in (0, 1):
        for green in (0, 1):
            for red in (0, 1):
                indices = (lower[:, 2] if blue == 0 else upper[:, 2],
                           lower[:, 1] if green == 0 else upper[:, 1],
                           lower[:, 0] if red == 0 else upper[:, 0])
                weight = ((fraction[:, 2] if blue else 1.0 - fraction[:, 2]) *
                          (fraction[:, 1] if green else 1.0 - fraction[:, 1]) *
                          (fraction[:, 0] if red else 1.0 - fraction[:, 0]))
                output += lut[indices] * weight[:, None]
    return output.reshape(original_shape)


def analytic_source_order(exposed_linear, multiply, srgb_to_rec2020, rec2020_to_srgb):
    rec2020 = multiply(exposed_linear, srgb_to_rec2020)
    mapped = (rec2020 * (2.51 * rec2020 + 0.03)) / (rec2020 * (2.43 * rec2020 + 0.59) + 0.14)
    return np.clip(multiply(mapped, rec2020_to_srgb), 0.0, 1.0)


def triangle_noise(height, width, temporal_noise=0.0):
    y, x = np.meshgrid(np.arange(height, dtype=np.float64) + 0.5,
                       np.arange(width, dtype=np.float64) + 0.5, indexing="ij")
    nx = np.mod((x / width + 0.07 * temporal_noise) * 5.3987, 1.0)
    ny = np.mod((y / height + 0.07 * temporal_noise) * 5.4421, 1.0)
    nx, ny = nx + ny * (nx + 21.5351), ny + nx * (ny + 14.3137)
    product = nx * ny
    return np.mod(product * 95.4307, 1.0) + np.mod(product * 75.04961, 1.0) - 1.0


def encoded_mae(first, second):
    return float(np.mean(np.abs(first - second)) * 255.0)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", default="remaining-visual-review")
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config["render"].get("previewToneMapper") != "FILMIC":
        raise ValueError("This diagnostic requires the existing FILMIC preview configuration")
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label / "display"
    target_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Scene does not match the locked source hash")
    source_path = (root / config["sourceModel"]).resolve()
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_hash != config["expectedSha256"]:
        raise ValueError("Original GLB hash changed")
    baked_hash = hashlib.sha256((output_dir / "example_room_2.baked.glb").read_bytes()).hexdigest()
    if baked_hash != "36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b":
        raise ValueError("10.5 baked GLB hash changed")

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import (REC2020_TO_SRGB, SRGB_TO_REC2020, filament_exposure,
                                  multiply, save_display_rgb)

    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    exposure = filament_exposure(config)["linearExposureFactor"]
    lut = build_filmic_lut(multiply, SRGB_TO_REC2020, REC2020_TO_SRGB)
    report = {
        "stage": "B1 remaining visual review; display-chain diagnostics only",
        "sourceSha256": source_hash,
        "bakedGlbSha256": baked_hash,
        "sceneLinearRerendered": False,
        "lightmapsRebaked": False,
        "mainPreviewsOverwritten": False,
        "exposureAppliedBeforeHdrQuantization": True,
        "lut": {
            "dimension": 32,
            "input": "Alexa LogC EI 1000 encoding followed by trilinear sampling at texel centers",
            "workingSpace": "linear sRGB -> linear Rec.2020 -> per-channel Narkowicz Filmic -> linear sRGB -> sRGB OETF",
            "storage": "Each LUT entry is rounded to binary16, then to RGB10_A2 integer RGB, following ColorGrading.cpp",
            "gamutMapping": False,
            "luminanceScaling": False,
        },
        "hdr": {
            "configuredFormat": "R11F_G11F_B10F (opaque SceneView, MEDIUM hdrColorBuffer)",
            "model": "Unsigned float with 6/6/5 mantissa bits and round-to-nearest-even for normal values",
            "boundary": "Source-derived format model, not a readback of the device driver or a claim about driver fallback support",
        },
        "dithering": {
            "type": "Default TEMPORAL, triangle noise shared by RGB channels",
            "temporalNoiseForDiagnostic": 0.0,
            "amplitudeBefore8BitRounding": "+/-1 code value",
        },
        "notReproduced": ["FXAA", "SSAO", "PCSS", "screen-space refraction", "driver-specific rounding and HDR fallback", "Android surface compositing"],
        "sources": SOURCES,
        "views": {},
    }
    for view in config["camera"]["views"]:
        view_id = view["id"]
        linear_path = output_dir / "previews" / "scene-linear" / f"{view_id}-offline-full-pbr.exr"
        image = bpy.data.images.load(str(linear_path), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        height, width = image.size[1], image.size[0]
        pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(height, width, 4)
        linear = pixels[..., :3].copy()
        exposed = linear * exposure
        hdr = quantize_r11g11b10f(exposed)
        source_order = analytic_source_order(exposed, multiply, SRGB_TO_REC2020, REC2020_TO_SRGB)
        hdr_only = analytic_source_order(hdr, multiply, SRGB_TO_REC2020, REC2020_TO_SRGB)
        lut_only = sample_lut(lut, exposed)
        hdr_lut = sample_lut(lut, hdr)
        noise = triangle_noise(height, width)[..., None]
        full = np.clip(hdr_lut + noise / 255.0, 0.0, 1.0)
        outputs = {
            "source-order": (source_order, False),
            "hdr-r11g11b10f": (hdr_only, False),
            "lut32": (lut_only, True),
            "hdr-lut32-dither": (full, True),
        }
        paths = {}
        for name, (rgb, is_encoded) in outputs.items():
            path = target_dir / f"{view_id}-{name}.png"
            display_rgb = srgb_eotf(rgb) if is_encoded else rgb
            if not np.isfinite(display_rgb).all():
                raise ValueError(f"Non-finite display pixels in {view_id}-{name}")
            rgba = np.concatenate((display_rgb, np.ones((*display_rgb.shape[:2], 1), dtype=np.float64)), axis=-1)
            save_display_rgb(rgba, path, scene)
            paths[name] = str(path.relative_to(target_dir.parent))
        source_encoded = srgb_oetf(source_order)
        hdr_encoded = srgb_oetf(hdr_only)
        report["views"][view_id] = {
            "linearMaster": str(linear_path.relative_to(output_dir)),
            "outputs": paths,
            "sourceOrderToHdrMae8Bit": encoded_mae(source_encoded, hdr_encoded),
            "sourceOrderToLutMae8Bit": encoded_mae(source_encoded, lut_only),
            "lutOnlyToHdrLutMae8Bit": encoded_mae(lut_only, hdr_lut),
            "hdrLutToDitheredMae8Bit": encoded_mae(hdr_lut, full),
            "hdrQuantizationRelativeRmse": float(np.sqrt(np.mean(((hdr - exposed) / np.maximum(np.abs(exposed), 1e-6)) ** 2))),
            "maxAbsDitherCodeValue": float(np.max(np.abs(full - hdr_lut)) * 255.0),
        }
        bpy.data.images.remove(image)
        print(f"DISPLAY_DIAGNOSTIC {view_id}", flush=True)
    path = target_dir / "report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"DISPLAY_DIAGNOSTIC_COMPLETE {path}", flush=True)


if __name__ == "__main__":
    main()
