import { describe, expect, it } from 'vitest';
import { isRightThumbsUp, ThumbConfirmSelector, THUMB_CONFIRM } from '../../src/gestures/thumb-confirm';
import { GestureEngine } from '../../src/gestures/engine';
import { features } from '../../src/gestures/features';
import { CONFIG } from '../../src/shared/config';
import { thumbFeedback } from '../../src/ui/hand-feedback';
import type { Hand } from '../../src/shared/types';
import { hand, fist } from '../fixtures/hands';

function thumbsUp(): Hand {
  const h = hand();
  for (const mcp of [5, 9, 13, 17]) {
    const base = h.landmarks[mcp];
    h.landmarks[mcp + 1] = { ...base, y: base.y - .04, z: -.02 };
    h.landmarks[mcp + 2] = { ...base, y: base.y + .04, z: -.02 };
    h.landmarks[mcp + 3] = { ...base, y: base.y + .10, z: -.02 };
  }
  h.landmarks[2] = { x: .35, y: .59, z: 0 };
  h.landmarks[3] = { x: .34, y: .46, z: 0 };
  h.landmarks[4] = { x: .33, y: .34, z: 0 };
  h.world = h.landmarks.map(p => ({ ...p }));
  return h;
}
const frame = (timestamp: number, hands: Hand[] = [thumbsUp()]) => ({ timestamp, hands, inferenceMs: 8 });
const process = (s: ThumbConfirmSelector, t: number, hands?: Hand[], target: string | null = 'chair-1', allowed = true) =>
  s.process(frame(t, hands), 4 / 3, target, allowed);
function hold(s: ThumbConfirmSelector, from = 0, target: string | null = 'chair-1', allowed = true) {
  const events = [];
  for (let t = from; t <= from + THUMB_CONFIRM.holdMs; t += 100) {
    const result = process(s, t, undefined, target, allowed);
    if (result) events.push(result);
  }
  return events;
}
function neutral(s: ThumbConfirmSelector, from: number) {
  for (const t of [from, from + 100, from + 150]) process(s, t, [hand()]);
}

describe('右手竖拇指手型', () => {
  it('识别拇指朝上、四指自然收拢，允许侧掌、镜像、尺度和小幅倾斜', () => {
    expect(isRightThumbsUp(thumbsUp())).toBe(true);
    for (const scale of [.5, 1, 1.4]) for (const mirror of [-1, 1]) for (const angle of [-.3, 0, .3]) {
      const h = thumbsUp();
      h.landmarks = h.landmarks.map(p => {
        const x = (p.x - .5) * 4 / 3 * mirror, y = p.y - .6;
        return { x: .5 + scale * (x * Math.cos(angle) - y * Math.sin(angle)) * 3 / 4,
          y: .6 + scale * (x * Math.sin(angle) + y * Math.cos(angle)), z: p.z * scale };
      });
      // 侧掌的 world normal 不朝镜头；竖拇指不使用掌面朝向门槛。
      h.world = h.world.map(p => ({ x: 0, y: p.y, z: p.x }));
      expect(isRightThumbsUp(h)).toBe(true);
    }
  });
  it('左手、张掌、握拳、捏合和任何其他伸出的手指不确认', () => {
    expect(isRightThumbsUp({ ...thumbsUp(), side: 'Left' })).toBe(false);
    for (const h of [hand(), fist('Right'), hand('Right', true)]) expect(isRightThumbsUp(h)).toBe(false);
    for (const mcp of [5, 9, 13, 17]) {
      const h = thumbsUp(), open = hand();
      for (const i of [mcp + 1, mcp + 2, mcp + 3]) h.landmarks[i] = open.landmarks[i];
      expect(isRightThumbsUp(h)).toBe(false);
    }
  });
  it('拇指横向、朝下、弯折或贴住食指不确认', () => {
    for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const h = thumbsUp();
      h.landmarks = h.landmarks.map(p => ({ x: .5 + (p.x - .5) * Math.cos(angle) - (p.y - .6) * Math.sin(angle),
        y: .6 + (p.x - .5) * Math.sin(angle) + (p.y - .6) * Math.cos(angle), z: p.z }));
      expect(isRightThumbsUp(h)).toBe(false);
    }
    const bent = thumbsUp(); bent.landmarks[4] = { x: .43, y: .48, z: 0 };
    expect(isRightThumbsUp(bent)).toBe(false);
    const pinch = thumbsUp(); pinch.landmarks[4] = { ...pinch.landmarks[8] };
    expect(isRightThumbsUp(pinch)).toBe(false);
  });
  it('拒绝低置信度、残缺、非有限和退化坐标', () => {
    expect(isRightThumbsUp({ ...thumbsUp(), score: .7 })).toBe(false);
    const short = thumbsUp(); short.landmarks.pop(); expect(isRightThumbsUp(short)).toBe(false);
    const invalid = thumbsUp(); invalid.landmarks[3].x = NaN; expect(isRightThumbsUp(invalid)).toBe(false);
    const degenerate = thumbsUp(); degenerate.landmarks.fill({ x: .5, y: .5, z: 0 });
    expect(isRightThumbsUp(degenerate)).toBe(false);
    const finger = thumbsUp(); finger.landmarks[7] = { ...finger.landmarks[6] };
    expect(isRightThumbsUp(finger)).toBe(false);
    expect(isRightThumbsUp(thumbsUp(), 0)).toBe(false);
  });
});

describe('确认计时与当前预览', () => {
  it('稳定 500ms 后确认一次，持续手型不重复；放下后可再次确认', () => {
    const s = new ThumbConfirmSelector();
    for (const t of [0, 100, 200]) expect(process(s, t)).toBeNull();
    expect(s.state.progress).toBe(.4);
    for (const t of [300, 400, 499]) expect(process(s, t)).toBeNull();
    expect(process(s, 500)).toBe('chair-1'); expect(s.state.phase).toBe('sent');
    expect(hold(s, 600)).toEqual([]);
    neutral(s, 1200); expect(hold(s, 1400)).toEqual(['chair-1']);
  });
  it('短暂手型变化重新计时，不能累计前一段进度', () => {
    const s = new ThumbConfirmSelector();
    for (const t of [0, 100, 200, 300]) process(s, t);
    process(s, 350, [hand()]);
    for (const t of [400, 500, 600, 700, 800, 899]) expect(process(s, t)).toBeNull();
    expect(process(s, 900)).toBe('chair-1');
  });
  it('拖动或检查期间不计时，结束后必须重新保持完整时长', () => {
    const s = new ThumbConfirmSelector();
    for (const t of [0, 100, 200, 300, 400]) process(s, t);
    expect(hold(s, 500, 'chair-1', false)).toEqual([]);
    expect(s.state.phase).toBe('blocked');
    for (const t of [1100, 1200, 1300, 1400, 1500]) expect(process(s, t)).toBeNull();
    expect(process(s, 1600)).toBe('chair-1');
  });
  it('没有预览或更换预览时不补发旧手势', () => {
    const s = new ThumbConfirmSelector();
    expect(hold(s, 0, null)).toEqual([]); expect(hold(s, 600)).toEqual([]);
    neutral(s, 1200);
    for (const t of [1400, 1500, 1600, 1700, 1800]) process(s, t);
    expect(hold(s, 1900, 'chair-2')).toEqual([]); expect(s.state.phase).toBe('neutral');
    for (const t of [2500, 2600, 2650]) process(s, t, [hand()], 'chair-2');
    expect(hold(s, 2700, 'chair-2')).toEqual(['chair-2']);
  });
  it('丢手、低分、双右手候选或手腕跳变均打断，恢复后先放下拇指', () => {
    const jumped = thumbsUp(); jumped.landmarks = jumped.landmarks.map(p => ({ ...p, x: p.x + .25 }));
    for (const hands of [[], [{ ...thumbsUp(), score: .7 }], [thumbsUp(), thumbsUp()], [jumped]]) {
      const s = new ThumbConfirmSelector();
      for (const t of [0, 100, 200, 300, 400]) process(s, t);
      expect(process(s, 450, hands)).toBeNull();
      expect(hold(s, 500)).toEqual([]);
      neutral(s, 1100); expect(hold(s, 1300)).toEqual(['chair-1']);
    }
  });
  it('无中间帧的长停顿、乱序及显式中断也不能续用计时', () => {
    for (const interrupt of ['gap', 'backwards', 'reset']) {
      const s = new ThumbConfirmSelector();
      for (const t of [0, 100, 200, 300, 400]) process(s, t);
      if (interrupt === 'reset') s.reset();
      if (interrupt === 'backwards') process(s, 350);
      expect(hold(s, interrupt === 'gap' ? 700 : 500)).toEqual([]);
    }
  });
  it('捏合转竖拇指先释放，再开始确认，左手环绕不受影响', () => {
    const s = new ThumbConfirmSelector(), engine = new GestureEngine(); engine.reset();
    const events = [], releases = [];
    for (let t = 0; t <= 1200; t += 50) {
      const right = t < 200 ? hand() : t < 500 ? hand('Right', true) : thumbsUp();
      const left = hand('Left', t >= 200, .8), f = frame(t, [right, left]);
      const g = engine.process(f, 4 / 3);
      if (g.operator?.ended) releases.push(t);
      const allowed = !!g.operator && !g.operator.pinching && !g.operator.releasing &&
        features(right).pinchRatio >= CONFIG.pinchExit;
      const event = s.process(f, 4 / 3, 'chair-1', allowed);
      if (event) events.push({ t, event, leftPinching: g.helper?.pinching });
    }
    expect(releases).toEqual([550]);
    expect(events).toEqual([{ t: 1100, event: 'chair-1', leftPinching: true }]);
  });
  it('确认反馈区分等待、重新摆手、进度与已发送，不能把发送说成放置成功', () => {
    expect(thumbFeedback({ phase: 'confirming', progress: .6 })).toContain('60%');
    expect(thumbFeedback({ phase: 'sent', progress: 1 })).toContain('结果见房间提示');
    expect(thumbFeedback({ phase: 'neutral', progress: 0 })).toContain('放下拇指');
    expect(thumbFeedback({ phase: 'waiting', progress: 0 })).toContain('预览');
  });
});
