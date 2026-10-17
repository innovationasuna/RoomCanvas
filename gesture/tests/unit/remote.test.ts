import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteTracker } from '../../src/tracking/remote';

function setup() {
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })) };
  vi.stubGlobal('document', { createElement: () => canvas });
  vi.stubGlobal('window', globalThis);
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ engine: 'mediapipe-python' }) });
  vi.stubGlobal('fetch', fetch);
  const tracker = new RemoteTracker('secret');
  const video = { readyState: 2, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  return { tracker, fetch, video, canvas };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('远程识别生命周期', () => {
  it('没有令牌不能连接或上传', async () => {
    const { fetch } = setup();
    await expect(new RemoteTracker('').start()).rejects.toThrow('令牌');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('未启动不上传，启动后携带令牌并保留客户端时间戳', async () => {
    const { tracker, fetch, video, canvas } = setup();
    const frame = vi.fn(); tracker.onFrame = frame;
    await tracker.detect(video, 1); expect(fetch).not.toHaveBeenCalled();
    await tracker.start();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ hands: [], inferenceMs: 12 }) });
    await tracker.detect(video, 42);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer secret');
    expect(frame.mock.calls[0][0]).toMatchObject({ timestamp: 42, hands: [], inferenceMs: 12 });
    expect(canvas.width).toBe(0);
    tracker.stop();
  });
  it('只有一个在途请求，停止后忽略旧响应，新会话可继续', async () => {
    const { tracker, fetch, video } = setup();
    const frame = vi.fn(); tracker.onFrame = frame;
    await tracker.start();
    let resolve!: (result: unknown) => void;
    fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = tracker.detect(video, 10);
    await Promise.resolve();
    await tracker.detect(video, 11);
    expect(fetch).toHaveBeenCalledTimes(2);
    tracker.stop();
    resolve({ ok: true, json: async () => ({ hands: [], inferenceMs: 1 }) });
    await pending;
    expect(frame).not.toHaveBeenCalled();
    await tracker.start();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ hands: [], inferenceMs: 2 }) });
    await tracker.detect(video, 12);
    expect(frame).toHaveBeenCalledTimes(1);
    tracker.stop();
  });
  it('忙时丢帧，恢复后继续；网络故障报告停止', async () => {
    const { tracker, fetch, video } = setup();
    tracker.onError = vi.fn(); tracker.onFrame = vi.fn();
    await tracker.start();
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await tracker.detect(video, 1);
    expect(tracker.onFrame).not.toHaveBeenCalled(); expect(tracker.onError).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ hands: [], inferenceMs: 2 }) });
    await tracker.detect(video, 2); expect(tracker.onFrame).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValueOnce(new Error('连接断开'));
    await tracker.detect(video, 3); expect(tracker.onError).toHaveBeenCalledWith('连接断开');
    tracker.stop();
  });
});
