import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { TrackingFrame, Side } from '../shared/types';
let tracker: HandLandmarker | undefined;
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      // ES module workers need the module WASM loader; the classic UMD loader
      // imported as an ES module does not expose ModuleFactory globally.
      const files = await FilesetResolver.forVisionTasks(message.wasm, true);
      tracker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: message.model, delegate: 'CPU' }, runningMode: 'VIDEO',
        numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      });
      self.postMessage({ type: 'ready' });
    } else if (message.type === 'frame') {
      const start = performance.now();
      try {
        const result = tracker!.detectForVideo(message.bitmap, message.timestamp);
        const frame: TrackingFrame = { timestamp: message.timestamp, inferenceMs: performance.now() - start,
          hands: result.landmarks.map((landmarks, i) => ({ landmarks, world: result.worldLandmarks[i],
            side: result.handedness[i][0].categoryName as Side, score: result.handedness[i][0].score })) };
        self.postMessage({ type: 'result', frame });
      } finally { message.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
};
