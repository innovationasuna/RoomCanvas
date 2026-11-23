// Keep source pixels in native images. Full-size canvases retain an additional
// backing store and can exhaust Safari's canvas memory on a textured room.
// Decode only two images at once, without ImageBitmap or canvas copies.

export function installMobileTextures(THREE, loader, {signal} = {}) {
  const images = new Set(), textures = new Set(), queue = [], active = new Set();
  let stopped = false, failure = null, completed = 0, pixels = 0, edge = 0;
  const aborted = () => new DOMException('已取消加载', 'AbortError');

  function pump() {
    while (!stopped && active.size < 2 && queue.length) queue.shift()();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const cancel of [...active]) cancel();
    while (queue.length) queue.shift()();
  }
  signal?.addEventListener('abort', stop, {once: true});
  if (signal?.aborted) stop();

  loader.register(parser => {
    // GLTFLoader still owns UV channels, flipY, colour spaces and sampler settings.
    parser.textureLoader = {
      load(url, onLoad, onProgress, onError) {
        const texture = new THREE.Texture(); textures.add(texture);
        const job = () => {
          if (stopped) {onError?.(aborted()); return;}
          const image = new Image();
          image.crossOrigin = parser.options.crossOrigin || 'anonymous';
          let settled = false;
          const cancel = () => finish(aborted());
          const finish = error => {
            if (settled) return;
            settled = true;
            image.onload = image.onerror = null;
            active.delete(cancel);
            if (error) {image.removeAttribute('src'); failure ||= error; onError?.(error);}
            else {completed++; onLoad(texture);}
            pump();
          };
          active.add(cancel);
          image.onload = () => {
            try {
              if (!image.naturalWidth || !image.naturalHeight) throw new Error('房间贴图解码失败，请重新加载');
              images.add(image);
              pixels += image.naturalWidth * image.naturalHeight;
              edge = Math.max(edge, image.naturalWidth, image.naturalHeight);
              texture.image = image; texture.needsUpdate = true;
              finish();
            } catch (error) {finish(error);}
          };
          image.onerror = () => finish(new Error('房间贴图加载失败，请重新加载'));
          image.src = parser.options.manager.resolveURL(url);
        };
        if (stopped) job(); else {queue.push(job); pump();}
        return texture;
      },
    };
    return {name: 'ROOMCANVAS_mobile_textures'};
  });

  return {
    check() {if (signal?.aborted || stopped) throw aborted(); if (failure) throw failure;},
    stats() {return {edge, images: completed, decodedBytes: pixels * 4};},
    dispose() {
      stop(); signal?.removeEventListener('abort', stop);
      for (const texture of textures) texture.dispose();
      for (const image of images) image.removeAttribute('src');
      textures.clear(); images.clear();
    },
  };
}
