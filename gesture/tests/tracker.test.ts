import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tracker } from '../src/tracking/tracker-core';

class FakeWorker {
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  onerror?: (event: { message: string }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  ready() { this.onmessage?.({ data: { type: 'ready' } }); }
}
const video = { readyState: 2 } as HTMLVideoElement;
function setup() {
  const workers: FakeWorker[] = [];
  const tracker = new Tracker({
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
    resources: () => ({ wasm: '/custom/wasm', model: '/custom/model' }),
  });
  return { tracker, workers };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('shared tracker lifecycle', () => {
  it('injects resources, terminates timed-out initialization and can restart', async () => {
    vi.useFakeTimers();
    const { tracker, workers } = setup();
    const first = tracker.start();
    const failed = expect(first).rejects.toThrow('超时');
    expect(workers[0].postMessage).toHaveBeenCalledWith({ type: 'init', wasm: '/custom/wasm', model: '/custom/model' });
    await vi.advanceTimersByTimeAsync(30000);
    await failed;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const again = tracker.start(); workers[1].ready(); await again;
    tracker.stop();
  });

  it('closes a late bitmap without posting it into a restarted worker', async () => {
    const { tracker, workers } = setup();
    const first = tracker.start(); workers[0].ready(); await first;
    let finish!: (bitmap: ImageBitmap) => void;
    vi.stubGlobal('createImageBitmap', () => new Promise(resolve => { finish = resolve; }));
    const pending = tracker.detect(video, 1);
    const again = tracker.start(); workers[1].ready(); await again;
    const bitmap = { close: vi.fn() };
    finish(bitmap as unknown as ImageBitmap); await pending;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(workers[1].postMessage).toHaveBeenCalledTimes(1);
    tracker.stop();
  });

  it('closes an untransferred bitmap when a worker rejects a frame', async () => {
    const { tracker, workers } = setup();
    const first = tracker.start(); workers[0].ready(); await first;
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', async () => bitmap);
    workers[0].postMessage.mockImplementation(() => { throw new Error('closed'); });
    tracker.onError = vi.fn();
    await tracker.detect(video, 2);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(tracker.onError).toHaveBeenCalledWith('Error: closed');
    tracker.stop();
  });
});
