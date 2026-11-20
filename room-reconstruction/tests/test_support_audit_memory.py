"""The geometric room checks read shapes only: textures must not ride along into every copied part."""
import numpy as np
import trimesh
from PIL import Image

from litereality_agent.pipeline.room_qc import support_audit


def test_bodies_for_the_support_audit_carry_no_textures(tmp_path):
    box = trimesh.creation.box(extents=(1, 1, 1))
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new("RGB", (64, 64), "red"))
    box.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(box.vertices), 2)), material=material)
    scene = trimesh.Scene()
    scene.add_geometry(box, node_name="Crate0", geom_name="Crate0")
    glb = tmp_path / "Room.glb"
    glb.write_bytes(scene.export(file_type="glb"))
    assert isinstance(trimesh.load(str(glb), force="scene").geometry["Crate0"].visual, trimesh.visual.TextureVisuals)

    bodies = support_audit.mesh_bodies(glb, [{"id": "Crate0"}])

    assert len(bodies["Crate0"].faces) == 12
    assert not isinstance(bodies["Crate0"].visual, trimesh.visual.TextureVisuals)
