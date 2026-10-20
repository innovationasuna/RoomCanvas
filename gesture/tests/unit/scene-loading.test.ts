import {afterEach, describe, expect, it, vi} from 'vitest';
import {setupSceneLoading} from '../../src/integration/scene-loading';

function setup(reduce = false, animated = true) {
  let now = 0, frameId = 0, pending: FrameRequestCallback | undefined;
  const loop = {currentTime: 0, pause: vi.fn(), cancel: vi.fn(), effect: {
    getTiming: () => ({duration: 2800}), updateTiming: vi.fn(),
  }};
  const outline = {getAnimations: () => [loop]};
  const reduced = Object.assign(new EventTarget(), {matches: reduce});
  const fades: {resolve: () => void; cancel: ReturnType<typeof vi.fn>}[] = [];
  const element = {
    hidden: true, dataset: {state: 'idle'}, offsetWidth: 500,
    querySelector: () => outline, getClientRects: () => [{}], getAnimations: () => animated ? [loop] : [],
    animate: vi.fn(() => {
      let resolve!: () => void;
      const finished = new Promise<void>(done => {resolve = done;});
      const cancel = vi.fn(); fades.push({resolve, cancel});
      return {finished, cancel};
    }),
  };
  vi.stubGlobal('performance', {now: () => now});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {pending = callback; return ++frameId;});
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {if (id === frameId) pending = undefined;});
  const loading = setupSceneLoading(element as unknown as HTMLElement, reduced as unknown as MediaQueryList);
  const frame = (milliseconds = 50) => {now += milliseconds; const callback = pending; pending = undefined; callback?.(now);};
  const advance = (milliseconds: number) => {for (let left = milliseconds; left > 0; left -= 50) frame(Math.min(left, 50));};
  loading.start();
  return {loading, element, loop, frame, advance, fades, reduced};
}
afterEach(() => vi.unstubAllGlobals());

describe('房间加载动效从可见断点收尾', () => {
  it('模型就绪后不改变已有进度，只画完剩余部分再淡出', async () => {
    const run = setup(); run.advance(1000);
    run.loading.ready(); expect(run.loop.currentTime).toBe(1000);
    run.advance(1750); expect(run.element.animate).not.toHaveBeenCalled();
    run.frame(); expect(run.element.dataset.state).toBe('ready'); expect(run.element.hidden).toBe(false);
    run.fades[0].resolve(); await Promise.resolve(); expect(run.element.hidden).toBe(true);
  });
  it('模型阻塞数秒后从上次可见位置继续，不跳到后台时钟的新循环', () => {
    const run = setup(); run.advance(900); run.loading.ready();
    run.frame(5000);
    expect(run.loop.currentTime).toBe(950); expect(run.element.animate).not.toHaveBeenCalled();
    run.advance(1850); expect(run.element.animate).toHaveBeenCalledTimes(1);
  });
  it('房子已画完整时直接淡出，不重新跑一轮', () => {
    const run = setup(); run.advance(2800); run.loading.ready();
    expect(run.element.animate).toHaveBeenCalledTimes(1); expect(run.loop.currentTime).toBe(2800);
  });
  it('连续就绪消息不重置进度或重复淡出', () => {
    const run = setup(); run.loading.ready(); run.advance(1000); run.loading.ready();
    run.advance(1800); run.loading.ready();
    expect(run.element.animate).toHaveBeenCalledTimes(1);
  });
  it('新房间开始加载后，旧淡出的完成不能隐藏新遮罩', async () => {
    const run = setup(); run.loading.ready(); run.advance(2800);
    run.loading.start(); run.fades[0].resolve(); await Promise.resolve();
    expect(run.fades[0].cancel).toHaveBeenCalled();
    expect(run.element.hidden).toBe(false); expect(run.element.dataset.state).toBe('loading');
  });
  it('超时停止收尾，重试后可以重新完成', async () => {
    const run = setup(); run.loading.ready(); run.loading.fail(); run.advance(6000);
    expect(run.element.animate).not.toHaveBeenCalled(); expect(run.element.dataset.state).toBe('error');
    run.loading.start(); run.loading.ready(); run.advance(2800); run.fades[0].resolve(); await Promise.resolve();
    expect(run.element.hidden).toBe(true);
  });
  it('减少动态效果时不等待动画', () => {
    const run = setup(true); run.loading.ready();
    expect(run.element.hidden).toBe(true); expect(run.element.animate).not.toHaveBeenCalled();
  });
  it('等待期间打开减少动态效果，也能立即结束', () => {
    const run = setup(); run.loading.ready();
    run.reduced.matches = true; run.reduced.dispatchEvent(new Event('change'));
    expect(run.element.hidden).toBe(true);
  });
  it('动画不可用时直接淡出，不留下遮罩', async () => {
    const run = setup(false, false); run.loading.ready();
    expect(run.element.animate).toHaveBeenCalledTimes(1);
    run.fades[0].resolve(); await Promise.resolve(); expect(run.element.hidden).toBe(true);
  });
});
