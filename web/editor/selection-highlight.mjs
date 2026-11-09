// A selection colours the whole visible surface, including textured and vertex-coloured
// imports. Keep texture alpha, normal detail and the material's existing shader hooks.
export function createSelectionHighlight(THREE) {
  const green = new THREE.Color(0x62c6a3);
  const rgb = green.toArray().map(value => value.toFixed(8)).join(', ');
  return {material(source) {
    const material = source.clone();
    if (!source.colorWrite) return material; // Invisible collision geometry stays invisible.
    const compile = material.onBeforeCompile;
    const program = material.customProgramCacheKey();
    material.onBeforeCompile = function(shader, renderer) {
      compile.call(this, shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
        `#include <color_fragment>\n diffuseColor.rgb = vec3(${rgb});`);
    };
    material.customProgramCacheKey = () => `${program}|room-selection-green`;
    if (material.emissive) {
      material.emissive.copy(green);
      material.emissiveIntensity = .35;
      material.emissiveMap = null;
    }
    if ('metalness' in material) {material.metalness = 0; material.metalnessMap = null;}
    if ('roughness' in material) material.roughness = .8;
    if ('transmission' in material) material.transmission = 0;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    return material;
  }};
}
