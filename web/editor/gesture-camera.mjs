// Built-in gestures: the editor's own camera card, driven by gesture/'s recognition runtime
// (bundled into web/vendor/gesture/ from gesture/src/embed/). Frames go straight to the editor's
// GestureInput in the form the gesture page posts them (gesture-bridge.mjs), so the camera
// card and the gesture page drive the room the same way.
export const DIGIT_MODES = {1: 'move', 2: 'rotate', 3: 'view'};
export const MODE_NAMES = {move: '移动', rotate: '旋转', view: '观察'};

// The left hand's state, worded as on the gesture page (gesture/src/integration/main.ts).
export function leftHandText(left, {busy = false, rightHeld = false} = {}) {
  const target = left.digit ? MODE_NAMES[DIGIT_MODES[left.digit]] : '';
  switch (left.phase) {
    case 'uncertain': return '左手不稳，让手掌朝向摄像头';
    case 'ambiguous': return '分不清左右手，请分开双手';
    case 'blocked': return busy ? '操作结束后张掌再选模式' : rightHeld ? '先松开右手再选模式' : '左手已识别';
    case 'neutral': return '先张开左手，再比 1 / 2 / 3';
    case 'pose': return '比 1 / 2 / 3，其余手指收拢';
    case 'confirming': return `左手 ${left.digit} → ${target} ${Math.round(left.progress * 100)}%`;
    case 'selected': return `左手 ${left.digit} → ${target}`;
    default: return '左手比 1 / 2 / 3 切换模式';
  }
}

// In observation mode the observation recogniser's pinch (two fingers orbit, three pan) drives
// the camera; otherwise the pointer pinch.
export function inputFrame(lib, frame, mode) {
  return mode === 'view' ? lib.observationPayload({...frame.observation, helper: frame.helper}) : lib.gesturePayload(frame);
}

// lib: the bundled runtime module. port: mode(), setMode(mode), canSwitch(), busy().
// ui: right(text, seen), left(text, progress, seen), status(text).
export function createGestureCamera({lib, video, input, port, ui, clock = performance}) {
  let runtime = null, on = false;
  // A mode switch starts from an open hand, as after the gesture page's mode message.
  function requestMode(next, fromHand = false) {
    if (next === port.mode() || !port.canSwitch()) return false;
    runtime?.interrupt(false, fromHand);
    input.reset();
    port.setMode(next);
    return true;
  }
  const callbacks = {
    canSwitch: () => port.canSwitch(),
    frame(frame) {
      if (frame.modeSelection) requestMode(DIGIT_MODES[frame.modeSelection], true);
      input.input(inputFrame(lib, frame, port.mode()), clock.now());
      const right = frame.operator;
      ui.right(!right ? '右手未识别' : right.pinching ? '右手捏合' : '右手已识别', !!right);
      const left = frame.leftDetection;
      ui.left(leftHandText(left, {busy: port.busy(), rightHeld: frame.rightHeld}), left.progress, left.detected);
    },
    // A lost hand ends the hand's operation; a preview it leaves stays for the mouse or the next pinch.
    interrupted(cancel) {if (cancel) input.reset(); else input.interrupt();},
    error(message) {on = false; ui.status(message);},
  };
  return {
    get on() {return on;},
    requestMode,
    async start() {
      runtime ??= new lib.GestureRuntime(video, callbacks);
      on = true;
      ui.status('正在开启摄像头…');
      const started = await runtime.start();
      if (!started) {on = false; return false;}
      ui.status('');
      return true;
    },
    stop() {on = false; runtime?.stop();},
  };
}
