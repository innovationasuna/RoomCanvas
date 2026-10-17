() => {
    if (window.__viewforgeGalleryRetry) return;
    window.__viewforgeGalleryRetry = true;
    // Called by the upload event only after the files reach Gradio's temp storage.
    window.__viewforgeNameUploadedObject = () => {
        let name;
        while (true) {
            name = window.prompt('请为新物体命名（同名素材目录将使用此名称）', '');
            if (name === null) {
                return null;
            }
            name = name.trim();
            if (/^[\p{L}\p{N}_.-]{1,80}$/u.test(name) && name !== '.' && name !== '..') break;
            window.alert('请输入 1–80 个中文、字母、数字、下划线或连字符，不能包含路径。');
        }
        return name;
    };
    const pending = new WeakMap();
    const inGallery = (img) => img instanceof HTMLImageElement && img.closest('#photo-gallery');
    const sourceKey = (img) => {
        const url = new URL(img.currentSrc || img.src, location.href);
        url.searchParams.delete('_vf_retry');
        return url.href;
    };
    function retry(img) {
        if (!inGallery(img) || !img.isConnected || !img.getAttribute('src')) return;
        const key = sourceKey(img);
        if (!/^https?:/.test(key)) return;
        let state = pending.get(img);
        if (state && state.key !== key) {
            clearTimeout(state.timer);
            state = null;
        }
        if (!state) {
            state = { key, attempts: 0, timer: null };
            pending.set(img, state);
        }
        if (state.timer !== null) return;
        const delay = Math.min(2000 * 2 ** Math.min(state.attempts, 4), 30000);
        state.timer = setTimeout(() => {
            state.timer = null;
            if (!img.isConnected || !inGallery(img) || sourceKey(img) !== key) return;
            if (img.complete && img.naturalWidth > 0) {
                pending.delete(img);
                return;
            }
            if (!img.complete) return;
            const url = new URL(key);
            url.searchParams.set('_vf_retry', String(Date.now()));
            state.attempts += 1;
            img.src = url.href;
        }, delay);
    }
    document.addEventListener('error', event => retry(event.target), true);
    document.addEventListener('load', event => {
        const img = event.target;
        if (!inGallery(img)) return;
        const state = pending.get(img);
        if (state) clearTimeout(state.timer);
        pending.delete(img);
    }, true);
    // Covers errors that happened before this callback was installed and new galleries.
    const scan = () => document.querySelectorAll('#photo-gallery img').forEach(img => {
        if (img.complete && img.naturalWidth === 0) retry(img);
    });
    scan();
    const interval = setInterval(scan, 5000);
    window.addEventListener('pagehide', () => clearInterval(interval), { once: true });
}
