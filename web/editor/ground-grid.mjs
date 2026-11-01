// A measuring surface in the room's world space, just below the finished floor.
// Recenter its invisible outer margin as the view moves; metre markings never move with it.
export function createGroundGrid(THREE, {floorY, target = new THREE.Vector3()}) {
  const uniforms = {
    lineColor: {value: new THREE.Color(0x82897a)},
    fadeCenter: {value: new THREE.Vector2()},
    fadeDistance: {value: 20},
    viewDirection: {value: new THREE.Vector3()},
    orthographic: {value: true},
    clipRange: {value: new THREE.Vector2()},
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
    vertexShader: `varying vec3 groundPosition;
      varying float viewDepth;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec4 viewPosition = viewMatrix * worldPosition;
        groundPosition = worldPosition.xyz;
        viewDepth = -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: `
      uniform vec3 lineColor;
      uniform vec2 fadeCenter;
      uniform float fadeDistance;
      uniform vec3 viewDirection;
      uniform bool orthographic;
      uniform vec2 clipRange;
      varying vec3 groundPosition;
      varying float viewDepth;

      float gridLine(vec2 world, float spacing, float width) {
        vec2 footprint = max(fwidth(world), vec2(0.00001));
        vec2 distanceToLine = abs(fract(world / spacing - 0.5) - 0.5) * spacing;
        // Physical-width lines lose coverage when sub-pixel, rather than becoming
        // equally bright one-pixel stripes at every angle.
        vec2 lo = distanceToLine - footprint * 0.5;
        vec2 hi = distanceToLine + footprint * 0.5;
        vec2 coverage = clamp((min(hi, vec2(width * 0.5)) - max(lo, vec2(-width * 0.5))) / footprint, 0.0, 1.0);
        float resolved = 1.0 - smoothstep(0.25, 0.75, max(footprint.x, footprint.y) / spacing);
        return max(coverage.x, coverage.y) * resolved;
      }
      void main() {
        float distanceFade = 1.0 - smoothstep(fadeDistance * 0.35, fadeDistance, distance(groundPosition.xz, fadeCenter));
        vec3 rayDirection = orthographic ? viewDirection : normalize(groundPosition - cameraPosition);
        float grazingFade = smoothstep(0.015, 0.12, abs(rayDirection.y));
        // An orthographic near plane can cross the ground at a low orbit angle.
        // Fade before that clip rather than cutting a rectangle through the foreground.
        float clipFade = smoothstep(clipRange.x, clipRange.x + 0.5, viewDepth)
          * (1.0 - smoothstep(clipRange.y * 0.9, clipRange.y, viewDepth));
        float lineAlpha = max(gridLine(groundPosition.xz, 0.25, 0.004) * 0.18,
                              gridLine(groundPosition.xz, 1.0, 0.008) * 0.32) * grazingFade;
        gl_FragColor = vec4(lineColor, lineAlpha * distanceFade * clipFade);
        if (gl_FragColor.a < 0.001) discard;
        #include <colorspace_fragment>
      }
    `,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  grid.name = 'WorkspaceGroundGrid';
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = floorY - .001;
  grid.frustumCulled = false;
  grid.renderOrder = -1;
  grid.raycast = () => {};
  grid.onBeforeRender = (_renderer, _scene, camera) => {
    const focus = typeof target === 'function' ? target() : target;
    const span = camera.isOrthographicCamera
      ? Math.max(camera.right - camera.left, camera.top - camera.bottom) / camera.zoom
      : 2 * camera.position.distanceTo(focus) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
    const radius = Math.max(12, span * 1.8);
    grid.position.set(focus.x, floorY - .001, focus.z);
    grid.scale.setScalar(radius * 1.1); // Every edge lies beyond the completely faded region.
    grid.updateMatrixWorld();
    uniforms.fadeCenter.value.set(focus.x, focus.z);
    uniforms.fadeDistance.value = radius;
    uniforms.orthographic.value = !!camera.isOrthographicCamera;
    uniforms.clipRange.value.set(camera.near, camera.far);
    camera.getWorldDirection(uniforms.viewDirection.value);
  };
  return grid;
}
