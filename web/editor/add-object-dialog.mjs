// The "添加物体" dialog: name + photos → mask previews (drop bad ones) → reconstruction progress →
// the result with one measured edge → into the room. The reconstruction runs on the server and
// survives closing the dialog or reloading the page (its job id is kept in localStorage).
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MIN_PHOTOS, MAX_PHOTOS, STAGES, objectName, stageLabel, duration, readable, createObject,
  startMasks, startReconstruction, follow, previewURL, saveMeasurement} from './add-object.mjs?v=app-36';
import {readAsset, modelURL, metricScale, placementMatrix, sizeInMeters, savedMeasurement} from './object-import.mjs?v=app-36';

const $ = (selector) => document.querySelector(selector);
const KEY = 'roomcanvas:add-object';
const remember = (value) => {try {value ? localStorage.setItem(KEY, JSON.stringify(value)) : localStorage.removeItem(KEY);} catch {}};
const recall = () => {try {return JSON.parse(localStorage.getItem(KEY) || 'null');} catch {return null;}};
const sizeText = (size) => `宽 ${size[0].toFixed(2)} × 深 ${size[2].toFixed(2)} × 高 ${size[1].toFixed(2)} 米`;

// HEIC and other formats the server does not take: redraw as JPEG if this browser can decode them.
async function asJPEG(file) {
  if (readable(file)) return file;
  const bitmap = await createImageBitmap(file);
  const canvas = Object.assign(document.createElement('canvas'), {width: bitmap.width, height: bitmap.height});
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .92));
  if (!blob) throw new Error('decode');
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {type: 'image/jpeg'});
}

export function mountAddObject({onReady, toast}) {
  const dialog = $('#add-object-dialog'), card = $('#add-object');
  // step: photos → masks → build → size. files: [{file, url}] before upload.
  let state = {step: 'photos', files: []}, viewer = null;

  function show(step) {
    state.step = step;
    for (const panel of dialog.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== step;
    const order = ['photos', 'masks', 'build', 'size'];
    for (const item of dialog.querySelectorAll('[data-step]')) {
      const at = order.indexOf(item.dataset.step), now = order.indexOf(step);
      item.dataset.state = at < now ? 'done' : at === now ? 'current' : '';
    }
    if (step !== 'size') closeViewer();
  }
  function cardState(text) {$('#add-object-state').textContent = text;}

  // 1. Name and photos.
  function renderPhotos() {
    const grid = $('#add-photos');
    grid.replaceChildren(...state.files.map((entry, index) => {
      const cell = document.createElement('figure');
      cell.innerHTML = `<img alt=""><button type="button" class="rc-photo-remove" aria-label="去掉这张">×</button>`;
      cell.querySelector('img').src = entry.url;
      cell.querySelector('button').onclick = () => {URL.revokeObjectURL(entry.url); state.files.splice(index, 1); renderPhotos();};
      return cell;
    }));
    const count = state.files.length, name = objectName($('#add-name').value);
    $('#add-photos-note').textContent = count ? `${count} 张${count < MIN_PHOTOS ? `，至少 ${MIN_PHOTOS} 张` : ''}` : '';
    $('#add-upload').disabled = !name || count < MIN_PHOTOS || count > MAX_PHOTOS;
  }
  async function addFiles(list) {
    let refused = 0;
    for (const file of list) {
      if (!file.type.startsWith('image/') && !/\.hei[cf]$/i.test(file.name)) continue;
      try {
        const photo = await asJPEG(file);
        state.files.push({file: photo, url: URL.createObjectURL(photo)});
      } catch {refused++;}
    }
    renderPhotos();
    if (refused) $('#add-photos-note').textContent = `${refused} 张读不了，请换成 JPEG 或 PNG`;
  }
  $('#add-files').onchange = () => {void addFiles([...$('#add-files').files]); $('#add-files').value = '';};
  const drop = $('#add-drop');
  drop.ondragover = (event) => {event.preventDefault(); drop.dataset.over = 'true';};
  drop.ondragleave = () => {drop.dataset.over = 'false';};
  drop.ondrop = (event) => {event.preventDefault(); drop.dataset.over = 'false'; void addFiles([...event.dataTransfer.files]);};
  $('#add-name').oninput = renderPhotos;
  $('#add-upload').onclick = async () => {
    const name = objectName($('#add-name').value);
    $('#add-upload').disabled = true;
    try {
      const created = await createObject(name, state.files.map((entry) => entry.file), (part) => {
        $('#add-photos-note').textContent = part < 1 ? `正在上传 ${Math.round(part * 100)}%` : '正在保存照片…';
      });
      state.files.forEach((entry) => URL.revokeObjectURL(entry.url));
      state = {step: 'masks', files: [], object: created.object, images: created.images, excluded: new Set()};
      await runMasks();
    } catch (error) {
      $('#add-photos-note').textContent = error.message;
      $('#add-upload').disabled = false;
    }
  };

  // 2. Mask previews: the object is tinted green; click a photo to leave it out.
  async function runMasks() {
    show('masks');
    $('#add-masks').replaceChildren();
    $('#add-build').disabled = true; $('#add-retry-masks').hidden = true;
    $('#add-masks-note').textContent = '正在抠图…';
    cardState('正在抠图');
    try {
      const job = await follow((await startMasks(state.object, state.images)).id, (update) => {
        $('#add-masks-note').textContent = `${stageLabel(update)} · ${duration(update.elapsed_seconds)}`;
      });
      state.masks = job.id;
      renderMasks(job.previews);
      cardState('抠图好了，待确认');
    } catch (error) {
      $('#add-masks-note').textContent = `抠图失败：${error.message}`;
      $('#add-retry-masks').hidden = false;
      cardState('抠图失败');
    }
  }
  function renderMasks(previews) {
    $('#add-masks').replaceChildren(...previews.map(({name, url}) => {
      const cell = document.createElement('button');
      cell.type = 'button'; cell.className = 'rc-mask'; cell.setAttribute('aria-pressed', 'true');
      cell.innerHTML = `<img alt=""><span>不用</span>`;
      cell.querySelector('img').src = previewURL(url);
      cell.onclick = () => {
        state.excluded.has(name) ? state.excluded.delete(name) : state.excluded.add(name);
        cell.setAttribute('aria-pressed', String(!state.excluded.has(name)));
        describeMasks();
      };
      return cell;
    }));
    describeMasks();
  }
  function describeMasks() {
    const kept = state.images.filter((name) => !state.excluded.has(name)).length;
    $('#add-masks-note').textContent = `绿色是识别出的物体。点一张可以不用它 · 用 ${kept} 张${kept < MIN_PHOTOS ? `，至少 ${MIN_PHOTOS} 张` : ''}`;
    $('#add-build').disabled = kept < MIN_PHOTOS;
    $('#add-build').textContent = `开始重建（${kept} 张）`;
  }
  $('#add-retry-masks').onclick = () => void runMasks();
  $('#add-build').onclick = async () => {
    $('#add-build').disabled = true;
    const images = state.images.filter((name) => !state.excluded.has(name));
    try {
      const job = await startReconstruction(state.object, images, state.masks);
      state.build = job.id;
      remember({object: state.object, build: job.id});
      void runBuild();
    } catch (error) {
      $('#add-masks-note').textContent = `没能开始重建：${error.message}`;
      $('#add-build').disabled = false;
    }
  };

  // 3. Reconstruction, followed on the server (a few minutes).
  async function runBuild() {
    show('build');
    $('#add-build-error').hidden = $('#add-build-again').hidden = true;
    const list = $('#add-stages');
    list.replaceChildren(...STAGES.map(([id, label]) => Object.assign(document.createElement('li'), {textContent: label, id: `add-stage-${id}`})));
    try {
      const job = await follow(state.build, (update) => {
        const at = update.status === 'queued' ? 0 : Math.max(1, STAGES.findIndex(([id]) => id === update.stage));
        STAGES.forEach(([id], index) => {$(`#add-stage-${id}`).dataset.state = index < at ? 'done' : index === at ? 'current' : '';});
        $('#add-build-note').textContent = `${stageLabel(update)} · 已用时 ${duration(update.elapsed_seconds)}`;
        cardState(`${stageLabel(update)} · ${duration(update.elapsed_seconds)}`);
      });
      state.run = job.run;
      remember({object: state.object, build: state.build, run: job.run});
      cardState('重建好了，填尺寸');
      if (!dialog.open) toast(`${state.object} 重建好了：点仓库里的“添加物体”填尺寸`);
      await openSize();
    } catch (error) {
      $('#add-build-error').hidden = $('#add-build-again').hidden = false;
      $('#add-build-error').textContent = `重建没完成：${error.message}`;
      cardState('重建失败');
      remember(null);
    }
  }

  // 4. The result and one measured edge.
  async function openSize() {
    show('size');
    $('#add-place').disabled = true;
    $('#add-size-note').textContent = '正在读取模型…';
    state.asset = await readAsset(state.run);
    const saved = savedMeasurement(state.asset);
    if (saved) {$('#add-axis').value = saved.axis; $('#add-meters').value = String(+saved.meters.toFixed(3));}
    describeSize();
    await openViewer(state.run, state.asset.base);
  }
  function measured() {
    return metricScale(state.asset.base, $('#add-axis').value, Number($('#add-meters').value));
  }
  function describeSize() {
    if (!state.asset) return;
    try {
      $('#add-size-note').textContent = sizeText(sizeInMeters(state.asset.base, measured()));
      $('#add-place').disabled = false;
    } catch {
      $('#add-size-note').textContent = '量一条边（米），按它换算真实大小';
      $('#add-place').disabled = true;
    }
  }
  $('#add-axis').onchange = $('#add-meters').oninput = describeSize;
  $('#add-place').onclick = async () => {
    $('#add-place').disabled = true;
    try {
      const asset = await saveMeasurement(state.run, $('#add-axis').value, Number($('#add-meters').value));
      dialog.close();
      remember(null);
      const run = state.run;
      reset();
      await onReady(run, asset);
    } catch (error) {
      $('#add-size-note').textContent = `没放进去：${error.message}`;
      $('#add-place').disabled = false;
    }
  };

  async function openViewer(run, base) {
    closeViewer();
    const host = $('#add-view'), width = host.clientWidth || 480, height = host.clientHeight || 260;
    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, width / height, .01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    const draw = () => renderer.render(scene, camera);
    controls.addEventListener('change', draw);
    viewer = {renderer, controls};
    let gltf;
    try {gltf = await new GLTFLoader().loadAsync(modelURL(run, 'preview.glb'));}
    catch {gltf = await new GLTFLoader().loadAsync(modelURL(run, 'result.glb'));}
    if (viewer?.renderer !== renderer) return;
    // Unit-sized, standing on y = 0, as the editor places it; the box shows the measured extent.
    const shape = new THREE.Group();
    shape.applyMatrix4(new THREE.Matrix4().fromArray(placementMatrix(base, 1 / Math.max(...Object.values(base.lengths)))));
    gltf.scene.traverse((mesh) => {
      if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({vertexColors: !!mesh.geometry.attributes.color, side: THREE.DoubleSide});
    });
    shape.add(gltf.scene);
    scene.add(shape);
    const box = new THREE.Box3().setFromObject(shape);
    scene.add(new THREE.Box3Helper(box, 0x30664f));
    const middle = box.getCenter(new THREE.Vector3());
    camera.position.set(middle.x + 1.2, middle.y + .8, middle.z + 1.6);
    controls.target.copy(middle);
    controls.update();
    draw();
  }
  function closeViewer() {
    if (!viewer) return;
    viewer.controls.dispose(); viewer.renderer.dispose(); viewer.renderer.domElement.remove();
    viewer = null;
  }

  function reset() {
    state.files?.forEach((entry) => URL.revokeObjectURL(entry.url));
    state = {step: 'photos', files: []};
    $('#add-name').value = '';
    $('#add-photos-note').textContent = '';
    renderPhotos();
    show('photos');
    cardState('几张照片重建');
  }
  $('#add-build-again').onclick = reset;

  card.onclick = () => {
    if (state.step === 'size' && state.run && !viewer) void openSize();
    dialog.showModal();
  };
  dialog.addEventListener('close', () => {if (state.step === 'size') closeViewer();});
  card.hidden = false;
  reset();

  // A reconstruction started before the page was reloaded.
  const saved = recall();
  if (saved?.build) {
    state = {step: 'build', files: [], object: saved.object, build: saved.build, run: saved.run};
    if (saved.run) {cardState('重建好了，填尺寸'); show('size');}
    else void runBuild();
  }
}
