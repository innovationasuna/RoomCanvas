import test from 'node:test';
import assert from 'node:assert/strict';
import {fallFraction, predictDrop} from '../drop-placement.mjs';
import {initialLayout} from '../layout.mjs';

test('gravity-shaped fall reaches exact landing without overshoot', () => {
  assert.equal(fallFraction(0,1),0);
  assert(fallFraction(.2,1) > fallFraction(.1,1));
  assert.equal(fallFraction(2,1),1);
  assert.equal(fallFraction(0,0),1);
});
test('an obstacle in the vertical path rejects a geometrically valid landing', () => {
  const layout=initialLayout(['toy']); layout.toy.y=1;
  const placement={settle(id,next){next[id].y=0;return {ok:true,surface:{label:'地面'}};},carry(){return {ok:true,moved:['toy']};},assess(){return {state:'stable',height:0,label:'已放稳 · 地面',support:null};}};
  const result=predictDrop('toy',layout,placement,{checkPlacement(){return {ok:true};},limit(){return {blocked:true,other:{name:'椅背'}};}});
  assert.equal(result.ok,false); assert.match(result.message,/椅背/); assert.equal(layout.toy.y,1);
});

test('analog projection is unvalidated and release still checks the entire fall path', () => {
  const layout=initialLayout(['toy']); layout.toy.y=1;
  const placement={settle(id,next){next[id].y=0;return {ok:true,surface:{label:'椅面'}};},carry(){return {ok:true,moved:['toy']};},assess(){return {state:'stable',height:0,label:'已放稳 · 椅面'};}};
  let checks=0;
  const collision={checkPlacement(){checks++;return {ok:true};},limit(){checks++;return {blocked:true,other:{name:'椅背'}};}};
  const preview=predictDrop('toy',layout,placement,collision,{previewOnly:true});
  assert.equal(preview.checked,false); assert.equal(checks,0); assert.equal(layout.toy.y,1);
  assert.equal(predictDrop('toy',layout,placement,collision).ok,false);
  assert.equal(checks,2);
});

test('a fall that stops a hair above a landing already checked clear still lands', () => {
  const layout=initialLayout(['toy']); layout.toy.y=1;
  const placement={settle(id,next){next[id].y=0;return {ok:true,surface:{label:'椅面'}};},carry(){return {ok:true,moved:['toy']};},assess(){return {state:'stable',height:0,label:'已放稳 · 椅面'};}};
  const stopAt = fraction => ({checkPlacement(){return {ok:true};},limit(){return {blocked:true,fraction,other:{name:'椅面'}};}});
  assert.equal(predictDrop('toy',layout,placement,stopAt(.9997)).ok,true);
  assert.equal(predictDrop('toy',layout,placement,stopAt(.99)).ok,false);
});
