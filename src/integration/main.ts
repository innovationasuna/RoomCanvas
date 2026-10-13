import './style.css';
import { GestureRuntime } from './runtime';
import { PROTOCOL, gesturePayload, integrationURL, parseSceneState } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = $<HTMLIFrameElement>('scene');
const video = $<HTMLVideoElement>('camera');
const start = $<HTMLButtonElement>('start');
const stop = $<HTMLButtonElement>('stop');
const address = $<HTMLInputElement>('address');
const connect = $<HTMLButtonElement>('connect');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
let session = '', sceneOrigin = '', sequence = 0, acknowledged = 0, ready = false, lastState = 0;
let cameraGeneration = 0;
const status = (text: string) => { $('camera-status').textContent = text; };
function send(body: Record<string, unknown>) {
  if (!session || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ protocol: PROTOCOL, session, sequence: ++sequence, ...body }, sceneOrigin);
}
const runtime = new GestureRuntime(video, {
  frame(frame, sampleTime, inferenceMs) {
    if (ready) send({ type: 'frame', sampleTime, frame: gesturePayload(frame) });
    status(`${frame.operator ? '右手已识别' : '请让右手进入画面'} · 推理 ${inferenceMs.toFixed(0)} ms`);
  },
  interrupted(cancelPending) {
    if (cancelPending) send({ type: 'stop' });
    else if (ready) send({ type: 'frame', sampleTime: performance.timeOrigin + performance.now(),
      frame: { interrupted: true, ambiguous: false } });
  },
  error(message) { cameraGeneration++; start.disabled = !ready; stop.disabled = true; status(message); },
});
function stopCamera() {
  cameraGeneration++; runtime.stop(); start.disabled = !ready; stop.disabled = true; status('摄像头已关闭');
}
function loadScene() {
  try {
    const nextSession = crypto.randomUUID();
    const url = integrationURL(address.value.trim(), location.origin, nextSession);
    stopCamera(); session = nextSession; sceneOrigin = url.origin; sequence = 0; acknowledged = 0;
    ready = false; lastState = 0; start.disabled = true;
    modeButtons.forEach(b => { b.disabled = true; });
    iframe.src = url.href;
    $('scene-status').textContent = '正在连接房间布局…';
  } catch (error) { $('scene-status').textContent = error instanceof Error ? error.message : String(error); }
}
iframe.addEventListener('load', () => {
  ready = false; lastState = 0; runtime.interrupt(); send({ type: 'hello' });
});
window.addEventListener('message', event => {
  if (event.source !== iframe.contentWindow || event.origin !== sceneOrigin) return;
  const state = parseSceneState(event.data, session);
  if (!state || state.sequence < acknowledged || state.sequence > sequence) return;
  acknowledged = state.sequence; ready = true; lastState = performance.now();
  start.disabled = !stop.disabled;
  modeButtons.forEach(b => { b.disabled = state.busy; b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)); });
  $('scene-status').textContent = state.layoutReady ? state.message : '请先在下方确认房间尺寸并加入物体。';
});
modeButtons.forEach(b => b.addEventListener('click', () => { runtime.interrupt(); send({ type: 'mode', mode: b.dataset.mode }); }));
connect.addEventListener('click', loadScene);
start.addEventListener('click', () => void (async () => {
  if (!ready) { status('请先连接房间布局。'); return; }
  const generation = ++cameraGeneration; start.disabled = true; stop.disabled = false; status('正在开启摄像头…');
  if (await runtime.start()) { if (generation === cameraGeneration) status('摄像头已开启；先松手，再捏合抓取。'); }
  else if (generation === cameraGeneration) { start.disabled = !ready; stop.disabled = true; }
})());
stop.addEventListener('click', stopCamera);
$('cancel').addEventListener('click', () => { runtime.interrupt(true); status('已取消操作；松手后重新抓取。'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) runtime.interrupt(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') runtime.interrupt(true); });
window.addEventListener('pagehide', () => { clearInterval(timer); runtime.stop(); });
const timer = window.setInterval(() => {
  if (!ready && session) send({ type: 'hello' });
  if (ready && performance.now() - lastState > 1500) {
    stopCamera(); ready = false; start.disabled = true; modeButtons.forEach(b => { b.disabled = true; });
    $('scene-status').textContent = '场景连接已中断，正在重连…';
  }
}, 500);
address.value = new URLSearchParams(location.search).get('layout') ??
  'http://127.0.0.1:7865/gradio_api/file=/workspace/geyinuo/ViewForge/code/scripts/assets/room-layout.html';
loadScene();
