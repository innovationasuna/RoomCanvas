// Shared profiles; no room names or asset-specific tuning. Original stays available for A/B.
export const LIGHTING_PROFILES = Object.freeze({
  original: Object.freeze({hemisphere: 2.5, key: 2.4, fill: 1.4, exposure: 1.15, environment: 0}),
  initial: Object.freeze({hemisphere: 2.5, key: 2.4, fill: 1.4, exposure: 1.15, environment: .18}),
  balanced: Object.freeze({hemisphere: 1.1, key: 3.0, fill: .65, exposure: 1.1, environment: .35}),
});
export function lightingProfile(value) {
  const name = value === 'off' || value === 'original' ? 'original' : value === 'initial' ? 'initial' : 'balanced';
  return {name, ...LIGHTING_PROFILES[name]};
}
