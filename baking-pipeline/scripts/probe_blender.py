import json
from pathlib import Path

import bpy


def main():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    devices = []
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            preferences.compute_device_type = backend
            preferences.get_devices()
            backend_devices = [
                {"name": device.name, "type": device.type}
                for device in preferences.devices
                if device.type != "CPU"
            ]
            if backend_devices:
                devices.append({"backend": backend, "devices": backend_devices})
        except (TypeError, RuntimeError):
            pass
    report = {
        "blenderVersion": bpy.app.version_string,
        "blenderBuildHash": bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else str(bpy.app.build_hash),
        "pythonVersion": __import__("sys").version,
        "cyclesDevices": devices,
        "bakeProperties": list(bpy.ops.object.bake.get_rna_type().properties.keys()),
        "gltfExportProperties": list(bpy.ops.export_scene.gltf.get_rna_type().properties.keys()),
        "worldHasLightSettings": hasattr(bpy.data.worlds.new("Probe"), "light_settings"),
    }
    output = Path(__file__).resolve().parents[1] / "output" / "environment.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
