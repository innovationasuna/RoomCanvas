import './style.css';
import { NUMBER_MODES } from '../gestures/number-mode';
import { drawHandFeedback, numberFeedback, thumbFeedback } from '../ui/hand-feedback';
import { GestureRuntime } from './runtime';
import { PROTOCOL, gesturePayload, integrationURL, parseSceneState, observationPayload } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = $<HTMLIFrameElement>('scene');
const video = $<HTMLVideoElement>('camera');
const skeleton = $<HTMLCanvasElement>('skeleton');
const clearSkeleton = () => skeleton.getContext('2d')!.clearRect(0,0,skeleton.width,skeleton.height);
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
function confirmationTarget() {
  const supported = ready && !!sceneState?.capabilities?.includes('thumb-confirm-v1');
  return {previewId: supported ? sceneState?.previewId ?? null : null,
    allowed: supported && sceneState?.canConfirm === true && pendingMode === null};
}
function supportsMode(mode: string) {
  return !!sceneState?.capabilities?.includes('dual-hand-v2') || ['move','rotate','view'].includes(mode);
}
function requestMode(mode: string, gesture = false) {
  if (!supportsMode(mode) || !canSwitch() || pendingMode !== null || mode === sceneState?.mode) return;
  runtime.interrupt(false,gesture); send({ type: 'mode', mode }); pendingMode = sequence;
}
const leftStatus = (text: string, progress=0) => {
  $('left-status').textContent=text;$<HTMLProgressElement>('left-progress').value=progress;
};
const rightStatus = (text: string, progress=0) => {
  $('right-status').textContent=text;$<HTMLProgressElement>('right-progress').value=progress;
};
const status = (text: string) => { $('camera-status').textContent = text; };
function send(body: Record<string, unknown>) {
  if (!session || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ protocol: PROTOCOL, session, sequence: ++sequence, ...body }, sceneOrigin);
}
const runtime = new GestureRuntime(video, {
  canSwitch,
  confirmationTarget,
  frame(frame, sampleTime, tracking) {
    if (frame.modeSelection) requestMode(NUMBER_MODES[frame.modeSelection],true);
    if (ready) {
      const legacy = !sceneState?.capabilities?.includes('dual-hand-v2');
      const observing = legacy && sceneState?.mode === 'view' && sceneState.capabilities?.includes('observe-pinch-v1');
      send({type:'frame',sampleTime,frame:observing ? observationPayload({...frame.observation,helper:frame.helper}) : gesturePayload(frame)});
      // 先处理释放帧，再确认同一预览，不模拟控件点击。
      const target = confirmationTarget();
      if (frame.placementConfirmation && target.allowed && frame.placementConfirmation === target.previewId) {
        send({type:'confirm',sampleTime,previewId:frame.placementConfirmation});
      }
    }
    drawHandFeedback(skeleton,tracking,frame,video);
    status(`${frame.operator ? '右手已识别' : '右手未识别'} · 推理 ${tracking.inferenceMs.toFixed(0)} ms`);
    leftStatus(frame.leftDetection.digit && !supportsMode(NUMBER_MODES[frame.leftDetection.digit]) ?
      '当前场景不支持这个模式，请更新编辑器' : numberFeedback(frame.leftDetection),frame.leftDetection.progress);
    rightStatus(sceneState?.capabilities?.includes('thumb-confirm-v1') ? thumbFeedback(frame.rightConfirmation) :
      '当前场景不支持竖拇指确认，请使用放置按钮',frame.rightConfirmation.progress);
  },
  interrupted(cancelPending) {
    clearSkeleton();
    leftStatus(stop.disabled ? '左手检测未开启' : '检测已暂停，请先张掌再选择模式');
    rightStatus(stop.disabled ? '右手确认检测未开启' : '检测已暂停，请放下拇指后再确认');
    if (cancelPending) send({ type: 'stop' });
    else if (ready) send({ type: 'frame', sampleTime: performance.timeOrigin + performance.now(),
      frame: { interrupted: true, helperInterrupted: true, ambiguous: false } });
  },
  error(message) { clearSkeleton(); rightStatus('右手确认检测未开启'); cameraGeneration++; start.disabled = !ready; stop.disabled = true; status(message); },
});
function stopCamera() {
  cameraGeneration++; runtime.stop(); start.disabled = !ready; stop.disabled = true; status('摄像头已关闭');leftStatus('左手检测未开启');
  clearSkeleton();rightStatus('右手确认检测未开启');
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
  start.disabled = !state.layoutReady || !stop.disabled;
  modeButtons.forEach(b => {
    b.disabled = !canSwitch() || pendingMode !== null || !supportsMode(b.dataset.mode!);
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  });
  $('scene-status').textContent = state.layoutReady ? state.message : '请等待下方 RoomCanvas 房间加载完成。';
  $('gesture-help').textContent = ({
    move:'右手捏住家具沿平面移动，保持当前高度；松手保留预览，竖拇指约 0.5 秒确认放置。',
    height:'右手捏住家具升降；松手保持悬空，切换 1 可继续平移；确认后才落下。',
    scale:'数字 3：拇食指成圈，其余三指伸出。选中后先松手，再双手捏合拉开或靠近缩放场景。',
    rotate:'右手横移一画面宽度旋转 1080°；松手保留预览，竖拇指确认。',
    view:'左手捏合环绕；双手捏合拉开或靠近缩放场景。',
  })[state.mode];
  if (!state.capabilities?.includes('dual-hand-v2')) {
    $('gesture-help').textContent = state.mode === 'view' ? '旧版观察：右手两指捏合环绕、三指合拢平移。' :
      '当前连接为旧版场景；移动、旋转和放置沿用场景原有规则。更新编辑器后使用完整双手控制。';
  }
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
  'http://127.0.0.1:7880/web/editor/?room=room3';
loadScene();
