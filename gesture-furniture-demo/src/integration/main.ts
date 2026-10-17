import './style.css';
import { GestureRuntime } from './runtime';
import { PROTOCOL, gesturePayload, integrationURL, parseSceneState, observationPayload } from './protocol';

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
let sceneState: ReturnType<typeof parseSceneState> = null;
let pendingMode: number | null = null;
function canSwitch() { return ready && !!sceneState && !sceneState.busy && sceneState.phase === 'idle'; }
function requestMode(mode: string, gesture = false) {
  if (!canSwitch() || pendingMode !== null || mode === sceneState?.mode) return;
  runtime.interrupt(false,gesture); send({ type: 'mode', mode }); pendingMode = sequence;
}
const leftStatus = (text: string, progress=0) => {
  $('left-status').textContent=text;$<HTMLProgressElement>('left-progress').value=progress;
};
const status = (text: string) => { $('camera-status').textContent = text; };
function send(body: Record<string, unknown>) {
  if (!session || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ protocol: PROTOCOL, session, sequence: ++sequence, ...body }, sceneOrigin);
}
const runtime = new GestureRuntime(video, {
  canSwitch,
  frame(frame, sampleTime, inferenceMs) {
    if (frame.modeSelection) requestMode(({1:'move',2:'rotate',3:'view'} as const)[frame.modeSelection],true);
    if (ready) {
      const observing = sceneState?.mode === 'view' && sceneState.capabilities?.includes('observe-pinch-v1');
      send({ type: 'frame', sampleTime, frame: observing ? observationPayload({...frame.observation,helper:frame.helper}) : gesturePayload(frame) });
    }
    status(`${frame.operator ? '右手已识别（蓝色）' : '右手未识别 · 左手仍可选模式'} · 推理 ${inferenceMs.toFixed(0)} ms`);
    const left=frame.leftDetection;
    const labels={1:'移动物体',2:'旋转物体',3:'仅观察'} as const;
    const target=left.digit?labels[left.digit]:'';
    let text='左手未识别，请将左手放入画面';
    if(left.phase==='uncertain')text='左手判断不稳定，请让手掌朝向摄像头';
    else if(left.phase==='ambiguous')text='左手身份不明确，请分开双手';
    else if(left.phase==='blocked')text=sceneState?.busy?'左手已识别 · 操作结束后张掌再选模式':frame.rightHeld?'左手已识别 · 请先松开右手捏合':'左手已识别 · 等待场景连接';
    else if(left.phase==='neutral')text='左手已识别 · 请先张掌，再摆出 1 / 2 / 3';
    else if(left.phase==='pose')text='左手已识别（绿色）· 请摆出 1 / 2 / 3，其他手指收拢';
    else if(left.phase==='confirming')text=`左手 ${left.digit} → ${target} · 确认 ${Math.round(left.progress*100)}%`;
    else if(left.phase==='selected')text=`左手 ${left.digit} → ${target} · 已识别`;
    leftStatus(text,left.progress);
  },
  interrupted(cancelPending) {
    leftStatus('检测已暂停，请先张掌再选择模式');
    if (cancelPending) send({ type: 'stop' });
    else if (ready) send({ type: 'frame', sampleTime: performance.timeOrigin + performance.now(),
      frame: { interrupted: true, ambiguous: false } });
  },
  error(message) { cameraGeneration++; start.disabled = !ready; stop.disabled = true; status(message); },
});
function stopCamera() {
  cameraGeneration++; runtime.stop(); start.disabled = !ready; stop.disabled = true; status('摄像头已关闭');leftStatus('左手检测未开启');
}
function loadScene() {
  try {
    const nextSession = crypto.randomUUID();
    const url = integrationURL(address.value.trim(), location.origin, nextSession);
    stopCamera(); session = nextSession; sceneOrigin = url.origin; sequence = 0; acknowledged = 0;
    ready = false; sceneState = null; pendingMode = null; lastState = 0; start.disabled = true;
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
  acknowledged = state.sequence; ready = true; lastState = performance.now(); sceneState = state;
  if (pendingMode !== null && state.sequence >= pendingMode) pendingMode = null;
  start.disabled = !stop.disabled;
  modeButtons.forEach(b => { b.disabled = state.busy; b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)); });
  $('scene-status').textContent = state.layoutReady || state.mode === 'view' ? state.message : '请先在下方确认房间尺寸并加入物体。';
  $('gesture-help').textContent = state.mode === 'view' ? '右手拇指＋食指捏合环绕；拇指＋食指＋中指合拢平移。松开固定视角。' : state.mode === 'move' ? '右手指向物体后捏合拖动，松开检查承托与碰撞。' : '右手指向物体后捏合，左右移动自由旋转，松开检查碰撞。';
});
modeButtons.forEach(b => b.addEventListener('click', () => requestMode(b.dataset.mode!)));
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
  'http://127.0.0.1:7865/viewforge/layouts/viewer';
loadScene();
