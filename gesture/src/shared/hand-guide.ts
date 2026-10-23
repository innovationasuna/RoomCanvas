import { CONFIG } from './config';
import type { HandSignal } from './types';

// 只控制显示；张掌、数字识别与释放确认继续接收完整控制信号。
export function showFingerGuide(hand?: Pick<HandSignal, 'fingertips' | 'pinchRatio'>): boolean {
  const ratio = hand?.pinchRatio;
  return !!hand?.fingertips && typeof ratio === 'number' && Number.isFinite(ratio) &&
    ratio >= 0 && ratio < CONFIG.fingerGuideMaxRatio;
}
