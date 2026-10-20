/** 房间先准备好，等待当前描线循环收尾后再淡出；新加载可取消旧收尾。 */
export function setupSceneLoading(element: HTMLElement, reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')) {
  const outline = element.querySelector<SVGPathElement>('.house-outline')!;
  let generation = 0, awaitingCycle = false, fade: Animation | undefined;
  let frame = 0, elapsed = 0, lastFrame = 0, duration = 2800, motion: Animation[] = [];

  function stopMotion() {
    cancelAnimationFrame(frame);
    motion.forEach(animation => animation.cancel()); motion = [];
  }

  function cancelFinish() {
    generation++; awaitingCycle = false;
    stopMotion(); fade?.cancel(); fade = undefined;
  }
  function finish() {
    if (!awaitingCycle) return;
    awaitingCycle = false; stopMotion();
    // 所有描线循环的末帧都是完整房子，停住后再露出已准备好的场景。
    element.dataset.state = 'ready';
    if (reducedMotion.matches) {element.hidden = true; return;}
    const ticket = generation;
    const animation = element.animate([{opacity: 1}, {opacity: 0}], {duration: 360, easing: 'ease-out', fill: 'forwards'});
    fade = animation;
    void animation.finished.then(() => {
      if (ticket !== generation) return;
      element.hidden = true; animation.cancel(); fade = undefined;
    }).catch(() => {});
  }
  function advance(now: number) {
    if (!motion.length) return;
    if (elapsed >= duration) elapsed = 0;
    // 模型解析会阻塞主线程；只推进实际可见的帧，不跳到后台时钟的新一轮。
    elapsed = Math.min(duration, elapsed + Math.min(50, Math.max(0, now - lastFrame)));
    lastFrame = now;
    motion.forEach(animation => {animation.currentTime = elapsed;});
    if (awaitingCycle && elapsed >= duration) {finish(); return;}
    frame = requestAnimationFrame(advance);
  }
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    if (awaitingCycle) finish(); else stopMotion();
  });

  return {
    start() {
      cancelFinish(); element.hidden = false; element.dataset.state = 'idle';
      // 刷新样式，让重试或切换房间也从完整的新循环开始。
      void element.offsetWidth;
      element.dataset.state = 'loading';
      if (reducedMotion.matches) return;
      duration = Number(outline.getAnimations()[0]?.effect?.getTiming().duration) || 2800;
      motion = element.getAnimations({subtree: true});
      motion.forEach(animation => {
        const length = Number(animation.effect?.getTiming().duration) || duration;
        animation.effect?.updateTiming({iterations: Math.max(1, Math.round(duration / length)), fill: 'both'});
        animation.pause(); animation.currentTime = 0;
      });
      elapsed = 0; lastFrame = performance.now(); frame = requestAnimationFrame(advance);
    },
    ready() {
      if (element.hidden || awaitingCycle || fade) return;
      awaitingCycle = true;
      if (reducedMotion.matches || !motion.length || !element.getClientRects().length || elapsed >= duration) finish();
    },
    fail() {
      cancelFinish(); element.hidden = false; element.dataset.state = 'error';
    },
  };
}
