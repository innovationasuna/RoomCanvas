"""Blender side of the small-object pass. Runs inside Blender on an existing Room.blend:

    blender -b Room.blend --python blender_ops.py -- request.json

request.json holds one operation:

  {"op": "render", "frames": [24, 50], "out_dir": ..., "resolution": [1920, 1440], "res_div": 2}
      Render the room from those capture cameras (cam_NNNNN) with the author stage's render
      recipe (`setup_render(engine="EEVEE", light=True)`), unrotated, as frame_NNNNN.png.

  {"op": "apply", "layout": ".../room_layout.json", "out_dir": ...,
   "drop": [{"id", "members"}], "replace": [{"id", "members", "category", "glb", "camera"}]}
      Delete dropped items; put each replacement GLB where its item's old model was (see fit.py)
      under a new handle with the item's id and support; save Room.blend, Room.glb and
      room_layout.json to out_dir, plus apply.json describing every change.

Objects resting on a removed item move to its support, or onto the new handle when it was
replaced, keeping their world pose. Nothing outside the listed items changes.
"""

import json
import os
import shutil
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fit  # noqa: E402

TEXTURE_SIZE = 1024  # TRELLIS bakes 4096 maps (~30 MB a mesh); far more than a small object needs
RENDER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))),
                          "room_ops", "rendering", "room_render")


def handles():
    return {o["room_id"]: o for o in bpy.data.objects if o.get("room_id")}


def owner(obj):
    """The room object a Blender object belongs to: its nearest ancestor with a room_id."""
    while obj is not None and not obj.get("room_id"):
        obj = obj.parent
    return obj


def own_objects(handle):
    """The handle and its parts, without other room objects parented under it."""
    return [handle] + [o for o in handle.children_recursive if owner(o) == handle]


def world_vertices(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    chunks = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        if len(mesh.vertices):
            local = np.empty(len(mesh.vertices) * 3)
            mesh.vertices.foreach_get("co", local)
            local = local.reshape(-1, 3)
            matrix = np.array(obj.matrix_world)
            chunks.append(local @ matrix[:3, :3].T + matrix[:3, 3])
        evaluated.to_mesh_clear()
    return np.concatenate(chunks) if chunks else np.zeros((0, 3))


def reparent(obj, parent):
    """Hang obj under parent where it stands. The author rests small things on parts it has stretched
    unevenly (a tabletop); a turned object under one is sheared, so it would end up skewed and the
    web editor refuses a room whose objects it cannot regroup unchanged. It then goes under an empty
    on that part scaled to take the stretch out (`<obj>_level`, fit.stretch), so it still hangs from
    and moves with the part its support_part names, as the build parents it (the check requires
    that). Under a part whose axes are skewed too, it goes under the nearest ancestor that is not
    stretched (fit.keeps_shape); rests_on/support_part still name what it stands on."""
    world = obj.matrix_world.copy()
    if parent is not None and not fit.keeps_shape(np.array(parent.matrix_world)):
        lengths = fit.stretch(np.array(parent.matrix_world))
        if lengths is not None:
            level = bpy.data.objects.new(f"{obj.name}_level", None)
            level.empty_display_size = 0.02
            for coll in obj.users_collection or parent.users_collection:
                coll.objects.link(level)
            level.parent = parent
            level.matrix_parent_inverse = Matrix.Identity(4)
            level.matrix_basis = Matrix.Diagonal((*(1 / v for v in lengths), 1.0))
            bpy.context.view_layer.update()
            parent = level
    while parent is not None and not fit.keeps_shape(np.array(parent.matrix_world)):
        parent = parent.parent
    obj.parent = parent
    obj.matrix_world = world


def render(request):
    sys.path.insert(0, RENDER_DIR)
    import render_room_cameras as recipe

    recipe.setup_render(engine="EEVEE", light=True)
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = request["resolution"]
    scene.render.resolution_percentage = max(1, int(100 / request.get("res_div", 1)))
    os.makedirs(request["out_dir"], exist_ok=True)
    for frame in request["frames"]:
        camera = bpy.data.objects.get(f"cam_{frame:05d}")
        if camera is None:
            print(f"  ! no camera cam_{frame:05d}")
            continue
        scene.camera = camera
        scene.render.filepath = os.path.join(request["out_dir"], f"frame_{frame:05d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"  rendered cam_{frame:05d}")


def rehome(dependent, support_id, support_part, parent, report):
    """Point an object that stood on a removed item at a new support."""
    for key in ("rests_on", "attached_to"):
        if key in dependent:
            dependent[key] = support_id
    if support_part:
        dependent["support_part"] = support_part
    elif "support_part" in dependent:
        del dependent["support_part"]
    reparent(dependent, parent)
    report.append({"id": dependent["room_id"], "now_on": support_id, "part": support_part})


def remove_item(item, live, report):
    """Delete an item's members; return (base handle props, dependents) before deletion."""
    members = [live[m] for m in item["members"] if m in live]
    base = live[item["id"]]
    names = set(item["members"])
    props = {k: base[k] for k in ("rests_on", "attached_to", "support_part") if k in base}
    props["parent"] = base.parent
    doomed = [o for member in members for o in own_objects(member)]
    dependents = []
    for other in live.values():
        if other["room_id"] in names:
            continue
        on = other.get("rests_on") or other.get("attached_to")
        if on in names or owner(other.parent) in members:
            dependents.append(other)
    for dependent in dependents:  # detach before the parents disappear
        reparent(dependent, None)
    for obj in doomed:
        bpy.data.objects.remove(obj, do_unlink=True)
    for name in names:
        live.pop(name, None)
    report.extend({"id": name, "removed": True} for name in sorted(names))
    return props, dependents


def import_glb(path, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o not in before]
    # A TRELLIS mesh's root empty is named `world`, the name trimesh gives its own scene root: the
    # check would read the whole room as hanging from it (room_ops/glb.py). Named after the item.
    for o in imported:
        if o.name == "world" or o.name.startswith("world."):
            o.name = f"{name}_root"
    return imported


def place(item, live, out_dir, report):
    target = item.get("marker_pose")
    if not target:
        old = [o for m in item["members"] if m in live for o in own_objects(live[m])]
        target = fit.footprint(world_vertices(old))
    props, dependents = remove_item(item, live, report["removed"])
    imported = import_glb(item["glb"], item["id"])
    for image in {node.image for obj in imported if obj.type == "MESH"
                  for mat in obj.data.materials if mat and mat.node_tree
                  for node in mat.node_tree.nodes if node.type == "TEX_IMAGE" and node.image}:
        if max(image.size) > TEXTURE_SIZE:
            image.scale(TEXTURE_SIZE, TEXTURE_SIZE)
            # Into Room.blend as they are now: unpacked, the file keeps the imported 4096 px data, and
            # a later pass that opens and exports it (openable parts) writes that back into Room.glb.
            image.pack()
    meshes = [o for o in imported if o.type == "MESH"]
    roots = [o for o in imported if o.parent not in imported]
    bpy.context.view_layer.update()
    points = world_vertices(meshes)
    low, high = points.min(0), points.max(0)
    origin = Vector(target["bottom"] if item.get("marker_pose") else (*target["centre"], target["z"][0]))
    camera = item.get("camera")
    pose = fit.placement(target, high - low, camera[:2] if camera else None)
    sx, sy, sz = pose["scale"]
    anchor = Vector(((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]))
    turn = Matrix.Rotation(pose["yaw"], 4, "Z")
    matrix = (Matrix.Translation(origin) @ turn @ Matrix.Diagonal((sx, sy, sz, 1))
              @ Matrix.Translation(-anchor))
    for root in roots:
        root.matrix_world = matrix @ root.matrix_world

    collection = bpy.data.collections.new(item["id"])
    bpy.context.scene.collection.children.link(collection)
    handle = bpy.data.objects.new(item["id"], None)
    handle.empty_display_size = 0.05
    collection.objects.link(handle)
    handle.matrix_world = Matrix.Translation(origin) @ turn
    handle["room_id"] = item["id"]
    handle["category"] = item["category"]
    handle["source_glb"] = f"{item['id']}.glb"
    handle["rebuilt"] = "trellis"
    if item.get("movable"):
        handle["movable"] = True
    bpy.context.view_layer.update()
    for key in ("rests_on", "attached_to", "support_part"):
        if key in props:
            handle[key] = props[key]
    for obj in imported:
        for coll in list(obj.users_collection):
            coll.objects.unlink(obj)
        collection.objects.link(obj)
    for root in roots:
        reparent(root, handle)
    if props["parent"] is not None:
        reparent(handle, props["parent"])
    for dependent in dependents:
        rehome(dependent, item["id"], None, handle, report["moved"])
    live[item["id"]] = handle
    os.makedirs(os.path.join(out_dir, "Object"), exist_ok=True)
    shutil.copyfile(item["glb"], os.path.join(out_dir, "Object", f"{item['id']}.glb"))
    report["placed"].append({"id": item["id"], "members": item["members"], **pose,
                             "footprint": target})


def bbox_entry(entry, handle):
    points = world_vertices([o for o in handle.children_recursive if owner(o) == handle])
    low, high = points.min(0), points.max(0)
    entry.update({
        "center": [round(float(v), 4) for v in (low + high) / 2],
        "bbox_min": [round(float(v), 4) for v in low],
        "bbox_max": [round(float(v), 4) for v in high],
        "size": [round(float(v), 4) for v in high - low],
        "top_z": round(float(high[2]), 4),
    })


def apply(request):
    out_dir = request["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    live = handles()
    report = {"removed": [], "moved": [], "placed": []}
    for item in request.get("drop", []):
        props, dependents = remove_item(item, live, report["removed"])
        support = props.get("rests_on") or props.get("attached_to")
        for dependent in dependents:
            rehome(dependent, support, props.get("support_part"), props["parent"],
                   report["moved"])
    for item in request.get("replace", []):
        place(item, live, out_dir, report)
    bpy.context.view_layer.update()

    with open(request["layout"]) as fh:
        layout = json.load(fh)
    entries = {entry["id"]: entry for entry in layout["objects"]}
    for gone in report["removed"]:
        entries.pop(gone["id"], None)
    for oid, handle in live.items():
        if oid not in entries:
            entries[oid] = {"id": oid, "handle": handle.name, "placeable_surface": False}
        entry = entries[oid]
        for key in ("category", "rests_on", "attached_to", "support_part", "source_glb",
                    "rebuilt", "movable"):
            if key in handle or key in ("rests_on", "attached_to", "support_part"):
                entry[key] = handle.get(key)
        if handle.get("rebuilt"):
            bbox_entry(entry, handle)
    layout["objects"] = [entries[k] for k in sorted(entries)]
    with open(os.path.join(out_dir, "room_layout.json"), "w") as fh:
        json.dump(layout, fh, indent=2)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type in {"MESH", "EMPTY"} and not obj.hide_get():
            obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, "Room.glb"), export_format="GLB",
                              use_selection=True, export_apply=True, export_animations=True,
                              export_cameras=False, export_lights=False)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "Room.blend"))
    with open(os.path.join(out_dir, "apply.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    print(f"  applied: {len(report['removed'])} removed, {len(report['placed'])} placed, "
          f"{len(report['moved'])} re-supported")


def main():
    with open(sys.argv[sys.argv.index("--") + 1]) as fh:
        request = json.load(fh)
    {"render": render, "apply": apply}[request["op"]](request)
    print("DONE", request["op"])


if __name__ == "__main__":
    main()
