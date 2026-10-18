#!/usr/bin/env python3
"""Build a room's object list from the reconstruction's room_layout.json.

python3 web/scripts/room_objects.py <room_preview dir>                # writes <dir>/room_objects.json
python3 web/scripts/room_objects.py <dir> --out other.json
python3 web/scripts/room_objects.py <dir> --joints <run>/realism_authoring/room/Objects

Input: room_layout.json (Blender Z-up, metres) and, when present, Room.glb next to it.
Output: every object with its role (structure / opening / fixture / furniture), the movable
group it belongs to (an object rebuilt on its own, `rebuilt` in the layout, is its own group), how it is mounted (floor / wall / ceiling), the wall it hangs on, and its
bounding box converted to the glTF frame the web editor uses (Y-up: (x, y, z) -> (x, z, -y)).
With --joints (default: ../room/Objects beside the room_preview dir, when it exists), also the parts
that open: the hinges and slides of the reconstruction's sim/<Object>.urdf files, kept only where
Room.glb has the part with its origin on the joint, so the editor can turn it about that origin.
Standard library only; the GLB's JSON is read, never modified.
"""
import argparse
import json
import math
import struct
import sys
import xml.etree.ElementTree as ElementTree
from pathlib import Path

FORMAT = 'roomcanvas-room-objects'
VERSION = 1

# Room shell. The reconstruction names these Wall<N>, Floor<N>, Ceiling<N>.
STRUCTURE = {'wall', 'floor', 'ceiling', 'bulkhead', 'boxed_services', 'column', 'beam'}
OPENINGS = {'door', 'window'}
# Built into the room: they stay when furniture moves or the room is emptied.
FIXED = {'socket', 'switch', 'vent', 'light', 'light_fixture', 'detector', 'ceiling_grid', 'cable', 'conduit',
         'curtain', 'radiator', 'air_conditioner', 'trim', 'skirting', 'trunking', 'electrical_trunking', 'environment'}


def to_y_up(point):
    x, y, z = point
    return [x, z, -y]


def glb_document(path):
    """The GLB's JSON chunk; the binary chunk is not read."""
    with open(path, 'rb') as file:
        magic, version, _ = struct.unpack('<4sII', file.read(12))
        if magic != b'glTF' or version != 2:
            raise ValueError(f'{path} is not a glTF 2.0 binary')
        length, kind = struct.unpack('<II', file.read(8))
        if kind != 0x4E4F534A:
            raise ValueError(f'{path} does not start with a JSON chunk')
        return json.loads(file.read(length))


def glb_node_names(path):
    return {node.get('name') for node in glb_document(path).get('nodes', [])}


def urdf_joints(objects_dir):
    """Hinges and slides of the reconstruction's sim/<Object>.urdf files, in the URDF's Z-up frame."""
    for path in sorted(Path(objects_dir).glob('*/*/sim/*.urdf')):
        for joint in ElementTree.parse(path).getroot().iter('joint'):
            if joint.get('type') not in ('revolute', 'prismatic'):
                continue
            origin, axis, limit = joint.find('origin'), joint.find('axis'), joint.find('limit')
            numbers = lambda element, key, default: [float(v) for v in (element.get(key) if element is not None else default).split()]
            yield {'urdf': path.name, 'type': joint.get('type'), 'parent': joint.find('parent').get('link'),
                   'child': joint.find('child').get('link'), 'xyz': numbers(origin, 'xyz', '0 0 0'),
                   'rpy': numbers(origin, 'rpy', '0 0 0'), 'axis': numbers(axis, 'xyz', '1 0 0'),
                   'lower': float(limit.get('lower', 0)), 'upper': float(limit.get('upper', 0))}


def place_joints(joints, document, object_nodes, tolerance=.01):
    """Joints whose part is one GLB node sitting on its joint: the part's own origin is the joint's
    origin in its parent's frame (the URDF base link: a cabinet's carcass, a door's frame), and the
    part itself is neither rotated nor scaled. That parent may be rotated and stretched to the scan;
    the editor swings the part rigidly in the world. Returns the kept joints in the editor's Y-up
    frame, and a reason for each one left out."""
    nodes = document.get('nodes', [])
    parent = {child: index for index, node in enumerate(nodes) for child in node.get('children', [])}
    kept, skipped = [], []
    for joint in joints:
        found = [index for index, node in enumerate(nodes) if node.get('name') == joint['child']]
        if len(found) != 1:
            skipped.append(f'{joint["urdf"]}: {joint["child"]} is {"missing from" if not found else "not unique in"} Room.glb')
            continue
        node = nodes[found[0]]
        owner = parent.get(found[0])
        while owner is not None and nodes[owner].get('name') not in object_nodes:
            owner = parent.get(owner)
        if owner is None:
            skipped.append(f'{joint["urdf"]}: {joint["child"]} is not under an object of the layout')
            continue
        if ('matrix' in node or any(abs(v) > 1e-6 for v in node.get('rotation', [0, 0, 0, 1])[:3])
                or any(abs(v - 1) > 1e-6 for v in node.get('scale', [1, 1, 1])) or any(abs(v) > 1e-9 for v in joint['rpy'])):
            skipped.append(f'{joint["urdf"]}: {joint["child"]} is rotated or scaled against its joint')
            continue
        offset = math.dist(node.get('translation', [0, 0, 0]), to_y_up(joint['xyz']))
        if offset > tolerance:
            skipped.append(f'{joint["urdf"]}: {joint["child"]} sits {offset:.3f} m from its joint')
            continue
        kept.append({'node': joint['child'], 'object': nodes[owner]['name'], 'type': joint['type'],
                     'axis': [v + 0.0 for v in to_y_up(joint['axis'])], 'lower': joint['lower'], 'upper': joint['upper']})
    return kept, skipped


def nearest_wall(item, walls, reach=.3):
    """The wall whose box holds a door or window that records none (older reconstructions)."""
    center = [(low + high) / 2 for low, high in zip(item['bbox_min'], item['bbox_max'])]
    def distance(wall):
        return sum(max(wall['bbox_min'][k] - center[k], 0, center[k] - wall['bbox_max'][k]) ** 2 for k in (0, 1)) ** .5
    near = [wall for wall in walls if distance(wall) <= reach]
    return min(near, key=distance)['id'] if near else None


def build(layout, node_names=None, names=None, joints=None):
    """names: hand-written display names by group id, kept from an earlier room_objects.json."""
    objects = {item['id']: item for item in layout['objects']}
    if len(objects) != len(layout['objects']):
        raise ValueError('room_layout.json has duplicate object ids')
    walls = [item for item in layout['objects'] if item['category'] == 'wall']
    opening_wall = {item['id']: nearest_wall(item, walls) for item in layout['objects']
                    if item['category'] in OPENINGS and not item.get('attached_to') and not item.get('rests_on')}

    def parent(item):
        # attached_to is the stronger relation: a socket on a cabinet moves with the cabinet.
        return item.get('attached_to') or item.get('rests_on') or opening_wall.get(item['id'])

    def chain(item):
        """The object, then each thing it rests on or hangs from, up to the room shell."""
        seen = []
        while item is not None:
            if item['id'] in seen:
                raise ValueError(f'support cycle: {" -> ".join(seen + [item["id"]])}')
            seen.append(item['id'])
            if item['category'] in STRUCTURE:
                break
            above = parent(item)
            if above is not None and above not in objects:
                raise ValueError(f'{item["id"]} refers to unknown object {above}')
            item = objects.get(above)
        return [objects[name] for name in seen]

    def wall_of(item):
        """The wall an object hangs on, through shell parts too (a curtain on a door bulkhead)."""
        seen = set()
        while item is not None and item['id'] not in seen:
            if item['category'] == 'wall':
                return item['id']
            seen.add(item['id'])
            item = objects.get(parent(item))
        return None

    def classify(owner):
        """Role and mount of a top-level object (one resting on or hanging from the shell)."""
        category = owner['category']
        if category in STRUCTURE:
            return 'structure', None
        if category in OPENINGS:
            return 'opening', 'wall'
        base = objects.get(parent(owner)) if parent(owner) else None
        mount = {'wall': 'wall', 'ceiling': 'ceiling', 'bulkhead': 'ceiling'}.get(base and base['category'], 'floor')
        # The editor has no ceiling mounts; a ceiling item is part of the room.
        if category in FIXED or mount == 'ceiling':
            return 'fixture', mount
        return 'furniture', mount

    records = []
    for item in layout['objects']:
        path = chain(item)
        # Group owner: the outermost object that is not shell. Contents move with it. An object
        # rebuilt on its own (the small-object pass) is its own group, with what stands on it:
        # it moves alone, and the editor still carries it along when its support moves.
        owner = next((step for step in path if step.get('rebuilt') and step['category'] not in STRUCTURE),
                     next((step for step in reversed(path) if step['category'] not in STRUCTURE), item))
        if item['category'] in STRUCTURE:
            owner = item
        role, mount = classify(owner)
        if item is not owner and role == 'opening':
            role = 'fixture'  # e.g. a blind hung on a window frame stays with the window
        wall = wall_of(item)
        low, high = to_y_up(item['bbox_min']), to_y_up(item['bbox_max'])
        records.append({
            'id': item['id'],
            'node': item.get('handle') or item['id'],
            'category': item['category'],
            'role': role,
            'group': owner['id'],
            'mount': mount if item is owner else None,
            'wall': wall,
            'rests_on': item.get('rests_on'),
            'attached_to': item.get('attached_to'),
            'support_part': item.get('support_part'),
            'placeable_surface': bool(item.get('placeable_surface')),
            **({'rebuilt': item['rebuilt']} if item.get('rebuilt') else {}),
            'bbox_min': [min(a, b) for a, b in zip(low, high)],
            'bbox_max': [max(a, b) for a, b in zip(low, high)],
        })

    if node_names is not None:
        missing = [record['node'] for record in records if record['node'] not in node_names]
        if missing:
            raise ValueError(f'Room.glb has no node for: {", ".join(missing)}')

    groups = []
    by_id = {record['id']: record for record in records}
    for record in records:
        if record['group'] != record['id'] or record['role'] != 'furniture':
            continue
        members = [other['id'] for other in records if other['group'] == record['id']]
        # Parts things can stand on: named support parts (a bookcase shelf), else members that
        # are placeable surfaces themselves (a table, the boards of a wall shelf).
        parts = sorted({other['support_part'] for other in records
                        if other['rests_on'] in members and other['support_part']})
        if not parts:
            parts = [by_id[member]['node'] for member in members if by_id[member]['placeable_surface']]
        group = {'id': record['id'], 'category': record['category'], 'mount': record['mount'],
                 'wall': record['wall'], 'members': members, 'support_parts': parts}
        if (names or {}).get(record['id']):
            group['name'] = names[record['id']]
        groups.append(group)

    def ids(category):
        return [record['id'] for record in records if record['category'] == category]

    floors = ids('floor')
    if len(floors) != 1:
        raise ValueError(f'expected one floor, found {floors or "none"}')
    openings = {}
    for record in records:
        if record['role'] == 'opening' and record['group'] == record['id'] and record['wall']:
            openings.setdefault(record['wall'], []).append(record['id'])
    unplaced = [record['id'] for record in records
                if record['role'] == 'opening' and record['group'] == record['id'] and not record['wall']]
    if unplaced:
        raise ValueError(f'openings not attached to a wall: {", ".join(unplaced)}')
    for group in groups:
        if group['mount'] == 'wall' and group['wall'] not in by_id:
            raise ValueError(f'{group["id"]} is wall-mounted but its wall is unknown')

    return {
        'format': FORMAT,
        'version': VERSION,
        'scene': layout.get('scene'),
        'frame': {'up': 'Y', 'units': 'meters', 'from': 'room_layout.json Z-up via (x, y, z) -> (x, z, -y)'},
        'floor': floors[0],
        'walls': ids('wall'),
        'ceiling': ids('ceiling'),
        'openings': openings,
        'groups': sorted(groups, key=lambda group: group['id']),
        'objects': records,
        **({'joints': joints} if joints else {}),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('room_dir', type=Path, help='directory with room_layout.json (and Room.glb)')
    parser.add_argument('--out', type=Path, help='default: <room_dir>/room_objects.json')
    parser.add_argument('--joints', type=Path, help='the run\'s room/Objects directory (default: ../room/Objects, if any)')
    args = parser.parse_args(argv)
    room_dir = args.room_dir.expanduser().resolve()
    layout = json.loads((room_dir / 'room_layout.json').read_text())
    glb = room_dir / 'Room.glb'
    out = args.out or room_dir / 'room_objects.json'
    # Display names are written by hand into room_objects.json; regenerating keeps them.
    names = {}
    if out.is_file():
        names = {group['id']: group['name'] for group in json.loads(out.read_text()).get('groups', []) if group.get('name')}
    objects_dir = args.joints.expanduser().resolve() if args.joints else room_dir.parent / 'room' / 'Objects'
    joints = []
    if objects_dir.is_dir():
        if not glb.is_file():
            parser.error('joints need Room.glb beside room_layout.json')
        handles = {item.get('handle') or item['id'] for item in layout['objects']}
        joints, skipped = place_joints(list(urdf_joints(objects_dir)), glb_document(glb), handles)
        for reason in skipped:
            print(f'joint left out: {reason}', file=sys.stderr)
    elif args.joints:
        parser.error(f'{objects_dir} is not a directory')
    result = build(layout, glb_node_names(glb) if glb.is_file() else None, names, joints)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n')
    counts = {}
    for record in result['objects']:
        counts[record['role']] = counts.get(record['role'], 0) + 1
    movable = ', '.join(f'{group["id"]}({len(group["members"])})' for group in result['groups'])
    print(f'{out}: {len(result["objects"])} objects {counts}; {len(result["groups"])} movable groups: {movable}; '
          f'{len(joints)} parts open: {", ".join(joint["node"] for joint in joints) or "none"}')
    if not glb.is_file():
        print('warning: Room.glb not found, node names were not checked', file=sys.stderr)


if __name__ == '__main__':
    main()
