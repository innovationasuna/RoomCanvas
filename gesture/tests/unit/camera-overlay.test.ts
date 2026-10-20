import {describe, expect, it, vi} from 'vitest';
import {drawHandFeedback} from '../../src/ui/hand-feedback';
import {hand} from '../fixtures/hands';

describe('摄像头骨架叠层',()=>{
 it('使用视频原始尺寸且只镜像一次，切换宽高比后继续对齐',()=>{
  const context={clearRect:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn()};
  const canvas={width:640,height:480,getContext:()=>context} as unknown as HTMLCanvasElement;
  const tracking={timestamp:0,inferenceMs:5,hands:[hand('Left',false,.2)]};
  const gesture={timestamp:0,menuRequested:false,interrupted:false,ambiguous:false};
  for(const [width,height] of [[1280,720],[640,480],[720,1280]]){
   context.moveTo.mockClear();
   drawHandFeedback(canvas,tracking,gesture,{videoWidth:width,videoHeight:height});
   expect([canvas.width,canvas.height]).toEqual([width,height]);
   expect(context.moveTo.mock.calls[0][0]).toBeCloseTo(.8*width);
   expect(context.moveTo.mock.calls[0][1]).toBeCloseTo(.8*height);
   expect(context.clearRect).toHaveBeenLastCalledWith(0,0,width,height);
  }
 });
 it('视频尚未就绪时保持有效画布，空追踪帧清除旧骨架',()=>{
  const clearRect=vi.fn();
  const canvas={width:640,height:480,getContext:()=>({clearRect})} as unknown as HTMLCanvasElement;
  drawHandFeedback(canvas,{timestamp:0,inferenceMs:0,hands:[]},
   {timestamp:0,menuRequested:false,interrupted:false,ambiguous:false},{videoWidth:0,videoHeight:0});
  expect([canvas.width,canvas.height]).toEqual([640,480]);
  expect(clearRect).toHaveBeenCalledWith(0,0,640,480);
 });
});
