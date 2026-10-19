const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};

export function summarizeFrames(frames) {
  const summary = {};
  for (const label of new Set(frames.map(frame => frame.label))) {
    const group = frames.filter(frame => frame.label === label);
    const cpu = group.map(frame => frame.cpuSubmitMs), gpu = group.map(frame => frame.gpuMs).filter(Number.isFinite);
    summary[label] = {frames: group.length, gpuSamples: gpu.length,
      cpuSubmitMs: {p50: percentile(cpu, .5), p95: percentile(cpu, .95)},
      gpuMs: {p50: percentile(gpu, .5), p95: percentile(gpu, .95)},
      calls: Math.max(...group.map(frame => frame.calls)), triangles: Math.max(...group.map(frame => frame.triangles))};
  }
  return summary;
}

// One measurement encloses ALL render passes in a submitted frame. GPU queries are
// opt-in for the lighting lab, polled asynchronously and never force a WebGL finish.
export function createRenderMetrics(renderer, {gpu = false, limit = 600, clock = performance} = {}) {
  const gl = renderer.getContext(), extension = gpu ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const previousAutoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;
  const frames = [], pending = [];
  let timer = null, disposed = false;
  function poll() {
    timer = null;
    const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const item = pending[i];
      const available = gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE);
      if (available || disjoint || ++item.polls > 120) {
        if (available && !disjoint) {item.frame.gpuMs = gl.getQueryParameter(item.query, gl.QUERY_RESULT) / 1e6; item.frame.gpuStatus = 'valid';}
        else item.frame.gpuStatus = disjoint ? 'disjoint' : 'timeout';
        gl.deleteQuery(item.query); pending.splice(i, 1);
      }
    }
    if (pending.length && !disposed) timer = setTimeout(poll, 16);
  }
  return {
    measure(label, draw) {
      if (disposed) return draw();
      renderer.info.reset();
      const frame = {label, cpuSubmitMs: 0, gpuMs: null, gpuStatus: extension ? 'pending' : 'unavailable'};
      let query = null;
      if (extension && pending.length < 12 && !gl.getQuery(extension.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) {
        query = gl.createQuery(); gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      } else if (extension) frame.gpuStatus = 'busy';
      const start = clock.now();
      try {return draw();}
      finally {
        frame.cpuSubmitMs = clock.now() - start;
        Object.assign(frame, {calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
          textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries});
        if (query) {
          gl.endQuery(extension.TIME_ELAPSED_EXT); pending.push({query, frame, polls: 0});
          if (timer === null) timer = setTimeout(poll, 16);
        }
        frames.push(frame); if (frames.length > limit) frames.shift();
      }
    },
    reset() {frames.length = 0;},
    get last() {return frames.at(-1) ? {...frames.at(-1)} : null;},
    snapshot() {return {gpuTimerSupported: !!extension, pendingQueries: pending.length,
      last: frames.at(-1) ? {...frames.at(-1)} : null, summary: summarizeFrames(frames), frames: frames.map(frame => ({...frame}))};},
    dispose() {
      disposed = true; clearTimeout(timer);
      for (const item of pending) gl.deleteQuery(item.query);
      pending.length = 0; renderer.info.autoReset = previousAutoReset;
    },
  };
}
