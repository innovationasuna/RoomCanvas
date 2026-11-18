import {createImportMaterials} from './import-materials.mjs';
import {placementMatrix, sizeInMeters, objectLabel} from './object-import.mjs';

export function createImportedEntity(THREE, {id, contact, full, light, base, scale, run, capabilities, at, units, mode}) {
  const shape = new THREE.Group();
  shape.applyMatrix4(new THREE.Matrix4().fromArray(placementMatrix(base, scale)));
  full.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.userData.collision = false; mesh.raycast = () => {};
    mesh.castShadow = true;
  });
  const importMaterials = createImportMaterials(THREE, full.scene, {mode,
    preservePBR: capabilities?.material_mode === 'pbr'});
  light.scene.name = light.scene.userData.name = contact;
  light.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false});
    mesh.userData.contactOnly = true; mesh.castShadow = mesh.receiveShadow = false;
  });
  shape.add(full.scene, light.scene);
  const origin = new THREE.Vector3(...at);
  const group = new THREE.Group();
  group.name = `Editable_${id}`; group.position.copy(origin);
  group.add(shape);
  group.traverse((object) => {if (object.isMesh) object.userData.editorId = id;});
  const size = sizeInMeters(base, scale), name = objectLabel(run);
  const entity = {id, name, category: '导入物品 · 真实尺寸', roots: [contact], group, origin, added: true, importMaterials, dimensions: size,
    sizeLabel: `${size[0].toFixed(2)} × ${size[2].toFixed(2)} × ${size[1].toFixed(2)} ${units}`};
  return entity;
}
