// Experimental, display-only controls. Values are offsets from the selected lighting preset.
export const DEFAULT_GRADING = Object.freeze({exposure: 0, whiteBalance: 0, contrast: 1, saturation: 1});
export const GRADING_LIMITS = Object.freeze({exposure: [-2, 2], whiteBalance: [-1, 1], contrast: [.6, 1.4], saturation: [0, 1.6]});
export function colorGrading(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_GRADING).map(([key, fallback]) => {
    const number = value[key], [min, max] = GRADING_LIMITS[key];
    return [key, typeof number === 'number' && Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback];
  }));
}
// A modest warm/cool balance, normalized to preserve neutral luminance. This is not a
// calibrated Kelvin input or an estimate of the photographed scene's illuminant.
export function whiteBalanceGains(value) {
  const t = colorGrading({whiteBalance: value}).whiteBalance;
  const gains = [Math.exp(.28 * t), 1, Math.exp(-.28 * t)];
  const luminance = gains[0] * .2126 + gains[1] * .7152 + gains[2] * .0722;
  return gains.map(gain => gain / luminance);
}
