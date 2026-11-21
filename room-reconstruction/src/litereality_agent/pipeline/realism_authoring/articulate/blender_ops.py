"""Blender side of the articulation pass. Runs inside Blender on an existing Room.blend:

    blender -b Room.blend --python blender_ops.py -- request.json

request.json holds one operation:

  {"op": "views", "items": ["Pedestal0", ...], "out_dir": ...}
      For each object: its frame (origin and turn of its room_id handle, unscaled), its box in that
      frame, the parts that already open, and three renders of it alone: front.png (looking
      along +Y), side.png (along +X), both orthographic with a known metric frame, and
      perspective_0..3.png (from the four diagonals). Writes <out_dir>/<id>/views.json.

  {"op": "apply", "out_dir": ..., "items": [{"id", "parts": [...]}]}
      Cut each part (judge.parse_plan) out of the object's meshes, put it under a new empty
      `<id>_Hinges` (the object's frame) with its origin on the joint, put a dark cavity behind a
      part that covered a hollow (and a box behind a drawer front), and add a closed → open →
      closed action per part; small pieces the cut left touching nothing of the object go
      (drop_loose). Saves Room.blend and Room.glb to out_dir and writes apply.json.

  {"op": "check", "items": [...ids], "out_dir": ...}
      For each object, alone, from its four diagonals: closed (frame 1) and fully open (frame 30).
      Writes <out_dir>/<id>/{closed,open}_{0..3}.png.

Parts that already open (objects carrying `articulation_type`, as set_articulation leaves them)
are never cut; everything outside the listed objects is left as it was.
"""

import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

OPEN_FRAME, END_FRAME = 30, 60
RES_ORTHO, RES_VIEW = 900, (720, 540)


# ---------------------------------------------------------------- the room's objects
def handles():
    return {o["room_id"]: o for o in bpy.data.objects if o.get("room_id")}


def owner(obj):
    while obj is not None and not obj.get("room_id"):
        obj = obj.parent
    return obj


def own_objects(handle):
    return [handle] + [o for o in handle.children_recursive if owner(o) == handle]


def moving(objects):
    """Objects that already open, and everything under them."""
    out = set()
    for obj in objects:
        if "articulation_type" in obj.keys():
            out.add(obj)
            out.update(obj.children_recursive)
    return out


def frame_of(handle):
    """The object's frame: the handle's origin and turn, without its scale."""
    loc, rot, _ = handle.matrix_world.decompose()
    return Matrix.Translation(loc) @ rot.to_matrix().to_4x4()


def world_points(obj):
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    points = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", points)
    obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    m = np.array(obj.matrix_world)
    return points.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def local_box(meshes, frame):
    inverse = np.array(frame.inverted())
    points = np.concatenate([world_points(o) for o in meshes]) if meshes else np.zeros((1, 3))
    local = points @ inverse[:3, :3].T + inverse[:3, 3]
    return local.min(0), local.max(0)


# ---------------------------------------------------------------- rendering an object alone
class Stage:
    """The object alone: everything else hidden from render, a plain world, a sun, a camera."""

    def __init__(self, keep):
        scene = bpy.context.scene
        self.scene = scene
        self.hidden = {o.name: o.hide_render for o in bpy.data.objects}
        for obj in bpy.data.objects:
            obj.hide_render = obj not in keep
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 24
        scene.cycles.use_denoising = True
        scene.render.film_transparent = False
        self.world = bpy.data.worlds.new("articulate_world")
        self.world.use_nodes = True
        background = self.world.node_tree.nodes["Background"]
        background.inputs[0].default_value = (0.8, 0.81, 0.78, 1)
        background.inputs[1].default_value = 1.0
        self.old_world, scene.world = scene.world, self.world
        self.sun = bpy.data.objects.new("articulate_sun", bpy.data.lights.new("articulate_sun", "SUN"))
        self.sun.data.energy = 2.5
        scene.collection.objects.link(self.sun)
        self.camera = bpy.data.objects.new("articulate_cam", bpy.data.cameras.new("articulate_cam"))
        scene.collection.objects.link(self.camera)
        self.old_camera, scene.camera = scene.camera, self.camera

    def shoot(self, path, location, target, frame, ortho=None, size=RES_VIEW):
        scene = self.scene
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.render.resolution_percentage = 100
        cam = self.camera
        cam.data.type = "ORTHO" if ortho else "PERSP"
        if ortho:
            cam.data.ortho_scale = ortho
        else:
            cam.data.lens = 40
        cam.location = location
        direction = Vector(target) - Vector(location)
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        self.sun.rotation_euler = (math.radians(50), math.radians(10),
                                   math.atan2(direction.y, direction.x) + math.radians(60))
        cam.data.clip_end = 1000
        scene.frame_set(frame)
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)

    def close(self):
        for obj in bpy.data.objects:
            if obj.name in self.hidden:
                obj.hide_render = self.hidden[obj.name]
        self.scene.world, self.scene.camera = self.old_world, self.old_camera
        bpy.data.objects.remove(self.sun, do_unlink=True)
        bpy.data.objects.remove(self.camera, do_unlink=True)
        bpy.data.worlds.remove(self.world)


def views(request):
    live = handles()
    for oid in request["items"]:
        out = os.path.join(request["out_dir"], oid)
        os.makedirs(out, exist_ok=True)
        handle = live.get(oid)
        if handle is None:
            with open(os.path.join(out, "views.json"), "w") as fh:
                json.dump({"error": "no such object"}, fh)
            continue
        own = own_objects(handle)
        meshes = [o for o in own if o.type == "MESH"]
        frame = frame_of(handle)
        low, high = local_box(meshes, frame)
        centre_local = (low + high) / 2
        centre = frame @ Vector(centre_local)
        span = float(max(high - low)) * 1.2 + 0.05
        rot = frame.to_3x3()
        stage = Stage(set(own))
        meta = {"frame": {"location": list(frame.translation), "rotation":
                          list(frame.to_quaternion())},
                "box_min": [round(float(v), 4) for v in low],
                "box_max": [round(float(v), 4) for v in high],
                "existing": sorted(o.name for o in moving(own) if "articulation_type" in o.keys()),
                "pixels": RES_ORTHO, "span_m": span, "views": {}}
        try:
            # front: from -Y looking +Y (X right); side: from -X looking +X (-Y right)
            for name, back, right in (("front", Vector((0, -1, 0)), [1, 0, 0]),
                                      ("side", Vector((-1, 0, 0)), [0, -1, 0])):
                location = centre + rot @ back * (span * 4 + 2)
                stage.shoot(os.path.join(out, f"{name}.png"), location, centre, 1, ortho=span,
                            size=(RES_ORTHO, RES_ORTHO))
                meta["views"][name] = {"center": [round(float(v), 5) for v in centre_local],
                                       "right": right}
            # from all four diagonals: which side is the front is not known yet
            size = float(np.linalg.norm(high - low))
            for n, (dx, dy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
                location = centre + rot @ Vector((dx, dy, 0.8)).normalized() * size * 1.5
                stage.shoot(os.path.join(out, f"perspective_{n}.png"), location, centre, 1,
                            size=(480, 360))
        finally:
            stage.close()
        with open(os.path.join(out, "views.json"), "w") as fh:
            json.dump(meta, fh, indent=1)
        print(f"  views {oid}: box {meta['box_min']} .. {meta['box_max']}")


# ---------------------------------------------------------------- cutting
def dark_material():
    material = bpy.data.materials.get("Articulate_Cavity")
    if material is None:
        material = bpy.data.materials.new("Articulate_Cavity")
        material.use_nodes = True
        bsdf = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (0.012, 0.011, 0.010, 1)
        bsdf.inputs["Roughness"].default_value = 0.8
    return material


def split(obj, frame, low, high):
    """Cut obj's mesh at the box faces (given in the object frame); return a new world-space
    object with the faces inside the box, removing them from obj. None if nothing is inside."""
    if obj.data.users > 1:
        obj.data = obj.data.copy()
    to_local = obj.matrix_world.inverted() @ frame
    normal_to_local = obj.matrix_world.to_3x3().transposed() @ frame.to_3x3()
    to_frame = frame.inverted() @ obj.matrix_world
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for axis in range(3):
        for value in (low[axis], high[axis]):
            co, no = Vector((0, 0, 0)), Vector((0, 0, 0))
            co[axis], no[axis] = value, 1
            bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                                   plane_co=to_local @ co, plane_no=(normal_to_local @ no).normalized())
    bm.faces.index_update()
    inside = [f for f in bm.faces
              if all(low[i] - 1e-4 <= (to_frame @ f.calc_center_median())[i] <= high[i] + 1e-4
                     for i in range(3))]
    if not inside:
        bm.free()
        return None
    keep_ids = {f.index for f in inside}
    part_bm = bm.copy()  # same face order as bm
    part_bm.faces.index_update()
    bmesh.ops.delete(part_bm, geom=[f for f in part_bm.faces if f.index not in keep_ids],
                     context="FACES")
    bmesh.ops.delete(bm, geom=inside, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    mesh = obj.data.copy()
    part_bm.to_mesh(mesh)
    part_bm.free()
    piece = bpy.data.objects.new(obj.name + "_cut", mesh)
    bpy.context.scene.collection.objects.link(piece)
    piece.matrix_world = obj.matrix_world.copy()
    return piece


def join(pieces, name):
    bpy.ops.object.select_all(action="DESELECT")
    for piece in pieces:
        piece.data.transform(piece.matrix_world)  # into world space
        piece.matrix_world = Matrix.Identity(4)
        piece.select_set(True)
    bpy.context.view_layer.objects.active = pieces[0]
    if len(pieces) > 1:
        bpy.ops.object.join()
    part = bpy.context.view_layer.objects.active
    part.name = part.data.name = name
    return part


def cavity(name, low, high, body_centre, parent, depth=0.12, inset=0.03):
    """A dark box behind the part's opening, on the body's side of its thinnest axis. Inset from
    the opening's edges: a front often overlaps the carcass, and a box as wide as the front would
    poke out of its sides; around the inset the carcass's own inner walls show."""
    low, high = np.array(low, float), np.array(high, float)
    thin = int(np.argmin(high - low))
    for i in range(3):
        if i != thin:
            margin = min(inset, 0.25 * (high[i] - low[i]))
            low[i], high[i] = low[i] + margin, high[i] - margin
    if body_centre[thin] < (low[thin] + high[thin]) / 2:
        low[thin], high[thin] = low[thin] - depth, low[thin] - inset
    else:
        low[thin], high[thin] = high[thin] + inset, high[thin] + depth
    corners = [(x, y, z) for x in (low[0], high[0]) for y in (low[1], high[1])
               for z in (low[2], high[2])]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(corners, [], faces)
    mesh.materials.append(dark_material())
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent  # its vertices are already in the hinge frame
    return obj


def drawer_box(part, spec, low, high, body_extent):
    """The drawer behind a cut front: bottom, sides and back, open at the top, moving with it."""
    k = max(range(3), key=lambda i: abs(spec["axis"][i]))
    outward = spec["axis"][k] > 0
    origin = np.array(spec["origin"], float)
    lo, hi = np.array(low, float) - origin, np.array(high, float) - origin
    inner = lo[k] if outward else hi[k]
    depth = min(float(spec["limit"]), 0.85 * float(body_extent[k]))
    back = inner - depth if outward else inner + depth
    others = [i for i in range(3) if i != k]
    span = {i: (lo[i] + 0.012, hi[i] - 0.012) for i in others}
    up = 2 if 2 in others else others[-1]  # the open side faces up
    side = [i for i in others if i != up][0]

    def point(along, s, u):
        p = [0.0, 0.0, 0.0]
        p[k], p[side], p[up] = along, s, u
        return tuple(p)

    (s0, s1), (u0, u1) = span[side], span[up]
    a0, a1 = inner, back
    verts = [point(a, s, u) for a in (a0, a1) for s in (s0, s1) for u in (u0, u1)]
    # 0..3 at the front edge, 4..7 at the back; u0 = bottom
    faces = [(0, 2, 6, 4), (0, 1, 5, 4), (2, 3, 7, 6), (4, 5, 7, 6)]  # bottom, side, side, back
    mesh = bpy.data.meshes.new(part.name + "_Box")
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(part.data.materials[0] if part.data.materials else dark_material())
    box = bpy.data.objects.new(part.name + "_Box", mesh)
    for coll in part.users_collection:
        coll.objects.link(box)
    box.parent = part
    return box


def animate(part, spec):
    """closed (frame 1) → fully open (OPEN_FRAME) → closed (END_FRAME), as one action."""
    k = max(range(3), key=lambda i: abs(spec["axis"][i]))
    sign = spec["axis"][k]
    path = "rotation_euler" if spec["joint"] == "revolute" else "location"
    rest = getattr(part, path)[k]
    for frame, amount in ((1, 0.0), (OPEN_FRAME, spec["limit"]), (END_FRAME, 0.0)):
        getattr(part, path)[k] = rest + sign * amount
        part.keyframe_insert(path, index=k, frame=frame)
    getattr(part, path)[k] = rest
    if part.animation_data and part.animation_data.action:
        part.animation_data.action.name = part.name + ("_swing" if spec["joint"] == "revolute"
                                                       else "_slide")


TOUCH = 0.005  # metres: pieces of one object this close touch (the room check's own reach)
LOOSE_SHARE = 0.05  # a piece left touching nothing goes if under this share of the object's surface


def islands(obj):
    """The connected pieces of a mesh object, vertices welded by position (texture seams split the
    mesh, not the surface): [(polygon indices, world vertices, polygons over them, area)]."""
    mesh = obj.data
    co = np.empty(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    m = np.array(obj.matrix_world)
    world = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
    _, weld = np.unique(np.round(world / 1e-5).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    root = list(range(int(weld.max()) + 1 if len(weld) else 0))

    def find(a):
        while root[a] != a:
            root[a] = root[root[a]]
            a = root[a]
        return a

    polygons = [[int(weld[v]) for v in poly.vertices] for poly in mesh.polygons]
    for poly in polygons:
        first = find(poly[0])
        for v in poly[1:]:
            other = find(v)
            if other != first:
                root[other] = first
    groups = {}
    for index, poly in enumerate(polygons):
        groups.setdefault(find(poly[0]), []).append(index)
    out = []
    for faces in groups.values():
        used = sorted({v for i in faces for v in mesh.polygons[i].vertices})
        local = {v: k for k, v in enumerate(used)}
        out.append((faces, world[used], [[local[v] for v in mesh.polygons[i].vertices] for i in faces],
                    sum(mesh.polygons[i].area for i in faces) * abs(np.linalg.det(m[:3, :3])) ** (2 / 3)))
    return out


def drop_loose(owned, removable):
    """After the cut: remove the small pieces of the cut meshes (`removable`) that touch nothing else
    of the object (`owned`, its parts in the closed pose included), e.g. a sliver of the body the
    part's box cut free; the room's check finds such a piece floating. Reached from the largest
    piece and from those on the object's bottom, through pieces that touch (TOUCH)."""
    from mathutils.bvhtree import BVHTree

    rows = [(obj, *piece) for obj in owned if obj.type == "MESH" and len(obj.data.polygons)
            for piece in islands(obj)]
    if len(rows) < 2:
        return []
    trees = [BVHTree.FromPolygons([Vector(v) for v in verts], polys) for _, _, verts, polys, _ in rows]
    low = np.array([verts.min(0) for _, _, verts, _, _ in rows])
    high = np.array([verts.max(0) for _, _, verts, _, _ in rows])
    area = np.array([row[4] for row in rows])
    bottom = low[:, 2].min()
    reached = {int(np.argmax(area))} | {k for k in range(len(rows)) if low[k, 2] <= bottom + TOUCH}
    pending, remaining = list(reached), set(range(len(rows))) - reached

    def touch(i, j):
        if trees[i].overlap(trees[j]):
            return True
        small, large = (i, j) if len(rows[i][2]) <= len(rows[j][2]) else (j, i)
        for v in rows[small][2]:
            hit = trees[large].find_nearest(Vector(v), TOUCH)
            if hit[0] is not None:
                return True
        return False

    while pending and remaining:
        i = pending.pop()
        for j in sorted(remaining):
            gap = np.maximum(0, np.maximum(low[i] - high[j], low[j] - high[i]))
            if np.linalg.norm(gap) <= TOUCH and touch(i, j):
                reached.add(j)
                remaining.discard(j)
                pending.append(j)
    dropped = {}
    for k in sorted(remaining):
        obj, faces = rows[k][0], rows[k][1]
        if obj in removable and area[k] < LOOSE_SHARE * area.sum():
            dropped.setdefault(obj, []).extend(faces)
    for obj, faces in dropped.items():
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i in faces], context="FACES")
        bm.to_mesh(obj.data)
        bm.free()
    return [{"node": obj.name, "faces": len(faces)} for obj, faces in dropped.items()]


def cut_object(handle, parts, report):
    oid = handle["room_id"]
    own = own_objects(handle)
    frozen = moving(own)
    body = [o for o in own if o.type == "MESH" and o not in frozen]
    frame = frame_of(handle)
    low_all, high_all = local_box(body, frame)
    body_centre = (low_all + high_all) / 2
    hinges = bpy.data.objects.new(f"{oid}_Hinges", None)
    hinges.empty_display_size = 0.05
    for coll in handle.users_collection:
        coll.objects.link(hinges)
    hinges.parent = handle
    hinges.matrix_world = frame
    made, cut = [], []
    for spec in parts:
        low, high = spec["box_min"], spec["box_max"]
        pieces = [p for p in (split(o, frame, low, high) for o in body) if p is not None]
        if not pieces:
            report["skipped"].append({"id": oid, "part": spec["name"], "reason": "no faces in box"})
            continue
        part = join(pieces, f"{oid}_{spec['name']}")
        cut.append(part)
        for coll in list(part.users_collection):
            coll.objects.unlink(part)
        for coll in handle.users_collection:
            coll.objects.link(part)
        origin = Vector(spec["origin"])
        # world → hinge frame → relative to the joint
        part.data.transform(Matrix.Translation(-origin) @ frame.inverted())
        k = max(range(3), key=lambda i: abs(spec["axis"][i]))
        if spec.get("open_now"):  # cut in an open pose: back to closed, once, in the mesh
            amount = -spec["axis"][k] * spec["open_now"]
            if spec["joint"] == "revolute":
                part.data.transform(Matrix.Rotation(amount, 4, "XYZ"[k]))
            else:
                shift = Vector((0, 0, 0))
                shift[k] = amount
                part.data.transform(Matrix.Translation(shift))
        part.parent = hinges
        part.matrix_parent_inverse = Matrix.Identity(4)
        part.location, part.rotation_mode = origin, "XYZ"
        part.rotation_euler, part.scale = (0, 0, 0), (1, 1, 1)
        part["articulation_type"] = spec["joint"]
        part["articulation_axis"] = [float(v) for v in spec["axis"]]
        part["limit_min"], part["limit_max"] = 0.0, float(spec["limit"])
        part["joint_origin"] = [float(v) for v in origin]
        animate(part, spec)
        # A hollow behind a part that closed over it: dark, or a drawer box that slides with it.
        if spec.get("covers_opening", True) and not spec.get("open_now"):
            if spec["joint"] == "prismatic":
                drawer_box(part, spec, low, high, high_all - low_all)
            box = cavity(f"{oid}_{spec['name']}_Cavity", low, high, body_centre, hinges)
            for coll in list(box.users_collection):
                coll.objects.unlink(box)
            for coll in handle.users_collection:
                coll.objects.link(box)
        made.append({"name": spec["name"], "node": part.name, "faces": len(part.data.polygons)})
    bpy.context.view_layer.update()
    loose = drop_loose(own_objects(handle), set(body) | set(cut))
    report["cut"].append({"id": oid, "parts": made, **({"loose": loose} if loose else {})})


def export(out_dir):
    bpy.context.scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type in {"MESH", "EMPTY"} and not obj.hide_get():
            obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, "Room.glb"), export_format="GLB",
                              use_selection=True, export_apply=True, export_animations=True,
                              export_cameras=False, export_lights=False)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "Room.blend"))


def apply(request):
    out_dir = request["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    live = handles()
    report = {"cut": [], "skipped": []}
    for item in request["items"]:
        handle = live.get(item["id"])
        if handle is None:
            report["skipped"].append({"id": item["id"], "reason": "no such object"})
            continue
        cut_object(handle, item["parts"], report)
    export(out_dir)
    with open(os.path.join(out_dir, "apply.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"  cut {sum(len(c['parts']) for c in report['cut'])} parts on {len(report['cut'])} objects")


def check(request):
    live = handles()
    for oid in request["items"]:
        handle = live.get(oid)
        if handle is None:
            continue
        out = os.path.join(request["out_dir"], oid)
        os.makedirs(out, exist_ok=True)
        own = own_objects(handle)
        frame = frame_of(handle)
        meshes = [o for o in own if o.type == "MESH"]
        low, high = local_box(meshes, frame)
        centre = frame @ Vector((low + high) / 2)
        size = float(np.linalg.norm(high - low))
        rot = frame.to_3x3()
        stage = Stage(set(own))
        try:
            for state, frame_no in (("closed", 1), ("open", OPEN_FRAME)):
                for n, (dx, dy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
                    location = centre + rot @ Vector((dx, dy, 0.8)).normalized() * size * 1.5
                    stage.shoot(os.path.join(out, f"{state}_{n}.png"), location, centre, frame_no,
                                size=(480, 360))
        finally:
            stage.close()
            bpy.context.scene.frame_set(1)
        print(f"  check renders {oid}")


def main():
    with open(sys.argv[sys.argv.index("--") + 1]) as fh:
        request = json.load(fh)
    {"views": views, "apply": apply, "check": check}[request["op"]](request)
    print("DONE", request["op"])


if __name__ == "__main__":
    main()
