// The "添加物体" dialog: name + photos → mask previews (drop bad ones) → reconstruction progress →
// the result with one measured edge → into the room. The reconstruction runs on the server and
// survives closing the dialog or reloading the page (its job id is kept in localStorage).
// The result shows COVER's suggestion of where to shoot next; 补拍 adds photos from there and
// rebuilds on top of the result (its photos stay in, their masks are reused).
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MIN_PHOTOS, MAX_PHOTOS, STAGES, objectName, stageLabel, duration, readable, createObject, captureObject,
  startMasks, startReconstruction, follow, previewURL, saveMeasurement, coverSuggestion, readManifest} from './add-object.mjs?v=app-53';
import {readAsset, modelURL, metricScale, placementMatrix, sizeInMeters, savedMeasurement} from './object-import.mjs?v=app-42';
import {DIMENSION_AXES, createDimensionGuides, disposeObjectTree} from './object-dimensions.mjs?v=app-43';

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
    dialog.querySelector('[data-step="photos"]').textContent = state.parent ? '补拍' : '照片';
    $('#add-object-title').textContent = state.parent ? '补拍' : '添加物体';
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
    const count = state.files.length, name = state.parent ? state.object : objectName($('#add-name').value);
    $('#add-name-field').hidden = !!state.parent;
    $('#add-capture-intro').hidden = $('#add-capture-cancel').hidden = !state.parent;
    if (state.parent) $('#add-capture-intro').textContent = `给「${state.object || state.parent}」补拍：原来的照片都保留，再加几张新角度（照着尺寸那一步的橙色箭头拍）。`;
    $('#add-photos-note').textContent = count ? `${count} 张${count > MAX_PHOTOS ? `，最多 ${MAX_PHOTOS} 张` : ''}` : '';
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
    const name = objectName($('#add-name').value), files = state.files.map((entry) => entry.file);
    const progress = (part) => {$('#add-photos-note').textContent = part < 1 ? `正在上传 ${Math.round(part * 100)}%` : '正在保存照片…';};
    $('#add-upload').disabled = true;
    try {
      const created = state.parent ? await captureObject(state.parent, files, progress) : await createObject(name, files, progress);
      state.files.forEach((entry) => URL.revokeObjectURL(entry.url));
      state = {step: 'masks', files: [], object: created.object, images: created.images, excluded: new Set(),
        parent: created.parent || null, kept: new Set(created.kept || [])};
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
      if (state.kept?.has(name)) {
        cell.dataset.kept = 'true'; cell.disabled = true; cell.title = '原来的照片，补拍时保留';
        return cell;
      }
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
    const earlier = state.kept?.size ? ` · 其中原来的 ${state.kept.size} 张保留（灰框）` : '';
    $('#add-masks-note').textContent = `绿色是识别出的物体。点一张可以不用它 · 用 ${kept} 张${earlier}${kept < MIN_PHOTOS ? `，至少 ${MIN_PHOTOS} 张` : ''}`;
    $('#add-build').disabled = kept < MIN_PHOTOS || (state.kept?.size && kept <= state.kept.size);
    $('#add-build').textContent = `开始重建（${kept} 张）`;
  }
  $('#add-retry-masks').onclick = () => void runMasks();
  $('#add-build').onclick = async () => {
    $('#add-build').disabled = true;
    const images = state.images.filter((name) => !state.excluded.has(name));
    try {
      const job = await startReconstruction(state.object, images, state.masks, undefined, state.parent);
      state.build = job.id;
      remember({object: state.object, build: job.id, parent: state.parent});
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
      remember({object: state.object, build: state.build, run: job.run, parent: state.parent});
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
    await openViewer(state.run, state.asset.base, state.asset.manifest_url);
  }
  function measured() {
    return metricScale(state.asset.base, $('#add-axis').value, Number($('#add-meters').value));
  }
  function describeSize() {
    if (!state.asset) return;
    viewer?.selectAxis?.($('#add-axis').value);
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

  async function openViewer(run, base, manifestURL) {
    closeViewer();
    $('#add-cover-view').hidden = true;
    $('#add-cover-note').textContent = manifestURL ? '正在读取补拍建议…' : '这个结果没有补拍建议，也可以直接补拍。';
    const host = $('#add-view'), width = host.clientWidth || 480, height = host.clientHeight || 260;
    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, width / height, .01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    const labels = document.createElement('div'); labels.className = 'rc-dimension-labels';
    labels.setAttribute('aria-label', '模型实测坐标轴'); host.appendChild(labels);
    let guides = null;
    const buttons = DIMENSION_AXES.map(spec => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = spec.label;
      button.dataset.measureAxis = spec.axis; button.style.setProperty('--axis-color', spec.color);
      button.onclick = () => {$('#add-axis').value = spec.axis; describeSize();};
      button.hidden = true; labels.appendChild(button); return button;
    });
    const draw = () => {
      renderer.render(scene, camera);
      buttons.forEach(button => {
        const tip = guides?.tips.get(button.dataset.measureAxis)?.clone().project(camera);
        button.hidden = !tip || tip.z < -1 || tip.z > 1;
        if (tip) {
          button.style.left = `${Math.max(34, Math.min(host.clientWidth - 34, (tip.x + 1) * host.clientWidth / 2))}px`;
          button.style.top = `${Math.max(16, Math.min(host.clientHeight - 16, (1 - tip.y) * host.clientHeight / 2))}px`;
        }
      });
    };
    controls.addEventListener('change', draw);
    const resize = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight); camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix(); draw();
    });
    resize.observe(host);
    viewer = {renderer, camera, controls, scene, resize, labels, selectAxis(axis) {
      guides?.select(axis);
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.measureAxis === axis)));
      draw();
    }};
    let gltf, model = 'glb_preview';
    try {gltf = await new GLTFLoader().loadAsync(modelURL(run, 'preview.glb'));}
    catch {gltf = await new GLTFLoader().loadAsync(modelURL(run, 'result.glb')); model = 'glb';}
    if (viewer?.renderer !== renderer) {disposeObjectTree(gltf.scene); return;}
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
    guides = createDimensionGuides(THREE, box);
    scene.add(guides.root);
    const middle = box.getCenter(new THREE.Vector3());
    camera.position.set(middle.x + 1.2, middle.y + .8, middle.z + 1.6);
    controls.target.copy(middle);
    controls.update();
    viewer.selectAxis($('#add-axis').value);
    if (manifestURL) showSuggestion(renderer, manifestURL, model, shape, box, draw).catch((error) => {
      console.error(error); $('#add-cover-note').textContent = '补拍建议没能显示，也可以直接补拍。';
    });
  }
  // COVER's next shot, drawn as an orange arrow toward the object; 看推荐角度 looks from there.
  async function showSuggestion(renderer, url, model, shape, box, draw) {
    let suggestion = null, manifest = null;
    try {manifest = await readManifest(url); suggestion = coverSuggestion(manifest, model);} catch {}
    if (viewer?.renderer !== renderer) return;
    if (!suggestion) {
      $('#add-cover-note').textContent = `${manifest?.status === 'complete' || !manifest?.message ? '这次没有算出补拍建议' : manifest.message}，也可以直接补拍。`;
      return;
    }
    shape.updateMatrixWorld(true);
    const toView = shape.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(suggestion.transform).invert());
    const eye = new THREE.Vector3(...suggestion.position).applyMatrix4(toView);
    const look = new THREE.Vector3(...suggestion.target).applyMatrix4(toView);
    const middle = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const toward = look.clone().sub(eye).normalize();
    // A solid arrow outside the object, pointing at it from the suggested side, drawn over the model.
    const arrow = new THREE.Group(), paint = new THREE.MeshBasicMaterial({color: 0xd9822b, depthTest: false, transparent: true});
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(size * .018, size * .018, size * .32, 12), paint);
    const head = new THREE.Mesh(new THREE.ConeGeometry(size * .06, size * .14, 20), paint);
    shaft.position.y = size * .16; head.position.y = size * .39;
    arrow.add(shaft, head); arrow.renderOrder = 10; arrow.traverse((part) => {part.renderOrder = 10;});
    arrow.position.copy(middle).addScaledVector(toward, -size * .95);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toward);
    viewer.scene.add(arrow);
    const {camera, controls} = viewer, overview = {position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov};
    let recommended = false;
    $('#add-cover-note').textContent = '橙色箭头是建议补拍的方向：从那里再拍一两张，模型会更完整。';
    $('#add-cover-view').hidden = false;
    $('#add-cover-view').textContent = '看推荐角度';
    $('#add-cover-view').onclick = () => {
      recommended = !recommended;
      const pose = recommended ? {position: eye, target: look, fov: suggestion.fovDegrees} : overview;
      camera.position.copy(pose.position); controls.target.copy(pose.target); camera.fov = pose.fov;
      camera.updateProjectionMatrix(); controls.update(); arrow.visible = !recommended;
      $('#add-cover-view').textContent = recommended ? '回到整体' : '看推荐角度';
      draw();
    };
    draw();
  }
  function closeViewer() {
    if (!viewer) return;
    viewer.resize.disconnect(); viewer.controls.dispose(); disposeObjectTree(viewer.scene);
    viewer.renderer.dispose(); viewer.renderer.domElement.remove(); viewer.labels.remove();
    viewer = null;
  }

  // 补拍: more photos for the object of a finished run. back: where 不补拍了 returns to.
  function capture(run, object, back = null) {
    state.files?.forEach((entry) => URL.revokeObjectURL(entry.url));
    state = {step: 'photos', files: [], parent: run, object, back};
    $('#add-photos-note').textContent = '';
    show('photos');
    renderPhotos();
    cardState(`补拍 ${object || ''}`.trim());
    if (!dialog.open) dialog.showModal();
  }
  $('#add-capture').onclick = () => capture(state.run, state.object, {object: state.object, build: state.build, run: state.run, parent: state.parent});
  $('#add-capture-cancel').onclick = () => {
    const back = state.back;
    if (!back) {reset(); return;}
    state.files.forEach((entry) => URL.revokeObjectURL(entry.url));
    state = {step: 'size', files: [], ...back};
    cardState('重建好了，填尺寸');
    void openSize();
  };

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
    state = {step: 'build', files: [], object: saved.object, build: saved.build, run: saved.run, parent: saved.parent || null};
    if (saved.run) {cardState('重建好了，填尺寸'); show('size');}
    else void runBuild();
  }
  return {capture};
}
