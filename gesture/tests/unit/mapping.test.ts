import {describe,it,expect} from 'vitest';
import {constrainFurniture,mapXYZ} from '../../src/controls/mapping';
import {OneEuroFilter} from '../../src/shared/filter';
import {TargetTask,TARGETS} from '../../src/scene/xyz/targets';
describe('坐标映射与定位任务',()=>{
 it('旋转后的家具包围范围保持在房间内',()=>{
  const t=constrainFurniture({position:{x:10,y:4,z:10},rotation:Math.PI/2,scale:1},{x:2,y:1,z:1});
  expect(t.position.x).toBe(2.5);expect(t.position.z).toBe(1.5);expect(t.position.y).toBe(2);
 });
 it('手掌变大向观察者靠近，且极端尺寸有边界',()=>{
  const axes={right:{x:1,y:0,z:0},up:{x:0,y:1,z:0},forward:{x:0,y:0,z:-1}};
  const p=mapXYZ({x:0,y:1,z:0},.1,-.1,1.2,axes);expect(p.x).toBe(.5);expect(p.y).toBe(1.5);expect(p.z).toBeGreaterThan(0);
  expect(mapXYZ({x:0,y:1,z:0},20,20,100,axes).x).toBe(2.5);
 });
 it('滤波平滑噪声并按真实时间更新',()=>{
  const f=new OneEuroFilter();expect(f.update(0,0)).toBe(0);const filtered=f.update(1,16);expect(filtered).toBeGreaterThan(0);expect(filtered).toBeLessThan(1);
  expect(f.update(1,500)).toBeGreaterThan(filtered);
 });
 it('目标连续停留 1 秒才成功，暂停不累计',()=>{
  const task=new TargetTask();task.update(TARGETS[0],0,true);task.update(TARGETS[0],800,true);expect(task.index).toBe(0);
  task.update(TARGETS[0],900,false);task.update(TARGETS[0],1200,true);task.update(TARGETS[0],2201,true);expect(task.index).toBe(1);
 });
});
