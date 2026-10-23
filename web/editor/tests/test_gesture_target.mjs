import test from 'node:test';
import assert from 'node:assert/strict';
import {canGestureActivate, isExplicitExport} from '../gesture-target.mjs';

function button(overrides = {}) {
  return {disabled:false,parentElement:null,closest:()=>null,checkVisibility:()=>true,...overrides};
}
test('折叠菜单中的按钮不能被手势吸附，菜单标题仍可打开，关闭后缓存目标失效',()=>{
  const summary=button(), child=button(), details={localName:'details',open:false,parentElement:null,querySelector:()=>({contains:node=>node===summary})};
  summary.parentElement=details;child.parentElement=details;
  assert.equal(canGestureActivate(summary),true);
  assert.equal(canGestureActivate(child),false);
  details.open=true;assert.equal(canGestureActivate(child),true);
  details.open=false;assert.equal(canGestureActivate(child),false);
});
test('隐藏、透明、禁用和明确排除的控件不接受手势，正常放置按钮仍可操作',()=>{
  assert.equal(canGestureActivate(button()),true);
  assert.equal(canGestureActivate(button({disabled:true})),false);
  assert.equal(canGestureActivate(button({closest:()=>({})})),false);
  assert.equal(canGestureActivate(button({checkVisibility:()=>false})),false);
  assert.equal(canGestureActivate(null),false);
});
test('嵌套折叠菜单不能绕过外层可见性限制',()=>{
  const outer={localName:'details',open:false,parentElement:null,querySelector:()=>null};
  const inner={localName:'details',open:true,parentElement:outer};
  assert.equal(canGestureActivate(button({parentElement:inner})),false);
});
test('导出只接受可信的鼠标或键盘点击，重复脚本点击也不会下载',()=>{
  assert.equal(isExplicitExport({isTrusted:true}),true);
  for(let i=0;i<20;i++) assert.equal(isExplicitExport({isTrusted:false}),false);
  assert.equal(isExplicitExport(undefined),false);
});
