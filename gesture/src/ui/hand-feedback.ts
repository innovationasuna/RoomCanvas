import type { GestureFrame, TrackingFrame } from '../shared/types';
import type { NumberFeedback } from '../gestures/number-mode';
import { NUMBER_LABELS } from '../gestures/number-mode';
import { showFingerGuide } from '../shared/hand-guide';
import type { ThumbFeedback } from '../gestures/thumb-confirm';

export const HAND_COLORS = {Right:'#c98248', Left:'#278f83'} as const;
const EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
  [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];

export function numberFeedback(state: NumberFeedback) {
  if (state.phase === 'missing') return '左手未识别 · 请将整只手放入画面';
  if (state.phase === 'uncertain') return '左手判断不稳定 · 请让掌面朝向摄像头';
  if (state.phase === 'ambiguous') return '左手身份不明确 · 请分开双手';
  if (state.phase === 'blocked') return '操作中 · 结束后张掌，再选择 1 / 2 / 3 / 4';
  if (state.phase === 'neutral') return '请先张掌（拇指展开），再摆出数字';
  if (state.digit) return '左手 ' + state.digit + ' · ' + NUMBER_LABELS[state.digit] +
    (state.phase === 'selected' ? ' · 已切换' : ' · 确认 ' + Math.round(state.progress * 100) + '%');
  return '左手已识别 · 1 平移 / 2 高度 / 3 缩放 / 4 旋转';
}

export function thumbFeedback(state: ThumbFeedback) {
  switch (state.phase) {
    case 'missing': return '右手未识别 · 请将整只手放入画面';
    case 'uncertain': return '右手判断不稳定 · 请让整只手清楚入画';
    case 'ambiguous': return '右手身份不明确 · 请分开双手';
    case 'waiting': return '先选择家具，调整后松手保留预览';
    case 'blocked': return '请先结束拖动或缩放，等待放置检查';
    case 'neutral': return '请先放下拇指，再重新竖起确认';
    case 'confirming': return `右手竖拇指 · 确认 ${Math.round(state.progress * 100)}%`;
    case 'sent': return '已发送放置确认 · 结果见房间提示';
    default: return '右手竖拇指，四指收拢，保持约 0.5 秒';
  }
}

export function drawHandFeedback(canvas: HTMLCanvasElement, frame: TrackingFrame, gesture: GestureFrame,
  source?: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>) {
  // 叠层与视频使用相同的原始尺寸和 object-fit；镜像只在下方坐标换算一次。
  if (source?.videoWidth && source.videoHeight) {
    if (canvas.width !== source.videoWidth) canvas.width = source.videoWidth;
    if (canvas.height !== source.videoHeight) canvas.height = source.videoHeight;
  }
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  for (const hand of frame.hands) {
    if (hand.landmarks.length !== 21) continue;
    const color = HAND_COLORS[hand.side];
    const point = (i: number) => [(1 - hand.landmarks[i].x) * w, hand.landmarks[i].y * h];
    ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = .65;
    for (const [a,b] of EDGES) {
      ctx.beginPath(); ctx.moveTo(...point(a) as [number,number]);
      ctx.lineTo(...point(b) as [number,number]); ctx.stroke();
    }
    for (let i=0;i<21;i++) {
      const [x,y] = point(i); ctx.beginPath(); ctx.arc(x,y,2.1,0,Math.PI*2); ctx.fill();
    }
    const signal = hand.side === 'Right' ? gesture.operator : gesture.helper;
    if (!showFingerGuide(signal)) continue;
    const [ax,ay] = point(4), [bx,by] = point(8);
    ctx.globalAlpha = .95; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.stroke();
    for (const [x,y] of [[ax,ay],[bx,by]]) {
      ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
    }
    ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc((ax+bx)/2,(ay+by)/2,signal?.pinching?6:4,0,Math.PI*2);
    if (signal?.pinching) ctx.fill(); else ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
