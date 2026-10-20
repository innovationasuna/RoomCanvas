import test from 'node:test';
import assert from 'node:assert/strict';
import {connectGestureBridge, parseMessage, PROTOCOL, UI_ACTIONS} from '../gesture-bridge.mjs';

test('工作台只接受有限场景操作，下载、文件和任意调用不能通过通信触发', () => {
  for (const action of UI_ACTIONS) assert.ok(parseMessage({protocol:PROTOCOL,session:'s',sequence:1,type:'ui',action}));
  for (const action of ['export','export-layout','import-layout','clear-room','fetch',undefined,{},'']) assert.equal(parseMessage({protocol:PROTOCOL,session:'s',sequence:1,type:'ui',action}),null);
});
test('工作台命令要求本机父窗口、正确会话、递增序号与可操作场景', () => {
  let receive; const calls = [], parent = {postMessage() {}}, state = {layoutReady:true,busy:false};
  const input = {active:false,dual:false,reset(){},interrupt(){}};
  const win = {parent,location:{search:'?gesture_origin=http://127.0.0.1:8800&gesture_session=s'},addEventListener(name,fn){if(name==='message') receive=fn;},setInterval(){return 1;},clearInterval(){}};
  const doc = {hidden:false,addEventListener(){}};
  connectGestureBridge({input,state:()=>state,uiAction:action=>calls.push(action)},{win,doc,clock:{now:()=>100,timeOrigin:1000}});
  let sequence=0;
  const send = (patch={},event={}) => receive({source:parent,origin:'http://127.0.0.1:8800',data:{protocol:PROTOCOL,session:'s',sequence:++sequence,type:'ui',action:'left',...patch},...event});
  send(); assert.equal(calls.length,0);
  send({type:'hello'});send();assert.deepEqual(calls,['left']);
  send({sequence:1});send({session:'wrong'});send({}, {origin:'https://example.com'});send({}, {source:{}});
  state.busy=true;send();state.busy=false;state.layoutReady=false;send();state.layoutReady=true;
  doc.hidden=true;send();doc.hidden=false;input.active=true;send();input.active=false;input.dual=true;send();input.dual=false;
  assert.deepEqual(calls,['left']);send({action:'top'});assert.deepEqual(calls,['left','top']);
});
