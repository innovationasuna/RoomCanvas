export const CONFIG = {
  pinchEnter: 0.25, // 两指距离/掌部尺度低于此值，开始捏合确认。
  pinchExit: 0.30, // 高于此值开始释放；降低可让两指稍分开就释放，须大于 pinchEnter。
  confirmMs: 100, // 抓取确认时间，避免误抓。
  releaseConfirmMs: 40, // 独立的释放确认时间，让松手比抓取更快。
  fingerGuideMaxRatio: 0.8, // 指尖距离/掌部尺度达到此值，隐藏场景中的指尖、连线与中点。
  menuHoldMs: 600,
  menuCloseHoldMs: 200, // 左手握拳持续确认后关闭菜单。
  lossMs: 200, identityRadius: 0.18, minimumScore: 0.5, operatorScore: 0.8,
  xyGain: 5, depthGain: 2, maxDepthRatio: 2.5, minFacing: 0.6,
  rotateGain: Math.PI, rotationSnap: Math.PI / 12, heightGain: 3,
  room: { width: 6, depth: 5, height: 3 },
  filter: { minCutoff: 1.8, beta: 0.03, derivativeCutoff: 1 },
  minScale: 0.5, maxScale: 2, inferenceInterval: 1000 / 30,
} as const;
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
