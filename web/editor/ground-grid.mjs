// Scans need not be aligned to the global axes. Use the longest structural wall
// as a fixed room frame; orbiting, panning and moving furniture cannot rotate it.
export function groundGridFrame(walls = []) {
  const candidates = walls.filter(wall => wall.tangent && wall.n && Number.isFinite(wall.d)
    && wall.bounds?.every(point => point.every(Number.isFinite))
    && Math.hypot(wall.tangent[0], wall.tangent[2]) > .001);
  const wall = candidates.reduce((best, next) => !best || next.bounds[1][0] - next.bounds[0][0]
    > best.bounds[1][0] - best.bounds[0][0] ? next : best, null);
  if (!wall) return {origin: [0, 0], x: [1, 0], z: [0, 1]};
  let x = [wall.tangent[0], wall.tangent[2]];
  const length = Math.hypot(...x);
  x = x.map(value => value / length);
  if (Math.abs(x[1]) > Math.abs(x[0])) x = [x[1], -x[0]];
  if (x[0] < 0) x = x.map(value => -value);
  return {x, z: [-x[1], x[0]], origin: [0, 2].map(axis =>
    wall.tangent[axis] * wall.bounds[0][0] + wall.n[axis] * wall.d)};
}

// A measuring surface in the room's frame, just below the finished floor.
// Recenter its invisible outer margin as the view moves; metre markings never move with it.
export function createGroundGrid(THREE, {floorY, target = new THREE.Vector3(), walls = []}) {
  const frame = groundGridFrame(walls);
  const uniforms = {
    lineColor: {value: new THREE.Color(0x718078)},
    axisXColor: {value: new THREE.Color(0xad625b)},
    axisZColor: {value: new THREE.Color(0x60916a)},
    gridOrigin: {value: new THREE.Vector2(...frame.origin)},
    gridXAxis: {value: new THREE.Vector2(...frame.x)},
    fadeCenter: {value: new THREE.Vector2()},
    fadeDistance: {value: 20},
    viewDirection: {value: new THREE.Vector3()},
    orthographic: {value: true},
    clipRange: {value: new THREE.Vector2()},
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    // Draw the guide before opaque room geometry. A transparent-queue grid draws
    // after the floor; their 1 mm separation can quantize to the same depth at
    // some perspective angles, letting lines leak over it. Explicit alpha blending
    // keeps the soft lines in the opaque queue, then the real floor covers them.
    transparent: false, blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: true, depthWrite: false, toneMapped: false,
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
      uniform vec3 axisXColor;
      uniform vec3 axisZColor;
      uniform vec2 gridOrigin;
      uniform vec2 gridXAxis;
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
        // Screen-width strokes stay readable nearby. Each family fades before its
        // cells collapse into a few pixels, instead of aliasing near the horizon.
        vec2 coverage = 1.0 - smoothstep(vec2(max(0.0, width * 0.5 - 0.5)),
          vec2(width * 0.5 + 0.5), distanceToLine / footprint);
        vec2 resolved = smoothstep(vec2(3.0), vec2(12.0), vec2(spacing) / footprint);
        return max(coverage.x * resolved.x, coverage.y * resolved.y);
      }
      void main() {
        vec2 delta = groundPosition.xz - gridOrigin;
        vec2 gridPosition = vec2(dot(delta, gridXAxis), dot(delta, vec2(-gridXAxis.y, gridXAxis.x)));
        float distanceFade = 1.0 - smoothstep(fadeDistance * 0.35, fadeDistance, distance(groundPosition.xz, fadeCenter));
        vec3 rayDirection = orthographic ? viewDirection : normalize(groundPosition - cameraPosition);
        float grazingFade = smoothstep(0.002, 0.035, abs(rayDirection.y));
        // An orthographic near plane can cross the ground at a low orbit angle.
        // Fade before that clip rather than cutting a rectangle through the foreground.
        float clipFade = smoothstep(clipRange.x, clipRange.x + 0.5, viewDepth)
          * (1.0 - smoothstep(clipRange.y * 0.9, clipRange.y, viewDepth));
        float lineAlpha = max(gridLine(gridPosition, 0.25, 0.8) * 0.08,
                              gridLine(gridPosition, 1.0, 1.15) * 0.34);
        // Wider intervals take over smoothly when zoomed out; a dense grey sheet
        // never replaces the floor. All levels keep the same fixed metre origin.
        float coarse = smoothstep(0.04, 0.16, max(fwidth(gridPosition.x), fwidth(gridPosition.y)));
        lineAlpha = max(lineAlpha, gridLine(gridPosition, 10.0, 1.25) * coarse * 0.34);
        vec2 axis = 1.0 - smoothstep(vec2(0.5), vec2(1.5), abs(gridPosition) / max(fwidth(gridPosition), vec2(0.00001)));
        vec3 color = mix(lineColor, axisXColor, axis.y);
        color = mix(color, axisZColor, axis.x);
        lineAlpha = max(lineAlpha, max(axis.x, axis.y) * 0.5);
        gl_FragColor = vec4(color, lineAlpha * grazingFade * distanceFade * clipFade);
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
    const radius = Math.max(60, span * 8);
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
