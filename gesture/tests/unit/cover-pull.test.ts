import {afterEach, describe, expect, it, vi} from 'vitest';
import {setupCoverPull} from '../../src/integration/cover-pull';

class Surface extends EventTarget {
  style = {transform: '', setProperty: vi.fn()};
  classList = {add: vi.fn(), remove: vi.fn(), toggle: vi.fn()};
  textContent = '';
  children = new Map<string, Surface>();
  captures = new Set<number>();
  querySelector(selector: string) {return this.children.get(selector);}
  contains(target: unknown) {return target === this || [...this.children.values()].includes(target as Surface);}
  setPointerCapture(id: number) {this.captures.add(id);}
  hasPointerCapture(id: number) {return this.captures.has(id);}
  releasePointerCapture(id: number) {this.captures.delete(id);}
}

function setup() {
  const cover = new Surface(), cue = new Surface(), label = new Surface();
  cover.children.set('#open-cover', cue); cue.children.set('.pull-label', label);
  const open = vi.fn();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('getComputedStyle', () => ({transform: 'none'}));
  setupCoverPull(cover as unknown as HTMLElement, {canStart: () => true, open, reducedMotion: {matches: true} as MediaQueryList});
  const pointer = (type: string, x: number, y = 100, target = cover, pointerId = 1) => {
    const event = Object.assign(new Event(type), {clientX: x, clientY: y, pointerId, isPrimary: true, button: 0});
    Object.defineProperty(event, 'target', {value: target});
    cover.dispatchEvent(event);
  };
  const click = (detail = 1) => cue.dispatchEvent(Object.assign(new Event('click', {cancelable: true}), {detail}));
  return {cover, cue, open, pointer, click};
}
afterEach(() => vi.unstubAllGlobals());

describe('封面快速拉动与点击兼容', () => {
  it('没有中间移动事件时，仍按按下和松手位置判断快速左拉', () => {
    const run = setup();
    run.pointer('pointerdown', 600);
    run.pointer('pointerup', 480);
    expect(run.open).toHaveBeenCalledTimes(1);
  });
  it('最后一个移动事件尚未起拖，松手坐标达到 1/8 屏也能开启', () => {
    const run = setup();
    run.pointer('pointerdown', 600);
    run.pointer('pointermove', 597);
    run.pointer('pointerup', 500);
    expect(run.open).toHaveBeenCalledTimes(1);
  });
  it('按下便捕获指针；手柄保留点击目标，封面其他位置也能接收外部松手', () => {
    const run = setup();
    run.pointer('pointerdown', 600, 100, run.cue);
    expect(run.cue.hasPointerCapture(1)).toBe(true);
    run.pointer('pointerup', 480);
    expect(run.cue.hasPointerCapture(1)).toBe(false);
    run.pointer('pointerdown', 600);
    expect(run.cover.hasPointerCapture(1)).toBe(true);
  });
  it('快速短拉未达阈值，松手后的合成点击也不打开', () => {
    const run = setup();
    run.pointer('pointerdown', 600, 100, run.cue);
    run.pointer('pointerup', 530);
    run.click();
    expect(run.open).not.toHaveBeenCalled();
  });
  it.each([[720, 100], [480, 320]])('右拉或以竖向为主的快速松手（%i,%i）不会开启', (x, y) => {
    const run = setup();
    run.pointer('pointerdown', 600, 100, run.cue);
    run.pointer('pointerup', x, y);
    run.click();
    expect(run.open).not.toHaveBeenCalled();
  });
  it.each(['pointercancel', 'lostpointercapture'])('拉够后发生 %s 仍取消，不把中断当作确认', type => {
    const run = setup();
    run.pointer('pointerdown', 600);
    run.pointer('pointermove', 450);
    run.pointer(type, 450);
    run.pointer('pointerup', 450);
    expect(run.open).not.toHaveBeenCalled();
  });
  it('拉够又拉回阈值内不会开启，其他指针的松手不结束当前拖动', () => {
    const run = setup();
    run.pointer('pointerdown', 600);
    run.pointer('pointermove', 450);
    run.pointer('pointerup', 450, 100, run.cover, 2);
    expect(run.open).not.toHaveBeenCalled();
    run.pointer('pointerup', 550);
    expect(run.open).not.toHaveBeenCalled();
  });
  it('普通点击和短拉后的键盘激活继续可用', () => {
    const run = setup();
    run.pointer('pointerdown', 600, 100, run.cue);
    run.pointer('pointerup', 600);
    run.click();
    expect(run.open).toHaveBeenCalledTimes(1);
    run.pointer('pointerdown', 600, 100, run.cue);
    run.pointer('pointermove', 560);
    run.pointer('pointerup', 560);
    run.click(0);
    expect(run.open).toHaveBeenCalledTimes(2);
  });
});
