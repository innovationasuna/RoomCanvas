import { describe, it, expect } from 'vitest';
import { NumberModeSelector, classifyLeftNumber } from '../../src/gestures/number-mode';
import { hand } from '../fixtures/hands';
import type { Hand } from '../../src/shared/types';
export function numberHand(digit: number, side: 'Left'|'Right' = 'Left'): Hand {
  const h = hand(side,false,.8);
  for (const mcp of [5,9,13,17].slice(digit)) h.landmarks[mcp+3] = {...h.landmarks[mcp],y:.73};
  h.landmarks[4] = { ...h.landmarks[1] }; // thumb folded
  h.world = h.landmarks.map(p=>({...p}));
  return h;
}
const frame=(timestamp:number,hands:Hand[])=>({timestamp,hands,inferenceMs:5});
function hold(selector:NumberModeSelector,h:Hand,from:number,allowed=true){let result=null;for(let t=from;t<=from+400;t+=100)result=selector.process(frame(t,[h]),4/3,allowed);return result;}
describe('左手数字模式',()=>{
 it('只识别已确认的食指、食中指、食中无名指模式',()=>{
  expect([1,2,3].map(n=>classifyLeftNumber(numberHand(n)))).toEqual([1,2,3]);
  expect(classifyLeftNumber(numberHand(4))).toBeNull();expect(classifyLeftNumber(numberHand(0))).toBeNull();
  const wrong=numberHand(3);wrong.landmarks[8]={...wrong.landmarks[5],y:.73};wrong.landmarks[20]={...hand('Left').landmarks[20]};
  expect(classifyLeftNumber(wrong)).toBeNull();
 });
 it('对镜像、平面旋转和统一尺度保持一致',()=>{
  for(const digit of [1,2,3])for(const scale of [.5,2]){
   const h=numberHand(digit);h.landmarks=h.landmarks.map(p=>({x:.4-(p.y-.5)*scale,y:.5+(p.x-.5)*scale,z:p.z*scale}));
   expect(classifyLeftNumber(h)).toBe(digit);
  }
 });
 it('右手、低分、退化关键点和不确定手指不能触发',()=>{
  expect(classifyLeftNumber(numberHand(1,'Right'))).toBeNull();const h=numberHand(1);h.score=.7;expect(classifyLeftNumber(h)).toBeNull();
  h.score=.95;h.landmarks[8].x=NaN;expect(classifyLeftNumber(h)).toBeNull();
  const degenerate=numberHand(1);degenerate.landmarks=Array.from({length:21},()=>({x:.5,y:.5,z:0}));expect(classifyLeftNumber(degenerate)).toBeNull();
 });
 it('稳定 400ms 只触发一次，空闲时可直接稳定切换到另一数字',()=>{
  const s=new NumberModeSelector();expect(hold(s,numberHand(1),0)).toBe(1);expect(hold(s,numberHand(1),500)).toBeNull();
  expect(hold(s,numberHand(2),1000)).toBe(2);
  for(const t of [1500,1600,1700])s.process(frame(t,[hand('Left',false,.8)]),4/3,true);
  expect(hold(s,numberHand(2),1800)).toBe(2);
 });
 it('切换中回到原数字会重新计时，不能累计不连续的新姿态',()=>{
  const s=new NumberModeSelector();expect(hold(s,numberHand(1),0)).toBe(1);
  s.process(frame(500,[numberHand(2)]),4/3,true);s.process(frame(600,[numberHand(1)]),4/3,true);
  for(const t of [700,800,900,1000])expect(s.process(frame(t,[numberHand(2)]),4/3,true)).toBeNull();
  expect(s.process(frame(1100,[numberHand(2)]),4/3,true)).toBe(2);
 });
 it('短暂过渡会重新计时，双候选和右手不能替代左手',()=>{
  const s=new NumberModeSelector();s.process(frame(0,[numberHand(1)]),4/3,true);s.process(frame(100,[numberHand(2)]),4/3,true);
  s.process(frame(200,[numberHand(1),numberHand(1)]),4/3,true);
  expect(hold(s,numberHand(1,'Right'),300)).toBeNull();
 });
 it('忙碌期间忽略数字，不在空闲时补发',()=>{
  const s=new NumberModeSelector();expect(hold(s,numberHand(3),0,false)).toBeNull();expect(hold(s,numberHand(3),500)).toBeNull();
  for(const t of [1000,1100,1200])s.process(frame(t,[hand('Left',false,.8)]),4/3,true);
  expect(hold(s,numberHand(3),1300)).toBe(3);
 });
 it('丢失后仍保持数字不会切换，需中性姿态重新确认',()=>{
  const s=new NumberModeSelector();s.process(frame(0,[numberHand(1)]),4/3,true);s.process(frame(100,[]),4/3,true);s.process(frame(300,[]),4/3,true);
  expect(hold(s,numberHand(1),400)).toBeNull();
  for(const t of [900,1000,1100])s.process(frame(t,[hand('Left',false,.8)]),4/3,true);
  expect(hold(s,numberHand(1),1200)).toBe(1);
 });
});

describe('真人收拢手指与左手检测反馈',()=>{
 it('指尖两节仍直但近端折回的自然握法也能识别 1/2/3',()=>{
  for(const digit of [1,2,3]){
   const h=numberHand(digit);
   for(const mcp of [5,9,13,17].slice(digit)){
    const p=h.landmarks[mcp];h.landmarks[mcp+1]={...p,y:p.y-.04,z:-.02};
    h.landmarks[mcp+2]={...p,y:p.y+.04,z:-.02};h.landmarks[mcp+3]={...p,y:p.y+.10,z:-.02};
   }
   expect(classifyLeftNumber(h)).toBe(digit);
  }
 });
 it('确认进度、数字与已识别状态分别输出',()=>{
  const s=new NumberModeSelector();s.process(frame(0,[numberHand(2)]),4/3,true);
  expect(s.state).toEqual({detected:true,digit:2,progress:0,phase:'confirming'});
  s.process(frame(100,[numberHand(2)]),4/3,true);s.process(frame(200,[numberHand(2)]),4/3,true);
  expect(s.state.progress).toBe(.5);s.process(frame(300,[numberHand(2)]),4/3,true);
  expect(s.process(frame(400,[numberHand(2)]),4/3,true)).toBe(2);
  expect(s.state).toEqual({detected:true,digit:2,progress:1,phase:'selected'});
 });
 it('区分没有左手、低置信度、双候选和被禁止切换',()=>{
  const s=new NumberModeSelector();s.process(frame(0,[]),4/3,true);expect(s.state.phase).toBe('missing');
  const low=numberHand(1);low.score=.7;s.process(frame(10,[low]),4/3,true);expect(s.state.phase).toBe('uncertain');
  s.process(frame(20,[numberHand(1),numberHand(1)]),4/3,true);expect(s.state.phase).toBe('ambiguous');
  s.process(frame(30,[numberHand(1)]),4/3,false);expect(s.state.phase).toBe('blocked');
  s.process(frame(40,[numberHand(1)]),4/3,true);expect(s.state.phase).toBe('neutral');
 });
});
