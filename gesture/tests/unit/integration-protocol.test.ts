import { describe, it, expect } from 'vitest';
import { gesturePayload, integrationURL, parseSceneState, PROTOCOL } from '../../src/integration/protocol';
import type { GestureFrame } from '../../src/shared/types';
const frame = (): GestureFrame => ({ timestamp: 42, interrupted: false, ambiguous: false, menuRequested: true,
  operator: { pointer: { x: .2, y: .7 }, wrist: { x: .8, y: .7 }, palmScale: 1, frontFacing: true,
    pinching: true, started: false, ended: false, releasing: true, openPalm: false } });
describe('RoomCanvas 最小输入协议', () => {
  it('只发送已镜像的右手指针与捏合状态，保留释放首帧冻结信号', () => {
    expect(gesturePayload(frame())).toEqual({ operator: { u: .2, v: .7, pinching: true,
      started: false, ended: false, releasing: true }, interrupted: false, ambiguous: false });
  });
  it('越界、非有限指针当作缺失，不夹到边缘', () => {
    for (const x of [-.1, 1.1, NaN, Infinity]) {
      const f = frame(); f.operator!.pointer.x = x; expect(gesturePayload(f).operator).toBeUndefined();
    }
  });
  it('左手只输出镜像显示指针，不输出菜单/深度接口', () => {
    const f = frame(); f.helper = f.operator; f.operator = undefined;
    expect(gesturePayload(f)).toEqual({ operator: undefined, helper:{u:.2,v:.7}, interrupted: false, ambiguous: false });
  });
  it('连接地址保留原参数，并显式绑定 origin 和会话', () => {
    const url = integrationURL('http://127.0.0.1:7880/web/editor/?room=room3', 'http://localhost:8800', 's');
    expect(url.searchParams.get('room')).toBe('room3');
    expect(url.searchParams.get('gesture_origin')).toBe('http://localhost:8800');
    expect(url.searchParams.get('gesture_session')).toBe('s');
    expect(() => integrationURL('https://example.com', 'http://localhost:8800', 's')).toThrow();
    expect(() => integrationURL('http://user:pass@localhost:7865', 'http://localhost:8800', 's')).toThrow();
  });
  it('拒绝旧会话和无效反馈', () => {
    const state = { protocol: PROTOCOL, session: 's', type: 'state', sequence: 1, busy: false,
      mode: 'move', selectedId: null, layoutReady: true, phase: 'idle', message: '已连接' };
    expect(parseSceneState(state, 's')).toEqual(state);
    expect(parseSceneState(state, 'old')).toBeNull();
    expect(parseSceneState({ ...state, busy: 'false' }, 's')).toBeNull();
    expect(parseSceneState({ ...state, mode: 'height' }, 's')).toBeNull();
  });
});

describe('左手显示指针',()=>{
 it('拒绝越界指针且不发送原始关键点',()=>{
  const f=frame();f.helper=f.operator;f.helper!.pointer.x=2;
  expect(gesturePayload(f)).not.toHaveProperty('helper');
  f.helper!.pointer.x=.3;const payload=gesturePayload(f);
  expect(payload.helper).toEqual({u:.3,v:.7});expect(payload.helper).not.toHaveProperty('landmarks');
 });
});
