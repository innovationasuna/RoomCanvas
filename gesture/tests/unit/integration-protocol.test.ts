import { describe, it, expect } from 'vitest';
import { gesturePayload, integrationURL, parseSceneState, PROTOCOL } from '../../src/integration/protocol';
import type { GestureFrame } from '../../src/shared/types';
const frame = (): GestureFrame => ({ timestamp: 42, interrupted: false, ambiguous: false, menuRequested: true,
  operator: { pointer: { x: .2, y: .7 }, wrist: { x: .8, y: .7 }, palmScale: 1, frontFacing: true,
    pinching: true, started: false, ended: false, releasing: true, openPalm: false } });
describe('RoomCanvas 最小输入协议', () => {
  it('发送控制所需的镜像信号，保留释放首帧冻结信号', () => {
    expect(gesturePayload(frame())).toEqual({ operator: { u: .2, v: .7, pinching: true,
      started: false, ended: false, releasing: true, palmScale:1,frontFacing:true }, helper:undefined, interrupted: false, helperInterrupted:false, ambiguous: false });
  });
  it('越界、非有限指针当作缺失，不夹到边缘', () => {
    for (const x of [-.1, 1.1, NaN, Infinity]) {
      const f = frame(); f.operator!.pointer.x = x; expect(gesturePayload(f).operator).toBeUndefined();
    }
  });
  it('左手同样输出捏合状态，支持独立环绕', () => {
    const f = frame(); f.helper = f.operator; f.operator = undefined;
    expect(gesturePayload(f).helper).toMatchObject({u:.2,v:.7,pinching:true,releasing:true});
    expect(gesturePayload(f)).not.toHaveProperty('menuRequested');
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
    expect(parseSceneState({ ...state, mode: 'unknown' }, 's')).toBeNull();
  });
  it('右手确认必须绑定有效的当前预览，旧版无此字段仍可连接', () => {
    const state = { protocol: PROTOCOL, session: 's', type: 'state', sequence: 1, busy: false,
      mode: 'height', selectedId: 'chair', layoutReady: true, phase: 'idle', message: '',
      previewId: 'preview-1', canConfirm: true, capabilities: ['dual-hand-v2', 'thumb-confirm-v1'] };
    expect(parseSceneState(state, 's')).toEqual(state);
    for (const previewId of [null, '', 1, 'x'.repeat(129)]) expect(parseSceneState({ ...state, previewId }, 's')).toBeNull();
    for (const patch of [{ canConfirm: 'yes' }, { busy: true }, { layoutReady: false }]) {
      expect(parseSceneState({ ...state, ...patch }, 's')).toBeNull();
    }
    expect(parseSceneState({ ...state, previewId: null, canConfirm: false }, 's')).not.toBeNull();
  });
});

describe('左手显示指针',()=>{
 it('拒绝越界指针且不发送原始关键点',()=>{
  const f=frame();f.helper=f.operator;f.helper!.pointer.x=2;
  expect(gesturePayload(f).helper).toBeUndefined();
  f.helper!.pointer.x=.3;const payload=gesturePayload(f);
  expect(payload.helper).toMatchObject({u:.3,v:.7,pinching:true});expect(payload.helper).not.toHaveProperty('landmarks');
 });
});


describe('双手显示控制信号',()=>{
 it('张开时独立隐藏指尖数据，释放信号仍送达；靠拢后恢复',()=>{
  const f=frame(); f.operator={...f.operator!,pinchRatio:.8,fingertips:{thumb:{x:.2,y:.3},index:{x:.4,y:.5}},pinching:false,ended:true};
  f.helper={...f.operator,pinchRatio:.4,pinching:true,ended:false,releasing:false};
  const wire=gesturePayload(f);
  expect(wire.operator?.fingertips).toBeUndefined();
  expect(wire.operator).toMatchObject({pinching:false,ended:true,pinchRatio:.8});
  expect(wire.helper?.fingertips).toEqual({thumb:{u:.2,v:.3},index:{u:.4,v:.5}});
  expect(wire.helper).not.toHaveProperty('landmarks');
  f.operator.pinchRatio=.4; f.helper.pinchRatio=.9;
  expect(gesturePayload(f).operator?.fingertips).toBeDefined();
  expect(gesturePayload(f).helper?.fingertips).toBeUndefined();
 });
});
