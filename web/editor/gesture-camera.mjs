// Built-in gestures: the editor's own camera card, driven by gesture/'s recognition runtime
// (bundled into web/vendor/gesture/ from gesture/src/embed/). Frames go straight to the editor's
// GestureInput in the form the gesture page posts them (gesture-bridge.mjs), so the camera
// card and the gesture page drive the room the same way.
export const DIGIT_MODES = {1: 'move', 2: 'height', 3: 'scale', 4: 'rotate'};
export const MODE_NAMES = {move: '移动', height: '抬高', scale: '缩放', rotate: '转向', view: '选择'};

// The left hand's state, worded as on the gesture page (gesture/src/integration/main.ts).
export function leftHandText(left, {busy = false, rightHeld = false} = {}) {
  const target = left.digit ? MODE_NAMES[DIGIT_MODES[left.digit]] : '';
  switch (left.phase) {
    case 'uncertain': return '左手不稳，让手掌朝向摄像头';
    case 'ambiguous': return '分不清左右手，请分开双手';
    case 'blocked': return busy ? '操作结束后张掌再选模式' : rightHeld ? '先松开右手再选模式' : '左手已识别';
    case 'neutral': return '先张开左手，再比 1 / 2 / 3 / 4';
    case 'pose': return '比 1 / 2 / 3 / 4；3 为拇食指成圈，其余三指伸出';
    case 'confirming': return `左手 ${left.digit} → ${target} ${Math.round(left.progress * 100)}%`;
    case 'selected': return `左手 ${left.digit} → ${target}`;
    default: return '左手比 1 / 2 / 3 / 4 切换模式';
  }
}

// 两种入口共用双手信号，保留左手环绕与双手缩放。
export function inputFrame(lib, frame) {
  return lib.gesturePayload(frame);
}

// 骨架只在本页绘制；跨窗口协议只发送必要的控制信号。
export function createGestureCamera({lib, video, canvas, input, port, ui, clock = performance}) {
  let runtime = null, on = false;
  function clearFeedback() {
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    ui.confirm?.('右手确认检测未开启', 0);
  }
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
    confirmationTarget: () => port.confirmationTarget(),
    frame(frame, sampleTime, tracking) {
      if (frame.modeSelection) requestMode(DIGIT_MODES[frame.modeSelection], true);
      input.input(inputFrame(lib, frame), clock.now());
      const target = port.confirmationTarget();
      if (frame.placementConfirmation && target.allowed && frame.placementConfirmation === target.previewId && !input.active && !input.dual) port.confirm();
      const right = frame.operator;
      ui.right(!right ? '右手未识别' : right.pinching ? '右手捏合' : '右手已识别', !!right);
      const left = frame.leftDetection;
      ui.left(leftHandText(left, {busy: port.busy(), rightHeld: frame.rightHeld}), left.progress, left.detected);
      if (canvas && tracking) lib.drawHandFeedback(canvas, tracking, frame, video);
      if (frame.rightConfirmation) ui.confirm?.(lib.thumbFeedback(frame.rightConfirmation), frame.rightConfirmation.progress);
    },
    // A lost hand ends the hand's operation; a preview it leaves stays for the mouse or the next pinch.
    interrupted(cancel) {clearFeedback(); if (cancel) input.reset(); else input.interrupt();},
    error(message) {on = false; clearFeedback(); ui.status(message);},
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
