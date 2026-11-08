#!/usr/bin/env python3
import argparse
import hashlib
import json
import struct
from pathlib import Path


def read_glb_json(path):
    with path.open("rb") as source:
        header = source.read(12)
        if len(header) != 12:
            raise ValueError("GLB header is incomplete")
        magic, version, declared_length = struct.unpack_from("<4sII", header)
        if magic != b"glTF" or version != 2:
            raise ValueError("Expected a glTF 2.0 binary file")
        if declared_length != path.stat().st_size:
            raise ValueError("GLB declared length does not match file size")
        chunk_header = source.read(8)
        if len(chunk_header) != 8:
            raise ValueError("GLB JSON chunk is missing")
        chunk_length, chunk_type = struct.unpack_from("<II", chunk_header)
        if chunk_type != 0x4E4F534A:
            raise ValueError("The first GLB chunk is not JSON")
        return json.loads(source.read(chunk_length).decode("utf-8").rstrip("\x00 "))


def png_size(data):
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack_from(">II", data, 16)
    return None


def jpeg_size(data):
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    offset = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            return None
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            return None
        segment_length = struct.unpack_from(">H", data, offset)[0]
        if segment_length < 2 or offset + segment_length > len(data):
            return None
        if marker in sof_markers and segment_length >= 7:
            height, width = struct.unpack_from(">HH", data, offset + 3)
            return width, height
        offset += segment_length
    return None


def primitive_triangle_count(gltf, primitive):
    mode = primitive.get("mode", 4)
    if "indices" in primitive:
        vertex_count = gltf["accessors"][primitive["indices"]]["count"]
    else:
        vertex_count = gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
    if mode == 4:
        return vertex_count // 3
    if mode in {5, 6}:
        return max(0, vertex_count - 2)
    return 0


def inspect(path):
    gltf = read_glb_json(path)
    buffer_views = gltf.get("bufferViews", [])
    binary = path.read_bytes()
    json_chunk_length = 12 + 8 + struct.unpack_from("<I", binary, 12)[0]
    bin_start = json_chunk_length + 8

    mesh_rows = []
    triangle_count = 0
    primitive_vertex_count = 0
    primitive_count = 0
    for mesh_index, mesh in enumerate(gltf.get("meshes", [])):
        mesh_triangles = 0
        for primitive in mesh.get("primitives", []):
            primitive_count += 1
            mesh_triangles += primitive_triangle_count(gltf, primitive)
            primitive_vertex_count += gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
        triangle_count += mesh_triangles
        mesh_rows.append({
            "index": mesh_index,
            "name": mesh.get("name", f"mesh_{mesh_index}"),
            "triangles": mesh_triangles,
        })
    mesh_rows.sort(key=lambda row: row["triangles"], reverse=True)

    image_rows = []
    rgba_bytes = 0
    embedded_image_bytes = 0
    for image_index, image in enumerate(gltf.get("images", [])):
        view = buffer_views[image["bufferView"]] if "bufferView" in image else None
        dimensions = None
        byte_length = 0
        if view is not None:
            byte_length = view.get("byteLength", 0)
            start = bin_start + view.get("byteOffset", 0)
            data = binary[start:start + byte_length]
            dimensions = png_size(data) or jpeg_size(data)
            embedded_image_bytes += byte_length
        width, height = dimensions or (0, 0)
        decoded_bytes = width * height * 4
        rgba_bytes += decoded_bytes
        image_rows.append({
            "index": image_index,
            "name": image.get("name", f"image_{image_index}"),
            "mimeType": image.get("mimeType"),
            "width": width,
            "height": height,
            "embeddedBytes": byte_length,
            "rgba8Bytes": decoded_bytes,
        })

    lights = gltf.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])
    return {
        "file": path.name,
        "sha256": hashlib.sha256(binary).hexdigest(),
        "fileBytes": len(binary),
        "nodes": len(gltf.get("nodes", [])),
        "meshes": len(gltf.get("meshes", [])),
        "primitives": primitive_count,
        "triangles": triangle_count,
        "primitiveVertices": primitive_vertex_count,
        "materials": len(gltf.get("materials", [])),
        "doubleSidedMaterials": sum(bool(material.get("doubleSided", False)) for material in gltf.get("materials", [])),
        "animations": len(gltf.get("animations", [])),
        "skins": len(gltf.get("skins", [])),
        "gltfLightDefinitions": len(lights),
        "gltfLightInstances": sum("KHR_lights_punctual" in node.get("extensions", {}) for node in gltf.get("nodes", [])),
        "images": len(image_rows),
        "embeddedImageBytes": embedded_image_bytes,
        "rgba8Bytes": rgba_bytes,
        "rgba8WithMipmapsBytes": rgba_bytes * 4 // 3,
        "imageDetails": image_rows,
        "largestMeshes": mesh_rows[:20],
    }


def main():
    parser = argparse.ArgumentParser(description="Inspect glTF 2.0 binary rendering cost without external dependencies")
    parser.add_argument("model", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.dumps(inspect(args.model), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report, end="")


if __name__ == "__main__":
    main()
