import { describe, it, expect, vi } from 'vitest';
import { showFingerGuide } from '../../src/shared/hand-guide';
import { drawHandFeedback } from '../../src/ui/hand-feedback';
import type { GestureFrame, HandSignal } from '../../src/shared/types';
import { hand } from '../fixtures/hands';

const signal = (pinchRatio: number): HandSignal => ({
  pointer:{x:.5,y:.5},wrist:{x:.5,y:.7},palmScale:.2,frontFacing:true,
  fingertips:{thumb:{x:.4,y:.5},index:{x:.6,y:.5}},pinchRatio,
  pinching:false,started:false,ended:false,openPalm:false,
});

describe('指尖操作标记',()=>{
  it('张开到 0.8 隐藏，靠拢后恢复；缺失或非法几何不显示',()=>{
    expect(showFingerGuide(signal(.799))).toBe(true);
    for(const ratio of [.8,1.2,-.1,NaN,Infinity]) expect(showFingerGuide(signal(ratio))).toBe(false);
    expect(showFingerGuide(undefined)).toBe(false);
    expect(showFingerGuide({pinchRatio:.2})).toBe(false);
    expect(showFingerGuide({...signal(.4),pinchRatio:undefined})).toBe(false);
    expect(showFingerGuide(signal(.4))).toBe(true);
  });
  it('摄像头保留完整骨架，只隐藏张开一侧的强调标记',()=>{
    const ctx={clearRect:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),fill:vi.fn(),arc:vi.fn()};
    const canvas={width:320,height:240,getContext:()=>ctx} as unknown as HTMLCanvasElement;
    const frame={timestamp:10,hands:[hand('Right'),hand('Left')],inferenceMs:10};
    const gesture:GestureFrame={timestamp:10,operator:signal(.9),helper:signal(.4),interrupted:false,ambiguous:false,menuRequested:false};
    drawHandFeedback(canvas,frame,gesture);
    expect(ctx.arc.mock.calls.filter(c=>c[2]===2.1)).toHaveLength(42);
    expect(ctx.arc.mock.calls.filter(c=>c[2]===5)).toHaveLength(2);
    expect(ctx.arc.mock.calls.filter(c=>c[2]===4)).toHaveLength(1);
    ctx.arc.mockClear(); gesture.operator=signal(.4); gesture.helper=signal(.9);
    drawHandFeedback(canvas,frame,gesture);
    expect(ctx.arc.mock.calls.filter(c=>c[2]===5)).toHaveLength(2);
    ctx.arc.mockClear(); gesture.operator=signal(.8);
    drawHandFeedback(canvas,frame,gesture);
    expect(ctx.arc.mock.calls.filter(c=>c[2]!==2.1)).toHaveLength(0);
  });
});
