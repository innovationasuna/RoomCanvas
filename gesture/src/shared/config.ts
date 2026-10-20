export const CONFIG = {
  pinchEnter: 0.25, // 两指距离/掌部尺度低于此值，开始捏合确认。
  pinchExit: 0.30, // 高于此值开始释放；降低可让两指稍分开就释放，须大于 pinchEnter。
  fingerGuideMaxRatio: 0.8, // 两指张开到掌部尺度的此比例后隐藏操作标记，不影响识别。
  confirmMs: 100, // 抓取确认时间，避免误抓。
  releaseConfirmMs: 40, // 独立的释放确认时间，让松手比抓取更快。
  menuHoldMs: 600,
  menuCloseHoldMs: 200, // 左手握拳持续确认后关闭菜单。
  lossMs: 200, identityRadius: 0.18, minimumScore: 0.5, operatorScore: 0.8,
  minFacing: 0.6,
  filter: { minCutoff: 1.8, beta: 0.03, derivativeCutoff: 1 },
  inferenceInterval: 1000 / 30,
} as const;
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
