import './style.css';
import './site-pages.css';
import { setupSite } from './site';
import { setupSceneLoading } from './scene-loading';
import { NUMBER_MODES } from '../gestures/number-mode';
import { drawHandFeedback, numberFeedback, thumbFeedback } from '../ui/hand-feedback';
import { GestureRuntime } from './runtime';
import { PROTOCOL, gesturePayload, integrationURL, parseSceneState, observationPayload } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const iframe = $<HTMLIFrameElement>('scene');
const video = $<HTMLVideoElement>('camera');
const skeleton = $<HTMLCanvasElement>('skeleton');
const start = $<HTMLButtonElement>('start');
const stop = $<HTMLButtonElement>('stop');
const address = $<HTMLInputElement>('address');
const connect = $<HTMLButtonElement>('connect');
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];
let session = '', sceneOrigin = '', sequence = 0, acknowledged = 0, ready = false, lastState = 0;
let cameraGeneration = 0;
let sceneState: ReturnType<typeof parseSceneState> = null;
let pendingMode: number | null = null;
let site: ReturnType<typeof setupSite> | undefined, loadedRoom = '', loadStarted = 0, fineMode = '', renderedState = '';
const sceneLoading = setupSceneLoading($('scene-loading'));
const uiActions = new Set(['left','right','forward','back','up','down','rotate-left','rotate-right','store','overview','top','zoom-in','zoom-out','edit','preview','change-wall']);
function cameraVisible(on: boolean) {
  document.body.classList.toggle('camera-on', on);
  document.querySelector<HTMLElement>('.gesture-feedback')!.hidden = !on;
}
function sceneAction(action: string) {
  if (!ready || !sceneState?.layoutReady || !sceneState.capabilities?.includes('studio-ui-v1') || !uiActions.has(action)) return;
  if (action === 'preview' && sceneState.previewId) {site?.notice('请先确认或取消这次试摆，再欣赏整个房间。'); return;}
  runtime.interrupt(); send({type:'ui',action});
}
function syncStudio() {
  const state = sceneState;
  if (!state) return;
  if (state.layoutReady) sceneLoading.ready();
  $('selected-title').textContent = state.selectedName || '未选择家具';
  $('choose-wall').hidden = !state.selectedWall;
  $('choose-wall').textContent = state.wallEditing ? '取消选择墙面' : '选择安装墙面';
  $<HTMLButtonElement>('choose-wall').disabled = state.busy;
  $('selected-description').textContent = state.selectedDescription || '';
  $('selected-description').hidden = !state.selectedDescription;
  $('placement-label').textContent = state.previewId ? (state.busy ? '正在检查' : state.pendingValid === false ? '请调整位置' : '待确认') : '未选择';
  $<HTMLButtonElement>('confirm').disabled = !state.canConfirm || state.pendingValid === false;
  $<HTMLButtonElement>('cancel').disabled = !state.previewId;
  $<HTMLButtonElement>('store-selected').disabled = !state.selectedId || state.busy;
  document.querySelectorAll('[data-scene-ui="edit"],[data-scene-ui="preview"]').forEach(button => button.setAttribute('aria-pressed',String((button as HTMLElement).dataset.sceneUi === state.editorMode)));
  if (fineMode !== state.mode) {
    fineMode = state.mode;
    const controls = state.mode === 'rotate' ? [['rotate-left','↶ 左转'],['rotate-right','↷ 右转']] : state.mode === 'height' ? [['up','↑ 抬高'],['down','↓ 放低']] : state.mode === 'scale' ? [['zoom-out','− 缩小'],['zoom-in','＋ 放大']] : state.mode === 'view' ? [['overview','整体'],['top','俯视']] : [['left','←'],['forward','↑'],['back','↓'],['right','→']];
    $('fine-controls').replaceChildren(...controls.map(([action,label]) => {
      const button = document.createElement('button');button.dataset.sceneUi=action;button.textContent=label;
      button.setAttribute('aria-label',({left:'向左移动',right:'向右移动',forward:'向前移动',back:'向后移动'} as Record<string,string>)[action] || label);return button;
    }));
  }
  $('fine-controls').querySelectorAll<HTMLButtonElement>('button').forEach(b => {b.disabled = !state.layoutReady || state.busy || (!['overview','top','zoom-in','zoom-out'].includes(b.dataset.sceneUi!) && !state.selectedId) || (!!state.selectedWall && b.dataset.sceneUi!.startsWith('rotate-'));});
  if (site?.page === 'furniture' && state.screen === 'studio' && state.previewId) site.selectionOpened();
  const desired = site?.page === 'furniture' ? 'library' : 'studio';
  if (state.layoutReady && state.screen && state.screen !== desired && !state.previewId) send({type:'ui',action:desired});
}
function canSwitch() { return ready && !!sceneState && !sceneState.busy && sceneState.phase === 'idle'; }
function confirmationTarget() {
  const supported = ready && !!sceneState?.capabilities?.includes('thumb-confirm-v1');
  return { previewId: supported ? sceneState?.previewId ?? null : null,
    allowed: supported && sceneState?.canConfirm === true && pendingMode === null };
}
function supportsMode(mode:string) {return !!sceneState?.capabilities?.includes('dual-hand-v2') || ['move','rotate','view'].includes(mode);}
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
      // 先送释放帧，再确认指定预览；不模拟鼠标点击，不会触发导出等其他控件。
      const target = confirmationTarget();
      if (frame.placementConfirmation && target.allowed && frame.placementConfirmation === target.previewId) {
        send({type:'confirm',sampleTime,previewId:frame.placementConfirmation});
      }
    }
    drawHandFeedback(skeleton,tracking,frame,video);
    status(`${frame.operator ? '右手已识别' : '右手未识别'} · ${frame.leftDetection.detected ? '左手已识别' : '左手未识别'}`);
    leftStatus(frame.leftDetection.digit && !supportsMode(NUMBER_MODES[frame.leftDetection.digit]) ? '当前旧版场景不支持这个模式，请连接 RoomCanvas 房间' : numberFeedback(frame.leftDetection),frame.leftDetection.progress);
    rightStatus(sceneState?.capabilities?.includes('thumb-confirm-v1') ? thumbFeedback(frame.rightConfirmation) :
      '当前场景未支持竖拇指确认，请刷新房间或使用放置按钮',frame.rightConfirmation.progress);
  },
  interrupted(cancelPending) {
    leftStatus(stop.disabled ? '左手检测未开启' : '检测已暂停，请先张掌再选择模式');
    rightStatus(stop.disabled ? '右手确认检测未开启' : '检测已暂停，请放下拇指后再确认');
    skeleton.getContext('2d')!.clearRect(0,0,skeleton.width,skeleton.height);
    if (cancelPending) send({ type: 'stop' });
    else if (ready) send({ type: 'frame', sampleTime: performance.timeOrigin + performance.now(),
      frame: { interrupted: true, helperInterrupted:true, ambiguous: false } });
  },
  error(message) { cameraVisible(false); cameraGeneration++; start.disabled = !ready; stop.disabled = true; status(message); rightStatus('右手确认检测未开启'); },
});
function stopCamera() {
  cameraVisible(false);
  cameraGeneration++; runtime.stop(); start.disabled = !ready; stop.disabled = true; status('摄像头已关闭');leftStatus('左手检测未开启');skeleton.getContext('2d')!.clearRect(0,0,skeleton.width,skeleton.height);
  rightStatus('右手确认检测未开启');
}
function loadScene() {
  try {
    const nextSession = crypto.randomUUID();
    const url = integrationURL(address.value.trim(), location.origin, nextSession);
    url.searchParams.set('studio','1');
    loadStarted = performance.now(); sceneLoading.start(); $('retry-scene').hidden = true;
    $('scene-loading').querySelector('p')!.hidden = true;
    stopCamera(); session = nextSession; sceneOrigin = url.origin; sequence = 0; acknowledged = 0;
    ready = false; sceneState = null; pendingMode = null; lastState = 0; start.disabled = true;
    modeButtons.forEach(b => { b.disabled = true; });
    iframe.src = url.href;
    $('scene-status').textContent = '正在连接房间布局…';
    $('selected-title').textContent = '未选择家具';
    $('selected-description').textContent = ''; $('selected-description').hidden = true;
    for (const button of document.querySelectorAll<HTMLButtonElement>('#confirm,#cancel,#store-selected,#choose-wall,#fine-controls button')) button.disabled = true;
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
  const {sequence: _messageSequence, ...visibleState} = state;
  const signature = JSON.stringify(visibleState) + `:${pendingMode}:${stop.disabled}:${site?.page}`;
  if (signature === renderedState) return;
  renderedState = signature;
  start.disabled = !state.layoutReady || !stop.disabled;
  syncStudio();
  const modern = state.capabilities?.includes('dual-hand-v2');
  modeButtons.forEach(b => {
    b.disabled = !canSwitch() || pendingMode !== null || (!modern && ['height','scale'].includes(b.dataset.mode!));
    b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode));
  });
  const label = modeButtons.find(b=>b.dataset.mode===state.mode)?.textContent ?? state.mode;
  $('mode-status').textContent = label;
  $('scene-status').textContent = state.message || (state.layoutReady ? '' : '正在准备场景…');
  $('scene-status').hidden = !state.message && state.layoutReady;
  $('compatibility').hidden = !!modern;
  $('gesture-help').textContent = stop.disabled ? ({move:'点选家具后，用箭头微调位置；也可以拖动家具。',height:'用上、下按钮调整高度。确认放置后会落到支撑面。',rotate:'每次转动 15°。试试新的朝向，再确认放置。',view:'点选家具开始试摆。拖动空白处看房间，滚轮缩放。',scale:'开启摄像头后，双手捏合拉开或靠近；鼠标也可用滚轮缩放。'})[state.mode] : ({
    move:'右手捏住家具沿平面移动，保持当前高度；松手保留预览，右手竖拇指约 0.5 秒确认放置。',
    height:'右手捏住家具升降；松手保持悬空，切换 1 可继续平移；右手竖拇指约 0.5 秒确认后才落下。',
    scale:'左手伸出中指、无名指、小指，拇食指成圈，保持片刻选中 3；松手后，双手捏合拉开／靠近缩放。',
    rotate:'右手水平横移一画面宽度旋转 1080°；松手保留预览，右手竖拇指约 0.5 秒确认放置。',
    view:'左手捏合环绕；双手捏合后拉开／靠近调整观察距离。',
  })[state.mode];
  if (modern && !state.capabilities?.includes('thumb-confirm-v1')) $('gesture-help').textContent += ' 当前房间需刷新后支持竖拇指；也可点击放置按钮或按 Enter。';
  if (!modern) $('gesture-help').textContent = state.mode==='view' ? '旧版观察：右手两指捏合环绕、三指合拢平移。' : state.mode==='rotate' ? '旧版旋转：一画面宽度 180°；新双手方案请连接 RoomCanvas 房间。' : '旧版移动：右手捏合拖动，松开由场景校验放置。';
});
modeButtons.forEach(b => b.addEventListener('click', () => requestMode(b.dataset.mode!)));
connect.addEventListener('click',() => {if (sceneState?.previewId) {site?.notice('请先确认或取消这次试摆。');return;} loadScene();});
$('retry-scene').addEventListener('click',loadScene);
document.addEventListener('click',event => {const button=(event.target as Element).closest<HTMLButtonElement>('button[data-scene-ui]');if(button && !button.disabled) sceneAction(button.dataset.sceneUi!);});
$('confirm').addEventListener('click',() => {const target=confirmationTarget();if(target.allowed && target.previewId) {runtime.interrupt();send({type:'confirm',previewId:target.previewId,sampleTime:performance.timeOrigin+performance.now()});}});
start.addEventListener('click', () => void (async () => {
  if (!ready) { status('请先连接房间布局。'); return; }
  const generation = ++cameraGeneration; start.disabled = true; stop.disabled = false; status('正在开启摄像头…');
  if (await runtime.start()) { if (generation === cameraGeneration) {cameraVisible(true);status('摄像头已开启；先松手，再捏合抓取。');} }
  else if (generation === cameraGeneration) { start.disabled = !ready; stop.disabled = true; }
})());
stop.addEventListener('click', stopCamera);
$('cancel').addEventListener('click', () => { runtime.interrupt(true); status(stop.disabled ? '摄像头已关闭' : '已取消操作；松手后重新抓取。'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) runtime.interrupt(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') runtime.interrupt(true); });
window.addEventListener('pagehide', () => { clearInterval(timer); runtime.stop(); });
const timer = window.setInterval(() => {
  if (!ready && session) send({ type: 'hello' });
  if (loadStarted && !sceneState?.layoutReady && performance.now()-loadStarted > 20000) {sceneLoading.fail();$('retry-scene').hidden=false;const message=$('scene-loading').querySelector('p')!;message.hidden=false;message.textContent='加载超时，请检查房间服务或重试。';}
  if (ready && performance.now() - lastState > 1500) {
    stopCamera(); ready = false; start.disabled = true; modeButtons.forEach(b => { b.disabled = true; });
    $('scene-status').textContent = '场景连接已中断，正在重连…';
    renderedState = '';
    for (const button of document.querySelectorAll<HTMLButtonElement>('#confirm,#cancel,#store-selected,#fine-controls button')) button.disabled = true;
  }
}, 500);
const editorOrigin = import.meta.env.VITE_ROOMCANVAS_EDITOR_ORIGIN || 'http://127.0.0.1:7870';
const defaultRoomURL = new URL('/web/editor/?scene=../../samples/office', editorOrigin).href;
address.value = new URLSearchParams(location.search).get('layout') ?? defaultRoomURL;
site = setupSite({
  pending: () => !!sceneState?.previewId,
  leaveStudio: stopCamera,
  openRoom(room) {
    const key = `${room.id}/${room.layoutId || ''}`;
    if (loadedRoom === key && session) return;
    const legacy = new URLSearchParams(location.search).get('layout');
    const url = room.kind === 'example'
      ? new URL(!loadedRoom && legacy ? legacy : defaultRoomURL)
      : new URL(`/room/web/editor/?scene=/api/rooms/${room.id}`, location.origin);
    if (room.layoutId) url.searchParams.set('layout_key',room.layoutId);
    if (room.legacyLayout) url.searchParams.set('legacy_layout','1');
    address.value = url.href;
    loadedRoom = key; loadScene();
  },
});
