// A loaded replay model owns its meshes, materials and texture images. Collect
// before disposing: GLTF primitives, wall copies and masks frequently share them.
export function disposeModel(root) {
  const geometries = new Set(), materials = new Set(root.userData.sourceMaterials || []), textures = new Set(), images = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [object.material].flat()) if (material) materials.add(material);
  });
  for (const material of materials) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  for (const texture of textures) if (texture.image) images.add(texture.image);
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
  images.forEach(image => image.close?.());
  root.removeFromParent();
  root.clear();
  for (const key of ['sourceMaterials', 'fadeMats', 'mask', 'windows', 'warm', 'materializerMaterials']) delete root.userData[key];
}
