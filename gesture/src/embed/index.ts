// Recognition only, for a page that draws its own scene (RoomCanvas's editor in web/): camera,
// MediaPipe hand tracking in a worker, pinch / number-mode / observation recognisers, and the
// protocol's frame payloads. Built with `npx vite build --config vite.embed.config.ts` into
// ../web/vendor/gesture/; nothing else in gesture/ changes for it.
export { GestureRuntime } from '../integration/runtime';
export type { IntegrationFrame } from '../integration/runtime';
export { gesturePayload, observationPayload } from '../integration/protocol';
export { setVisionBase } from './tracker';
