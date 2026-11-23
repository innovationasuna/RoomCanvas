import {encodeRoom} from './mobile-snapshot.mjs';

export function mountMobileShare({button, capture}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'rc-mobile-share';
  dialog.setAttribute('aria-labelledby', 'mobile-share-title');
  dialog.innerHTML = `<form method="dialog" class="mobile-share-heading"><h2 id="mobile-share-title">在手机中打开</h2><button aria-label="关闭手机分享">×</button></form>
    <p>把这次布置带到手机，选择浏览器体验或 Android App。</p>
    <p class="mobile-share-note">手机与电脑连接同一 Wi-Fi，保持电脑服务运行。分享后继续编辑，不会改变这份布局。</p>
    <p id="mobile-share-status" role="status" aria-live="polite">准备生成当前布局</p>
    <div class="mobile-share-result" hidden>
      <div id="mobile-share-qr" role="img" aria-label="手机打开房间的二维码"></div>
      <div class="mobile-share-fields"><p id="mobile-share-version"></p>
        <label for="mobile-share-host">电脑的 Wi-Fi 地址</label>
        <input id="mobile-share-host" list="mobile-share-addresses" inputmode="decimal" autocomplete="off" placeholder="例如 192.168.1.8">
        <datalist id="mobile-share-addresses"></datalist>
        <label for="mobile-share-link">手机链接</label><input id="mobile-share-link" readonly>
        <button type="button" id="mobile-share-copy">复制链接</button>
      </div>
    </div>
    <div class="mobile-share-actions"><button type="button" id="mobile-share-generate" class="primary">生成二维码</button><button type="button" id="mobile-share-download">下载房间 GLB</button></div>`;
  document.body.append(dialog);
  const $ = s => dialog.querySelector(s), status = $('#mobile-share-status');
  let busy = false, file = null, published = null, fileURL = null;
  const buttons = [$('#mobile-share-generate'), $('#mobile-share-download')];
  function setBusy(value) {busy = value; buttons.forEach(b => b.disabled = value); dialog.setAttribute('aria-busy', String(value));}
  async function prepare() {
    if (!file) {
      status.textContent = '正在打包模型与贴图…';
      // capture() is synchronous, so subsequent edits cannot change this version.
      file = await encodeRoom(capture());
    }
    return file;
  }
  function updateURL() {
    const host = $('#mobile-share-host').value.trim();
    const pieces = host.split('.');
    if (pieces.length !== 4 || pieces.some(p => !/^\d{1,3}$/.test(p) || +p > 255) || ['0', '127'].includes(pieces[0])) {
      $('#mobile-share-link').value = ''; $('#mobile-share-qr').replaceChildren();
      $('#mobile-share-copy').disabled = true;
      status.textContent = '填写手机可访问的电脑 Wi-Fi IPv4 地址后生成二维码。'; return;
    }
    const url = `http://${host}:${published.port}${published.path}`;
    $('#mobile-share-link').value = url;
    $('#mobile-share-copy').disabled = false;
    const code = window.qrcode(0, 'M'); code.addData(url); code.make();
    $('#mobile-share-qr').innerHTML = code.createSvgTag({cellSize: 5, margin: 20, scalable: true});
    status.textContent = '已准备好。用手机相机扫码打开。';
  }
  $('#mobile-share-host').addEventListener('input', () => {if (published) updateURL();});
  $('#mobile-share-copy').onclick = async () => {
    try {await navigator.clipboard.writeText($('#mobile-share-link').value); status.textContent = '链接已复制';}
    catch {$('#mobile-share-link').select(); status.textContent = '请复制已选中的链接';}
  };
  $('#mobile-share-generate').onclick = async () => {
    if (busy) return; setBusy(true);
    try {
      const configResponse = await fetch('/web/mobile-shares/config');
      if (!configResponse.ok) throw new Error('请更新并重启 RoomCanvas 网页服务，再生成手机分享');
      const config = await configResponse.json();
      if (!config.enabled) throw new Error('手机分享服务未启动，请重启网页服务或更换分享端口');
      const {blob, metadata} = await prepare();
      status.textContent = '正在保存分享版本…';
      const response = await fetch('/web/mobile-shares', {method: 'POST', headers: {'Content-Type': 'model/gltf-binary'}, body: blob});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存失败，请重试');
      published = result;
      $('#mobile-share-version').textContent = `${metadata.name} · ${metadata.version.slice(0, 8)} · ${(blob.size / 1048576).toFixed(1)} MB`;
      $('#mobile-share-addresses').replaceChildren(...result.addresses.map(address => {const option = document.createElement('option'); option.value = address; return option;}));
      $('#mobile-share-host').value = result.addresses[0] || '';
      $('.mobile-share-result').hidden = false;
      updateURL();
      $('#mobile-share-generate').textContent = '重新生成二维码';
    } catch (error) {status.textContent = error.message || '生成失败，请重试';}
    finally {setBusy(false);}
  };
  $('#mobile-share-download').onclick = async () => {
    if (busy) return; setBusy(true);
    try {
      const {blob, metadata} = await prepare();
      if (fileURL) URL.revokeObjectURL(fileURL);
      fileURL = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = fileURL;
      link.download = `${metadata.name.replace(/[\\/:*?"<>|]/g, '_')}-${metadata.version.slice(0, 8)}.glb`;
      link.click(); status.textContent = '已开始下载完整房间，可通过手机文件选择器导入 App。';
    } catch (error) {status.textContent = error.message || '导出失败，请重试';}
    finally {setBusy(false);}
  };
  button.onclick = () => {
    if (!busy) {
      file = null; published = null;
      $('.mobile-share-result').hidden = true;
      status.textContent = '将导出当前已确认的布局';
      $('#mobile-share-generate').textContent = '生成二维码';
    }
    dialog.showModal();
  };
  dialog.addEventListener('click', event => {if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  }});
}
