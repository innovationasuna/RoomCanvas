export const DEFAULT_INDOOR_LIGHTS = Object.freeze({power: true, angle: 160});
export const LAMP_ANGLE_LIMITS = Object.freeze({min: 60, max: 170});

// Angle is the full cone in degrees; Three.js SpotLight.angle uses its half-angle.
// Older ceiling/strip selections are ignored while preserving the master power state.
export function indoorLighting(value) {
  return {
    power: typeof value?.power === 'boolean' ? value.power : DEFAULT_INDOOR_LIGHTS.power,
    angle: typeof value?.angle === 'number' && Number.isFinite(value.angle)
      ? Math.min(LAMP_ANGLE_LIMITS.max, Math.max(LAMP_ANGLE_LIMITS.min, value.angle)) : DEFAULT_INDOOR_LIGHTS.angle,
  };
}
