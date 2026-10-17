import { describe, it, expect } from 'vitest';
import { ObservationRecognizer } from '../../src/gestures/observe-pinch';
import { observationPayload } from '../../src/integration/protocol';
import { hand } from '../fixtures/hands';
import type { Hand } from '../../src/shared/types';
function pose(action:'orbit'|'pan',x=.5):Hand{
 const h=hand('Right',true,x);
 if(action==='pan')h.landmarks[12]={...h.landmarks[8],x:h.landmarks[8].x+.005};
 h.world=h.landmarks.map(p=>({...p}));return h;
}
const frame=(timestamp:number,hands:Hand[])=>({timestamp,hands,inferenceMs:5});
function begin(action:'orbit'|'pan'){
 const r=new ObservationRecognizer();r.process(frame(0,[hand()]));r.process(frame(10,[pose(action)]));
 return {r,signal:r.process(frame(110,[pose(action)]))};
}
describe('观察模式两指/三指捏合',()=>{
 it('两指确认环绕，三指确认平移',()=>{
  for(const action of ['orbit','pan']as const){const {signal}=begin(action);expect(signal.operator?.started).toBe(true);expect(signal.operator?.action).toBe(action);}
 });
 it('抓取开始后动作锁定，不能在拖动中突然改为平移',()=>{
  const {r}=begin('orbit');expect(r.process(frame(140,[pose('pan')])).operator?.action).toBe('orbit');
 });
 it('三指散开第一帧冻结，确认后结束；两指仍合拢不能立即变为环绕',()=>{
  const {r}=begin('pan');const stable=r.process(frame(140,[pose('pan')]));
  const released=pose('orbit');released.landmarks[8].y-=.02;released.landmarks[4].y-=.02;
  const first=r.process(frame(150,[released]));expect(first.operator?.releasing).toBe(true);expect(first.operator?.pointer).toEqual(stable.operator?.pointer);
  const ended=r.process(frame(190,[released]));expect(ended.operator?.ended).toBe(true);expect(ended.operator?.action).toBe('pan');
  expect(r.process(frame(220,[pose('orbit')])).operator?.pinching).toBe(false);
  r.process(frame(260,[hand()]));r.process(frame(300,[pose('orbit')]));expect(r.process(frame(400,[pose('orbit')])).operator?.started).toBe(true);
 });
 it('初始已合拢、重置后合拢需要先松开',()=>{
  const r=new ObservationRecognizer();for(const t of [0,100,200])expect(r.process(frame(t,[pose('pan')])).operator?.pinching).toBe(false);
  r.process(frame(240,[hand()]));r.process(frame(260,[pose('pan')]));expect(r.process(frame(360,[pose('pan')])).operator?.started).toBe(true);
  r.reset();expect(r.process(frame(400,[pose('pan')])).operator?.pinching).toBe(false);
 });
 it('丢手冻结，中断后不能被左手或低置信度右手接管',()=>{
  const {r}=begin('pan');expect(r.process(frame(140,[])).operator).toBeUndefined();expect(r.process(frame(350,[])).interrupted).toBe(true);
  expect(r.process(frame(380,[pose('pan')])).operator?.pinching).toBe(false);
  expect(r.process(frame(400,[hand('Left',true)])).operator).toBeUndefined();
  const low=pose('pan');low.score=.7;expect(r.process(frame(420,[low])).operator).toBeUndefined();
 });
 it('双右手歧义与停顿后恢复不输出活动姿态',()=>{
  const {r}=begin('orbit');expect(r.process(frame(140,[pose('orbit'),pose('orbit',.6)])).operator).toBeUndefined();
  expect(r.process(frame(400,[pose('orbit')])).interrupted).toBe(true);
 });
 it('最小观察消息只扩展动作，不发送关键点或手掌尺度',()=>{
  const {signal}=begin('pan');const payload=observationPayload(signal);expect(payload.operator?.observation).toBe('pan');
  expect(Object.keys(payload.operator!)).toEqual(['u','v','pinching','started','ended','releasing','observation']);
 });
});
