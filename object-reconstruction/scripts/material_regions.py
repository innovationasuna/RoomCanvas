"""Opt-in material controls for an existing baked MV GLB; geometry bytes stay intact.

Manual region masks and procedural normals are illustrative parameters, not material
reconstruction. Estimated maps must come from a separately recorded model run.
"""
import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import time


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_glb(path):
    data = Path(path).read_bytes()
    if len(data) < 20 or struct.unpack('<4sII', data[:12]) != (b'glTF', 2, len(data)):
        raise ValueError('Expected a complete glTF 2 binary')
    chunks, cursor = {}, 12
    while cursor < len(data):
        length, kind = struct.unpack('<I4s', data[cursor:cursor+8])
        if length % 4 or cursor+8+length > len(data) or kind in chunks:
            raise ValueError('Invalid or duplicate GLB chunk')
        chunks[kind] = data[cursor+8:cursor+8+length]
        cursor += 8+length
    if set(chunks) != {b'JSON', b'BIN\0'}:
        raise ValueError('Expected embedded JSON and BIN chunks only')
    doc = json.loads(chunks[b'JSON'])
    if len(doc.get('buffers', [])) != 1 or 'uri' in doc['buffers'][0]:
        raise ValueError('Expected one embedded buffer')
    return data, doc, chunks[b'BIN\0']


def image_bytes(doc, binary, texture):
    image = doc['images'][doc['textures'][texture]['source']]
    view = doc['bufferViews'][image['bufferView']]
    start = view.get('byteOffset', 0)
    return binary[start:start+view['byteLength']]


def accessor(doc, binary, index):
    import numpy as np
    value = doc['accessors'][index]
    if value.get('sparse') or value.get('normalized'):
        raise ValueError('Sparse or normalized accessor not supported by this trial')
    view = doc['bufferViews'][value['bufferView']]
    dtype = np.dtype({5121: '<u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}[value['componentType']])
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[value['type']]
    offset = view.get('byteOffset', 0)+value.get('byteOffset', 0)
    stride = view.get('byteStride', dtype.itemsize*width)
    return np.ndarray((value['count'], width), dtype=dtype, buffer=binary, offset=offset,
                      strides=(stride, dtype.itemsize)).copy()


def write_once(path, data):
    path = Path(path)
    if path.exists():
        if path.read_bytes() != data:
            raise FileExistsError(f'Use a new result directory: {path}')
    else:
        path.write_bytes(data)


def patch_material(source, destination, *, mr=None, normal=None, base_color=None, origin):
    original, doc, binary = read_glb(source)
    old_doc, original_binary = copy.deepcopy(doc), binary
    if len(doc['materials']) != 1:
        raise ValueError('This controlled trial requires one source material')
    material = doc['materials'][0]
    pbr = material['pbrMetallicRoughness']
    old_color = image_bytes(doc, binary, pbr['baseColorTexture']['index'])
    uv_set = pbr['baseColorTexture'].get('texCoord', 0)
    def append_image(image, label):
        nonlocal binary
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        encoded = stream.getvalue()
        binary += b'\0'*(-len(binary) % 4)
        view = len(doc['bufferViews'])
        doc['bufferViews'].append(dict(buffer=0, byteOffset=len(binary), byteLength=len(encoded)))
        binary += encoded
        image_index = len(doc['images'])
        doc['images'].append(dict(bufferView=view, mimeType='image/png', name=label))
        texture = len(doc['textures'])
        doc['textures'].append(dict(source=image_index))
        return dict(index=texture, texCoord=uv_set)
    if mr is not None:
        pbr.update(metallicRoughnessTexture=append_image(mr, 'metallic-roughness'),
                   roughnessFactor=1.0, metallicFactor=1.0)
    if normal is not None:
        material['normalTexture'] = dict(append_image(normal, 'procedural-normal'), scale=1.0)
    if base_color is not None:
        pbr['baseColorTexture'] = append_image(base_color, 'estimated-basecolor')
    material.setdefault('extras', {})['roomcanvas_material_trial'] = origin
    doc['buffers'][0]['byteLength'] = len(binary)
    encoded_json = json.dumps(doc, separators=(',', ':'), ensure_ascii=True).encode()
    encoded_json += b' '*(-len(encoded_json) % 4)
    padded_binary = binary+b'\0'*(-len(binary) % 4)
    size = 12+8+len(encoded_json)+8+len(padded_binary)
    encoded = struct.pack('<4sII', b'glTF', 2, size)+struct.pack('<I4s', len(encoded_json), b'JSON')+encoded_json
    encoded += struct.pack('<I4s', len(padded_binary), b'BIN\0')+padded_binary
    write_once(destination, encoded)
    _, checked, checked_binary = read_glb(destination)
    keys = ('meshes', 'nodes', 'scenes', 'scene', 'accessors')
    assert all(old_doc.get(key) == checked.get(key) for key in keys)
    assert old_doc['bufferViews'] == checked['bufferViews'][:len(old_doc['bufferViews'])]
    assert checked_binary[:len(original_binary)] == original_binary
    same_color = old_color == image_bytes(checked, checked_binary,
                                        checked['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['index'])
    if base_color is None:
        assert same_color
    return dict(path=str(Path(destination).resolve()), bytes=len(encoded), source_sha256=digest(original),
                sha256=digest(encoded), original_binary_prefix_preserved=True,
                geometry_uv_nodes_preserved=True, base_color_preserved=same_color, origin=origin)


def manual_maps(doc, binary, profile):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    from scipy.ndimage import distance_transform_edt
    material = doc['materials'][0]['pbrMetallicRoughness']
    base = Image.open(io.BytesIO(image_bytes(doc, binary, material['baseColorTexture']['index']))).convert('RGB')
    pixels = np.asarray(base, dtype=np.float32)/255
    maximum, minimum = pixels.max(axis=2), pixels.min(axis=2)
    saturation = (maximum-minimum)/np.maximum(maximum, 1e-6)
    if profile == 'plush':
        # Locate the coloured heart and dark markings; parameters below are assigned
        # explicitly, never inferred as physical truth from brightness or colour.
        coloured = (pixels[..., 0] > pixels[..., 1]*1.4) & (pixels[..., 0] > pixels[..., 2]*1.4)
        dark = maximum < .22
        roughness = np.full(maximum.shape, .92, dtype=np.float32)
        roughness[coloured], roughness[dark] = .72, .86
        strength = np.full(maximum.shape, .10, dtype=np.float32)
        strength[coloured], strength[dark] = .06, .04
        parameters = dict(body_roughness=.92, coloured_heart_roughness=.72, dark_marking_roughness=.86,
                          metalness=0, assumption='All regions treated as nonmetal fabric; no verified physical values')
    else:
        coloured = (saturation > .22) & (maximum > .12)
        roughness = np.where(coloured, .60, .90).astype(np.float32)
        strength = np.where(coloured, .05, .10).astype(np.float32)
        parameters = dict(body_roughness=.90, coloured_cushion_roughness=.60, metalness=0,
                          assumption='Fabric body and smoother coloured cushion, illustrative values, not measurement')
    roughness = np.asarray(Image.fromarray(np.uint8(roughness*255)).filter(ImageFilter.GaussianBlur(1)), dtype=np.uint8)
    mr = np.zeros((*roughness.shape, 3), dtype=np.uint8)
    mr[..., 1] = roughness
    width, height = base.size
    primitive = doc['meshes'][0]['primitives'][0]
    faces = accessor(doc, binary, primitive['indices']).reshape(-1, 3)
    uv = accessor(doc, binary, primitive['attributes']['TEXCOORD_0'])
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges.sort(axis=1)
    edges, count = np.unique(edges, axis=0, return_counts=True)
    edges = edges[count == 1]
    boundary = Image.new('L', base.size, 0)
    draw = ImageDraw.Draw(boundary)
    xy = uv*np.array([width-1, height-1])
    for edge in edges:
        draw.line([tuple(xy[edge[0]]), tuple(xy[edge[1]])], fill=255, width=2)
    fade = np.clip((distance_transform_edt(np.asarray(boundary) == 0)-1)/3, 0, 1).astype(np.float32)
    yy, xx = np.mgrid[:height, :width]
    phase_x, phase_y = xx*(2*np.pi/8), yy*(2*np.pi/8)
    nx = strength*fade*np.sin(phase_x)*np.cos(phase_y)
    ny = strength*fade*np.cos(phase_x)*np.sin(phase_y)
    nz = np.sqrt(np.maximum(0, 1-nx*nx-ny*ny))
    normal = np.uint8(np.clip(np.stack([nx, ny, nz], axis=-1)*.5+.5, 0, 1)*255+.5)
    return base, Image.fromarray(mr), Image.fromarray(normal), Image.fromarray(np.uint8(coloured)*255), parameters


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profile', choices=('plush', 'sofa'), required=True)
    parser.add_argument('--estimated-maps', type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    original, doc, binary = read_glb(args.input)
    report_path = output/'variants.json'
    report = json.loads(report_path.read_text()) if report_path.exists() else dict(
        profile=args.profile, source=str(args.input.resolve()), source_sha256=digest(original), variants={})
    assert report['source_sha256'] == digest(original)
    if args.estimated_maps:
        import numpy as np
        from PIL import Image
        maps = args.estimated_maps
        receipt = json.loads((maps/'result.json').read_text())
        if receipt.get('status') != 'complete' or receipt.get('model_sha256') != digest(original):
            raise ValueError('Estimated maps do not belong to this exact completed source GLB')
        mr = Image.open(maps/'predicted-metallic-roughness.png').convert('RGB')
        base = Image.open(maps/'predicted-basecolor.png').convert('RGB')
        nonmetal = np.asarray(mr).copy()
        nonmetal[..., 2] = 0
        variants = [
            ('estimated_roughness', Image.fromarray(nonmetal), None, None,
             dict(method='trellis_estimated_roughness', metallic_override='nonmetal fabric assumption')),
            ('estimated_mr', mr, None, None, dict(method='trellis_estimated_metallic_roughness')),
            ('estimated_full', mr, None, base, dict(method='trellis_estimated_basecolor_and_mr',
                                                 note='Separate colour-change control, not a material-only comparison')),
        ]
        report['estimated_source'] = receipt
    else:
        base, mr, normal, mask, params = manual_maps(doc, binary, args.profile)
        for image, name in [(mr, 'manual-metallic-roughness.png'), (normal, 'procedural-normal.png'), (mask, 'manual-region-mask.png')]:
            stream = io.BytesIO()
            image.save(stream, format='PNG')
            write_once(output/name, stream.getvalue())
        report['manual_parameters'] = params
        variants = [
            ('manual_roughness', mr, None, None, dict(method='manually_assigned_roughness', parameters=params)),
            ('procedural_normal', None, normal, None, dict(method='procedural_uv_weave_normal',
                note='Synthetic shading control; not recovered fabric detail; faded near UV boundaries')),
            ('manual_combined', mr, normal, None, dict(method='manual_roughness_and_procedural_normal', parameters=params)),
        ]
    for name, mr, normal, base, origin in variants:
        origin.update(experimental=True, profile=args.profile, predicted_normal=False)
        report['variants'][name] = patch_material(args.input, output/f'{name}.glb', mr=mr,
                                                  normal=normal, base_color=base, origin=origin)
    report['last_export_seconds'] = round(time.monotonic()-started, 3)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(dict(profile=args.profile, variants=list(report['variants']),
                         elapsed_seconds=report['last_export_seconds'])))


if __name__ == '__main__':
    main()
