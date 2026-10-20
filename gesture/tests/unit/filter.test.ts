import {describe,it,expect} from 'vitest';
import {OneEuroFilter} from '../../src/shared/filter';
describe('关键点滤波',()=>{
 it('滤波平滑噪声并按真实时间更新',()=>{
  const f=new OneEuroFilter();expect(f.update(0,0)).toBe(0);const filtered=f.update(1,16);expect(filtered).toBeGreaterThan(0);expect(filtered).toBeLessThan(1);
  expect(f.update(1,500)).toBeGreaterThan(filtered);
 });

});
